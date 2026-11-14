/**
 * The calendars a person subscribes to (GitHub #619), kept in the encrypted
 * settings blob as `calendarFeeds`: one register per feed id, whose value is
 * the calendar's address, and null once the person removes it. A private
 * calendar address is as secret as a password, so it lives in the sealed
 * part of the settings cache and never goes into a log, a message or an
 * error. Each device downloads the feeds itself (calendarFeedStore.ts); the
 * events never become items, so they cost no quota and never sync.
 *
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 14)
 */
import {
  mergeRegisterMaps,
  newRegisterId,
  REGISTER_ID,
  registerMapsEqual,
  stampAfter,
  validateRegisterMap,
  type RegisterMap,
} from './registers';

export type CalendarFeeds = RegisterMap;

/** The longest address kept. */
const URL_MAX = 2048;
/** The most calendars one account subscribes to. */
export const CALENDAR_FEED_MAX = 20;

/** Sanitize a raw map from a settings blob. */
export function validateCalendarFeeds(raw: unknown, now = Date.now()): CalendarFeeds {
  return validateRegisterMap(raw, (id) => REGISTER_ID.test(id), URL_MAX, now);
}

export function mergeCalendarFeeds(local: CalendarFeeds, remote: CalendarFeeds, now = Date.now()): CalendarFeeds {
  return mergeRegisterMaps(local, remote, now);
}

export const calendarFeedsEqual = registerMapsEqual;

/** The subscribed calendars, in the order they were added. */
export function liveCalendarFeeds(feeds: CalendarFeeds): { id: string; url: string }[] {
  return Object.entries(feeds)
    .filter((e): e is [string, { v: string; at: string }] => typeof e[1].v === 'string')
    .sort((a, b) => a[1].at.localeCompare(b[1].at) || a[0].localeCompare(b[0]))
    .map(([id, reg]) => ({ id, url: reg.v }));
}

/** Subscribe to an address, under `id` when the caller chose it before.
 *  The same address twice is one subscription; `full` when the account
 *  holds the most it may. */
export function addCalendarFeed(feeds: CalendarFeeds, url: string, id = newRegisterId()): { feeds: CalendarFeeds; id: string } | 'full' {
  const live = liveCalendarFeeds(feeds);
  const held = live.find((f) => f.url === url);
  if (held) return { feeds, id: held.id };
  if (live.length >= CALENDAR_FEED_MAX || url.length > URL_MAX || !REGISTER_ID.test(id)) return 'full';
  // After every stamp the list holds, so the new feed sorts last.
  const latest = Object.values(feeds).reduce((m, r) => (r.at > m ? r.at : m), '');
  return { feeds: { ...feeds, [id]: { v: url, at: stampAfter(latest || undefined) } }, id };
}

/** Unsubscribe. The null travels, so no other device brings the feed back
 *  until registers.ts drops the null at the end of the tombstone window. */
export function removeCalendarFeed(feeds: CalendarFeeds, id: string): CalendarFeeds {
  const prev = feeds[id];
  if (!prev || prev.v === null) return feeds;
  return { ...feeds, [id]: { v: null, at: stampAfter(prev.at) } };
}

// ── The read-only events of a feed ─────────────────────────────────────

const ITEM_PREFIX = 'feed:';

/** The id a feed's event carries in the calendars. It can never match an
 *  item's id, which is a UUID. */
export function feedItemId(feedId: string, n: number): string {
  return `${ITEM_PREFIX}${feedId}:${n}`;
}

/** Whether an id names an event of a subscribed calendar. */
export function isFeedItemId(id: string): boolean {
  return id.startsWith(ITEM_PREFIX);
}
