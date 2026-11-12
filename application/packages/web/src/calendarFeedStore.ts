/**
 * The subscribed calendars on this device (GitHub #619). Each address in the
 * synced `calendarFeeds` setting is downloaded by this device through the
 * clipper's download path (`clipDownload.ts`: on the device in the desktop
 * and phone apps, through the Worker on the web), read by the calendar
 * importer's parser, and held in memory as read-only events the calendars
 * draw. Nothing of a feed is written to the device or synced: a restart
 * downloads it again, and a failed download keeps the events of the last
 * good one. The address never goes into a log or an error.
 *
 * A feed is downloaded when the app opens, then again once it is an hour old
 * (ten minutes after a failure), and only while the app is in view. The
 * module loads only once the account has a feed (`useCalendarFeeds`), so it
 * is not on the boot path.
 *
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 14)
 */
import { useSyncExternalStore } from 'react';
import type { LocalNote } from './db';
import type { ClipErrorReason } from './clipDownload';
import type { TokenSource } from './sessionToken';
import { feedItemId } from './calendarFeeds';

/** Why a feed shows no fresh events: a download refusal, or a file that is
 *  not a calendar the importer reads. */
export type FeedError = ClipErrorReason | 'not-calendar';

export type FeedState = {
  /** The calendar's own name (`X-WR-CALNAME`), else the address's host. */
  name: string;
  items: readonly LocalNote[];
  /** When the last download ended, in ms; 0 before the first. */
  checkedAt: number;
  /** Why the last download failed; the events of the one before stay. */
  error: FeedError | null;
  busy: boolean;
};

const FRESH_MS = 60 * 60_000;
const RETRY_MS = 10 * 60_000;
/** How often an open app looks for a feed that is due. */
const TICK_MS = 5 * 60_000;

let states = new Map<string, FeedState>();
/** Bumped by `clearFeedStore`, and per feed by `forgetFeed`: a download that
 *  started before lands nowhere. */
let epoch = 0;
const gens = new Map<string, number>();
const listeners = new Set<() => void>();
const running = new Map<string, { mark: string; run: Promise<FeedError | null> }>();
const markOf = (id: string) => `${epoch}.${gens.get(id) ?? 0}`;

function put(id: string, state: FeedState) {
  states = new Map(states).set(id, state);
  listeners.forEach((l) => l());
}

/** Listen to every change of any feed's state. */
export function subscribeFeeds(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Every feed's state on this device. */
export function feedStates(): ReadonlyMap<string, FeedState> {
  return states;
}

/** Every feed's state, for the calendars and the Webcal panel. */
export function useFeedStates(): ReadonlyMap<string, FeedState> {
  return useSyncExternalStore(subscribeFeeds, feedStates, feedStates);
}

/** Whether a feed should be downloaded now. */
export function feedIsDue(state: FeedState | undefined, now = Date.now()): boolean {
  if (!state) return true;
  if (state.busy) return false;
  return now - state.checkedAt >= (state.error ? RETRY_MS : FRESH_MS);
}

/** The host of an address: a feed's name before its first download. */
export function feedHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** A parsed event as the read-only item the calendar index reads. */
function asItem(feedId: string, n: number, e: { title: string; body: string; createdAt: string; updatedAt: string; trackers?: Record<string, unknown> }): LocalNote {
  return {
    id: feedItemId(feedId, n),
    title: e.title,
    body: e.body,
    tags: [],
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    dirty: 0,
    deleted: 0,
    trashed: 0,
    starred: 0,
    locked: 1,
    pinProtected: 0,
    type: 'event',
    trackers: e.trackers,
    folderId: null,
  };
}

/**
 * Download one feed and replace its events. Resolves with the reason it
 * failed, or null. Two calls for one feed share one download.
 */
export function refreshFeed(id: string, url: string, token: TokenSource): Promise<FeedError | null> {
  const mark = markOf(id);
  const held = running.get(id);
  if (held?.mark === mark) return held.run;
  const run = download(id, url, token, mark).finally(() => {
    if (running.get(id)?.run === run) running.delete(id);
  });
  running.set(id, { mark, run });
  return run;
}

async function download(id: string, url: string, token: TokenSource, mark: string): Promise<FeedError | null> {
  const prev = states.get(id);
  const base: FeedState = prev ?? { name: feedHost(url), items: [], checkedAt: 0, error: null, busy: false };
  put(id, { ...base, busy: true });
  const done = (patch: Partial<FeedState>): FeedError | null => {
    if (markOf(id) === mark) put(id, { ...base, ...patch, busy: false, checkedAt: Date.now() });
    return patch.error ?? null;
  };
  // The download code loads on the first download, off the boot path.
  const { calendarFeedUrl, downloadCalendarFeed } = await import('./import/calendarFeed');
  const { ClipError } = await import('./clipDownload');
  const address = calendarFeedUrl(url);
  if (!address) return done({ error: 'refused' });
  let bytes: Uint8Array;
  try {
    const file = await downloadCalendarFeed(address, token);
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    return done({ error: err instanceof ClipError ? err.reason : 'failed' });
  }
  try {
    const { parseCalendarFiles } = await import('./import/googleCalendar');
    const parsed = parseCalendarFiles([{ name: base.name || 'calendar', bytes }]);
    const name = parsed.folders?.[0]?.name || parsed.notes[0]?.folderPath?.[0] || feedHost(address);
    return done({ name, items: parsed.notes.map((e, n) => asItem(id, n, e)), error: null });
  } catch {
    return done({ error: 'not-calendar' });
  }
}

/** Drop a feed's events, as when the person removes it. */
export function forgetFeed(id: string): void {
  gens.set(id, (gens.get(id) ?? 0) + 1);
  if (!states.has(id)) return;
  const next = new Map(states);
  next.delete(id);
  states = next;
  listeners.forEach((l) => l());
}

/** Drop every feed's events: the app closed its vault. */
export function clearFeedStore(): void {
  epoch += 1;
  if (states.size === 0) return;
  states = new Map();
  listeners.forEach((l) => l());
}

/**
 * Keep the subscribed feeds fresh while the app is in view: drop the events
 * of a feed no longer in `live`, download each due feed now, then look again
 * every few minutes and whenever the app comes back into view. Returns the
 * stop function. `useCalendarFeeds` (notesView/) calls it.
 */
export function watchFeeds(live: readonly { id: string; url: string }[], token: TokenSource): () => void {
  const ids = new Set(live.map((f) => f.id));
  for (const id of states.keys()) if (!ids.has(id)) forgetFeed(id);
  if (live.length === 0) return () => {};
  const check = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    for (const f of live) if (feedIsDue(states.get(f.id))) void refreshFeed(f.id, f.url, token);
  };
  check();
  const timer = setInterval(check, TICK_MS);
  document.addEventListener('visibilitychange', check);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
  };
}
