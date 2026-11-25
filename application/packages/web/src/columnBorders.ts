/**
 * Column border configuration, Markdown metadata codec, and export color math.
 *
 * Kept free of ProseMirror and React imports so both the TipTap editor
 * (`columns.ts`, `ColumnsBlock.tsx`, `ColumnsControls.tsx`, `Callout.tsx`)
 * and the standalone HTML/PDF/Burn renderer (`markdownRender.ts`) share one
 * source of truth.
 *
 * Stored as hyphen-separated tokens in the outer callout metadata:
 *   > [!columns]+                           (borderless default)
 *   > [!columns|divider]+                   (1px solid default divider)
 *   > [!columns|boxes-dashed-blue-tint]+    (dashed blue boxes with soft tint)
 *   > [!columns|frame-dotted-thick-teal]+   (2px dotted teal frame)
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

/** True when `style` supports a soft column background tint (Boxes or Frame). */
export function columnBorderSupportsTint(style: ColumnBorderStyle): boolean {
  return style === 'boxes' || style === 'frame';
}

/** True when the soft column tint should paint on this border configuration. */
export function columnBorderHasTint(cfg: ColumnBorderConfig): boolean {
  return cfg.tint && columnBorderSupportsTint(cfg.style);
}

/** Grid gap matching each border style so CSS and resize-handle math stay aligned. */
export function columnBorderGapCss(style: ColumnBorderStyle): string {
  if (style === 'frame') return '0px';
  if (style === 'boxes') return '0.75rem';
  return '1.25rem';
}

/** Parse `[!columns|<meta>]+` metadata into a normalized border config. */
export function parseColumnBorder(meta: string | null | undefined): ColumnBorderConfig {
  if (!meta) return DEFAULT_COLUMN_BORDER;
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
  if (cfg.style === 'none') return null;
  const parts: string[] = [cfg.style];
  if (cfg.line !== 'solid') parts.push(cfg.line);
  if (cfg.weight === 2) parts.push('thick');
  if (cfg.color && isLookColor(cfg.color)) parts.push(cfg.color);
  if (columnBorderHasTint(cfg)) parts.push('tint');
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
  const hex = cfg.color ? PALETTE[cfg.color] : null;
  const bc = hex ? hexToRgba(hex, 0.62) : 'rgba(128,128,128,0.45)';
  const bg = columnBorderHasTint(cfg)
    ? hex
      ? hexToRgba(hex, 0.12)
      : 'rgba(128,128,128,0.06)'
    : 'transparent';
  return { bc, bg };
}
