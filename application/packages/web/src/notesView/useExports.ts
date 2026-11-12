import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { SupabaseClient } from '@notes/shared';
import type { LocalNote } from '../db';
import { recordAdminEvent } from '../adminEvents';
import type { ExportSource } from '../adminEvents';
import i18n from '../i18n';
import { decodeZipBackup, BACKUP_TOO_SMALL } from '@notes/shared';
import type { BulkExportResult, ExportStep, ExportStepName, MissingBlob } from '../export';
import { setExportStep } from '../ExportProgressModal';
import { RESTORE_WAIT_LINE, restoreGateNow } from '../pullState';
import { carriedSettings, remapFolderLooks, settingsAfterRestore } from '../backupRestore';
import type { ImageStore } from '../imageStore';
import type { AttachmentStore } from '../attachmentStore';
import type { UserSettings } from '../userSettings';
import { isChunkLoadError, prefetchChunk } from '../chunkLoad';
import { pictureDataUrl } from '../drawing/pictures';
import { parseScene, toExcalidrawFile } from '../drawing/scene';

const loadExport = () => import('../export');

/** What the export progress window shows. */
export interface ExportProgress {
  status: string;
  done: boolean;
  error?: string;
  /** Where a native save put the file, for Show in folder. */
  savedPath?: string;
  /** The steps of a running bulk export. The one it is on goes to the
   *  window alone (`setExportStep`), never through this state (#683). */
  steps?: readonly ExportStepName[];
}

export function useExports({
  supabase,
  auth,
  userSettings,
  mutateSettings,
  imageStoreRef,
  attachmentStoreRef,
  setExportProgress,
}: {
  supabase: SupabaseClient;
  auth: { encryptionKey: Uint8Array };
  userSettings: UserSettings;
  mutateSettings: (updater: (prev: UserSettings) => UserSettings) => void;
  imageStoreRef: MutableRefObject<ImageStore | null>;
  attachmentStoreRef: MutableRefObject<AttachmentStore | null>;
  setExportProgress: Dispatch<SetStateAction<ExportProgress | null>>;
}) {
  const { t } = useTranslation('notes');
  // The bulk export that has the progress window open. Cancel, the X and
  // Escape abort it and close the window at once; the export stops at its
  // next step and saves nothing.
  const bulkAbortRef = useRef<AbortController | null>(null);
  // export.ts, with the renderer it pulls in, loads on the first export and
  // not at boot. It is fetched a few seconds after sign-in so an export made
  // offline later still works: nothing else caches the chunk. Offline at that
  // moment, it is fetched when the connection is back.
  useEffect(() => {
    const prefetch = () => prefetchChunk(loadExport);
    const id = window.setTimeout(() => {
      if (navigator.onLine) prefetch();
      else window.addEventListener('online', prefetch, { once: true });
    }, 4000);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('online', prefetch);
    };
  }, []);
  // Export wrappers - identical to the raw functions in ./export but
  // they also fire an anonymous admin_events row (`export` + format)
  // so we can see which export paths users actually use. No content,
  // no pubkey, just the format key.
  //
  // Every one of them routes through runExport, which owns the failure UI.
  // Writing the file can throw: the native Save As path reports failures
  // rather than swallowing them (issue #193), and without a shared catch an
  // Android export that saved 0 bytes looks exactly like one that worked,
  // with the user finding out at restore time.
  const runExport = async (format: ExportSource, run: () => Promise<void>) => {
    try {
      await run();
      recordAdminEvent(supabase, 'export', format);
    } catch (err) {
      // Cancelled: the window closed when the reader asked, so stay quiet.
      if ((err as Error | null)?.name === 'AbortError') return;
      // Offline before the chunk was ever fetched: the toast already says so,
      // so a progress window the export opened closes rather than waiting.
      if (!navigator.onLine && isChunkLoadError(err)) {
        setExportProgress(null);
        return;
      }
      setExportProgress({
        status: '',
        done: true,
        error: err instanceof Error && err.message
          ? err.message
          : t('importExport:exportErrors.generic'),
      });
    }
  };
  // A file saved without a picture or a file its notes refer to is kept,
  // because a partial copy beats none, and the progress window says what it
  // lacks: a finished export carries a status only then, and the window
  // never calls it complete. A single note opens the window only for that.
  const reportMissing = (missing: MissingBlob[], describeMissing: (m: MissingBlob[]) => string) => {
    if (missing.length > 0) setExportProgress({ status: describeMissing(missing), done: true });
  };
  const exportSingleMarkdown = (n: LocalNote) =>
    runExport('md', async () => {
      const ex = await loadExport();
      reportMissing(
        await ex.exportSingleMarkdown(n, imageStoreRef.current, userSettings.folders, attachmentStoreRef.current),
        ex.describeMissing,
      );
    });
  const exportSingleHtml = (n: LocalNote) =>
    runExport('html', async () => {
      const ex = await loadExport();
      reportMissing(
        await ex.exportSingleHtml(n, imageStoreRef.current, userSettings.folders, attachmentStoreRef.current),
        ex.describeMissing,
      );
    });
  // A drawing leaves as a .excalidraw file or a PNG, with its pictures.
  // Spec: docs/internal/specs/drawing.md (section 7, Export)
  const exportDrawing = (n: LocalNote, format: 'excalidraw' | 'png') =>
    runExport('drawing', async () => {
      const scene = parseScene(n.body);
      if (!scene) throw new Error(t('importExport:exportErrors.generic'));
      const urls = new Map<string, string>();
      for (const [id, file] of Object.entries(scene.files)) {
        const url = await pictureDataUrl(file.src);
        if (url) urls.set(id, url);
      }
      const { saveDrawing } = await import('../drawing/exportDrawing');
      await saveDrawing(n.title, toExcalidrawFile(scene, urls), format);
    });
  // Every bulk zip opens the progress window and reports its steps. The
  // window owns all the wording, "Preparing..." included, in every language.
  const runBulkExport = async (
    format: ExportSource,
    steps: (ex: typeof import('../export')) => readonly ExportStepName[],
    run: (signal: AbortSignal, onProgress: (at: ExportStep) => void) => Promise<BulkExportResult>,
  ) => {
    bulkAbortRef.current?.abort();
    const controller = new AbortController();
    bulkAbortRef.current = controller;
    const { signal } = controller;
    setExportStep(undefined);
    setExportProgress({ status: '', done: false });
    await runExport(format, async () => {
      const ex = await loadExport();
      signal.throwIfAborted();
      setExportProgress({ status: '', done: false, steps: steps(ex) });
      const { missing, savedPath } = await run(signal, setExportStep);
      setExportProgress({ status: ex.describeMissing(missing), done: true, savedPath });
    });
    if (bulkAbortRef.current === controller) bulkAbortRef.current = null;
  };
  /** Closes the progress window; a running bulk export stops with it. */
  const closeExportProgress = () => {
    bulkAbortRef.current?.abort();
    bulkAbortRef.current = null;
    setExportProgress(null);
  };
  // A picked set passes `privacynotes-selection`, so its file never reads
  // as a full backup (#682).
  const exportAllMarkdownZip = (ns: LocalNote[], fileStem?: string) =>
    runBulkExport('md-zip', (ex) => ex.FULL_BACKUP_STEPS, async (signal, onProgress) =>
      (await loadExport()).exportAllMarkdownZip(ns, imageStoreRef.current, attachmentStoreRef.current, onProgress, userSettings.folders, carriedSettings(userSettings), signal, fileStem));
  const exportNotesMarkdownZip = (ns: LocalNote[]) =>
    runBulkExport('md-zip', (ex) => ex.FULL_BACKUP_STEPS, async (signal, onProgress) =>
      (await loadExport()).exportNotesMarkdownZip(ns, imageStoreRef.current, attachmentStoreRef.current, onProgress, userSettings.folders, signal));
  const exportEncryptedFullBackup = (ns: LocalNote[]) =>
    runBulkExport('encrypted-zip', (ex) => ex.FULL_BACKUP_STEPS, async (signal, onProgress) =>
      (await loadExport()).exportEncryptedFullBackup(ns, imageStoreRef.current, attachmentStoreRef.current, auth.encryptionKey, onProgress, userSettings.folders, carriedSettings(userSettings), signal));
  /** Decrypt a picked .pnbackupz into the plain full-backup zip. The
   *  modal then runs it through the NORMAL zip restore flow - preview,
   *  quota preflight and blob restore all reuse. Errors arrive already
   *  translated, the decryptBackup precedent (issue #193). */
  const decryptFullBackup = async (file: File): Promise<File> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const zip = decodeZipBackup(bytes, auth.encryptionKey);
      return new File([zip as BlobPart], 'backup.zip', { type: 'application/zip' });
    } catch (err) {
      if (err instanceof Error && err.name === BACKUP_TOO_SMALL) {
        throw new Error(i18n.t('importExport:decryptErrors.tooSmall', { size: bytes.length }));
      }
      throw new Error(i18n.t('importExport:decryptErrors.notThisAccount'));
    }
  };
  const exportAllHtmlZip = (ns: LocalNote[], fileStem?: string) =>
    runBulkExport('html-zip', (ex) => ex.HTML_ARCHIVE_STEPS, async (signal, onProgress) =>
      (await loadExport()).exportAllHtmlZip(ns, imageStoreRef.current, userSettings.folders, onProgress, attachmentStoreRef.current, signal, fileStem));
  const exportAllJson = (ns: LocalNote[]) =>
    runExport('json', async () => (await loadExport()).exportAllJson(ns, userSettings.folders, userSettings.itemStyles, userSettings.customThemes, userSettings.factors, userSettings.customHabits));
  const exportEncryptedBackup = (ns: LocalNote[]) =>
    runExport('encrypted', async () =>
      (await loadExport()).exportEncryptedBackup(ns, auth.encryptionKey, userSettings.folders, userSettings.itemStyles, userSettings.customThemes, userSettings.factors, userSettings.customHabits));
  const exportVault = (ns: LocalNote[]) =>
    runExport('vault', async () => (await loadExport()).exportVaultBitwarden(ns, userSettings.folders));
  const exportBookmarks = (ns: LocalNote[]) =>
    runExport('bookmarks', async () => (await loadExport()).exportBookmarksHtml(ns, userSettings.folders));
  const exportContacts = (ns: LocalNote[]) =>
    runExport('contacts', async () => (await loadExport()).exportContactsVcf(ns));
  const exportCalendar = (ns: LocalNote[]) =>
    runExport('calendar', async () => (await loadExport()).exportCalendarIcs(ns));
  // Every drawing as a .excalidraw file in one .zip, through the bulk
  // window: pictures are read one by one, and a missing one is reported.
  const exportDrawings = (ns: LocalNote[]) =>
    runBulkExport('drawing', (ex) => ex.DRAWINGS_STEPS, async (signal, onProgress) =>
      (await loadExport()).exportDrawingsZip(ns, imageStoreRef.current, onProgress, signal));
  const printNote = (n: LocalNote, titleOnly = false) =>
    runExport('pdf', async () =>
      (await loadExport()).printNote(n, imageStoreRef.current, userSettings.folders, attachmentStoreRef.current, titleOnly));
  const importEncryptedBackup = async (file: File): Promise<{ imported: number; updated: number; unchanged: number }> => {
    // The restore matches the backup's notes by id against this device's
    // copy, so it waits for this device's first clean pull (pullState.ts).
    const gate = restoreGateNow();
    if (gate !== 'open') throw new Error(i18n.t(RESTORE_WAIT_LINE[gate]));
    const buf = new Uint8Array(await file.arrayBuffer());
    const backup = (await loadExport()).decryptBackup(buf, auth.encryptionKey);
    recordAdminEvent(supabase, 'import', 'encrypted');
    // v3 backups carry the folder definitions, their looks and the custom
    // themes; merged before the notes so the restored notes' folderId
    // pointers resolve to a real tree (backupRestore.ts).
    mutateSettings((prev) => settingsAfterRestore(prev, backup));
    const { applyImport } = await import('../import/apply');
    const parsed = {
      notes: backup.notes.map((n) => ({
        // The note's own id, which is what turns this from a second copy of
        // the vault into a repair of it. Backups written before ids were
        // carried have none, and those still come in as new notes.
        ...(typeof n.id === 'string' && n.id ? { id: n.id } : {}),
        title: n.title,
        body: n.body,
        tags: n.tags,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        ...(typeof n.editedAt === 'string' ? { editedAt: n.editedAt } : {}),
        starred: n.starred === 1,
        trashed: n.trashed === 1,
        type: n.type,
        locked: n.locked === 1,
        pinProtected: n.pinProtected === 1,
        trackers: n.trackers,
        folderId: n.folderId ?? null,
        archived: n.archived === 1,
      })),
      warnings: [],
      transforms: [],
      stats: { totalNotes: backup.notes.length, emptyNotes: 0, untaggedNotes: 0, uniqueTags: 0 },
      source: 'markdown-folder' as const,
    };
    const result = await applyImport(parsed);
    if (result.errors.length > 0) throw new Error(result.errors.join('\n'));
    return {
      imported: result.imported,
      updated: result.updated ?? 0,
      unchanged: result.unchanged ?? 0,
    };
  };

  /** The looks and custom themes a full backup zip carries, merged as the
   *  .pnbackup restore merges them, with each folder look moved to the id its
   *  folder came back under. */
  const mergeRestoredSettings = (
    settings: { itemStyles?: unknown; customThemes?: unknown; factors?: unknown; customHabits?: unknown; medications?: unknown; customTrackers?: unknown; favoriteTags?: unknown; calendarFeeds?: unknown; dashboard?: unknown; agentFolder?: unknown; trackerSetup?: unknown },
    savedToFinal: ReadonlyMap<string, string>,
  ) =>
    mutateSettings((prev) =>
      settingsAfterRestore(prev, {
        itemStyles: remapFolderLooks(settings.itemStyles, savedToFinal),
        customThemes: settings.customThemes,
        factors: settings.factors,
        customHabits: settings.customHabits,
        medications: settings.medications,
        customTrackers: settings.customTrackers,
        favoriteTags: settings.favoriteTags,
        calendarFeeds: settings.calendarFeeds,
        dashboard: settings.dashboard,
        // The folder came back under a new id when the vault had lost it.
        agentFolder: typeof settings.agentFolder === 'string' ? savedToFinal.get(settings.agentFolder) ?? settings.agentFolder : undefined,
        trackerSetup: settings.trackerSetup,
      }),
    );
  return {
    mergeRestoredSettings,
    exportSingleMarkdown,
    exportSingleHtml,
    exportDrawing,
    exportAllMarkdownZip,
    exportNotesMarkdownZip,
    exportAllHtmlZip,
    closeExportProgress,
    exportAllJson,
    exportEncryptedBackup,
    exportVault,
    exportBookmarks,
    exportContacts,
    exportCalendar,
    exportDrawings,
    printNote,
    importEncryptedBackup,
    exportEncryptedFullBackup,
    decryptFullBackup,
  };
}
