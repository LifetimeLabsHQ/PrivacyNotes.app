/**
 * The browser extension's crypto: the sealed inbox, the pairing code, the
 * unlock checker and the logins key.
 *
 * The extension never holds the content key. It seals each clip to the
 * account's inbox public key, which every app derives from the seed and no
 * server ever sees; only an app can open a clip. Logins reach the extension in
 * a second copy under a key P that opens nothing else; P is split between the
 * browser (Kext) and the server (Ksrv), and the server releases its half only
 * after it checked the extension's PIN or passcode.
 *
 * Every construction here is pinned by tools/crypto-kat.mjs.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3)
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { base64ToBytes, bytesToBase64, bytesToBase64url, bytesToHex } from './crypto.js';
import { parseSitePasskey, type SitePasskey } from './sitePasskey.js';

export type { SitePasskey } from './sitePasskey.js';
// The site passkeys' authenticator runs only in the extension, so it is on
// this entry, never on the app's barrel.
// Spec: docs/contrib/passkeys.md (section 5.4, Authenticator)
export * from './passkeyAuthenticator.js';

const utf8 = new TextEncoder();

// ------------------------------------------------------------------
// The inbox
// ------------------------------------------------------------------

export interface InboxKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/** The account's inbox pair, the same on every app of the account. */
export function deriveInboxKeyPair(seed: Uint8Array): InboxKeyPair {
  const secretKey = hkdf(sha256, seed, undefined, utf8.encode('privacynotes-clip-inbox-v1'), 32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** The row kinds the inbox carries. A reader leaves any other kind alone.
 *  `loginedit` is every change the extension makes to a login, passkeys
 *  included; `login` stays the v1 add and never carries a passkey.
 *  Spec: docs/contrib/passkeys.md (P28, section 6) */
export type InboxKind = 'clip' | 'picture' | 'login' | 'note' | 'loginedit' | 'keyhalf';

export const INBOX_VERSION = 1;
/**
 * A `loginedit` row is sealed as version 2. An app of 0.782.0 or older reads
 * only version 1 and leaves any other row for a newer app, so it never applies
 * a login edit, and a login edit needs no release floor. `clip-inbox` refuses a
 * `loginedit` row of version 1, so a stolen token cannot post one an old app
 * would apply. A newer app still opens a version 1 `loginedit` row (from a
 * development build) and checks its proof as for version 2.
 * Spec: docs/contrib/passkeys.md (section 16, finding 1)
 */
export const LOGINEDIT_INBOX_VERSION = 2;

/** The version a row of `kind` is sealed as. */
function sealVersion(kind: InboxKind): number {
  return kind === 'loginedit' ? LOGINEDIT_INBOX_VERSION : INBOX_VERSION;
}

/**
 * The signed row (inboxSigned.ts): the hybrid X25519 and ML-KEM-768 seal with
 * the sender's signature inside, for every kind. Byte 3, because byte 2 is the
 * legacy `loginedit` row. An app before the reader leaves it for a newer app.
 * Spec: docs/internal/plans/inbox-signed-hybrid.md (section 4.3)
 */
export const SIGNED_INBOX_VERSION = 3;

/** True when this app opens a row of `kind` sealed as `version`; any other row
 *  waits for a newer app. A signed row opens only through inboxSigned.ts. */
export function inboxVersionKnown(kind: string, version: number | null): boolean {
  return version === INBOX_VERSION || version === SIGNED_INBOX_VERSION || (kind === 'loginedit' && version === LOGINEDIT_INBOX_VERSION);
}

/** What a sealed row is bound to: a ciphertext moved to another account, id
 *  or kind fails to open. */
export interface InboxContext {
  /**
   * The account id, hex: the public key of the account's FIRST phrase. Never
   * the signing key of the phrase in use, which a phrase change replaces;
   * bound to it, every inbox row would fail to open after the change.
   * Spec: docs/internal/plans/phrase-change.md (4.6)
   */
  account: string;
  /** The row id, a uuid the sealer chose. */
  id: string;
  kind: InboxKind;
}

// Spec: docs/internal/plans/browser-extension-build.md (section 3.3, 4 KiB padding)
const INBOX_PAD = 4096;

function inboxAad(version: number, ctx: InboxContext, epk: Uint8Array): Uint8Array {
  const head = utf8.encode(`privacynotes-inbox:v${version}:${ctx.account}:${ctx.kind}:${ctx.id}:`);
  const out = new Uint8Array(head.length + epk.length);
  out.set(head);
  out.set(epk, head.length);
  return out;
}

function sealKey(shared: Uint8Array, epk: Uint8Array, inboxPublic: Uint8Array): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(epk);
  salt.set(inboxPublic, 32);
  return hkdf(sha256, shared, salt, utf8.encode('privacynotes-clip-seal-v1'), 32);
}

/** JSON in, padded with spaces to the next 4 KiB, so a row's length says
 *  little about its content. JSON.parse ignores the padding. */
export function padInboxJson(value: unknown): Uint8Array {
  const body = utf8.encode(JSON.stringify(value));
  const size = Math.ceil((body.length + 1) / INBOX_PAD) * INBOX_PAD;
  const out = new Uint8Array(size).fill(0x20);
  out.set(body);
  return out;
}

/**
 * Seal bytes to the inbox public key: a fresh X25519 pair per row, HKDF over
 * the shared secret, XChaCha20-Poly1305. The row is base64 of
 * version(1) || epk(32) || nonce(24) || ciphertext; the version is 1, or 2
 * for a `loginedit` row.
 */
export function sealInbox(plaintext: Uint8Array, inboxPublic: Uint8Array, ctx: InboxContext): string {
  const esk = randomBytes(32);
  const epk = x25519.getPublicKey(esk);
  const key = sealKey(x25519.getSharedSecret(esk, inboxPublic), epk, inboxPublic);
  const nonce = randomBytes(24);
  const version = sealVersion(ctx.kind);
  const ct = xchacha20poly1305(key, nonce, inboxAad(version, ctx, epk)).encrypt(plaintext);
  const out = new Uint8Array(1 + 32 + 24 + ct.length);
  out[0] = version;
  out.set(epk, 1);
  out.set(nonce, 33);
  out.set(ct, 57);
  return bytesToBase64(out);
}

/** Inverse of sealInbox. Throws on another version, a wrong key, a tamper or
 *  a row that is not bound to `ctx`. */
export function openInbox(payload: string, inboxSecret: Uint8Array, ctx: InboxContext): Uint8Array {
  const raw = base64ToBytes(payload);
  if (raw.length < 1 + 32 + 24 + 16) throw new Error('inbox row too short');
  const version = raw[0] as number;
  if (version === SIGNED_INBOX_VERSION || !inboxVersionKnown(ctx.kind, version)) throw new Error('inbox row version unknown');
  const epk = raw.subarray(1, 33);
  const nonce = raw.subarray(33, 57);
  const inboxPublic = x25519.getPublicKey(inboxSecret);
  const key = sealKey(x25519.getSharedSecret(inboxSecret, epk), epk, inboxPublic);
  return xchacha20poly1305(key, nonce, inboxAad(version, ctx, epk)).decrypt(raw.subarray(57));
}

/** The version byte of a sealed row, or null when it is not one, so a reader
 *  can leave a newer row for a newer app instead of discarding it. */
export function inboxRowVersion(payload: string): number | null {
  try {
    const raw = base64ToBytes(payload.slice(0, 4));
    return raw.length ? (raw[0] as number) : null;
  } catch {
    return null;
  }
}

/** A uuid (version 8, RFC 9562) from 16 bytes of a MAC. */
function uuidFromMac(mac: Uint8Array): string {
  const b = Uint8Array.from(mac.subarray(0, 16));
  b[6] = ((b[6] as number) & 0x0f) | 0x80;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The id of the item an inbox row becomes. Two apps adopting one row create
 * the same item, and only the account's apps can compute it from the row id.
 * The server can still tell such an item apart: the id is a version-8 uuid,
 * where a note made in the app has a version-4 one, and the app asks which of
 * these ids are tombstones right after it lists the inbox. So the server sees
 * which notes came through the inbox and, beside the row's plain `kind`, of
 * what kind; it reads none of them. The version 8 stays: ids already on the
 * server are bound to it, and two apps must keep deriving one id per row
 * (beta #205 item 5).
 */
export function inboxItemId(inboxSecret: Uint8Array, rowId: string): string {
  const idKey = hkdf(sha256, inboxSecret, undefined, utf8.encode('privacynotes-clip-item-id-v1'), 32);
  return uuidFromMac(hmac(sha256, idKey, utf8.encode(rowId)));
}

// ------------------------------------------------------------------
// The pairing code
// ------------------------------------------------------------------

export interface PairingCode {
  /** One-time secret the server burns on redemption. */
  secret: Uint8Array;
  inboxPublic: Uint8Array;
  /** The browser's half of the logins key; null when logins are off. */
  kext: Uint8Array | null;
  /**
   * A version 2 code: the connection's own sender seed, and the hash of the
   * account's ML-KEM public key, which the redeem answer must match. Absent
   * for a version 1 code. Spec: docs/internal/plans/inbox-signed-hybrid.md (section 4.4)
   */
  signed?: { kemHash: Uint8Array; seed: Uint8Array };
}

export const PAIRING_SECRET_BYTES = 16;
const PAIRING_VERSION = 1;
const PAIRING_PREFIX = 'pnx1-';
const SIGNED_PAIRING_VERSION = 2;
const SIGNED_PAIRING_PREFIX = 'pnx2-';
// Crockford base32: no I, L, O or U, so a code survives being read aloud.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** Strict: only the one spelling base32() writes decodes, so a character
 *  added to a code or a changed spare bit is refused, not ignored. */
function unbase32(text: string, bytes: number): Uint8Array | null {
  if (text.length !== Math.ceil((bytes * 8) / 5)) return null;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B32.indexOf(ch === 'O' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch);
    if (v < 0) return null;
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

function pairingCheck(body: Uint8Array): Uint8Array {
  const tagged = new Uint8Array(body.length + 1);
  tagged[0] = 0x70;
  tagged.set(body, 1);
  return sha256(tagged).subarray(0, 4);
}

/** The code the app shows once: the prefix, then groups of four. A code with
 *  `signed` is version 2: `pnx2-`, the hash and the seed after the inbox key. */
export function encodePairingCode(code: PairingCode): string {
  if (code.signed && (code.signed.kemHash.length !== 32 || code.signed.seed.length !== 32)) throw new Error('a version 2 code carries 32-byte values');
  const version = code.signed ? SIGNED_PAIRING_VERSION : PAIRING_VERSION;
  const parts = [
    Uint8Array.of(version), code.secret, code.inboxPublic,
    ...(code.signed ? [code.signed.kemHash, code.signed.seed] : []),
    ...(code.kext ? [code.kext] : []),
  ];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  const full = new Uint8Array(body.length + 4);
  full.set(body);
  full.set(pairingCheck(body), body.length);
  return (code.signed ? SIGNED_PAIRING_PREFIX : PAIRING_PREFIX) + (base32(full).match(/.{1,4}/g) ?? []).join(' ');
}

/** The code as pasted, or null when it is not a whole, unaltered code. Case,
 *  spaces, hyphens and the look-alike letters are forgiven. Reads version 1
 *  and version 2; the version byte must match the code's length. */
export function decodePairingCode(text: string): PairingCode | null {
  let s = text.trim().toUpperCase();
  for (const prefix of [PAIRING_PREFIX, SIGNED_PAIRING_PREFIX]) {
    if (s.startsWith(prefix.toUpperCase())) s = s.slice(prefix.length);
  }
  const compact = s.replace(/[\s-]+/g, '');
  const head = 1 + PAIRING_SECRET_BYTES + 32;
  const shapes = [
    { version: PAIRING_VERSION, signed: false, kext: true },
    { version: PAIRING_VERSION, signed: false, kext: false },
    { version: SIGNED_PAIRING_VERSION, signed: true, kext: true },
    { version: SIGNED_PAIRING_VERSION, signed: true, kext: false },
  ];
  for (const shape of shapes) {
    const size = head + (shape.signed ? 64 : 0) + (shape.kext ? 32 : 0) + 4;
    const full = unbase32(compact, size);
    if (!full) continue;
    const body = full.subarray(0, full.length - 4);
    const check = pairingCheck(body);
    const given = full.subarray(full.length - 4);
    if (check.some((b, i) => b !== given[i])) return null;
    if (body[0] !== shape.version) return null;
    const secret = body.slice(1, 1 + PAIRING_SECRET_BYTES);
    const inboxPublic = body.slice(1 + PAIRING_SECRET_BYTES, head);
    const rest = head + (shape.signed ? 64 : 0);
    const kext = shape.kext ? body.slice(rest, rest + 32) : null;
    if (!shape.signed) return { secret, inboxPublic, kext };
    return { secret, inboxPublic, kext, signed: { kemHash: body.slice(head, head + 32), seed: body.slice(head + 32, head + 64) } };
  }
  return null;
}

/** sha256 as lower-case hex: how the server stores a pairing secret, an
 *  extension token and a pull ticket, none of which it keeps in the clear. */
export function hashHex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

// ------------------------------------------------------------------
// The unlock checker
// ------------------------------------------------------------------

// Spec: docs/internal/plans/browser-extension-build.md (section 3.2, the checker KDF; OWASP Argon2id minimum)
export const UNLOCK_KDF = { t: 2, m: 19456, p: 1 } as const;
export const UNLOCK_SALT_BYTES = 16;

/**
 * The proof of the extension's PIN or passcode: Argon2id over the NFC secret
 * and the extension's own salt. The extension sends it at each unlock; the
 * server keeps only `unlockChecker(proof)` and compares.
 */
export function deriveUnlockProof(secret: string, salt: Uint8Array): Uint8Array {
  return argon2id(utf8.encode(secret.normalize('NFC')), salt, { ...UNLOCK_KDF, dkLen: 32 });
}

/** What the server stores and compares against: a tagged hash of the proof. */
export function unlockChecker(proof: Uint8Array): string {
  const tagged = new Uint8Array(proof.length + 1);
  tagged[0] = 0x63;
  tagged.set(proof, 1);
  return bytesToHex(sha256(tagged));
}

// ------------------------------------------------------------------
// The logins key P
// ------------------------------------------------------------------

/** Wraps P in the synced settings: an HKDF branch of the content key, so P is
 *  never a plain field of the settings or of their local cache. */
export function deriveLoginsWrapKey(contentKey: Uint8Array): Uint8Array {
  return hkdf(sha256, contentKey, undefined, utf8.encode('privacynotes-ext-logins-wrap-v1'), 32);
}

/** Keys the ids of the logins copy, so the server cannot match a copy row to
 *  the vault row it mirrors. */
export function deriveLoginsIdKey(contentKey: Uint8Array): Uint8Array {
  return hkdf(sha256, contentKey, undefined, utf8.encode('privacynotes-ext-logins-id-v1'), 32);
}

/** The copy row id of one vault item. */
export function loginsRowId(idKey: Uint8Array, itemId: string): string {
  return uuidFromMac(hmac(sha256, idKey, utf8.encode(itemId)));
}

/**
 * The proof that an unlocked extension made a `loginedit` row for an existing
 * login: an HMAC under an HKDF branch of the logins key P over the account,
 * the row id and the item. The stored token alone cannot make it, so a row
 * without a valid proof never changes a login that exists; the app makes a
 * new login from it instead. The seal hides the proof from the server.
 * Spec: docs/contrib/passkeys.md (section 16, finding 1)
 */
export function loginEditProof(p: Uint8Array, account: string, rowId: string, item: string): string {
  const key = hkdf(sha256, p, undefined, utf8.encode('privacynotes-ext-loginedit-proof-v1'), 32);
  return bytesToBase64url(hmac(sha256, key, utf8.encode(`${account}:${rowId}:${item}`)));
}

/** Whether `mac` is the proof of this row under P, in constant time. */
export function loginEditProofOk(mac: string, p: Uint8Array, account: string, rowId: string, item: string): boolean {
  const want = loginEditProof(p, account, rowId, item);
  if (mac.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= mac.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function xor32(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== 32 || b.length !== 32) throw new Error('logins key halves are 32 bytes');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (a[i] as number) ^ (b[i] as number);
  return out;
}

/** A fresh split of P for one extension: Kext goes into the pairing code,
 *  Ksrv to the server. Either half alone is uniformly random. */
export function splitLoginsKey(p: Uint8Array): { kext: Uint8Array; ksrv: Uint8Array } {
  const kext = randomBytes(32);
  return { kext, ksrv: xor32(p, kext) };
}

/** Ksrv for a known Kext: a code's half, or a fresh half a browser sent
 *  (kind `keyhalf`). Never the half a browser held before a key change: the
 *  server's old and new halves would then give P xor P' (beta #205 item 1). */
export function serverHalf(p: Uint8Array, kext: Uint8Array): Uint8Array {
  return xor32(p, kext);
}

/**
 * The name of one browser half, for the server's `half_id`: an app that
 * writes a server half for a fresh browser half names it, so the browser
 * knows which of the halves it holds the server half belongs to. A hash of
 * 32 random bytes, so it tells the server nothing about the half.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4 step 7)
 */
export function browserHalfId(kext: Uint8Array): string {
  if (kext.length !== 32) throw new Error('logins key halves are 32 bytes');
  const tagged = new Uint8Array(kext.length + HALF_ID_LABEL.length);
  tagged.set(HALF_ID_LABEL);
  tagged.set(kext, HALF_ID_LABEL.length);
  return bytesToHex(sha256(tagged).subarray(0, 16));
}
const HALF_ID_LABEL = utf8.encode('privacynotes-ext-half-id-v1:');

/**
 * A fresh browser half, from a browser that stays after another was removed
 * (kind `keyhalf`, version 1, the logins permission). The apps write its
 * server half for the account's current P, so a removed browser's old key and
 * the server's halves never give the new P. Sealed to the inbox key, so the
 * server never sees the half. The token that posted it names the browser.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4 step 7)
 */
export interface InboxKeyHalf {
  v: 1;
  id: string;
  /** Base64 of the 32 bytes. */
  kext: string;
}

/** The shape check of a `keyhalf` payload: the half, or null. */
export function parseInboxKeyHalf(value: unknown, rowId: string): Uint8Array | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.v !== 1 || v.id !== rowId || typeof v.kext !== 'string') return null;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(v.kext)) return null;
  const kext = base64ToBytes(v.kext);
  return kext.length === 32 ? kext : null;
}

/** P from the two halves. */
export function joinLoginsKey(kext: Uint8Array, ksrv: Uint8Array): Uint8Array {
  return xor32(kext, ksrv);
}

// ------------------------------------------------------------------
// The inbox payloads, as the extension writes them and the apps read them.
// The apps treat every field as hostile until their own shape check passed.
// ------------------------------------------------------------------

/** A clip row: a note (or a selection) from the clip engine, or a bookmark. */
export interface InboxClip {
  v: 1;
  /** The row id, also bound by the seal; a reader refuses a mismatch. */
  id: string;
  mode: 'note' | 'selection' | 'bookmark';
  url: string;
  title: string;
  /** The clip engine's output for a note or a selection; absent for a bookmark. */
  clip?: {
    title: string;
    byline: string;
    siteName: string;
    published: string;
    description: string;
    markdown: string;
    images: { src: string; alt: string }[];
  };
  /** One entry per picture of `clip.images`: the id of the picture row that
   *  carries it, or null when it was not downloaded. */
  pictures?: (string | null)[];
  clippedAt: string;
}

/** A login made in the extension; the app adopts it into the vault. */
export interface InboxLogin {
  v: 1;
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  /** The authenticator key, as the Vault's 2FA field takes it. Optional: an
   *  older extension sends none. */
  totp?: string;
  notes?: string;
}

/** The fields an edit from the extension may set: what the copy shows, never
 *  the notes or custom fields it does not carry.
 *  Spec: docs/contrib/passkeys.md (P31) */
export const LOGIN_EDIT_FIELDS = ['name', 'url', 'username', 'password', 'totp'] as const;
export type LoginEditField = (typeof LOGIN_EDIT_FIELDS)[number];

/** The limits of a `loginedit` row, the ones the app holds a `login` row to
 *  (its `parseLogin`: 1000 characters a text field, 4096 a URL), and at most
 *  this many passkeys in one edit.
 *  Spec: docs/contrib/passkeys.md (section 6, sized like InboxLogin) */
export const INBOX_LOGINEDIT_LIMITS = { text: 1000, url: 4096, passkeys: 10 } as const;

/**
 * A change the extension makes to a login, or a new login with a passkey:
 * kind `loginedit`. With `item`, the app changes that login (each set field,
 * passkeys added by credential id); without it, or when the item is gone, the
 * app makes a new login from `base`, `set` and `addPasskeys`.
 * Spec: docs/contrib/passkeys.md (P28, section 6)
 */
export interface InboxLoginEdit {
  v: 1;
  /** The row id, also bound by the seal; a reader refuses a mismatch. */
  id: string;
  /** The vault item's id; absent for a new login. */
  item?: string;
  set: Partial<Record<LoginEditField, string>>;
  addPasskeys: SitePasskey[];
  /** The copy entry as the extension saw it (`urls[0]` as `url`): only to
   *  build a new login when the item is gone. Required with `item`. */
  base?: { name: string; username: string; url: string };
  /** With `item`: `loginEditProof` under the logins key of `tag`. Without a
   *  valid one the app makes a new login, never a change to `item`.
   *  Spec: docs/contrib/passkeys.md (section 16, finding 1) */
  proof?: { tag: string; mac: string };
  /** When the extension queued the row (ms, its own clock), sealed with it so
   *  a copy of the queue cannot change it. The app refuses a row whose
   *  `queuedAt` is more than 90 days before its server `created_at`: a row
   *  posted again after the server forgot its settled id (0132).
   *  Spec: docs/contrib/passkeys.md (section 6, beta #140 item 1) */
  queuedAt?: number;
}

const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const editText = (v: unknown): v is string => typeof v === 'string' && v.length <= INBOX_LOGINEDIT_LIMITS.text;

/** An empty string, or an http(s) URL as `URL` writes it; null otherwise. */
function editUrl(v: unknown): string | null {
  if (v === '') return '';
  if (typeof v !== 'string' || v.length > INBOX_LOGINEDIT_LIMITS.url) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The shape check of a `loginedit` row, shared by the extension (before it
 * sends) and the app (after it opens). Strict: a `set` key outside
 * LOGIN_EDIT_FIELDS, a passkey that does not parse, a repeated credential id
 * or an edit that changes nothing refuses the whole row, so a row is never
 * applied in part. Returns a fresh object with the known fields only.
 * An app that refuses a row deletes it, so a payload an older app cannot
 * parse (a new `set` field, a passkey entry of another `v`) needs a new inbox
 * kind, which an older app leaves waiting; a new top-level field is ignored.
 * Spec: docs/contrib/passkeys.md (section 16, finding 18)
 */
export function parseInboxLoginEdit(value: unknown, rowId: string): InboxLoginEdit | null {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.v !== 1 || r.id !== rowId) return null;
  const edit: InboxLoginEdit = { v: 1, id: rowId, set: {}, addPasskeys: [] };
  if (r.item !== undefined) {
    if (typeof r.item !== 'string' || !ITEM_ID.test(r.item)) return null;
    edit.item = r.item;
  }
  const set = r.set === undefined ? {} : r.set;
  if (!set || typeof set !== 'object' || Array.isArray(set)) return null;
  for (const [key, v] of Object.entries(set)) {
    if (!(LOGIN_EDIT_FIELDS as readonly string[]).includes(key)) return null;
    if (key === 'url') {
      const url = editUrl(v);
      if (url === null) return null;
      edit.set.url = url;
    } else {
      if (!editText(v)) return null;
      edit.set[key as Exclude<LoginEditField, 'url'>] = v;
    }
  }
  const add = r.addPasskeys === undefined ? [] : r.addPasskeys;
  if (!Array.isArray(add) || add.length > INBOX_LOGINEDIT_LIMITS.passkeys) return null;
  for (const item of add) {
    const passkey = parseSitePasskey(item);
    if (!passkey || edit.addPasskeys.some((p) => p.credentialId === passkey.credentialId)) return null;
    edit.addPasskeys.push(passkey);
  }
  if (r.base !== undefined) {
    const b = r.base as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || !editText(b.name) || !editText(b.username)) return null;
    const url = editUrl(b.url);
    if (url === null) return null;
    edit.base = { name: b.name, username: b.username, url };
  }
  if (r.proof !== undefined) {
    const pr = r.proof as Record<string, unknown> | null;
    if (!pr || typeof pr !== 'object' || typeof pr.tag !== 'string' || !/^[0-9a-f]{1,64}$/.test(pr.tag)
      || typeof pr.mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pr.mac)) return null;
    edit.proof = { tag: pr.tag, mac: pr.mac };
  }
  if (r.queuedAt !== undefined) {
    if (typeof r.queuedAt !== 'number' || !Number.isSafeInteger(r.queuedAt) || r.queuedAt < 0) return null;
    edit.queuedAt = r.queuedAt;
  }
  if (edit.item && !edit.base) return null;
  if (!Object.keys(edit.set).length && !edit.addPasskeys.length) return null;
  return edit;
}

/** A note from the command line `privacynotes`; the app adopts it into the Agent folder.
 *  Spec: docs/internal/plans/agent-cli.md (section 3.3) */
export interface InboxNote {
  v: 1;
  id: string;
  title: string;
  markdown: string;
  tags: string[];
  savedAt: string;
  /** Where it was written: absent for `privacynotes` (the Agent folder), else
   *  the extension's New note or the Ninja box. Either lands at the root.
   *  Spec: docs/internal/plans/quick-note-694.md (Q3) */
  from?: InboxNoteFrom;
  /** The folder id the Ninja box read from the title line, `from: 'quick'` only. */
  folder?: string;
}

export type InboxNoteFrom = 'browser' | 'quick';

/** The limits both `privacynotes` and the app hold a note row to. The body cap is the
 *  clipper's `CLIP_MAX_BODY_BYTES` (tests/cliNote.test.ts keeps them equal).
 *  Spec: docs/internal/plans/agent-cli.md (sections 3.3 and 3.4) */
export const INBOX_NOTE_LIMITS = { bodyBytes: 700 * 1024, title: 200, tags: 20 } as const;

/** A note's title when none is given: the first `# ` heading, else the first
 *  line with text, cut to the limit. `privacynotes save` and the extension's
 *  New note use it. */
export function inboxNoteTitle(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.find((l) => /^#\s+\S/.test(l));
  const first = heading ? heading.replace(/^#\s+/, '') : (lines.find((l) => l.trim()) ?? '');
  return [...first.trim()].slice(0, INBOX_NOTE_LIMITS.title).join('');
}

/** The shape check of a `note` row, shared by `privacynotes` (before it sends) and the
 *  app (after it opens): the fields and their limits, nothing about the
 *  Markdown itself. Tags are left as sent; the app normalizes them. */
export function parseInboxNote(value: unknown, rowId: string): InboxNote | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || v.id !== rowId) return null;
  if (typeof v.title !== 'string' || [...v.title].length > INBOX_NOTE_LIMITS.title) return null;
  if (typeof v.markdown !== 'string' || !v.markdown.trim()) return null;
  if (utf8.encode(v.markdown).length > INBOX_NOTE_LIMITS.bodyBytes) return null;
  if (!Array.isArray(v.tags) || v.tags.length > INBOX_NOTE_LIMITS.tags) return null;
  if (!v.tags.every((t) => typeof t === 'string' && t.length <= 200)) return null;
  if (typeof v.savedAt !== 'string' || Number.isNaN(Date.parse(v.savedAt))) return null;
  const note: InboxNote = { v: 1, id: rowId, title: v.title, markdown: v.markdown, tags: v.tags as string[], savedAt: v.savedAt };
  // An older app drops both fields and puts the note in the Agent folder:
  // a value this one does not know is dropped the same way.
  if (v.from === 'browser' || v.from === 'quick') note.from = v.from;
  if (note.from === 'quick' && typeof v.folder === 'string' && v.folder.length > 0 && v.folder.length <= 200) note.folder = v.folder;
  return note;
}

export interface InboxPictureHeader {
  v: 1;
  id: string;
  /** The clip row this picture belongs to. */
  clip: string;
  type: string;
  size: number;
}

/** A picture row's plaintext: a 4-byte header length, the JSON header, the
 *  picture's bytes, then padding to 4 KiB. Bytes, not base64, so a picture
 *  costs its own size in the row. */
export function packInboxPicture(header: InboxPictureHeader, bytes: Uint8Array): Uint8Array {
  const head = utf8.encode(JSON.stringify(header));
  const used = 4 + head.length + bytes.length;
  const out = new Uint8Array(Math.ceil((used + 1) / INBOX_PAD) * INBOX_PAD);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(bytes, 4 + head.length);
  return out;
}

/** Inverse of packInboxPicture, with no trust in the header: null when the
 *  lengths do not add up. */
export function unpackInboxPicture(plain: Uint8Array): { header: unknown; bytes: Uint8Array } | null {
  if (plain.length < 4) return null;
  const headLen = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
  if (headLen < 2 || headLen > 1024 || 4 + headLen > plain.length) return null;
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + headLen)));
  } catch {
    return null;
  }
  const size = (header as { size?: unknown } | null)?.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || 4 + headLen + size > plain.length) return null;
  return { header, bytes: plain.slice(4 + headLen, 4 + headLen + size) };
}

/** A fresh logins key and the random tag that names it on the server. */
export function newLoginsKey(): { p: Uint8Array; tag: string } {
  return { p: randomBytes(32), tag: bytesToHex(randomBytes(16)) };
}

/** A keyed fingerprint of what an app last wrote to one copy row, so it can
 *  skip an unchanged login without keeping a plain hash of a password. */
export function loginsFingerprint(idKey: Uint8Array, text: string): string {
  return bytesToHex(hmac(sha256, idKey, utf8.encode(`fp:${text}`)).subarray(0, 16));
}

/**
 * One row of the vault copy, as an app writes it and the extension reads it:
 * only what the extension shows. Never an item's notes or custom fields, a
 * card's billing address, an SSH key's private key or passphrase, a note's
 * text. Version 2 added the kinds beside the login and the pinned flag; an
 * extension skips a kind or a version it does not know, so an older add-on
 * keeps working on a newer copy, with fewer rows.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, the copy)
 */
export const COPY_VERSION = 2;
export const COPY_KINDS = ['login', 'card', 'ssh', 'bookmark'] as const;
export type CopyKind = (typeof COPY_KINDS)[number];

interface CopyEntryBase {
  v: typeof COPY_VERSION;
  /** The vault item's id: the row's identity, and the item a shortcut opens. */
  item: string;
  name: string;
  /** The app's star (Pinned). */
  pinned: boolean;
}
export interface LoginCopyEntry extends CopyEntryBase {
  kind: 'login';
  username: string;
  password: string;
  totp: string;
  urls: string[];
  /** The login's site passkeys; absent when it holds none. An optional field,
   *  so the copy stays version 2 and an older extension ignores it.
   *  Spec: docs/contrib/passkeys.md (P23, section 5.3) */
  passkeys?: SitePasskey[];
}
export interface CardCopyEntry extends CopyEntryBase {
  kind: 'card';
  holder: string;
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  /** Visa, Mastercard and so on, as the app detects it; empty when unknown. */
  network: string;
}
export interface SshKeyCopyEntry extends CopyEntryBase {
  kind: 'ssh';
  publicKey: string;
  /** `SHA256:<base64>` of the key blob, as ssh-keygen prints it; empty when the key does not parse. */
  fingerprint: string;
  /** ED25519, RSA, ECDSA; empty when unknown. */
  keyType: string;
}
export interface BookmarkCopyEntry extends CopyEntryBase {
  kind: 'bookmark';
  url: string;
  /** The note the page was clipped into, when there is one. */
  note: string | null;
  /** When the bookmark was made (ISO). */
  savedAt: string;
}
export type CopyEntry = LoginCopyEntry | CardCopyEntry | SshKeyCopyEntry | BookmarkCopyEntry;

const str = (v: unknown): v is string => typeof v === 'string';
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);

/** The passkeys of an array that parse, the first of each credential id; an
 *  empty list for anything that is not an array. */
function sitePasskeys(value: unknown): SitePasskey[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SitePasskey[] = [];
  for (const item of value) {
    const passkey = parseSitePasskey(item);
    if (!passkey || seen.has(passkey.credentialId)) continue;
    seen.add(passkey.credentialId);
    out.push(passkey);
  }
  return out;
}

/**
 * The extension's shape check on an opened row: a row that is not exactly one
 * of the kinds above, with every field of its kind, is left out, never shown
 * half. Returns a fresh object with the known fields only.
 */
export function parseCopyEntry(value: unknown): CopyEntry | null {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || r.v !== COPY_VERSION || !str(r.item) || !str(r.name)) return null;
  const base = { v: COPY_VERSION as 2, item: r.item, name: r.name, pinned: r.pinned === true };
  switch (r.kind) {
    case 'login': {
      if (!str(r.username) || !str(r.password) || !str(r.totp) || !strs(r.urls)) return null;
      const login: LoginCopyEntry = { ...base, kind: 'login', username: r.username, password: r.password, totp: r.totp, urls: r.urls };
      // The login stays when its passkeys do not hold: only those go.
      const passkeys = sitePasskeys(r.passkeys);
      if (passkeys.length) login.passkeys = passkeys;
      return login;
    }
    case 'card':
      if (!str(r.holder) || !str(r.number) || !str(r.expMonth) || !str(r.expYear) || !str(r.cvv) || !str(r.network)) return null;
      return { ...base, kind: 'card', holder: r.holder, number: r.number, expMonth: r.expMonth, expYear: r.expYear, cvv: r.cvv, network: r.network };
    case 'ssh':
      if (!str(r.publicKey) || !str(r.fingerprint) || !str(r.keyType)) return null;
      return { ...base, kind: 'ssh', publicKey: r.publicKey, fingerprint: r.fingerprint, keyType: r.keyType };
    case 'bookmark':
      if (!str(r.url) || !(r.note === null || str(r.note)) || !str(r.savedAt)) return null;
      return { ...base, kind: 'bookmark', url: r.url, note: r.note, savedAt: r.savedAt };
    default:
      return null;
  }
}

/** What a copy row is bound to: a row moved to another account or id fails.
 *  The label keeps "login" from version 1: the rows already on the server are
 *  bound to it, and the entry's own `v` and `kind` say what the row is. */
export function loginsCopyAad(account: string, rowId: string): string {
  return `privacynotes-ext-login-v1:${account}:${rowId}`;
}

/** Wraps the unlock proof under a passkey's PRF output, for the extension's
 *  fingerprint or face unlock: the proof, never Ksrv or P, so the server still
 *  checks every unlock and a removed extension cannot open anything. */
export function deriveProofWrapKey(prfOutput: Uint8Array): Uint8Array {
  return hkdf(sha256, prfOutput, undefined, utf8.encode('privacynotes-ext-prf-wrap-v1'), 32);
}
