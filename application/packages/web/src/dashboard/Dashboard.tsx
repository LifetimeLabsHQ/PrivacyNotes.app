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
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { HoverLabel } from '../HoverLabel';
import type { LocalNote } from '../db';
import { ItemList, useItemList } from '../itemList';
import { proUnlocked } from '../demo';
import { isTouchContextMenu, optsOutOfAppMenu, shouldUseBrowserDefault, type ContextMenuItem } from '../ContextMenu';
import {
  Badge, Button, ContextMenu, EmptyState, GridCard, IconButton, ProMark, SettingsSegmented, Snackbar, useContextMenu, usePointerReorder,
} from '../ui';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Briefcase, CalendarCheck, CaretLeft, CaretRight, Heartbeat, House, ClockClockwise, DotsSix, NotePencil, Notches, PenNib, Plus,
  SquaresFour, Trash, NEW_GLYPHS, PILLAR_GLYPHS, iconExternal, iconSettings, iconSidebar, iconZen, type Icon,
} from '../icons';
import { addDays } from '../MonthGrid';
import { pixelYears } from '../yearPixels';
import { RHYTHM_WEEKS, type RhythmLayer } from '../stats/overviewParts';
import { weekRecapMonday } from '../stats/WeekRecap';
import { keyText } from '../shortcutMatch';
import { itemTypeViewRows } from '../viewRows';
import type { View } from '../views';
import { useSteppedWidth } from '../useElementSize';
import { WIDGET_GLYPH, WidgetGlyph, widgetNameKey } from './widgetGlyphs';
import { formatDay } from '../intlFormat';
import { intlLocale } from '../languages';
import { toLocalIso } from '../notesViewUtils';
import { checkInEntry } from '../checkIn';
import { isTaskReminderOverdue } from '../taskReminderText';
import { activeCustomTrackers, type JournalTrackerData } from '../trackerTypes';
import { medicationRowsOn, takenOfRows } from '../medicationDoses';
import { trackerName } from '../stats/wellnessModel';
import {
  HOME_GAP_PX, HOME_ROW_PX, LAYOUT_IDS, WIDGETS, addWidget, columnsFor, fillHoles, fitSize, fitsDashboard, isWidgetKind, layoutWidgets, moveWidget, packBoxes,
  parseItemTypes, removeWidget, resizeWidget, retargetWidget, syncTargetWidgets, type Box, type HomeSpace, type LayoutId, type Widget, type WidgetDef, type WidgetKind,
} from './dashboardLayout';
import { useDashboardEnv, type QuickCaptureMode } from './env';
import {
  BirthdaysWidget, BookmarksWidget, CheckInStreakWidget, FilesWidget, FolderWidget, GraphWidgetSlot, InteractiveCounterWidget, MilestoneWidget,
  NoteWidget, OnThisDayWidget, PatternsWidget, PinnedWidget, PlacesWidgetSlot, QuickCaptureWidget, RecentWidget, RhythmWidget, StorageWidget,
  StreakWidget, TagWidget, TasksWidget, TodayWidget, TrackerWidget, TypesWidget, UpcomingWidget, WeekRecapWidget, WeekWidget, YearPixelsWidget,
  MonthModelContext, useBuildMonthModel, useOpenTasks, useTrackerChoices, useWritingStats,
} from './widgets';
import { WidgetCatalog, TargetChooser, type ChooserKind } from './WidgetCatalog';
import { WidgetPreview } from './WidgetPreview';

const fmt = (n: number) => n.toLocaleString(intlLocale());

/** The widgets that are one number: a tile with its own label, no head. */
const NUMBERS: ReadonlySet<string> = new Set<WidgetKind>(['streak', 'checkInStreak', 'milestone']);
/** The numbers short enough for half a phone's width: two of them share a
 *  row there. The milestone's "3,129 of 5,000" is not. */
const PAIRS: ReadonlySet<string> = new Set<WidgetKind>(['streak', 'checkInStreak']);
/** The widgets of a fixed height (a number, a recap): centred in a box made
 *  taller, where a list would start at the top. */
const CENTRED: ReadonlySet<string> = new Set<WidgetKind>([...NUMBERS as Set<WidgetKind>, 'weekRecap']);
/** Fixed-content cards that should not stretch vertically more than one row
 *  when `fillHoles` closes grid gaps: stretching a 1x2 counter or storage card
 *  across a tall empty column leaves a giant dead void instead of letting
 *  neighboring wide cards expand sideways. */
const COMPACT_FILL: ReadonlySet<string> = new Set<WidgetKind>([
  'checkIn', 'quickCapture', 'streak', 'checkInStreak', 'milestone', 'storage', 'counter', 'week', 'weekRecap',
]);

/** The cards whose content opens in place and can outgrow their rows:
 *  the check-in card's pass, the medication card's doses, the month card's day. */
const GROWS: ReadonlySet<string> = new Set<WidgetKind>(['checkIn', 'medication', 'calendar']);

/**
 * The rows the content of each of these cards needs right now, measured from
 * the card. The check-in card opens its guided pass inside itself and the
 * month card its day, as they do on Journals; a cell of only the saved
 * height would let the pass or the day draw over the header and the
 * neighbours. Measured, because the content is the
 * card's own: Home only draws the box. Observed, so a pass that opens or
 * closes re-packs at once. Never under the saved height: the caller takes
 * the larger.
 */
function useContentRows(grid: HTMLElement | null, ids: readonly string[]): Record<string, number> {
  const [rows, setRows] = useState<Record<string, number>>({});
  const key = ids.join(',');
  useLayoutEffect(() => {
    if (!grid || !ids.length) return;
    const cards = () => ids.map((id) => grid.querySelector<HTMLElement>(`[data-reorder-id="${CSS.escape(id)}"]`)).filter((li): li is HTMLElement => !!li);
    const measure = () => {
      const next: Record<string, number> = {};
      for (const li of cards()) {
        const cs = getComputedStyle(li);
        const frame = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        let content = 0;
        // The content stacks; the grip, the corner and the drop line sit over it.
        // Box-filling children (the Home month calendar when no day panel is
        // open) stretch to the tile height and never ask for extra rows.
        for (const child of li.children) {
          if (getComputedStyle(child).position === 'absolute') continue;
          if ((child as HTMLElement).hasAttribute('data-fill-box')) continue;
          content += (child as HTMLElement).offsetHeight;
        }
        if (content > 0) {
          next[li.dataset.reorderId!] = Math.ceil((content + frame + HOME_GAP_PX) / (HOME_ROW_PX + HOME_GAP_PX));
        }
      }
      setRows((prev) => {
        const keys = Object.keys(next);
        return keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]) ? prev : next;
      });
    };
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      for (const li of cards()) for (const child of li.children) ro.observe(child);
    };
    watch();
    measure();
    // A pass or a day opens as new children: watch them too.
    const mo = new MutationObserver(() => { watch(); measure(); });
    mo.observe(grid, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the ids
  }, [grid, key]);
  return rows;
}

/**
 * The size each widget shows at a grid width, before packing: held to the
 * column count; on a phone the whole row except two numbers side by side (a
 * number with no number beside it takes the row too); as tall as its width
 * asks (`heightAt`), and as tall as its open content measures (`grown`, the
 * two cards in GROWS).
 */
function sizeWidgets(widgets: readonly Widget[], width: number, resizing: { id: string; w: number; h: number } | null, grown: Record<string, number> = {}) {
  const { cols, narrow } = columnsFor(width);
  // One column and its gap, in pixels.
  const colStep = (width - (cols - 1) * HOME_GAP_PX) / cols + HOME_GAP_PX;
  const shown = widgets.filter((w) => isWidgetKind(w.k));
  const items = shown.map((w, n) => {
    const live = resizing?.id === w.i ? resizing : w;
    const def: WidgetDef = WIDGETS[w.k as WidgetKind];
    const paired = PAIRS.has(w.k) && (PAIRS.has(shown[n - 1]?.k ?? '') || PAIRS.has(shown[n + 1]?.k ?? ''));
    const wide = narrow ? (paired ? 1 : cols) : Math.min(live.w, cols);
    let high = live.h;
    if (def.heightAt) {
      const need = def.heightAt(wide * colStep - HOME_GAP_PX);
      high = Math.max(high, Math.ceil((need + HOME_GAP_PX) / (HOME_ROW_PX + HOME_GAP_PX)));
    }
    if (GROWS.has(w.k)) high = Math.max(high, grown[w.i] ?? 0);
    return { id: w.i, w: wide, h: high };
  });
  return { cols, narrow, items };
}

const sizeKey = (s: ReturnType<typeof sizeWidgets>) => `${s.cols}${s.narrow ? 'n' : ''}:${s.items.map((b) => `${b.w}.${b.h}`).join(',')}`;

const placeOf = (b: Box): CSSProperties => ({ gridColumn: `${b.x + 1} / span ${b.w}`, gridRow: `${b.y + 2} / span ${b.h}` });

export default function Dashboard({ widgets, onWrite, ownHome }: {
  widgets: Widget[];
  /** Saves a list; null is the stock layout (Reset). */
  onWrite: (next: Widget[] | null) => void;
  /** Only while a space is open (not All): whether it has its own Home, and
   *  the switch (a list turns it on with that list, null turns it off).
   *  Spec: docs/internal/specs/dashboard.md (section 6) */
  ownHome?: { space: HomeSpace; on: boolean; set: (list: Widget[] | null) => void };
}) {
  // Every namespace a key below names, so each is loaded before Home draws.
  const { t } = useTranslation(['shell', 'common', 'editor', 'notes', 'stats', 'media', 'trackers']);
  const { t: tStats } = useTranslation('stats');
  const env = useDashboardEnv();
  const today = toLocalIso(new Date());
  const { stats, live } = useWritingStats();
  const openTasks = useOpenTasks();
  const month = useBuildMonthModel();
  const trackers = useTrackerChoices(month);
  const menu = useContextMenu();
  // The undo is the write that puts things back, made where the change was
  // made: it keeps the Home it belongs to across a space switch.
  const [snack, setSnack] = useState<{ text: string; undo?: () => void } | null>(null);
  const undoTo = (before: Widget[]) => () => onWrite(before);
  const [catalog, setCatalog] = useState(false);
  const [chooser, setChooser] = useState<{ kind: ChooserKind; widgetId?: string; initial?: string } | null>(null);
  const typeRows = useMemo(() => itemTypeViewRows(t), [t]);
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
  const [captureMode, setCaptureMode] = useState<QuickCaptureMode>('journal');
  const [rhythmLayer, setRhythmLayer] = useState<RhythmLayer>('both');
  const [pixelsPickedYear, setPixelsPickedYear] = useState<number | null>(null);
  const [recapBack, setRecapBack] = useState(0);
  const availablePixelYears = useMemo(() => pixelYears(month.firstDay, today), [month.firstDay, today]);
  const pixelsYear = pixelsPickedYear !== null && availablePixelYears.includes(pixelsPickedYear)
    ? pixelsPickedYear
    : availablePixelYears[availablePixelYears.length - 1]!;
  const hasMoodData = useMemo(() => {
    const mood = month.byId('mood');
    return mood ? month.entries.some((e) => typeof e.data.mood === 'number') : false;
  }, [month]);
  // The rows the check-in card and the month card need for what is open in them.
  const grown = useContentRows(gridEl, widgets.filter((w) => GROWS.has(w.k)).map((w) => w.i));
  // Home draws again only when a width step changes what it shows: the
  // columns, or the size of a card.
  const sizeAt = (width: number) => sizeWidgets(widgets, width, resizing, grown);
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

  // Drag by the grip: snapshot card boxes at drag start so live grid reflow
  // never causes hit-test flicker, while a 60fps floating preview card follows
  // the pointer and the grid parts in real time to show the exact landing slot.
  type Slot = { overId: string; place: 'before' | 'after'; axis: 'x' | 'y' };
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const dragPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const startBoxesRef = useRef<Map<string, { left: number; top: number; right: number; bottom: number; width: number; height: number }> | null>(null);
  const orderFor = (id: string, slot: Slot): Widget[] => {
    const rest = widgets.filter((w) => w.i !== id);
    const at = rest.findIndex((w) => w.i === slot.overId) + (slot.place === 'after' ? 1 : 0);
    return moveWidget(widgets, id, at);
  };
  const { drag, pressProps, endedDrag } = usePointerReorder<Slot>({
    enabled: canEdit,
    onMove: (pos) => {
      if (!pos) {
        startBoxesRef.current = null;
        return;
      }
      dragPosRef.current = { x: pos.x, y: pos.y };
      if (!startBoxesRef.current && grid.current) {
        const gBox = grid.current.getBoundingClientRect();
        const map = new Map<string, { left: number; top: number; right: number; bottom: number; width: number; height: number }>();
        for (const el of grid.current.querySelectorAll<HTMLElement>('[data-reorder-id]')) {
          const r = el.getBoundingClientRect();
          const rid = el.dataset.reorderId;
          if (rid) {
            map.set(rid, {
              left: r.left - gBox.left,
              top: r.top - gBox.top,
              right: r.right - gBox.left,
              bottom: r.bottom - gBox.top,
              width: r.width,
              height: r.height,
            });
          }
        }
        startBoxesRef.current = map;
      }
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate3d(${Math.round(pos.x - 132)}px, ${Math.round(pos.y - 12)}px, 0)`;
      }
    },
    resolve: (id, x, y) => {
      const root = grid.current;
      if (!root) return null;
      const gBox = root.getBoundingClientRect();
      const gx = x - gBox.left;
      const gy = y - gBox.top;
      const rtl = getComputedStyle(root).direction === 'rtl';
      const snap = startBoxesRef.current;
      let bestId: string | null = null;
      let bestBox: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null = null;
      let bestDist = Infinity;
      const entries = snap
        ? [...snap.entries()]
        : Array.from(root.querySelectorAll<HTMLElement>('[data-reorder-id]')).map((el) => {
            const r = el.getBoundingClientRect();
            return [el.dataset.reorderId ?? '', {
              left: r.left - gBox.left,
              top: r.top - gBox.top,
              right: r.right - gBox.left,
              bottom: r.bottom - gBox.top,
              width: r.width,
              height: r.height,
            }] as const;
          });
      for (const [overId, box] of entries) {
        if (!overId) continue;
        const dx = gx < box.left ? box.left - gx : gx > box.right ? gx - box.right : 0;
        const dy = gy < box.top ? box.top - gy : gy > box.bottom ? gy - box.bottom : 0;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) {
          bestId = overId;
          bestBox = box;
          bestDist = dist;
        }
      }
      if (!bestId || !bestBox || bestId === id) return null;
      // A card that fills its row (a phone, a large card) splits top and
      // bottom; one beside others splits start and end.
      const axis: 'x' | 'y' = bestBox.width > gBox.width * 0.9 ? 'y' : 'x';
      const place: 'before' | 'after' = axis === 'y'
        ? (gy < bestBox.top + bestBox.height / 2 ? 'before' : 'after')
        : ((gx < bestBox.left + bestBox.width / 2) !== rtl ? 'before' : 'after');
      const slot: Slot = { overId: bestId, place, axis };
      const next = orderFor(id, slot);
      return next.every((w, i) => w.i === widgets[i]?.i) ? null : slot;
    },
    targetKey: (s) => `${s.overId}:${s.place}:${s.axis}`,
    onDrop: (id, slot) => onWrite(orderFor(id, slot)),
  });

  /** Build the widget action rows shared by a card's grip button and right-clicking
   *  the card directly (`asContextMenu` adds the card's title header, destination
   *  link and trailing Add widget entry). */
  function widgetMenuItems(w: Widget, opts: { asContextMenu?: boolean } = {}): ContextMenuItem[] {
    // Moves step over the widgets drawn here: one from a newer app is not
    // drawn, and stepping past it would look like nothing happened.
    const shownList = widgets.filter((x) => isWidgetKind(x.k));
    const at = shownList.findIndex((x) => x.i === w.i);
    const stepTo = (to: number) => {
      focusAfter.current = { grip: w.i };
      onWrite(moveWidget(widgets, w.i, widgets.findIndex((x) => x.i === shownList[to]!.i)));
    };
    const kind = w.k as WidgetKind;
    const def = WIDGETS[kind];
    const target = def.target;
    const targetInfo = target ? targetState(w) : { state: 'ok' as const };
    const name = t(widgetNameKey(kind));
    const label = target ? targetInfo.title ?? name : name;
    const link = linkOf(kind, w, targetInfo);
    const resizeTo = (wide: number, high: number) => {
      focusAfter.current = { grip: w.i };
      onWrite(resizeWidget(widgets, w.i, wide, high));
    };
    // Wider stops at the pane's columns: a step past it would show nothing.
    const widest = Math.min(def.w[2], cols);
    // Respect any effective height floor (from heightAt or open content) so
    // Taller/Shorter never appear to do nothing when w.h sits below it.
    const askedH = askedOf.get(w.i)?.h ?? w.h;
    const minH = def.heightAt || GROWS.has(kind) ? Math.max(def.h[0], askedH > w.h ? askedH : def.h[0]) : def.h[0];
    const currentH = Math.max(w.h, askedH);
    const items: ContextMenuItem[] = [];
    if (opts.asContextMenu) {
      items.push({ type: 'header', label, keepCase: !!target });
      if (link) {
        const openLabel = link.label === t('contacts.open')
          ? link.label
          : t('dashboard.openTarget', { target: link.label });
        items.push({ label: openLabel, icon: iconExternal(), onSelect: link.onClick });
      }
      if (canEdit && target) {
        items.push({
          label: t(`dashboard.choose${target[0]!.toUpperCase()}${target.slice(1)}`),
          icon: <WidgetGlyph kind={kind} />,
          onSelect: () => setChooser({ kind: target, widgetId: w.i, initial: w.r }),
        });
      }
    }
    if (!canEdit) return items.length > 1 ? items : [];
    if (items.length > 1) items.push({ type: 'separator' });
    if (!narrow) {
      items.push(
        { label: t('notes:editor.widthWide'), icon: <ArrowRight className="rtl:-scale-x-100" />, disabled: w.w >= widest, onSelect: () => resizeTo(Math.min(w.w, cols) + 1, w.h) },
        { label: t('dashboard.narrower'), icon: <ArrowLeft className="rtl:-scale-x-100" />, disabled: Math.min(w.w, cols) <= def.w[0], onSelect: () => resizeTo(Math.min(w.w, cols) - 1, w.h) },
      );
    }
    items.push(
      { label: t('dashboard.taller'), icon: <ArrowDown />, disabled: currentH >= def.h[2], onSelect: () => resizeTo(w.w, currentH + 1) },
      { label: t('dashboard.shorter'), icon: <ArrowUp />, disabled: currentH <= minH, onSelect: () => resizeTo(w.w, currentH - 1) },
      { type: 'separator' },
      { label: t('dashboard.moveEarlier'), icon: <ArrowLeft className="rtl:-scale-x-100" />, disabled: at === 0, onSelect: () => stepTo(at - 1) },
      { label: t('dashboard.moveLater'), icon: <ArrowRight className="rtl:-scale-x-100" />, disabled: at === shownList.length - 1, onSelect: () => stepTo(at + 1) },
    );
    if (!opts.asContextMenu && target) {
      items.push(
        { type: 'separator' },
        { label: t(`dashboard.choose${target[0]!.toUpperCase()}${target.slice(1)}`), icon: <WidgetGlyph kind={kind} />, onSelect: () => setChooser({ kind: target, widgetId: w.i, initial: w.r }) },
      );
    }
    items.push(
      { type: 'separator' },
      {
        label: opts.asContextMenu ? t('dashboard.removeFromHome') : t('common:actions.remove'),
        icon: <Trash />,
        destructive: true,
        onSelect: () => {
          // The next card takes its place; the one before when it was last.
          focusAfter.current = { grip: (shownList[at + 1] ?? shownList[at - 1])?.i ?? null };
          const before = widgets;
          onWrite(removeWidget(widgets, w.i));
          setSnack({ text: t('dashboard.removed'), undo: undoTo(before) });
        },
      },
    );
    if (opts.asContextMenu) {
      items.push(
        { type: 'separator' },
        { label: t('dashboard.addWidget'), icon: <Plus aria-hidden="true" />, onSelect: () => setCatalog(true) },
      );
    }
    return items;
  }

  function openWidgetMenu(e: MouseEvent<HTMLButtonElement>, w: Widget) {
    if (endedDrag()) return;
    const box = e.currentTarget.getBoundingClientRect();
    menu.open(
      { clientX: box.left, clientY: box.bottom + 4, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() },
      widgetMenuItems(w),
      e.detail === 0,
    );
  }

  /** Layout rows shared by the header Layouts button and the Home background menu. */
  function layoutMenuItems(): ContextMenuItem[] {
    return [
      ...(ownHome ? [
        {
          label: t(ownHome.space === 'work' ? 'dashboard.separateWorkHome' : 'dashboard.separatePersonalHome'),
          icon: ownHome.space === 'work' ? <Briefcase aria-hidden="true" /> : <House aria-hidden="true" />,
          checked: ownHome.on,
          onSelect: () => {
            const before = widgets;
            if (ownHome.on) {
              ownHome.set(null);
              setSnack({ text: t('dashboard.separateHomeOff'), undo: () => ownHome.set(before) });
            } else {
              ownHome.set(before);
              setSnack({ text: t(ownHome.space === 'work' ? 'dashboard.separateWorkHomeOn' : 'dashboard.separatePersonalHomeOn'), undo: () => ownHome.set(null) });
            }
          },
        },
        { type: 'separator' as const },
      ] : []),
      ...LAYOUT_IDS.map((id: LayoutId): ContextMenuItem => ({
        label: t(id === 'journal' ? 'notes:newMenu.journal' : `dashboard.layout.${id}`),
        icon: <LayoutGlyph id={id} />,
        checked: sameLayout(widgets, layoutWidgets(id)),
        onSelect: () => {
          const before = widgets;
          onWrite(id === 'everyday' ? null : layoutWidgets(id));
          setSnack({ text: t('dashboard.layoutChanged'), undo: undoTo(before) });
        },
      })),
      { type: 'separator' },
      {
        label: t('settings:appearance.resetDefaults'),
        icon: <ClockClockwise aria-hidden="true" />,
        onSelect: () => {
          const before = widgets;
          onWrite(null);
          setSnack({ text: t('dashboard.layoutChanged'), undo: undoTo(before) });
        },
      },
    ];
  }

  function pickLayout(e: MouseEvent<HTMLButtonElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    menu.open(
      { clientX: box.left, clientY: box.bottom + 4, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() },
      layoutMenuItems(),
      e.detail === 0,
    );
  }

  /** Home background context menu: Add widget, Quick add, Layouts, and shell view
   *  toggles (no Hide notes list on Home). */
  function homeCanvasMenuItems(): ContextMenuItem[] {
    const shell = env.shellMenu;
    const items: ContextMenuItem[] = [];
    if (canEdit) {
      items.push({ label: t('dashboard.addWidget'), icon: <Plus aria-hidden="true" />, onSelect: () => setCatalog(true) });
    }
    if (shell) {
      items.push({
        label: t('quickAdd.label'),
        icon: <NEW_GLYPHS.event />,
        shortcut: keyText('quickAdd'),
        onSelect: shell.onQuickAdd,
      });
    }
    if (canEdit) {
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({ type: 'header', label: t('listPrefs.layout') });
      // Drop the extra separator before Reset inside the flat canvas menu so
      // layouts + Reset read as one compact section.
      items.push(...layoutMenuItems().filter((it, idx, arr) => !(idx === arr.length - 2 && 'type' in it && it.type === 'separator')));
    }
    if (shell) {
      if (items.length > 0) items.push({ type: 'separator' });
      items.push(
        {
          label: shell.zenMode ? t('notes:zen.exitHover') : t('common:palette.commands.zen'),
          icon: iconZen(),
          pro: !env.isPro,
          onSelect: shell.onToggleZen,
        },
        {
          label: shell.sidebarCollapsed ? t('contextMenu.showSidebar') : t('contextMenu.hideSidebar'),
          icon: iconSidebar(),
          onSelect: shell.onToggleSidebar,
        },
        {
          label: t('contextMenu.resetPaneWidths'),
          icon: iconSidebar(),
          onSelect: shell.onResetPaneWidths,
        },
        { type: 'separator' },
        {
          label: t('contextMenu.settings'),
          icon: iconSettings(),
          onSelect: shell.onOpenSettings,
        },
      );
    }
    return items;
  }

  /** Right-click anywhere on Home: note rows already stop propagation with their
   *  own Note menu; editable fields/links keep the native browser menu; a card
   *  opens its widget menu; empty background/header opens the Home canvas menu. */
  function handleGridContextMenu(e: MouseEvent) {
    if (isTouchContextMenu(e) || shouldUseBrowserDefault(e.target) || optsOutOfAppMenu(e.target)) return;
    if ((e.target as HTMLElement | null)?.closest?.('[data-tag-chip]')) return;
    const cardEl = (e.target as HTMLElement | null)?.closest<HTMLElement>('.pn-home-grid > li[data-reorder-id]');
    if (cardEl?.dataset.reorderId) {
      const w = byId.get(cardEl.dataset.reorderId);
      if (w) {
        const items = widgetMenuItems(w, { asContextMenu: true });
        if (items.length > 0) {
          menu.open(e, items);
          return;
        }
      }
    }
    const items = homeCanvasMenuItems();
    if (items.length > 0) menu.open(e, items);
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

  function chosenMany(values: string[]) {
    const c = chooser;
    setChooser(null);
    if (!c || c.kind === 'types') return;
    const before = widgets;
    const active = new Set(before.filter((w) => w.k === c.kind && w.r).map((w) => w.r!));
    const wanted = new Set(values);
    const same = active.size === wanted.size && [...wanted].every((v) => active.has(v));
    if (same) return;
    const next = syncTargetWidgets(before, c.kind, values);
    if (next === before || !fitsDashboard(next)) {
      setSnack({ text: t('dashboard.full') });
      return;
    }
    onWrite(next);
    const addedAny = [...wanted].some((v) => !active.has(v));
    const removedAny = [...active].some((v) => !wanted.has(v));
    if (removedAny && !addedAny) {
      setSnack({ text: t('dashboard.removed'), undo: undoTo(before) });
    } else if (removedAny) {
      setSnack({ text: t('dashboard.layoutChanged'), undo: undoTo(before) });
    }
    if (addedAny) scrollToEnd();
  }

  function scrollToEnd() {
    requestAnimationFrame(() => grid.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }

  // The header line: what is on today, from the page's own numbers.
  const eventsToday = useMemo(() => env.calendarDays.entriesOf(today).filter((e) => e.kind === 'event').length, [env.calendarDays, today]);
  const overdueTasks = useMemo(
    () => openTasks.filter((task) => task.reminder && isTaskReminderOverdue(task.reminder)).length,
    [openTasks],
  );
  const dosesRemaining = useMemo(() => {
    const entry = checkInEntry(env.listed, today);
    const guarded = !!entry && (env.isNoteLocked(entry) || entry.locked === 1);
    const logs = entry && !guarded ? (entry.trackers as JournalTrackerData | undefined)?.medications : undefined;
    const rows = medicationRowsOn(env.medications, logs, today);
    const { expected, taken } = takenOfRows(rows, logs);
    return Math.max(0, expected - taken);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gatedKey tracks lock changes
  }, [env.listed, env.medications, env.gatedKey, today]);
  const summaryParts = [
    eventsToday > 0 ? { key: 'events', text: t('dashboard.headerEvents', { count: eventsToday, formatted: fmt(eventsToday) }), tone: 'muted' as const } : null,
    overdueTasks > 0 ? { key: 'overdue', text: t('dashboard.headerOverdue', { count: overdueTasks, formatted: fmt(overdueTasks) }), tone: 'danger' as const } : null,
    openTasks.length > 0 ? { key: 'tasks', text: t('dashboard.headerTasks', { count: openTasks.length, formatted: fmt(openTasks.length) }), tone: 'muted' as const } : null,
    dosesRemaining > 0 ? { key: 'doses', text: t('dashboard.headerDosesLeft', { count: dosesRemaining, formatted: fmt(dosesRemaining) }), tone: 'accent' as const } : null,
    stats.currentStreak > 0 ? { key: 'streak', text: t('stats:milestone.streak', { count: stats.currentStreak }), tone: 'muted' as const } : null,
  ].filter((p): p is NonNullable<typeof p> => p !== null);
  const summaryLine = summaryParts.length > 0 ? (
    <>
      {summaryParts.map((part, i) => (
        <span key={part.key}>
          {i > 0 && ' · '}
          <span className={part.tone === 'danger' ? 'font-medium text-danger' : part.tone === 'accent' ? 'font-medium text-accent' : undefined}>
            {part.text}
          </span>
        </span>
      ))}
    </>
  ) : null;

  /** Where a target points, and whether it still exists. */
  function targetState(w: Widget): { state: 'ok' | 'gone' | 'otherSpace'; note?: LocalNote; title?: string; views?: View[]; icon?: Icon } {
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
    if (w.k === 'counter') {
      const c = activeCustomTrackers(env.trackerSettings.customTrackers).find((x) => x.id === r && x.type === 'counter');
      return c ? { state: 'ok', title: c.name } : { state: 'gone' };
    }
    if (w.k === 'types') {
      const picked = new Set(parseItemTypes(r));
      const rows = typeRows.filter((row) => picked.has(row.key));
      if (!rows.length) return { state: 'gone' };
      return {
        state: 'ok',
        title: rows.map((row) => row.label).join(' · '),
        views: rows.map((row) => row.key),
        icon: rows.length === 1 ? rows[0]!.icon : undefined,
      };
    }
    return { state: 'ok' };
  }

  function content(w: Widget, kind: WidgetKind, target: ReturnType<typeof targetState>): ReactNode {
    switch (kind) {
      case 'quickCapture': return <QuickCaptureWidget mode={captureMode} />;
      case 'upcoming': return <UpcomingWidget />;
      case 'today': return <TodayWidget />;
      case 'tasks': return <TasksWidget tasks={openTasks} />;
      case 'recent': return <RecentWidget />;
      case 'pinned': return <PinnedWidget />;
      case 'note': return target.note ? <NoteWidget note={target.note} /> : null;
      case 'tag': return <TagWidget tag={w.r!} />;
      case 'folder': return <FolderWidget folderId={w.r!} />;
      case 'types': return target.views?.length ? <TypesWidget views={target.views} /> : null;
      case 'onThisDay': return <OnThisDayWidget />;
      case 'graph': return <GraphWidgetSlot />;
      case 'places': return <PlacesWidgetSlot />;
      case 'week': return <WeekWidget stats={stats} live={live} />;
      case 'streak': return <StreakWidget stats={stats} />;
      case 'checkInStreak': return <CheckInStreakWidget />;
      case 'rhythm': return <RhythmWidget stats={stats} layer={rhythmLayer} />;
      case 'yearPixels': return <YearPixelsWidget year={pixelsYear} />;
      case 'patterns': return <PatternsWidget />;
      case 'milestone': return <MilestoneWidget stats={stats} />;
      case 'tracker': return <TrackerWidget trackerId={w.r!} />;
      case 'counter': return <InteractiveCounterWidget trackerId={w.r!} />;
      case 'weekRecap': return <WeekRecapWidget back={recapBack} />;
      case 'files': return <FilesWidget />;
      case 'bookmarks': return <BookmarksWidget />;
      case 'birthdays': return <BirthdaysWidget />;
      case 'storage': return <StorageWidget />;
      case 'checkIn':
      case 'medication':
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
      case 'types': {
        const only = target.views?.length === 1 ? typeRows.find((row) => row.key === target.views![0]) : undefined;
        return only
          ? { label: only.label, onClick: () => env.goTo(only.key) }
          : { label: t('tagsRail.allItems'), onClick: () => env.goTo('home') };
      }
      case 'upcoming': return { label: t('tagsRail.calendar'), onClick: () => env.goTo('calendar') };
      case 'tasks': return { label: t('tagsRail.tasks'), onClick: () => env.goTo('tasks') };
      case 'pinned': return { label: t('tagsRail.pinned'), onClick: () => env.goTo('starred') };
      case 'files': return { label: t('tagsRail.files'), onClick: () => env.goTo('files') };
      case 'bookmarks': return { label: t('tagsRail.bookmarks'), onClick: () => env.goTo('bookmarks') };
      case 'graph': return { label: t('contacts.open'), onClick: () => env.openGraph('graph') };
      case 'places': return { label: t('contacts.open'), onClick: () => env.openGraph('places') };
      case 'storage': return { label: t('contextMenu.settings'), onClick: env.openStorage };
      case 'week':
      case 'rhythm':
      case 'yearPixels':
      case 'patterns':
      case 'counter':
        return { label: t('notes:settings.statsLabel'), onClick: env.openStats };
      default: return undefined;
    }
  }

  // Live reflow preview while dragging: pack the tentative order so every
  // other card parts cleanly around the dragged card's dashed landing zone.
  const displayWidgets = drag?.target ? orderFor(drag.id, drag.target) : widgets;
  const shown = displayWidgets.filter((w) => isWidgetKind(w.k));
  const displaySized = drag?.target ? sizeWidgets(displayWidgets, gridWidth, resizing, grown) : sized;
  const packed = packBoxes(displaySized.items, cols);
  // The cards grow into the holes beside them within their own max bounds;
  // compact fixed-height cards grow at most one row so they never become tall
  // empty pillars. A resize starts from the size before that growth.
  const byId = new Map(shown.map((w) => [w.i, w]));
  const fillLimits = new Map(packed.map((b) => {
    const w = byId.get(b.id);
    const def = w && isWidgetKind(w.k) ? WIDGETS[w.k] : null;
    if (!def) return [b.id, { maxW: cols, maxH: Infinity }] as const;
    const compact = COMPACT_FILL.has(w!.k);
    const maxH = compact ? Math.min(def.h[2], b.h + 1) : def.h[2];
    return [b.id, { maxW: def.w[2], maxH, ...(compact ? { exactOnly: true } : {}) }] as const;
  }));
  const boxes = fillHoles(packed, cols, fillLimits);
  const askedOf = new Map(packed.map((b) => [b.id, b]));

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
    // The moves and the release are read on the window, not the handle, and
    // the loss of the capture is not a release. The cards are drawn in packed
    // order, so a size that moves this card to another row or column moves
    // its node in the DOM; the browser then drops the capture and fires
    // lostpointercapture while the button is still down. The window still
    // gets every move and the release, captured or not. A release the window
    // cannot see (the window loses focus mid-drag) ends it too.
    const events = ['pointerup', 'pointercancel', 'blur'] as const;
    const end = () => {
      window.removeEventListener('pointermove', move);
      for (const type of events) window.removeEventListener(type, end);
      setResizing(null);
      // A width held to a narrower pane is kept as it was saved.
      const wide = last.w === box.w ? w.w : last.w;
      if (wide !== w.w || last.h !== w.h) onWrite(resizeWidget(widgets, w.i, wide, last.h));
    };
    window.addEventListener('pointermove', move);
    for (const type of events) window.addEventListener(type, end);
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
    // What the card is called in its head, its grip and its corner: the
    // target of a note, tag, folder or tracker widget, so two tag widgets do
    // not both read "Options for A tag" to a screen reader.
    const label = def.target ? target.title ?? name : name;
    const dragging = drag?.id === w.i;
    const sizing = resizing?.id === w.i;
    const asked = askedOf.get(w.i)!;
    // Always there, nothing to switch on: a grip tab on the card's top edge
    // (a tap opens the widget menu, a drag moves the card) and, for a mouse,
    // the resize corner. On a mouse both show while the card is hovered or
    // holds focus; on touch the tab always shows and the menu resizes.
    const controls = canEdit ? (
      <>
        <button
          type="button"
          data-no-drag
          data-home-grip={w.i}
          aria-label={t('editor:formatBar.optionsFor', { item: label })}
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
        {/* The picture handle's plate and glyph (ui-patterns.md section 160),
            straddling the bottom-end corner like the grip tab straddles the top
            edge so it never covers bottom-right card buttons. */}
        <div className="pn-card-ctl pn-card-resize absolute -bottom-2.5 -end-2.5 z-10">
          <HoverLabel label={t('media:image.resizeHint')} position="start" disabled={sizing}>
            <button
              type="button"
              data-no-drag
              data-home-resize={w.i}
              aria-label={t('dashboard.resize', { name: label })}
              onPointerDown={(e) => startResize(e, w, asked)}
              onKeyDown={(e) => keyResize(e, w, asked)}
              className="pn-resize-plate shadow-sm cursor-nwse-resize rtl:cursor-nesw-resize focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Notches aria-hidden="true" className="rtl:-scale-x-100" />
            </button>
          </HoverLabel>
        </div>
      </>
    ) : undefined;
    const common = {
      'data-reorder-id': w.i,
      style: place,
      icon: ('icon' in target && target.icon) ? target.icon : WIDGET_GLYPH[kind],
      controls,
      className: `${dragging ? '!border-2 !border-dashed !border-accent !bg-accent/10 [&>*:not(.pn-card-ctl)]:opacity-20' : ''} ${sizing ? 'ring-2 ring-accent' : ''}`,
    };

    // The cards that are their own grid items.
    if (kind === 'checkIn' || kind === 'medication' || kind === 'calendar') {
      const card = kind === 'checkIn' ? env.checkInCard : kind === 'medication' ? env.medicationCard : env.calendarCard;
      if (isValidElement(card)) {
        cards.push(cloneElement(card as ReactElement<{ style?: CSSProperties; className?: string; controls?: ReactNode; reorderId?: string }>, {
          key: w.i, style: place, className: common.className, controls, reorderId: w.i,
        }));
      }
      continue;
    }
    // A Pro widget on an account without Pro: the door, not the content.
    if (def.pro && !env.unlocked) {
      cards.push(
        <GridCard key={w.i} {...common} title={name}>
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <ProMark />
            <Button action="open" pro onClick={env.onUpgrade}>{t('dashboard.proLocked')}</Button>
          </div>
        </GridCard>,
      );
      continue;
    }
    const title = NUMBERS.has(kind) ? undefined : label;
    let body: ReactNode;
    if (def.target && target.state !== 'ok') {
      body = (
        <div className="flex h-full flex-col items-center justify-center gap-2">
          <EmptyState compact flush>{t(target.state === 'gone' ? 'dashboard.gone' : 'dashboard.otherSpace')}</EmptyState>
          {canEdit && <Button action="edit" onClick={() => setChooser({ kind: def.target!, widgetId: w.i, initial: w.r })}>{t('dashboard.choose')}</Button>}
        </div>
      );
    } else {
      body = content(w, kind, target);
      if (CENTRED.has(kind)) body = <div className="flex h-full flex-col justify-center">{body}</div>;
    }
    const pixelYearIdx = availablePixelYears.indexOf(pixelsYear);
    const recapMonday = addDays(weekRecapMonday(today), -7 * recapBack);
    const recapCanGoBack = month.firstDay !== null && addDays(recapMonday, -7) >= weekRecapMonday(month.firstDay);
    const headerEnd = kind === 'quickCapture' ? (
      <SettingsSegmented
        label={t('dashboard.quickCapture.destination')}
        value={captureMode}
        onChange={(v) => setCaptureMode(v as QuickCaptureMode)}
        options={[
          { value: 'journal', label: t('notes:newMenu.journal') },
          { value: 'task', label: t('tagsRail.tasks') },
          { value: 'note', label: t('notes:newMenu.note') },
        ]}
      />
    ) : kind === 'rhythm' && month.entries.length > 0 ? (
      <SettingsSegmented
        label={tStats('overview.rhythm', { weeks: RHYTHM_WEEKS })}
        value={rhythmLayer}
        onChange={(v) => setRhythmLayer(v as RhythmLayer)}
        options={(['both', 'writing', 'mood'] as const).map((l) => ({
          value: l,
          label: tStats(l === 'both' ? 'overview.layerBoth' : l === 'writing' ? 'tabs.writing' : 'wellness.mood.heading'),
        }))}
      />
    ) : kind === 'yearPixels' && hasMoodData ? (
      <div className="flex items-center gap-0.5 text-small">
        <button
          type="button"
          aria-label={tStats('wellness.pixels.prevYear')}
          disabled={pixelYearIdx <= 0}
          onClick={() => setPixelsPickedYear(availablePixelYears[pixelYearIdx - 1]!)}
          className="rounded p-1 text-pn-muted hover:text-pn disabled:opacity-30 disabled:hover:text-pn-muted"
        >
          <CaretLeft aria-hidden="true" />
        </button>
        <span className="min-w-[3ch] text-center font-medium tabular-nums text-pn">{pixelsYear}</span>
        <button
          type="button"
          aria-label={tStats('wellness.pixels.nextYear')}
          disabled={pixelYearIdx >= availablePixelYears.length - 1}
          onClick={() => setPixelsPickedYear(availablePixelYears[pixelYearIdx + 1]!)}
          className="rounded p-1 text-pn-muted hover:text-pn disabled:opacity-30 disabled:hover:text-pn-muted"
        >
          <CaretRight aria-hidden="true" />
        </button>
      </div>
    ) : kind === 'weekRecap' ? (
      <div className="flex items-center gap-0.5 text-small">
        <button
          type="button"
          aria-label={tStats('recap.previous')}
          disabled={!recapCanGoBack}
          onClick={() => setRecapBack((b) => b + 1)}
          className="rounded p-1 text-pn-muted hover:text-pn disabled:opacity-30 disabled:hover:text-pn-muted"
        >
          <CaretLeft aria-hidden="true" />
        </button>
        <span className="px-1 font-medium text-pn whitespace-nowrap">
          {recapBack === 0
            ? tStats('overview.thisWeek')
            : tStats('wellness.week.range', { start: formatDay(recapMonday, 'dayMonth'), end: formatDay(addDays(recapMonday, 6), 'dayMonth') })}
        </span>
        <button
          type="button"
          aria-label={tStats('recap.next')}
          disabled={recapBack === 0}
          onClick={() => setRecapBack((b) => Math.max(0, b - 1))}
          className="rounded p-1 text-pn-muted hover:text-pn disabled:opacity-30 disabled:hover:text-pn-muted"
        >
          <CaretRight aria-hidden="true" />
        </button>
      </div>
    ) : undefined;
    cards.push(
      <GridCard key={w.i} {...common} title={title} headerEnd={headerEnd} link={linkOf(kind, w, target)}>
        {body}
      </GridCard>,
    );
  }

  const draggedWidget = drag ? byId.get(drag.id) ?? null : null;
  const draggedKind = draggedWidget && isWidgetKind(draggedWidget.k) ? draggedWidget.k : null;
  const draggedLabel = draggedWidget && draggedKind
    ? (WIDGETS[draggedKind].target ? targetState(draggedWidget).title ?? t(widgetNameKey(draggedKind)) : t(widgetNameKey(draggedKind)))
    : '';
  const draggedBox = drag ? askedOf.get(drag.id) : null;

  return (
    <>
      <MonthModelContext.Provider value={month}>
      <ItemList list={list} grid={false} pullToSync onContextMenu={handleGridContextMenu} className="pn-home-grid grid content-start min-h-0 overscroll-contain" style={{
        padding: 16,
        gap: HOME_GAP_PX,
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: 'auto',
        gridAutoRows: `${HOME_ROW_PX}px`,
      }}>
        {/* On a phone the date and the two icon buttons share the first
            line and the summary takes the second, whole. */}
        {narrow ? (
          <li style={{ gridRow: 1 }} className="col-span-full grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 px-1 pb-1">
            <h2 className="text-heading font-semibold text-pn truncate">{formatDay(today, 'weekdayDate')}</h2>
            {canEdit && (
              <div className="flex shrink-0 items-center gap-1">
                <IconButton label={t('dashboard.addWidget')} data-home-add onClick={() => setCatalog(true)}><Plus aria-hidden="true" /></IconButton>
                <IconButton label={t('dashboard.layouts')} onClick={pickLayout}><SquaresFour aria-hidden="true" /></IconButton>
              </div>
            )}
            {summaryLine && <p className="col-span-2 text-small text-pn-muted truncate">{summaryLine}</p>}
          </li>
        ) : (
          <li style={{ gridRow: 1 }} className="col-span-full flex min-w-0 flex-wrap items-end gap-x-4 gap-y-2 px-1 pb-1">
            {/* The date line never shrinks for the buttons: its base size is
                its own text, so when both do not fit side by side the buttons
                wrap to a row of their own under it. Only a line wider than
                the pane itself shrinks, and truncates. */}
            <div className="min-w-0 max-w-full flex-auto">
              <h2 className="text-heading font-semibold text-pn truncate">{formatDay(today, 'weekdayDate')}</h2>
              {summaryLine && <p className="text-small text-pn-muted truncate">{summaryLine}</p>}
            </div>
            {canEdit && (
              <div className="flex shrink-0 items-center gap-2">
                <Button action="add" data-home-add onClick={() => setCatalog(true)}>{t('dashboard.addWidget')}</Button>
                <Button icon={<SquaresFour aria-hidden="true" />} onClick={pickLayout}>{t('dashboard.layouts')}</Button>
              </div>
            )}
          </li>
        )}
        {cards}
      </ItemList>
      </MonthModelContext.Provider>
      {draggedKind && draggedBox && typeof document !== 'undefined' && createPortal(
        <div
          ref={ghostRef}
          aria-hidden="true"
          data-home-drag-preview=""
          className="pointer-events-none fixed z-[70] w-[264px]"
          style={{ left: 0, top: 0, transform: `translate3d(${Math.round(dragPosRef.current.x - 132)}px, ${Math.round(dragPosRef.current.y - 12)}px, 0)` }}
        >
          <div className="relative flex flex-col gap-2 rounded-xl border-2 border-accent bg-surface-2/95 p-2.5 shadow-2xl backdrop-blur-sm rotate-[1deg]">
            <span className="absolute -top-2.5 left-1/2 flex h-5 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-accent bg-surface-2 text-accent shadow-sm">
              <DotsSix aria-hidden="true" />
            </span>
            <div className="flex items-center gap-2 min-w-0 pt-0.5">
              <span className="shrink-0 text-accent"><WidgetGlyph kind={draggedKind} /></span>
              <span className="min-w-0 flex-1 truncate text-compact font-semibold text-pn">{draggedLabel}</span>
              <Badge tone="info"><span className="tabular-nums">{draggedBox.w} × {draggedBox.h}</span></Badge>
            </div>
            <WidgetPreview kind={draggedKind} />
          </div>
        </div>,
        document.body,
      )}
      {menu.state && <ContextMenu state={menu.state} onClose={menu.close} />}
      {catalog && (
        <WidgetCatalog
          onHomeCounts={widgets.reduce((m, w) => { m.set(w.k, (m.get(w.k) ?? 0) + 1); return m; }, new Map<string, number>())}
          isPro={env.isPro}
          unlocked={proUnlocked(env.isPro)}
          onUpgrade={env.onUpgrade}
          trackersExist={trackers.length > 0}
          onAdd={add}
          onRemove={removeKind}
          onClose={() => setCatalog(false)}
        />
      )}
      {chooser && (
        <TargetChooser
          kind={chooser.kind}
          initial={chooser.initial}
          activeTargets={!chooser.widgetId && chooser.kind !== 'types'
            ? widgets.filter((w) => w.k === chooser.kind && w.r).map((w) => w.r!)
            : undefined}
          trackers={trackers}
          onPick={chosen}
          onPickMany={!chooser.widgetId && chooser.kind !== 'types' ? chosenMany : undefined}
          onClose={() => setChooser(null)}
        />
      )}
      {snack && (
        <Snackbar
          {...(snack.undo ? { actionLabel: t('notes:editor.undo'), onAction: () => { snack.undo!(); setSnack(null); } } : {})}
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
  wellness: Heartbeat,
};

function LayoutGlyph({ id }: { id: LayoutId }) {
  const Glyph = LAYOUT_GLYPH[id];
  return <Glyph aria-hidden="true" />;
}

/** Whether Home shows a layout as it came: the same widgets at the same sizes. */
function sameLayout(a: readonly Widget[], b: readonly Widget[]): boolean {
  return a.length === b.length && a.every((w, i) => w.k === b[i]!.k && w.w === b[i]!.w && w.h === b[i]!.h && w.r === b[i]!.r);
}
