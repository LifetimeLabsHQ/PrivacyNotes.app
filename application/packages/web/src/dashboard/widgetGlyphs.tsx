/** The glyph of each Home widget: its card head, the catalog row, the menus.
 *  Spec: docs/internal/specs/dashboard.md (section 3) */
import {
  CalendarCheck, CalendarDots, Cake, ChartLineUp, CheckCircle, CheckFat, ClockCounterClockwise, Fire, Flag, Folder, NotePencil, PenNib,
  Pulse, PushPin, Smiley, SquaresFour, Tag, PILLAR_GLYPHS, type Icon,
} from '../icons';
import type { WidgetGroup, WidgetKind } from './dashboardLayout';

export const WIDGET_GLYPH: Record<WidgetKind, Icon> = {
  checkIn: Smiley,
  calendar: CalendarDots,
  upcoming: CalendarCheck,
  today: PenNib,
  tasks: CheckFat,
  recent: ClockCounterClockwise,
  pinned: PushPin,
  note: NotePencil,
  tag: Tag,
  folder: Folder,
  onThisDay: ClockCounterClockwise,
  week: ChartLineUp,
  streak: Fire,
  checkInStreak: CheckCircle,
  rhythm: SquaresFour,
  milestone: Flag,
  tracker: Pulse,
  weekRecap: CalendarCheck,
  files: PILLAR_GLYPHS.files,
  bookmarks: PILLAR_GLYPHS.bookmarks,
  birthdays: Cake,
};

/** The key of each widget's name. A widget named as a view or a Statistics
 *  block already is takes that key, so the two never drift apart. */
const NAME_KEY: Partial<Record<WidgetKind, string>> = {
  calendar: 'shell:tagsRail.calendar',
  pinned: 'shell:tagsRail.pinned',
  bookmarks: 'shell:tagsRail.bookmarks',
  birthdays: 'shell:calendar.birthdays',
  week: 'stats:overview.thisWeek',
  streak: 'stats:overview.streak',
  checkInStreak: 'stats:overview.checkInStreak',
  weekRecap: 'notes:weekReview.title',
};

export function widgetNameKey(kind: WidgetKind): string {
  return NAME_KEY[kind] ?? `shell:dashboard.w.${kind}.name`;
}

/** The catalog groups' headings; three are words the app has already. */
export const GROUP_KEY: Record<WidgetGroup, string> = {
  today: 'shell:backfillPopover.today',
  notes: 'shell:tagsRail.notes',
  stats: 'notes:settings.statsLabel',
  keep: 'shell:dashboard.groups.keep',
};

export function WidgetGlyph({ kind }: { kind: WidgetKind }) {
  const Glyph = WIDGET_GLYPH[kind];
  return <Glyph aria-hidden="true" />;
}
