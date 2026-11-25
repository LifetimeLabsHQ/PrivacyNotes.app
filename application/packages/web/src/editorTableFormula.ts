import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState, Selection, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { TableMap } from '@tiptap/pm/tables';
import { activeLocale } from './i18n';
import { blockContains, touchesTopBlock } from './editorDirection';
import { evaluateTable, formatFormulaValue, isFormulaText } from './tableFormula';

/**
 * Draw the result of a table formula over the formula itself.
 *
 * Nothing here touches the document. The cell's text stays `=SUM(B2:B7)` from
 * the moment it is typed to the moment it is saved; a decoration hides that
 * text and a widget paints the number in its place. That is what makes the
 * feature free of a migration, free of a schema change, and impossible to
 * lose: there is no second copy of the formula to fall out of step, and a
 * reader whose app has never heard of this sees the formula rather than a
 * stale number.
 *
 * Click-to-edit needs no machinery at all, which is the point of keeping the
 * formula in plain text. A cell the selection is inside is simply not
 * decorated, so the caret lands on the source the user typed and the number
 * comes back when the caret leaves. The inline-math node has the opposite
 * problem (backlog #136: its source re-renders only on a remount) precisely
 * because it swaps a node for text and needs an input rule to swap it back.
 *
 * Spec: docs/internal/specs/table-formulas.md
 */

type FormulaEntry = { relFrom: number; relTo: number; source: string; shown: string };
type FormulaTarget = { from: number; to: number; source: string; shown: string };
type FormulaState = {
  targets: FormulaTarget[];
  /** Indices of targets currently uncovered by the caret/selection. */
  editing: string;
  locale: string;
  decorations: DecorationSet;
};

const formulaKey = new PluginKey<FormulaState>('tableFormula');

/** One cell we can both evaluate and draw over, in table-relative coordinates. */
type Target = { relFrom: number; relTo: number; row: number; col: number; text: string };

const hasTable = (node: ProseMirrorNode) => blockContains(node, (n) => n.type.name === 'table');

/**
 * The text range of a cell, when the cell is simple enough to paint over.
 *
 * Only a cell holding exactly one paragraph of exactly one text node
 * qualifies. A cell carrying a mark, an image, a note-link or a second
 * paragraph is left alone: the position arithmetic below assumes the plain
 * shape, and a formula is plain text by definition, so nothing a user would
 * want computed is excluded by the rule.
 */
function plainTextRange(cell: ProseMirrorNode, cellRelPos: number): { relFrom: number; relTo: number; text: string } | null {
  if (cell.childCount !== 1) return null;
  const paragraph = cell.firstChild;
  if (!paragraph || paragraph.type.name !== 'paragraph' || paragraph.childCount !== 1) return null;
  const text = paragraph.firstChild;
  if (!text?.isText || text.marks.length) return null;
  // cellRelPos is relative to the table's start: +1 enters the table, +1 enters
  // the cell, +1 enters the paragraph, and the text starts there.
  const relFrom = cellRelPos + 3;
  const raw = text.text ?? '';
  return { relFrom, relTo: relFrom + raw.length, text: raw };
}

/** Every formula cell of one table, with the grid it must be evaluated against. */
function tableTargets(table: ProseMirrorNode): { grid: string[][]; targets: Target[] } {
  const map = TableMap.get(table);
  const grid: string[][] = [];
  const targets: Target[] = [];
  // A merged cell appears at every coordinate it covers, so the same text is
  // read more than once. That is right for the grid, where a reference to any
  // covered coordinate should find it, and wrong for the decorations, where it
  // would paint the cell twice.
  const painted = new Set<number>();
  for (let row = 0; row < map.height; row++) {
    const cells: string[] = [];
    for (let col = 0; col < map.width; col++) {
      const cellPos = map.map[row * map.width + col];
      const cell = cellPos === undefined ? null : table.nodeAt(cellPos);
      if (cellPos === undefined || !cell) {
        cells.push('');
        continue;
      }
      cells.push(cell.textContent);
      const range = plainTextRange(cell, cellPos);
      if (!range || !isFormulaText(range.text) || painted.has(cellPos)) continue;
      painted.add(cellPos);
      targets.push({ relFrom: range.relFrom, relTo: range.relTo, row, col, text: range.text });
    }
    grid.push(cells);
  }
  return { grid, targets };
}

/** Per immutable table node: evaluated formula entries, cached across edits
 *  elsewhere in the document. */
const tableFormulaCache = new WeakMap<ProseMirrorNode, { locale: string; entries: FormulaEntry[] }>();

function entriesOf(table: ProseMirrorNode, locale: string): FormulaEntry[] {
  const hit = tableFormulaCache.get(table);
  if (hit && hit.locale === locale) return hit.entries;
  const { grid, targets } = tableTargets(table);
  const entries: FormulaEntry[] = [];
  if (targets.length) {
    const results = evaluateTable(grid);
    for (const target of targets) {
      const result = results[target.row]?.[target.col];
      // A formula that cannot produce a number is drawn as the text the
      // user typed. One failure mode, and it is the same thing a reader
      // without the feature sees.
      if (!result || 'error' in result) continue;
      entries.push({
        relFrom: target.relFrom,
        relTo: target.relTo,
        source: target.text,
        shown: formatFormulaValue(result.value, locale),
      });
    }
  }
  tableFormulaCache.set(table, { locale, entries });
  return entries;
}

/**
 * The span that carries the number.
 *
 * It has to handle its own mousedown. The span is `contenteditable=false`, so
 * a click landing ON it never reaches the text underneath and ProseMirror
 * leaves the selection where it was: the cell looked inert, and the formula
 * appeared only when the click happened to land PAST the number, in the
 * cell's empty space, where the caret could reach the hidden text by itself.
 * So the widget puts the caret at the end of the formula, which is both what
 * a click on a total should do and where a person wants to start editing.
 */
function valueWidget(view: EditorView, getPos: () => number | undefined, shown: string, source: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'pn-formula-value';
  span.textContent = shown;
  // The formula itself, so hovering a total says where the number came from.
  // It is the user's own text, never a translated string.
  span.title = source;
  span.contentEditable = 'false';
  span.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const from = getPos();
    // The decoration can be gone by the time a click lands on it.
    if (from === undefined) return;
    const end = Math.min(from + source.length, view.state.doc.content.size);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    view.focus();
  });
  return span;
}

function editingSignature(targets: readonly FormulaTarget[], selection: Selection): string {
  if (!targets.length) return '';
  const { from: selFrom, to: selTo } = selection;
  let sig = '';
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    if (selFrom <= t.to + 1 && selTo >= t.from - 1) sig += `${i},`;
  }
  return sig;
}

function decorationsFor(doc: ProseMirrorNode, targets: readonly FormulaTarget[], selection: Selection): DecorationSet {
  if (!targets.length) return DecorationSet.empty;
  const { from: selFrom, to: selTo } = selection;
  const decorations: Decoration[] = [];
  for (const target of targets) {
    // The caret inside the cell means the user is editing: show the
    // source. One position of slack at each end so a click landing on the
    // cell boundary opens it rather than looking inert.
    if (selFrom <= target.to + 1 && selTo >= target.from - 1) continue;
    decorations.push(Decoration.inline(target.from, target.to, { class: 'pn-formula-src' }));
    decorations.push(
      Decoration.widget(target.from, (view, getPos) => valueWidget(view, getPos, target.shown, target.source), {
        side: -1,
        ignoreSelection: true,
      }),
    );
  }
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function buildState(state: EditorState): FormulaState {
  const locale = activeLocale();
  const targets: FormulaTarget[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') {
      // Never walk into inline content: a table cannot live inside a
      // paragraph, and the text nodes of a long note are the bulk of the tree.
      return !node.inlineContent;
    }
    for (const entry of entriesOf(node, locale)) {
      targets.push({ from: pos + entry.relFrom, to: pos + entry.relTo, source: entry.source, shown: entry.shown });
    }
    return false;
  });
  const editing = editingSignature(targets, state.selection);
  return { targets, editing, locale, decorations: decorationsFor(state.doc, targets, state.selection) };
}

function applyState(tr: Transaction, prev: FormulaState, newState: EditorState): FormulaState {
  if (!tr.docChanged && !tr.selectionSet) return prev;
  const locale = activeLocale();
  if (locale !== prev.locale) return buildState(newState);
  if (!tr.docChanged) {
    if (!prev.targets.length) return prev;
    const editing = editingSignature(prev.targets, newState.selection);
    if (editing === prev.editing) return prev;
    return { ...prev, editing, decorations: decorationsFor(newState.doc, prev.targets, newState.selection) };
  }
  if (!touchesTopBlock(tr, hasTable)) {
    if (!prev.targets.length) return prev;
    const targets = prev.targets.map((t) => ({
      ...t,
      from: tr.mapping.map(t.from, 1),
      to: tr.mapping.map(t.to, 1),
    }));
    const editing = editingSignature(targets, newState.selection);
    const decorations = editing === prev.editing
      ? prev.decorations.map(tr.mapping, newState.doc)
      : decorationsFor(newState.doc, targets, newState.selection);
    return { targets, editing, locale, decorations };
  }
  return buildState(newState);
}

/**
 * The plugin.
 *
 * It asks nothing about Pro, and that is deliberate: the result of a formula
 * is drawn for every account. The formula is plain text in the person's own
 * file, so a gate here would mean a free account's note showed `=SUM(B2:B4)`
 * in the app and `1,575` in its own PDF, because the export renderer has no
 * account to ask. What Pro buys is the menu that writes the formula for you
 * (FormulaSuggestion.tsx and the table toolbar button), not the arithmetic.
 */
export function tableFormulaPlugin(): Plugin<FormulaState> {
  return new Plugin<FormulaState>({
    key: formulaKey,
    state: {
      init: (_config, state) => buildState(state),
      apply: (tr, value, _old, newState) => applyState(tr, value, newState),
    },
    props: {
      /**
       * `undefined` rather than an empty set when there is nothing to draw,
       * which is most documents: a note with no table has no formulas.
       *
       * It is not only tidier. ProseMirror keeps every source that returns a
       * set and, past one source, merges them with an `instanceof` check. A
       * test runner that loads prosemirror-view twice (an ESM copy for our
       * modules, a CJS copy inside the view) fails that check for EVERY
       * source and merges them into undefined, so one extra source turned 81
       * unrelated editor tests red. Returning nothing keeps this plugin out
       * of the merge entirely unless it has something to say.
       */
      decorations(state) {
        const set = formulaKey.getState(state)?.decorations;
        return set && set !== DecorationSet.empty ? set : undefined;
      },
    },
  });
}
