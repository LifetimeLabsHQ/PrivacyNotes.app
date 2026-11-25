/**
 * Collapse all and Expand all for one note (GitHub #779): every fold in the
 * note closes or opens in one step. Three kinds of fold count:
 *
 * - callouts (Fold, Box, Panel and the colored types) and code blocks, whose
 *   `folded` attribute is saved in the Markdown, so the change is one undo
 *   step;
 * - heading and list folds (editorFolds.ts, #727), a view state of this
 *   device that never enters the Markdown or the undo history.
 *
 * A Kanban board and its columns never fold, and a copy box never closes
 * (editorCodeBlock.ts), so none of them counts. The long-block fold of a code
 * block (FOLD_MIN_LINES in editorCodeBlock.ts) is a view state of its own
 * and is not touched.
 * Spec: docs/contrib/callouts.md (Fold control)
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import { Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { isBoard, isColumn } from './kanban';
import { COPY_BOX_LANGUAGE } from './editorCodeBlock';
import { foldablesOf, foldCounts, setAllFolded as setAllViewFolds } from './editorFolds';

export type FoldSummary = { foldable: number; open: number };

function foldable(node: PMNode): boolean {
  if (node.type.name === 'callout') return !isBoard(node) && !isColumn(node);
  if (node.type.name === 'codeBlock') return node.attrs['language'] !== COPY_BOX_LANGUAGE;
  return false;
}

// The toolbar asks on every transaction, so a doc or unchanged child block it
// already counted is free.
const ZERO_SUMMARY: FoldSummary = { foldable: 0, open: 0 };
const blockSummaries = new WeakMap<PMNode, FoldSummary>();

function nodeSummary(node: PMNode): FoldSummary {
  if (node.isTextblock && node.type.name !== 'codeBlock') return ZERO_SUMMARY;
  const known = blockSummaries.get(node);
  if (known) return known;
  let count = 0;
  let open = 0;
  if (foldable(node)) {
    count++;
    if (!node.attrs['folded']) open++;
  }
  if (!node.isTextblock) {
    node.forEach((child) => {
      const sub = nodeSummary(child);
      count += sub.foldable;
      open += sub.open;
    });
  }
  const summary = count === 0 ? ZERO_SUMMARY : { foldable: count, open };
  blockSummaries.set(node, summary);
  return summary;
}

/** The callouts and code blocks of a doc. */
function blockSummary(doc: PMNode): FoldSummary {
  const known = blockSummaries.get(doc);
  if (known) return known;
  let count = 0;
  let open = 0;
  doc.forEach((child) => {
    const sub = nodeSummary(child);
    count += sub.foldable;
    open += sub.open;
  });
  const summary = count === 0 ? ZERO_SUMMARY : { foldable: count, open };
  blockSummaries.set(doc, summary);
  return summary;
}

/** How many places in the note can fold, and how many of them are open. */
export function foldSummary(state: EditorState): FoldSummary {
  const blocks = blockSummary(state.doc);
  const view = foldCounts(state);
  return { foldable: blocks.foldable + view.foldable, open: blocks.open + view.foldable - view.folded };
}

/** A place the fold hides, and where the caret goes instead. */
type Hidden = { from: number; to: number; caret: (doc: PMNode) => Selection };

/**
 * Where the caret goes when a fold hides it: out of the outermost hidden
 * place that holds it. A callout sends it to the end of its title, a code
 * block to the nearest text outside it, a heading or a list item to the end
 * of its own line. Null when the caret stays visible.
 */
function visibleCaret(tr: Transaction, viewFolds: boolean): Selection | null {
  const head = tr.selection.head;
  const $head = tr.doc.resolve(head);
  const hidden: Hidden[] = [];
  for (let depth = 1; depth <= $head.depth; depth++) {
    const node = $head.node(depth);
    if (!foldable(node) || !node.attrs['folded']) continue;
    const start = $head.before(depth);
    if (node.type.name === 'callout') {
      // Inside the title the caret stays where it is.
      if ($head.index(depth) === 0) continue;
      const title = node.firstChild;
      const titleEnd = start + 1 + (title ? title.nodeSize - 1 : 0);
      hidden.push({ from: start, to: start + node.nodeSize, caret: (doc) => TextSelection.create(doc, titleEnd) });
    } else {
      hidden.push({
        from: start,
        to: start + node.nodeSize,
        caret: (doc) => {
          const before = Selection.near(doc.resolve(start), -1);
          return before.$head.pos <= start ? before : Selection.near(doc.resolve(start + node.nodeSize), 1);
        },
      });
    }
  }
  // Only where the fold plugin runs (not in the history preview).
  for (const f of viewFolds ? foldablesOf(tr.doc) : []) {
    // The same test as editorFolds.ts: the first hidden block's start in, the end out.
    if (head < f.hidden.from || head >= f.hidden.to) continue;
    // `line.to` is after the line's node; its text ends one before.
    hidden.push({ from: f.line.from, to: f.hidden.to, caret: (doc) => TextSelection.create(doc, f.line.to - 1) });
  }
  if (hidden.length === 0) return null;
  // The outermost place starts first; on a tie, it ends last.
  hidden.sort((a, b) => a.from - b.from || b.to - a.to);
  return hidden[0]!.caret(tr.doc);
}

/** One transaction that closes (`folded` true) or opens every fold in the
 *  note, or null when every fold is already that way. */
export function setAllFolded(state: EditorState, folded: boolean): Transaction | null {
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (foldable(node) && !!node.attrs['folded'] !== folded) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, folded });
    }
    return !node.isTextblock;
  });
  const view = foldCounts(state);
  const viewChanges = view.foldable > 0 && view.folded !== (folded ? view.foldable : 0);
  if (!tr.docChanged && !viewChanges) return null;
  if (viewChanges) setAllViewFolds(tr, folded);
  if (folded) {
    const caret = visibleCaret(tr, view.foldable > 0);
    if (caret) tr.setSelection(caret);
  }
  return tr;
}
