import { lazy, Suspense, useContext, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, Globe } from './icons';
import { Button, DeleteButton, GlyphTile, IconButton, Spinner, StatusLine, TextField } from './ui';
import { ColorSwatchRow } from './ColorSwatch';
import { NO_TEXT_ASSIST } from './formFields';
import { ROW_TITLE, SettingsSegmented } from './settingsUI';
import { SPACE_ICONS } from './SpaceSwitch';
import type { SpaceView } from './spaces';
import { useAuth } from './auth';
import type { ClipErrorReason } from './clipDownload';
import { sessionTokenOf } from './sessionToken';
import { calendarFeedUrl } from './import/calendarFeed';
import { addCalendarFeed, CALENDAR_FEED_MAX, liveCalendarFeeds, removeCalendarFeed, type CalendarFeeds } from './calendarFeeds';
import { feedHost, forgetFeed, refreshFeed, useFeedStates, type FeedError } from './calendarFeedStore';
import { formatInstant } from './intlFormat';
import { feedLookKey, isLookColor, lookOf, type ItemStyles, type LookAttr } from './itemStyles';
import { inkStyle, LooksContext, PathGlyph } from './looks/LookGlyph';
import { useLookPaths } from './looks/lookIconsLoader';

const LookPicker = lazy(() => import('./looks/LookPicker').then((m) => ({ default: m.LookPicker })));

/**
 * The parts of a calendar subscription (GitHub #619) that two screens share:
 * the Webcal panel in Settings > Import, and the Subscribe window the
 * calendar's top row opens. Both write through the one `FeedsControl`.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 14)
 */

/** The subscribed calendars and their one writer. `spaces` is there while
 *  Spaces is on: the space each calendar shows in (#772). */
export type FeedsControl = {
  list: CalendarFeeds;
  onChange: (update: (prev: CalendarFeeds) => CalendarFeeds) => void;
  spaces?: { of: (id: string) => SpaceView; set: (id: string, space: SpaceView) => void };
  /** Each calendar's icon and color, which its events wear (#811). */
  looks?: { styles: ItemStyles; set: (id: string, patch: Partial<Record<LookAttr, string | null>>) => void };
};

const FEED_SPACES = ['all', 'personal', 'work'] as const;

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
  'insecure': 'webcal.errors.insecure',
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

/** The address field and Subscribe: a new calendar joins the list and the
 *  field empties. The Subscribe window and Settings > Date & Time >
 *  Calendar draw it; the Webcal panel has its own, with Import beside it. */
export function FeedSubscribeForm({ feeds, autoFocus = false, onBusy }: { feeds: FeedsControl; autoFocus?: boolean; onBusy?: (busy: boolean) => void }) {
  const { t } = useTranslation('importExport');
  const [address, setAddress] = useState('');
  const sub = useFeedSubscribe(feeds);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onBusy?.(true);
        void sub.subscribe(address).then((ok) => {
          onBusy?.(false);
          if (ok) setAddress('');
        });
      }}
      className="flex flex-wrap items-start gap-2"
    >
      <div className="min-w-48 flex-1">
        <TextField
          type="url"
          inputMode="url"
          autoComplete="off"
          {...NO_TEXT_ASSIST}
          autoFocus={autoFocus}
          aria-label={t('webcal.fieldLabel')}
          placeholder="webcal://"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            sub.setError(null);
          }}
          error={sub.error ?? undefined}
          className="w-full"
        />
      </div>
      <Button
        type="submit"
        variant="primary"
        icon={sub.busy ? <Spinner size={15} className="text-current" /> : <CalendarPlus aria-hidden="true" />}
        disabled={sub.busy || !address.trim()}
      >
        {sub.busy ? t('webcal.downloading') : t('webcal.subscribe')}
      </Button>
    </form>
  );
}

/** The subscribed calendars by name, each with its state and Remove; nothing
 *  while there are none. The address is never shown back. `heading` off
 *  where a section title above already names the list. */
export function SubscribedFeeds({ feeds, heading = true }: { feeds: FeedsControl; heading?: boolean }) {
  const { t } = useTranslation('importExport');
  const states = useFeedStates();
  const live = useMemo(() => liveCalendarFeeds(feeds.list), [feeds.list]);
  if (live.length === 0) return null;
  return (
    <div>
      {heading && <span className={`block ${ROW_TITLE}`}>{t('webcal.subscribed')}</span>}
      <ul className={`${heading ? 'mt-1 ' : ''}divide-y divide-divider`}>
        {live.map((f) => {
          const st = states.get(f.id);
          const name = st?.name || feedHost(f.url);
          return (
            <FeedRow key={f.id} id={f.id} name={name} looks={feeds.looks}>
              {/* The name keeps 10rem; a narrow window puts the space pick under it. */}
              <div className="min-w-0 flex-1 basis-40">
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
              {feeds.spaces && (
                <SettingsSegmented<SpaceView>
                  label={`${t('shell:spaces.label')}: ${name}`}
                  value={feeds.spaces.of(f.id)}
                  onChange={(space) => feeds.spaces?.set(f.id, space)}
                  options={FEED_SPACES.map((space) => {
                    const Glyph = space === 'all' ? null : SPACE_ICONS[space];
                    return {
                      value: space,
                      label: (
                        <span className="inline-flex items-center gap-1">
                          {Glyph && <Glyph aria-hidden="true" />}
                          {t(`shell:spaces.${space}`)}
                        </span>
                      ),
                    };
                  })}
                  className="ms-auto flex-nowrap whitespace-nowrap"
                />
              )}
              <DeleteButton
                kind="remove"
                label={t('trackers:factors.remove', { name })}
                onConfirm={() => {
                  feeds.onChange((prev) => removeCalendarFeed(prev, f.id));
                  forgetFeed(f.id);
                }}
              />
            </FeedRow>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One subscribed calendar (#811): its tile (the icon in its color, a button
 * that opens the folder and tag icon picker), the name, the space and Remove
 * on the first line; under them, from the row's start edge, as in Settings > Trackers > Custom,
 * "Choose icon" and the color swatches. Every row keeps the same columns, so
 * a list of several calendars lines up. Cancel in the picker puts back what
 * it found.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 14)
 */
function FeedRow({ id, name, looks, children }: { id: string; name: string; looks: FeedsControl['looks']; children: ReactNode }) {
  const { t } = useTranslation(['shell', 'editor', 'trackers']);
  const [before, setBefore] = useState<{ icon: string | null; color: string | null } | null>(null);
  const key = feedLookKey(id);
  const look = lookOf(looks?.styles ?? {}, key);
  const { customIcons } = useContext(LooksContext);
  const paths = useLookPaths(look.icon, customIcons);
  const color = isLookColor(look.color) ? look.color : null;
  const glyph = (size: number) => (paths
    ? <PathGlyph paths={paths} size={size} />
    : <Globe size={size} aria-hidden="true" />);
  const open = () => setBefore({ icon: look.icon, color: look.color });
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {looks ? (
          <IconButton label={`${t('looks.menu')}: ${name}`} position="above-start" onClick={open} className="!h-9 !w-9 hover:!bg-transparent">
            <GlyphTile size={36} color={color ? `var(--pn-label-${color}-ink)` : undefined}>{glyph(20)}</GlyphTile>
          </IconButton>
        ) : (
          <Globe size={16} aria-hidden="true" className="shrink-0 text-accent" />
        )}
        {children}
      </div>
      {looks && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button icon={<span className="inline-flex" style={inkStyle(color)}>{glyph(15)}</span>} onClick={open}>
            {t('trackers:config.chooseIcon')}
          </Button>
          <ColorSwatchRow
            selected={color ?? 'none'}
            noneLabel={t('noteOptionsMenu.colorNone')}
            colorLabel={(c) => t(`editor:color.names.${c}`)}
            onPick={(c) => looks.set(id, { color: c })}
          />
        </div>
      )}
      {looks && before && (
        <Suspense fallback={null}>
          <LookPicker
            target={{ kind: 'calendar', lookKey: key, name }}
            styles={looks.styles}
            noteColors="off"
            onNoteColors={() => {}}
            onPick={(patch) => looks.set(id, patch)}
            onCancel={() => looks.set(id, before)}
            onClose={() => setBefore(null)}
          />
        </Suspense>
      )}
    </li>
  );
}
