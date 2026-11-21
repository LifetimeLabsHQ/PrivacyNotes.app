import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from './icons';
import { Modal } from './ui';
import { renderMarkdownSafe } from './markdownRender';
import { dayNumber, scheduleOf, shiftDay } from './schedule';
import { describeSchedule } from './scheduleText';
import type { LocalNote } from './db';
import { feedIdOf } from './calendarFeeds';
import { PathGlyph, useFeedLook } from './looks/LookGlyph';

/** Rendered HTML with every anchor replaced by its own content. Parsed in a
 *  template, whose content loads and runs nothing. */
function linksAsText(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const a of tpl.content.querySelectorAll('a')) a.replaceWith(...a.childNodes);
  return tpl.innerHTML;
}

/**
 * An event of a subscribed calendar, read-only (GitHub #619): its title, its
 * day and time, the calendar it comes from, and its details as the calendar
 * import writes them. It has no item behind it, so nothing here edits. A
 * repeating event shows the occurrence that was clicked. Loaded on demand.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 14)
 */
export default function FeedEventModal({ item, feed, occurrence, onClose }: {
  item: LocalNote;
  /** The name of the calendar the event comes from. */
  feed: string;
  occurrence?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(['shell', 'common']);
  // The calendar's own icon and color, as its events wear them (#811).
  const look = useFeedLook(feedIdOf(item.id));
  const when = useMemo(() => {
    const s = scheduleOf(item.trackers, item.type);
    if (!s) return '';
    if (!occurrence || occurrence === s.day) return describeSchedule(s, t);
    const end = s.end ? shiftDay(occurrence, dayNumber(s.end) - dayNumber(s.day)) : undefined;
    return describeSchedule({ ...s, day: occurrence, ...(end ? { end } : {}) }, t);
  }, [item, occurrence, t]);
  const html = useMemo(() => (item.body.trim() ? linksAsText(renderMarkdownSafe(item.body)) : ''), [item.body]);
  return (
    <Modal
      onClose={onClose}
      title={item.title || t('common:state.untitled')}
      icon={look?.iconPaths ? <PathGlyph paths={look.iconPaths} size={20} style={look.icon} /> : <Globe style={look?.icon} />}
      subtitle={when}
      className="max-w-md p-6 space-y-4"
    >
      {html && (
        <div
          dir="auto"
          className="prose prose-pn prose-sm max-w-none text-compact"
          // The importer's own Markdown through the app's sanitizing
          // renderer; never the feed's text as HTML. A stranger wrote the
          // event, so its links are drawn as plain text: no anchor, nothing
          // to click or focus, and the address can still be selected.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <p className="text-meta text-pn-muted">{t('calendar.feedReadOnly', { name: feed })}</p>
    </Modal>
  );
}
