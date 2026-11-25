/**
 * Side-by-side borderless columns inside a note (GitHub #647).
 *
 * Stored as nested Obsidian callouts so copy, paste, export, importers,
 * Markdown folder and older clients keep every word in reading order:
 *
 *   > [!columns]+
 *   > > [!col|33]+
 *   > > First column
 *   >
 *   > > [!col|67]+
 *   > > Second column
 *
 * Equal columns omit the width suffix (`[!col]+`). Every edit here is one
 * ProseMirror transaction (one undo step) and never drops content: shrinking
 * or deleting a column appends its non-blank blocks into its neighbor.
 */

import type { Editor as TipTapEditor } from '@tiptap/core';
import type { Node as PMNode, Schema, Slice } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { commitWidths, dragWidths, effectiveWidths, mirrorEdge } from './tableColumnWidths';
import { isBlank } from './kanban';
import { formatColumnBorder, parseColumnBorder, type ColumnBorderConfig } from './columnBorders';

export const MIN_LAYOUT_COLUMNS = 2;
const MAX_LAYOUT_COLUMNS = 5;

export type ColumnPresetId = '2' | '1:2' | '2:1' | '3' | '4' | '5';

export interface ColumnPreset {
  id: ColumnPresetId;
  weights: readonly number[];
  pro: boolean;
}

export const COLUMN_PRESETS: readonly ColumnPreset[] = [
  { id: '2', weights: [50, 50], pro: false },
  { id: '1:2', weights: [33, 67], pro: false },
  { id: '2:1', weights: [67, 33], pro: false },
  { id: '3', weights: [33, 33, 34], pro: false },
  { id: '4', weights: [25, 25, 25, 25], pro: true },
  { id: '5', weights: [20, 20, 20, 20, 20], pro: true },
];

export function isColumnsBlock(node: PMNode | null | undefined): boolean {
  return !!node && node.type.name === 'columnsBlock';
}

export function isColumnsCol(node: PMNode | null | undefined): boolean {
  return !!node && node.type.name === 'columnsCol';
}

/** Parse a column width weight from `[!col|33]` metadata. */
export function parseColumnWidth(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 99 ? n : null;
}

/** Equal integer shares summing to 100 (e.g. 3 -> [33, 33, 34]). */
function equalColumnShares(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(100 / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? 100 - base * (count - 1) : base));
}

/** Normalized widths for each column in a columnsBlock (summing to 100). */
export function columnWeightsOf(block: PMNode): number[] {
  const raw: (number | null)[] = [];
  block.forEach((child) => {
    if (isColumnsCol(child)) raw.push(typeof child.attrs.width === 'number' ? child.attrs.width : null);
  });
  if (raw.length === 0) return [];
  return effectiveWidths(raw) ?? equalColumnShares(raw.length);
}

/** True when all columns have equal shares (no custom widths stored). */
export function columnsAreEqual(block: PMNode): boolean {
  const raw: (number | null)[] = [];
  block.forEach((child) => {
    if (isColumnsCol(child)) raw.push(typeof child.attrs.width === 'number' ? child.attrs.width : null);
  });
  return effectiveWidths(raw) === null;
}

/** Matching preset id for a columnsBlock, or null when custom-dragged. */
export function matchingPresetId(block: PMNode): ColumnPresetId | null {
  const weights = columnWeightsOf(block);
  const equal = columnsAreEqual(block);
  for (const preset of COLUMN_PRESETS) {
    if (preset.weights.length !== weights.length) continue;
    if (equal && effectiveWidths(preset.weights) === null) return preset.id;
    if (!equal && preset.weights.every((w, i) => w === weights[i])) return preset.id;
  }
  return null;
}

/** CSS grid-template-columns value for normalized weights (e.g. "33fr 67fr"). */
export function columnsGridTemplate(weights: readonly number[]): string {
  return weights.map((w) => `minmax(0, ${w}fr)`).join(' ');
}

/** Drag math between column `border` and `border + 1`, reusing table resize rules. */
export function dragColumnWeights(start: readonly number[], border: number, deltaPercent: number, fine = false): number[] {
  return dragWidths(start, border, deltaPercent, mirrorEdge(start, border), fine);
}

/** Final snapped weights to commit after a drag (null when equal). */
export function commitColumnWeights(weights: readonly number[], fine = false): number[] | null {
  return commitWidths(weights, fine);
}

export interface ActiveColumns {
  pos: number;
  node: PMNode;
  colIndex: number;
  colPos: number;
  /** True when the caret sits inside a table nested in a column (TableControls owns the bar). */
  inTable: boolean;
}

/** Find the active columnsBlock and active column for the current selection. */
export function activeColumnsAt(state: EditorState): ActiveColumns | null {
  const { $from } = state.selection;
  let inTable = false;
  let colDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'table') inTable = true;
    if (colDepth < 0 && name === 'columnsCol') colDepth = d;
    if (name === 'columnsBlock') {
      const node = $from.node(d);
      const pos = $from.before(d);
      const colIndex = colDepth === d + 1 ? $from.index(d) : 0;
      const colPos = colDepth === d + 1 ? $from.before(colDepth) : pos + 1;
      return { pos, node, colIndex, colPos, inTable };
    }
  }
  return null;
}

function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => out.push(child));
  return out;
}

function makeCol(schema: Schema, blocks: PMNode[], width: number | null): PMNode {
  const nonEmpty = blocks.length > 0 ? blocks : [schema.nodes.paragraph!.create()];
  return schema.nodes.columnsCol!.create({ width }, nonEmpty);
}

/** Build a columnsBlock node with the given weights. */
function makeColumnsBlock(schema: Schema, weights: readonly number[] = [50, 50]): PMNode {
  const normalized = effectiveWidths(weights);
  const cols = weights.map((_, i) => makeCol(schema, [], normalized ? normalized[i]! : null));
  return schema.nodes.columnsBlock!.create(null, cols);
}

/** True when inserting a columnsBlock is allowed here (disallowed inside columns, Kanban, or tables). */
export function canInsertColumns(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (isColumnsBlock(node) || node.type.name === 'table') return false;
    if (node.type.name === 'callout' && (node.attrs.type === 'kanban' || node.attrs.type === 'column')) return false;
  }
  return true;
}

/**
 * Mutate `tr` to insert a columnsBlock at `tr.selection`, wrapping any
 * non-empty selection into column 1 and placing the caret inside column 1.
 */
export function insertColumnsInTr(tr: Transaction, schema: Schema, weights: readonly number[] = [50, 50]): boolean {
  if (!schema.nodes.columnsBlock || !schema.nodes.columnsCol || !schema.nodes.paragraph) return false;
  const wrapped: Slice | null = tr.selection.empty ? null : tr.selection.content();
  const block = makeColumnsBlock(schema, weights);
  const from = tr.selection.from;
  const stepIndexBefore = tr.steps.length;
  if (wrapped) {
    tr.replaceRangeWith(from, tr.selection.to, block);
  } else {
    tr.replaceSelectionWith(block);
  }
  // Locate the exact inserted block range from the step map itself so
  // inserting before a heading/paragraph (where `from` shifts past the
  // inserted block) still lands the caret inside column 1.
  let searchFrom = Math.max(0, tr.mapping.map(from, -1) - 1);
  let searchTo = Math.min(tr.doc.content.size, searchFrom + block.nodeSize + 4);
  const stepMap = tr.mapping.maps[stepIndexBefore];
  if (stepMap) {
    let minStart = Infinity;
    let maxEnd = -1;
    stepMap.forEach((_os, _oe, newStart, newEnd) => {
      if (newStart < minStart) minStart = newStart;
      if (newEnd > maxEnd) maxEnd = newEnd;
    });
    if (maxEnd >= 0) {
      searchFrom = Math.max(0, minStart);
      searchTo = Math.min(tr.doc.content.size, maxEnd);
    }
  }
  let firstColPos = -1;
  tr.doc.nodesBetween(searchFrom, searchTo, (node, pos) => {
    if (firstColPos < 0 && isColumnsCol(node)) {
      firstColPos = pos + 1;
      return false;
    }
    return firstColPos < 0;
  });
  if (firstColPos >= 0) {
    // Place caret inside column 1's empty paragraph, then let replaceSelection fit wrapped content.
    tr.setSelection(TextSelection.near(tr.doc.resolve(firstColPos + 1)));
    if (wrapped) {
      tr.replaceSelection(wrapped);
    }
  }
  tr.scrollIntoView();
  return true;
}

/**
 * Run a structural column edit in its own isolated undo step so Undo never
 * merges a preset/resize/reorder/unwrap click with typing right before or after it.
 */
export function dispatchColumnEdit(view: EditorView, mutate: (tr: Transaction) => boolean): boolean {
  if (!view.editable) return false;
  const probe = view.state.tr;
  if (!mutate(probe) || !probe.docChanged) return false;
  // Seal any recent typing into its own undo group first, then commit and seal this edit.
  view.dispatch(closeHistory(view.state.tr));
  const tr = view.state.tr;
  if (!mutate(tr) || !tr.docChanged) return false;
  view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/**
 * Insert a 2-column block where the caret is. If text is selected, wraps the
 * selection cleanly into column 1 through ProseMirror's fitter so partial
 * selections across lists/headings never throw and never lose content.
 */
export function insertColumnsBlock(editor: TipTapEditor, weights: readonly number[] = [50, 50]): boolean {
  if (!editor.isEditable || !canInsertColumns(editor.state)) return false;
  const ok = dispatchColumnEdit(editor.view, (tr) => insertColumnsInTr(tr, editor.state.schema, weights));
  if (ok) editor.commands.focus();
  return ok;
}

function blockAt(tr: Transaction, pos: number): PMNode | null {
  const node = tr.doc.nodeAt(pos);
  return isColumnsBlock(node) ? node : null;
}

/** Non-blank blocks of a column, preserving all real content when merging. */
function meaningfulBlocks(col: PMNode): PMNode[] {
  return childrenOf(col).filter((b) => !isBlank(b));
}

/** Apply a layout preset (change column count and widths) in one transaction. */
export function applyColumnPreset(tr: Transaction, blockPos: number, weights: readonly number[]): boolean {
  const block = blockAt(tr, blockPos);
  if (!block) return false;
  const schema = block.type.schema;
  const cols = childrenOf(block).filter(isColumnsCol);
  const target = weights.length;
  if (target < MIN_LAYOUT_COLUMNS || target > MAX_LAYOUT_COLUMNS) return false;
  const normalized = effectiveWidths(weights);
  const nextCols: PMNode[] = [];

  if (target >= cols.length) {
    for (let i = 0; i < target; i++) {
      const width = normalized ? normalized[i]! : null;
      if (i < cols.length) {
        nextCols.push(cols[i]!.type.create({ ...cols[i]!.attrs, width }, cols[i]!.content));
      } else {
        nextCols.push(makeCol(schema, [], width));
      }
    }
  } else {
    // Shrink: merge non-blank content of dropped trailing columns into the last kept column.
    const overflow: PMNode[] = [];
    for (let i = target; i < cols.length; i++) overflow.push(...meaningfulBlocks(cols[i]!));
    for (let i = 0; i < target; i++) {
      const width = normalized ? normalized[i]! : null;
      if (i === target - 1 && overflow.length > 0) {
        const kept = meaningfulBlocks(cols[i]!);
        nextCols.push(makeCol(schema, [...kept, ...overflow], width));
      } else {
        nextCols.push(cols[i]!.type.create({ ...cols[i]!.attrs, width }, cols[i]!.content));
      }
    }
  }

  const next = block.type.create(block.attrs, nextCols);
  const prevCaret = tr.selection.head;
  tr.replaceWith(blockPos, blockPos + block.nodeSize, next);
  const clamped = Math.max(blockPos + 2, Math.min(prevCaret, blockPos + next.nodeSize - 2));
  // Bias -1 so shrinking when the caret was in a dropped trailing column keeps it inside the last kept column.
  tr.setSelection(TextSelection.near(tr.doc.resolve(clamped), -1));
  return true;
}

/** Set column widths (null clears to equal shares) in one transaction. */
export function setColumnWidths(tr: Transaction, blockPos: number, widths: readonly number[] | null): boolean {
  const block = blockAt(tr, blockPos);
  if (!block) return false;
  const normalized = widths ? effectiveWidths(widths) : null;
  let offset = blockPos + 1;
  let idx = 0;
  let changed = false;
  block.forEach((child) => {
    if (isColumnsCol(child)) {
      const nextWidth = normalized ? normalized[idx] ?? null : null;
      if (child.attrs.width !== nextWidth) {
        tr.setNodeMarkup(offset, undefined, { ...child.attrs, width: nextWidth });
        changed = true;
      }
      idx++;
    }
    offset += child.nodeSize;
  });
  return changed;
}

/** Normalized border settings for a columnsBlock. */
export function columnBorderOf(block: PMNode): ColumnBorderConfig {
  return parseColumnBorder(typeof block.attrs.border === 'string' ? block.attrs.border : null);
}

/** Update a columnsBlock's border settings in one transaction. */
export function setColumnBorder(tr: Transaction, blockPos: number, next: ColumnBorderConfig): boolean {
  const block = blockAt(tr, blockPos);
  if (!block) return false;
  const serialized = formatColumnBorder(next);
  const current = typeof block.attrs.border === 'string' && block.attrs.border ? block.attrs.border : null;
  if (current === serialized) return false;
  tr.setNodeMarkup(blockPos, undefined, { ...block.attrs, border: serialized });
  return true;
}

/** Swap column `index` with `index + dir` and keep the caret inside the moved column. */
export function moveColumn(tr: Transaction, blockPos: number, index: number, dir: -1 | 1): boolean {
  const block = blockAt(tr, blockPos);
  if (!block) return false;
  const cols = childrenOf(block).filter(isColumnsCol);
  const to = index + dir;
  if (index < 0 || index >= cols.length || to < 0 || to >= cols.length) return false;

  // Record caret offset relative to the moved column so typing continues smoothly.
  let oldColStart = blockPos + 1;
  for (let i = 0; i < index; i++) oldColStart += cols[i]!.nodeSize;
  const relOffset = Math.max(1, Math.min(tr.selection.head - oldColStart, cols[index]!.nodeSize - 1));

  const next = cols.slice();
  [next[index], next[to]] = [next[to]!, next[index]!];
  const rebuilt = block.type.create(block.attrs, next);
  tr.replaceWith(blockPos, blockPos + block.nodeSize, rebuilt);

  let newColStart = blockPos + 1;
  for (let i = 0; i < to; i++) newColStart += next[i]!.nodeSize;
  const targetPos = Math.min(newColStart + relOffset, newColStart + next[to]!.nodeSize - 1);
  tr.setSelection(TextSelection.near(tr.doc.resolve(targetPos), -1));
  return true;
}

/** Delete column `index`, merging its non-blank content into its neighbor. Refused at MIN_LAYOUT_COLUMNS. */
export function deleteColumn(tr: Transaction, blockPos: number, index: number): boolean {
  const block = blockAt(tr, blockPos);
  if (!block) return false;
  const cols = childrenOf(block).filter(isColumnsCol);
  if (cols.length <= MIN_LAYOUT_COLUMNS || index < 0 || index >= cols.length) return false;
  const schema = block.type.schema;
  const gone = cols[index]!;
  const into = index > 0 ? index - 1 : 1;
  const moved = meaningfulBlocks(gone);
  const target = cols[into]!;
  const merged = index > 0 ? [...meaningfulBlocks(target), ...moved] : [...moved, ...meaningfulBlocks(target)];
  const remaining = cols
    .map((c, i) => (i === into ? makeCol(schema, merged, null) : c.type.create({ ...c.attrs, width: null }, c.content)))
    .filter((_, i) => i !== index);

  const rebuilt = block.type.create(block.attrs, remaining);
  tr.replaceWith(blockPos, blockPos + block.nodeSize, rebuilt);
  const targetIndex = index > 0 ? into : 0;
  let targetStart = blockPos + 1;
  for (let i = 0; i < targetIndex; i++) targetStart += remaining[i]!.nodeSize;
  tr.setSelection(TextSelection.near(tr.doc.resolve(targetStart + 1)));
  return true;
}

/** Dissolve the columns block back into sequential top-level blocks, keeping every word. */
export function unwrapColumns(tr: Transaction, blockPos: number): boolean {
  const block = blockAt(tr, blockPos);
  if (!block) return false;
  const schema = block.type.schema;
  const out: PMNode[] = [];
  block.forEach((child) => {
    if (isColumnsCol(child)) out.push(...meaningfulBlocks(child));
    else out.push(child);
  });
  if (out.length === 0) out.push(schema.nodes.paragraph!.create());
  tr.replaceWith(blockPos, blockPos + block.nodeSize, out);
  tr.setSelection(TextSelection.near(tr.doc.resolve(blockPos + 1)));
  return true;
}

/** Unwrap columnsBlock nodes that sit inside forbidden parents (columns, Kanban, tables) or hold < 2 columns. */
function unwrapNestedColumns(state: EditorState): Transaction | null {
  const nested: { from: number; to: number; replacement: PMNode[] }[] = [];
  const isForbiddenParent = (node: PMNode) =>
    isColumnsBlock(node) ||
    node.type.name === 'table' ||
    (node.type.name === 'callout' && (node.attrs.type === 'kanban' || node.attrs.type === 'column'));
  const walk = (node: PMNode, pos: number, insideForbidden: boolean) => {
    if (isColumnsBlock(node) && (insideForbidden || node.childCount < MIN_LAYOUT_COLUMNS)) {
      const blocks: PMNode[] = [];
      node.forEach((child) => {
        if (isColumnsCol(child)) blocks.push(...meaningfulBlocks(child));
        else blocks.push(child);
      });
      if (blocks.length === 0) blocks.push(state.schema.nodes.paragraph!.create());
      nested.push({ from: pos, to: pos + node.nodeSize, replacement: blocks });
      return;
    }
    if (node.isTextblock) return;
    const nextInside = insideForbidden || isForbiddenParent(node);
    let offset = pos + 1;
    node.forEach((child) => {
      walk(child, offset, nextInside);
      offset += child.nodeSize;
    });
  };
  let topOffset = 0;
  state.doc.forEach((child) => {
    walk(child, topOffset, false);
    topOffset += child.nodeSize;
  });
  if (nested.length === 0) return null;
  const tr = state.tr;
  for (const item of nested.reverse()) {
    tr.replaceWith(item.from, item.to, item.replacement);
  }
  return tr;
}

interface CrossColumnSpan {
  blockPos: number;
  block: PMNode;
  startCol: number;
  endCol: number;
  from: number;
  to: number;
}

/** Non-null when a range selection starts in one column and ends in a later column of the same block. */
function crossColumnSpan(state: EditorState): CrossColumnSpan | null {
  const { selection } = state;
  if (selection.empty) return null;
  const { $from, $to } = selection;
  let blockDepth = -1;
  let startColDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (startColDepth < 0 && name === 'columnsCol') startColDepth = d;
    if (name === 'columnsBlock') {
      blockDepth = d;
      break;
    }
  }
  if (blockDepth < 1 || startColDepth !== blockDepth + 1) return null;
  const blockPos = $from.before(blockDepth);
  let endColDepth = -1;
  for (let d = $to.depth; d > 0; d--) {
    const name = $to.node(d).type.name;
    if (endColDepth < 0 && name === 'columnsCol') endColDepth = d;
    if (name === 'columnsBlock') {
      if ($to.before(d) !== blockPos || endColDepth !== d + 1) return null;
      const startCol = $from.index(blockDepth);
      const endCol = $to.index(d);
      if (startCol >= endCol) return null;
      return { blockPos, block: $from.node(blockDepth), startCol, endCol, from: selection.from, to: selection.to };
    }
  }
  return null;
}

/**
 * Clear a selection that spans multiple columns inside each column separately
 * so Backspace, Delete, or typing never merges two columnsCol nodes and never
 * collapses the columnsBlock.
 */
function clearCrossColumnSpan(view: EditorView, span: CrossColumnSpan, insertText?: string): boolean {
  const { state } = view;
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return false;
  const cols: { pos: number; node: PMNode }[] = [];
  let offset = span.blockPos + 1;
  span.block.forEach((child) => {
    cols.push({ pos: offset, node: child });
    offset += child.nodeSize;
  });

  const tr = state.tr;
  // Walk backwards from endCol to startCol so earlier positions remain exact.
  for (let i = span.endCol; i >= span.startCol; i--) {
    const col = cols[i]!;
    const contentStart = col.pos + 1;
    const contentEnd = col.pos + col.node.nodeSize - 1;
    if (i === span.endCol) {
      if (span.to >= contentEnd - 1) {
        tr.replaceWith(contentStart, contentEnd, paragraph.create());
      } else if (span.to > contentStart) {
        tr.delete(contentStart, span.to);
      }
    } else if (i === span.startCol) {
      if (span.from <= contentStart + 1) {
        tr.replaceWith(contentStart, contentEnd, paragraph.create());
      } else if (span.from < contentEnd) {
        tr.delete(span.from, contentEnd);
      }
    } else {
      tr.replaceWith(contentStart, contentEnd, paragraph.create());
    }
  }

  const caretPos = Math.min(tr.mapping.map(span.from, -1), tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(caretPos)));
  if (insertText) {
    tr.insertText(insertText);
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

const columnsPluginKey = new PluginKey('pnColumns');

/**
 * Marks the active columnsBlock and active column with node decorations (no
 * React re-render per caret move), keeps cross-column deletes/typing inside
 * each column without collapsing the block, and prevents nested columns on paste.
 */
export function columnsPlugin(): Plugin {
  return new Plugin({
    key: columnsPluginKey,
    props: {
      decorations(state) {
        const active = activeColumnsAt(state);
        if (!active) return DecorationSet.empty;
        const decos: Decoration[] = [
          Decoration.node(active.pos, active.pos + active.node.nodeSize, { class: 'pn-columns-active' }),
        ];
        const col = state.doc.nodeAt(active.colPos);
        if (col && isColumnsCol(col)) {
          decos.push(Decoration.node(active.colPos, active.colPos + col.nodeSize, { class: 'pn-columns-col-active' }));
        }
        return DecorationSet.create(state.doc, decos);
      },
      handleKeyDown(view, event) {
        if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
        const span = crossColumnSpan(view.state);
        if (!span) return false;
        event.preventDefault();
        return clearCrossColumnSpan(view, span);
      },
      handleTextInput(view, _from, _to, text) {
        const span = crossColumnSpan(view.state);
        if (!span) return false;
        return clearCrossColumnSpan(view, span, text);
      },
    },
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged)) return null;
      return unwrapNestedColumns(state);
    },
  });
}
