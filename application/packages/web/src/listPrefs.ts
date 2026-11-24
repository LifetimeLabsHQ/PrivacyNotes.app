/**
 * Notes-list display preferences - pure store helpers.
 *
 * Controls sort order and which row metadata (preview / date / tags) is
 * visible in the middle column. Modeled on Standard Notes' panel:
 * a Global default plus per-pillar overrides.
 *
 * Pillars with a notes list of their own: 'notes' (the 'all' view),
 * 'tasks', 'journal'. Non-pillar views ('trash', 'starred') always
 * resolve against Global - they have no override of their own.
 *
 * This module is intentionally pure - no localStorage, no events. The
 * store is owned by `UserSettings` (see `userSettings.ts`) so prefs
 * sync across devices via the existing encrypted user_settings
 * pipeline. Components read/write through the settings state.
 */

export type SortField = 'modified' | 'created' | 'title' | 'size';
type SortDir = 'asc' | 'desc';
/**
 * How a list groups its rows: decoupled from `sortField` so `groupBy` chooses
 * the foldable buckets and `sortField` + `sortDir` sorts items inside each
 * bucket (including when sorted by Size).
 * Spec: docs/internal/specs/list-groups.md
 */
export type GroupBy = 'none' | 'date' | 'letter' | 'type' | 'folder' | 'site';

export type ListPrefs = {
  sortField: SortField;
  sortDir: SortDir;
  /**
   * Whether a row carries its preview line - the note's first words, a
   * bookmark's URL, a login's username. Default true, but three pillars
   * start it off; see PILLAR_DEFAULTS.
   * Spec: docs/internal/design-decisions.md (per-pillar list settings)
   */
  showPreview: boolean;
  /**
   * Whether the preview runs over several lines of the note instead of one:
   * a list of short notes can then be read without opening them. Only takes
   * effect while `showPreview` is on, and the menu hides it otherwise.
   * Default false.
   */
  longPreview: boolean;
  /**
   * Whether a row carries its date. Default true, off in the pillars whose
   * rows say it already; see PILLAR_DEFAULTS.
   * Spec: docs/internal/design-decisions.md (per-pillar list settings)
   */
  showDate: boolean;
  /**
   * Whether a row carries the file size that its pillar prints on every row -
   * the Files list and the Markdown folder list. Default true. The size a row
   * shows BECAUSE the list is sorted by size is not this switch's: that one
   * answers the sort, so hiding it would hide the column being sorted on.
   * Named "Show file size" in the interface.
   */
  showSize: boolean;
  /**
   * Whether a row shows its folder chip and its tag chips. Default true:
   * both are the browse axis a free account has, so a new user who tags or
   * files a note sees the chip on the row without finding the pref first.
   * Named "Show folder & tags" in the interface.
   */
  showTags: boolean;
  /**
   * Whether notes marked "Read-only" (locked) appear in the
   * list. Turn off to hide them entirely - handy if you use locks
   * on reference material you rarely open. Default true.
   */
  showLocked: boolean;
  /**
   * Whether PIN-protected notes appear in the list. Independent of
   * unlock state: turning this off hides the "Protected note"
   * placeholder rows too. Default true.
   */
  showProtected: boolean;
  /**
   * Files pillar only: whether to show files that are embedded in
   * content notes (true) or only standalone file-upload notes (false).
   * Default true.
   */
  showAttachedNotes: boolean;
  /**
   * Bookmarks pillar only: mix in read-only rows derived from URLs found
   * inside note bodies. Computed locally, never stored. Off in Global, on
   * from the start in the bookmarks pillar (PILLAR_DEFAULTS).
   * Spec: docs/internal/specs/bookmarks-pillar.md (section 8)
   */
  showNoteLinks: boolean;
  /**
   * Tasks pillar only: list the notes that merely carry a checkbox line
   * alongside the task lists made in the pillar itself. Off leaves only the
   * notes typed 'task', so a recipe or a packing list stays out of the way.
   * Spec: docs/internal/plans/issue-batches.md (batch 17)
   */
  showNoteTasks: boolean;
  /**
   * Whether the list draws group headers. Kept in sync with `groupBy`
   * (`groupBy !== 'none'`) so older clients still see groups on/off while
   * carrying `groupBy` through `unknownScalars`.
   * Spec: docs/internal/specs/list-groups.md
   */
  showGroups: boolean;
  /**
   * Which grouping mode is active. Default `'none'`. Views that do not offer a
   * stored mode (e.g. `'type'` in a single-type view) fall back to `'none'`.
   * Spec: docs/internal/specs/list-groups.md
   */
  groupBy: GroupBy;
};

/**
 * A "pillar" is a note-type bucket the user can configure
 * independently. 'global' is the fallback applied to views that have
 * no override.
 */
import type { View } from './views';
import type { ViewMode } from './viewMode';

export type Pillar = 'global' | 'notes' | 'tasks' | 'journal' | 'vault' | 'files' | 'bookmarks' | 'contacts';

/**
 * The full prefs document: a global default plus optional per-pillar
 * overrides. A missing pillar key means "inherit Global."
 */
export type ListPrefsStore = {
  global: ListPrefs;
  notes?: ListPrefs;
  tasks?: ListPrefs;
  journal?: ListPrefs;
  vault?: ListPrefs;
  files?: ListPrefs;
  bookmarks?: ListPrefs;
  contacts?: ListPrefs;
};

/** One folder's or tag's own list settings: the prefs and the layout. */
export type ScopedListPrefs = { prefs: ListPrefs; layout: ViewMode };

/**
 * The folders and tags that remember their own sort and layout ("Remember for
 * this folder" or "for this tag" in the list menu);
 * `UserSettings.scopedListPrefs`. Keyed by `prefsScopeOf`: `folder:<id>` or
 * `tag:<name>`. A folder or tag with no entry uses Global and this device's
 * layout. The layout here is synced, unlike the device layout in
 * `viewMode.ts`: it follows what the folder or tag holds, not the screen. An
 * entry for a folder or tag that no longer exists is dropped on the next
 * write (`pruneScopedPrefs`); a renamed tag starts again from Global.
 *
 * A top-level setting and not a key inside `listPrefs`: a client older than
 * this one rebuilds `listPrefs` from the keys it knows and would drop it, but
 * carries an unknown top-level key through unchanged (`hydrate` in
 * `userSettings.ts`).
 * Spec: docs/internal/design-decisions.md (per-folder and per-tag list settings)
 */
export type ScopedListPrefsStore = Record<string, ScopedListPrefs>;

/**
 * The scope the open list remembers its settings under: one folder or one
 * tag, never both at once (no rule for which would win is obvious), and never
 * the "untagged" filter. Null when the list follows Global.
 */
export function prefsScopeOf(folderId: string | null, tag: string | null): string | null {
  const realTag = tag && tag !== '__untagged__' ? tag : null;
  if (folderId && realTag) return null;
  if (folderId) return `folder:${folderId}`;
  if (realTag) return `tag:${realTag}`;
  return null;
}

const DEFAULT_PREFS: ListPrefs = {
  sortField: 'modified',
  sortDir: 'desc',
  showPreview: true,
  longPreview: false,
  showDate: true,
  showSize: true,
  showTags: true,
  showLocked: true,
  showProtected: true,
  showAttachedNotes: true,
  showNoteLinks: false,
  showNoteTasks: true,
  showGroups: false,
  groupBy: 'none',
};

export const DEFAULT_STORE: ListPrefsStore = {
  global: { ...DEFAULT_PREFS },
};

/**
 * Per-pillar starting positions, applied on top of Global for a pillar that
 * has not been touched yet. A pillar listed here is NOT an override: it holds
 * no stored copy, so it still follows Global for every key the delta does not
 * name. The first edit inside that pillar writes a real copy and the delta
 * stops applying.
 *
 * A delta rather than a seeded store entry, for two reasons. It reaches
 * existing accounts with no migration, because nothing has to be written for
 * it to take effect. And it keeps "no copy means inherit Global" true, which
 * a seeded entry would quietly break.
 *
 * Why each one, since every entry here is a claim about what a row IS:
 *   - bookmarks: the URL line stays, because the address IS the bookmark.
 *     The date of a saved link is noise, tags and folders belong to the
 *     filter chips above the list rather than to every row, and the links
 *     found inside notes are what the pillar is for.
 *   - files: the row always carries its size, which is the number that
 *     matters, and the preview line only names the type again.
 *   - journal: the title IS the date (`journalTitle`), so a date line under
 *     it says the same thing twice; and the entries line up by the day each
 *     one is for, which the `created` sort reads in this pillar.
 *   - vault: a login's second line is its username, so the preview stays ON
 *     here - the exact opposite of bookmarks, through the same switch. Only
 *     the date goes.
 * Notes and Tasks are deliberately absent: a preview line is how you tell two
 * untitled notes apart.
 * Spec: docs/internal/design-decisions.md (per-pillar list settings)
 */
const PILLAR_DEFAULTS: Partial<Record<Pillar, Partial<ListPrefs>>> = {
  bookmarks: { showDate: false, showTags: false, showNoteLinks: true },
  // Contacts: a person's row says who they are and how to reach them; the
  // date of the last edit is noise there. Sort stays the global default
  // (date modified), by decision, and A to Z is one click away.
  // Spec: docs/internal/specs/contacts-pillar.md (section 10, PILLAR_DEFAULTS)
  contacts: { showDate: false },
  files: { showPreview: false, showDate: false },
  journal: { showDate: false, sortField: 'created' },
  vault: { showDate: false },
};

/* ────────────────────────────────────────────────────────────────
 * Hydration - validate untrusted input (from a stored settings blob
 * or an older client schema) into a well-formed store.
 * ──────────────────────────────────────────────────────────────── */

/** The keys of `obj` this build does not know, with plain values, so a key a
 *  newer client added survives this client's next save instead of reverting
 *  to its default everywhere (the carry of DAT-B-1). */
function unknownScalars(obj: object, known: object): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k in known) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function hydratePrefs(raw: unknown): ListPrefs {
  const base: ListPrefs = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== 'object') return base;
  Object.assign(base, unknownScalars(raw, DEFAULT_PREFS));
  const obj = raw as Partial<ListPrefs>;
  if (
    obj.sortField === 'modified' ||
    obj.sortField === 'created' ||
    obj.sortField === 'title' ||
    obj.sortField === 'size'
  ) {
    base.sortField = obj.sortField;
  }
  if (obj.sortDir === 'asc' || obj.sortDir === 'desc') {
    base.sortDir = obj.sortDir;
  }
  if (typeof obj.showPreview === 'boolean') base.showPreview = obj.showPreview;
  if (typeof obj.longPreview === 'boolean') base.longPreview = obj.longPreview;
  if (typeof obj.showDate === 'boolean') base.showDate = obj.showDate;
  if (typeof obj.showSize === 'boolean') base.showSize = obj.showSize;
  if (typeof obj.showTags === 'boolean') base.showTags = obj.showTags;
  if (typeof obj.showLocked === 'boolean') base.showLocked = obj.showLocked;
  if (typeof obj.showProtected === 'boolean') base.showProtected = obj.showProtected;
  if (typeof obj.showAttachedNotes === 'boolean') base.showAttachedNotes = obj.showAttachedNotes;
  if (typeof obj.showNoteLinks === 'boolean') base.showNoteLinks = obj.showNoteLinks;
  if (typeof obj.showNoteTasks === 'boolean') base.showNoteTasks = obj.showNoteTasks;
  if (typeof obj.showGroups === 'boolean') base.showGroups = obj.showGroups;
  // Backward/forward compat between legacy `showGroups` and `groupBy`:
  // - An older client that turns `showGroups` off leaves `groupBy` carried via
  //   `unknownScalars`; honor `showGroups === false` as turning groups off.
  // - A legacy blob with `showGroups: true` and no `groupBy` (or legacy `'sort'`)
  //   maps to `'letter'` under title sort and `'date'` otherwise.
  const rawGroupBy = obj.groupBy as string | undefined;
  if (obj.showGroups === false) {
    base.groupBy = 'none';
    base.showGroups = false;
  } else if (
    rawGroupBy === 'none' ||
    rawGroupBy === 'date' ||
    rawGroupBy === 'letter' ||
    rawGroupBy === 'type' ||
    rawGroupBy === 'folder' ||
    rawGroupBy === 'site'
  ) {
    base.groupBy = rawGroupBy;
    base.showGroups = rawGroupBy !== 'none';
  } else if (rawGroupBy === 'sort' || base.showGroups) {
    base.groupBy = base.sortField === 'title' ? 'letter' : 'date';
    base.showGroups = true;
  }
  return base;
}

/**
 * Effective grouping mode from a `ListPrefs` value. Handles callers that
 * construct `{ ...DEFAULT_STORE.global, showGroups: true }` without also
 * setting `groupBy`.
 */
export function resolveGroupBy(prefs: Pick<ListPrefs, 'sortField' | 'showGroups' | 'groupBy'>): GroupBy {
  if (prefs.groupBy !== 'none') return prefs.groupBy;
  if (prefs.showGroups) return prefs.sortField === 'title' ? 'letter' : 'date';
  return 'none';
}

/** A scope key: `folder:` or `tag:` and a name of bounded length. */
function isScopeKey(id: string): boolean {
  return id.length <= 300 && /^(folder|tag):./.test(id);
}

export function hydrateScopedListPrefs(raw: unknown): ScopedListPrefsStore {
  const out: ScopedListPrefsStore = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!isScopeKey(id) || !v || typeof v !== 'object') continue;
    const entry = v as { prefs?: unknown; layout?: unknown };
    const layout = entry.layout === 'list' || entry.layout === 'grid' || entry.layout === 'auto' ? entry.layout : 'auto';
    out[id] = { prefs: hydratePrefs(entry.prefs), layout };
  }
  return out;
}

export function hydrateListPrefsStore(raw: unknown): ListPrefsStore {
  const base: ListPrefsStore = { global: { ...DEFAULT_PREFS } };
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Partial<ListPrefsStore>;
  if (obj.global !== undefined) base.global = hydratePrefs(obj.global);
  if (obj.notes !== undefined) base.notes = hydratePrefs(obj.notes);
  if (obj.tasks !== undefined) base.tasks = hydratePrefs(obj.tasks);
  if (obj.journal !== undefined) base.journal = hydratePrefs(obj.journal);
  if (obj.vault !== undefined) base.vault = hydratePrefs(obj.vault);
  if (obj.files !== undefined) base.files = hydratePrefs(obj.files);
  if (obj.bookmarks !== undefined) base.bookmarks = hydratePrefs(obj.bookmarks);
  if (obj.contacts !== undefined) base.contacts = hydratePrefs(obj.contacts);
  // Migrate legacy 'logins' key to 'vault'.
  if (!obj.vault && (obj as Record<string, unknown>).logins !== undefined) {
    base.vault = hydratePrefs((obj as Record<string, unknown>).logins);
  }
  return base;
}

/* ────────────────────────────────────────────────────────────────
 * Pure store operations - every mutator returns a new store so
 * callers can pipe the result into React state without worrying
 * about shared references.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Resolve the effective prefs for a pillar: its own copy if it has one, else
 * Global with that pillar's starting delta laid over it. For 'global' this is
 * just Global itself.
 *
 * The delta branch builds a NEW object every call, so a caller that feeds the
 * result into a dependency array must memoize it (NotesView does). Returning a
 * fresh object into `useMemo` deps re-sorts and re-filters the whole library
 * on every render.
 */
export function resolvePrefs(
  store: ListPrefsStore,
  pillar: Pillar
): ListPrefs {
  if (pillar === 'global') return store.global;
  const own = store[pillar];
  if (own) return own;
  const delta = PILLAR_DEFAULTS[pillar];
  return delta ? { ...store.global, ...delta } : store.global;
}

/** Write prefs for the given pillar and return a new store. */
export function setPillarPrefs(
  store: ListPrefsStore,
  pillar: Pillar,
  prefs: ListPrefs
): ListPrefsStore {
  if (pillar === 'global') return { ...store, global: prefs };
  return { ...store, [pillar]: prefs };
}

/** The scope's own settings, or null when it follows Global. */
export function scopedPrefs(store: ScopedListPrefsStore, scope: string | null): ScopedListPrefs | null {
  if (!scope) return null;
  return Object.prototype.hasOwnProperty.call(store, scope) ? store[scope]! : null;
}

/** Give a scope its own settings (an entry), or drop them (null). */
export function setScopedPrefs(
  store: ScopedListPrefsStore,
  scope: string,
  entry: ScopedListPrefs | null
): ScopedListPrefsStore {
  const next = { ...store };
  if (entry) next[scope] = entry;
  else delete next[scope];
  return next;
}

/** Drop the entries of folders and tags that no longer exist. The same store
 *  comes back when nothing is dropped. */
export function pruneScopedPrefs(store: ScopedListPrefsStore, live: (scope: string) => boolean): ScopedListPrefsStore {
  const dead = Object.keys(store).filter((id) => !live(id));
  if (!dead.length) return store;
  const next = { ...store };
  for (const id of dead) delete next[id];
  return next;
}

/* ────────────────────────────────────────────────────────────────
 * View → pillar mapping
 * ──────────────────────────────────────────────────────────────── */

/**
 * Map the app's internal `view` state to a pillar. Views that don't
 * correspond to a pillar ('trash', 'starred', 'archive', 'markdown') map to 'global' so
 * they always inherit and never own an override. The notes list is one of
 * them: it shares Global with those views, which is also what its own sort
 * menu edits.
 *
 * This answer and the `pillar` a pane hands its `ListPrefsPopover` are the
 * same question, and a pane that answers it twice can read one copy while its
 * menu writes another. In the Tasks pillar that reads as a dead sort control:
 * the menu writes Global, the list renders from the Tasks copy, and the two
 * agree only until something writes a Tasks copy.
 *
 * Takes `View` rather than a local restatement of it. A local union would be
 * one more copy of the same strings and the only one that would NOT fail the
 * build when a view is added - a missing member silently stops being
 * assignable rather than erroring at the definition, so the drift would
 * surface as a call-site type error far from the cause.
 */
export function viewToPillar(view: View): Pillar {
  if (view === 'all') return 'global';
  if (view === 'journal') return 'journal';
  if (view === 'tasks') return 'tasks';
  if (view === 'vault') return 'vault';
  if (view === 'files') return 'files';
  if (view === 'bookmarks') return 'bookmarks';
  if (view === 'contacts') return 'contacts';
  return 'global';
}
