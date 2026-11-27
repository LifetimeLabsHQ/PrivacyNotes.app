/**
 * Column layout and border codec, CSS grid templates, and container styles.
 *
 * Kept free of ProseMirror and React imports so both the TipTap editor
 * (`columns.ts`, `ColumnsBlock.tsx`, `ColumnsControls.tsx`, `Callout.tsx`)
 * and the standalone HTML/PDF/Burn renderer (`markdownRender.ts`) share one
 * source of truth.
 *
 * Stored as nested callout metadata:
 *   > [!columns]+                           (borderless default)
 *   > [!columns|divider]+                   (1px solid default divider)
 *   > [!columns|boxes-dashed-blue-tint]+    (dashed blue boxes with soft tint)
 *   > [!columns|frame-dotted-thick-teal]+   (2px dotted teal frame)
 *   > > [!col|33]+                          (column width share, omitted when equal)
 *
 * Spec: docs/contrib/callouts.md (Columns)
 */

import { PALETTE } from './editorColors';
import { isLookColor, type LookColor } from './itemStyles';

export const COLUMN_BORDER_STYLES = ['none', 'divider', 'boxes', 'frame'] as const;
export type ColumnBorderStyle = (typeof COLUMN_BORDER_STYLES)[number];

export const COLUMN_BORDER_LINES = ['solid', 'dashed', 'dotted'] as const;
export type ColumnBorderLine = (typeof COLUMN_BORDER_LINES)[number];

export const COLUMN_BORDER_WEIGHTS = [1, 2] as const;
type ColumnBorderWeight = (typeof COLUMN_BORDER_WEIGHTS)[number];

export interface ColumnBorderConfig {
  style: ColumnBorderStyle;
  line: ColumnBorderLine;
  weight: ColumnBorderWeight;
  color: LookColor | null;
  tint: boolean;
}

export const DEFAULT_COLUMN_BORDER: ColumnBorderConfig = {
  style: 'none',
  line: 'solid',
  weight: 1,
  color: null,
  tint: false,
};

const COL_CALLOUT_HEADER_RE = /^\[!col(?:\|([\w-]+))?\][+-]?\s?(.*)$/i;

/** Parse a column width weight (1..99) from `[!col|33]` metadata. */
export function parseColumnWidth(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 99 ? n : null;
}

/** Parse a de-prefixed `[!col]` or `[!col|33]` callout header line. */
export function parseColCalloutHeader(line: string): { width: number | null; lead: string } | null {
  if (typeof line !== 'string') return null;
  const m = COL_CALLOUT_HEADER_RE.exec(line);
  if (!m) return null;
  return {
    width: parseColumnWidth(m[1]),
    lead: (m[2] ?? '').trim(),
  };
}

/** CSS `grid-template-columns` value for normalized weights, or equal `1fr` tracks when unset. */
export function columnsGridTemplate(weights: readonly number[] | null | undefined, columnCount = 1): string {
  if (
    Array.isArray(weights) &&
    weights.length > 0 &&
    weights.every((w) => typeof w === 'number' && Number.isFinite(w) && w > 0)
  ) {
    return weights.map((w) => `minmax(0,${w}fr)`).join(' ');
  }
  const count =
    typeof columnCount === 'number' && Number.isFinite(columnCount)
      ? Math.max(1, Math.floor(columnCount))
      : 1;
  return `repeat(${count},minmax(0,1fr))`;
}

/** True when `style` supports a soft column background tint (Boxes or Frame). */
export function columnBorderSupportsTint(style: ColumnBorderStyle): boolean {
  return style === 'boxes' || style === 'frame';
}

/** True when the soft column tint should paint on this border configuration. */
function columnBorderHasTint(cfg: ColumnBorderConfig): boolean {
  return cfg.tint && columnBorderSupportsTint(cfg.style);
}

function isColumnBorderStyle(v: unknown): v is ColumnBorderStyle {
  return typeof v === 'string' && (COLUMN_BORDER_STYLES as readonly string[]).includes(v);
}

function isColumnBorderLine(v: unknown): v is ColumnBorderLine {
  return typeof v === 'string' && (COLUMN_BORDER_LINES as readonly string[]).includes(v);
}

function normalizeColumnBorder(cfg: ColumnBorderConfig | null | undefined): ColumnBorderConfig {
  if (!cfg || typeof cfg !== 'object' || !isColumnBorderStyle(cfg.style) || cfg.style === 'none') {
    return DEFAULT_COLUMN_BORDER;
  }
  const style = cfg.style;
  const line: ColumnBorderLine = isColumnBorderLine(cfg.line) ? cfg.line : 'solid';
  const weight: ColumnBorderWeight = cfg.weight === 2 ? 2 : 1;
  const color: LookColor | null = isLookColor(cfg.color) ? cfg.color : null;
  const tint = Boolean(cfg.tint) && columnBorderSupportsTint(style);
  return { style, line, weight, color, tint };
}

/** Grid gap matching each border style so CSS and resize-handle math stay aligned. */
export function columnBorderGapCss(style: ColumnBorderStyle): string {
  if (style === 'frame') return '0px';
  if (style === 'boxes') return '0.75rem';
  return '1.25rem';
}

/** Parse `[!columns|<meta>]+` metadata into a normalized border config. */
export function parseColumnBorder(meta: string | null | undefined): ColumnBorderConfig {
  if (typeof meta !== 'string' || !meta) return DEFAULT_COLUMN_BORDER;
  let style: ColumnBorderStyle = 'none';
  let line: ColumnBorderLine = 'solid';
  let weight: ColumnBorderWeight = 1;
  let color: LookColor | null = null;
  let tint = false;

  for (const raw of meta.toLowerCase().split('-')) {
    if (raw === 'divider' || raw === 'boxes' || raw === 'frame') {
      style = raw;
    } else if (raw === 'dashed' || raw === 'dotted') {
      line = raw;
    } else if (raw === 'thick') {
      weight = 2;
    } else if (raw === 'tint') {
      tint = true;
    } else if (isLookColor(raw)) {
      color = raw;
    }
  }

  if (style === 'none') return DEFAULT_COLUMN_BORDER;
  return {
    style,
    line,
    weight,
    color,
    tint: tint && columnBorderSupportsTint(style),
  };
}

/** Serialize a border config into canonical `[!columns|<meta>]+` metadata, or null when borderless. */
export function formatColumnBorder(cfg: ColumnBorderConfig): string | null {
  const norm = normalizeColumnBorder(cfg);
  if (norm.style === 'none') return null;
  const parts: string[] = [norm.style];
  if (norm.line !== 'solid') parts.push(norm.line);
  if (norm.weight === 2) parts.push('thick');
  if (norm.color) parts.push(norm.color);
  if (norm.tint) parts.push('tint');
  return parts.join('-');
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Standalone CSS color values for HTML export, print and burn viewer.
 * Reads `PALETTE` dynamically so any future color added to `LOOK_COLORS` /
 * `TEXT_COLORS` works with zero changes here.
 */
export function columnBorderExportColors(cfg: ColumnBorderConfig): { bc: string; bg: string } {
  const norm = normalizeColumnBorder(cfg);
  const hex = norm.color ? PALETTE[norm.color] : null;
  const bc = hex ? hexToRgba(hex, 0.62) : 'rgba(128,128,128,0.45)';
  const bg = columnBorderHasTint(norm)
    ? hex
      ? hexToRgba(hex, 0.12)
      : 'rgba(128,128,128,0.06)'
    : 'transparent';
  return { bc, bg };
}

/**
 * Container style rules for a columns block: CSS custom properties for the live
 * editor node view (`mode: 'editor'`, default), or standalone inline CSS for
 * HTML export, print, and the burn viewer (`mode: 'export'`).
 */
export function columnContainerStyle(
  weights: readonly number[] | null,
  border: ColumnBorderConfig,
  options?: { mode?: 'editor'; columnCount?: number },
): Record<string, string>;
export function columnContainerStyle(
  weights: readonly number[] | null,
  border: ColumnBorderConfig,
  options: { mode: 'export'; columnCount?: number },
): string;
export function columnContainerStyle(
  weights: readonly number[] | null,
  border: ColumnBorderConfig,
  options?: { mode?: 'editor' | 'export'; columnCount?: number },
): Record<string, string> | string {
  const norm = normalizeColumnBorder(border);
  const template = columnsGridTemplate(weights, options?.columnCount);
  const gap = columnBorderGapCss(norm.style);
  if (options?.mode === 'export') {
    if (norm.style === 'none') {
      return `margin:1em 0;display:grid;grid-template-columns:${template};gap:${gap};align-items:start`;
    }
    const { bc, bg } = columnBorderExportColors(norm);
    const frameCss =
      norm.style === 'frame'
        ? `;border:${norm.weight}px ${norm.line} ${bc};border-radius:7px;overflow:hidden${bg !== 'transparent' ? `;background:${bg}` : ''}`
        : '';
    return `margin:1em 0;display:grid;grid-template-columns:${template};gap:${gap};align-items:stretch;--pn-col-bw:${norm.weight}px;--pn-col-bs:${norm.line};--pn-col-bc:${bc};--pn-col-bg:${bg}${frameCss}`;
  }
  const vars: Record<string, string> = {
    '--pn-cols-template': template,
    '--pn-cols-gap': gap,
  };
  if (norm.style !== 'none') {
    vars['--pn-col-bw'] = `${norm.weight}px`;
    vars['--pn-col-bs'] = norm.line;
    vars['--pn-col-bc'] = norm.color
      ? `color-mix(in srgb, var(--pn-label-${norm.color}-ink) 62%, transparent)`
      : 'rgb(var(--pn-text) / 0.24)';
    if (columnBorderHasTint(norm)) {
      vars['--pn-col-bg'] = norm.color
        ? `var(--pn-label-${norm.color}-tint)`
        : 'rgb(var(--pn-text) / 0.045)';
    }
  }
  return vars;
}
