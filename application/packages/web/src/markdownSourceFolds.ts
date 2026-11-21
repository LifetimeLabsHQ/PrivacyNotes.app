/**
 * Collapse all and Expand all in the Markdown view (GitHub #779 there): the
 * same change the formatted view saves, written into the text. A callout's
 * fold is the marker after its type (`> [!note]-` folded, `+` open) and a
 * code block's is the word `fold` in its fence line, so the toolbar button
 * sets every marker one way in one typed change. A Kanban board and its
 * columns never fold, and neither do a copy box, a map or a doodle fence,
 * as in foldAll.ts. Heading and list folds are the formatted view's own
 * state on this device (editorFolds.ts) and are not in the text, so this
 * view leaves them as they are.
 * Spec: docs/contrib/callouts.md (Fold control)
 */
import { nextFence, type Fence } from './markdownFence';
import { formatFenceInfo, parseFenceInfo } from './codeFenceInfo';

export type SourceFoldSummary = { foldable: number; open: number };

/** A callout's first line: its quote marks, the type, the meta after a bar,
 *  and the fold marker. */
const CALLOUT_HEAD = /^((?:[ \t]*>[ \t]?)+)\[!([\w-]+)((?:\|[\w-]+)?)\]([+-]?)/;
/** The quote marks at the start of a line. */
const QUOTES = /^(?:[ \t]*>[ \t]?)*/;
/** A fence line once its quote marks are off: indent, the run, the info. */
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
/** Fences that are not code blocks, or never close (editorCodeBlock.ts). */
const NEVER_FOLDS = new Set(['copy', 'map', 'doodle']);
const NEVER_FOLDS_CALLOUT = new Set(['kanban', 'column']);

type Spot = { line: number; folded: boolean; set: (folded: boolean) => string };

function depth(quotes: string): number {
  return (quotes.match(/>/g) ?? []).length;
}

/** Every place in the text that can fold, with how to write it either way. */
function spots(lines: readonly string[]): Spot[] {
  const found: Spot[] = [];
  let fence: Fence | null = null;
  let prevDepth = 0;
  lines.forEach((line, i) => {
    const quotes = QUOTES.exec(line)![0];
    const inner = line.slice(quotes.length);
    const lineDepth = depth(quotes);
    if (fence) {
      // A fence line with any indent counts: a list container is not tracked.
      fence = nextFence(fence, inner, Infinity).fence;
      prevDepth = lineDepth;
      return;
    }
    const step = nextFence(null, inner, Infinity);
    if (step.isFence) {
      fence = step.fence;
      const m = FENCE.exec(inner)!;
      const info = parseFenceInfo(m[3]!);
      if (!NEVER_FOLDS.has(String(info.language).toLowerCase())) {
        found.push({
          line: i,
          folded: info.folded,
          // The editor's own form of the info, as its save writes it.
          set: (folded) => `${quotes}${m[1]}${m[2]}${formatFenceInfo(info.language, info.title, folded)}`,
        });
      }
      prevDepth = lineDepth;
      return;
    }
    // A callout opens a quote: a header one level deeper than the line above.
    const head = CALLOUT_HEAD.exec(line);
    if (head && lineDepth > prevDepth && !NEVER_FOLDS_CALLOUT.has(head[2]!.toLowerCase())) {
      const before = head[1]! + `[!${head[2]}${head[3]}]`;
      const after = line.slice(head[0].length);
      found.push({ line: i, folded: head[4] === '-', set: (folded) => `${before}${folded ? '-' : '+'}${after}` });
    }
    prevDepth = lineDepth;
  });
  return found;
}

/** How many places in the text can fold, and how many of them are open. */
export function sourceFoldSummary(text: string): SourceFoldSummary {
  const all = spots(text.split('\n'));
  return { foldable: all.length, open: all.filter((s) => !s.folded).length };
}

/** The text with every fold closed (`folded` true) or open; the same text
 *  when every one is that way already. */
export function setSourceFolded(text: string, folded: boolean): string {
  const lines = text.split('\n');
  let changed = false;
  for (const spot of spots(lines)) {
    if (spot.folded === folded) continue;
    lines[spot.line] = spot.set(folded);
    changed = true;
  }
  return changed ? lines.join('\n') : text;
}
