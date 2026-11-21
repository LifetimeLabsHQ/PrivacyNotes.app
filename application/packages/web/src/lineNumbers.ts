/**
 * Line numbers (GitHub #727 follow-up): which Markdown line each block of a
 * formatted view starts on. The Markdown view numbers its own lines (the
 * marks copy in MarkdownSourceEditor.tsx); the formatted view and the split
 * view's preview put the same number beside each block (BlockLineNumbers.tsx),
 * so a number points at the same place on both sides. The pairing is the
 * scroll follow's (pairLinesToBlocks): a block is found by its first words.
 * A picture has no words, so pictures are paired by their order instead.
 * Spec: docs/internal/specs/editor-mode-toggle.md (Line numbers)
 */
import { pairLinesToBlocks, previewBlocks } from './viewSwitchAnchor';

/** The gap between a number and its block: past the fold chevron where the
 *  view draws one at the line's start (editorFolds.ts BUTTON_W, 18px). Here,
 *  not in BlockLineNumbers.tsx, so the editor can load that layer on demand. */
export const NUMBER_GAP = 12;
export const NUMBER_GAP_FOLDS = 30;

const FENCE = /^\s*(?:`{3,}|~{3,})/;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/** The width the numbers of a note with `lines` lines take, plus `gap`
 *  before the text. A monospace digit is about 0.62 of the font size; the
 *  numbers end against the text, so only the room must be enough. */
export function lineGutter(lines: number, gap: number): string {
  return `calc(${String(Math.max(1, lines)).length} * 8.7px * var(--pn-text-scale) + ${gap}px)`;
}

/** Per block, the line it starts on, or null for a block no line names.
 *  A code block starts on its fence, not on its first code line. */
export function linesOfBlocks(lines: readonly string[], blocks: readonly string[]): Array<number | null> {
  const out: Array<number | null> = blocks.map(() => null);
  for (const [i, j] of pairLinesToBlocks(lines, blocks)) {
    out[j] = i > 0 && FENCE.test(lines[i - 1]!) ? i - 1 : i;
  }
  return out;
}

/** The line of each picture, in order, one entry per picture; none inside a
 *  code block. */
export function imageLines(lines: readonly string[]): number[] {
  const out: number[] = [];
  let code = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      code = !code;
      return;
    }
    if (code) return;
    for (const _ of line.matchAll(IMAGE)) out.push(i);
  });
  return out;
}

/** The numbered line whose block holds `line`: the last numbered line at or
 *  before it, with no blank line between (a blank line ends a block). */
export function blockStartFor(numbered: readonly number[], lines: readonly string[], line: number): number | null {
  let best: number | null = null;
  for (const n of numbered) {
    if (n > line) break;
    best = n;
  }
  if (best === null) return null;
  for (let k = best; k <= line; k++) if (!lines[k]?.trim()) return null;
  return best;
}

export type NumberedBlock = { line: number; el: HTMLElement };

/** The blocks of a formatted body with the line each starts on, in the
 *  body's order. Pictures count only when the body draws as many as the
 *  text names, so a picture never takes another one's number. */
export function numberBlocks(text: string, body: HTMLElement): NumberedBlock[] {
  const lines = text.split('\n');
  const blocks = previewBlocks(body);
  const at = linesOfBlocks(lines, blocks.map((b) => b.text));
  const out: NumberedBlock[] = [];
  blocks.forEach((b, j) => {
    const line = at[j];
    if (line !== null && line !== undefined) out.push({ line, el: b.el });
  });
  const pictures = body.querySelectorAll<HTMLElement>('.pn-image-node');
  const pictureLines = imageLines(lines);
  if (pictures.length === pictureLines.length) pictures.forEach((el, k) => out.push({ line: pictureLines[k]!, el }));
  return out.sort((a, b) => a.line - b.line);
}
