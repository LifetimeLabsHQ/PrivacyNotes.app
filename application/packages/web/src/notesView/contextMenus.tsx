/**
 * Context-menu builders for the NotesView root, the editable surfaces
 * (title input, tag input, TipTap editor body) and the per-note menus
 * shown when right-clicking a row in the notes/files list.
 *
 * They live here rather than inline in NotesView's `AuthenticatedView`
 * so the orchestrator stays focused on state + layout, and so a reader
 * auditing the menus doesn't have to wade through unrelated code first.
 *
 * The builders re-derive on every call (no memoisation). That matches
 * the inline-function behaviour they replaced - switching to memoised
 * variants would risk holding stale closures over `view`, `theme` etc.
 */

import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react';
import i18n from '../i18n';
import { keyText } from '../shortcutMatch';
import { shortcutNoun } from '../noteShortcut';
import { isUuid } from '../uuid';
import type { ContextMenuItem } from '../ContextMenu';
import type { LocalNote } from '../db';
import {
  iconBookmark, iconCheckbox, iconCopy, iconDownload, iconEditPencil,
  iconExternal, iconFlame, iconFolder, iconHome, iconOpenInTab, iconSideBySide,
  iconNewJournal, iconNewLogin, iconNewTask,
  iconArchive, iconNote, iconPin, iconReadOnly, iconRestore, iconSettings, iconTag,
  iconShield, iconSidebar,
  iconSignOut, iconTrash, iconUpload, iconZen, LinkSimple, NEW_GLYPHS, EXPORT_GLYPHS,
  CreditCard, Key, Translate,
} from '../icons';
import { ACTIONS } from '../ui/actions';
import { bulkActionGuards, canTranslate, noteActionGuards } from '../noteActionGuards';
import { isMac } from '../devices';
import { detectDeviceOs } from '../deviceFingerprint';
import type { ImageStore } from '../imageStore';
import type { View } from '../views';

/** Single config object - every builder reads from the same shape. */
export type ContextMenuDeps = {
  // Identity / navigation
  view: View;
  handleSelectView: (next: View) => Promise<void> | void;

  // Pro gate
  isPro: boolean;
  // Zen is Pro-gated but unlocked in the public demo; isPro still drives the
  // teaser badge, zenUnlocked drives whether the action fires.
  zenUnlocked: boolean;
  // Folders follows the same demo-teaser pattern as zen.
  foldersUnlocked: boolean;
  onOpenUpgrade: (trigger: string) => void;

  // Toggles + visible state (used by the Global menu)
  zenMode: boolean;
  setZenMode: Dispatch<SetStateAction<boolean>>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  notesListCollapsed: boolean;
  setNotesListCollapsed: Dispatch<SetStateAction<boolean>>;
  /** Restore both pane widths to their defaults (GitHub #211). */
  onResetPaneWidths: () => void;

  // Creation + app shell
  handleNew: (vaultType?: 'login' | 'card' | 'ssh-key', overrideView?: View, overrideFolderId?: string | null, overrideStarred?: boolean, template?: 'kanban') => Promise<void> | void;
  /** Switch to Files and open the OS file picker (upload flow). */
  onNewFile: () => void;
  /** Bookmarks create through the pillar's quick-add bar, not handleNew -
   *  this navigates there and focuses the bar. */
  onNewBookmark: () => void;
  onNewContact: () => void;
  onQuickAdd: () => void;
  /** The password generator, as the Vault's own New menu opens it. */
  onOpenGenerator: () => void;
  // Bookmark row actions (type 'link')
  onOpenBookmark: (n: LocalNote) => void;
  onCopyBookmarkUrl: (n: LocalNote) => void;
  onCopyShortcut: (n: LocalNote) => void;
  onEditBookmark: (n: LocalNote) => void;
  /** Save as note, or open the note a bookmark was clipped into. */
  onSaveBookmarkAsNote: (n: LocalNote) => void;
  /** The note a bookmark was clipped into, when there is one. */
  clippedNoteFor: (n: LocalNote) => LocalNote | undefined;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  handleSignOutClick: () => void;

  /** Open these items as tabs above the editor, or show the tab one already
   *  has. Absent where the strip is not drawn. Spec: docs/internal/specs/note-tabs.md */
  onOpenInTab?: (ids: string[]) => void;
  /** Two items side by side; absent where it cannot be offered. `offers`
   *  is false for an item already on screen.
   *  Spec: docs/internal/specs/side-by-side-notes.md (section 2) */
  sideBySide?: { offers: (n: LocalNote) => boolean; open: (n: LocalNote) => void };
  /** Home: whether a note widget shows this item, and the row that adds or
   *  removes it. Absent while the layout cannot be written.
   *  Spec: docs/internal/specs/dashboard.md (section 6) */
  onHome?: { has: (id: string) => boolean; toggle: (n: LocalNote) => void; offers: (n: LocalNote) => boolean };

  // Multi-select (used by buildNoteMenu for Select / Deselect)
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  /** What a row does to a whole selection. Each is the handler the
   *  selection toolbar already calls, and each reads the current selection
   *  itself, so none of them takes a list of ids. */
  selectionAllStarred: boolean;
  selectionAllArchived: boolean;
  selectionAllLocked: boolean;
  selectionAllProtected: boolean;
  onClearSelection: () => void;
  onBulkFavorite: () => void;
  onBulkArchive: () => void;
  onBulkMoveToFolder: () => void;
  onBulkDuplicate: () => void;
  onBulkExportMarkdown: () => void;
  onBulkExportHtml: () => void;
  onBulkSetLocked: (locked: boolean) => void;
  onBulkSetPinProtected: (pinProtected: boolean) => void;
  onRequestBulkUnprotect: () => void;
  onBulkRestore: () => void;
  onBulkDelete: () => void;
  /** Opens the tag picker for these ids at the point that was clicked. */
  onTagPicker: (ids: string[]) => void;

  // Per-note actions (used by buildNoteMenu)
  handleRestore: (id: string) => Promise<void> | void;
  handlePermanentlyDelete: (id: string) => Promise<void> | void;
  requestDeleteConfirm: (id: string, title: string) => void;
  handleToggleStar: (id: string, starred: boolean) => Promise<void> | void;
  handleToggleArchive: (id: string, archived: boolean) => Promise<void> | void;
  /** Pro: the read-only and PIN-protect toggles, gated by noteActionGuards. */
  handleSetLocked: (id: string, locked: boolean) => Promise<void> | void;
  handleSetPinProtected: (id: string, pinProtected: boolean) => Promise<void> | void;
  /** Turning protection off opens the note's gate in its remove state. */
  requestRemoveProtection: (id: string) => void;
  /** Open Security > PIN, for a protect attempt with no PIN set. */
  onSetPin: () => void;
  handleDuplicate: (id: string) => Promise<void> | void;
  /** Opens Translate notes on one note; null while Plugins is not released. */
  translateNote: ((n: LocalNote) => void) | null;
  handleTrash: (id: string) => Promise<void> | void;
  /** Trash one note through the shared confirm modal, the same question a
   *  whole selection gets. */
  requestTrash: (ids: string[]) => void;
  /** Pro: open the folder picker for this note. */
  onMoveToFolder: (id: string) => void;
  /** "Move to Work" or "Move to Personal" for these items, while spaces are
   *  on; undefined when they sit in both spaces (All open, mixed selection). */
  spaceMove?: (ids: string[]) => { label: ReactNode; icon: ReactNode; run: (ids: string[]) => void } | undefined;
  handleBurnShare: (n: LocalNote) => Promise<void> | void;
  exportSingleMarkdown: (n: LocalNote) => Promise<void> | void;
  exportSingleHtml: (n: LocalNote) => Promise<void> | void;
  printNote: (n: LocalNote) => Promise<void> | void;
  imageStoreRef: MutableRefObject<ImageStore | null>;
};

/**
 * Build the two menus for the current render. Returns plain arrays of
 * `ContextMenuItem`; the caller hands them to `ctxMenu.open`. The text
 * editor menu was retired in v0.158.0 - under strategy B (partial
 * suppression) the browser's native menu wins on editable surfaces.
 * Spec: docs/internal/backlog.md #74.
 */
export function createContextMenuBuilders(deps: ContextMenuDeps): {
  buildGlobalMenu: () => ContextMenuItem[];
  newForView: (view: View) => ContextMenuItem[];
  buildNoteMenu: (n: LocalNote, opts?: { alone?: boolean }) => ContextMenuItem[];
  buildSelectionMore: () => ContextMenuItem[];
} {
  // Each "New X" switches to the matching pillar and then creates the
  // item. handleNew accepts an overrideView so it creates the correct
  // type even though the React re-render from handleSelectView hasn't
  // committed yet (closure's `view` would still be stale).
  // Fix: docs/internal/backlog.md #94.
  const createInPillar = (target: View) => () => {
    void deps.handleSelectView(target);
    void deps.handleNew(undefined, target);
  };

  // The letter that picks each entry above the first separator when the
  // menu opens from the keyboard (NEW_MENU_PICKS, same order).
  // Order MUST match the sidebar pillar nav (TagsRail.tsx) and the "New" dropdown
  // (NotesList.tsx allNewOptions): Note, Task, Kanban board, Login, File, Journal, Event, Contact, Bookmark.
  // Spec: docs/internal/design/ui-patterns.md section 45 (New-menu order invariant)
  // The "New" entry of each section, for the global menu below and for a
  // sidebar row's own menu (newForView). Spec: docs/internal/specs/section-lock.md (section 4)
  const newEntries = {
    all: {
      label: i18n.t('notes:header.newNote'),
      icon: iconNote(),
      onSelect: createInPillar('all'),
    },
    tasks: {
      label: i18n.t('shell:contextMenu.newTask'),
      icon: iconNewTask(),
      onSelect: createInPillar('tasks'),
    },
    drawings: {
      label: i18n.t('shell:contextMenu.newDrawing'),
      icon: <NEW_GLYPHS.drawing size={14} />,
      onSelect: () => {
        void deps.handleSelectView('drawings');
        void deps.handleNew(undefined, 'drawings');
      },
    },
    vault: {
      label: i18n.t('shell:contextMenu.newLogin'),
      icon: iconNewLogin(),
      onSelect: createInPillar('vault'),
    },
    files: {
      label: i18n.t('shell:contextMenu.newFile'),
      icon: iconUpload(),
      onSelect: () => deps.onNewFile(),
    },
    journal: {
      label: i18n.t('shell:contextMenu.newJournal'),
      icon: iconNewJournal(),
      onSelect: createInPillar('journal'),
    },
    calendar: {
      label: i18n.t('notes:header.newEvent'),
      icon: <NEW_GLYPHS.event />,
      // An event is made in the quick add, which shows what it can read.
      onSelect: () => deps.onQuickAdd(),
    },
    contacts: {
      label: i18n.t('shell:contextMenu.newContact'),
      icon: <NEW_GLYPHS.contact />,
      onSelect: () => deps.onNewContact(),
    },
    bookmarks: {
      label: i18n.t('shell:bookmarks.newBookmark'),
      icon: iconBookmark(),
      onSelect: () => deps.onNewBookmark(),
    },
  } satisfies Partial<Record<View, ContextMenuItem>>;
  // The Vault row offers every type its own New menu offers (NotesList.tsx
  // vaultNewOptions); the global menu keeps the one Login entry.
  const GeneratorIcon = ACTIONS.generate.icon;
  const vaultExtras: ContextMenuItem[] = [
    { label: i18n.t('shell:contextMenu.newCard'), icon: <CreditCard />, onSelect: () => { void deps.handleSelectView('vault'); void deps.handleNew('card', 'vault'); } },
    { label: i18n.t('shell:contextMenu.newSshKey'), icon: <Key />, onSelect: () => { void deps.handleSelectView('vault'); void deps.handleNew('ssh-key', 'vault'); } },
    { label: i18n.t('auth:loginForm.generatePassword'), icon: <GeneratorIcon />, onSelect: () => deps.onOpenGenerator() },
  ];
  const newForView = (view: View): ContextMenuItem[] => {
    const one = (newEntries as Partial<Record<View, ContextMenuItem>>)[view];
    if (!one) return [];
    return view === 'vault' ? [one, ...vaultExtras] : [one];
  };

  const buildGlobalMenu = (): ContextMenuItem[] => [
    {
      label: i18n.t('shell:quickAdd.label'),
      icon: <NEW_GLYPHS.event />,
      shortcut: keyText('quickAdd'),
      onSelect: () => deps.onQuickAdd(),
    },
    newEntries.all,
    newEntries.tasks,
    {
      label: i18n.t('shell:contextMenu.newKanban'),
      icon: <NEW_GLYPHS.kanban size={14} />,
      onSelect: () => {
        void deps.handleSelectView('tasks');
        void deps.handleNew(undefined, 'tasks', undefined, undefined, 'kanban');
      },
    },
    newEntries.drawings,
    newEntries.vault,
    newEntries.files,
    newEntries.journal,
    newEntries.calendar,
    newEntries.contacts,
    newEntries.bookmarks,
    { type: 'separator' },
    {
      label: deps.zenMode ? i18n.t('notes:zen.exitHover') : i18n.t('common:palette.commands.zen'),
      icon: iconZen(),
      pro: !deps.isPro,
      onSelect: () => {
        if (!deps.zenUnlocked) { deps.onOpenUpgrade('zen'); return; }
        deps.setZenMode((z) => !z);
      },
    },
    {
      label: deps.sidebarCollapsed ? i18n.t('shell:contextMenu.showSidebar') : i18n.t('shell:contextMenu.hideSidebar'),
      icon: iconSidebar(),
      onSelect: () => deps.setSidebarCollapsed((v: boolean) => !v),
    },
    {
      label: deps.notesListCollapsed ? i18n.t('shell:contextMenu.showNotesList') : i18n.t('shell:contextMenu.hideNotesList'),
      icon: iconSidebar(),
      onSelect: () => deps.setNotesListCollapsed((v) => !v),
    },
    {
      label: i18n.t('shell:contextMenu.resetPaneWidths'),
      icon: iconSidebar(),
      onSelect: () => deps.onResetPaneWidths(),
    },
    { type: 'separator' },
    {
      label: i18n.t('shell:contextMenu.settings'),
      icon: iconSettings(),
      onSelect: () => deps.setShowSettings(true),
    },
    {
      label: i18n.t('settings:signOut'),
      icon: iconSignOut(),
      destructive: true,
      onSelect: () => deps.handleSignOutClick(),
    },
  ];

  /**
   * The menu for a right-click on a row that is one of several selected
   * ones. Every verb here acts on the whole selection, which is the only
   * reading of a menu opened over rows that all look picked. It offers
   * the selection toolbar's actions and takes their labels, so the two
   * surfaces cannot name the same action differently. (GitHub #188)
   */
  /**
   * Which items a menu is being built for. Every row reads this instead of
   * closing over one note, which is what lets one list serve both cases.
   */
  type Scope =
    | { kind: 'one'; note: LocalNote; isSelected: boolean }
    | { kind: 'many'; ids: string[] };

  /**
   * A row's answer when it has no meaning for a selection. The reason is
   * the documentation: a reader of the list sees why the row is absent
   * without hunting for the code that drops it.
   */
  const scopeIds = (s: Scope): string[] => (s.kind === 'one' ? [s.note.id] : s.ids);

  type OneItemOnly = { readonly oneItemOnly: string };
  const oneItemOnly = (reason: string): OneItemOnly => ({ oneItemOnly: reason });
  const isOneItemOnly = (v: RowSpec['many']): v is OneItemOnly =>
    typeof v === 'object' && v !== null && 'oneItemOnly' in v;
  // A drawing has no text to print or burn: it saves as a file or a
  // picture from its own canvas menu. Spec: docs/internal/specs/drawing.md (section 7, Export)
  const notADrawing = (s: Scope): boolean => s.kind === 'many' || s.note.type !== 'drawing';

  /**
   * One row of a note menu.
   *
   * `many` is required and has no default. That is the whole anti-drift
   * mechanism: a row cannot be added without saying what it means for a
   * selection, and "nothing" is a value that carries its reason rather
   * than an omission nobody notices. The two menus drifted apart once
   * because they were two lists; there is one list now.
   */
  type RowSpec = {
    label: (s: Scope) => ReactNode;
    icon: (s: Scope) => ReactNode;
    checked?: (s: Scope) => boolean;
    pro?: boolean;
    destructive?: boolean;
    success?: boolean;
    /** A gesture or key that does the same, shown on the right of the row. */
    shortcut?: () => string;
    /** Rows that belong to certain items only, such as the bookmark verbs. */
    when?: (s: Scope) => boolean;
    /** The selection bar draws this row as a button of its own, so the
     *  bar's More menu leaves it out (#805). */
    onBar?: true;
    one: (n: LocalNote) => void;
    many: ((ids: string[]) => void) | OneItemOnly;
  };

  /**
   * Turn groups of rows into a menu for one scope. Separators come from the
   * grouping rather than from hand-placed entries, so a filtered-out row can
   * never leave a doubled or leading rule behind.
   */
  function renderRows(groups: RowSpec[][], s: Scope): ContextMenuItem[] {
    const out: ContextMenuItem[] = [];
    for (const group of groups) {
      const rows = group.filter((r) => {
        if (r.when && !r.when(s)) return false;
        return !(s.kind === 'many' && isOneItemOnly(r.many));
      });
      if (rows.length === 0) continue;
      if (out.length > 0) out.push({ type: 'separator' });
      for (const r of rows) {
        out.push({
          label: r.label(s),
          icon: r.icon(s),
          ...(r.checked ? { checked: r.checked(s) } : {}),
          ...(r.pro ? { pro: true } : {}),
          ...(r.destructive ? { destructive: true } : {}),
          ...(r.success ? { success: true } : {}),
          ...(r.shortcut ? { shortcut: r.shortcut() } : {}),
          onSelect: () => {
            if (s.kind === 'one') { r.one(s.note); return; }
            if (isOneItemOnly(r.many)) return;
            r.many(s.ids);
          },
        });
      }
    }
    return out;
  }

  /** The Pro and PIN gates for a selection, the twin of the per-note ones. */
  const bulkGuards = () => bulkActionGuards({
    isPro: deps.isPro,
    allLocked: deps.selectionAllLocked,
    allProtected: deps.selectionAllProtected,
    onSetLocked: (locked) => deps.onBulkSetLocked(locked),
    onSetPinProtected: (p) => deps.onBulkSetPinProtected(p),
    onRequestRemoveProtection: () => deps.onRequestBulkUnprotect(),
    onOpenUpgrade: (trigger) => deps.onOpenUpgrade(trigger ?? ''),
    onSetPin: deps.onSetPin,
    onClose: () => { /* the context menu closes itself after onSelect */ },
  });

  /** The same gates for one note, so the two surfaces cannot drift on who
   *  may lock a note and what a protect toggle asks for first. */
  const noteGuards = (n: LocalNote) => noteActionGuards({
    note: n,
    isPro: deps.isPro,
    onClose: () => { /* the context menu closes itself after onSelect */ },
    onSetLocked: (locked) => void deps.handleSetLocked(n.id, locked),
    onSetPinProtected: (p) => void deps.handleSetPinProtected(n.id, p),
    onRequestRemoveProtection: () => deps.requestRemoveProtection(n.id),
    onOpenUpgrade: (trigger) => deps.onOpenUpgrade(trigger ?? ''),
    onSetPin: deps.onSetPin,
  });

  const isLink = (s: Scope) => s.kind === 'one' && s.note.type === 'link';

  /** The selection row: it names the gesture, so it reads differently in
   *  each scope while staying the same row in the same place. */
  const selectRow: RowSpec = {
    label: (s) => s.kind === 'many'
      ? i18n.t('notes:selection.deselectAll')
      : s.isSelected ? i18n.t('shell:contextMenu.deselect') : i18n.t('shell:contextMenu.select'),
    icon: () => iconCheckbox(),
    onBar: true,
    one: (n) => deps.onToggleSelected(n.id),
    many: () => deps.onClearSelection(),
  };

  /** The rows a note menu offers outside the trash, in groups. */
  const NOTE_GROUPS: RowSpec[][] = [
    [
      {
        label: () => i18n.t('shell:contacts.open'),
        icon: () => iconExternal(),
        when: isLink,
        one: (n) => deps.onOpenBookmark(n),
        many: oneItemOnly('a bookmark opens one tab'),
      },
      {
        label: () => i18n.t('shell:contextMenu.copyBookmarkUrl'),
        icon: () => iconCopy(),
        when: isLink,
        one: (n) => deps.onCopyBookmarkUrl(n),
        many: oneItemOnly('the clipboard holds one address'),
      },
      {
        label: () => i18n.t('shell:contextMenu.editBookmark'),
        icon: () => iconEditPencil(),
        when: isLink,
        one: (n) => deps.onEditBookmark(n),
        many: oneItemOnly('the bookmark editor takes one bookmark'),
      },
      {
        label: (s) => s.kind === 'one' && deps.clippedNoteFor(s.note)
          ? i18n.t('editor:noteLink.open')
          : i18n.t('shell:contextMenu.saveAsNote'),
        icon: () => iconNote(),
        when: isLink,
        one: (n) => deps.onSaveBookmarkAsNote(n),
        many: oneItemOnly('one bookmark is saved as one note'),
      },
    ],
    [
      {
        label: () => i18n.t('shell:contextMenu.openInTab'),
        icon: () => iconOpenInTab(),
        // The click that does the same from a row, which no other place names.
        // Linux window managers and ChromeOS take Alt-click before the page
        // sees it, so there the hint names the middle click, which works.
        shortcut: () => (['Linux', 'ChromeOS'].includes(detectDeviceOs())
          ? i18n.t('shell:contextMenu.openInTabHintMiddle')
          : i18n.t('shell:contextMenu.openInTabHint', { key: isMac() ? '⌥' : 'Alt' })),
        when: () => deps.onOpenInTab !== undefined,
        one: (n) => deps.onOpenInTab?.([n.id]),
        many: (ids) => deps.onOpenInTab?.(ids),
      },
      {
        label: () => i18n.t('shell:contextMenu.openSideBySide'),
        icon: () => iconSideBySide(),
        when: (s) => s.kind === 'one' && !!deps.sideBySide?.offers(s.note),
        one: (n) => deps.sideBySide?.open(n),
        many: oneItemOnly('two items side by side take one item at a time'),
      },
      {
        label: (s) => s.kind === 'one' && deps.onHome?.has(s.note.id)
          ? i18n.t('shell:dashboard.removeFromHome')
          : i18n.t('shell:dashboard.showOnHome'),
        icon: () => iconHome(),
        when: (s) => s.kind === 'one' && !!deps.onHome?.offers(s.note),
        one: (n) => deps.onHome?.toggle(n),
        many: oneItemOnly('a note widget shows one note'),
      },
    ],
    [selectRow],
    [
      {
        label: (s) => (s.kind === 'many' ? deps.selectionAllStarred : s.note.starred === 1)
          ? i18n.t('shell:contextMenu.unpin')
          : i18n.t('shell:contextMenu.pin'),
        icon: (s) => iconPin(s.kind === 'many' ? deps.selectionAllStarred : s.note.starred === 1),
        onBar: true,
        one: (n) => void deps.handleToggleStar(n.id, n.starred !== 1),
        many: () => deps.onBulkFavorite(),
      },
      {
        label: (s) => (s.kind === 'many' ? deps.selectionAllArchived : s.note.archived === 1)
          ? i18n.t('shell:contextMenu.unarchive')
          : i18n.t('shell:contextMenu.archive'),
        icon: (s) => iconArchive(s.kind === 'many' ? deps.selectionAllArchived : s.note.archived === 1),
        onBar: true,
        one: (n) => void deps.handleToggleArchive(n.id, n.archived !== 1),
        many: () => deps.onBulkArchive(),
      },
      {
        label: () => i18n.t('shell:selectionToolbar.tag'),
        icon: () => iconTag(),
        onBar: true,
        one: (n) => deps.onTagPicker([n.id]),
        many: (ids) => deps.onTagPicker(ids),
      },
      // For one note both labels come from the "..." options menu, because
      // they name the same two switches, and a trailing check says which way
      // a switch is set, the way a native menu does. A selection can be
      // mixed, where a check says nothing about what a click does, so there
      // the row names its effect, as Pin and Unpin do (#805).
      {
        label: (s) => s.kind === 'one'
          ? i18n.t('notes:noteRow.readOnly')
          : deps.selectionAllLocked ? i18n.t('shell:contextMenu.makeEditable') : i18n.t('shell:contextMenu.makeReadOnly'),
        icon: () => iconReadOnly(),
        pro: !deps.isPro,
        checked: (s) => s.kind === 'one' && s.note.locked === 1,
        one: (n) => noteGuards(n).toggleLock(),
        many: () => bulkGuards().toggleLock(),
      },
      {
        label: (s) => s.kind === 'one' || !deps.selectionAllProtected
          ? i18n.t('shell:noteOptionsMenu.protect')
          : i18n.t('shell:contextMenu.removeProtection'),
        icon: () => iconShield(),
        pro: !deps.isPro,
        checked: (s) => s.kind === 'one' && s.note.pinProtected === 1,
        one: (n) => noteGuards(n).toggleProtect(),
        many: () => bulkGuards().toggleProtect(),
      },
    ],
    [
      {
        label: () => i18n.t('shell:contextMenu.duplicate'),
        icon: () => iconCopy(),
        one: (n) => void deps.handleDuplicate(n.id),
        many: () => deps.onBulkDuplicate(),
      },
      {
        label: () => i18n.t('notes:translate.action'),
        icon: () => <Translate aria-hidden="true" />,
        pro: !deps.isPro,
        when: (s) => s.kind === 'one' && !!deps.translateNote && canTranslate(s.note),
        one: (n) => deps.translateNote?.(n),
        many: oneItemOnly('a translation is one new note from one note'),
      },
      {
        label: () => i18n.t('shell:contextMenu.moveToFolder'),
        icon: () => iconFolder(),
        pro: !deps.isPro,
        onBar: true,
        one: (n) => {
          if (!deps.foldersUnlocked) { deps.onOpenUpgrade('folders'); return; }
          deps.onMoveToFolder(n.id);
        },
        many: () => deps.onBulkMoveToFolder(),
      },
      {
        label: (s) => deps.spaceMove?.(scopeIds(s))?.label ?? '',
        icon: (s) => deps.spaceMove?.(scopeIds(s))?.icon,
        pro: !deps.isPro,
        when: (s) => !!deps.spaceMove?.(scopeIds(s)),
        one: (n) => deps.spaceMove?.([n.id])?.run([n.id]),
        many: (ids) => deps.spaceMove?.(ids)?.run(ids),
      },
    ],
    [
      {
        label: (s) => i18n.t(s.kind === 'one' && shortcutNoun(s.note.type) === 'item' ? 'shell:shortcut.copyItem' : 'shell:shortcut.copyNote'),
        icon: () => <LinkSimple aria-hidden="true" />,
        when: (s) => s.kind === 'one' && isUuid(s.note.id),
        one: (n) => deps.onCopyShortcut(n),
        many: oneItemOnly('a shortcut opens one item'),
      },
      {
        label: () => i18n.t('shell:contextMenu.exportAsMarkdown'),
        when: notADrawing,
        icon: () => <EXPORT_GLYPHS.markdown aria-hidden="true" />,
        onBar: true,
        one: (n) => void deps.exportSingleMarkdown(n),
        many: () => deps.onBulkExportMarkdown(),
      },
      {
        label: () => i18n.t('shell:contextMenu.exportAsHtml'),
        when: notADrawing,
        icon: () => <EXPORT_GLYPHS.html aria-hidden="true" />,
        one: (n) => void deps.exportSingleHtml(n),
        many: () => deps.onBulkExportHtml(),
      },
      {
        label: () => i18n.t('notes:share.printTitle'),
        when: notADrawing,
        icon: () => <EXPORT_GLYPHS.print aria-hidden="true" />,
        one: (n) => void deps.printNote(n),
        many: oneItemOnly('one sheet of paper cannot mean five notes'),
      },
      {
        label: () => i18n.t('notes:share.burnTitle'),
        when: notADrawing,
        icon: () => <span className="text-orange-500"><EXPORT_GLYPHS.burn aria-hidden="true" /></span>,
        one: (n) => void deps.handleBurnShare(n),
        many: oneItemOnly('a burn link points at one note'),
      },
    ],
    [
      {
        label: () => i18n.t('common:actions.delete'),
        icon: () => iconTrash(),
        destructive: true,
        onBar: true,
        one: (n) => deps.requestTrash([n.id]),
        many: (ids) => deps.requestTrash(ids),
      },
    ],
  ];

  /** The trash view is a different menu, built the same way so its own two
   *  versions cannot drift either. */
  const TRASH_GROUPS: RowSpec[][] = [
    [selectRow],
    [
      {
        label: () => i18n.t('shell:contextMenu.restore'),
        icon: () => iconRestore(),
        success: true,
        onBar: true,
        one: (n) => void deps.handleRestore(n.id),
        many: () => deps.onBulkRestore(),
      },
    ],
    [
      {
        label: () => i18n.t('shell:contextMenu.deleteForever'),
        icon: () => iconTrash(),
        destructive: true,
        onBar: true,
        one: (n) => deps.requestDeleteConfirm(n.id, n.title || ''),
        many: () => deps.onBulkDelete(),
      },
    ],
  ];

  /**
   * Per-note menu. A right-click on one of several selected rows asks about
   * all of them: a per-note menu there applies a verb to a single row while
   * the rest sit highlighted beside it, which reads as a bug and is one
   * where the verb is destructive. (GitHub #188)
   */
  /**
   * `alone`: the menu of this one item, wherever it is and whatever the list
   * has selected, for a surface outside the list (the quick switcher's Tab).
   * It has no Select row, since it is not opened over a list row, and it
   * follows the item into or out of the trash, not the open view.
   */
  const buildNoteMenu = (n: LocalNote, opts?: { alone?: boolean }): ContextMenuItem[] => {
    if (opts?.alone) {
      const groups = (n.trashed === 1 ? TRASH_GROUPS : NOTE_GROUPS).map((g) => g.filter((r) => r !== selectRow));
      return renderRows(groups, { kind: 'one', note: n, isSelected: false });
    }
    const groups = deps.view === 'trash' ? TRASH_GROUPS : NOTE_GROUPS;
    const isSelected = deps.selectedIds.has(n.id);
    if (isSelected && deps.selectedIds.size > 1) {
      const ids = Array.from(deps.selectedIds);
      return [
        { type: 'header', label: i18n.t('shell:contextMenu.selectedCount', { count: ids.length }) },
        ...renderRows(groups, { kind: 'many', ids }),
      ];
    }
    return renderRows(groups, { kind: 'one', note: n, isSelected });
  };

  /**
   * The selection bar's More menu: every row the selection menu offers that
   * the bar does not draw as a button. It is the same list as the right-click
   * menu, so a phone, which has no right-click, reaches every bulk action,
   * and a row added to the list reaches both places (#805).
   */
  const buildSelectionMore = (): ContextMenuItem[] => {
    if (deps.selectedIds.size === 0) return [];
    const groups = (deps.view === 'trash' ? TRASH_GROUPS : NOTE_GROUPS).map((g) => g.filter((r) => !r.onBar));
    return renderRows(groups, { kind: 'many', ids: Array.from(deps.selectedIds) });
  };

  return { buildGlobalMenu, newForView, buildNoteMenu, buildSelectionMore };
}

/**
 * The letter that picks each "New" entry of the global menu when it opens
 * from the keyboard (Mod+Shift+N in the desktop apps), in the menu's order:
 * Quick add, Note, Task, Login, File, Journal, Event, Contact, Bookmark. English letters on
 * every keyboard, shown on each row.
 */
export const NEW_MENU_PICKS = ['q', 'n', 't', 'k', 'l', 'f', 'j', 'e', 'c', 'b'] as const;
