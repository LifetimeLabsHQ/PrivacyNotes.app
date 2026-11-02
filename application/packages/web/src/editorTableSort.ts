import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import i18n, { activeLocale } from './i18n';
import { TIP_PILL, positionClasses } from './HoverLabel';
import { isFormulaText } from './tableFormula';
import { stripToPlainText } from './notesViewUtils';

/**
 * Sort a table by a column (#636): a faint arrow at the end of each header
 * cell sorts the rows under it A to Z, and again Z to A. It moves the row
 * nodes, so a row keeps its cell colors and the note stores the new order;
 * it is one transaction, so one undo step.
 *
 * A table only gets the arrows when a sort can mean something and break
 * nothing: a header row, at least two rows under it, no merged cells, and
 * no formula, because a formula points at cells by row and a sort would
 * move what it points at.
 * Spec: docs/internal/specs/table-cell-colors.md (section Sort)
 */

const sortKey = new PluginKey<DecorationSet>('pnTableSort');

export type SortState = 'asc' | 'desc' | null;

function rowsOf(table: ProseMirrorNode): ProseMirrorNode[] {
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row));
  return rows;
}

/** The editor's own markdown for a node, or null before its serializer is set up. */
type ToMarkdown = (node: ProseMirrorNode) => string | null;

const cellTexts = new WeakMap<ProseMirrorNode, string>();

/**
 * What a cell reads as for sorting: the plain text the notes list would show
 * for it. The cell goes through the editor's own serializer and then the one
 * stripper every preview uses (`stripToPlainText`), so every syntax the
 * editor writes reads as its text: a note-link as its label or target, a
 * highlight or a colored run as its words, an escape as the character. A
 * spoiler reads as the list shows it, so a sort never tells what it hides.
 * `textContent` read every atom as nothing: a column of note-links sorted
 * as a column of empty cells. Cached per cell node, which a transaction
 * keeps when it does not touch the cell.
 */
function cellSortText(cell: ProseMirrorNode, toMarkdown: ToMarkdown): string {
  const hit = cellTexts.get(cell);
  if (hit !== undefined) return hit;
  const markdown = toMarkdown(cell);
  // Not cached: the serializer is not there yet, and the next read has it.
  if (markdown === null) return cell.textContent.trim();
  const text = markdown
    .split(/\r?\n/)
    .map(stripToPlainText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  cellTexts.set(cell, text);
  return text;
}

/** Whether the table at hand gets sort arrows (see the file note). */
export function tableIsSortable(table: ProseMirrorNode): boolean {
  const rows = rowsOf(table);
  if (rows.length < 3) return false;
  let ok = true;
  rows.forEach((row, r) => {
    row.forEach((cell) => {
      const header = cell.type.name === 'tableHeader';
      if (header !== (r === 0) || cell.attrs['colspan'] > 1 || cell.attrs['rowspan'] > 1 || isFormulaText(cell.textContent)) ok = false;
    });
  });
  return ok;
}

const decimals = new Map<string, string>();
function decimalSign(locale?: string): string {
  const key = locale ?? '';
  let sign = decimals.get(key);
  if (sign === undefined) {
    sign = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';
    decimals.set(key, sign);
  }
  return sign;
}

/**
 * A cell read as a number for sorting, or null. Wider than the formula
 * engine's `cellNumber`, which must read a cell the same way in every
 * language: a sort only has to order what a person typed, in the app
 * language. A currency sign, a percent sign, spaces, a leading plus and a
 * typographic minus are dropped. With one kind of separator, it is a
 * thousands sign when it groups exactly three digits and is not the app
 * language's decimal sign; with both, the last one is the decimal sign. A
 * date such as `30.10.2026` groups no threes, so it stays text.
 */
export function sortNumber(raw: string, locale?: string): number | null {
  let t = raw
    .replace(CURRENCY_CODE, '')
    .replace(/\p{Sc}|%|‰/gu, '')
    .replace(/[\s\u00a0\u202f']/g, '')
    .replace(/^[\u2212\u2013]/, '-')
    .replace(/^\+/, '');
  const negative = t.startsWith('-');
  if (negative) t = t.slice(1);
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
  const commas = t.split(',').length - 1;
  const dots = t.split('.').length - 1;
  let group = '';
  let decimal = '';
  if (commas && dots) {
    decimal = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.';
    group = decimal === ',' ? '.' : ',';
  } else if (commas || dots) {
    const sep = commas ? ',' : '.';
    const threes = /^\d{1,3}$/.test(t.split(sep)[0]!) && t.split(sep).slice(1).every((p) => /^\d{3}$/.test(p));
    if (commas + dots > 1 || (threes && sep !== decimalSign(locale))) group = sep;
    else decimal = sep;
  }
  if (group) {
    const whole = decimal ? t.slice(0, t.lastIndexOf(decimal)) : t;
    if (!/^\d{1,3}(?:[.,]\d{3})*$/.test(whole) || whole.includes(decimal || '\u0000')) return null;
    t = t.split(group).join('');
  }
  if (decimal) t = t.replace(decimal, '.');
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t)) return null;
  const value = Number(t) * (negative ? -1 : 1);
  return Number.isFinite(value) ? value : null;
}

/** Currency codes a price is often written with, before or after the number. */
const CURRENCY_CODE = /^(?:USD|EUR|GBP|CHF|JPY|CNY|SEK|NOK|DKK|PLN|CZK|HUF|INR|BRL|CAD|AUD|MXN|KRW|TRY|UAH)\s*|\s*(?:USD|EUR|GBP|CHF|JPY|CNY|SEK|NOK|DKK|PLN|CZK|HUF|INR|BRL|CAD|AUD|MXN|KRW|TRY|UAH)$/;

/** A cell's sort key, read once: the compare runs n log n times. */
type SortKey = { text: string; num: number | null };

function keysOf(texts: readonly string[], locale?: string): SortKey[] {
  return texts.map((t) => {
    const text = t.trim();
    return { text, num: text ? sortNumber(text, locale) : null };
  });
}

/**
 * Compare two cells: an empty cell after everything, a number before text
 * and by value, text in the app language with digits read as numbers
 * (`Item 2` before `Item 10`). `dir` flips everything but the empty rule.
 */
function compareKeys(a: SortKey, b: SortKey, dir: 1 | -1, collator: Intl.Collator): number {
  if (!a.text || !b.text) return (a.text ? 0 : 1) - (b.text ? 0 : 1);
  if (a.num !== null && b.num !== null) return (a.num - b.num) * dir;
  if (a.num !== null || b.num !== null) return (a.num !== null ? -1 : 1) * dir;
  return collator.compare(a.text, b.text) * dir;
}

const collators = new Map<string, Intl.Collator>();
function collatorFor(locale?: string): Intl.Collator {
  const key = locale ?? '';
  let c = collators.get(key);
  if (!c) {
    c = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    collators.set(key, c);
  }
  return c;
}

/** The row order for sorting `texts` (one string per row) up or down; stable. */
export function sortedOrder(texts: readonly string[], dir: 1 | -1, locale?: string): number[] {
  const collator = collatorFor(locale);
  const keys = keysOf(texts, locale);
  return keys.map((_, i) => i).sort((x, y) => compareKeys(keys[x]!, keys[y]!, dir, collator) || x - y);
}

/**
 * Whether the rows already stand A to Z, Z to A, or neither. A stable sort
 * leaves the rows alone exactly when no neighbour pair is out of order, so
 * one pass answers it.
 */
export function columnSortState(texts: readonly string[], locale?: string): SortState {
  const keys = keysOf(texts, locale);
  // A column of one value reads as sorted both ways, which tells nothing.
  if (new Set(keys.map((k) => k.text)).size < 2) return null;
  const collator = collatorFor(locale);
  const ordered = (dir: 1 | -1) => keys.every((k, i) => i === 0 || compareKeys(keys[i - 1]!, k, dir, collator) <= 0);
  if (ordered(1)) return 'asc';
  if (ordered(-1)) return 'desc';
  return null;
}

function columnTexts(table: ProseMirrorNode, col: number, toMarkdown: ToMarkdown): string[] {
  return rowsOf(table).slice(1).map((row) => (col < row.childCount ? cellSortText(row.child(col), toMarkdown) : ''));
}

/** Sort the table at `tablePos` by column `col`: A to Z, or Z to A when it already stands A to Z. */
export function sortTableColumn(view: EditorView, tablePos: number, col: number, toMarkdown: ToMarkdown): void {
  const { state } = view;
  const table = state.doc.nodeAt(tablePos);
  if (!table || table.type.name !== 'table' || !tableIsSortable(table)) return;
  const locale = activeLocale();
  const texts = columnTexts(table, col, toMarkdown);
  const dir = columnSortState(texts, locale) === 'asc' ? -1 : 1;
  const rows = rowsOf(table);
  const body = rows.slice(1);
  const order = sortedOrder(texts, dir, locale);
  if (order.every((v, i) => v === i)) return;
  // An array, not a Fragment: replaceWith builds the fragment with its own
  // copy of the model, and two copies are loaded.
  const content = [rows[0]!, ...order.map((i) => body[i]!)];
  const tr = state.tr.replaceWith(tablePos + 1, tablePos + table.nodeSize - 1, content);
  // The replace maps a caret inside the table to its end; put it back in its
  // own row, which has moved. Every row keeps its size, so the offset holds.
  const rowStart = (index: number, list: readonly ProseMirrorNode[]) => tablePos + 1 + list.slice(0, index).reduce((n, r) => n + r.nodeSize, 0);
  const head = state.selection.head;
  if (state.selection.empty && head > tablePos && head < tablePos + table.nodeSize) {
    let index = 0;
    while (index < rows.length && rowStart(index + 1, rows) <= head) index++;
    if (index > 0) {
      const newIndex = order.indexOf(index - 1) + 1;
      const pos = rowStart(newIndex, content) + (head - rowStart(index, rows));
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
    }
  }
  // Its own undo step, even when two clicks come close together.
  view.dispatch(closeHistory(tr).scrollIntoView());
}

const ICONS: Record<'asc' | 'desc' | 'none', string> = {
  asc: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  desc: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  none: '<path d="M5 6l3-3 3 3M5 10l3 3 3-3"/>',
};

function arrow(view: EditorView, getPos: () => number | undefined, col: number, state: SortState, toMarkdown: ToMarkdown): HTMLElement {
  // HoverLabel's tip built as DOM, as the code block's buttons do: a widget
  // is plain DOM. Below and end-aligned, because the table's scroller cuts
  // what hangs above the header row or past the last column.
  const host = document.createElement('span');
  host.className = 'pn-table-sort-host group/tip';
  host.contentEditable = 'false';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `pn-table-sort${state ? ' is-sorted' : ''}`;
  // The label says what a click does next.
  const label = i18n.t(state === 'asc' ? 'editor:table.sortDescending' : 'editor:table.sortAscending');
  button.setAttribute('aria-label', label);
  button.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[state ?? 'none']}</svg>`;
  const tip = document.createElement('span');
  tip.className = `${TIP_PILL} ${positionClasses['below-end']} whitespace-nowrap`;
  tip.textContent = label;
  host.append(button, tip);
  // Pointer-down keeps the caret where it is; the click does the work.
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', (e) => {
    e.preventDefault();
    const pos = getPos();
    if (pos === undefined || !view.editable) return;
    const $pos = view.state.doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth--) {
      if ($pos.node(depth).type.name === 'table') {
        sortTableColumn(view, $pos.before(depth), col, toMarkdown);
        return;
      }
    }
  });
  return host;
}

/**
 * Per table node: whether it is sortable and how each column stands. A
 * transaction keeps every node it did not touch, so typing elsewhere in a
 * note with a long table reads it from here instead of sorting it again.
 */
const tableInfo = new WeakMap<ProseMirrorNode, { locale: string; states: SortState[] | null }>();

function infoOf(table: ProseMirrorNode, locale: string, toMarkdown: ToMarkdown): SortState[] | null {
  const hit = tableInfo.get(table);
  if (hit && hit.locale === locale) return hit.states;
  const states = tableIsSortable(table)
    ? Array.from({ length: table.firstChild!.childCount }, (_, col) => columnSortState(columnTexts(table, col, toMarkdown), locale))
    : null;
  // Read before the serializer was there: good for now, not to keep.
  if (toMarkdown(table.firstChild!) !== null) tableInfo.set(table, { locale, states });
  return states;
}

function sortDecorations(state: EditorState, toMarkdown: ToMarkdown): DecorationSet {
  const decorations: Decoration[] = [];
  const locale = activeLocale();
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const states = infoOf(node, locale, toMarkdown);
    if (!states) return false;
    let cellPos = pos + 2;
    node.firstChild!.forEach((cell, _offset, col) => {
      const sorted = states[col] ?? null;
      decorations.push(Decoration.node(cellPos, cellPos + cell.nodeSize, { class: 'pn-sortable' }));
      decorations.push(
        Decoration.widget(cellPos + 1, (view, getPos) => arrow(view, getPos, col, sorted, toMarkdown), {
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
          key: `sort-${col}-${sorted ?? 'none'}`,
        }),
      );
      cellPos += cell.nodeSize;
    });
    return false;
  });
  return DecorationSet.create(state.doc, decorations);
}

export function tableSortPlugin(toMarkdown: ToMarkdown): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: sortKey,
    state: {
      init: (_config, state) => sortDecorations(state, toMarkdown),
      apply: (tr, old, _prev, state) => (tr.docChanged ? sortDecorations(state, toMarkdown) : old),
    },
    props: {
      decorations: (state) => sortKey.getState(state),
    },
  });
}
