/**
 * The seal on a delete (migration 0130).
 *
 * A tombstone needs only a session, so the server cannot tell a delete made
 * on one of the person's devices from one made with a stolen session. The
 * deleting device therefore seals each tombstone with the sync key: an
 * XChaCha20-Poly1305 tag over an empty message, with the account and the note
 * id as associated data. Only a holder of the key can make one, and a seal
 * moved onto another note or account fails. The server stores it beside the
 * marker and never checks it; every device checks it before it deletes its
 * own copy (settleTombstones in sync.ts).
 *
 * Form: base64 nonce (24 bytes), a dot, base64 tag (16 bytes). The server's
 * notes_delete_seal_shape constraint accepts that shape only.
 * Spec: docs/contrib/sync-protocol.md (section 3, sealed deletes)
 */
import { base64ToBytes, bytesToBase64, decryptBytesAad, encryptBytesAad } from '@notes/shared';
import { openWithRing } from './keyRing';

/** What a pulled tombstone's seal says. `none` is a delete from an app
 *  before 0130 or from a session without the key; the guard decides it. */
export type SealVerdict = 'valid' | 'bad' | 'none';

const EMPTY = new Uint8Array(0);
const SHAPE = /^[A-Za-z0-9+/]{32}\.[A-Za-z0-9+/]{22}==$/;

function aad(pubkey: string, id: string): string {
  return `privacynotes:tombstone:v1:${pubkey}:${id.toLowerCase()}`;
}

/** The seal this device puts on its delete of note `id`. */
export function sealTombstone(pubkey: string, id: string, key: Uint8Array): string {
  const { ciphertext, nonce } = encryptBytesAad(EMPTY, key, aad(pubkey, id));
  return `${bytesToBase64(nonce)}.${bytesToBase64(ciphertext)}`;
}

/**
 * Check a pulled seal with every key this device holds (the current one, then
 * the ring of an earlier phrase). A seal no key opens is bad: a device whose
 * session predates a phrase change hears that from the heartbeat and writes
 * nothing, so a held key is never missing for a real delete.
 */
export function checkTombstoneSeal(seal: unknown, pubkey: string, id: string, key: Uint8Array): SealVerdict {
  if (seal === null || seal === undefined || seal === '') return 'none';
  if (typeof seal !== 'string' || !SHAPE.test(seal)) return 'bad';
  const [nonce, tag] = seal.split('.') as [string, string];
  try {
    openWithRing('sync', key, (k) => decryptBytesAad(base64ToBytes(tag), base64ToBytes(nonce), k, aad(pubkey, id)));
    return 'valid';
  } catch {
    return 'bad';
  }
}
