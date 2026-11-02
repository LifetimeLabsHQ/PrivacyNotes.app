/**
 * The SSH key's stored body: the JSON blob an ssh-key note keeps, its parser
 * and its serializer. Split from SshKeyForm.tsx for the same reason as
 * cardBody.ts: a reader without a window.
 */
import { base64ToBytes, bytesToBase64 } from '@notes/shared';
import { storedVaultKeys } from './vaultBody';

/* ────────────────────────────────────────────────────────────────
 * SshKeyData - the JSON blob stored in the note body for ssh-key
 * type notes. The note's `title` field serves as the display name
 * (e.g. "user@host") and is auto-derived from the key comment.
 * ──────────────────────────────────────────────────────────────── */
export interface SshKeyData {
  label: string;
  privateKey: string;
  publicKey: string;
  passphrase: string;
  notes: string;
}

export function parseSshKeyBody(body: string): SshKeyData {
  try {
    const p = JSON.parse(body);
    return {
      label: typeof p.label === 'string' ? p.label : '',
      privateKey: typeof p.privateKey === 'string' ? p.privateKey : '',
      publicKey: typeof p.publicKey === 'string' ? p.publicKey : '',
      passphrase: typeof p.passphrase === 'string' ? p.passphrase : '',
      notes: typeof p.notes === 'string' ? p.notes : '',
    };
  } catch {
    return { label: '', privateKey: '', publicKey: '', passphrase: '', notes: '' };
  }
}

/** `previous` is the stored body; keys a newer version wrote in it are kept. */
export function serializeSshKeyBody(data: SshKeyData, previous = ''): string {
  return JSON.stringify({ ...storedVaultKeys(previous), ...data });
}

/** ED25519, RSA or ECDSA from the type token of a public key line; empty
 *  for any other type, or a line that is not a key. */
export function sshKeyType(publicKey: string): string {
  const type = publicKey.trim().split(/\s+/)[0] ?? '';
  if (type === 'ssh-ed25519') return 'ED25519';
  if (type === 'ssh-rsa') return 'RSA';
  if (type.startsWith('ecdsa-sha2-')) return 'ECDSA';
  return '';
}

/** `SHA256:<base64, no padding>` of the key blob of a public key line, as
 *  `ssh-keygen -lf` prints it. Empty when the blob does not decode or does
 *  not start with the line's own type, as ssh-keygen would refuse it. */
export async function sshKeyFingerprint(publicKey: string): Promise<string> {
  const [type, b64] = publicKey.trim().split(/\s+/);
  if (!type || !b64) return '';
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(b64);
  } catch {
    return '';
  }
  const name = new TextEncoder().encode(type);
  if (blob.length < 4 + name.length) return '';
  if (new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0) !== name.length) return '';
  if (!name.every((b, i) => blob[4 + i] === b)) return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', blob as Uint8Array<ArrayBuffer>));
  return `SHA256:${bytesToBase64(digest).replace(/=+$/, '')}`;
}
