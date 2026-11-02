import { Fragment, useMemo, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { isOversizeImport, splitImportedNote } from '../noteSplit';
import i18n from '../i18n';
import { IMPORTERS } from './registry';
import { applyImport } from './apply';
import { withFolderPathTags } from './folderImport';
import { withBrowserTags } from './browserBookmarks';
import { normalizeTag } from '../notesRepo';
import type { Importer, ParsedImport, ImportedNote, RestoreCounts, StagedBlob } from './types';
import { useAuth } from '../auth';
import { recordAdminEvent, type ImportSource } from '../adminEvents';
import type { LocalNote } from '../db';
import { missingItemsLabel } from '../export';
import type { FolderDef } from '../folders';
import { destinationGroups, existingImportFolder, fileUnfiled, type ImportDestination, type ImportTarget } from './destination';
import { Archive, ArrowCounterClockwise, Heartbeat, BookmarkSimple, BookOpenText, BracketsCurly, CalendarDots, Check, CircleNotch, Download, FileHtml, FileText, FileZip, Globe, Key, Lock, LockOpen, Note, Upload, AddressBook, NEW_GLYPHS } from '../icons';
import { goesToCalendarFile } from '../schedule';
import { fetchQuotaUsage, recalculateQuota } from '../devices';
import { estimateNoteStoredBytes, estimateBlobBytes } from '../notesViewUtils';
import { proUnlocked } from '../demo';
import { savedToFinalIds } from '../backupRestore';
import { RESTORE_WAIT_LINE, restoreGateNow, useRestoreGate, type RestoreGate } from '../pullState';
import { formatBytes } from '../formatBytes';
import { textMatcher } from '../textMatch';
import { useEscapeToClose } from '../useEscapeToClose';
import { perFileLimit } from '../attachmentValidation';
import { contactPhotoOptions, processImage } from '../imageProcessing';
import { SETTINGS_BTN, SETTINGS_HELP, SectionEyebrow, SettingsCallout, SettingsTabStrip, StatTile, settingsTabClass, ROW_TITLE, SETTINGS_CARD as CARD, SETTINGS_CARD_GRID as CARD_GRID, SETTINGS_CARD_REST as CARD_REST, SettingsCardIcon as RowIcon } from '../settingsUI';
import { Button, Callout, Checkbox, ListSearchInput, Modal, Select, Spinner, TextField } from '../ui';
import { calendarFeedUrl, downloadCalendarFeed } from './calendarFeed';
import { ClipError, type ClipErrorReason } from '../clipDownload';
import { activeLocale } from '../languages';
import { helpPath } from '../localeRoutes';
import { siteHref } from '../siteLinks';
import { HelpChip } from '../HelpChip';
import { WellnessExportTab } from '../stats/WellnessExport';
import { IconUpgrade } from '../UpgradeModal';
import { usePaneTab } from '../settingsPaneTab';

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

/** Per-note stored-bytes estimate via the shared server-cost estimator
 *  (UTF-8 measured, base64-expanded: estimating from UTF-16 length x1.4
 *  undercounts CJK imports by ~3x, so the "will not fit" gate would never
 *  fire for exactly the imports most likely to blow the quota). */
function estimateImportBytes(notes: ImportedNote[]): number {
  let total = 0;
  for (const n of notes) {
    total += estimateNoteStoredBytes(n.title ?? '', n.body ?? '', n.tags ?? []);
  }
  return total;
}

type QuotaCheck = {
  estimatedBytes: number;
  availableBytes: number;
  exceeds: boolean;
};

/**
 * What an address book's photos will cost once the app sizes them down.
 * `bytes` is measured from a sample of the actual file, never taken from a
 * table: contact photo sizes vary by two orders of magnitude between an
 * OEM contacts app and an iPhone. `fits` is decided BEFORE anything is
 * written, so the contacts land and the photos are declined as one whole,
 * never half of them followed by a quota error.
 * Spec: docs/internal/specs/contacts-pillar.md (section 7.4)
 */
type PhotoEstimate = {
  count: number;
  bytes: number;
  /** null when the quota could not be read (offline, demo). */
  available: number | null;
  fits: boolean;
};

/** How many photos the estimate compresses to find the median. */
const PHOTO_SAMPLE = 20;

async function sampleContactPhotos(parsed: ParsedImport): Promise<{ count: number; bytes: number } | null> {
  const photos = [...(parsed.blobs?.values() ?? [])].filter((b) => b.ceiling === 'contact');
  if (photos.length === 0) return null;
  const step = Math.max(1, Math.floor(photos.length / PHOTO_SAMPLE));
  const sizes: number[] = [];
  for (let i = 0; i < photos.length && sizes.length < PHOTO_SAMPLE; i += step) {
    const b = photos[i]!;
    const result = await processImage(new File([b.data as BlobPart], b.name, { type: b.mime }), contactPhotoOptions());
    sizes.push(result.ok ? result.image.sizeBytes : b.data.length);
  }
  sizes.sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  return { count: photos.length, bytes: estimateBlobBytes(median) * photos.length };
}

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

// Map importer ids to the short source keys we record in admin_events.
// The registry uses kebab-case slugs that happen to match 1:1 - this
// cast is just the type narrowing and keeps the set of sources honest.
function importerIdToSource(id: string): ImportSource | null {
  const known: ImportSource[] = [
    'google-keep',
    'standard-notes',
    'obsidian',
    'notesnook',
    'apple-notes',
    'apple-journal',
    'samsung-notes',
    'simplenote',
    'markdown-folder',
    'privacynotes',
    'browser-bookmarks',
    'browser-passwords',
  ];
  return (known as string[]).includes(id) ? (id as ImportSource) : null;
}

/**
 * Import / Export modal - tabbed shell.
 *
 * Import tab - three-phase flow:
 *   1. pick   → choose which importer to run
 *   2. parse  → user picks a file; we read, parse, show preview + warnings
 *   3. apply  → user confirms; we write to Dexie, close, parent triggers sync
 *
 * Export tab - the whole-set exports (.zip of md, .zip of html, .json
 * backup, encrypted variants), plus the bookmarks-only and vault-only
 * writers when there is something for them to write. Callbacks come from
 * the parent so the telemetry wrapper stays in one place.
 *
 * The parent wires an `onImported` callback that refreshes the notes
 * list and kicks off a sync. No server writes happen inside this modal -
 * all encryption / upload goes through the normal sync pass.
 */
export function ImportModal({
  onClose,
  onImported,
  initialTab = 'import',
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
}: {
  onClose: () => void;
  onImported: (count: number, skippedDuplicates?: number, repaired?: RestoreCounts) => void;
  /** Render inline as a settings pane (no overlay, no own header/escape). */
  embedded?: boolean;
  /** The tracker data for the Wellness tab; without it the tab is not shown. */
  wellness?: Omit<ComponentProps<typeof WellnessExportTab>, 'notes' | 'Row'>;
  initialTab?: 'import' | 'export' | 'restore' | 'wellness';
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
  onImportEncrypted: (file: File) => Promise<RestoreCounts & { imported: number }>;
  onExportEncryptedZip: (ns: LocalNote[]) => void;
  /** Decrypts a .pnbackupz into the plain full-backup zip; the modal
   *  then runs the normal zip restore flow on the result. */
  decryptFullBackup: (file: File) => Promise<File>;
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
  /** Our own full backup: merge the looks and custom themes it carries,
   *  with each folder look moved from its saved folder id to the final one. */
  onImportSettings?: (
    settings: { itemStyles?: unknown; customThemes?: unknown },
    savedToFinal: ReadonlyMap<string, string>,
  ) => void;
}) {
  const { t } = useTranslation('importExport');
  const { auth, supabase } = useAuth();
  const isPro = auth.status === 'authenticated' ? auth.isPro : false;
  type Phase =
    | { kind: 'pick' }
    | { kind: 'parsing'; importer: Importer; status: string }
    | { kind: 'preview'; importer: Importer; parsed: ParsedImport; file: { name: string; size: number } }
    | { kind: 'applying'; importer: Importer }
    | { kind: 'error'; importer: Importer; message: string };

  const [tab, setTab] = usePaneTab<'import' | 'export' | 'restore' | 'wellness'>('importExport', initialTab);
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const restoreGate = useRestoreGate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Keep the raw file around so restoreBlobs can re-read it after applyImport. */
  const selectedFileRef = useRef<File | null>(null);
  const [activeImporter, setActiveImporter] = useState<Importer | null>(null);
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

  function handlePickImporter(importer: Importer) {
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

  /** Parse one file through one importer: progress, quota preflight,
   *  oversize warnings, preview. The picker enters here with the chosen
   *  file; the .pnbackupz restore enters with the DECRYPTED zip, so the
   *  sealed backup reuses the whole flow, blob restore included. */
  async function runParseFlow(importer: Importer, file: File) {
    selectedFileRef.current = file;

    setPhase({
      kind: 'parsing',
      importer,
      status: t('status.readingFile'),
    });

    try {
      const parsed = await importer.parse(file, (msg) =>
        setPhase((prev) =>
          prev.kind === 'parsing' ? { ...prev, status: msg } : prev
        )
      );
      // Quota preflight - best-effort. If the RPC fails, leave
      // quotaCheck null and let the server enforce on push.
      // The same pass counts blobs over the PER-FILE cap, which the total
      // quota says nothing about: an oversized file imports to this device
      // fine and is then refused by the server on upload, so without this
      // it would sit here looking imported and silently never reach any
      // other device. Journal exports carry video, which is where this
      // bites first, but it is true of every importer that ships blobs.
      let oversize = 0;
      let capLabel = '';
      // Measured before the quota is read, so the row can still show the
      // count and the size when the quota read fails.
      const photos = await sampleContactPhotos(parsed);
      setPhotoEstimate(photos ? { ...photos, available: null, fits: true } : null);
      setImportPhotos(true);
      try {
        // Recalculate before reading: the counter can trail a delete the
        // user just made, promising space the next recalc takes back.
        // Best-effort - a failed recalc still leaves a usable read.
        await recalculateQuota(supabase).catch(() => {});
        const usage = await fetchQuotaUsage(supabase, isPro);
        const available = Math.max(
          0,
          usage.maxTotalBytes - usage.totalBytes - usage.imageBytes,
        );
        // Blob costs: per-blob encryption overhead when the parsed blob set
        // is available, else the raw byte total.
        // A contact photo is shrunk before it is stored, so it costs what the
        // sample measured, not its raw bytes, and it costs nothing when it is
        // declined for not fitting.
        const photosFit = photos ? photos.bytes <= available : true;
        if (photos) {
          setPhotoEstimate({ ...photos, available, fits: photosFit });
          setImportPhotos(photosFit);
        }
        let blobBytes = photos && photosFit ? photos.bytes : 0;
        if (parsed.blobs && parsed.blobs.size > 0) {
          for (const blob of parsed.blobs.values()) {
            if (blob.ceiling === 'contact') continue;
            blobBytes += estimateBlobBytes(blob.data.length);
          }
        } else {
          blobBytes = parsed.blobBytes ?? 0;
        }
        const estimatedBytes = estimateImportBytes(parsed.notes) + blobBytes;
        setQuotaCheck({
          estimatedBytes,
          availableBytes: available,
          exceeds: estimatedBytes > available,
        });
        const cap = perFileLimit(
          proUnlocked(isPro),
          usage.maxTotalBytes > 500 * 1000 * 1000,
        );
        for (const blob of parsed.blobs?.values() ?? []) {
          if (blob.ceiling === 'contact') continue;
          if (blob.data.length > cap) oversize++;
        }
        capLabel = formatBytes(cap);
      } catch {
        setQuotaCheck(null);
      }
      setPhase({
        kind: 'preview',
        importer,
        file: { name: file.name, size: file.size },
        parsed:
          oversize > 0
            ? {
                ...parsed,
                warnings: [
                  ...parsed.warnings,
                  t('preview.oversizeAttachments', { count: oversize, limit: capLabel }),
                ],
              }
            : parsed,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('notesChrome:burnView.error.heading');
      setPhase({ kind: 'error', importer, message });
    }
  }

  /** The "Add to" folder; a new one it makes goes into `made`. */
  function resolveDestination(importer: Importer, made: string[]): string | null {
    if (!importTarget || destination === 'none') return null;
    if (destination === 'new') {
      const folder = onCreateImportFolder?.(sourceLabel(importer, t)) ?? null;
      if (folder?.created) made.push(folder.id);
      return folder?.id ?? null;
    }
    return importTarget.folders.some((f) => f.id === destination.folderId) ? destination.folderId : null;
  }

  async function handleConfirm() {
    if (phase.kind !== 'preview') return;
    const { importer, parsed } = phase;
    // Our own backups match their notes by id against this device's copy, so
    // they wait for its first clean pull, before the folder merge below or
    // any other write (pullState.ts).
    if (importer.id === 'privacynotes') {
      const gate = restoreGateNow();
      if (gate !== 'open') {
        setPhase({ kind: 'error', importer, message: t(RESTORE_WAIT_LINE[gate]) });
        return;
      }
    }
    setPhase({ kind: 'applying', importer });
    // What this run made before its notes landed, taken back if they do not
    // (backlog 217). The files need nothing here: they land in the notes'
    // own write. A throw anywhere ends on the error screen, never on
    // "applying".
    const madeFolders: string[] = [];
    let notesWritten = false;
    try {
      // Obsidian vaults, Notesnook notebooks and our own backups rebuild a
      // folder tree: merge it into settings so notes' folderId pointers
      // resolve, then derive folder tags per the toggle (see folderImport).
      let notesForApply = parsed.notes;
      // A restore keeps the backup's own folders, so the row is for other apps.
      const target = importer.id === 'privacynotes' ? null : resolveDestination(importer, madeFolders);
      // The settings wait for the notes (below); a folder look follows its
      // folder there.
      let savedToFinal: ReadonlyMap<string, string> = new Map();
      if (parsed.folders && parsed.folders.length > 0) {
        // Merge the tree into settings (reusing existing folders) and remap
        // note folderIds to the ids that survived reconciliation.
        const merged = onImportFolders?.(parsed.folders, parsed.originalFolderIds, target);
        if (merged) madeFolders.push(...merged.created);
        const idMap = merged?.idMap;
        const remapped =
          idMap && idMap.size > 0
            ? parsed.notes.map((n) =>
                n.folderId && idMap.has(n.folderId)
                  ? { ...n, folderId: idMap.get(n.folderId)! }
                  : n
              )
            : parsed.notes;
        // The toggle lives on the Import tab. A restore puts notes back as the
        // backup holds them, and its preview counts no folder tags, so a
        // backup takes none.
        notesForApply = importer.id === 'privacynotes'
          ? remapped
          : withFolderPathTags(remapped, folderTags);
        // A folder look moves with its folder: saved id, to rebuilt id, to
        // the id the merge kept.
        savedToFinal = savedToFinalIds(parsed.originalFolderIds, idMap);
      }
      notesForApply = fileUnfiled(notesForApply, target);
      notesForApply = withBrowserTags(notesForApply, browserTags);
      // A note color from the source (Google Keep) becomes a tag named after
      // the color, in the reader's language, and that tag takes the color:
      // colors live on tags here, never on a note.
      // Spec: docs/internal/specs/folder-tag-icons.md (section 4.7)
      const colorTags = new Map<string, string>();
      if (notesForApply.some((n) => n.colorKey)) {
        notesForApply = notesForApply.map((n) => {
          if (!n.colorKey) return n;
          const tag = normalizeTag(t(`editor:color.names.${n.colorKey}`));
          if (!tag) return n;
          colorTags.set(tag, n.colorKey);
          return n.tags.includes(tag) ? n : { ...n, tags: [...n.tags, tag] };
        });
      }
      if (splitOversize && notesForApply.some(isOversizeImport)) {
        notesForApply = notesForApply.flatMap((n) =>
          isOversizeImport(n)
            ? splitImportedNote(
                n,
                (index, total) => t('preview.partTitle', { title: n.title || t('common:state.untitled'), index, total }),
                (title) => t('notes:split.continuedIn', { link: `[[${title}]]` }),
              )
            : [n],
        );
      }
      let parsedForApply =
        notesForApply === parsed.notes
          ? parsed
          : { ...parsed, notes: notesForApply };
      // Declined photos leave with their references: a body that still names
      // a blob nobody stored would carry a dead photo key forever.
      if (photoEstimate && (!importPhotos || !photoEstimate.fits)) {
        parsedForApply = withoutContactPhotos(parsedForApply);
      }
      // A media failure must never sink into a console.warn: that makes the
      // worst outcome the quietest one, where the notes land, every image
      // reference stays an un-rewritten placeholder token, and the modal
      // closes on a success toast with nothing on screen saying the pictures
      // are gone. Both blob paths below record the reason, and the modal
      // stays open on it - the notes land either way, so this is reported ON
      // TOP of a real import, never instead of one.
      let mediaError: string | null = null;
      // A backup that lists a picture or a file and does not carry it is
      // reported the same way.
      let missingMessage: string | null = null;

      // Generic blob import: any importer that populates parsed.blobs gets
      // its images/attachments staged and its note bodies rewritten to
      // pn:img/ and pn:file/ URIs. It runs BEFORE the notes are written,
      // because a row written with a placeholder can be picked up and sent by
      // a sync pass before the rewrite lands, and the rewrite moves no
      // timestamp for that pass to notice (see blobImport.ts). The staged
      // files land in the notes' own write, so a failed write keeps neither.
      // parsedForApply, not parsed: a contact photo the user declined is
      // filtered out of both by then, so it is never stored either.
      let staged: StagedBlob[] = [];
      if (parsedForApply.blobs && parsedForApply.blobs.size > 0) {
        setPhase({
          kind: 'parsing',
          importer,
          status: t('status.importingBlobs'),
        });
        try {
          const { importBlobs } = await import('./blobImport');
          const media = await importBlobs(parsedForApply.blobs, parsedForApply.notes, (msg) =>
            setPhase((prev) =>
              prev.kind === 'parsing' ? { ...prev, status: msg } : prev
            )
          );
          parsedForApply = { ...parsedForApply, notes: media.notes };
          staged = media.staged;
        } catch (err) {
          console.warn('Blob import failed:', err);
          mediaError = err instanceof Error ? err.message : String(err);
        }
        setPhase({ kind: 'applying', importer });
      }

      const tag = autoTag && importer.sourceTag ? importer.sourceTag : undefined;
      const result = await applyImport(parsedForApply, tag, staged);
      if (result.errors.length > 0) {
        onUndoImportFolders?.(madeFolders);
        setPhase({
          kind: 'error',
          importer,
          message: t('errors.importNothingChanged', { detail: result.errors.join('\n') }),
        });
        return;
      }
      notesWritten = true;
      // Settings and tag colors have no undo, so they wait for the notes.
      if (parsed.settings) onImportSettings?.(parsed.settings, savedToFinal);
      if (colorTags.size > 0) onImportTagColors?.(colorTags);
      if (staged.length > 0) onBlobsRestored?.();

      // For PrivacyNotes full backups, restore images + attachments from
      // the zip (uses manifest-based restoration, not parsed.blobs).
      if (importer.id === 'privacynotes' && selectedFileRef.current) {
        setPhase({
          kind: 'parsing',
          importer,
          status: t('status.restoringBlobs'),
        });
        try {
          const { restoreBlobs } = await import('./privacynotes');
          const restored = await restoreBlobs(selectedFileRef.current, (msg) =>
            setPhase((prev) =>
              prev.kind === 'parsing' ? { ...prev, status: msg } : prev
            )
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
      console.warn('Import failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      if (!notesWritten) onUndoImportFolders?.(madeFolders);
      setPhase({
        kind: 'error',
        importer,
        message: notesWritten ? detail : t('errors.importNothingChanged', { detail }),
      });
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
      title={tab === 'import' ? t('shell.importTitle') : tab === 'export' || tab === 'wellness' ? t('shell.exportTitle') : t('shell.restoreTitle')}
      header="bar"
      className="max-w-lg max-h-[85vh] flex flex-col"
    >
        <SettingsTabStrip
          role="tablist"
          aria-label={t('shell.tablistLabel')}
          className="shrink-0 px-4 sm:px-6"
        >
          {([
            { id: 'import' as const, setting: 'import.import', label: t('shell.tabImport'), icon: <Download aria-hidden="true" /> },
            { id: 'export' as const, setting: 'import.export', label: t('shell.tabExport'), icon: <Upload aria-hidden="true" /> },
            { id: 'restore' as const, setting: 'import.restore', label: t('shell.tabRestore'), icon: <ArrowCounterClockwise aria-hidden="true" /> },
            // Shown when the pane has the tracker data to export.
            ...(wellness ? [{ id: 'wellness' as const, setting: 'import.wellness', label: t('notes:settings.trackersLabel'), icon: <Heartbeat aria-hidden="true" /> }] : []),
          ]).map((tb) => (
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
                  destinationRow={importTarget && phase.importer.id !== 'privacynotes' && (
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
                />
              )}
            </>
          ) : tab === 'restore' ? (
            <>
              {phase.kind === 'pick' && (
                <RestorePickPhase
                  gate={restoreGate}
                  onPickRestore={handlePickImporter}
                  onImportEncrypted={async (file) => {
                    // A .pnbackupz is the full-backup zip sealed under
                    // the phrase key: decrypt, then run the NORMAL zip
                    // restore flow, preview and blob restore included.
                    if (file.name.toLowerCase().endsWith('.pnbackupz')) {
                      const imp = IMPORTERS.find((i) => i.id === 'privacynotes');
                      if (!imp) return;
                      setPhase({ kind: 'parsing', importer: imp, status: t('status.decryptingBackup') });
                      try {
                        const zipFile = await decryptFullBackup(file);
                        await runParseFlow(imp, zipFile);
                      } catch (err) {
                        setPhase({
                          kind: 'error',
                          importer: imp,
                          message: err instanceof Error ? err.message : t('errors.decryptionFailed'),
                        });
                      }
                      return;
                    }
                    setPhase({ kind: 'parsing', importer: { id: 'privacynotes', label: t('encryptedBackupLabel'), description: '', accept: '.pnbackup', enabled: true, sourceTag: '', parse: async () => { throw new Error(); } }, status: t('status.decryptingBackup') });
                    try {
                      const counts = await onImportEncrypted(file);
                      onImported(counts.imported, undefined, { updated: counts.updated, unchanged: counts.unchanged });
                      onClose();
                    } catch (err) {
                      setPhase({
                        kind: 'error',
                        importer: { id: 'privacynotes', label: t('encryptedBackupLabel'), description: '', accept: '.pnbackup', enabled: true, sourceTag: '', parse: async () => { throw new Error(); } },
                        message: err instanceof Error ? err.message : t('errors.decryptionFailed'),
                      });
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
                <ErrorPhase importerLabel={sourceLabel(phase.importer, t)} message={phase.message} />
              )}
            </>
          ) : tab === 'wellness' && wellness ? (
            <WellnessExportTab notes={notes} {...wellness} Row={ActionRow} />
          ) : (
            // The window stays open after an export: a daily routine writes
            // more than one backup, and the progress window sits above it.
            <ExportPanel
              notes={notes}
              onExportAllMdZip={onExportAllMdZip}
              onExportAllHtmlZip={onExportAllHtmlZip}
              onExportAllJson={onExportAllJson}
              onExportEncrypted={onExportEncrypted}
              onExportEncryptedZip={onExportEncryptedZip}
              onExportBookmarks={onExportBookmarks}
              onExportContacts={onExportContacts}
              onExportCalendar={onExportCalendar}
              onExportDrawings={onExportDrawings}
              onExportVault={onExportVault}
            />
          )}
        </div>

        {/* A picking tab needs no footer: the X closes the window, and a lone
            line there reads as stray text. The footer comes back while an
            import runs, for Back and Import. */}
        {!(tab === 'export' || tab === 'wellness' || phase.kind === 'pick') && (
        <div className="px-6 py-3 border-t border-divider flex items-center justify-between gap-3">
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
        </div>
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

/** Importers drawn with a phosphor glyph instead of a brand asset, for a
 *  source no single vendor owns. */
const IMPORT_GLYPH: Record<string, ReactNode> = {
  // A key, matching the sidebar's Vault pillar. No browser logo: the same
  // .csv comes out of all of them.
  'browser-passwords': <Key size={20} aria-hidden="true" />,
  // The address book, matching the Contacts pillar: every phone writes the
  // same .vcf, so no vendor's logo fits.
  'vcard': <AddressBook size={20} aria-hidden="true" />,
  // The drawing glyph the app draws everywhere, for a format two apps write.
  'excalidraw': <NEW_GLYPHS.drawing size={20} aria-hidden="true" />,
};

/** App icons for the note importers, reused from the /help import guides
 *  (public/help/icons). markdown-folder maps to the generic markdown mark. */
const IMPORT_ICON: Record<string, string> = {
  // Every browser writes the same bookmarks file, so this row's icon is
  // the one that is not the source app's own logo: the Chrome mark stands
  // in for "your browser" and the description names the other six. Same
  // asset as the /help guide tile and the homepage import pill.
  'browser-bookmarks': '/help/icons/browser-bookmarks.svg',
  'google-keep': '/help/icons/google-keep.svg',
  'google-calendar': '/help/icons/google-calendar.svg',
  'apple-notes': '/help/icons/apple-notes.svg',
  'apple-journal': '/help/icons/apple-journal.webp',
  'bear': '/help/icons/bear.webp',
  'evernote': '/help/icons/evernote.svg',
  'samsung-notes': '/help/icons/samsung-notes.webp',
  'simplenote': '/help/icons/simplenote.svg',
  'standard-notes': '/help/icons/standard-notes.webp',
  'obsidian': '/help/icons/obsidian.svg',
  'notesnook': '/help/icons/notesnook.svg',
  'joplin': '/help/icons/joplin.svg',
  'upnote': '/help/icons/upnote.svg',
  'markdown-folder': '/help/icons/markdown.svg',
  'bitwarden': '/help/icons/bitwarden.svg',
  'typora': '/help/icons/typora.webp',
  'ia-writer': '/help/icons/ia-writer.webp',
  'zettlr': '/help/icons/zettlr.svg',
  'nextcloud-notes': '/help/icons/nextcloud-notes.svg',
};

/** Maps importer ids to their /help/import/<slug>/ guide slug. Slugs match
 *  ids 1:1 except markdown-folder, whose guide lives under "markdown". */
const GUIDE_SLUG: Record<string, string> = {
  'apple-journal': 'apple-journal',
  'browser-bookmarks': 'browser-bookmarks',
  'apple-notes': 'apple-notes',
  'bear': 'bear',
  'bitwarden': 'bitwarden',
  'browser-passwords': 'browser-passwords',
  'vcard': 'contacts',
  'evernote': 'evernote',
  'google-keep': 'google-keep',
  'google-calendar': 'google-calendar',
  'joplin': 'joplin',
  'markdown-folder': 'markdown',
  'typora': 'typora',
  'ia-writer': 'ia-writer',
  'zettlr': 'zettlr',
  'nextcloud-notes': 'nextcloud-notes',
  'notesnook': 'notesnook',
  'obsidian': 'obsidian',
  'samsung-notes': 'samsung-notes',
  'simplenote': 'simplenote',
  'standard-notes': 'standard-notes',
  'upnote': 'upnote',
};

/** Maps importer ids to their description translation key under sourceDesc. */
/**
 * The few importer labels that are OUR wording rather than the source
 * application's own name.
 *
 * An importer's `label` renders raw, because "Obsidian" is Obsidian in every
 * language. Five of them are not brands, and each already had a translation
 * sitting in `guides.json` for its help page, so the picker said "Browser
 * bookmarks" while the guide one click away said "Signets du navigateur".
 * `guides.json` is build-only (the static help site reads it off disk; it is
 * excluded from the runtime catalog glob in i18n.ts), so the wording is
 * repeated here in a catalog the app actually loads.
 *
 * An id ABSENT from this map is a brand name and renders as written. That is
 * what makes the map readable: it is the list of labels that are ours.
 */
const SOURCE_LABEL_KEY: Record<string, string> = {
  'privacynotes': 'sourceLabel.privacynotes',
  'browser-bookmarks': 'sourceLabel.browserBookmarks',
  'browser-passwords': 'sourceLabel.browserPasswords',
  'vcard': 'sourceLabel.vcard',
  'markdown-folder': 'sourceLabel.markdownFolder',
};

/** An importer's name in the reader's language, or its brand name unchanged. */
function sourceLabel(imp: Importer, t: TFunction): string {
  const key = SOURCE_LABEL_KEY[imp.id];
  return key ? t(key) : imp.label;
}

const SOURCE_DESC_KEY: Record<string, string> = {
  'browser-bookmarks': 'sourceDesc.browserBookmarks',
  'vcard': 'sourceDesc.vcard',
  'google-keep': 'sourceDesc.googleKeep',
  'google-calendar': 'sourceDesc.googleCalendar',
  'excalidraw': 'sourceDesc.excalidraw',
  'apple-notes': 'sourceDesc.appleNotes',
  'apple-journal': 'sourceDesc.appleJournal',
  'bear': 'sourceDesc.bear',
  'evernote': 'sourceDesc.evernote',
  'samsung-notes': 'sourceDesc.samsungNotes',
  'simplenote': 'sourceDesc.simplenote',
  'standard-notes': 'sourceDesc.standardNotes',
  'obsidian': 'sourceDesc.obsidian',
  'notesnook': 'sourceDesc.notesnook',
  'joplin': 'sourceDesc.joplin',
  'upnote': 'sourceDesc.upnote',
  'markdown-folder': 'sourceDesc.markdownFolder',
  // One shared line for the four markdown-app aliases: the parser is the
  // same, so four near-identical descriptions would be four copies to keep
  // in step across every locale. What differs per app is in its guide, one
  // click away in the row's guide rail.
  'typora': 'sourceDesc.markdownApp',
  'ia-writer': 'sourceDesc.markdownApp',
  'zettlr': 'sourceDesc.markdownApp',
  'nextcloud-notes': 'sourceDesc.markdownApp',
  'bitwarden': 'sourceDesc.bitwarden',
  'browser-passwords': 'sourceDesc.browserPasswords',
};

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

/** The panel of the open tile: what the old row showed (the name, the
 *  description) and its actions. It spans the whole grid row; the grid's
 *  dense flow moves the rest of the tile's row up above it. */
function SourcePanel({ id, label, desc, children }: { id: string; label: string; desc: ReactNode; children: ReactNode }) {
  return (
    <div id={id} role="region" aria-label={label} className="col-span-full rounded-lg border border-divider bg-surface-1 px-3 py-2.5">
      <span className={`block ${ROW_TITLE}`}>{label}</span>
      <span className="block text-small text-pn-soft mt-0.5">{desc}</span>
      <div className="mt-2.5 flex flex-wrap items-start gap-2">{children}</div>
    </div>
  );
}

/** The panel actions of one importer: Import opens the file picker, Guide
 *  opens its /help/import/<slug>/ page when one exists. */
function ImporterActions({ imp, onPick }: { imp: Importer; onPick: (imp: Importer) => void }) {
  const { t } = useTranslation('importExport');
  const guideSlug = GUIDE_SLUG[imp.id];
  return (
    <>
      <Button variant="primary" icon={<Download aria-hidden="true" />} onClick={() => onPick(imp)}>
        {t('webcal.import')}
      </Button>
      {guideSlug && (
        <a
          href={siteHref(`${helpPath(activeLocale())}/import/${guideSlug}`)}
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

/** The message for a calendar address that did not download. */
const FEED_ERROR: Record<ClipErrorReason, string> = {
  'refused': 'webcal.errors.refused',
  'wrong-type': 'webcal.errors.wrongType',
  'too-large': 'webcal.errors.tooLarge',
  'timeout': 'webcal.errors.timeout',
  'blocked': 'webcal.errors.blocked',
  'offline': 'webcal.errors.offline',
  'limit': 'webcal.errors.limit',
  'demo-limit': 'webcal.errors.limit',
  'failed': 'webcal.errors.failed',
};

/** The Webcal form: a calendar address, downloaded once and handed to the
 *  calendar import as a file. It sits in the Webcal tile's panel. The address is never kept or shown back in a
 *  message. Spec: docs/internal/issues/0548.md (Spec, design A) */
function CalendarFeedForm({ onFile }: { onFile: (file: File) => void }) {
  const { t } = useTranslation('importExport');
  const { supabase } = useAuth();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const url = calendarFeedUrl(address);
    if (!url) {
      setError(t('webcal.errors.invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const file = await downloadCalendarFeed(url, async () => (await supabase.auth.getSession()).data.session?.access_token ?? null);
      onFile(file);
    } catch (err) {
      setError(t(FEED_ERROR[err instanceof ClipError ? err.reason : 'failed']));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="min-w-0 flex-1">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            size="sm"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('webcal.fieldLabel')}
            placeholder="webcal://"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setError(null);
            }}
            error={error ?? undefined}
            className="w-full"
          />
        </div>
        <Button type="submit" variant="primary" icon={busy ? <Spinner size={15} className="text-current" /> : <Download aria-hidden="true" />} disabled={busy || !address.trim()}>
          {busy ? t('webcal.downloading') : t('webcal.import')}
        </Button>
      </div>
    </form>
  );
}

/** The file types a source card names under its title: the extensions the
 *  person's export writes, so the card says which file to make before the
 *  click. Extensions only, so the line needs no translation. An importer
 *  that also takes another type to refuse it with a message (Notesnook's
 *  .nnbackupz) leaves that one out. */
const FILE_TYPES: Record<string, string> = {
  'apple-journal': '.zip',
  'apple-notes': '.zip',
  'bear': '.bear2bk, .zip',
  'bitwarden': '.json',
  'browser-bookmarks': '.html, .zip',
  'browser-passwords': '.csv, .zip',
  'evernote': '.enex, .zip',
  'excalidraw': '.excalidraw, .zip',
  'google-calendar': '.ics, .zip',
  'google-keep': '.zip, .json',
  'ia-writer': '.zip',
  'joplin': '.jex, .zip',
  'markdown-folder': '.md, .txt, .zip',
  'nextcloud-notes': '.zip',
  'notesnook': '.zip',
  'obsidian': '.zip',
  'samsung-notes': '.docx, .txt, .zip',
  'simplenote': '.zip, .json',
  'standard-notes': '.zip, .txt',
  'typora': '.zip',
  'upnote': '.zip, .html, .md',
  'vcard': '.vcf',
  'zettlr': '.zip',
  webcal: 'webcal://',
};

/** Import tab: a search field over a card per source in three groups, the
 *  note apps first, then calendar, contacts and bookmarks, then passwords.
 *  The search reads the name and the file types, so ".enex" finds Evernote.
 *  The descriptions live in the panel a card opens.
 *  Spec: docs/internal/design/patterns/151-160.md (section 157) */
function ImportPickPhase({ onPick, onCalendarFeed }: { onPick: (imp: Importer) => void; onCalendarFeed: (file: File) => void }) {
  const { t } = useTranslation('importExport');
  const importerMap = Object.fromEntries(IMPORTERS.map((i) => [i.id, i]));
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Escape empties a typed search before it closes Settings.
  useEscapeToClose(() => setQuery(''), query !== '');
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  // The password importers had a tab of their own that people did not find,
  // and then sat among the general sources (#608); they get a group of their
  // own. Each group is alphabetical.
  const groups = [
    { key: 'notes', icon: Note, title: t('shell:tagsRail.notes'), ids: ['apple-journal', 'apple-notes', 'bear', 'evernote', 'excalidraw', 'google-keep', 'ia-writer', 'joplin', 'markdown-folder', 'nextcloud-notes', 'notesnook', 'obsidian', 'samsung-notes', 'simplenote', 'standard-notes', 'typora', 'upnote', 'zettlr'] },
    { key: 'calendar', icon: CalendarDots, title: t('importPick.groupCalendar'), ids: ['browser-bookmarks', 'vcard', 'google-calendar', WEBCAL_ID] },
    { key: 'passwords', icon: Key, title: t('shell.tabVault'), ids: ['bitwarden', 'browser-passwords'] },
  ];
  const panelId = (id: string) => `import-panel-${id}`;
  const labelOf = (id: string) => (id === WEBCAL_ID ? t('webcal.title') : importerMap[id] ? sourceLabel(importerMap[id], t) : '');
  const match = query.trim() ? textMatcher(query) : null;
  const matches = (id: string) => !match || !!match(labelOf(id)) || !!match(FILE_TYPES[id] ?? '');

  // A card, then its panel right after it when open: the panel spans the
  // row, and `grid-flow-dense` fills the rest of the card's row from the
  // cards that follow, so the panel opens under the row and comes next in
  // the Tab order.
  const cells = (id: string) => {
    const open = openId === id;
    if (id === WEBCAL_ID) {
      return (
        <Fragment key={id}>
          <SourceTile
            data-setting="import.webcal"
            icon={<RowIcon glyph={<Globe size={20} aria-hidden="true" />} />}
            label={t('webcal.title')}
            detail={FILE_TYPES[id] ?? ''}
            open={open}
            panelId={panelId(id)}
            onToggle={() => toggle(id)}
          />
          {open && (
            <SourcePanel id={panelId(id)} label={t('webcal.title')} desc={t('webcal.desc')}>
              <CalendarFeedForm onFile={onCalendarFeed} />
            </SourcePanel>
          )}
        </Fragment>
      );
    }
    const imp = importerMap[id];
    if (!imp) return null;
    const descKey = SOURCE_DESC_KEY[imp.id];
    return (
      <Fragment key={id}>
        <SourceTile
          data-setting={`import.source.${imp.id}`}
          icon={<RowIcon src={IMPORT_ICON[imp.id]} glyph={IMPORT_GLYPH[imp.id]} />}
          label={sourceLabel(imp, t)}
          detail={FILE_TYPES[imp.id] ?? ''}
          open={open}
          panelId={panelId(id)}
          disabled={!imp.enabled}
          onToggle={() => toggle(id)}
        />
        {open && (
          <SourcePanel id={panelId(id)} label={sourceLabel(imp, t)} desc={descKey ? t(descKey) : imp.description}>
            <ImporterActions imp={imp} onPick={onPick} />
          </SourcePanel>
        )}
      </Fragment>
    );
  };
  const shown = groups.map((g) => ({ ...g, ids: g.ids.filter(matches) })).filter((g) => g.ids.length > 0);

  return (
    <div className="space-y-3">
      <ListSearchInput value={query} onChange={setQuery} placeholder={t('importPick.searchPlaceholder')} ariaLabel={t('importPick.searchPlaceholder')} />
      {shown.map((g) => (
        <SourceGroup key={g.key} icon={g.icon} title={g.title}>{g.ids.map(cells)}</SourceGroup>
      ))}
      {shown.length === 0 && (
        // Most note apps can write plain Markdown, which the Markdown
        // importer reads, so a search with no match ends on that card.
        <SourceGroup title={t('importPick.noMatch')}>{cells('markdown-folder')}</SourceGroup>
      )}
    </div>
  );
}

/** The Webcal tile's id: not an importer, it downloads a calendar address
 *  and hands the file to the Google Calendar importer. */
const WEBCAL_ID = 'webcal';

/** Restore tab pick phase - PrivacyNotes backup restore, 1-col with full descriptions. */
function RestorePickPhase({ gate, onPickRestore, onImportEncrypted }: {
  gate: RestoreGate;
  onPickRestore: (imp: Importer) => void;
  onImportEncrypted: (file: File) => void;
}) {
  const { t } = useTranslation('importExport');
  const encFileRef = useRef<HTMLInputElement | null>(null);
  const importerMap = Object.fromEntries(IMPORTERS.map((i) => [i.id, i]));

  return (
    <div className="space-y-3">
      <p className={SETTINGS_HELP}>
        {t('restorePick.intro')}
      </p>

      {gate !== 'open' && <SettingsCallout>{t(RESTORE_WAIT_LINE[gate])}</SettingsCallout>}

      <div className="space-y-1.5">
        <ActionRow
          setting="restore.fullBackup"
          title={t('restorePick.fullBackupTitle')}
          description={t('restorePick.fullBackupDesc')}
          glyph={<FileZip size={20} aria-hidden="true" />}
          disabled={gate !== 'open'}
          onClick={() => {
            const imp = importerMap['privacynotes'];
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
        <CircleNotch size={32} className="animate-spin text-accent" />
      </div>
      <div className="text-body font-medium">{importerLabel}</div>
      <div className="text-small text-pn-muted mt-1">
        {status}
      </div>
    </div>
  );
}

/** Derive type-aware counts from notes at render time. */
function computeTypeCounts(notes: ImportedNote[]): { label: string; count: number }[] {
  let noteCount = 0;
  let journalCount = 0;
  let loginCount = 0;
  let cardCount = 0;
  let sshKeyCount = 0;
  let contactCount = 0;
  let drawingCount = 0;
  for (const n of notes) {
    switch (n.type) {
      case 'journal': journalCount++; break;
      case 'login': loginCount++; break;
      case 'card': cardCount++; break;
      case 'ssh-key': sshKeyCount++; break;
      case 'contact': contactCount++; break;
      case 'drawing': drawingCount++; break;
      default: noteCount++; break;
    }
  }
  const parts: { label: string; count: number }[] = [];
  if (noteCount > 0) parts.push({ label: i18n.t('importExport:counts.note', { count: noteCount }), count: noteCount });
  if (contactCount > 0) parts.push({ label: i18n.t('importExport:counts.contact', { count: contactCount }), count: contactCount });
  if (drawingCount > 0) parts.push({ label: i18n.t('importExport:counts.drawing', { count: drawingCount }), count: drawingCount });
  if (journalCount > 0) parts.push({ label: i18n.t('importExport:counts.journal', { count: journalCount }), count: journalCount });
  if (loginCount > 0) parts.push({ label: i18n.t('importExport:counts.login', { count: loginCount }), count: loginCount });
  if (cardCount > 0) parts.push({ label: i18n.t('importExport:counts.card', { count: cardCount }), count: cardCount });
  if (sshKeyCount > 0) parts.push({ label: i18n.t('importExport:counts.sshKey', { count: sshKeyCount }), count: sshKeyCount });
  return parts;
}

/** Format type counts for the confirm button label. */
function formatTypeCountsShort(notes: ImportedNote[]): string {
  const parts = computeTypeCounts(notes);
  if (parts.length === 0) return i18n.t('importExport:counts.zeroItems');
  if (parts.length === 1) return `${parts[0]!.count} ${parts[0]!.label}`;
  return parts.map((p) => `${p.count} ${p.label}`).join(', ');
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
        <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 text-small space-y-1">
          {transforms.map((t, i) => (
            <div
              key={i}
              className="text-accent flex items-start gap-1.5"
            >
              <Check className="mt-0.5 shrink-0" />
              <span>{t}</span>
            </div>
          ))}
        </div>
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

      <SettingsCallout>
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
      </SettingsCallout>

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
}: {
  importerLabel: string;
  message: string;
}) {
  const { t } = useTranslation('importExport');
  return (
    <div className="py-6">
      <Callout tone="danger" title={t('errorPhase.heading', { importer: importerLabel })}>
        <div className="whitespace-pre-wrap break-words">{message}</div>
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
  onExportAllMdZip,
  onExportAllHtmlZip,
  onExportAllJson,
  onExportEncrypted,
  onExportEncryptedZip,
  onExportVault,
  onExportBookmarks,
  onExportContacts,
  onExportCalendar,
  onExportDrawings,
}: {
  notes: LocalNote[];
  onExportAllMdZip: (ns: LocalNote[]) => void;
  onExportAllHtmlZip: (ns: LocalNote[]) => void;
  onExportAllJson: (ns: LocalNote[]) => void;
  onExportEncrypted: (ns: LocalNote[]) => void;
  onExportEncryptedZip: (ns: LocalNote[]) => void;
  onExportVault: (ns: LocalNote[]) => void;
  onExportBookmarks: (ns: LocalNote[]) => void;
  onExportContacts: (ns: LocalNote[]) => void;
  onExportCalendar: (ns: LocalNote[]) => void;
  onExportDrawings?: (ns: LocalNote[]) => void;
}) {
  const { t } = useTranslation('importExport');
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
  const fullBackups: { setting: string; title: string; desc: string; locked?: boolean; unlocked?: boolean; glyph?: ReactNode; src?: string; run: () => void }[] = [
    { setting: 'export.encryptedZip', title: t('export.encryptedZipBackupTitle'), desc: t('export.encryptedZipBackupDesc'), locked: true, src: PN_ICON, run: () => onExportEncryptedZip(notes) },
    { setting: 'export.encryptedBackup', title: t('export.encryptedBackupTitle'), desc: t('export.encryptedBackupDesc'), locked: true, src: PN_ICON, run: () => onExportEncrypted(notes) },
    { setting: 'export.zipBackup', title: t('export.zipBackupTitle'), desc: t('export.zipBackupDesc'), unlocked: true, glyph: <FileZip size={20} aria-hidden="true" />, run: () => onExportAllMdZip(notes) },
  ];
  // The one-kind files (bookmarks, contacts, calendar, drawings, vault) sit with the
  // portable formats: each had a section of one row. Each appears once there
  // is something for it to write.
  const portable: ExportEntry[] = [
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
            <Button variant="primary" icon={<Upload aria-hidden="true" />} onClick={e.run}>
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

      {/* Full backup keeps the Restore rows: their names are long, so a
          card would cut them. */}
      <section className="space-y-1.5">
        <SectionEyebrow icon={Archive} className="pt-1">{t('export.fullBackupHeading')}</SectionEyebrow>
        {fullBackups.map((e) => {
          const { name, type } = splitFileType(e.title);
          return <ActionRow key={e.setting} setting={e.setting} title={name} type={type} description={e.desc} locked={e.locked} unlocked={e.unlocked} glyph={e.glyph} src={e.src} onClick={e.run} />;
        })}
      </section>
      <SourceGroup icon={FileText} title={t('export.portableHeading')}>{portable.map(cells)}</SourceGroup>

      {/* Help links sit at the foot of a settings pane, after the last
          section: the question you arrive with, then the one you leave with. */}
      <HelpChip surface="export" />
      <HelpChip surface="exportEnd" />
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
