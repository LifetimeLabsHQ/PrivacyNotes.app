/**
 * The vault's engine. The copy waits in extension storage as the apps
 * sealed it, under the key P. P exists only after an unlock: the server
 * checks the proof of the extension's own PIN or passcode, counts a wrong
 * one (the tenth disconnects this browser), and returns its half Ksrv;
 * P = Kext xor Ksrv then lives in session storage, which trusted extension
 * pages alone can read and the browser forgets when it closes. The chosen
 * idle time locks it again.
 *
 * An unlock returns as soon as the server says yes: the rows of the last
 * session show at once, and the delta pull runs behind them.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4)
 */
import { browser } from 'wxt/browser';
import { base64ToBytes, bytesToBase64, bytesToHex, decryptJsonAad } from '@notes/shared';
import { joinLoginsKey, loginsCopyAad, parseCopyEntry, type CopyEntry } from '@notes/shared/extension';
import { call, type Answer } from './api';
import { APP_URL } from './config';
import { forgetLocal, readConnection } from './connection';
import { copySecret } from './clipboard';
import { loginsOf, matchLogins } from './match';
import { readPrefs } from './prefs';
import { deriveProof } from './proof';

interface PullBody {
  ksrv: string;
  key_tag: string;
  pro: boolean;
  more: boolean;
  rows: { id: string; ciphertext: string; nonce: string; deleted: boolean; changed_at: string }[];
}

export const LOCK_ALARM = 'lock-logins';
/** Point the browser's idle detection at the chosen lock time. A choice
 *  that is not a time keeps the longest interval, since only the computer's
 *  lock (or nothing) ends it. */
export async function applyLockTime(): Promise<void> {
  const { lockAfter } = await readPrefs();
  await browser.idle.setDetectionInterval(typeof lockAfter === 'number' ? lockAfter : 14400);
}

/** Whether a change of the computer's idle state ends the unlocked session. */
export async function locksOn(state: 'active' | 'idle' | 'locked'): Promise<boolean> {
  const { lockAfter } = await readPrefs();
  if (state === 'locked') return lockAfter !== 'restart';
  return state === 'idle' && typeof lockAfter === 'number';
}

/** The session storage key that says the vault is open; the popup and the
 *  menus listen for it. */
export const SESSION_KEY = 'unlocked';
const PRO_HINT_KEY = 'proHint';
/** The local storage key of the sealed rows; the list listens for it. */
export const ROWS_KEY = 'loginRows';

/** Whether the account was Pro at the last unlock. */
export async function proHint(): Promise<boolean> {
  return (await browser.storage.local.get(PRO_HINT_KEY))[PRO_HINT_KEY] === true;
}

interface Unlocked {
  p: string;
  tag: string;
  ticket: string;
  pro: boolean;
}

interface StoredRows {
  tag: string;
  cursor: { at: string; id: string } | null;
  rows: Record<string, { ciphertext: string; nonce: string }>;
}

async function session(): Promise<Unlocked | null> {
  return ((await browser.storage.session.get(SESSION_KEY))[SESSION_KEY] as Unlocked | undefined) ?? null;
}

export async function isUnlocked(): Promise<boolean> {
  return (await session()) !== null;
}

export async function lockLogins(): Promise<void> {
  // A fingerprint set-up that never finished leaves nothing behind either.
  await browser.storage.session.remove([SESSION_KEY, 'enrollProof']);
}

export type UnlockResult =
  | { kind: 'ok' }
  | { kind: 'wrong'; left: number }
  | { kind: 'disconnected' }
  | { kind: 'offline' }
  | { kind: 'off' }
  | { kind: 'failed' };

/** Unlock with the PIN or passcode, or with a proof a fingerprint unwrapped.
 *  Returns once the key is in session storage; the pull follows on its own. */
export async function unlock(input: { secret: string } | { proof: Uint8Array }): Promise<UnlockResult> {
  const connection = await readConnection();
  if (!connection?.logins || !connection.kext || !connection.salt) return { kind: 'off' };
  const proof = 'proof' in input ? input.proof : await deriveProof(input.secret, base64ToBytes(connection.salt));
  const ticket = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const answer = await call<{ ksrv: string; key_tag: string; pro: boolean }>('extension-logins', {
    action: 'unlock', token: connection.token, ticket, proof: bytesToHex(proof),
  });
  if (!answer.ok) {
    if (answer.status === 0) return { kind: 'offline' };
    if (answer.error === 'wrong') return { kind: 'wrong', left: Number(answer.body.left) || 0 };
    if (answer.error === 'disconnected' || answer.error === 'not_connected') {
      await forgetLocal();
      return { kind: 'disconnected' };
    }
    return { kind: 'failed' };
  }
  const p = joinLoginsKey(base64ToBytes(connection.kext), base64ToBytes(answer.body.ksrv));
  await browser.storage.session.set({ [SESSION_KEY]: { p: bytesToBase64(p), tag: answer.body.key_tag, ticket, pro: answer.body.pro === true } });
  // Not a secret: only whether the generator offers the passphrase while locked.
  await browser.storage.local.set({ [PRO_HINT_KEY]: answer.body.pro === true });
  await applyLockTime();
  void pull();
  return { kind: 'ok' };
}

async function readRows(): Promise<StoredRows | null> {
  return ((await browser.storage.local.get(ROWS_KEY))[ROWS_KEY] as StoredRows | undefined) ?? null;
}

export type PullResult = 'ok' | 'locked' | 'offline' | 'disconnected';

let pulling: Promise<PullResult> | null = null;

/** A delta pull of the copy, a page at a time from a minute before the last
 *  cursor, so a row committed late is not skipped. One at a time: a second
 *  caller joins the pull in flight. */
export function pull(): Promise<PullResult> {
  if (!pulling) pulling = pullNow().finally(() => (pulling = null));
  return pulling;
}

/** Whether a pull runs now, for the popup's status line. */
export function pullInFlight(): boolean {
  return pulling !== null;
}

async function pullNow(): Promise<PullResult> {
  const connection = await readConnection();
  let state = await session();
  if (!connection || !state) return 'locked';
  let stored = await readRows();
  if (!stored || stored.tag !== state.tag) stored = { tag: state.tag, cursor: null, rows: {} };
  let after: { at: string; id: string | null } | null = stored.cursor
    ? { at: new Date(Date.parse(stored.cursor.at) - 60_000).toISOString(), id: null }
    : null;
  for (let page = 0; page < 20; page++) {
    const answer: Answer<PullBody> = await call<PullBody>(
      'extension-logins', { action: 'pull', token: connection.token, ticket: state.ticket, after },
    );
    if (!answer.ok) {
      if (answer.status === 0) return 'offline';
      if (answer.error === 'not_connected' || answer.error === 'disconnected') {
        await forgetLocal();
        return 'disconnected';
      }
      // The ticket ended (8 hours, or the key changed): unlock again.
      await lockLogins();
      return 'locked';
    }
    const body: PullBody = answer.body;
    // A lock while the request was out wins: nothing is written back.
    if (!(await session())) return 'locked';
    if (body.key_tag !== stored.tag) {
      // The apps moved to a new key: its half came with the answer.
      state = { ...state, tag: body.key_tag, p: bytesToBase64(joinLoginsKey(base64ToBytes(connection.kext!), base64ToBytes(body.ksrv))) };
      await browser.storage.session.set({ [SESSION_KEY]: state });
      stored = { tag: body.key_tag, cursor: null, rows: {} };
      after = null;
      continue;
    }
    for (const row of body.rows) {
      if (row.deleted) delete stored.rows[row.id];
      else stored.rows[row.id] = { ciphertext: row.ciphertext, nonce: row.nonce };
      stored.cursor = { at: row.changed_at, id: row.id };
    }
    if (state.pro !== body.pro) {
      state = { ...state, pro: body.pro === true };
      await browser.storage.session.set({ [SESSION_KEY]: state });
    }
    await browser.storage.local.set({ [ROWS_KEY]: stored });
    if (!body.more) return 'ok';
    const last = body.rows[body.rows.length - 1]!;
    after = { at: last.changed_at, id: last.id };
  }
  return 'ok';
}

/** Every entry the copy holds, opened with P and checked for shape. A row
 *  that does not open or is not a kind this build knows is left out, never
 *  shown half. */
export async function allEntries(): Promise<{ entries: CopyEntry[]; pro: boolean } | null> {
  const [connection, state, stored] = await Promise.all([readConnection(), session(), readRows()]);
  if (!connection || !state || !stored || stored.tag !== state.tag) return state ? { entries: [], pro: state.pro } : null;
  const p = base64ToBytes(state.p);
  const entries: CopyEntry[] = [];
  for (const [id, row] of Object.entries(stored.rows)) {
    try {
      const entry = parseCopyEntry(decryptJsonAad<unknown>(base64ToBytes(row.ciphertext), base64ToBytes(row.nonce), p, loginsCopyAad(connection.account, id)));
      if (entry) entries.push(entry);
    } catch {
      // Not under this key: a row the next pull replaces.
    }
  }
  return { entries, pro: state.pro };
}

/** The app, open on one item: the app's note shortcut. The id rides in the
 *  fragment, which the browser never sends to a server. */
export function shortcutUrl(item: string): string {
  return `${APP_URL}/note#${item}`;
}

// ── The shortcut ────────────────────────────────────────────────────

const SHORTCUT_KEY = 'shortcutStep';

/** Alt+Shift+L: the first press copies the username, the second, within 30
 *  seconds on the same page, the password. With two or more matches it opens
 *  the popup instead of guessing. */
export async function copyLoginShortcut(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab?.url;
  const found = url && (await isUnlocked()) ? await allEntries() : null;
  const matches = found && url ? matchLogins(loginsOf(found.entries), url) : [];
  if (matches.length !== 1) {
    await browser.action.openPopup?.().catch(() => undefined);
    return;
  }
  const login = matches[0]!;
  const prev = (await browser.storage.session.get(SHORTCUT_KEY))[SHORTCUT_KEY] as { item: string; at: number } | undefined;
  const second = prev && prev.item === login.item && Date.now() - prev.at < 30_000;
  await copySecret(second ? login.password : login.username);
  await browser.storage.session.set({ [SHORTCUT_KEY]: second ? null : { item: login.item, at: Date.now() } });
}
