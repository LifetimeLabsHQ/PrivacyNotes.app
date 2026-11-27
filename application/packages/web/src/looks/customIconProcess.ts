/**
 * Client-side image squaring and compression for custom icons (48x48 px, <= 5 KB).
 *
 * Loaded lazily only when the user uploads a custom icon, so it adds zero bytes
 * to the boot path. Never sends bytes to any server: every step runs locally in
 * an offscreen canvas, stripping all image metadata automatically.
 *
 * Compression cascade:
 *   1. WebP at 0.85 -> 0.72 -> 0.55 (preserves transparency, typically 0.8-2.5 KB).
 *      Checks `blob.type === 'image/webp'` because iOS WebKit silently falls back
 *      to PNG when asked for WebP.
 *   2. If WebP is unsupported or exceeds 5 KB:
 *      - Opaque icons -> JPEG at 0.85 -> 0.70 -> 0.55 (~1.2-2.2 KB).
 *      - Transparent icons -> PNG; if still > 5 KB, gently quantize RGB levels
 *        while preserving full alpha so PNG deflate stays well under 5 KB.
 *
 * Spec: docs/internal/specs/folder-tag-icons.md (section 3.9)
 */
import { bytesToBase64 } from '@notes/shared';
import { CUSTOM_ICON_MAX_BYTES, CUSTOM_ICON_PX, isValidCustomIconDataUrl } from '../customIcons';

const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

const ALLOWED_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico']);

/** Guard against decoding huge files just to produce a 48x48 icon. */
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

export type CustomIconErrorCode = 'unsupported' | 'tooLarge' | 'decodeFailed';

export class CustomIconError extends Error {
  readonly code: CustomIconErrorCode;
  constructor(code: CustomIconErrorCode) {
    super(code);
    this.code = code;
  }
}

function isSvgFile(file: File): boolean {
  if (file.type.toLowerCase() === 'image/svg+xml') return true;
  return (file.name.split('.').pop()?.toLowerCase() ?? '') === 'svg';
}

function isSupportedIconFile(file: File): boolean {
  if (file.type && ALLOWED_MIMES.has(file.type.toLowerCase())) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ALLOWED_EXTS.has(ext);
}

/** Decode any supported file into a drawable bitmap/image. SVGs always go
 *  through a detached HTMLImageElement (never inserted into the DOM), where
 *  browsers by spec disable JavaScript and block all external subresources;
 *  canvas redraw then extracts only raw 48x48 RGBA pixels. */
async function decodeDrawable(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  const svg = isSvgFile(file);
  if (!svg && typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      if (bmp.width > 0 && bmp.height > 0) {
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      }
      bmp.close();
    } catch {
      // Fall through to HTMLImageElement (handles .ico and some WebKit formats).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode'));
      el.src = url;
    });
    const width = img.naturalWidth || (svg ? CUSTOM_ICON_PX : 0);
    const height = img.naturalHeight || (svg ? CUSTOM_ICON_PX : 0);
    if (!width || !height) throw new CustomIconError('decodeFailed');
    return { source: img, width, height, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err instanceof CustomIconError ? err : new CustomIconError('decodeFailed');
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

function hasAlpha(ctx: CanvasRenderingContext2D, size: number): boolean {
  const { data } = ctx.getImageData(0, 0, size, size);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) return true;
  }
  return false;
}

/** Quantize RGB channels to `levels` steps (preserving alpha) so noisy transparent
 *  PNGs deflate under 5 KB on engines without WebP encoding (iOS WebKit). */
function quantizeCanvas(source: HTMLCanvasElement, levels: number): HTMLCanvasElement {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext('2d');
  if (!ctx) return source;
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, copy.width, copy.height);
  const d = img.data;
  const max = levels - 1;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      continue;
    }
    d[i] = Math.round((Math.round((d[i]! / 255) * max) / max) * 255);
    d[i + 1] = Math.round((Math.round((d[i + 1]! / 255) * max) / max) * 255);
    d[i + 2] = Math.round((Math.round((d[i + 2]! / 255) * max) / max) * 255);
  }
  ctx.putImageData(img, 0, 0);
  return copy;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type};base64,${bytesToBase64(bytes)}`;
}

/** Resize an uploaded image file to `targetPx` square (default 48x48 px,
 *  aspect-preserved, centered) and compress it to a validated data URL within
 *  CUSTOM_ICON_MAX_BYTES (5 KB). */
export async function processCustomIcon(file: File, targetPx = CUSTOM_ICON_PX): Promise<string> {
  if (!isSupportedIconFile(file)) throw new CustomIconError('unsupported');
  if (file.size === 0 || file.size > MAX_INPUT_BYTES) throw new CustomIconError('tooLarge');

  const decoded = await decodeDrawable(file);
  try {
    const size = targetPx;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CustomIconError('decodeFailed');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const scale = Math.min(size / decoded.width, size / decoded.height);
    const dw = Math.max(1, Math.round(decoded.width * scale));
    const dh = Math.max(1, Math.round(decoded.height * scale));
    const dx = Math.floor((size - dw) / 2);
    const dy = Math.floor((size - dh) / 2);
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(decoded.source, dx, dy, dw, dh);

    // 1. Try WebP first (best ratio + alpha everywhere except iOS WebKit).
    for (const q of [0.85, 0.72, 0.55]) {
      const blob = await canvasToBlob(canvas, 'image/webp', q);
      if (blob && blob.type === 'image/webp' && blob.size > 0 && blob.size <= CUSTOM_ICON_MAX_BYTES) {
        const url = await blobToDataUrl(blob);
        if (isValidCustomIconDataUrl(url)) return url;
      }
    }

    // 2. Fallback: JPEG for opaque icons, PNG (with gentle quantization fallback) for transparent ones.
    const transparent = hasAlpha(ctx, size);
    if (!transparent) {
      for (const q of [0.85, 0.7, 0.55, 0.4]) {
        const blob = await canvasToBlob(canvas, 'image/jpeg', q);
        if (blob && blob.type === 'image/jpeg' && blob.size > 0 && blob.size <= CUSTOM_ICON_MAX_BYTES) {
          const url = await blobToDataUrl(blob);
          if (isValidCustomIconDataUrl(url)) return url;
        }
      }
    } else {
      const png = await canvasToBlob(canvas, 'image/png');
      if (png && png.type === 'image/png' && png.size > 0 && png.size <= CUSTOM_ICON_MAX_BYTES) {
        const url = await blobToDataUrl(png);
        if (isValidCustomIconDataUrl(url)) return url;
      }
      for (const levels of [32, 16, 8, 4]) {
        const qCanvas = quantizeCanvas(canvas, levels);
        const qBlob = await canvasToBlob(qCanvas, 'image/png');
        if (qBlob && qBlob.type === 'image/png' && qBlob.size > 0 && qBlob.size <= CUSTOM_ICON_MAX_BYTES) {
          const url = await blobToDataUrl(qBlob);
          if (isValidCustomIconDataUrl(url)) return url;
        }
      }
    }

    throw new CustomIconError('tooLarge');
  } finally {
    decoded.close();
  }
}
