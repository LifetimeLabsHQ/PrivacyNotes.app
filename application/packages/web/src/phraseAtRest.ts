/**
 * Phrase at rest - the stored recovery phrase is an AES-GCM envelope
 * wherever the platform allows (see the failure policy below).
 *
 * In the apps the wrap key comes from the device key first (`pnwrap2:`):
 * a key the OS keeps outside the app's storage (Secure Enclave, Android
 * Keystore, DPAPI, the Linux Secret Service) seals a random secret, the envelope carries only the
 * sealed handle, and HKDF over the secret gives the AES key. A copy of the
 * app's data folder then holds only ciphertext, and on Apple devices and
 * Android so does a backup restored on another device (Windows and Linux
 * keys follow the login account). Where the shell has no such store (a Linux desktop
 * without an unlocked keyring, a Mac without a Secure Enclave, the web) the
 * key below is used, as before.
 * Spec: docs/internal/plans/device-bound-phrase-key.md
 *
 * A phrase readable from storage is the whole account: whoever holds
 * the storage file holds the vault. So the stored value is an AES-GCM
 * envelope under a non-extractable WebCrypto AES-256 key that lives in
 * IndexedDB (db.kv). IndexedDB persists the CryptoKey OBJECT via
 * structured clone; the raw key bytes never exist in script-readable
 * form, so a copied localStorage file alone, or a script-level dump,
 * does not open the envelope (while this device's lock is on, or while it
 * keeps no phrase at rest, it keeps the account's PIN or passcode wrap, so
 * such a copy is bound by that secret's strength). "Non-extractable" is a script-API property,
 * not hardware: the browser writes the key's bytes into its own IndexedDB
 * files, so a copy of the whole profile or app data folder opens the
 * envelope with a parser of those files. An attacker who can RUN CODE in
 * this origin on this machine can use the key directly. Both boundaries
 * are documented in THREAT_MODEL.md ("Local storage at rest"); the app
 * lock removes this envelope.
 *
 * The envelope reuses the phrase's own storage key. Every presence
 * check (hasStoredPhrase, the app-lock gate, sign-out removal, the
 * demo credential sweep) keys on presence, not shape, so they all keep
 * working unchanged.
 *
 * Failure policy, in one line: the phrase is never written as plain
 * text. If the browser key fails (no working IndexedDB or WebCrypto),
 * persist tries once more after a reopen, then writes nothing: the
 * session lives in this tab's memory, a banner says that closing the
 * tab signs out, and the next start asks for the phrase. A plain value
 * an older version wrote stays where it is (removing the only copy
 * could strand a person who never wrote the words down); the PIN tab
 * warns while it holds. A lost wrap key (envelope present, key gone)
 * demotes to the sign-in screen, where re-entering the phrase repairs
 * everything.
 * Spec: docs/internal/plans/phrase-lock-hardening.md (section 1)
 *
 * Spec: THREAT_MODEL.md (phrase wrapped at rest under a
 * non-extractable device key)
 */

import { base64ToBytes, bytesToBase64, hexToBytes, isValidPhrase } from '@notes/shared';
import { db, reopenDb } from './db';
import { PHRASE_STORAGE_KEY, hasPendingPhraseChange } from './authStorage';
import { isTrustedDevice, tabSecrets, trustAwareStorage } from './trustStorage';
import { setSessionSealArmed, settleStoredSession } from './sessionSeal';
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  hasBiometricCredential,
  hasPinWrappedPhrase,
  invokeTauri,
} from './biometric';
import { keyFromPrf } from './webauthn';
import { settingsLocalKey } from './settingsLocalKey';
import { inNativeShell } from './appShell';
import { logAuthEvent } from './authDiag';
import { isLivePhrase, signInStamp, signedOutSince, type SignInStamp } from './liveSignIn';

// Version-prefixed so a future format change can coexist with old
// envelopes during a migration. A BIP-39 phrase is lowercase words and
// spaces, so the prefix cannot collide with legacy plaintext values.
const ENVELOPE_PREFIX = 'pnwrap1:';
// `pnwrap2:<handle>:<iv>:<ciphertext>`, under the device key. An older
// bundle reads it as no session and shows the sign-in screen.
const DEVICE_ENVELOPE_PREFIX = 'pnwrap2:';
const DEVICE_HKDF_INFO = 'privacynotes-device-wrap-v1';
const DEVICE_SECRET_BYTES = 32;
// Apple `sd1.<hex>.<hex>`, Android `kd1.<hex>.<hex>`, Windows `dp1.<hex>`,
// Linux `ss1.<hex>.<hex>`:
// never a ':', which separates the envelope's parts.
const DEVICE_HANDLE = /^[a-z]{2}\d\.[0-9a-f.]+$/;
// Time limits on the shell, so a store that never answers holds neither the
// boot nor a sign-in. The interactive open waits for the Linux unlock
// dialog, which the native side gives up on after 60 seconds.
const DEVICE_CALL_MS = 15_000;
const DEVICE_PROMPT_MS = 75_000;
// A busy store (a Keystore or DPAPI hiccup) gets one more try after this.
const DEVICE_RETRY_DELAY_MS = 600;
// db.kv: set while the shell answers that it has no device key (Linux
// without an unlocked keyring, a Mac without a Secure Enclave), so the boot
// does not ask at every start. Every write asks again and updates it.
const DEVICE_KEY_MISSING_KV = 'deviceKeyMissing';

// db.kv slot for the device wrap key. Stored as a CryptoKey object
// (structured clone), NOT exported bytes - non-extractable is the
// entire point. Lives beside the owner mirror; account deletion's
// db.delete() destroys it, sign-out leaves it (it wraps nothing once
// the envelope is removed, and the next sign-in reuses it).
const WRAP_KEY_KV = 'phraseWrapKey';

/** True when a stored phrase value is a wrapped envelope rather than
 *  legacy plaintext. */
export function isWrappedEnvelope(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX) || value.startsWith(DEVICE_ENVELOPE_PREFIX);
}

export { inNativeShell };

/**
 * True when a stored envelope is under the browser key in an app whose
 * device key it could move to. The boot then writes the phrase again, and
 * the write prefers the device key; a shell without one writes the same
 * kind of envelope back.
 */
export function needsDeviceRewrap(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX) && inNativeShell();
}

/** The secret arrives as hex; anything else, or the wrong length, is no secret. */
function deviceSecret(hex: unknown): Uint8Array | null {
  if (typeof hex !== 'string') return null;
  try {
    const bytes = hexToBytes(hex);
    return bytes.length === DEVICE_SECRET_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject('timeout'), ms);
    call.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markDeviceKeyMissing(missing: boolean): Promise<void> {
  try {
    if (missing) await db.kv.put({ key: DEVICE_KEY_MISSING_KV, value: '1' });
    else await db.kv.delete(DEVICE_KEY_MISSING_KV);
  } catch { /* a hint only: the next write asks again */ }
}

/**
 * True where the OS keeps no device key for this app: the web, and a shell
 * that answered at the last write that it has none. A shell that never
 * wrote, or whose create failed, reads as one with a key.
 * Spec: docs/internal/plans/pin-wrap-hardening.md (section 5, C1)
 */
export async function noDeviceKeyHere(): Promise<boolean> {
  return !inNativeShell() || (await deviceKeyKnownMissing());
}

/** True when the shell answered at the last write that it has no device key. */
export async function deviceKeyKnownMissing(): Promise<boolean> {
  try {
    return (await db.kv.get(DEVICE_KEY_MISSING_KV))?.value === '1';
  } catch {
    return false;
  }
}

/**
 * A fresh device-key secret and its handle; `unsupported` where the shell has
 * no device key. `info` names what the derived key is for, so the phrase
 * envelope and the PIN wrap seal (pinWrapSeal.ts) never share a key.
 */
export async function deviceKeyCreate(info = DEVICE_HKDF_INFO): Promise<{ handle: string; key: CryptoKey } | 'unsupported' | 'failed'> {
  if (!inNativeShell()) return 'unsupported';
  let made: { handle?: unknown; secret?: unknown };
  try {
    made = await withTimeout(invokeTauri<{ handle?: unknown; secret?: unknown }>('device_key_create'), DEVICE_CALL_MS);
  } catch (err) {
    return err === 'unsupported' ? 'unsupported' : 'failed';
  }
  const secret = deviceSecret(made?.secret);
  if (typeof made?.handle !== 'string' || !DEVICE_HANDLE.test(made.handle) || !secret) return 'failed';
  const key = await keyFromPrf(secret, info);
  secret.fill(0);
  return { handle: made.handle, key };
}

/**
 * The wrap key of a device-key handle; `cancelled` when the person dismissed
 * the Linux unlock dialog (asked only when `interactive`), null when the
 * store will not open it.
 */
export async function deviceKeyOpen(handle: string, interactive = false, info = DEVICE_HKDF_INFO): Promise<CryptoKey | 'cancelled' | null> {
  if (!DEVICE_HANDLE.test(handle)) return null;
  let secret: Uint8Array | null;
  try {
    secret = deviceSecret(
      await withTimeout(
        invokeTauri<string>('device_key_open', { handle, interactive }),
        interactive ? DEVICE_PROMPT_MS : DEVICE_CALL_MS,
      ),
    );
  } catch (err) {
    return err === 'cancelled' ? 'cancelled' : null;
  }
  if (!secret) return null;
  const key = await keyFromPrf(secret, info);
  secret.fill(0);
  return key;
}

/**
 * The phrase under the device key, proven to open through the store before
 * it is trusted, or null where there is no device key. A shell that has one
 * and still fails leaves a breadcrumb, so a fall back to the browser key is
 * never silent.
 */
async function sealUnderDeviceKey(phrase: string): Promise<string | null> {
  if (!inNativeShell()) return null;
  try {
    const made = await deviceKeyCreate();
    if (made === 'unsupported') {
      await markDeviceKeyMissing(true);
      return null;
    }
    if (made === 'failed') {
      logAuthEvent('auth:phrase-device-wrap-fallback', { message: 'create' });
      return null;
    }
    const { ciphertext, iv } = await aesGcmEncrypt(made.key, phrase);
    // Round trip through the store, as the next boot will open it.
    const again = await deviceKeyOpen(made.handle);
    if (again === null || again === 'cancelled' || (await aesGcmDecrypt(again, ciphertext, iv)) !== phrase) {
      logAuthEvent('auth:phrase-device-wrap-fallback', { message: 'read-back' });
      return null;
    }
    await markDeviceKeyMissing(false);
    return `${DEVICE_ENVELOPE_PREFIX}${made.handle}:${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`;
  } catch (err) {
    logAuthEvent('auth:phrase-device-wrap-fallback', { message: (err as Error | null)?.message });
    return null;
  }
}

/**
 * Open a `pnwrap2:` envelope; null when it is malformed or the store will
 * not open it. A busy store gets one more try after a pause; a dismissed
 * unlock dialog is not asked again. Nothing is removed either way, so the
 * next start, or the sign-in screen when the window comes back, asks again.
 */
async function unwrapDeviceEnvelope(value: string, interactive: boolean): Promise<string | null> {
  const parts = value.slice(DEVICE_ENVELOPE_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = base64ToBytes(parts[1]!);
    ciphertext = base64ToBytes(parts[2]!);
  } catch {
    return null;
  }
  let cancelled = false;
  for (let attempt = 0; attempt < 2 && !cancelled; attempt++) {
    if (attempt > 0) await pause(DEVICE_RETRY_DELAY_MS);
    try {
      const key = await deviceKeyOpen(parts[0]!, interactive);
      if (key === 'cancelled') cancelled = true;
      else if (key) return await aesGcmDecrypt(key, ciphertext, iv);
    } catch { /* retried once, then reported */ }
  }
  logAuthEvent('auth:phrase-device-unwrap-failed', { message: cancelled ? 'cancelled' : undefined });
  return null;
}

/**
 * Once the phrase is at rest under the device key, the browser key in
 * IndexedDB only opens what an older envelope left behind: a storage engine
 * keeps an overwritten value in its files until it compacts them. So it goes,
 * unless a phrase-change handover or the other storage slot still holds an
 * envelope under it. A later fall back to the browser key makes a new one.
 * The start wipe of an untrusted device's leftover (untrustedLeftover.ts)
 * drops it the same way: no tab holds a sign-in then.
 */
export async function dropBrowserKeyIfUnused(): Promise<void> {
  if (hasPendingPhraseChange()) return;
  for (const store of [localStorage, tabSecrets, sessionStorage]) {
    try {
      if (store.getItem(PHRASE_STORAGE_KEY)?.startsWith(ENVELOPE_PREFIX)) return;
    } catch {
      return;
    }
  }
  try {
    await db.kv.delete(WRAP_KEY_KV);
  } catch { /* the next confirmed write tries again */ }
}

/**
 * The boot's move of a `pnwrap1:` envelope under the device key. Unlike a
 * sign-in's write it seals under the device key only, does nothing where
 * there is none, and writes only over the exact value the boot read and
 * never while the app lock is armed, so it cannot put back a phrase the lock
 * or anything else removed meanwhile. The one write is persistStoredPhrase's.
 * Answers whether the move landed.
 * Spec: docs/internal/plans/device-bound-phrase-key.md (section 4)
 */
export function rewrapUnderDeviceKey(phrase: string, from: string): Promise<boolean> {
  return persistStoredPhrase(phrase, { deviceOnly: true, onlyOver: from });
}

/**
 * True when this device keeps its recovery phrase as plain text: a value
 * written by a version from before the wrap, or by one whose wrap fell
 * back to the plain write, that no later wrap has replaced. The PIN tab
 * warns while it holds. With the app lock on nothing is stored in this
 * slot, so it is false.
 */
export function storedPhraseUnwrapped(): boolean {
  try {
    const stored = trustAwareStorage.getItem(PHRASE_STORAGE_KEY);
    return !!stored && !isWrappedEnvelope(stored) && isValidPhrase(stored);
  } catch {
    return false;
  }
}

function isCryptoKey(v: unknown): v is CryptoKey {
  return typeof CryptoKey !== 'undefined' && v instanceof CryptoKey;
}

/**
 * Read the device wrap key, creating it on first use. The create is
 * atomic across tabs: the CryptoKey is generated OUTSIDE the Dexie
 * transaction (an awaited non-IDB call inside one auto-commits the
 * transaction), then a rw transaction re-checks and only the first
 * writer's key survives. Two tabs racing here converge on one key, so
 * an envelope written by either tab opens in both.
 */
async function getOrCreateWrapKey(): Promise<CryptoKey> {
  const existing = await db.kv.get(WRAP_KEY_KV);
  if (isCryptoKey(existing?.value)) return existing.value;
  const fresh = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: the property this module exists for
    ['encrypt', 'decrypt'],
  );
  return db.transaction('rw', db.kv, async () => {
    const again = await db.kv.get(WRAP_KEY_KV);
    if (isCryptoKey(again?.value)) return again.value;
    await db.kv.put({ key: WRAP_KEY_KV, value: fresh });
    return fresh;
  });
}

async function readWrapKey(): Promise<CryptoKey | null> {
  const entry = await db.kv.get(WRAP_KEY_KV);
  return isCryptoKey(entry?.value) ? entry.value : null;
}

/** True when this device holds the app lock's own copy of the phrase (the
 *  PIN or passcode wrap, or a biometric enrollment), whatever the switch
 *  says. With one and no stored phrase, the start shows the lock screen. */
export function hasLockWrap(): boolean {
  return hasPinWrappedPhrase() || hasBiometricCredential();
}

/**
 * True when the app lock is the only door: the setting is on AND a PIN
 * or biometric wrap exists to open it.
 *
 * Arming the lock strips the device-key phrase envelope on purpose, so a
 * sign-in that writes the phrase back re-creates the door the lock
 * removed - permanently, and silently. The test therefore belongs to the
 * write rather than to one sign-in path: both the phrase sign-in and the
 * custodial OAuth sign-in reach persistStoredPhrase with a lock possibly
 * armed, and only the first one used to ask.
 *
 * It is deliberately NOT inside persistStoredPhrase. Two callers write
 * the phrase back precisely BECAUSE they are removing a lock factor -
 * pinRecovery.ts when clearing a PIN leaves no other door, and
 * BiometricTab.tsx when removing a fingerprint leaves no PIN wrap - and
 * both run while the settings flag is still on. A guard inside the write
 * would strand those devices with no phrase and no door, which is the
 * defect v0.507.16 closed.
 */
export function appLockArmed(): boolean {
  if (!hasLockWrap()) return false;
  // Raw read of the cached settings blob rather than loadLocalSettings,
  // following bumpNotesCreated: the userSettings import chain reads
  // browser globals at module load, and this module is imported by the
  // OAuth path, which must stay light. Only one boolean is needed, and
  // anything other than a stored true answers "not armed", which is the
  // safe side here - the write it gates is what restores a lost session.
  try {
    const raw = localStorage.getItem(settingsLocalKey());
    if (!raw) return false;
    const cache = JSON.parse(raw) as { settings?: { appLockEnabled?: unknown } };
    return cache.settings?.appLockEnabled === true;
  } catch {
    return false;
  }
}

// The stored session is sealed while the lock is armed (sessionSeal.ts), on a
// trusted tab only: the wraps and the setting are shared with an untrusted
// tab of the same browser, which keeps its session in memory.
setSessionSealArmed(() => isTrustedDevice() && appLockArmed());

// Set when a write of the live sign-in's phrase found no key to wrap it
// under and so stored nothing: the session lives in this tab's memory only.
// Holds the sign-in stamp, so a sign-out ends it without a call.
let memoryOnlySince: SignInStamp | null = null;
const memoryOnlyListeners = new Set<() => void>();

function setMemoryOnly(stamp: SignInStamp | null): void {
  if (memoryOnlySince === stamp) return;
  memoryOnlySince = stamp;
  for (const fn of memoryOnlyListeners) fn();
}

/** A memory-only spell of the sign-in that is still live. */
function memoryOnlyLive(): boolean {
  return memoryOnlySince !== null && !signedOutSince(memoryOnlySince);
}

/**
 * True when this tab holds the session's phrase in memory only: the last
 * write could not wrap it and stored nothing, nothing else is in the slot,
 * and no PIN, passcode or fingerprint wrap holds it instead. A reload or a
 * closed tab then signs out, which the banner says (`PhraseNotSavedBanner`).
 * With such a wrap on the device the next start shows the lock screen
 * instead, whatever the lock switch says (App.tsx, the boot's lock rule),
 * so there is nothing to warn about.
 * Spec: docs/internal/plans/phrase-lock-hardening.md (section 1.2 C)
 */
export function phraseHeldInMemoryOnly(): boolean {
  if (!memoryOnlyLive()) return false;
  if (hasLockWrap()) return false;
  try {
    return !trustAwareStorage.getItem(PHRASE_STORAGE_KEY);
  } catch {
    return true;
  }
}

/** Called when `phraseHeldInMemoryOnly` may have changed. Returns the unsubscribe. */
export function onPhraseMemoryOnlyChange(fn: () => void): () => void {
  memoryOnlyListeners.add(fn);
  return () => { memoryOnlyListeners.delete(fn); };
}

/**
 * The phrase under the browser key, with one more try after a reopen of the
 * database: iOS WebKit severs the IndexedDB connection of a backgrounded
 * standalone app, and only a reopen brings it back (the precedent of
 * `unwrapStoredEnvelope`, issue #112). Throws when both tries fail.
 */
async function sealUnderBrowserKeyWithRetry(phrase: string): Promise<string> {
  try {
    return await sealUnderBrowserKey(phrase);
  } catch (err) {
    // Logged once per memory-only spell: a settings pass asks again each
    // time (syncPinWrap), and the auth log keeps only its last entries.
    if (!memoryOnlyLive()) logAuthEvent('auth:phrase-wrap-retry', { message: (err as Error | null)?.message });
    try { await reopenDb(); } catch { /* the second try reports it */ }
    return sealUnderBrowserKey(phrase);
  }
}

function refuseStaleWrite(): false {
  logAuthEvent('auth:phrase-persist-refused');
  return false;
}

/**
 * Persist the session phrase into trust-aware storage as a wrapped
 * envelope. Replaces every former plaintext write site, including the
 * boot-time migration of an existing plaintext value (same slot, so
 * the overwrite IS the migration; a per-store setItem either lands or
 * leaves the old value intact - there is no torn state).
 *
 * The wrap is proven before it is trusted: the key is re-read from
 * IndexedDB after any create (a key that cannot be read back cannot
 * open the envelope on the next boot) and the ciphertext is decrypted
 * and compared before the write. A browser key that fails twice writes
 * nothing and answers false, with a breadcrumb: the session goes on
 * from memory (`phraseHeldInMemoryOnly`), and the next start asks for
 * the phrase. Never a plain write (issue #844). A value already in the
 * slot is left as it is.
 *
 * A phrase that is not the live sign-in's is refused, before the wrap
 * and again before the write, and so is a write that a sign-out overtook,
 * even when the same phrase has signed in again meanwhile (liveSignIn.ts
 * says why).
 *
 * Answers whether the phrase is at rest afterwards, read back the way
 * the next start reads it. trustAwareStorage swallows a refused write
 * (quota, storage switched off), so a caller about to remove this
 * device's last lock door, or to commit the flag that stops the lock
 * screen, acts on this answer and never on the call having returned.
 * Pinned by tests/phraseAtRest.test.ts.
 */
export async function persistStoredPhrase(
  phrase: string,
  opts: { deviceOnly?: boolean; onlyOver?: string } = {},
): Promise<boolean> {
  const stamp = signInStamp();
  if (!isLivePhrase(phrase)) return refuseStaleWrite();
  let value: string | null;
  try {
    value = (await sealUnderDeviceKey(phrase)) ?? (opts.deviceOnly ? null : await sealUnderBrowserKeyWithRetry(phrase));
  } catch (err) {
    // No key to wrap under: store nothing, never the plain phrase (#844).
    // Breadcrumbed so a device that cannot wrap is visible in the auth log,
    // once per memory-only spell (see the retry above).
    if (!memoryOnlyLive()) {
      logAuthEvent('auth:phrase-wrap-failed', {
        message: (err as Error | null)?.message,
      });
    }
    if (!opts.deviceOnly && !signedOutSince(stamp) && isLivePhrase(phrase)) setMemoryOnly(stamp);
    return false;
  }
  // `deviceOnly` (the boot's move) writes nothing without a device key.
  if (value === null) return false;
  // The wrap awaited IndexedDB and WebCrypto, and a sign-out can have
  // begun meanwhile.
  if (signedOutSince(stamp) || !isLivePhrase(phrase)) return refuseStaleWrite();
  // `onlyOver`: only over the exact value the caller read, and never behind
  // an armed lock, whose arming emptied the slot.
  if (opts.onlyOver !== undefined && (appLockArmed() || trustAwareStorage.getItem(PHRASE_STORAGE_KEY) !== opts.onlyOver)) {
    return false;
  }
  trustAwareStorage.setItem(PHRASE_STORAGE_KEY, value);
  // Asked again once written. Another tab runs alongside this one, and its
  // notice and removal can fall between the check above and the write: then
  // this write undoes itself, unless a newer one already replaced it.
  if (signedOutSince(stamp) || !isLivePhrase(phrase)) {
    if (trustAwareStorage.getItem(PHRASE_STORAGE_KEY) === value) trustAwareStorage.removeItem(PHRASE_STORAGE_KEY);
    return refuseStaleWrite();
  }
  if ((await readResumablePhrase()) === phrase) {
    if (value.startsWith(DEVICE_ENVELOPE_PREFIX)) await dropBrowserKeyIfUnused();
    setMemoryOnly(null);
    // The phrase is at rest again (the lock off, or a door removed): the
    // session follows the lock's state.
    settleStoredSession();
    return true;
  }
  logAuthEvent('auth:phrase-persist-unconfirmed');
  // A store that refused the write leaves the session in memory too; the
  // getter shows the banner only while the slot is really empty.
  if (!opts.deviceOnly && !signedOutSince(stamp) && isLivePhrase(phrase)) setMemoryOnly(stamp);
  return false;
}

/**
 * The phrase sealed under this device's wrap key, as an envelope
 * `unwrapStoredEnvelope` opens, or null when the device cannot wrap. Never
 * the plaintext: the phrase change keeps its new phrase in a handover record
 * with this, and a record must never hold a phrase in the clear.
 * Spec: docs/internal/plans/phrase-change.md (6.6)
 */
export async function sealPhraseForDevice(phrase: string): Promise<string | null> {
  try {
    return (await sealUnderDeviceKey(phrase)) ?? (await sealUnderBrowserKey(phrase));
  } catch {
    return null;
  }
}

/**
 * The phrase under the browser key in IndexedDB, proven before it is
 * trusted: the key is re-read through the committed transaction (encrypt
 * with the key as IndexedDB will serve it at the next boot, not with the
 * in-memory candidate that may have lost the create race), and the
 * ciphertext is decrypted and compared, because a wrap that cannot decrypt
 * would brick the stored session where plaintext would have worked. Throws
 * on any failure.
 */
async function sealUnderBrowserKey(phrase: string): Promise<string> {
  await getOrCreateWrapKey();
  // A device-key write of another flow can drop the key between the two
  // reads (dropBrowserKeyIfUnused); one more create covers that.
  const key = (await readWrapKey()) ?? (await getOrCreateWrapKey(), await readWrapKey());
  if (!key) throw new Error('wrap key unreadable after create');
  const { ciphertext, iv } = await aesGcmEncrypt(key, phrase);
  if ((await aesGcmDecrypt(key, ciphertext, iv)) !== phrase) throw new Error('wrap round trip mismatch');
  return `${ENVELOPE_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`;
}

/**
 * Open a stored envelope back into the phrase. Returns null when the
 * envelope is malformed or the wrap key is gone (cleared IndexedDB
 * beside a surviving localStorage) - the caller treats null as "no
 * restorable session" and demotes to sign-in, which re-entry of the
 * phrase repairs. One reopen-and-retry absorbs iOS WebKit severing
 * the IndexedDB connection in a backgrounded standalone app (the
 * reopenDb precedent, issue #112).
 */
export async function unwrapStoredEnvelope(
  value: string,
  opts: { interactive?: boolean } = {},
): Promise<string | null> {
  // Only the boot passes `interactive`: it may show the Linux keyring's
  // unlock dialog. Every other read stays silent.
  if (value.startsWith(DEVICE_ENVELOPE_PREFIX)) return unwrapDeviceEnvelope(value, opts.interactive === true);
  if (!value.startsWith(ENVELOPE_PREFIX)) return null;
  const parts = value.slice(ENVELOPE_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = base64ToBytes(parts[0]!);
    ciphertext = base64ToBytes(parts[1]!);
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const key = await readWrapKey();
      if (!key) {
        logAuthEvent('auth:phrase-wrap-key-missing');
        return null;
      }
      return await aesGcmDecrypt(key, ciphertext, iv);
    } catch (err) {
      if (attempt === 0) {
        // A severed IndexedDB connection and a genuine decrypt failure
        // both throw; the reopen only helps the first, and one retry
        // costs nothing on the second.
        try { await reopenDb(); } catch { /* ignore */ }
        continue;
      }
      logAuthEvent('auth:phrase-unwrap-failed', {
        message: (err as Error | null)?.message,
      });
    }
  }
  return null;
}

/**
 * The phrase this install is holding, when it is holding a usable one.
 *
 * An install can sit on the sign-in screen with a phrase still on disk: a
 * boot that cannot finish its handshake demotes there on purpose, because an
 * unreachable server or a storage hiccup is not a verdict, and re-entering the
 * phrase repairs everything. A deliberate sign-out is NOT one of those cases:
 * it removes the phrase before that screen appears, and persistStoredPhrase
 * refuses every later write from the session it ended.
 *
 * In that state the app asks for something it is already holding. This reader
 * is what lets the sign-in screen offer to carry on instead. It answers null
 * for anything it cannot use: nothing stored, an envelope that will not open,
 * or a value that is not a phrase. The app lock needs no special case here,
 * because arming it removes this copy and the lock screen owns the unlock.
 * Spec: docs/internal/plans/oauth-redirect-binding-handoff.md (section 8.8)
 */
export async function readResumablePhrase(): Promise<string | null> {
  let stored: string | null = null;
  try {
    stored = trustAwareStorage.getItem(PHRASE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!stored) return null;
  if (isWrappedEnvelope(stored)) {
    const opened = await unwrapStoredEnvelope(stored).catch(() => null);
    return opened && isValidPhrase(opened) ? opened : null;
  }
  return isValidPhrase(stored) ? stored : null;
}
