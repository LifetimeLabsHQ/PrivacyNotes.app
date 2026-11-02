/**
 * The extension's connection to an account, kept in the browser's extension
 * storage: the token it made at pairing, the account's inbox public key and,
 * with logins on, the browser's half of the logins key and the salt of its
 * PIN or passcode proof. Nothing here opens a note, a clip or a login on its
 * own: the inbox key only seals, and Kext needs the server's half.
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.2 and 5)
 */
import { browser } from 'wxt/browser';
import { bytesToBase64, bytesToHex } from '@notes/shared';
import { decodePairingCode, deriveUnlockProof, hashHex, unlockChecker, UNLOCK_SALT_BYTES } from '@notes/shared/extension';
import { call } from './api';
import { clearIfStill } from './clipboard';

export type SecretKind = 'pin' | 'passcode';

export interface Connection {
  v: 1;
  /** The bearer token, hex; the server keeps only its hash. */
  token: string;
  tokenId: string;
  /** The account's signing public key, hex: bound into every sealed row. */
  account: string;
  inboxPublic: string;
  clips: boolean;
  logins: boolean;
  kext: string | null;
  salt: string | null;
  secretKind: SecretKind | null;
}

const KEY = 'connection';

export async function readConnection(): Promise<Connection | null> {
  const got = (await browser.storage.local.get(KEY))[KEY] as Connection | undefined;
  return got && got.v === 1 ? got : null;
}

/** Forget everything this browser holds for the account. A password copied
 *  in the last 30 seconds is cleared first, while its marker still exists. */
export async function forgetLocal(): Promise<void> {
  await clearIfStill().catch(() => undefined);
  await browser.storage.local.clear();
  await browser.storage.session.clear().catch(() => undefined);
}

/** "Chrome on macOS": the name the device list shows. */
function browserLabel(): string {
  const ua = navigator.userAgent;
  const data = (navigator as { userAgentData?: { brands?: { brand: string }[]; platform?: string } }).userAgentData;
  const brands = data?.brands?.map((b) => b.brand) ?? [];
  const name = /Firefox\//.test(ua)
    ? 'Firefox'
    : brands.includes('Microsoft Edge') || /Edg\//.test(ua)
      ? 'Edge'
      : brands.includes('Brave')
        ? 'Brave'
        : 'Chrome';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${name} on ${os}` : name;
}

export type PasteResult = { kind: 'bad' } | { kind: 'needsSecret' } | { kind: 'ready' };

/** Whether a pasted code is whole, and whether it asks for a PIN. */
export function readCode(text: string): PasteResult {
  const code = decodePairingCode(text);
  if (!code) return { kind: 'bad' };
  return code.kext ? { kind: 'needsSecret' } : { kind: 'ready' };
}

export type RedeemResult =
  /** `proof` with logins, for a fingerprint set up right after. */
  | { ok: true; connection: Connection; proof: Uint8Array | null }
  | { ok: false; reason: 'bad' | 'used' | 'offline' | 'full' | 'failed' };

/**
 * Redeem the code: a fresh token, and with logins the checker of the PIN or
 * passcode, sent once. The server deletes the code in the same statement.
 */
export async function redeem(text: string, secret?: { value: string; kind: SecretKind }): Promise<RedeemResult> {
  const code = decodePairingCode(text);
  if (!code) return { ok: false, reason: 'bad' };
  if (code.kext && !secret) return { ok: false, reason: 'bad' };
  const token = crypto.getRandomValues(new Uint8Array(32));
  let salt: Uint8Array | null = null;
  let checker: string | undefined;
  let proof: Uint8Array | null = null;
  if (code.kext && secret) {
    salt = crypto.getRandomValues(new Uint8Array(UNLOCK_SALT_BYTES));
    proof = deriveUnlockProof(secret.value, salt);
    checker = unlockChecker(proof);
  }
  const answer = await call<{ account: string; id: string; clips: boolean; logins: boolean }>('extension-pair', {
    action: 'redeem',
    secret: bytesToHex(code.secret),
    tokenHash: hashHex(token),
    label: browserLabel(),
    version: browser.runtime.getManifest().version,
    ...(checker ? { checker } : {}),
  });
  if (!answer.ok) {
    if (answer.status === 0) return { ok: false, reason: 'offline' };
    if (answer.error === 'invalid_code') return { ok: false, reason: 'used' };
    if (answer.error === 'too_many_extensions') return { ok: false, reason: 'full' };
    return { ok: false, reason: 'failed' };
  }
  const { account, id, clips, logins } = answer.body;
  if (typeof account !== 'string' || !/^[0-9a-f]{64}$/.test(account) || typeof id !== 'string') return { ok: false, reason: 'failed' };
  const connection: Connection = {
    v: 1,
    token: bytesToHex(token),
    tokenId: id,
    account,
    inboxPublic: bytesToBase64(code.inboxPublic),
    clips: clips === true,
    logins: logins === true && !!code.kext,
    kext: code.kext ? bytesToBase64(code.kext) : null,
    salt: salt ? bytesToBase64(salt) : null,
    secretKind: secret?.kind ?? null,
  };
  await browser.storage.local.set({ [KEY]: connection });
  return { ok: true, connection, proof };
}

/** Disconnect: the server forgets the token, this browser forgets all. A
 *  disconnect that cannot reach the server still forgets here. */
export async function disconnect(connection: Connection): Promise<void> {
  await call('extension-pair', { action: 'forget', token: connection.token }).catch(() => undefined);
  await forgetLocal();
}
