import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from './icons';
import { Modal } from './ui';
import { renderMarkdownSafe } from './markdownRender';
import { dayNumber, scheduleOf, shiftDay } from './schedule';
import { describeSchedule } from './scheduleText';
import type { LocalNote } from './db';

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
  const when = useMemo(() => {
    const s = scheduleOf(item.trackers, item.type);
    if (!s) return '';
    if (!occurrence || occurrence === s.day) return describeSchedule(s, t);
    const end = s.end ? shiftDay(occurrence, dayNumber(s.end) - dayNumber(s.day)) : undefined;
    return describeSchedule({ ...s, day: occurrence, ...(end ? { end } : {}) }, t);
  }, [item, occurrence, t]);
  const html = useMemo(() => (item.body.trim() ? renderMarkdownSafe(item.body) : ''), [item.body]);
  return (
    <Modal
      onClose={onClose}
      title={item.title || t('common:state.untitled')}
      icon={<Globe />}
      subtitle={when}
      className="max-w-md p-6 space-y-4"
    >
      {html && (
        <div
          dir="auto"
          className="prose prose-pn prose-sm max-w-none text-compact [&_a]:pointer-events-none"
          // The importer's own Markdown through the app's sanitizing
          // renderer; never the feed's text as HTML. Links stay text, as in
          // the clipper's preview.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <p className="text-meta text-pn-muted">{t('calendar.feedReadOnly', { name: feed })}</p>
    </Modal>
  );
}
