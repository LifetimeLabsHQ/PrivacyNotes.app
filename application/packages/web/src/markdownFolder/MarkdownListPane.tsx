/**
 * List column for the Markdown folder pillar: scanned files or the entry state.
 *
 * Owns its chrome rather than reusing the encrypted sidebar so isolation holds
 * by construction: nothing reachable here reads or writes the encrypted store.
 *
 * Spec: docs/internal/specs/markdown-folder.md (note-links never cross the boundary; a title must not leak)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListNav } from '../notesView/ListNav';
import { ListPrefsPopover } from '../ListPrefsPopover';
import MarkdownItem from './MarkdownItem';
import { formatBytes } from '../formatBytes';
import { useProgressiveReveal } from '../useProgressiveReveal';
import { itemGridClass, routeItemClick, useScrollRestore } from '../itemList';
import { compareNotes } from '../notesViewUtils';
import { keyText } from '../shortcutMatch';
import { HoverLabel, IconButton, ListSearchInput, SelectionCountStrip } from '../ui';
import { X, CheckSquare, FileMd, FileTxt, Folder, Question, Trash, FunnelSimple, Lock, Copy, ArrowsClockwise, PILLAR_GLYPHS } from '../icons';
import { NewButton } from '../NewButton';
import type { ListPrefs, ListPrefsStore } from '../listPrefs';
import type { View } from '../views';
import type { ContextMenuItem } from '../ContextMenu';
import { markdownSupport } from './capability';
import { MarkdownDefaultAppPopover } from './MarkdownDefaultApp';
import { useDefaultApp } from './defaultApp';
import { forgetFolder, rememberFolder } from './folderMemory';
import { adaptFile, entryToNote, isSupportedFile, isTextFile, readOpenedFile } from './adapter';
import {
  FileExistsError,
  hasRealPath,
  openFailedText,
  pickDirectory,
  pickFile,
  type DirectoryEntry,
  type OpenedFileRef,
} from './fileAccess';
import type { FileMeta } from './useTagIndex';
import { MarkdownEmptyState } from './MarkdownEmptyState';
import { LooksContext, NO_LOOKS } from '../looks/LookGlyph';
import { textMatcher } from '../textMatch';
import { isImeComposing } from '../imeComposing';
import type { OpenedMarkdownDir, OpenedMarkdownFile } from './types';

/** Files on disk carry no PIN flag, so rows in this pane are never PIN-gated. */
const DISK_FILE_LOCKED = false;

export function MarkdownListPane({
  onSelectView,
  hiddenViews,
  onOpenDrawer,
  dir,
  onDir,
  dirFilter,
  tagFilter,
  initialFilter,
  tagsByPath,
  tagsScanned,
  listPrefs,
  listPrefsStore,
  onListPrefsChange,
  opened,
  onOpened,
  viewMode,
  onExplain,
  reopenName,
  onReopen,
  onContextMenu,
  onImportToNotes,
  onRequestDelete,
  onImportManyToNotes,
  onRequestDeleteMany,
}: {
  onSelectView: (next: View) => void;
  /** Passed straight to ListNav; see userSettings.hiddenViews. */
  hiddenViews?: import('../views').View[] | undefined;
  onOpenDrawer: () => void;
  dir: OpenedMarkdownDir | null;
  onDir: (next: OpenedMarkdownDir | null) => void;
  /** Subfolder and tag selections from the sidebar rail. */
  dirFilter: string | null;
  tagFilter: string | null;
  /** Initial search query carried over when navigating from All search. */
  initialFilter?: string;
  tagsByPath: Map<string, FileMeta>;
  /** False while the background tag pass is still reading files, distinguishing
   *  "no files match this tag" from "still scanning". */
  tagsScanned: boolean;
  /** Resolved list preferences so preview, date, tags, and size toggles match other lists. */
  listPrefs: ListPrefs;
  /** Shared list preferences store backing the sort popover. */
  listPrefsStore: ListPrefsStore;
  onListPrefsChange: (next: ListPrefsStore) => void;
  opened: OpenedMarkdownFile | null;
  onOpened: (file: OpenedMarkdownFile | null) => void;
  /** List or grid layout from the shell setting. */
  viewMode: 'list' | 'grid';
  /** Opens the explainer modal rendered by the shell. Spec: docs/internal/specs/markdown-folder.md (12) */
  onExplain: () => void;
  /** Remembered folder awaiting a click to re-grant permission or desktop scope. */
  reopenName: string | null;
  onReopen: () => void;
  /** Opens the app context menu at the pointer. */
  onContextMenu: (e: React.MouseEvent, items: ContextMenuItem[]) => void;
  /** Filename and raw text so the importer produces the same note as drag-and-drop. */
  onImportToNotes: (filename: string, raw: string) => void;
  onRequestDelete: (file: OpenedMarkdownFile) => void;
  /** Bulk actions over relative paths, resolved locally without exposing folder entries to the shell. */
  onImportManyToNotes: (paths: string[]) => Promise<void>;
  onRequestDeleteMany: (paths: string[]) => void;
}) {
  const { t } = useTranslation('shell');
  const support = markdownSupport();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState(initialFilter ?? '');
  const reveal = useProgressiveReveal();
  // Preserves scroll position across pane hide/show (#186); resets when folder or filters change.
  const scroll = useScrollRestore([dir, filter, dirFilter, tagFilter]);
  const gridMode = viewMode === 'grid';
  const [showListPrefs, setShowListPrefs] = useState(false);
  const [showDefaultApp, setShowDefaultApp] = useState(false);
  /**
   * Read here as well as inside the popover because the toolbar button is shown
   * only while PrivacyNotes is not yet the default `.md` handler; one shared
   * module state backs both (`defaultApp.ts`).
   */
  const defaultApp = useDefaultApp('markdown');
  /**
   * Local multi-select over relative paths. Kept separate from `useMultiSelect`
   * because that hook wires into `notesRepo`, sync, blob stores, and PIN gates
   * on the encrypted store, while gestures (click toggle, shift-range, touch
   * long-press) stay identical.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const lastPickedRef = useRef<string | null>(null);
  const longPressRef = useRef<number | null>(null);
  const listPrefsButtonRef = useRef<HTMLButtonElement | null>(null);
  const defaultAppButtonRef = useRef<HTMLButtonElement | null>(null);

  async function openRef(ref: OpenedFileRef) {
    onOpened(await readOpenedFile(ref));
  }

  async function handleOpenFile() {
    setError(null);
    try {
      const ref = await pickFile();
      if (!ref) return; // canceled - not an error
      // Validate extension explicitly because OS file pickers allow switching to "All files".
      if (!isSupportedFile(ref.name)) {
        setError(t('markdown.unsupportedFile'));
        return;
      }
      await openRef(ref);
    } catch (err) {
      setError(openFailedText(t, err));
    }
  }

  /**
   * Opens the OS directory picker directly; `MarkdownEmptyState` displays
   * `MarkdownPitch` inline above the picker, and the `?` toolbar button opens
   * the full reference card once a folder is loaded.
   * Spec: docs/internal/specs/markdown-folder.md (section 12)
   */
  async function handleOpenFolder() {
    setError(null);
    setBusy(true);
    try {
      const ref = await pickDirectory();
      if (!ref) return;
      if (ref.remember) void rememberFolder(ref.remember);
      onDir({ ref, entries: await ref.scan() });
      onOpened(null);
      setFilter('');
      reveal.reset();
    } catch {
      setError(t('markdown.openFailed'));
    } finally {
      setBusy(false);
    }
  }

  /** Creates a new untitled Markdown file in the active subfolder. */
  async function handleNew() {
    if (!dir) return;
    setError(null);
    setBusy(true);
    const base = dirFilter ?? '';
    const freeName = (entries: DirectoryEntry[]) => {
      const taken = new Set(entries.map((e) => e.relPath));
      let name = 'Untitled.md';
      for (let i = 2; taken.has(`${base}${name}`); i++) name = `Untitled ${i}.md`;
      return `${base}${name}`;
    };
    try {
      let entries = dir.entries;
      try {
        const ref = await dir.ref.createFile(freeName(entries), '');
        onDir({ ref: dir.ref, entries: await dir.ref.scan() });
        await openRef(ref);
        return;
      } catch (err) {
        if (!(err instanceof FileExistsError)) throw err;
        // Rescan once when an external file was created after the last scan snapshot.
        entries = await dir.ref.scan();
        onDir({ ref: dir.ref, entries });
      }
      const ref = await dir.ref.createFile(freeName(entries), '');
      onDir({ ref: dir.ref, entries: await dir.ref.scan() });
      await openRef(ref);
    } catch {
      setError(t('markdown.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Rescans the folder while holding `busy` for at least one 600ms rotation
   * concurrently with `scan()` so fast local scans still show visible feedback
   * without delaying slower folders.
   */
  async function handleRescan() {
    if (!dir) return;
    setError(null);
    setBusy(true);
    try {
      const [entries] = await Promise.all([
        dir.ref.scan(),
        new Promise((resolve) => setTimeout(resolve, 600)),
      ]);
      onDir({ ref: dir.ref, entries });
    } catch {
      setError(t('markdown.openFailed'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Context menu for a file row so right-clicking never bubbles to the shell's
   * encrypted-item fallback menu. Includes `Copy path` only when the platform
   * exposes real filesystem paths (`hasRealPath()`).
   */
  function rowMenu(entry: DirectoryEntry): ContextMenuItem[] {
    const path = entry.ref.location;
    const isSelected = selected.has(entry.relPath);
    // Only `Copy path` is offered on desktop: `opener:default` grants `openUrl`
    // without path reveal, and opening in the OS default `.md` app would loop
    // back into PrivacyNotes when PrivacyNotes owns the association.
    const pathItems: ContextMenuItem[] = hasRealPath() ? [
      {
        label: t('markdown.copyPath'),
        icon: <Copy />,
        onSelect: () => void navigator.clipboard.writeText(path),
      },
      { type: 'separator' },
    ] : [];

    return [
      {
        label: isSelected ? t('contextMenu.deselect') : t('contextMenu.select'),
        icon: <CheckSquare />,
        onSelect: () => toggleSelected(entry.relPath),
      },
      { type: 'separator' },
      ...pathItems,
      {
        label: t('markdown.saveToNotes'),
        icon: <Lock />,
        onSelect: () => {
          void (async () => {
            const raw = await entry.ref.read();
            onImportToNotes(entry.ref.name, raw);
          })();
        },
      },
      { type: 'separator' },
      {
        label: t('common:actions.delete'),
        icon: <Trash />,
        destructive: true,
        onSelect: () => {
          void (async () => {
            const raw = await entry.ref.read();
            onRequestDelete({
              ref: entry.ref,
              raw,
              stamp: await entry.ref.stamp(),
              adapted: adaptFile(entry.ref.name, raw),
              reloadToken: 0,
            });
          })();
        },
      },
    ];
  }

  function exitSelection() {
    setSelectionMode(false);
    setSelected(new Set());
    lastPickedRef.current = null;
  }

  /** Prune selected paths and range anchor that no longer exist after a rescan,
   *  exiting selection mode if every selected file was removed. */
  useEffect(() => {
    const live = new Set((dir?.entries ?? []).map((e) => e.relPath));
    if (lastPickedRef.current !== null && !live.has(lastPickedRef.current)) {
      lastPickedRef.current = null;
    }
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((p) => live.has(p)));
      if (next.size === prev.size) return prev;
      if (next.size === 0) setSelectionMode(false);
      return next;
    });
  }, [dir]);

  /** Toggle one path, syncing `selectionMode` when picking the first or dropping the last row. */
  function toggleSelected(relPath: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath); else next.add(relPath);
      setSelectionMode(next.size > 0);
      return next;
    });
    lastPickedRef.current = relPath;
  }

  /** Shift-click selects the span between the last pick and `relPath` in visible list order. */
  function rangeSelect(relPath: string) {
    const anchor = lastPickedRef.current;
    if (!anchor) { toggleSelected(relPath); return; }
    const order = matches.map((m) => m.entry.relPath);
    const from = order.indexOf(anchor);
    const to = order.indexOf(relPath);
    if (from < 0 || to < 0) { toggleSelected(relPath); return; }
    const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    setSelectionMode(true);
    setSelected((prev) => new Set([...prev, ...span]));
    lastPickedRef.current = relPath;
  }

  function beginLongPress(relPath: string) {
    longPressRef.current = window.setTimeout(() => toggleSelected(relPath), 500);
  }
  function cancelLongPress() {
    if (longPressRef.current) { window.clearTimeout(longPressRef.current); longPressRef.current = null; }
  }

  /**
   * Escape exits selection mode in bubble phase so capture-phase modals and
   * popovers (`useEscapeToClose`) consume Escape first when open.
   */
  useEffect(() => {
    if (!selectionMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isImeComposing(e)) exitSelection();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectionMode]);

  /**
   * Changing the open folder location or rail filters clears selection so bulk
   * actions never target hidden files; keyed on `dir?.ref.location` so rescans
   * of the same folder preserve active selections.
   */
  useEffect(() => {
    if (selectionMode) exitSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir?.ref.location, dirFilter, tagFilter]);

  /** Formatted byte size once the background pass has stat'd the file. */
  const sizeOf = (entry: DirectoryEntry) => {
    if (!listPrefs.showSize) return null;
    const bytes = tagsByPath.get(entry.relPath)?.size;
    return bytes != null ? formatBytes(bytes) : null;
  };

  // Filters by relative path rather than full-text file reads.
  const matches = useMemo(() => {
    if (!dir) return [];
    const q = filter.trim();
    const match = q ? textMatcher(q) : null;
    const filtered = dir.entries.filter((e) => {
      if (dirFilter !== null && !e.dir.startsWith(dirFilter)) return false;
      if (tagFilter !== null && !(tagsByPath.get(e.relPath)?.tags ?? []).includes(tagFilter)) return false;
      if (match && !match(e.relPath)) return false;
      return true;
    });

    /* Sort through `compareNotes` so sort rules stay consistent across pillars,
     * overriding `size` with byte counts from the background scan (since `note.body`
     * holds a short excerpt). Unscanned files sort last in both directions rather
     * than jumping from 0 as the index fills. */
    const rows = filtered.map((entry) => ({
      entry,
      note: entryToNote(entry.relPath, tagsByPath.get(entry.relPath)),
    }));
    const dirMul = listPrefs.sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (listPrefs.sortField === 'size') {
        const av = tagsByPath.get(a.entry.relPath)?.size;
        const bv = tagsByPath.get(b.entry.relPath)?.size;
        if (av == null || bv == null) {
          if (av != null) return -1;
          if (bv != null) return 1;
        } else if (av !== bv) {
          return (av - bv) * dirMul;
        }
      }
      return compareNotes(a.note, b.note, listPrefs);
    });
    return rows;
  }, [dir, filter, dirFilter, tagFilter, tagsByPath, listPrefs.sortField, listPrefs.sortDir]);

  /**
   * Auto-opens the first file once per opened folder on desktop/tablet widths
   * (`>= 768px`) in list mode, without re-selecting when filter typing hides
   * the open file.
   */
  const autoOpenedFolderRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dir) {
      autoOpenedFolderRef.current = null;
      return;
    }
    if (gridMode || opened) return;
    if (autoOpenedFolderRef.current === dir.ref.location) return;
    const first = matches[0];
    if (!first) return;
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) return;
    autoOpenedFolderRef.current = dir.ref.location;
    void openRef(first.entry.ref).catch((err) => setError(openFailedText(t, err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, gridMode, opened, matches]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-1">
      {selectionMode ? (
        <div className="shrink-0 h-11 md:h-14 px-3 border-b border-divider flex items-center justify-between gap-1 bg-accent/5 dark:bg-accent/10">
          <IconButton
            label={t('markdown.exitSelection')}
            keys={keyText('escape')}
            position="below-start"
            onClick={exitSelection}
          >
            <X aria-hidden="true" />
          </IconButton>
          <div className="shrink-0 flex items-center gap-1">
            <IconButton
              label={t('markdown.saveToNotes')}
              tone="accent"
              position="below"
              disabled={selected.size === 0}
              onClick={() => {
                const paths = [...selected];
                exitSelection();
                void onImportManyToNotes(paths);
              }}
            >
              <Lock aria-hidden="true" />
            </IconButton>
            {/* Opens a confirm modal; selection stays intact until the delete completes and rescans. */}
            <IconButton
              label={t('common:actions.delete')}
              tone="danger"
              position="below-end"
              disabled={selected.size === 0}
              onClick={() => onRequestDeleteMany([...selected])}
            >
              <Trash aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      ) : (
        <div className="shrink-0 h-11 md:h-14 px-4 border-b border-divider flex items-center justify-between gap-3">
          <ListNav
            hiddenViews={hiddenViews}
            view="markdown"
            onSelectView={onSelectView}
            onOpenDrawer={onOpenDrawer}
            icon={<PILLAR_GLYPHS.markdown size={26} className="text-accent shrink-0" aria-hidden="true" />}
            title={t('markdown.title')}
          />
          {dir && <NewButton onClick={() => void handleNew()} label={t('markdown.new')} />}
        </div>
      )}

      {dir && (
        <div className="shrink-0 border-b border-divider px-3 py-2">
          {/* Folder path button reopens the directory picker, paired with Rescan
              and Close; `flex-wrap` lets trailing buttons wrap on deep paths. */}
          <div className="relative flex items-center flex-wrap gap-2 mb-2">
            <HoverLabel label={t('markdown.selectFolder')} position="below" className="min-w-0">
              <button
                type="button"
                onClick={() => void handleOpenFolder()}
                className="inline-flex items-center gap-2 h-8 min-w-0 max-w-full rounded-md border border-divider bg-surface-2 px-2 hover:border-accent transition cursor-pointer"
              >
                {/* Amber `text-label` matches the rail's folder glyphs. */}
                <Folder className="text-label shrink-0" />
                <span className="font-mono text-compact font-medium text-pn truncate">
                  {dir.ref.location}
                </span>
                <span aria-hidden="true" className="shrink-0 text-small text-pn-muted tabular-nums">
                  {matches.length}
                </span>
                <span className="sr-only">{t('markdown.fileCount', { count: matches.length })}</span>
              </button>
            </HoverLabel>
            <IconButton
              label={t('markdown.rescanFolder')}
              position="below"
              disabled={busy}
              onClick={() => void handleRescan()}
              className="group border border-divider bg-surface-2 hover:border-accent hover:!text-accent"
            >
              {/* Hover rotates half a turn; `busy` runs `animate-spin` exclusively
                  so `transform` and `rotate` never compose. */}
              <ArrowsClockwise
                aria-hidden="true"
                className={busy ? 'animate-spin' : 'transition-transform duration-300 group-hover:rotate-180'}
              />
            </IconButton>
            {/* Calls `forgetFolder` so the folder is not reopened on next launch. */}
            <IconButton
              label={t('markdown.closeFolder')}
              position="below"
              onClick={() => { void forgetFolder(); onDir(null); onOpened(null); }}
              className="border border-divider bg-surface-2 hover:border-accent hover:!text-accent"
            >
              <X aria-hidden="true" />
            </IconButton>
            <span className="flex-1" />
            {/* Desktop-only default-app trigger, grouped with `?` after the spacer
                so both feature controls wrap together on narrow columns. Shown only
                while PrivacyNotes does not own the `.md` association, styled with
                theme `success` tokens while actionable.
                Spec: docs/internal/specs/markdown-folder.md (section 11) */}
            {defaultApp && defaultApp.owner !== 'ours' && (
              <IconButton
                ref={defaultAppButtonRef}
                label={t('markdown.assocTitle')}
                position="below-end"
                aria-expanded={showDefaultApp}
                aria-haspopup="dialog"
                onClick={() => setShowDefaultApp((v) => !v)}
                className={`border ${
                  showDefaultApp
                    ? 'bg-accent/10 border-accent !text-accent-strong'
                    : 'bg-surface-2 border-success/50 !text-success hover:border-success hover:!bg-success/10'
                }`}
              >
                <FileMd aria-hidden="true" />
              </IconButton>
            )}
            <MarkdownDefaultAppPopover
              open={showDefaultApp}
              onClose={() => setShowDefaultApp(false)}
              anchorRef={defaultAppButtonRef}
            />
            {/* Sole entry point for the explainer modal; fixed-width icon square
                keeps translated labels from wrapping the path row. */}
            <IconButton
              label={t('markdown.localFolder')}
              tone="accent"
              position="below-end"
              onClick={() => onExplain()}
              className="border border-divider bg-surface-2 hover:border-accent"
            >
              <Question weight="fill" aria-hidden="true" />
            </IconButton>
          </div>
          {/* Search and sort row matching `NotesList`. */}
          <div className="flex items-stretch gap-2 relative">
            <IconButton
              ref={listPrefsButtonRef}
              label={t('notes:search.sortOptions')}
              position="above-start"
              aria-expanded={showListPrefs}
              onClick={() => setShowListPrefs((v) => !v)}
              className={`!w-10 !h-10 border ${
                showListPrefs
                  ? 'bg-accent/10 border-accent !text-accent-strong'
                  : 'bg-surface-2 border-divider hover:border-accent hover:!text-accent'
              }`}
            >
              <FunnelSimple aria-hidden="true" />
            </IconButton>
            <ListSearchInput
              value={filter}
              onChange={(v) => { setFilter(v); reveal.reset(); }}
              placeholder={t('markdown.searchFolder')}
            />
            {showListPrefs && (
              <ListPrefsPopover
                store={listPrefsStore}
                onChange={onListPrefsChange}
                onClose={() => setShowListPrefs(false)}
                anchorRef={listPrefsButtonRef}
                className="absolute start-0 top-full mt-1 z-20"
                showSizeToggle
              />
            )}
          </div>
          {/* Surfaces New and Rescan errors while a folder is open; cleared before each retry. */}
          {error && <p className="mt-1.5 text-small text-danger">{error}</p>}
        </div>
      )}

      {selectionMode && selected.size > 0 && (
        <SelectionCountStrip
          selectedCount={selected.size}
          totalCount={matches.length}
          label={t('markdown.selectedCount', { selected: selected.size, total: matches.length })}
          onSelectAll={() => setSelected(new Set(matches.map((m) => m.entry.relPath)))}
          onDeselectAll={() => setSelected(new Set())}
        />
      )}
      <div
        ref={scroll.ref as React.RefObject<HTMLDivElement>}
        className="flex-1 min-h-0 overflow-y-auto"
        onScroll={(e) => {
          scroll.onScroll(e.currentTarget);
          reveal.onScroll(e.currentTarget, matches.length);
        }}
      >
        {dir ? (
          matches.length === 0 ? (
            <p className="p-4 text-compact text-pn-muted text-center">
              {/* Show scanning state when a tag filter is active before the background pass completes. */}
              {tagFilter !== null && !tagsScanned
                ? t('markdown.scanning')
                : filter.trim() || dirFilter !== null || tagFilter !== null
                  ? t('markdown.noMatches')
                  : t('markdown.folderEmpty')}
            </p>
          ) : (
            // Plaintext files do not inherit vault tag colors or icons.
            <LooksContext.Provider value={NO_LOOKS}>
            <ul className={itemGridClass(gridMode)}>
              {matches.slice(0, reveal.visible).map(({ entry, note }) => (
                <MarkdownItem
                  key={entry.relPath}
                  note={note}
                  isOpen={opened?.ref.location === entry.ref.location}
                  // Suppress preview and date until the background scan populates them.
                  listPrefs={{ ...listPrefs, showPreview: listPrefs.showPreview && tagsScanned, showDate: listPrefs.showDate && tagsScanned }}
                  isNoteLocked={DISK_FILE_LOCKED}
                  // Cmd/Ctrl-click enters selection mode on pointer devices alongside touch long-press.
                  onClick={(e) =>
                    routeItemClick(e, selectionMode, {
                      range: () => rangeSelect(entry.relPath),
                      toggle: () => toggleSelected(entry.relPath),
                      open: () => void openRef(entry.ref),
                    })
                  }
                  selectionMode={selectionMode}
                  isMultiSelected={selected.has(entry.relPath)}
                  onToggleSelect={(e) => {
                    if (e.shiftKey) rangeSelect(entry.relPath); else toggleSelected(entry.relPath);
                  }}
                  onTouchStart={() => beginLongPress(entry.relPath)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  showTypeIcons
                  size={sizeOf(entry)}
                  onContextMenu={(e) => { e.stopPropagation(); onContextMenu(e, rowMenu(entry)); }}
                  grid={gridMode}
                  text={isTextFile(entry.ref.name)}
                />
              ))}
            </ul>
            </LooksContext.Provider>
          )
        ) : opened ? (
          <SingleFileCard opened={opened} onClose={() => onOpened(null)} onOpenFile={() => void handleOpenFile()} />
        ) : (
          <MarkdownEmptyState
            support={support}
            error={error}
            busy={busy}
            reopenName={reopenName}
            onReopen={onReopen}
            onOpenFile={() => void handleOpenFile()}
            onOpenFolder={() => void handleOpenFolder()}
          />
        )}
      </div>
    </div>
  );
}

function SingleFileCard({
  opened,
  onClose,
  onOpenFile,
}: {
  opened: OpenedMarkdownFile;
  onClose: () => void;
  onOpenFile: () => void;
}) {
  const { t } = useTranslation('shell');
  return (
    <div className="p-3">
      <div className="rounded-lg border border-divider bg-surface-2 p-3">
        <div className="flex items-center gap-2 mb-1">
          {isTextFile(opened.ref.name)
            ? <FileTxt className="text-accent shrink-0" />
            : <FileMd className="text-accent shrink-0" />}
          <span className="text-compact font-medium truncate">{opened.adapted.title}</span>
        </div>
        <p className="font-mono text-meta text-pn-muted truncate mb-2">
          {opened.ref.location}
        </p>
        {opened.adapted.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {opened.adapted.tags.map((tag) => (
              <span key={tag} className="text-meta px-1.5 py-0.5 rounded-full border border-divider text-pn-muted">
                #{tag}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button type="button" onClick={onOpenFile} className="text-small text-accent hover:underline">
            {t('markdown.openFile')}
          </button>
          <button type="button" onClick={onClose} className="text-small text-accent hover:underline">
            {t('markdown.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
