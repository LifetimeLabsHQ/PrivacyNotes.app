/**
 * A doodle block's text in the note (issue #736), a fenced block like the
 * map's (PlaceMapNode.tsx):
 *
 *     ```doodle height=400
 *     {"v":1,"id":"k2f9","paper":"#ffffff","style":{...},"strokes":[{"f":"#000000","s":"#000000","p":0,"d":[...]}]}
 *     ```
 *
 * The board is BOARD_WIDTH units wide and `height` units tall, whatever the
 * width of the screen; the block scales it to the column. A stroke's points
 * are whole board units, the first point as it is and every next one as the
 * step from the one before. A pen stroke (`p: 1`) adds its pressure, 0 to
 * 100, after each point. The text comes from any note, a shared or imported
 * one too, so the parse checks every field and drops what it cannot read; a
 * fence it cannot read at all stays a code block.
 */
import { DEFAULT_STYLE, EASING_NAMES, RANGES, type DoodleStroke, type DoodleStyle } from './doodleStyle';

import { BOARD_HEIGHT_DEFAULT } from './doodleFence';

export { BOARD_HEIGHT_DEFAULT } from './doodleFence';
/** The board's width in board units. */
export const BOARD_WIDTH = 800;
const BOARD_HEIGHT_MIN = 150;
const BOARD_HEIGHT_MAX = 2400;
/** Limits on what a parse takes in, against a note made to stall the app. */
const MAX_STROKES = 5000;
const MAX_NUMBERS = 400_000;

export type DoodleData = {
  /** Stable across saves and devices: the full-screen window finds its block by it. */
  id: string;
  paper: string | null;
  style: DoodleStyle;
  strokes: DoodleStroke[];
};

const HEX = /^#[0-9a-f]{6}$/i;

export function clampBoardHeight(raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  return Math.min(BOARD_HEIGHT_MAX, Math.max(BOARD_HEIGHT_MIN, Math.round(raw)));
}

export function newDoodleId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function textId(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `t${(h >>> 0).toString(36)}`;
}

/** A stroke's points as the compact list of whole numbers. */
function encodePoints(stroke: DoodleStroke): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  stroke.points.forEach((pt, i) => {
    const x = Math.round(pt[0] ?? 0);
    const y = Math.round(pt[1] ?? 0);
    if (i > 0 && x === px && y === py) return;
    out.push(i === 0 ? x : x - px, i === 0 ? y : y - py);
    if (stroke.pressure) out.push(Math.round((pt[2] ?? 0.5) * 100));
    px = x;
    py = y;
  });
  return out;
}

function decodePoints(d: number[], pressure: boolean): number[][] {
  const per = pressure ? 3 : 2;
  const points: number[][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + per <= d.length; i += per) {
    x = points.length === 0 ? (d[i] ?? 0) : x + (d[i] ?? 0);
    y = points.length === 0 ? (d[i + 1] ?? 0) : y + (d[i + 1] ?? 0);
    points.push([x, y, pressure ? Math.min(1, Math.max(0, (d[i + 2] ?? 50) / 100)) : 0.5]);
  }
  return points;
}

/** Only the style fields that differ from the default are written. */
function styleDiff(style: DoodleStyle): Partial<DoodleStyle> {
  const out: Partial<DoodleStyle> = {};
  for (const key of Object.keys(DEFAULT_STYLE) as (keyof DoodleStyle)[]) {
    if (style[key] !== DEFAULT_STYLE[key]) (out as Record<string, unknown>)[key] = style[key];
  }
  return out;
}

/** The fence's one line of text. */
export function serializeDoodle(data: DoodleData): string {
  return JSON.stringify({
    v: 1,
    id: data.id,
    paper: data.paper,
    style: styleDiff(data.style),
    strokes: data.strokes.map((s) => ({ f: s.fill, s: s.stroke, p: s.pressure ? 1 : 0, d: encodePoints(s) })),
  });
}

/** The style a saved block names, field by field over the default. */
export function readStyle(raw: unknown): DoodleStyle {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const style = { ...DEFAULT_STYLE };
  for (const key of Object.keys(DEFAULT_STYLE) as (keyof DoodleStyle)[]) {
    const v = s[key];
    const d = DEFAULT_STYLE[key];
    if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v)) {
      const range = RANGES[key as keyof typeof RANGES];
      (style[key] as number) = range ? Math.min(range.max, Math.max(range.min, v)) : v;
    }
    else if (typeof d === 'boolean' && typeof v === 'boolean') (style[key] as boolean) = v;
    else if (typeof d === 'string' && typeof v === 'string' && (EASING_NAMES as string[]).includes(v)) (style[key] as string) = v;
  }
  return style;
}

/** A doodle from a fence's text, or null when the text is no doodle. */
export function parseDoodle(text: string): DoodleData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !Array.isArray(r.strokes)) return null;
  const strokes: DoodleStroke[] = [];
  let numbers = 0;
  for (const s of r.strokes.slice(0, MAX_STROKES)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (!Array.isArray(o.d) || !o.d.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    numbers += o.d.length;
    if (numbers > MAX_NUMBERS) break;
    const pressure = o.p === 1;
    const points = decodePoints(o.d as number[], pressure);
    if (points.length === 0) continue;
    strokes.push({
      points,
      fill: typeof o.f === 'string' && HEX.test(o.f) ? o.f : '#000000',
      stroke: typeof o.s === 'string' && HEX.test(o.s) ? o.s : '#000000',
      pressure,
    });
  }
  return {
    // A block with no id of its own gets one from its text, the same on every
    // read, so the full-screen window still finds it; its next change writes it.
    id: typeof r.id === 'string' && /^[a-z0-9]{1,16}$/.test(r.id) ? r.id : textId(text),
    paper: typeof r.paper === 'string' && HEX.test(r.paper) ? r.paper : null,
    style: readStyle(r.style),
    strokes,
  };
}

