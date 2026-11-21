/**
 * Page corner finder for the scan step (#800), plain TypeScript, no canvas
 * calls, so it runs in a worker, on the main thread or in Node.
 *
 * Method: shrink the photo, blur, color edges (Canny), candidate shapes
 * from edge chains and from the bright paper region, the best four-sided
 * shape by edge support, then each side refined on the full photo.
 * Nothing found: the whole photo, with `found: false`.
 */

export type Point = { x: number; y: number };
/** Top-left, top-right, bottom-right, bottom-left, in source pixels. */
export type Quad = [Point, Point, Point, Point];
export type Rgba = { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
export type CornerResult = { corners: Quad; found: boolean; score: number };

/** Long edge of the working copy the search runs on. */
const DETECT_PX = 480;
/** The smallest page we look for, as a part of the photo's area. */
const MIN_AREA = 0.08;
/** Below this score the result is the whole photo. */
const MIN_SCORE = 0.15;

type Gray = { d: Float32Array; w: number; h: number };

export function findPageCorners(img: Rgba): CornerResult {
  const { width: W, height: H } = img;
  const s = Math.min(1, DETECT_PX / Math.max(W, H));
  const w = Math.max(8, Math.round(W * s));
  const h = Math.max(8, Math.round(H * s));
  const [r, g, b] = shrink(img, w, h);
  for (const c of [r, g, b]) blur(c, 1.6);
  const cn = colorCanny(r, g, b);
  const luma = mixLuma(r, g, b);
  const ctx: ScoreCtx = { rgb: [r, g, b], luma, w, h, step: stepFor(cn.hi) };

  const cands: Quad[] = [];
  for (const q of edgeChainQuads(cn.edges, w, h)) cands.push(q);
  for (const q of brightRegionQuads(luma)) cands.push(q);
  for (const q of houghQuads(cn, w, h)) cands.push(q);

  let best: Quad | null = null;
  let bestScore = 0;
  for (const q of cands) {
    const sc = scoreQuad(q, ctx);
    if (sc > bestScore) { bestScore = sc; best = q; }
  }
  const whole: Quad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  if (!best || bestScore < MIN_SCORE) return { corners: whole, found: false, score: bestScore };
  const up = best.map((p) => ({ x: p.x / s, y: p.y / s })) as Quad;
  return { corners: clampQuad(refineQuad(img, up, s), W, H), found: true, score: bestScore };
}

// ---------------------------------------------------------------- pixels

/** Area-average shrink into three float channels (0..255). */
function shrink(img: Rgba, w: number, h: number): [Gray, Gray, Gray] {
  const { data, width: W, height: H } = img;
  const out = [0, 1, 2].map(() => ({ d: new Float32Array(w * h), w, h })) as [Gray, Gray, Gray];
  const cnt = new Float32Array(w * h);
  const fx = w / W;
  const fy = h / H;
  for (let y = 0; y < H; y++) {
    const ty = Math.min(h - 1, (y * fy) | 0) * w;
    for (let x = 0; x < W; x++) {
      const t = ty + Math.min(w - 1, (x * fx) | 0);
      const i = (y * W + x) * 4;
      out[0].d[t]! += data[i]!;
      out[1].d[t]! += data[i + 1]!;
      out[2].d[t]! += data[i + 2]!;
      cnt[t]!++;
    }
  }
  for (let t = 0; t < w * h; t++) {
    const n = cnt[t] || 1;
    out[0].d[t]! /= n; out[1].d[t]! /= n; out[2].d[t]! /= n;
  }
  return out;
}

function mixLuma(r: Gray, g: Gray, b: Gray): Gray {
  const d = new Float32Array(r.d.length);
  for (let i = 0; i < d.length; i++) d[i] = 0.299 * r.d[i]! + 0.587 * g.d[i]! + 0.114 * b.d[i]!;
  return { d, w: r.w, h: r.h };
}

/** Separable Gaussian blur in place. */
function blur(g: Gray, sigma: number): void {
  const rad = Math.ceil(sigma * 2.5);
  const k = new Float32Array(rad * 2 + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; i++) { k[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + rad]!; }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const { d, w, h } = g;
  const tmp = new Float32Array(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -rad; i <= rad; i++) a += k[i + rad]! * d[y * w + Math.min(w - 1, Math.max(0, x + i))]!;
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -rad; i <= rad; i++) a += k[i + rad]! * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]!;
    d[y * w + x] = a;
  }
}

/**
 * Canny on color: at each pixel the channel with the strongest Sobel
 * gradient wins, so a white page on a light table of another color still
 * shows an edge. Returns the magnitude, the thin edge map and the high
 * threshold.
 */
type Canny = { mag: Float32Array; gx: Float32Array; gy: Float32Array; edges: Uint8Array; hi: number };
function colorCanny(r: Gray, g: Gray, b: Gray): Canny {
  const { w, h } = r;
  const mag = new Float32Array(w * h);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    let bm = -1, bx = 0, by = 0;
    for (const c of [r.d, g.d, b.d]) {
      const sx = c[i - w + 1]! + 2 * c[i + 1]! + c[i + w + 1]! - c[i - w - 1]! - 2 * c[i - 1]! - c[i + w - 1]!;
      const sy = c[i + w - 1]! + 2 * c[i + w]! + c[i + w + 1]! - c[i - w - 1]! - 2 * c[i - w]! - c[i - w + 1]!;
      const m = sx * sx + sy * sy;
      if (m > bm) { bm = m; bx = sx; by = sy; }
    }
    mag[i] = Math.sqrt(bm); gx[i] = bx; gy[i] = by;
  }
  // Thresholds from the magnitude spread: most pixels are flat.
  const hi = Math.max(24, percentile(mag, 0.9));
  const lo = hi * 0.4;
  const nms = new Uint8Array(w * h); // 0 none, 1 weak, 2 strong
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const m = mag[i];
    if (m! < lo) continue;
    const ang = Math.atan2(gy[i]!, gx[i]!);
    const dx = Math.round(Math.cos(ang));
    const dy = Math.round(Math.sin(ang));
    if (m! < mag[i + dy * w + dx]! || m! < mag[i - dy * w - dx]!) continue;
    nms[i] = m! >= hi ? 2 : 1;
  }
  // Hysteresis: keep weak pixels that touch a strong chain.
  const edges = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < nms.length; i++) if (nms[i] === 2) { edges[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const j = i + oy * w + ox;
      if (j >= 0 && j < nms.length && nms[j] && !edges[j]) { edges[j] = 1; stack.push(j); }
    }
  }
  return { mag, gx, gy, edges, hi };
}

function percentile(a: Float32Array, p: number): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! > max) max = a[i]!;
  if (max === 0) return 0;
  const bins = new Uint32Array(1024);
  for (let i = 0; i < a.length; i++) bins[Math.min(1023, ((a[i]! / max) * 1023) | 0)]!++;
  let acc = 0;
  const goal = a.length * p;
  for (let i = 0; i < 1024; i++) { acc += bins[i]!; if (acc >= goal) return (i / 1023) * max; }
  return max;
}

// ------------------------------------------------------------ candidates

/** Connected regions of a mask (8-connected), as per-row extreme points. */
function regions(mask: Uint8Array, w: number, h: number, minPix: number): Point[][] {
  const seen = new Uint8Array(mask.length);
  const out: Point[][] = [];
  const stack: number[] = [];
  for (let s0 = 0; s0 < mask.length; s0++) {
    if (!mask[s0] || seen[s0]) continue;
    const minX = new Int32Array(h).fill(w);
    const maxX = new Int32Array(h).fill(-1);
    let n = 0;
    seen[s0] = 1; stack.push(s0);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      n++;
      if (x < minX[y]!) minX[y] = x;
      if (x > maxX[y]!) maxX[y] = x;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = y + oy;
        if (yy < 0 || yy >= h) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = x + ox;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    if (n < minPix) continue;
    const pts: Point[] = [];
    for (let y = 0; y < h; y++) if (maxX[y]! >= 0) { pts.push({ x: minX[y]!, y }); if (maxX[y] !== minX[y]) pts.push({ x: maxX[y]!, y }); }
    out.push(pts);
  }
  return out;
}

function dilate(m: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = x + ox, yy = y + oy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) o[yy * w + xx] = 1;
    }
  }
  return o;
}

/** Quads from edge chains: each long chain's hull, cut to four corners. */
function edgeChainQuads(edges: Uint8Array, w: number, h: number): Quad[] {
  const closed = dilate(edges, w, h);
  const out: Quad[] = [];
  for (const pts of regions(closed, w, h, (w + h) * 0.3)) {
    const q = hullQuad(pts);
    if (q) out.push(q);
  }
  return out;
}

/**
 * Quads from the paper itself: Otsu splits the light from the dark, and
 * the largest light regions are page candidates. Catches a page whose
 * edge chain is broken by a busy table.
 */
function brightRegionQuads(l: Gray): Quad[] {
  const t = otsu(l.d);
  const out: Quad[] = [];
  for (const shift of [0, 15, -15]) {
    const m = new Uint8Array(l.d.length);
    for (let i = 0; i < m.length; i++) m[i] = l.d[i]! > t + shift ? 1 : 0;
    const regs = regions(m, l.w, l.h, l.w * l.h * MIN_AREA * 0.5);
    regs.sort((a, b) => b.length - a.length);
    for (const pts of regs.slice(0, 3)) {
      const q = hullQuad(pts);
      if (q) out.push(q);
    }
  }
  return out;
}

function otsu(d: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < d.length; i++) hist[Math.max(0, Math.min(255, d[i]! | 0))]!++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sb = 0, wb = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wb += hist[i]!;
    if (!wb) continue;
    const wf = d.length - wb;
    if (!wf) break;
    sb += i * hist[i]!;
    const mb = sb / wb, mf = (sum - sb) / wf;
    const v = wb * wf * (mb - mf) * (mb - mf);
    if (v > best) { best = v; t = i; }
  }
  return t;
}

/** A line as x cos(t) + y sin(t) = rho. */
type HLine = { t: number; rho: number; votes: number };

/**
 * Quads from straight lines: a Hough transform over the edge pixels
 * (each votes only near its own gradient direction), the strongest
 * lines split into the mostly-horizontal and the mostly-vertical, the
 * photo's own borders added to both (a page cut off by the frame), and
 * every pair of one with every pair of the other meets in a quad.
 */
function houghQuads(cn: Canny, w: number, h: number): Quad[] {
  const T = 180, diag = Math.ceil(Math.hypot(w, h));
  const R = 2 * diag + 1;
  const acc = new Uint16Array(T * R);
  const cos = new Float32Array(T), sin = new Float32Array(T);
  for (let t = 0; t < T; t++) { cos[t] = Math.cos((t * Math.PI) / T); sin[t] = Math.sin((t * Math.PI) / T); }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!cn.edges[i]) continue;
    let a = Math.round((Math.atan2(cn.gy[i]!, cn.gx[i]!) * T) / Math.PI);
    a = ((a % T) + T) % T;
    for (let d = -6; d <= 6; d++) {
      const t = (a + d + T) % T;
      const rho = Math.round(x * cos[t]! + y * sin[t]!) + diag;
      acc[t * R + rho]!++;
    }
  }
  // Peaks: local maxima over +-4 degrees and +-6 rho, longest first.
  const minVotes = Math.min(w, h) * 0.12;
  const peaks: HLine[] = [];
  for (let t = 0; t < T; t++) for (let r = 0; r < R; r++) {
    const v = acc[t * R + r]!;
    if (v < minVotes) continue;
    let isMax = true;
    for (let dt = -4; dt <= 4 && isMax; dt++) for (let dr = -6; dr <= 6; dr++) {
      let tt = t + dt, rr = r + dr;
      if (tt < 0) { tt += T; rr = R - 1 - rr; } else if (tt >= T) { tt -= T; rr = R - 1 - rr; }
      if (rr < 0 || rr >= R || (dt === 0 && dr === 0)) continue;
      const o = acc[tt * R + rr];
      if (o! > v || (o === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; }
    }
    if (isMax) peaks.push({ t: (t * Math.PI) / T, rho: r - diag, votes: v });
  }
  peaks.sort((a, b) => b.votes - a.votes);
  const horiz: HLine[] = [], vert: HLine[] = [];
  for (const p of peaks) {
    const isH = p.t > Math.PI / 4 && p.t < (3 * Math.PI) / 4; // normal near vertical: line near horizontal
    const group = isH ? horiz : vert;
    if (group.length < LINES) group.push(p);
  }
  horiz.push({ t: Math.PI / 2, rho: 0, votes: 0 }, { t: Math.PI / 2, rho: h - 1, votes: 0 });
  vert.push({ t: 0, rho: 0, votes: 0 }, { t: 0, rho: w - 1, votes: 0 });
  const out: Quad[] = [];
  for (let a = 0; a < horiz.length; a++) for (let b = a + 1; b < horiz.length; b++) {
    for (let c = 0; c < vert.length; c++) for (let d = c + 1; d < vert.length; d++) {
      const pts = [meetH(horiz[a]!, vert[c]!), meetH(horiz[a]!, vert[d]!), meetH(horiz[b]!, vert[c]!), meetH(horiz[b]!, vert[d]!)];
      if (pts.some((p) => !p || p.x < -0.02 * w || p.y < -0.02 * h || p.x > 1.02 * w || p.y > 1.02 * h)) continue;
      out.push(orderQuad(pts as Point[]));
    }
  }
  return out;
}

function meetH(a: HLine, b: HLine): Point | null {
  const ca = Math.cos(a.t), sa = Math.sin(a.t), cb = Math.cos(b.t), sb = Math.sin(b.t);
  const den = ca * sb - sa * cb;
  if (Math.abs(den) < 1e-6) return null;
  return { x: (a.rho * sb - b.rho * sa) / den, y: (ca * b.rho - cb * a.rho) / den };
}

/** The turn from o to a to b: its sign says left or right. */
export const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Andrew's monotone chain, counter-clockwise in screen terms. */
function convexHull(pts: Point[]): Point[] {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lower: Point[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  const upper: Point[] = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q!) <= 0) upper.pop(); upper.push(q!); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

export function polyArea(p: Point[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i]!.x * q!.y - q!.x * p[i]!.y; }
  return Math.abs(a) / 2;
}

/** The largest-area quad whose corners are hull vertices. */
function hullQuad(pts: Point[]): Quad | null {
  let hull = convexHull(pts);
  if (hull.length < 4) return null;
  // Thin the hull so the brute-force search stays small.
  while (hull.length > 36) hull = hull.filter((_, i) => i % 2 === 0);
  const n = hull.length;
  let best = -1, bi = [0, 1, 2, 3];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
    const ar = polyArea([hull[a]!, hull[b]!, hull[c]!, hull[d]!]);
    if (ar > best) { best = ar; bi = [a, b, c, d]; }
  }
  return orderQuad(bi.map((i) => hull[i]!));
}

/** Order four points as top-left, top-right, bottom-right, bottom-left. */
function orderQuad(p: Point[]): Quad {
  const cx = p.reduce((s, q) => s + q.x, 0) / 4;
  const cy = p.reduce((s, q) => s + q.y, 0) / 4;
  const byAng = p.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // Start at the point with the smallest x + y (top-left).
  let k = 0;
  for (let i = 1; i < 4; i++) if (byAng[i]!.x + byAng[i]!.y < byAng[k]!.x + byAng[k]!.y) k = i;
  return [0, 1, 2, 3].map((i) => byAng[(k + i) % 4]) as Quad;
}

// --------------------------------------------------------------- scoring

type ScoreCtx = { rgb: [Gray, Gray, Gray]; luma: Gray; w: number; h: number; step: number };

/**
 * The color step (0..441) a page border must show between its two sides,
 * from the photo's own contrast: a Sobel magnitude is about four times
 * the step under it, and the 90th percentile is a strong local step.
 */
function stepFor(hi: number): number {
  return Math.max(STEP_MIN, Math.min(36, hi / 4 * STEP_K));
}
/** Tuned on the bench photos. Spec: docs/internal/specs/plugins-scan.md (section 2) */
const STEP_MIN = 10, STEP_K = 0.7, TEX = 1.2, PAPER_W = 1, LINES = 8, BORDER_SUP = 0.5;

function sample(c: Gray, x: number, y: number): number {
  const xi = Math.max(0, Math.min(c.w - 1, Math.round(x))), yi = Math.max(0, Math.min(c.h - 1, Math.round(y)));
  return c.d[yi * c.w + xi]!;
}

/**
 * Score = sqrt(area share) x mean side support x sqrt(weakest side) x a
 * paper factor. Support is the share of points along a side where the
 * color 3 px inside differs from the color 3 px outside: a real border
 * steps along its whole length, text and clutter only here and there. A
 * side on the photo's border (page cut off by the frame) counts as half
 * supported, and at most two sides may lie there. The paper factor
 * prefers a light inside, so a white page beats a dark folder beside it.
 */
function scoreQuad(q: Quad, ctx: ScoreCtx): number {
  const { rgb, luma, w, h, step } = ctx;
  const area = polyArea(q) / (w * h);
  if (area < MIN_AREA || area > 0.995) return 0;
  // Convex, with no corner sharper than 35 degrees or blunter than 145.
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], o = q[i], b = q[(i + 1) % 4];
    if (cross(a!, o!, b!) < 0) return 0;
    const v1x = a!.x - o!.x, v1y = a!.y - o!.y, v2x = b!.x - o!.x, v2y = b!.y - o!.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9);
    if (Math.abs(cos) > 0.82) return 0;
  }
  let sum = 0, min = 1, border = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const onBorder = (a!.x < 3 && b!.x < 3) || (a!.y < 3 && b!.y < 3) || (a!.x > w - 4 && b!.x > w - 4) || (a!.y > h - 4 && b!.y > h - 4);
    let sup: number;
    if (onBorder) { sup = BORDER_SUP; border++; }
    else {
      const len = Math.hypot(b!.x - a!.x, b!.y - a!.y);
      // Inward normal: the quad runs clockwise on screen, so inside is to the right.
      const nx = -(b!.y - a!.y) / len, ny = (b!.x - a!.x) / len;
      const n = Math.max(8, Math.round(len / 2));
      let hit = 0;
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const x = a!.x + (b!.x - a!.x) * t, y = a!.y + (b!.y - a!.y) * t;
        // Two widths, so a gently curled edge still counts. The step must
        // beat both a floor and the texture along the side (carpet, cloth).
        const tx = (b!.x - a!.x) / len, ty = (b!.y - a!.y) / len;
        for (const off of [3, 6]) {
          let d2 = 0, t2 = 0;
          for (const c of rgb) {
            const ix = x + nx * off, iy = y + ny * off, ox = x - nx * off, oy = y - ny * off;
            const vi = sample(c, ix, iy), vo = sample(c, ox, oy);
            d2 += (vi - vo) ** 2;
            t2 += (vi - sample(c, ix + tx * 3, iy + ty * 3)) ** 2 + (vo - sample(c, ox + tx * 3, oy + ty * 3)) ** 2;
          }
          if (d2 >= step * step && d2 >= TEX * TEX * t2) { hit++; break; }
        }
      }
      sup = hit / (n - 1);
    }
    sum += sup;
    min = Math.min(min, sup);
  }
  if (border > 2) return 0;
  return Math.sqrt(area) * (sum / 4) * Math.sqrt(min) * paperFactor(q, luma);
}

/** Mean brightness inside the quad (sampled on a grid), as 0.4..1. */
function paperFactor(q: Quad, l: Gray): number {
  let acc = 0, n = 0;
  for (let v = 0.1; v < 0.95; v += 0.1) for (let u = 0.1; u < 0.95; u += 0.1) {
    const tx = q[0].x + (q[1].x - q[0].x) * u, ty = q[0].y + (q[1].y - q[0].y) * u;
    const bx = q[3].x + (q[2].x - q[3].x) * u, by = q[3].y + (q[2].y - q[3].y) * u;
    acc += sample(l, tx + (bx - tx) * v, ty + (by - ty) * v); n++;
  }
  return 1 - PAPER_W + PAPER_W * (acc / n / 255);
}

// ------------------------------------------------------------ refinement

function lumaAt(img: Rgba, x: number, y: number): number {
  const { data, width: W, height: H } = img;
  const xi = Math.max(0, Math.min(W - 2, x | 0)), yi = Math.max(0, Math.min(H - 2, y | 0));
  const fx = Math.max(0, Math.min(1, x - xi)), fy = Math.max(0, Math.min(1, y - yi));
  let acc = 0;
  for (let k = 0; k < 4; k++) {
    const ox = k & 1, oy = k >> 1;
    const i = ((yi + oy) * W + xi + ox) * 4;
    const wgt = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
    acc += wgt * (0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!);
  }
  return acc;
}

type Line = { px: number; py: number; dx: number; dy: number };

/**
 * Snap each side to the strongest step in brightness near it, on the full
 * photo, fit a line through those points, and meet the lines at the
 * corners. A side that finds no clear step keeps its coarse line.
 */
function refineQuad(img: Rgba, q: Quad, s: number): Quad {
  const reach = Math.max(4, 3 / s); // three working-copy pixels
  const lines: Line[] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b!.x - a!.x, b!.y - a!.y);
    const tx = (b!.x - a!.x) / len, ty = (b!.y - a!.y) / len;
    const nx = -ty, ny = tx;
    const pts: Point[] = [];
    const N = 48;
    for (let k = 0; k < N; k++) {
      const t = 0.1 + 0.8 * (k / (N - 1));
      const cx = a!.x + (b!.x - a!.x) * t, cy = a!.y + (b!.y - a!.y) * t;
      let best = 0, bestOff = 0;
      for (let o = -reach; o <= reach; o += 0.5) {
        // Step across the side, averaged over 3 points along it.
        let g = 0;
        for (const u of [-2, 0, 2]) {
          const x = cx + nx * o + tx * u, y = cy + ny * o + ty * u;
          g += lumaAt(img, x + nx, y + ny) - lumaAt(img, x - nx, y - ny);
        }
        if (Math.abs(g) > Math.abs(best)) { best = g; bestOff = o; }
      }
      if (Math.abs(best) > 3 * 6) pts.push({ x: cx + nx * bestOff, y: cy + ny * bestOff });
    }
    lines.push(fitLine(pts) ?? { px: a!.x, py: a!.y, dx: tx, dy: ty });
  }
  const out: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const p = meet(lines[(i + 3) % 4]!, lines[i]!);
    // A corner that runs off by more than the reach keeps its coarse spot.
    out.push(p && Math.hypot(p.x - q[i]!.x, p.y - q[i]!.y) < reach * 2.5 ? p : q[i]!);
  }
  return out as Quad;
}

/** Total least squares through the points, two rounds with the worst third dropped. */
function fitLine(pts: Point[]): Line | null {
  let use = pts;
  let line: Line | null = null;
  for (let round = 0; round < 2; round++) {
    if (use.length < 6) return line;
    const mx = use.reduce((s, p) => s + p.x, 0) / use.length;
    const my = use.reduce((s, p) => s + p.y, 0) / use.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of use) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    line = { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
    const l = line;
    const res = use.map((p) => Math.abs((p.x - l.px) * -l.dy + (p.y - l.py) * l.dx));
    const cut = res.slice().sort((a, b) => a - b)[Math.floor(res.length * 0.66)];
    use = use.filter((_, i) => res[i]! <= cut!);
  }
  return line;
}

function meet(a: Line, b: Line): Point | null {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return { x: a.px + a.dx * t, y: a.py + a.dy * t };
}

function clampQuad(q: Quad, W: number, H: number): Quad {
  return q.map((p) => ({ x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) })) as Quad;
}
