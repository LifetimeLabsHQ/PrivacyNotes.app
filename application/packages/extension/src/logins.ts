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
import { browserHalfId, joinLoginsKey, loginsCopyAad, padInboxJson, parseCopyEntry, type CopyEntry, type InboxKeyHalf } from '@notes/shared/extension';
import { call, type Answer } from './api';
import { APP_URL } from './config';
import { forgetLocal, readConnection, saveConnection, sealRow, settlePending, type Connection } from './connection';
import { forgetBiometric } from './biometric';
import { copySecret } from './clipboard';
import { loginsOf, matchLogins } from './match';
import { readPrefs } from './prefs';
import { deriveProof } from './proof';
import { activeTab } from './tabs';
import { notSavedEdits, overlayPending, readPending, rekeyPending, writePending, type NotSavedEdit } from './pending';
import { PASSKEY_COUNT_KEY } from './passkeyDoor';
import { passkeysReleased } from './passkeyRelease';
import { enqueue, flush, queuedIds } from './queue';

interface PullBody {
  ksrv: string;
  key_tag: string;
  /** The account's tag (migration 0156): another one than `key_tag` while
   *  this browser has no server half for the apps' new key yet. */
  account_tag?: string | null;
  /** The name of the browser half `ksrv` is for; null for the code's half. */
  half_id?: string | null;
  pro: boolean;
  more: boolean;
  rows: { id: string; ciphertext: string; nonce: string; deleted: boolean; changed_at: string }[];
}

/** While unlocked, a pull every 20 minutes keeps the server's ticket alive:
 *  the server ends a ticket after 24 hours with no request (and 7 days in
 *  all, migration 0112), so the lock time the person chose decides, and a
 *  night of sleep does not lock the vault. */
export const KEEP_ALARM = 'keep-ticket';
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
  /** `at`: the server's `changed_at` of the row, kept since the pending
   *  store needs it (passkeys.md section 6); a row pulled before has none. */
  rows: Record<string, { ciphertext: string; nonce: string; at?: string }>;
  /** When the last pull ended, on the server's clock (its `Date`). */
  syncedAt?: number;
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
  await browser.alarms.clear(KEEP_ALARM);
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
  const ask = async (proof: Uint8Array) => {
    const ticket = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const answer = await call<{ ksrv: string; key_tag: string; pro: boolean; account_tag?: string | null; half_id?: string | null }>('extension-logins', {
      action: 'unlock', token: connection.token, ticket, proof: bytesToHex(proof),
    });
    return { ticket, answer };
  };
  let { ticket, answer } = await ask('proof' in input ? input.proof : await deriveProof(input.secret, base64ToBytes(connection.salt)));
  if (connection.pendingSalt) {
    if (answer.ok) {
      // The current salt still unlocks: the change never reached the server.
      await settlePending(connection, false);
    } else if (answer.error === 'wrong' && 'secret' in input) {
      // A change of PIN whose answer was lost (changeSecret.ts): the server
      // may hold the new checker. One more try with the pending salt; when
      // the PIN was simply wrong, it costs a second of the server's 10 tries.
      ({ ticket, answer } = await ask(await deriveProof(input.secret, base64ToBytes(connection.pendingSalt))));
      if (answer.ok) {
        await settlePending(connection, true);
        // A fingerprint set-up wraps the old proof.
        await forgetBiometric();
      }
    }
  }
  if (!answer.ok) {
    if (answer.status === 0) return { kind: 'offline' };
    if (answer.error === 'wrong') return { kind: 'wrong', left: Number(answer.body.left) || 0 };
    if (answer.error === 'disconnected' || answer.error === 'not_connected') {
      await forgetLocal();
      return { kind: 'disconnected' };
    }
    return { kind: 'failed' };
  }
  // Read again: a settled PIN change above saved the connection.
  const kext = await halfFor((await readConnection()) ?? connection, answer.body.half_id);
  const p = joinLoginsKey(kext, base64ToBytes(answer.body.ksrv));
  await browser.storage.session.set({ [SESSION_KEY]: { p: bytesToBase64(p), tag: answer.body.key_tag, ticket, pro: answer.body.pro === true } });
  if (needsFreshHalf(answer.body)) await sendFreshHalf().catch(() => undefined);
  // Not a secret: only whether the generator offers the passphrase while locked.
  await browser.storage.local.set({ [PRO_HINT_KEY]: answer.body.pro === true });
  await applyLockTime();
  browser.alarms.create(KEEP_ALARM, { periodInMinutes: 20 });
  void pull();
  return { kind: 'ok' };
}

/**
 * The browser half the server's half belongs to. The server names a fresh
 * half by `half_id`; when it names the one this browser sent, that half
 * becomes the browser's own. Otherwise the half it holds: the code's, or a
 * fresh one taken before.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4 step 7)
 */
async function halfFor(connection: Connection, halfId: string | null | undefined): Promise<Uint8Array> {
  if (halfId && connection.kextNext && browserHalfId(base64ToBytes(connection.kextNext)) === halfId) {
    const { kextNext, ...rest } = connection;
    await saveConnection({ ...rest, kext: kextNext });
    return base64ToBytes(kextNext);
  }
  return base64ToBytes(connection.kext!);
}

/** The apps moved to a new logins key and this browser has no half for it. */
function needsFreshHalf(body: { key_tag: string; account_tag?: string | null }): boolean {
  return typeof body.account_tag === 'string' && body.account_tag !== body.key_tag;
}

/**
 * A browser removed elsewhere made the apps change the logins key. They give
 * this browser no server half under its old half, since the server's halves
 * from before and after would then give the new key to whoever kept the
 * removed browser's key. So this browser makes a fresh half once, keeps it
 * before anything is sent, and sends it sealed to the apps' inbox key (kind
 * `keyhalf`) at each unlock until an app has written its server half. The
 * vault shows nothing meanwhile.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4 step 7)
 */
async function sendFreshHalf(): Promise<void> {
  let connection = await readConnection();
  if (!connection?.logins) return;
  if (!connection.kextNext) {
    connection = { ...connection, kextNext: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))) };
    await saveConnection(connection);
  }
  const id = crypto.randomUUID();
  const payload: InboxKeyHalf = { v: 1, id, kext: connection.kextNext! };
  const sealed = sealRow(connection, 'keyhalf', id, padInboxJson(payload));
  if (await enqueue([{ id, kind: 'keyhalf', group: id, payload: sealed }])) await flush();
}

async function readRows(): Promise<StoredRows | null> {
  return ((await browser.storage.local.get(ROWS_KEY))[ROWS_KEY] as StoredRows | undefined) ?? null;
}

/** When the last pull of the copy ended, on the server's clock: a time the
 *  server had passed before anything queued after it (queue.ts `since`). */
export async function lastPullAt(): Promise<number | undefined> {
  return (await readRows())?.syncedAt;
}

/** `failed`: the server answered with an error that does not end the
 *  unlock (a fault, a refusal of the request); the vault stays open and
 *  the next pull tries again. */
export type PullResult = 'ok' | 'locked' | 'offline' | 'disconnected' | 'failed';

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
      // Only the server's "locked" ends the unlock: the ticket ran out (24
      // hours with no request, or 7 days) or another unlock replaced it.
      if (answer.error === 'locked') {
        await lockLogins();
        return 'locked';
      }
      return 'failed';
    }
    const body: PullBody = answer.body;
    // A lock while the request was out wins: nothing is written back.
    if (!(await session())) return 'locked';
    if (body.key_tag !== stored.tag) {
      // The apps moved to a new key: its half came with the answer. The
      // pending store moves with it while the old key is still at hand.
      const old = state;
      const kext = await halfFor((await readConnection()) ?? connection, body.half_id);
      state = { ...state, tag: body.key_tag, p: bytesToBase64(joinLoginsKey(kext, base64ToBytes(body.ksrv))) };
      await rekeyPending(base64ToBytes(old.p), old.tag, base64ToBytes(state.p), state.tag, connection.account).catch(() => undefined);
      await browser.storage.session.set({ [SESSION_KEY]: state });
      stored = { tag: body.key_tag, cursor: null, rows: {} };
      after = null;
      continue;
    }
    for (const row of body.rows) {
      if (row.deleted) delete stored.rows[row.id];
      else stored.rows[row.id] = { ciphertext: row.ciphertext, nonce: row.nonce, at: row.changed_at };
      stored.cursor = { at: row.changed_at, id: row.id };
    }
    if (state.pro !== body.pro) {
      state = { ...state, pro: body.pro === true };
      await browser.storage.session.set({ [SESSION_KEY]: state });
    }
    if (!body.more && answer.serverTime) stored.syncedAt = answer.serverTime;
    await browser.storage.local.set({ [ROWS_KEY]: stored });
    if (!body.more) {
      if (passkeysReleased()) await countPasskeys();
      return 'ok';
    }
    const last = body.rows[body.rows.length - 1]!;
    after = { at: last.changed_at, id: last.id };
  }
  return 'ok';
}

/** Every entry the copy holds, opened with P and checked for shape. A row
 *  that does not open or is not a kind this build knows is left out, never
 *  shown half. */
export async function allEntries(): Promise<{ entries: CopyEntry[]; pro: boolean; notSaved?: NotSavedEdit[] } | null> {
  const [connection, state, stored] = await Promise.all([readConnection(), session(), readRows()]);
  if (!connection || !state || !stored || stored.tag !== state.tag) return state ? { entries: [], pro: state.pro } : null;
  const p = base64ToBytes(state.p);
  const entries: CopyEntry[] = [];
  const changedAt = new Map<string, number>();
  for (const [id, row] of Object.entries(stored.rows)) {
    try {
      const entry = parseCopyEntry(decryptJsonAad<unknown>(base64ToBytes(row.ciphertext), base64ToBytes(row.nonce), p, loginsCopyAad(connection.account, id)));
      if (entry) {
        entries.push(entry);
        if (row.at) changedAt.set(entry.item, Date.parse(row.at));
      }
    } catch {
      // Not under this key: a row the next pull replaces.
    }
  }
  if (!passkeysReleased()) return { entries, pro: state.pro };
  // What this browser sent and the copy does not show yet (passkeys.md section 6).
  const pending = await readPending(p, state.tag, connection.account);
  if (!pending.length) return { entries, pro: state.pro };
  const laid = overlayPending(entries, pending, changedAt, Date.now(), stored.syncedAt, await queuedIds());
  if (laid.kept.length !== pending.length) await writePending(laid.kept, p, state.tag, connection.account);
  return { entries: laid.entries, pro: state.pro, notSaved: notSavedEdits(laid.kept, entries) };
}

/** The person read the not-saved notice: the edit leaves the pending store. */
export async function dismissNotSaved(row: string): Promise<void> {
  const key = await loginsKey();
  if (!key) return;
  const pending = await readPending(key.p, key.tag, key.account);
  await writePending(pending.filter((e) => e.row !== row), key.p, key.tag, key.account);
}

/** The logins key while unlocked, for a write to the pending store. */
export async function loginsKey(): Promise<{ p: Uint8Array; tag: string; account: string } | null> {
  const [connection, state] = await Promise.all([readConnection(), session()]);
  return connection && state ? { p: base64ToBytes(state.p), tag: state.tag, account: connection.account } : null;
}

/** How many site passkeys the copy and the pending store hold, for a locked
 *  extension's door. Written at the end of a pull and when a passkey is saved. */
export async function countPasskeys(): Promise<void> {
  const found = await allEntries();
  if (!found) return;
  const count = found.entries.reduce((n, e) => n + (e.kind === 'login' ? (e.passkeys?.length ?? 0) : 0), 0);
  await browser.storage.local.set({ [PASSKEY_COUNT_KEY]: count });
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
  const tab = await activeTab();
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
