/**
 * Keeps the reading position when a note switches between the formatted view
 * and the Markdown view. Both views scroll in the same pane but have very
 * different heights (a picture is tall in one and one line in the other), so
 * a scroll percent lands lines off. Instead the first block at the top of the
 * pane is the anchor: its first words are found in the other view, line by
 * line with the Markdown marks stripped, and the pane scrolls that place to
 * where the block was. The percent stays as the estimate that picks between
 * two places with the same words, and as the fallback when nothing matches.
 * The same line reading keeps the preview beside the Markdown text on the
 * place the text shows (createPreviewFollow, at the end).
 * Spec: docs/internal/issues/0493.md (Reading position)
 */

import { stripToPlainText } from './notesViewUtils';

/** What a switch carries from one view to the other. `part` is how much of
 *  the anchor's own height was above the reading line (0 to 1): a long
 *  paragraph wraps to more rows in a narrow column than in a wide one, so
 *  the place inside it travels as a share of its height, not in pixels. */
export type ViewAnchor = { words: string; offset: number; ratio: number; part?: number };

/** The share of a line or block above the reading line. */
function partAbove(top: number, height: number, line: number): number {
  return height > 0 ? Math.min(1, Math.max(0, (line - top) / height)) : 0;
}

/** Lower case, one space between words, no edge spaces. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The first words of a block, enough to find it again. */
export function anchorWords(text: string, count = 6): string {
  return normalizeText(text).split(' ').filter(Boolean).slice(0, count).join(' ');
}

/** A line that draws no text of its own in the formatted view: a code
 *  fence, a callout header, a table rule, a divider. */
const STRUCTURAL = /^\s*(?:(?:>\s?)*\[![\w-]+(?:\|[\w-]+)?\][+-]?.*|`{3,}.*|~{3,}.*|\|?[\s:|-]*-{3,}[\s:|-]*|[-*_]{3,}\s*)$/;

/** One Markdown line as the formatted view shows its text; empty for a
 *  line that shows none. The reading is the preview stripper's, so the two
 *  never disagree; this adds only the indent of a nested item and a table
 *  row's cells. A spoiler reads as the preview mask, so a line that starts
 *  with one matches on fewer words or falls back to the scroll percent. */
export function stripMarkdownLine(line: string): string {
  if (STRUCTURAL.test(line)) return '';
  return normalizeText(stripToPlainText(line.trimStart()).replace(/\|/g, ' '));
}

/**
 * The index of the entry that starts with `words` (or, failing that, holds
 * them), nearest to `estimate`; fewer words are tried when the full run is
 * not found, down to two. -1 when nothing matches.
 */
export function findNearest(entries: readonly string[], words: string, estimate: number): number {
  const all = words.split(' ').filter(Boolean);
  for (let n = all.length; n >= Math.min(2, all.length) && n > 0; n--) {
    const needle = all.slice(0, n).join(' ');
    for (const test of [(e: string) => e.startsWith(needle), (e: string) => e.includes(needle)]) {
      let best = -1;
      entries.forEach((e, i) => {
        if (e && test(e) && (best === -1 || Math.abs(i - estimate) < Math.abs(best - estimate))) best = i;
      });
      if (best !== -1) return best;
    }
  }
  return -1;
}

// ------------------------------------------------------------------
// The DOM half: what sits at the top of the pane, and putting it back.
// ------------------------------------------------------------------

/** The blocks of the formatted view that carry text a reader sees. */
const RICH_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, pre, th, td';

/** A block placed below the reading line keeps at most this gap, so a
 *  picture above it in one view does not push it down the other. */
const MAX_GAP = 48;

/** The top of the part of the pane the reader sees: under the sticky tag
 *  row, and under the format bar when it sits at the top. */
function readingLine(pane: HTMLElement): number {
  const top = pane.getBoundingClientRect().top;
  const tagRow = parseFloat(getComputedStyle(pane).getPropertyValue('--pn-tagrow-h')) || 0;
  const bar = pane.querySelector<HTMLElement>('.pn-editor-toolbar:not(.pn-toolbar-bottom)');
  return Math.max(top + tagRow, bar ? bar.getBoundingClientRect().bottom : 0);
}

function scrollRatio(pane: HTMLElement): number {
  const max = pane.scrollHeight - pane.clientHeight;
  return max > 0 ? pane.scrollTop / max : 0;
}

/** The top of each line of a textarea, from its own top, measured on a copy
 *  with the same font, width and wrapping. */
function lineTops(area: HTMLTextAreaElement, lines: readonly string[]): number[] {
  const cs = getComputedStyle(area);
  const mirror = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingLeft', 'paddingRight'] as const) {
    mirror.style[p] = cs[p];
  }
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px',
    width: `${area.clientWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'border-box',
  });
  for (const line of lines) {
    const row = document.createElement('div');
    row.textContent = line || ' ';
    mirror.appendChild(row);
  }
  document.body.appendChild(mirror);
  const tops = Array.from(mirror.children, (row) => (row as HTMLElement).offsetTop);
  mirror.remove();
  return tops;
}

/** Reads the anchor from whichever view is on screen; null when the pane
 *  is at its top, where both views already agree. */
export function captureAnchor(pane: HTMLElement): ViewAnchor | null {
  if (pane.scrollTop < 2) return null;
  const line = readingLine(pane);
  const ratio = scrollRatio(pane);
  const area = pane.querySelector<HTMLTextAreaElement>('textarea[data-pn-source]');
  if (area) {
    const lines = area.value.split('\n');
    const tops = lineTops(area, lines);
    const areaTop = area.getBoundingClientRect().top;
    let i = tops.findIndex((t, n) => areaTop + (tops[n + 1] ?? t + 1) > line + 2);
    while (i !== -1 && i < lines.length && !stripMarkdownLine(lines[i]!)) i++;
    if (i === -1 || i >= lines.length) return { words: '', offset: 0, ratio };
    const top = areaTop + tops[i]!;
    const height = (tops[i + 1] ?? tops[i]! + (parseFloat(getComputedStyle(area).lineHeight) || 0)) - tops[i]!;
    return { words: anchorWords(stripMarkdownLine(lines[i]!)), offset: top - line, ratio, part: partAbove(top, height, line) };
  }
  const body = pane.querySelector<HTMLElement>('.ProseMirror');
  if (!body) return null;
  const block = Array.from(body.querySelectorAll<HTMLElement>(RICH_BLOCKS))
    .find((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().bottom > line + 2 && normalizeText(el.textContent ?? '') !== '');
  if (!block) return { words: '', offset: 0, ratio };
  const box = block.getBoundingClientRect();
  return { words: anchorWords(block.textContent ?? ''), offset: box.top - line, ratio, part: partAbove(box.top, box.height, line) };
}

/** Scrolls the view now on screen so the anchor sits where it was. False
 *  while that view has not drawn its text yet. */
function restoreAnchor(pane: HTMLElement, anchor: ViewAnchor): boolean {
  const area = pane.querySelector<HTMLTextAreaElement>('textarea[data-pn-source]');
  const body = area ? null : pane.querySelector<HTMLElement>('.ProseMirror');
  if (!area && !body?.firstElementChild) return false;
  const max = pane.scrollHeight - pane.clientHeight;
  const line = readingLine(pane);
  let gap = Math.min(anchor.offset, MAX_GAP);
  // An anchor partly above the reading line keeps the same share above it.
  const keepPart = (height: number) => {
    if (anchor.offset < 0 && anchor.part !== undefined) gap = -anchor.part * height;
  };
  let top: number | null = null;
  if (anchor.words && area) {
    const lines = area.value.split('\n');
    const at = findNearest(lines.map(stripMarkdownLine), anchor.words, anchor.ratio * lines.length);
    if (at !== -1) {
      const tops = lineTops(area, lines);
      top = area.getBoundingClientRect().top + tops[at]!;
      keepPart((tops[at + 1] ?? tops[at]! + (parseFloat(getComputedStyle(area).lineHeight) || 0)) - tops[at]!);
    }
  } else if (anchor.words && body) {
    const blocks = Array.from(body.querySelectorAll<HTMLElement>(RICH_BLOCKS));
    const at = findNearest(blocks.map((b) => normalizeText(b.textContent ?? '')), anchor.words, anchor.ratio * blocks.length);
    // A block inside a folded callout has no box: the callout stands in.
    let shown: HTMLElement | null = at === -1 ? null : blocks[at]!;
    while (shown && shown.getClientRects().length === 0) shown = shown.parentElement;
    if (shown) {
      top = shown.getBoundingClientRect().top;
      keepPart(shown.getBoundingClientRect().height);
    }
    if (shown && shown !== blocks[at]) gap = 0;
  }
  pane.scrollTop = top === null
    ? Math.round(anchor.ratio * max)
    : Math.round(pane.scrollTop + top - line - gap);
  return true;
}

/**
 * Puts the anchor back once the view has drawn its text, and once more a
 * frame later, when its height has settled. A scroll from anything else
 * between two frames (a jump to a heading, a search hit) wins, and the loop
 * stops. Returns the cancel.
 */
export function followAnchor(pane: HTMLElement, anchor: ViewAnchor): () => void {
  let frame = 0;
  let tries = 0;
  let placed = false;
  let last: number | null = null;
  const step = () => {
    if (last !== null && Math.abs(pane.scrollTop - last) > 2) return;
    if (restoreAnchor(pane, anchor)) {
      if (placed) return;
      placed = true;
    } else if (++tries > 30) {
      return;
    }
    last = pane.scrollTop;
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

// ------------------------------------------------------------------
// The preview beside the text: the Markdown view with a preview.
// ------------------------------------------------------------------

/** How many blocks a line looks ahead for its own: far enough to pass the
 *  blocks no line writes alone, near enough that a short line does not take
 *  the same words much further down. */
const LOOK_AHEAD = 12;

/**
 * Pairs Markdown lines with the formatted blocks that show them, in order:
 * a line that shows text takes the first block after the last pair whose
 * text is its first words. A line with no block of its own (a code line, the
 * second half of a hard break) pairs with nothing, and its place is read
 * between the pairs around it. `blocks` are the blocks' texts, normalized.
 */
export function pairLinesToBlocks(lines: readonly string[], blocks: readonly string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let next = 0;
  lines.forEach((line, i) => {
    const words = anchorWords(stripMarkdownLine(line));
    if (!words) return;
    const end = Math.min(blocks.length, next + LOOK_AHEAD);
    for (let j = next; j < end; j++) {
      const block = blocks[j]!;
      if (block === words || block.startsWith(`${words} `)) {
        pairs.push([i, j]);
        next = j + 1;
        return;
      }
    }
  });
  return pairs;
}

/**
 * The place on the second side for `at` on the first, read on the straight
 * line between the two points around it. `points` rise on both sides. Before
 * the first point and after the last one the two sides move together.
 */
export function placeBetween(points: readonly (readonly [number, number])[], at: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return at;
  if (at <= first[0]) return first[1] + at - first[0];
  if (at >= last[0]) return last[1] + at - last[0];
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] <= at) lo = mid;
    else hi = mid;
  }
  const [a, pa] = points[lo]!;
  const [b, pb] = points[hi]!;
  return pa + ((at - a) / (b - a)) * (pb - pa);
}

/** A table cell's text: its paragraphs only, without the sort buttons a
 *  header cell draws, whose labels no Markdown line writes. */
function cellText(cell: HTMLTableCellElement): string {
  const paragraphs = cell.querySelectorAll('p');
  return paragraphs.length > 0 ? Array.from(paragraphs, (p) => p.textContent ?? '').join(' ') : cell.textContent ?? '';
}

/** The blocks of the preview a Markdown line can stand for. A table row is
 *  one block, its cells side by side as stripMarkdownLine reads the row, so
 *  the paragraphs inside its cells are not blocks of their own. */
export function previewBlocks(body: HTMLElement): Array<{ el: HTMLElement; text: string }> {
  return Array.from(body.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6, pre, tr'))
    .filter((el) => el.tagName === 'TR' || !el.closest('td, th'))
    .map((el) => ({
      el,
      text: normalizeText(el instanceof HTMLTableRowElement
        ? Array.from(el.cells, cellText).join(' ')
        : el.textContent ?? ''),
    }));
}

export type PreviewFollow = {
  /** Scrolls the preview to the place the text shows now. */
  align: () => void;
  /** The preview drew new content: measure the pairs again. */
  invalidate: () => void;
  /** Moves the text so the preview shows `el` at its top (the outline's
   *  jump): `align` read the other way, on the same pairs. */
  reveal: (el: Element) => void;
};

/**
 * Keeps the preview beside the Markdown text on the place the text shows at
 * the top of the pane: `pane` scrolls the text, `preview` scrolls itself and
 * sits under the same bars, so its top edge is the reading line. Lines and
 * blocks are paired once per preview refresh and width, and each `align`
 * reads the reading line between the two pairs around it, so the preview
 * glides past a picture or a code block instead of jumping at its ends. Over
 * the last screen of the pane the preview closes on its own end, so the two
 * ends meet. One way: a scroll in the preview moves nothing. With no pair,
 * the scroll percent.
 * Spec: docs/internal/specs/heading-folds-and-source-preview.md (Part 2, decision 5)
 */
export function createPreviewFollow(pane: HTMLElement, preview: HTMLElement): PreviewFollow {
  let version = 0;
  let key = '';
  let points: Array<[number, number]> = [];

  const measure = (area: HTMLTextAreaElement, body: HTMLElement) => {
    const lines = area.value.split('\n');
    const tops = lineTops(area, lines);
    const blocks = previewBlocks(body);
    const base = preview.getBoundingClientRect().top - preview.scrollTop;
    points = [];
    for (const [i, j] of pairLinesToBlocks(lines, blocks.map((b) => b.text))) {
      // A block inside a folded callout has no box: the callout stands in.
      let shown: HTMLElement | null = blocks[j]!.el;
      while (shown && shown.getClientRects().length === 0) shown = shown.parentElement;
      if (!shown) continue;
      const at: [number, number] = [tops[i]!, shown.getBoundingClientRect().top - base];
      const last = points[points.length - 1];
      if (!last || (at[0] > last[0] && at[1] >= last[1])) points.push(at);
    }
    // The pane's top is the preview's top: the reading line's place on the
    // text when the pane is not scrolled (the column under the bars does
    // not move) maps to 0, ahead of the first block's own top gap.
    const startAt = preview.getBoundingClientRect().top - area.getBoundingClientRect().top - pane.scrollTop;
    if (points[0] && startAt < points[0][0]) points.unshift([startAt, 0]);
    const last = points[points.length - 1];
    const textEnd = (tops[tops.length - 1] ?? 0) + (parseFloat(getComputedStyle(area).lineHeight) || 0);
    const previewEnd = body.getBoundingClientRect().bottom - base;
    if (last && textEnd > last[0] && previewEnd >= last[1]) points.push([textEnd, previewEnd]);
  };

  /** The text field once the pairs are current; null while either side
   *  has not drawn. */
  const measured = (): HTMLTextAreaElement | null => {
    const area = pane.querySelector<HTMLTextAreaElement>('textarea[data-pn-source]');
    const body = preview.querySelector<HTMLElement>('.ProseMirror');
    if (!area || !body) return null;
    const now = `${version}|${area.clientWidth}|${preview.clientWidth}|${preview.scrollHeight}`;
    if (now !== key) {
      key = now;
      measure(area, body);
    }
    return area;
  };

  const align = () => {
    const max = preview.scrollHeight - preview.clientHeight;
    const paneMax = pane.scrollHeight - pane.clientHeight;
    if (max <= 0 || paneMax <= 0) return;
    const area = measured();
    if (!area) return;
    let target = points.length > 0
      ? placeBetween(points, preview.getBoundingClientRect().top - area.getBoundingClientRect().top)
      : (pane.scrollTop / paneMax) * max;
    const endStart = Math.max(0, paneMax - pane.clientHeight);
    const end = Math.min(1, Math.max(0, (pane.scrollTop - endStart) / (paneMax - endStart)));
    target += (max - target) * end;
    preview.scrollTop = Math.round(Math.min(max, Math.max(0, target)));
  };

  const reveal = (el: Element) => {
    const area = measured();
    if (!area || points.length === 0) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const base = preview.getBoundingClientRect().top - preview.scrollTop;
    const at = placeBetween(points.map(([t, p]) => [p, t] as const), el.getBoundingClientRect().top - base);
    const top = pane.scrollTop + area.getBoundingClientRect().top + at - preview.getBoundingClientRect().top;
    pane.scrollTo({ top: Math.max(0, Math.round(top)), behavior: 'smooth' });
  };

  return { align, invalidate: () => { version++; }, reveal };
}
