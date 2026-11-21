/// <reference lib="webworker" />
import { findPageCorners, type Quad, type Rgba } from './pageCorners';
import { pageSize, warpPage, type Paper } from './pageWarp';
import { cleanPaper } from './paperCleanup';

/**
 * The scan step off the main thread, so the corner editor never stutters:
 * the photo stays here after `photo`, `warp` flattens it, `clean` makes a
 * cleaned copy of the flat page. Pixels only: no network, no storage.
 * Spec: docs/internal/specs/plugins-scan.md (section 2)
 */

export type ScanRequest =
  | { op: 'photo'; img: Rgba }
  | { op: 'warp'; quad: Quad; snap: boolean; maxPx: number }
  | { op: 'clean' }
  /** A page already flat (VisionKit's scanner on iOS): only the clean-up runs here. */
  | { op: 'flat'; img: Rgba };

export type ScanReply =
  | { op: 'photo'; corners: Quad; found: boolean }
  | { op: 'warp'; page: Rgba; paper: Paper }
  | { op: 'clean'; page: Rgba }
  | { op: 'error' };

let photo: Rgba | null = null;
let flat: Rgba | null = null;

const copy = (img: Rgba): Rgba => ({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });

self.onmessage = (e: MessageEvent<ScanRequest>) => {
  const req = e.data;
  try {
    if (req.op === 'photo') {
      photo = req.img;
      const { corners, found } = findPageCorners(photo);
      self.postMessage({ op: 'photo', corners, found } satisfies ScanReply);
    } else if (req.op === 'warp' && photo) {
      const size = pageSize(req.quad, photo.width, photo.height, req.maxPx, req.snap);
      flat = warpPage(photo, req.quad, size);
      const out = copy(flat);
      self.postMessage({ op: 'warp', page: out, paper: size.paper } satisfies ScanReply, [out.data.buffer]);
    } else if (req.op === 'flat') {
      flat = req.img;
      self.postMessage({ op: 'clean', page: copy(flat) } satisfies ScanReply);
    } else if (req.op === 'clean' && flat) {
      const out = copy(flat);
      cleanPaper(out);
      self.postMessage({ op: 'clean', page: out } satisfies ScanReply, [out.data.buffer]);
    } else {
      self.postMessage({ op: 'error' } satisfies ScanReply);
    }
  } catch {
    self.postMessage({ op: 'error' } satisfies ScanReply);
  }
};
