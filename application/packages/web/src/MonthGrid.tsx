import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDot, CalendarDots, CaretDown, CaretLeft, CaretRight, Plus } from './icons';
import { HoverLabel, IconButton, Popover } from './ui';
import { WEEK_START_DAY, formatInstant, toLocalIso, useDateFormatKey, weekStartSetting, weekdayDate, weekdayLabel, type WeekStart } from './intlFormat';
import { intlLocale } from './languages';
import type { Space } from './spaces';
import type { LocalNote } from './db';
import { typeGlyph } from './NoteRow';
import { moodColor } from './moodColors';
import { moodAnchor } from './moodMark';

/**
 * One month of days. It draws and reports a click, nothing else: the hosts
 * own the data and decide what a picked day does. It replaces the browser
 * date field, whose calendar is a separate window the page cannot place,
 * mark or connect to an entry.
 * Spec: docs/internal/specs/journal-calendar.md
 */

/** A local ISO day as a Date at noon, so a daylight-saving change never moves
 *  the day. Every calendar surface turns a day into a Date through here. */
export function dayAtNoon(day: string): Date {
  return new Date(`${day}T12:00:00`);
}

export function addDays(day: string, n: number): string {
  const d = dayAtNoon(day);
  d.setDate(d.getDate() + n);
  return toLocalIso(d);
}

/** The same day of the month `n` months away, clamped to the month's last day. */
export function addMonths(day: string, n: number): string {
  const d = dayAtNoon(day);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, 12);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return toLocalIso(target);
}

/** The first day of the week, 0 = Sunday: the synced setting, or on Automatic
 *  the locale's own. Monday where the engine cannot say. */
export function firstWeekday(locale: string, setting: WeekStart = weekStartSetting()): number {
  if (setting !== 'auto') return WEEK_START_DAY[setting];
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = l.getWeekInfo?.().firstDay ?? l.weekInfo?.firstDay;
    if (first) return first % 7;
  } catch {
    // An unknown tag falls through to the default.
  }
  return 1;
}

/** `firstWeekday` for the app language, read again when the setting changes. */
export function useWeekStart(): number {
  useDateFormatKey();
  return firstWeekday(intlLocale());
}

/** Six weeks of days around the month of `day`, so every month has the same height. */
export function monthCells(day: string, weekStart: number): string[] {
  const d = dayAtNoon(day);
  const first = new Date(d.getFullYear(), d.getMonth(), 1, 12);
  const start = addDays(toLocalIso(first), -((first.getDay() - weekStart + 7) % 7));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** The seven days of the week that holds `day`. */
export function weekCells(day: string, weekStart: number): string[] {
  const start = addDays(day, -((dayAtNoon(day).getDay() - weekStart + 7) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** The most dots a day draws; the list under the grid names the rest. */
const MAX_DOTS = 3;

type Dot = { space: Space | null; kind?: LocalNote['type'] };

/** The color of an item type in a calendar: the app's type color, except a
 *  birthday, which is pink so it never reads as a note in the accent.
 *  theme-ok: a fixed hue like the journal purple, the same in every theme. */
export function dayKindColor(kind: LocalNote['type']): string {
  return kind === 'contact' ? 'text-pink-500 dark:text-pink-400' : typeGlyph(kind).color;
}

/** The dots of a day, in its type's color and its space's shape: each type
 *  and space once first, so a mixed day shows its mix, then repeats, so
 *  three notes still read as three. A day in both spaces always shows one
 *  dot of the other space. */
export function pickDots(found: readonly Dot[]): Dot[] {
  const seen = new Set<string>();
  const first: Dot[] = [];
  const rest: Dot[] = [];
  for (const dot of found) {
    const key = `${dot.kind ?? ''}|${dot.space ?? ''}`;
    (seen.has(key) ? rest : first).push(dot);
    seen.add(key);
  }
  const picked = first.slice(0, MAX_DOTS);
  const other = first.find((d) => d.space !== first[0]!.space);
  if (other && !picked.includes(other)) picked[MAX_DOTS - 1] = other;
  return [...picked, ...rest].slice(0, MAX_DOTS);
}

type Props = {
  /** The days that get a dot. With `entriesOf`, a dot per space: Personal
   *  round in the accent, Work square in the warning color, so the shape
   *  tells them apart without color. Spec: docs/internal/specs/spaces.md (section 9) */
  marked: { has(day: string): boolean; entriesOf?(day: string): readonly { space: Space | null; kind?: LocalNote['type'] }[] };
  /** The day drawn with a ring. */
  selected?: string;
  /** A day in the month to show first. Today when absent. */
  initialMonth?: string;
  onPick: (day: string) => void;
  /** One week or the whole month (six weeks). The arrows step by the same unit. */
  weeks?: 1 | 6;
  /** When set, a button beside the arrows switches between week and month. */
  onToggleWeeks?: () => void;
  /** When set, a Today row heads the grid and calls this. */
  onToday?: () => void;
  /** `large` fills its host: each day is a grid cell with its number as a
   *  button and the host's content under it (`renderDay`), each week row
   *  takes an overlay (`renderWeek`, the multi-day bars). `small` is the
   *  240 px grid of dots every popover and card draws. */
  size?: 'small' | 'large';
  /** A `small` grid as wide as the check-in card above it, for the band at
   *  the top of a list: the full width of the list since 2026-10-22. */
  wide?: boolean;
  /** The focused day, when the host keeps it (the Calendar pillar keeps the
   *  month across an open item and Back). The grid keeps its own otherwise. */
  focus?: string;
  onFocusChange?: (day: string) => void;
  /** Large: what a day cell holds under its number. */
  renderDay?: (day: string, state: { inMonth: boolean; isToday: boolean }) => ReactNode;
  /** Large: an overlay over one week row, for items that run across days. */
  renderWeek?: (days: readonly string[]) => ReactNode;
  /** Large: a click on a cell's empty space or its plus, to create on that day. */
  onAdd?: (day: string) => void;
  /** Large: a right-click on a cell's empty space (an item's own menu comes first). */
  onDayMenu?: (e: React.MouseEvent, day: string) => void;
  /** Large: controls at the end of the header row (the view switch). */
  headerEnd?: ReactNode;
  /** Large: the header's second row (the legend). */
  headerBelow?: ReactNode;
  /** Large: before the title (the drawer button). */
  headerStart?: ReactNode;
  /** A narrow first column with the ISO week number (the synced setting). */
  weekNumbers?: boolean;
  /** Large: a list item dragged over a day, and dropped on it. */
  drop?: { accepts: (e: React.DragEvent) => boolean; onDrop: (day: string, e: React.DragEvent) => void };
  /** Small: the mood look of the Journals calendar. A day with a mood is a
   *  disc in its color, a day written without one a ring; the dots give way.
   *  Spec: docs/internal/issues/0439.md (Spec) */
  moodOf?: (day: string) => number | 'written' | undefined;
};

/** The number beside a row of the month: the ISO week of the row's Thursday.
 *  A row that starts on Sunday or Saturday holds one or two days of the week
 *  before, and its first cell would number the row by them, not by the five
 *  or six days that share the week (every row in a Sunday-first year was one
 *  off). Thursday is in the ISO week of the row's majority for every start. */
export function rowWeek(days: readonly string[], weekStart: number): number {
  return isoWeek(days[(4 - weekStart + 7) % 7]!);
}

/** The ISO 8601 week number of a day. */
function isoWeek(day: string): number {
  const d = dayAtNoon(day);
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7), 12);
  const jan4 = new Date(thursday.getFullYear(), 0, 4, 12);
  return 1 + Math.round(((thursday.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

/**
 * The month and year picker the title caret opens (#750): a year with its
 * arrows, then the twelve months. A pick keeps the day of the month (clamped
 * to the month's length), so a week or day view stays where it was in the
 * month. The month shown is filled, the current month has a ring.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (step 3), docs/internal/design/patterns/181-190.md (182)
 */
function MonthYearPanel({ focus, onPick, onClose }: { focus: string; onPick: (day: string) => void; onClose: () => void }) {
  const { t } = useTranslation('shell');
  const locale = intlLocale();
  const shown = dayAtNoon(focus);
  const now = new Date();
  const [year, setYear] = useState(shown.getFullYear());
  const months = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = months.current;
    (box?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? box?.querySelector<HTMLButtonElement>('[data-month]'))?.focus();
  }, []);
  const name = new Intl.DateTimeFormat(locale, { month: 'short' }); // date-ok: a month name carries no day, so no date-order setting applies
  const long = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }); // date-ok: the same, for the screen reader
  return (
    <div
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // Only the picker closes, not the menu or window the grid sits in.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="flex items-center justify-between">
        <IconButton label={t('stats:wellness.pixels.prevYear')} onClick={() => setYear((y) => y - 1)}>
          <CaretLeft aria-hidden="true" />
        </IconButton>
        <span aria-live="polite" className="text-compact font-medium text-pn tabular-nums">{year}</span>
        <IconButton label={t('stats:wellness.pixels.nextYear')} onClick={() => setYear((y) => y + 1)}>
          <CaretRight aria-hidden="true" />
        </IconButton>
      </div>
      <div ref={months} className="mt-1 grid grid-cols-3 gap-1">
        {Array.from({ length: 12 }, (_, m) => {
          const date = new Date(year, m, 1, 12);
          const isShown = year === shown.getFullYear() && m === shown.getMonth();
          const isNow = year === now.getFullYear() && m === now.getMonth();
          return (
            <button
              key={m}
              type="button"
              data-month={m}
              aria-current={isShown ? 'true' : undefined}
              aria-label={long.format(date)}
              onClick={() => onPick(addMonths(focus, (year - shown.getFullYear()) * 12 + m - shown.getMonth()))}
              className={`h-9 [@media(hover:none)]:h-11 rounded-md text-compact transition ${
                isShown ? 'bg-accent-fill text-white font-semibold' : isNow ? 'ring-[1.5px] ring-inset ring-accent text-accent font-semibold hover:bg-accent/10' : 'text-pn hover:bg-pn/5'
              }`}
            >
              {name.format(date)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function MonthGrid({
  marked, selected, initialMonth, onPick, weeks = 6, onToggleWeeks, onToday,
  size = 'small', wide = false, focus: heldFocus, onFocusChange, renderDay, renderWeek, onAdd, onDayMenu, headerEnd, headerBelow, headerStart, weekNumbers = false, drop, moodOf,
}: Props) {
  const { t } = useTranslation('shell');
  const today = toLocalIso(new Date());
  const [ownFocus, setOwnFocus] = useState(initialMonth ?? selected ?? today);
  const focus = heldFocus ?? ownFocus;
  const setFocus = (day: string) => {
    setOwnFocus(day);
    onFocusChange?.(day);
  };
  const moved = useRef(false);
  const [picking, setPicking] = useState(false);
  const titleRef = useRef<HTMLButtonElement | null>(null);
  const closePicker = () => {
    setPicking(false);
    titleRef.current?.focus();
  };
  const [dropDay, setDropDay] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const locale = intlLocale();
  const weekStart = useWeekStart();
  const cells = weeks === 1 ? weekCells(focus, weekStart) : monthCells(focus, weekStart);
  const step = (n: number) => (weeks === 1 ? addDays(focus, 7 * n) : addMonths(focus, n));
  const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(dayAtNoon(focus)); // date-ok: a month heading carries no day, so no date-order setting applies
  const shortTitle = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(dayAtNoon(focus)); // date-ok: the same heading, short
  // A narrow host (a tight list pane, a grid tile) shows the short month, so
  // the heading never wraps beside the arrows; a screen reader always hears
  // the long one. The breakpoint fits the longest long month with its year;
  // each extra header button (a host's, the week switch) moves it up 32px.
  const extra = (headerEnd ? 1 : 0) + (onToggleWeeks ? 1 : 0);
  const shortUpTo = ['@min-[208px]/month:hidden', '@min-[240px]/month:hidden', '@min-[272px]/month:hidden'][extra];
  const longFrom = ['@min-[208px]/month:inline', '@min-[240px]/month:inline', '@min-[272px]/month:inline'][extra];
  // Touch-size buttons (40px each) leave the long name room only from 280px, 40px more per extra button.
  const touchShort = ['[@media(hover:none)]:@max-[279.98px]/month:inline', '[@media(hover:none)]:@max-[319.98px]/month:inline', '[@media(hover:none)]:@max-[359.98px]/month:inline'][extra];
  const touchLong = ['[@media(hover:none)]:@max-[279.98px]/month:hidden', '[@media(hover:none)]:@max-[319.98px]/month:hidden', '[@media(hover:none)]:@max-[359.98px]/month:hidden'][extra];
  const heading = (
    <span aria-live="polite" className="min-w-0 truncate">
      <span aria-hidden="true" className={`${shortUpTo} ${touchShort}`}>{shortTitle}</span>
      <span aria-hidden="true" className={`hidden ${longFrom} ${touchLong}`}>{title}</span>
      <span className="sr-only">{title}</span>
    </span>
  );

  // Focus follows the arrow keys only, so opening the grid never steals focus.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus();
  }, [focus]);

  function onKeyDown(e: React.KeyboardEvent) {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const weekPos = (dayAtNoon(focus).getDay() - weekStart + 7) % 7;
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, rtl ? 1 : -1),
      ArrowRight: () => addDays(focus, rtl ? -1 : 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
      Home: () => addDays(focus, -weekPos),
      End: () => addDays(focus, 6 - weekPos),
    };
    const next = step[e.key];
    if (!next) return;
    // The menus around the grid move focus with these keys too; the grid keeps them.
    e.preventDefault();
    e.stopPropagation();
    moved.current = true;
    setFocus(next());
  }

  const navBtn = 'inline-flex items-center justify-center w-8 h-8 [@media(hover:none)]:w-10 [@media(hover:none)]:h-10 rounded-md text-accent hover:bg-pn/5 transition';
  if (size === 'large') {
    return (
      <LargeMonth
        focus={focus}
        today={today}
        title={title}
        shortTitle={shortTitle}
        cells={cells}
        weekStart={weekStart}
        weeks={weeks}
        gridRef={gridRef}
        onKeyDown={onKeyDown}
        onPrev={() => setFocus(step(-1))}
        onNext={() => setFocus(step(1))}
        onJump={setFocus}
        onToday={onToday}
        onPick={onPick}
        renderDay={renderDay}
        renderWeek={renderWeek}
        onAdd={onAdd}
        onDayMenu={onDayMenu}
        headerEnd={headerEnd}
        headerBelow={headerBelow}
        headerStart={headerStart}
        weekNumbers={weekNumbers}
        drop={drop}
      />
    );
  }
  // Every calendar in the app draws through here: the hosts give a container
  // and nothing else, so the width, the title, the Today row and the day
  // states stay one design in the list, the popovers and the entry menu.
  // Under 208 px (the short title's width) the title and the header buttons
  // tighten, so the arrows and a host's button still fit beside the title.
  // min-w-0: with touch-size arrows the long month name can be wider than
  // the room left; it truncates instead of pushing the arrows out.
  const shortDays = Array.from({ length: 7 }, (_, i) => weekdayLabel(weekdayDate((weekStart + i) % 7), 'short'));
  const shortFits = shortDays.every((name) => [...name].length <= 6);
  const titleClass = 'inline-flex min-w-0 items-center gap-1 rounded-md px-2 @max-[207.98px]/month:px-1 py-1 text-compact font-medium text-pn';
  return (
    <div className={`@container/month w-full ${wide ? '' : 'max-w-[240px]'} mx-auto select-none`}>
      {onToday && (
        <button
          type="button"
          onClick={onToday}
          className="mb-2 w-full flex items-baseline justify-between gap-3 px-3 py-2 rounded-lg text-start ring-[1.5px] ring-inset ring-accent hover:bg-accent/10 transition"
        >
          <span className="text-body font-medium text-pn">{t('backfillPopover.today')}</span>
          <span className="text-small tabular-nums font-semibold text-accent">{formatInstant(dayAtNoon(today), 'dayMonth')}</span>
        </button>
      )}
      {/* The month arrows sit together at the end, so they never read as the
          back arrow a menu puts at the start of the same row. */}
      <div className="flex items-center justify-between mb-1">
        {/* The title opens the month and year picker (#750); the week and
            month switch is its own button beside the arrows. */}
        <HoverLabel label={t('monthGrid.pickMonthTip')} position="below-start" disabled={picking} className="flex min-w-0">
          <button
            ref={titleRef}
            type="button"
            onClick={() => setPicking((p) => !p)}
            aria-expanded={picking}
            aria-label={t('monthGrid.pickMonth', { month: title })}
            className={`${titleClass} hover:bg-pn/5 transition`}
          >
            {heading}
            <CaretDown aria-hidden="true" className={`shrink-0 text-accent transition-transform ${picking ? 'rotate-180' : ''}`} />
          </button>
        </HoverLabel>
        <span className={`flex shrink-0 items-center @max-[207.98px]/month:[&_button]:w-7 ${picking ? 'invisible' : ''}`}>
          {/* The extra buttons step aside before the month name truncates:
              a host's button under 256 px, the week switch under 224 px
              (measured with the short name and its year, plus room for the
              longer short names of other languages). */}
          {onToggleWeeks && (
            <span className="contents @max-[223.98px]/month:hidden">
            <HoverLabel label={t(weeks === 6 ? 'monthGrid.showOneWeek' : 'monthGrid.showWholeMonth')} position="below" disabled={picking}>
              <button type="button" onClick={onToggleWeeks} aria-expanded={weeks === 6} aria-label={t(weeks === 6 ? 'monthGrid.showOneWeek' : 'monthGrid.showWholeMonth')} className={navBtn}>
                {weeks === 6 ? <CalendarDot aria-hidden="true" /> : <CalendarDots aria-hidden="true" />}
              </button>
            </HoverLabel>
            </span>
          )}
          <HoverLabel label={t(weeks === 1 ? 'monthGrid.previousWeek' : 'monthGrid.previousMonth')} position="below" disabled={picking}>
            <button type="button" onClick={() => setFocus(step(-1))} aria-label={t(weeks === 1 ? 'monthGrid.previousWeek' : 'monthGrid.previousMonth')} className={navBtn}>
              <CaretLeft aria-hidden="true" />
            </button>
          </HoverLabel>
          <HoverLabel label={t(weeks === 1 ? 'monthGrid.nextWeek' : 'monthGrid.nextMonth')} position={headerEnd ? 'below' : 'below-end'} disabled={picking}>
            <button type="button" onClick={() => setFocus(step(1))} aria-label={t(weeks === 1 ? 'monthGrid.nextWeek' : 'monthGrid.nextMonth')} className={navBtn}>
              <CaretRight aria-hidden="true" />
            </button>
          </HoverLabel>
          {headerEnd && <span className="contents @max-[255.98px]/month:hidden">{headerEnd}</span>}
        </span>
      </div>
      {picking && <MonthYearPanel focus={focus} onPick={(day) => { setFocus(day); closePicker(); }} onClose={closePicker} />}
      <div ref={gridRef} role="group" aria-label={title} onKeyDown={onKeyDown} className={`${picking ? 'hidden' : 'grid'} ${weekNumbers ? 'grid-cols-[1.5rem_repeat(7,minmax(0,1fr))]' : 'grid-cols-7'} gap-0.5 text-center`}>
        {weekNumbers && <div aria-hidden="true" />}
        {/* A grid with room (a phone-wide strip, a list band) names the
            weekdays as the large month does; a narrow one keeps one letter.
            A locale whose short names are whole words (pt-PT "domingo")
            keeps the letter too: seven of them do not fit a phone. */}
        {shortDays.map((short, i) => (
          <div key={i} aria-hidden="true" className={`min-w-0 truncate text-meta text-pn-muted ${weeks === 1 ? 'py-0.5 md:py-1' : 'py-1'}`}>
            <span className={shortFits ? '@min-[320px]/month:hidden' : ''}>{weekdayLabel(weekdayDate((weekStart + i) % 7), 'narrow')}</span>
            {shortFits && <span className="hidden @min-[320px]/month:inline">{short}</span>}
          </div>
        ))}
        {cells.map((day, n) => {
          const inMonth = weeks === 1 || sameMonth(day, focus);
          const isToday = day === today;
          const hasEntry = marked.has(day);
          const label = formatInstant(dayAtNoon(day), 'date');
          const found = hasEntry && marked.entriesOf ? marked.entriesOf(day) : [];
          const kinds = found.map((e) => e.space);
          const dots = hasEntry ? (found.length ? pickDots(found) : [{ space: null }]) : [];
          const spaces = new Set(kinds.filter((k) => k !== null));
          const spaceName = spaces.size === 1 ? t(spaces.has('work') ? 'spaces.work' : 'spaces.personal') : null;
          const isSelected = day === selected;
          const mood = moodOf && hasEntry ? moodOf(day) : undefined;
          const moodDisc = typeof mood === 'number';
          // Selected: a filled square. Today: a ring. A dotted day keeps its
          // dot in both, white on the fill, so no state hides another. In the
          // mood look a disc carries the mood, and selected and today become
          // an outline around it.
          const circle = moodDisc
            ? `font-semibold ${isSelected ? 'outline outline-2 outline-offset-1 outline-accent' : isToday ? 'outline outline-[1.5px] outline-offset-1 outline-accent' : ''} ${inMonth ? '' : 'opacity-60'}`
            : mood === 'written' && !isSelected
              ? `ring-[1.5px] ring-inset ring-current ${dayKindColor('journal')} ${isToday ? 'font-semibold' : ''} ${inMonth ? '' : 'opacity-60'}`
              : isSelected
                ? 'bg-accent-fill text-white font-semibold'
                : isToday
                  ? 'ring-[1.5px] ring-inset ring-accent text-accent font-semibold group-hover:bg-accent/10'
                  : `${inMonth ? 'text-pn' : 'text-pn-muted opacity-60'} group-hover:bg-pn/5`;
          const showDots = hasEntry && mood === undefined;
          return (
            <Fragment key={day}>
            {weekNumbers && n % 7 === 0 && (
              <div aria-hidden="true" className="flex items-center justify-center text-meta text-pn-muted tabular-nums">
                {rowWeek(cells.slice(n, n + 7), weekStart)}
              </div>
            )}
            <button
              type="button"
              data-day={day}
              tabIndex={day === focus ? 0 : -1}
              aria-label={
                moodDisc ? t('monthGrid.dayWithMood', { date: label, mood: t(`trackers:mood.anchor.${moodAnchor(mood)}`) })
                  : !hasEntry ? label
                  : kinds.length > 1 ? t('monthGrid.dayWithItems', { date: label, count: kinds.length })
                  : spaceName ? t('monthGrid.dayWithEntryIn', { date: label, space: spaceName })
                  : t('monthGrid.dayWithEntry', { date: label })
              }
              aria-current={isToday ? 'date' : undefined}
              aria-pressed={selected !== undefined ? isSelected : undefined}
              onClick={() => onPick(day)}
              onDragEnter={drop ? (e) => { if (drop.accepts(e)) { e.preventDefault(); setDropDay(day); } } : undefined}
              onDragOver={drop ? (e) => { if (drop.accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (dropDay !== day) setDropDay(day); } } : undefined}
              onDragLeave={drop ? () => setDropDay((d) => (d === day ? null : d)) : undefined}
              onDrop={drop ? (e) => { if (drop.accepts(e)) { e.preventDefault(); setDropDay(null); drop.onDrop(day, e); } } : undefined}
              className={`group min-w-0 flex items-center justify-center h-10 [@media(hover:none)]:h-11 outline-none rounded-lg ${dropDay === day ? 'ring-2 ring-inset ring-accent bg-accent/10' : ''}`}
            >
              <span
                className={`relative flex items-center justify-center w-full max-w-8 ${moodOf ? 'aspect-square rounded-full' : 'h-9 pb-2 rounded-lg'} text-compact tabular-nums transition group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-1 group-focus-visible:outline-accent ${circle}`}
                // A tint of the mood's color, not the color itself: the day's
                // number stays in the text color and the month stays calm.
                style={moodDisc ? { background: `color-mix(in srgb, ${moodColor(mood)} 32%, transparent)` } : undefined}
              >
                {dayAtNoon(day).getDate()}
                {showDots && (
                  // Under 240 px a day cell is too narrow for three dots, so
                  // the first one stays, a size smaller.
                  <span aria-hidden="true" className="absolute bottom-[6px] inset-x-0 flex justify-center gap-[3px] @max-[239.98px]/month:gap-[2px]">
                    {dots.map((dot, i) => (
                      <span
                        key={i}
                        className={`w-[5px] h-[5px] @max-[239.98px]/month:w-1 @max-[239.98px]/month:h-1 ${i >= 1 ? '@max-[239.98px]/month:hidden' : ''} ${dot.space === 'work' ? 'rounded-[1px]' : 'rounded-full'} ${isSelected ? 'bg-white' : `bg-current ${dot.kind ? dayKindColor(dot.kind) : 'text-accent'}`}`}
                      />
                    ))}
                  </span>
                )}
              </span>
            </button>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The large month: the same days, keys, week start and RTL mirror as the
 * small grid, with each day a grid cell. The number is the day's focusable
 * button (the roving tab stop), the content under it is the host's chips,
 * the empty space and the plus create. Weekends take a tint, other months
 * fade, today's number is a filled square.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (step 1)
 */
function LargeMonth({
  focus, today, title, cells, weekStart, weeks, gridRef, onKeyDown, onPrev, onNext, onJump, onToday, onPick,
  renderDay, renderWeek, onAdd, onDayMenu, headerEnd, headerBelow, headerStart, shortTitle, weekNumbers, drop,
}: {
  onDayMenu?: Props['onDayMenu'];
  headerStart?: ReactNode;
  shortTitle?: string;
  headerBelow?: ReactNode;
  focus: string;
  today: string;
  title: string;
  cells: string[];
  weekStart: number;
  weeks: 1 | 6;
  gridRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPrev: () => void;
  onNext: () => void;
  onJump: (day: string) => void;
  onToday?: () => void;
  onPick: (day: string) => void;
  renderDay?: Props['renderDay'];
  renderWeek?: Props['renderWeek'];
  onAdd?: (day: string) => void;
  headerEnd?: ReactNode;
  weekNumbers: boolean;
  drop?: Props['drop'];
}) {
  const { t } = useTranslation('shell');
  const [dropDay, setDropDay] = useState<string | null>(null);
  const rows = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const cols = weekNumbers ? 'grid-cols-[2rem_repeat(7,minmax(0,1fr))]' : 'grid-cols-7';
  return (
    <div className="flex flex-col w-full h-full min-h-0 select-none">
      <CalendarHeader
        start={headerStart}
        title={title}
        shortTitle={shortTitle}
        below={headerBelow}
        onPrev={onPrev}
        onNext={onNext}
        prevLabel={t(weeks === 1 ? 'monthGrid.previousWeek' : 'monthGrid.previousMonth')}
        nextLabel={t(weeks === 1 ? 'monthGrid.nextWeek' : 'monthGrid.nextMonth')}
        onToday={onToday}
        end={headerEnd}
        focus={focus}
        onJump={onJump}
      />
      {/* A row never goes below room for the number, two lanes of bars and a
          chip; a short window scrolls the month instead of cutting chips. */}
      <div role="grid" aria-label={title} ref={gridRef} onKeyDown={onKeyDown} className="flex-1 min-h-0 flex flex-col overflow-y-auto overscroll-contain">
        <div role="row" className={`sticky top-0 z-[2] bg-surface-2 shrink-0 grid ${cols} border-b border-divider`}>
          {weekNumbers && <div role="columnheader" aria-hidden="true" />}
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} role="columnheader" className="text-meta text-pn-muted text-center py-1">
              {weekdayLabel(weekdayDate((weekStart + i) % 7), 'short')}
            </div>
          ))}
        </div>
        {rows.map((days) => (
          <div key={days[0]} role="row" className={`relative flex-1 ${weeks === 1 ? 'min-h-0' : 'min-h-[5.5rem]'} grid ${cols} border-b border-divider last:border-b-0`}>
            {weekNumbers && (
              <div role="rowheader" className="text-meta text-pn-muted text-center pt-1.5 tabular-nums border-e border-divider">
                {rowWeek(days, weekStart)}
              </div>
            )}
            {days.map((day) => {
              const inMonth = weeks === 1 || sameMonth(day, focus);
              const isToday = day === today;
              const weekday = dayAtNoon(day).getDay();
              const weekend = weekday === 0 || weekday === 6;
              const label = formatInstant(dayAtNoon(day), 'date');
              return (
                <div
                  key={day}
                  role="gridcell"
                  aria-current={isToday ? 'date' : undefined}
                  data-cell={day}
                  onClick={onAdd ? (e) => { if (e.target === e.currentTarget) onAdd(day); } : undefined}
                  onContextMenu={onDayMenu ? (e) => { if (!e.defaultPrevented) onDayMenu(e, day); } : undefined}
                  onDragEnter={drop ? (e) => { if (drop.accepts(e)) { e.preventDefault(); setDropDay(day); } } : undefined}
                  onDragOver={drop ? (e) => { if (drop.accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (dropDay !== day) setDropDay(day); } } : undefined}
                  onDragLeave={drop ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDay((d) => (d === day ? null : d)); } : undefined}
                  onDrop={drop ? (e) => { if (drop.accepts(e)) { e.preventDefault(); setDropDay(null); drop.onDrop(day, e); } } : undefined}
                  className={`@container/cell group/cell relative min-w-0 min-h-0 overflow-hidden flex flex-col gap-px p-1 border-e border-divider last:border-e-0 ${
                    dropDay === day ? 'ring-2 ring-inset ring-accent bg-accent/10'
                      : isToday ? 'bg-accent/5' : weekend ? 'bg-pn/[0.03]' : ''
                  }`}
                >
                  <div className="shrink-0 flex items-center justify-between pointer-events-none">
                    <button
                      type="button"
                      data-day={day}
                      tabIndex={day === focus ? 0 : -1}
                      aria-label={label}
                      onClick={() => onPick(day)}
                      className={`pointer-events-auto inline-flex items-center justify-center min-w-6 h-6 px-1 rounded-md text-small tabular-nums transition outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                        isToday ? 'bg-accent-fill text-white font-bold' : `${inMonth ? 'text-pn font-medium' : 'text-pn-muted opacity-60'} hover:bg-pn/5`
                      }`}
                    >
                      {dayAtNoon(day).getDate()}
                    </button>
                    {onAdd && (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => onAdd(day)}
                        aria-label={t('calendar.addOn', { date: label })}
                        className="pointer-events-auto hidden group-hover/cell:inline-flex [@media(hover:none)]:hidden items-center justify-center w-5 h-5 rounded border border-dashed border-divider text-pn-muted hover:text-accent hover:border-accent transition"
                      >
                        <Plus aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <div className={`min-h-0 flex flex-col gap-px ${inMonth ? '' : 'opacity-55'}`}>
                    {renderDay?.(day, { inMonth, isToday })}
                  </div>
                </div>
              );
            })}
            {renderWeek?.(days)}
          </div>
        ))}
      </div>
    </div>
  );
}

const HEADER_NAV = 'inline-flex items-center justify-center w-8 h-8 [@media(hover:none)]:w-10 [@media(hover:none)]:h-10 rounded-md text-accent hover:bg-pn/5 transition';

/** The header of every large calendar layout, two fixed rows: the title,
 *  the arrows together, Today and the host's controls (the view switch) at
 *  the end; under them the host's second row (the legend), left-aligned. A
 *  narrow pane shows the short title, so row one never wraps. */
export function CalendarHeader({ title, shortTitle, onPrev, onNext, prevLabel, nextLabel, onToday, end, below, start, focus, onJump }: {
  /** With `onJump`: the day shown, for the month and year picker the title opens (#750). */
  focus?: string;
  onJump?: (day: string) => void;
  /** Before the title: the agenda button, and the drawer button where nothing else on screen opens it. */
  start?: ReactNode;
  title: string;
  shortTitle?: string;
  onPrev: () => void;
  onNext: () => void;
  prevLabel: string;
  nextLabel: string;
  onToday?: () => void;
  end?: ReactNode;
  below?: ReactNode;
}) {
  const { t } = useTranslation('shell');
  const [picking, setPicking] = useState(false);
  const titleRef = useRef<HTMLButtonElement | null>(null);
  const closePicker = () => {
    setPicking(false);
    titleRef.current?.focus();
  };
  const heading = shortTitle ? (
    <>
      <span aria-hidden="true" className="@min-[520px]/calhead:hidden">{shortTitle}</span>
      <span aria-hidden="true" className="hidden @min-[520px]/calhead:inline">{title}</span>
      <span className="sr-only">{title}</span>
    </>
  ) : title;
  return (
    <div className="@container/calhead shrink-0 flex flex-col gap-1 px-3 py-2 border-b border-divider">
      <div className="flex items-center gap-1.5 min-w-0">
        {start}
        {/* Today and the arrows come before the title, so a longer or
            shorter month, week or day name never moves them between two
            clicks (#748). */}
        {onToday && (
          <button type="button" onClick={onToday} className="shrink-0 h-7 px-2.5 rounded-md border border-divider text-compact font-medium text-pn hover:border-accent hover:text-accent transition">
            {t('backfillPopover.today')}
          </button>
        )}
        <span className="shrink-0 flex items-center">
          <HoverLabel label={prevLabel} position="below">
            <button type="button" onClick={onPrev} aria-label={prevLabel} className={HEADER_NAV}>
              <CaretLeft aria-hidden="true" />
            </button>
          </HoverLabel>
          <HoverLabel label={nextLabel} position="below">
            <button type="button" onClick={onNext} aria-label={nextLabel} className={HEADER_NAV}>
              <CaretRight aria-hidden="true" />
            </button>
          </HoverLabel>
        </span>
        <h2 aria-live="polite" className="min-w-0 flex text-title font-semibold text-pn ms-1">
          {focus && onJump ? (
            <HoverLabel label={t('monthGrid.pickMonthTip')} position="below-start" disabled={picking} className="flex min-w-0 text-body font-normal">
              <button
                ref={titleRef}
                type="button"
                onClick={() => setPicking((p) => !p)}
                aria-expanded={picking}
                aria-label={t('monthGrid.pickMonth', { month: title })}
                className="min-w-0 inline-flex items-center gap-1 rounded-md px-1 -mx-1 text-title font-semibold hover:bg-pn/5 transition"
              >
                <span className="min-w-0 truncate">{heading}</span>
                <CaretDown aria-hidden="true" className={`shrink-0 text-accent transition-transform ${picking ? 'rotate-180' : ''}`} />
              </button>
            </HoverLabel>
          ) : <span className="min-w-0 truncate">{heading}</span>}
        </h2>
        {focus && onJump && (
          <Popover open={picking} anchorRef={titleRef} onClose={() => setPicking(false)} className="w-64">
            <MonthYearPanel focus={focus} onPick={(day) => { onJump(day); closePicker(); }} onClose={closePicker} />
          </Popover>
        )}
        <span className="flex-1" />
        {end && <span className="shrink-0">{end}</span>}
      </div>
      {below && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">{below}</div>}
    </div>
  );
}
