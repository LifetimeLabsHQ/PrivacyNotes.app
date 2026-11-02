/**
 * Sealed rows waiting to be sent. A clip is sealed before it is queued, so
 * the queue holds ciphertext only. Pictures are queued before their clip and
 * sent in order; a refusal that can pass (offline, busy, full) keeps the row
 * for the next try, a refusal that cannot drops it, and a revoked token
 * disconnects this browser. The badge shows how many clips wait.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.3, step 4)
 */
import { browser } from 'wxt/browser';
import type { InboxKind } from '@notes/shared/extension';
import { call } from './api';
import { forgetLocal, readConnection } from './connection';

export interface Queued {
  id: string;
  kind: InboxKind;
  payload: string;
  /** The clip this row belongs to: its own id for a clip or a login. */
  group: string;
}

const KEY = 'queue';
// Spec: docs/internal/plans/browser-extension-build.md (section 3.3, 50 items and 8 MB)
const MAX_GROUPS = 50;
const MAX_BYTES = 8_000_000;
export const FLUSH_ALARM = 'flush-queue';

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

/** Add the rows of one clip, or refuse when the queue is full. The byte limit
 *  holds while other clips wait: an empty queue takes one clip of any size,
 *  so a clip with 10 MB of pictures (about 14 MB sealed) is still sent. */
export async function enqueue(rows: Queued[]): Promise<boolean> {
  const added = await update((items) => {
    const next = [...items, ...rows];
    const bytes = next.reduce((n, r) => n + r.payload.length, 0);
    if (groups(next) > MAX_GROUPS || (items.length > 0 && bytes > MAX_BYTES)) return { items, result: false };
    return { items: next, result: true };
  });
  if (added) await showCount(await read());
  return added;
}

async function showCount(items: Queued[]): Promise<void> {
  const n = groups(items);
  await browser.action.setBadgeText({ text: n > 0 ? String(n) : '' });
  if (n > 0) {
    await browser.action.setBadgeBackgroundColor({ color: '#1E40AF' });
    browser.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  } else {
    await browser.alarms.clear(FLUSH_ALARM);
  }
}

/** A short mark on the icon: a tick for saved, ! for a problem. */
export async function flashBadge(mark: 'saved' | 'problem'): Promise<void> {
  await browser.action.setBadgeText({ text: mark === 'saved' ? '✓' : '!' });
  await browser.action.setBadgeBackgroundColor({ color: mark === 'saved' ? '#006045' : '#C10007' });
  if (mark === 'saved') {
    setTimeout(() => {
      void read().then(showCount);
    }, 3000);
  }
}

export type FlushResult = { sent: string[]; dropped: string[]; left: number; revoked: boolean };

let flushing: Promise<FlushResult> | null = null;

/** Send what waits, in order. One flush at a time. */
export function flush(): Promise<FlushResult> {
  flushing ??= flushOnce().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function flushOnce(): Promise<FlushResult> {
  const connection = await readConnection();
  const sent: string[] = [];
  const dropped: string[] = [];
  if (!connection) return { sent, dropped, left: groups(await read()), revoked: false };
  for (;;) {
    const item = (await read())[0];
    if (!item) break;
    const answer = await call('clip-inbox', { token: connection.token, id: item.id, kind: item.kind, payload: item.payload });
    if (answer.ok) {
      sent.push(item.id);
      await update((items) => ({ items: items.filter((r) => r.id !== item.id), result: null }));
      continue;
    }
    if (answer.error === 'not_connected') {
      await forgetLocal();
      await flashBadge('problem');
      return { sent, dropped, left: 0, revoked: true };
    }
    // Offline, rate limited, full or down: the row waits for the next try.
    if (answer.status === 0 || answer.status === 429 || answer.status >= 500 || answer.error === 'inbox_full') break;
    // A refusal that can never pass: the clip's rows go together.
    dropped.push(item.group);
    await update((items) => ({ items: items.filter((r) => r.group !== item.group), result: null }));
    await flashBadge('problem');
  }
  const left = await read();
  await showCount(left);
  return { sent, dropped, left: groups(left), revoked: false };
}
