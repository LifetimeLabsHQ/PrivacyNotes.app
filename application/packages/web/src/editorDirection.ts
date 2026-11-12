/**
 * Direction for the blocks whose marks sit at the start of the line: lists
 * (the bullet, the number), tasks (the checkbox), quotes (the bar),
 * callouts (the icon and the fold caret) and the footnotes (their numbers).
 *
 * `unicode-bidi: plaintext` (index.css) turns each paragraph the way its own
 * text reads, but it does not move what the block draws beside the text:
 * that follows the block's `direction`, which came from the app language. So
 * a Persian list in an English app had right-aligned text and its bullets,
 * numbers and checkboxes still on the left (GitHub #725). This plugin gives
 * each such block a `dir` from its own first letter (textDirection.ts).
 *
 * Decorations only: nothing is stored, and the markdown does not change. A
 * block with no letter yet (a new, empty list) gets no `dir` and follows the
 * app language until the first letter is typed. An ordered list in Arabic
 * script that writes Persian also counts in Persian digits (`listNumerals`,
 * `data-numerals` in index.css).
 *
 * An edit recomputes only the top-level blocks it touched: a full pass over
 * a note of 2,000 short lists took 10 ms, on every key. A full pass runs
 * only when the note starts or stops writing Persian, which changes the
 * digits of lists the edit did not touch.
 * Spec: docs/internal/design/patterns/061-070.md (section 67)
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { firstLetter, letterDirection, listNumerals, writesPersian } from './textDirection';

// A task item turns on its own as well: it is a row with no list gutter, so
// an English task in a Persian checklist keeps its checkbox beside its text.
// A bullet or number keeps the list's side, which its gutter is on.
const DIRECTED = new Set(['bulletList', 'orderedList', 'taskList', 'taskItem', 'blockquote', 'callout', 'footnotes']);

/**
 * The first letter of a block's text. Code does not count: it is always
 * shown left-to-right and isolated (index.css), so the paragraph's own
 * direction skips it too.
 */
function firstLetterIn(node: PMNode): string | null {
  if (node.isText) {
    return node.marks.some((m) => m.type.name === 'code') ? null : firstLetter(node.text ?? '');
  }
  if (node.type.name === 'codeBlock') return null;
  for (let i = 0; i < node.childCount; i++) {
    const letter = firstLetterIn(node.child(i));
    if (letter) return letter;
  }
  return null;
}

function notePersian(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.isText && writesPersian(node.text ?? '')) found = true;
    return !found;
  });
  return found;
}

/**
 * `persian` is null until a list needed it: most notes never pay for the
 * scan, and a note that never asked has no digits to change when it flips.
 */
type DirectionState = { decorations: DecorationSet; persian: boolean | null };

/** The decorations for one node and everything inside it, at `base`. */
function decorate(node: PMNode, base: number, out: Decoration[], isPersian: () => boolean): void {
  const visit = (child: PMNode, pos: number): boolean => {
    // No block that takes a direction lives inside a paragraph or an atom.
    if (child.isTextblock || child.isAtom) return false;
    if (!DIRECTED.has(child.type.name)) return true;
    const letter = firstLetterIn(child);
    if (!letter) return true;
    const dir = letterDirection(letter);
    const attrs: Record<string, string> = { dir };
    if (child.type.name === 'orderedList' && dir === 'rtl' && listNumerals(letter, () => child.textContent, isPersian)) {
      attrs['data-numerals'] = 'persian';
    }
    out.push(Decoration.node(pos, pos + child.nodeSize, attrs));
    return true;
  };
  if (visit(node, base)) node.descendants((child, pos) => visit(child, base + 1 + pos));
}

function build(doc: PMNode): DirectionState {
  const out: Decoration[] = [];
  let persian: boolean | null = null;
  const isPersian = () => (persian ??= notePersian(doc));
  doc.forEach((node, offset) => decorate(node, offset, out, isPersian));
  return { decorations: DecorationSet.create(doc, out), persian };
}

/** The top-level blocks an edit touched, by their start in the new document. */
function touchedBlocks(tr: Transaction): Map<number, PMNode> {
  const doc = tr.doc;
  const touched = new Map<number, PMNode>();
  tr.steps.forEach((step, index) => {
    const rest = tr.mapping.slice(index + 1);
    const ranges: [number, number][] = [];
    tr.mapping.maps[index]?.forEach((_oldStart, _oldEnd, newStart, newEnd) => ranges.push([newStart, newEnd]));
    // A mark or attribute step moves nothing, so its map is empty, yet
    // inline code changes which letter comes first: take its own range.
    if (!ranges.length) {
      const { from, to, pos } = step as { from?: number; to?: number; pos?: number };
      if (typeof from === 'number') ranges.push([from, to ?? from]);
      else if (typeof pos === 'number') ranges.push([pos, pos]);
    }
    for (const [start, end] of ranges) {
      // One position wider on each side: a join or a split changes the
      // block on the other side of the boundary too.
      const from = Math.max(0, rest.map(start, -1) - 1);
      const to = Math.min(doc.content.size, rest.map(end, 1) + 1);
      doc.nodesBetween(from, to, (node, pos) => {
        touched.set(pos, node);
        return false;
      });
    }
  });
  return touched;
}

function update(tr: Transaction, state: DirectionState): DirectionState {
  if (!tr.docChanged) return state;
  if (state.persian !== null && notePersian(tr.doc) !== state.persian) return build(tr.doc);
  let persian = state.persian;
  const isPersian = () => (persian ??= notePersian(tr.doc));
  let decorations = state.decorations.map(tr.mapping, tr.doc);
  const added: Decoration[] = [];
  for (const [pos, node] of touchedBlocks(tr)) {
    const end = pos + node.nodeSize;
    // find() also returns a neighbour's decoration that only touches this
    // block's edge; that one stays.
    decorations = decorations.remove(decorations.find(pos, end).filter((d) => d.from >= pos && d.to <= end));
    decorate(node, pos, added, isPersian);
  }
  // In document order: add() given an unsorted list dropped a decoration
  // from a set that already held others (prosemirror-view 1.42).
  added.sort((a, b) => a.from - b.from);
  return { decorations: decorations.add(tr.doc, added), persian };
}

const directionKey = new PluginKey<DirectionState>('blockDirection');

export const BlockDirection = Extension.create({
  name: 'blockDirection',

  addProseMirrorPlugins() {
    return [
      new Plugin<DirectionState>({
        key: directionKey,
        state: {
          init: (_config, state) => build(state.doc),
          apply: (tr, current) => update(tr, current),
        },
        props: {
          decorations: (state) => directionKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});

/** The full pass, for the tests. */
export function directionDecorations(doc: PMNode): DecorationSet {
  return build(doc).decorations;
}
