/**
 * Memory-hard KDF for password-wrapped sign-in passkey slots (`wrap_kind = 'pw-s1'`).
 *
 * Kept in its own entry (`@notes/shared/passkey-kdf`), never re-exported from
 * the barrel, and excluded from the web app's boot-path `shared` chunk so only
 * a browser adding or signing in with a non-PRF passkey loads it.
 *
 * Uses audited RFC 7914 `scryptAsync` from `@noble/hashes/scrypt.js` at
 * N = 2^16 (64 MiB), r = 8, p = 2, dkLen = 32: 64 MiB peak memory (safe on
 * mobile Safari while matching OWASP's scrypt work factor at 64 MiB), yielding
 * to the event loop every 10 ms and zeroizing its scratch buffers on completion
 * or abort. The caller mixes the 32-byte scrypt output with the passkey's
 * 32-byte random `userHandle` (held only by the passkey provider, never sent
 * to the server) through HKDF-SHA256 to derive the non-extractable AES-GCM-256
 * slot key.
 *
 * Spec: docs/contrib/passkeys.md (section 4.1)
 */
import { scryptAsync } from '@noble/hashes/scrypt.js';

/** HKDF info string binding the combined userHandle || scrypt key material to pw-s1. */
export const PASSKEY_PW_HKDF_INFO = 'privacynotes-passkey-slot:pw-s1';

/** UTF-8 byte cap on a passkey password (DoS bound before running scrypt). */
export const PASSKEY_PASSWORD_MAX_UTF8_BYTES = 1024;
/** Required salt length (bytes) for pw-s1 scrypt and HKDF. */
export const PASSKEY_KDF_SALT_BYTES = 32;

/**
 * Frozen scrypt parameters for `wrap_kind = 'pw-s1'`. Never read from the server
 * (a compromised database cannot lower cost or cause OOM). A future bump adds a
 * new wrap_kind token (e.g. `pw-s2`) with its own hardcoded parameters.
 * Spec: docs/contrib/passkeys.md (section 4.1)
 */
export const PASSKEY_SCRYPT_OPTS = Object.freeze({
  N: 2 ** 16,
  r: 8,
  p: 2,
  dkLen: 32,
  asyncTick: 10,
});

const utf8 = new TextEncoder();

/**
 * Derive 32 bytes from a passkey password and 32-byte salt using scryptAsync.
 * Accepts any non-empty password up to the UTF-8 byte cap so sign-in never
 * rejects a password on policy changes; callers must zeroize the returned bytes
 * immediately after feeding them into HKDF.
 */
export async function derivePasskeyScrypt(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (typeof password !== 'string' || password.length === 0) throw new Error('empty password');
  if (!(salt instanceof Uint8Array) || salt.length !== PASSKEY_KDF_SALT_BYTES) {
    throw new Error('salt must be 32 bytes');
  }
  const nfc = password.normalize('NFC');
  const pwBytes = utf8.encode(nfc);
  if (pwBytes.length === 0 || pwBytes.length > PASSKEY_PASSWORD_MAX_UTF8_BYTES) {
    pwBytes.fill(0);
    throw new Error('password out of bounds');
  }
  try {
    return await scryptAsync(pwBytes, salt, PASSKEY_SCRYPT_OPTS);
  } finally {
    pwBytes.fill(0);
  }
}
