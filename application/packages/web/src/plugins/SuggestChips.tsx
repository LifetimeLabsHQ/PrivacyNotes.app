import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, Plus } from '../icons';
import type { LocalNote } from '../db';
import { folderNamePath, type FolderDef } from '../folders';
import { meaningNeighbors, pluginsShown, useMeaningIndexReady, useMeaningState } from '../onDeviceAi';
import { isRelatedSource } from '../relatedLoader';
import { RowChip } from '../ui';
import { useSuggestionsOn } from './pluginState';
import { SUGGEST_NEIGHBORS, suggestFolder, suggestTags } from './smartSuggest';

/**
 * Tag and folder suggestions in a note's tag row: up to three faint "+ tag"
 * chips and one "Move to <folder>" chip, from the twenty notes nearest in
 * meaning. Nothing changes until a tap. Only with Smart connections on, its
 * index built and the switch on, on a note that is not locked, PIN-guarded
 * or a vault item.
 * Spec: docs/internal/plans/plugins.md (section 6.2)
 */
export function SuggestChips({ note, notesById, folders, foldersUnlocked, onAddTag, onMove }: {
  note: LocalNote;
  notesById: ReadonlyMap<string, LocalNote>;
  folders: readonly FolderDef[];
  foldersUnlocked: boolean;
  onAddTag: (tag: string) => void;
  onMove: (folderId: string) => void;
}) {
  const { t } = useTranslation('notes');
  const on = useMeaningState().status === 'on';
  const ready = useMeaningIndexReady();
  const switchOn = useSuggestionsOn();
  const shown = pluginsShown() && on && ready && switchOn && note.locked !== 1 && isRelatedSource(note);

  const { tags, folder } = useMemo(() => {
    if (!shown) return { tags: [] as string[], folder: null };
    const live = (id: string) => {
      const n = notesById.get(id);
      return !!n && n.trashed === 0 && n.deleted === 0;
    };
    const neighbors = meaningNeighbors(note, (id) => !live(id), SUGGEST_NEIGHBORS);
    const nextTags = suggestTags(neighbors, (id) => notesById.get(id)?.tags ?? [], note.tags);
    const folderId = foldersUnlocked && !note.folderId ? suggestFolder(neighbors, (id) => notesById.get(id)?.folderId ?? null) : null;
    return { tags: nextTags, folder: folderId && folders.some((f) => f.id === folderId) ? folderId : null };
    // The note's text and tags, and the index, decide the vote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, note.id, note.body, note.title, note.tags, note.folderId, notesById, folders, foldersUnlocked]);

  if (!shown || (tags.length === 0 && !folder)) return null;
  return (
    <>
      {tags.map((tag) => (
        <RowChip key={tag} empty icon={<Plus className="shrink-0" aria-hidden="true" />} onClick={() => onAddTag(tag)}>
          {tag}
        </RowChip>
      ))}
      {folder && (
        <RowChip empty icon={<Folder className="shrink-0 text-label" aria-hidden="true" />} onClick={() => onMove(folder)}>
          {t('tags.suggestMove', { folder: folderNamePath([...folders], folder).join(' / ') })}
        </RowChip>
      )}
    </>
  );
}
