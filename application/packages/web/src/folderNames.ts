/**
 * Folder id -> name, for the folder chip that a list row or a grid tile
 * draws beside its tags (Pro folders).
 *
 * A context rather than a prop because the chip is drawn deep inside
 * `TagChips`: threading a map down would mean adding a prop to every list
 * pane, `NoteRow` and `NoteCard`, none of which read it themselves.
 * `NotesView` owns the folder list and provides the map once, so a rename
 * re-labels every visible chip.
 *
 * Spec: docs/internal/design/ui-patterns.md (section 41, per-item folder chip)
 */
import { createContext, useContext } from 'react';

export const FolderNamesContext = createContext<ReadonlyMap<string, string>>(new Map());

/**
 * Folder id -> group header label (full path like "Prose / Arabic" so nested
 * folders sharing a leaf name never render duplicate headers).
 */
export const FolderGroupLabelsContext = createContext<ReadonlyMap<string, string>>(new Map());

// Latest folder id -> group label map, synced on every NotesView render (the
// pattern of viewRows.ts `setViewOrder`), so pure list selectors like
// `selectTaskNotes` can order by folder without changing their signature.
let currentFolderGroupLabels: ReadonlyMap<string, string> = new Map();

export function setFolderGroupLabels(names: ReadonlyMap<string, string>): void {
  currentFolderGroupLabels = names;
}

export function getFolderGroupLabels(): ReadonlyMap<string, string> {
  return currentFolderGroupLabels;
}

/**
 * The item's folder name, or null when it is unfiled - which is also what a
 * free account always gets, since it has no folders. Callers render nothing
 * on null, so an unfiled item never shows an empty chip.
 */
export function useFolderName(folderId: string | null | undefined): string | null {
  const names = useContext(FolderNamesContext);
  return folderId ? names.get(folderId) ?? null : null;
}
