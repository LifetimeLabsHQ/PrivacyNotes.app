/**
 * The format bar a person arranges: every toolbar item, where it lives by
 * default, and the rules that turn a saved arrangement into the bar, the '+'
 * menu and the hidden set.
 *
 * Every item has three possible homes: the bar, the '+' menu (in the
 * person's order inside its own group), or hidden. The picture, file,
 * recording and "picture from Files" items have a fourth: the attach menu,
 * a small menu behind the paperclip button. The bar has two zones,
 * both in the person's order: the row, which gives way behind the "•••" when
 * the bar is narrow, and the end, after the '+', which always stays visible.
 * Two kinds of item never go into the menu: a control that opens a React
 * popover, because the menu closes on the press that would open it, and the
 * recorder, whose button shows the running recording. The recorder can sit
 * in the attach menu, because the toolbar puts its stop button on the bar
 * while it records.
 *
 * The saved arrangement names every list, so a key in none of them is an
 * item a later version added. It takes its stock home and stock position, so
 * a person who arranged the bar still meets the new button.
 * Spec: docs/internal/specs/format-bar.md
 */
import {
  mergeRegisterMaps,
  registerMapsEqual,
  stampAfter,
  validateRegisterMap,
  type RegisterMap,
} from './registers';

/** Where an item lives. `bar` and `end` are the two zones of the bar. */
export type FormatBarHome = 'bar' | 'end' | 'menu' | 'attachMenu' | 'hidden';
export type FormatBarGroup = 'format' | 'insert' | 'blocks' | 'notation';

export type FormatBarItem = {
  key: string;
  /** Stock home. */
  home: FormatBarHome;
  /** The menu group the item sits in when it is in the menu. */
  group: FormatBarGroup;
  /** False for a popover trigger and for the recorder: on the bar or hidden. */
  menuAllowed: boolean;
  /** True for the items the attach menu can hold. */
  attachAllowed: boolean;
};

const row = (key: string, menuAllowed = true): FormatBarItem => ({ key, home: 'bar', group: 'format', menuAllowed, attachAllowed: false });
const menu = (key: string, group: FormatBarGroup, attachAllowed = false): FormatBarItem => ({ key, home: 'menu', group, menuAllowed: true, attachAllowed });
const end = (key: string, menuAllowed = true): FormatBarItem => ({ key, home: 'end', group: 'insert', menuAllowed, attachAllowed: false });
const attached = (key: string, menuAllowed = true): FormatBarItem => ({ key, home: 'attachMenu', group: 'insert', menuAllowed, attachAllowed: true });
// A separator is a thin line on the bar. Each key exists once, so a person
// who wants more than one line takes the next one.
const separator = (key: string): FormatBarItem => ({ key, home: 'hidden', group: 'format', menuAllowed: false, attachAllowed: false });
// Hidden until a person places it, on the bar or in the menu.
const offered = (key: string, group: FormatBarGroup): FormatBarItem => ({ key, home: 'hidden', group, menuAllowed: true, attachAllowed: false });

/** Stock order: the row, the menu, the attach menu, the end of the bar, hidden. */
export const FORMAT_BAR_ITEMS: readonly FormatBarItem[] = [
  row('bold'), row('italic'), row('underline'), row('heading', false), row('tasks'),
  row('link', false), row('notelink'),
  row('color', false), row('align', false), row('font', false),
  row('highlight', false), row('callout', false), row('strike'),
  menu('table', 'insert'), menu('hr', 'insert'), menu('bullets', 'insert'), menu('numbered', 'insert'),
  menu('indent', 'insert'), menu('outdent', 'insert'),
  menu('fromFiles', 'insert', true), menu('date', 'insert'), menu('dateTime', 'insert'), menu('icon', 'insert'), menu('location', 'insert'),
  menu('quote', 'blocks'), menu('codeblock', 'blocks'), menu('copybox', 'blocks'), menu('kanban', 'blocks'),
  menu('inlinecode', 'notation'), menu('math', 'notation'), menu('blockmath', 'notation'),
  menu('superscript', 'notation'), menu('subscript', 'notation'), menu('spoiler', 'notation'),
  menu('footnote', 'notation'),
  // The attach menu's items come before the paperclip in stock order, so an
  // arrangement saved before the paperclip existed gets it after them.
  attached('image'), attached('attach'), attached('audio', false),
  end('attachMenu', false), end('customize'), end('markdownView'),
  offered('copyAsPlain', 'notation'), offered('copyAsMarkdown', 'notation'),
  separator('separator1'), separator('separator2'), separator('separator3'), separator('separator4'),
];

const FORMAT_BAR_GROUPS: readonly FormatBarGroup[] = ['format', 'insert', 'blocks', 'notation'];

/** What a person saved. */
export type FormatBarLayout = { bar: string[]; end: string[]; menu: string[]; attachMenu: string[]; hidden: string[] };

/** What the toolbar draws. */
export type ResolvedFormatBar = {
  /** The row, in order. */
  bar: string[];
  /** The end of the bar, after the '+', in order; it always stays visible. */
  end: string[];
  /** Menu items, grouped in FORMAT_BAR_GROUPS order, the person's order inside a group. */
  menu: string[];
  /** The attach menu, in order. */
  attachMenu: string[];
  hidden: string[];
};

/** Why a move is refused, or null when it is allowed. */
export type FormatBarRefusal = 'menuNotAllowed' | 'attachNotAllowed' | 'lastOnBar' | null;

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
}

/**
 * The rules of one arrangeable bar, over its own item list: the format bar
 * (below) and the drawing canvas's toolbar (`drawing/drawingBar.ts`), which
 * has no menus, so its items live on the bar, at its end, or hidden.
 * `sometimesAbsent` names the items that do not count as the button that
 * keeps a bar usable (see SOMETIMES_ABSENT).
 */
export function createBarModel(items: readonly FormatBarItem[], groups: readonly FormatBarGroup[], sometimesAbsent: ReadonlySet<string>) {
  const BY_KEY = new Map(items.map((i) => [i.key, i]));
  const STOCK_INDEX = new Map(items.map((i, n) => [i.key, n]));
  const byStock = (a: string, b: string) => STOCK_INDEX.get(a)! - STOCK_INDEX.get(b)!;
  const keepsBar = (k: string) => !sometimesAbsent.has(k);

  function item(key: string): FormatBarItem | undefined {
    return BY_KEY.get(key);
  }

  /** Menu order: by group, then the given order inside each group. */
  function groupMenu(keys: string[]): string[] {
    return groups.flatMap((g) => keys.filter((k) => BY_KEY.get(k)!.group === g));
  }

  /**
   * Put `key` into `list` at its stock place: before the first key that follows
   * it in stock order and is already in the list, else at the end. `sameRun`
   * limits the comparison to keys of the same menu group.
   */
  function insertAtStockPlace(list: string[], key: string, sameRun: (k: string) => boolean = () => true): void {
    const at = list.findIndex((k) => sameRun(k) && byStock(k, key) > 0);
    if (at === -1) {
      // After the last key of the same run, so a menu item lands in its group.
      let last = -1;
      list.forEach((k, n) => { if (sameRun(k)) last = n; });
      list.splice(last === -1 ? list.length : last + 1, 0, key);
    } else {
      list.splice(at, 0, key);
    }
  }

  function stock(): ResolvedFormatBar {
    const at = (home: FormatBarItem['home']) => items.filter((i) => i.home === home).map((i) => i.key);
    return { bar: at('bar'), end: at('end'), menu: groupMenu(at('menu')), attachMenu: at('attachMenu'), hidden: at('hidden') };
  }

  /**
   * Turn a saved arrangement into what the toolbar draws. Total: any input,
   * however malformed, gives a usable bar.
   */
  function resolve(saved: Partial<FormatBarLayout> | null | undefined): ResolvedFormatBar {
    if (!saved || typeof saved !== 'object') return stock();
    const seen = new Set<string>();
    const take = (raw: unknown) => strings(raw).filter((k) => {
      if (!BY_KEY.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const bar = take(saved.bar);
    const endList = take(saved.end);
    const menuList: string[] = [];
    for (const k of take(saved.menu)) {
      // An item that cannot be in the menu goes back to the end of the bar.
      if (BY_KEY.get(k)!.menuAllowed) menuList.push(k);
      else endList.push(k);
    }
    const attachList: string[] = [];
    for (const k of take(saved.attachMenu)) {
      // An item the attach menu cannot hold goes back to the end of the bar.
      if (BY_KEY.get(k)!.attachAllowed) attachList.push(k);
      else endList.push(k);
    }
    const hidden = take(saved.hidden);

    // Items no list names: a later version added them. Stock home, stock place.
    for (const i of items) {
      if (seen.has(i.key)) continue;
      if (i.home === 'bar') insertAtStockPlace(bar, i.key);
      else if (i.home === 'end') insertAtStockPlace(endList, i.key);
      else if (i.home === 'attachMenu') insertAtStockPlace(attachList, i.key);
      else if (i.home === 'hidden') insertAtStockPlace(hidden, i.key);
      else insertAtStockPlace(menuList, i.key, (k) => BY_KEY.get(k)!.group === i.group);
    }

    // A bar with no button every editor offers is never what a person saved
    // (the Settings board keeps one); it is damage, and the stock arrangement
    // is the safe answer.
    if (![...bar, ...endList].some(keepsBar)) return stock();

    return { bar, end: endList, menu: groupMenu(menuList), attachMenu: attachList, hidden };
  }

  function isStock(r: ResolvedFormatBar): boolean {
    const s = stock();
    return r.bar.join() === s.bar.join() && r.end.join() === s.end.join()
      && r.menu.join() === s.menu.join() && r.attachMenu.join() === s.attachMenu.join()
      && r.hidden.join() === s.hidden.join();
  }

  function refusal(r: ResolvedFormatBar, key: string, to: FormatBarHome): FormatBarRefusal {
    const i = BY_KEY.get(key);
    if (!i) return null;
    if (to === 'menu' && !i.menuAllowed) return 'menuNotAllowed';
    if (to === 'attachMenu' && !i.attachAllowed) return 'attachNotAllowed';
    const onBar = [...r.bar, ...r.end];
    if (to !== 'bar' && to !== 'end' && onBar.includes(key) && !onBar.some((k) => k !== key && keepsBar(k))) {
      return 'lastOnBar';
    }
    return null;
  }

  /**
   * Move `key` to `to`, before `beforeKey` when that key is in the same list
   * (and, for the menu, the same group), else to the end of the list or group.
   * Returns the input unchanged when the move is refused.
   */
  function place(r: ResolvedFormatBar, key: string, to: FormatBarHome, beforeKey: string | null = null): ResolvedFormatBar {
    const i = BY_KEY.get(key);
    if (!i || refusal(r, key, to)) return r;
    const out: ResolvedFormatBar = {
      bar: r.bar.filter((k) => k !== key),
      end: r.end.filter((k) => k !== key),
      menu: r.menu.filter((k) => k !== key),
      attachMenu: r.attachMenu.filter((k) => k !== key),
      hidden: r.hidden.filter((k) => k !== key),
    };
    if (to === 'menu') {
      const sameGroup = (k: string) => BY_KEY.get(k)!.group === i.group;
      const at = beforeKey && sameGroup(beforeKey) ? out.menu.indexOf(beforeKey) : -1;
      if (at >= 0) {
        out.menu.splice(at, 0, key);
      } else {
        let last = -1;
        out.menu.forEach((k, n) => { if (sameGroup(k)) last = n; });
        if (last === -1) {
          out.menu.push(key);
          out.menu = groupMenu(out.menu);
        } else {
          out.menu.splice(last + 1, 0, key);
        }
      }
      return out;
    }
    const list = out[to];
    const at = beforeKey ? list.indexOf(beforeKey) : -1;
    if (at >= 0) list.splice(at, 0, key);
    else list.push(key);
    return out;
  }

  /**
   * Move `key` one step inside its own list (and, in the menu, its own group).
   * The bar's two zones are one line: a step past the row's last place goes to
   * the start of the end, and a step back from the end's first place goes to
   * the row's last.
   */
  function step(r: ResolvedFormatBar, key: string, dir: -1 | 1): ResolvedFormatBar {
    const home = homeOf(r, key);
    if (!home || home === 'hidden') return r;
    const list = [...r[home]];
    const at = list.indexOf(key);
    const to = at + dir;
    if (home === 'bar' && to >= list.length) {
      return { ...r, bar: list.filter((k) => k !== key), end: [key, ...r.end] };
    }
    if (home === 'end' && to < 0) {
      return { ...r, bar: [...r.bar, key], end: list.filter((k) => k !== key) };
    }
    if (to < 0 || to >= list.length) return r;
    if (home === 'menu' && BY_KEY.get(list[to]!)!.group !== BY_KEY.get(key)!.group) return r;
    [list[at], list[to]] = [list[to]!, list[at]!];
    return { ...r, [home]: list };
  }

  return {
    groups,
    item,
    stock,
    resolve,
    isStock,
    homeOf,
    refusalFor: refusal,
    placeItem: place,
    stepItem: step,
    /** Whether `stepItem` would move the item. */
    canStep: (r: ResolvedFormatBar, key: string, dir: -1 | 1) => step(r, key, dir) !== r,
  };
}

/** The rules of one bar (`createBarModel`). */
export type BarModel = ReturnType<typeof createBarModel>;

/**
 * An item that some editors do not offer: a Markdown folder note has no
 * picture, file, recording or "picture from Files", the Linux app has no
 * recorder, a phone has no "Customize toolbar" (it reaches the tab through
 * Settings), only a note that has a Markdown view offers "Show markdown",
 * and the paperclip shows only while its menu holds something. None of them
 * counts as the button that keeps a bar usable, or that editor could draw an
 * empty bar. A separator is no button at all.
 */
const SOMETIMES_ABSENT = new Set([
  'fromFiles', 'image', 'attach', 'audio', 'customize', 'markdownView', 'attachMenu',
  'separator1', 'separator2', 'separator3', 'separator4',
]);

/** The format bar's rules. */
export const FORMAT_BAR = createBarModel(FORMAT_BAR_ITEMS, FORMAT_BAR_GROUPS, SOMETIMES_ABSENT);

export const formatBarItem = FORMAT_BAR.item;
export const stockFormatBar = FORMAT_BAR.stock;
export const resolveFormatBar = FORMAT_BAR.resolve;
export const isStockFormatBar = FORMAT_BAR.isStock;
export const refusalFor = FORMAT_BAR.refusalFor;
export const placeItem = FORMAT_BAR.placeItem;
export const stepItem = FORMAT_BAR.stepItem;
export const canStep = FORMAT_BAR.canStep;

/** The arrangement to save for what the board shows. */
export function layoutOf(r: ResolvedFormatBar): FormatBarLayout {
  return { bar: [...r.bar], end: [...r.end], menu: [...r.menu], attachMenu: [...r.attachMenu], hidden: [...r.hidden] };
}

export function homeOf(r: ResolvedFormatBar, key: string): FormatBarHome | null {
  for (const home of ['bar', 'end', 'menu', 'attachMenu', 'hidden'] as const) if (r[home].includes(key)) return home;
  return null;
}

// ------------------------------------------------------------------
// Storage: one register in the settings blob
// ------------------------------------------------------------------

/**
 * The settings field. A register map with one key, so it merges like the
 * looks and the custom themes: the later stamp wins at every sync point, and
 * a device that pushes an old blob after some other change cannot take an
 * arrangement back. The value is the arrangement as JSON; null is "stock".
 */
export type FormatBarSetting = RegisterMap;

/** The register of each bar: the format bar's `layout`, the drawing
 *  toolbar's `drawing`. One register map, so both sync the same way. */
export type BarRegister = 'layout' | 'drawing';
const REGISTER_KEYS: ReadonlySet<string> = new Set<BarRegister>(['layout', 'drawing']);
const JSON_MAX = 4096;

export function validateFormatBarSetting(raw: unknown, now = Date.now()): FormatBarSetting {
  return validateRegisterMap(raw, (k) => REGISTER_KEYS.has(k), JSON_MAX, now);
}

export function mergeFormatBarSettings(local: FormatBarSetting, remote: FormatBarSetting, now = Date.now()): FormatBarSetting {
  return mergeRegisterMaps(local, remote, now);
}

export const formatBarSettingsEqual = registerMapsEqual;

/** The saved arrangement, or null for stock (no register, a reset, or bad JSON). */
export function readFormatBarSetting(setting: FormatBarSetting | undefined, register: BarRegister = 'layout'): FormatBarLayout | null {
  const v = setting?.[register]?.v;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    return { bar: strings(p.bar), end: strings(p.end), menu: strings(p.menu), attachMenu: strings(p.attachMenu), hidden: strings(p.hidden) };
  } catch {
    return null;
  }
}

/** Write an arrangement; the stock one is written as a reset. */
export function writeFormatBarSetting(
  setting: FormatBarSetting,
  next: ResolvedFormatBar | null,
  register: BarRegister = 'layout',
  model: BarModel = FORMAT_BAR,
): FormatBarSetting {
  const prev = setting[register];
  const v = !next || model.isStock(next) ? null : JSON.stringify(layoutOf(next));
  if (prev ? prev.v === v : v === null) return setting;
  return { ...setting, [register]: { v, at: stampAfter(prev?.at) } };
}
