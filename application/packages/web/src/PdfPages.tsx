/**
 * PDF rendering for the shared viewer and the file card, on pdf.js.
 *
 * This module is the only importer of pdf.js, and every caller reaches it
 * through a dynamic import, so the library is fetched the first time somebody
 * opens a PDF and never on the way to the first render.
 *
 * Three decisions, each measured against what the app ships on:
 * - The LEGACY build. The modern one calls newer built-ins than the WebKit on
 *   our oldest supported iOS and macOS provides.
 * - No WebAssembly. Our content security policy does not allow it, so the
 *   JBIG2 and JPEG 2000 decoders that scanned documents use run from the
 *   JavaScript fallbacks the build copies to `pdfjs/<version>/`
 *   (vite.config.ts, pdfjsDecoders).
 * - Pages are drawn onto canvases, one per page, only while a page is near
 *   the screen. No text or link layer: a PDF is read here, not clicked
 *   through, so nothing inside one can navigate the app.
 *
 * Spec: docs/internal/design/ui-patterns.md (section 98, the picture viewer)
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GlobalWorkerOptions,
  PDFWorker,
  getDocument,
  version as pdfjsVersion,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { cachedPdfCover, cachedPdfStrip, loadPdfCover, loadPdfStrip, type PdfCoverImage } from './EncryptedAttachment';
import { useNearScreen } from './useNearScreen';

GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * One worker for every document, the viewer's and each cover's. Without it
 * each `getDocument` starts a worker of its own, so a note of many PDFs would
 * run one per file at once. Made on first use, so importing this module starts
 * nothing, and kept for the session: destroying a document leaves a worker it
 * was handed running.
 */
let sharedWorker: PDFWorker | null = null;

function pdfWorker(): PDFWorker {
  sharedWorker ??= new PDFWorker();
  return sharedWorker;
}

/** Where the build puts the image decoders. The version is in the path, so a
 *  new pdf.js never meets a decoder cached from the old one. */
function decoderDir(): string {
  return new URL(`pdfjs/${pdfjsVersion}/`, document.baseURI).href;
}

/**
 * The largest canvas one page may use, in device pixels. iOS refuses a canvas
 * much past this, and a zoomed page on a wide screen would otherwise ask for
 * several times the memory it can show.
 */
const MAX_CANVAS_PIXELS = 16_000_000;

export type PdfLoader = () => Promise<Uint8Array | null>;

type Opened =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy }
  | { status: 'password' }
  | { status: 'failed' };

/**
 * Open a document. The bytes are handed to the worker, so pass a copy. One
 * that will not open is closed here, because its caller never receives the
 * task, and a locked PDF would otherwise stay in the shared worker for the
 * session, once for every chip that asks for its cover again.
 */
async function openPdf(bytes: Uint8Array) {
  const task = getDocument({
    data: bytes,
    worker: pdfWorker(),
    useWasm: false,
    wasmUrl: decoderDir(),
  });
  try {
    return { task, doc: await task.promise };
  } catch (err) {
    void task.destroy();
    throw err;
  }
}

function failureStatus(err: unknown): 'password' | 'failed' {
  return err instanceof Error && err.name === 'PasswordException' ? 'password' : 'failed';
}

/** Draw one page onto a canvas at `cssWidth` CSS pixels. */
function drawPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  onAspect: (aspect: number) => void,
): { promise: Promise<void>; cancel: () => void } {
  let task: RenderTask | null = null;
  let cancelled = false;
  const promise = (async () => {
    const page = await doc.getPage(pageNumber);
    if (cancelled) return;
    const base = page.getViewport({ scale: 1 });
    onAspect(base.height / base.width);
    let scale = (cssWidth * (window.devicePixelRatio || 1)) / base.width;
    const area = base.width * base.height * scale * scale;
    if (area > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    task = page.render({ canvas, viewport });
    await task.promise;
  })();
  return {
    promise: promise.catch(() => {}),
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

// ── The viewer: every page, drawn as it nears the screen ────────────

export function PdfPages({ load, zoom, fitMax = Infinity, label }: {
  load: PdfLoader;
  /** 1 fits the page to the pane; larger values scroll sideways. */
  zoom: number;
  /** The widest a page draws at zoom 1, in CSS pixels. */
  fitMax?: number;
  /** The file name, for each page's accessible label. */
  label: string;
}) {
  const { t } = useTranslation('media');
  const scrollRef = useRef<HTMLDivElement>(null);
  // The viewer mounts one of these per file (it is keyed by the file), so the
  // loader is read once; a ref keeps a new closure from reopening the file.
  const loadRef = useRef(load);
  loadRef.current = load;
  const [opened, setOpened] = useState<Opened>({ status: 'loading' });
  const [fitWidth, setFitWidth] = useState(0);
  // The first page's shape stands in for every page until each one is drawn,
  // so the scroll height is close to right before anything renders.
  const [firstAspect, setFirstAspect] = useState(Math.SQRT2);

  useEffect(() => {
    let alive = true;
    let destroy: (() => void) | null = null;
    void (async () => {
      try {
        const bytes = await loadRef.current();
        if (!alive) return;
        if (!bytes) { setOpened({ status: 'failed' }); return; }
        const { task, doc } = await openPdf(bytes);
        destroy = () => { void task.destroy(); };
        if (!alive) { destroy(); return; }
        const first = await doc.getPage(1);
        const base = first.getViewport({ scale: 1 });
        if (!alive) return;
        setFirstAspect(base.height / base.width);
        setOpened({ status: 'ready', doc });
      } catch (err) {
        if (alive) setOpened({ status: failureStatus(err) });
      }
    })();
    return () => {
      alive = false;
      destroy?.();
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setFitWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 12px of gutter on each side at fit, so a page never touches the frame.
  const cssWidth = Math.max(0, Math.floor(Math.min(fitWidth - 24, fitMax) * zoom));

  // No background of its own: the pages sit on the viewer's dark stage.
  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      {opened.status === 'ready' ? (
        <div className="flex flex-col items-center gap-3 p-3 w-max min-w-full">
          {Array.from({ length: opened.doc.numPages }, (_, i) => (
            <PdfPage
              key={i}
              doc={opened.doc}
              pageNumber={i + 1}
              cssWidth={cssWidth}
              initialAspect={firstAspect}
              root={scrollRef}
              label={t('viewer.pageLabel', { name: label, page: i + 1, count: opened.doc.numPages })}
            />
          ))}
        </div>
      ) : (
        <div className="h-full flex items-center justify-center p-6 text-body text-white/70 text-center">
          {opened.status === 'loading'
            ? t('viewer.pdfLoading')
            : opened.status === 'password'
              ? t('viewer.pdfPassword')
              : t('viewer.pdfFailed')}
        </div>
      )}
    </div>
  );
}

function PdfPage({ doc, pageNumber, cssWidth, initialAspect, root, label }: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  cssWidth: number;
  initialAspect: number;
  root: React.RefObject<HTMLDivElement | null>;
  label: string;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(initialAspect);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    // A screen's height of margin above and below: drawn just before it is
    // seen, and let go once it is a screen away.
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      { root: root.current, rootMargin: '100% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!near || cssWidth <= 0) {
      // Width 0 releases the backing store; an off-screen page costs nothing.
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    const draw = drawPage(doc, pageNumber, canvas, cssWidth, setAspect);
    return () => draw.cancel();
  }, [doc, pageNumber, cssWidth, near]);

  return (
    <div
      ref={holderRef}
      className="shrink-0 bg-white shadow-sm"
      style={{ width: cssWidth || undefined, aspectRatio: `1 / ${aspect}` }}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} className="block w-full h-full" />
    </div>
  );
}

// ── The first page as a picture: the file card, the chip and Files ─────

/** Pixel width the cover is drawn at: sharp on a phone at 2x and on a
 *  desktop note column at 1x, and a fraction of a full page's memory. */
const COVER_WIDTH_PX = 900;

/**
 * A page read for Text in pictures: its text layer, or the page as a PNG.
 * `total` is the pages this run reads, `pages` the file's own count.
 */
export type PdfPageForOcr = { page: number; total: number; pages: number; text: string | null; png: ArrayBuffer | null };

/** A scanned page is drawn at this many pixels per PDF point (about 150 dpi) before OCR. */
const OCR_SCALE = 2;

/**
 * Pages one run reads: a scanned page is an OCR run of seconds and a drawn
 * page's memory, so a long file stops here and the sheet names the pages
 * read (beta #240 item 12).
 * Spec: docs/internal/plans/plugins.md (section 6.4)
 */
export const OCR_MAX_PAGES = 50;

/**
 * Fewer visible characters than this in a page's text layer is a scan with
 * a stamp, a page number or a fax header on it: the page is read as a
 * picture (beta #240 item 11).
 * Spec: docs/internal/plans/plugins.md (section 6.4)
 */
const OCR_SPARSE_TEXT = 50;

/** The longest side of a page drawn for OCR: a browser refuses a canvas side far past this, area cap or not. */
const OCR_MAX_SIDE = 8192;

/**
 * Each page of a PDF for Text in pictures, up to `OCR_MAX_PAGES`: a page
 * with a text layer gives its text and needs no OCR; a page without one, or
 * with a nearly empty one, is drawn and handed over as a PNG. Each page is
 * let go once read, so a long scan does not hold every page drawn.
 * Spec: docs/internal/plans/plugins.md (section 6.4)
 */
export async function* readPdfForOcr(bytes: Uint8Array): AsyncGenerator<PdfPageForOcr> {
  const { task, doc } = await openPdf(bytes);
  const pages = doc.numPages;
  const total = Math.min(pages, OCR_MAX_PAGES);
  try {
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+\n/g, '\n').trim();
        if (text.replace(/\s/g, '').length >= OCR_SPARSE_TEXT) {
          yield { page: n, total, pages, text, png: null };
          continue;
        }
        const base = page.getViewport({ scale: 1 });
        let scale = OCR_SCALE;
        const area = base.width * base.height * scale * scale;
        if (area > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
        const side = Math.max(base.width, base.height) * scale;
        if (side > OCR_MAX_SIDE) scale *= OCR_MAX_SIDE / side;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvas, viewport }).promise;
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        // The canvas's pixels go now, not when the collector gets to them.
        canvas.width = 0;
        canvas.height = 0;
        const png = blob ? await blob.arrayBuffer() : null;
        // A page that would not draw keeps what its text layer had.
        yield { page: n, total, pages, text: png || !text ? null : text, png };
      } finally {
        // pdf.js keeps a drawn page's operators and pictures until this.
        page.cleanup();
      }
    }
  } finally {
    void task.destroy();
  }
}

/** Pixel width of the strip's further pages: sharp at 2x in a 220 px tall
 *  strip, where a page is about 155 px wide. */
const STRIP_WIDTH_PX = 360;

/** One page as a PNG object URL, drawn `width` pixels wide. */
async function drawPagePng(doc: Awaited<ReturnType<typeof openPdf>>['doc'], n: number, width: number): Promise<string> {
  const page = await doc.getPage(n);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error('cover');
    return URL.createObjectURL(blob);
  } finally {
    page.cleanup();
  }
}

/** The first page as a PNG, with the page count. One per file per session:
 *  the cache lives beside the attachment URLs (`loadPdfCover`). */
export async function drawCover(bytes: Uint8Array): Promise<PdfCoverImage> {
  const { task, doc } = await openPdf(bytes);
  try {
    return { url: await drawPagePng(doc, 1, COVER_WIDTH_PX), pages: doc.numPages };
  } finally {
    void task.destroy();
  }
}

/** Pages 2 to `last` as small PNGs, for the file card's strip
 *  (`loadPdfStrip`). A page that will not draw ends the strip there. */
export async function drawStrip(bytes: Uint8Array, last: number): Promise<string[]> {
  const { task, doc } = await openPdf(bytes);
  const urls: string[] = [];
  try {
    for (let n = 2; n <= Math.min(last, doc.numPages); n++) {
      try {
        urls.push(await drawPagePng(doc, n, STRIP_WIDTH_PX));
      } catch {
        break;
      }
    }
    return urls;
  } finally {
    void task.destroy();
  }
}

export function PdfCover({ uuid, name }: { uuid: string; name: string }) {
  const { t } = useTranslation('media');
  const [cover, setCover] = useState<PdfCoverImage | null>(() => cachedPdfCover(uuid));
  const [failed, setFailed] = useState<'password' | 'failed' | null>(null);
  // Read and drawn once the card comes near the screen, like the chip's tile:
  // a card further down a long note may never be looked at.
  const placeholderRef = useRef<HTMLSpanElement>(null);
  const near = useNearScreen(placeholderRef, !cover && !failed);

  useEffect(() => {
    if (!near) return;
    // Another reader (the chip's tile, a Files tile) may have drawn it
    // since this mounted: take it, or the card waits forever.
    const drawn = cachedPdfCover(uuid);
    if (drawn) {
      setCover(drawn);
      return;
    }
    let alive = true;
    loadPdfCover(uuid).then(
      (drawn) => { if (alive) setCover(drawn); },
      (err: unknown) => { if (alive) setFailed(failureStatus(err)); },
    );
    return () => { alive = false; };
  }, [near, uuid]);

  // Spans, because the file card renders this inside a button.
  if (failed) {
    return (
      <span className="block px-4 py-8 text-body text-center text-pn-muted">
        {failed === 'password' ? t('viewer.pdfPassword') : t('viewer.pdfFailed')}
      </span>
    );
  }
  if (!cover) {
    return (
      <span ref={placeholderRef} className="block px-4 py-16 text-body text-center text-pn-muted">
        {t('viewer.pdfLoading')}
      </span>
    );
  }
  return cover.pages > 1 ? <PdfStrip uuid={uuid} name={name} cover={cover} /> : (
    // One page: the top of it at the card's full width, cut off at a fixed
    // height with a fade, so the heading reads and the card has no empty
    // sides (owner, 2026-11-20).
    <span className="relative block max-h-[260px] overflow-hidden px-3 pt-3">
      <img
        src={cover.url}
        alt={name}
        draggable={false}
        className="block w-full !my-0 bg-white shadow-sm"
      />
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent to-surface-1" />
    </span>
  );
}

/** How many pages the strip shows: two on a narrow card, three from 30rem. */
const STRIP_PAGES_WIDE = 3;

/**
 * Several pages: the first ones side by side, sharing the width (each up to
 * 220 px), so a card has no empty sides until it is very wide. The last page
 * shown carries "+N" for the pages after it; the page count itself is on
 * the meta line under the card.
 */
function PdfStrip({ uuid, name, cover }: { uuid: string; name: string; cover: PdfCoverImage }) {
  const [rest, setRest] = useState<string[]>(() => cachedPdfStrip(uuid) ?? []);
  useEffect(() => {
    if (cachedPdfStrip(uuid)) return;
    let alive = true;
    loadPdfStrip(uuid, STRIP_PAGES_WIDE).then((urls) => { if (alive) setRest(urls); }, () => {});
    return () => { alive = false; };
  }, [uuid]);
  const pages = [cover.url, ...rest];
  const more = (shown: number) => cover.pages - shown;
  const badge = 'absolute bottom-2 end-2 rounded-md bg-black/60 text-white text-meta font-medium px-1.5 py-0.5';
  return (
    <span className="flex justify-center items-start gap-2.5 p-3">
      {pages.map((url, i) => (
        <span key={url} className={`relative min-w-0 flex-1 max-w-[220px] ${i >= 2 ? 'hidden @[30rem]/chip:block' : 'block'}`}>
          <img src={url} alt={i === 0 ? name : ''} draggable={false} className="block w-full h-auto !my-0 bg-white shadow-sm" />
          {/* "+N" on the last page shown: page 2 on a narrow card, page 3 on a wide one. */}
          {i === 1 && more(2) > 0 && (
            <span aria-hidden="true" className={`${badge} ${pages.length > 2 ? '@[30rem]/chip:hidden' : ''}`}>+{more(2)}</span>
          )}
          {i === 2 && more(3) > 0 && (
            <span aria-hidden="true" className={badge}>+{more(3)}</span>
          )}
        </span>
      ))}
    </span>
  );
}
