/**
 * The doodle block's settings and colours (issue #736), with no drawing code,
 * so the editor and the note previews can read a block's text without the
 * stroke engine. The values are the demo app of the perfect-freehand
 * repository (`packages/dev`, MIT) as it is; keep them in step with that demo
 * on an update (docs/contrib/map/editor.md, doodle). The paper is ours.
 */

// The demo's `state/easings.ts`.
export const EASINGS = {
  linear: (t: number) => t,
  easeInQuad: (t: number) => t * t,
  easeOutQuad: (t: number) => t * (2 - t),
  easeInOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t: number) => t * t * t,
  easeOutCubic: (t: number) => --t * t * t + 1,
  easeInOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  easeInQuart: (t: number) => t * t * t * t,
  easeOutQuart: (t: number) => 1 - --t * t * t * t,
  easeInOutQuart: (t: number) => (t < 0.5 ? 8 * t * t * t * t : 1 - 8 * --t * t * t * t),
  easeInQuint: (t: number) => t * t * t * t * t,
  easeOutQuint: (t: number) => 1 + --t * t * t * t * t,
  easeInOutQuint: (t: number) => (t < 0.5 ? 16 * t * t * t * t * t : 1 + 16 * --t * t * t * t * t),
  easeInSine: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  easeOutSine: (t: number) => Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInExpo: (t: number) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  easeOutExpo: (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInOutExpo: (t: number) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
} as const;

export type Easing = keyof typeof EASINGS;
export const EASING_NAMES = Object.keys(EASINGS) as Easing[];

/** The demo's `DrawStyles` without its two colours, which each stroke keeps. */
export type DoodleStyle = {
  size: number;
  thinning: number;
  streamline: number;
  smoothing: number;
  easing: Easing;
  /** 100 is the demo's `true`: the taper runs the whole stroke. */
  taperStart: number;
  capStart: boolean;
  easingStart: Easing;
  taperEnd: number;
  capEnd: boolean;
  easingEnd: Easing;
  isFilled: boolean;
  strokeWidth: number;
};

// The demo's `defaultStyle`.
export const DEFAULT_STYLE: DoodleStyle = {
  size: 16,
  thinning: 0.5,
  streamline: 0.5,
  smoothing: 0.5,
  easing: 'linear',
  taperStart: 0,
  capStart: true,
  easingStart: 'linear',
  taperEnd: 0,
  capEnd: true,
  easingEnd: 'linear',
  isFilled: true,
  strokeWidth: 0,
};

type NumberKey = 'size' | 'thinning' | 'streamline' | 'smoothing' | 'taperStart' | 'taperEnd' | 'strokeWidth';

// The demo's slider ranges (`components/controls/controls.tsx`).
export const RANGES: Record<NumberKey, { min: number; max: number; step: number }> = {
  size: { min: 1, max: 100, step: 1 },
  thinning: { min: -0.99, max: 0.99, step: 0.01 },
  streamline: { min: 0.01, max: 0.99, step: 0.01 },
  smoothing: { min: 0.01, max: 0.99, step: 0.01 },
  taperStart: { min: 0, max: 100, step: 1 },
  taperEnd: { min: 0, max: 100, step: 1 },
  strokeWidth: { min: 0, max: 100, step: 1 },
};

// The demo's `COLORS`, for the fill and the outline. `name` is the key of
// the swatch's label.
export const INK_COLORS = [
  { value: '#000000', name: 'black' },
  { value: '#ffc107', name: 'yellow' },
  { value: '#ff5722', name: 'orange' },
  { value: '#e91e63', name: 'pink' },
  { value: '#673ab7', name: 'purple' },
  { value: '#00bcd4', name: 'cyan' },
  { value: '#efefef', name: 'lightGray' },
] as const;

/** The paper under the strokes (ours, not the demo's). Null is no paper: the
 *  note shows through. White is the default, so the black ink stays readable
 *  in a dark theme. */
export const PAPER_COLORS = [
  { value: null, name: 'none' },
  { value: '#ffffff', name: 'white' },
  { value: '#f8f9fa', name: 'gray' },
  { value: '#fff9db', name: 'yellow' },
  { value: '#ebfbee', name: 'green' },
  { value: '#e7f5ff', name: 'blue' },
  { value: '#f3f0ff', name: 'purple' },
  { value: '#fff0f6', name: 'pink' },
  { value: '#212529', name: 'dark' },
] as const;
export const DEFAULT_PAPER = '#ffffff';

export type DoodleStroke = {
  /** `[x, y, pressure]` in board units. */
  points: number[][];
  fill: string;
  stroke: string;
  /** A pen gives real pressure; a mouse or a finger has it simulated. */
  pressure: boolean;
};
