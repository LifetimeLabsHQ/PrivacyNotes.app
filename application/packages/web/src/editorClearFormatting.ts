import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode, ResolvedPos, Schema } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { liftTarget } from '@tiptap/pm/transform';

/** Plain text of an inline atom node (note-link -> label/target, inline math -> latex). */
function plainAtomText(node: ProseMirrorNode): string {
  const attrs = node.attrs as { label?: string | null; target?: string; latex?: string };
  return (attrs.label || attrs.target || attrs.latex || '').replace(/\u00a0/g, ' ');
}

/** Plain text of a table cell, joining its textblocks with spaces. */
function plainCellText(cell: ProseMirrorNode): string {
  const parts: string[] = [];
  cell.descendants((node) => {
    if (node.isTextblock) {
      const text = node.textBetween(0, node.content.size, ' ', (leaf) =>
        leaf.type.name === 'hardBreak' ? ' ' : plainAtomText(leaf),
      ).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
      return false;
    }
    if (node.type.name === 'blockMath') {
      const latex = ((node.attrs as { latex?: string }).latex ?? '').trim();
      if (latex) parts.push(latex);
      return false;
    }
    return true;
  });
  return parts.join(' ');
}

/** Flatten a table into plain paragraphs, one per row. */
function tableToParagraphs(table: ProseMirrorNode, schema: Schema): ProseMirrorNode[] {
  const paragraph = schema.nodes['paragraph']!;
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      const text = plainCellText(cell);
      if (text) cells.push(text);
    });
    const line = cells.join(' ');
    rows.push(paragraph.create(null, line ? schema.text(line) : null));
  });
  return rows.length > 0 ? rows : [paragraph.create()];
}

/** Strip every inline mark and flatten inline atoms strictly inside [from, to]. */
function clearInlineInRange(tr: Transaction, from: number, to: number, schema: Schema): void {
  if (from >= to) return;
  tr.removeMark(from, to, null);
  const atoms: { from: number; to: number; text: string }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isInline && !node.isText && node.type.name !== 'hardBreak') {
      const end = pos + node.nodeSize;
      if (pos >= from && end <= to) atoms.push({ from: pos, to: end, text: plainAtomText(node) });
      return false;
    }
    return true;
  });
  for (let i = atoms.length - 1; i >= 0; i--) {
    const atom = atoms[i]!;
    if (atom.text) tr.replaceWith(atom.from, atom.to, schema.text(atom.text));
    else tr.delete(atom.from, atom.to);
  }
}

/** Depth of the deepest shared ancestor matching `match`, or -1. */
function sharedAncestorDepth($a: ResolvedPos, $b: ResolvedPos, match: (n: ProseMirrorNode) => boolean): number {
  const limit = Math.min($a.depth, $b.depth);
  for (let d = limit; d >= 1; d--) {
    if ($a.node(d) === $b.node(d) && match($a.node(d))) return d;
  }
  return -1;
}

/** Find the outermost callout or columnsBlock intersecting [from, to] at depth >= minDepth. */
function findWrapperInRange(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  minDepth: number,
  empty: boolean,
): { node: ProseMirrorNode; pos: number } | null {
  const isWrapper = (n: ProseMirrorNode) => n.type.name === 'callout' || n.type.name === 'columnsBlock';
  if (empty) {
    const $pos = doc.resolve(from);
    for (let d = minDepth + 1; d <= $pos.depth; d++) {
      const node = $pos.node(d);
      if (isWrapper(node)) return { node, pos: $pos.before(d) };
    }
    return null;
  }
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    const end = pos + node.nodeSize;
    if (isWrapper(node) && pos < to && end > from && doc.resolve(pos).depth >= minDepth) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

/** Replace code blocks, block math, whole tables and dividers in [from, to] with plain paragraphs (or delete dividers). */
function replaceSpecialBlocks(
  tr: Transaction,
  from: number,
  to: number,
  schema: Schema,
  minDepth: number,
  empty: boolean,
): void {
  const paragraph = schema.nodes['paragraph']!;
  const codeLines = (node: ProseMirrorNode) =>
    node.textContent.split('\n').map((line) => paragraph.create(null, line ? schema.text(line) : null));

  if (empty) {
    const $pos = tr.doc.resolve(from);
    if ($pos.parent.type.name === 'codeBlock' && $pos.depth > minDepth) {
      tr.replaceWith($pos.before(), $pos.after(), codeLines($pos.parent));
    }
    return;
  }

  type Op = { from: number; to: number; nodes: ProseMirrorNode[] | null };
  const ops: Op[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    const end = pos + node.nodeSize;
    if (tr.doc.resolve(pos).depth < minDepth) return true;
    if (node.type.name === 'codeBlock' && pos < to && end > from) {
      ops.push({ from: pos, to: end, nodes: codeLines(node) });
      return false;
    }
    if (node.type.name === 'blockMath' && pos < to && end > from) {
      const latex = ((node.attrs as { latex?: string }).latex ?? '').trim();
      ops.push({ from: pos, to: end, nodes: [paragraph.create(null, latex ? schema.text(latex) : null)] });
      return false;
    }
    if (node.type.name === 'table' && minDepth === 0 && pos >= from && end <= to) {
      ops.push({ from: pos, to: end, nodes: tableToParagraphs(node, schema) });
      return false;
    }
    if (node.type.name === 'horizontalRule' && pos >= from && end <= to) {
      ops.push({ from: pos, to: end, nodes: null });
      return false;
    }
    return true;
  });

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (op.nodes) {
      tr.replaceWith(op.from, op.to, op.nodes);
    } else {
      const $p = tr.doc.resolve(op.from);
      if ($p.parent.childCount <= 1) tr.replaceWith(op.from, op.to, paragraph.create());
      else tr.delete(op.from, op.to);
    }
  }
}

/** Clear blocks, containers, marks and inline atoms across a range inside `tr`. */
function clearRangeInTr(
  tr: Transaction,
  origFrom: number,
  origTo: number,
  schema: Schema,
  minDepth: number,
  wasEmpty: boolean,
): [number, number] {
  const paragraph = schema.nodes['paragraph']!;
  const startMapLen = tr.mapping.maps.length;
  const getRange = (): [number, number] => {
    const mapping = tr.mapping.slice(startMapLen);
    const size = tr.doc.content.size;
    if (wasEmpty) {
      const a = Math.max(0, Math.min(size, mapping.map(origFrom, -1)));
      return [a, a];
    }
    const a = Math.max(0, Math.min(size, mapping.map(origFrom, -1)));
    const b = Math.max(a, Math.min(size, mapping.map(origTo, 1)));
    return [a, b];
  };

  // 1. Strip marks and inline atoms strictly inside [origFrom, origTo].
  if (!wasEmpty) clearInlineInRange(tr, origFrom, origTo, schema);

  // 2. Unwrap callouts (including Kanban boards/columns) and columns blocks.
  for (let pass = 0; pass < 8; pass++) {
    const [from, to] = getRange();
    const target = findWrapperInRange(tr.doc, from, to, minDepth, wasEmpty);
    if (!target) break;
    const { node, pos } = target;
    const children: ProseMirrorNode[] = [];
    if (node.type.name === 'callout') {
      node.forEach((child) => {
        if (child.type.name === 'calloutTitle') {
          if (child.content.size > 0) children.push(paragraph.create(null, child.content));
        } else {
          children.push(child);
        }
      });
    } else if (node.type.name === 'columnsBlock') {
      node.forEach((col) => {
        col.forEach((child) => children.push(child));
      });
    }
    tr.replaceWith(pos, pos + node.nodeSize, children.length > 0 ? children : [paragraph.create()]);
  }

  // 3. Flatten code blocks, block math, whole tables, and dividers.
  {
    const [from, to] = getRange();
    replaceSpecialBlocks(tr, from, to, schema, minDepth, wasEmpty);
  }

  // 4. Reset headings/aligned textblocks to plain paragraphs and lift lists/blockquotes.
  {
    const [initFrom, initTo] = getRange();
    let maxSweeps = 1;
    tr.doc.nodesBetween(initFrom, initTo, (_node, pos) => {
      maxSweeps = Math.max(maxSweeps, tr.doc.resolve(pos).depth + 1);
    });
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      const docBefore = tr.doc;
      const sweepMapsLen = tr.mapping.maps.length;
      let cachedMapsLen = sweepMapsLen;
      let sweepMapping = tr.mapping.slice(sweepMapsLen);
      const [from, to] = getRange();
      docBefore.nodesBetween(from, to, (node, pos) => {
        if (node.isText) return false;
        if (tr.mapping.maps.length !== cachedMapsLen) {
          cachedMapsLen = tr.mapping.maps.length;
          sweepMapping = tr.mapping.slice(sweepMapsLen);
        }
        const mappedPos = sweepMapping.map(pos);
        const mappedEnd = sweepMapping.map(pos + node.nodeSize);
        if (mappedPos >= mappedEnd || mappedEnd > tr.doc.content.size) return;
        const $mappedFrom = tr.doc.resolve(mappedPos);
        if ($mappedFrom.depth < minDepth) return true;
        const $mappedTo = tr.doc.resolve(mappedEnd);
        const nodeRange = $mappedFrom.blockRange($mappedTo);
        if (!nodeRange) return;
        if (node.isTextblock) {
          const { defaultType } = $mappedFrom.parent.contentMatchAt($mappedFrom.index());
          const target = tr.doc.nodeAt(nodeRange.start);
          if (defaultType && target && !target.hasMarkup(defaultType) && defaultType.validContent(target.content)) {
            tr.setNodeMarkup(nodeRange.start, defaultType);
          }
        }
        const targetLiftDepth = liftTarget(nodeRange);
        if (targetLiftDepth !== null && targetLiftDepth >= minDepth) {
          tr.lift(nodeRange, targetLiftDepth);
        }
      });
      if (tr.doc.eq(docBefore)) break;
    }
  }

  return getRange();
}

/**
 * Strip all formatting from the selection down to plain text in one undoable
 * transaction: marks (including links), inline atoms (note-links and inline
 * math become their plain text), block formatting (headings, quotes, lists,
 * alignment, code blocks, callouts, columns), whole selected tables, and
 * dividers. Media and embedded blocks (images, files, doodles, maps) stay
 * untouched. With only a caret, clears stored marks and resets the current
 * block without wiping unselected text. (#973)
 */
export function clearFormatting(ed: Editor): boolean {
  if (ed.isDestroyed || !ed.isEditable) return false;
  ed.commands.focus();
  const { state } = ed;
  const { selection, schema } = state;
  const paragraph = schema.nodes['paragraph'];
  if (!paragraph) return false;

  const tr = state.tr;

  // Multi-cell table selection (CellSelection from @tiptap/pm/tables).
  const cellSel = selection as typeof selection & {
    $anchorCell?: ResolvedPos;
    forEachCell?: (f: (node: ProseMirrorNode, pos: number) => void) => void;
  };
  if (typeof cellSel.forEachCell === 'function' && cellSel.$anchorCell) {
    const cells: { node: ProseMirrorNode; pos: number }[] = [];
    cellSel.forEachCell((node, pos) => cells.push({ node, pos }));
    let tableDepth = -1;
    for (let d = cellSel.$anchorCell.depth; d >= 1; d--) {
      if (cellSel.$anchorCell.node(d).type.name === 'table') {
        tableDepth = d;
        break;
      }
    }
    if (tableDepth >= 1) {
      const tableNode = cellSel.$anchorCell.node(tableDepth);
      const tablePos = cellSel.$anchorCell.before(tableDepth);
      let totalCells = 0;
      tableNode.forEach((row) => { totalCells += row.childCount; });
      if (cells.length >= totalCells) {
        const rows = tableToParagraphs(tableNode, schema);
        tr.replaceWith(tablePos, tablePos + tableNode.nodeSize, rows);
        const endPos = tablePos + rows.reduce((sum, n) => sum + n.nodeSize, 0);
        tr.setSelection(TextSelection.between(tr.doc.resolve(tablePos), tr.doc.resolve(endPos)));
        tr.setStoredMarks([]);
        ed.view.dispatch(tr.scrollIntoView());
        return true;
      }
    }
    // Partial cell selection: clear each selected cell's contents in place.
    cells.sort((a, b) => b.pos - a.pos);
    for (const cell of cells) {
      const innerFrom = cell.pos + 1;
      const innerTo = cell.pos + cell.node.nodeSize - 1;
      const cellDepth = tr.doc.resolve(innerFrom).depth;
      clearRangeInTr(tr, innerFrom, innerTo, schema, cellDepth, false);
    }
    tr.setStoredMarks([]);
    ed.view.dispatch(tr.scrollIntoView());
    return true;
  }

  // Single selected atom / leaf node (NodeSelection).
  if (selection instanceof NodeSelection) {
    const node = selection.node;
    if (node.isInline && !node.isText && node.type.name !== 'hardBreak') {
      const plain = plainAtomText(node);
      if (plain) tr.replaceWith(selection.from, selection.to, schema.text(plain));
      else tr.delete(selection.from, selection.to);
      tr.setStoredMarks([]);
      ed.view.dispatch(tr.scrollIntoView());
      return true;
    }
    if (node.type.name === 'blockMath') {
      const latex = ((node.attrs as { latex?: string }).latex ?? '').trim();
      const next = paragraph.create(null, latex ? schema.text(latex) : null);
      tr.replaceWith(selection.from, selection.to, next);
      tr.setSelection(Selection.near(tr.doc.resolve(selection.from + 1)));
      tr.setStoredMarks([]);
      ed.view.dispatch(tr.scrollIntoView());
      return true;
    }
    if (node.type.name === 'horizontalRule') {
      const $p = tr.doc.resolve(selection.from);
      if ($p.parent.childCount <= 1) tr.replaceWith(selection.from, selection.to, paragraph.create());
      else tr.delete(selection.from, selection.to);
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(selection.from, tr.doc.content.size))));
      tr.setStoredMarks([]);
      ed.view.dispatch(tr.scrollIntoView());
      return true;
    }
    if (node.isBlock && (node.isLeaf || node.isAtom) && !node.isTextblock) {
      return false;
    }
  }

  const wasEmpty = selection.empty;
  const cellDepth = sharedAncestorDepth(
    selection.$from,
    selection.$to,
    (n) => n.type.name === 'tableCell' || n.type.name === 'tableHeader',
  );
  const minDepth = cellDepth >= 1 ? cellDepth : 0;

  const [finalFrom, finalTo] = clearRangeInTr(tr, selection.from, selection.to, schema, minDepth, wasEmpty);
  const $a = tr.doc.resolve(Math.max(0, Math.min(tr.doc.content.size, finalFrom)));
  const $b = tr.doc.resolve(Math.max(0, Math.min(tr.doc.content.size, finalTo)));
  tr.setSelection(wasEmpty || finalFrom >= finalTo ? Selection.near($a) : TextSelection.between($a, $b));
  tr.setStoredMarks([]);
  ed.view.dispatch(tr.scrollIntoView());
  return true;
}
