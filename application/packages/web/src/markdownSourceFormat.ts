/**
 * What the Markdown view's toolbar does to the text: each action reads the
 * text and the selection and returns one replacement, so the field applies it
 * as a single typed change and its own undo takes it back in one step.
 *
 * Marks wrap the selection and unwrap it on a second press. They wrap the
 * words only: spaces and line ends at the edges of the selection, and a list,
 * quote or heading marker at the start of a line, stay outside, because
 * `**hello **` and `**- item**` are not bold in Markdown. Across lines each
 * line gets its own pair, because a mark cannot cross a blank line. Line
 * prefixes act on every line the selection touches and come off when every
 * line already carries them. Blocks (divider, code block, table) sit on their
 * own lines with a blank line before them, because a `---` right under a line
 * of text makes that line a heading.
 * Spec: docs/internal/specs/editor-mode-toggle.md (Source bar edits)
 */

import { setSourceFolded, sourceFoldSummary } from './markdownSourceFolds';

/** Replace [from, to) with `insert`, then select [selFrom, selTo). */
export type SourceEdit = { from: number; to: number; insert: string; selFrom: number; selTo: number };

export type SourceAction =
  | 'bold' | 'italic' | 'strike' | 'inlinecode' | 'highlight' | 'spoiler' | 'math'
  | 'heading' | 'tasks' | 'bullets' | 'numbered' | 'quote'
  | 'link' | 'notelink' | 'codeblock' | 'table' | 'hr'
  | 'blockmath' | 'callout' | 'footnote' | 'foldAll';

/** Every action the Markdown view can run from a toolbar item of the same
 *  key (formatBar.ts). An item not here writes no Markdown of its own
 *  (underline, color, alignment, font, superscript and subscript are HTML)
 *  or needs the formatted editor (pictures, files, a map, a doodle, a board,
 *  an icon), so the Markdown view does not offer it. */
export const SOURCE_ACTIONS: ReadonlySet<string> = new Set<SourceAction>([
  'bold', 'italic', 'strike', 'inlinecode', 'highlight', 'spoiler', 'math',
  'heading', 'tasks', 'bullets', 'numbered', 'quote',
  'link', 'notelink', 'codeblock', 'table', 'hr',
  'blockmath', 'callout', 'footnote', 'foldAll',
]);

function wrapRange(text: string, s: number, e: number, mark: string): SourceEdit {
  const n = mark.length;
  // A lone '*' must not take one star of a '**' pair.
  const lone = (at: number) => mark !== '*' || text[at] !== '*';
  if (text.slice(s - n, s) === mark && text.slice(e, e + n) === mark && lone(s - n - 1) && lone(e + n)) {
    return { from: s - n, to: e + n, insert: text.slice(s, e), selFrom: s - n, selTo: e - n };
  }
  const sel = text.slice(s, e);
  if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(n, sel.length - n);
    return { from: s, to: e, insert: inner, selFrom: s, selTo: s + inner.length };
  }
  // A backtick inside inline code needs a longer fence around it.
  const open = mark === '`' && sel.includes('`') ? '`` ' : mark;
  const close = open === mark ? mark : ' ``';
  return { from: s, to: e, insert: open + sel + close, selFrom: s + open.length, selTo: e + open.length };
}

// A list, task, quote or heading marker at the start of a line, nested ones
// included (`> - [ ] `): a mark goes after it, never around it.
const LINE_MARKER = /^[ \t]*(?:(?:- \[[ xX]\] |[-*+] |\d+[.)] |> ?|#{1,6} )[ \t]*)*/;

/** [s, e) without the spaces at its edges and a line marker at its start. */
function words(text: string, s: number, e: number): [number, number] {
  const lineStart = text.lastIndexOf('\n', s - 1) + 1;
  s = Math.max(s, lineStart + LINE_MARKER.exec(text.slice(lineStart))![0].length);
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return [s, e];
}

function wrap(text: string, selS: number, selE: number, mark: string): SourceEdit {
  if (selS === selE) return wrapRange(text, selS, selE, mark);
  const [s, e] = words(text, selS, selE);
  // Only spaces or a marker selected: the caret goes where the words would.
  if (s >= e) return wrapRange(text, Math.min(s, selE), Math.min(s, selE), mark);
  if (!text.slice(s, e).includes('\n')) return wrapRange(text, s, e, mark);
  // Several lines: one pair per line with words, all on or all off.
  const n = mark.length;
  const parts: [number, number][] = [];
  for (let at = s; at <= e;) {
    const nl = text.indexOf('\n', at);
    const end = nl === -1 || nl > e ? e : nl;
    const [ws, we] = words(text, at, end);
    if (ws < we) parts.push([ws, we]);
    at = end + 1;
  }
  // A line in bold is not a line in italic: '**' counts for '*' only as '***'.
  const lone = (at: number, step: number) => mark !== '*' || text[at + step] !== '*' || text[at + 2 * step] === '*';
  const on = (p: [number, number]) => p[1] - p[0] >= 2 * n && text.startsWith(mark, p[0]) && text.endsWith(mark, p[1]) && lone(p[0], 1) && lone(p[1] - 1, -1);
  const off = parts.every(on);
  let insert = '';
  let at = s;
  for (const [ws, we] of parts) {
    const inner = text.slice(ws, we);
    insert += text.slice(at, ws) + (off ? inner.slice(n, inner.length - n) : on([ws, we]) ? inner : mark + inner + mark);
    at = we;
  }
  insert += text.slice(at, e);
  return { from: s, to: e, insert, selFrom: s, selTo: s + insert.length };
}

// The first group is the indent, which a nested item keeps. A quote starts
// the line, so it has none.
const LINE_PREFIX: Record<'tasks' | 'bullets' | 'numbered' | 'quote', RegExp> = {
  tasks: /^([ \t]*)- \[[ xX]\] /,
  bullets: /^([ \t]*)[-*+] (?!\[[ xX]\] )/,
  numbered: /^([ \t]*)\d+[.)] /,
  quote: /^()> ?/,
};
// Any list or quote prefix, so a bullet line turns into a task line rather
// than a bullet with a checkbox inside it.
const ANY_LIST = /^([ \t]*)(?:- \[[ xX]\] |[-*+] |\d+[.)] |> ?)/;

function lines(text: string, s: number, e: number, map: (line: string, i: number) => string): SourceEdit {
  const from = text.lastIndexOf('\n', s - 1) + 1;
  // A selection that ends at the start of a line does not take that line.
  const endAt = e > s && text[e - 1] === '\n' ? e - 1 : e;
  const nl = text.indexOf('\n', endAt);
  const to = nl === -1 ? text.length : nl;
  const before = text.slice(from, to).split('\n');
  const after = before.map(map);
  const insert = after.join('\n');
  if (s === e) {
    const delta = after[0]!.length - before[0]!.length;
    const caret = Math.max(from, s + delta);
    return { from, to, insert, selFrom: caret, selTo: caret };
  }
  return { from, to, insert, selFrom: from, selTo: from + insert.length };
}

/** The column a run of spaces and tabs reaches; a tab stops every four. */
function columns(indent: string): number {
  let col = 0;
  for (const ch of indent) col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
  return col;
}

function listToggle(text: string, s: number, e: number, kind: keyof typeof LINE_PREFIX): SourceEdit {
  const from = text.lastIndexOf('\n', s - 1) + 1;
  const endAt = e > s && text[e - 1] === '\n' ? e - 1 : e;
  const nl = text.indexOf('\n', endAt);
  const block = text.slice(from, nl === -1 ? text.length : nl).split('\n');
  const filled = block.filter((l) => l.trim() !== '');
  const off = filled.length > 0 && filled.every((l) => LINE_PREFIX[kind].test(l));
  // One entry per open nesting level: the indent the line had, the indent it
  // gets, the column its text starts at, and its own count. A child moves to
  // its parent's text column, because a marker of another width would
  // otherwise leave it too shallow to nest, and every level counts from 1.
  const levels: { from: number; indent: string; text: number; n: number }[] = [];
  return lines(text, s, e, (line) => {
    if (off) return line.replace(LINE_PREFIX[kind], '$1');
    if (line.trim() === '' && filled.length > 0) return line;
    // A quote wraps the line as it is, list marker and task state included.
    if (kind === 'quote') return `> ${line.replace(LINE_PREFIX.quote, '')}`;
    const m = ANY_LIST.exec(line);
    const own = m ? m[1]! : /^[ \t]*/.exec(line)![0];
    const bare = line.slice(m ? m[0].length : own.length);
    const at = columns(own);
    while (levels.length > 0 && levels[levels.length - 1]!.from > at) levels.pop();
    let level = levels[levels.length - 1];
    if (!level || level.from < at) {
      level = { from: at, indent: level ? ' '.repeat(level.text) : own, text: 0, n: 0 };
      levels.push(level);
    }
    // A task's text starts after `- `: the checkbox is part of its text.
    const marker = kind === 'numbered' ? `${++level.n}. ` : '- ';
    level.text = columns(level.indent) + marker.length;
    return `${level.indent}${marker}${kind === 'tasks' ? '[ ] ' : ''}${bare}`;
  });
}

/** H1, H2, H3, then back to body text. */
function heading(text: string, s: number, e: number): SourceEdit {
  return lines(text, s, e, (line) => {
    const m = /^(#{1,6}) /.exec(line);
    if (!m) return `# ${line}`;
    const body = line.slice(m[0].length);
    return m[1]!.length >= 3 ? body : `${m[1]}# ${body}`;
  });
}

/** `content` on its own lines, with a blank line before and after it. */
function block(text: string, s: number, e: number, content: string, selIn: [number, number]): SourceEdit {
  const head = text.slice(0, s);
  const tail = text.slice(e);
  const lead = head === '' || head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n';
  const trail = tail === '' || tail.startsWith('\n\n') ? '' : tail.startsWith('\n') ? '\n' : '\n\n';
  const insert = lead + content + trail;
  const at = s + lead.length;
  return { from: s, to: e, insert, selFrom: at + selIn[0], selTo: at + selIn[1] };
}

export function sourceEdit(action: SourceAction, text: string, selStart: number, selEnd: number): SourceEdit {
  const s = Math.min(selStart, selEnd);
  const e = Math.max(selStart, selEnd);
  const sel = text.slice(s, e);
  switch (action) {
    case 'bold': return wrap(text, s, e, '**');
    case 'italic': return wrap(text, s, e, '*');
    case 'strike': return wrap(text, s, e, '~~');
    case 'inlinecode': return wrap(text, s, e, '`');
    case 'highlight': return wrap(text, s, e, '==');
    case 'spoiler': return wrap(text, s, e, '||');
    case 'math': return wrap(text, s, e, '$');
    case 'heading': return heading(text, s, e);
    case 'tasks':
    case 'bullets':
    case 'numbered':
    case 'quote': return listToggle(text, s, e, action);
    case 'link': {
      // The address is the part still to write, so it is what ends selected.
      const url = 'https://';
      const insert = `[${sel}](${url})`;
      return sel === ''
        ? { from: s, to: e, insert, selFrom: s + 1, selTo: s + 1 }
        : { from: s, to: e, insert, selFrom: s + sel.length + 3, selTo: s + sel.length + 3 + url.length };
    }
    case 'notelink':
      return { from: s, to: e, insert: `[[${sel}]]`, selFrom: s + 2, selTo: s + 2 + sel.length };
    case 'codeblock': {
      const content = '```\n' + sel + '\n```';
      return block(text, s, e, content, [4, 4 + sel.length]);
    }
    case 'table': {
      const cell = sel.includes('\n') ? '' : sel;
      const head = cell || 'Column';
      const content = `| ${head} | Column |\n| --- | --- |\n|  |  |`;
      return block(text, s, e, content, [2, 2 + head.length]);
    }
    case 'hr': {
      // After the selection, which it keeps; the caret goes under the line.
      const out = block(text, e, e, '---', [3, 3]);
      const caret = e + out.insert.length;
      return { ...out, selFrom: caret, selTo: caret };
    }
    case 'blockmath': {
      const content = '$$\n' + sel + '\n$$';
      return block(text, s, e, content, [3, 3 + sel.length]);
    }
    case 'callout': {
      // The type the formatted view's picker opens on; the selection, if any,
      // becomes the body, each line quoted. The caret ends in the body.
      const head = '> [!note]+';
      const body = (sel === '' ? [''] : sel.split('\n')).map((l) => `> ${l}`).join('\n');
      const content = `${head}\n${body}`;
      return block(text, s, e, content, [content.length, content.length]);
    }
    case 'footnote': {
      // The next free number, its marker after the selection and its line at
      // the end of the note, where the editor keeps the definitions; the
      // caret waits on that line. One replacement, so one undo.
      const used = [...text.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]));
      const n = used.length > 0 ? Math.max(...used) + 1 : 1;
      const rest = text.slice(e);
      const gap = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
      const insert = `${sel}[^${n}]${rest}${gap}[^${n}]: `;
      const end = s + insert.length;
      return { from: s, to: text.length, insert, selFrom: end, selTo: end };
    }
    case 'foldAll': {
      // Closes every fold while one is open, opens them all once each is
      // closed, as the formatted view's button does. Only the lines that
      // change are replaced; the selection stays where it was.
      const { foldable, open } = sourceFoldSummary(text);
      const next = setSourceFolded(text, open > 0 || foldable === 0);
      let from = 0;
      while (from < text.length && from < next.length && text[from] === next[from]) from++;
      let tail = 0;
      while (tail < text.length - from && tail < next.length - from && text[text.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
      const shift = (at: number) => (at <= from ? at : Math.max(from, at + next.length - text.length));
      return { from, to: text.length - tail, insert: next.slice(from, next.length - tail), selFrom: shift(s), selTo: shift(e) };
    }
  }
}

/**
 * A toolbar press on a text field: the edit above, written through the same
 * change as typing, so the field's own undo takes it back in one step, then
 * the selection the action leaves. The one function here that touches a
 * field; the Markdown view and the vault Notes box both call it.
 *
 * Returns the new text when the browser had no typed change to make (no
 * `execCommand`), because then no input event reports it and the caller must
 * store it itself; null when the field's own input event already did.
 */
export function applySourceAction(el: HTMLTextAreaElement, action: SourceAction): string | null {
  const edit = sourceEdit(action, el.value, el.selectionStart, el.selectionEnd);
  el.focus();
  // Nothing to change (Collapse all with every fold already closed): a
  // delete over an empty range would take the character before the caret.
  if (edit.from === edit.to && edit.insert === '') {
    el.setSelectionRange(edit.selFrom, edit.selTo);
    return null;
  }
  el.setSelectionRange(edit.from, edit.to);
  const typed = edit.insert === ''
    ? document.execCommand?.('delete', false)
    : document.execCommand?.('insertText', false, edit.insert);
  let untyped: string | null = null;
  if (!typed) {
    el.setRangeText(edit.insert, edit.from, edit.to, 'end');
    untyped = el.value;
  }
  el.setSelectionRange(edit.selFrom, edit.selTo);
  return untyped;
}
