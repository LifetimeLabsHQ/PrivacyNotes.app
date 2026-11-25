/**
 * Custom TipTap extension for encrypted file attachments.
 *
 * Renders as a one-line chip: [preview tile] filename, type and size
 * [actions]. A chip that holds a picture or a PDF shows it in the tile, and a
 * click on the tile opens the shared viewer. In a note the Files pillar made
 * that holds one file, a picture or a PDF renders as a card with the file
 * itself on it instead (the `filePreview` option, `showsFileCard`). Files are
 * encrypted client-side and stored in the same Supabase Storage bucket as
 * images.
 *
 * URI scheme: pn:file/<uuid> in markdown link syntax:
 *   [filename](pn:file/<uuid>)
 *
 * Markdown roundtrip is handled by custom serialize/parse hooks.
 */

import { lazy, Suspense, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { estimateBlobBytes, mimeToLabel } from './notesViewUtils';
import { useTranslation } from 'react-i18next';
import { saveBlob } from './saveFile';
import { Node, mergeAttributes, type Editor as TipTapEditor } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AttachmentStore, type AttachmentMeta, type DecryptedAttachment } from './attachmentStore';
import { validateAttachment, isImageFile, formatFileSize } from './attachmentValidation';
import { currentImageOptions, isSupportedImage, processImage } from './imageProcessing';
import { isMail, isPdf, isPictureMime, openMediaViewerInDoc } from './mediaRefs';
import { HoverLabel } from './HoverLabel';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu';
import { suppressSoftKeyboard } from './softKeyboard';
import { useNearScreen } from './useNearScreen';
import { useBlobQuotaBlocked } from './usePendingUploads';
import { MusicNotes, VideoCamera, Image, Archive, File as FileGlyph, Pause, Play, Check, Copy, Download, Eye, MagicWand, PencilSimple, TextAlignLeft, TextT, Waveform, X } from './icons';
import { pluginsShown } from './onDeviceAi';
import { canAddText, cleanupShown, cleanupSubjects, editorNote, openPluginSheet, voiceShown, type AudioAttrs } from './plugins/pluginDoors';
import { cancelJob, dropJob, useJobs } from './plugins/jobs';
import { timeLeft } from './plugins/timeLeft';
import { planIsPro } from './plugins/pluginState';
import { insertTextAfter } from './plugins/insertText';
import { DeleteButton } from './ui/DeleteButton';
import { Callout, FeedbackButton, Snackbar, Spinner } from './ui/feedback';
import { RangeSlider } from './ui/RangeSlider';
import { isBlobDamaged } from './blobDamaged';
import { formatDuration } from './formatDuration';
import {
  FILE_NAME_MAX_LENGTH,
  cleanFileName,
  escapeMarkdownText,
  joinFileName,
  subscribeToAttachmentNames,
  splitFileName,
} from './fileNames';
import i18n, { activeLocale } from './i18n';
import { drawablePicture } from './avifDisplay';
import { InlineRenameField } from './InlineRenameField';
import { IconUpgrade } from './proMark';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const FILE_URI_PREFIX = 'pn:file/';

/** The narrowest the chip menu draws (ContextMenu's floor), so a menu opened
 *  from the chip's end lines its end edge up with the button. */
const MENU_MIN_WIDTH_PX = 160;
/** How long Undo stays after Remove noise swapped a recording; the note's history keeps the original after that. */
const CLEAN_UNDO_MS = 10_000;

// The glyph inside a chip button takes no pointer events, so a press on it
// lands on the button itself. The editor ignores a press on a button and
// handles one on anything else, so a press on a bare glyph would also select
// the chip under the button's own action.
const BUTTON_CONTENT = '[&>*]:pointer-events-none';

// ------------------------------------------------------------------
// Rename requests from outside the editor
// ------------------------------------------------------------------

type RenameListener = (uuid: string) => void;
const renameListeners = new Set<RenameListener>();

/**
 * The most recent request, kept for a moment after it is made. A chip's node
 * view mounts asynchronously, so a request that arrives with the note - which
 * is how the Files pillar sends one - reaches no listener at all. The chip
 * claims it on mount instead.
 */
let pendingRename: { uuid: string; at: number } | null = null;

/** How long a request waits for its chip to appear. */
// Spec: docs/internal/specs/file-rename-and-audio-seek.md (where the control lives)
const RENAME_REQUEST_TTL_MS = 4000;

/**
 * Ask the chip holding `uuid` to open its rename field.
 *
 * The Files pillar's Rename row opens the parent note and then calls this,
 * so the name is only ever written by the chip inside the live editor. A
 * list that rewrote the note body itself would lose the race against a
 * debounced edit still pending in that editor.
 */
export function requestAttachmentRename(uuid: string) {
  pendingRename = { uuid, at: Date.now() };
  for (const listener of renameListeners) listener(uuid);
}

function subscribeToRenameRequests(listener: RenameListener): () => void {
  renameListeners.add(listener);
  return () => { renameListeners.delete(listener); };
}

/** True once, for the chip a live request was aimed at. */
function claimPendingRename(uuid: string | null): boolean {
  if (!uuid || !pendingRename || pendingRename.uuid !== uuid) return false;
  if (Date.now() - pendingRename.at > RENAME_REQUEST_TTL_MS) {
    pendingRename = null;
    return false;
  }
  pendingRename = null;
  return true;
}

// ------------------------------------------------------------------
// File type icon helper
// ------------------------------------------------------------------

/** SVG icon for file type - replaces emoji for a cleaner look. */
function FileTypeIcon({ mime, size = 18 }: { mime: string; size?: number }) {
  // Audio
  if (mime.startsWith('audio/')) {
    return <MusicNotes size={size} />;
  }
  // Video
  if (mime.startsWith('video/')) {
    return <VideoCamera size={size} />;
  }
  // Image
  if (mime.startsWith('image/')) {
    return <Image size={size} />;
  }
  // Archive
  if (mime === 'application/zip' || mime.includes('compressed') || mime.includes('archive')) {
    return <Archive size={size} />;
  }
  // Default: generic file
  return <FileGlyph size={size} />;
}

// ------------------------------------------------------------------
// The file card's preview
// ------------------------------------------------------------------

/** Answered once per document: every chip in a note asks after each edit,
 *  and a document is never changed in place. */
const oneFileDocs = new WeakMap<ProseMirrorNode, boolean>();

/**
 * Whether a document holds exactly one file chip. A picture placed from Files
 * is a picture node, not a chip, so it is not one of the note's files.
 */
export function holdsOneFile(doc: ProseMirrorNode): boolean {
  let one = oneFileDocs.get(doc);
  if (one === undefined) {
    let chips = 0;
    doc.descendants((node) => {
      if (node.type.name === 'attachment') chips += 1;
      // A chip is a block, so the inside of a paragraph never holds one.
      return !node.isTextblock;
    });
    one = chips === 1;
    oneFileDocs.set(doc, one);
  }
  return one;
}

/**
 * Whether a note's picture or PDF draws as the file card: only in a note the
 * Files pillar made, and only while that note holds one file. A note of
 * several files reads as a list, and a card per file would make it a gallery.
 * Spec: docs/internal/design/ui-patterns.md (section 107, the file card)
 */
export function showsFileCard(fileNote: boolean, doc: ProseMirrorNode): boolean {
  return fileNote && holdsOneFile(doc);
}

// pdf.js is fetched the first time a PDF card or the viewer needs it, never
// on the way to the first render.
const PdfCover = lazy(() => import('./PdfPages').then((m) => ({ default: m.PdfCover })));
const MailCover = lazy(() => import('./MailView').then((m) => ({ default: m.MailCover })));

/**
 * The file itself, on the card a Files upload opens as: a picture at its
 * stored size, never scaled up, or a PDF's first page with its page count.
 * The whole area opens the viewer, which is where the arrows and the pages
 * are; the card previews, it does not read.
 *
 * Spans rather than divs throughout, because this is the content of a button.
 */
function FilePreview({ uuid, pdf, mail, name, onOpen, onDamaged }: {
  uuid: string;
  pdf: boolean;
  mail: boolean;
  name: string;
  onOpen: () => void;
  /** The picture's bytes do not open; the chip shows that state in place of this card. */
  onDamaged: () => void;
}) {
  const { t } = useTranslation('media');
  // A PDF and a mail are read from their bytes; only a picture has a URL.
  const fromBytes = pdf || mail;
  const [url, setUrl] = useState<string | null>(() => (fromBytes ? null : cachedAttachmentUrl(uuid)));
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (fromBytes || url) return;
    let alive = true;
    void readAttachmentUrl(uuid).then((loaded) => {
      if (!alive) return;
      if (loaded) setUrl(loaded);
      else setMissing(true);
    }, (err: unknown) => {
      if (!alive) return;
      if (isBlobDamaged(err)) onDamaged();
      else setMissing(true);
    });
    return () => { alive = false; };
  }, [uuid, fromBytes, url, onDamaged]);

  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      aria-label={t('attachment.view')}
      className={`block w-full bg-surface-1 ${mail ? 'cursor-pointer' : 'cursor-zoom-in'} outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${BUTTON_CONTENT}`}
    >
      {mail ? (
        <Suspense fallback={<span className="block py-10" />}>
          <MailCover uuid={uuid} />
        </Suspense>
      ) : pdf ? (
        <Suspense fallback={<span className="block py-16" />}>
          <PdfCover uuid={uuid} name={name} />
        </Suspense>
      ) : url ? (
        <span className="flex justify-center p-3">
          <img
            src={url}
            alt={name}
            draggable={false}
            className="block max-w-full max-h-[60vh] !my-0 rounded-md"
          />
        </span>
      ) : (
        <span className="block px-4 py-16 text-body text-center text-pn-muted">
          {missing ? t('image.notFound') : t('image.loading')}
        </span>
      )}
    </button>
  );
}

// ------------------------------------------------------------------
// Action buttons
// ------------------------------------------------------------------

/** Icon-only, no border, hover background. The last one in a chip takes
 *  `tip="above-end"`, because the chip's end can be the screen's edge. */
function ActionButton({ onClick, label, disabled, tip = 'above', children }: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  label: string;
  disabled?: boolean;
  tip?: 'above' | 'above-end';
  children: React.ReactNode;
}) {
  return (
    <HoverLabel label={label} position={tip}>
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      disabled={disabled}
      aria-label={label}
      className={`shrink-0 w-[30px] h-[30px] rounded-md flex items-center justify-center transition cursor-pointer select-none text-pn-muted hover:text-accent hover:bg-pn/5 ${BUTTON_CONTENT} ${
        disabled ? 'opacity-50 pointer-events-none' : ''
      }`}
    >
      {children}
    </button>
    </HoverLabel>
  );
}

/**
 * A labeled tool: what the file is for (View, Text, Transcribe, Remove
 * noise, or Download for a file nothing here shows). Accent-tinted so it
 * reads ahead of the quiet file icons (owner, 2026-11-20). `compact` drops
 * the label when the phone row has no room (`useFitsRow`); the hover label
 * and the accessible name keep it. `busy` is a running job: a fill for how
 * far it came, and a press cancels it.
 */
function ToolButton({ icon, label, onClick, compact, pro, disabled, busy }: {
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  compact: boolean;
  pro?: boolean;
  disabled?: boolean;
  busy?: { fraction?: number; cancelLabel: string };
}) {
  const named = busy ? `${label} - ${busy.cancelLabel}` : label;
  const button = (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      disabled={disabled}
      aria-label={compact || busy ? named : undefined}
      className={`relative overflow-hidden shrink-0 inline-flex items-center justify-center gap-1.5 h-8 rounded-lg bg-accent/10 dark:bg-accent/20 text-accent-strong text-small font-medium whitespace-nowrap transition cursor-pointer select-none hover:bg-accent/15 dark:hover:bg-accent/30 ${
        compact ? 'w-8' : 'px-3'
      } ${BUTTON_CONTENT} ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
    >
      {busy?.fraction !== undefined && (
        <span aria-hidden="true" className="absolute inset-y-0 start-0 bg-accent/20 transition-[width]" style={{ width: `${Math.round(busy.fraction * 100)}%` }} />
      )}
      <span className="relative inline-flex">
        {icon}
        {pro && compact && (
          <span className="absolute -top-1.5 -end-2">
            <IconUpgrade size={11} />
          </span>
        )}
      </span>
      {!compact && <span className="relative">{label}</span>}
      {!compact && pro && <span className="relative inline-flex"><IconUpgrade size={12} /></span>}
      {!compact && busy && <X className="relative" />}
    </button>
  );
  return compact || busy ? <HoverLabel label={busy ? busy.cancelLabel : label} position="above">{button}</HoverLabel> : button;
}

/**
 * How many labeled tools, counted from the end, show their icon only so the
 * tool row fits: the last one drops its label first (Remove noise before
 * Transcribe, Text before View). The width each step needed is kept, so a
 * label comes back only once it fits, with no flicker at the edge, and a
 * change in which tools show (`signature`) measures again. Measured, not a
 * fixed breakpoint, because a label's length depends on the language.
 */
function useFitsRow(ref: React.RefObject<HTMLDivElement | null>, signature: string, labels: number): number {
  const [dropped, setDropped] = useState(0);
  const needs = useRef<number[]>([]);
  useLayoutEffect(() => {
    needs.current = [];
    setDropped(0);
  }, [signature]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      if (el.clientWidth === 0) return;
      setDropped((d) => {
        if (el.scrollWidth > el.clientWidth + 1 && d < labels) {
          needs.current[d] = el.scrollWidth;
          return d + 1;
        }
        if (d > 0 && el.clientWidth >= (needs.current[d - 1] ?? Infinity)) return d - 1;
        return d;
      });
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, dropped, signature, labels]);
  return dropped;
}

// ------------------------------------------------------------------
// Audio length
// ------------------------------------------------------------------

/**
 * The playable length of a loaded audio element, in seconds, or 0 when the
 * browser will not say.
 *
 * A recording made in the app carries no length in its header, because
 * MediaRecorder writes MP4 and OGG as it goes and never returns to fill the
 * field in, so `duration` reads Infinity. Seeking far past the end makes the
 * browser scan to the real end and report it through `durationchange`; the
 * position is put back before anything plays. A file that still will not
 * answer gets 0, which leaves the slider disabled and the total hidden - an
 * elapsed-only readout is honest, a slider that cannot know where it is is
 * not.
 *
 * Each seek is let finish before the next one starts and before play, so a
 * player that drops a seek made while another runs cannot lose the reset to
 * 0. Written for #686, whose cause the Linux test VM did not confirm: there
 * the probe runs only when GStreamer reads a length of 0, and playback then
 * starts at 0, about 1.5 s late (docs/internal/linux-vm.md, section 5).
 */
export function resolveDuration(audio: HTMLAudioElement): Promise<number> {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    return Promise.resolve(audio.duration);
  }
  return new Promise<number>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = async () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      audio.removeEventListener('durationchange', onDurationChange);
      await seekSettled(audio);
      try { audio.currentTime = 0; } catch { /* not seekable */ }
      await seekSettled(audio);
      resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
    };
    const onDurationChange = () => {
      if (Number.isFinite(audio.duration)) void finish();
    };
    audio.addEventListener('durationchange', onDurationChange);
    timer = setTimeout(() => { void finish(); }, 1500);
    try {
      audio.currentTime = 1e101;
    } catch {
      void finish();
    }
  });
}

/** Resolves once a running seek ends (`seeked`), or after 1.5 s if it never says. */
function seekSettled(audio: HTMLAudioElement): Promise<void> {
  if (!audio.seeking) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      audio.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, 1500);
    audio.addEventListener('seeked', done);
  });
}

// ------------------------------------------------------------------
// React NodeView - renders attachment chip with download
// ------------------------------------------------------------------

type AttachmentNodeViewProps = {
  node: { attrs: { src: string; filename: string; filesize: string; mimetype: string } };
  selected: boolean;
  deleteNode: () => void;
  updateAttributes: (attrs: Record<string, unknown>) => void;
  editor: TipTapEditor;
  /** Document position of this chip, or undefined once the node is gone. */
  getPos: () => number | undefined;
  extension: { options: AttachmentOptions };
};

function EncryptedAttachmentView({
  node,
  selected,
  deleteNode,
  updateAttributes,
  editor,
  getPos,
  extension,
}: AttachmentNodeViewProps) {
  const { t } = useTranslation('media');
  const { src, filename, filesize, mimetype } = node.attrs;
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The blob is referenced by the note but absent from the server: it
  // never uploaded from its origin device (usually a full vault there).
  // Rendered as an amber explanation, not a red error (backlog #151).
  const [missingRemote, setMissingRemote] = useState(false);
  // The blob arrived but does not open (a wrong key, damaged bytes). Shown
  // with a Try again; nothing is deleted for it. See blobDamaged.ts.
  const [damaged, setDamaged] = useState(false);
  const markDamaged = useCallback(() => setDamaged(true), []);
  const [copied, setCopied] = useState(false);
  const [playing, setPlaying] = useState(false);
  /**
   * Whether this note can be edited, tracked rather than read once.
   * `readOnly` toggles WITHOUT remounting the editor - it is keyed by note
   * id - and `editor.isEditable` is a plain getter, so a chip that read it
   * at render time went on offering Rename and Delete on a locked note.
   * Neither would have saved: the debounced write refuses a read-only note,
   * so the buttons removed a chip on screen and lost the change on the next
   * load. `setEditable` emits an update, which is what this listens for.
   */
  const [editable, setEditable] = useState(editor.isEditable);
  useEffect(() => {
    const sync = () => setEditable(editor.isEditable);
    sync();
    editor.on('update', sync);
    return () => { editor.off('update', sync); };
  }, [editor]);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // Playback position and length, both in seconds. `duration` stays 0 until
  // a real length is known, which is what disables the slider - see
  // resolveDuration for why a recording does not report one at first.
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [formatUnsupported, setFormatUnsupported] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  // One load at a time, and none that outlives the chip: a second tap on
  // Play while the file was still on its way started a second player over
  // the first (Pause then stopped only one), and leaving the note during
  // the load started a player nothing could reach.
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);

  const uuid = src?.startsWith(FILE_URI_PREFIX)
    ? src.slice(FILE_URI_PREFIX.length)
    : null;

  // Amber "on this device only" chip while the blob cannot fit the
  // storage quota (backlog #143) - clears itself once space frees and
  // the retry sweep uploads it.
  const localOnly = useBlobQuotaBlocked(uuid);

  const isAudio = mimetype?.startsWith('audio/') ?? false;
  const isImage = mimetype?.startsWith('image/') ?? false;
  // What the shared viewer can open. A HEIC stored before the upload pipeline
  // re-encoded pictures keeps its thumbnail attempt but opens nothing.
  const isPicture = Boolean(uuid) && isPictureMime(mimetype || '');
  const isPdfFile = Boolean(uuid) && isPdf(mimetype || '', filename || '');
  const isMailFile = Boolean(uuid) && isMail(mimetype || '', filename || '');
  const viewable = isPicture || isPdfFile || isMailFile;
  // A Files note that holds one file shows that file, not only its name, and
  // reads as a list once it holds a second. The count follows every edit, so
  // a file dropped into the note turns the card back into a row at once.
  const fileNote = extension.options.filePreview;
  const [cardNote, setCardNote] = useState(() => showsFileCard(fileNote, editor.state.doc));
  useEffect(() => {
    if (!fileNote) return;
    const sync = () => setCardNote(showsFileCard(fileNote, editor.state.doc));
    sync();
    editor.on('update', sync);
    return () => { editor.off('update', sync); };
  }, [editor, fileNote]);
  const showPreview = viewable && cardNote;

  const openViewer = useCallback(() => {
    const pos = getPos();
    if (typeof pos === 'number') openMediaViewerInDoc(editor.state.doc, pos);
  }, [editor, getPos]);

  // A PDF's tile shows its first page, drawn once the chip comes near the
  // screen, so a note of many PDFs reads only the ones somebody scrolls to.
  const tileRef = useRef<HTMLDivElement>(null);
  const [pdfCover, setPdfCover] = useState<PdfCoverImage | null>(() =>
    isPdfFile && uuid ? cachedPdfCover(uuid) : null,
  );
  // On the file card too: the card's preview draws the same cover (one
  // shared draw), and the meta line takes its page count.
  const pdfNear = useNearScreen(tileRef, isPdfFile && !pdfCover);
  useEffect(() => {
    if (!pdfNear || !uuid || pdfCover) return;
    let alive = true;
    // A PDF that cannot be drawn keeps the file glyph.
    loadPdfCover(uuid).then((cover) => { if (alive) setPdfCover(cover); }, () => {});
    return () => { alive = false; };
  }, [pdfNear, uuid, pdfCover]);

  const menu = useContextMenu();
  const toolRowRef = useRef<HTMLDivElement>(null);

  // Load thumbnail for image attachments. The URL belongs to the shared
  // cache, which the Files grid and the viewer read too, so it outlives this
  // chip and is not revoked here.
  useEffect(() => {
    if (!isImage || !uuid) return;
    let cancelled = false;
    void readAttachmentUrl(uuid).then((url) => {
      if (!cancelled && url) setThumbnailUrl(url);
    }, (err: unknown) => {
      if (!cancelled && isBlobDamaged(err)) setDamaged(true);
    });
    return () => { cancelled = true; };
  }, [isImage, uuid]);

  // Stop audio and free its blob URL on unmount (e.g. navigating to another note)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  // Pause audio when app is backgrounded (home button, browser minimized)
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && audioRef.current && playing) {
        audioRef.current.pause();
        setPlaying(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [playing]);

  const fetchBlobUrl = useCallback(async (): Promise<string | null> => {
    if (!uuid) return null;
    const store = getAttachmentStore();
    if (!store) return null;
    const attachment = await store.getAttachment(uuid);
    if (!attachment) return null;
    const mime = attachment.meta.mime || 'application/octet-stream';
    const blob = new Blob([attachment.data as BlobPart], { type: mime });
    return URL.createObjectURL(blob);
  }, [uuid]);

  const handleDownload = useCallback(async () => {
    if (!uuid || downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const store = getAttachmentStore();
      if (!store) { setError(t('attachment.fileNotFound')); return; }
      const attachment = await store.getAttachment(uuid);
      // Not cached and not on the server: the blob never uploaded from
      // its origin device. Explain instead of "File not found" (#151).
      if (!attachment) { setMissingRemote(true); return; }
      setMissingRemote(false);
      setDamaged(false);
      const mime = attachment.meta.mime || 'application/octet-stream';
      const blob = new Blob([attachment.data as BlobPart], { type: mime });
      const saved = await saveBlob(blob, filename || 'download');
      // The catch below turns the reason into the message; a dismissed dialog
      // is not a failure.
      if (!saved.ok && saved.reason === 'failed') throw saved.error;
    } catch (err) {
      if (isBlobDamaged(err)) setDamaged(true);
      else setError(err instanceof Error ? err.message : t('attachment.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  }, [uuid, filename, downloading, t]);

  const handleCopy = useCallback(() => {
    // Copy the markdown link so it can be pasted into another note. The name
    // is escaped the way the serializer escapes it, so a name holding a
    // bracket or an asterisk pastes back as itself rather than as emphasis.
    const name = escapeMarkdownText(filename || 'Attachment');
    const size = filesize || '';
    const mime = mimetype || '';
    const md = `[${name}|${size}|${mime}](${src})`;
    void navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [src, filename, filesize, mimetype]);

  // Try again on a damaged file: one read per click. A file that opens clears
  // the state (a picture draws its thumbnail); one that is gone or cannot be
  // reached takes the path a Download would have taken.
  const handleRetry = useCallback(async () => {
    const store = getAttachmentStore();
    if (!uuid || !store) return;
    try {
      const attachment = await store.getAttachment(uuid);
      setDamaged(false);
      if (!attachment) { setMissingRemote(true); return; }
      setMissingRemote(false);
      if (isImage) setThumbnailUrl(await loadAttachmentUrl(uuid));
    } catch (err) {
      if (isBlobDamaged(err)) return;
      setDamaged(false);
      setError(err instanceof Error ? err.message : t('attachment.downloadFailed'));
    }
  }, [uuid, isImage, t]);

  // ---- Rename ----

  const currentName = filename || t('attachment.fallbackName');
  const { ext: nameExt } = splitFileName(currentName);

  const startRename = useCallback(() => {
    if (!editor.isEditable) return;
    if (renaming) return;
    setRenameValue(splitFileName(filename || t('attachment.fallbackName')).base);
    setRenaming(true);
  }, [editor, filename, t]);

  const cancelRename = useCallback(() => {
    setRenaming(false);
  }, []);

  // A note locked while the field is open drops the field with it, rather
  // than leaving a control the save path would refuse.
  useEffect(() => {
    if (!editable) setRenaming(false);
  }, [editable]);

  const commitRename = useCallback(() => {
    setRenaming(false);
    const before = filename || '';
    const { ext } = splitFileName(before);
    const base = cleanFileName(renameValue, '');
    // Nothing but dots and spaces is a cancel, not a request for a file
    // called `.` - and it covers the empty field too.
    if (!/[^.]/.test(base)) return;
    const next = joinFileName(base, ext);
    if (next === before) return;
    updateAttributes({ filename: next });
    extension.options.onRename?.(next);
  }, [filename, renameValue, updateAttributes, extension]);

  // The Files pillar's Rename row lands here. A request made while this chip
  // was already on screen arrives through the listener; one made as the note
  // opened is waiting to be claimed, because this node view did not exist
  // when it was sent.
  useEffect(() => {
    if (claimPendingRename(uuid)) startRename();
    return subscribeToRenameRequests((requested) => {
      if (requested === uuid) {
        claimPendingRename(uuid);
        startRename();
      }
    });
  }, [uuid, startRename]);

  // A single-file item's title commit names its file (fileNameForTitle).
  // The title is set already, so onRename is not called back.
  useEffect(() => subscribeToAttachmentNames((requested, name) => {
    if (requested === uuid && editable) updateAttributes({ filename: name });
  }), [uuid, editable, updateAttributes]);

  const handlePlayPause = useCallback(async () => {
    if (playing && audioRef.current) {
      audioRef.current.pause();
      setPlaying(false);
      return;
    }
    if (audioRef.current && audioUrlRef.current) {
      void audioRef.current.play();
      setPlaying(true);
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;
    setError(null);
    try {
      const url = await fetchBlobUrl();
      if (!url) { setMissingRemote(true); return; }
      // The chip is gone (the note was left while the file loaded): the
      // unmount cleanup ran before there was a player to stop.
      if (!mountedRef.current) { URL.revokeObjectURL(url); return; }
      setMissingRemote(false);
      audioUrlRef.current = url;
      const audio = document.createElement('audio');
      audio.preload = 'auto';
      audioRef.current = audio;
      audio.onended = () => { setPlaying(false); setPosition(0); };
      // A recording's own header can understate its length - a three-second
      // one made here reported 1.52 - and the browser only corrects that as
      // it plays. Take every correction, and never let the thumb sit past
      // the end of its own track.
      audio.ondurationchange = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
      };
      audio.ontimeupdate = () => {
        setPosition(audio.currentTime);
        setDuration((known) => (audio.currentTime > known ? audio.currentTime : known));
      };
      await new Promise<void>((resolve, reject) => {
        audio.oncanplaythrough = () => resolve();
        audio.onerror = () => reject(new Error('format'));
        audio.src = url;
        audio.load();
      });
      const known = await resolveDuration(audio);
      setDuration(known);
      await audio.play();
      setPlaying(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (isBlobDamaged(err)) setDamaged(true);
      else if (msg === 'format') { setFormatUnsupported(true); setError(null); }
      else { setError(msg || t('attachment.playbackFailed')); }
      setPlaying(false);
    } finally {
      loadingRef.current = false;
    }
  }, [playing, mimetype, fetchBlobUrl, t]);

  const sizeStr = filesize || '';
  // The type, then a PDF's page count once its first page is drawn, then the size.
  const metaStr = [
    mimeToLabel(isPdfFile ? 'application/pdf' : isMailFile ? 'message/rfc822' : mimetype || ''),
    pdfCover ? t('viewer.pageCount', { count: pdfCover.pages }) : '',
    sizeStr,
  ].filter(Boolean).join(' · ');
  const playable = isAudio && !formatUnsupported;
  // The tile opens the viewer, and the rest of the chip stays the editor's to
  // select, drag and delete. On the file card the picture above is the trigger.
  const tileOpens = viewable && !showPreview;

  // A plugin's text has a place only where the note can be edited and has
  // paragraphs (`canAddText`); `editable` is tracked, so the rows follow it.
  const addHere = editable && canAddText(editor);
  const addText = addHere
    ? {
        insert: (text: string) => {
          const pos = getPos();
          if (typeof pos !== 'number') throw new Error('gone');
          insertTextAfter(editor, pos, text);
        },
      }
    : {};
  // Text in pictures on a PDF: the sheet reads its text layer, and OCR only
  // the pages without one. Spec: docs/internal/plans/plugins.md (section 6.4)
  const pdfText = isPdfFile && uuid && pluginsShown()
    ? (primary: 'copy' | 'add') => openPluginSheet({
        kind: 'ocr',
        source: 'pdf',
        primary,
        noteId: editorNote(editor),
        load: async () => (await loadAttachmentData(uuid))?.data ?? null,
        ...addText,
      })
    : null;
  // Voice to text on a recording or an imported audio file (free, D25; not
  // in iOS browsers, D24). Spec: docs/internal/plans/plugins.md (section 6.6)
  const audioText = isAudio && uuid && voiceShown()
    ? () => openPluginSheet({
        kind: 'voice',
        noteId: editorNote(editor),
        load: async () => (await loadAttachmentData(uuid))?.data ?? null,
        mimetype: mimetype || '',
        ...addText,
      })
    : null;
  // Remove noise (Pro): one tap cleans the recording and swaps it in, with
  // Undo; no sheet and no preview (SE3). The job outlives the chip, so a
  // chip that mounts again takes a result that ended while it was gone.
  // Spec: docs/internal/specs/plugins-speech-enhancement.md (SE3, section 14)
  const cleanJob = useJobs().find((j) => j.pluginId === 'cleanup' && uuid !== null && cleanupSubjects.get(j.id) === uuid);
  const [cleanUndo, setCleanUndo] = useState<AudioAttrs | null>(null);
  // A swap of the file stops the player first: it holds the old file's address.
  const resetPlayer = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setPlaying(false);
    setPosition(0);
    setDuration(0);
  };
  const cleanStarted = useRef<{ at: number; done: number } | null>(null);
  const audioClean = isAudio && uuid && editable && !cleanJob && cleanupShown()
    ? () => openPluginSheet({
        kind: 'cleanup',
        noteId: editorNote(editor),
        subject: uuid,
        filename: filename || 'recording.m4a',
        load: async () => (await loadAttachmentData(uuid))?.data ?? null,
        store: storeAttachmentFile,
      })
    : null;
  useEffect(() => {
    if (!cleanJob || cleanJob.status !== 'done' || !editable) return;
    const { attrs, uploaded } = cleanJob.result as { attrs: AudioAttrs; uploaded: Promise<void> };
    const before = { src, filename, filesize, mimetype };
    dropJob(cleanJob.id);
    cleanupSubjects.delete(cleanJob.id);
    cleanStarted.current = null;
    resetPlayer();
    updateAttributes(attrs);
    setCleanUndo(before);
    // A cleaned file that never reaches the server must not stay in the note.
    uploaded.catch(() => {
      try {
        updateAttributes(before);
      } catch {
        // The chip is gone; the note keeps what it saved.
      }
    });
    // The result once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanJob?.status, editable]);
  useEffect(() => {
    if (!cleanUndo) return;
    const timer = setTimeout(() => setCleanUndo(null), CLEAN_UNDO_MS);
    return () => clearTimeout(timer);
  }, [cleanUndo]);
  const undoClean = () => {
    if (!cleanUndo) return;
    resetPlayer();
    if (editable) updateAttributes(cleanUndo);
    setCleanUndo(null);
  };
  const cleanProgress = cleanJob?.status === 'running' ? cleanJob.progress : undefined;
  if (cleanProgress && cleanStarted.current === null) cleanStarted.current = { at: performance.now(), done: cleanProgress.done };
  const cleanStart = cleanStarted.current;
  const cleanLeft = cleanProgress && cleanStart && cleanProgress.done > cleanStart.done
    ? (((performance.now() - cleanStart.at) / (cleanProgress.done - cleanStart.done)) * (cleanProgress.total - cleanProgress.done)) / 1000
    : null;
  // A failed run says why under the chip; a running one shows in its button.
  const cleanNotice = cleanJob && cleanJob.status === 'error' ? (
      <Callout
        tone="danger"
        action={
          <FeedbackButton
            action="done"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => {
              e.stopPropagation();
              dropJob(cleanJob.id);
              cleanupSubjects.delete(cleanJob.id);
            }}
            className={BUTTON_CONTENT}
          />
        }
      >
        {t(cleanJob.error === 'audio-format' ? 'audioFormat' : cleanJob.error === 'worker-died' ? 'lowMemory' : 'cleanFailed')}
      </Callout>
  ) : null;
  // Text in pictures has its own labelled button (owner, 2026-11-18): in the
  // menu nobody found it.
  const openTextMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!pdfText) return;
    const items: ContextMenuItem[] = [{ label: t('copyText'), icon: <TextT size={14} />, pro: !planIsPro(), onSelect: () => pdfText('copy') }];
    if (addHere) items.push({ label: t('addText'), icon: <TextAlignLeft size={14} />, pro: !planIsPro(), onSelect: () => pdfText('add') });
    openBelow(e, items);
  };
  function openBelow(e: React.MouseEvent<HTMLButtonElement>, items: ContextMenuItem[]) {
    const r = e.currentTarget.getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    menu.open(
      {
        clientX: rtl ? r.left : r.right - MENU_MIN_WIDTH_PX,
        clientY: r.bottom + 4,
        preventDefault: () => {},
        stopPropagation: () => {},
      },
      items,
    );
  }

  // On the file card the frame carries the border and the row becomes its
  // footer; everywhere else the row is the whole chip.
  const frameTone = selected
    ? 'border-accent'
    : error ? 'border-danger/40' : 'border-divider';
  const rowClass = showPreview
    ? `px-3.5 py-3 border-t transition ${
        selected ? 'border-accent bg-accent/10 dark:bg-accent/20' : 'border-divider'
      }`
    : `p-3 rounded-xl border transition ${
        selected
          ? 'border-accent bg-accent/10 dark:bg-accent/20'
          : 'border-divider bg-surface-2'
      } ${error ? 'border-danger/40' : ''}`;

  const tileContent = isImage && thumbnailUrl && !showPreview ? (
    <img
      src={thumbnailUrl}
      // The name stands beside it, so a picture that opens needs no alt of its own.
      alt={isPicture ? '' : filename || t('attachment.imageAlt')}
      draggable={false}
      className="block w-full h-full rounded-lg object-cover !m-0"
    />
  ) : pdfCover && !showPreview ? (
    <img
      src={pdfCover.url}
      alt=""
      draggable={false}
      className="block max-w-[40px] max-h-[40px] !m-0 bg-white border border-divider"
    />
  ) : (
    <FileTypeIcon
      mime={mimetype || (isPdfFile ? 'application/pdf' : 'application/octet-stream')}
      size={showPreview ? 18 : 20}
    />
  );
  const tileFace = 'w-full h-full rounded-lg bg-track flex items-center justify-center text-pn-muted';

  // ---- Tools ----
  // Two kinds (owner, 2026-11-20). Labeled tools say what the file is for;
  // file tools (Download, Rename, Copy, Delete) are quiet icons, beside the
  // name on a wide chip and at the end of the tool row on a narrow one, so
  // nothing wraps and nothing hides in a menu. Spec: pattern 108.
  const primaryDownload = !viewable && !playable;
  const proMark = !planIsPro();
  const cleaning = !!cleanJob && (cleanJob.status === 'waiting' || cleanJob.status === 'running');
  const toolSignature = [viewable, pdfText, primaryDownload, audioText, audioClean, cleaning, editable].map((v) => (v ? 1 : 0)).join('');
  const labelCount = [viewable, pdfText, primaryDownload, audioText, cleaning || audioClean].filter(Boolean).length;
  const dropped = useFitsRow(toolRowRef, toolSignature, labelCount);
  // The tool at `index` (0-based, in row order) shows its icon only.
  const iconOnly = (index: number) => index >= labelCount - dropped;
  const labeled: React.ReactNode[] = [];
  if (viewable) labeled.push(<ToolButton key="view" icon={<Eye />} label={t('attachment.view')} compact={iconOnly(labeled.length)} onClick={openViewer} />);
  if (pdfText) labeled.push(<ToolButton key="text" icon={<TextT />} label={t('text')} pro={proMark} compact={iconOnly(labeled.length)} onClick={openTextMenu} />);
  if (primaryDownload) labeled.push(<ToolButton key="download" icon={<Download />} label={t('common:updateToast.download')} compact={iconOnly(labeled.length)} disabled={downloading} onClick={() => void handleDownload()} />);
  if (audioText) labeled.push(<ToolButton key="voice" icon={<Waveform />} label={t('transcribe')} compact={iconOnly(labeled.length)} onClick={audioText} />);
  if (cleaning && cleanJob) {
    labeled.push(
      <ToolButton
        key="clean"
        icon={<Spinner />}
        label={cleanJob.status === 'waiting'
          ? t('importExport:upload.statusWaiting')
          : cleanLeft !== null
            ? `${t('removingNoise')} · ${t('timeLeft', { time: timeLeft(cleanLeft, activeLocale()) })}`
            : t('removingNoise')}
        compact={iconOnly(labeled.length)}
        busy={{ fraction: cleanProgress && cleanProgress.total > 0 ? cleanProgress.done / cleanProgress.total : undefined, cancelLabel: t('common:actions.cancel') }}
        onClick={() => {
          cancelJob(cleanJob.id);
          cleanupSubjects.delete(cleanJob.id);
          cleanStarted.current = null;
        }}
      />,
    );
  } else if (audioClean) {
    labeled.push(<ToolButton key="clean" icon={<MagicWand />} label={t('settings:plugins.cleanup.title')} pro={proMark} compact={iconOnly(labeled.length)} onClick={audioClean} />);
  }
  const fileTools = (
    <>
      {!primaryDownload && (
        <ActionButton onClick={() => void handleDownload()} disabled={downloading} label={t('common:updateToast.download')}>
          <Download />
        </ActionButton>
      )}
      {editable && (
        <ActionButton onClick={startRename} label={t('common:actions.rename')}>
          <PencilSimple />
        </ActionButton>
      )}
      <ActionButton onClick={handleCopy} label={copied ? t('auth:createPhrase.copied') : t('common:actions.copy')} tip={editable ? 'above' : 'above-end'}>
        {copied ? <Check className="text-success" /> : <Copy />}
      </ActionButton>
      {editable && (
        <>
          <span aria-hidden="true" className="w-px h-4 mx-1 bg-divider" />
          <DeleteButton label={t('common:actions.delete')} confirmLabel={t('common:actions.deleteConfirm')} onConfirm={deleteNode} />
        </>
      )}
    </>
  );

  const row = (
    <div className={rowClass}>
      {/* ---- Header: tile, name, file tools (wide) ---- */}
      <div className="flex items-center gap-3">
        {/* A picture or a PDF opens from its tile, the way a thumbnail does
            everywhere; View is the same action for the keyboard and a
            screen reader, so that tile keeps out of the tab order. A
            recording's tile is its Play button. */}
        <div
          ref={tileRef}
          aria-hidden={tileOpens ? 'true' : undefined}
          className={`shrink-0 ${showPreview ? 'w-9 h-9' : 'w-12 h-12'}`}
        >
          {tileOpens ? (
            <HoverLabel label={t('attachment.view')} position="above" className="w-full h-full">
              <button
                type="button"
                tabIndex={-1}
                // A tap must not raise the keyboard on its way into the
                // viewer: the same suppression the picture node arms.
                onPointerDown={(e) => { if (e.pointerType !== 'mouse') suppressSoftKeyboard(editor.view.dom); }}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); openViewer(); }}
                className={`${tileFace} cursor-zoom-in transition hover:ring-2 hover:ring-accent/60 ${BUTTON_CONTENT}`}
              >
                {tileContent}
              </button>
            </HoverLabel>
          ) : playable ? (
            <HoverLabel label={playing ? t('attachment.pause') : t('attachment.play')} position="above" className="w-full h-full">
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); handlePlayPause(); }}
                aria-label={playing ? t('attachment.pause') : t('attachment.play')}
                className={`w-full h-full rounded-lg flex items-center justify-center bg-accent/10 dark:bg-accent/20 text-accent hover:bg-accent/15 dark:hover:bg-accent/30 transition cursor-pointer ${BUTTON_CONTENT}`}
              >
                {playing ? <Pause size={22} /> : <Play size={22} weight="fill" />}
              </button>
            </HoverLabel>
          ) : (
            <div className={tileFace}>{tileContent}</div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex items-baseline gap-1">
              <InlineRenameField
                value={renameValue}
                onValueChange={setRenameValue}
                onCommit={commitRename}
                onCancel={cancelRename}
                onClick={(e) => e.stopPropagation()}
                // Stop the press reaching the chip WITHOUT preventing it: the
                // sibling buttons prevent their mousedown to keep the node
                // from being dragged, and doing that here would kill the
                // caret. The drag is refused at dragstart instead.
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                draggable={false}
                onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                maxLength={FILE_NAME_MAX_LENGTH}
                placeholder={t('attachment.renamePlaceholder')}
                aria-label={t('attachment.renamePlaceholder')}
                className="min-w-0 flex-1 bg-transparent border-b border-accent/50 focus:border-accent outline-none text-body font-medium text-pn"
              />
              {nameExt && (
                <span className="shrink-0 text-body text-pn-muted">
                  .{nameExt}
                </span>
              )}
            </div>
          ) : (
            <div className="text-body font-medium text-pn truncate" dir="auto">
              {filename || t('attachment.fallbackName')}
            </div>
          )}
          <div className="text-small text-pn-muted truncate">
            {formatUnsupported && (
              <span className="text-warning">{t('attachment.cantPlay')}</span>
            )}
            {!formatUnsupported && metaStr}
            {localOnly && (
              <span className="text-warning ms-1">
                {t('attachment.localOnly')}
              </span>
            )}
            {missingRemote && (
              <span className="text-warning ms-1">
                {t('attachment.notUploaded')}
              </span>
            )}
            {downloading && <span className="text-accent ms-1">{t('attachment.downloadingStatus')}</span>}
            {error && <span className="text-danger ms-1">{error}</span>}
          </div>
          {/* The WHY, always visible - a tooltip is unreachable on touch,
              and this sits outside the truncating meta line so it can wrap. */}
          {localOnly && (
            <div className="text-meta text-warning mt-0.5 leading-tight">
              {t('attachment.localOnlyTip')}
            </div>
          )}
          {/* Other-device counterpart of localOnlyTip: same always-visible
              amber line, same reasons (no hover on touch, truncation). */}
          {missingRemote && (
            <div className="text-meta text-warning mt-0.5 leading-tight">
              {t('attachment.notUploadedTip')}
            </div>
          )}

        </div>

        {renaming ? (
          <div className="shrink-0 flex items-center gap-0.5">
            <ActionButton onClick={commitRename} label={t('attachment.saveName')}>
              <Check className="text-accent" />
            </ActionButton>
            <ActionButton onClick={cancelRename} label={t('common:actions.cancel')} tip="above-end">
              <X />
            </ActionButton>
          </div>
        ) : (
          <div className="hidden @[30rem]/chip:flex shrink-0 items-center gap-0.5">{fileTools}</div>
        )}
      </div>

          {/* ---- Seek (audio only) ----
              Rendered at rest rather than on first play, so the note does
              not reflow under the reader. It is inert until the file is
              loaded, because filling it in advance would mean decrypting
              every recording in the note on open. */}
          {playable && (
            <div className="flex items-center gap-2 mt-2.5">
              <span className="shrink-0 text-meta text-pn-muted tabular-nums">
                {formatDuration(position)}
              </span>
              {/* Before the first play the length is unknown: a bare track,
                  not a disabled grey thumb parked at 0. */}
              {duration <= 0 ? (
                <div aria-hidden="true" className="flex-1 h-1 rounded-full bg-track" />
              ) : (
              <RangeSlider
                min={0}
                max={duration || 1}
                step={0.1}
                value={duration > 0 ? Math.min(position, duration) : 0}
                disabled={duration <= 0}
                onChange={(e) => {
                  const next = parseFloat(e.target.value);
                  setPosition(next);
                  if (audioRef.current) audioRef.current.currentTime = next;
                }}
                onClick={(e) => e.stopPropagation()}
                // Same reasoning as the rename field: stop the press without
                // preventing it, or the thumb cannot be grabbed at all.
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                draggable={false}
                onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                aria-label={t('attachment.seek')}
                aria-valuetext={formatDuration(position)}
                className="flex-1"
              />
              )}
              <span className="shrink-0 text-meta text-pn-muted tabular-nums">
                {duration > 0 ? formatDuration(duration) : '--:--'}
              </span>
            </div>
          )}

      {/* ---- Tool row: labeled tools, then the file tools on a narrow chip ---- */}
      {!renaming && (
        <div
          ref={toolRowRef}
          className={`flex items-center gap-1.5 mt-2.5 ${labeled.length ? '' : '@[30rem]/chip:hidden'}`}
        >
          {labeled}
          <span className="flex-1" />
          <div className="flex @[30rem]/chip:hidden shrink-0 items-center gap-0.5">{fileTools}</div>
        </div>
      )}
    </div>
  );

  const damagedNotice = (
    <Callout
      tone="danger"
      action={
        <FeedbackButton
          action="retry"
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); void handleRetry(); }}
          className={BUTTON_CONTENT}
        >
          {t('auth:signIn.tryAgain')}
        </FeedbackButton>
      }
    >
      {t('attachment.damaged')}
    </Callout>
  );

  return (
    <NodeViewWrapper
      // my-6 (24px) is one line of body copy (15px x 1.7). With the ghost
      // paragraph gone, this margin IS the gap between stacked chips - 12px
      // read as a solid block, and the old two-line crater was 75px.
      className="encrypted-attachment-wrapper @container/chip my-6 leading-none"
      // Same defect as EncryptedImage: the node spec sets draggable: true, but
      // a React node view also needs this attribute or TipTap never starts the
      // drag. Fixed together because the two are the media-block pair
      // everywhere else (MEDIA_NODE_NAMES, MediaGapCleaner), and an attachment
      // chip that cannot be reordered is the same bug.
      data-drag-handle
    >
      {showPreview && uuid ? (
        <div className={`rounded-xl border overflow-hidden bg-surface-2 transition ${frameTone}`}>
          {damaged
            ? <div className="p-3">{damagedNotice}</div>
            : <FilePreview uuid={uuid} pdf={isPdfFile} mail={isMailFile} name={filename || ''} onOpen={openViewer} onDamaged={markDamaged} />}
          {row}
        </div>
      ) : (
        <>
          {row}
          {damaged && <div className="mt-2">{damagedNotice}</div>}
        </>
      )}
      {cleanNotice && <div className="mt-2">{cleanNotice}</div>}
      {cleanUndo && (
        <Snackbar actionLabel={t('notes:editor.undo')} onAction={undoClean}>
          {t('noiseRemoved')}
        </Snackbar>
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </NodeViewWrapper>
  );
}

// ------------------------------------------------------------------
// Global store registry - set by NotesView when auth is ready
// ------------------------------------------------------------------

let _attachmentStore: AttachmentStore | null = null;

export function setAttachmentStore(store: AttachmentStore | null) {
  _attachmentStore = store;
}

function getAttachmentStore(): AttachmentStore | null {
  return _attachmentStore;
}

/**
 * As loadAttachmentData, except that bytes which do not open throw
 * BlobDamagedError: the one failure a chip or a picture shows as damaged.
 */
async function readAttachmentData(uuid: string): Promise<DecryptedAttachment | null> {
  const store = getAttachmentStore();
  if (!store) return null;
  try {
    return await store.getAttachment(uuid);
  } catch (err) {
    if (isBlobDamaged(err)) throw err;
    return null;
  }
}

/** A decrypted attachment, or null when it is neither here nor on the server. */
export async function loadAttachmentData(uuid: string): Promise<DecryptedAttachment | null> {
  return readAttachmentData(uuid).catch(() => null);
}

/**
 * Attachment pictures as object URLs, kept for the session the way the
 * picture cache in EncryptedImage.tsx is, so a chip, a Files tile, a picture
 * placed from Files and the viewer that show one file decrypt it once.
 */
const attachmentUrlCache = new Map<string, string>();

/**
 * An object URL for an attachment's bytes, or null when it is not here and
 * not on the server; bytes that do not open throw BlobDamagedError.
 * Typed by the stored MIME, because an SVG in an untyped blob does not draw.
 */
export async function readAttachmentUrl(uuid: string): Promise<string | null> {
  const cached = attachmentUrlCache.get(uuid);
  if (cached) return cached;
  const att = await readAttachmentData(uuid);
  if (!att) return null;
  const drawable = await drawablePicture(att.data);
  const existing = attachmentUrlCache.get(uuid);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([drawable.bytes as BlobPart], { type: drawable.mime ?? (att.meta.mime || '') }));
  attachmentUrlCache.set(uuid, url);
  return url;
}

/** An object URL for an attachment's bytes, or null when it cannot be read. */
export async function loadAttachmentUrl(uuid: string): Promise<string | null> {
  return readAttachmentUrl(uuid).catch(() => null);
}

/** The cached URL, without reading anything. Lets a node view paint on its first frame. */
export function cachedAttachmentUrl(uuid: string): string | null {
  return attachmentUrlCache.get(uuid) ?? null;
}

/** The attachment an object URL of this tab shows, or null. A paste of the
 *  browser's "Copy image" names that URL, and this turns it back into the
 *  stored file instead of a second copy. Spec: docs/internal/specs/picture-copy-reuse.md */
export function attachmentIdForUrl(url: string): string | null {
  for (const [uuid, cached] of attachmentUrlCache) if (cached === url) return uuid;
  return null;
}

/** A PDF's first page as a picture, with the document's page count. */
export type PdfCoverImage = { url: string; pages: number };

/** Draws in flight or done, by attachment uuid. A chip mounts again on every
 *  edit near it, and re-reading a large PDF each time would show; holding the
 *  promise also lets the chip, the card and a Files tile share one draw. */
const pdfCoverDraws = new Map<string, Promise<PdfCoverImage>>();
/** The same covers once drawn, so a remount paints on its first frame. */
const pdfCovers = new Map<string, PdfCoverImage>();

/**
 * The first page of a stored PDF, drawn once per session per file. pdf.js is
 * fetched by the first call. Rejects when the file cannot be read or opened,
 * and a failure is not remembered: the file may arrive with the next sync.
 */
export function loadPdfCover(uuid: string): Promise<PdfCoverImage> {
  let pending = pdfCoverDraws.get(uuid);
  if (!pending) {
    pending = (async () => {
      const [{ drawCover }, att] = await Promise.all([import('./PdfPages'), loadAttachmentData(uuid)]);
      if (!att) throw new Error('missing');
      // pdf.js takes ownership of the bytes it is given, so it gets a copy.
      const cover = await drawCover(new Uint8Array(att.data));
      pdfCovers.set(uuid, cover);
      return cover;
    })();
    pdfCoverDraws.set(uuid, pending);
    pending.catch(() => pdfCoverDraws.delete(uuid));
  }
  return pending;
}

/** The drawn cover, without reading anything. */
export function cachedPdfCover(uuid: string): PdfCoverImage | null {
  return pdfCovers.get(uuid) ?? null;
}

/** The file card's further pages (2 and 3), drawn only for a card with
 *  several pages; the chip and Files need only the cover. */
const pdfStripDraws = new Map<string, Promise<string[]>>();
const pdfStrips = new Map<string, string[]>();

export function loadPdfStrip(uuid: string, last: number): Promise<string[]> {
  let pending = pdfStripDraws.get(uuid);
  if (!pending) {
    pending = (async () => {
      const [{ drawStrip }, att] = await Promise.all([import('./PdfPages'), loadAttachmentData(uuid)]);
      if (!att) throw new Error('missing');
      const urls = await drawStrip(new Uint8Array(att.data), last);
      pdfStrips.set(uuid, urls);
      return urls;
    })();
    pdfStripDraws.set(uuid, pending);
    pending.catch(() => pdfStripDraws.delete(uuid));
  }
  return pending;
}

export function cachedPdfStrip(uuid: string): string[] | null {
  return pdfStrips.get(uuid) ?? null;
}

// ------------------------------------------------------------------
// Upload handler
// ------------------------------------------------------------------

export type AttachmentUploadContext = {
  isPro: boolean;
  attachmentStore: AttachmentStore;
  onQuotaExceeded?: () => void;
  getQuota?: () => { usedBytes: number; maxBytes: number } | null;
};

let _uploadContext: AttachmentUploadContext | null = null;

export function setAttachmentUploadContext(ctx: AttachmentUploadContext | null) {
  _uploadContext = ctx;
}

/**
 * Checks, prepares and stores one file as an encrypted attachment, without
 * putting it into a note: the size cap, the image switches, the quota, then
 * the store. Null when it was refused (the reason is already shown).
 */
async function storeAttachment(file: File, opts: AttachmentUploadOptions = {}): Promise<{ uuid: string; meta: AttachmentMeta; uploaded: Promise<void> } | null> {
  if (!_uploadContext) return null;

  // Validate file size (storage-sub holders get a larger per-file cap).
  const maxBytes = _uploadContext.getQuota?.()?.maxBytes ?? 0;
  const validation = validateAttachment(file, _uploadContext.isPro, maxBytes > 500 * 1000 * 1000);
  if (!validation.ok) {
    alert(validation.error);
    return null;
  }

  // An image through the paperclip is still a file chip, but its bytes
  // obey the image switches like every other door, and the chip then names
  // the stored format so a download opens. A picture the module cannot
  // read is stored as it arrived, the way every non-image is. A vault
  // item's file (`keepOriginal`) is always stored as it arrived: a backup
  // QR or a scan of recovery codes wants its own bytes and name.
  let upload = file;
  if (!opts.keepOriginal && isSupportedImage(file)) {
    const processed = await processImage(file, currentImageOptions());
    if (processed.ok) {
      upload = new File([processed.image.data as BlobPart], processed.image.name, { type: processed.image.mime });
    }
  }

  // Pre-flight quota check, incoming file included: the bytes about to be
  // stored plus encryption overhead are the exact cost.
  if (_uploadContext.getQuota) {
    const q = _uploadContext.getQuota();
    if (q && q.usedBytes + estimateBlobBytes(upload.size) > q.maxBytes) {
      _uploadContext.onQuotaExceeded?.();
      return null;
    }
  }

  try {
    return await _uploadContext.attachmentStore.uploadAttachment(upload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('Quota exceeded')) {
      _uploadContext.onQuotaExceeded?.();
    } else {
      alert(i18n.t('media:attachment.uploadFailed', { message: msg || i18n.t('media:attachment.unknownError') }));
    }
    return null;
  }
}

/** Remove noise: the cleaned recording stored as an attachment of its own, as the chip's new attributes. */
async function storeAttachmentFile(file: File): Promise<{ attrs: AudioAttrs; uploaded: Promise<void> } | null> {
  const stored = await storeAttachment(file);
  if (!stored) return null;
  return {
    attrs: { src: `${FILE_URI_PREFIX}${stored.uuid}`, filename: stored.meta.name, filesize: formatFileSize(stored.meta.size), mimetype: stored.meta.mime },
    uploaded: stored.uploaded,
  };
}

async function handleAttachmentUpload(
  file: File,
  view: EditorView,
  opts: AttachmentUploadOptions = {},
): Promise<string | null> {
  const stored = await storeAttachment(file, opts);
  if (!stored) return null;
  const { uuid, meta, uploaded } = stored;

  // The note may have turned read-only, or closed, while the file was
  // stored. Nothing is inserted then; the stored blob is named by no note,
  // and the orphan reconcile (imageGC.ts) reclaims it. A failed background
  // upload then has no node to take out, only a rejection to settle.
  if (!view.editable || view.isDestroyed) {
    uploaded.catch(() => {});
    return null;
  }

  // Insert attachment node. If the cursor is in an empty paragraph,
  // replace it; otherwise insert after the current block. Avoids the
  // "phantom empty paragraph above" that happens when a block node
  // gets inserted at an inline position.
  const { schema } = view.state;
  const attachmentNode = schema.nodes['attachment'];
  if (!attachmentNode) return null;

  const attachmentSrc = `${FILE_URI_PREFIX}${uuid}`;
  const node = attachmentNode.create({
    src: attachmentSrc,
    filename: meta.name,
    filesize: formatFileSize(meta.size),
    mimetype: meta.mime,
  });
  const $pos = view.state.doc.resolve(view.state.selection.to);
  const parentNode = $pos.parent;
  if (
    parentNode.type.name === 'paragraph' &&
    parentNode.content.size === 0 &&
    $pos.depth > 0
  ) {
    const start = $pos.before($pos.depth);
    const end = $pos.after($pos.depth);
    const tr = view.state.tr.replaceWith(start, end, node);
    view.dispatch(tr.scrollIntoView());
  } else {
    const insertAfter = $pos.depth > 0 ? $pos.after($pos.depth) : $pos.pos;
    const tr = view.state.tr.insert(insertAfter, node);
    view.dispatch(tr.scrollIntoView());
  }

  // If the background upload fails permanently, remove the ghost node
  // from the editor so it doesn't persist in the saved note.
  uploaded.catch(() => {
    if (view.isDestroyed) return;
    const { doc, tr } = view.state;
    let found = false;
    doc.descendants((n, pos) => {
      if (found) return false;
      if (n.type.name === 'attachment' && n.attrs.src === attachmentSrc) {
        tr.delete(pos, pos + n.nodeSize);
        found = true;
        return false;
      }
    });
    if (found) view.dispatch(tr);
  });
  return attachmentSrc;
}

/** How one upload treats its file. `keepOriginal` skips the image
 *  switches, so a picture keeps its bytes, name and MIME. */
type AttachmentUploadOptions = { keepOriginal?: boolean };

/** Public entry point for toolbar file picker. Gives the placed chip's `src`, or null when none was placed. */
export async function triggerAttachmentUpload(
  file: File,
  view: EditorView,
  opts: AttachmentUploadOptions = {},
): Promise<string | null> {
  return handleAttachmentUpload(file, view, opts);
}

// ------------------------------------------------------------------
// ProseMirror plugin for paste/drop interception (non-image files)
// ------------------------------------------------------------------

const attachmentUploadPluginKey = new PluginKey('attachmentUpload');

function createAttachmentUploadPlugin() {
  return new Plugin({
    key: attachmentUploadPluginKey,
    props: {
      handleDrop(view, event) {
        if (!event.dataTransfer?.files?.length) return false;
        // Only handle non-image files. Images are handled by the
        // EncryptedImage plugin.
        const files = Array.from(event.dataTransfer.files).filter(
          (f) => !isImageFile(f),
        );
        if (files.length === 0) return false;

        event.preventDefault();
        for (const file of files) {
          void handleAttachmentUpload(file, view);
        }
        return true;
      },

      handlePaste(view, event) {
        const items = event.clipboardData?.items;
        if (!items) return false;

        const files: File[] = [];
        for (const item of Array.from(items)) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file && !isImageFile(file)) files.push(file);
          }
        }

        if (files.length === 0) return false;
        event.preventDefault();
        for (const file of files) {
          void handleAttachmentUpload(file, view);
        }
        return true;
      },
    },
  });
}

// ------------------------------------------------------------------
// TipTap Extension
// ------------------------------------------------------------------

export type AttachmentOptions = {
  /**
   * Called with the new name after a chip is renamed. The editor decides
   * whether anything outside the document should follow; see the wiring in
   * `Editor.tsx`.
   */
  onRename: ((name: string) => void) | null;
  /**
   * The note is one the Files pillar made. While it holds one file, that file
   * is the whole note and its name alone previews nothing, so a picture or a
   * PDF draws as a card with the file itself on it instead of a one-line
   * chip. A note of several files keeps its chips (`showsFileCard`).
   */
  filePreview: boolean;
};

export const EncryptedAttachment = Node.create<AttachmentOptions>({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return { onRename: null, filePreview: false };
  },

  addAttributes() {
    return {
      src: { default: null },
      filename: { default: null },
      filesize: { default: null },
      mimetype: { default: null },
    };
  },

  parseHTML() {
    return [
      // Explicit data-attachment tag (from renderHTML).
      {
        tag: 'a[data-attachment]',
        getAttrs(dom) {
          const el = dom as HTMLAnchorElement;
          return {
            src: el.getAttribute('href'),
            filename: el.getAttribute('data-filename'),
            filesize: el.getAttribute('data-filesize'),
            mimetype: el.getAttribute('data-mimetype'),
          };
        },
      },
      // markdown-it produces <a href="pn:file/uuid">name|size|mime</a>
      // from [name|size|mime](pn:file/uuid). Detect via href prefix.
      {
        tag: 'a[href^="pn:file/"]',
        getAttrs(dom) {
          const el = dom as HTMLAnchorElement;
          const href = el.getAttribute('href') || '';
          // Parse pipe-delimited text: "filename|size|mime"
          const text = el.textContent || '';
          const parts = text.split('|');
          return {
            src: href,
            // The link text is whatever the note holds, an import's included,
            // so the name shown and saved goes through the same cleaning as
            // a rename.
            filename: cleanFileName(parts[0] || '', 'Attachment'),
            filesize: parts[1] || '',
            mimetype: parts[2] || '',
          };
        },
        // Higher priority than the Link extension so we intercept first.
        priority: 60,
      },
    ];
  },

  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, string> }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-attachment': 'true',
        'data-filename': HTMLAttributes.filename,
        'data-filesize': HTMLAttributes.filesize,
        'data-mimetype': HTMLAttributes.mimetype,
        href: HTMLAttributes.src,
      }),
      HTMLAttributes.filename || 'Attachment',
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EncryptedAttachmentView as never);
  },

  addProseMirrorPlugins() {
    return [createAttachmentUploadPlugin()];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            esc: (s: string) => string;
            closeBlock: (n: unknown) => void;
          },
          node: { attrs: { src: string; filename: string; filesize: string; mimetype: string } },
        ) {
          // Serialize as: [filename|size|mime](pn:file/<uuid>)
          // The pipe-delimited format packs metadata into the link text
          // so it survives markdown roundtrip without needing extra syntax.
          const name = state.esc(node.attrs.filename || 'Attachment');
          const size = state.esc(node.attrs.filesize || '');
          const mime = state.esc(node.attrs.mimetype || '');
          const src = state.esc(node.attrs.src || '');
          state.write(`[${name}|${size}|${mime}](${src})`);
          // closeBlock, NOT a trailing "\n". This is a BLOCK node, and only
          // closeBlock leaves the blank line that makes the next block its own
          // paragraph. With a bare newline, two chips landed on consecutive
          // lines, markdown-it (breaks: true) turned the softbreak into <br>,
          // and ProseMirror lifted each block chip out of that paragraph -
          // leaving a <br>-only paragraph between every pair. That ghost
          // paragraph is two lines tall (measured: a 12px gap became 75px) and
          // came back on every reload, because nothing could tell it apart from
          // a line the user typed. It also glued the paragraph AFTER a chip
          // onto the chip's own line.
          state.closeBlock(node);
        },
        parse: {
          // markdown-it parses [text](href) → <a href="...">text</a>
          // We need a custom rule to detect pn:file/ links and convert
          // them into our attachment node.
        },
      },
    };
  },
});
