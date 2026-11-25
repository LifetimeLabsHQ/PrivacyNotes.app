import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu';
import { FolderTreeView } from './FolderTreeView';
import { FolderNameInput } from './FolderNameInput';
import { SIDEBAR_ROW_MENU_BUTTON } from './sidebarUI';
import { isSoftKeyboardDevice } from './softKeyboard';
import { textMatcher } from './textMatch';
import { FolderGlyph } from './looks/LookGlyph';
import { DashedAddButton, PickerModal } from './ui';
import {
  flattenFolderRows,
  INDENT_PX,
  MAX_INDENT_LEVEL,
  useFolderExpansion,
} from './folderTreeState';
import {
  canCreateChild,
  canMoveFolder,
  folderSiblingSorter,
  folderTotals,
  subtreeIds,
  type FolderDef,
  type FolderSortDir,
  type FolderSortField,
} from './folders';
import { Check, DotsThree, Folder, FolderPlus, PencilSimple, Prohibit, type Icon } from './icons';

/**
 * The shared folder picker (Pro folders feature) - the single "choose a
 * folder" surface. Every filing entry point opens this: the note "..."
 * menu, the note context menu, the folder menu's Move action, and the
 * bulk toolbar.
 *
 * A compact centered modal: search input, the folder tree, an Unfiled row
 * (note mode), and an inline New folder affordance. Returns the chosen
 * folderId - or null for Unfiled / root - via onPick.
 *
 * The tree is `FolderTreeView`, the same component the sidebar renders, so
 * carets, guide lines, indent, the tinted expanded branch, the open/closed
 * state and the sibling sort are one implementation rather than two. Until
 * 2026-08-27 this file drew its own flat, caret-less tree, and the two
 * surfaces disagreed about the same folders.
 *
 * The two MODES used to differ far more than they do now: re-parenting a
 * folder got no New folder button, no row menu and no check on its current
 * parent, for no reason anyone could name. What still differs is only what
 * carries meaning - which rows are refused, and what the "no folder" row
 * says.
 *
 * Right-clicking a row opens the folder's own menu (new subfolder,
 * rename), the picker's answer to the sidebar tree's row menu. The dialog
 * carries `data-no-app-menu` so the global "New note / Sign out" chrome
 * menu - which meant nothing on top of a picker - never appears here
 * again. Spec: issue #208.
 */

export interface FolderPickerProps {
  folders: FolderDef[];
  /**
   * 'note': filing note(s) - every folder is a valid target, plus
   * Unfiled. 'folder': re-parenting a folder - the moved folder's
   * subtree is disabled, and null means "move to root level".
   */
  mode: 'note' | 'folder';
  /**
   * Note mode: the current folderId, rendered with a check. null means
   * Unfiled; undefined means "no single current folder" (a multi-select
   * spanning several folders), which checks nothing.
   */
  currentFolderId?: string | null;
  /** Folder mode: the folder being moved. */
  movingFolderId?: string;
  /** Direct-member note counts, the same map the sidebar tree reads. */
  counts: Map<string, number>;
  /**
   * The sidebar's own sibling sort, so both trees read the same way. The
   * dialog has no sort control of its own on purpose: it draws the folders
   * you just looked at in the rail, and a second, separately-set order for
   * the same tree is a place to get lost, not a setting.
   */
  sortField: FolderSortField;
  sortDir: FolderSortDir;
  onPick: (folderId: string | null) => void;
  /** Land a dragged folder, exactly as the sidebar tree does. */
  onReorderFolders: (id: string, parentId: string | null, orderedIds: string[]) => void;
  /**
   * Create a folder under `parentId` (null = root level) and return its
   * id (null when creation failed).
   */
  onCreateFolder?: (name: string, parentId: string | null) => string | null;
  /** Rename a folder in place, from the row menu. */
  onRenameFolder?: (id: string, name: string) => void;
  /** Note mode while spaces are on: the tree in one section per space, each
   *  under its name; Unfiled sits in the section flagged for it. Spec: docs/internal/specs/spaces.md */
  sections?: { key: string; label: string; icon: Icon; folders: FolderDef[]; unfiled?: boolean }[];
  /** The dialog's title; "Move to folder" when absent. */
  title?: string;
  onClose: () => void;
}

export function FolderPicker({
  folders,
  mode,
  currentFolderId,
  movingFolderId,
  counts,
  sortField,
  sortDir,
  onPick,
  onReorderFolders,
  onCreateFolder,
  onRenameFolder,
  sections,
  title,
  onClose,
}: FolderPickerProps) {
  const { t } = useTranslation('shell');
  const { expand, isExpanded } = useFolderExpansion();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isSoftKeyboardDevice()) searchRef.current?.focus({ preventScroll: true });
  }, []);
  /** Parent id the inline "new folder" input is nested under; undefined = closed.
   *  null is the footer's own root-level create. Mirrors FolderTree. */
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const [createDraft, setCreateDraft] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const rowMenu = useContextMenu();

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  const totals = useMemo(() => folderTotals(folders, counts), [folders, counts]);

  const sortSiblings = useMemo(
    () => folderSiblingSorter(sortField, sortDir, totals),
    [sortField, sortDir, totals],
  );

  /** Folder mode: the moved folder's own subtree can never be its parent. */
  const refused = useMemo(() => {
    if (mode !== 'folder' || !movingFolderId) return new Set<string>();
    return subtreeIds(folders, movingFolderId);
  }, [folders, mode, movingFolderId]);

  function isDisabled(folder: FolderDef): boolean {
    if (mode !== 'folder' || !movingFolderId) return false;
    return refused.has(folder.id) || !canMoveFolder(folders, movingFolderId, folder.id);
  }

  /**
   * The row that already holds the thing being moved, checked so the
   * dialog says where it is now. In folder mode that is its parent - the
   * folder itself is refused, so a check on it would be a check on a row
   * you cannot pick.
   */
  const checkedId =
    mode === 'note' ? currentFolderId : folders.find((f) => f.id === movingFolderId)?.parentId ?? null;

  /** Search: flat matches, ancestor path shown as a muted prefix. With
   *  sections, only the folders the sections offer can match, so a search in
   *  "Move to Work" never offers a Personal folder. */
  const searching = query.trim().length > 0;
  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const match = textMatcher(q);
    const offered = sections ? new Set(sections.flatMap((sec) => sec.folders.map((f) => f.id))) : null;
    return flattenFolderRows(folders, { isExpanded: () => true, respectCollapse: false, sortSiblings })
      .map((row) => row.folder)
      .filter((folder) => (!offered || offered.has(folder.id)) && match(folder.name));
  }, [folders, sections, query, sortSiblings]);

  function pathLabel(folder: FolderDef): string {
    const parts: string[] = [];
    let current = folder.parentId ? byId.get(folder.parentId) : undefined;
    while (current) {
      parts.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return parts.join(' / ');
  }

  function cancelCreate() {
    setCreatingUnder(undefined);
    setCreateDraft('');
  }

  /**
   * Creating a folder here used to FILE the note into it and close the
   * dialog in the same keystroke, on the reasoning that you only make a
   * folder here because you want this note in it. In use that read as the
   * save step going missing: the dialog vanished, and the move had already
   * happened before anyone confirmed it (reported 2026-08-27). It now just
   * creates the folder and leaves it on screen, selected by a second tap
   * like any other row.
   */
  function commitCreate() {
    const name = createDraft.trim();
    const parentId = creatingUnder;
    cancelCreate();
    if (!name || !onCreateFolder || parentId === undefined) return;
    const id = onCreateFolder(name, parentId);
    // A subfolder made inside a closed parent would land behind its caret.
    if (id && parentId) expand(folders, parentId);
  }

  function commitRename(id: string) {
    const name = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft('');
    if (name) onRenameFolder?.(id, name);
  }

  function buildRowMenu(folder: FolderDef): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (onCreateFolder && canCreateChild(folders, folder.id)) {
      items.push({
        label: t('folders.newSubfolder'),
        icon: <FolderPlus />,
        onSelect: () => {
          setRenamingId(null);
          setCreateDraft('');
          setCreatingUnder(folder.id);
        },
      });
    }
    if (onRenameFolder) {
      items.push({
        label: t('folders.rename'),
        icon: <PencilSimple />,
        onSelect: () => {
          cancelCreate();
          setRenameDraft(folder.name);
          setRenamingId(folder.id);
        },
      });
    }
    return items;
  }

  /**
   * The "no folder" row is an ACTION - take this note out of its folder,
   * move this folder up to the root - not a destination, so it renders
   * only when picking it would change something. An already-unfiled note
   * used to get a checked "Unfiled" row that did nothing when clicked: a
   * state readout wearing a button's clothes, and the one entry here that
   * isn't a folder. It stays the only way to un-file, which is why it
   * can't simply be dropped. undefined (a multi-select spanning several
   * folders) counts as "would change something" - some of them are filed.
   */
  const clearWouldChange =
    mode === 'note'
      ? currentFolderId !== null
      : folders.find((f) => f.id === movingFolderId)?.parentId != null;

  /** A search hit shows no subfolders below it, so it counts them in. */
  const trailingFor = (folder: FolderDef, withMenu = false, open = false) => (
    <>
      {/* The same "..." the sidebar row wears, from the same class token.
          Right-click alone is undiscoverable on a desktop, a two-hand job on
          a trackpad and absent on a phone. Not drawn on a search result:
          those rows are a flat list of destinations, not the tree. */}
      {withMenu && !isDisabled(folder) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            rowMenu.open(e, buildRowMenu(folder));
          }}
          aria-label={t('folders.actionsForFolder', { folder: folder.name })}
          className={SIDEBAR_ROW_MENU_BUTTON}
        >
          <DotsThree />
        </button>
      )}
      <span className="text-meta text-pn-muted tabular-nums ms-1 shrink-0">
        {(open ? counts : totals).get(folder.id) ?? 0}
      </span>
      {checkedId === folder.id ? (
        <Check className="ms-1.5 me-1 shrink-0 text-accent" />
      ) : (
        <span className="ms-1.5 me-1 w-3.5 shrink-0" aria-hidden="true" />
      )}
    </>
  );

  const renderTree = (list: FolderDef[]) => (
    <FolderTreeView
      folders={list}
      density="dialog"
      sortSiblings={sortSiblings}
      ariaLabel={t('shell:contextMenu.moveToFolder')}
      isActive={(f) => checkedId === f.id}
      isDisabled={isDisabled}
      onSelect={(f) => onPick(f.id)}
      // The dialog reorders and re-files folders too. It was read-only
      // at first, on the reasoning that here a press is a pick - but
      // the drag starts on its own handle, and a tree you can only
      // rearrange from one of the two places that draw it is the same
      // split this whole component was written to end.
      reorder={{ onReorder: onReorderFolders }}
      onContextMenu={(e, f) => {
        if (isDisabled(f)) return;
        rowMenu.open(e, buildRowMenu(f));
      }}
      isEditing={(f) => renamingId === f.id}
      renderName={(f) =>
        renamingId === f.id ? (
          <FolderNameInput
            value={renameDraft}
            onChange={setRenameDraft}
            onCommit={() => commitRename(f.id)}
            onCancel={() => setRenamingId(null)}
            scale="dialog"
          />
        ) : (
          <span className="truncate">{f.name}</span>
        )
      }
      renderTrailing={(f) => (renamingId === f.id ? null : trailingFor(f, true, isExpanded(f)))}
      renderAfter={(f, level) =>
        creatingUnder === f.id ? (
          <div
            className="border-s border-divider"
            style={{ marginInlineStart: level + 1 < MAX_INDENT_LEVEL ? INDENT_PX : 0 }}
          >
            <div className="flex items-center gap-2 px-1 py-2">
              <span className="w-4 shrink-0" aria-hidden="true" />
              <span className="inline-flex shrink-0 text-label">
                <Folder />
              </span>
              <FolderNameInput
          value={createDraft}
          onChange={setCreateDraft}
          onCommit={commitCreate}
          onCancel={cancelCreate}
          scale="dialog"
        />
            </div>
          </div>
        ) : null
      }
    />
  );
  const unfiledRow = !searching && clearWouldChange && (
    <button
      type="button"
      onClick={() => onPick(null)}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-body text-start transition text-pn-muted hover:bg-pn/5 hover:text-pn-soft"
    >
      <span className="inline-flex shrink-0">
        <Prohibit />
      </span>
      <span className="flex-1 min-w-0 truncate">
        {mode === 'folder' ? t('folders.rootLevel') : t('folders.unfiled')}
      </span>
    </button>
  );

  return (
    <PickerModal
      title={title ?? t('shell:contextMenu.moveToFolder')}
      onClose={onClose}
      maxWidth="max-w-sm"
      maxHeight="max-h-[70vh]"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: t('folders.searchPlaceholder'),
        inputRef: searchRef,
      }}
      footer={
        onCreateFolder ? (
          creatingUnder === null ? (
            <div className="flex items-center gap-2 py-0.5">
              <span className="inline-flex shrink-0 text-label">
                <Folder />
              </span>
              <FolderNameInput
                value={createDraft}
                onChange={setCreateDraft}
                onCommit={commitCreate}
                onCancel={cancelCreate}
                scale="dialog"
              />
            </div>
          ) : (
            <DashedAddButton
              fullWidth
              icon={<FolderPlus className="shrink-0 text-label" aria-hidden="true" />}
              onClick={() => {
                setRenamingId(null);
                setCreateDraft('');
                setCreatingUnder(null);
              }}
            >
              {t('folders.new')}
            </DashedAddButton>
          )
        ) : undefined
      }
    >
      {/* Search flattens the tree on purpose: a match three levels down
          is easier to read as one row with its path than as a branch
          the reader has to trace. Carets and indent come back the
          moment the box is empty. */}
      {searching ? (
        matches.map((folder) => {
          const disabled = isDisabled(folder);
          const path = pathLabel(folder);
          return (
            <button
              key={folder.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(folder.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-body text-start transition ${
                disabled
                  ? 'text-pn-muted/75 cursor-not-allowed'
                  : checkedId === folder.id
                    ? 'pn-on-tint bg-accent/15 text-accent-strong dark:bg-accent/20 hover:bg-accent/20 dark:hover:bg-accent/25'
                    : 'text-pn hover:bg-pn/5'
              }`}
            >
              <span className={`inline-flex shrink-0 ${disabled ? '' : 'text-label'}`}>
                <FolderGlyph folderId={folder.id} size={15} />
              </span>
              <span className="flex-1 min-w-0 truncate">
                {path && <span className="text-pn-muted">{path} / </span>}
                {folder.name}
              </span>
              {trailingFor(folder)}
            </button>
          );
        })
      ) : (
        sections ? (
          sections.map((sec, i) => (
            <div key={sec.key} className={i > 0 ? 'mt-2 pt-2 border-t border-divider' : undefined}>
              <div className="flex items-center gap-1.5 px-3 pt-1 pb-1 text-small font-semibold text-pn-muted">
                <sec.icon size={13} aria-hidden="true" />
                {sec.label}
              </div>
              {renderTree(sec.folders)}
              {sec.unfiled && unfiledRow}
            </div>
          ))
        ) : (
          renderTree(folders)
        )
      )}
      {!sections && unfiledRow}
      {searching && matches.length === 0 && (
        <div className="px-3 py-2 text-compact text-pn-muted">
          {t('folders.noMatches')}
        </div>
      )}
      <ContextMenu state={rowMenu.state} onClose={rowMenu.close} />
    </PickerModal>
  );
}
