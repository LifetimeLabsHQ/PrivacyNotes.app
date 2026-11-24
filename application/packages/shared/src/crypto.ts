/**
 * Crypto core. From a BIP-39 phrase (12 or 24 words), HKDF branches are
 * derived, each under its own domain-separation info string:
 *   - ed25519 signing keypair - public key is the user ID.
 *   - xchacha20poly1305 symmetric key - encrypts note contents for sync.
 *   - local-data key - seals note content at rest on the device.
 *   - fingerprint pepper - see "Device fingerprint hashing" below.
 *   - auth password - see "Auth credential" below.
 *
 * Server stores only: user_pubkey (identity), ciphertext, nonce.
 * Seed and private keys never leave the device.
 */

import { readBind, type NoteBind } from './noteBind.js';
import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
  mnemonicToSeedSync,
} from '@scure/bip39';
// @noble/@scure v2+ require the explicit `.js` on subpath imports, and sha256 folded into
// sha2. Dropping the suffix, or reaching for '@noble/hashes/sha256', is a build error, not a
// silent fallback. Verified 2026-07-16: these paths produce byte-identical keys to the v1
// ones (see tools/crypto-kat.mjs). Spec: docs/internal/dependency-migration.md (run `pnpm test:crypto` to verify)
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import * as ed from '@noble/ed25519';
// Spec: THREAT_MODEL.md (xchacha20poly1305 via @noble/ciphers)
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import type { DecryptedNote } from './types.js';

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

// ------------------------------------------------------------------
// BIP-39 phrase
// ------------------------------------------------------------------

// Spec: THREAT_MODEL.md (BIP-39 12-word phrase, client-generated, never touches server)
// 24 words carry 256 bits. Every other function here takes any valid BIP-39
// length, so a phrase of either length derives its keys the same way.
// Spec: docs/internal/plans/phrase-change.md (section 3, the 12 or 24 word choice)
export function generatePhrase(words: 12 | 24 = 12): string {
  return generateMnemonic(wordlist, words === 24 ? 256 : 128);
}

/** True if the phrase is a valid BIP-39 mnemonic (checksum verified). */
export function isValidPhrase(phrase: string): boolean {
  return validateMnemonic(phrase.trim().toLowerCase(), wordlist);
}

/** The BIP-39 entropy of a valid phrase: 16 bytes for 12 words, 32 for 24.
 *  Throws on an invalid phrase. */
export function phraseToEntropy(phrase: string): Uint8Array {
  return mnemonicToEntropy(phrase.trim().toLowerCase(), wordlist);
}

/** The phrase of 16 to 32 bytes of BIP-39 entropy (a multiple of 4). */
export function entropyToPhrase(entropy: Uint8Array): string {
  return entropyToMnemonic(entropy, wordlist);
}

/** 64-byte BIP-39 seed - single source of truth for all key derivation. */
export function phraseToSeed(phrase: string): Uint8Array {
  return mnemonicToSeedSync(phrase.trim().toLowerCase());
}

// ------------------------------------------------------------------
// Key derivation (HKDF with domain-separated info strings)
// ------------------------------------------------------------------

/** Derive the ed25519 signing keypair. Public key = user ID. */
export async function deriveSigningKey(
  seed: Uint8Array
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const privateKey = hkdf(
    sha256,
    seed,
    undefined,
    utf8.encode('privacynotes-signing-v1'),
    32
  );
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey };
}

/** Derive the xchacha20poly1305 symmetric key. Same seed = same key on every device. */
export function deriveEncryptionKey(seed: Uint8Array): Uint8Array {
  return hkdf(
    sha256,
    seed,
    undefined,
    utf8.encode('privacynotes-encryption-v1'),
    32
  );
}

/**
 * Derive the local-data key: seals note content at rest in the device's
 * own storage (IndexedDB rows, caches, the flush stash). Disjoint from
 * the sync encryption branch so a local ciphertext can never pass as a
 * server row or the reverse. Never stored and never transmitted - it is
 * re-derived from the phrase on every unlock.
 * Spec: docs/internal/specs/local-at-rest.md (HKDF branch, section 3.1)
 */
export function deriveLocalDataKey(seed: Uint8Array): Uint8Array {
  return hkdf(
    sha256,
    seed,
    undefined,
    utf8.encode('privacynotes-local-at-rest-v1'),
    32
  );
}

/**
 * The key that seals the stored sign-in session while the app lock is armed
 * (web `sessionSeal.ts`). From the phrase's BIP-39 entropy, not the seed, so
 * it is ready before the seed's PBKDF2 at an unlock: every door of the lock
 * gives the phrase, and only the phrase gives this key. Never stored.
 * Spec: docs/internal/specs/session-under-app-lock.md (section 2.1)
 */
export function deriveSessionSealKey(phrase: string): Uint8Array {
  return hkdf(sha256, phraseToEntropy(phrase), undefined, utf8.encode('privacynotes-session-seal-v1'), 32);
}

// Challenge signing - proves pubkey ownership to link-pubkey edge function.

/**
 * A stamp from an edge function: the server's time and its HMAC, digits, one
 * dot and 64 lower-case hex characters. A stamped text ends in
 * `:<digest>:<stamp>`, and the server takes it for two minutes. Every
 * part is checked before anything is signed, so a server can never have the
 * key sign another text.
 * Spec: docs/internal/plans/challenge-expiry.md (section 3.3)
 */
const STAMP_SHAPE = /^\d{1,12}\.[0-9a-f]{64}$/;

/** The three challenges that end in a stamp. */
type StampedChallenge = 'link' | 'register-device' | 'manage-storage-sub';

/**
 * SHA-256 hex of `["<purpose>-v2", <value>]`: the body fields a stamped
 * challenge signs besides its old text. The same array as `challengeDigest`
 * in packages/supabase/functions/_shared/challengeStamp.ts;
 * tests/challengeExpiry.test.ts runs both.
 */
function challengeDigest(purpose: StampedChallenge, value: string | boolean | null): string {
  return bytesToHex(sha256(utf8.encode(JSON.stringify([`${purpose}-v2`, value]))));
}

/** `:<digest>:<stamp>` for a stamp of the right shape; the empty string for none (the old text, kept for its tests). */
function stampSuffix(purpose: StampedChallenge, stamped: { stamp: string; value: string | boolean | null } | undefined): string {
  if (stamped === undefined) return '';
  if (!STAMP_SHAPE.test(stamped.stamp)) throw new Error('challenge stamp malformed');
  return `:${challengeDigest(purpose, stamped.value)}:${stamped.stamp}`;
}

/**
 * Sign `link:<authUid>:<digest>:<stamp>` with the ed25519 private key, the
 * stamp from link-pubkey `link-stamp` and the digest over the credential the
 * link attaches (null for none). Binding authUid prevents replay across
 * different users; the stamp ends a signature's use after two minutes.
 * Without `stamped` it signs the old `link:<authUid>`, which the server takes
 * only while LEGACY_UNSTAMPED_SIGNATURE_ACCEPTED is on: kept for the tests of
 * that path.
 */
export async function signLinkChallenge(
  privateKey: Uint8Array,
  authUid: string,
  stamped?: { stamp: string; authPassword: string | null },
): Promise<Uint8Array> {
  if (stamped && (!UUID_SHAPE.test(authUid) || (stamped.authPassword !== null && !HEX32_KEY.test(stamped.authPassword)))) {
    throw new Error('link challenge malformed');
  }
  const suffix = stampSuffix('link', stamped && { stamp: stamped.stamp, value: stamped.authPassword });
  return ed.signAsync(utf8.encode(`link:${authUid}${suffix}`), privateKey);
}

/** The account action has already validated the server nonce and recomputed
 * this exact challenge from its own session and normalized payload. */
export async function signAccountLoginsChallenge(privateKey: Uint8Array, challenge: {
  nonceId: string; authUid: string; sessionId: string; pubkey: string;
  operation: 'activate' | 'connect' | 'disconnect' | 'enroll-mfa' | 'unenroll-mfa'; bodyDigest: string;
}): Promise<Uint8Array> {
  const { nonceId, authUid, sessionId, pubkey, operation, bodyDigest } = challenge;
  return ed.signAsync(utf8.encode(`account-logins:${nonceId}:${authUid}:${sessionId}:${pubkey}:${operation}:${bodyDigest}`), privateKey);
}

/** 32 bytes as lower-case hex: a public key, an account id or a digest. */
export const HEX32_KEY = /^[0-9a-f]{64}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Sign `resolve:<signingPubkey>:<nonce>` for link-pubkey `resolve`, which
 * answers which account a signing key belongs to after a phrase change. The
 * text is built here from a nonce of digits, a dot and hex, so a server can
 * never have this key sign another function's challenge.
 * Spec: docs/internal/plans/phrase-change.md (4.3)
 */
export async function signResolveChallenge(
  privateKey: Uint8Array,
  signingPubkey: string,
  nonce: string,
): Promise<Uint8Array> {
  if (!HEX32_KEY.test(signingPubkey) || !/^\d{1,12}\.[0-9a-f]{64}$/.test(nonce)) {
    throw new Error('resolve challenge malformed');
  }
  return ed.signAsync(utf8.encode(`resolve:${signingPubkey}:${nonce}`), privateKey);
}

/**
 * Sign `bind-session:<nonceId>:<authUid>:<sessionId>:<account>` for
 * link-pubkey `bind-session`: this session proves the account's current
 * signing key, and the key-epoch write gate lets it write.
 * Spec: docs/internal/plans/phrase-change.md (4.4)
 */
export async function signBindSessionChallenge(privateKey: Uint8Array, challenge: {
  nonceId: string; authUid: string; sessionId: string; account: string;
}): Promise<Uint8Array> {
  const { nonceId, authUid, sessionId, account } = challenge;
  if (![nonceId, authUid, sessionId].every((v) => UUID_SHAPE.test(v)) || !HEX32_KEY.test(account)) {
    throw new Error('bind-session challenge malformed');
  }
  return ed.signAsync(utf8.encode(`bind-session:${nonceId}:${authUid}:${sessionId}:${account}`), privateKey);
}

/**
 * Sign `rotate-phrase:<nonceId>:<authUid>:<sessionId>:<account>:<epoch>:<newSigningPubkey>:<bodyDigest>`
 * for the edge function `rotate-phrase`. The change signs it twice, with the
 * account's current key and with the new phrase's key. The text is built here
 * from checked parts, so a server can never have either key sign another
 * function's challenge. Spec: docs/internal/plans/phrase-change.md (section 5)
 */
export async function signRotatePhraseChallenge(privateKey: Uint8Array, challenge: {
  nonceId: string; authUid: string; sessionId: string; account: string;
  epoch: number; newSigningPubkey: string; bodyDigest: string;
}): Promise<Uint8Array> {
  const { nonceId, authUid, sessionId, account, epoch, newSigningPubkey, bodyDigest } = challenge;
  if (![nonceId, authUid, sessionId].every((v) => UUID_SHAPE.test(v)) || ![account, newSigningPubkey, bodyDigest].every((v) => HEX32_KEY.test(v))
    || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error('rotate-phrase challenge malformed');
  }
  return ed.signAsync(utf8.encode(`rotate-phrase:${nonceId}:${authUid}:${sessionId}:${account}:${epoch}:${newSigningPubkey}:${bodyDigest}`), privateKey);
}

/**
 * Sign `passkey-slot:<nonceId>:<authUid>:<sessionId>:<account>:<operation>:<bodyDigest>`
 * for the edge function `passkey-slot`, which adds or removes a sign-in
 * passkey's slot only under the account's signing key, over a server nonce,
 * this session and a digest of the whole request body. The text is built here
 * from checked parts, so a server can never have the key sign another
 * function's challenge. Spec: docs/contrib/passkeys.md (P19, section 4.2)
 */
export async function signPasskeySlotChallenge(privateKey: Uint8Array, challenge: {
  nonceId: string; authUid: string; sessionId: string; account: string;
  operation: 'passkey-add' | 'passkey-remove'; bodyDigest: string;
}): Promise<Uint8Array> {
  const { nonceId, authUid, sessionId, account, operation, bodyDigest } = challenge;
  if (![nonceId, authUid, sessionId].every((v) => UUID_SHAPE.test(v)) || ![account, bodyDigest].every((v) => HEX32_KEY.test(v))
    || (operation !== 'passkey-add' && operation !== 'passkey-remove')) {
    throw new Error('passkey-slot challenge malformed');
  }
  return ed.signAsync(utf8.encode(`passkey-slot:${nonceId}:${authUid}:${sessionId}:${account}:${operation}:${bodyDigest}`), privateKey);
}

/** A custody change: store the phrase with the server, or delete that copy. */
export type CustodyAction = 'custody-store' | 'custody-delete';

/**
 * The digest a custody nonce is bound to and the request signs: SHA-256 over
 * `["<action>-v1", <phrase or null>]`, the phrase trimmed as the server
 * stores it. The same array as `custodyBodyDigest` in
 * packages/supabase/functions/_shared/custodyProof.ts; tests/review181Server.test.ts runs both.
 */
export async function custodyBodyDigest(action: CustodyAction, phrase: string | null): Promise<string> {
  const text = JSON.stringify([`${action}-v1`, action === 'custody-store' ? (phrase ?? '').trim() : null]);
  return bytesToHex(sha256(utf8.encode(text)));
}

/**
 * Sign `<action>:<nonceId>:<authUid>:<sessionId>:<account>:<bodyDigest>` for
 * `store-custodial-phrase` (`custody-store`) or `delete-custodial-phrase`
 * (`custody-delete`). The nonce is one use (account_consume_nonce), so a saved
 * request cannot be sent again later; the session and the digest bind it to
 * this sign-in and this phrase. The text is built here from checked parts, so
 * a server can never have the key sign another function's challenge.
 * Spec: docs/contrib/custodial-key-spec.md (One use: the custody nonce)
 */
export async function signCustodyChallenge(privateKey: Uint8Array, challenge: {
  action: CustodyAction; nonceId: string; authUid: string; sessionId: string; account: string; bodyDigest: string;
}): Promise<Uint8Array> {
  const { action, nonceId, authUid, sessionId, account, bodyDigest } = challenge;
  if (![nonceId, authUid, sessionId].every((v) => UUID_SHAPE.test(v)) || ![account, bodyDigest].every((v) => HEX32_KEY.test(v))
    || (action !== 'custody-store' && action !== 'custody-delete')) {
    throw new Error('custody challenge malformed');
  }
  return ed.signAsync(utf8.encode(`${action}:${nonceId}:${authUid}:${sessionId}:${account}:${bodyDigest}`), privateKey);
}

/** `delete-account` and `revoke-device` over a one-use nonce (beta.privacynotes.app #227 item 10). */
export type AccountAction = 'account-delete' | 'device-revoke';

/**
 * The digest an account action's nonce is bound to: SHA-256 over
 * `["<action>-v1", <target device or null>]`. The same array as
 * `accountActionDigest` in packages/supabase/functions/_shared/custodyProof.ts;
 * tests/review0152to0153Server.test.ts runs both.
 */
export function accountActionDigest(action: AccountAction, targetDeviceId: string | null): string {
  const text = JSON.stringify([`${action}-v1`, action === 'device-revoke' ? targetDeviceId : null]);
  return bytesToHex(sha256(utf8.encode(text)));
}

/**
 * Sign `<action>:<nonceId>:<authUid>:<sessionId>:<account>:<bodyDigest>` for
 * `delete-account` (`account-delete`) or `revoke-device` (`device-revoke`).
 * The nonce is one use, so a captured request cannot delete the account or
 * remove a device again later; the session and the digest bind it to this
 * sign-in and, for a removal, the device. Built here from checked parts, as
 * signCustodyChallenge is.
 * Spec: docs/contrib/custodial-key-spec.md (One use: the custody nonce)
 */
export async function signAccountActionChallenge(privateKey: Uint8Array, challenge: {
  action: AccountAction; nonceId: string; authUid: string; sessionId: string; account: string; bodyDigest: string;
}): Promise<Uint8Array> {
  const { action, nonceId, authUid, sessionId, account, bodyDigest } = challenge;
  if (![nonceId, authUid, sessionId].every((v) => UUID_SHAPE.test(v)) || ![account, bodyDigest].every((v) => HEX32_KEY.test(v))
    || (action !== 'account-delete' && action !== 'device-revoke')) {
    throw new Error('account action challenge malformed');
  }
  return ed.signAsync(utf8.encode(`${action}:${nonceId}:${authUid}:${sessionId}:${account}:${bodyDigest}`), privateKey);
}

// ------------------------------------------------------------------
// Device identity
// ------------------------------------------------------------------
//
// Each install generates a random 32-byte deviceSecret, stored locally
// (localStorage). The public deviceId is HKDF(deviceSecret, info=pubkey)
// truncated to 16 bytes (32 hex chars). Including the pubkey in `info`
// means the same local deviceSecret produces different deviceIds across
// different phrases - accounts stay isolated if two users share a
// machine.
//
// The deviceSecret is not a cryptographic secret per se (losing it just
// means the install looks like a new device, which is the intended
// reset behaviour on "clear site data"). But we store it in plain
// localStorage rather than session storage so it survives tab close.

/** 32 random bytes - generate once per install, keep forever. */
export function generateDeviceSecret(): Uint8Array {
  return randomBytes(32);
}

/**
 * Derive a stable 32-hex-char deviceId from (pubkey, deviceSecret). Idempotent on server.
 * `pubkey` is the ACCOUNT ID, never the signing key: after a phrase change the
 * two differ, and a signing key here would give every device a new id.
 * Spec: docs/internal/plans/phrase-change.md (4.6)
 */
export function deriveDeviceId(
  pubkey: string,
  deviceSecret: Uint8Array,
): string {
  const info = utf8.encode(`privacynotes-device-v1:${pubkey}`);
  const bytes = hkdf(sha256, deviceSecret, undefined, info, 16);
  return bytesToHex(bytes);
}

/**
 * Sign the device-registration challenge,
 * `register-device:<authUid>:<deviceId>:<digest>:<stamp>`, the stamp from
 * register-device `stamp` and the digest over the `reactivate` the body
 * sends (null when it sends none). The stamp ends a signature's use after two
 * minutes, and the digest keeps an automatic start from being sent on as a
 * sign-in by hand, so a copy cannot bring a removed device back. Without
 * `stamped` it signs the old text, as signLinkChallenge does.
 */
export async function signDeviceRegisterChallenge(
  privateKey: Uint8Array,
  authUid: string,
  deviceId: string,
  stamped?: { stamp: string; reactivate: boolean | null },
): Promise<Uint8Array> {
  if (stamped && (!UUID_SHAPE.test(authUid) || !/^[0-9a-f]{32}$/.test(deviceId))) {
    throw new Error('register-device challenge malformed');
  }
  const suffix = stampSuffix('register-device', stamped && { stamp: stamped.stamp, value: stamped.reactivate });
  return ed.signAsync(utf8.encode(`register-device:${authUid}:${deviceId}${suffix}`), privateKey);
}

/**
 * Sign the old device-revocation challenge. It names no session and no
 * nonce, so it can be sent again. The app signs signAccountActionChallenge
 * now; the server takes this one only until the release floor
 * (LEGACY_ACCOUNT_SIGNATURE_ACCEPTED). Kept for the tests of that path.
 */
export async function signDeviceRevokeChallenge(
  privateKey: Uint8Array,
  authUid: string,
  targetDeviceId: string,
): Promise<Uint8Array> {
  const message = utf8.encode(`revoke-device:${authUid}:${targetDeviceId}`);
  return ed.signAsync(message, privateKey);
}

/**
 * Sign the old account-deletion challenge, which can be sent again. The app
 * signs signAccountActionChallenge now; the server takes this one only until
 * the release floor (LEGACY_ACCOUNT_SIGNATURE_ACCEPTED). Kept for the tests
 * of that path.
 */
export async function signDeleteAccountChallenge(
  privateKey: Uint8Array,
  authUid: string,
): Promise<Uint8Array> {
  const message = utf8.encode(`delete-account:${authUid}`);
  return ed.signAsync(message, privateKey);
}

/**
 * Sign the custodial-release challenge (custodial -> self-custody).
 * Proves the caller holds the master key, so a stolen session token
 * alone cannot flip someone out of custodial mode. This challenge is
 * possible where the retrieval one is not: by the time a user can ask
 * to leave custodial mode they are signed in and hold the key.
 *
 * The old message: it names only the user, so it can be sent again. The app
 * signs `signCustodyChallenge` now; the server takes this one only until the
 * release floor (LEGACY_CUSTODY_SIGNATURE_ACCEPTED). Kept for the tests of
 * that path.
 */
export async function signCustodialReleaseChallenge(
  privateKey: Uint8Array,
  authUid: string,
): Promise<Uint8Array> {
  const message = utf8.encode(`delete-custodial-phrase:${authUid}`);
  return ed.signAsync(message, privateKey);
}

/**
 * Sign a device's answer to a new sign-in that asks for the account's
 * custodial phrase (custodial-release-decide, migration 0175). The text names
 * the request, the answer, this login and this session, so the signature
 * answers that one request from this device only.
 * Spec: docs/internal/plans/custodial-release-hardening.md (section 13.2)
 */
export async function signCustodialDecideChallenge(privateKey: Uint8Array, challenge: {
  requestId: string; allow: boolean; authUid: string; sessionId: string; account: string;
}): Promise<Uint8Array> {
  const { requestId, allow, authUid, sessionId, account } = challenge;
  return ed.signAsync(utf8.encode(`custodial-release-decide:${requestId}:${allow ? 'allow' : 'deny'}:${authUid}:${sessionId}:${account}`), privateKey);
}

/**
 * Sign the custodial-adopt challenge (storing a phrase server-side).
 *
 * Without this, store-custodial-phrase authorizes on the session token
 * alone, and a stolen token lets an attacker plant a phrase THEY
 * generated as the victim's custodial phrase. The victim's next
 * new-device sign-in then retrieves the attacker's phrase and lands in
 * the attacker's vault, so everything written afterwards is readable
 * by them. Binding the call to the account's signing key closes that:
 * the phrase can only be stored by someone who already holds it.
 *
 * Usable on both callers, because link-pubkey runs before the store in
 * the signup flow, so the signing key exists by then.
 *
 * The old message, accepted only until the release floor, as above.
 */
export async function signCustodialAdoptChallenge(
  privateKey: Uint8Array,
  authUid: string,
): Promise<Uint8Array> {
  const message = utf8.encode(`store-custodial-phrase:${authUid}`);
  return ed.signAsync(message, privateKey);
}

/**
 * Sign the storage-subscription management challenge,
 * `manage-storage-sub:<authUid>:<subscriptionId>:<action>:<priceId>:<digest>:<stamp>`,
 * the stamp from manage-storage-sub `stamp` and the digest over the quote the
 * body sends (null for none). Binds the action and (for a switch) the target
 * price so a signature cannot be replayed against a different subscription,
 * action, or package; the stamp ends its use after two minutes, and the
 * digest keeps the quote's price check in the request. priceId is empty for
 * cancel. Without `stamped` it signs the old text, as signLinkChallenge does.
 */
export async function signStorageManageChallenge(
  privateKey: Uint8Array,
  authUid: string,
  subscriptionId: string,
  action: string,
  priceId: string,
  stamped?: { stamp: string; quote: string | null },
): Promise<Uint8Array> {
  if (stamped && (!UUID_SHAPE.test(authUid) || !/^sub_[a-zA-Z0-9]+$/.test(subscriptionId)
    || !(action === 'cancel' ? priceId === '' : action === 'switch' && /^pri_[a-zA-Z0-9]+$/.test(priceId)))) {
    throw new Error('manage-storage-sub challenge malformed');
  }
  const suffix = stampSuffix('manage-storage-sub', stamped && { stamp: stamped.stamp, value: stamped.quote });
  const message = utf8.encode(
    `manage-storage-sub:${authUid}:${subscriptionId}:${action}:${priceId}${suffix}`,
  );
  return ed.signAsync(message, privateKey);
}

// ------------------------------------------------------------------
// Device fingerprint hashing (per-user peppered)
// ------------------------------------------------------------------
//
// The server stores hashes of (platform, gpu, cores, language) rather
// than the raw values. The pepper is derived from the user's BIP-39
// seed via HKDF with a domain-separated info string, so:
//
//   - The server never sees raw fingerprint values.
//   - Different pubkeys produce different hashes on the same machine,
//     so cross-user fingerprint correlation is impossible.
//   - The same pubkey on the same hardware produces consistent hashes,
//     so per-user device dedup still works.
//
// Spec: docs/internal/specs/device-fingerprint-hash.md

/** Per-user fingerprint pepper. Same seed → same pepper, forever. */
// Spec: docs/internal/specs/device-fingerprint-hash.md (HKDF info "privacynotes-fp-pepper-v1")
export function deriveFpPepper(seed: Uint8Array): Uint8Array {
  return hkdf(
    sha256,
    seed,
    undefined,
    utf8.encode('privacynotes-fp-pepper-v1'),
    32,
  );
}

// ------------------------------------------------------------------
// Auth credential (returning-user session re-mint)
// ------------------------------------------------------------------
//
// A returning user's Supabase session is re-minted by signing in to
// their EXISTING auth user with a credential derived from the phrase,
// instead of creating a brand-new anonymous auth user on every re-mint.
// Anonymous sign-ins are rate-limited per IP per hour and every one of
// them leaves an orphaned auth.users row behind, so the anonymous path
// is reserved for the FIRST sign-in of a pubkey; link-pubkey attaches
// this credential to that auth user, and every later re-mint is a
// plain password grant against it.
//
//   - The password is a full HKDF branch off the seed, disjoint from
//     the signing, encryption and pepper branches. Holding it grants
//     nothing beyond a session for this pubkey's account - which the
//     phrase holder could already mint - and it cannot be reversed to
//     the seed. The server stores only GoTrue's bcrypt of it.
//   - The email is not an address, it is an identifier in email
//     shape: the pubkey at a domain we control that no OAuth provider
//     can ever assert and that receives no mail. The server derives it
//     from the signature-verified pubkey itself (never from client
//     input), which is what keeps the THREAT_MODEL invariant intact:
//     nothing here can present an attacker-chosen email as confirmed.
//
// Spec: docs/internal/design-decisions.md (phrase-derived auth credential)

/** Domain part of the derived auth email. Not a mail domain: no MX,
 * never receives anything, exists so GoTrue has a unique, deterministic
 * identifier to key the password grant on. Duplicated in the
 * link-pubkey edge function, which must derive the same address. */
export const AUTH_EMAIL_DOMAIN = 'phrase.privacynotes.app';

/** Deterministic sign-in identifier for a pubkey. Lowercase on both
 * sides: GoTrue lowercases emails on write, so deriving it any other
 * way would sign in to a user that does not exist. */
export function authEmailForPubkey(pubkey: string): string {
  return `${pubkey.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;
}

/** Phrase-derived password for the auth user. Same seed → same
 * password, forever: this is a login credential, not a vault key, but
 * it is pinned by the same KAT harness because drift here fails
 * SILENTLY - password sign-in returns invalid_credentials and the
 * client quietly falls back to minting anonymous users again, which is
 * exactly the rate-limited path this credential exists to retire. */
export function deriveAuthPassword(seed: Uint8Array): string {
  return bytesToHex(
    hkdf(sha256, seed, undefined, utf8.encode('privacynotes-auth-password-v1'), 32),
  );
}

export interface FpInput {
  /** Normalized OS label, e.g. "macOS", "Windows", "iPhone". */
  platform: string;
  /** WebGL renderer string, or "unknown" if unavailable. */
  gpu: string;
  /** navigator.hardwareConcurrency, or 0 if unavailable. */
  cores: number;
  /** navigator.language, or "unknown". */
  language: string;
}

export interface FpHashes {
  platform_hash: string;
  /** null when GPU is unavailable, so the server can pick the degraded threshold. */
  gpu_hash: string | null;
  cores_hash: string;
  language_hash: string;
}

function hmacFp(pepper: Uint8Array, prefix: string, value: string): string {
  const input = utf8.encode(`${prefix}:${value}`);
  return bytesToBase64(hmac(sha256, pepper, input));
}

/** Compute per-field fingerprint hashes. Field prefixes prevent cross-field collisions. */
export function computeFpHashes(pepper: Uint8Array, fp: FpInput): FpHashes {
  const gpuAvailable = !!fp.gpu && fp.gpu !== 'unknown';
  return {
    platform_hash: hmacFp(pepper, 'platform', fp.platform),
    gpu_hash: gpuAvailable ? hmacFp(pepper, 'gpu', fp.gpu) : null,
    cores_hash: hmacFp(pepper, 'cores', String(fp.cores)),
    language_hash: hmacFp(pepper, 'language', fp.language),
  };
}

// ------------------------------------------------------------------
// Hex helpers (pubkey is stored as hex text in Postgres)
// ------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length hex string');
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('hexToBytes: non-hex characters');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ------------------------------------------------------------------
// Base64 helpers - used at the Supabase boundary for ciphertext/nonce.
// ------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------
// Base64url helpers - URL-safe, no padding, no percent-encoding needed.
// Used for burn-after-reading links where URL length matters.
// ------------------------------------------------------------------

export function bytesToBase64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64urlToBytes(b64url: string): Uint8Array {
  // Restore standard base64: swap URL-safe chars, re-pad.
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  b64 += '='.repeat(pad);
  return base64ToBytes(b64);
}

/** Strict unpadded base64url, for a value from outside: only the one
 *  spelling bytesToBase64url writes decodes (no padding, no other alphabet,
 *  no set spare bits), so two texts never name the same bytes. Null for
 *  anything else, or for more than `maxChars` characters. */
export function base64urlToBytesStrict(text: unknown, maxChars: number): Uint8Array | null {
  if (typeof text !== 'string' || text.length > maxChars || text.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const bytes = base64urlToBytes(text);
  return bytesToBase64url(bytes) === text ? bytes : null;
}

// ------------------------------------------------------------------
// Symmetric encryption - xchacha20poly1305 with per-call random nonce.
// 24-byte nonces mean random nonces are safe forever (unlike AES-GCM).
// ------------------------------------------------------------------

/**
 * Encrypt the plaintext fields of a note. Returns an opaque blob the
 * server can store but can't read.
 *
 * `trashed`, `starred`, `locked`, and `pinProtected` are included
 * inside the ciphertext (not plaintext columns) so even per-note
 * metadata stays private to the user.
 *
 * `locked` and `pinProtected` were added later and are optional for
 * backward compatibility: older clients may omit them when writing,
 * and older ciphertexts may lack them when decrypted.
 */
export type EncryptedPayload = Pick<
  DecryptedNote,
  'title' | 'body' | 'tags' | 'trashed' | 'starred' | 'locked' | 'pinProtected' | 'type' | 'trackers' | 'folderId' | 'archived' | 'editedAt'
>;

/**
 * The bytes encryptNote seals: one JSON document. The ciphertext is these
 * bytes plus the 16-byte Poly1305 tag, so a caller can size a note's stored
 * row exactly without encrypting it.
 */
/** A decrypted payload: its fields, and the binding it carries
 *  (`undefined` when it carries none). Spec: docs/internal/plans/payload-row-binding.md (section 4) */
export type DecryptedPayload = EncryptedPayload & { bind: unknown };

export function notePlaintext(note: EncryptedPayload, bind: NoteBind): Uint8Array {
  return utf8.encode(
    JSON.stringify({
      title: note.title,
      body: note.body,
      tags: note.tags,
      trashed: note.trashed,
      starred: note.starred,
      locked: note.locked,
      pinProtected: note.pinProtected,
      type: note.type,
      ...(note.trackers ? { trackers: note.trackers } : {}),
      ...(note.folderId ? { folderId: note.folderId } : {}),
      // Stated whenever the writer knows it, so a reader can tell "not
      // archived" from a payload written by a client that predates Archive
      // and drops the field. A writer that does not know leaves it out.
      ...(note.archived === undefined ? {} : { archived: note.archived === true }),
      // Only when known, so a payload without it stays what it was.
      ...(note.editedAt ? { editedAt: note.editedAt } : {}),
      // The row this payload is written for. Required by the type, so every
      // writer names it; a caller outside the type check (an old writer in a
      // test) that passes none writes a payload as before the binding.
      // Spec: docs/internal/plans/payload-row-binding.md (section 2)
      ...(bind ? { bind: { id: bind.id.toLowerCase(), kind: bind.kind, ...(bind.at !== undefined ? { at: bind.at } : {}) } } : {}),
    })
  );
}

export function encryptNote(
  note: EncryptedPayload,
  key: Uint8Array,
  bind: NoteBind,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = notePlaintext(note, bind);
  const ciphertext = cipher.encrypt(plaintext);
  return { ciphertext, nonce };
}

/**
 * Inverse of encryptNote. Throws if the ciphertext or key is wrong
 * (Poly1305 authentication failure).
 *
 * Backward-compatible: ciphertexts written by older clients (before
 * v0.4.0) don't have `trashed`/`starred` fields, and ciphertexts
 * from before the Pro features shipped don't have
 * `locked`/`pinProtected`; we default all of them to `false`.
 */
export function decryptNote(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): DecryptedPayload {
  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  const parsed = JSON.parse(utf8Decoder.decode(plaintext)) as Partial<EncryptedPayload>;
  return {
    // Beside the fields, never one of them: checkNoteBind reads it.
    bind: readBind(parsed as Record<string, unknown>),
    title: parsed.title ?? '',
    body: parsed.body ?? '',
    tags: parsed.tags ?? [],
    trashed: parsed.trashed ?? false,
    starred: parsed.starred ?? false,
    locked: parsed.locked ?? false,
    pinProtected: parsed.pinProtected ?? false,
    type: parsed.type ?? 'note',
    trackers: (parsed as Record<string, unknown>).trackers as Record<string, unknown> | undefined,
    folderId: parsed.folderId ?? null,
    // Absent means the writer did not carry Archive at all: an older
    // client that rebuilt the payload without it. Callers decide what an
    // unknown value means for them (noteMerge.ts fieldsOfPayload).
    archived: typeof parsed.archived === 'boolean' ? parsed.archived : undefined,
    // Absent from every payload an older client wrote. The reader decides
    // what stands in for it (sync.ts processBatch); this never guesses.
    editedAt: isoInstant(parsed.editedAt),
  };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 instant, written back in the one form the app writes, so the
 *  lists can compare two of them as strings; anything else reads as absent,
 *  a year the written form cannot hold in four digits included. */
function isoInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const iso = new Date(at).toISOString();
  return ISO_INSTANT.test(iso) ? iso : undefined;
}

// ------------------------------------------------------------------
// Generic JSON blob encryption - used for anything that isn't a note
// but still needs to be end-to-end encrypted with the user's key.
// Current caller: synced user settings (favorite tags, etc).
//
// Uses the same xchacha20poly1305 primitive as notes so there is
// exactly one encryption path in the codebase.
// ------------------------------------------------------------------

export function encryptJson(
  value: unknown,
  key: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = utf8.encode(JSON.stringify(value));
  const ciphertext = cipher.encrypt(plaintext);
  return { ciphertext, nonce };
}

export function decryptJson<T = unknown>(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): T {
  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return JSON.parse(utf8Decoder.decode(plaintext)) as T;
}

// ------------------------------------------------------------------
// AAD variants - same primitive, with associated data bound into the
// authentication tag. Used by the local at-rest seal, where the AAD
// carries the table and row id so a ciphertext moved onto another row
// or table fails authentication instead of decrypting.
// Spec: docs/internal/specs/local-at-rest.md (seal format, section 3.2)
// ------------------------------------------------------------------

/** Encrypt raw bytes with associated data. Fresh 24-byte nonce per call. */
export function encryptBytesAad(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: string
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce, utf8.encode(aad));
  return { ciphertext: cipher.encrypt(plaintext), nonce };
}

/** Inverse of encryptBytesAad. Throws on a wrong key, tamper, or AAD mismatch. */
export function decryptBytesAad(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
  aad: string
): Uint8Array {
  const cipher = xchacha20poly1305(key, nonce, utf8.encode(aad));
  return cipher.decrypt(ciphertext);
}

/** JSON convenience over encryptBytesAad. */
export function encryptJsonAad(
  value: unknown,
  key: Uint8Array,
  aad: string
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  return encryptBytesAad(utf8.encode(JSON.stringify(value)), key, aad);
}

/** Inverse of encryptJsonAad. */
export function decryptJsonAad<T = unknown>(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
  aad: string
): T {
  return JSON.parse(
    utf8Decoder.decode(decryptBytesAad(ciphertext, nonce, key, aad))
  ) as T;
}
