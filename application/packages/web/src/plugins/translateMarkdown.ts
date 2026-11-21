import { escapeHtml } from '../escapeHtml';
import { nextFence, type Fence } from '../markdownFence';

/**
 * Translate notes: a note's Markdown in, the same Markdown out with only its
 * words translated. The structure never goes to the engine: each line keeps
 * its heading marks, list and task markers, quote and callout marks, table
 * pipes, hard breaks and indents. Code blocks (fenced or indented), math
 * blocks as the editor reads them, HTML blocks, comments, reference link
 * definitions, setext underlines and table markers stay as they are. Only
 * the inline text of a line goes, as one unit, or in pieces of about `SPLIT`
 * characters cut at a space, because the engine cuts a long sentence short:
 *
 * - bold, italic and highlight go as tags, in an order that nests (the
 *   engine's HTML reader fails on tags that cross), and a link as
 *   `<a href="#L<n>">` (its target never goes);
 * - every part that must not change (a code span, a note-link, a reference
 *   link, a picture or file, inline math, an icon, a footnote mark, an
 *   address, raw HTML, an escape, an entity, a struck or hidden run, and the
 *   characters this file uses for itself) goes as `⟦n⟧`.
 *
 * A line whose marks cross, or that holds two or more links, goes in the
 * plain form from the start: no tags, and each link whole and untranslated
 * as one more `⟦n⟧` (a model can put a tag on the wrong words, and a link's
 * address would then sit under another name). A mark the model gives back
 * empty is dropped on its own; a line whose link comes back empty, or whose
 * tags do not pair, goes again in the plain form. A `⟦n⟧` the model wrote
 * with spaces inside is read, what is left of a broken one is removed, and a
 * part the engine lost is added at the end of its line. An answer with no
 * words keeps the source text, and translate.ts counts that line.
 * Spec: docs/internal/plans/plugins.md (section 6.5)
 */

export type Unit = {
  /** For the HTML mode. */
  html: string;
  /** For the second try, in plain mode. */
  plain: string;
  /** The Markdown that each `⟦n⟧` stands for; the plain mode's links follow the parts of the HTML mode. */
  parts: string[];
  /** The number of parts the HTML mode sends. */
  htmlParts: number;
  /** Each link's target with its brackets, `(url "title")`, by its number; none for a unit that goes as its plain form. */
  targets: string[];
  /** The Markdown the unit stands for, kept as it is when the engine gives back no words. */
  source: string;
};

/** A line as pieces: kept text, or the index of a unit. */
export type Plan = { lines: (string | number)[][]; units: Unit[] };

// Private-use characters stand for the pieces while a unit is built. The
// same characters in a note are parts of their own (beta #239 item 8).
const PART = '\uE000';
const PART_END = '\uE001';
const LINK = '\uE002';
const LINK_END = '\uE003';
const LINK_CLOSE = '\uE004';
const MARK = '\uE005';
const MARK_CLOSE = '\uE006';
const TARGET = '\uE007';
const TARGET_END = '\uE008';

/** A mark kind by the Markdown it was written with, so a piece's source can be rebuilt. */
const MARK_SRC: Record<string, string> = { b: '**', B: '__', i: '*', I: '_', m: '==' };
const MARK_TAG: Record<string, string> = { b: 'b', B: 'b', i: 'i', I: 'i', m: 'mark' };
const MARK_MD: Record<string, string> = { b: '**', i: '*', s: '~~', mark: '==', u: '||' };

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~=<>$:"'&^]/;

/**
 * The longest run of inline text that goes as one unit. The engine's limit
 * is per sentence and a Thai paragraph is one sentence, so a longer run goes
 * in pieces cut at a space (beta #239 item 2).
 */
const SPLIT = 250;

/** A reference label of more characters is read as text (CommonMark allows 999; real ones are short, and this keeps a line of brackets linear). */
const LABEL_MAX = 200;

const NO_REFS: ReadonlySet<string> = new Set();

/**
 * One string's lookups, each made once, so a line of open brackets, open
 * note-links or open comments costs one pass and not one per bracket
 * (beta #239 item 9).
 */
class Scan {
  readonly s: string;
  private readonly match: Int32Array;
  private readonly sameTicks: Int32Array;
  private readonly found = new Map<string, { from: number; at: number }>();

  constructor(s: string) {
    this.s = s;
    this.match = new Int32Array(s.length).fill(-1);
    this.sameTicks = new Int32Array(s.length).fill(-1);
    const square: number[] = [];
    const round: number[] = [];
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === '[') square.push(j);
      else if (c === '(') round.push(j);
      else if (c === ']' || c === ')') {
        const open = (c === ']' ? square : round).pop();
        if (open !== undefined) this.match[open] = j;
      }
    }
    // Each run of backticks: where the next run of the same length starts.
    const next = new Map<number, number>();
    for (let j = s.length - 1; j >= 0; ) {
      if (s[j] !== '`') {
        j--;
        continue;
      }
      let k = j;
      while (k > 0 && s[k - 1] === '`') k--;
      this.sameTicks[k] = next.get(j - k + 1) ?? -1;
      next.set(j - k + 1, k);
      j = k - 1;
    }
  }

  /** The end of the bracket group that opens at `i` (`[` or `(`), or -1. */
  closing(i: number): number {
    return this.match[i] ?? -1;
  }

  /** The first `needle` at or after `from`, or -1. A walk that asks from further on reuses the last answer. */
  next(needle: string, from: number): number {
    const last = this.found.get(needle);
    if (last && from >= last.from && (last.at === -1 || last.at >= from)) return last.at;
    const at = this.s.indexOf(needle, from);
    this.found.set(needle, { from, at });
    return at;
  }

  /** The start of the next run of exactly `len` backticks after the run at `i`, or -1. */
  ticks(i: number, len: number): number {
    if (i === 0 || this.s[i - 1] !== '`') return this.sameTicks[i]!;
    // A run that starts after an escaped backtick: rare, read as it is.
    const re = new RegExp(`(?<!\`)\`{${len}}(?!\`)`, 'g');
    re.lastIndex = i + len;
    return re.exec(this.s)?.index ?? -1;
  }
}

const TAG_AT = /<[a-zA-Z][\w+.-]*:[^\s<>]*>|<\/?[a-zA-Z][^<>]*>/y;
const ENTITY_AT = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/y;
const ADDRESS_AT = /(https?:\/\/|www\.)[^\s<>]+/y;
const sticky = (re: RegExp, s: string, i: number): number => {
  re.lastIndex = i;
  return re.exec(s)?.[0].length ?? 0;
};

/** The length of the protected part at `i`, or 0. */
function partAt(sc: Scan, i: number): number {
  const s = sc.s;
  const c = s[i]!;
  if (c === '⟦' || c === '⟧' || c === '\uFFFD' || (c >= PART && c <= TARGET_END)) return 1;
  if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1]!)) return 2;
  if (c === '`') {
    let run = 1;
    while (s[i + run] === '`') run++;
    const end = sc.ticks(i, run);
    return end >= 0 ? end + run - i : run;
  }
  if (c === '$') {
    if (s[i + 1] === '$') {
      const end = sc.next('$$', i + 2);
      return end > i + 2 ? end + 2 - i : 0;
    }
    // Inline math as `inlineMathRule` in editorInlineSyntax.ts reads it: the
    // first unescaped sign closes it, with no space inside either end and no
    // digit right after ("$5 and $10" is text).
    if (i + 1 >= s.length || /\s/.test(s[i + 1]!)) return 0;
    let end = s.indexOf('$', i + 1);
    while (end > 0 && s[end - 1] === '\\') end = s.indexOf('$', end + 1);
    return end > i + 1 && !/\s/.test(s[end - 1]!) && !/\d/.test(s[end + 1] ?? '') ? end + 1 - i : 0;
  }
  if (c === '[' && s[i + 1] === '[') {
    const end = sc.next(']]', i + 2);
    return end >= 0 ? end + 2 - i : 0;
  }
  if ((c === '!' && s[i + 1] === '[') || (c === '[' && s[i + 1] === '^')) {
    const end = sc.closing(c === '!' ? i + 1 : i);
    if (end < 0) return 0;
    if (c === '[') return end + 1 - i;
    const stop = s[end + 1] === '(' ? sc.closing(end + 1) : -1;
    return (stop > 0 ? stop : end) + 1 - i;
  }
  if (c === '<') {
    if (s.startsWith('<!--', i)) {
      const end = sc.next('-->', i + 4);
      if (end >= 0) return end + 3 - i;
    }
    return sticky(TAG_AT, s, i);
  }
  if (c === '&') return sticky(ENTITY_AT, s, i);
  if (c === ':' && (s.startsWith(':icon[', i) || s.startsWith(':logo[', i))) {
    const end = sc.next(']', i + 6);
    return end >= 0 ? end + 1 - i : 0;
  }
  if ((c === 'h' || c === 'w') && (i === 0 || /\s|\(/.test(s[i - 1]!))) {
    let len = sticky(ADDRESS_AT, s, i);
    while (len > 0 && `.,;:!?)'"`.includes(s[i + len - 1]!)) len--;
    return len;
  }
  return 0;
}

const labelKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The end of a reference link at `i` whose label the note defines (`[words][label]`, `[label][]`, `[label]`), or -1. */
function refEnd(sc: Scan, i: number, end: number, refs: ReadonlySet<string>): number {
  const s = sc.s;
  if (s[i + 1] === '^' || end - i > LABEL_MAX) return -1;
  if (s[end + 1] === '[') {
    const stop = sc.closing(end + 1);
    if (stop < 0 || stop - end > LABEL_MAX) return -1;
    return refs.has(labelKey(stop === end + 2 ? s.slice(i + 1, end) : s.slice(end + 2, stop))) ? stop : -1;
  }
  return refs.has(labelKey(s.slice(i + 1, end))) ? end : -1;
}

/** The text with every part and link turned into placeholders; parts, link sources and targets collect on the way. */
function protect(s: string, parts: string[], links: string[], targets: string[], refs: ReadonlySet<string>): string {
  const sc = new Scan(s);
  const part = (from: number, to: number) => `${PART}${parts.push(s.slice(from, to)) - 1}${PART_END}`;
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] === '[') {
      const end = sc.closing(i);
      if (end > i && s[end + 1] === '(') {
        const stop = sc.closing(end + 1);
        const target = stop > 0 ? s.slice(end + 1, stop + 1) : '';
        // Only a web, mail or phone link keeps its words translatable: a file
        // or note address names something that must keep its name.
        if (stop > 0 && /^\(\s*<?(https?:|mailto:|tel:|#)/i.test(target)) {
          const n = targets.length;
          targets.push(target);
          links.push(s.slice(i, stop + 1));
          out += `${LINK}${n}${LINK_END}${protect(s.slice(i + 1, end), parts, links, targets, refs)}${LINK_CLOSE}`;
          i = stop + 1;
          continue;
        }
        if (stop > 0) {
          out += part(i, stop + 1);
          i = stop + 1;
          continue;
        }
      }
      // A reference link is kept whole, as its definition line is: two
      // translations of one label would leave the link dead (beta #239 item 5).
      const ref = end > i && refs.size ? refEnd(sc, i, end, refs) : -1;
      if (ref > 0) {
        out += part(i, ref + 1);
        i = ref + 1;
        continue;
      }
    }
    const len = partAt(sc, i);
    if (len > 0) {
      out += part(i, i + len);
      i += len;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
/** Whether the character before `i`, or at `i`, is a letter, a digit or `_` (a surrogate pair read as one). */
const wordBefore = (s: string, i: number) => /[\p{L}\p{N}_]$/u.test(s.slice(Math.max(0, i - 2), i));
const wordAt = (s: string, i: number) => /^[\p{L}\p{N}_]/u.test(s.slice(i, i + 2));

/**
 * Pairs a delimiter as `d(?=\S)([\s\S]*?\S)d` would, in one pass: each
 * closer is found once, so a line of openers that never close stays linear
 * (beta #239 item 9). `wrap` gives the text for the pair, or null to leave
 * that opener as text.
 */
function pair(
  s: string,
  d: string,
  opens: (p: number) => boolean,
  closes: (q: number) => boolean,
  wrap: (p: number, q: number) => string | null,
): string {
  const len = d.length;
  const closers: number[] = [];
  for (let q = s.indexOf(d, 1); q !== -1; q = s.indexOf(d, q + 1)) if (!isSpace(s[q - 1]) && closes(q)) closers.push(q);
  let out = '';
  let at = 0;
  let k = 0;
  for (let p = s.indexOf(d); p !== -1; ) {
    if (!isSpace(s[p + len]) && opens(p)) {
      while (k < closers.length && closers[k]! < p + len + 1) k++;
      if (k === closers.length) break;
      const q = closers[k]!;
      const w = wrap(p, q);
      if (w !== null) {
        out += s.slice(at, p) + w;
        at = q + len;
        p = s.indexOf(d, at);
        continue;
      }
    }
    p = s.indexOf(d, p + 1);
  }
  return out + s.slice(at);
}

/** The index of the LINK_CLOSE that ends the link whose LINK_END is at `i`, or the end of the text. */
function linkEnd(s: string, i: number): number {
  let depth = 1;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === LINK) depth++;
    else if (s[j] === LINK_CLOSE && --depth === 0) return j;
  }
  return s.length;
}

type Prepared = { marked: string; parts: string[]; links: string[]; targets: string[] };

/** The Markdown a run of placeholders stands for. */
function sourceOf(s: string, prep: Prepared): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === PART || c === MARK) {
      const end = s.indexOf(c === PART ? PART_END : MARK_CLOSE, i);
      const key = s.slice(i + 1, end);
      out += c === PART ? prep.parts[Number(key)] : MARK_SRC[key.replace('/', '')];
      i = end;
    } else if (c === LINK) {
      const end = s.indexOf(LINK_END, i);
      // The link's source holds its words.
      out += prep.links[Number(s.slice(i + 1, end))];
      i = linkEnd(s, end);
    } else out += c;
  }
  return out;
}

/**
 * Struck and hidden runs as parts, whole: a strike or a spoiler shown
 * unmarked would say the opposite or show a secret, and the plain try has no
 * marks (beta #239 item 4). A run that crosses a link's edge stays text.
 */
function hideRuns(s: string, prep: Prepared): string {
  for (const d of ['~~', '||']) {
    const t = s;
    s = pair(t, d, () => true, () => true, (p, q) => {
      let depth = 0;
      for (let j = p; j < q; j++) {
        if (t[j] === LINK) depth++;
        else if (t[j] === LINK_CLOSE && --depth < 0) return null;
      }
      return depth ? null : `${PART}${prep.parts.push(sourceOf(t.slice(p, q + d.length), prep)) - 1}${PART_END}`;
    });
  }
  return s;
}

/** Turns the Markdown marks into mark placeholders. Bold first, so `**` is never read as two `*`. */
function marks(s: string): string {
  const tag = (kind: string, body: string) => `${MARK}${kind}${MARK_CLOSE}${body}${MARK}/${kind}${MARK_CLOSE}`;
  const twice = (t: string, d: string, kind: string, opens: (p: number) => boolean, closes: (q: number) => boolean) =>
    pair(t, d, opens, closes, (p, q) => tag(kind, t.slice(p + 2, q)));
  s = twice(s, '**', 'b', () => true, () => true);
  const u = s;
  s = twice(u, '__', 'B', (p) => !wordBefore(u, p), (q) => !wordAt(u, q + 2));
  s = twice(s, '==', 'm', () => true, () => true);
  // A single mark cannot hold its own sign, so each try stops at the next one.
  return s
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, (_, body: string) => tag('i', body))
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, (_, body: string) => tag('I', body));
}

type Tag = { raw: string; mark: boolean; open: boolean; run: number; mate: Tag | null };

/**
 * The marked text with its marks and links in an order that nests, or null
 * when they cross. Marks with no text between them trade places: `***x***`
 * closes its bold and its italic at one spot, so the one opened last closes
 * first. A link's tags keep their place. The engine's HTML reader ends on a
 * tag that closes out of turn (beta #239 item 1).
 */
function nested(s: string): string | null {
  const re = new RegExp(`${MARK}(/?)([bBiIm])${MARK_CLOSE}|${LINK}\\d+${LINK_END}|${LINK_CLOSE}`, 'g');
  const pieces: (string | Tag[])[] = [];
  const unclosed: Record<string, Tag[]> = {};
  let at = 0;
  let run = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > at) {
      pieces.push(s.slice(at, m.index));
      run++;
    }
    at = m.index + m[0].length;
    const kind = m[2] ?? 'a';
    const tag: Tag = { raw: m[0], mark: !!m[2], open: m[2] ? !m[1] : m[0] !== LINK_CLOSE, run, mate: null };
    if (tag.open) (unclosed[kind] ??= []).push(tag);
    else {
      const from = unclosed[kind]?.pop();
      // No opener, or nothing between the two.
      if (!from || from.run === run) return null;
      from.mate = tag;
      tag.mate = from;
    }
    const group = pieces.at(-1);
    if (Array.isArray(group) && tag.mark && group[0]!.mark) group.push(tag);
    else pieces.push([tag]);
  }
  if (Object.values(unclosed).some((list) => list.length)) return null;
  const stack: Tag[] = [];
  let out = '';
  for (const piece of pieces) {
    if (typeof piece === 'string') {
      out += piece;
      continue;
    }
    // What closes here must be what was opened last, and closes innermost first.
    const closers = piece.filter((t) => !t.open);
    const top = closers.length ? stack.splice(-closers.length) : [];
    if (closers.some((t) => !top.includes(t.mate!))) return null;
    for (const t of top.reverse()) out += t.mate!.raw;
    // What opens here: the one that closes last goes outside.
    const openers = piece.filter((t) => t.open).sort((a, b) => b.mate!.run - a.mate!.run);
    for (const t of openers) out += t.raw;
    stack.push(...openers);
  }
  return out + s.slice(at);
}

/** A text's own spaces at both ends, and what they hold (no regex: a long run of spaces stays linear). */
function splitSpace(s: string): [string, string, string] {
  const start = s.length - s.trimStart().length;
  const core = s.trim();
  return [s.slice(0, start), core, s.slice(start + core.length)];
}

/** The parts a text sends, by number, each once, in order. */
const slots = (s: string): number[] => [...new Set([...s.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])))];

/** Plain mode: no marks, and each link whole, as one more part after the `base` parts. */
function plainOf(marked: string, base: number): string {
  let out = '';
  for (let i = 0; i < marked.length; i++) {
    const c = marked[i]!;
    if (c === MARK) i = marked.indexOf(MARK_CLOSE, i);
    else if (c === PART) {
      const end = marked.indexOf(PART_END, i);
      out += `⟦${marked.slice(i + 1, end)}⟧`;
      i = end;
    } else if (c === LINK) {
      const end = marked.indexOf(LINK_END, i);
      // A link inside another link's words: the outer one is one part already.
      out += `⟦${base + Number(marked.slice(i + 1, end))}⟧`;
      i = linkEnd(marked, end);
    } else out += c;
  }
  return out;
}

/** A unit of one run of the marked text, its parts and links numbered from 0, or null when it holds no words. */
function unitOf(prep: Prepared, piece: string): Unit | null {
  const parts: string[] = [];
  const links: string[] = [];
  const targets: string[] = [];
  const marked = piece.replace(new RegExp(`${PART}(\\d+)${PART_END}|${LINK}(\\d+)${LINK_END}`, 'g'), (_, p: string | undefined, l: string | undefined) => {
    if (p !== undefined) return `${PART}${parts.push(prep.parts[Number(p)]!) - 1}${PART_END}`;
    targets.push(prep.targets[Number(l)]!);
    return `${LINK}${links.push(prep.links[Number(l)]!) - 1}${LINK_END}`;
  });
  const words = marked.replace(new RegExp(`${PART}\\d+${PART_END}|${MARK}/?[bBiIm]${MARK_CLOSE}`, 'g'), '');
  if (!/\p{L}/u.test(words)) return null;
  const plain = plainOf(marked, parts.length);
  const source = sourceOf(piece, prep);
  // Two links or more go as the plain form: the model can put a tag on the
  // wrong words, and a link's address would sit under another name (beta #239 item 3).
  const tagged = targets.length < 2 ? nested(marked) : null;
  // Marks that cross each other or a link's edge cannot go as tags: the line goes as its plain form from the start.
  if (tagged === null) {
    const html = escapeHtml(plain);
    return { html, plain, parts: [...parts, ...links], htmlParts: slots(html).length, targets: [], source };
  }
  const html = escapeHtml(tagged)
    .replace(new RegExp(`${PART}(\\d+)${PART_END}`, 'g'), '⟦$1⟧')
    .replace(new RegExp(`${LINK}(\\d+)${LINK_END}`, 'g'), '<a href="#L$1">')
    .replace(new RegExp(LINK_CLOSE, 'g'), '</a>')
    .replace(new RegExp(`${MARK}(/?)([bBiIm])${MARK_CLOSE}`, 'g'), (_, slash: string, k: string) => `<${slash}${MARK_TAG[k]}>`);
  return { html, plain, parts: [...parts, ...links], htmlParts: parts.length, targets, source };
}

function prepare(text: string, refs: ReadonlySet<string>): Prepared {
  const prep: Prepared = { marked: '', parts: [], links: [], targets: [] };
  prep.marked = marks(hideRuns(protect(text, prep.parts, prep.links, prep.targets, refs), prep));
  return prep;
}

/** One line's inline text as a unit, or null when it holds no words. `refs` are the reference labels the note defines. */
export function inlineUnit(text: string, refs: ReadonlySet<string> = NO_REFS): Unit | null {
  const prep = prepare(text, refs);
  return unitOf(prep, prep.marked);
}

/**
 * The marked text in pieces of about `SPLIT` characters, each with the
 * spaces after it. A cut falls only on a space outside every mark, link and
 * part (or right after a CJK full stop), at the end of a sentence when one
 * is near enough.
 */
function cut(m: string): [string, string][] {
  if (m.length <= SPLIT) return [[m, '']];
  const cuts: { at: number; to: number; stop: boolean }[] = [];
  let depth = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m[i]!;
    if (c === PART) i = m.indexOf(PART_END, i);
    else if (c === MARK) {
      depth += m[i + 1] === '/' ? -1 : 1;
      i = m.indexOf(MARK_CLOSE, i);
    } else if (c === LINK) {
      depth++;
      i = m.indexOf(LINK_END, i);
    } else if (c === LINK_CLOSE) depth--;
    else if (depth > 0) continue;
    else if (/\s/.test(c)) {
      let j = i;
      while (j < m.length && /\s/.test(m[j]!)) j++;
      cuts.push({ at: i, to: j, stop: /[.!?;:…。！？]/.test(m[i - 1] ?? '') });
      i = j - 1;
    } else if (/[。！？]/.test(c) && i + 1 < m.length && !/\s/.test(m[i + 1]!)) cuts.push({ at: i + 1, to: i + 1, stop: true });
  }
  const out: [string, string][] = [];
  let start = 0;
  let k = 0;
  while (m.length - start > SPLIT) {
    let best = -1;
    let stop = -1;
    for (let j = k; j < cuts.length && cuts[j]!.at - start <= SPLIT; j++) {
      if (cuts[j]!.at <= start) continue;
      best = j;
      if (cuts[j]!.stop) stop = j;
    }
    let pick = stop >= 0 && cuts[stop]!.at - start >= SPLIT / 3 ? stop : best;
    // No cut within the limit: the first one after it.
    if (pick < 0) pick = cuts.findIndex((c, j) => j >= k && c.at > start);
    if (pick < 0) break;
    out.push([m.slice(start, cuts[pick]!.at), m.slice(cuts[pick]!.at, cuts[pick]!.to)]);
    start = cuts[pick]!.to;
    k = pick + 1;
  }
  out.push([m.slice(start), '']);
  return out;
}

const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' })[e] ?? '');

/** What is left of a placeholder the engine broke: a bracket, a replacement character, the number beside them. */
const BROKEN = /⟦\s*\d*\s*⟧?|\uFFFD+\s*(?:\d+\s*⟧?)?|\d*⟧/g;

/** An answer's placeholders as `⟦n⟧`, also one written with spaces inside, and the rest of a broken one removed (beta #239 item 7). */
function cleanSlots(s: string): string {
  let out = '';
  let at = 0;
  for (const m of s.matchAll(/⟦\s*(\d+)\s*⟧/g)) {
    out += `${s.slice(at, m.index).replace(BROKEN, '')}⟦${m[1]}⟧`;
    at = m.index + m[0].length;
  }
  return out + s.slice(at).replace(BROKEN, '');
}

/** Puts each part and link target back in one pass; a part the engine dropped goes at the end. */
function restoreParts(s: string, parts: readonly string[], expected: readonly number[], targets: readonly string[] = []): string {
  const want = new Set(expected);
  const used = new Set<number>();
  let out = s.replace(new RegExp(`⟦(\\d+)⟧|${TARGET}(\\d+)${TARGET_END}`, 'g'), (_, n: string | undefined, t: string | undefined) => {
    if (t !== undefined) return targets[Number(t)] ?? '';
    const i = Number(n);
    if (!want.has(i) || used.has(i)) return '';
    used.add(i);
    return parts[i]!;
  });
  for (const i of expected) if (!used.has(i)) out += ` ${parts[i]}`;
  return out;
}

type Node = { tag: string; link: number; kids: (string | Node)[] };

const textOf = (n: Node): string => n.kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join('');

/**
 * The engine's HTML answer as Markdown, or null when it needs the plain try:
 * a link came back empty, a tag does not pair up, or a part is gone. A mark
 * that came back empty is dropped on its own (beta #239 item 4).
 */
export function fromHtml(unit: Unit, answer: string): string | null {
  const root: Node = { tag: '', link: -1, kids: [] };
  const stack = [root];
  const all: Node[] = [];
  const re = /<(\/?)(a|b|i|s|mark|u)\b([^>]*)>/g;
  let at = 0;
  for (let m = re.exec(answer); m; m = re.exec(answer)) {
    stack.at(-1)!.kids.push(answer.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1]) {
      if (stack.length < 2 || stack.at(-1)!.tag !== m[2]) return null;
      stack.pop();
    } else {
      const node: Node = { tag: m[2]!, link: m[2] === 'a' ? Number(/#L(\d+)/.exec(m[3]!)?.[1] ?? -1) : -1, kids: [] };
      if (node.tag === 'a' && !(node.link >= 0 && node.link < unit.targets.length)) return null;
      stack.at(-1)!.kids.push(node);
      stack.push(node);
      all.push(node);
    }
  }
  if (stack.length !== 1) return null;
  root.kids.push(answer.slice(at));
  const empty = (n: Node) => !/[\p{L}\p{N}⟦]/u.test(textOf(n));
  // A link the engine split over several words keeps its target on the longest piece.
  const keep = new Map<number, Node>();
  for (const n of all) if (n.tag === 'a' && !empty(n) && textOf(n).length > (keep.get(n.link) ? textOf(keep.get(n.link)!).length : -1)) keep.set(n.link, n);
  if (unit.targets.some((_, i) => !keep.has(i))) return null;
  const render = (n: Node): string => {
    const inner = n.kids.map((k) => (typeof k === 'string' ? cleanSlots(decode(k)) : render(k))).join('');
    if (!n.tag || (n.tag === 'a' ? keep.get(n.link) !== n : empty(n))) return inner;
    const [lead, core, trail] = splitSpace(inner);
    if (n.tag === 'a') return `${lead}[${core}]${TARGET}${n.link}${TARGET_END}${trail}`;
    const d = MARK_MD[n.tag]!;
    return `${lead}${d}${core}${d}${trail}`;
  };
  const md = render(root);
  const expected = slots(unit.html);
  const seen = [...md.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1]));
  if (seen.length !== expected.length || new Set(seen).size !== seen.length || seen.some((n) => !expected.includes(n))) return null;
  return restoreParts(md, unit.parts, expected, unit.targets);
}

/** The engine's plain answer as Markdown. */
export function fromPlain(unit: Unit, answer: string): string {
  return restoreParts(cleanSlots(answer), unit.parts, slots(unit.plain));
}

const BLOCK_HTML = /^<\/?(address|article|aside|blockquote|details|dialog|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|img|iframe|video|audio)\b/i;
const QUOTE = /^((?:[ \t]*>[ \t]?)*)/;
const REF_DEF = /^ {0,3}\[(?!\^)([^\]]+)\]:/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)]|\[\^[^\]]+\]:)(?:[ \t]|$)/;

/** The columns of a line's indent, a tab to the next stop of four. */
function indentOf(s: string): number {
  let col = 0;
  for (const c of s) {
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

const depthOf = (quote: string) => quote.split('>').length - 1;

/**
 * The Markdown of a note as kept text and units, line by line.
 */
export function planTranslation(md: string): Plan {
  // A carriage return or a Unicode line or paragraph separator ends a line as `\n` does (beta #239 item 6).
  const rows = md.replace(/\r\n?|[\u2028\u2029]/g, '\n').split('\n');
  const quotes = rows.map((l) => QUOTE.exec(l)![1]!);
  const rests = rows.map((l, i) => l.slice(quotes[i]!.length));
  const units: Unit[] = [];
  const lines: (string | number)[][] = [];
  // The labels the note defines: a reference link stays whole.
  const refs = new Set<string>();
  for (const r of rests) {
    const m = REF_DEF.exec(r);
    if (m) refs.add(labelKey(m[1]!));
  }
  // From each line on: the first line that ends a math block, holds `-->`, or is blank.
  const ahead = (test: (i: number) => boolean) => {
    const at = new Int32Array(rows.length + 1).fill(-1);
    for (let i = rows.length - 1; i >= 0; i--) at[i] = test(i) ? i : at[i + 1]!;
    return at;
  };
  const mathEnd = ahead((i) => rests[i]!.trimEnd().endsWith('$$'));
  const commentEnd = ahead((i) => rows[i]!.includes('-->'));
  const blankAt = ahead((i) => !rests[i]!.trim());

  let fence: Fence | null = null;
  let fenceQuote = 0;
  let fenceIndent = 0;
  let mathUntil = -1;
  let comment: 'block' | 'inline' | null = null;
  let htmlBlock = false;
  let indented = false;
  let blankBefore = true;
  let inList = false;

  /** The pieces of one run of inline text: its own spaces stay outside, a long run goes in pieces. */
  const inline = (text: string): (string | number)[] => {
    const [lead, core, trail] = splitSpace(text);
    if (!core) return [text];
    const prep = prepare(core, refs);
    const out: (string | number)[] = [lead];
    let made = false;
    for (const [piece, gap] of cut(prep.marked)) {
      const unit = unitOf(prep, piece);
      if (unit) made = true;
      out.push(unit ? units.push(unit) - 1 : sourceOf(piece, prep), gap);
    }
    if (!made) return [text];
    out.push(trail);
    return out;
  };

  const row = (idx: number): (string | number)[] => {
    const line = rows[idx]!;
    const quote = quotes[idx]!;
    const rest = rests[idx]!;
    // Code in a fence. The fence closes only at its own quote depth, indented
    // at most three past where it opened; a line out of its quote ends it (beta #239 item 5).
    if (fence) {
      if (depthOf(quote) < fenceQuote) fence = null;
      else {
        let own = line;
        for (let k = 0; k < fenceQuote; k++) own = own.replace(/^[ \t]*>[ \t]?/, '');
        const lead = own.length - own.trimStart().length;
        fence = nextFence(fence, own.slice(Math.min(lead, fenceIndent)), 3).fence;
        return [line];
      }
    }
    if (idx <= mathUntil) return [line];
    if (comment) {
      const end = line.indexOf('-->');
      if (end < 0) return [line];
      const open = comment;
      comment = null;
      // An HTML block holds its closing line; after an inline comment, the words go.
      return open === 'block' ? [line] : [line.slice(0, end + 3), ...inline(line.slice(end + 3))];
    }
    // Indented code: four columns after a blank line, outside a list (beta #239 item 5).
    if (indented || (blankBefore && !inList && rest.trim() && indentOf(rest) >= 4)) {
      if (!rest.trim() || indentOf(rest) >= 4) {
        indented = true;
        return [line];
      }
      indented = false;
    }
    const f = nextFence(null, rest, 99);
    if (f.isFence) {
      fence = f.fence;
      fenceQuote = depthOf(quote);
      fenceIndent = rest.length - rest.trimStart().length;
      return [line];
    }
    const start = rest.trimStart();
    // Math as the editor reads it (`blockMathRule` in editorInlineSyntax.ts):
    // a line that starts with `$$`, to the next line that ends with `$$`.
    if (start.startsWith('$$')) {
      const first = start.slice(2).trimEnd();
      if (first.endsWith('$$') && first.length > 2) return [line];
      if (mathEnd[idx + 1]! >= 0) {
        mathUntil = mathEnd[idx + 1]!;
        return [line];
      }
    }
    if (start.startsWith('<!--')) {
      if (rest.indexOf('-->', rest.indexOf('<!--') + 4) < 0) comment = 'block';
      return [line];
    }
    if (!rest.trim()) {
      htmlBlock = false;
      return [line];
    }
    const simple = /^(\s*<(p|h[1-6])\b[^>]*>)(.*)(<\/\2>\s*)$/i.exec(rest);
    if (simple) return [quote + simple[1]!, ...inline(simple[3]!), simple[4]!];
    if (htmlBlock || BLOCK_HTML.test(start)) {
      htmlBlock = true;
      return [line];
    }
    // A thematic break, a table's delimiter row, a setext underline, a reference definition.
    const bare = rest.replace(/\s/g, '');
    if (
      /^(\*{3,}|-{3,}|_{3,})$/.test(bare) ||
      (/^[|:-]+$/.test(bare) && bare.includes('-') && bare.includes('|')) ||
      /^ {0,3}(=+|-+)[ \t]*$/.test(rest) ||
      REF_DEF.test(rest)
    ) return [line];
    if (start.startsWith('|')) {
      // A table row: each cell on its own, the pipes as they are.
      const pieces: (string | number)[] = [quote];
      let cell = '';
      let tick = 0;
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i]!;
        if (c === '\\' && i + 1 < rest.length) {
          cell += c + rest[++i];
          continue;
        }
        if (c === '`') tick = tick ? 0 : 1;
        if (c === '|' && !tick) {
          pieces.push(...inline(cell), '|');
          cell = '';
        } else cell += c;
      }
      pieces.push(...inline(cell));
      return pieces;
    }
    const head =
      /^(\s*#{1,6}[ \t]+)(.*)$/.exec(rest) ??
      /^(\s*\[![\w-]+(?:\|[\w-]+)?\][+-]?[ \t]?)(.*)$/.exec(quote ? rest : '') ??
      /^(\s*\[\^[^\]]+\]:[ \t]*)(.*)$/.exec(rest) ??
      /^(\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)(.*)$/.exec(rest) ??
      /^(\s*)([\s\S]*)$/.exec(rest)!;
    let body = head[2]!;
    let tail = '';
    // A comment that opens here and closes on a later line of the paragraph:
    // from it on, the line stays as it is (beta #239 item 5).
    const open = body.lastIndexOf('<!--');
    if (open >= 0 && body.indexOf('-->', open + 4) < 0 && commentEnd[idx + 1]! >= 0 && (blankAt[idx + 1]! < 0 || commentEnd[idx + 1]! < blankAt[idx + 1]!)) {
      comment = 'inline';
      return [quote + head[1]!, ...inline(body.slice(0, open)), body.slice(open)];
    }
    // A heading's closing hashes and a hard break's backslash stay as they are.
    if (head[1]!.includes('#')) {
      const t = body.trimEnd();
      let h = t.length;
      while (h > 0 && t[h - 1] === '#') h--;
      if (h < t.length && (t[h - 1] === ' ' || t[h - 1] === '\t')) {
        tail = body.slice(h);
        body = body.slice(0, h);
      }
    }
    if (body.endsWith('\\') && !body.endsWith('\\\\')) {
      tail = `\\${tail}`;
      body = body.slice(0, -1);
    }
    return [quote + head[1]!, ...inline(body), tail];
  };

  for (let idx = 0; idx < rows.length; idx++) {
    lines.push(row(idx));
    const rest = rests[idx]!;
    const blank = !rest.trim();
    if (!blank) inList = LIST_ITEM.test(rest) || (inList && indentOf(rest) > 0);
    blankBefore = blank;
  }
  return { lines, units };
}

/** The translated note: each unit's Markdown in its place. */
export function assemble(plan: Plan, done: readonly string[]): string {
  return plan.lines.map((pieces) => pieces.map((p) => (typeof p === 'number' ? done[p]! : p)).join('')).join('\n');
}

/** The words of a note for language detection, without any part. */
export function plainWords(plan: Plan, max = 2000): string {
  let out = '';
  for (const u of plan.units) {
    if (out.length >= max) break;
    out += `${u.plain.replace(/⟦\d+⟧/g, ' ')}\n`;
  }
  return out.slice(0, max);
}
