/**
 * The doodle block's strokes (issue #736). `getStroke` from the
 * `perfect-freehand` package draws every stroke; the rest of this file is
 * the demo app of the same repository (`packages/dev`, MIT), carried over
 * as it is: its fill-and-outline render and its erase test. Its settings
 * live in doodleStyle.ts. Keep both in step with that demo on an update
 * (docs/contrib/map/editor.md, doodle).
 *
 * As in the demo, the fill and outline colours belong to each stroke, and
 * every other setting applies to all strokes of the block.
 */
import { getStroke } from 'perfect-freehand';
import { EASINGS, type DoodleStroke, type DoodleStyle } from './doodleStyle';

/** The outline polygon of one stroke (the demo's `DrawUtil.Component`). */
export function strokeOutline(stroke: DoodleStroke, style: DoodleStyle, done = true): number[][] {
  return getStroke(stroke.points, {
    size: style.size,
    thinning: style.thinning,
    streamline: style.streamline,
    smoothing: style.smoothing,
    easing: EASINGS[style.easing],
    start: { taper: taper(style.taperStart), cap: style.capStart, easing: EASINGS[style.easingStart] },
    end: { taper: taper(style.taperEnd), cap: style.capEnd, easing: EASINGS[style.easingEnd] },
    simulatePressure: !stroke.pressure,
    last: done,
  });
}

/** The demo's slider gives `true` at its top end. */
function taper(v: number): number | boolean {
  return v >= 100 ? true : v;
}

const average = (a: number, b: number) => (a + b) / 2;

/** The demo's `getSvgPathFromStroke`: the outline as a closed SVG path. */
export function svgPath(points: number[][]): string {
  const len = points.length;
  if (len < 4) return '';
  const x = (i: number) => points[i]?.[0] ?? 0;
  const y = (i: number) => points[i]?.[1] ?? 0;
  let result = `M${x(0).toFixed(2)},${y(0).toFixed(2)} Q${x(1).toFixed(2)},${y(1).toFixed(2)} ${average(x(1), x(2)).toFixed(2)},${average(y(1), y(2)).toFixed(2)} T`;
  for (let i = 2, max = len - 1; i < max; i++) {
    result += `${average(x(i), x(i + 1)).toFixed(2)},${average(y(i), y(i + 1)).toFixed(2)} `;
  }
  return `${result}Z`;
}

/** How the demo paints a stroke: the outline first, then the fill over it.
 *  With neither, a thin black line keeps the stroke visible. */
export function paintOf(stroke: DoodleStroke, style: DoodleStyle): { fill: string | null; line: string | null; lineWidth: number } {
  if (style.strokeWidth > 0) return { fill: style.isFilled ? stroke.fill : null, line: stroke.stroke, lineWidth: style.strokeWidth };
  if (style.isFilled) return { fill: stroke.fill, line: null, lineWidth: 0 };
  return { fill: null, line: '#000000', lineWidth: 1 };
}

const X = (q: readonly number[]) => q[0] ?? 0;
const Y = (q: readonly number[]) => q[1] ?? 0;

function cross(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  return (X(b) - X(a)) * (Y(c) - Y(a)) - (X(c) - X(a)) * (Y(b) - Y(a));
}

/** The demo's winding-number test. */
export function pointInPolygon(p: readonly number[], points: number[][]): boolean {
  let wn = 0;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length] ?? a;
    if (Y(a) <= Y(p)) {
      if (Y(b) > Y(p) && cross(a, b, p) > 0) wn += 1;
    } else if (Y(b) <= Y(p) && cross(a, b, p) < 0) {
      wn -= 1;
    }
  });
  return wn !== 0;
}

/** The demo's erase test: on the stroke's outline, or within 10 of its start. */
export function hitsStroke(p: readonly number[], stroke: DoodleStroke, outline: number[][]): boolean {
  const start = stroke.points[0];
  if (start && Math.hypot(X(p) - X(start), Y(p) - Y(start)) < 10) return true;
  return outline.length > 2 && pointInPolygon(p, outline);
}

/** One stroke as SVG markup, painted as the demo paints it. The colours
 *  are checked hex values (doodleFormat.ts), so they go into the markup as
 *  they are. */
export function strokeSvg(stroke: DoodleStroke, style: DoodleStyle): string {
  const d = svgPath(strokeOutline(stroke, style));
  if (!d) return '';
  const paint = paintOf(stroke, style);
  const line = paint.line ? `<path d="${d}" fill="none" stroke="${paint.line}" stroke-width="${paint.lineWidth}" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  const fill = paint.fill ? `<path d="${d}" fill="${paint.fill}"/>` : '';
  return line + fill;
}
