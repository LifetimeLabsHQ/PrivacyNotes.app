import { useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { SupabaseClient } from '@notes/shared';
import { fetchQuotaUsage } from '../devices';
import { isUnsyncedLocalVault } from '../localOnly';
import type { AttachmentStore } from '../attachmentStore';
import { formatFileSize, validateAttachment } from '../attachmentValidation';
import { proUnlocked } from '../demo';
import { currentImageOptions, isSupportedImage, processImage } from '../imageProcessing';
import type { LocalNote } from '../db';
import { parseMarkdown } from '../import/markdown';
import { ensureImportLogLoaded } from '../i18n';
import type { FolderDef } from '../folders';
import { SUPPORTED_EXT } from '../markdownFolder/adapter';
import { signInStamp, signedOutSince } from '../liveSignIn';
import { holdLockReload } from '../lockReload';
import { createNote } from '../notesRepo';
import type { FileUploadEntry } from '../UploadProgressModal';
import type { View } from '../views';

/**
 * A file whose bytes are read only when its turn in the upload comes: the
 * share inbox hands a batch over this way, so the window lists every file
 * from the start while only one file is ever held in memory.
 */
export interface LaterFile {
  name: string;
  size: number;
  read: () => Promise<File>;
  /** Removes the file from where it waits (the share inbox), for a file the
   *  upload keeps; the upload window offers it on that file's row. */
  discard?: () => Promise<void>;
}

type UploadSource = File | LaterFile;

const ENCRYPTED_BACKUP_EXT = /\.(pnbackup|pnbackupz)$/i;

export type PendingFilesPrompt =
  | { kind: 'markdown'; files: File[] }
  | { kind: 'backup'; file: File };

export function useFilesUpload({
  auth,
  supabase,
  attachmentStoreRef,
  quotaRef,
  refresh,
  runSync,
  refreshStorage,
  setSelectedId,
  setView,
  setImportToast,
  onImportFolders,
  onUndoImportFolders,
  importDestination,
  onBlobsRestored,
  inheritFilters,
}: {
  auth: { status?: string; isPro: boolean };
  supabase: SupabaseClient;
  attachmentStoreRef: MutableRefObject<AttachmentStore | null>;
  quotaRef: MutableRefObject<{ usedBytes: number; maxBytes: number } | null>;
  refresh: () => Promise<LocalNote[]>;
  runSync: () => Promise<void>;
  refreshStorage: () => void;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setView: (next: View) => void;
  setImportToast: Dispatch<SetStateAction<string | null>>;
  /** Merge a rebuilt folder tree into settings under `rootParent` (null: at
   *  the top); returns old id -> kept id, and the ids of the folders it made. */
  onImportFolders?: (folders: FolderDef[], rootParent: string | null) => { idMap: Map<string, string>; created: string[] } | undefined;
  /** Take back the folders a file's failed import made (backlog 217). */
  onUndoImportFolders?: (ids: readonly string[]) => void;
  /** The Import window's default "Add to", decided once per import before the
   *  first await, so a space switch while the files are read cannot move the
   *  import: null for none, else a function that makes (or reuses) the folder,
   *  in Work a folder named after the source, since unfiled reads as Personal.
   *  Called once the first file has parsed, so a batch that fails to parse
   *  leaves no empty folder; only an explicit `{ id, created: true }` result
   *  is eligible for rollback if zero notes are written. */
  importDestination?: () => (() => string | { id: string; created: boolean } | null) | null;
  /** Kick the pending-upload passes once blobs have landed locally. */
  onBlobsRestored?: () => void;
  /** The folder and tags the list the upload started from is filtered by. A
   *  file that misses them lands outside that list, and the auto-select
   *  effect then drops the selection, so the upload reads as doing nothing
   *  (the fault GitHub #305 describes for contacts). Read at upload time, not
   *  at render time, because the New menu switches to Files on the way here. */
  inheritFilters?: () => { tags: string[]; folderId: string | null };
}) {
  const { t } = useTranslation('notes');

  // Upload progress modal state
  const [uploadEntries, setUploadEntries] = useState<FileUploadEntry[] | null>(null);
  // Files-pillar upload: when the user picks .md/.zip files, ask whether
  // to import-as-notes (or restore, for our own backup .zip) or store as
  // encrypted attachments before proceeding.
  const [pendingImportableFiles, setPendingImportableFiles] = useState<PendingFilesPrompt | null>(null);
  const filesUploadRef = useRef<HTMLInputElement | null>(null);

  /** Trigger file upload from the Files view. The picker accepts every
   *  type the vault does: the type tabs choose what the list shows, never
   *  what may be added. */
  function handleFilesUpload() {
    filesUploadRef.current?.click();
  }

  /** Handle file(s) selected via the hidden input.
   *  Single file → its own note. Multiple files → one shared note.
   *  When every selected file is .md or .zip, sniff any .zip for a
   *  PrivacyNotes backup manifest so our own backups route to Backup > Restore
   *  instead of being flattened by the plain markdown importer. */
  async function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const store = attachmentStoreRef.current;
    if (!store) return;
    const fileArr = Array.from(files);
    // Reset so re-selecting the same file fires onChange again.
    e.target.value = '';

    // A lone encrypted PrivacyNotes backup (.pnbackup / .pnbackupz) routes to
    // the same Restore or store? prompt as a full backup .zip.
    if (fileArr.length === 1 && ENCRYPTED_BACKUP_EXT.test(fileArr[0]!.name)) {
      setPendingImportableFiles({ kind: 'backup', file: fileArr[0]! });
      return;
    }

    // Detect importable files: anything the markdown importer reads, plus a
    // zip. The extension list is the adapter's, not a second copy - a `.txt`
    // or `.markdown` the importer accepts but this check does not would be
    // silently attached as a file instead of offered as notes.
    const allImportable = fileArr.every(
      (f) => SUPPORTED_EXT.test(f.name) || f.name.toLowerCase().endsWith('.zip'),
    );
    if (allImportable) {
      const zips = fileArr.filter((f) => f.name.toLowerCase().endsWith('.zip'));
      if (zips.length > 0) {
        let kinds: Array<'backup' | 'markdown' | 'attachment'>;
        try {
          // Dynamic import keeps jszip and the backup parser off the boot path.
          const { classifyFilesZip } = await import('../import/privacynotes');
          kinds = await Promise.all(zips.map((f) => classifyFilesZip(f)));
        } catch {
          // Offline or chunk load failure: store the files locally rather than dropping the upload.
          await doAttachmentUpload(fileArr, store);
          return;
        }
        if (fileArr.length === 1 && kinds[0] === 'backup') {
          setPendingImportableFiles({ kind: 'backup', file: fileArr[0]! });
          return;
        }
        if (kinds.every((k) => k === 'markdown')) {
          setPendingImportableFiles({ kind: 'markdown', files: fileArr });
          return;
        }
        // Non-markdown archives (HTML/Drawings/Calendar/photo/corrupt zips)
        // and multi-file batches containing a backup zip store as files.
        await doAttachmentUpload(fileArr, store);
        return;
      }
      setPendingImportableFiles({ kind: 'markdown', files: fileArr });
      return; // Wait for user choice in the prompt dialog.
    }

    await doAttachmentUpload(fileArr, store);
  }

  /** Run the import pipeline on markdown/.zip files from the Files pillar.
   *
   *  Runs through `runImport` (`import/importRun.ts`) under `holdLockReload`
   *  with the same defaults as `ImportModal`: the batch's default destination
   *  (undone if no notes land), folder tags for free accounts, oversize-note
   *  splitting, and the `markdown` source tag. */
  async function handleImportFromFiles(files: File[]) {
    setPendingImportableFiles(null);
    const releaseLockReload = holdLockReload();
    try {
      let totalImported = 0;
      let anyWritten = false;
      let lastFailure: { fileName: string; detail: string } | null = null;
      let lastMediaError: string | null = null;
      const isPro = (auth.status === undefined || auth.status === 'authenticated') && auth.isPro;
      const folderTags = !proUnlocked(isPro);
      const makeTarget = importDestination?.() ?? null;
      let target: string | null = null;
      let createdTarget = false;
      let targetResolved = false;

      for (const file of files) {
        try {
          await ensureImportLogLoaded();
          const parsed = await parseMarkdown(file);
          if (!targetResolved) {
            const resolved = makeTarget ? makeTarget() : null;
            if (typeof resolved === 'string') {
              target = resolved;
              createdTarget = false;
            } else if (resolved !== null) {
              target = resolved.id;
              createdTarget = resolved.created;
            }
            targetResolved = true;
          }
          const { runImport } = await import('../import/importRun');
          // A multi-file batch shares `target`; if zero files write anything,
          // the batch undo below removes `target` only when `createdTarget` is true.
          const run = await runImport(
            parsed,
            {
              target,
              folderTags,
              browserTags: false,
              splitOversize: true,
              dropContactPhotos: false,
              sourceTag: 'markdown',
            },
            {
              mergeFolders: onImportFolders ? (folders, _originalIds, rootParent) => onImportFolders(folders, rootParent) : undefined,
              undoFolders: onUndoImportFolders,
              blobsStored: onBlobsRestored,
            },
          );
          if (run.kind === 'refused') {
            const detail = run.errors.join('\n');
            console.warn('[Files->Import] write failed for', file.name, run.errors);
            lastFailure = { fileName: file.name, detail };
            continue;
          }
          if (run.kind === 'failed') {
            if (run.written) anyWritten = true;
            const detail = run.error instanceof Error ? run.error.message : String(run.error);
            console.warn('[Files->Import] failed for', file.name, run.error);
            lastFailure = { fileName: file.name, detail };
            continue;
          }
          if (run.result.imported > 0 || run.result.noteIds.length > 0) {
            anyWritten = true;
          }
          if (run.mediaError) {
            console.warn('[Files->Import] media failed for', file.name, run.mediaError);
            lastMediaError = run.mediaError;
          }
          totalImported += run.result.imported;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.warn('[Files->Import] failed for', file.name, err);
          lastFailure = { fileName: file.name, detail };
        }
      }

      if (!anyWritten && totalImported === 0 && createdTarget && target !== null) {
        onUndoImportFolders?.([target]);
      }

      if (anyWritten || totalImported > 0) {
        setImportToast(
          lastMediaError
            ? t('importExport:errors.blobImportFailed', { detail: lastMediaError })
            : lastFailure
              ? t('toast.uploadFailedFor', { filename: lastFailure.fileName, error: lastFailure.detail })
              : t('toast.importedSyncing', { count: totalImported }),
        );
        await refresh();
        void runSync();
        // Switch to Notes so the user sees the imported content immediately
        // instead of staring at the Files pillar wondering if it worked.
        setView('all');
        window.setTimeout(() => setImportToast(null), 4000);
      } else if (lastFailure) {
        setImportToast(
          t('importExport:errors.importNothingChanged', { detail: lastFailure.detail }),
        );
        window.setTimeout(() => setImportToast(null), 4000);
      }
    } finally {
      releaseLockReload();
    }
  }

  /** Proceed with normal encrypted-attachment upload for selected files.
   *  Called explicitly via ConfirmModal's onCancel ("Store as files"). */
  async function handleAttachFromFiles<T extends UploadSource>(
    files: T[],
    isCurrent?: () => boolean,
    overrideFilters?: { folderId?: string | null; tags?: string[] },
  ): Promise<T[]> {
    setPendingImportableFiles(null);
    const store = attachmentStoreRef.current;
    if (!store) return [];
    return doAttachmentUpload(files, store, isCurrent, overrideFilters);
  }

  /** Core attachment upload logic (extracted from handleFilesSelected).
   *  Answers the files that are handled: stored on this device, or refused
   *  for good on their size. A file that failed for a reason that can pass
   *  (no room yet, a failed read, a failed local store) is left out, so the
   *  share inbox keeps it. */
  async function doAttachmentUpload<T extends UploadSource>(
    fileArr: T[],
    store: AttachmentStore,
    isCurrent?: () => boolean,
    overrideFilters?: { folderId?: string | null; tags?: string[] },
  ): Promise<T[]> {
    const uploadStamp = signInStamp();
    const current = () => !signedOutSince(uploadStamp) && (isCurrent ? isCurrent() : true);
    if (!current()) return [];
    const handled: T[] = [];
    const multi = fileArr.length > 1;
    // Read once, before the first await: the note is written minutes later
    // on a slow batch, and the file belongs to the list the user started
    // from, not to whatever they filtered to while it uploaded.
    const inherited = inheritFilters?.() ?? { tags: [], folderId: null };
    const filters = overrideFilters
      ? {
          folderId: overrideFilters.folderId !== undefined ? overrideFilters.folderId : inherited.folderId,
          tags: overrideFilters.tags !== undefined ? overrideFilters.tags : inherited.tags,
        }
      : inherited;

    // Build initial entries for the modal
    const initial: FileUploadEntry[] = fileArr.map((f) => ({
      name: f.name,
      size: f.size,
      status: 'pending' as const,
    }));
    setUploadEntries([...initial]);

    // For multi-file uploads we collect all body lines and create one
    // note at the end. For single-file uploads we create immediately.
    const bodyLines: string[] = [];
    const bodyNames: string[] = [];
    const serverUploads: Promise<void>[] = [];

    // Quota preflight (backlog #143): one fresh server read for the whole
    // batch. A file that clearly cannot fit is refused BEFORE anything is
    // created - no note, no cached blob, no half-state - and the row says
    // so. The server check stays the authority for races; a best-effort
    // failure here just skips the gate.
    let freeBytes: number | null = null;
    let maxTotalBytes: number | null = null;
    if (!isUnsyncedLocalVault()) {
      try {
        const q = await fetchQuotaUsage(supabase, true);
        freeBytes = Math.max(0, q.maxTotalBytes - q.totalBytes - q.imageBytes);
        maxTotalBytes = q.maxTotalBytes;
      } catch {
        freeBytes = null;
      }
    }
    if (!current()) return [];

    for (let i = 0; i < fileArr.length; i++) {
      if (!current()) return multi ? [] : handled;
      const source = fileArr[i]!;
      // Per-file cap from the fresh server read when we have one - quotaRef
      // is null before the first sync, which validated an add-on holder
      // against the plain Pro limit while the pane hint said otherwise.
      // Checked on the size alone, so a file read later is refused unread.
      const v = validateAttachment(source, proUnlocked(auth.isPro), (maxTotalBytes ?? quotaRef.current?.maxBytes ?? 0) > 500 * 1000 * 1000);
      if (!v.ok) {
        initial[i] = { ...initial[i]!, status: 'failed', error: v.error };
        if (current()) setUploadEntries([...initial]);
        // Refused for good only on a limit that was read: before the first
        // quota answer an add-on holder meets the plain limit.
        if (maxTotalBytes !== null || quotaRef.current !== null) handled.push(source);
        continue;
      }
      const later = !(source instanceof File);
      let file: File;
      try {
        file = later ? await source.read() : source;
      } catch (err) {
        if (!current()) return multi ? [] : handled;
        initial[i] = { ...initial[i]!, status: 'failed', error: err instanceof Error ? err.message : 'Upload failed' };
        setUploadEntries([...initial]);
        continue;
      }
      if (!current()) return multi ? [] : handled;
      // Images obey the two image switches at this door too, and the row
      // then shows the file that is actually stored. A picture the module
      // cannot read is stored as it arrived, the way every non-image is.
      let upload = file;
      if (isSupportedImage(file)) {
        const processed = await processImage(file, currentImageOptions());
        if (!current()) return multi ? [] : handled;
        if (processed.ok) {
          upload = new File([processed.image.data as BlobPart], processed.image.name, { type: processed.image.mime });
          initial[i] = { ...initial[i]!, name: upload.name, size: upload.size };
        }
      }
      if (freeBytes !== null) {
        if (upload.size > freeBytes) {
          initial[i] = { ...initial[i]!, status: 'failed', errorCode: 'storage-full' };
          if (current()) setUploadEntries([...initial]);
          continue;
        }
        // Reserve headroom so a batch cannot collectively overshoot.
        freeBytes -= upload.size;
      }
      initial[i] = { ...initial[i]!, status: 'uploading' };
      if (current()) setUploadEntries([...initial]);

      try {
        if (!current()) return multi ? [] : handled;
        const result = await store.uploadAttachment(upload);
        if (!current()) return multi ? [] : handled;
        const { uuid, meta, uploaded } = result;
        const line = `[${meta.name}|${formatFileSize(meta.size)}|${meta.mime}](pn:file/${uuid})`;

        if (multi) {
          handled.push(source);
          bodyLines.push(line);
          bodyNames.push(meta.name);
          serverUploads.push(uploaded);
          // Keep the row on "uploading" until the SERVER upload settles.
          // Marking done at local-cache time told the user a large batch
          // was complete while megabytes were still streaming - closing
          // the app then stranded blobs this modal had reported as Done.
          const row = i;
          uploaded
            .then(() => {
              if (!current()) return;
              initial[row] = { ...initial[row]!, status: 'done' };
              setUploadEntries([...initial]);
            })
            .catch((uploadErr) => {
              if (!current()) return;
              const uploadMsg = uploadErr instanceof Error ? uploadErr.message : 'Server upload failed';
              const quota = /quota exceeded/i.test(uploadMsg);
              // Quota race lost after the preflight: the blob + note stay
              // local (quotaBlocked) - say that, not just "failed" (#143).
              initial[row] = {
                ...initial[row]!,
                status: 'failed',
                error: uploadMsg,
                ...(quota ? { errorCode: 'storage-full-kept' as const } : {}),
              };
              setUploadEntries([...initial]);
            });
          // A file read later waits for its server upload before the next one
          // is read, so the batch holds one file's bytes at a time.
          if (later) await uploaded.catch(() => {});
          if (!current()) return [];
        } else {
          // Single file - create its own note immediately.
          const note = await createNote(meta.name, line, filters.tags, undefined, 'file', filters.folderId);
          // Saved from here on, whatever the refresh answers, or the next
          // drain of the share inbox saves the file a second time.
          handled.push(source);
          if (!current()) return handled;
          await refresh().catch((err) => console.warn('[upload] list refresh failed:', err));
          if (!current()) return handled;
          void runSync();
          setSelectedId(note.id);
          try {
            await uploaded;
            initial[i] = { ...initial[i]!, status: 'done' };
          } catch (uploadErr) {
            const uploadMsg = uploadErr instanceof Error ? uploadErr.message : 'Server upload failed';
            const quota = /quota exceeded/i.test(uploadMsg);
            initial[i] = {
              ...initial[i]!,
              status: 'failed',
              error: uploadMsg,
              ...(quota ? { errorCode: 'storage-full-kept' as const } : {}),
            };
          }
        }
      } catch (err) {
        if (!current()) return multi ? [] : handled;
        const msg = err instanceof Error ? err.message : 'Upload failed';
        initial[i] = { ...initial[i]!, status: 'failed', error: msg };
      }
      if (current()) setUploadEntries([...initial]);
    }

    // Multi-file: create one note containing all successfully uploaded files.
    if (!current()) return multi ? [] : handled;
    if (multi && bodyLines.length > 0) {
      // One survivor of a batch is a single file and is named like one.
      const title = bodyLines.length === 1
        ? bodyNames[0]!
        : t('importExport:upload.batchTitle', { count: bodyLines.length });
      const body = bodyLines.join('\n');
      const note = await createNote(title, body, filters.tags, undefined, 'file', filters.folderId);
      if (!current()) return handled;
      await refresh().catch((err) => console.warn('[upload] list refresh failed:', err));
      if (!current()) return handled;
      void runSync();
      setSelectedId(note.id);
    }

    // Refresh the storage bar once the bytes have actually been charged.
    // uploadAttachment resolves as soon as the blob is in the local cache;
    // the Storage write and its adjust_blob_bytes call happen in the promise
    // it hands back. Reading the counter before those settle rendered the
    // pre-upload total, so a multi-file drop looked like it consumed nothing.
    void Promise.allSettled(serverUploads).then(() => {
      if (current()) refreshStorage();
    });

    // A file from the share inbox that this upload keeps comes back on every
    // drain until it fits; its row lets the person drop it instead.
    fileArr.forEach((source, i) => {
      if (handled.includes(source) || source instanceof File || !source.discard) return;
      const drop = source.discard;
      initial[i] = {
        ...initial[i]!,
        discard: async () => {
          await drop();
          initial[i] = { ...initial[i]!, discard: undefined, discarded: true };
          setUploadEntries([...initial]);
        },
      };
    });
    setUploadEntries([...initial]);
    return handled;
  }

  return {
    uploadEntries,
    setUploadEntries,
    pendingImportableFiles,
    setPendingImportableFiles,
    filesUploadRef,
    handleFilesUpload,
    handleFilesSelected,
    handleImportFromFiles,
    handleAttachFromFiles,
  };
}
