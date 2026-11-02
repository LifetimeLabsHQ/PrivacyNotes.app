/**
 * A drawing's pictures, between the encrypted image store and the canvas.
 *
 * Excalidraw draws a picture from a data URL it holds in memory. The body
 * never holds one (`scene.ts`), so a picture is decrypted when its drawing
 * opens and handed to the canvas, and a new one goes through the pipeline
 * every note picture takes (`storePicture`: the switches, the quota gates,
 * the per-file cap, the storage upsell) before the canvas sees it.
 *
 * These live outside `DrawingCanvas.tsx` on purpose: that chunk is lazy and
 * must not import a module of the NotesView chunk (docs/contrib/bundle-size.md
 * section 8), so `DrawingItem` hands these down.
 * Spec: docs/internal/specs/drawing.md (section 7, Pictures)
 */

import { currentImageOptions } from '../imageProcessing';
import { sniffImageFormat } from '../imageMetadata';
import { IMAGE_REF_PREFIX } from '../mediaRefs';
import { loadEncryptedImageUrl, storePicture } from '../EncryptedImage';

const FORMAT_MIME: Partial<Record<ReturnType<typeof sniffImageFormat>, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * The picture a `pn:img/<uuid>` reference names, as a data URL with its
 * type, or null when it cannot be read (not here, not on the server, or
 * damaged): the canvas then draws its empty box, never an error.
 */
export async function pictureDataUrl(src: string): Promise<string | null> {
  if (!src.startsWith(IMAGE_REF_PREFIX)) return null;
  const url = await loadEncryptedImageUrl(src.slice(IMAGE_REF_PREFIX.length));
  if (!url) return null;
  try {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const mime = FORMAT_MIME[sniffImageFormat(bytes)];
    if (!mime) return null;
    return await readAsDataUrl(new Blob([bytes], { type: mime }));
  } catch {
    return null;
  }
}

/**
 * Store a picture for a drawing and answer its reference, or null when the
 * pipeline refused it (it said why, through its own toast or the upsell).
 */
export async function storeDrawingPicture(file: File): Promise<string | null> {
  const stored = await storePicture(file, currentImageOptions());
  return stored ? `${IMAGE_REF_PREFIX}${stored.uuid}` : null;
}

/** A picture the canvas holds only as a data URL, as a file for the pipeline. */
export async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type });
}
