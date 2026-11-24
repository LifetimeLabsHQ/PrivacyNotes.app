/**
 * The group headers of a list. Grouping is decoupled from sorting: `groupBy`
 * chooses the foldable buckets (None, Date, First letter, Type, Folder,
 * Website) and `sortField` + `sortDir` orders items inside each bucket
 * (including when sorted by Size). Whenever a list mixes pinned and unpinned
 * items, pinned items always get their own foldable Pinned group above the
 * rest (even when grouping is None).
 *
 * `buildGroups` never reorders: it cuts contiguous runs from an already ordered
 * list. `orderForGroup` / `orderNotesForGroup` order a sorted list into those
 * runs ahead of it so every consumer of the list (multi-select range select,
 * keyboard navigation, Files lightbox) shares one on-screen order.
 *
 * Generic over the item, so the list shell of every pane can call it.
 * Spec: docs/internal/specs/list-groups.md
 */
import { type GroupBy, type SortField } from './listPrefs';
import { linkDomain, parseLinkBody } from './linkBody';
import type { View } from './views';
import { orderViews } from './viewRows';

/** A run of the sorted list: `count` items from index `start`. */
export interface ListGroup {
  key: string;
  start: number;
  count: number;
}

export type GroupBasis = 'date' | 'title' | 'type' | 'folder' | 'site';

/** Which `GroupBy` choices a view offers in the list options dropdown. */
export function groupOptionsForView(view: View): readonly GroupBy[] {
  if (view === 'home' || view === 'starred' || view === 'archive' || view === 'trash' || view === 'tasks') {
    return ['none', 'date', 'letter', 'type', 'folder'];
  }
  if (view === 'vault' || view === 'files') {
    return ['none', 'type', 'date', 'letter', 'folder'];
  }
  if (view === 'contacts') {
    return ['none', 'letter', 'date', 'folder'];
  }
  if (view === 'bookmarks') {
    return ['none', 'date', 'site', 'letter', 'folder'];
  }
  if (view === 'journal') {
    return ['none', 'date', 'folder'];
  }
  return ['none', 'date', 'letter', 'folder'];
}

/** Stored `groupBy` restricted to the options `view` supports; unsupported values fall back to `'none'`. */
export function effectiveGroupByForView(groupBy: GroupBy, view: View): GroupBy {
  return groupOptionsForView(view).includes(groupBy) ? groupBy : 'none';
}

/** Which group basis is active for `groupBy` (optionally scoped to `view`), or null for none. */
export function groupBasisFor(groupBy: GroupBy, view?: View): GroupBasis | null {
  const active = view ? effectiveGroupByForView(groupBy, view) : groupBy;
  if (active === 'none') return null;
  if (active === 'letter') return 'title';
  return active;
}

/** Which type-grouping taxonomy a view uses, or null for single-type views. */
export type TypeGroupMode = 'pillar' | 'vault' | 'files';

export function typeGroupModeForView(view: View): TypeGroupMode | null {
  if (view === 'home' || view === 'starred' || view === 'archive' || view === 'trash' || view === 'tasks') {
    return 'pillar';
  }
  if (view === 'vault') return 'vault';
  if (view === 'files') return 'files';
  return null;
}

/** Group key for a note's type under `'pillar'` (All/Pinned/Archive/Trash/Tasks) or `'vault'`. */
export function noteTypeGroupKey(type: string | undefined, mode: 'pillar' | 'vault'): string {
  const t = type ?? 'note';
  if (mode === 'vault') {
    if (t === 'login' || t === 'card' || t === 'ssh-key') return `type:${t}`;
    return 'type:other';
  }
  if (t === 'login' || t === 'card' || t === 'ssh-key') return 'type:vault';
  if (
    t === 'note' ||
    t === 'task' ||
    t === 'drawing' ||
    t === 'file' ||
    t === 'journal' ||
    t === 'event' ||
    t === 'contact' ||
    t === 'link'
  ) {
    return `type:${t}`;
  }
  return 'type:other';
}

/** Group key for a Files list category (`Images`, `Audio`, `Files`). */
export function fileTypeGroupKey(category: 'image' | 'audio' | 'document'): string {
  return `type:${category}`;
}

export const UNFILED_GROUP_KEY = 'f:unfiled';
export const SITE_OTHER_KEY = 'site:other';

/** Group key for an item's folder; unknown or missing folder ids map to Unfiled. */
export function folderGroupKey(
  folderId: string | null | undefined,
  folderNames: ReadonlyMap<string, string>,
): string {
  return folderId && folderNames.has(folderId) ? `f:${folderId}` : UNFILED_GROUP_KEY;
}

/** Group key for a bookmark's domain. PIN-gated bookmarks never parse their body. */
export function siteGroupKey(body: string, locked: boolean): string {
  if (locked) return SITE_OTHER_KEY;
  const domain = linkDomain(parseLinkBody(body).url).trim().toLowerCase();
  return domain ? `site:${domain}` : SITE_OTHER_KEY;
}

const DEFAULT_PILLAR_TYPE_ROWS: readonly { key: View; groupKey: string }[] = [
  { key: 'all', groupKey: 'type:note' },
  { key: 'tasks', groupKey: 'type:task' },
  { key: 'drawings', groupKey: 'type:drawing' },
  { key: 'vault', groupKey: 'type:vault' },
  { key: 'files', groupKey: 'type:file' },
  { key: 'journal', groupKey: 'type:journal' },
  { key: 'calendar', groupKey: 'type:event' },
  { key: 'contacts', groupKey: 'type:contact' },
  { key: 'bookmarks', groupKey: 'type:link' },
];

/** Canonical pillar type-group order, following the user's sidebar order (`viewOrder`). */
export function pillarTypeOrder(viewOrder: readonly View[] = [], first?: string): string[] {
  const ordered = orderViews([...DEFAULT_PILLAR_TYPE_ROWS], viewOrder).map((r) => r.groupKey);
  if (first) {
    const idx = ordered.indexOf(first);
    if (idx > 0) {
      ordered.splice(idx, 1);
      ordered.unshift(first);
    }
  }
  ordered.push('type:other');
  return ordered;
}

export const VAULT_TYPE_ORDER: readonly string[] = ['type:login', 'type:card', 'type:ssh-key', 'type:other'];
export const FILE_TYPE_ORDER: readonly string[] = ['type:image', 'type:audio', 'type:document'];

export const PINNED_KEY = 'pinned';
/** The unpinned items under a standalone Pinned fold (when grouping is None). */
export const REST_KEY = 'rest';
export const SYMBOL_KEY = '#';
/** Han characters, which have no reading the app could index by. */
export const OTHER_KEY = 'other';

const DAY_MS = 86_400_000;

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The date bucket of a day: today, yesterday, previous 7 days (2 to 6 days
 * ago), previous 30 days (7 to 29), then the month when it is this year, else
 * the year. A day in the future falls into its month or year.
 */
export function dateBucket(day: Date, now: Date): string {
  // Rounded, because a day that crosses a daylight-saving change is 23 or 25 hours.
  const ago = Math.round((localMidnight(now) - localMidnight(day)) / DAY_MS);
  if (ago === 0) return 'today';
  if (ago === 1) return 'yesterday';
  if (ago >= 2 && ago < 7) return 'prev7';
  if (ago >= 7 && ago < 30) return 'prev30';
  const y = day.getFullYear();
  if (y === now.getFullYear()) return `m:${y}-${String(day.getMonth() + 1).padStart(2, '0')}`;
  return `y:${y}`;
}

/** Chronological rank of a date bucket (higher = newer), so decoupled Date grouping orders buckets newest-first. */
export function dateBucketRank(key: string, now: Date): number {
  const todayMs = localMidnight(now);
  if (key === 'today') return todayMs;
  if (key === 'yesterday') return todayMs - DAY_MS;
  if (key === 'prev7') return todayMs - 2 * DAY_MS;
  if (key === 'prev30') return todayMs - 7 * DAY_MS;
  if (key.startsWith('m:')) {
    const [y, m] = key.slice(2).split('-').map(Number);
    const futureMonth =
      y! > now.getFullYear() ||
      (y! === now.getFullYear() && (m! - 1 > now.getMonth() || (m! - 1 === now.getMonth() && now.getDate() < 31)));
    return futureMonth ? new Date(y!, m!, 1).getTime() : new Date(y!, m! - 1, 1).getTime();
  }
  if (key.startsWith('y:')) {
    const y = Number(key.slice(2));
    return y > now.getFullYear() ? new Date(y, 0, 1).getTime() : new Date(y, 11, 31).getTime();
  }
  return Number.NEGATIVE_INFINITY;
}

// Hangul leading consonants U+1100 to U+1112, as the jamo a reader knows.
const HANGUL_INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
// The first kana of each row of the gojuon, in code point order.
const KANA_ROWS = 'あかさたなはまやらわ';

/**
 * The index letter of a title: `l:` and the letter, `#` for a digit or a
 * symbol, or `other` for Han. The letter is upper case, and loses its accent
 * when the collator says the accent does not count, so "Élan" files under E
 * where the sort puts it there.
 */
export function letterKey(title: string, collator: Intl.Collator, locale?: string): string {
  const chars = [...title.trim()];
  let i = 0;
  // A Thai leading vowel is written first and sorted after its consonant.
  while (i < chars.length - 1 && /[เ-ไ]/.test(chars[i]!)) i++;
  const ch = chars[i];
  if (!ch || !/\p{L}/u.test(ch)) return SYMBOL_KEY;
  if (/\p{Script=Han}/u.test(ch)) return OTHER_KEY;
  if (/\p{Script=Hangul}/u.test(ch)) {
    const lead = ch.normalize('NFD').codePointAt(0)!;
    const jamo = lead >= 0x1100 && lead <= 0x1112 ? HANGUL_INITIALS[lead - 0x1100] : ch;
    return `l:${jamo}`;
  }
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) {
    // NFKC first: halfwidth katakana (ｶ) sorts with its fullwidth form (カ).
    let cp = ch.normalize('NFKC').codePointAt(0)!;
    if (cp >= 0x30a1 && cp <= 0x30f6) cp -= 0x60;
    let row = KANA_ROWS[0]!;
    for (const start of KANA_ROWS) if (cp >= start.codePointAt(0)!) row = start;
    return `l:${row}`;
  }
  const upper = [...ch.toLocaleUpperCase(locale)][0]!;
  const bare = upper.normalize('NFD').replace(/\p{M}/gu, '');
  return `l:${bare && collator.compare(bare, upper) === 0 ? bare : upper}`;
}

/** Order letter group keys: `#` first, letters by collator, Han (`other`) last. */
function compareLetterKeys(a: string, b: string, collator: Intl.Collator): number {
  if (a === b) return 0;
  if (a === SYMBOL_KEY) return -1;
  if (b === SYMBOL_KEY) return 1;
  if (a === OTHER_KEY) return 1;
  if (b === OTHER_KEY) return -1;
  return collator.compare(a.startsWith('l:') ? a.slice(2) : a, b.startsWith('l:') ? b.slice(2) : b);
}

/** Order folder group keys alphabetically by display name, with Unfiled always last. */
function compareFolderKeys(
  a: string,
  b: string,
  folderNames: ReadonlyMap<string, string>,
  collator: Intl.Collator,
): number {
  if (a === b) return 0;
  if (a === UNFILED_GROUP_KEY) return 1;
  if (b === UNFILED_GROUP_KEY) return -1;
  const na = folderNames.get(a.slice(2)) ?? '';
  const nb = folderNames.get(b.slice(2)) ?? '';
  const cmp = collator.compare(na, nb);
  return cmp !== 0 ? cmp : a < b ? -1 : 1;
}

/** Order website group keys alphabetically by domain, with Other always last. */
function compareSiteKeys(a: string, b: string, collator: Intl.Collator): number {
  if (a === b) return 0;
  if (a === SITE_OTHER_KEY) return 1;
  if (b === SITE_OTHER_KEY) return -1;
  return collator.compare(a.slice(5), b.slice(5));
}

/** Compare keys against a fixed order list (pillar types, Vault kinds, File categories). */
export function compareOrderedKeys(order: readonly string[]): (a: string, b: string) => number {
  const rank = new Map(order.map((k, i) => [k, i] as const));
  return (a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
  };
}

const groupCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * Reorder an already-sorted list into group buckets while keeping the chosen
 * sort intact inside each bucket. When the list mixes pinned and unpinned
 * items, pinned items stay together at the top in their sorted order (for the
 * single foldable Pinned group); when everything is pinned (e.g. Pinned view)
 * or nothing is pinned, every item joins its bucket.
 */
export function orderForGroup<T>(
  sorted: readonly T[],
  o: {
    basis: GroupBasis | null;
    isPinned: (item: T) => boolean;
    keyOf: (item: T) => string;
    compareKeys: (a: string, b: string) => number;
  },
): T[] {
  if (o.basis === null || sorted.length <= 1) return sorted.slice();
  const mixed = sorted.some(o.isPinned) && !sorted.every(o.isPinned);
  const pinned: T[] = [];
  const buckets = new Map<string, T[]>();
  for (const item of sorted) {
    if (mixed && o.isPinned(item)) {
      pinned.push(item);
      continue;
    }
    const key = o.keyOf(item);
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(item);
  }
  const orderedKeys = [...buckets.keys()].sort(o.compareKeys);
  const out = pinned;
  for (const key of orderedKeys) {
    out.push(...buckets.get(key)!);
  }
  return out;
}

/**
 * Order any sorted item list into the active `GroupBasis` buckets while
 * preserving the user's chosen `sortField` + `sortDir` inside every bucket.
 *
 * Always groups into contiguous buckets so no duplicate headers can appear
 * (e.g. Hiragana + Katakana sharing a kana row under Title sort, or Journals
 * sorted by Date modified while grouped by entry date).
 */
export function orderItemsForGroup<T>(
  sorted: readonly T[],
  o: {
    basis: GroupBasis | null;
    sortField: SortField;
    sortDir?: 'asc' | 'desc';
    now: Date;
    isPinned: (item: T) => boolean;
    dateOf: (item: T) => Date;
    titleOf: (item: T) => string;
    hidesTitle: (item: T) => boolean;
    typeOf?: (item: T) => string;
    typeOrder?: readonly string[];
    folderOf?: (item: T) => string;
    folderNames?: ReadonlyMap<string, string>;
    siteOf?: (item: T) => string;
    collator?: Intl.Collator;
  },
): T[] {
  const { basis, sortField, sortDir = 'desc' } = o;
  if (!basis || sorted.length <= 1) return sorted.slice();
  const collator = o.collator ?? groupCollator;
  if (basis === 'date') {
    const oldestFirst = (sortField === 'modified' || sortField === 'created') && sortDir === 'asc';
    return orderForGroup(sorted, {
      basis,
      isPinned: o.isPinned,
      keyOf: (item) => dateBucket(o.dateOf(item), o.now),
      compareKeys: (a, b) =>
        oldestFirst
          ? dateBucketRank(a, o.now) - dateBucketRank(b, o.now)
          : dateBucketRank(b, o.now) - dateBucketRank(a, o.now),
    });
  }
  if (basis === 'title') {
    const desc = sortField === 'title' && sortDir === 'desc';
    return orderForGroup(sorted, {
      basis,
      isPinned: o.isPinned,
      keyOf: (item) => (o.hidesTitle(item) ? SYMBOL_KEY : letterKey(o.titleOf(item), collator)),
      compareKeys: (a, b) => (desc ? compareLetterKeys(b, a, collator) : compareLetterKeys(a, b, collator)),
    });
  }
  if (basis === 'type' && o.typeOf && o.typeOrder) {
    return orderForGroup(sorted, {
      basis,
      isPinned: o.isPinned,
      keyOf: o.typeOf,
      compareKeys: compareOrderedKeys(o.typeOrder),
    });
  }
  if (basis === 'folder' && o.folderOf) {
    const names = o.folderNames ?? new Map<string, string>();
    return orderForGroup(sorted, {
      basis,
      isPinned: o.isPinned,
      keyOf: o.folderOf,
      compareKeys: (a, b) => compareFolderKeys(a, b, names, collator),
    });
  }
  if (basis === 'site' && o.siteOf) {
    return orderForGroup(sorted, {
      basis,
      isPinned: o.isPinned,
      keyOf: o.siteOf,
      compareKeys: (a, b) => compareSiteKeys(a, b, collator),
    });
  }
  return sorted.slice();
}

/** Whether two neighbouring keys are one group. Letters compare with the
 *  sort's collator; every other key must match exactly. */
function sameGroup(a: string, b: string, collator: Intl.Collator): boolean {
  if (a === b) return true;
  return a.startsWith('l:') && b.startsWith('l:') && collator.compare(a.slice(2), b.slice(2)) === 0;
}

export interface GroupOptions<T> {
  /** Active group basis (`'date'`, `'title'`, `'type'`, `'folder'`, `'site'`), or `null` to split pinned from unpinned only. */
  basis: GroupBasis | null;
  now: Date;
  /** The day the date grouping reads for an item. */
  dateOf: (item: T) => Date;
  /** The title the row shows. */
  titleOf: (item: T) => string;
  /** The type group key (e.g. `'type:note'`) when `basis === 'type'`. */
  typeOf?: (item: T) => string;
  /** The folder group key (`'f:<id>'` or `'f:unfiled'`) when `basis === 'folder'`. */
  folderOf?: (item: T) => string;
  /** The site group key (`'site:<domain>'` or `'site:other'`) when `basis === 'site'`. */
  siteOf?: (item: T) => string;
  isPinned: (item: T) => boolean;
  /**
   * True for an item whose row hides its title, behind a closed PIN gate with
   * no stored title. Under title sort it joins the group above it; under
   * decoupled letter grouping it sits in `#`, so no header ever names the first
   * letter of a hidden body.
   */
  hidesTitle: (item: T) => boolean;
  /** The collator the sort uses, so the groups never cut a run in two. */
  collator: Intl.Collator;
  locale?: string;
}

/**
 * The groups of an already ordered list. Pinned items form their own group,
 * but only beside unpinned ones: in a list of pinned items alone, the header
 * would say nothing. When `basis` is null (Group by None), only a mixed list
 * gets groups: `pinned` and `rest`.
 */
export function buildGroups<T>(items: readonly T[], o: GroupOptions<T>): ListGroup[] {
  const mixed = items.some(o.isPinned) && !items.every(o.isPinned);
  if (o.basis === null && !mixed) return [];
  const groups: ListGroup[] = [];
  items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    let key: string;
    if (mixed && o.isPinned(item)) key = PINNED_KEY;
    else if (o.basis === null) key = REST_KEY;
    else if (o.basis === 'type') key = o.typeOf ? o.typeOf(item) : OTHER_KEY;
    else if (o.basis === 'folder') key = o.folderOf ? o.folderOf(item) : UNFILED_GROUP_KEY;
    else if (o.basis === 'site') key = o.siteOf ? o.siteOf(item) : SITE_OTHER_KEY;
    else if (o.basis === 'date') key = dateBucket(o.dateOf(item), o.now);
    else if (o.hidesTitle(item)) key = last && last.key !== PINNED_KEY ? last.key : SYMBOL_KEY;
    else key = letterKey(o.titleOf(item), o.collator, o.locale);
    if (last && sameGroup(last.key, key, o.collator)) last.count++;
    else groups.push({ key, start: index, count: 1 });
  });
  return groups;
}
