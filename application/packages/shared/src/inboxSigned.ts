/**
 * The signed inbox row (wire byte 3): a seal that holds while either X25519
 * or ML-KEM-768 holds, with the sender's Ed25519 signature inside it.
 *
 * A legacy row (bytes 1 and 2, extension.ts) names no sender and is sealed
 * with X25519 alone. A connection that paired with a version 2 code holds a
 * seed of its own and the account's ML-KEM public key, and seals every row
 * here instead. Only the app's reader, the extension and the command line
 * import this module, the app with a dynamic import: ML-KEM stays off the
 * boot path.
 *
 * Every construction here is pinned by tools/crypto-kat.mjs.
 * Spec: docs/internal/plans/inbox-signed-hybrid.md (section 4)
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes as concat, randomBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { base64ToBytes, bytesToBase64, bytesToHex } from './crypto.js';
import { SIGNED_INBOX_VERSION, type InboxContext } from './extension.js';

const utf8 = new TextEncoder();

// ------------------------------------------------------------------
// The sender key of one connection
// ------------------------------------------------------------------

export const INBOX_SENDER_SEED_BYTES = 32;
const KEY_ID_BYTES = 16;
const SIGNATURE_BYTES = 64;

export interface InboxSender {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** Names the public key inside a row and in the app's settings; hex. */
  keyId: string;
}

/** The name of a sender public key: 16 bytes of a tagged hash, hex. */
export function inboxSenderId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('a sender public key is 32 bytes');
  return bytesToHex(sha256(concat(utf8.encode('privacynotes-inbox-sender-id-v1:'), publicKey)).subarray(0, KEY_ID_BYTES));
}

/** The Ed25519 pair of one connection, from the random seed its pairing
 *  code carried. Not a branch of the recovery seed, so the README table of
 *  derived keys (check:claims) does not list it. */
export function deriveInboxSender(connectionSeed: Uint8Array): InboxSender {
  if (connectionSeed.length !== INBOX_SENDER_SEED_BYTES) throw new Error('a sender seed is 32 bytes');
  const secretKey = hkdf(sha256, connectionSeed, undefined, utf8.encode('privacynotes-inbox-sender-key-v1'), 32);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, keyId: inboxSenderId(publicKey) };
}

// ------------------------------------------------------------------
// The ML-KEM-768 pair of one account epoch
// ------------------------------------------------------------------

export interface InboxKemKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export const INBOX_KEM_PUBLIC_BYTES = 1184;
const KEM_CT_BYTES = 1088;

/**
 * The account's ML-KEM-768 pair, the same on every app of one key epoch. From
 * the content key, never from the X25519 inbox secret: a quantum computer that
 * breaks X25519 learns that secret, and nothing about the content key. The key
 * ring holds the content key of each earlier epoch, so an earlier pair is
 * derived the same way.
 */
export function deriveInboxKemKeyPair(contentKey: Uint8Array): InboxKemKeyPair {
  if (contentKey.length !== 32) throw new Error('a content key is 32 bytes');
  const seed = hkdf(sha256, contentKey, undefined, utf8.encode('privacynotes-inbox-mlkem768-v1'), 64);
  const pair = ml_kem768.keygen(seed);
  seed.fill(0);
  return { secretKey: pair.secretKey, publicKey: pair.publicKey };
}

/** What a version 2 pairing code carries in place of the ML-KEM public key. */
export function inboxKemHash(kemPublic: Uint8Array): Uint8Array {
  if (kemPublic.length !== INBOX_KEM_PUBLIC_BYTES) throw new Error('an ML-KEM-768 public key is 1184 bytes');
  return sha256(concat(utf8.encode('privacynotes-inbox-kem-v1:'), kemPublic));
}

/**
 * The ML-KEM public key a server answered, as bytes, when it is the key the
 * pairing code names; null otherwise. The code is the only authority: a
 * server that answers another key, or none, connects nothing.
 */
export function checkedInboxKemPublic(answer: unknown, kemHash: Uint8Array): Uint8Array | null {
  if (typeof answer !== 'string' || !/^[A-Za-z0-9+/]{1579}=$/.test(answer)) return null;
  const kemPublic = base64ToBytes(answer);
  if (kemPublic.length !== INBOX_KEM_PUBLIC_BYTES) return null;
  const hash = inboxKemHash(kemPublic);
  let diff = hash.length ^ kemHash.length;
  for (let i = 0; i < hash.length; i++) diff |= (hash[i] as number) ^ (kemHash[i] ?? 0);
  return diff === 0 ? kemPublic : null;
}

// ------------------------------------------------------------------
// The row
// ------------------------------------------------------------------

const HEAD = 1 + 32 + KEM_CT_BYTES + 24;

/** What the key, the AAD and the signature of one row are bound to. */
function transcript(ctx: InboxContext, epk: Uint8Array, inboxPublic: Uint8Array, kemHash: Uint8Array, kemCt: Uint8Array): Uint8Array {
  const head = utf8.encode(`privacynotes-inbox-v${SIGNED_INBOX_VERSION}:${ctx.account}:${ctx.kind}:${ctx.id}:`);
  return sha256(concat(head, epk, inboxPublic, kemHash, kemCt));
}

function rowKey(sharedX: Uint8Array, sharedKem: Uint8Array, t: Uint8Array): Uint8Array {
  return hkdf(sha256, concat(sharedX, sharedKem), t, utf8.encode(`privacynotes-inbox-seal-v${SIGNED_INBOX_VERSION}`), 32);
}

const rowAad = (t: Uint8Array): Uint8Array => concat(utf8.encode(`privacynotes-inbox:v${SIGNED_INBOX_VERSION}:`), t);

const signedMessage = (t: Uint8Array, body: Uint8Array): Uint8Array =>
  concat(utf8.encode('privacynotes-inbox-sender-v1:'), t, sha256(body));

/** The reader's public keys, as a connection holds them. */
export interface InboxSealTarget {
  inboxPublic: Uint8Array;
  kemPublic: Uint8Array;
}

/** The one-time values of a seal. Only a known-answer test passes them. */
export interface InboxSealRandomness {
  esk: Uint8Array;
  kemRandomness: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Seal `body` (the plaintext a legacy row of this kind carries) to the
 * account, signed by this connection. The row is base64 of
 * 3 || epk(32) || ML-KEM ciphertext(1088) || nonce(24) || ciphertext, and the
 * plaintext is key id(16) || signature(64) || body.
 */
export function sealInboxSigned(
  body: Uint8Array,
  to: InboxSealTarget,
  sender: Pick<InboxSender, 'secretKey' | 'keyId'>,
  ctx: InboxContext,
  fixed?: InboxSealRandomness,
): string {
  const esk = fixed?.esk ?? randomBytes(32);
  const epk = x25519.getPublicKey(esk);
  const kem = ml_kem768.encapsulate(to.kemPublic, fixed?.kemRandomness);
  const t = transcript(ctx, epk, to.inboxPublic, inboxKemHash(to.kemPublic), kem.cipherText);
  const key = rowKey(x25519.getSharedSecret(esk, to.inboxPublic), kem.sharedSecret, t);
  const signature = ed25519.sign(signedMessage(t, body), sender.secretKey);
  const nonce = fixed?.nonce ?? randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, rowAad(t)).encrypt(concat(hexId(sender.keyId), signature, body));
  return bytesToBase64(concat(Uint8Array.of(SIGNED_INBOX_VERSION), epk, kem.cipherText, nonce, ct));
}

function hexId(keyId: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(keyId)) throw new Error('a sender key id is 32 hex characters');
  const out = new Uint8Array(KEY_ID_BYTES);
  for (let i = 0; i < KEY_ID_BYTES; i++) out[i] = parseInt(keyId.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The reader's secret keys of one epoch. */
export interface InboxOpenKeys {
  inboxSecret: Uint8Array;
  kem: InboxKemKeyPair;
}

/** An opened row whose sender is not checked yet. */
export interface OpenedSignedRow {
  /** The key id the row names. A claim until `bodyFrom` answers. */
  keyId: string;
  /** The body, when `senderPublic` signed this row; null otherwise. The body
   *  has no other way out, so no caller reads an unsigned one. */
  bodyFrom(senderPublic: Uint8Array): Uint8Array | null;
}

/**
 * Open a signed row. Throws on another version, a wrong key, a tamper or a
 * row that is not bound to `ctx`; the sender is then still to be checked.
 */
export function openInboxSigned(payload: string, keys: InboxOpenKeys, ctx: InboxContext): OpenedSignedRow {
  const raw = base64ToBytes(payload);
  if (raw.length < HEAD + KEY_ID_BYTES + SIGNATURE_BYTES + 16) throw new Error('inbox row too short');
  if (raw[0] !== SIGNED_INBOX_VERSION) throw new Error('inbox row version unknown');
  const epk = raw.subarray(1, 33);
  const kemCt = raw.subarray(33, 33 + KEM_CT_BYTES);
  const nonce = raw.subarray(33 + KEM_CT_BYTES, HEAD);
  const inboxPublic = x25519.getPublicKey(keys.inboxSecret);
  const t = transcript(ctx, epk, inboxPublic, inboxKemHash(keys.kem.publicKey), kemCt);
  const key = rowKey(x25519.getSharedSecret(keys.inboxSecret, epk), ml_kem768.decapsulate(kemCt, keys.kem.secretKey), t);
  const plain = xchacha20poly1305(key, nonce, rowAad(t)).decrypt(raw.subarray(HEAD));
  const keyId = bytesToHex(plain.subarray(0, KEY_ID_BYTES));
  const signature = plain.slice(KEY_ID_BYTES, KEY_ID_BYTES + SIGNATURE_BYTES);
  const body = plain.subarray(KEY_ID_BYTES + SIGNATURE_BYTES);
  return {
    keyId,
    bodyFrom(senderPublic) {
      try {
        if (inboxSenderId(senderPublic) !== keyId) return null;
        // The strict check of RFC 8032, not the ZIP-215 one: one signature, one reading.
        return ed25519.verify(signature, signedMessage(t, body), senderPublic, { zip215: false }) ? body : null;
      } catch {
        return null;
      }
    },
  };
}
