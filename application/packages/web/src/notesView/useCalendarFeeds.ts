import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { LocalNote } from '../db';
import type { TokenSource } from '../sessionToken';
import type { FeedState } from '../calendarFeedStore';
import { liveCalendarFeeds, type CalendarFeeds } from '../calendarFeeds';

type Store = Pick<typeof import('../calendarFeedStore'), 'watchFeeds' | 'subscribeFeeds' | 'feedStates' | 'clearFeedStore'>;

const noSubscribe = () => () => {};
const NO_STATES: ReadonlyMap<string, FeedState> = new Map();
const noStates = () => NO_STATES;

/**
 * The calendars' side of the subscribed feeds (GitHub #619): the events of
 * every subscribed calendar, with the name of the calendar each comes from,
 * for `calendarIndex`. The store that downloads them (`calendarFeedStore.ts`)
 * loads only once the account has a feed, so an account without one carries
 * none of it on the boot path. The events live only while the vault is open.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 14)
 */
export function useCalendarFeeds(feeds: CalendarFeeds, token: TokenSource): { items: readonly LocalNote[]; feedOf: (n: LocalNote) => string | null } {
  const live = useMemo(() => liveCalendarFeeds(feeds), [feeds]);
  const key = live.map((f) => `${f.id}=${f.url}`).join('\n');
  const [store, setStore] = useState<Store | null>(null);

  useEffect(() => {
    if (store || live.length === 0) return;
    let on = true;
    import('../calendarFeedStore').then(
      ({ watchFeeds, subscribeFeeds, feedStates, clearFeedStore }) => on && setStore({ watchFeeds, subscribeFeeds, feedStates, clearFeedStore }),
      () => {
        // A chunk that cannot load (offline at boot) leaves the feeds off
        // until the next start.
      },
    );
    return () => {
      on = false;
    };
  }, [store, live.length]);

  // `key` stands for `live`; the token reads the session when it runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => (store ? store.watchFeeds(live, token) : undefined), [store, key]);
  useEffect(() => (store ? store.clearFeedStore : undefined), [store]);

  const all = useSyncExternalStore(store ? store.subscribeFeeds : noSubscribe, store ? store.feedStates : noStates, noStates);

  return useMemo(() => {
    const names = new Map<string, string>();
    const items: LocalNote[] = [];
    for (const f of live) {
      const s = all.get(f.id);
      if (!s) continue;
      for (const item of s.items) {
        names.set(item.id, s.name);
        items.push(item);
      }
    }
    return { items, feedOf: (n: LocalNote) => names.get(n.id) ?? null };
  }, [live, all]);
}
