/**
 * Four-point perspective warp to an upright page, plain TypeScript.
 * The page's true width-to-height ratio comes from the corners with the
 * pinhole-camera method of Zhang and He (2007, "Whiteboard scanning and
 * image enhancement"), then snaps to A4 or Letter when it is close. The
 * page is never longer than `maxPx`: the caller passes IMAGE_FIT_PX, the
 * size of a stored picture, so this file stays free of app imports.
 * Spec: docs/internal/specs/plugins-scan.md (section 2)
 */
import type { Point, Quad, Rgba } from './pageCorners';

/** How close (as a share) a ratio must be to snap to a paper size. */
const SNAP = 0.04;
export const PAPER = {
  a4: { ratio: 210 / 297, longPt: 841.89 },
  letter: { ratio: 8.5 / 11, longPt: 792 },
} as const;
export type Paper = keyof typeof PAPER | null;

export type PageSize = { width: number; height: number; paper: Paper };

/** Width over height of the real page, or null when the math has no answer. */
export function pageRatio(q: Quad, W: number, H: number): number {
  const fallback = () => {
    const top = dist(q[0], q[1]), bottom = dist(q[3], q[2]);
    const left = dist(q[0], q[3]), right = dist(q[1], q[2]);
    return (top + bottom) / (left + right);
  };
  // m1 top-left, m2 top-right, m3 bottom-left, m4 bottom-right, centered.
  const cx = W / 2, cy = H / 2;
  const m = (p: Point) => [p.x - cx, p.y - cy, 1];
  const m1 = m(q[0]), m2 = m(q[1]), m3 = m(q[3]), m4 = m(q[2]);
  const k2 = dot(crs(m1, m4), m3) / dot(crs(m2, m4), m3);
  const k3 = dot(crs(m1, m4), m2) / dot(crs(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]!);
  const n3 = m3.map((v, i) => k3 * v - m1[i]!);
  const den = n2[2]! * n3[2]!;
  // Nearly no perspective: the focal length is unknowable; side lengths do.
  if (Math.abs(den) < 1e-9) return fallback();
  const f2 = -(n2[0]! * n3[0]! + n2[1]! * n3[1]!) / den;
  const diag2 = W * W + H * H;
  // A phone lens has a focal length of about 0.5 to 2 photo diagonals.
  if (!(f2 > 0.15 * diag2 && f2 < 6 * diag2)) return fallback();
  const r = Math.sqrt(
    (n2[0]! ** 2 + n2[1]! ** 2 + f2 * n2[2]! ** 2) / (n3[0]! ** 2 + n3[1]! ** 2 + f2 * n3[2]! ** 2),
  );
  return Number.isFinite(r) && r > 0 ? r : fallback();
}

/**
 * Output size: the measured ratio, snapped to a paper size when close and
 * `snap` allows it (the page covers most of the photo; a page inside a
 * sleeve or frame measures wrong).
 */
export function pageSize(q: Quad, W: number, H: number, maxPx: number, snap = true): PageSize {
  let r = pageRatio(q, W, H);
  let paper: Paper = null;
  if (snap) for (const key of ['a4', 'letter'] as const) {
    const p = PAPER[key].ratio;
    for (const want of [p, 1 / p]) if (Math.abs(r / want - 1) < SNAP) { r = want; paper = key; }
  }
  // As many pixels as the photo really has along the page, capped.
  const long = Math.min(maxPx, Math.round(Math.max(dist(q[0], q[1]), dist(q[3], q[2]), dist(q[0], q[3]), dist(q[1], q[2]))));
  return r >= 1
    ? { width: long, height: Math.max(1, Math.round(long / r)), paper }
    : { width: Math.max(1, Math.round(long * r)), height: long, paper };
}

/**
 * Warp: for each output pixel, the source point through the homography
 * that maps the unit square onto the quad (Heckbert 1989), sampled
 * bilinearly. The source is the decoded photo.
 */
export function warpPage(src: Rgba, q: Quad, size: PageSize): Rgba {
  const { width: w, height: h } = size;
  const H = squareToQuad(q);
  const out = new Uint8ClampedArray(w * h * 4);
  const { data, width: W, height: SH } = src;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const z = H[6]! * u + H[7]! * v + 1;
      let sx = (H[0]! * u + H[1]! * v + H[2]!) / z - 0.5;
      let sy = (H[3]! * u + H[4]! * v + H[5]!) / z - 0.5;
      sx = sx < 0 ? 0 : sx > W - 1.001 ? W - 1.001 : sx;
      sy = sy < 0 ? 0 : sy > SH - 1.001 ? SH - 1.001 : sy;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c]! + (data[i10 + c]! - data[i00 + c]!) * fx;
        const bot = data[i01 + c]! + (data[i11 + c]! - data[i01 + c]!) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Projective map from (0,0),(1,0),(1,1),(0,1) to the quad's corners. */
function squareToQuad(q: Quad): number[] {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0];
  }
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const hh = (dx1 * sy - sx * dy1) / den;
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + hh * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + hh * p3.y, p0.y,
    g, hh,
  ];
}

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const crs = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
