/**
 * Passkey sign-in on a new device: a signed-in device adds a passkey that seals
 * the recovery phrase and stores the ciphertext in a passkey slot (edge
 * function `passkey-slot`). On a new device the passkey asks the server for
 * that ciphertext, the device opens it, and the phrase signs in as if it had
 * been typed: the same sign-in step, captcha and 2FA prompt (P8). The phrase
 * stays the root key.
 *
 * Two wrap kinds (4.1):
 * - `'prf'` (1-click): one fixed PRF input for every sign-in passkey (a
 *   discoverable `get` does not know the credential before the person picks it,
 *   P18); HKDF-SHA256 over the 32-byte PRF output gives a non-extractable
 *   AES-GCM-256 key; AAD names the credential id.
 * - `'pw-s1'` (passkey password, for providers without WebAuthn PRF such as
 *   Bitwarden, KeePassXC, Windows 10, older Apple platforms): the passkey holds
 *   a 32-byte random `user.id` (`userHandle`, never sent to the server); the
 *   user sets a passkey password; audited `scryptAsync` (N=65536, r=8, p=2,
 *   64 MiB) over the password and a 32-byte per-slot `kdfSalt` is mixed with
 *   the 32-byte `userHandle` through HKDF-SHA256 to derive a non-extractable
 *   AES-GCM-256 key; AAD binds `pw-s1`, `rpId`, `credentialId` and `kdfSalt`.
 *   Because the server holds neither `userHandle` nor the password, a database
 *   leak alone cannot open or offline-guess the slot.
 *
 * Both wrap kinds pad the phrase with spaces to 256 bytes so the length does
 * not tell 12 from 24 words. The slot's name is sealed under the account's sync
 * key (P30). Adding and removing a slot is signed with the phrase's signing key
 * over a server nonce, the session and a digest of the body (P19).
 *
 * Every server call has a demo guard: the demo sends nothing.
 * Spec: docs/contrib/passkeys.md (4.1, 4.3)
 */
import {
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  decryptJsonAad,
  encryptJsonAad,
  hexToBytes,
  isValidPhrase,
  signPasskeySlotChallenge,
  type SupabaseClient,
} from '@notes/shared';
import { isDemoMode } from './demo';
import { detectPlatform, readFnErrorBody, type FnError } from './devices';
import { ensureLevel2 } from './mfaStep';
import { passkeysReleased } from './passkeysRelease';
import { sha256Hex } from './sha256Hex';
import { isUuid } from './uuid';
import { buf, keyFromPrf, prfOutput, prfResultsOf, signalUnknownCredential } from './webauthn';

// ── Constants ─────────────────────────────────────────────────────────

/**
 * The origins that offer passkey sign-in, and the RP ID of each (P15): each
 * host its own RP ID, the app and the public beta in production, never the
 * apex (script on any subdomain could then ask for the PRF output), and
 * localhost in development. A beta passkey answers only on beta. The
 * server holds the same table (`_shared/passkeySignIn.ts`).
 * `APP_ORIGINS` is never used for this.
 * Spec: docs/contrib/passkeys.md (4.1, P15)
 */
export const PASSKEY_SIGNIN_ORIGINS: Readonly<Record<string, string>> = Object.freeze({
  'https://use.privacynotes.app': 'use.privacynotes.app',
  'https://beta.privacynotes.app': 'beta.privacynotes.app',
  'http://localhost:5173': 'localhost',
  'http://localhost:5174': 'localhost',
});

/** The RP ID of an origin that offers passkey sign-in, or null. */
export function passkeySignInRpId(origin: string): string | null {
  return Object.prototype.hasOwnProperty.call(PASSKEY_SIGNIN_ORIGINS, origin) ? PASSKEY_SIGNIN_ORIGINS[origin]! : null;
}

const SIGNIN_INFO = 'privacynotes-passkey-signin-v1';

/** The user name and display name a sign-in passkey carries in the passkey
 *  app, apart from the unlock passkeys ("PrivacyNotes User") on the same RP
 *  ID. Also used as the visually hidden username field on the password-wrap
 *  forms so password managers attach the passkey password to the passkey item.
 *  Spec: docs/contrib/passkeys.md (4.3) */
export const SIGNIN_PASSKEY_NAME = 'PrivacyNotes sign-in';

/** SHA-256(utf8("privacynotes-passkey-signin-v1")), pinned by
 *  tests/passkeySignIn.test.ts. Spec: docs/contrib/passkeys.md (4.1, P18) */
export const PASSKEY_SIGNIN_PRF_INPUT: Uint8Array = hexToBytes('188337c0cd951e121c4bf47940668887f56315304b87c748953da441c7ff9ad0');

/** Spec: docs/contrib/passkeys.md (P20) */
export const MAX_PASSKEY_SLOTS = 10;

export const PASSKEY_WRAP_PRF = 'prf' as const;
export const PASSKEY_WRAP_PASSWORD = 'pw-s1' as const;

/** Minimum trimmed Unicode code points for a passkey password. Spec: docs/contrib/passkeys.md (4.1) */
export const PASSKEY_PASSWORD_MIN_LENGTH = 12;
export const PASSKEY_PASSWORD_MAX_LENGTH = 256;
const PASSKEY_PASSWORD_MAX_UTF8_BYTES = 1024;
const PASSKEY_USER_HANDLE_BYTES = 32;
const PASSKEY_KDF_SALT_BYTES = 32;
const KDF_SALT_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** The padded plaintext length. Spec: docs/contrib/passkeys.md (4.1) */
const PHRASE_PAD_BYTES = 256;
const AES_GCM_IV_BYTES = 12;
const FUNCTION = 'passkey-slot';

const utf8 = new TextEncoder();

/** Policy check for setting a new passkey password. Kept lightweight here so
 *  the scrypt KDF module (`@notes/shared/passkey-kdf`) stays off the boot path. */
export function passkeyPasswordValid(password: string): boolean {
  if (typeof password !== 'string') return false;
  const nfc = password.normalize('NFC');
  if ([...nfc.trim()].length < PASSKEY_PASSWORD_MIN_LENGTH) return false;
  if ([...nfc].length > PASSKEY_PASSWORD_MAX_LENGTH) return false;
  if (utf8.encode(nfc).length > PASSKEY_PASSWORD_MAX_UTF8_BYTES) return false;
  return true;
}

// ── Where it is offered ───────────────────────────────────────────────

/** Whether this device offers passkey sign-in: a browser (not an app's
 *  webview), WebAuthn present, an origin of the table, not the demo, and
 *  the release switch on. */
export function passkeySignInAvailable(): boolean {
  if (isDemoMode() || !passkeysReleased()) return false;
  if (detectPlatform() !== 'web') return false;
  if (typeof window === 'undefined' || typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return false;
  return passkeySignInRpId(window.location.origin) !== null;
}

// ── The slot's ciphertext ─────────────────────────────────────────────

function slotAad(credentialId: string): Uint8Array {
  return utf8.encode(`privacynotes-passkey-slot-v1:${credentialId}`);
}

function passwordSlotAad(rpId: string, credentialId: string, kdfSalt: string): Uint8Array {
  return utf8.encode(`privacynotes-passkey-slot:${PASSKEY_WRAP_PASSWORD}:${rpId}:${credentialId}:${kdfSalt}`);
}

function labelAad(credentialId: string): string {
  return `privacynotes-passkey-label-v1:${credentialId}`;
}

/** The phrase, UTF-8, right-padded with spaces to 256 bytes. */
export function padPhrase(phrase: string): Uint8Array {
  const bytes = utf8.encode(phrase);
  if (bytes.length > PHRASE_PAD_BYTES) throw new Error('phrase too long');
  const out = new Uint8Array(PHRASE_PAD_BYTES).fill(0x20);
  out.set(bytes);
  return out;
}

/** Encrypt the phrase under the passkey's PRF output, bound to its credential id. */
export async function sealPhraseForSlot(phrase: string, output: Uint8Array, credentialId: string): Promise<{ ciphertext: string; nonce: string }> {
  const key = await keyFromPrf(output, SIGNIN_INFO);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const padded = padPhrase(phrase);
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buf(iv), additionalData: buf(slotAad(credentialId)) }, key, buf(padded),
    ));
    return { ciphertext: bytesToBase64url(ciphertext), nonce: bytesToBase64url(iv) };
  } finally {
    padded.fill(0);
  }
}

/** Open a PRF slot's ciphertext; null when it does not open. The reader trims. */
export async function openSlotPhrase(ciphertext: string, nonce: string, output: Uint8Array, credentialId: string): Promise<string | null> {
  try {
    const key = await keyFromPrf(output, SIGNIN_INFO);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(base64urlToBytes(nonce)), additionalData: buf(slotAad(credentialId)) },
      key, buf(base64urlToBytes(ciphertext)),
    ));
    try {
      const phrase = new TextDecoder().decode(plain).trim().toLowerCase();
      return isValidPhrase(phrase) ? phrase : null;
    } finally {
      plain.fill(0);
    }
  } catch {
    return null;
  }
}

function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i]!;
  return acc === 0;
}

/**
 * Derive a non-extractable AES-GCM-256 key for a `'pw-s1'` slot by mixing the
 * passkey's 32-byte random `userHandle` with `scryptAsync(password, kdfSalt)`
 * through HKDF-SHA256. Dynamically loads `@notes/shared/passkey-kdf` so scrypt
 * never enters the boot-path chunks.
 */
async function derivePasswordSlotKey(password: string, kdfSaltBytes: Uint8Array, userHandle: Uint8Array): Promise<CryptoKey> {
  if (kdfSaltBytes.length !== PASSKEY_KDF_SALT_BYTES) throw new Error('bad kdf salt length');
  if (userHandle.length !== PASSKEY_USER_HANDLE_BYTES || isAllZero(userHandle)) throw new Error('bad user handle');
  // Snapshot userHandle before awaiting dynamic import / scrypt so concurrent
  // zeroization of a caller buffer can never turn IKM into 0^32 || scrypt.
  const handleSnapshot = userHandle.slice();
  let scryptOut: Uint8Array | null = null;
  let ikm: Uint8Array | null = null;
  try {
    const { derivePasskeyScrypt, PASSKEY_PW_HKDF_INFO } = await import('@notes/shared/passkey-kdf');
    scryptOut = await derivePasskeyScrypt(password, kdfSaltBytes);
    ikm = new Uint8Array(handleSnapshot.length + scryptOut.length);
    ikm.set(handleSnapshot, 0);
    ikm.set(scryptOut, handleSnapshot.length);
    const material = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: buf(kdfSaltBytes), info: buf(utf8.encode(PASSKEY_PW_HKDF_INFO)) },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    handleSnapshot.fill(0);
    scryptOut?.fill(0);
    ikm?.fill(0);
  }
}

/**
 * Seal the recovery phrase for a `'pw-s1'` slot and immediately verify
 * AES-GCM round-trip decryption with the same non-extractable key before
 * anything leaves the device.
 */
export async function sealPasswordSlotPhrase(
  phrase: string,
  password: string,
  kdfSalt: string,
  userHandle: Uint8Array,
  rpId: string,
  credentialId: string,
): Promise<{ ciphertext: string; nonce: string }> {
  if (!KDF_SALT_RE.test(kdfSalt)) throw new Error('invalid kdfSalt');
  const saltBytes = base64urlToBytes(kdfSalt);
  const key = await derivePasswordSlotKey(password, saltBytes, userHandle);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const aad = passwordSlotAad(rpId, credentialId, kdfSalt);
  const padded = padPhrase(phrase);
  let ciphertext: Uint8Array;
  try {
    ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(padded),
    ));
  } finally {
    padded.fill(0);
  }
  const check = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(ciphertext),
  ));
  let opened: string;
  try {
    opened = new TextDecoder().decode(check).trim().toLowerCase();
  } finally {
    check.fill(0);
  }
  if (opened !== phrase.trim().toLowerCase() || !isValidPhrase(opened)) {
    throw new Error('passkey slot round-trip check failed');
  }
  return { ciphertext: bytesToBase64url(ciphertext), nonce: bytesToBase64url(iv) };
}

export type UnlockPasswordSlotResult =
  | { ok: true; phrase: string }
  | { ok: false; reason: 'wrong_password' | 'failed' };

async function openPasswordSlotDetailed(
  ciphertext: string,
  nonce: string,
  password: string,
  kdfSalt: string,
  userHandle: Uint8Array,
  rpId: string,
  credentialId: string,
): Promise<UnlockPasswordSlotResult> {
  if (!password) return { ok: false, reason: 'wrong_password' };
  if (!KDF_SALT_RE.test(kdfSalt) || userHandle.length !== PASSKEY_USER_HANDLE_BYTES || isAllZero(userHandle)) {
    return { ok: false, reason: 'failed' };
  }
  let key: CryptoKey;
  try {
    const saltBytes = base64urlToBytes(kdfSalt);
    key = await derivePasswordSlotKey(password, saltBytes, userHandle);
  } catch (err) {
    // Password exceeding the KDF UTF-8 cap cannot match any saved slot.
    if (err instanceof Error && (err.message === 'empty password' || err.message === 'password out of bounds')) {
      return { ok: false, reason: 'wrong_password' };
    }
    return { ok: false, reason: 'failed' };
  }
  const aad = passwordSlotAad(rpId, credentialId, kdfSalt);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(base64urlToBytes(nonce)), additionalData: buf(aad) },
      key, buf(base64urlToBytes(ciphertext)),
    ));
  } catch (err) {
    // WebCrypto AES-GCM authentication tag mismatch throws OperationError.
    if (err instanceof Error && err.name === 'OperationError') {
      return { ok: false, reason: 'wrong_password' };
    }
    return { ok: false, reason: 'failed' };
  }
  try {
    const phrase = new TextDecoder().decode(plain).trim().toLowerCase();
    return isValidPhrase(phrase) ? { ok: true, phrase } : { ok: false, reason: 'wrong_password' };
  } finally {
    plain.fill(0);
  }
}

/** Open a `'pw-s1'` slot's ciphertext; null when password, userHandle, or AAD fails. */
export async function openPasswordSlotPhrase(
  ciphertext: string,
  nonce: string,
  password: string,
  kdfSalt: string,
  userHandle: Uint8Array,
  rpId: string,
  credentialId: string,
): Promise<string | null> {
  const res = await openPasswordSlotDetailed(ciphertext, nonce, password, kdfSalt, userHandle, rpId, credentialId);
  return res.ok ? res.phrase : null;
}

/**
 * The digest add and remove sign: lowercase SHA-256 hex over the JSON of
 * every body field but `action`, `nonceId` and `signature`, keys sorted.
 * The edge function computes the same (`passkey-slot`, P19).
 */
export async function slotBodyDigest(fields: Record<string, string | number>): Promise<string> {
  const sorted: Record<string, string | number> = {};
  for (const key of Object.keys(fields).sort()) sorted[key] = fields[key]!;
  return sha256Hex(utf8.encode(JSON.stringify(sorted)));
}

// ── Server calls ──────────────────────────────────────────────────────

type Refusal = { code: string | null; status: number | null };

async function refusalOf(error: unknown): Promise<Refusal> {
  const fe = error as FnError & { context?: { status?: unknown } };
  const status = typeof fe?.context?.status === 'number' ? fe.context.status : null;
  let body: { error?: unknown } | null = null;
  try {
    body = (await readFnErrorBody(fe)) as { error?: unknown } | null;
  } catch {
    body = null;
  }
  const code = typeof body?.error === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(body.error) ? body.error : null;
  return { code, status };
}

type Invoked = { data: unknown; refusal: Refusal | null };

async function call(supabase: SupabaseClient, bearer: string, body: Record<string, unknown>): Promise<Invoked> {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION, { body, headers: { Authorization: `Bearer ${bearer}` } });
    if (!error) return { data, refusal: null };
    return { data: null, refusal: await refusalOf(error) };
  } catch {
    return { data: null, refusal: { code: null, status: null } };
  }
}

/** The open vault's session and keys (auth.tsx `phraseChangeActor`). */
export type SlotActor = {
  supabase: SupabaseClient;
  accessToken: string;
  authUid: string;
  sessionId: string;
  accountId: string;
  phrase: string;
  signingPrivateKey: Uint8Array;
  /** The current sync key: it seals the slot's name. */
  encryptionKey: Uint8Array;
};

/**
 * The bearer for add and remove, after a 2FA code from the last five minutes
 * where the account has 2FA (the server's `account_assert_actor` wants one
 * for both). The check can refresh the token, never the session the
 * signature names. Null when the person cancelled or the session changed.
 */
async function freshBearer(actor: SlotActor): Promise<string | null | 'cancelled'> {
  try {
    await ensureLevel2(actor.supabase, { force: true, allowLocalUse: true });
    const { data } = await actor.supabase.auth.getSession();
    const live = data.session;
    if (live?.user?.id && live.user.id !== actor.authUid) return null;
    return typeof live?.access_token === 'string' && live.access_token ? live.access_token : actor.accessToken;
  } catch (err) {
    return isCancel(err) || (err as Error)?.name === 'MfaCancelledError' ? 'cancelled' : null;
  }
}

/** A fresh nonce bound to the body's digest, then the signature over the
 *  nonce, the session and that digest. */
async function signedFields(
  actor: SlotActor,
  bearer: string,
  operation: 'passkey-add' | 'passkey-remove',
  fields: Record<string, string | number>,
): Promise<{ nonceId: string; signature: string } | { refusal: Refusal }> {
  const bodyDigest = await slotBodyDigest(fields);
  const issued = await call(actor.supabase, bearer, { action: 'nonce', operation, bodyDigest });
  if (issued.refusal) return { refusal: issued.refusal };
  const nonceId = (issued.data as { nonceId?: unknown } | null)?.nonceId;
  if (typeof nonceId !== 'string' || !isUuid(nonceId)) return { refusal: { code: null, status: null } };
  try {
    // The signer refuses a part of the wrong shape: a refusal, never a throw.
    const signature = bytesToHex(await signPasskeySlotChallenge(actor.signingPrivateKey, {
      nonceId, authUid: actor.authUid, sessionId: actor.sessionId, account: actor.accountId, operation, bodyDigest,
    }));
    return { nonceId, signature };
  } catch {
    return { refusal: { code: null, status: null } };
  }
}

// ── Add ───────────────────────────────────────────────────────────────

/**
 * A newly created non-PRF passkey waiting for the user to set a passkey
 * password. Deliberately holds neither the `SlotActor` (phrase / keys) nor a
 * bearer token: `PasskeysTab` fetches the actor fresh at Save.
 */
export type PendingPasswordPasskey = {
  rpId: string;
  credentialId: string;
  publicKey: string;
  alg: number;
  label: string;
  /** 32-byte random `user.id` stored in the passkey; never sent to server. */
  userHandle: Uint8Array;
};

export type BeginAddPasskeyResult =
  | { ok: true; status: 'added' }
  | { ok: true; status: 'needs_password'; pending: PendingPasswordPasskey }
  | { ok: false; reason: 'unavailable' | 'cancelled' | 'too_many' | 'failed' };

export type FinishPasswordPasskeyResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'invalid_password' | 'cancelled' | 'too_many' | 'failed'; retryable: boolean };

const TERMINAL_ADD_CODES = new Set(['too_many', 'id_taken', 'phrase_replaced', 'phrase_refused']);
const STALE_MFA_CODES = new Set(['mfa_required', 'account_auth_required']);

function isCancel(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/**
 * Discard an unsaved pending non-PRF passkey: zeroes its local `userHandle`
 * and signals the passkey provider that the credential is unused (best-effort
 * hint; Bitwarden's script does not handle signalUnknownCredential yet, so UI
 * copy also reminds the user).
 */
export function cancelPendingSignInPasskey(pending: PendingPasswordPasskey | null): void {
  if (!pending) return;
  pending.userHandle.fill(0);
  signalUnknownCredential(pending.rpId, pending.credentialId);
}

/**
 * Make a sign-in passkey and store its slot (1-click PRF when the provider
 * supplies a 32-byte PRF output; otherwise returns `needs_password` with a
 * `PendingPasswordPasskey` so the UI can collect a passkey password without
 * losing the new credential).
 *
 * The passkey is discoverable, with user verification, a 32-byte random
 * `user.id`, the fixed PRF input, and `credProtect` `userVerificationRequired`
 * (best-effort, non-enforced so software managers keep working). A provider
 * that enables PRF at creation and evaluates it only on an assertion gets one
 * `get` for the new credential (copying its `transports`). The caller runs the
 * PIN gate first (4.4); this asks for a recent 2FA check where 2FA is on,
 * before creating any passkey so a cancel leaves nothing behind.
 */
export async function beginAddSignInPasskey(actor: SlotActor, label: string): Promise<BeginAddPasskeyResult> {
  if (isDemoMode() || !passkeySignInAvailable()) return { ok: false, reason: 'unavailable' };
  const rpId = passkeySignInRpId(window.location.origin);
  if (!rpId) return { ok: false, reason: 'unavailable' };

  // The 2FA step first, before any passkey exists: a cancel here leaves
  // nothing behind in the person's passkey app.
  const bearer = await freshBearer(actor);
  if (bearer === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (!bearer) return { ok: false, reason: 'failed' };

  const userId = crypto.getRandomValues(new Uint8Array(PASSKEY_USER_HANDLE_BYTES));
  const createOptions: PublicKeyCredentialCreationOptions = {
    rp: { id: rpId, name: 'PrivacyNotes' },
    // A name of its own: in production the biometric unlock passkeys share
    // this RP ID, and the provider's list must tell the two apart.
    user: { id: buf(userId), name: SIGNIN_PASSKEY_NAME, displayName: SIGNIN_PASSKEY_NAME },
    challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' }, // ES256
      { alg: -257, type: 'public-key' }, // RS256
    ],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  };
  // prf and credProtect are not yet in every TS type definition.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (createOptions as any).extensions = {
    prf: { eval: { first: buf(PASSKEY_SIGNIN_PRF_INPUT) } },
    credentialProtectionPolicy: 'userVerificationRequired',
    enforceCredentialProtectionPolicy: false,
  };

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({ publicKey: createOptions })) as PublicKeyCredential | null;
  } catch (err) {
    userId.fill(0);
    return { ok: false, reason: isCancel(err) ? 'cancelled' : 'failed' };
  }
  if (!credential) {
    userId.fill(0);
    return { ok: false, reason: 'cancelled' };
  }
  const rawId = new Uint8Array(credential.rawId);
  const credentialId = bytesToBase64url(rawId);
  // From here a passkey exists in the person's passkey app. A stop before
  // the add went out, or an add the server refused with its own code, tells
  // the provider this new credential is unused; never another credential,
  // and never after an add whose answer was lost (the slot may be stored).
  const drop = (reason: 'cancelled' | 'too_many' | 'failed'): BeginAddPasskeyResult => {
    userId.fill(0);
    signalUnknownCredential(rpId, credentialId);
    return { ok: false, reason };
  };

  const response = credential.response as AuthenticatorAttestationResponse;
  let spki: ArrayBuffer | null = null;
  let alg: number | null = null;
  let transports: AuthenticatorTransport[] = [];
  try {
    spki = response.getPublicKey?.() ?? null;
    alg = response.getPublicKeyAlgorithm?.() ?? null;
    const rawTransports = response.getTransports?.();
    if (Array.isArray(rawTransports)) transports = rawTransports as AuthenticatorTransport[];
  } catch {
    spki = null;
  }
  if (!spki || (alg !== -7 && alg !== -257)) return drop('failed');
  const publicKey = bytesToBase64url(new Uint8Array(spki));

  const prf = prfResultsOf(credential);
  let output: Uint8Array | null = null;
  if (prf?.enabled === true) {
    output = prfOutput(prf.results?.first);
    if (!output) {
      const descriptor: PublicKeyCredentialDescriptor = transports.length > 0
        ? { id: buf(rawId), type: 'public-key', transports }
        : { id: buf(rawId), type: 'public-key' };
      const getOptions: PublicKeyCredentialRequestOptions = {
        rpId,
        challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
        allowCredentials: [descriptor],
        userVerification: 'required',
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (getOptions as any).extensions = { prf: { eval: { first: buf(PASSKEY_SIGNIN_PRF_INPUT) } } };
      let assertion: PublicKeyCredential | null;
      try {
        assertion = (await navigator.credentials.get({ publicKey: getOptions })) as PublicKeyCredential | null;
      } catch (err) {
        return drop(isCancel(err) ? 'cancelled' : 'failed');
      }
      if (!assertion) return drop('cancelled');
      output = prfOutput(prfResultsOf(assertion)?.results?.first);
      // If the second touch succeeded without returning 32-byte PRF output
      // (e.g. an iOS security key or quirky firmware), fall through to the
      // password-wrap step instead of discarding the passkey.
    }
  }

  if (!output) {
    return {
      ok: true,
      status: 'needs_password',
      pending: { rpId, credentialId, publicKey, alg, label, userHandle: userId },
    };
  }

  // 1-click PRF path: exact 10-key add body (backwards compatible with 0131).
  let fields: Record<string, string | number>;
  try {
    const sealed = await sealPhraseForSlot(actor.phrase, output, credentialId);
    const name = encryptJsonAad(label, actor.encryptionKey, labelAad(credentialId));
    fields = {
      credentialId,
      publicKey,
      alg,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      labelCiphertext: bytesToBase64url(name.ciphertext),
      labelNonce: bytesToBase64url(name.nonce),
    };
  } catch {
    return drop('failed');
  } finally {
    output.fill(0);
    userId.fill(0);
  }

  const signed = await signedFields(actor, bearer, 'passkey-add', fields);
  if ('refusal' in signed) return drop('failed');
  const added = await call(actor.supabase, bearer, { action: 'add', ...fields, ...signed });
  if (added.refusal) {
    const { code, status } = added.refusal;
    const refused = code !== null && status !== null && status >= 400 && status < 500;
    if (!refused) return { ok: false, reason: 'failed' };
    return drop(code === 'too_many' ? 'too_many' : 'failed');
  }
  if ((added.data as { ok?: unknown } | null)?.ok !== true) return { ok: false, reason: 'failed' };
  return { ok: true, status: 'added' };
}

/**
 * Finish adding a non-PRF sign-in passkey by sealing the phrase under the
 * passkey's `userHandle` and the user's chosen passkey password, then sending
 * the signed 12-key `'pw-s1'` add request.
 *
 * Handles stale 2FA (>5 minutes spent choosing a password) on both `nonce`
 * (`account_auth_required`) and `add` (`mfa_required` / `account_auth_required`)
 * with one `freshBearer` refresh and retry without running scrypt a second time.
 * Never signals `signalUnknownCredential` on recoverable/network errors so the
 * user can retry without losing the passkey they already created.
 */
export async function finishPasswordSignInPasskey(
  actor: SlotActor,
  pending: PendingPasswordPasskey,
  password: string,
  opts?: { onDispatch?: () => void; onResetDispatch?: () => void; isCancelled?: () => boolean },
): Promise<FinishPasswordPasskeyResult> {
  if (isDemoMode() || !passkeySignInAvailable()) return { ok: false, reason: 'unavailable', retryable: false };
  if (!passkeyPasswordValid(password)) {
    return { ok: false, reason: 'invalid_password', retryable: true };
  }
  const handleCopy = pending.userHandle.slice();
  if (handleCopy.length !== PASSKEY_USER_HANDLE_BYTES || isAllZero(handleCopy)) {
    handleCopy.fill(0);
    return { ok: false, reason: 'failed', retryable: false };
  }

  const kdfSalt = bytesToBase64url(crypto.getRandomValues(new Uint8Array(PASSKEY_KDF_SALT_BYTES)));
  let fields: Record<string, string | number>;
  try {
    const sealed = await sealPasswordSlotPhrase(
      actor.phrase, password, kdfSalt, handleCopy, pending.rpId, pending.credentialId,
    );
    const name = encryptJsonAad(pending.label, actor.encryptionKey, labelAad(pending.credentialId));
    fields = {
      credentialId: pending.credentialId,
      publicKey: pending.publicKey,
      alg: pending.alg,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      labelCiphertext: bytesToBase64url(name.ciphertext),
      labelNonce: bytesToBase64url(name.nonce),
      wrapKind: PASSKEY_WRAP_PASSWORD,
      kdfSalt,
    };
  } catch {
    return { ok: false, reason: 'failed', retryable: true };
  } finally {
    handleCopy.fill(0);
  }

  if (opts?.isCancelled?.()) return { ok: false, reason: 'cancelled', retryable: true };

  const submitOnce = async (token: string): Promise<{ sentAdd: boolean; cancelled?: boolean; data: unknown; refusal: Refusal | null }> => {
    const signed = await signedFields(actor, token, 'passkey-add', fields);
    if ('refusal' in signed) return { sentAdd: false, data: null, refusal: signed.refusal };
    if (opts?.isCancelled?.()) return { sentAdd: false, cancelled: true, data: null, refusal: null };
    opts?.onDispatch?.();
    const added = await call(actor.supabase, token, { action: 'add', ...fields, ...signed });
    return { sentAdd: true, data: added.data, refusal: added.refusal };
  };

  let res = await submitOnce(actor.accessToken);
  if (res.cancelled) return { ok: false, reason: 'cancelled', retryable: true };
  if (res.refusal?.code && STALE_MFA_CODES.has(res.refusal.code)) {
    if (res.sentAdd) opts?.onResetDispatch?.();
    const refreshed = await freshBearer(actor);
    if (refreshed === 'cancelled' || opts?.isCancelled?.()) return { ok: false, reason: 'cancelled', retryable: true };
    if (!refreshed) return { ok: false, reason: 'failed', retryable: true };
    res = await submitOnce(refreshed);
    if (res.cancelled) return { ok: false, reason: 'cancelled', retryable: true };
  }

  if (!res.refusal && (res.data as { ok?: unknown } | null)?.ok === true) {
    pending.userHandle.fill(0);
    return { ok: true };
  }

  const code = res.refusal?.code ?? null;
  const status = res.refusal?.status ?? null;
  if (code !== null && TERMINAL_ADD_CODES.has(code)) {
    cancelPendingSignInPasskey(pending);
    return { ok: false, reason: code === 'too_many' ? 'too_many' : 'failed', retryable: false };
  }
  // Definite 4xx rejection means the server refused without storing the slot,
  // so allow clean Cancel / unmount cleanup again without losing retryability.
  if (res.sentAdd && code !== null && status !== null && status >= 400 && status < 500) {
    opts?.onResetDispatch?.();
  }
  return { ok: false, reason: 'failed', retryable: true };
}

// ── Sign in ───────────────────────────────────────────────────────────

/** A released `'pw-s1'` slot waiting for the user's passkey password. */
export type PendingPasswordSignIn = {
  rpId: string;
  credentialId: string;
  ciphertext: string;
  nonce: string;
  kdfSalt: string;
  /** 32-byte userHandle from the passkey assertion; zeroed on unlock/cancel/timeout. */
  userHandle: Uint8Array;
};

export type SignInPasskeyResult =
  | { ok: true; phrase: string }
  | { ok: false; reason: 'needs_password'; pending: PendingPasswordSignIn }
  | { ok: false; reason: 'unavailable' | 'cancelled' | 'no_prf' | 'not_found' | 'retired' | 'rate_limited' | 'unsupported_slot' | 'network' };

/** The anon key every signed-out call goes out with, never a session. */
function anonKey(): string | null {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return key || null;
}

/** Zeroize the local `userHandle` of an abandoned or expired Step-2 password sign-in. */
export function clearPendingPasswordSignIn(pending: PendingPasswordSignIn | null): void {
  pending?.userHandle.fill(0);
}

/**
 * Sign in with a passkey: a one-time challenge, a discoverable `get` with the
 * PRF input, the server's `release` of the slot, then branch solely on the
 * server's `slot.wrapKind`:
 * - `'prf'`: open immediately with the 32-byte PRF output and return the phrase.
 * - `'pw-s1'`: discard any PRF output (in case the provider later added PRF),
 *   verify the 32-byte `userHandle`, and return `needs_password` for Step 2.
 * - Any unknown `wrapKind`: fail closed with `unsupported_slot`.
 *
 * `signalUnknownCredential` goes out only for the function's own `retired`
 * answer. An unknown credential is never signalled: the biometric unlock
 * passkeys share the RP ID (localhost in development, use.privacynotes.app in
 * production), and the person may have picked one.
 */
export async function signInPasskeyPhrase(supabase: SupabaseClient): Promise<SignInPasskeyResult> {
  if (isDemoMode() || !passkeySignInAvailable()) return { ok: false, reason: 'unavailable' };
  const rpId = passkeySignInRpId(window.location.origin);
  const bearer = anonKey();
  if (!rpId || !bearer) return { ok: false, reason: 'unavailable' };

  const issued = await call(supabase, bearer, { action: 'challenge' });
  if (issued.refusal) return { ok: false, reason: issued.refusal.code === 'rate_limited' || issued.refusal.status === 429 ? 'rate_limited' : 'network' };
  const challenge = (issued.data as { challenge?: unknown } | null)?.challenge;
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)) return { ok: false, reason: 'network' };

  const getOptions: PublicKeyCredentialRequestOptions = {
    rpId,
    challenge: buf(base64urlToBytes(challenge)),
    userVerification: 'required',
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (getOptions as any).extensions = { prf: { eval: { first: buf(PASSKEY_SIGNIN_PRF_INPUT) } } };
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({ publicKey: getOptions })) as PublicKeyCredential | null;
  } catch (err) {
    return { ok: false, reason: isCancel(err) ? 'cancelled' : 'network' };
  }
  if (!assertion) return { ok: false, reason: 'cancelled' };
  const credentialId = bytesToBase64url(new Uint8Array(assertion.rawId));
  const output = prfOutput(prfResultsOf(assertion)?.results?.first);

  const response = assertion.response as AuthenticatorAssertionResponse;
  const userHandle = response.userHandle ? new Uint8Array(response.userHandle) : null;
  const released = await call(supabase, bearer, {
    action: 'release',
    credentialId,
    clientDataJSON: bytesToBase64url(new Uint8Array(response.clientDataJSON)),
    authenticatorData: bytesToBase64url(new Uint8Array(response.authenticatorData)),
    signature: bytesToBase64url(new Uint8Array(response.signature)),
  });
  if (released.refusal) {
    output?.fill(0);
    userHandle?.fill(0);
    const { code, status } = released.refusal;
    // Only the function's own codes count: a bare 404 or 410 from a gateway
    // says nothing about the slot.
    if (code === 'retired') {
      signalUnknownCredential(rpId, credentialId);
      return { ok: false, reason: 'retired' };
    }
    // Never signalled: the person may have picked a biometric unlock
    // passkey, which shares the RP ID and which the server does not know.
    if (code === 'not_found') return { ok: false, reason: 'not_found' };
    if (code === 'rate_limited' || status === 429) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: 'network' };
  }
  const slot = released.data as { ciphertext?: unknown; nonce?: unknown; wrapKind?: unknown; kdfSalt?: unknown } | null;
  if (typeof slot?.ciphertext !== 'string' || typeof slot.nonce !== 'string') {
    output?.fill(0);
    userHandle?.fill(0);
    return { ok: false, reason: 'network' };
  }

  const wrapKind = slot.wrapKind === undefined ? PASSKEY_WRAP_PRF : slot.wrapKind;
  if (wrapKind === PASSKEY_WRAP_PRF) {
    userHandle?.fill(0);
    if (!output) return { ok: false, reason: 'no_prf' };
    try {
      const phrase = await openSlotPhrase(slot.ciphertext, slot.nonce, output, credentialId);
      // A ciphertext the PRF output does not open: this passkey app gave
      // another output than at the add, so it cannot unlock the notes.
      if (!phrase) return { ok: false, reason: 'no_prf' };
      return { ok: true, phrase };
    } finally {
      output.fill(0);
    }
  }

  // Always discard any PRF output on a password-wrapped slot (e.g. if the
  // provider shipped PRF support after this slot was created).
  output?.fill(0);

  if (wrapKind === PASSKEY_WRAP_PASSWORD) {
    if (typeof slot.kdfSalt !== 'string' || !KDF_SALT_RE.test(slot.kdfSalt)) {
      userHandle?.fill(0);
      return { ok: false, reason: 'network' };
    }
    if (!userHandle || userHandle.length !== PASSKEY_USER_HANDLE_BYTES || isAllZero(userHandle)) {
      userHandle?.fill(0);
      return { ok: false, reason: 'no_prf' };
    }
    return {
      ok: false,
      reason: 'needs_password',
      pending: {
        rpId,
        credentialId,
        ciphertext: slot.ciphertext,
        nonce: slot.nonce,
        kdfSalt: slot.kdfSalt,
        userHandle,
      },
    };
  }

  userHandle?.fill(0);
  return { ok: false, reason: 'unsupported_slot' };
}

/**
 * Unlock a released `'pw-s1'` slot with the user's passkey password.
 * Zeroes `pending.userHandle` only on success; on a wrong password or transient
 * error it keeps `pending` intact so the caller can let the user retry without
 * re-prompting WebAuthn, distinguishing `'wrong_password'` from `'failed'`.
 */
export async function unlockPasswordSignInSlot(pending: PendingPasswordSignIn, password: string): Promise<UnlockPasswordSlotResult> {
  const result = await openPasswordSlotDetailed(
    pending.ciphertext,
    pending.nonce,
    password,
    pending.kdfSalt,
    pending.userHandle,
    pending.rpId,
    pending.credentialId,
  );
  if (result.ok) pending.userHandle.fill(0);
  return result;
}

// ── List and remove ───────────────────────────────────────────────────

export type SignInPasskeySlot = {
  credentialId: string;
  /** The name, opened with the sync key; null when it does not open (a slot
   *  added under an earlier phrase). */
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** False for a slot added before the phrase changed (retired, P16). */
  current: boolean;
  /** `'prf'` for 1-click slots; any non-`'prf'` wrap_kind maps to `'password'`
   *  so older tabs can still display and remove future password wrap versions. */
  wrapKind: 'prf' | 'password';
};

export type ListPasskeysResult = { ok: true; slots: SignInPasskeySlot[] } | { ok: false };

function openLabel(row: { credentialId: string; labelCiphertext?: unknown; labelNonce?: unknown }, key: Uint8Array): string | null {
  if (typeof row.labelCiphertext !== 'string' || typeof row.labelNonce !== 'string' || !row.labelCiphertext) return null;
  try {
    const value = decryptJsonAad<unknown>(base64urlToBytes(row.labelCiphertext), base64urlToBytes(row.labelNonce), key, labelAad(row.credentialId));
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** The account's sign-in passkeys. The demo has none and asks nothing. */
export async function listSignInPasskeys(actor: SlotActor): Promise<ListPasskeysResult> {
  if (isDemoMode()) return { ok: true, slots: [] };
  const listed = await call(actor.supabase, actor.accessToken, { action: 'list' });
  if (listed.refusal) return { ok: false };
  const rows = (listed.data as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(rows)) return { ok: false };
  const slots: SignInPasskeySlot[] = [];
  for (const raw of rows as Array<Record<string, unknown>>) {
    if (!raw || typeof raw.credentialId !== 'string' || typeof raw.createdAt !== 'string') continue;
    slots.push({
      credentialId: raw.credentialId,
      label: openLabel({ ...raw, credentialId: raw.credentialId }, actor.encryptionKey),
      createdAt: raw.createdAt,
      lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
      current: raw.current !== false,
      wrapKind: raw.wrapKind === undefined || raw.wrapKind === PASSKEY_WRAP_PRF ? 'prf' : 'password',
    });
  }
  return { ok: true, slots };
}

/** Remove one slot, after the same 2FA check as an add. The passkey itself
 *  stays in the person's passkey app. */
export async function removeSignInPasskey(actor: SlotActor, credentialId: string): Promise<{ ok: true } | { ok: false; reason: 'cancelled' | 'not_found' | 'failed' }> {
  if (isDemoMode()) return { ok: false, reason: 'failed' };
  const bearer = await freshBearer(actor);
  if (bearer === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (!bearer) return { ok: false, reason: 'failed' };
  const fields = { credentialId };
  const signed = await signedFields(actor, bearer, 'passkey-remove', fields);
  if ('refusal' in signed) return { ok: false, reason: 'failed' };
  const removed = await call(actor.supabase, bearer, { action: 'remove', ...fields, ...signed });
  if (removed.refusal) return { ok: false, reason: removed.refusal.code === 'not_found' ? 'not_found' : 'failed' };
  return { ok: true };
}

/** How many sign-in passkeys still sign in, for the phrase change's
 *  summary (P16): a change retires them. Null when the server gave no answer. */
export async function countSignInPasskeys(actor: SlotActor): Promise<number | null> {
  if (!passkeysReleased()) return 0;
  const listed = await listSignInPasskeys(actor);
  return listed.ok ? listed.slots.filter((slot) => slot.current).length : null;
}
