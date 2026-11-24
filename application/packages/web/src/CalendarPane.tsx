import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellSimple, Calendar, Columns, Download, Gear, Gift, Globe, GridNine, List, ListDashes, Repeat, Ruler } from './icons';
import { SPACE_ICONS } from './SpaceSwitch';
import { typeGlyph } from './NoteRow';
import { Switch } from './Switch';
import { HoverLabel } from './HoverLabel';
import { keyText } from './shortcutMatch';
import { CalendarHeader, MonthGrid, addDays, dayAtNoon, dayKindColor, monthCells, useWeekStart, weekCells, type DayCounter } from './MonthGrid';
import { DayCountStrip } from './DayCountStrip';
import { chooseEnd, countDays, pickDay, shownCount, startCount, swapDays, typeDays, type DayCountState } from './dayCount';
import { CalendarGrid } from './CalendarGrid';
import { DayChooser, timeLabel, useEntryLook } from './JournalCalendar';
import { PathGlyph } from './looks/LookGlyph';
import { dayChips, entryKey, lanesUsed, weekBars, type TimedBlock } from './calendarLayout';
import { formatInstant, toLocalIso } from './intlFormat';
import { intlLocale } from './languages';
import { isItemDrag, readItemDrag, writeItemDrag } from './itemDrag';
import { usePopoverPosition } from './usePopoverPosition';
import { useEscapeToClose } from './useEscapeToClose';
import type { DayEntry, DayIndex, DayKind } from './notesViewUtils';
import type { Space } from './spaces';
import type { CalendarPillar } from './notesView/useCalendarPillar';
import { dayNumber } from './schedule';
import { setHiddenKinds, useHiddenKinds } from './calendarLegend';
import { DayMarks, TrackersMenu, type CalendarTrackers } from './CalendarTrackers';

/**
 * The Calendar pillar's editor pane: Day, Week or Month over one index. The
 * month is `MonthGrid` at its large size with chips and the multi-day bars in
 * lanes; the day and the week are `CalendarGrid`, the hour layout. A chip
 * opens its item, an empty cell or hour creates, a chip or a bar dragged to
 * another day moves the whole schedule, the grip at a bar's end moves its end
 * day. Loaded on demand, so the boot chunk does not carry it.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (steps 1, 3, 4 and 5)
 */

/** The drag of a chip or a bar inside the calendar: which occurrence, the
 *  day it was grabbed on, and whether it is a bar's end grip. It rides with
 *  the item ids of a list drag, so a folder row in the sidebar still files it. */
const CAL_TYPE = 'application/x-privacynotes-calendar';
type CalDrag = { id: string; occurrence?: string; grab: string; edge?: 'end' };

/** A move the pane asks for: the item, its occurrence, and how many days
 *  (and, dropped on an hour, to which time) it goes. */
type CalendarMove = { id: string; occurrence?: string; days: number; time?: string };

const CHIP_PX = 18;
const NUMBER_PX = 28;

// ── The legend: which types show, per device (calendarLegend.ts) ─────

const LEGEND: readonly DayKind[] = ['event', 'note', 'task', 'journal', 'contact'];

// ── Drag helpers ──────────────────────────────────────────────────────

function writeCalDrag(e: React.DragEvent, data: CalDrag) {
  writeItemDrag(e.dataTransfer, [data.id], '');
  e.dataTransfer.setData(CAL_TYPE, JSON.stringify(data));
}
function readCalDrag(e: React.DragEvent): CalDrag | null {
  try {
    const v = JSON.parse(e.dataTransfer.getData(CAL_TYPE)) as Partial<CalDrag>;
    return typeof v.id === 'string' && typeof v.grab === 'string' ? (v as CalDrag) : null;
  } catch {
    return null;
  }
}
const accepts = (e: React.DragEvent) => isItemDrag(e.dataTransfer);

// ── A chip and a bar ──────────────────────────────────────────────────

/** A box whose current color is the item's own color when it has one, so
 *  a bar's fill and a timed card's edge and tint take it in place of the
 *  type color. */
function InkBox({ entry, className, style, children }: { entry: DayEntry; className: string; style?: React.CSSProperties; children: React.ReactNode }) {
  const { icon: ink } = useEntryLook(entry);
  return <div className={className} style={{ ...style, ...ink }}>{children}</div>;
}

/** The item's own icon, or its type's, in the item's own color when it has
 *  one; a globe for an event of a subscribed calendar (#619). */
function EntryGlyph({ entry, size = 12 }: { entry: DayEntry; size?: number }) {
  const { iconPaths, icon: style } = useEntryLook(entry);
  const { Icon } = typeGlyph(entry.kind);
  const Glyph = entry.feed ? Globe : entry.kind === 'contact' ? Gift : Icon;
  const className = `shrink-0 ${dayKindColor(entry.kind)}`;
  return iconPaths
    ? <PathGlyph paths={iconPaths} size={size} className={className} style={style} />
    : <Glyph size={size} aria-hidden="true" className={className} style={style} />;
}

/** The repeat glyph of a bar or a timed card, in the item's color, beside
 *  the stripes `.pn-repeat` draws (#811). */
function RepeatGlyph({ entry }: { entry: DayEntry }) {
  const { icon: ink } = useEntryLook(entry);
  return <Repeat size={10} aria-hidden="true" className={`shrink-0 ${dayKindColor(entry.kind)}`} style={ink} />;
}

/** One item in a cell: its type's icon, the time in front of a timed one,
 *  the title, then a bell, the repeat glyph and the briefcase of Work. */
/** The views, each with the icon its switch shows. */
const VIEW_MODES = [
  { mode: 'day', Icon: Calendar, key: 'calendarDay' },
  { mode: 'week', Icon: Columns, key: 'calendarWeek' },
  { mode: 'month', Icon: GridNine, key: 'calendarMonth' },
] as const;

/** A chip's, a bar's or a card's right-click menu. */
type ItemMenu = ((e: React.MouseEvent, entry: DayEntry) => void) | undefined;

function Chip({ entry, day, mixed, onOpen, onMenu }: { entry: DayEntry; day: string; mixed: boolean; onOpen: (e: DayEntry) => void; onMenu: ItemMenu }) {
  const { t } = useTranslation(['shell', 'common']);
  const title = entry.title || t('common:state.untitled');
  const SpaceGlyph = mixed && entry.space === 'work' ? SPACE_ICONS.work : null;
  const when = entry.time ? timeLabel(day, entry.time) : '';
  const { row } = useEntryLook(entry);
  return (
    <button
      type="button"
      style={row}
      draggable={entry.kind !== 'contact' && !entry.feed}
      onDragStart={(e) => writeCalDrag(e, { id: entry.id, occurrence: entry.occurrence, grab: day })}
      onClick={() => onOpen(entry)}
      onContextMenu={onMenu && !entry.feed ? (e) => onMenu(e, entry) : undefined}
      aria-label={[[when, title].filter(Boolean).join(' '), entry.feed].filter(Boolean).join(', ')}
      className="shrink-0 flex items-center gap-1 min-w-0 h-[17px] px-1 rounded text-meta leading-[15px] text-pn hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent text-start"
    >
      <span data-slot="icon" className="inline-flex shrink-0"><EntryGlyph entry={entry} /></span>
      {/* A narrow cell gives the title the room; the time stays in the label. */}
      {when && <span className="hidden @min-[128px]/cell:inline shrink-0 text-pn-muted tabular-nums text-meta">{when}</span>}
      <span data-slot="title" dir="auto" className="min-w-0 truncate">{title}</span>
      {entry.alerted && <BellSimple size={10} aria-hidden="true" className="shrink-0 text-accent" />}
      {entry.repeating && <Repeat size={10} aria-hidden="true" className="shrink-0 text-accent" />}
      {SpaceGlyph && <SpaceGlyph size={10} aria-hidden="true" className="shrink-0 text-accent" />}
    </button>
  );
}

/** The bars of one week row: a filled pill per multi-day item in its lane,
 *  flat where it runs past the row, with a grip at its end to move the end day.
 *  `passThrough` (the day counter is open): the bars take no pointer, so a
 *  click on one reaches the day cell under it, as a chip's click does. */
function Bars({ days, index, hidden, onOpen, onMenu, top, weekCol, passThrough = false }: {
  passThrough?: boolean;
  onMenu: ItemMenu;
  days: readonly string[];
  index: DayIndex;
  hidden: (e: DayEntry) => boolean;
  onOpen: (e: DayEntry) => void;
  top: number;
  weekCol: string;
}) {
  const { t } = useTranslation(['shell', 'common']);
  const { bars } = weekBars(days, index, hidden);
  const n = days.length;
  return (
    <>
      {bars.map((b) => {
        const title = b.entry.title || t('common:state.untitled');
        const span = b.endCol - b.startCol + 1;
        const color = dayKindColor(b.entry.kind);
        return (
          <InkBox
            key={entryKey(b.entry)}
            entry={b.entry}
            className={`absolute h-4 z-[1] px-0.5 ${passThrough ? 'pointer-events-none' : ''} ${color}`}
            style={{
              top: top + b.lane * CHIP_PX,
              insetInlineStart: `calc(${weekCol} + (100% - ${weekCol}) * ${b.startCol} / ${n})`,
              width: `calc((100% - ${weekCol}) * ${span} / ${n})`,
            }}
          >
            <div
              className={`h-full flex items-center bg-current/15 ${b.entry.repeating ? 'pn-repeat' : ''} ${b.contStart ? 'rounded-s-none' : 'rounded-s'} ${b.contEnd ? 'rounded-e-none' : 'rounded-e'}`}
            >
              <button
                type="button"
                draggable={!b.entry.feed}
                onDragStart={(e) => {
                  // The day under the pointer is the one grabbed, so a bar
                  // picked up by its middle keeps its length where it lands.
                  const r = e.currentTarget.getBoundingClientRect();
                  const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
                  const x = rtl ? r.right - e.clientX : e.clientX - r.left;
                  const col = Math.min(span - 1, Math.max(0, Math.floor((x / r.width) * span)));
                  writeCalDrag(e, { id: b.entry.id, occurrence: b.entry.span?.start, grab: days[b.startCol + col]! });
                }}
                onClick={() => onOpen(b.entry)}
                onContextMenu={onMenu && !b.entry.feed ? (e) => onMenu(e, b.entry) : undefined}
                aria-label={[title, b.entry.feed].filter(Boolean).join(', ')}
                className="flex-1 min-w-0 h-full flex items-center gap-1 px-1.5 text-meta font-semibold text-pn text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent rounded"
              >
                <span data-slot="icon" className="inline-flex shrink-0"><EntryGlyph entry={b.entry} size={11} /></span>
                <span data-slot="title" dir="auto" className="min-w-0 truncate">{title}</span>
                {b.entry.repeating && <RepeatGlyph entry={b.entry} />}
                {b.entry.space === 'work' && <SPACE_ICONS.work size={10} aria-hidden="true" className="shrink-0 ms-auto text-pn-muted" />}
              </button>
              {!b.contEnd && b.entry.kind !== 'contact' && !b.entry.feed && (
                <span
                  draggable
                  data-drag-handle
                  role="presentation"
                  onDragStart={(e) => writeCalDrag(e, { id: b.entry.id, occurrence: b.entry.span?.start, grab: b.entry.span!.end, edge: 'end' })}
                  title={t('calendar.dragEnd')}
                  className="shrink-0 w-2 h-full cursor-ew-resize flex items-center justify-center"
                >
                  <span className="w-[3px] h-2.5 rounded-full bg-current opacity-60" />
                </span>
              )}
            </div>
          </InkBox>
        );
      })}
    </>
  );
}

/** The "+N more" popover: the day's whole list, the rows of the card. */
function MorePopover({ day, index, anchor, onOpen, onClose }: { day: string; index: DayIndex; anchor: HTMLElement; onOpen: (e: DayEntry) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  const pos = usePopoverPosition(true, anchorRef, ref, { align: 'center' });
  useEscapeToClose(onClose);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={formatInstant(dayAtNoon(day), 'date')}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className="fixed z-50 w-[260px] max-w-[calc(100vw-16px)] rounded-md border border-divider bg-surface-2 shadow-lg p-2"
    >
      <div className="px-2 pb-1 text-small font-semibold text-pn-muted">{formatInstant(dayAtNoon(day), 'date')}</div>
      <DayChooser day={day} entries={index} bare onOpen={(e) => { onClose(); onOpen(e); }} onFold={onClose} />
    </div>
  );
}

// ── The pane ──────────────────────────────────────────────────────────

type Props = {
  index: DayIndex;
  pillar: CalendarPillar;
  onOpen: (id: string, occurrence?: string) => void;
  /** An item's right-click menu: the item menu, at the occurrence. */
  onItemMenu?: (e: React.MouseEvent, entry: DayEntry) => void;
  /** A right-click on a day's empty space. */
  onDayMenu?: (e: React.MouseEvent, day: string) => void;
  /** Create on a day, at a time and to an end time when given. */
  onAdd: (day: string, time?: string, timeEnd?: string) => void;
  onMove: (move: CalendarMove) => void;
  onResize: (id: string, occurrence: string | undefined, end: string) => void;
  /** List rows dropped on a day (and an hour). */
  onDropItems: (ids: string[], day: string, time?: string) => void;
  weekNumbers: boolean;
  firstHour: number;
  /** Opens the drawer, below lg where the folded agenda took its button along. */
  onMenu?: () => void;
  /** The agenda (the list pane) beside the grid: shown or folded, and the
   *  button that toggles it. Absent where the agenda is the whole screen. */
  agenda?: { open: boolean; toggle: () => void };
  /** Opens the Import tab, where the calendar file and webcal rows are. */
  onImport?: () => void;
  /** Opens Settings > Date & Time > Calendar, where the subscribed calendars
   *  and the other calendar settings are (#811). */
  onSettings?: () => void;
  /** The trackers shown on the days, and the legend's switches for them. */
  trackers?: CalendarTrackers | null;
};

export default function CalendarPane({ index, pillar, onOpen, onItemMenu, onDayMenu, onAdd, onMove, onResize, onDropItems, weekNumbers, firstHour, onMenu, agenda, onImport, onSettings, trackers = null }: Props) {
  const { t } = useTranslation(['shell', 'notes']);
  const { mode, setMode, focus, setFocus, goToday } = pillar;
  const hiddenKinds = useHiddenKinds();
  const hidden = (e: DayEntry) => hiddenKinds.has(e.kind);
  const shown = useMemo<DayIndex>(() => ({
    has: (day) => index.entriesOf(day).some((e) => !hiddenKinds.has(e.kind)),
    entriesOf: (day) => index.entriesOf(day).filter((e) => !hiddenKinds.has(e.kind)),
  }), [index, hiddenKinds]);
  const locale = intlLocale();
  const weekStart = useWeekStart();
  const today = toLocalIso(new Date());
  const [more, setMore] = useState<{ day: string; anchor: HTMLElement } | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const [cellH, setCellH] = useState(96);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el || mode !== 'month') return;
    const measure = () => {
      const cell = el.querySelector<HTMLElement>('[role="gridcell"]');
      if (cell) setCellH(cell.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  const open = (e: DayEntry) => onOpen(e.id, e.occurrence ?? e.span?.start);
  const drop = {
    accepts,
    onDrop: (day: string, e: React.DragEvent) => {
      const cal = readCalDrag(e);
      if (cal?.edge === 'end') onResize(cal.id, cal.occurrence, day);
      else if (cal) onMove({ id: cal.id, occurrence: cal.occurrence, days: dayNumber(day) - dayNumber(cal.grab) });
      else onDropItems(readItemDrag(e.dataTransfer), day);
    },
  };

  // The day counter (#815). Its days live in the pillar; while it is picking,
  // the day under the pointer is the preview, shown in place of the day that
  // moves. A click locks the day: the pointer no longer moves it. The
  // preview belongs to the screen it was taken on (the view, the day in
  // focus, the tile pressed): a grid that goes away fires no mouseleave, and
  // a touch screen none at all, so a preview from another screen is dropped.
  // Spec: docs/internal/specs/calendar-pillar-spec.md (section 15)
  const { count, setCount, countBoth, setCountBoth } = pillar;
  const hoverKey = `${mode}|${focus}|${count?.end}|${count?.picking}`;
  const [hover, setHover] = useState<{ day: string; key: string } | null>(null);
  const update = (next: DayCountState | null) => { setCount(next); setHover(null); };
  const closeCount = () => update(null);
  useEscapeToClose(closeCount, count !== null, true);
  const shownDays = count ? shownCount(count, hover?.key === hoverKey ? hover.day : null) : null;
  const liveDays = shownDays?.to ? countDays(shownDays.from, shownDays.to, countBoth).days : 0;
  const counter: DayCounter = {
    active: count !== null,
    lo: shownDays?.lo ?? null,
    hi: shownDays?.hi ?? null,
    // Nothing counts before To is picked.
    hiCounted: countBoth && shownDays?.to != null,
    // The day that moves wears its distance from the other one: +35, -35.
    badge: shownDays?.moving && shownDays.anchor && liveDays > 0
      ? { day: shownDays.moving, text: new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' }).format(Math.sign(dayNumber(shownDays.moving) - dayNumber(shownDays.anchor) || 1) * liveDays) }
      : null,
    // A shift-click with no count open starts one from today.
    pick: (day) => update(pickDay(count, day, today)),
    hover: (day) => { if (count?.picking) setHover(day ? { day, key: hoverKey } : null); },
  };
  const countStrip = count && (
    <DayCountStrip
      count={count}
      preview={shownDays?.preview ?? null}
      both={countBoth}
      onBoth={setCountBoth}
      onEnd={(end) => update(chooseEnd(count, end))}
      onDays={(days) => {
        // A press on minus or plus (from the keyboard; a mouse has left the
        // grid) while a day is previewed starts from the day on screen.
        const base = shownDays?.preview ? pickDay(count, shownDays.preview, today) : count;
        const next = typeDays(base, days, countBoth);
        update(next);
        setFocus(next[next.end] ?? focus);
      }}
      onSwap={() => update(swapDays(count))}
      onClose={closeCount}
    />
  );
  const countLabel = t('calendar.count.tool');

  // The segmented control of Settings (Auto, Light, Dark): the track, the
  // raised option, an icon each. A narrow header keeps the icons; the tip
  // names each one and its key at every width.
  const viewSwitch = (
    <div role="group" aria-label={t('calendar.viewLabel')} className="shrink-0 flex gap-1 rounded-md bg-track p-1">
      {VIEW_MODES.map(({ mode: m, Icon, key }) => (
        <HoverLabel key={m} label={t(`calendar.views.${m}`)} keys={keyText(key)} position="below">
          <button
            type="button"
            aria-pressed={mode === m}
            aria-label={t(`calendar.views.${m}`)}
            onClick={() => setMode(m)}
            className={`inline-flex items-center gap-1.5 h-6 px-1.5 @min-[420px]/calhead:px-2.5 rounded text-small transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              mode === m ? 'bg-surface-2 shadow-sm text-pn font-semibold' : 'text-pn-soft hover:text-pn font-medium'
            }`}
          >
            <Icon aria-hidden="true" />
            <span aria-hidden="true" className="hidden @min-[420px]/calhead:inline">{t(`calendar.views.${m}`)}</span>
          </button>
        </HoverLabel>
      ))}
    </div>
  );

  // The kinds on the left; the space switch at the end of the row, under the
  // view switch, since it is a view setting too.
  const legend = (
    <div className="w-full flex flex-wrap items-center gap-x-4 gap-y-1">
    <div role="group" aria-label={t('calendar.legendLabel')} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {LEGEND.map((kind) => {
        const off = hiddenKinds.has(kind);
        const { Icon } = typeGlyph(kind);
        const Glyph = kind === 'contact' ? Gift : Icon;
        return (
          <HoverLabel key={kind} label={t(`calendar.kinds.${kind}`)} position="below" className="@min-[560px]/calhead:[&>:last-child]:hidden">
            <button
              type="button"
              aria-pressed={!off}
              aria-label={t(`calendar.kinds.${kind}`)}
              onClick={() => setHiddenKinds(off ? [...hiddenKinds].filter((k) => k !== kind) : [...hiddenKinds, kind])}
              className={`inline-flex items-center gap-1 min-h-6 text-small text-pn-muted hover:text-pn transition ${off ? 'opacity-45 line-through' : ''}`}
            >
              <Glyph aria-hidden="true" className={dayKindColor(kind)} />
              {/* A narrow header keeps the glyphs and names them on hover. */}
              <span aria-hidden="true" className="hidden @min-[560px]/calhead:inline">{t(`calendar.kinds.${kind}`)}</span>
            </button>
          </HoverLabel>
        );
      })}
      {trackers && trackers.choices.length > 0 && <TrackersMenu trackers={trackers} />}
    </div>
    </div>
  );

  // Import mirrors the agenda button: the toolbar starts and ends with one
  // square tool. It opens the Import tab, where the calendar rows are.
  // The gear sits beside it, in the same look, and opens Settings > Date &
  // Time > Calendar, where the subscribed calendars are (#811: one place for
  // them, in place of a Subscribe window of its own). The day counter's tool
  // comes first and hides last (under 316px; a shift-click on a day and the
  // day's menu still start it). Import shows from 636px and the gear from
  // 672px: narrower, they took the month title's room (#815, measured with
  // the view switch's labels); Settings is their way in.
  // Spec: docs/internal/issues/0548.md (Spec, the calendar's door), docs/internal/specs/calendar-pillar-spec.md (section 14)
  const settingsLabel = `${t('contextMenu.settings')}: ${t('notes:settings.dateLabel')}`;
  // The day counter's tool comes first: it acts on the days on screen.
  const countTool = (
    <HoverLabel label={countLabel} position="below-end" className="hidden @min-[316px]/calhead:block">
      <button
        type="button"
        onClick={() => (count ? closeCount() : update(startCount(today)))}
        aria-label={countLabel}
        aria-pressed={count !== null}
        className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md border transition ${
          count ? 'bg-accent/10 border-accent/40 text-accent' : 'border-divider text-pn-muted hover:border-accent hover:text-accent'
        }`}
      >
        <Ruler aria-hidden="true" />
      </button>
    </HoverLabel>
  );
  const headerEnd = (
    <span className="flex items-center gap-2">
      {countTool}
      {onImport && (
        <HoverLabel label={t('calendar.importLabel')} position="below-end" className="hidden @min-[636px]/calhead:block">
          <button
            type="button"
            onClick={onImport}
            aria-label={t('calendar.importLabel')}
            className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md border border-divider text-pn-muted hover:border-accent hover:text-accent transition"
          >
            <Download aria-hidden="true" />
          </button>
        </HoverLabel>
      )}
      {onSettings && (
        <HoverLabel label={settingsLabel} position="below-end" className="hidden @min-[672px]/calhead:block">
          <button
            type="button"
            onClick={onSettings}
            aria-label={settingsLabel}
            className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md border border-divider text-pn-muted hover:border-accent hover:text-accent transition"
          >
            <Gear aria-hidden="true" />
          </button>
        </HoverLabel>
      )}
      {viewSwitch}
    </span>
  );
  // The agenda button names what it does on hover, and wears the pressed
  // look while the agenda is open, so a folded agenda is never a secret.
  const agendaLabel = agenda ? t(agenda.open ? 'calendar.hideAgenda' : 'calendar.showAgenda') : '';
  const headerStart = onMenu || agenda ? (
    <>
      {onMenu && (
        <button type="button" onClick={onMenu} aria-label={t('mobileHeader.openMenu')} className="shrink-0 rounded p-1.5 -ms-1 text-pn-muted hover:bg-pn/10 transition">
          <List size={20} />
        </button>
      )}
      {agenda && (
        <HoverLabel label={agendaLabel} position="below-start">
          <button
            type="button"
            onClick={agenda.toggle}
            aria-label={agendaLabel}
            aria-pressed={agenda.open}
            className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md border transition ${
              agenda.open ? 'bg-accent/10 border-accent/40 text-accent' : 'border-divider text-pn-muted hover:border-accent hover:text-accent'
            }`}
          >
            <ListDashes aria-hidden="true" />
          </button>
        </HoverLabel>
      )}
    </>
  ) : null;

  /** A day's chips under `lanes` lanes of bars, as many as `fit`, then "+N more". */
  const dayContent = (day: string, entries: readonly DayEntry[], lanes: number, fit: number, overBars: number) => {
    const { chips, more: extra } = dayChips(entries, fit, overBars);
    const mixed = new Set(shown.entriesOf(day).map((e) => e.space)).size > 1;
    return (
      <>
        {lanes > 0 && <div aria-hidden="true" style={{ height: lanes * CHIP_PX }} className="shrink-0" />}
        {chips.map((e) => <Chip key={entryKey(e)} entry={e} day={day} mixed={mixed} onOpen={open} onMenu={onItemMenu} />)}
        {extra > 0 && (
          <button
            type="button"
            onClick={(ev) => setMore({ day, anchor: ev.currentTarget })}
            className="shrink-0 self-start px-1 text-meta font-semibold text-accent hover:underline"
          >
            {t('calendar.more', { count: extra })}
          </button>
        )}
      </>
    );
  };

  let content: React.ReactNode;
  if (mode === 'month') {
    const weekCol = weekNumbers ? '2rem' : '0px';
    const rowLanes = new Map<string, { lanes: number; over: Map<string, number> }>();
    const cells = monthCells(focus, weekStart);
    for (let i = 0; i < cells.length; i += 7) {
      const days = cells.slice(i, i + 7);
      const { bars, hidden: over } = weekBars(days, shown);
      for (const d of days) rowLanes.set(d, { lanes: lanesUsed(bars), over });
    }
    content = (
      <MonthGrid
        onDayMenu={onDayMenu}
        size="large"
        marked={shown}
        focus={focus}
        onFocusChange={setFocus}
        onPick={(day) => { setFocus(day); setMode('day'); }}
        onToday={goToday}
        onAdd={(day) => onAdd(day)}
        headerEnd={headerEnd}
        headerBelow={<>{legend}{countStrip}</>}
        counter={counter}
        headerStart={headerStart}
        weekNumbers={weekNumbers}
        drop={drop}
        {...(trackers && trackers.shown.length > 0 ? {
          renderDayBadge: (day: string) => <DayMarks day={day} marks={trackers.marks(day)} onOpenEntry={trackers.onOpenEntry} onOpenStats={trackers.onOpenStats} cell />,
        } : {})}
        renderDay={(day) => {
          const row = rowLanes.get(day);
          const lanes = row?.lanes ?? 0;
          // Whole chips only: a cell with no room for one shows "+N more".
          const fit = Math.max(0, Math.floor((cellH - NUMBER_PX - 4 - lanes * CHIP_PX) / CHIP_PX));
          return dayContent(day, shown.entriesOf(day), lanes, fit, row?.over.get(day) ?? 0);
        }}
        renderWeek={(days) => <Bars days={days} index={shown} hidden={hidden} onOpen={open} onMenu={onItemMenu} top={NUMBER_PX} weekCol={weekCol} passThrough={count !== null} />}
      />
    );
  } else {
    const days = mode === 'week' ? weekCells(focus, weekStart) : [focus];
    const shortTitle = mode === 'day' ? formatInstant(dayAtNoon(focus), 'weekdayDate') : formatInstant(dayAtNoon(days[0]!), 'dayMonth');
    const title = mode === 'day'
      ? formatInstant(dayAtNoon(focus), 'date')
      : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }) // date-ok: a week heading is a range, which no named style writes
        .formatRange(dayAtNoon(days[0]!), dayAtNoon(days[6]!));
    const stepDays = mode === 'week' ? 7 : 1;
    const band = weekBars(days, shown);
    const bandLanes = lanesUsed(band.bars);
    content = (
      <div className="flex flex-col h-full min-h-0">
        <CalendarHeader
          title={title}
          shortTitle={shortTitle}
          onPrev={() => setFocus(addDays(focus, -stepDays))}
          onNext={() => setFocus(addDays(focus, stepDays))}
          prevLabel={t(mode === 'week' ? 'monthGrid.previousWeek' : 'calendar.previousDay')}
          nextLabel={t(mode === 'week' ? 'monthGrid.nextWeek' : 'calendar.nextDay')}
          onToday={goToday}
          end={headerEnd}
          below={<>{legend}{countStrip}</>}
          start={headerStart}
          focus={focus}
          onJump={setFocus}
        />
        <CalendarGrid
          days={days}
          index={shown}
          hidden={hidden}
          firstHour={firstHour}
          scrollRef={pillar.hourScroll}
          renderAllDay={(day) => dayContent(day, shown.entriesOf(day).filter((e) => !e.time), bandLanes, 3, band.hidden.get(day) ?? 0)}
          {...(trackers && trackers.shown.length > 0 ? {
            renderDayHead: (day: string) => {
              const marks = trackers.marks(day);
              return marks.length ? <DayMarks day={day} marks={marks} onOpenEntry={trackers.onOpenEntry} onOpenStats={trackers.onOpenStats} max={2} /> : null;
            },
          } : {})}
          renderBars={(ds) => <Bars days={ds} index={shown} hidden={hidden} onOpen={open} onMenu={onItemMenu} top={4} weekCol="4rem" passThrough={count !== null} />}
          renderCard={(b: TimedBlock, day) => <TimedCard block={b} day={day} onOpen={open} onMenu={onItemMenu} />}
          onCreate={(day, start, end) => onAdd(day, start, end)}
          onPickDay={(day) => { setFocus(day); setMode('day'); }}
          counter={counter}
          accepts={accepts}
          onDropAt={(e, day, time) => {
            const cal = readCalDrag(e);
            if (cal && !cal.edge) onMove({ id: cal.id, occurrence: cal.occurrence, days: dayNumber(day) - dayNumber(cal.grab), time });
            else if (!cal) onDropItems(readItemDrag(e.dataTransfer), day, time);
          }}
        />
      </div>
    );
  }

  return (
    <div ref={body} className="flex-1 min-h-0 flex flex-col">
      {content}
      {more && <MorePopover day={more.day} index={shown} anchor={more.anchor} onOpen={open} onClose={() => setMore(null)} />}
    </div>
  );
}

/** A timed item on the hour grid: the type color's tint with its edge, the
 *  title, then the time. */
function TimedCard({ block, day, onOpen, onMenu }: { block: TimedBlock; day: string; onOpen: (e: DayEntry) => void; onMenu: ItemMenu }) {
  const { t } = useTranslation(['shell', 'common']);
  const e = block.entry;
  const title = e.title || t('common:state.untitled');
  const start = block.carried ? '' : e.time ? timeLabel(day, e.time) : '';
  const end = e.timeEnd ? timeLabel(day, e.timeEnd) : '';
  const { icon: ink } = useEntryLook(e);
  return (
    <button
      style={ink}
      type="button"
      draggable={!block.carried && !e.feed}
      onDragStart={(ev) => writeCalDrag(ev, { id: e.id, occurrence: e.occurrence, grab: day })}
      onClick={() => onOpen(e)}
      onContextMenu={onMenu && !e.feed ? (ev) => onMenu(ev, e) : undefined}
      aria-label={[title, start && end ? `${start} - ${end}` : start, e.feed].filter(Boolean).join(', ')}
      className={`pn-timed-card w-full h-full overflow-hidden rounded-md border-s-[3px] border-current bg-current/15 px-1.5 py-0.5 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${e.repeating ? 'border-dashed pn-repeat' : ''} ${dayKindColor(e.kind)}`}
    >
      <span className="flex items-center gap-1 text-meta font-semibold text-pn">
        <span data-slot="icon" className="inline-flex shrink-0"><EntryGlyph entry={e} size={11} /></span>
        <span dir="auto" className="min-w-0 truncate">{title}</span>
        {e.alerted && <BellSimple size={10} aria-hidden="true" className="shrink-0 text-pn-muted" />}
        {e.repeating && <RepeatGlyph entry={e} />}
        {e.space === 'work' && <SPACE_ICONS.work size={10} aria-hidden="true" className="shrink-0 text-pn-muted" />}
      </span>
      {start && <span className="pn-timed-time block truncate text-meta text-pn-muted tabular-nums">{end ? `${start} - ${end}` : start}</span>}
    </button>
  );
}
