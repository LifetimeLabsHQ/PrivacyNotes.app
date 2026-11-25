import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePdf, Image as ImageIcon, Scan, TextT } from '../icons';
import { decodablePicture, IMAGE_FIT_PX, IMAGE_JPEG_QUALITY } from '../imageProcessing';
import { planIsPro } from '../plugins/pluginState';
import { Switch } from '../Switch';
import { Button, Modal, StatusLine } from '../ui';
import { cross, polyArea, type Point, type Quad, type Rgba } from './pageCorners';
import type { Paper } from './pageWarp';
import { jpegToPdf } from './pagePdf';
import type { ScanReply, ScanRequest } from './scanWorker';

/**
 * Scan a page (free, D14): the photo with the found corners to drag, then
 * the flat page with "Clean up" and the choice of a picture or a one-page
 * PDF. The original photo is never stored; only the result goes through the
 * normal save doors. OCR, when it runs, reads the warped page, never the
 * cleaned one.
 * Spec: docs/internal/plans/plugins.md (section 6.3), docs/internal/specs/plugins-scan.md (section 5)
 */

/** The photo is decoded at most this long on its long edge: the page comes out at 2048 at most. Spec: docs/internal/specs/plugins-scan.md (section 2) */
const DECODE_PX = 3000;
/** The page snaps to A4 or Letter only when it covers at least this share of the photo. Spec: docs/internal/plans/plugins.md (section 6.3) */
const SNAP_COVER = 0.5;
/** The loupe on touch: its size in CSS pixels and how much it magnifies. Spec: docs/internal/specs/plugins-scan.md (section 5) */
const LOUPE_PX = 110;
const LOUPE_ZOOM = 2.5;
const CLEAN_KEY = 'privacynotes.scan.cleanUp';

/** `page` is the warped page before any clean-up, as a JPEG: OCR reads that one, never the cleaned page. */
/** A picture or a PDF, with the page for "Also add the text"; or the text alone, read from the page by Text in pictures. */
export type ScanResult =
  | { kind: 'picture' | 'pdf'; file: File; page: Uint8Array<ArrayBuffer> | null }
  | { kind: 'text'; page: Uint8Array<ArrayBuffer> };

function readClean(): boolean {
  try {
    return localStorage.getItem(CLEAN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeClean(on: boolean): void {
  try {
    if (on) localStorage.setItem(CLEAN_KEY, '1');
    else localStorage.removeItem(CLEAN_KEY);
  } catch {
    // A private window: for this session only.
  }
}

async function decodePhoto(file: File): Promise<{ img: Rgba; bitmap: ImageBitmap }> {
  const blob = await decodablePicture(file);
  const probe = await createImageBitmap(blob);
  const s = Math.min(1, DECODE_PX / Math.max(probe.width, probe.height));
  const width = Math.max(1, Math.round(probe.width * s));
  const height = Math.max(1, Math.round(probe.height * s));
  probe.close();
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  return { img: { data, width, height }, bitmap };
}

async function encodeJpeg(page: Rgba): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = new OffscreenCanvas(page.width, page.height);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(page.data), page.width, page.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: IMAGE_JPEG_QUALITY });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Every turn of the quad goes the same way: a page, not a bow tie. */
function isConvex(q: Quad): boolean {
  const s = q.map((p, i) => Math.sign(cross(p, q[(i + 1) % 4]!, q[(i + 2) % 4]!)));
  return s.every((v) => v !== 0 && v === s[0]);
}

export function ScanEditor({ file, flat = false, withTextOffer, onRetake, onDone, onClose }: {
  file: File;
  /** The page is already flat (VisionKit's scanner on iOS): no corner editor. */
  flat?: boolean;
  /** Text in pictures is on: the result offers "Also add the text". */
  withTextOffer: boolean;
  onRetake: () => void;
  onDone: (result: ScanResult) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('media');
  const worker = useRef<Worker | null>(null);
  const [photo, setPhoto] = useState<{ w: number; h: number; url: string; bitmap: ImageBitmap } | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [page, setPage] = useState<{ raw: Rgba; shown: Rgba; paper: Paper } | null>(null);
  const [clean, setClean] = useState(readClean);
  const [withText, setWithText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const ask = (req: ScanRequest, w: Worker | null = worker.current) =>
    new Promise<ScanReply>((resolve) => {
      if (!w) return resolve({ op: 'error' });
      w.onmessage = (e: MessageEvent<ScanReply>) => resolve(e.data);
      w.postMessage(req);
    });

  useEffect(() => {
    const w = new Worker(new URL('./scanWorker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    let live = true;
    let url = '';
    void (async () => {
      try {
        const { img, bitmap } = await decodePhoto(file);
        url = URL.createObjectURL(file);
        if (flat) {
          const reply = await ask({ op: 'flat', img }, w);
          if (!live) return;
          if (reply.op !== 'clean') throw new Error('scan');
          setPhoto({ w: img.width, h: img.height, url, bitmap });
          setQuad([{ x: 0, y: 0 }, { x: img.width, y: 0 }, { x: img.width, y: img.height }, { x: 0, y: img.height }]);
          let shown = img;
          if (readClean()) {
            const c = await ask({ op: 'clean' }, w);
            if (c.op === 'clean') shown = c.page;
          }
          setPage({ raw: img, shown, paper: null });
          return;
        }
        // This run's own worker: a second run of the effect has another one.
        const reply = await ask({ op: 'photo', img }, w);
        if (!live) return;
        if (reply.op !== 'photo') throw new Error('scan');
        setPhoto({ w: img.width, h: img.height, url, bitmap });
        // Not found: the handles sit 4 % in from the photo's corners.
        const inset = (p: Point): Point => ({ x: p.x === 0 ? img.width * 0.04 : p.x - img.width * 0.04, y: p.y === 0 ? img.height * 0.04 : p.y - img.height * 0.04 });
        const start = reply.found ? reply.corners : (reply.corners.map(inset) as Quad);
        setQuad(start);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
      w.terminate();
      if (url) URL.revokeObjectURL(url);
    };
    // One editor per photo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const usePage = async () => {
    if (!quad || !photo || !isConvex(quad)) return;
    setBusy(true);
    const reply = await ask({ op: 'warp', quad, snap: polyArea(quad) >= SNAP_COVER * photo.w * photo.h, maxPx: IMAGE_FIT_PX });
    if (reply.op !== 'warp') {
      setFailed(true);
      setBusy(false);
      return;
    }
    let shown = reply.page;
    if (clean) {
      const c = await ask({ op: 'clean' });
      if (c.op === 'clean') shown = c.page;
    }
    setPage({ raw: reply.page, shown, paper: reply.paper });
    setBusy(false);
  };

  const toggleClean = async (on: boolean) => {
    setClean(on);
    writeClean(on);
    if (!page) return;
    if (!on) setPage({ ...page, shown: page.raw });
    else {
      const c = await ask({ op: 'clean' });
      if (c.op === 'clean') setPage({ ...page, shown: c.page });
    }
  };

  const insert = async (kind: 'picture' | 'pdf' | 'text') => {
    if (!page) return;
    setBusy(true);
    // The text is read from the page before Clean up, as "Also add the text" does.
    if (kind === 'text') return onDone({ kind, page: await encodeJpeg(page.raw) });
    const jpeg = await encodeJpeg(page.shown);
    const stem = file.name.replace(/\.[^.]+$/, '') || 'scan';
    const out = kind === 'picture'
      ? new File([jpeg], `${stem}.jpg`, { type: 'image/jpeg' })
      : new File([jpegToPdf(jpeg, page.paper)], `${stem}.pdf`, { type: 'application/pdf' });
    onDone({ kind, file: out, page: withText ? (page.shown === page.raw ? jpeg : await encodeJpeg(page.raw)) : null });
  };

  return (
    <Modal title={t('scanPage')} icon={<Scan />} onClose={onClose} layer="z-[60]" className="max-w-2xl w-full p-6 space-y-4" escape={!busy}>
      {failed ? (
        <StatusLine tone="danger">{t('image.loadFailed')}</StatusLine>
      ) : !photo || !quad ? (
        <StatusLine busy>{t('scanPage')}</StatusLine>
      ) : page ? (
        <ResultScreen page={page.shown} clean={clean} onClean={(on) => void toggleClean(on)} withTextOffer={withTextOffer} withText={withText} onWithText={setWithText} busy={busy} onInsert={(k) => void insert(k)} />
      ) : (
        <>
          <CornerEditor photo={photo} quad={quad} onChange={setQuad} onEnter={() => void usePage()} />
          <p className="text-help text-pn-soft">{t('dragCorner')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button action="back" onClick={onRetake}>{t('retake')}</Button>
            <Button action="confirm" disabled={!isConvex(quad) || busy} onClick={() => void usePage()}>{t('usePage')}</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** A choice tile: icon, label and line start at the left edge, so the three line up; the Pro mark ends the row. */
const TILE = 'w-full !justify-start';

/** The flat page, "Clean up", and the three ways to keep it. */
function ResultScreen({ page, clean, onClean, withTextOffer, withText, onWithText, busy, onInsert }: {
  page: Rgba;
  clean: boolean;
  onClean: (on: boolean) => void;
  withTextOffer: boolean;
  withText: boolean;
  onWithText: (on: boolean) => void;
  busy: boolean;
  onInsert: (kind: 'picture' | 'pdf' | 'text') => void;
}) {
  const { t } = useTranslation('media');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = page.width;
    c.height = page.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(page.data), page.width, page.height), 0, 0);
  }, [page]);
  return (
    <div className="flex flex-col gap-4">
      <canvas ref={canvas} className="mx-auto max-h-[50vh] max-w-full rounded-md border border-divider object-contain" />
      <Switch label={t('cleanUp')} checked={clean} onChange={onClean} />
      {withTextOffer && <Switch label={t('alsoText')} checked={withText} onChange={onWithText} />}
      {/* Three ways to keep the page, each with its own icon: no checkmarks (owner, 2026-11-18). */}
      <div className="grid gap-2 sm:grid-cols-3">
        <Button icon={<ImageIcon />} variant="secondary" className={TILE} disabled={busy} onClick={() => onInsert('picture')}>
          <span className="flex flex-1 flex-col items-start text-start">
            <span>{t('insertPicture')}</span>
            <span className="text-small text-pn-muted">{t('insertPictureDesc')}</span>
          </span>
        </Button>
        <Button icon={<FilePdf />} variant="secondary" className={TILE} disabled={busy} onClick={() => onInsert('pdf')}>
          <span className="flex flex-1 flex-col items-start text-start">
            <span>{t('insertPdf')}</span>
            <span className="text-small text-pn-muted">{t('insertPdfDesc')}</span>
          </span>
        </Button>
        <Button icon={<TextT />} variant="secondary" className={TILE} pro={!planIsPro()} disabled={busy} onClick={() => onInsert('text')}>
          <span className="flex flex-1 flex-col items-start text-start">
            <span>{t('insertText')}</span>
            <span className="text-small text-pn-muted">{t('insertTextDesc')}</span>
          </span>
        </Button>
      </div>
    </div>
  );
}

/**
 * The photo with the quad: four corner handles and a handle on each side
 * that moves that side in parallel. A handle follows the pointer's movement,
 * not its position, so a finger never hides the point; on touch a loupe
 * shows the photo under it. Arrow keys move the focused handle 1 px (Shift
 * 10 px), Enter uses the page. A quad that is not convex draws red.
 */
function CornerEditor({ photo, quad, onChange, onEnter }: {
  photo: { w: number; h: number; url: string; bitmap: ImageBitmap };
  quad: Quad;
  onChange: (q: Quad) => void;
  onEnter: () => void;
}) {
  const { t } = useTranslation('media');
  const box = useRef<HTMLDivElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ handle: number; last: { x: number; y: number }; touch: boolean } | null>(null);
  const [loupeAt, setLoupeAt] = useState<{ x: number; y: number; p: Point } | null>(null);
  const ok = isConvex(quad);

  const scale = () => photo.w / (box.current?.clientWidth || photo.w);
  const clamp = (p: Point): Point => ({ x: Math.max(0, Math.min(photo.w, p.x)), y: Math.max(0, Math.min(photo.h, p.y)) });
  /** Handles 0 to 3 are corners; 4 to 7 the sides after each corner. */
  const move = (handle: number, dx: number, dy: number): Quad => {
    const next = quad.map((p) => ({ ...p })) as Quad;
    const ids = handle < 4 ? [handle] : [handle - 4, (handle - 3) % 4];
    for (const i of ids) next[i] = clamp({ x: next[i]!.x + dx, y: next[i]!.y + dy });
    return next;
  };
  const handlePoint = (i: number): Point => (i < 4 ? quad[i]! : { x: (quad[i - 4]!.x + quad[(i - 3) % 4]!.x) / 2, y: (quad[i - 4]!.y + quad[(i - 3) % 4]!.y) / 2 });

  const down = (i: number) => (e: ReactPointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { handle: i, last: { x: e.clientX, y: e.clientY }, touch: e.pointerType === 'touch' };
  };
  const moveTo = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const s = scale();
    const next = move(d.handle, (e.clientX - d.last.x) * s, (e.clientY - d.last.y) * s);
    d.last = { x: e.clientX, y: e.clientY };
    onChange(next);
    if (d.touch) setLoupeAt({ x: e.clientX, y: e.clientY, p: d.handle < 4 ? next[d.handle]! : next[d.handle - 4]! });
  };
  const up = () => {
    drag.current = null;
    setLoupeAt(null);
  };
  const key = (i: number) => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const dir: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = dir[e.key];
    if (d) {
      e.preventDefault();
      onChange(move(i, d[0], d[1]));
    } else if (e.key === 'Enter' && ok) {
      e.preventDefault();
      onEnter();
    }
  };

  useEffect(() => {
    const c = loupe.current;
    if (!c || !loupeAt) return;
    const ctx = c.getContext('2d')!;
    const src = LOUPE_PX / LOUPE_ZOOM;
    ctx.clearRect(0, 0, LOUPE_PX, LOUPE_PX);
    ctx.drawImage(photo.bitmap, loupeAt.p.x - src / 2, loupeAt.p.y - src / 2, src, src, 0, 0, LOUPE_PX, LOUPE_PX);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(LOUPE_PX / 2, 0);
    ctx.lineTo(LOUPE_PX / 2, LOUPE_PX);
    ctx.moveTo(0, LOUPE_PX / 2);
    ctx.lineTo(LOUPE_PX, LOUPE_PX / 2);
    ctx.stroke();
  }, [loupeAt, photo.bitmap]);

  const pts = quad.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <div ref={box} className="relative mx-auto w-full select-none touch-none" style={{ aspectRatio: `${photo.w} / ${photo.h}`, maxHeight: '60vh' }} onPointerMove={moveTo} onPointerUp={up} onPointerCancel={up}>
      <img src={photo.url} alt="" className="absolute inset-0 h-full w-full rounded-md object-contain" draggable={false} />
      <svg viewBox={`0 0 ${photo.w} ${photo.h}`} className="absolute inset-0 h-full w-full" aria-hidden="true">
        <path d={`M0,0 H${photo.w} V${photo.h} H0 Z M${pts.replace(/ /g, ' L')} Z`} fill="rgba(0,0,0,0.45)" fillRule="evenodd" />
        <polygon points={pts} fill="none" stroke={ok ? 'rgb(var(--pn-accent))' : 'rgb(var(--pn-danger))'} strokeWidth={photo.w / 300} />
      </svg>
      {Array.from({ length: 8 }, (_, i) => {
        const p = handlePoint(i);
        return (
          <button
            key={i}
            type="button"
            aria-label={t('dragCorner')}
            onPointerDown={down(i)}
            onKeyDown={key(i)}
            className="absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            style={{ left: `${(p.x / photo.w) * 100}%`, top: `${(p.y / photo.h) * 100}%` }}
          >
            <span className={`block rounded-full border-2 border-white shadow ${i < 4 ? 'h-3 w-3' : 'h-2 w-2'} ${ok ? 'bg-accent-fill' : 'bg-danger'}`} />
          </button>
        );
      })}
      {loupeAt && box.current && (
        <canvas
          ref={loupe}
          width={LOUPE_PX}
          height={LOUPE_PX}
          className="pointer-events-none fixed rounded-full border-2 border-white shadow-lg"
          style={{ width: LOUPE_PX, height: LOUPE_PX, left: loupeAt.x - LOUPE_PX / 2, top: loupeAt.y - LOUPE_PX - 40 < 8 ? loupeAt.y + 40 : loupeAt.y - LOUPE_PX - 40 }}
        />
      )}
    </div>
  );
}

