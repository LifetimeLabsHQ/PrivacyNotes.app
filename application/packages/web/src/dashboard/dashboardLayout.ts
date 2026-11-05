/**
 * Home: the widgets a person keeps on it, their order and sizes, and how the
 * layout is stored.
 *
 * The layout is one stamped register in the settings blob, the format bar's
 * rule (formatBar.ts): the later save wins at every sync point, a reset is a
 * stamped null, and a device holding an older blob cannot take a newer
 * layout back. A widget kind this version does not know is kept through a
 * save, with any field it does not know, so an older app never removes what
 * a newer one added.
 * Spec: docs/internal/specs/dashboard.md (sections 5 and 7)
 */
import {
  mergeRegisterMaps,
  registerMapsEqual,
  stampAfter,
  validateRegisterMap,
  type RegisterMap,
} from '../registers';

/** The old size letter: one column, two, or the row. Still written beside
 *  `w`, so an app from before free sizes draws the widget near its width. */
type WidgetSize = 's' | 'm' | 'l';
export type WidgetGroup = 'today' | 'notes' | 'stats' | 'keep';
/** What a widget points at, chosen by the person. */
export type WidgetTarget = 'note' | 'tag' | 'folder' | 'tracker';
/** Smallest, default, largest. */
type Range = readonly [number, number, number];

export interface WidgetDef {
  group: WidgetGroup;
  /** Width in columns. */
  w: Range;
  /** Height in rows (HOME_ROW_PX each, HOME_GAP_PX between). */
  h: Range;
  /** For content whose height grows with its width (a month of days, a
   *  heatmap): the card height in pixels it needs at a card width. Home
   *  draws it at least that many rows tall. */
  heightAt?: (widthPx: number) => number;
  /** The narrowest card its content fits: in a pane whose columns are
   *  narrower, Home draws it over as many columns as it needs. */
  minWidthPx?: number;
  target?: WidgetTarget;
  /** Its content is Pro today. */
  pro?: boolean;
}

/** Most columns Home has; a widget is never wider. */
export const HOME_COLS = 4;
/** Tallest a widget can be, in rows. */
const MAX_ROWS = 12;
// Spec: docs/internal/specs/dashboard.md (section 3, the grid)
export const HOME_ROW_PX = 60;
export const HOME_GAP_PX = 12;
/** The calendar card's header (month, the arrows, expand) needs this width. */
const CALENDAR_MIN_PX = 230;

// Spec: docs/internal/specs/dashboard.md (section 5, the version 1 list)
const WIDGET_DEFS = {
  checkIn: { group: 'today', w: [2, 2, 4], h: [2, 2, 4] },
  // Measured: the month is 345px tall at every width the card takes on a
  // phone (288px to 382px of card; the days have one size), plus the card's
  // 16px of padding. An older 331px below 335px gave a five-row tile that
  // the month did not fit, and Home showed one week strip in it.
  calendar: { group: 'today', w: [1, 1, 2], h: [5, 5, 6], heightAt: () => 361, minWidthPx: CALENDAR_MIN_PX },
  upcoming: { group: 'today', w: [1, 1, 4], h: [2, 5, 12] },
  today: { group: 'today', w: [1, 2, 4], h: [2, 3, 8] },
  tasks: { group: 'today', w: [1, 1, 4], h: [2, 5, 12] },
  recent: { group: 'notes', w: [1, 2, 4], h: [2, 5, 12] },
  pinned: { group: 'notes', w: [1, 1, 4], h: [2, 4, 12] },
  note: { group: 'notes', w: [1, 2, 4], h: [2, 5, 12], target: 'note' },
  tag: { group: 'notes', w: [1, 1, 4], h: [2, 4, 12], target: 'tag' },
  folder: { group: 'notes', w: [1, 1, 4], h: [2, 4, 12], target: 'folder', pro: true },
  onThisDay: { group: 'notes', w: [1, 1, 4], h: [2, 3, 12] },
  // Four tiles in a row from 512px of content (the card's @lg), else two by
  // two: measured 110px and 235px of tiles, plus the head and the padding.
  week: { group: 'stats', w: [2, 2, 4], h: [2, 3, 6], heightAt: (px) => (px - 24 >= 512 ? 110 : 235) + 36 + 24 },
  streak: { group: 'stats', w: [1, 1, 2], h: [2, 2, 3] },
  checkInStreak: { group: 'stats', w: [1, 1, 2], h: [2, 2, 3] },
  // The heatmap is 406 by 112 and fills the card's width (24px of padding);
  // above it the head and the layer switch, under it the legend line.
  rhythm: { group: 'stats', w: [2, 2, 4], h: [3, 4, 8], heightAt: (px) => ((px - 24) * 112) / 406 + 24 + 36 + 44 + 24 },
  milestone: { group: 'stats', w: [1, 1, 2], h: [2, 2, 3] },
  tracker: { group: 'stats', w: [1, 1, 4], h: [2, 2, 6], target: 'tracker' },
  weekRecap: { group: 'stats', w: [2, 2, 4], h: [4, 4, 10], pro: true },
  files: { group: 'keep', w: [1, 1, 4], h: [2, 4, 12] },
  bookmarks: { group: 'keep', w: [1, 1, 4], h: [2, 4, 12] },
  birthdays: { group: 'keep', w: [1, 1, 2], h: [2, 3, 8] },
} as const satisfies Record<string, WidgetDef>;

export type WidgetKind = keyof typeof WIDGET_DEFS;
export const WIDGETS: Record<WidgetKind, WidgetDef> = WIDGET_DEFS;
export const WIDGET_KINDS = Object.keys(WIDGETS) as WidgetKind[];

export function isWidgetKind(k: string): k is WidgetKind {
  return Object.prototype.hasOwnProperty.call(WIDGETS, k);
}

/** One widget on Home. `k` is a string: a kind from a newer app is kept. */
export interface Widget {
  i: string;
  k: string;
  /** Width in columns, 1 to HOME_COLS. */
  w: number;
  /** Height in rows. */
  h: number;
  r?: string;
  /** Fields a newer app wrote that this one does not know, kept as they are. */
  x?: Record<string, unknown>;
}

const ID = /^[a-z0-9]{1,12}$/;
const KIND = /^[A-Za-z]{1,24}$/;
const SIZES: readonly WidgetSize[] = ['s', 'm', 'l'];
const TARGET_MAX = 200;
/** Most widgets one layout holds. */
export const MAX_WIDGETS = 40;
// The reader drops a register over this length whole, so the writer refuses
// a longer list rather than let one device's save read as stock on another.
// It may only ever grow. Spec: docs/internal/specs/dashboard.md (section 6, the cap)
const JSON_MAX = 16384;
const KNOWN_FIELDS = new Set(['i', 'k', 's', 'w', 'h', 'r']);

const clamp = (n: number, [lo, , hi]: Range) => Math.max(lo, Math.min(hi, n));
const WIDTH_OF: Record<WidgetSize, number> = { s: 1, m: 2, l: HOME_COLS };
/** The letter an older app reads: the nearest of one column, two, or the row. */
const sizeLetter = (w: number): WidgetSize => (w <= 1 ? 's' : w === 2 ? 'm' : 'l');
const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : null);

/** A widget's width and height held to what its kind allows. */
export function fitSize(k: string, w: number, h: number): { w: number; h: number } {
  if (!isWidgetKind(k)) return { w: Math.max(1, Math.min(HOME_COLS, w)), h: Math.max(1, Math.min(MAX_ROWS, h)) };
  const def = WIDGETS[k];
  return { w: clamp(w, def.w), h: clamp(h, def.h) };
}

function readWidget(raw: unknown): Widget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.i !== 'string' || !ID.test(o.i)) return null;
  if (typeof o.k !== 'string' || !KIND.test(o.k)) return null;
  const s = typeof o.s === 'string' && (SIZES as readonly string[]).includes(o.s) ? (o.s as WidgetSize) : null;
  let wide = count(o.w, HOME_COLS);
  // An app from before free sizes changed the letter and kept our `w` as a
  // field it does not know: its letter is the newer choice.
  if (wide !== null && s && sizeLetter(wide) !== s) wide = WIDTH_OF[s];
  const known = isWidgetKind(o.k);
  if (wide === null && s) wide = WIDTH_OF[s];
  if (wide === null && !known) return null;
  const def = known ? WIDGETS[o.k as WidgetKind] : null;
  const w: Widget = { i: o.i, k: o.k, ...fitSize(o.k, wide ?? def!.w[1], count(o.h, MAX_ROWS) ?? def?.h[1] ?? 3) };
  if (o.r !== undefined) {
    if (typeof o.r !== 'string' || o.r.length < 1 || o.r.length > TARGET_MAX) return null;
    w.r = o.r;
  }
  const extra = Object.entries(o).filter(([key]) => !KNOWN_FIELDS.has(key));
  if (extra.length) w.x = Object.fromEntries(extra);
  return w;
}

/** A widget list read from storage: bad entries and duplicate ids dropped, the cap applied. */
function readList(raw: unknown): Widget[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: Widget[] = [];
  for (const item of raw) {
    const w = readWidget(item);
    if (!w || seen.has(w.i)) continue;
    seen.add(w.i);
    out.push(w);
    if (out.length >= MAX_WIDGETS) break;
  }
  return out;
}

function toStored(w: Widget): Record<string, unknown> {
  return { ...(w.x ?? {}), i: w.i, k: w.k, s: sizeLetter(w.w), w: w.w, h: w.h, ...(w.r !== undefined ? { r: w.r } : {}) };
}

// ------------------------------------------------------------------
// The stock layout and the layouts a person can start from
// ------------------------------------------------------------------

export type LayoutId = 'everyday' | 'journal' | 'planner' | 'writer';
export const LAYOUT_IDS: readonly LayoutId[] = ['everyday', 'journal', 'planner', 'writer'];

/** [id, kind, width, height] */
type Spec = readonly (readonly [string, WidgetKind, number, number])[];
const fromSpec = (spec: Spec): Widget[] => spec.map(([i, k, w, h]) => ({ i, k, w, h }));

// The ids are fixed, so two devices that both hold a stock layout write the
// same list. Each fills its rows at four columns with no hole; the packer
// fills what narrower panes leave. Spec: docs/internal/specs/dashboard.md (section 6, layouts)
const LAYOUTS: Record<LayoutId, Spec> = {
  everyday: [
    ['e1', 'checkIn', 2, 2], ['e2', 'calendar', 1, 5], ['e3', 'upcoming', 1, 5],
    ['e4', 'week', 2, 3],
    ['e5', 'recent', 2, 4], ['e6', 'tasks', 1, 6], ['e7', 'pinned', 1, 6],
    ['e8', 'streak', 1, 2], ['e9', 'onThisDay', 1, 2],
  ],
  journal: [
    ['j1', 'checkIn', 2, 2], ['j2', 'calendar', 1, 5], ['j3', 'onThisDay', 1, 5],
    ['j4', 'today', 2, 3],
    ['j5', 'checkInStreak', 1, 2], ['j6', 'streak', 1, 2], ['j7', 'rhythm', 2, 4],
    ['j8', 'recent', 2, 2],
  ],
  planner: [
    ['p1', 'upcoming', 2, 5], ['p2', 'calendar', 1, 5], ['p3', 'birthdays', 1, 5],
    ['p4', 'tasks', 2, 6], ['p5', 'pinned', 1, 6], ['p6', 'recent', 1, 6],
  ],
  writer: [
    ['w1', 'week', 2, 3], ['w2', 'streak', 1, 3], ['w3', 'milestone', 1, 3],
    ['w4', 'recent', 2, 4], ['w5', 'rhythm', 2, 4],
  ],
};

export function layoutWidgets(id: LayoutId): Widget[] {
  return fromSpec(LAYOUTS[id]);
}

export function stockDashboard(): Widget[] {
  return layoutWidgets('everyday');
}

function sameList(a: readonly Widget[], b: readonly Widget[]): boolean {
  return JSON.stringify(a.map(toStored)) === JSON.stringify(b.map(toStored));
}

export function isStockDashboard(list: readonly Widget[]): boolean {
  return sameList(list, stockDashboard());
}

// ------------------------------------------------------------------
// Edits. Each returns a new list; the caller writes it.
// ------------------------------------------------------------------

/** An id not in the list. */
export function newWidgetId(list: readonly Widget[], random: () => number = Math.random): string {
  const taken = new Set(list.map((w) => w.i));
  for (;;) {
    const id = Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
    if (!taken.has(id)) return id;
  }
}

/** Add a widget at the start or the end. Refused (same list back) when the
 *  result would not fit the register. */
export function addWidget(
  list: readonly Widget[],
  k: WidgetKind,
  opts: { r?: string; at?: 'start' | 'end'; id?: string } = {},
): Widget[] {
  const def = WIDGETS[k];
  const w: Widget = { i: opts.id ?? newWidgetId(list), k, w: def.w[1], h: def.h[1] };
  if (opts.r !== undefined) w.r = opts.r.slice(0, TARGET_MAX);
  const next = opts.at === 'start' ? [w, ...list] : [...list, w];
  return fitsDashboard(next) ? next : (list as Widget[]);
}

export function removeWidget(list: readonly Widget[], id: string): Widget[] {
  return list.filter((w) => w.i !== id);
}

export function moveWidget(list: readonly Widget[], id: string, to: number): Widget[] {
  const from = list.findIndex((w) => w.i === id);
  if (from < 0) return list as Widget[];
  const out = list.filter((w) => w.i !== id);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, list[from]!);
  return out;
}

/** Set a widget's width and height, held to what its kind allows. */
export function resizeWidget(list: readonly Widget[], id: string, w: number, h: number): Widget[] {
  return list.map((x) => (x.i === id ? { ...x, ...fitSize(x.k, w, h) } : x));
}

export function retargetWidget(list: readonly Widget[], id: string, r: string): Widget[] {
  return list.map((w) => (w.i === id ? { ...w, r: r.slice(0, TARGET_MAX) } : w));
}

/** The widget that already shows this target, if any. */
export function widgetFor(list: readonly Widget[], k: WidgetKind, r: string): Widget | undefined {
  return list.find((w) => w.k === k && w.r === r);
}

// ------------------------------------------------------------------
// Placement: where each widget sits for a number of columns
// ------------------------------------------------------------------

export interface Box {
  id: string;
  /** Column and row, from 0. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Place boxes on a grid of `cols` columns, in list order: each takes the
 * first free place that fits, row by row, start to end. A later small box
 * fills a hole an earlier large one left, so no row is held open by its
 * tallest card. A box wider than the grid is made as wide as the grid.
 * The result is sorted by row, then column: the reading and Tab order.
 */
export function packBoxes(items: readonly { id: string; w: number; h: number }[], cols: number): Box[] {
  const taken: boolean[][] = [];
  const free = (x: number, y: number, w: number, h: number) => {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (taken[r]?.[c]) return false;
    return true;
  };
  const out: Box[] = [];
  for (const item of items) {
    const w = Math.max(1, Math.min(cols, item.w));
    const h = Math.max(1, item.h);
    let y = 0;
    let x = -1;
    for (; x < 0; y++) {
      for (let c = 0; c + w <= cols; c++) {
        if (free(c, y, w, h)) {
          x = c;
          break;
        }
      }
    }
    y--;
    for (let r = y; r < y + h; r++) {
      taken[r] ??= [];
      for (let c = x; c < x + w; c++) taken[r]![c] = true;
    }
    out.push({ id: item.id, x, y, w, h });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Close the holes packing leaves: each box grows down, a row at a time, while
 * the row under it is free across its whole width and inside the grid's
 * height; then sideways, a column at a time, toward the end and then the
 * start, while that column is free along its whole height. Then the page
 * ends on one straight edge and no card sits beside a gap. Only how Home
 * draws: the saved size does not change.
 */
export function fillHoles(boxes: readonly Box[], cols: number): Box[] {
  const rows = boxes.reduce((n, b) => Math.max(n, b.y + b.h), 0);
  const taken = new Set<string>();
  const mark = (b: Box) => {
    for (let r = b.y; r < b.y + b.h; r++) for (let c = b.x; c < b.x + b.w; c++) taken.add(`${c},${r}`);
  };
  const freeRow = (r: number, x: number, w: number) => {
    for (let c = x; c < x + w; c++) if (taken.has(`${c},${r}`)) return false;
    return r < rows;
  };
  const freeCol = (c: number, y: number, h: number) => {
    for (let r = y; r < y + h; r++) if (taken.has(`${c},${r}`)) return false;
    return c >= 0 && c < cols;
  };
  boxes.forEach(mark);
  const out = boxes.map((b) => ({ ...b }));
  for (const b of out) {
    while (freeRow(b.y + b.h, b.x, b.w)) {
      b.h++;
      mark(b);
    }
  }
  for (const b of out) {
    while (freeCol(b.x + b.w, b.y, b.h)) {
      b.w++;
      mark(b);
    }
    while (freeCol(b.x - 1, b.y, b.h)) {
      b.x--;
      b.w++;
      mark(b);
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Storage: one register in the settings blob
// ------------------------------------------------------------------

/** The settings field: a register map with one key, `layout`. */
export type DashboardSetting = RegisterMap;
const REGISTER = 'layout';

export function validateDashboardSetting(raw: unknown, now = Date.now()): DashboardSetting {
  return validateRegisterMap(raw, (k) => k === REGISTER, JSON_MAX, now);
}

export function mergeDashboardSettings(local: DashboardSetting, remote: DashboardSetting, now = Date.now()): DashboardSetting {
  return mergeRegisterMaps(local, remote, now);
}

export const dashboardSettingsEqual = registerMapsEqual;

/** The saved list, or null for stock (no register, a reset, or a bad value). */
export function readDashboardSetting(setting: DashboardSetting | undefined): Widget[] | null {
  const v = setting?.[REGISTER]?.v;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return readList((parsed as Record<string, unknown>).w);
  } catch {
    return null;
  }
}

/** The list Home draws. */
export function dashboardWidgets(setting: DashboardSetting | undefined): Widget[] {
  return readDashboardSetting(setting) ?? stockDashboard();
}

/** Whether a list fits the register: the widget cap and the stored length. */
export function fitsDashboard(list: readonly Widget[]): boolean {
  return list.length <= MAX_WIDGETS && JSON.stringify({ w: list.map(toStored) }).length <= JSON_MAX;
}

/** Save a list; the stock list is saved as a reset. A list that does not fit
 *  is refused, never trimmed. Refused or unchanged comes back as the same
 *  object. */
export function writeDashboardSetting(setting: DashboardSetting, next: readonly Widget[] | null): DashboardSetting {
  const prev = setting[REGISTER];
  let v: string | null = null;
  if (next && !isStockDashboard(next)) {
    if (!fitsDashboard(next)) return setting;
    v = JSON.stringify({ w: next.map(toStored) });
  }
  if (prev ? prev.v === v : v === null) return setting;
  return { ...setting, [REGISTER]: { v, at: stampAfter(prev?.at) } };
}
