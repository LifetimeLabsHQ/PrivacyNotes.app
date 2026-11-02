/**
 * Open and write the entries of the synced field `extensionKeys` (see
 * extensionKeys.ts): P per key tag and each extension's browser half, wrapped
 * under an HKDF branch of the content key. Loaded only by the extension's
 * pairing and sync code, never at boot.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.1)
 */
import { base64ToBytes, bytesToBase64, decryptBytesAad, encryptBytesAad } from '@notes/shared';
import { deriveLoginsWrapKey } from '@notes/shared/extension';
import { stampAfter } from './registers';
import type { ExtensionKeys } from './extensionKeys';

const aad = (key: string) => `privacynotes-ext-logins-key-v1:${key}`;

function wrap(contentKey: Uint8Array, key: string, plain: Uint8Array): string {
  const { ciphertext, nonce } = encryptBytesAad(plain, deriveLoginsWrapKey(contentKey), aad(key));
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce);
  out.set(ciphertext, nonce.length);
  return bytesToBase64(out);
}

function unwrap(contentKey: Uint8Array, key: string, value: string | null | undefined): Uint8Array | null {
  if (!value) return null;
  try {
    const raw = base64ToBytes(value);
    return decryptBytesAad(raw.subarray(24), raw.subarray(0, 24), deriveLoginsWrapKey(contentKey), aad(key));
  } catch {
    return null;
  }
}

/** P for `tag`, or null when this app has not seen it yet. */
export function loginsKeyFor(keys: ExtensionKeys, contentKey: Uint8Array, tag: string): Uint8Array | null {
  const p = unwrap(contentKey, `p:${tag}`, keys[`p:${tag}`]?.v);
  return p && p.length === 32 ? p : null;
}

export interface BrowserHalf {
  kext: Uint8Array;
  /** When the entry was written, ms. */
  at: number;
}

/** The browser half of every extension this account ever paired with logins
 *  and has not cleared, by token id. Kext never changes for an extension; a
 *  new P only gives it a new server half, so an entry outlives a key change. */
export function browserHalves(keys: ExtensionKeys, contentKey: Uint8Array): Map<string, BrowserHalf> {
  const out = new Map<string, BrowserHalf>();
  for (const [key, reg] of Object.entries(keys)) {
    if (!key.startsWith('k:')) continue;
    const kext = unwrap(contentKey, key, reg.v);
    if (kext?.length === 32) out.set(key.slice(2), { kext, at: Date.parse(reg.at) });
  }
  return out;
}

/** The map with P stored for `tag`. */
export function withLoginsKey(keys: ExtensionKeys, contentKey: Uint8Array, tag: string, p: Uint8Array): ExtensionKeys {
  const key = `p:${tag}`;
  return { ...keys, [key]: { v: wrap(contentKey, key, p), at: stampAfter(keys[key]?.at) } };
}

/** The map with the browser half of one extension. */
export function withBrowserHalf(keys: ExtensionKeys, contentKey: Uint8Array, tokenId: string, kext: Uint8Array): ExtensionKeys {
  const key = `k:${tokenId}`;
  return { ...keys, [key]: { v: wrap(contentKey, key, kext), at: stampAfter(keys[key]?.at) } };
}
