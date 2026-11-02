/**
 * Home: the grid of widgets in the list pane, arranged in place.
 *
 * There is no edit mode: every change is saved at once, like any setting.
 * The header always holds Add widget and Layouts (Reset is the last row of
 * Layouts). Each card carries a grip tab on its top edge: a tap opens its
 * menu (the sizes, the moves, the choice, Remove with Undo), a drag moves
 * it; with a mouse the tab and the resize corner show while the card is
 * hovered or focused, on touch the tab always shows and the menu resizes.
 * Each widget has a width in columns and a height in rows, and the packer
 * (packBoxes) places them for the pane's column count. The check-in and
 * calendar cards are their own grid items, placed and given the same tools.
 * Spec: docs/internal/specs/dashboard.md (sections 3 to 6)
 */
import { cloneElement, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalNote } from '../db';
import { ItemList, useItemList } from '../itemList';
import { proUnlocked } from '../demo';
import type { ContextMenuItem } from '../ContextMenu';
import { ProMark } from '../UpgradeModal';
import {
  Button, ContextMenu, DropLine, EmptyState, GridCard, IconButton, Snackbar, DRAG_SOURCE, halfOf, useContextMenu, usePointerReorder,
} from '../ui';
import { ArrowDown, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, CalendarCheck, ClockClockwise, DotsSix, NotePencil, PenNib, Plus, SquaresFour, Trash, PILLAR_GLYPHS } from '../icons';
import { useSteppedWidth } from '../useElementSize';
import { WIDGET_GLYPH, WidgetGlyph, widgetNameKey } from './widgetGlyphs';
import { formatDay } from '../intlFormat';
import { intlLocale } from '../languages';
import { toLocalIso } from '../notesViewUtils';
import { trackerName } from '../stats/wellnessModel';
import {
  HOME_COLS, HOME_GAP_PX, HOME_ROW_PX, LAYOUT_IDS, WIDGETS, addWidget, fillHoles, fitSize, fitsDashboard, isWidgetKind, layoutWidgets, moveWidget, packBoxes,
  removeWidget, resizeWidget, retargetWidget, type Box, type LayoutId, type Widget, type WidgetDef, type WidgetKind,
} from './dashboardLayout';
import { useDashboardEnv } from './env';
import {
  BirthdaysWidget, BookmarksWidget, CheckInStreakWidget, FilesWidget, FolderWidget, MilestoneWidget, NoteWidget, OnThisDayWidget,
  PinnedWidget, RecentWidget, RhythmWidget, StreakWidget, TagWidget, TasksWidget, TodayWidget, TrackerWidget, UpcomingWidget,
  WeekRecapWidget, WeekWidget, MonthModelContext, useBuildMonthModel, useOpenTasks, useTrackerChoices, useWritingStats,
} from './widgets';
import { WidgetCatalog, TargetChooser, type ChooserKind } from './WidgetCatalog';

const fmt = (n: number) => n.toLocaleString(intlLocale());

/** The widgets that are one number: they pair two to a row on a phone. */
const PAIRS: ReadonlySet<string> = new Set<WidgetKind>(['streak', 'checkInStreak', 'milestone']);
/** The widgets of a fixed height (a number, a recap): centred in a box made
 *  taller, where a list would start at the top. */
const CENTRED: ReadonlySet<string> = new Set<WidgetKind>([...PAIRS as Set<WidgetKind>, 'weekRecap']);

/** Columns for the pane's width: the steps of the list's tile grid
 *  (index.css), stopping at HOME_COLS. `narrow` is a phone's pane,
 *  where every widget takes the row except two numbers side by side.
 *  `width` is the grid's content box; the steps are for the pane, 32px more. */
function columnsFor(width: number): { cols: number; narrow: boolean } {
  const pane = width + 32;
  const cols = pane < 260 ? 1 : pane < 700 ? 2 : pane < 1040 ? 3 : HOME_COLS;
  return { cols, narrow: pane < 400 };
}

/**
 * The size each widget shows at a grid width, before packing: held to the
 * column count; on a phone the whole row except two numbers side by side (a
 * number with no number beside it takes the row too); as wide as its
 * content needs (`minWidthPx`) and as tall as its width asks (`heightAt`).
 */
function sizeWidgets(widgets: readonly Widget[], width: number, resizing: { id: string; w: number; h: number } | null) {
  const { cols, narrow } = columnsFor(width);
  // One column and its gap, in pixels.
  const colStep = (width - (cols - 1) * HOME_GAP_PX) / cols + HOME_GAP_PX;
  const span = (px: number) => Math.ceil((px + HOME_GAP_PX) / colStep);
  const shown = widgets.filter((w) => isWidgetKind(w.k));
  const items = shown.map((w, n) => {
    const live = resizing?.id === w.i ? resizing : w;
    const def: WidgetDef = WIDGETS[w.k as WidgetKind];
    const paired = PAIRS.has(w.k) && (PAIRS.has(shown[n - 1]?.k ?? '') || PAIRS.has(shown[n + 1]?.k ?? ''));
    let wide = narrow ? (paired ? 1 : cols) : Math.min(live.w, cols);
    if (def.minWidthPx) wide = Math.min(cols, Math.max(wide, span(def.minWidthPx)));
    let high = live.h;
    if (def.heightAt) {
      const need = def.heightAt(wide * colStep - HOME_GAP_PX);
      high = Math.max(high, Math.ceil((need + HOME_GAP_PX) / (HOME_ROW_PX + HOME_GAP_PX)));
    }
    return { id: w.i, w: wide, h: high };
  });
  return { cols, narrow, items };
}

const sizeKey = (s: ReturnType<typeof sizeWidgets>) => `${s.cols}${s.narrow ? 'n' : ''}:${s.items.map((b) => `${b.w}.${b.h}`).join(',')}`;

const placeOf = (b: Box): CSSProperties => ({ gridColumn: `${b.x + 1} / span ${b.w}`, gridRow: `${b.y + 2} / span ${b.h}` });

export default function Dashboard({ widgets, onWrite }: {
  widgets: Widget[];
  /** Saves a list; null is the stock layout (Reset). */
  onWrite: (next: Widget[] | null) => void;
}) {
  // Every namespace a key below names, so each is loaded before Home draws.
  const { t } = useTranslation(['shell', 'common', 'editor', 'notes', 'stats']);
  const { t: tStats } = useTranslation('stats');
  const env = useDashboardEnv();
  const today = toLocalIso(new Date());
  const { stats, live } = useWritingStats();
  const openTasks = useOpenTasks();
  const month = useBuildMonthModel();
  const trackers = useTrackerChoices(month);
  const menu = useContextMenu();
  const [snack, setSnack] = useState<{ text: string; undo?: Widget[] } | null>(null);
  const [catalog, setCatalog] = useState(false);
  const [chooser, setChooser] = useState<{ kind: ChooserKind; widgetId?: string } | null>(null);
  // The list shell every pane uses: the grid class, and the scroll place
  // kept across a phone's trip into a note and back.
  const list = useItemList(['dashboard'], widgets.length + 2, 'dashboard');
  const grid = list.ref;
  const [gridEl, setGridEl] = useState<HTMLElement | null>(null);
  // After every draw: the list element can be a new one (a remount), and a
  // width read from the old one would be 0.
  useLayoutEffect(() => {
    if (grid.current !== gridEl) setGridEl(grid.current);
  });
  // The size a widget shows while its corner is dragged, before it is saved.
  const [resizing, setResizing] = useState<{ id: string; w: number; h: number } | null>(null);
  // Home draws again only when a width step changes what it shows: the
  // columns, or the size of a card.
  const sizeAt = (width: number) => sizeWidgets(widgets, width, resizing);
  const [gridWidth, liveWidth] = useSteppedWidth(gridEl, (width) => sizeKey(sizeAt(width)));
  const sized = sizeAt(gridWidth);
  const { cols, narrow } = sized;
  const canEdit = !env.locked;
  // Where keyboard focus goes once a remove, a menu move or a key resize has
  // drawn: the grip or the resize handle of a widget by its id, or Add widget
  // (null). The removed card took the focused button with it, the menu's
  // close puts focus nowhere, and a card that moves in the order is a moved
  // node, which loses focus.
  const focusAfter = useRef<{ grip: string | null } | { resize: string } | null>(null);
  useEffect(() => {
    const next = focusAfter.current;
    if (!next) return;
    focusAfter.current = null;
    const selector = 'resize' in next
      ? `[data-home-resize="${CSS.escape(next.resize)}"]`
      : next.grip === null ? '[data-home-add]' : `[data-home-grip="${CSS.escape(next.grip)}"]`;
    grid.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [widgets, grid]);

  // A snackbar leaves on its own after a few seconds.
  useEffect(() => {
    if (!snack) return;
    const id = setTimeout(() => setSnack(null), 5000);
    return () => clearTimeout(id);
  }, [snack]);

  const save = (next: Widget[]) => {
    if (next === widgets || !fitsDashboard(next)) {
      setSnack({ text: t('dashboard.full') });
      return;
    }
    onWrite(next);
  };

  // Drag by the grip: the nearest card to the point, before or after it by
  // the half the point is in (mirrored in right-to-left).
  type Slot = { overId: string; place: 'before' | 'after'; axis: 'x' | 'y' };
  const orderFor = (id: string, slot: Slot): Widget[] => {
    const rest = widgets.filter((w) => w.i !== id);
    const at = rest.findIndex((w) => w.i === slot.overId) + (slot.place === 'after' ? 1 : 0);
    return moveWidget(widgets, id, at);
  };
  const { drag, pressProps, endedDrag } = usePointerReorder<Slot>({
    enabled: canEdit,
    resolve: (id, x, y) => {
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const el of grid.current?.querySelectorAll<HTMLElement>('[data-reorder-id]') ?? []) {
        const box = el.getBoundingClientRect();
        const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
        const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) {
          best = el;
          bestDist = dist;
        }
      }
      const overId = best?.dataset.reorderId;
      if (!best || !overId || overId === id) return null;
      // A card that fills its row (a phone, a large card) splits top and
      // bottom; one beside others splits start and end.
      const row = grid.current?.getBoundingClientRect().width ?? 0;
      const axis = best.getBoundingClientRect().width > row * 0.9 ? 'y' : 'x';
      const slot = { overId, place: halfOf(best, x, y, axis), axis } as Slot;
      const next = orderFor(id, slot);
      return next.every((w, i) => w.i === widgets[i]?.i) ? null : slot;
    },
    targetKey: (s) => `${s.overId}:${s.place}:${s.axis}`,
    onDrop: (id, slot) => onWrite(orderFor(id, slot)),
  });

  function openWidgetMenu(e: MouseEvent<HTMLButtonElement>, w: Widget) {
    if (endedDrag()) return;
    // Moves step over the widgets drawn here: one from a newer app is not
    // drawn, and stepping past it would look like nothing happened.
    const shown = widgets.filter((x) => isWidgetKind(x.k));
    const at = shown.findIndex((x) => x.i === w.i);
    const stepTo = (to: number) => {
      focusAfter.current = { grip: w.i };
      onWrite(moveWidget(widgets, w.i, widgets.findIndex((x) => x.i === shown[to]!.i)));
    };
    const kind = w.k as WidgetKind;
    const def = WIDGETS[kind];
    const box = e.currentTarget.getBoundingClientRect();
    const target = def.target;
    const resizeTo = (wide: number, high: number) => {
      focusAfter.current = { grip: w.i };
      onWrite(resizeWidget(widgets, w.i, wide, high));
    };
    // Wider stops at the pane's columns: a step past it would show nothing.
    const widest = Math.min(def.w[2], cols);
    menu.open(
      { clientX: box.left, clientY: box.bottom + 4, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() },
      [
        ...(narrow ? [] : [
          { label: t('notes:editor.widthWide'), icon: <ArrowRight className="rtl:-scale-x-100" />, disabled: w.w >= widest, onSelect: () => resizeTo(Math.min(w.w, cols) + 1, w.h) },
          { label: t('dashboard.narrower'), icon: <ArrowLeft className="rtl:-scale-x-100" />, disabled: Math.min(w.w, cols) <= def.w[0], onSelect: () => resizeTo(Math.min(w.w, cols) - 1, w.h) },
        ]),
        { label: t('dashboard.taller'), icon: <ArrowDown />, disabled: w.h >= def.h[2], onSelect: () => resizeTo(w.w, w.h + 1) },
        { label: t('dashboard.shorter'), icon: <ArrowUp />, disabled: w.h <= def.h[0], onSelect: () => resizeTo(w.w, w.h - 1) },
        { type: 'separator' as const },
        { label: t('dashboard.moveEarlier'), icon: <ArrowLeft className="rtl:-scale-x-100" />, disabled: at === 0, onSelect: () => stepTo(at - 1) },
        { label: t('dashboard.moveLater'), icon: <ArrowRight className="rtl:-scale-x-100" />, disabled: at === shown.length - 1, onSelect: () => stepTo(at + 1) },
        ...(target ? [{ type: 'separator' as const }, { label: t(`dashboard.choose${target[0]!.toUpperCase()}${target.slice(1)}`), icon: <WidgetGlyph kind={kind} />, onSelect: () => setChooser({ kind: target, widgetId: w.i }) }] : []),
        { type: 'separator' as const },
        {
          label: t('common:actions.remove'),
          icon: <Trash />,
          destructive: true,
          onSelect: () => {
            // The next card takes its place; the one before when it was last.
            focusAfter.current = { grip: (shown[at + 1] ?? shown[at - 1])?.i ?? null };
            const before = widgets;
            onWrite(removeWidget(widgets, w.i));
            setSnack({ text: t('dashboard.removed'), undo: before });
          },
        },
      ],
      e.detail === 0,
    );
  }

  function pickLayout(e: MouseEvent<HTMLButtonElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    menu.open(
      { clientX: box.left, clientY: box.bottom + 4, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() },
      [...LAYOUT_IDS.map((id: LayoutId): ContextMenuItem => ({
        label: t(id === 'journal' ? 'notes:newMenu.journal' : `dashboard.layout.${id}`),
        icon: <LayoutGlyph id={id} />,
        checked: sameLayout(widgets, layoutWidgets(id)),
        onSelect: () => {
          const before = widgets;
          onWrite(id === 'everyday' ? null : layoutWidgets(id));
          setSnack({ text: t('dashboard.layoutChanged'), undo: before });
        },
      })),
        { type: 'separator' },
        {
          label: t('settings:appearance.resetDefaults'),
          icon: <ClockClockwise aria-hidden="true" />,
          onSelect: () => {
            const before = widgets;
            onWrite(null);
            setSnack({ text: t('dashboard.layoutChanged'), undo: before });
          },
        },
      ],
      e.detail === 0,
    );
  }

  /** Add from the catalog. A widget that points at something asks first;
   *  any other is added and the catalog stays open, its plus now a minus. */
  function add(kind: WidgetKind) {
    const target = WIDGETS[kind].target;
    if (target) {
      setCatalog(false);
      setChooser({ kind: target });
      return;
    }
    save(addWidget(widgets, kind));
  }

  /** The catalog's minus: the one widget of that kind leaves Home. The plus
   *  beside it is the way back, so no snackbar. */
  function removeKind(kind: WidgetKind) {
    const w = widgets.find((x) => x.k === kind);
    if (w) onWrite(removeWidget(widgets, w.i));
  }

  function chosen(value: string) {
    const c = chooser;
    setChooser(null);
    if (!c) return;
    if (c.widgetId) {
      save(retargetWidget(widgets, c.widgetId, value));
      return;
    }
    const next = addWidget(widgets, c.kind, { r: value });
    save(next);
    if (next !== widgets) scrollToEnd();
  }

  function scrollToEnd() {
    requestAnimationFrame(() => grid.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }

  // The header line: what is on today, from the page's own numbers.
  const eventsToday = useMemo(() => env.calendarDays.entriesOf(today).filter((e) => e.kind === 'event').length, [env.calendarDays, today]);
  const summary = [
    eventsToday > 0 ? t('dashboard.headerEvents', { count: eventsToday, formatted: fmt(eventsToday) }) : null,
    openTasks.length > 0 ? t('dashboard.headerTasks', { count: openTasks.length, formatted: fmt(openTasks.length) }) : null,
    stats.currentStreak > 0 ? t('stats:milestone.streak', { count: stats.currentStreak }) : null,
  ].filter(Boolean).join(' · ');

  /** Where a target points, and whether it still exists. */
  function targetState(w: Widget): { state: 'ok' | 'gone' | 'otherSpace'; note?: LocalNote; title?: string } {
    const r = w.r;
    if (!r) return { state: 'gone' };
    if (w.k === 'note') {
      const note = env.everywhere.find((n) => n.id === r);
      if (!note) return { state: 'gone' };
      if (!env.listed.some((n) => n.id === r)) return { state: note.archived === 1 ? 'gone' : 'otherSpace', note };
      return { state: 'ok', note, title: note.title || t('common:state.untitled') };
    }
    if (w.k === 'tag') {
      if (env.listed.some((n) => n.tags.includes(r))) return { state: 'ok', title: `#${r}` };
      return { state: env.everywhere.some((n) => n.tags.includes(r)) ? 'otherSpace' : 'gone', title: `#${r}` };
    }
    if (w.k === 'folder') {
      const f = env.folders.find((x) => x.id === r);
      return f ? { state: 'ok', title: f.name } : { state: 'gone' };
    }
    if (w.k === 'tracker') {
      const d = trackers.find((x) => x.id === r);
      return d ? { state: 'ok', title: trackerName(d, tStats) } : { state: 'gone' };
    }
    return { state: 'ok' };
  }

  function content(w: Widget, kind: WidgetKind, target: ReturnType<typeof targetState>): ReactNode {
    switch (kind) {
      case 'upcoming': return <UpcomingWidget />;
      case 'today': return <TodayWidget />;
      case 'tasks': return <TasksWidget tasks={openTasks} />;
      case 'recent': return <RecentWidget />;
      case 'pinned': return <PinnedWidget />;
      case 'note': return target.note ? <NoteWidget note={target.note} /> : null;
      case 'tag': return <TagWidget tag={w.r!} />;
      case 'folder': return <FolderWidget folderId={w.r!} />;
      case 'onThisDay': return <OnThisDayWidget />;
      case 'week': return <WeekWidget stats={stats} live={live} />;
      case 'streak': return <StreakWidget stats={stats} />;
      case 'checkInStreak': return <CheckInStreakWidget />;
      case 'rhythm': return <RhythmWidget stats={stats} />;
      case 'milestone': return <MilestoneWidget stats={stats} />;
      case 'tracker': return <TrackerWidget trackerId={w.r!} />;
      case 'weekRecap': return <WeekRecapWidget />;
      case 'files': return <FilesWidget />;
      case 'bookmarks': return <BookmarksWidget />;
      case 'birthdays': return <BirthdaysWidget />;
      case 'checkIn':
      case 'calendar':
        return null;
    }
  }

  /** Where a widget's head link goes, if it has one. */
  function linkOf(kind: WidgetKind, w: Widget, target: ReturnType<typeof targetState>): { label: string; onClick: () => void } | undefined {
    if (target.state !== 'ok') return undefined;
    switch (kind) {
      case 'note': return target.note ? { label: t('contacts.open'), onClick: () => env.open(target.note!.id) } : undefined;
      case 'tag': return { label: t('tagsRail.allItems'), onClick: () => env.openTag(w.r!) };
      case 'folder': return { label: t('tagsRail.allItems'), onClick: () => env.openFolder(w.r!) };
      case 'upcoming': return { label: t('tagsRail.calendar'), onClick: () => env.goTo('calendar') };
      case 'tasks': return { label: t('tagsRail.tasks'), onClick: () => env.goTo('tasks') };
      case 'pinned': return { label: t('tagsRail.pinned'), onClick: () => env.goTo('starred') };
      case 'files': return { label: t('tagsRail.files'), onClick: () => env.goTo('files') };
      case 'bookmarks': return { label: t('tagsRail.bookmarks'), onClick: () => env.goTo('bookmarks') };
      case 'week':
      case 'rhythm':
        return { label: t('notes:settings.statsLabel'), onClick: env.openStats };
      default: return undefined;
    }
  }

  const shown = widgets.filter((w) => isWidgetKind(w.k));
  const packed = packBoxes(sized.items, cols);
  // The cards grow into the holes beside them; a resize starts from the
  // size before that growth, the one the widget asks for.
  const boxes = fillHoles(packed, cols);
  const askedOf = new Map(packed.map((b) => [b.id, b]));
  const byId = new Map(shown.map((w) => [w.i, w]));

  /** Drag the corner: the size follows the pointer in whole cells, the other
   *  widgets make room as it goes, and the size is saved on release. */
  function startResize(e: PointerEvent<HTMLButtonElement>, w: Widget, box: Box) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    // The live width: the drawn one is renewed only at a layout step.
    const colStep = (liveWidth.current - (cols - 1) * HOME_GAP_PX) / cols + HOME_GAP_PX;
    const rowStep = HOME_ROW_PX + HOME_GAP_PX;
    const rtl = getComputedStyle(handle).direction === 'rtl';
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last = { w: box.w, h: box.h };
    const move = (ev: globalThis.PointerEvent) => {
      const dx = (ev.clientX - x0) * (rtl ? -1 : 1);
      const wide = narrow ? box.w : Math.min(cols, Math.round(box.w + dx / colStep));
      const next = fitSize(w.k, wide, Math.round(box.h + (ev.clientY - y0) / rowStep));
      if (narrow) next.w = box.w;
      if (next.w === last.w && next.h === last.h) return;
      last = next;
      setResizing({ id: w.i, ...next });
    };
    // A release can come as pointerup, pointercancel, or only as the loss of
    // the capture (a drag the browser took over): each ends it, once.
    const events = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;
    const end = () => {
      handle.removeEventListener('pointermove', move);
      for (const type of events) handle.removeEventListener(type, end);
      setResizing(null);
      // A width held to a narrower pane is kept as it was saved.
      const wide = last.w === box.w ? w.w : last.w;
      if (wide !== w.w || last.h !== w.h) onWrite(resizeWidget(widgets, w.i, wide, last.h));
    };
    handle.addEventListener('pointermove', move);
    for (const type of events) handle.addEventListener(type, end);
  }

  /** The arrow keys on the corner: a column or a row at a time. */
  function keyResize(e: KeyboardEvent<HTMLButtonElement>, w: Widget, box: Box) {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const step: Record<string, [number, number]> = {
      ArrowRight: [rtl ? -1 : 1, 0], ArrowLeft: [rtl ? 1 : -1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1],
    };
    const d = step[e.key];
    if (!d) return;
    e.preventDefault();
    const wide = narrow || d[0] === 0 ? w.w : Math.min(cols, box.w + d[0]);
    const next = fitSize(w.k, wide, w.h + d[1]);
    if (next.w === w.w && next.h === w.h) return;
    focusAfter.current = { resize: w.i };
    onWrite(resizeWidget(widgets, w.i, next.w, next.h));
  }

  const cards: ReactNode[] = [];
  for (const box of boxes) {
    const w = byId.get(box.id)!;
    const kind = w.k as WidgetKind;
    const def = WIDGETS[kind];
    const name = t(widgetNameKey(kind));
    const place = placeOf(box);
    const target = def.target ? targetState(w) : { state: 'ok' as const };
    const dragTarget = drag?.target?.overId === w.i ? drag.target : null;
    const line = dragTarget && <DropLine edge={dragTarget.axis === 'y' ? (dragTarget.place === 'before' ? 'top' : 'bottom') : dragTarget.place === 'before' ? 'start' : 'end'} />;
    const sizing = resizing?.id === w.i;
    const asked = askedOf.get(w.i)!;
    // Always there, nothing to switch on: a grip tab on the card's top edge
    // (a tap opens the widget menu, a drag moves the card) and, for a mouse,
    // the resize corner. On a mouse both show while the card is hovered or
    // holds focus; on touch the tab always shows and the menu resizes.
    const controls = canEdit ? (
      <>
        {line}
        <button
          type="button"
          data-no-drag
          data-home-grip={w.i}
          aria-label={t('editor:formatBar.optionsFor', { item: name })}
          {...pressProps(w.i, { grip: true })}
          onClick={(e) => openWidgetMenu(e, w)}
          className="pn-card-ctl pn-card-grip absolute -top-2.5 left-1/2 z-10 flex h-5 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-divider bg-surface-2 text-pn-muted shadow-sm cursor-grab active:cursor-grabbing hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          <DotsSix aria-hidden="true" />
        </button>
        {sizing && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="rounded-md bg-surface-1 px-2 py-0.5 text-small tabular-nums text-pn shadow-sm">{resizing.w} × {resizing.h}</span>
          </span>
        )}
        <button
          type="button"
          data-no-drag
          data-home-resize={w.i}
          aria-label={t('dashboard.resize', { name })}
          onPointerDown={(e) => startResize(e, w, asked)}
          onKeyDown={(e) => keyResize(e, w, asked)}
          className="pn-card-ctl pn-card-resize absolute bottom-1 end-1 z-10 flex h-7 w-7 touch-none items-center justify-center rounded-md bg-surface-2 text-pn-muted hover:bg-pn/5 hover:text-pn cursor-nwse-resize rtl:cursor-nesw-resize focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ArrowDownRight aria-hidden="true" className="rtl:-scale-x-100" />
        </button>
      </>
    ) : line || undefined;
    const common = {
      'data-reorder-id': w.i,
      style: place,
      icon: WIDGET_GLYPH[kind],
      controls,
      className: `${drag?.id === w.i ? DRAG_SOURCE : ''} ${sizing ? 'ring-2 ring-accent' : ''}`,
    };

    // The two cards that are their own grid items.
    if (kind === 'checkIn' || kind === 'calendar') {
      const card = kind === 'checkIn' ? env.checkInCard : env.calendarCard;
      if (isValidElement(card)) {
        cards.push(cloneElement(card as ReactElement<{ style?: CSSProperties; controls?: ReactNode; reorderId?: string }>, {
          key: w.i, style: place, controls, reorderId: w.i,
        }));
      }
      continue;
    }
    // A Pro widget on an account without Pro: the door, not the content.
    if (def.pro && !env.unlocked) {
      cards.push(
        <GridCard key={w.i} {...common} title={name}>
          <div className="flex flex-col items-center gap-2 py-3 text-center">
            <ProMark />
            <Button action="open" pro onClick={env.onUpgrade}>{t('dashboard.proLocked')}</Button>
          </div>
        </GridCard>,
      );
      continue;
    }
    const title = def.target ? target.title ?? name : PAIRS.has(kind) ? undefined : name;
    let body: ReactNode;
    if (def.target && target.state !== 'ok') {
      body = (
        <div className="flex flex-col items-center gap-1 pb-2">
          <EmptyState compact>{t(target.state === 'gone' ? 'dashboard.gone' : 'dashboard.otherSpace')}</EmptyState>
          {canEdit && <Button action="edit" onClick={() => setChooser({ kind: def.target!, widgetId: w.i })}>{t('dashboard.choose')}</Button>}
        </div>
      );
    } else {
      body = content(w, kind, target);
      if (CENTRED.has(kind)) body = <div className="flex h-full flex-col justify-center">{body}</div>;
    }
    cards.push(
      <GridCard key={w.i} {...common} title={title} link={linkOf(kind, w, target)}>
        {body}
      </GridCard>,
    );
  }

  return (
    <>
      <MonthModelContext.Provider value={month}>
      <ItemList list={list} grid={false} className="pn-home-grid grid content-start min-h-0 overscroll-contain" style={{
        padding: 16,
        gap: HOME_GAP_PX,
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: 'auto',
        gridAutoRows: `${HOME_ROW_PX}px`,
      }}>
        <li style={{ gridRow: 1 }} className="col-span-full flex flex-wrap items-end gap-x-4 gap-y-2 px-1 pb-1">
          {/* The date line never shrinks for the buttons: when both do not
              fit side by side, the buttons wrap to a row of their own under
              it. Only a line wider than the pane itself truncates. On a
              phone the buttons are icons. */}
          <div className="min-w-[min(100%,max-content)] flex-1">
            <h2 className="text-heading font-semibold text-pn truncate">{formatDay(today, 'weekdayDate')}</h2>
            {summary && <p className="text-small text-pn-muted truncate">{summary}</p>}
          </div>
          {canEdit && (narrow ? (
            <div className="flex shrink-0 items-center gap-1">
              <IconButton label={t('dashboard.addWidget')} data-home-add onClick={() => setCatalog(true)}><Plus aria-hidden="true" /></IconButton>
              <IconButton label={t('dashboard.layouts')} onClick={pickLayout}><SquaresFour aria-hidden="true" /></IconButton>
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-2">
              <Button action="add" data-home-add onClick={() => setCatalog(true)}>{t('dashboard.addWidget')}</Button>
              <Button icon={<SquaresFour aria-hidden="true" />} onClick={pickLayout}>{t('dashboard.layouts')}</Button>
            </div>
          ))}
        </li>
        {cards}
      </ItemList>
      </MonthModelContext.Provider>
      {menu.state && <ContextMenu state={menu.state} onClose={menu.close} />}
      {catalog && (
        <WidgetCatalog
          onHome={new Set(widgets.map((w) => w.k))}
          isPro={env.isPro}
          unlocked={proUnlocked(env.isPro)}
          onUpgrade={env.onUpgrade}
          trackersExist={trackers.length > 0}
          onAdd={add}
          onRemove={removeKind}
          onClose={() => setCatalog(false)}
        />
      )}
      {chooser && <TargetChooser kind={chooser.kind} trackers={trackers} onPick={chosen} onClose={() => setChooser(null)} />}
      {snack && (
        <Snackbar
          {...(snack.undo ? { actionLabel: t('notes:editor.undo'), onAction: () => { onWrite(snack.undo!); setSnack(null); } } : {})}
        >
          {snack.text}
        </Snackbar>
      )}
    </>
  );
}

const LAYOUT_GLYPH: Record<LayoutId, typeof SquaresFour> = {
  everyday: PILLAR_GLYPHS.dashboard,
  journal: PenNib,
  planner: CalendarCheck,
  writer: NotePencil,
};

function LayoutGlyph({ id }: { id: LayoutId }) {
  const Glyph = LAYOUT_GLYPH[id];
  return <Glyph aria-hidden="true" />;
}

/** Whether Home shows a layout as it came: the same widgets at the same sizes. */
function sameLayout(a: readonly Widget[], b: readonly Widget[]): boolean {
  return a.length === b.length && a.every((w, i) => w.k === b[i]!.k && w.w === b[i]!.w && w.h === b[i]!.h && w.r === b[i]!.r);
}
