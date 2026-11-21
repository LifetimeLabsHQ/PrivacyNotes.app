/**
 * Open and write the entries of the synced field `extensionKeys` (see
 * extensionKeys.ts): P per key tag and each extension's browser half, wrapped
 * under an HKDF branch of the content key. Loaded only by the extension's
 * pairing and sync code, never at boot.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.1)
 */
import { base64ToBytes, bytesToBase64, bytesToHex, decryptBytesAad, encryptBytesAad, hexToBytes } from '@notes/shared';
import { deriveLoginsWrapKey } from '@notes/shared/extension';
import { stampAfter } from './registers';
import { withoutEntries, type ExtensionKeys } from './extensionKeys';

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

// ── The senders of signed inbox rows ────────────────────────────────
// Spec: docs/internal/plans/inbox-signed-hybrid.md (section 5.2)

export interface InboxSenderEntry {
  client: 'browser' | 'cli';
  tokenId: string;
  publicKey: Uint8Array;
  /** When the entry was written, ms. */
  at: number;
}

/** What the settings say of one key id: a live sender, a removed one
 *  (a tombstone), or nothing (not seen yet). */
export type SenderLookup = { live: InboxSenderEntry } | 'removed' | 'unknown';

const uuidToBytes = (id: string): Uint8Array => hexToBytes(id.replace(/-/g, ''));
function bytesToUuid(b: Uint8Array): string {
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The map with the sender key of one connection: client, token id, public key. */
export function withSender(keys: ExtensionKeys, contentKey: Uint8Array, keyId: string, entry: Omit<InboxSenderEntry, 'at'>): ExtensionKeys {
  const key = `s:${keyId}`;
  const plain = new Uint8Array(49);
  plain[0] = entry.client === 'cli' ? 1 : 0;
  plain.set(uuidToBytes(entry.tokenId), 1);
  plain.set(entry.publicKey, 17);
  return { ...keys, [key]: { v: wrap(contentKey, key, plain), at: stampAfter(keys[key]?.at) } };
}

/** Every live sender, by key id. An entry that does not open is left out. */
export function inboxSenders(keys: ExtensionKeys, contentKey: Uint8Array): Map<string, InboxSenderEntry> {
  const out = new Map<string, InboxSenderEntry>();
  for (const [key, reg] of Object.entries(keys)) {
    if (!key.startsWith('s:')) continue;
    const plain = unwrap(contentKey, key, reg.v);
    if (plain?.length !== 49 || (plain[0] !== 0 && plain[0] !== 1)) continue;
    out.set(key.slice(2), { client: plain[0] === 1 ? 'cli' : 'browser', tokenId: bytesToUuid(plain.subarray(1, 17)), publicKey: plain.slice(17), at: Date.parse(reg.at) });
  }
  return out;
}

/** What the settings say of the sender `keyId`. */
export function lookupSender(keys: ExtensionKeys, senders: Map<string, InboxSenderEntry>, keyId: string): SenderLookup {
  const live = senders.get(keyId);
  if (live) return { live };
  return keys[`s:${keyId}`]?.v === null ? 'removed' : 'unknown';
}

/** Whether any sender entry was ever written, live or removed. */
export function hasSenderEntries(keys: ExtensionKeys): boolean {
  return Object.keys(keys).some((k) => k.startsWith('s:'));
}

/** Whether the account takes no unsigned inbox row (`c:inbox`). Sealed, so a
 *  server cannot set or clear it; a value that does not open counts as set. */
export function inboxClosed(keys: ExtensionKeys): boolean {
  const reg = keys['c:inbox'];
  return !!reg && reg.v !== null;
}

/** The map with the account closed to unsigned inbox rows. */
export function withInboxClosed(keys: ExtensionKeys, contentKey: Uint8Array): ExtensionKeys {
  if (inboxClosed(keys)) return keys;
  return { ...keys, 'c:inbox': { v: wrap(contentKey, 'c:inbox', Uint8Array.of(1)), at: stampAfter(keys['c:inbox']?.at) } };
}

/** The map with the sender of one connection removed: Remove in Settings is
 *  the one place that marks a sender gone, after the inbox was taken in
 *  first (or the person chose Remove anyway). Absence from the server's list
 *  never does: a clock that is off, or a list read before a redeem, would
 *  cut a live connection off (spec review H1, H2). */
export function withoutSenderOf(keys: ExtensionKeys, contentKey: Uint8Array, tokenId: string): ExtensionKeys {
  const ids = [...inboxSenders(keys, contentKey)].filter(([, s]) => s.tokenId === tokenId).map(([id]) => `s:${id}`);
  return ids.length ? withoutEntries(keys, ids) : keys;
}
