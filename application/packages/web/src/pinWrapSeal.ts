/**
 * The PIN wrap at rest in the apps, sealed under the device key.
 *
 * The lock's own copy of the PIN wrap (`privacynotes.pin.wrapped`) is the
 * phrase under a key from a 4-digit PIN, so a copy of the app's data folder
 * gave the phrase up to an offline search in minutes. In the native shell,
 * where the OS keeps a device key (phraseAtRest.ts), the stored ciphertext is
 * sealed again under it: `pndev1:<handle>:<iv>:<sealed>:<id>`, so this copy
 * gives nothing to search without the device's own key store. (The account's
 * copy in the settings cache is sealed in C2 part 2.) The salt, the
 * IV and the count stay plain (the lock screen reads the salt for the kind),
 * and they are inside the seal too, so a seal never opens beside another
 * wrap's salt. `<id>` is a short check value of the plain ciphertext, which
 * names the wrap for the synchronous identity tests (`hasSamePinWrap`,
 * `pinWrapStamp`); without the PIN-derived key it opens nothing.
 *
 * The web, a shell without a device key and the demo keep the plain value.
 * Spec: docs/internal/plans/pin-wrap-hardening.md (section 5.4, C2-1)
 */

import { base64ToBytes, bytesToBase64 } from '@notes/shared';
import { aesGcmDecrypt, aesGcmEncrypt } from './biometric';
import { isDemoMode } from './demo';
import { deviceKeyCreate, deviceKeyOpen, inNativeShell } from './phraseAtRest';

const PREFIX = 'pndev1:';
// Its own derivation label: the phrase envelope's key never opens a PIN seal.
const INFO = 'privacynotes-pin-wrap-v1';

/** Whether a stored PIN wrap value is sealed under the device key. */
export function isSealedPinWrap(value: string | null): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * A short check value of a plain ciphertext (FNV-1a over its text, with its
 * length). It names a wrap among the few this device ever holds; it is not a
 * secret and gives nothing to a search, which needs the plain ciphertext.
 */
export function plainWrapId(ciphertext: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < ciphertext.length; i++) {
    h ^= ciphertext.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}.${ciphertext.length}`;
}

/** The identity of a stored value, sealed or plain, by its plain ciphertext. */
export function storedWrapId(value: string): string {
  if (!isSealedPinWrap(value)) return plainWrapId(value);
  return value.slice(PREFIX.length).split(':')[3] ?? '';
}

/** Whether this device seals its PIN wrap: the native shell, never the demo. */
export function sealsPinWrapHere(): boolean {
  return inNativeShell() && !isDemoMode();
}

type Bound = { s: string; i: string; c: string };

/**
 * The plain ciphertext sealed under a fresh device-key handle, opened once
 * through the store before it is trusted, or null where there is no device
 * key or the seal did not read back.
 */
export async function sealPinCiphertext(salt: string, iv: string, ciphertext: string): Promise<string | null> {
  if (!sealsPinWrapHere()) return null;
  try {
    const made = await deviceKeyCreate(INFO);
    if (made === 'unsupported' || made === 'failed') return null;
    const body: Bound = { s: salt, i: iv, c: ciphertext };
    const sealed = await aesGcmEncrypt(made.key, JSON.stringify(body));
    const value = `${PREFIX}${made.handle}:${bytesToBase64(sealed.iv)}:${bytesToBase64(sealed.ciphertext)}:${plainWrapId(ciphertext)}`;
    // Round trip through the store, as the lock screen will open it.
    return (await openSealedPinWrap(value, salt, iv)) === ciphertext ? value : null;
  } catch {
    return null;
  }
}

/**
 * The plain ciphertext of a sealed value: `cancelled` when the person
 * dismissed the Linux keyring dialog (asked only when `interactive`), null
 * when the store does not open it or the seal belongs to another salt and IV.
 * A busy store gets one more try.
 */
export async function openSealedPinWrap(
  value: string,
  salt: string,
  iv: string,
  interactive = false,
): Promise<string | 'cancelled' | null> {
  if (!isSealedPinWrap(value)) return null;
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 4) return null;
  let sealedIv: Uint8Array;
  let sealed: Uint8Array;
  try {
    sealedIv = base64ToBytes(parts[1]!);
    sealed = base64ToBytes(parts[2]!);
  } catch {
    return null;
  }
  // A dialog the person answered is not asked again; a store with no dialog
  // gets one more try when it is busy.
  for (let attempt = 0; attempt < (interactive ? 1 : 2); attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600));
    try {
      const key = await deviceKeyOpen(parts[0]!, interactive, INFO);
      if (key === 'cancelled') return 'cancelled';
      if (!key) continue;
      const body = JSON.parse(await aesGcmDecrypt(key, sealed, sealedIv)) as Partial<Bound>;
      if (body.s !== salt || body.i !== iv || typeof body.c !== 'string') return null;
      return plainWrapId(body.c) === parts[3] ? body.c : null;
    } catch {
      /* tried again once, then reported as not opening */
    }
  }
  return null;
}
