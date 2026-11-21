/**
 * One import run: a parsed file and the person's choices in, every step in
 * order, the undo included. Both doors of a file import call it, the Import
 * window's Import button (`ImportModal.tsx`) and Files > "Import as notes"
 * (`notesView/useFilesUpload.ts`), so the same file lands the same way from
 * either one, except where a door's choices differ.
 *
 * The order:
 *   1. the rebuilt folder tree merges into the settings (under the "Add to"
 *      folder) and each note's folder id follows it; folder tags if chosen;
 *   2. loose notes go into the "Add to" folder; browser tags if chosen;
 *   3. a note color becomes a tag of that color's name;
 *   4. a note too large to sync is cut into parts, if chosen;
 *   5. declined contact photos leave with their references;
 *   6. pictures and files are staged, and the bodies point at them; this
 *      runs BEFORE the write, or a sync pass can send a placeholder body
 *      (`blobImport.ts`);
 *   7. one write of the notes and the staged files (`applyImport`);
 *   8. only then the settings and the tag colors, which have no undo.
 * A failure before the write ends takes back the folders this run made, the
 * "Add to" folder too when the caller made it for this run, and never one the
 * vault had (backlog 217). The run never throws: every way out is a value.
 */
import i18n from '../i18n';
import { normalizeTag } from '../notesRepo';
import { isOversizeImport, splitImportedNote } from '../noteSplit';
import { savedToFinalIds } from '../backupRestore';
import type { FolderDef } from '../folders';
import { applyImport } from './apply';
import { withBrowserTags } from './browserBookmarks';
import { fileUnfiled } from './destination';
import { withFolderPathTags } from './folderImport';
import type { ApplyResult, ParsedImport, StagedBlob } from './types';

/** What the person chose for this import. */
export interface ImportChoices {
  /** The "Add to" folder (null: none). */
  target: string | null;
  /** The caller made `target` for this import, so a failure takes it back. */
  targetMade?: boolean;
  /** Also tag each note with its folder names. */
  folderTags: boolean;
  /** Keep a bookmark's browser tags and keywords as tags. */
  browserTags: boolean;
  /** Cut a note too large to sync at its headings. */
  splitOversize: boolean;
  /** Leave the address book's photos out. */
  dropContactPhotos: boolean;
  /** The tag every imported note gets (undefined: none). */
  sourceTag?: string;
}

/** The writes outside the notes store, each one the caller's. */
export interface ImportHooks {
  /** Merge a rebuilt folder tree into the settings; old id -> kept id, and
   *  the ids of the folders it made. */
  mergeFolders?: (
    folders: FolderDef[],
    originalIds: ReadonlyMap<string, string> | undefined,
    rootParent: string | null,
  ) => { idMap: Map<string, string>; created: string[] } | void;
  /** Take back folders this run made. */
  undoFolders?: (ids: readonly string[]) => void;
  /** Our own backup: its looks and themes, each folder look moved to the
   *  folder id the merge kept. */
  applySettings?: (
    settings: NonNullable<ParsedImport['settings']>,
    savedToFinal: ReadonlyMap<string, string>,
  ) => void;
  /** Tag -> color key, for the tags made from note colors. */
  applyTagColors?: (colors: Map<string, string>) => void;
  /** Pictures or files landed with the notes: start their uploads. */
  blobsStored?: () => void;
  /** The picture step's own status lines, for a progress screen. */
  media?: { start: () => void; progress: (line: string) => void; end: () => void };
}

export type ImportRunResult =
  /** The notes are in. `mediaError`: the pictures and files did not come
   *  along, and the notes keep their placeholders. */
  | { kind: 'written'; result: ApplyResult; mediaError: string | null }
  /** The write refused the notes; nothing changed. */
  | { kind: 'refused'; errors: string[] }
  /** A step threw. `written`: the notes were in by then. */
  | { kind: 'failed'; error: unknown; written: boolean };

/** The parsed import minus its contact photos: the blobs, and the
 *  `photo` key each card carries, so no body keeps a dangling reference. */
function withoutContactPhotos(parsed: ParsedImport): ParsedImport {
  if (!parsed.blobs) return parsed;
  const blobs = new Map([...parsed.blobs].filter(([, b]) => b.ceiling !== 'contact'));
  const notes = parsed.notes.map((n) => {
    if (n.type !== 'contact') return n;
    try {
      const body = JSON.parse(n.body) as Record<string, unknown>;
      if (!('photo' in body)) return n;
      delete body.photo;
      return { ...n, body: JSON.stringify(body) };
    } catch {
      return n;
    }
  });
  return { ...parsed, blobs, notes };
}

export async function runImport(
  parsed: ParsedImport,
  choices: ImportChoices,
  hooks: ImportHooks = {},
): Promise<ImportRunResult> {
  const made: string[] = choices.targetMade && choices.target ? [choices.target] : [];
  let written = false;
  try {
    const target = choices.target;
    let notes = parsed.notes;
    // The settings wait for the notes (below); a folder look follows its
    // folder there.
    let savedToFinal: ReadonlyMap<string, string> = new Map();
    if (parsed.folders && parsed.folders.length > 0) {
      const merged = hooks.mergeFolders?.(parsed.folders, parsed.originalFolderIds, target);
      if (merged) made.push(...merged.created);
      const idMap = merged?.idMap;
      if (idMap && idMap.size > 0) {
        notes = notes.map((n) =>
          n.folderId && idMap.has(n.folderId) ? { ...n, folderId: idMap.get(n.folderId)! } : n,
        );
      }
      notes = withFolderPathTags(notes, choices.folderTags);
      // A folder look moves with its folder: saved id, to rebuilt id, to the
      // id the merge kept.
      savedToFinal = savedToFinalIds(parsed.originalFolderIds, idMap);
    }
    notes = fileUnfiled(notes, target);
    notes = withBrowserTags(notes, choices.browserTags);
    // A note color from the source (Google Keep) becomes a tag named after
    // the color, in the reader's language, and that tag takes the color:
    // colors live on tags here, never on a note.
    // Spec: docs/internal/specs/folder-tag-icons.md (section 4.7)
    const colorTags = new Map<string, string>();
    if (notes.some((n) => n.colorKey)) {
      notes = notes.map((n) => {
        if (!n.colorKey) return n;
        const tag = normalizeTag(i18n.t(`editor:color.names.${n.colorKey}`));
        if (!tag) return n;
        colorTags.set(tag, n.colorKey);
        return n.tags.includes(tag) ? n : { ...n, tags: [...n.tags, tag] };
      });
    }
    // Notes too large to sync are cut at their headings unless the person
    // said no. Spec: docs/internal/specs/note-size-limit.md
    if (choices.splitOversize && notes.some(isOversizeImport)) {
      notes = notes.flatMap((n) =>
        isOversizeImport(n)
          ? splitImportedNote(
              n,
              (index, total) =>
                i18n.t('importExport:preview.partTitle', { title: n.title || i18n.t('common:state.untitled'), index, total }),
              (title) => i18n.t('notes:split.continuedIn', { link: `[[${title}]]` }),
            )
          : [n],
      );
    }
    let toApply: ParsedImport = notes === parsed.notes ? parsed : { ...parsed, notes };
    // Declined photos leave with their references: a body that still names
    // a blob nobody stored would carry a dead photo key forever.
    if (choices.dropContactPhotos) toApply = withoutContactPhotos(toApply);

    // A media failure is reported, never swallowed: the notes land either
    // way, and the caller says the pictures did not come along.
    let mediaError: string | null = null;
    let staged: StagedBlob[] = [];
    if (toApply.blobs && toApply.blobs.size > 0) {
      hooks.media?.start();
      try {
        const { importBlobs } = await import('./blobImport');
        const media = await importBlobs(toApply.blobs, toApply.notes, hooks.media?.progress);
        toApply = { ...toApply, notes: media.notes };
        staged = media.staged;
      } catch (err) {
        console.warn('Blob import failed:', err);
        mediaError = err instanceof Error ? err.message : String(err);
      }
      hooks.media?.end();
    }

    // The staged files land in the notes' own write, so a failed write
    // keeps neither.
    const result = await applyImport(toApply, choices.sourceTag, staged);
    if (result.errors.length > 0) {
      hooks.undoFolders?.(made);
      return { kind: 'refused', errors: result.errors };
    }
    written = true;
    // Settings and tag colors have no undo, so they wait for the notes.
    if (parsed.settings) hooks.applySettings?.(parsed.settings, savedToFinal);
    if (colorTags.size > 0) hooks.applyTagColors?.(colorTags);
    if (staged.length > 0) hooks.blobsStored?.();
    return { kind: 'written', result, mediaError };
  } catch (error) {
    if (!written) hooks.undoFolders?.(made);
    return { kind: 'failed', error, written };
  }
}
