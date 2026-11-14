/**
 * A clip's pictures, fetched by the extension: the same per-clip limits as
 * the app (20 pictures, 10 MB as downloaded), only picture types the app
 * stores, no cookies sent, and never from the person's own computer or
 * network (`fetchPublic`). A picture larger than one inbox row allows is
 * scaled down here; the app then runs its own picture settings on it when it
 * stores the clip.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.3, step 3)
 */
import { CLIP_MAX_PICTURE_BYTES, CLIP_MAX_PICTURES } from '@notes/clipper';
import { fetchPublic } from './publicFetch';

const TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;
// A sealed row carries at most 1.5 MiB of base64, so a picture's bytes stay
// under this, with room for its header and the padding.
const ROW_PICTURE_MAX = 1_100_000;
const FETCH_MS = 20_000;

export interface Picture {
  bytes: Uint8Array;
  type: string;
}

async function fetchOne(src: string): Promise<Picture | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetchPublic(src, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal, cache: 'force-cache' });
    if (!res?.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!TYPES.test(type)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= CLIP_MAX_PICTURE_BYTES ? { bytes, type } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Scale a picture until it fits one row, as a JPEG; null when it cannot. */
async function fitRow(pic: Picture): Promise<Picture | null> {
  if (pic.bytes.length <= ROW_PICTURE_MAX) return pic;
  try {
    const bitmap = await createImageBitmap(new Blob([pic.bytes as BlobPart], { type: pic.type }));
    for (const edge of [2560, 1920, 1280]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      if (blob.size <= ROW_PICTURE_MAX) return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg' };
    }
    return null;
  } catch {
    return null;
  }
}

/** The pictures of a clip in page order, null where one was not saved. */
export async function fetchPictures(srcs: string[]): Promise<(Picture | null)[]> {
  const out: (Picture | null)[] = [];
  let total = 0;
  for (let i = 0; i < srcs.length; i++) {
    if (i >= CLIP_MAX_PICTURES || total >= CLIP_MAX_PICTURE_BYTES) {
      out.push(null);
      continue;
    }
    const got = await fetchOne(srcs[i]!);
    if (!got) {
      out.push(null);
      continue;
    }
    total += got.bytes.length;
    out.push(total > CLIP_MAX_PICTURE_BYTES ? null : await fitRow(got));
  }
  return out;
}
