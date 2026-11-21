/**
 * The extension's connection to an account, kept in the browser's extension
 * storage: the token it made at pairing, the account's inbox public key and,
 * with logins on, the browser's half of the logins key and the salt of its
 * PIN or passcode proof. Nothing here opens a note, a clip or a login on its
 * own: the inbox key only seals, and Kext needs the server's half. A
 * connection made with a version 2 code also holds its own sender seed and
 * the account's ML-KEM public key, and seals every row signed (`sealRow`).
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.2 and 5);
 * docs/internal/plans/inbox-signed-hybrid.md (section 5.3)
 */
import { browser } from 'wxt/browser';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '@notes/shared';
import { decodePairingCode, deriveUnlockProof, hashHex, sealInbox, unlockChecker, UNLOCK_SALT_BYTES, type InboxKind } from '@notes/shared/extension';
import { checkedInboxKemPublic, deriveInboxSender, sealInboxSigned } from '@notes/shared/inbox-signed';
import { call } from './api';
import { clearIfStill } from './clipboard';

export type SecretKind = 'pin' | 'passcode';

export interface Connection {
  /** 2 for a connection made with a version 2 code (it holds `signSeed` and
   *  `kemPublic`): an older build then reads no connection at all, instead of
   *  one it would rewrite without the seed (spec review H4). */
  v: 1 | 2;
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
  /** A new PIN or passcode sent with no answer back yet: its salt and kind,
   *  stored before the call (changeSecret.ts), since the server may hold its
   *  checker while this browser never heard (beta #184, item 4). */
  pendingSalt?: string;
  pendingKind?: SecretKind;
  /** A fresh browser half made after the apps changed the logins key, kept
   *  before it is sent sealed to the apps; it becomes `kext` once the server
   *  half for it arrives, named by `half_id` (beta #205 item 1). */
  kextNext?: string;
  /** A version 2 code's sender seed and the account's checked ML-KEM public
   *  key, base64. With them every row is signed; absent for a version 1 code. */
  signSeed?: string;
  kemPublic?: string;
}

/** One sealed inbox row of this connection: signed when it was made with a
 *  version 2 code, else the version 1 seal (bytes 1 and 2) as before. */
export function sealRow(connection: Connection, kind: InboxKind, id: string, plain: Uint8Array): string {
  const ctx = { account: connection.account, id, kind };
  if (connection.signSeed && connection.kemPublic) {
    const to = { inboxPublic: base64ToBytes(connection.inboxPublic), kemPublic: base64ToBytes(connection.kemPublic) };
    return sealInboxSigned(plain, to, deriveInboxSender(base64ToBytes(connection.signSeed)), ctx);
  }
  return sealInbox(plain, base64ToBytes(connection.inboxPublic), ctx);
}

const KEY = 'connection';

export async function readConnection(): Promise<Connection | null> {
  const got = (await browser.storage.local.get(KEY))[KEY] as Connection | undefined;
  if (!got) return null;
  if (got.v === 1 && !got.signSeed && !got.kemPublic) return got;
  return got.v === 2 && got.signSeed && got.kemPublic ? got : null;
}

/** Store the connection; a new PIN or passcode changes its salt and kind. */
export async function saveConnection(connection: Connection): Promise<void> {
  await browser.storage.local.set({ [KEY]: connection });
}

/** Settle a pending new PIN or passcode: `held`, the server holds its
 *  checker, so its salt and kind become the connection's; otherwise it goes. */
export async function settlePending(connection: Connection, held: boolean): Promise<Connection> {
  const { pendingSalt, pendingKind, ...rest } = connection;
  const settled: Connection = held && pendingSalt ? { ...rest, salt: pendingSalt, secretKind: pendingKind ?? rest.secretKind } : rest;
  await saveConnection(settled);
  return settled;
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
  | { ok: false; reason: 'bad' | 'used' | 'offline' | 'full' | 'notPro' | 'failed' };

/** The token and salt of a redeem whose answer may have been lost, by the
 *  hash of its code: session storage, gone with the browser. */
const ATTEMPT_KEY = 'pairAttempt';
interface Attempt {
  code: string;
  token: string;
  salt: string;
}

async function readAttempt(code: string): Promise<{ token: Uint8Array; salt: Uint8Array } | null> {
  const got = (await browser.storage.session.get(ATTEMPT_KEY))[ATTEMPT_KEY] as Attempt | undefined;
  if (!got || got.code !== code || !/^[0-9a-f]{64}$/.test(got.token)) return null;
  try {
    return { token: hexToBytes(got.token), salt: base64ToBytes(got.salt) };
  } catch {
    return null;
  }
}

/**
 * Redeem the code: a fresh token, and with logins the checker of the PIN or
 * passcode, sent once. The server deletes the code in the same statement.
 * A try again with the same code sends the same token and salt, so the same
 * PIN gives the same checker: the server answers that repeat as it did the
 * first time, where a fresh token would find the code used (beta #184, item 6).
 */
export async function redeem(text: string, secret?: { value: string; kind: SecretKind }): Promise<RedeemResult> {
  const code = decodePairingCode(text);
  if (!code) return { ok: false, reason: 'bad' };
  if (code.kext && !secret) return { ok: false, reason: 'bad' };
  const codeHash = hashHex(code.secret);
  const before = await readAttempt(codeHash);
  const token = before?.token ?? crypto.getRandomValues(new Uint8Array(32));
  const saltFor = before?.salt.length === UNLOCK_SALT_BYTES ? before.salt : crypto.getRandomValues(new Uint8Array(UNLOCK_SALT_BYTES));
  await browser.storage.session.set({ [ATTEMPT_KEY]: { code: codeHash, token: bytesToHex(token), salt: bytesToBase64(saltFor) } satisfies Attempt });
  let salt: Uint8Array | null = null;
  let checker: string | undefined;
  let proof: Uint8Array | null = null;
  if (code.kext && secret) {
    salt = saltFor;
    proof = deriveUnlockProof(secret.value, salt);
    checker = unlockChecker(proof);
  }
  const answer = await call<{ account: string; id: string; clips: boolean; logins: boolean }>('extension-pair', {
    action: 'redeem',
    secret: bytesToHex(code.secret),
    tokenHash: hashHex(token),
    label: browserLabel(),
    version: browser.runtime.getManifest().version,
    // Named, so the server refuses a command line's code here; a redeem that
    // names none is refused once the release floor passes this build (beta
    // #202 item 4).
    client: 'browser',
    ...(checker ? { checker } : {}),
    ...(code.signed ? { kem: true } : {}),
  });
  if (!answer.ok) {
    if (answer.status === 0) return { ok: false, reason: 'offline' };
    if (answer.error === 'invalid_code') {
      // A used code never connects: its token goes.
      await browser.storage.session.remove(ATTEMPT_KEY);
      return { ok: false, reason: 'used' };
    }
    if (answer.error === 'too_many_extensions') return { ok: false, reason: 'full' };
    // A free account's second browser; the code stays usable (migration 0117).
    if (answer.error === 'not_pro') return { ok: false, reason: 'notPro' };
    return { ok: false, reason: 'failed' };
  }
  const { account, id, clips, logins } = answer.body;
  if (typeof account !== 'string' || !/^[0-9a-f]{64}$/.test(account) || typeof id !== 'string') return { ok: false, reason: 'failed' };
  // A version 2 code connects only with the ML-KEM key its hash names, never
  // as a connection that seals unsigned rows (inbox-signed-hybrid.md 5.5).
  const kemPublic = code.signed ? checkedInboxKemPublic((answer.body as { kem?: unknown }).kem, code.signed.kemHash) : null;
  if (code.signed && !kemPublic) return { ok: false, reason: 'failed' };
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
    ...(code.signed && kemPublic ? { v: 2 as const, signSeed: bytesToBase64(code.signed.seed), kemPublic: bytesToBase64(kemPublic) } : {}),
  };
  await saveConnection(connection);
  await browser.storage.session.remove(ATTEMPT_KEY);
  return { ok: true, connection, proof };
}

/** Disconnect: the server forgets the token, this browser forgets all. A
 *  disconnect that cannot reach the server still forgets here. */
export async function disconnect(connection: Connection): Promise<void> {
  await call('extension-pair', { action: 'forget', token: connection.token }).catch(() => undefined);
  await forgetLocal();
}
