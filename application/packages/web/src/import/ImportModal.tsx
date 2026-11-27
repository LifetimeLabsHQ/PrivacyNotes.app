import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { isOversizeImport } from '../noteSplit';
import { NO_TEXT_ASSIST } from '../formFields';
import i18n from '../i18n';
import {
  IMPORTERS,
  buildPickerGroups,
  filterPickerCards,
  importerIdToSource,
  sourceLabel,
  type PickerCard,
  type PickerCardKey,
  type PickerSectionKey,
} from './registry';
import {
  createSupabaseQuotaPort,
  prepareImportPreview,
  type PhotoEstimate,
  type QuotaCheck,
} from './importPreflight';
import { runImport } from './importRun';
import { withFolderPathTags } from './folderImport';
import { withBrowserTags } from './browserBookmarks';
import type { ImporterEntry, ParsedImport, ImportedNote, RestoreCounts } from './types';
import { useAuth } from '../auth';
import { recordAdminEvent } from '../adminEvents';
import type { LocalNote } from '../db';
import { BackupWrongKeyError, missingItemsLabel } from '../export';
import { extractPhraseFromScan } from '../qrSignIn';
import { QrScannerModal } from '../QrScannerModal';
import type { FolderDef } from '../folders';
import { destinationGroups, existingImportFolder, type ImportDestination, type ImportTarget } from './destination';
import { Archive, ArrowCounterClockwise, ClockCounterClockwise, Heartbeat, BookmarkSimple, BookOpenText, BracketsCurly, CalendarDots, CalendarPlus, FileArrowDown, FileArrowUp, FileHtml, FileText, FileZip, Globe, Key, Lock, LockOpen, Note, Scan, Upload, AddressBook, NEW_GLYPHS, EXPORT_GLYPHS, PILLAR_GLYPHS } from '../icons';
import { goesToCalendarFile } from '../schedule';
import { proUnlocked } from '../demo';
import { backupSettingsNames } from '../backupRestore';
import { listOf } from '../scheduleText';
import { RESTORE_WAIT_LINE, restoreGateNow, useRestoreGate, type RestoreGate } from '../pullState';
import { formatBytes } from '../formatBytes';
import { useEscapeToClose } from '../useEscapeToClose';
import { SETTINGS_BTN, SETTINGS_HELP, SectionEyebrow, SettingsTabStrip, StatTile, settingsTabClass, ROW_TITLE, SETTINGS_CARD as CARD, SETTINGS_CARD_GRID as CARD_GRID, SETTINGS_CARD_REST as CARD_REST, SettingsCardIcon as RowIcon } from '../settingsUI';
import { Button, Callout, Checkbox, IconUpgrade, ListSearchInput, Modal, ModalFooter, PhraseInput, Select, Spinner, TextField } from '../ui';
import { calendarFeedUrl, downloadCalendarFeed } from './calendarFeed';
import { ClipError } from '../clipDownload';
import { sessionTokenOf } from '../sessionToken';
import { FEED_ERROR, SubscribedFeeds, useFeedSubscribe, type FeedsControl } from '../calendarFeedUI';
import { activeLocale } from '../languages';
import { helpPath } from '../localeRoutes';
import { siteHref } from '../siteLinks';
import { HelpChip } from '../HelpChip';
import { ImportFileError } from './zipEntry';
import { holdLockReload } from '../lockReload';
import { WellnessExportTab } from '../stats/WellnessExport';
import { usePaneTab } from '../settingsPaneTab';
import { AutomaticCallout, AutomaticPane } from '../autoBackup/AutomaticPane';

/**
 * The `accept` list to hand the file picker, widened on Android.
 *
 * Android picks files by MIME type, and Chrome builds that list by running
 * every extension in `accept` through Android's own extension->MIME table,
 * silently dropping the ones it does not know. `.enex` is not in that table,
 * `.zip` is, so an Evernote importer asking for `.enex,.zip` ends up asking
 * for zips only - and the .enex the user came to import sits greyed out and
 * unselectable next to it. Same for `.pnbackup` and `.nnbackupz`. Reported by
 * a tester on a Pixel 3a, where the export could not be picked at all.
 *
 * There is no way to read that table from here, and it grows with every
 * Android release, so guessing which of our extensions are in it would fail
 * silently and identically. Android therefore gets no filter: an accept list
 * is a convenience everywhere else and a wall here, and every importer
 * already rejects the wrong file with a message naming the right one.
 *
 * iOS is unaffected - WebKit maps an unknown extension to a dynamic UTI that
 * the file itself resolves to as well, so the two still match.
 */
// Spec: docs/contrib/gotchas.md (Android file picker drops accept extensions it cannot map to a MIME type)
function pickerAccept(accept: string): string {
  return /android/i.test(navigator.userAgent) ? '*/*' : accept;
}

/** Every tab of the window; each Settings page shows its own subset. */
export type ImportTab = 'import' | 'export' | 'wellness' | 'manual' | 'automatic' | 'restore';
const TRANSFER_TABS: readonly ImportTab[] = ['import', 'export', 'wellness'];
const BACKUP_TABS: readonly ImportTab[] = ['manual', 'automatic', 'restore'];

/**
 * Import / Export modal - tabbed shell.
 *
 * Import tab - three-phase flow:
 *   1. pick   → choose which importer to run
 *   2. parse  → user picks a file; we read, parse, show preview + warnings
 *   3. apply  → user confirms; we write to Dexie, close, parent triggers sync
 *
 * Export tab - the portable whole-set exports (.zip of md, .zip of html,
 * .json), plus the bookmarks-only and vault-only writers when there is
 * something for them to write. The full backups (.pnbackupz, .pnbackup,
 * .zip) are the Manual tab of the Backup page. Callbacks come from
 * the parent so the telemetry wrapper stays in one place.
 *
 * The parent wires an `onImported` callback that refreshes the notes
 * list and kicks off a sync. No server writes happen inside this modal -
 * all encryption / upload goes through the normal sync pass.
 */
export function ImportModal({
  onClose,
  onImported,
  section = 'transfer',
  initialTab,
  initialRestoreFile,
  notes,
  onExportAllMdZip,
  onExportAllHtmlZip,
  onExportAllJson,
  onExportEncrypted,
  onExportVault,
  onExportBookmarks,
  onExportContacts,
  onExportCalendar,
  onExportDrawings,
  onExportNotesMdZip,
  onImportEncrypted,
  onExportEncryptedZip,
  decryptFullBackup,
  onBlobsRestored,
  onImportFolders,
  onImportSettings,
  onImportTagColors,
  importTarget,
  onCreateImportFolder,
  onUndoImportFolders,
  embedded = false,
  wellness,
  calendarFeeds,
}: {
  onClose: () => void;
  onImported: (count: number, skippedDuplicates?: number, repaired?: RestoreCounts) => void;
  /** Render inline as a settings pane (no overlay, no own header/escape). */
  embedded?: boolean;
  /** The tracker data for the Wellness tab; without it the tab is not shown. */
  wellness?: Omit<ComponentProps<typeof WellnessExportTab>, 'notes' | 'Row'>;
  /** Which Settings page this is: Transfer (Import, Export, Trackers) or
   *  Backup (Manual, Automatic, Restore). */
  section?: 'transfer' | 'backup';
  initialTab?: ImportTab;
  /** A full backup .zip handed in from another surface (e.g. Files upload):
   *  runs directly through the normal Backup > Restore parse and preview flow. */
  initialRestoreFile?: File;
  notes: LocalNote[];
  onExportAllMdZip: (ns: LocalNote[]) => void;
  onExportAllHtmlZip: (ns: LocalNote[]) => void;
  onExportAllJson: (ns: LocalNote[]) => void;
  onExportEncrypted: (ns: LocalNote[]) => void;
  onExportVault: (ns: LocalNote[]) => void;
  onExportBookmarks: (ns: LocalNote[]) => void;
  onExportContacts: (ns: LocalNote[]) => void;
  onExportCalendar: (ns: LocalNote[]) => void;
  /** Every drawing as a .excalidraw file in one .zip; the card shows only
   *  when this is wired (behind the export-all PIN gate). */
  onExportDrawings?: (ns: LocalNote[]) => void;
  /** Only the notes, as Markdown files in one .zip (#682). */
  onExportNotesMdZip: (ns: LocalNote[]) => void;
  onImportEncrypted: (file: File, foreignPhrase?: string) => Promise<RestoreCounts & { imported: number }>;
  onExportEncryptedZip: (ns: LocalNote[]) => void;
  /** Decrypts a .pnbackupz into the plain full-backup zip; the modal
   *  then runs the normal zip restore flow on the result. */
  decryptFullBackup: (file: File, foreignPhrase?: string) => Promise<File>;
  /** Called after restoreBlobs writes images/attachments to IndexedDB.
   *  Parent should re-trigger processPendingUploads so blobs reach Supabase. */
  onBlobsRestored?: () => void;
  /** Merge folders rebuilt by an importer (Obsidian) into the settings
   *  folder tree, reusing any existing folder whose path already matches,
   *  or, for our own backup, the one still live under its saved id
   *  (`ParsedImport.originalFolderIds`). Returns imported-id -> final-id so
   *  we can remap each note's folderId before writing. */
  onImportFolders?: (
    folders: FolderDef[],
    originalIds?: ReadonlyMap<string, string>,
    rootParent?: string | null,
  ) => { idMap: Map<string, string>; created: string[] } | void;
  /** Take back the folders a failed import made (the ids `onImportFolders`
   *  and `onCreateImportFolder` reported as created). */
  onUndoImportFolders?: (ids: readonly string[]) => void;
  /** The folders the "Add to" row offers. Absent while folders are locked,
   *  and then the row does not show. */
  importTarget?: ImportTarget;
  /** Makes (or finds) the "Add to" row's new folder; returns its id, and
   *  whether it was made just now. */
  onCreateImportFolder?: (name: string) => { id: string; created: boolean } | null;
  /** Give imported tags their colors (Google Keep's note colors): tag ->
   *  color key. The parent colors only a tag that has no color yet. */
  onImportTagColors?: (colors: Map<string, string>) => void;
  /** Our own full backup: merge the settings it carries, with each folder look
   *  and folder reference remapped from its saved folder id to the final one. */
  onImportSettings?: (
    settings: NonNullable<ParsedImport['settings']>,
    savedToFinal: ReadonlyMap<string, string>,
  ) => void;
  /** The subscribed calendars and their one writer, for the Webcal panel (#619). */
  calendarFeeds?: FeedsControl;
}) {
  const { t } = useTranslation('importExport');
  const { auth, supabase } = useAuth();
  const isPro = auth.status === 'authenticated' ? auth.isPro : false;
  type Phase =
    | { kind: 'pick' }
    | { kind: 'parsing'; importer: ImporterEntry; status: string }
    | { kind: 'foreignPhrase'; importer: ImporterEntry; file: File; format: 'pnbackupz' | 'pnbackup' }
    | { kind: 'preview'; importer: ImporterEntry; parsed: ParsedImport; file: { name: string; size: number } }
    | { kind: 'applying'; importer: ImporterEntry }
    | { kind: 'error'; importer: ImporterEntry; message: string; detail?: string };

  const backup = section === 'backup';
  const tabs = backup ? BACKUP_TABS : TRANSFER_TABS;
  const [tab, setTab] = usePaneTab<ImportTab>(
    backup ? 'backup' : 'importExport',
    initialTab && tabs.includes(initialTab) ? initialTab : tabs[0] ?? 'import',
  );
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const restoreGate = useRestoreGate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Keep the raw file around so restoreBlobs can re-read it after applyImport. */
  const selectedFileRef = useRef<File | null>(null);
  const startedInitialRestore = useRef(false);
  const [activeImporter, setActiveImporter] = useState<ImporterEntry | null>(null);
  const [autoTag, setAutoTag] = useState(true);
  // With Work open, an import goes into a new Work folder: an unfiled item is
  // always in Personal, so otherwise it would seem to vanish.
  // Spec: docs/internal/issues/0471.md
  const [destination, setDestination] = useState<ImportDestination>(
    importTarget?.openSpace === 'work' ? 'new' : 'none',
  );
  /** Obsidian only: also add each folder name as a tag. Folders are
   *  rebuilt regardless; this is extra tag-based navigation. Defaults on
   *  for free (folder actions are locked for them) and off for Pro. */
  const [folderTags, setFolderTags] = useState(!proUnlocked(isPro));
  // Firefox tags and address-bar keywords. On by default: they are the
  // user's own labels, and dropping data silently is the worse default.
  const [browserTags, setBrowserTags] = useState(true);
  // Notes too large to sync are cut at their headings unless the person
  // unticks it in the preview. Spec: docs/internal/specs/note-size-limit.md
  const [splitOversize, setSplitOversize] = useState(true);
  const oversizeCount = useMemo(
    () => (phase.kind === 'preview' ? phase.parsed.notes.filter(isOversizeImport).length : 0),
    [phase],
  );
  /** Contacts: whether the address book's photos come along. On by
   *  default, forced off when the estimate does not fit the quota. */
  const [importPhotos, setImportPhotos] = useState(true);
  const [photoEstimate, setPhotoEstimate] = useState<PhotoEstimate | null>(null);
  /** Quota preflight result. null = not checked yet (e.g. RPC failed,
   *  unauthenticated). Surfaces a warning + blocks the Import button
   *  when the estimated ciphertext exceeds available capacity. */
  const [quotaCheck, setQuotaCheck] = useState<QuotaCheck | null>(null);

  function handlePickImporter(importer: ImporterEntry) {
    if (!importer.enabled) return;
    setActiveImporter(importer);
    // Defer clicking until the input exists - React hasn't rendered the
    // hidden input yet on first click. One tick later is enough.
    requestAnimationFrame(() => fileInputRef.current?.click());
  }

  async function handleFileSelected(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again still fires change.
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file || !activeImporter) return;
    await runParseFlow(activeImporter, file);
  }

  async function handleImportEncryptedFile(file: File) {
    // A .pnbackupz is the full-backup zip sealed under
    // the phrase key: decrypt, then run the NORMAL zip
    // restore flow, preview and blob restore included.
    // A wrong-key failure opens the inline foreign-phrase
    // prompt so backups from another device or local-only
    // vault can be unlocked without switching accounts.
    if (file.name.toLowerCase().endsWith('.pnbackupz')) {
      const imp = IMPORTERS.find((i) => i.restore);
      if (!imp) return;
      setPhase({ kind: 'parsing', importer: imp, status: t('status.decryptingBackup') });
      try {
        const zipFile = await decryptFullBackup(file);
        await runParseFlow(imp, zipFile);
      } catch (err) {
        if (err instanceof BackupWrongKeyError) {
          setPhase({ kind: 'foreignPhrase', importer: imp, file, format: 'pnbackupz' });
          return;
        }
        setPhase({
          kind: 'error',
          importer: imp,
          message: err instanceof Error ? err.message : t('errors.decryptionFailed'),
        });
      }
      return;
    }
    const imp = encryptedBackupImporter();
    setPhase({ kind: 'parsing', importer: imp, status: t('status.decryptingBackup') });
    const releaseLockReload = holdLockReload();
    try {
      const counts = await onImportEncrypted(file);
      onImported(counts.imported, undefined, { updated: counts.updated, unchanged: counts.unchanged });
      onClose();
    } catch (err) {
      if (err instanceof BackupWrongKeyError) {
        setPhase({ kind: 'foreignPhrase', importer: imp, file, format: 'pnbackup' });
        return;
      }
      setPhase({
        kind: 'error',
        importer: imp,
        message: err instanceof Error ? err.message : t('errors.decryptionFailed'),
      });
    } finally {
      releaseLockReload();
    }
  }

  useEffect(() => {
    if (!initialRestoreFile || startedInitialRestore.current) return;
    // Wait on the calm RestorePickPhase callout until sync opens the gate,
    // then start automatically without dropping the handed-in file.
    if (restoreGate !== 'open') return;
    startedInitialRestore.current = true;
    const lower = initialRestoreFile.name.toLowerCase();
    if (lower.endsWith('.pnbackup') || lower.endsWith('.pnbackupz')) {
      void handleImportEncryptedFile(initialRestoreFile);
      return;
    }
    const imp = IMPORTERS.find((i) => i.restore);
    if (!imp) return;
    void runParseFlow(imp, initialRestoreFile);
    // Intentionally fires once for the initial file handed in on mount once the restore gate opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRestoreFile, restoreGate]);

  /** Parse one file through one importer: progress, quota preflight,
   *  oversize warnings, preview. The picker enters here with the chosen
   *  file; the .pnbackupz restore enters with the DECRYPTED zip, so the
   *  sealed backup reuses the whole flow, blob restore included. */
  async function runParseFlow(importer: ImporterEntry, file: File) {
    selectedFileRef.current = file;

    setPhase({
      kind: 'parsing',
      importer,
      status: t('status.readingFile'),
    });

    try {
      const prepared = await prepareImportPreview({
        importer,
        file,
        quota: createSupabaseQuotaPort(supabase, isPro),
        isPro,
        onProgress: (msg) =>
          setPhase((prev) =>
            prev.kind === 'parsing' ? { ...prev, status: msg } : prev,
          ),
      });
      setPhotoEstimate(prepared.photoEstimate);
      setImportPhotos(prepared.importPhotos);
      setQuotaCheck(prepared.quotaCheck);
      setPhase({
        kind: 'preview',
        importer,
        file: { name: file.name, size: file.size },
        parsed: prepared.parsed,
      });
    } catch (err) {
      setPhase({ kind: 'error', importer, ...importFailure(err, importer, file.size, t) });
    }
  }

  /** The "Add to" folder; a new one it makes goes into `made`. */
  function resolveDestination(importer: ImporterEntry, made: string[]): string | null {
    if (!importTarget || destination === 'none') return null;
    if (destination === 'new') {
      const folder = onCreateImportFolder?.(sourceLabel(importer, t)) ?? null;
      if (folder?.created) made.push(folder.id);
      return folder?.id ?? null;
    }
    return importTarget.folders.some((f) => f.id === destination.folderId) ? destination.folderId : null;
  }

  /** The .pnbackup restore runs in the parent (`onImportEncrypted`); this
   *  stands in for an importer on its progress and error screens, which
   *  name it as our backup. */
  function encryptedBackupImporter(): ImporterEntry {
    return {
      id: 'privacynotes', label: t('encryptedBackupLabel'), description: '', accept: '.pnbackup', enabled: true, sourceTag: '',
      parse: async () => { throw new Error(); },
      group: null, icon: null, labelKey: 'sourceLabel.privacynotes', descKey: null, fileTypes: '', guide: null, restore: true,
    };
  }

  async function handleConfirm() {
    if (phase.kind !== 'preview') return;
    const { importer, parsed } = phase;
    // Our own backups match their notes by id against this device's copy, so
    // they wait for its first clean pull, before the folder merge below or
    // any other write (pullState.ts).
    if (importer.restore) {
      const gate = restoreGateNow();
      if (gate !== 'open') {
        setPhase({ kind: 'error', importer, message: t(RESTORE_WAIT_LINE[gate]) });
        return;
      }
    }
    setPhase({ kind: 'applying', importer });
    // The "Add to" folder this import made: the run takes it back with its
    // own folders if the notes do not land (backlog 217). A throw anywhere
    // ends on the error screen, never on "applying".
    const madeFolders: string[] = [];
    let notesWritten = false;
    const showFailure = (err: unknown) => {
      console.warn('Import failed:', err);
      const { message, detail } = importFailure(err, importer, selectedFileRef.current?.size, t);
      setPhase({
        kind: 'error',
        importer,
        message: notesWritten ? message : t('errors.importNothingChanged', { detail: message }),
        detail,
      });
    };
    // The import runs on behind the lock: the lock reloads the page only when it ends (lockReload.ts).
    const releaseLockReload = holdLockReload();
    try {
      // A restore keeps the backup's own folders, so the row is for other apps.
      const restore = importer.restore === true;
      const target = restore ? null : resolveDestination(importer, madeFolders);
      // Every step of the import, in its one order (importRun.ts). A restore
      // puts notes back as the backup holds them, and its preview counts no
      // folder tags, so a backup takes none.
      const run = await runImport(parsed, {
        target,
        targetMade: madeFolders.length > 0,
        folderTags: !restore && folderTags,
        browserTags,
        splitOversize,
        dropContactPhotos: !!photoEstimate && (!importPhotos || !photoEstimate.fits),
        sourceTag: autoTag && importer.sourceTag ? importer.sourceTag : undefined,
      }, {
        mergeFolders: onImportFolders,
        undoFolders: onUndoImportFolders,
        applySettings: onImportSettings,
        applyTagColors: onImportTagColors,
        blobsStored: onBlobsRestored,
        media: {
          start: () => setPhase({ kind: 'parsing', importer, status: t('status.importingBlobs') }),
          progress: (msg) => setPhase((prev) => (prev.kind === 'parsing' ? { ...prev, status: msg } : prev)),
          end: () => setPhase({ kind: 'applying', importer }),
        },
      });
      if (run.kind === 'refused') {
        setPhase({
          kind: 'error',
          importer,
          message: t('errors.importNothingChanged', { detail: run.errors.join('\n') }),
        });
        return;
      }
      if (run.kind === 'failed') {
        // The run took back what it made; only the words are left.
        notesWritten = run.written;
        showFailure(run.error);
        return;
      }
      const { result } = run;
      notesWritten = true;
      // A media failure must never sink into a console.warn: that makes the
      // worst outcome the quietest one, where the notes land, every image
      // reference stays an un-rewritten placeholder token, and the modal
      // closes on a success toast with nothing on screen saying the pictures
      // are gone. The run records the reason, and the modal stays open on it -
      // the notes land either way, so this is reported ON TOP of a real
      // import, never instead of one.
      let mediaError = run.mediaError;
      // A backup that lists a picture or a file and does not carry it is
      // reported the same way.
      let missingMessage: string | null = null;

      // For PrivacyNotes full backups, restore images + attachments from
      // the zip (uses manifest-based restoration, not parsed.blobs).
      if (importer.restore && selectedFileRef.current) {
        setPhase({
          kind: 'parsing',
          importer,
          status: t('status.restoringBlobs'),
        });
        try {
          const { restoreBlobs } = await import('./privacynotes');
          const restored = await restoreBlobs(
            selectedFileRef.current,
            (msg) => setPhase((prev) => (prev.kind === 'parsing' ? { ...prev, status: msg } : prev)),
            auth.status === 'authenticated' ? { supabase, pubkey: auth.pubkey } : undefined,
          );
          // Re-trigger pending uploads so restored blobs reach Supabase.
          // Without this, blobs sit in local cache but never get uploaded,
          // making them unavailable on other devices.
          onBlobsRestored?.();
          if (restored.missing.length > 0) {
            missingMessage = t('errors.blobsNotInBackup', {
              count: restored.missing.length,
              items: missingItemsLabel(restored.missing),
            });
          }
        } catch (err) {
          // Notes are already imported, so this never rolls anything back -
          // but a backup that restored its notes and lost its images is not
          // a restore, and the user has to be told.
          console.warn('Blob restore failed:', err);
          mediaError ??= err instanceof Error ? err.message : String(err);
        }
      }

      // Fire anonymous import telemetry. No user identifier, no content -
      // just `{type: 'import', source: 'google-keep' | 'standard-notes'}`
      // so we can see which import paths are actually getting exercised.
      // Swallows its own errors; never blocks the happy path.
      const source = importerIdToSource(importer.id);
      if (source) {
        recordAdminEvent(supabase, 'import', source);
      }

      // The notes exist locally whatever happened to the media, so the
      // parent hears about them first: the list has to refresh and the sync
      // has to run even when the error phase below keeps the modal open.
      onImported(result.imported, result.skippedDuplicates, { updated: result.updated ?? 0, unchanged: result.unchanged ?? 0 });
      const message = mediaError
        ? t('errors.blobImportFailed', { detail: mediaError })
        : missingMessage;
      if (message) {
        setPhase({ kind: 'error', importer, message });
        return;
      }
      onClose();
    } catch (err) {
      if (!notesWritten) onUndoImportFolders?.(madeFolders);
      showFailure(err);
    } finally {
      releaseLockReload();
    }
  }

  function handleBackToPick() {
    setActiveImporter(null);
    selectedFileRef.current = null;
    setQuotaCheck(null);
    setPhase({ kind: 'pick' });
  }

  return (
    <Modal
      embedded={embedded}
      embeddedClassName="flex-1 min-h-0 flex flex-col text-pn"
      onClose={onClose}
      title={tab === 'import' ? t('shell.importTitle') : tab === 'export' || tab === 'wellness' ? t('shell.exportTitle') : tab === 'restore' ? t('shell.restoreTitle') : t('shell.backupTitle')}
      header="bar"
      // The width of a one-page Settings window, which the source tiles were
      // laid out for: at max-w-lg they squeezed into a narrow column.
      className="max-w-2xl max-h-[85vh] flex flex-col"
    >
        <SettingsTabStrip
          role="tablist"
          aria-label={backup ? t('shell.backupTablistLabel') : t('shell.tablistLabel')}
          className="shrink-0 px-4 sm:px-6"
        >
          {([
            { id: 'import' as const, setting: 'import.import', label: t('shell.tabImport'), icon: <FileArrowDown aria-hidden="true" /> },
            { id: 'export' as const, setting: 'import.export', label: t('shell.tabExport'), icon: <FileArrowUp aria-hidden="true" /> },
            { id: 'manual' as const, setting: 'backup.manual', label: t('shell.tabManual'), icon: <Archive aria-hidden="true" /> },
            { id: 'automatic' as const, setting: 'import.automatic', label: t('shell.tabAutomatic'), icon: <ClockCounterClockwise aria-hidden="true" /> },
            { id: 'restore' as const, setting: 'import.restore', label: t('shell.tabRestore'), icon: <ArrowCounterClockwise aria-hidden="true" /> },
            // Shown when the pane has the tracker data to export.
            ...(wellness ? [{ id: 'wellness' as const, setting: 'import.wellness', label: t('notes:settings.trackersLabel'), icon: <Heartbeat aria-hidden="true" /> }] : []),
          ]).filter((tb) => tabs.includes(tb.id)).map((tb) => (
            <button
              key={tb.id}
              data-setting={tb.setting}
              role="tab"
              aria-selected={tab === tb.id}
              onClick={() => setTab(tb.id)}
              className={settingsTabClass(tab === tb.id)}
            >
              {tb.icon}
              <span>{tb.label}</span>
            </button>
          ))}
        </SettingsTabStrip>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {tab === 'import' ? (
            <>
              {phase.kind === 'pick' && (
                  <ImportPickPhase
                    onPick={handlePickImporter}
                    calendarFeeds={calendarFeeds}
                    onCalendarFeed={(file) => {
                      const calendar = IMPORTERS.find((i) => i.id === 'google-calendar');
                      // The Google Calendar importer reads any .ics; the
                      // preview names the source as the person chose it.
                      if (calendar) void runParseFlow({ ...calendar, label: t('webcal.title') }, file);
                    }}
                  />
              )}

              {phase.kind === 'parsing' && (
                <ParsingPhase
                  importerLabel={sourceLabel(phase.importer, t)}
                  status={phase.status}
                />
              )}

              {phase.kind === 'preview' && (
                <PreviewPhase
                  importerLabel={sourceLabel(phase.importer, t)}
                  file={phase.file}
                  parsed={phase.parsed}
                  quotaCheck={quotaCheck}
                  sourceTag={phase.importer.sourceTag || undefined}
                  autoTag={autoTag}
                  onAutoTagChange={setAutoTag}
                  folderTags={folderTags}
                  browserTags={browserTags}
                  onBrowserTagsChange={setBrowserTags}
                  onFolderTagsChange={setFolderTags}
                  photoEstimate={photoEstimate}
                  importPhotos={importPhotos}
                  onImportPhotosChange={setImportPhotos}
                  oversizeCount={oversizeCount}
                  splitOversize={splitOversize}
                  onSplitOversizeChange={setSplitOversize}
                  destinationRow={importTarget && !phase.importer.restore && (
                    <DestinationRow
                      target={importTarget}
                      newFolderName={sourceLabel(phase.importer, t)}
                      value={destination}
                      onChange={setDestination}
                    />
                  )}
                />
              )}

              {phase.kind === 'applying' && (
                <ParsingPhase
                  importerLabel={sourceLabel(phase.importer, t)}
                  status={t('status.writingNotes')}
                />
              )}

              {phase.kind === 'error' && (
                <ErrorPhase
                  importerLabel={sourceLabel(phase.importer, t)}
                  message={phase.message}
                  detail={phase.detail}
                />
              )}
            </>
          ) : tab === 'restore' ? (
            <>
              {phase.kind === 'pick' && (
                <RestorePickPhase
                  gate={restoreGate}
                  onPickRestore={handlePickImporter}
                  onImportEncrypted={(file) => void handleImportEncryptedFile(file)}
                />
              )}
              {phase.kind === 'foreignPhrase' && (
                <ForeignPhrasePhase
                  onBack={handleBackToPick}
                  onUnlock={async (phrase) => {
                    if (phase.format === 'pnbackupz') {
                      try {
                        const zipFile = await decryptFullBackup(phase.file, phrase);
                        await runParseFlow(phase.importer, zipFile);
                        return null;
                      } catch (err) {
                        if (err instanceof BackupWrongKeyError) return err.message;
                        setPhase({
                          kind: 'error',
                          importer: phase.importer,
                          message: err instanceof Error ? err.message : t('errors.decryptionFailed'),
                        });
                        return null;
                      }
                    }
                    const releaseLockReload = holdLockReload();
                    try {
                      const counts = await onImportEncrypted(phase.file, phrase);
                      onImported(counts.imported, undefined, { updated: counts.updated, unchanged: counts.unchanged });
                      onClose();
                      return null;
                    } catch (err) {
                      if (err instanceof BackupWrongKeyError) return err.message;
                      setPhase({
                        kind: 'error',
                        importer: phase.importer,
                        message: err instanceof Error ? err.message : t('errors.decryptionFailed'),
                      });
                      return null;
                    } finally {
                      releaseLockReload();
                    }
                  }}
                />
              )}
              {phase.kind === 'parsing' && (
                <ParsingPhase importerLabel={sourceLabel(phase.importer, t)} status={phase.status} />
              )}
              {phase.kind === 'preview' && (
                <PreviewPhase importerLabel={sourceLabel(phase.importer, t)} file={phase.file} parsed={phase.parsed} quotaCheck={quotaCheck} />
              )}
              {phase.kind === 'applying' && (
                <ParsingPhase importerLabel={sourceLabel(phase.importer, t)} status={t('status.writingNotes')} />
              )}
              {phase.kind === 'error' && (
                <ErrorPhase importerLabel={sourceLabel(phase.importer, t)} message={phase.message} detail={phase.detail} />
              )}
            </>
          ) : tab === 'automatic' ? (
            <AutomaticPane />
          ) : tab === 'manual' ? (
            <ManualBackupPanel
              notes={notes}
              onExportAllMdZip={onExportAllMdZip}
              onExportEncrypted={onExportEncrypted}
              onExportEncryptedZip={onExportEncryptedZip}
              automatic={<AutomaticCallout onOpen={() => setTab('automatic')} />}
            />
          ) : tab === 'wellness' && wellness ? (
            <WellnessExportTab notes={notes} {...wellness} Row={ActionRow} />
          ) : (
            // The window stays open after an export: a daily routine writes
            // more than one backup, and the progress window sits above it.
            <ExportPanel
              notes={notes}
              onExportAllHtmlZip={onExportAllHtmlZip}
              onExportAllJson={onExportAllJson}
              onExportBookmarks={onExportBookmarks}
              onExportContacts={onExportContacts}
              onExportCalendar={onExportCalendar}
              onExportDrawings={onExportDrawings}
              onExportNotesMdZip={onExportNotesMdZip}
              onExportVault={onExportVault}
            />
          )}
        </div>

        {/* A picking tab needs no footer: the X closes the window, and a lone
            line there reads as stray text. The footer comes back while an
            import runs, for Back and Import. */}
        {!(tab === 'export' || tab === 'manual' || tab === 'automatic' || tab === 'wellness' || phase.kind === 'pick' || phase.kind === 'foreignPhrase') && (
        <ModalFooter bar>
          {phase.kind === 'preview' ? (
            <>
              <Button action="back" onClick={handleBackToPick} />
              <Button action="import" variant="primary" onClick={handleConfirm} disabled={quotaCheck?.exceeds === true}>
                {t('counts.importButton', { counts: formatTypeCountsShort(phase.parsed.notes) })}
              </Button>
            </>
          ) : phase.kind === 'error' ? (
            <>
              <Button action="back" onClick={handleBackToPick} />
              <Button action="cancel" onClick={onClose} />
            </>
          ) : (
            <div className="text-small text-pn-muted w-full text-center">
              {t('shell.working')}
            </div>
          )}
        </ModalFooter>
        )}

        {/* Hidden file input - shared by all importer cards. */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={pickerAccept(activeImporter?.accept ?? '')}
          onChange={handleFileSelected}
        />
    </Modal>
  );
}

/**
 * Inline phrase prompt shown when an encrypted backup (.pnbackup or .pnbackupz)
 * fails decryption under the active vault's key (D1, GitHub #862). Lets the
 * user type, upload a QR image, or scan a QR code for the backup's own
 * recovery phrase without switching accounts. Phrase state stays local to this
 * component so it is dropped as soon as unlock completes or cancels.
 */
function ForeignPhrasePhase({
  onBack,
  onUnlock,
}: {
  onBack: () => void;
  /** Returns an inline error string on wrong/invalid phrase, or null when the
   *  parent has transitioned out of this phase. */
  onUnlock: (phrase: string) => Promise<string | null>;
}) {
  const { t } = useTranslation('importExport');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [scanning, setScanning] = useState(false);
  const qrInputRef = useRef<HTMLInputElement | null>(null);

  async function handleSubmit() {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const err = await onUnlock(trimmed);
    setBusy(false);
    if (err) setError(err);
  }

  async function handleUploadQr(file: File) {
    setScanning(true);
    setError(null);
    try {
      const mod = await import('qr-scanner');
      const QrScanner = (mod as unknown as { default?: { scanImage: (f: File) => Promise<string> }; scanImage?: (f: File) => Promise<string> }).default
        ?? (mod as unknown as { scanImage: (f: File) => Promise<string> });
      const decoded = await QrScanner.scanImage(file);
      const phrase = extractPhraseFromScan(decoded);
      if (!phrase) {
        setError(t('auth:qrScanner.imageNotSignInCode'));
        return;
      }
      setInput(phrase);
    } catch {
      setError(t('auth:qrScanner.imageUnreadable'));
    } finally {
      setScanning(false);
      if (qrInputRef.current) qrInputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-title font-semibold text-pn">
          <Key className="text-accent" aria-hidden="true" />
          <span>{t('restoreForeign.title')}</span>
        </div>
        <p className="text-body text-pn-soft leading-relaxed">
          {t('restoreForeign.body')}
        </p>
      </div>

      <PhraseInput
        value={input}
        onChange={(next) => {
          setInput(next);
          setError(null);
        }}
        placeholder={t('auth:importPhrase.placeholder')}
        disabled={busy}
        autoFocus
      />

      <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
        <Button
          icon={<Upload aria-hidden="true" />}
          onClick={() => qrInputRef.current?.click()}
          disabled={scanning || busy}
          className="w-full"
        >
          {scanning ? t('auth:qrScanner.readingImage') : t('auth:importPhrase.uploadQr')}
        </Button>
        <Button
          icon={<Scan aria-hidden="true" />}
          onClick={() => setShowScanner(true)}
          disabled={busy}
          className="w-full"
        >
          {t('auth:importPhrase.scanQr')}
        </Button>
      </div>

      <input
        ref={qrInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUploadQr(file);
        }}
      />

      {error && <Callout tone="danger">{error}</Callout>}

      <ModalFooter>
        <Button action="back" onClick={onBack} disabled={busy} />
        <Button
          variant="primary"
          icon={busy ? <Spinner size={15} /> : <LockOpen aria-hidden="true" />}
          onClick={() => void handleSubmit()}
          disabled={!input.trim() || busy}
        >
          {t('restoreForeign.unlock')}
        </Button>
      </ModalFooter>

      {showScanner && (
        <QrScannerModal
          onScanned={(phrase) => {
            setInput(phrase);
            setError(null);
            setShowScanner(false);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}

/** The glyphs a card can carry instead of a brand's mark (`ImporterIcon`). */
const CARD_GLYPH: ReadonlyMap<'address-book' | 'drawing', ReactNode> = new Map<
  'address-book' | 'drawing',
  ReactNode
>([
  // The address book, matching the Contacts pillar: every phone writes the
  // same .vcf, so no vendor's logo fits.
  ['address-book', <AddressBook key="address-book" size={20} aria-hidden="true" />],
  // The drawing glyph the app draws everywhere, for a format two apps write.
  ['drawing', <NEW_GLYPHS.drawing key="drawing" size={20} aria-hidden="true" />],
]);

/**
 * The words an import failure shows (#758). An importer's own Error carries a
 * sentence written for the person and is shown as it is, and a zip that would
 * not open already has one (ImportFileError). A built-in error (a SyntaxError
 * from JSON.parse, a TypeError, a RangeError, a DOMException) is the code or
 * the device failing: its text means nothing to the person, so it gets a plain
 * sentence, and its own text stays as the technical detail for a bug report.
 */
function importFailure(err: unknown, imp: ImporterEntry, size: number | undefined, t: TFunction): { message: string; detail?: string } {
  if (err instanceof ImportFileError) return { message: err.message, detail: err.detail };
  const builtIn =
    err instanceof SyntaxError ||
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof ReferenceError ||
    err instanceof DOMException;
  if (err instanceof Error && !builtIn) return { message: err.message };
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (err instanceof RangeError && size !== undefined && /memory|allocat/i.test(err.message)) {
    return { message: t('errors.outOfMemory', { size: formatBytes(size) }), detail };
  }
  return { message: t('errors.unreadable', { importer: sourceLabel(imp, t) }), detail };
}


/** The app's own mark, for the rows that read or write our own format. */
const PN_ICON = '/favicon.svg';


/** One source card: the mark beside the name, the file types under it. A
 *  click opens the source's panel (`SourcePanel`) under the card's row; a
 *  second click closes it. Spec: docs/internal/design/patterns/151-160.md (section 157) */
function SourceTile({ icon, label, detail, open, panelId, disabled, onToggle, ...rest }: {
  icon: ReactNode;
  label: string;
  /** The line under the name: the file types. */
  detail: string;
  open: boolean;
  panelId: string;
  disabled?: boolean;
  onToggle: () => void;
  'data-setting': string;
}) {
  return (
    <button
      {...rest}
      type="button"
      disabled={disabled}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={onToggle}
      className={`${CARD} ${disabled ? 'border-divider opacity-40 cursor-not-allowed' : open ? 'border-accent bg-accent/5' : CARD_REST}`}
    >
      {icon}
      <span className="min-w-0 flex-1 flex flex-col">
        <span className="text-small font-medium leading-tight hyphens-auto break-words">{label}</span>
        <span className="truncate text-meta text-pn-muted mt-0.5">{detail}</span>
      </span>
    </button>
  );
}

/** One group of cards under its heading, the same on both tabs. */
function SourceGroup({ icon, title, children }: { icon?: ComponentProps<typeof SectionEyebrow>['icon']; title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <SectionEyebrow icon={icon} className="pt-1">{title}</SectionEyebrow>
      <div className={CARD_GRID}>{children}</div>
    </section>
  );
}

/** Expanded detail panel of the active source tile: full title, description,
 *  and primary actions across the full grid row (`grid-flow-dense` moves
 *  remaining tiles on that row above the panel). */
function SourcePanel({ id, label, desc, children }: { id: string; label: string; desc: ReactNode; children: ReactNode }) {
  return (
    <div id={id} role="region" aria-label={label} className="col-span-full rounded-lg border border-divider bg-surface-2 px-3 py-2.5">
      <span className={`block ${ROW_TITLE}`}>{label}</span>
      <span className="block text-small text-pn-soft mt-0.5">{desc}</span>
      <div className="mt-2.5 flex flex-wrap items-start gap-2">{children}</div>
    </div>
  );
}

/** The panel actions of one importer: Import opens the file picker, Guide
 *  opens its /help/import/<slug> page when one exists. */
function ImporterActions({ imp, onPick, guide }: { imp: ImporterEntry; onPick: (imp: ImporterEntry) => void; guide: string | null }) {
  const { t } = useTranslation('importExport');
  return (
    <>
      <Button variant="primary" icon={<FileArrowDown aria-hidden="true" />} onClick={() => onPick(imp)}>
        {t('webcal.import')}
      </Button>
      {guide && (
        <a
          href={siteHref(`${helpPath(activeLocale())}/import/${guide}`)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('importPick.guideAria', { app: sourceLabel(imp, t) })}
          className={SETTINGS_BTN}
        >
          <BookOpenText aria-hidden="true" className="shrink-0" />
          {t('importPick.guideLabel')}
        </a>
      )}
    </>
  );
}

/** The Webcal form: a calendar address, either downloaded once and handed
 *  to the calendar import as a file, or subscribed to (#619): kept in the
 *  synced settings and shown read-only in the calendars, downloaded again by
 *  each device. Under the field, the subscribed calendars with Remove. The
 *  address is never shown back in a message.
 *  Spec: docs/internal/issues/0548.md (Spec, design A), docs/internal/specs/calendar-pillar-spec.md (section 14) */
function CalendarFeedForm({ onFile, feeds }: { onFile: (file: File) => void; feeds?: FeedsControl }) {
  const { t } = useTranslation('importExport');
  const { supabase } = useAuth();
  const [address, setAddress] = useState('');
  const [importing, setImporting] = useState(false);
  const sub = useFeedSubscribe(feeds);
  const busy = importing || sub.busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const url = calendarFeedUrl(address);
    if (!url) {
      sub.setError(t('webcal.errors.invalid'));
      return;
    }
    setImporting(true);
    sub.setError(null);
    try {
      const file = await downloadCalendarFeed(url, sessionTokenOf(supabase));
      onFile(file);
    } catch (err) {
      sub.setError(t(FEED_ERROR[err instanceof ClipError ? err.reason : 'failed']));
      setImporting(false);
    }
  }

  return (
    <div className="min-w-0 flex-1 basis-full space-y-3">
      <form onSubmit={submit} noValidate className="flex flex-wrap items-start gap-2">
        <div className="min-w-48 flex-1">
          <TextField
            size="sm"
            type="url"
            inputMode="url"
            autoComplete="off"
            {...NO_TEXT_ASSIST}
            aria-label={t('webcal.fieldLabel')}
            placeholder="webcal://"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              sub.setError(null);
            }}
            error={sub.error ?? undefined}
            className="w-full"
          />
        </div>
        <Button type="submit" variant="primary" icon={importing ? <Spinner size={15} className="text-current" /> : <FileArrowDown aria-hidden="true" />} disabled={busy || !address.trim()}>
          {importing ? t('webcal.downloading') : t('webcal.import')}
        </Button>
        {feeds && (
          <Button
            type="button"
            icon={sub.busy ? <Spinner size={15} className="text-current" /> : <CalendarPlus aria-hidden="true" />}
            disabled={busy || !address.trim()}
            onClick={() => void sub.subscribe(address).then((ok) => ok && setAddress(''))}
          >
            {sub.busy ? t('webcal.downloading') : t('webcal.subscribe')}
          </Button>
        )}
      </form>
      {feeds && <SubscribedFeeds feeds={feeds} />}
    </div>
  );
}

const GROUP_ICON: ReadonlyMap<PickerSectionKey, ComponentProps<typeof SectionEyebrow>['icon']> = new Map<
  PickerSectionKey,
  ComponentProps<typeof SectionEyebrow>['icon']
>([
  ['notes', Note],
  ['tasks', PILLAR_GLYPHS.tasks],
  ['drawings', NEW_GLYPHS.drawing],
  ['calendar', CalendarDots],
  ['bookmarks', BookmarkSimple],
  ['passwords', Key],
]);

/** Import tab: a search field over source cards grouped by destination pillar.
 *  Search matches card labels, file extensions, and section titles, so ".enex"
 *  finds Evernote and "bookmarks" retains every browser card in Bookmarks.
 *  Spec: docs/internal/design/patterns/151-160.md (section 157) */
function ImportPickPhase({ onPick, onCalendarFeed, calendarFeeds }: { onPick: (imp: ImporterEntry) => void; onCalendarFeed: (file: File) => void; calendarFeeds?: FeedsControl }) {
  const { t } = useTranslation('importExport');
  const [openCard, setOpenCard] = useState<PickerCardKey | null>(null);
  const [query, setQuery] = useState('');
  // Escape empties a typed search before it closes Settings.
  useEscapeToClose(() => setQuery(''), query !== '');

  const groups = useMemo(() => buildPickerGroups((key) => t(key)), [t]);
  const shown = useMemo(() => filterPickerCards(groups, query), [groups, query]);
  const fallbackCard = useMemo(
    () =>
      groups
        .flatMap((g) => g.cards)
        .find((c) => c.importerId === 'markdown-folder' && c.aliasKey === null) ?? null,
    [groups],
  );

  const isOpen = (card: PickerCard) =>
    openCard !== null &&
    openCard.importerId === card.importerId &&
    openCard.aliasKey === card.aliasKey;
  const toggle = (card: PickerCard) =>
    setOpenCard((cur) =>
      cur !== null && cur.importerId === card.importerId && cur.aliasKey === card.aliasKey
        ? null
        : { importerId: card.importerId, aliasKey: card.aliasKey },
    );
  const panelIdOf = (card: PickerCard) =>
    card.aliasKey
      ? `import-panel-${card.importerId}-${card.aliasKey}`
      : `import-panel-${card.importerId}`;

  // A card, then its panel right after it when open: the panel spans the
  // row, and `grid-flow-dense` fills the rest of the card's row from the
  // cards that follow, so the panel opens under the row and comes next in
  // the Tab order.
  const renderCard = (card: PickerCard) => {
    const open = isOpen(card);
    const panelId = panelIdOf(card);
    const reactKey = card.aliasKey ? `${card.importerId}:${card.aliasKey}` : card.importerId;
    if (card.kind === 'webcal') {
      return (
        <Fragment key={reactKey}>
          <SourceTile
            data-setting="import.webcal"
            icon={<RowIcon glyph={<Globe size={20} aria-hidden="true" />} />}
            label={card.label}
            detail={card.fileTypes}
            open={open}
            panelId={panelId}
            onToggle={() => toggle(card)}
          />
          {open && (
            <SourcePanel id={panelId} label={card.label} desc={card.desc}>
              <CalendarFeedForm onFile={onCalendarFeed} feeds={calendarFeeds} />
            </SourcePanel>
          )}
        </Fragment>
      );
    }
    const imp = card.importer;
    return (
      <Fragment key={reactKey}>
        <SourceTile
          // Every browser card of a family carries the family's marker; the
          // settings search scrolls to the first one. An alias of another
          // app (Apple Calendar) takes its own, or a search for Google
          // Calendar would land on it.
          data-setting={`import.source.${imp.id}`}
          {...(card.aliasSetting ? { 'data-setting': card.aliasSetting } : {})}
          icon={
            <RowIcon
              src={'src' in card.icon ? card.icon.src : undefined}
              glyph={'glyph' in card.icon ? CARD_GLYPH.get(card.icon.glyph) : undefined}
            />
          }
          label={card.label}
          detail={card.fileTypes}
          open={open}
          panelId={panelId}
          disabled={!imp.enabled}
          onToggle={() => toggle(card)}
        />
        {open && (
          <SourcePanel id={panelId} label={card.label} desc={card.desc}>
            <ImporterActions imp={card.pickImporter} onPick={onPick} guide={card.guide} />
          </SourcePanel>
        )}
      </Fragment>
    );
  };

  return (
    <div className="space-y-3">
      <ListSearchInput value={query} onChange={setQuery} placeholder={t('importPick.searchPlaceholder')} ariaLabel={t('importPick.searchPlaceholder')} />
      {shown.map((g) => (
        <SourceGroup key={g.key} icon={GROUP_ICON.get(g.key)} title={g.title}>{g.cards.map(renderCard)}</SourceGroup>
      ))}
      {shown.length === 0 && fallbackCard && (
        // Most note apps can write plain Markdown, which the Markdown
        // importer reads, so a search with no match ends on that card.
        <SourceGroup title={t('importPick.noMatch')}>{renderCard(fallbackCard)}</SourceGroup>
      )}
    </div>
  );
}

/** Restore tab pick phase - PrivacyNotes backup restore, 1-col with full descriptions. */
function RestorePickPhase({ gate, onPickRestore, onImportEncrypted }: {
  gate: RestoreGate;
  onPickRestore: (imp: ImporterEntry) => void;
  onImportEncrypted: (file: File) => void;
}) {
  const { t } = useTranslation('importExport');
  const encFileRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="space-y-3">
      <p className={SETTINGS_HELP}>
        {t('restorePick.intro')}
      </p>

      {gate !== 'open' && <Callout>{t(RESTORE_WAIT_LINE[gate])}</Callout>}

      <div className="space-y-1.5">
        <ActionRow
          setting="restore.fullBackup"
          title={t('restorePick.fullBackupTitle')}
          description={t('restorePick.fullBackupDesc')}
          glyph={<FileZip size={20} aria-hidden="true" />}
          disabled={gate !== 'open'}
          onClick={() => {
            const imp = IMPORTERS.find((i) => i.restore);
            if (imp) onPickRestore(imp);
          }}
        />
        <ActionRow
          setting="restore.encryptedBackup"
          title={t('restorePick.encryptedBackupTitle')}
          description={t('restorePick.encryptedBackupDesc')}
          locked
          src={PN_ICON}
          disabled={gate !== 'open'}
          onClick={() => encFileRef.current?.click()}
        />
      </div>

      <input
        ref={encFileRef}
        type="file"
        className="hidden"
        accept={pickerAccept('.pnbackup,.pnbackupz')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (encFileRef.current) encFileRef.current.value = '';
          if (file) onImportEncrypted(file);
        }}
      />

      <HelpChip surface="restore" />
    </div>
  );
}

function ParsingPhase({
  importerLabel,
  status,
}: {
  importerLabel: string;
  status: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="mb-4">
        <Spinner size={32} />
      </div>
      <div className="text-body font-medium">{importerLabel}</div>
      <div className="text-small text-pn-muted mt-1">
        {status}
      </div>
    </div>
  );
}

/** Derive type-aware counts from notes at render time. */
export function computeTypeCounts(notes: ImportedNote[]): { label: string; count: number }[] {
  let noteCount = 0, taskCount = 0, eventCount = 0, linkCount = 0, journalCount = 0, loginCount = 0, cardCount = 0, sshKeyCount = 0, contactCount = 0, drawingCount = 0;
  for (const n of notes) {
    switch (n.type) {
      case 'task': taskCount++; break;
      case 'event': eventCount++; break;
      case 'link': linkCount++; break;
      case 'journal': journalCount++; break;
      case 'login': loginCount++; break;
      case 'card': cardCount++; break;
      case 'ssh-key': sshKeyCount++; break;
      case 'contact': contactCount++; break;
      case 'drawing': drawingCount++; break;
      default: noteCount++; break;
    }
  }
  const lower = (s: string) => (activeLocale() === 'de' ? s : s.toLowerCase()), parts: { label: string; count: number }[] = [], push = (count: number, label: () => string) => { if (count > 0) parts.push({ label: label(), count }); };
  push(noteCount, () => i18n.t('importExport:counts.note', { count: noteCount }));
  push(taskCount, () => lower(i18n.t('notes:footerStats.tasks', { count: taskCount })));
  push(eventCount, () => lower(eventCount === 1 ? i18n.t('notes:newMenu.event') : i18n.t('shell:calendar.kinds.event')));
  push(linkCount, () => lower(i18n.t('notes:footerStats.bookmarks', { count: linkCount })));
  push(contactCount, () => i18n.t('importExport:counts.contact', { count: contactCount }));
  push(drawingCount, () => i18n.t('importExport:counts.drawing', { count: drawingCount }));
  push(journalCount, () => i18n.t('importExport:counts.journal', { count: journalCount }));
  push(loginCount, () => i18n.t('importExport:counts.login', { count: loginCount }));
  push(cardCount, () => i18n.t('importExport:counts.card', { count: cardCount }));
  push(sshKeyCount, () => i18n.t('importExport:counts.sshKey', { count: sshKeyCount }));
  return parts;
}

/** Format type counts for the confirm button label. Several types read as
 *  one total: the stat tiles above the button already show each type, and a
 *  list of seven types made a button of two lines. */
export function formatTypeCountsShort(notes: ImportedNote[]): string {
  const parts = computeTypeCounts(notes);
  if (parts.length === 0) return i18n.t('importExport:counts.zeroItems');
  if (parts.length === 1) return `${parts[0]!.count} ${parts[0]!.label}`;
  return i18n.t('common:quickSwitcher.tagItems', { count: parts.reduce((sum, p) => sum + p.count, 0) });
}

/** The "Add to" row: where the import puts its items. */
function DestinationRow({
  target,
  newFolderName,
  value,
  onChange,
}: {
  target: ImportTarget;
  newFolderName: string;
  value: ImportDestination;
  onChange: (v: ImportDestination) => void;
}) {
  const { t } = useTranslation('importExport');
  const groups = destinationGroups(target.folders, target.spaceOf, target.openSpace);
  const newSpace = target.openSpace ?? 'personal';
  // A second import from the same source goes into the folder the first one
  // made, so that folder is selected and no "New folder" is offered.
  const existing = existingImportFolder(target, newFolderName);
  const selected = value === 'new' && existing ? `f:${existing}` : typeof value === 'string' ? value : `f:${value.folderId}`;
  const newOption = !existing && <option value="new">{t('destination.newFolder', { name: newFolderName })}</option>;
  const folderOptions = (entries: (typeof groups)[number]['entries']) =>
    entries.map((e) => (
      <option key={e.id} value={`f:${e.id}`}>{'\u00a0\u00a0'.repeat(e.depth) + e.name}</option>
    ));
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 ${OPTION_ROW}`}>
      <div className="min-w-0">
        <label htmlFor="import-destination" className="block text-body text-pn">{t('shell:quickAdd.addTo')}</label>
        <div className="mt-0.5 text-small text-pn-muted">{t('destination.help')}</div>
      </div>
      <Select
        id="import-destination"
        size="sm"
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === 'none' || v === 'new' ? v : { folderId: v.slice(2) });
        }}
        className="max-w-full"
      >
        <option value="none">{t('destination.none')}</option>
        {!target.spaceOf ? (
          <>
            {newOption}
            {groups.flatMap((g) => folderOptions(g.entries))}
          </>
        ) : (
          groups.map((g) => (
            <optgroup key={g.space} label={t(`shell:spaces.${g.space}`)}>
              {g.space === newSpace && newOption}
              {folderOptions(g.entries)}
            </optgroup>
          ))
        )}
      </Select>
    </div>
  );
}

/** One choice in the check step's options group: the padding a row has
 *  inside the group's frame, which draws the lines between the rows. */
const OPTION_ROW = 'px-3 py-2.5';

/** The notes the check step lists by name, before "and N more". */
const PREVIEW_SAMPLE = 8;

/** The check step: what the file holds, what needs attention, every choice
 *  in one group with what happens when it is off, and the first notes by
 *  name. A wide pane puts the names in a column beside the rest.
 *  Spec: docs/internal/design/patterns/151-160.md (section 157, 2026-10-30) */
function PreviewPhase({
  importerLabel,
  file,
  parsed,
  quotaCheck,
  sourceTag,
  autoTag,
  onAutoTagChange,
  folderTags,
  onFolderTagsChange,
  browserTags,
  onBrowserTagsChange,
  photoEstimate,
  importPhotos,
  onImportPhotosChange,
  oversizeCount = 0,
  splitOversize,
  onSplitOversizeChange,
  destinationRow,
}: {
  importerLabel: string;
  file: { name: string; size: number };
  parsed: ParsedImport;
  quotaCheck: QuotaCheck | null;
  /** The importer's source tag; with `onAutoTagChange` the step offers it. */
  sourceTag?: string;
  autoTag?: boolean;
  onAutoTagChange?: (v: boolean) => void;
  folderTags?: boolean;
  onFolderTagsChange?: (v: boolean) => void;
  browserTags?: boolean;
  onBrowserTagsChange?: (v: boolean) => void;
  photoEstimate?: PhotoEstimate | null;
  importPhotos?: boolean;
  onImportPhotosChange?: (v: boolean) => void;
  /** Notes over the 1 MB sync limit, and the choice to cut them at headings. */
  oversizeCount?: number;
  splitOversize?: boolean;
  onSplitOversizeChange?: (v: boolean) => void;
  destinationRow?: ReactNode;
}) {
  const { t } = useTranslation('importExport');
  const { warnings, transforms, notes } = parsed;
  const sample = notes.slice(0, PREVIEW_SAMPLE);
  const typeCounts = computeTypeCounts(notes);
  const folderCount = parsed.folders?.length ?? 0;
  const fileCount = parsed.blobs?.size ?? 0;
  // Every importer that rebuilds a folder tree (Obsidian vaults,
  // Notesnook notebooks) gets the folder-tag toggle. Our own backups
  // rebuild one too, but the Restore tab passes no toggle and a restore
  // adds no folder tags.
  const showFolderTags = folderCount > 0;
  // Only Firefox writes these, and only for bookmarks the user labelled,
  // so the toggle appears only when the file actually carries some.
  const showBrowserTags = notes.some((n) => (n.browserTags?.length ?? 0) > 0);
  const allLinks = notes.length > 0 && notes.every((n) => n.type === 'link');
  const allContacts = notes.length > 0 && notes.every((n) => n.type === 'contact');
  const allEvents = notes.length > 0 && notes.every((n) => n.type === 'event');
  // Our own backups carry each note's id, and a restore matches it to the
  // copy the vault holds. A backup written before ids were carried adds
  // everything again, so it keeps the duplicates warning. Only the
  // PrivacyNotes backup formats set an id (ImportedNote.id), so this reads
  // the file itself rather than the importer that opened it.
  const allOwn = notes.length > 0 && notes.every((n) => !!n.id);
  // Our own full backup carries settings beside the notes (subscribed
  // calendars, the Home layout, looks); the preview names the ones it holds,
  // so a file somebody else made cannot bring them in unseen.
  const settingNames = parsed.settings ? backupSettingsNames(parsed.settings) : [];
  // Reflect the folder tags the import is about to add (reactive to the
  // toggle) so the tag counts match what actually lands, not the raw
  // parse-time count. Non-folder imports fall through to notes unchanged.
  const previewNotes = useMemo(() => {
    const withFolders = showFolderTags
      ? withFolderPathTags(notes, folderTags ?? false)
      : notes;
    return withBrowserTags(withFolders, browserTags ?? false);
  }, [showFolderTags, notes, folderTags, browserTags]);
  const uniqueTagCount = useMemo(
    () => new Set(previewNotes.flatMap((n) => n.tags)).size,
    [previewNotes]
  );
  const capital = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
  const offerSourceTag = !!sourceTag && !!onAutoTagChange;
  const hasOptions = !!destinationRow || offerSourceTag
    || (showFolderTags && !!onFolderTagsChange)
    || (oversizeCount > 0 && !!onSplitOversizeChange)
    || (!!photoEstimate && !!onImportPhotosChange)
    || (showBrowserTags && !!onBrowserTagsChange);
  return (
    <div className="@container space-y-4">
      <div className="min-w-0">
        <h3 className="text-title font-semibold text-pn">{t('preview.title')}</h3>
        <div className="text-small text-pn-muted truncate">
          {[importerLabel, file.name, formatBytes(file.size)].join(' \u00b7 ')}
        </div>
      </div>

      <div className="grid gap-4 @2xl:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="min-w-0 space-y-3">
      <div className="grid grid-cols-2 @md:grid-cols-4 gap-2">
        {typeCounts.length > 0
          ? typeCounts.map((tc) => <StatTile key={tc.label} label={capital(tc.label)} value={tc.count} />)
          : <StatTile label={t('preview.items')} value={0} />}
        {folderCount > 0 && <StatTile label={t('shell:browseToggle.folders')} value={folderCount} />}
        {fileCount > 0 && <StatTile label={t('shell:tagsRail.files')} value={fileCount} />}
        <StatTile label={t('preview.uniqueTags')} value={uniqueTagCount} />
      </div>

      {quotaCheck?.exceeds && (
        <Callout tone="danger">
          <Trans
            i18nKey="importExport:preview.quotaExceeded"
            values={{
              needed: formatBytes(quotaCheck.estimatedBytes),
              available: formatBytes(quotaCheck.availableBytes),
            }}
            components={{ strong: <strong /> }}
          />
        </Callout>
      )}

      {transforms.length > 0 && (
        <Callout>
          <div className="space-y-1">{transforms.map((item, i) => <div key={i}>{item}</div>)}</div>
        </Callout>
      )}

      {oversizeCount > 0 && onSplitOversizeChange && (
        <Callout tone="warning" title={t('preview.oversize', { count: oversizeCount })} />
      )}

      {warnings.length > 0 && (
        <Callout tone="warning">
          <div className="space-y-1">{warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
        </Callout>
      )}

      {hasOptions && (
        <div className="rounded-lg border border-divider divide-y divide-divider">
          {destinationRow}

          {offerSourceTag && (
            <Checkbox
              checked={autoTag ?? true}
              onChange={(e) => onAutoTagChange(e.target.checked)}
              label={
                <Trans
                  i18nKey="importExport:preview.sourceTagLabel"
                  values={{ tag: `#${sourceTag}` }}
                  components={{ tag: <span className="font-mono text-accent" /> }}
                />
              }
              description={t('preview.sourceTagDesc')}
              className={OPTION_ROW}
            />
          )}

          {showFolderTags && onFolderTagsChange && (
            <Checkbox
              checked={folderTags ?? false}
              onChange={(e) => onFolderTagsChange(e.target.checked)}
              label={t('folderImport.tagLabel')}
              description={t('folderImport.tagDesc')}
              className={OPTION_ROW}
            />
          )}

          {oversizeCount > 0 && onSplitOversizeChange && (
            <Checkbox
              checked={splitOversize ?? false}
              onChange={(e) => onSplitOversizeChange(e.target.checked)}
              label={t('preview.splitOversize', { count: oversizeCount })}
              className={OPTION_ROW}
            />
          )}

          {photoEstimate && onImportPhotosChange && (
            <Checkbox
              checked={photoEstimate.fits && (importPhotos ?? true)}
              disabled={!photoEstimate.fits}
              onChange={(e) => onImportPhotosChange(e.target.checked)}
              label={t('contactImport.photosLabel')}
              description={
                !photoEstimate.fits && photoEstimate.available !== null
                  ? t('contactImport.photosTooBig', {
                      count: photoEstimate.count,
                      size: formatBytes(photoEstimate.bytes),
                      shortfall: formatBytes(photoEstimate.bytes - photoEstimate.available),
                    })
                  : photoEstimate.available !== null
                    ? t('contactImport.photosDesc', {
                        count: photoEstimate.count,
                        size: formatBytes(photoEstimate.bytes),
                        pct: Math.min(100, Math.round((photoEstimate.bytes / Math.max(1, photoEstimate.available)) * 100)),
                        free: formatBytes(photoEstimate.available),
                      })
                    : t('contactImport.photosDescNoQuota', {
                        count: photoEstimate.count,
                        size: formatBytes(photoEstimate.bytes),
                      })
              }
              className={OPTION_ROW}
            />
          )}

          {showBrowserTags && onBrowserTagsChange && (
            <Checkbox
              checked={browserTags ?? false}
              onChange={(e) => onBrowserTagsChange(e.target.checked)}
              label={t('browserImport.tagLabel')}
              description={t('browserImport.tagDesc')}
              className={OPTION_ROW}
            />
          )}
        </div>
      )}

      {quotaCheck && !quotaCheck.exceeds && (
        <p className={SETTINGS_HELP}>
          {t('preview.storageLine', {
            needed: formatBytes(quotaCheck.estimatedBytes),
            available: formatBytes(quotaCheck.availableBytes),
          })}
        </p>
      )}

      {settingNames.length > 0 && (
        <p className={SETTINGS_HELP}>
          {t('preview.backupSettings', { list: listOf(settingNames.map((k) => t(`preview.backupSetting.${k}`))) })}
        </p>
      )}

      <Callout>
        <strong className="text-pn">
          {t('preview.headsUpLabel')}
        </strong>{' '}
        {/* Our own backups, bookmarks and contacts are the sources apply.ts
            matches against the vault, so the standing "you will get
            duplicates" line is false for them. The id match comes first
            because apply.ts runs it before the bookmark and contact rules:
            a newer copy of a contact from our own backup updates its row,
            it is not skipped as a lookalike. */}
        {allOwn
          ? t('preview.restoreMergeNote')
          : allLinks
            ? t('preview.duplicateSkipNote')
            : allContacts
              ? t('preview.contactSkipNote')
              : allEvents
                ? t('preview.eventSkipNote')
                : t('preview.duplicateWarning')}
      </Callout>

      <p className={SETTINGS_HELP}>{t('preview.nothingWritten')}</p>
      </div>

      {sample.length > 0 && (
        <section className="min-w-0">
          <SectionEyebrow className="mb-1.5">
            {t('preview.whatComesIn')}
          </SectionEyebrow>
          <ul className="space-y-1">
            {sample.map((n, i) => {
              const meta = [
                n.folderPath?.join(' / '),
                n.tags.length > 0 ? t('shell:noteOptionsMenu.tagCount', { count: n.tags.length }) : '',
              ].filter(Boolean).join(' \u00b7 ');
              return (
                <li key={i} className="min-w-0 rounded-md border border-divider px-2.5 py-1.5">
                  <div className="truncate text-small font-medium text-pn">{n.title || t('common:state.untitled')}</div>
                  {meta && <div className="truncate text-meta text-pn-muted">{meta}</div>}
                </li>
              );
            })}
          </ul>
          {notes.length > sample.length && (
            <div className="mt-1.5 text-small text-pn-muted">
              {t('preview.andMore', { count: notes.length - sample.length })}
            </div>
          )}
        </section>
      )}
      </div>
    </div>
  );
}

function ErrorPhase({
  importerLabel,
  message,
  detail,
}: {
  importerLabel: string;
  message: string;
  detail?: string;
}) {
  const { t } = useTranslation('importExport');
  return (
    <div className="py-6">
      <Callout tone="danger" title={t('errorPhase.heading', { importer: importerLabel })}>
        <div className="whitespace-pre-wrap break-words">{message}</div>
        {detail && <div className="mt-2 text-meta text-pn-muted break-words select-text">{t('errorPhase.detail', { detail })}</div>}
      </Callout>
    </div>
  );
}

/**
 * Export tab body - exports that run over the whole note set. The full
 * backups and the portable archives always render; the bookmarks-only and
 * vault-only writers appear once there is something for them to write.
 * Per-note exports live in the note's own share menu, not here. A tile opens
 * its panel; the panel's Export button fires the parent's telemetry-wrapped
 * handler, which also closes the modal.
 */
function ExportPanel({
  notes,
  onExportAllHtmlZip,
  onExportAllJson,
  onExportVault,
  onExportBookmarks,
  onExportContacts,
  onExportCalendar,
  onExportDrawings,
  onExportNotesMdZip,
}: {
  notes: LocalNote[];
  onExportAllHtmlZip: (ns: LocalNote[]) => void;
  onExportAllJson: (ns: LocalNote[]) => void;
  onExportVault: (ns: LocalNote[]) => void;
  onExportBookmarks: (ns: LocalNote[]) => void;
  onExportContacts: (ns: LocalNote[]) => void;
  onExportCalendar: (ns: LocalNote[]) => void;
  onExportDrawings?: (ns: LocalNote[]) => void;
  onExportNotesMdZip: (ns: LocalNote[]) => void;
}) {
  const { t } = useTranslation('importExport');
  const hasNotes = notes.some((n) => n.type === 'note' && n.deleted !== 1 && n.trashed !== 1);
  const hasDrawings = notes.some((n) => n.type === 'drawing' && n.deleted !== 1 && n.trashed !== 1);
  const hasCalendar = notes.some(goesToCalendarFile);
  const hasContacts = notes.some((n) => n.type === 'contact' && n.trashed !== 1);
  const hasVaultItems = notes.some(
    (n) => n.type === 'login' || n.type === 'card' || n.type === 'ssh-key',
  );
  const hasBookmarks = notes.some(
    (n) => n.type === 'link' && n.deleted !== 1 && n.trashed !== 1,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  // Single-pillar files (bookmarks, contacts, calendar, drawings, vault) share
  // the Portable export grid alongside whole-vault archives, appearing once
  // the vault holds matching items.
  const portable: ExportEntry[] = [
    ...(hasNotes ? [{ setting: 'export.notesMarkdown', title: t('export.notesMarkdownTitle'), desc: t('export.notesMarkdownDesc'), icon: <RowIcon glyph={<EXPORT_GLYPHS.markdown size={20} aria-hidden="true" />} />, run: () => onExportNotesMdZip(notes) }] : []),
    { setting: 'export.htmlArchive', title: t('export.htmlArchiveTitle'), desc: t('export.htmlArchiveDesc'), icon: <RowIcon glyph={<FileHtml size={20} aria-hidden="true" />} />, run: () => onExportAllHtmlZip(notes) },
    { setting: 'export.textBackup', title: t('export.textBackupTitle'), desc: t('export.textBackupDesc'), icon: <RowIcon glyph={<BracketsCurly size={20} aria-hidden="true" />} />, run: () => onExportAllJson(notes) },
    ...(hasBookmarks ? [{ setting: 'export.bookmarks', title: t('export.bookmarksExportTitle'), desc: t('export.bookmarksExportDesc'), icon: <RowIcon glyph={<BookmarkSimple size={20} aria-hidden="true" />} />, run: () => onExportBookmarks(notes) }] : []),
    ...(hasContacts ? [{ setting: 'export.contacts', title: t('export.contactsExportTitle'), desc: t('export.contactsExportDesc'), icon: <RowIcon glyph={<AddressBook size={20} aria-hidden="true" />} />, run: () => onExportContacts(notes) }] : []),
    ...(hasCalendar ? [{ setting: 'export.calendar', title: t('export.calendarExportTitle'), desc: t('export.calendarExportDesc'), icon: <RowIcon glyph={<CalendarDots size={20} aria-hidden="true" />} />, run: () => onExportCalendar(notes) }] : []),
    ...(hasDrawings && onExportDrawings ? [{ setting: 'export.drawings', title: t('export.drawingsExportTitle'), desc: t('export.drawingsExportDesc'), icon: <RowIcon glyph={<NEW_GLYPHS.drawing size={20} aria-hidden="true" />} />, run: () => onExportDrawings(notes) }] : []),
    ...(hasVaultItems ? [{ setting: 'export.vault', title: t('export.vaultExportTitle'), desc: t('export.vaultExportDesc'), icon: <RowIcon glyph={<Key size={20} aria-hidden="true" />} />, run: () => onExportVault(notes) }] : []),
  ];
  // A card, then its panel when open, as on the Import tab (section 157).
  const cells = (e: ExportEntry) => {
    const open = openId === e.setting;
    const panelId = `export-panel-${e.setting}`;
    const { name, type } = splitFileType(e.title);
    return (
      <Fragment key={e.setting}>
        <SourceTile
          data-setting={e.setting}
          icon={e.icon}
          label={name}
          detail={type}
          open={open}
          panelId={panelId}
          onToggle={() => setOpenId((cur) => (cur === e.setting ? null : e.setting))}
        />
        {open && (
          <SourcePanel id={panelId} label={e.title} desc={e.desc}>
            <Button variant="primary" icon={<FileArrowUp aria-hidden="true" />} onClick={e.run}>
              {t('shell.tabExport')}
            </Button>
          </SourcePanel>
        )}
      </Fragment>
    );
  };
  return (
    <div className="space-y-3">
      <p className={SETTINGS_HELP}>
        {t('export.intro')}
      </p>
      <SourceGroup icon={FileText} title={t('export.portableHeading')}>{portable.map(cells)}</SourceGroup>

      {/* Help links sit at the foot of a settings pane, after the last
          section: the question you arrive with, then the one you leave with. */}
      <HelpChip surface="export" />
      <HelpChip surface="exportEnd" />
    </div>
  );
}

/**
 * The Manual tab of Backup: the three full backups, each one file of
 * everything. They keep the Restore rows: their names are long, so a card
 * would cut them. The automatic backups callout sits above them.
 */
function ManualBackupPanel({
  notes,
  onExportAllMdZip,
  onExportEncrypted,
  onExportEncryptedZip,
  automatic,
}: {
  notes: LocalNote[];
  onExportAllMdZip: (ns: LocalNote[]) => void;
  onExportEncrypted: (ns: LocalNote[]) => void;
  onExportEncryptedZip: (ns: LocalNote[]) => void;
  automatic: ReactNode;
}) {
  const { t } = useTranslation('importExport');
  const fullBackups: { setting: string; title: string; desc: string; locked?: boolean; unlocked?: boolean; glyph?: ReactNode; src?: string; run: () => void }[] = [
    { setting: 'export.encryptedZip', title: t('export.encryptedZipBackupTitle'), desc: t('export.encryptedZipBackupDesc'), locked: true, src: PN_ICON, run: () => onExportEncryptedZip(notes) },
    { setting: 'export.encryptedBackup', title: t('export.encryptedBackupTitle'), desc: t('export.encryptedBackupDesc'), locked: true, src: PN_ICON, run: () => onExportEncrypted(notes) },
    { setting: 'export.zipBackup', title: t('export.zipBackupTitle'), desc: t('export.zipBackupDesc'), unlocked: true, glyph: <FileZip size={20} aria-hidden="true" />, run: () => onExportAllMdZip(notes) },
  ];
  return (
    <div className="space-y-3">
      <p className={SETTINGS_HELP}>{t('export.manualIntro')}</p>
      {automatic}
      <section className="space-y-1.5">
        <SectionEyebrow icon={Archive} className="pt-1">{t('export.fullBackupHeading')}</SectionEyebrow>
        {fullBackups.map((e) => {
          const { name, type } = splitFileType(e.title);
          return <ActionRow key={e.setting} setting={e.setting} title={name} type={type} description={e.desc} locked={e.locked} unlocked={e.unlocked} glyph={e.glyph} src={e.src} onClick={e.run} />;
        })}
      </section>
      <HelpChip surface="export" />
    </div>
  );
}

/** An export title's name and its file type: every title ends in the type
 *  in brackets ("HTML archive (.zip)"), which the settings search keeps and
 *  the card shows on its second line. A title without one keeps it whole. */
function splitFileType(title: string): { name: string; type: string } {
  const m = /^(.*?)\s*[(\uff08](\.[a-z]+)[)\uff09]$/.exec(title);
  return m?.[1] && m[2] ? { name: m[1], type: m[2] } : { name: title, type: '' };
}

/** One Export card and what its panel's Export button runs. `setting` is
 *  also the settings search id. */
type ExportEntry = { setting: string; title: string; desc: string; icon: ReactNode; run: () => void };

/** One Restore or Trackers row: mark, title, optional Pro lock, description.
 *  Shared by both tabs so a file type looks the same wherever it appears -
 *  the mark names the FORMAT (.zip, .html, .json), and our own two formats
 *  take the app icon. */
function ActionRow({
  setting,
  title,
  description,
  locked,
  unlocked,
  pro,
  type,
  glyph,
  src,
  disabled,
  onClick,
}: {
  /** The settings search id of this row. */
  setting: string;
  title: string;
  description: string;
  locked?: boolean;
  /** A file anyone can read: the open lock, in red. `locked` is green. */
  unlocked?: boolean;
  /** A Pro action: the rocket after the title, as on every Pro door. */
  pro?: boolean;
  /** The file type, quiet after the title (Export's Full backup). */
  type?: string;
  glyph?: ReactNode;
  src?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      data-setting={setting}
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-start rounded-lg border border-divider px-3 py-2.5 transition flex items-center gap-3 ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'hover:border-accent hover:bg-accent/5 cursor-pointer'
      }`}
    >
      <RowIcon src={src} glyph={glyph} />
      <span className="min-w-0">
        <span className="block font-medium text-body flex items-center gap-1.5">
          {title}
          {type && <span className="font-normal text-small text-pn-muted">{type}</span>}
          {locked && (
            <Lock className="text-success shrink-0" />
          )}
          {unlocked && <LockOpen className="text-danger shrink-0" />}
          {pro && <IconUpgrade size={12} />}
        </span>
        <span className="block text-small text-pn-soft mt-0.5">{description}</span>
      </span>
    </button>
  );
}
