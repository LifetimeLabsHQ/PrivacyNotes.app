import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from './icons';
import { DeleteButton, StatusLine } from './ui';
import { ROW_TITLE } from './settingsUI';
import { useAuth } from './auth';
import type { ClipErrorReason } from './clipDownload';
import { sessionTokenOf } from './sessionToken';
import { calendarFeedUrl } from './import/calendarFeed';
import { addCalendarFeed, CALENDAR_FEED_MAX, liveCalendarFeeds, removeCalendarFeed, type CalendarFeeds } from './calendarFeeds';
import { feedHost, forgetFeed, refreshFeed, useFeedStates, type FeedError } from './calendarFeedStore';
import { formatInstant } from './intlFormat';

/**
 * The parts of a calendar subscription (GitHub #619) that two screens share:
 * the Webcal panel in Settings > Import, and the Subscribe window the
 * calendar's top row opens. Both write through the one `FeedsControl`.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 14)
 */

/** The subscribed calendars and their one writer. */
export type FeedsControl = { list: CalendarFeeds; onChange: (update: (prev: CalendarFeeds) => CalendarFeeds) => void };

/** The message for a calendar address that did not download. */
export const FEED_ERROR: Record<ClipErrorReason, string> = {
  'refused': 'webcal.errors.refused',
  'wrong-type': 'webcal.errors.wrongType',
  'too-large': 'webcal.errors.tooLarge',
  'timeout': 'webcal.errors.timeout',
  'blocked': 'webcal.errors.blocked',
  'offline': 'webcal.errors.offline',
  'limit': 'webcal.errors.limit',
  'demo-limit': 'webcal.errors.limit',
  'failed': 'webcal.errors.failed',
};

/** The message for a feed whose download failed: a refusal, or a file
 *  that is not a calendar. */
const feedError = (reason: FeedError): string => (reason === 'not-calendar' ? 'webcal.errors.wrongType' : FEED_ERROR[reason]);

/**
 * Subscribe to a typed address: check it, download it once, and keep it
 * only when that worked. The error is a sentence for the field.
 */
export function useFeedSubscribe(feeds: FeedsControl | undefined) {
  const { t } = useTranslation('importExport');
  const { supabase } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe(address: string): Promise<boolean> {
    const url = calendarFeedUrl(address);
    if (!url) {
      setError(t('webcal.errors.invalid'));
      return false;
    }
    if (!feeds) return false;
    const added = addCalendarFeed(feeds.list, url);
    if (added === 'full') {
      setError(t('webcal.errors.full', { max: CALENDAR_FEED_MAX }));
      return false;
    }
    setBusy(true);
    setError(null);
    const failed = await refreshFeed(added.id, url, sessionTokenOf(supabase));
    setBusy(false);
    if (failed) {
      if (!liveCalendarFeeds(feeds.list).some((f) => f.id === added.id)) forgetFeed(added.id);
      setError(t(feedError(failed)));
      return false;
    }
    feeds.onChange((prev) => {
      const next = addCalendarFeed(prev, url, added.id);
      return next === 'full' ? prev : next.feeds;
    });
    return true;
  }

  return { subscribe, busy, error, setError };
}

/** The subscribed calendars by name, each with its state and Remove; nothing
 *  while there are none. The address is never shown back. */
export function SubscribedFeeds({ feeds }: { feeds: FeedsControl }) {
  const { t } = useTranslation('importExport');
  const states = useFeedStates();
  const live = useMemo(() => liveCalendarFeeds(feeds.list), [feeds.list]);
  if (live.length === 0) return null;
  return (
    <div>
      <span className={`block ${ROW_TITLE}`}>{t('webcal.subscribed')}</span>
      <ul className="mt-1 divide-y divide-divider">
        {live.map((f) => {
          const st = states.get(f.id);
          const name = st?.name || feedHost(f.url);
          return (
            <li key={f.id} className="flex items-center gap-2 py-1.5">
              <Globe size={16} aria-hidden="true" className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-body text-pn">{name}</span>
                <StatusLine busy={st?.busy} tone={st?.error ? 'danger' : undefined}>
                  {st?.busy
                    ? t('webcal.updating')
                    : st?.error
                      ? t(feedError(st.error))
                      : st?.checkedAt
                        ? t('webcal.updatedAt', { time: formatInstant(new Date(st.checkedAt), 'time'), count: st.items.length })
                        : t('webcal.notYet')}
                </StatusLine>
              </div>
              <DeleteButton
                kind="remove"
                label={t('trackers:factors.remove', { name })}
                onConfirm={() => {
                  feeds.onChange((prev) => removeCalendarFeed(prev, f.id));
                  forgetFeed(f.id);
                }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
