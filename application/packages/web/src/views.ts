import type { NoteType } from '@notes/shared';

/**
 * The app shell's pillar/view union - the single source of truth.
 *
 * Copies of this union stay structurally compatible until a value is added to
 * one and not the others; each stale copy then breaks the build separately,
 * surfacing only after the previous is fixed. So it lives here once, and
 * everything else imports it.
 *
 * It is a leaf module on purpose: a type shared by thirteen files should not
 * hang off one of them, and `ListNav` importing from `TagsRail` would create a
 * component-to-component dependency for a string union.
 *
 * Adding a view means adding it HERE and nowhere else. Anything that switches
 * exhaustively on it will then fail to compile until it is handled, which is
 * the whole point.
 */
export type View =
  | 'all'
  | 'home'
  /** Home: a page of widgets, no list of items. GUI name "Home"; the key
   *  'home' is the All list and stays it. Spec: docs/internal/specs/dashboard.md */
  | 'dashboard'
  | 'journal'
  | 'starred'
  | 'trash'
  | 'tasks'
  | 'vault'
  | 'files'
  /** Plain-text files on the user's own disk. Never touches the encrypted
   *  store. Spec: docs/internal/specs/markdown-folder.md (no sync, history, or PIN-protect - vault-only features) */
  | 'markdown'
  /** Bookmarks pillar - notes of type 'link'. GUI name "Bookmarks", never
   *  "Links". Spec: docs/internal/specs/bookmarks-pillar.md (free feature, not gated behind Pro) */
  | 'bookmarks'
  /** Contacts pillar - notes of type 'contact'. Free and ungated, like
   *  bookmarks. Spec: docs/internal/specs/contacts-pillar.md (section 4, the View union member) */
  | 'contacts'
  /** Calendar pillar - every dated item on one calendar; it owns notes of
   *  type 'event'. The list pane is the agenda, the editor pane the month,
   *  week or day. Free. Spec: docs/internal/specs/calendar-pillar-spec.md */
  | 'calendar'
  /** Drawings - notes of type 'drawing', Excalidraw scenes. Free. Its row
   *  shows from the start, as every other type's.
   *  Spec: docs/internal/specs/drawing.md (section 1, decision 4) */
  | 'drawings'
  /** Archive - items kept but out of sight. A state, like 'starred', not a
   *  type. Spec: docs/internal/issues/archive/0388.md */
  | 'archive';

/**
 * The Vault's kind filter, the chips above its list. `passkey` is not a note
 * type: it keeps the logins that hold a site passkey (`matchesVaultFilter` in
 * loginBody.ts). One union here, as `View` above, for the list and the view.
 * Spec: docs/contrib/passkeys.md (section 5.1, Kinds; section 7)
 */
export type VaultFilter = 'all' | 'login' | 'passkey' | 'card' | 'ssh-key';

/**
 * Whether a view's row is drawn, given the user's hidden list and the view
 * that is open right now.
 *
 * A switched-off row still draws while it IS the open view. Several actions
 * move the app into a view on their own - an upload opens Files, a search hit
 * opens its item, the New menu opens the pillar it created into - and a hidden
 * target would leave the sidebar highlighting nothing with the user unable to
 * tell where they are. It is the rule Pinned has always followed at zero count.
 *
 * The exemption covers navigation the APP performs, never a hide the user
 * just asked for: switching a view off while standing in it moves the user to
 * All first (NotesView.handleToggleHiddenView), so the row goes at once. Left
 * to this rule alone the row stayed until the next view change or reload, and
 * the menu read as a dead control (reported for Bookmarks 2026-08-25).
 *
 * Read by all three lists that draw views: the wide rail (`TagsRail`), the
 * narrow icon strip (`CollapsedSidebar`) and the pillar dropdown in a list
 * title (`notesView/ListNav`). Platform availability is checked separately, and
 * first: Markdown stays hidden where no filesystem API exists whatever this
 * says. Spec: docs/internal/specs/sidebar-views.md (governs Show in sidebar only, separate from Show in All)
 */
export function isViewShown(view: View, hidden: View[] | undefined, current: View): boolean {
  return view === current || !hidden?.includes(view);
}

/**
 * The note types each view owns, for the All list's type filter.
 *
 * Views absent from this map contribute no types: 'home' is the All list
 * itself, 'starred' and 'trash' are states rather than types, and 'markdown'
 * reads the user's disk and never enters the encrypted store at all.
 * Spec: docs/internal/specs/sidebar-views.md (feeds the Show in All filter, the funnel icon setting)
 * Spec: docs/internal/specs/section-lock.md (the sections a person can protect, and which items each holds)
 */
export const VIEW_NOTE_TYPES: Partial<Record<View, NoteType[]>> = {
  // 'all' is the Notes pillar, NOT the All list - see the union above, where
  // 'home' is All Items. The two names read backwards from their labels.
  all: ['note'],
  tasks: ['task'],
  journal: ['journal'],
  files: ['file'],
  vault: ['login', 'card', 'ssh-key'],
  bookmarks: ['link'],
  contacts: ['contact'],
  calendar: ['event'],
  drawings: ['drawing'],
};

/**
 * Whether entering `view` clears active folder and tag filters.
 * Trash lists deleted items (contradicting active folder/tag counts), and Home
 * and Calendar draw their own surfaces that ignore folder and tag filters, so a
 * filter kept on any of them would sit visibly active while filtering nothing.
 * Spec: docs/internal/specs/dashboard.md (section 2)
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 6, step 3)
 */
export function isFilterExclusiveView(view: View): boolean {
  return view === 'trash' || view === 'dashboard' || view === 'calendar';
}

/**
 * The view a folder or tag filter pick lands on from `current`.
 * Views that cannot take a vault folder or tag filter (exclusive views and the
 * disk-backed Markdown pillar) bounce to All ('home') so the list pane shows
 * the filtered items; clearing a filter (`hasFilter === false`) stays put.
 */
export function viewForFilterPick(current: View, hasFilter = true): View {
  if (!hasFilter) return current;
  return isFilterExclusiveView(current) || current === 'markdown' ? 'home' : current;
}
