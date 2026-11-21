/**
 * Light clean-up for a flat page: even out the light and make the paper
 * white (divide by a smooth estimate of the paper color), then a mild
 * black-point stretch. In place on the warped page.
 */
import type { Rgba } from './pageCorners';

/** Paper estimate grid: about this many cells along the long edge. */
const CELLS = 32;
/** The share of a cell's pixels at or above the paper color. */
const PAPER_SHARE = 0.1;
/** The most the division may brighten a pixel, so a dim photo does not turn to noise. Spec: docs/internal/specs/plugins-scan.md (section 4, Clean-up) */
const GAIN_CAP = 2.5;

export function cleanPaper(img: Rgba): void {
  const { data, width: w, height: h } = img;
  const cell = Math.max(8, Math.ceil(Math.max(w, h) / CELLS));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  // Per cell and channel: the level that the brightest 10 % reach.
  const grid = [0, 1, 2].map(() => new Float32Array(gw * gh));
  const hist = new Uint32Array(256 * 3);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    hist.fill(0);
    let n = 0;
    for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y += 2) for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x += 2) {
      const i = (y * w + x) * 4;
      hist[data[i]!]!++; hist[256 + data[i + 1]!]!++; hist[512 + data[i + 2]!]!++; n++;
    }
    for (let c = 0; c < 3; c++) {
      let acc = 0, v = 255;
      for (; v > 0; v--) { acc += hist[c * 256 + v]!; if (acc >= n * PAPER_SHARE) break; }
      grid[c]![gy * gw + gx] = v;
    }
  }
  // A cell that is mostly picture or ink is darker than paper: never let
  // the estimate fall far below the page's own paper level, or a photo on
  // the page is blown out to white.
  for (const g of grid) {
    const sorted = Array.from(g).sort((a, b) => a - b);
    const paper = sorted[Math.floor(sorted.length * 0.75)];
    for (let i = 0; i < g.length; i++) g[i] = Math.max(g[i]!, paper! * 0.72, 255 / GAIN_CAP);
    smoothGrid(g, gw, gh);
  }
  // Divide, then stretch from a black point at the 1st percentile of luma.
  const lut = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1.001, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = fy | 0, ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1.001, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = fx | 0, tx = fx - x0;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const g = grid[c];
        const a = g![y0 * gw + x0], b = g![y0 * gw + x0 + 1], d = g![(y0 + 1) * gw + x0], e = g![(y0 + 1) * gw + x0 + 1];
        const bg = (a! + (b! - a!) * tx) * (1 - ty) + (d! + (e! - d!) * tx) * ty;
        data[i + c] = Math.min(255, (data[i + c]! / bg) * 255);
      }
      lut[(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!) | 0]!++;
    }
  }
  let acc = 0, black = 0;
  for (; black < 128; black++) { acc += lut[black]!; if (acc >= w * h * 0.01) break; }
  black = Math.min(black, 90);
  const map = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) map[v] = Math.max(0, ((v - black) / (255 - black)) ** 1.15 * 255);
  for (let i = 0; i < data.length; i += 4) { data[i] = map[data[i]!]!; data[i + 1] = map[data[i + 1]!]!; data[i + 2] = map[data[i + 2]!]!; }
}

/** 3 x 3 median, then a 3 x 3 box blur, on the grid. */
function smoothGrid(g: Float32Array, w: number, h: number): void {
  const pass = (fn: (v: number[]) => number) => {
    const src = g.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v: number[] = [];
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const xx = Math.min(w - 1, Math.max(0, x + ox)), yy = Math.min(h - 1, Math.max(0, y + oy));
        v.push(src[yy * w + xx]!);
      }
      g[y * w + x] = fn(v);
    }
  };
  pass((v) => v.sort((a, b) => a - b)[4]!);
  pass((v) => v.reduce((s, a) => s + a, 0) / 9);
}
