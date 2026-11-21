/**
 * Sealed rows waiting to be sent. A clip is sealed before it is queued, so
 * the queue holds ciphertext only. Pictures are queued before their clip and
 * sent in order; a refusal the function names as final drops the clip's
 * rows, a revoked token disconnects this browser, and every other answer
 * (offline, busy, full, or a page from something in front of the function)
 * keeps the row and stops the send until the next try. The badge shows how
 * many clips wait.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.3, step 4)
 */
import { browser } from 'wxt/browser';
import { showMark, showQueueCount } from './badge';
import type { InboxKind } from '@notes/shared/extension';
import { call, type Answer } from './api';
import { forgetLocal, readConnection } from './connection';
import { markPendingDropped } from './pending';

export interface Queued {
  id: string;
  kind: InboxKind;
  payload: string;
  /** The clip this row belongs to: its own id for a clip or a login. */
  group: string;
  /** When the row was queued (this browser's clock); `enqueue` sets it. A
   *  `loginedit` row brings its own, the `queuedAt` sealed inside it, which a
   *  copy of this storage cannot change (beta #140 item 1). */
  at?: number;
  /** A `loginedit` row: the server's time (ms, its `Date` header) known
   *  before the row was queued, sent with every post so clip-inbox refuses
   *  the row once that is 80 days past on its own clock (beta #129). */
  since?: number;
}

const KEY = 'queue';
// Spec: docs/internal/plans/browser-extension-build.md (section 3.3, 50 items and 8 MB)
const MAX_GROUPS = 50;
const MAX_BYTES = 8_000_000;
export const FLUSH_ALARM = 'flush-queue';
// The server answers `ok` to a repeat of a settled login edit for 90 days
// (migration 0132), so a repeat must never outlive that memory. A row with
// `since` is counted on the server's clock: clip-inbox refuses it 80 days
// after `since` (`too_old`), and the refusal drops it, whatever this
// browser's clock says (beta #129). A row without one (queued before the
// copy's first pull ended, or by an older build) falls back to this
// browser's clock: dropped when 80 days older than its `at`, and dropped
// with no `at` at all. That fallback still trusts two readings of this
// browser's clock. Spec: docs/contrib/passkeys.md (section 16, finding 6)
const LOGINEDIT_MAX_AGE_MS = 80 * 24 * 60 * 60 * 1000;

async function read(): Promise<Queued[]> {
  return ((await browser.storage.local.get(KEY))[KEY] as Queued[] | undefined) ?? [];
}

// Every change to the queue reads the latest list and writes it back, one at
// a time, so a send that finishes never writes back a list that predates a
// clip saved meanwhile.
let chain: Promise<unknown> = Promise.resolve();
function update<T>(change: (items: Queued[]) => { items: Queued[]; result: T }): Promise<T> {
  const next = chain.then(async () => {
    const { items, result } = change(await read());
    await browser.storage.local.set({ [KEY]: items });
    return result;
  });
  chain = next.catch(() => undefined);
  return next;
}

const groups = (items: Queued[]) => new Set(items.map((i) => i.group)).size;

/** The ids of the rows that wait, unsent. */
export async function queuedIds(): Promise<Set<string>> {
  return new Set((await read()).map((r) => r.id));
}

/** Add the rows of one clip, or refuse when the queue is full. The byte limit
 *  holds while other clips wait: an empty queue takes one clip of any size,
 *  so a clip with 10 MB of pictures (about 14 MB sealed) is still sent. */
export async function enqueue(rows: Queued[], now = Date.now()): Promise<boolean> {
  const added = await update((items) => {
    const next = [...items, ...rows.map((r) => ({ ...r, at: r.at ?? now }))];
    const bytes = next.reduce((n, r) => n + r.payload.length, 0);
    if (groups(next) > MAX_GROUPS || (items.length > 0 && bytes > MAX_BYTES)) return { items, result: false };
    return { items: next, result: true };
  });
  if (added) await showCount(await read());
  return added;
}

async function showCount(items: Queued[]): Promise<void> {
  const n = groups(items);
  await showQueueCount(n);
  if (n > 0) {
    browser.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  } else {
    await browser.alarms.clear(FLUSH_ALARM);
  }
}

/** A short mark on the icon: a tick for saved, ! for a problem. */
export async function flashBadge(mark: 'saved' | 'problem'): Promise<void> {
  await showMark(mark, async () => showCount(await read()));
}

/** The refusals of clip-inbox that the same row can never pass, each only
 *  as the code in the function's JSON body: an answer with none of these is
 *  not the function's word on the row and drops nothing. */
const FINAL_REFUSALS = new Set(['invalid_body', 'invalid_json', 'too_large', 'bad_kind', 'id_taken', 'not_allowed', 'too_old']);

/** Every code clip-inbox itself answers with, besides `ok`: a refusal, or
 *  its own `internal` when the database refused the post. */
const CLIP_INBOX_CODES = new Set([...FINAL_REFUSALS, 'not_connected', 'rate_limited', 'inbox_full', 'method_not_allowed', 'internal']);

export type FlushResult = { sent: string[]; dropped: string[]; left: number; revoked: boolean };

/** When the server accepted a row, on its own clock, for the rows this
 *  worker sent (the pending store compares it with `changed_at`). */
const accepted = new Map<string, number>();
export function acceptedAt(id: string): number | undefined {
  return accepted.get(id);
}

let flushing: Promise<FlushResult> | null = null;

/** Send what waits, in order. One flush at a time. */
export function flush(now = Date.now): Promise<FlushResult> {
  flushing ??= flushOnce(now).finally(() => {
    flushing = null;
  });
  return flushing;
}

/** The row is in the inbox: clip-inbox's own `{ ok: true }`. A 2xx with any
 *  other body (a block page from a network in front of the server) is not
 *  the function's answer, so the row is not counted as sent. */
function landed(answer: Answer): answer is Extract<Answer, { ok: true }> {
  return answer.ok && answer.body.ok === true;
}

/** The same row for the group: drops the clip's rows, and an edit the
 *  pending store shows leaves it. */
async function drop(group: string, dropped: string[]): Promise<void> {
  dropped.push(group);
  await markPendingDropped(group).catch(() => undefined);
  await update((items) => ({ items: items.filter((r) => r.group !== group), result: null }));
  await flashBadge('problem');
}

async function flushOnce(now: () => number): Promise<FlushResult> {
  const connection = await readConnection();
  const sent: string[] = [];
  const dropped: string[] = [];
  if (!connection) return { sent, dropped, left: groups(await read()), revoked: false };
  for (;;) {
    const item = (await read())[0];
    if (!item) break;
    if (item.kind === 'loginedit' && item.since === undefined && (item.at === undefined || now() - item.at > LOGINEDIT_MAX_AGE_MS)) {
      await drop(item.group, dropped);
      continue;
    }
    const answer = await call('clip-inbox', { token: connection.token, id: item.id, kind: item.kind, payload: item.payload, ...(item.since === undefined ? {} : { since: item.since }) });
    if (landed(answer)) {
      sent.push(item.id);
      if (answer.serverTime && item.kind === 'loginedit') accepted.set(item.id, answer.serverTime);
      await update((items) => ({ items: items.filter((r) => r.id !== item.id), result: null }));
      continue;
    }
    if (!answer.ok && answer.error === 'not_connected') {
      await forgetLocal();
      await flashBadge('problem');
      return { sent, dropped, left: 0, revoked: true };
    }
    // Offline, rate limited, full, down, or an answer the function did not
    // write: the row waits for the next try.
    const code = answer.body.error;
    if (typeof code !== 'string' || !FINAL_REFUSALS.has(code)) break;
    // A refusal that can never pass.
    await drop(item.group, dropped);
  }
  const left = await read();
  await showCount(left);
  return { sent, dropped, left: groups(left), revoked: false };
}

/** What a send that must reach the server now came to. `unknown`: no
 *  answer from the function came in its time (offline to the end, a request
 *  cancelled at the limit, or an answer without one of its codes), so the
 *  server may have taken the row (beta #125, #198 item 4); `failed`: the
 *  function answered with its own code and did not take it. */
export type PostNowResult = 'sent' | 'revoked' | 'failed' | 'unknown';

/**
 * Send one sealed row now, never leaving it in the queue: a site passkey
 * may exist only once its row is on the server, and the page gets it only
 * then (P24). It waits for a send in flight, so the two never send at once,
 * and tries again while offline for `limitMs`. A refusal is a failure, and
 * the row is gone with it. A request still out when the time runs out is
 * cancelled, so it does not land after the page was told to use the
 * browser. One the server had already taken can still land: the Vault then
 * holds a passkey the site never got (section 16, finding 16), so no answer
 * reads as `unknown`, never as a refusal.
 * Spec: docs/contrib/passkeys.md (section 5.4, Saving)
 */
export async function postNow(row: Queued, limitMs = 10_000): Promise<PostNowResult> {
  const connection = await readConnection();
  if (!connection) return 'failed';
  const until = Date.now() + limitMs;
  await flushing?.catch(() => undefined);
  const gaveUp = new AbortController();
  const timeUp = new Promise<'unknown'>((resolve) => setTimeout(() => {
    gaveUp.abort();
    resolve('unknown');
  }, limitMs));
  const send = async (): Promise<PostNowResult> => {
    for (;;) {
      const answer = await call('clip-inbox', { token: connection.token, id: row.id, kind: row.kind, payload: row.payload }, gaveUp.signal);
      if (landed(answer)) {
        if (answer.serverTime) accepted.set(row.id, answer.serverTime);
        return 'sent';
      }
      if (!answer.ok && answer.error === 'not_connected') {
        await forgetLocal();
        await flashBadge('problem');
        return 'revoked';
      }
      // Only the function's own code is its word that the row was not
      // taken. A 500, 502 or 504 with none (a gateway, a time-out behind
      // it) is the same lost answer as no answer: the row may be stored
      // (beta #198 item 4). No answer at all is worth another try within
      // the time, and past it may still have landed.
      if (answer.status !== 0) return typeof answer.body.error === 'string' && CLIP_INBOX_CODES.has(answer.body.error) ? 'failed' : 'unknown';
      if (Date.now() + 1000 > until) return 'unknown';
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  return Promise.race([send(), timeUp]);
}
