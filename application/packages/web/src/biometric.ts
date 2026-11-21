/**
 * Biometric unlock - AES-GCM phrase wrapping behind a biometric prompt.
 *
 * Two interchangeable gates, picked per device: WebAuthn on the web, and the OS
 * authenticator (Touch ID, Windows Hello, an Android fingerprint) in the native
 * app, whose webview never exposes a WebAuthn platform authenticator. Which one
 * wrapped a blob is recorded in the stored credential id, so an unlock always
 * prompts the same way the enrollment did.
 * Spec: docs/contrib/biometric-unlock.md, backlog #101
 *
 * In a browser whose passkey provider has the WebAuthn PRF extension, the key
 * is bound: HKDF over the PRF output of the passkey gives the AES-GCM key at
 * each unlock, and the key is never stored, so a copy of the storage holds only
 * ciphertext (one record, `privacynotes.bio.enrollment`). In the native apps
 * the same record holds a key the device's secure hardware keeps (the Secure
 * Enclave, the Android Keystore, Windows Hello) and releases only after the
 * biometric check. Where neither can bind (a device without secure hardware,
 * a browser or provider without PRF) no enrollment is made (#842). One made
 * before that, or before the binding, can still be a user-presence check
 * only: the phrase is wrapped with a random AES-GCM-256 key that sits in
 * localStorage beside the blob it wraps, so storage access bypasses the gate
 * entirely. `isBiometricKeyBound` answers which. A browser one goes after an
 * unlock where a PIN or passcode wrap is here too (`dropPresenceGateBesidePin`);
 * a native one converts at its next unlock.
 * Spec: docs/internal/plans/phrase-lock-hardening.md (section 2)
 * Spec: docs/internal/plans/app-lock-passcode.md (section 4.6),
 * docs/internal/plans/biometric-key-binding.md (sections 4 and 8)
 *
 * Also provides PIN-based phrase wrapping (PBKDF2, convenience only).
 * Note encryption is untouched - this module only wraps the stored phrase.
 */

import {
  bytesToBase64,
  base64ToBytes,
  bytesToBase64url,
  base64urlToBytes,
  hexToBytes,
} from '@notes/shared';
import { detectPlatform } from './devices';
import { credentialKey } from './demo';
import { isTrustedDevice, tabSecrets } from './trustStorage';
import { settleStoredSession } from './sessionSeal';
import { logAuthEvent } from './authDiag';
import { hasLiveSignIn, signInStamp, signedOutSince, type SignInStamp } from './liveSignIn';
import { LEGACY_PIN_WRAP_ITERATIONS, normalizeSecret, saltBytesFor, saltIsPasscode } from './secretKind';
import { settingsLocalKey } from './settingsLocalKey';
import { buf, keyFromPrf, prfOutput, prfResultsOf, signalUnknownCredential } from './webauthn';
import { isSealedPinWrap, openSealedPinWrap, plainWrapId, sealPinCiphertext, sealsPinWrapHere, storedWrapId } from './pinWrapSeal';

// ── Constants ──────────────────────────────────────────────────
// All demo-bucketed (see credentialKey in demo.ts): the demo's usable
// Security tabs must never touch a real account's wrapped phrase on
// the same origin.

const BIO_CREDENTIAL_ID = credentialKey('privacynotes.bio.credentialId');
const BIO_WRAP_KEY = credentialKey('privacynotes.bio.wrapKey');
const BIO_IV = credentialKey('privacynotes.bio.iv');
const BIO_WRAPPED = credentialKey('privacynotes.bio.wrapped');
// A bound enrollment, one JSON value so it is written in one setItem and a
// half-written one cannot exist: { v: 1, credentialId, prfSalt, iv, wrapped }
// in a browser, { v: 2, handle, iv, wrapped } in the native apps.
const BIO_ENROLLMENT = credentialKey('privacynotes.bio.enrollment');
// Names an older build used for PRF salts; cleared on removal, never written.
const BIO_LEGACY_PRF_SALT = credentialKey('privacynotes.bio.prfSalt');
const BIO_LEGACY_HKDF_SALT = credentialKey('privacynotes.bio.hkdfSalt');

const PIN_PBKDF2_SALT = credentialKey('privacynotes.pin.pbkdf2Salt');
const PIN_IV = credentialKey('privacynotes.pin.iv');
const PIN_WRAPPED = credentialKey('privacynotes.pin.wrapped');
const PIN_ITERATIONS_KEY = credentialKey('privacynotes.pin.iterations');

const AES_GCM_IV_BYTES = 12;
const AES_KEY_BITS = 256;
const PBKDF2_ITERATIONS = 600_000;

// ── Helpers ─────────────────────────────────────────────────────

const textEnc = new TextEncoder();

// ── AES-GCM helpers ────────────────────────────────────────────

// Exported for phraseAtRest.ts, which wraps the stored session phrase
// with the same primitive under a non-extractable device key.
export async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: string,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const encoded = textEnc.encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(encoded)),
  );
  return { ciphertext, iv };
}

export async function aesGcmDecrypt(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(iv) },
    key,
    buf(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

// ── Native (OS) gate ────────────────────────────────────────────

/**
 * Credential-id sentinel for a blob gated by the OS authenticator rather than a
 * WebAuthn credential. Stored so a blob is always unlocked by the gate that
 * wrapped it, whatever the current platform reports.
 */
const NATIVE_CREDENTIAL_ID = 'native';

/** Calls an app command of the native shell. Throws where there is none (the web). */
export async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<T>(cmd, args);
}

/**
 * True when the OS itself can gate on biometrics: Touch ID / Face ID via
 * LocalAuthentication (macOS, iOS), Windows Hello via UserConsentVerifier,
 * BiometricPrompt via androidx.biometric (Android). Embedded webviews expose no
 * WebAuthn platform authenticator, so in a native build the OS is the only route
 * to a fingerprint. Asked on every native platform, since the command answers
 * false where there is nothing to offer (Linux) - only the web is skipped, where
 * there is no command at all.
 * Deliberately not cached: enrolling a finger, or a biometry lockout, flips the
 * answer while the app is open.
 * Spec: docs/contrib/biometric-unlock.md (section 3.2 native path), backlog #101
 */
async function canUseNativeBiometric(): Promise<boolean> {
  if (detectPlatform() === 'web') return false;
  try {
    return await invokeTauri<boolean>('biometric_available');
  } catch {
    // A shell older than this web bundle has no such command.
    return false;
  }
}

/** Present the OS biometric prompt. False on cancel, failure, or no prompt. */
async function nativeAuthenticate(reason: string, cancelLabel: string): Promise<boolean> {
  try {
    return await invokeTauri<boolean>('biometric_authenticate', { reason, cancelLabel });
  } catch {
    return false;
  }
}

/**
 * Why the hardware key gave nothing. `unsupported`: this device cannot bind
 * (no strong biometric, no secure hardware), said before any prompt.
 * `cancelled`: the person or the OS cancelled the prompt. `gone`: the OS
 * destroyed the key (the device passcode removed, the key invalidated), and
 * it never comes back. `unenrolled`: no biometric is enrolled now, so the key
 * cannot open, but it may again once one is. `failed`: anything else.
 */
type NativeKeyFailure = 'unsupported' | 'cancelled' | 'gone' | 'unenrolled' | 'failed';
type NativeKey = { handle: string; secret: Uint8Array };

/** The shell answers with these codes; anything else is a failure. */
function nativeKeyFailure(err: unknown): NativeKeyFailure {
  return err === 'unsupported' || err === 'cancelled' || err === 'gone' || err === 'unenrolled' ? err : 'failed';
}

// The 32 random bytes the hardware key seals, or the Windows Hello signature.
const NATIVE_SECRET_MIN_BYTES = 32;

/** The secret arrives as hex; anything else, or anything short, is a failure. */
function nativeSecret(hex: unknown): Uint8Array {
  if (typeof hex !== 'string') throw 'failed';
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch {
    throw 'failed';
  }
  if (bytes.length < NATIVE_SECRET_MIN_BYTES) throw 'failed';
  return bytes;
}

/**
 * Make a fresh hardware key, seal a secret to it, and open the secret once
 * behind the biometric prompt, which is both the person's consent and the
 * proof that the key opens. Throws a NativeKeyFailure. Only the shell's own
 * `unsupported` says the device cannot bind; any other error (a shell without
 * the command, a broken call) is `failed`, so nobody is told their device
 * cannot bind when it can (#842).
 * Spec: docs/internal/plans/biometric-key-binding.md (section 8.2),
 * docs/internal/plans/phrase-lock-hardening.md (section 2.2 A)
 */
async function nativeKeyCreate(reason: string, cancelLabel: string): Promise<NativeKey> {
  let made: { handle?: unknown; secret?: unknown };
  try {
    made = await invokeTauri<{ handle?: unknown; secret?: unknown }>('biometric_key_create', { reason, cancelLabel });
  } catch (err) {
    if (err === 'cancelled' || err === 'unsupported') throw err;
    throw 'failed';
  }
  if (typeof made?.handle !== 'string' || !made.handle) throw 'failed';
  return { handle: made.handle, secret: nativeSecret(made.secret) };
}

/** Open the secret of a hardware key behind the biometric prompt. Throws a NativeKeyFailure. */
async function nativeKeyOpen(handle: string, reason: string, cancelLabel: string): Promise<Uint8Array> {
  let secret: unknown;
  try {
    secret = await invokeTauri<string>('biometric_key_open', { handle, reason, cancelLabel });
  } catch (err) {
    throw nativeKeyFailure(err);
  }
  return nativeSecret(secret);
}

/** Remove a hardware key nothing refers to any more. A hint: never throws, never awaited. */
function nativeKeyDelete(handle: string): void {
  void invokeTauri('biometric_key_delete', { handle }).catch(() => { /* an orphan key opens nothing */ });
}

const NATIVE_HKDF_INFO = textEnc.encode('privacynotes-bio-native-v1');

/** The AES-GCM key a hardware secret gives. Non-extractable, and never stored. */
async function keyFromNativeSecret(secret: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', buf(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: buf(NATIVE_HKDF_INFO) },
    material,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wrap the phrase under a hardware secret and prove the wrap opens before anything is stored. */
async function buildNativeEnrollment(phrase: string, made: NativeKey): Promise<NativeBoundEnrollment> {
  const key = await keyFromNativeSecret(made.secret);
  const { ciphertext, iv } = await aesGcmEncrypt(key, phrase);
  if ((await aesGcmDecrypt(key, ciphertext, iv)) !== phrase) throw new Error('The new biometric wrap did not open.');
  return { v: 2, handle: made.handle, iv: bytesToBase64(iv), wrapped: bytesToBase64(ciphertext) };
}

// ── Feature detection ───────────────────────────────────────────

/**
 * Can this device support biometric unlock? True when either gate is usable:
 * the OS authenticator (native app) or a WebAuthn platform authenticator (web).
 */
export async function canUseBiometric(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (await canUseNativeBiometric()) return true;
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// ── WebAuthn PRF binding ───────────────────────────────────────

type BoundEnrollment = { v: 1; credentialId: string; prfSalt: string; iv: string; wrapped: string };
type NativeBoundEnrollment = { v: 2; handle: string; iv: string; wrapped: string };
type AnyBoundEnrollment = BoundEnrollment | NativeBoundEnrollment;

const PRF_SALT_BYTES = 32;
const PRF_HKDF_INFO = 'privacynotes-bio-prf-v1';

/** The bound enrollment this device holds, or null. Never throws. */
function readEnrollment(): AnyBoundEnrollment | null {
  try {
    const raw = localStorage.getItem(BIO_ENROLLMENT);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Record<string, unknown> | null;
    const fields = rec?.v === 1 ? ['credentialId', 'prfSalt', 'iv', 'wrapped']
      : rec?.v === 2 ? ['handle', 'iv', 'wrapped']
      : null;
    if (!rec || !fields) return null;
    for (const field of fields) {
      if (typeof rec[field] !== 'string' || !rec[field]) return null;
    }
    return rec as AnyBoundEnrollment;
  } catch {
    return null;
  }
}

/** A WebAuthn assertion of one credential, with the PRF evaluated over `salt`.
 *  userVerification stays 'required' here and at creation: an authenticator
 *  keeps separate PRF secrets with and without verification, so loosening
 *  one side changes the output and no bound record would open again. */
async function assertWithPrf(credentialId: Uint8Array, salt: Uint8Array): Promise<PublicKeyCredential | null> {
  const getOptions: PublicKeyCredentialRequestOptions = {
    rpId: window.location.hostname,
    challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
    allowCredentials: [{ id: buf(credentialId), type: 'public-key' }],
    userVerification: 'required',
  };
  // prf and hints are not yet in every TS type definition.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (getOptions as any).extensions = { prf: { eval: { first: buf(salt) } } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (getOptions as any).hints = ['client-device'];
  return (await navigator.credentials.get({ publicKey: getOptions })) as PublicKeyCredential | null;
}

type MadeCredential =
  | { kind: 'prf'; credentialId: Uint8Array; salt: Uint8Array; output: Uint8Array }
  | { kind: 'presence'; credentialId: Uint8Array }
  | { kind: 'cancelled' };

/**
 * Create a WebAuthn credential and ask its PRF for an output. Every
 * credential gets a fresh random user handle: with one handle per account a
 * second enrollment on the same authenticator replaced the first passkey
 * before the new one worked. The unlock finds the credential by its id, so
 * nothing reads the handle.
 */
async function createWebCredential(): Promise<MadeCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(PRF_SALT_BYTES));
  const createOptions: PublicKeyCredentialCreationOptions = {
    rp: { name: 'PrivacyNotes', id: window.location.hostname },
    user: {
      id: buf(crypto.getRandomValues(new Uint8Array(16))),
      name: 'PrivacyNotes User',
      displayName: 'PrivacyNotes',
    },
    challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },   // ES256
      { alg: -257, type: 'public-key' },  // RS256 fallback
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred',
    },
  };
  // prf and hints are not yet in every TS type definition.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (createOptions as any).extensions = { prf: { eval: { first: buf(salt) } } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (createOptions as any).hints = ['client-device'];

  const credential = (await navigator.credentials.create({
    publicKey: createOptions,
  })) as PublicKeyCredential | null;
  if (!credential) return { kind: 'cancelled' };
  const credentialId = new Uint8Array(credential.rawId);

  const prf = prfResultsOf(credential);
  if (prf?.enabled !== true) return { kind: 'presence', credentialId };
  const atCreate = prfOutput(prf.results?.first);
  if (atCreate) return { kind: 'prf', credentialId, salt, output: atCreate };
  // Some providers enable PRF at creation and evaluate it only on an assertion.
  let assertion: PublicKeyCredential | null;
  try {
    assertion = await assertWithPrf(credentialId, salt);
  } catch (err) {
    signalCredentialGone(bytesToBase64url(credentialId));
    throw err;
  }
  const first = assertion ? prfOutput(prfResultsOf(assertion)?.results?.first) : null;
  if (!first) return { kind: 'presence', credentialId };
  return { kind: 'prf', credentialId, salt, output: first };
}

/** Wrap the phrase under the PRF key and prove the wrap opens before anything is stored. */
async function buildBoundEnrollment(phrase: string, made: Extract<MadeCredential, { kind: 'prf' }>): Promise<BoundEnrollment> {
  const key = await keyFromPrf(made.output, PRF_HKDF_INFO);
  const { ciphertext, iv } = await aesGcmEncrypt(key, phrase);
  if ((await aesGcmDecrypt(key, ciphertext, iv)) !== phrase) throw new Error('The new biometric wrap did not open.');
  return {
    v: 1,
    credentialId: bytesToBase64url(made.credentialId),
    prfSalt: bytesToBase64(made.salt),
    iv: bytesToBase64(iv),
    wrapped: bytesToBase64(ciphertext),
  };
}

function removePresenceKeys(): void {
  try {
    localStorage.removeItem(BIO_CREDENTIAL_ID);
    localStorage.removeItem(BIO_WRAP_KEY);
    localStorage.removeItem(BIO_IV);
    localStorage.removeItem(BIO_WRAPPED);
  } catch {
    /* storage unavailable: the record still opens, and the next record unlock
       tries this again */
  }
}

/**
 * What this device's biometric enrollment is, as one value: the record and the
 * presence-gate keys. An enrollment that ends under another stamp than it
 * started under raced another tab, and commits nothing.
 */
function enrollmentStamp(): string {
  try {
    return [BIO_ENROLLMENT, BIO_CREDENTIAL_ID, BIO_WRAP_KEY, BIO_WRAPPED]
      .map((k) => localStorage.getItem(k) ?? '')
      .join('|');
  } catch {
    return '';
  }
}

/**
 * The commit of a bound enrollment, in one synchronous block so a closed tab
 * cannot split it: the sign-out fence, a check that no other tab changed the
 * enrollment since `startedFrom`, one write, a read-back, and only then the
 * removal of the older presence-gate keys. A write that throws or does not read
 * back puts back exactly what was there before it, so a working enrollment is
 * never lost to a failed one. Answers whether the record stands.
 */
function commitBoundEnrollment(record: AnyBoundEnrollment, since: SignInStamp, startedFrom: string): boolean {
  if (signedOutSince(since)) throw new Error('Signed out during enrollment.');
  if (enrollmentStamp() !== startedFrom) return false;
  const value = JSON.stringify(record);
  let previous: string | null;
  try {
    previous = localStorage.getItem(BIO_ENROLLMENT);
  } catch {
    return false;
  }
  try {
    localStorage.setItem(BIO_ENROLLMENT, value);
    if (localStorage.getItem(BIO_ENROLLMENT) !== value) throw new Error('read-back');
  } catch {
    // A sign-out since the start removed every wrap: nothing comes back.
    if (signedOutSince(since)) {
      try {
        if (localStorage.getItem(BIO_ENROLLMENT) === value) localStorage.removeItem(BIO_ENROLLMENT);
      } catch { /* */ }
      throw new Error('Signed out during enrollment.');
    }
    // Undo only a damaged write of ours. A valid record that is neither ours
    // nor the previous one was written by another tab in the same instant (the
    // tabs share no lock), and it is the one to keep.
    try {
      const now = localStorage.getItem(BIO_ENROLLMENT);
      if (now !== previous && (now === value || readEnrollment() === null)) {
        if (previous === null) localStorage.removeItem(BIO_ENROLLMENT);
        else localStorage.setItem(BIO_ENROLLMENT, previous);
      }
      // Asked again once restored: a sign-out in another tab can land
      // between the two lines above, and the restored record must not
      // outlive it.
      if (signedOutSince(since) && previous !== null && localStorage.getItem(BIO_ENROLLMENT) === previous) {
        localStorage.removeItem(BIO_ENROLLMENT);
      }
    } catch { /* */ }
    return false;
  }
  // Asked again once written: another tab's sign-out can fall between the
  // check and the write. After a sign-out the new record goes and nothing is
  // restored.
  if (signedOutSince(since)) {
    try {
      if (localStorage.getItem(BIO_ENROLLMENT) === value) localStorage.removeItem(BIO_ENROLLMENT);
    } catch { /* */ }
    throw new Error('Signed out during enrollment.');
  }
  removePresenceKeys();
  // A bound record stands, so a no-PRF mark from an earlier refused try and
  // the notice about a removed gate no longer say anything true.
  try {
    localStorage.removeItem(BIND_NO_PRF);
    localStorage.removeItem(PRESENCE_GATE_REMOVED);
  } catch { /* */ }
  for (const fn of presenceNoticeListeners) fn();
  return true;
}

export type BiometricEnrollResult =
  | { ok: true }
  /** `no_prf`: this browser's passkey gave no PRF output, so nothing was
   *  stored. `unsupported`: the device has no secure hardware key for it. */
  | { ok: false; reason: 'user_cancelled' | 'changed' | 'no_prf' | 'unsupported' | 'error'; message: string };

/**
 * Enroll biometric unlock: a WebAuthn passkey whose PRF output gives the wrap
 * key (web), or a key the device's secure hardware holds (native app). Where
 * neither can bind, nothing is stored: a wrap key beside the phrase it wraps
 * would stop nobody with a copy of the storage (#842).
 *
 * The OS prompt renders both strings, so callers pass them translated: the
 * reason for the prompt, and the label for the cancel button Android draws
 * itself. This module has no i18n access, which is why they are parameters.
 */
export async function enrollBiometric(
  phrase: string,
  reason: string,
  cancelLabel: string,
): Promise<BiometricEnrollResult> {
  const since = signInStamp();
  try {
    if (await canUseNativeBiometric()) return await enrollNative(phrase, reason, cancelLabel, since);

    const startedFrom = enrollmentStamp();
    const made = await createWebCredential();
    if (made.kind === 'cancelled') {
      return { ok: false, reason: 'user_cancelled', message: 'Credential creation was canceled.' };
    }
    const newId = bytesToBase64url(made.credentialId);
    const changed = { ok: false, reason: 'changed', message: 'Enrolled in another tab.' } as const;
    // From here a credential exists; any failure tells the provider it is unused.
    try {
      // No PRF from this browser or passkey provider: nothing is stored, and
      // the passkey is told gone. The mark keeps the Lock tab from offering a
      // set-up-again that could only fail the same way.
      if (made.kind === 'presence') {
        signalCredentialGone(newId);
        markNoPrfHere();
        return { ok: false, reason: 'no_prf', message: 'This browser gave no PRF output.' };
      }
      const record = await buildBoundEnrollment(phrase, made);
      // Another tab enrolled while this prompt was up: its enrollment stands.
      if (enrollmentStamp() !== startedFrom) {
        signalCredentialGone(newId);
        return changed;
      }
      if (!commitBoundEnrollment(record, since, startedFrom)) throw new Error('This device could not store biometric unlock.');
      return { ok: true };
    } catch (err) {
      signalCredentialGone(newId);
      throw err;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      return { ok: false, reason: 'user_cancelled', message: 'Biometric verification was canceled.' };
    }
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'Unknown error during biometric enrollment.',
    };
  }
}

/**
 * The native enrollment: a key the device's secure hardware holds. A device
 * that cannot make one enrolls nothing (#842). The hardware key is made under
 * a fresh name, so a working enrollment is never touched before the new
 * record reads back; a key whose record did not commit is deleted.
 * Spec: docs/internal/plans/biometric-key-binding.md (section 8.2),
 * docs/internal/plans/phrase-lock-hardening.md (section 2.2 A)
 */
async function enrollNative(
  phrase: string,
  reason: string,
  cancelLabel: string,
  since: SignInStamp,
): Promise<BiometricEnrollResult> {
  const startedFrom = enrollmentStamp();
  let made: NativeKey;
  try {
    made = await nativeKeyCreate(reason, cancelLabel);
  } catch (failure) {
    if (failure === 'cancelled') {
      return { ok: false, reason: 'user_cancelled', message: 'Biometric verification was canceled.' };
    }
    if (failure === 'unsupported') {
      return { ok: false, reason: 'unsupported', message: 'This device has no secure hardware key for biometric unlock.' };
    }
    return { ok: false, reason: 'error', message: 'Biometric unlock could not be set up on this device.' };
  }
  try {
    const record = await buildNativeEnrollment(phrase, made);
    if (enrollmentStamp() !== startedFrom) {
      nativeKeyDelete(made.handle);
      return { ok: false, reason: 'changed', message: 'Enrolled in another tab.' };
    }
    const previous = readEnrollment();
    if (!commitBoundEnrollment(record, since, startedFrom)) {
      nativeKeyDelete(made.handle);
      // Another tab's enrollment landed first and stands.
      if (enrollmentStamp() !== startedFrom) return { ok: false, reason: 'changed', message: 'Enrolled in another tab.' };
      return { ok: false, reason: 'error', message: 'This device could not store biometric unlock.' };
    }
    if (previous?.v === 2 && previous.handle !== record.handle) nativeKeyDelete(previous.handle);
    return { ok: true };
  } catch (err) {
    nativeKeyDelete(made.handle);
    throw err;
  }
}

/**
 * The silent conversion of a presence enrollment (D5), run after its unlock
 * opened the old wrap: the phrase is wrapped under the new hardware key and
 * committed like any bound enrollment, which removes the raw key only after
 * the record reads back. Any failure deletes the new key and leaves the old
 * wrap exactly as it was; the unlock has already succeeded either way.
 */
async function convertNative(phrase: string, made: NativeKey, since: SignInStamp, startedFrom: string): Promise<boolean> {
  try {
    const record = await buildNativeEnrollment(phrase, made);
    if (commitBoundEnrollment(record, since, startedFrom)) return true;
  } catch {
    /* the old wrap still opens */
  }
  nativeKeyDelete(made.handle);
  return false;
}

/**
 * A hardware key made before the rule that a biometric added later makes it
 * unusable: an Apple key under `.biometryAny` (`se1.`) or an Android key that
 * survives a new enrollment (`ks1.`). The one place this file reads inside a
 * handle. Windows Hello has no such rule, so its handles never match.
 * Spec: docs/internal/plans/biometric-new-finger.md (section 3)
 */
function opensWithAnyBiometric(handle: string): boolean {
  return handle.startsWith('se1.') || handle.startsWith('ks1.');
}

/** Old keys this app start already tried to replace: a cancel or a device
 *  that refuses costs the second prompt once per start, not at every unlock. */
const replaceTried = new Set<string>();

export type BiometricSetUpAgainResult =
  | { ok: true }
  | { ok: false; reason: 'user_cancelled' | 'changed' | 'no_prf' | 'error'; message: string };

/**
 * Replace an unbound browser enrollment with a bound one. The old enrollment
 * keeps working until the new record is written, read back and proven to
 * open: a cancel, a browser without PRF, a wrap that does not open or a write
 * the store refuses all leave it exactly as it was. Afterwards the browser is
 * told, where it can be, that the old passkey is gone; that is a hint to the
 * passkey provider, and nothing relies on it.
 * Spec: docs/internal/plans/app-lock-passcode.md (section 4.6, "Old enrollments")
 */
export async function setUpBiometricAgain(phrase: string): Promise<BiometricSetUpAgainResult> {
  const since = signInStamp();
  const startedFrom = enrollmentStamp();
  const oldId = (() => {
    try { return localStorage.getItem(BIO_CREDENTIAL_ID); } catch { return null; }
  })();
  try {
    const made = await createWebCredential();
    if (made.kind === 'cancelled') {
      return { ok: false, reason: 'user_cancelled', message: 'Credential creation was canceled.' };
    }
    if (made.kind === 'presence') {
      signalCredentialGone(bytesToBase64url(made.credentialId));
      markNoPrfHere();
      return { ok: false, reason: 'no_prf', message: 'This browser gave no PRF output.' };
    }
    const newId = bytesToBase64url(made.credentialId);
    // From here a credential exists; any failure tells the provider it is unused.
    try {
      const record = await buildBoundEnrollment(phrase, made);
      // Another tab changed the enrollment while this prompt was up; this tab
      // follows it and writes nothing.
      if (enrollmentStamp() !== startedFrom) {
        signalCredentialGone(newId);
        return { ok: false, reason: 'changed', message: 'The enrollment changed in another tab.' };
      }
      if (!commitBoundEnrollment(record, since, startedFrom)) {
        signalCredentialGone(newId);
        return { ok: false, reason: 'error', message: 'This device could not store biometric unlock.' };
      }
    } catch (err) {
      signalCredentialGone(newId);
      throw err;
    }
    if (oldId && oldId !== NATIVE_CREDENTIAL_ID) signalCredentialGone(oldId);
    return { ok: true };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      return { ok: false, reason: 'user_cancelled', message: 'Biometric verification was canceled.' };
    }
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'Unknown error during biometric enrollment.',
    };
  }
}

// ── The phrase change: a record for the new phrase, prepared before ──
//
// A phrase change replaces the phrase every door opens to. Each door is
// built and proven to open BEFORE the server changes anything, and stored
// only after the server answered, so a failed change leaves every door as it
// was and a landed one never leaves the device without one. One prepare step
// and one commit step per kind:
// - a browser record bound through PRF: one assertion with the enrolled
//   passkey gives the PRF output, and the new phrase is wrapped under it;
// - a native record: a fresh hardware key under a new name, as an enrollment
//   makes one; the commit deletes the old key, a discard the new one;
// - the presence gate of the native apps: a fresh hardware key, so the new
//   phrase gets a bound record. A browser presence gate, or a device that
//   cannot bind, gets none: no raw key is made for the new phrase, and the
//   handover record never carries one (#842).
// Spec: docs/internal/plans/phrase-change.md (6.5),
// docs/internal/plans/phrase-lock-hardening.md (section 2.2 A)

/** A biometric record for a new phrase, proven to open, stored nowhere yet.
 *  Plain JSON, so the handover record can keep it (phraseChange.ts). */
export type PreparedBiometric =
  | { kind: 'prf'; record: BoundEnrollment; startedFrom: string }
  | { kind: 'native'; record: NativeBoundEnrollment; previousHandle: string | null; startedFrom: string };

export type BiometricPrepareResult =
  /** `prepared` is null when this device holds no biometric record. */
  | { ok: true; prepared: PreparedBiometric | null }
  /** `cannot_bind`: the record is a presence gate that cannot become bound. */
  | { ok: false; reason: 'user_cancelled' | 'cannot_bind' | 'error'; message: string };

/** Build this device's biometric record again for `phrase`, store nothing. */
export async function prepareBiometricForPhrase(phrase: string, reason: string, cancelLabel: string): Promise<BiometricPrepareResult> {
  const startedFrom = enrollmentStamp();
  const record = readEnrollment();
  const cancelled = { ok: false, reason: 'user_cancelled', message: 'Biometric verification was canceled.' } as const;
  try {
    if (record?.v === 1) {
      const salt = base64ToBytes(record.prfSalt);
      const assertion = await assertWithPrf(base64urlToBytes(record.credentialId), salt);
      const output = assertion ? prfOutput(prfResultsOf(assertion)?.results?.first) : null;
      if (!output) return cancelled;
      const built = await buildBoundEnrollment(phrase, { kind: 'prf', credentialId: base64urlToBytes(record.credentialId), salt, output });
      return { ok: true, prepared: { kind: 'prf', record: built, startedFrom } };
    }
    if (record?.v === 2) {
      let made: NativeKey;
      try {
        made = await nativeKeyCreate(reason, cancelLabel);
      } catch (failure) {
        if (failure === 'cancelled') return cancelled;
        return { ok: false, reason: 'error', message: 'Biometric unlock could not be set up on this device.' };
      }
      try {
        const built = await buildNativeEnrollment(phrase, made);
        return { ok: true, prepared: { kind: 'native', record: built, previousHandle: record.handle, startedFrom } };
      } catch (err) {
        nativeKeyDelete(made.handle);
        throw err;
      }
    }
    let credentialId: string | null;
    try {
      credentialId = localStorage.getItem(BIO_WRAPPED) !== null ? localStorage.getItem(BIO_CREDENTIAL_ID) : null;
    } catch {
      credentialId = null;
    }
    if (!credentialId) return { ok: true, prepared: null };
    const cannotBind = { ok: false, reason: 'cannot_bind', message: 'This biometric unlock cannot be bound.' } as const;
    if (credentialId !== NATIVE_CREDENTIAL_ID) return cannotBind;
    let made: NativeKey;
    try {
      made = await nativeKeyCreate(reason, cancelLabel);
    } catch (failure) {
      if (failure === 'cancelled') return cancelled;
      if (failure === 'unsupported') return cannotBind;
      return { ok: false, reason: 'error', message: 'Biometric unlock could not be set up on this device.' };
    }
    try {
      const built = await buildNativeEnrollment(phrase, made);
      return { ok: true, prepared: { kind: 'native', record: built, previousHandle: null, startedFrom } };
    } catch (err) {
      nativeKeyDelete(made.handle);
      throw err;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') return cancelled;
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'Biometric unlock could not be prepared.' };
  }
}

/**
 * Store a prepared record as this device's biometric unlock, after the
 * server took the change. False, with nothing stored, when another tab
 * changed the enrollment since the prepare or the store refused; the old
 * record then wraps the replaced phrase, and the caller removes it. Throws
 * when a sign-out began at `since`, as every enrollment does.
 */
export function commitPreparedBiometric(prepared: PreparedBiometric, since: SignInStamp): boolean {
  // A handover record an older version wrote can hold a presence gate with
  // its raw key: it is never stored, and the caller removes the old record.
  if (prepared.kind !== 'prf' && prepared.kind !== 'native') return false;
  let stands = false;
  try {
    stands = commitBoundEnrollment(prepared.record, since, prepared.startedFrom);
  } finally {
    if (prepared.kind === 'native') {
      if (!stands) nativeKeyDelete(prepared.record.handle);
      else if (prepared.previousHandle && prepared.previousHandle !== prepared.record.handle) nativeKeyDelete(prepared.previousHandle);
    }
  }
  return stands;
}

/** Throw away a prepared record that will not be stored: a native one's new
 *  hardware key goes. A hint, never awaited. */
export function discardPreparedBiometric(prepared: PreparedBiometric): void {
  if (prepared.kind === 'native') nativeKeyDelete(prepared.record.handle);
}

/** Tell the passkey provider a credential is no longer used, where the browser can. Never throws. */
function signalCredentialGone(credentialId: string): void {
  signalUnknownCredential(window.location.hostname, credentialId);
}

/**
 * Prompt for biometric, then unwrap the phrase from localStorage. Prompts
 * through whichever gate enrolled this device: the OS authenticator or a
 * WebAuthn assertion.
 *
 * The OS prompt renders both strings, so callers pass them translated: the
 * reason for the prompt, and the label for the cancel button Android draws
 * itself. This module has no i18n access, which is why they are parameters.
 */
export async function unlockWithBiometric(
  reason: string,
  cancelLabel: string,
): Promise<string | null> {
  const result = await unlockWithBiometricDetailed(reason, cancelLabel);
  return result.phrase;
}

/**
 * Why an unlock gave no phrase: the person cancelled or refused the prompt, or
 * the unlock failed for another reason (the key it produced did not open the
 * wrap, a passkey whose PRF gives nothing now, an authenticator error, a
 * damaged record), or the OS destroyed the hardware key of a native
 * enrollment (every biometric or the device passcode removed), which never
 * comes back and must be set up again. The last two earn their own line.
 */
export type BiometricUnlockResult =
  | { phrase: string; failure?: undefined }
  | { phrase: null; failure: 'cancelled' | 'unopened' | 'gone' };

export async function unlockWithBiometricDetailed(
  reason: string,
  cancelLabel: string,
): Promise<BiometricUnlockResult> {
  // An answer is good only for the enrollment it was asked of. Another tab can
  // remove it, replace it or sign out while the prompt is up; the answer then
  // opens nothing and removes nothing.
  const since = signInStamp();
  const startedFrom = enrollmentStamp();
  const current = () => enrollmentStamp() === startedFrom && !signedOutSince(since);
  const record = readEnrollment();
  if (record?.v === 2) return unlockNativeBound(record, reason, cancelLabel, since, current);
  if (record) return unlockBound(record, current);

  let credIdB64: string | null, wrapKeyB64: string | null, ivB64: string | null, wrappedB64: string | null;
  try {
    credIdB64 = localStorage.getItem(BIO_CREDENTIAL_ID);
    wrapKeyB64 = localStorage.getItem(BIO_WRAP_KEY);
    ivB64 = localStorage.getItem(BIO_IV);
    wrappedB64 = localStorage.getItem(BIO_WRAPPED);
  } catch {
    return { phrase: null, failure: 'cancelled' };
  }

  if (!credIdB64 || !wrapKeyB64 || !ivB64 || !wrappedB64) return { phrase: null, failure: 'cancelled' };

  // Enrolled against the OS authenticator: no credential to assert, the
  // prompt itself is the gate.
  if (credIdB64 === NATIVE_CREDENTIAL_ID) {
    return unlockNativePresence({ wrapKeyB64, ivB64, wrappedB64 }, reason, cancelLabel, since, startedFrom, current);
  }
  try {
    const credentialId = base64urlToBytes(credIdB64);
    const getOptions: PublicKeyCredentialRequestOptions = {
      rpId: window.location.hostname,
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      allowCredentials: [{ id: buf(credentialId), type: 'public-key' }],
      userVerification: 'required',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getOptions as any).hints = ['client-device'];
    const assertion = (await navigator.credentials.get({
      publicKey: getOptions,
    })) as PublicKeyCredential | null;
    if (!assertion) return { phrase: null, failure: 'cancelled' };
  } catch (err) {
    return { phrase: null, failure: promptFailure(err) };
  }
  let phrase: string;
  try {
    phrase = await unwrapStoredPhrase(wrapKeyB64, ivB64, wrappedB64);
  } catch {
    return { phrase: null, failure: 'unopened' };
  }
  return current() ? { phrase } : { phrase: null, failure: 'cancelled' };
}

/**
 * Unlock a presence enrollment of the native apps, and convert it (D5). Where
 * the device can bind, making the hardware key is the prompt: its read-back
 * needs a passed biometric, so it gates the old wrap as the presence prompt
 * did, and one prompt does both. Where it cannot, or the key could not be
 * made, the presence prompt runs as before. A cancel cancels.
 * Spec: docs/internal/plans/biometric-key-binding.md (section 8.2, migration)
 */
async function unlockNativePresence(
  stored: { wrapKeyB64: string; ivB64: string; wrappedB64: string },
  reason: string,
  cancelLabel: string,
  since: SignInStamp,
  startedFrom: string,
  current: () => boolean,
): Promise<BiometricUnlockResult> {
  let made: NativeKey | null = null;
  try {
    made = await nativeKeyCreate(reason, cancelLabel);
  } catch (failure) {
    if (failure === 'cancelled') return { phrase: null, failure: 'cancelled' };
  }
  if (!made && !(await nativeAuthenticate(reason, cancelLabel))) return { phrase: null, failure: 'cancelled' };
  let phrase: string;
  try {
    phrase = await unwrapStoredPhrase(stored.wrapKeyB64, stored.ivB64, stored.wrappedB64);
  } catch {
    if (made) nativeKeyDelete(made.handle);
    return { phrase: null, failure: 'unopened' };
  }
  if (!current()) {
    if (made) nativeKeyDelete(made.handle);
    return { phrase: null, failure: 'cancelled' };
  }
  if (made) await convertNative(phrase, made, since, startedFrom);
  // A sign-out during the conversion removed every door; the phrase it read
  // must not open the app after it.
  if (signedOutSince(since)) return { phrase: null, failure: 'cancelled' };
  return { phrase };
}

/**
 * Unlock a bound native enrollment: the hardware key releases the secret
 * behind the biometric prompt, and nothing stored can stand in for it. A key
 * the OS destroyed answers `gone`; the dead record is then removed, but only
 * while another door holds the phrase (a PIN wrap, or the phrase at rest) and
 * the record is still the one this unlock read. With no biometric enrolled
 * the lock screen says the same, and the record stays. A key that any
 * biometric opens is replaced after it opened, by a key bound to the
 * biometrics enrolled now: a second prompt, once. Any failure of that keeps
 * the old record, and the unlock stands.
 * Spec: docs/internal/plans/biometric-key-binding.md (D6, section 8.2),
 * docs/internal/plans/biometric-new-finger.md (section 3)
 */
async function unlockNativeBound(
  record: NativeBoundEnrollment,
  reason: string,
  cancelLabel: string,
  since: SignInStamp,
  current: () => boolean,
): Promise<BiometricUnlockResult> {
  let secret: Uint8Array;
  try {
    secret = await nativeKeyOpen(record.handle, reason, cancelLabel);
  } catch (failure) {
    if (failure === 'cancelled') return { phrase: null, failure: 'cancelled' };
    if (failure === 'gone') {
      if (current() && (hasPinWrappedPhrase() || hasStoredPhrase())) removeBiometricCredential();
      return { phrase: null, failure: 'gone' };
    }
    // No biometric enrolled now: the same line, but nothing is removed, so a
    // finger or face enrolled again can still open this record.
    if (failure === 'unenrolled') return { phrase: null, failure: 'gone' };
    return { phrase: null, failure: 'unopened' };
  }
  let phrase: string;
  try {
    const key = await keyFromNativeSecret(secret);
    phrase = await aesGcmDecrypt(key, base64ToBytes(record.wrapped), base64ToBytes(record.iv));
  } catch {
    return { phrase: null, failure: 'unopened' };
  }
  if (!current()) return { phrase: null, failure: 'cancelled' };
  removePresenceKeys();
  if (opensWithAnyBiometric(record.handle) && !replaceTried.has(record.handle)) {
    replaceTried.add(record.handle);
    // Taken with no await after `current()`: the record this unlock opened,
    // without the presence keys just removed.
    const opened = enrollmentStamp();
    let made: NativeKey | null = null;
    try {
      made = await nativeKeyCreate(reason, cancelLabel);
    } catch {
      /* a cancel or a refusal keeps the old key until the next app start */
    }
    // A shell without the current-set rule would trade one old key for another.
    if (made && opensWithAnyBiometric(made.handle)) {
      nativeKeyDelete(made.handle);
      made = null;
    }
    const replaced = made !== null && (await convertNative(phrase, made, since, opened));
    if (replaced) nativeKeyDelete(record.handle);
    // A sign-out during the second prompt removed every door, and a record
    // another tab wrote meanwhile is not the one this unlock opened; either
    // way the phrase it read must not open the app.
    if (signedOutSince(since) || (!replaced && enrollmentStamp() !== opened)) {
      return { phrase: null, failure: 'cancelled' };
    }
  }
  return { phrase };
}

/** A cancelled or refused prompt is the person's choice; anything else the
 *  authenticator or the stored data failed. WebAuthn reports a cancel, a
 *  timeout and a refusal as NotAllowedError, and an abort as AbortError. */
function promptFailure(err: unknown): 'cancelled' | 'unopened' {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')
    ? 'cancelled'
    : 'unopened';
}

/**
 * Unlock a bound enrollment: the passkey's PRF output is the key, so there is
 * nothing stored to fall back to. After it opens, any presence-gate keys still
 * here are removed, which finishes a set-up-again a closed tab or a full
 * storage interrupted. Both happen only while `current` answers true, with no
 * await between the check and the removal: presence keys written after the
 * prompt opened belong to a newer enrollment.
 */
async function unlockBound(record: BoundEnrollment, current: () => boolean): Promise<BiometricUnlockResult> {
  let credentialId: Uint8Array, salt: Uint8Array, wrapped: Uint8Array, iv: Uint8Array;
  try {
    credentialId = base64urlToBytes(record.credentialId);
    salt = base64ToBytes(record.prfSalt);
    wrapped = base64ToBytes(record.wrapped);
    iv = base64ToBytes(record.iv);
  } catch {
    return { phrase: null, failure: 'unopened' };
  }
  let assertion: PublicKeyCredential | null;
  try {
    assertion = await assertWithPrf(credentialId, salt);
  } catch (err) {
    return { phrase: null, failure: promptFailure(err) };
  }
  if (!assertion) return { phrase: null, failure: 'cancelled' };
  const first = prfOutput(prfResultsOf(assertion)?.results?.first);
  if (!first) return { phrase: null, failure: 'unopened' };
  let phrase: string;
  try {
    const key = await keyFromPrf(first, PRF_HKDF_INFO);
    phrase = await aesGcmDecrypt(key, wrapped, iv);
  } catch {
    return { phrase: null, failure: 'unopened' };
  }
  if (!current()) return { phrase: null, failure: 'cancelled' };
  removePresenceKeys();
  return { phrase };
}

/** Biometric passed - unwrap the phrase with the key held in localStorage. */
async function unwrapStoredPhrase(
  wrapKeyB64: string,
  ivB64: string,
  wrappedB64: string,
): Promise<string> {
  const rawKey = base64ToBytes(wrapKeyB64);
  const key = await crypto.subtle.importKey(
    'raw',
    buf(rawKey),
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['decrypt'],
  );
  return await aesGcmDecrypt(key, base64ToBytes(wrappedB64), base64ToBytes(ivB64));
}

/** Check if a biometric-wrapped phrase exists on this device, bound or not. */
export function hasBiometricCredential(): boolean {
  if (readEnrollment()) return true;
  try {
    return localStorage.getItem(BIO_WRAPPED) !== null
      && localStorage.getItem(BIO_CREDENTIAL_ID) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether this device's biometric unlock is a Windows Hello key on a PC that
 * offers Windows no TPM, where Windows keeps the key in software. Asked live,
 * with no prompt, so an enrollment of any age gets the answer. Only the
 * Windows app (`build`) with a bound app enrollment asks; every failure
 * reads as false, which leaves the sentence that promises no chip.
 * Spec: docs/internal/plans/hello-tpm-status.md (section 3.3)
 */
export async function biometricKeyInSoftware(build: string): Promise<boolean> {
  if (build !== 'windows' || readEnrollment()?.v !== 2 || !isBiometricKeyBound()) return false;
  try {
    return (await invokeTauri<unknown>('biometric_tpm_missing')) === true;
  } catch {
    return false;
  }
}

/**
 * Whether biometric unlock on this device is a real key: the authenticator
 * produces or releases the wrap key, so a copy of the storage holds only
 * ciphertext. True for a browser enrollment bound through PRF and for a native
 * enrollment whose key the secure hardware holds. The PIN tab warns while
 * biometric unlock is on and this is false.
 * Spec: docs/internal/plans/biometric-key-binding.md (D3)
 */
export function isBiometricKeyBound(): boolean {
  // A raw wrap key beside the record still opens the phrase on its own, so
  // that state (an interrupted set-up-again) is not bound.
  if (!readEnrollment()) return false;
  try {
    return localStorage.getItem(BIO_WRAP_KEY) === null;
  } catch {
    return false;
  }
}

/**
 * Whether the Lock tab offers "Set up again": a browser enrollment that is not
 * bound. The native apps convert on their next unlock instead (D5).
 */
export function canSetUpBiometricAgain(): boolean {
  if (detectPlatform() !== 'web') return false;
  if (!hasBiometricCredential() || isBiometricKeyBound()) return false;
  if (noPrfHere()) return false;
  try {
    return localStorage.getItem(BIO_CREDENTIAL_ID) !== NATIVE_CREDENTIAL_ID;
  } catch {
    return false;
  }
}

// The browser whose passkey last gave no PRF here, by its user agent. Set up
// again would only make the same unbound passkey, so the Lock tab stops
// offering it in that browser (GitHub #594 thread: Firefox with Bitwarden
// offered it after every failure). A browser update changes the user agent and
// brings the offer back; so does a removal, which clears the mark.
const BIND_NO_PRF = credentialKey('privacynotes.ui.bindNoPrf');

function markNoPrfHere(): void {
  try {
    localStorage.setItem(BIND_NO_PRF, navigator.userAgent);
  } catch {
    /* the offer comes back on the next visit */
  }
}

/** Whether this browser's passkey already gave no PRF on this device. */
export function noPrfHere(): boolean {
  try {
    return localStorage.getItem(BIND_NO_PRF) === navigator.userAgent;
  } catch {
    return false;
  }
}

// The Lock tab asks once per device to set an unbound enrollment up again.
// Bucketed like the credentials, so a demo answer leaves a real account's ask.
const BIND_OFFER_ANSWERED = credentialKey('privacynotes.ui.bindOfferAnswered');

// Set when an unlock removed a browser presence gate; the notes view shows a
// banner until it is dismissed. Bucketed like the credentials.
const PRESENCE_GATE_REMOVED = credentialKey('privacynotes.ui.presenceGateRemoved');
const presenceNoticeListeners = new Set<() => void>();

/** Whether this browser says its passkeys can evaluate PRF. Unknown reads as no. */
async function browserOffersPrf(): Promise<boolean> {
  try {
    const caps = await (PublicKeyCredential as unknown as {
      getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
    }).getClientCapabilities?.();
    return caps?.['extension:prf'] === true;
  } catch {
    return false;
  }
}

/**
 * Whether the Lock tab asks this device to set biometric unlock up again: a
 * browser enrollment that is not bound (made before the binding, or where the
 * passkey gave no PRF), a browser that says its passkeys have PRF, and no
 * earlier answer here. The passkey provider can still lack PRF where the
 * browser has it; the set-up-again then says so and the ask does not return.
 */
export async function shouldOfferBinding(): Promise<boolean> {
  if (!canSetUpBiometricAgain()) return false;
  try {
    if (localStorage.getItem(BIND_OFFER_ANSWERED) !== null) return false;
  } catch {
    return false;
  }
  return browserOffersPrf();
}

/** Remembers on this device that the ask was answered, either way. */
export function answerBindingOffer(): void {
  try {
    localStorage.setItem(BIND_OFFER_ANSWERED, '1');
  } catch {
    /* the ask comes back on the next visit */
  }
}

/** Remove all biometric credential data from localStorage. Every name goes
 *  through credentialKey, so the demo never removes a real account's keys on
 *  the same origin. A native record's hardware key is deleted after it, as a
 *  hint: the key opens nothing once its record is gone. */
export function removeBiometricCredential(): void {
  const record = readEnrollment();
  if (record?.v === 2) nativeKeyDelete(record.handle);
  try {
    localStorage.removeItem(BIO_ENROLLMENT);
    localStorage.removeItem(BIO_CREDENTIAL_ID);
    localStorage.removeItem(BIO_WRAP_KEY);
    localStorage.removeItem(BIO_IV);
    localStorage.removeItem(BIO_WRAPPED);
    localStorage.removeItem(BIO_LEGACY_PRF_SALT);
    localStorage.removeItem(BIO_LEGACY_HKDF_SALT);
    localStorage.removeItem(BIND_NO_PRF);
    localStorage.removeItem(PRESENCE_GATE_REMOVED);
  } catch {
    /* storage unavailable */
  }
  for (const fn of presenceNoticeListeners) fn();
}

/**
 * Whether this device holds a browser presence gate beside the PIN or
 * passcode wrap (#842 B): its raw key sits next to the phrase it wraps, so it
 * stops nobody with a copy of the storage, and the PIN wrap is the lock. A
 * native one converts at its next unlock, and a bound record with leftover
 * keys is a set-up-again its own unlock finishes, so neither counts. The lock
 * screen does not start the fingerprint prompt by itself while this holds, so
 * the PIN, typed once, proves the wrap opens before the gate goes.
 * Spec: docs/internal/plans/phrase-lock-hardening.md (section 2.2 B)
 */
export function browserPresenceGateBesidePin(): boolean {
  let credentialId: string | null;
  try {
    if (localStorage.getItem(BIO_WRAP_KEY) === null) return false;
    credentialId = localStorage.getItem(BIO_CREDENTIAL_ID);
  } catch {
    return false;
  }
  if (!credentialId || credentialId === NATIVE_CREDENTIAL_ID) return false;
  if (readEnrollment()) return false;
  return hasPinWrappedPhrase();
}

/**
 * Remove that gate. Called only after the PIN or passcode opened the wrap on
 * the lock screen, so the door that stays is one the person just used. The
 * check and the removal are one synchronous block, so another tab cannot take
 * the PIN wrap between them. A gate that is the only door stays, with its
 * callout. Answers whether it removed one.
 */
export function dropPresenceGateBesidePin(): boolean {
  if (!browserPresenceGateBesidePin()) return false;
  let credentialId: string | null = null;
  try {
    credentialId = localStorage.getItem(BIO_CREDENTIAL_ID);
  } catch { /* checked above */ }
  removeBiometricCredential();
  try {
    localStorage.setItem(PRESENCE_GATE_REMOVED, '1');
  } catch {
    /* the Lock tab still shows biometric unlock as off */
  }
  for (const fn of presenceNoticeListeners) fn();
  if (credentialId) signalCredentialGone(credentialId);
  return true;
}

/** Whether the banner about a removed presence gate shows. */
export function presenceGateRemovedNotice(): boolean {
  try {
    return localStorage.getItem(PRESENCE_GATE_REMOVED) !== null;
  } catch {
    return false;
  }
}

export function dismissPresenceGateNotice(): void {
  try {
    localStorage.removeItem(PRESENCE_GATE_REMOVED);
  } catch {
    /* it shows again on the next start */
  }
  for (const fn of presenceNoticeListeners) fn();
}

export function onPresenceGateNoticeChange(fn: () => void): () => void {
  presenceNoticeListeners.add(fn);
  return () => { presenceNoticeListeners.delete(fn); };
}

// ── PIN-based phrase wrapping ───────────────────────────────────

// Spec: THREAT_MODEL.md (PBKDF2-SHA256 600k iterations per OWASP 2024)
const PIN_PBKDF2_ITERATIONS = PBKDF2_ITERATIONS;

async function deriveKeyFromPin(
  pin: string,
  salt: Uint8Array,
  iterations: number = PIN_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('PIN requires a secure connection (HTTPS). Please access the app over HTTPS.');
  }
  const material = await crypto.subtle.importKey(
    'raw',
    buf(textEnc.encode(normalizeSecret(pin))),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: buf(salt),
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

export type PinWrapBlob = {
  pinWrapSalt: string;
  pinWrapIV: string;
  pinWrapCiphertext: string;
  pinWrapIterations: number;
};

/**
 * Derive and encrypt only: the blob that goes into the synced settings, with
 * no storage access. A device the user marked untrusted changes the PIN
 * through this, so the account's wrap follows the new PIN while that device
 * keeps no copy of it. Pinned by tests/pinChange.test.ts.
 */
export async function buildPinWrap(phrase: string, pin: string): Promise<PinWrapBlob> {
  // The salt length records the kind of secret (secretKind.ts).
  const salt = crypto.getRandomValues(new Uint8Array(saltBytesFor(pin)));
  const key = await deriveKeyFromPin(pin, salt);
  const { ciphertext, iv } = await aesGcmEncrypt(key, phrase);
  return {
    pinWrapSalt: bytesToBase64(salt),
    pinWrapIV: bytesToBase64(iv),
    pinWrapCiphertext: bytesToBase64(ciphertext),
    pinWrapIterations: PIN_PBKDF2_ITERATIONS,
  };
}

/**
 * Store a wrap built in memory as this device's own, with no await between
 * the caller's last check and the writes. A caller that must first confirm
 * the secret is still the account's (pinCredentialStamp in pin.ts) builds
 * with `buildPinWrap`, checks, then stores here, so a wrap under a secret
 * replaced meanwhile never overwrites the newer one. Throws when the store
 * refuses or a sign-out began at `since`: every caller derives a PIN key
 * first, about a second, so `since` is the stamp taken before that.
 *
 * Answers a function that puts back the wrap this one replaced, for a caller
 * whose next write failed (the PIN tab's settings save). It does nothing once
 * another wrap was stored here or a sign-out began.
 */
export function storeBuiltPinWrap(blob: PinWrapBlob, since: SignInStamp, local?: string | null): () => void {
  if (signedOutSince(since)) throw new Error('Signed out while the PIN wrap was built.');
  const keys = [PIN_PBKDF2_SALT, PIN_IV, PIN_WRAPPED, PIN_ITERATIONS_KEY];
  const previous = keys.map((k) => localStorage.getItem(k));
  // Putting the old values back returns the store to a size it already held.
  const putBack = () => keys.forEach((k, i) => {
    try {
      const v = previous[i];
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch { /* */ }
  });
  try {
    localStorage.setItem(PIN_PBKDF2_SALT, blob.pinWrapSalt);
    localStorage.setItem(PIN_IV, blob.pinWrapIV);
    // The value sealed under the device key when the caller made one
    // (`sealedLocalPinWrap`), so a new wrap never lands plain.
    localStorage.setItem(PIN_WRAPPED, local ?? blob.pinWrapCiphertext);
    localStorage.setItem(PIN_ITERATIONS_KEY, String(blob.pinWrapIterations));
  } catch (err) {
    // A store that refuses one of the four keeps the wrap it had, never a
    // salt of one wrap beside the ciphertext of another, which opens with no
    // secret at all.
    putBack();
    throw err;
  }
  // Asked again once written: another tab's sign-out can fall between the
  // check and the writes, and then this wrap undoes itself.
  if (signedOutSince(since)) {
    if (hasSamePinWrap(blob)) removePinWrappedPhrase();
    throw new Error('Signed out while the PIN wrap was built.');
  }
  if (!local) void sealLocalPinWrap();
  // By identity, so the put-back still finds this wrap once it is sealed; the
  // wrap it puts back is sealed again where it was plain.
  return () => {
    if (signedOutSince(since)) return;
    if (hasSamePinWrap(blob)) {
      putBack();
      void sealLocalPinWrap();
    }
  };
}

/**
 * This device's copy of a wrap a caller just built, sealed under the device
 * key where it seals (pinWrapSeal.ts), for `storeBuiltPinWrap`'s `local`.
 * Called before the caller's last check, so the store itself stays
 * synchronous. Null where it does not seal, or the seal did not read back:
 * the store then writes the plain value and seals it afterwards.
 */
export async function sealedLocalPinWrap(blob: PinWrapBlob): Promise<string | null> {
  if (!sealsPinWrapHere()) return null;
  return sealPinCiphertext(blob.pinWrapSalt, blob.pinWrapIV, blob.pinWrapCiphertext);
}

/**
 * Open a PIN wrap held in memory, such as the account's wrap from a settings
 * row: the phrase it holds, or null when the PIN does not open it. Reads and
 * writes no storage. The phrase change proves the typed PIN on the account's
 * own wrap, and its new wrap on itself, before anything is sent.
 * Spec: docs/internal/plans/phrase-change.md (6.5)
 */
export async function openPinWrapBlob(blob: PinWrapBlob, pin: string): Promise<string | null> {
  try {
    const key = await deriveKeyFromPin(pin, base64ToBytes(blob.pinWrapSalt), blob.pinWrapIterations);
    return await aesGcmDecrypt(key, base64ToBytes(blob.pinWrapCiphertext), base64ToBytes(blob.pinWrapIV));
  } catch {
    return null;
  }
}

/** The local wrap's salt and ciphertext as one value. An unlock that starts
 *  under one stamp and ends under another opened a wrap this device no longer
 *  holds, so the lock screen drops its answer. Pinned by
 *  tests/lockScreenKind.test.ts. */
export function pinWrapStamp(): string {
  try {
    const stored = localStorage.getItem(PIN_WRAPPED);
    // By the plain ciphertext, so a wrap sealed under the device key while a
    // check runs (pinWrapSeal.ts) is still the same wrap.
    return `${localStorage.getItem(PIN_PBKDF2_SALT) ?? ''}:${stored === null ? '' : storedWrapId(stored)}`;
  } catch {
    return '';
  }
}

/**
 * True when the wrap this device holds IS the given one, by salt and
 * ciphertext. syncPinWrap asks it so a PIN changed on another device, which
 * re-wraps under the new PIN, replaces the blob here rather than leaving a
 * wrap the retired PIN still opens. Pinned by tests/pinRecovery.test.ts.
 */
export function hasSamePinWrap(
  blob: Pick<PinWrapBlob, 'pinWrapSalt' | 'pinWrapCiphertext'> & Partial<Pick<PinWrapBlob, 'pinWrapIV'>>,
): boolean {
  try {
    const stored = localStorage.getItem(PIN_WRAPPED);
    if (stored === null || localStorage.getItem(PIN_PBKDF2_SALT) !== blob.pinWrapSalt) return false;
    if (!isSealedPinWrap(stored)) {
      return stored === blob.pinWrapCiphertext
        && (blob.pinWrapIV === undefined || localStorage.getItem(PIN_IV) === blob.pinWrapIV);
    }
    // A sealed wrap names its plain ciphertext by a check value, and the IV
    // must match too, so a salt and IV of one wrap beside the ciphertext of
    // another (a torn write) is never the same wrap.
    // Spec: docs/internal/plans/pin-wrap-hardening.md (section 5.4, C2-1)
    return storedWrapId(stored) === plainWrapId(blob.pinWrapCiphertext)
      && (blob.pinWrapIV === undefined || localStorage.getItem(PIN_IV) === blob.pinWrapIV);
  } catch {
    return false;
  }
}

/**
 * Seal this device's plain PIN wrap under the device key, in the apps
 * (pinWrapSeal.ts). Runs after every write of the wrap and once at the boot,
 * which moves a wrap written before. The sealed value replaces the plain one
 * only while the plain one is still there, salt and IV included, with no
 * await between that check and the write: a wrap another tab or a sign-out
 * changed meanwhile stays as it is.
 */
export async function sealLocalPinWrap(): Promise<void> {
  if (!sealsPinWrapHere()) return;
  let salt: string | null;
  let iv: string | null;
  let plain: string | null;
  try {
    salt = localStorage.getItem(PIN_PBKDF2_SALT);
    iv = localStorage.getItem(PIN_IV);
    plain = localStorage.getItem(PIN_WRAPPED);
  } catch {
    return;
  }
  if (!salt || !iv || !plain || isSealedPinWrap(plain)) return;
  const sealed = await sealPinCiphertext(salt, iv, plain);
  if (!sealed) {
    // Never silent, as the phrase envelope's fall back is not.
    logAuthEvent('auth:pin-wrap-seal-fallback');
    return;
  }
  try {
    if (
      localStorage.getItem(PIN_WRAPPED) === plain
      && localStorage.getItem(PIN_PBKDF2_SALT) === salt
      && localStorage.getItem(PIN_IV) === iv
    ) {
      localStorage.setItem(PIN_WRAPPED, sealed);
    }
  } catch {
    /* stays plain; the next write or boot tries again */
  }
}

/**
 * Whether this device's PIN wrap opens: a plain one always, a sealed one when
 * the device key store opens its seal (no dialog). A seal that does not open
 * (a restore on another device, a key the OS reset) is no door, so the code
 * that strips the phrase behind the wrap, or treats it as the last door, asks
 * this first. A seal that opened is remembered per stored value for the
 * life of the page; one that did not is asked again.
 */
const opensMemo = new Map<string, boolean>();

/** Whether this device's PIN wrap is sealed under the device key (no await). */
export function localPinWrapSealed(): boolean {
  try {
    return isSealedPinWrap(localStorage.getItem(PIN_WRAPPED));
  } catch {
    return false;
  }
}
export async function localPinWrapOpens(): Promise<boolean> {
  let stored: string | null;
  let salt: string | null;
  let iv: string | null;
  try {
    stored = localStorage.getItem(PIN_WRAPPED);
    salt = localStorage.getItem(PIN_PBKDF2_SALT);
    iv = localStorage.getItem(PIN_IV);
  } catch {
    return false;
  }
  if (stored === null || !salt || !iv) return false;
  if (!isSealedPinWrap(stored)) return true;
  const known = opensMemo.get(stored);
  if (known !== undefined) return known;
  const opened = await openSealedPinWrap(stored, salt, iv);
  const opens = typeof opened === 'string' && opened !== 'cancelled';
  if (opens) opensMemo.set(stored, true);
  return opens;
}

/**
 * Write a synced PIN wrap blob into localStorage so app lock works on this
 * device.
 *
 * Gated on the trust choice, and the gate lives HERE rather than at the call
 * sites on purpose: there were two callers and neither checked, so a user who
 * answered "shared computer" at sign-in still ended up with a persistent,
 * offline-attackable copy of their wrapped phrase on that machine. A PIN is
 * four digits, so the whole keyspace is ten thousand guesses against a blob the
 * attacker can take away with them. Putting the check inside the function means
 * a third caller cannot reintroduce the hole by forgetting it.
 *
 * The cost is deliberate and small: on an untrusted device app lock does not
 * light up from synced settings, and it cannot be switched on there either.
 * A PIN set on that device builds its wrap in memory for the account only and
 * writes nothing to this device (PinTab.tsx).
 * Test: tests/pinWrapUntrusted.test.ts
 */
export function hydrateLocalPinWrap(blob: PinWrapBlob): void {
  if (!isTrustedDevice()) return;
  // A sync pass that outlived a sign-out must not put the wrap back, or the
  // four-digit PIN opens the signed-out device (liveSignIn.ts).
  if (!hasLiveSignIn()) return;
  const keys = [PIN_PBKDF2_SALT, PIN_IV, PIN_WRAPPED, PIN_ITERATIONS_KEY];
  let previous: (string | null)[];
  try {
    previous = keys.map((k) => localStorage.getItem(k));
  } catch {
    return;
  }
  try {
    localStorage.setItem(PIN_PBKDF2_SALT, blob.pinWrapSalt);
    localStorage.setItem(PIN_IV, blob.pinWrapIV);
    localStorage.setItem(PIN_WRAPPED, blob.pinWrapCiphertext);
    localStorage.setItem(PIN_ITERATIONS_KEY, String(blob.pinWrapIterations ?? LEGACY_PIN_WRAP_ITERATIONS));
  } catch {
    // A store that refuses one of the four keeps the wrap it had, never a
    // salt of one wrap beside the ciphertext of another, which no secret
    // opens (as storeBuiltPinWrap).
    keys.forEach((k, i) => {
      try {
        const v = previous[i];
        if (v === null || v === undefined) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch { /* */ }
    });
    return;
  }
  // Asked again once written, as storeBuiltPinWrap does.
  if (!hasLiveSignIn() && hasSamePinWrap(blob)) {
    removePinWrappedPhrase();
    return;
  }
  void sealLocalPinWrap();
}

/** Only a Linux keyring shows an unlock dialog, and only one asked for it
 *  waits for the person (75 s); the other stores answer at once. */
function keyringMayAsk(): boolean {
  try {
    const ua = navigator.userAgent.toLowerCase();
    return ua.includes('linux') && !ua.includes('android');
  } catch {
    return false;
  }
}

/** Why a PIN wrap sealed under the device key did not open: the person
 *  dismissed the Linux keyring dialog, or the key store does not open it. */
export type PinWrapUnavailable = 'keyring-cancelled' | 'device-key-unavailable';

/** The wrap a legacy upgrade replaced, by salt and ciphertext. */
export type ReplacedPinWrap = Pick<PinWrapBlob, 'pinWrapSalt' | 'pinWrapCiphertext'>;

/**
 * `onUpgraded` receives the blob a legacy-iteration wrap was re-wrapped
 * into after a successful unlock, and the wrap it replaced. The re-wrap is local; the caller carries
 * the blob to the synced settings, because every device replaces a wrap
 * that differs from the account's, and an upgrade the account never learns
 * of would be undone on the next pass and redone on the next unlock.
 */
export async function unwrapPhraseWithPin(
  pin: string,
  onUpgraded?: (blob: PinWrapBlob, replaced: ReplacedPinWrap) => void,
): Promise<string | null | PinWrapUnavailable> {
  // The legacy upgrade below starts after this function's own key
  // derivation, and it must not outlive a sign-out that began during it.
  const startedAt = signInStamp();
  const saltB64 = localStorage.getItem(PIN_PBKDF2_SALT);
  const ivB64 = localStorage.getItem(PIN_IV);
  const stored = localStorage.getItem(PIN_WRAPPED);

  if (!saltB64 || !ivB64 || !stored) return null;
  const wrapAtStart = pinWrapStamp();
  // A wrap sealed under the device key opens through the key store first. A
  // seal that does not open is no wrong PIN: the caller counts nothing and
  // offers the phrase. On Linux this is the moment the keyring may ask to be
  // unlocked, a dialog the person started by submitting the PIN.
  // Spec: docs/internal/plans/pin-wrap-hardening.md (section 5.4, C2-1)
  let wrappedB64 = stored;
  if (isSealedPinWrap(stored)) {
    const opened = await openSealedPinWrap(stored, saltB64, ivB64, keyringMayAsk());
    if (opened === 'cancelled') return 'keyring-cancelled';
    if (opened === null) return 'device-key-unavailable';
    wrappedB64 = opened;
  }
  // The caller saves the upgrade only over the wrap it replaced.
  const reportUpgrade = onUpgraded && ((blob: PinWrapBlob) => onUpgraded(blob, { pinWrapSalt: saltB64, pinWrapCiphertext: wrappedB64 }));

  const storedIterations = parseInt(localStorage.getItem(PIN_ITERATIONS_KEY) ?? '', 10) || LEGACY_PIN_WRAP_ITERATIONS;
  const salt = base64ToBytes(saltB64);
  const ciphertext = base64ToBytes(wrappedB64);
  const iv = base64ToBytes(ivB64);

  // Try with stored iteration count first.
  try {
    const key = await deriveKeyFromPin(pin, salt, storedIterations);
    const phrase = await aesGcmDecrypt(key, ciphertext, iv);

    // Auto-upgrade: re-wrap with current iterations if using legacy count.
    if (storedIterations < PIN_PBKDF2_ITERATIONS) upgradeLegacyWrap(phrase, pin, wrapAtStart, startedAt, reportUpgrade);
    // A plain wrap in the apps moves under the device key.
    else if (!isSealedPinWrap(stored)) void sealLocalPinWrap();

    return phrase;
  } catch {
    // If stored iterations differ from legacy, also try legacy as fallback
    // (handles edge case where PIN_ITERATIONS_KEY was lost/corrupt).
    if (storedIterations !== LEGACY_PIN_WRAP_ITERATIONS) {
      try {
        const legacyKey = await deriveKeyFromPin(pin, salt, LEGACY_PIN_WRAP_ITERATIONS);
        const phrase = await aesGcmDecrypt(legacyKey, ciphertext, iv);
        upgradeLegacyWrap(phrase, pin, wrapAtStart, startedAt, reportUpgrade);
        return phrase;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * True when this device's wrap was made with a passcode. The lock screen reads
 * this and nothing else: it opens the wrap, and the wrap and the cached hash
 * can come from different writes (a sync pass that stops between the two).
 */
export function pinWrapIsPasscode(): boolean {
  try {
    return saltIsPasscode(localStorage.getItem(PIN_PBKDF2_SALT));
  } catch {
    return false;
  }
}

/**
 * Re-wrap a legacy-iteration wrap after it opened, in the background. Built in
 * memory and stored only while the wrap it replaces is still this device's,
 * with no await in between: a newer wrap another tab stored meanwhile (a
 * secret changed there) is never overwritten by one under the old secret, and
 * the account never learns of it. Best effort; a failure leaves the legacy
 * wrap, which still opens.
 */
function upgradeLegacyWrap(
  phrase: string,
  pin: string,
  wrapAtStart: string,
  startedAt: SignInStamp,
  onUpgraded?: (blob: PinWrapBlob) => void,
): void {
  void buildPinWrap(phrase, pin)
    .then(async (blob) => {
      const local = await sealedLocalPinWrap(blob);
      if (pinWrapStamp() !== wrapAtStart) return;
      storeBuiltPinWrap(blob, startedAt, local);
      onUpgraded?.(blob);
    })
    .catch(() => { /* best-effort upgrade */ });
}

export function hasPinWrappedPhrase(): boolean {
  try {
    return localStorage.getItem(PIN_WRAPPED) !== null
      && localStorage.getItem(PIN_PBKDF2_SALT) !== null;
  } catch {
    return false;
  }
}

export function removePinWrappedPhrase(): void {
  try {
    localStorage.removeItem(PIN_PBKDF2_SALT);
    localStorage.removeItem(PIN_IV);
    localStorage.removeItem(PIN_WRAPPED);
    localStorage.removeItem(PIN_ITERATIONS_KEY);
  } catch {
    /* storage unavailable */
  }
}

// ── Stored phrase removal ───────────────────────────────────────

// Local copy to avoid the authStorage import cycle; same demo bucket
// as the canonical PHRASE_STORAGE_KEY in authStorage.ts.
const PHRASE_STORAGE_KEY = credentialKey('privacynotes.phrase');

/**
 * True while a phrase is stored on this device (localStorage, or the tab's
 * own copy in memory on a tab that is not trusted), i.e. this browser is still signed in. Presence only -
 * the value is a wrapped envelope (phraseAtRest.ts), or legacy plaintext
 * on a not-yet-migrated install. Distinguishes "the user changed an
 * app-lock setting" from "another tab signed out", which removes the
 * wrapped blobs and the stored phrase together. App.tsx asks it at boot
 * too: no stored phrase means no session to restore.
 */
export function hasStoredPhrase(): boolean {
  try {
    if (localStorage.getItem(PHRASE_STORAGE_KEY) !== null) return true;
  } catch { /* storage unavailable */ }
  try {
    return tabSecrets.getItem(PHRASE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Removes the wrapped doors a sign-out left on this device, before the lock
 * screen reads them at boot. A tab on an older bundle signs out without
 * knowing every door a newer bundle writes (the bound biometric record came
 * later), and with no phrase at rest the next start shows the lock screen,
 * whose fingerprint would sign the signed-out account back in.
 *
 * Only on proof that this browser is signed out, never because a read came
 * back empty: a sign-out notice exists, and nothing a signed-in device keeps
 * is here, which is a phrase at rest, a session in either store, and the
 * settings cache. An armed app lock has no phrase at rest and can lose its
 * session, but its settings cache goes only with a sign-out, so its doors
 * stay. A read that throws keeps them too. Answers whether it removed them.
 * Pinned by tests/signedOutDoors.test.ts.
 */
export function dropDoorsLeftBySignOut(): boolean {
  if (!hasBiometricCredential() && !hasPinWrappedPhrase()) return false;
  try {
    if (signInStamp().announced === null) return false;
    if (localStorage.getItem(settingsLocalKey()) !== null) return false;
    for (const store of [localStorage, tabSecrets, sessionStorage]) {
      if (store.getItem(PHRASE_STORAGE_KEY) !== null) return false;
      for (let i = 0; i < store.length; i++) {
        if (store.key(i)?.startsWith('sb-')) return false;
      }
    }
  } catch {
    return false;
  }
  removeBiometricCredential();
  removePinWrappedPhrase();
  return true;
}

/** Enabling app lock strips the stored phrase: from then on the ONLY
 *  door back into the session is a PIN or biometric unlock. */
export function removeStoredPhrase(): void {
  try { localStorage.removeItem(PHRASE_STORAGE_KEY); } catch { /* */ }
  try { tabSecrets.removeItem(PHRASE_STORAGE_KEY); } catch { /* */ }
  // The settings write that arms the lock comes after this in some paths;
  // it settles the session again (userSettings.ts writeLocal).
  settleStoredSession();
}

// ── Cross-tab sync ──────────────────────────────────────────────

export function onWrappedBlobChange(callback: () => void): () => void {
  const keys = new Set([BIO_WRAPPED, BIO_CREDENTIAL_ID, BIO_ENROLLMENT, PIN_WRAPPED]);
  function handler(e: StorageEvent) {
    if (e.key && keys.has(e.key)) callback();
  }
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
