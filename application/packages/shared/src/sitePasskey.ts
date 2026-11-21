/**
 * A passkey for another website, as a Vault login holds it and the browser
 * extension uses it. The private key and the PRF secret are as sensitive as a
 * password: they live only inside the login's encrypted body and the
 * extension's logins copy, never in search text or a printable view.
 * Spec: docs/contrib/passkeys.md (section 5.1)
 */

import { base64urlToBytesStrict } from './crypto.js';

export interface SitePasskey {
  v: 1;
  /** Unpadded base64url. */
  credentialId: string;
  /** The relying party id, a lower-case domain, e.g. "github.com". */
  rpId: string;
  /** Unpadded base64url of the site's `user.id`. */
  userHandle: string;
  userName: string;
  displayName: string;
  /** Unpadded base64url PKCS#8 of the P-256 private key. */
  key: string;
  /** Unpadded base64url of 32 random bytes, the PRF (hmac-secret) key. */
  prfSecret: string;
  /** ISO time. */
  created: string;
}

/** Field limits, in characters. A credential id of 1366 characters is 1024
 *  bytes; a user handle of 88 holds WebAuthn's 64 bytes.
 *  Spec: docs/contrib/passkeys.md (section 5.1) */
export const SITE_PASSKEY_LIMITS = { credentialId: 1366, userHandle: 88, name: 256, rpId: 253 } as const;

// WebAuthn's own limit: a `user.id` is 1 to 64 bytes.
const USER_HANDLE_MAX_BYTES = 64;
/** The length of `prfSecret`. Spec: docs/contrib/passkeys.md (section 5.1, 32 random bytes) */
export const SITE_PASSKEY_PRF_SECRET_BYTES = 32;

// The two DER spellings of a P-256 PKCS#8 key (RFC 5208, RFC 5915): with the
// public key, as WebCrypto and this package write it (138 bytes), and without
// it (67 bytes). Each is a fixed prefix, the 32-byte scalar, and for the long
// form a fixed infix and the 65-byte uncompressed point.
const PKCS8_P256_LONG = '308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420';
const PKCS8_P256_SHORT = '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420';
const PKCS8_P256_POINT = 'a144034200';
// The order n of P-256's base point, big-endian.
const P256_ORDER = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array, at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
}

/** A 32-byte big-endian scalar in [1, n - 1]. */
function scalarInRange(d: Uint8Array): boolean {
  const n = hexBytes(P256_ORDER);
  if (d.length !== 32 || d.every((b) => b === 0)) return false;
  for (let i = 0; i < 32; i++) {
    if (d[i] !== n[i]) return (d[i] as number) < (n[i] as number);
  }
  return false;
}

/** The private scalar of a P-256 PKCS#8 key in one of the two fixed
 *  spellings, or null for anything else (another curve, another layout, a
 *  scalar out of range, trailing bytes). */
export function p256Pkcs8Scalar(der: Uint8Array): Uint8Array | null {
  const long = hexBytes(PKCS8_P256_LONG);
  const short = hexBytes(PKCS8_P256_SHORT);
  let d: Uint8Array;
  if (der.length === long.length + 32 + 5 + 65 && startsWith(der, long)) {
    if (!startsWith(der, hexBytes(PKCS8_P256_POINT), long.length + 32) || der[long.length + 37] !== 0x04) return null;
    d = der.slice(long.length, long.length + 32);
  } else if (der.length === short.length + 32 && startsWith(der, short)) {
    d = der.slice(short.length);
  } else {
    return null;
  }
  return scalarInRange(d) ? d : null;
}

/** The PKCS#8 DER of a P-256 key with its public point (the 138-byte form
 *  WebCrypto's `exportKey('pkcs8')` writes). `publicKey` is the 65-byte
 *  uncompressed point. */
export function p256Pkcs8(scalar: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (!scalarInRange(scalar) || publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error('p256 key malformed');
  const long = hexBytes(PKCS8_P256_LONG);
  const point = hexBytes(PKCS8_P256_POINT);
  const out = new Uint8Array(long.length + 32 + point.length + 65);
  out.set(long);
  out.set(scalar, long.length);
  out.set(point, long.length + 32);
  out.set(publicKey, long.length + 32 + point.length);
  return out;
}

// A lower-case DNS name of labels of at most 63 letters, digits and inner
// hyphens. The last label may not be all digits, so an IPv4 address is no RP
// ID (the extension refuses IP addresses, section 5.4).
const RP_ID = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRpId(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > SITE_PASSKEY_LIMITS.rpId || !RP_ID.test(v)) return false;
  return !/^\d+$/.test(v.slice(v.lastIndexOf('.') + 1));
}

const isName = (v: unknown): v is string => typeof v === 'string' && v.length <= SITE_PASSKEY_LIMITS.name;

/**
 * The shape check of a site passkey from anywhere outside this process (a
 * login body, a copy row, an inbox row): every field present with its type
 * and length, the ids and secrets strict base64url that decode, the key a
 * P-256 PKCS#8 key. Returns a fresh object with the known fields only, or
 * null.
 */
export function parseSitePasskey(x: unknown): SitePasskey | null {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.v !== 1) return null;
  const id = base64urlToBytesStrict(r.credentialId, SITE_PASSKEY_LIMITS.credentialId);
  if (!id || id.length === 0) return null;
  if (!isRpId(r.rpId)) return null;
  const handle = base64urlToBytesStrict(r.userHandle, SITE_PASSKEY_LIMITS.userHandle);
  if (!handle || handle.length === 0 || handle.length > USER_HANDLE_MAX_BYTES) return null;
  if (!isName(r.userName) || !isName(r.displayName)) return null;
  // 138 bytes of DER are 184 characters.
  const key = base64urlToBytesStrict(r.key, 184);
  if (!key || !p256Pkcs8Scalar(key)) return null;
  const secret = base64urlToBytesStrict(r.prfSecret, 43);
  if (!secret || secret.length !== SITE_PASSKEY_PRF_SECRET_BYTES) return null;
  if (typeof r.created !== 'string' || !ISO_TIME.test(r.created) || !Number.isFinite(Date.parse(r.created))) return null;
  return {
    v: 1,
    credentialId: r.credentialId as string,
    rpId: r.rpId,
    userHandle: r.userHandle as string,
    userName: r.userName,
    displayName: r.displayName,
    key: r.key as string,
    prfSecret: r.prfSecret as string,
    created: r.created,
  };
}
