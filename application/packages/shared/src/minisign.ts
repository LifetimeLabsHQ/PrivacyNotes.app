/**
 * Checks a minisign signature: Ed25519 over the BLAKE2b-512 hash of the file,
 * which is what the `minisign` command writes (algorithm `ED`).
 *
 * Its own entry, `@notes/shared/minisign`, so the app loads it only when it
 * has a signature to check (the update policy files).
 *
 * A .minisig file is four lines: an untrusted comment, the signature line,
 * a trusted comment and a second signature over the first one plus that
 * comment. Only the signature line is read here: nothing uses the trusted
 * comment, so its signature is not checked.
 *
 * Spec: docs/internal/android-update-check.md (The policy signature)
 */

// `.js` on the subpath, none on the entry. Spec: docs/internal/dependency-migration.md
import { blake2b } from '@noble/hashes/blake2.js';
import * as ed from '@noble/ed25519';
import { base64ToBytes } from './crypto.js';

// A key or signature line is base64 of: two algorithm bytes, eight key id
// bytes, then the public key (32 bytes) or the signature (64 bytes).
const HEAD = 10;
const PUBLIC_KEY_BYTES = HEAD + 32;
const SIGNATURE_BYTES = HEAD + 64;

/**
 * True when `signature`, the text of a .minisig file, is a valid signature
 * over `message` by `publicKey`, the base64 line of a minisign .pub file.
 * False for anything else; it does not throw. The older algorithm `Ed`, which
 * signs the bytes without the hash step, is refused.
 */
export async function verifyMinisign(message: Uint8Array, signature: string, publicKey: string): Promise<boolean> {
  try {
    const key = base64ToBytes(publicKey.trim());
    const sig = base64ToBytes((signature.split('\n')[1] ?? '').trim());
    if (key.length !== PUBLIC_KEY_BYTES || sig.length !== SIGNATURE_BYTES) return false;
    // 'Ed' on the key, 'ED' (hashed) on the signature.
    if (key[0] !== 0x45 || key[1] !== 0x64 || sig[0] !== 0x45 || sig[1] !== 0x44) return false;
    for (let i = 2; i < HEAD; i++) if (key[i] !== sig[i]) return false;
    return await ed.verifyAsync(sig.subarray(HEAD), blake2b(message, { dkLen: 64 }), key.subarray(HEAD), { zip215: false });
  } catch {
    return false;
  }
}
