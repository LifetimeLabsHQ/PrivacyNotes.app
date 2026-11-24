import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalNote } from './db';
import type { ContextMenuItem } from './ContextMenu';
import { FolderGroupLabelsContext, FolderNamesContext } from './folderNames';
import { resolveGroupBy, type ListPrefs } from './listPrefs';
import type { View } from './views';
import { isDemoMode } from './demo';
import { intlLocale } from './languages';
import { capitalize, monthName, relativeDayName, toLocalIso } from './intlFormat';
import { parseDay } from './localDate';
import { deriveDisplayTitle, editedAtOf, entryDayOf } from './notesViewUtils';
import { CaretDown } from './icons';
import {
  OTHER_KEY,
  PINNED_KEY,
  REST_KEY,
  SITE_OTHER_KEY,
  SYMBOL_KEY,
  UNFILED_GROUP_KEY,
  VAULT_TYPE_ORDER,
  buildGroups,
  folderGroupKey,
  groupBasisFor,
  noteTypeGroupKey,
  orderItemsForGroup,
  pillarTypeOrder,
  siteGroupKey,
  typeGroupModeForView,
  type ListGroup,
} from './listGroups';

/**
 * The group headers of a notes list: the hook every pane calls, the header
 * row, and the fold state behind it. A pane hands its sorted notes in and
 * renders the entries it gets back, so no pane holds a copy of the rules.
 * Spec: docs/internal/specs/list-groups.md
 */

// Device-local, like the layout. The demo gets its own key, because `?demo=1`
// runs on the same origin as a real install.
function foldKey(): string {
  return isDemoMode() ? 'privacynotes.demo.listGroupsFolded' : 'privacynotes.listGroupsFolded';
}

function readFolds(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(foldKey()) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** The collapsed groups of one list scope (a view), kept on this device. */
function useGroupFold(scope: string) {
  const [all, setAll] = useState(readFolds);
  const folded = new Set(Array.isArray(all[scope]) ? all[scope] : []);
  /** Takes the next set from the latest one, so two clicks in one frame both count. */
  const update = useCallback(
    (fn: (prev: Set<string>) => Set<string>) => {
      setAll((prev) => {
        const next = fn(new Set(Array.isArray(prev[scope]) ? prev[scope] : []));
        const out = { ...prev, [scope]: [...next] };
        if (next.size === 0) delete out[scope];
        try {
          localStorage.setItem(foldKey(), JSON.stringify(out));
        } catch {
          // Storage refused (private mode, quota): the fold lasts for this session.
        }
        return out;
      });
    },
    [scope],
  );
  return { folded, update };
}

const TYPE_LABEL_KEYS: Record<string, string> = {
  'type:note': 'shell:tagsRail.notes',
  'type:task': 'shell:tagsRail.tasks',
  'type:drawing': 'shell:tagsRail.drawings',
  'type:vault': 'shell:tagsRail.vault',
  'type:file': 'shell:tagsRail.files',
  'type:journal': 'shell:tagsRail.journals',
  'type:event': 'shell:calendar.kinds.event',
  'type:contact': 'shell:tagsRail.contacts',
  'type:link': 'shell:tagsRail.bookmarks',
  'type:login': 'notes:vaultFilter.logins',
  'type:card': 'notes:vaultFilter.cards',
  'type:ssh-key': 'notes:vaultFilter.keys',
  'type:image': 'notes:settings.imagesLabel',
  'type:audio': 'shell:filesList.filterAudio',
  'type:document': 'shell:filesList.filterFiles',
  'type:other': 'notes:listGroups.other',
};

/** The words on a header. Month, year, today and yesterday come from Intl in
 *  the app language, so no catalog carries them. */
function groupLabel(
  key: string,
  t: (k: string) => string,
  folderNames: ReadonlyMap<string, string>,
): string {
  const loc = intlLocale();
  if (key === PINNED_KEY) return t('shell:tagsRail.pinned');
  if (key.startsWith('type:')) return t(TYPE_LABEL_KEYS[key] ?? 'notes:listGroups.other');
  if (key === UNFILED_GROUP_KEY) return t('shell:folders.unfiled');
  if (key.startsWith('f:')) return folderNames.get(key.slice(2)) ?? t('shell:folders.unfiled');
  if (key === SITE_OTHER_KEY) return t('notes:listGroups.other');
  if (key.startsWith('site:')) return key.slice(5);
  if (key === 'today' || key === 'yesterday') return capitalize(relativeDayName(key === 'today' ? 0 : -1), loc);
  if (key === 'prev7') return t('notes:listGroups.previous7Days');
  if (key === 'prev30') return t('notes:listGroups.previous30Days');
  if (key.startsWith('m:')) {
    const [y, m] = key.slice(2).split('-').map(Number);
    return capitalize(monthName(y!, m! - 1), loc);
  }
  if (key.startsWith('y:')) return key.slice(2);
  if (key === OTHER_KEY || key === REST_KEY) return t('notes:listGroups.other');
  if (key === SYMBOL_KEY) return '#';
  return key.startsWith('l:') ? key.slice(2) : key;
}

const ListGroupHeader = memo(function ListGroupHeader({
  label,
  count,
  collapsed,
  collapsible,
  foldable,
  grid,
  as = 'li',
  onToggle,
  onContextMenu,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  /** False for the unpinned `rest` band under a standalone Pinned fold: marks
   *  where the sorted list starts without offering to collapse the whole list. */
  collapsible: boolean;
  /** False in selection mode, where every item stays on screen. */
  foldable: boolean;
  grid: boolean;
  /** `'div'` for panes whose list container is a `div` (Files); `'li'` for `ul` panes. */
  as?: 'li' | 'div';
  onToggle: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const Tag = as;
  const canToggle = collapsible && foldable;
  return (
    // No data-item-id: the list keys and the tab middle-click skip a header.
    <Tag
      // The grid pads its scroll box by 16 px and a sticky item stops at that
      // padding, so in the grid the header reaches up through it (-top-4 with
      // pt-4): tiles never show above it. -mt-3 takes back the grid's gap-3
      // and no more, so the header's box never covers the tile above it.
      className={`sticky z-10 bg-surface-1 ${grid ? 'col-span-full -top-4 -mt-3 pt-4' : 'top-0 border-b border-divider/50'}`}
      onContextMenu={canToggle ? onContextMenu : undefined}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={foldable ? onToggle : undefined}
          aria-expanded={foldable ? !collapsed : undefined}
          aria-disabled={foldable ? undefined : true}
          className={`w-full flex items-center gap-1.5 text-start text-small font-semibold text-pn-muted select-none ${
            grid ? 'py-1.5' : 'px-4 py-1.5'
          } ${foldable ? 'cursor-pointer hover:text-pn' : 'cursor-default'}`}
        >
          <CaretDown
            aria-hidden="true"
            className={`shrink-0 transition-transform ${foldable ? '' : 'opacity-40'} ${collapsed ? '-rotate-90 rtl:rotate-90' : ''}`}
          />
          <span className="min-w-0 truncate" dir="auto">{label}</span>
          <span className="ms-auto shrink-0 font-normal tabular-nums">{count}</span>
        </button>
      ) : (
        <div
          className={`w-full flex items-center gap-1.5 text-start text-small font-semibold text-pn-muted select-none ${
            grid ? 'py-1.5' : 'px-4 py-1.5'
          }`}
        >
          <span className="min-w-0 truncate" dir="auto">{label}</span>
          <span className="ms-auto shrink-0 font-normal tabular-nums">{count}</span>
        </div>
      )}
    </Tag>
  );
});

/** One line of a grouped item list: a header, or an item with its index in the source array. */
export type ItemGroupEntry<T> =
  | { kind: 'header'; group: ListGroup; collapsed: boolean }
  | { kind: 'item'; item: T; index: number };

/** One line of a grouped notes list: a header, a note, or a tracker gap. */
export type ListEntry =
  | { kind: 'header'; group: ListGroup; collapsed: boolean }
  | { kind: 'note'; note: LocalNote }
  /** The days between two entries while a tracker is in focus in Journals;
   *  `longest` marks the widest gap of the list. Spec: docs/internal/specs/tracker-focus-771.md (section 4) */
  | { kind: 'gap'; days: number; longest: boolean; key: string };

/** The collator `compareNotes` sorts titles with, so a letter group never cuts a run in two. */
const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Today's local date, renewed at local midnight, when the window comes
 *  back (a sleeping machine fires no timer on time), and once a minute, so a
 *  list left open overnight moves its "Today" items to "Yesterday". The
 *  minute check is for Android: its WebView freezes timers in the background
 *  and its timer clock stops in deep sleep, so the midnight timer can fire
 *  hours late and the check-in and medication cards keep the day before
 *  (the likely cause of GitHub #781, not reproduced on a phone). The same
 *  string keeps the render where it is. */
export function useToday(): string {
  const [today, setToday] = useState(() => toLocalIso(new Date()));
  useEffect(() => {
    const check = () => setToday(toLocalIso(new Date()));
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = window.setTimeout(check, midnight.getTime() - now.getTime() + 1000);
    const minute = window.setInterval(check, 60_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(minute);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [today]);
  return today;
}

/**
 * The grouped form of any sorted item list, or null entries when it needs no
 * headers: during a search, or when `showGroups` is off / sorting by size and
 * the list does not mix pinned and unpinned items. Selection mode ignores the
 * fold, so "Select all", a Shift range and a bulk action never reach an item
 * that is not on screen.
 */
export function useItemGroups<T>({
  items,
  idOf,
  dateOf,
  titleOf,
  typeOf,
  folderOf,
  siteOf,
  isPinned,
  hidesTitle,
  listPrefs,
  search,
  scope,
  view,
  selectionMode,
  selectedId,
  onContextMenu,
  as = 'li',
}: {
  items: readonly T[];
  idOf: (item: T) => string;
  dateOf: (item: T) => Date;
  titleOf: (item: T) => string;
  /** Type group key for multi-type lists; omit for single-type lists. */
  typeOf?: (item: T) => string;
  /** Folder group key (`'f:<id>'` or `'f:unfiled'`). */
  folderOf?: (item: T) => string;
  /** Website group key (`'site:<domain>'` or `'site:other'`). */
  siteOf?: (item: T) => string;
  isPinned: (item: T) => boolean;
  hidesTitle: (item: T) => boolean;
  listPrefs: ListPrefs;
  search: string;
  /** The fold scope, one per view. */
  scope: string;
  /** View key used to resolve allowed grouping options. */
  view?: View;
  selectionMode: boolean;
  selectedId: string | null;
  onContextMenu?: (e: React.MouseEvent, items: ContextMenuItem[]) => void;
  as?: 'li' | 'div';
}) {
  const { t } = useTranslation('notes');
  const folderGroupLabels = useContext(FolderGroupLabelsContext);
  const fallbackFolderNames = useContext(FolderNamesContext);
  const folderNames = folderGroupLabels.size > 0 ? folderGroupLabels : fallbackFolderNames;
  const today = useToday();
  const searching = search.trim().length > 0;
  const rawBasis = !searching ? groupBasisFor(resolveGroupBy(listPrefs), view) : null;
  const basis =
    rawBasis === 'type' && !typeOf
      ? null
      : rawBasis === 'folder' && !folderOf
        ? null
        : rawBasis === 'site' && !siteOf
          ? null
          : rawBasis;
  const accessors = useRef({ idOf, dateOf, titleOf, typeOf, folderOf, siteOf, isPinned, hidesTitle });
  accessors.current = { idOf, dateOf, titleOf, typeOf, folderOf, siteOf, isPinned, hidesTitle };
  const groups = useMemo(() => {
    if (searching) return null;
    const built = buildGroups(items, {
      basis,
      now: parseDay(today),
      dateOf: (item) => accessors.current.dateOf(item),
      titleOf: (item) => accessors.current.titleOf(item),
      typeOf: typeOf ? (item) => accessors.current.typeOf!(item) : undefined,
      folderOf: folderOf ? (item) => accessors.current.folderOf!(item) : undefined,
      siteOf: siteOf ? (item) => accessors.current.siteOf!(item) : undefined,
      isPinned: (item) => accessors.current.isPinned(item),
      hidesTitle: (item) => accessors.current.hidesTitle(item),
      collator: titleCollator,
    });
    return built.length > 0 ? built : null;
  }, [searching, basis, Boolean(typeOf), Boolean(folderOf), Boolean(siteOf), items, listPrefs.sortField, today, folderNames]);

  const fold = useGroupFold(scope);
  const foldedKey = [...fold.folded].join('\n');
  const entries = useMemo((): ItemGroupEntry<T>[] | null => {
    if (!groups) return null;
    const out: ItemGroupEntry<T>[] = [];
    for (const group of groups) {
      const collapsible = group.key !== REST_KEY;
      const collapsed = collapsible && !selectionMode && fold.folded.has(group.key);
      out.push({ kind: 'header', group, collapsed });
      if (!collapsed) {
        for (let i = group.start; i < group.start + group.count; i++) {
          out.push({ kind: 'item', item: items[i]!, index: i });
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, foldedKey, selectionMode, items]);

  // Opening an item that sits in a collapsed group expands the group, so the
  // open row is always on screen. Keyed on the selection and on the groups
  // coming back (an item opened from a search): collapsing the group of the
  // open item afterwards is the person's choice and stays.
  const foldRef = useRef({ groups, fold, items });
  foldRef.current = { groups, fold, items };
  const active = groups !== null;
  useEffect(() => {
    const { groups: gs, fold: f, items: all } = foldRef.current;
    if (!selectedId || !gs) return;
    const index = all.findIndex((item) => accessors.current.idOf(item) === selectedId);
    const group = gs.find((g) => index >= g.start && index < g.start + g.count);
    if (group && group.key !== REST_KEY && f.folded.has(group.key)) {
      f.update((prev) => {
        const next = new Set(prev);
        next.delete(group.key);
        return next;
      });
    }
  }, [selectedId, basis, active]);

  const header = (entry: { kind: 'header'; group: ListGroup; collapsed: boolean }, grid: boolean) => {
    const { group, collapsed } = entry;
    const collapsible = group.key !== REST_KEY;
    const collapsibleKeys = groups ? groups.filter((g) => g.key !== REST_KEY).map((g) => g.key) : [];
    return (
      <ListGroupHeader
        key={`h:${group.key}:${group.start}`}
        label={groupLabel(group.key, t, folderNames)}
        count={group.count}
        collapsed={collapsed}
        collapsible={collapsible}
        foldable={!selectionMode}
        grid={grid}
        as={as}
        onToggle={(e) =>
          fold.update((prev) => {
            // Alt-click works as on a macOS disclosure triangle: every collapsible
            // group takes the state the clicked one moves to.
            if (e.altKey && collapsibleKeys.length > 1) {
              return prev.has(group.key) ? new Set() : new Set(collapsibleKeys);
            }
            const next = new Set(prev);
            if (next.has(group.key)) next.delete(group.key);
            else next.add(group.key);
            return next;
          })
        }
        onContextMenu={
          onContextMenu && collapsibleKeys.length > 1
            ? (e) =>
                onContextMenu(e, [
                  { label: t('listGroups.collapseAll'), onSelect: () => fold.update(() => new Set(collapsibleKeys)) },
                  { label: t('listGroups.expandAll'), onSelect: () => fold.update(() => new Set()) },
                ])
            : undefined
        }
      />
    );
  };

  return { entries, header };
}

/**
 * The grouped form of a sorted notes list (`LocalNote[]`), built over
 * `useItemGroups` so every note-based list shares one set of rules.
 */
/** The date a note reads for Date grouping (shared by ordering and header building). */
function noteDateForGroup(n: LocalNote, sortField: ListPrefs['sortField'], entryDays: boolean): Date {
  if (entryDays && n.type === 'journal') return parseDay(entryDayOf(n));
  return new Date(sortField === 'created' ? n.createdAt : editedAtOf(n));
}

/**
 * Order a sorted `LocalNote[]` list into the active `GroupBy` buckets while
 * preserving the user's chosen `Sort by` inside every bucket.
 */
export function orderNotesForGroup(
  sorted: readonly LocalNote[],
  o: {
    view: View;
    listPrefs: ListPrefs;
    now: Date;
    isGated: (n: LocalNote) => boolean;
    viewOrder?: readonly View[];
    folderNames: ReadonlyMap<string, string>;
  },
): LocalNote[] {
  const basis = groupBasisFor(resolveGroupBy(o.listPrefs), o.view);
  const rawMode = typeGroupModeForView(o.view);
  const typeMode = rawMode === 'pillar' || rawMode === 'vault' ? rawMode : null;
  const entryDays = o.view === 'journal';
  return orderItemsForGroup(sorted, {
    basis,
    sortField: o.listPrefs.sortField,
    sortDir: o.listPrefs.sortDir,
    now: o.now,
    isPinned: (n) => n.starred === 1,
    dateOf: (n) => noteDateForGroup(n, o.listPrefs.sortField, entryDays),
    titleOf: (n) => deriveDisplayTitle(n, o.isGated(n)),
    // `deriveDisplayTitle(n, true)` never reads a gated body: it returns the
    // stored title or the generic stand-in ("Untitled"), so grouping by its
    // first letter leaks nothing and keeps "Untitled" in U instead of "#".
    hidesTitle: () => false,
    typeOf: typeMode ? (n) => noteTypeGroupKey(n.type, typeMode) : undefined,
    typeOrder:
      typeMode === 'vault'
        ? VAULT_TYPE_ORDER
        : typeMode === 'pillar'
          ? pillarTypeOrder(o.viewOrder, o.view === 'tasks' ? 'type:task' : undefined)
          : undefined,
    folderOf: (n) => folderGroupKey(n.folderId, o.folderNames),
    folderNames: o.folderNames,
    siteOf: o.view === 'bookmarks' ? (n) => siteGroupKey(n.body, o.isGated(n)) : undefined,
    collator: titleCollator,
  });
}

export function useListGroups({
  notes,
  listPrefs,
  search,
  scope,
  view,
  selectionMode,
  selectedId,
  isNoteLocked,
  onContextMenu,
}: {
  /** The list as ordered by `compareNotes` and `orderNotesForGroup`. */
  notes: LocalNote[];
  listPrefs: ListPrefs;
  search: string;
  /** The fold scope, one per view. */
  scope: string;
  /** Active view, used to pick the supported grouping options and date/type rules. */
  view: View;
  selectionMode: boolean;
  selectedId: string | null;
  isNoteLocked: (n: LocalNote) => boolean;
  onContextMenu?: (e: React.MouseEvent, items: ContextMenuItem[]) => void;
}) {
  const folderGroupLabels = useContext(FolderGroupLabelsContext);
  const fallbackFolderNames = useContext(FolderNamesContext);
  const folderNames = folderGroupLabels.size > 0 ? folderGroupLabels : fallbackFolderNames;
  const entryDays = view === 'journal';
  const rawMode = typeGroupModeForView(view);
  const typeMode = rawMode === 'pillar' || rawMode === 'vault' ? rawMode : null;
  const gatedRef = useRef(isNoteLocked);
  gatedRef.current = isNoteLocked;
  const grouped = useItemGroups<LocalNote>({
    items: notes,
    idOf: (n) => n.id,
    dateOf: (n) => noteDateForGroup(n, listPrefs.sortField, entryDays),
    titleOf: (n) => deriveDisplayTitle(n, gatedRef.current(n)),
    typeOf: typeMode ? (n) => noteTypeGroupKey(n.type, typeMode) : undefined,
    folderOf: (n) => folderGroupKey(n.folderId, folderNames),
    siteOf: view === 'bookmarks' ? (n) => siteGroupKey(n.body, gatedRef.current(n)) : undefined,
    isPinned: (n) => n.starred === 1,
    hidesTitle: () => false,
    listPrefs,
    search,
    scope,
    view,
    selectionMode,
    selectedId,
    onContextMenu,
    as: 'li',
  });
  const entries = useMemo((): ListEntry[] | null => {
    if (!grouped.entries) return null;
    return grouped.entries.map((e): ListEntry =>
      e.kind === 'header' ? e : { kind: 'note', note: e.item },
    );
  }, [grouped.entries]);
  return { entries, header: grouped.header };
}
