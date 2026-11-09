/**
 * A new PIN or passcode for this browser, while the vault is open. The server
 * checks the proof of the current secret against the same 10 tries as an
 * unlock, then stores the checker of the new one; this browser keeps the new
 * salt. Ksrv and P stay as they are. A fingerprint or face set-up wraps the
 * old proof, so it is forgotten here; the caller offers to set it up again
 * with the new proof.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, step 2)
 */
import { browser } from 'wxt/browser';
import { base64ToBytes, bytesToBase64, bytesToHex } from '@notes/shared';
import { unlockChecker, UNLOCK_SALT_BYTES } from '@notes/shared/extension';
import { call } from './api';
import { forgetBiometric } from './biometric';
import { forgetLocal, readConnection, saveConnection, type Connection, type SecretKind } from './connection';
import { lockLogins, SESSION_KEY } from './logins';
import { deriveProof } from './proof';

export type ChangeResult =
  /** `proof` of the new secret, for a fingerprint set up again. */
  | { kind: 'ok'; connection: Connection; proof: Uint8Array }
  | { kind: 'wrong'; left: number }
  | { kind: 'locked' }
  | { kind: 'disconnected' }
  | { kind: 'offline' }
  | { kind: 'failed' };

export async function changeSecret(current: string, next: { value: string; kind: SecretKind }): Promise<ChangeResult> {
  const connection = await readConnection();
  const open = (await browser.storage.session.get(SESSION_KEY))[SESSION_KEY] as { ticket?: string } | undefined;
  if (!connection?.logins || !connection.salt) return { kind: 'failed' };
  if (!open?.ticket) return { kind: 'locked' };
  const salt = crypto.getRandomValues(new Uint8Array(UNLOCK_SALT_BYTES));
  const proof = await deriveProof(current, base64ToBytes(connection.salt));
  const newProof = await deriveProof(next.value, salt);
  const answer = await call('extension-logins', {
    action: 'change_secret', token: connection.token, ticket: open.ticket,
    proof: bytesToHex(proof), checker: unlockChecker(newProof),
  });
  if (!answer.ok) {
    if (answer.status === 0) return { kind: 'offline' };
    if (answer.error === 'wrong') return { kind: 'wrong', left: Number(answer.body.left) || 0 };
    if (answer.error === 'locked') {
      await lockLogins();
      return { kind: 'locked' };
    }
    if (answer.error === 'disconnected' || answer.error === 'not_connected') {
      await forgetLocal();
      return { kind: 'disconnected' };
    }
    return { kind: 'failed' };
  }
  const changed: Connection = { ...connection, salt: bytesToBase64(salt), secretKind: next.kind };
  await saveConnection(changed);
  await forgetBiometric();
  return { kind: 'ok', connection: changed, proof: newProof };
}
