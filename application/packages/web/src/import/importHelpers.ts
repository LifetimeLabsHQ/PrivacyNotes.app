/**
 * Small readers more than one importer needs: zip paths, tags, dates, loose
 * JSON values, note-links and inline alignment. Each importer calls these
 * instead of keeping a copy (rule AD).
 */
import { escapeMarkdownText } from '../markdownEscape';
import { normalizeTag } from '../notesRepo';
import { noteLinkTarget } from '../noteLinks';
import { mapOutsideCode } from './codeSegments';
import {
  createLineIndex,
  scanAngleTokenEnd,
  scanCodeSpan,
  scanInlineMathEnd,
  scanMarkdownLink,
  scanNoteLinkEnd,
} from './linkify';

/** A zip entry that is never note content: macOS resource forks and dot files. */
export function isJunkEntry(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.startsWith('__macosx/') || lower.includes('/__macosx/')) return true;
  const name = path.split('/').pop() ?? '';
  if (name.startsWith('.')) return true;
  return false;
}

/** A zip entry name with the leading slashes and dot segments gone, or null for a path that climbs. */
export function cleanPath(path: string): string | null {
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/**
 * Tags through `normalizeTag`, deduplicated case-insensitively: "Dev" and
 * "dev" are one tag and the first spelling stays.
 */
export function normalizeTagList(rawTags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** A date string as ISO, or now when it is missing or unreadable. */
export function isoOrNow(s: string | undefined): string {
  if (!s) return new Date().toISOString();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

/** A finite number from loose JSON, else null. */
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A string from loose JSON, else empty. */
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Strips a leading UTF-8 BOM (written by Windows browsers and some exporters). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Indents every non-empty line with `prefix` (for Markdown list item continuations). */
export function indentLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : `${prefix}${line}`))
    .join('\n');
}

/**
 * A note-link to another note's title. The target goes through
 * `noteLinkTarget` because a real title can hold a pipe or a bracket, and
 * writing one raw produces a link that parses as a different target with
 * different text. The sanitized target still resolves: `noteLinkKey`
 * compares it to the note's real title through the same rule.
 * Spec: packages/web/src/noteLinks.ts
 */
export function noteLink(target: string, label: string): string {
  const t = noteLinkTarget(target);
  if (!t) {
    const raw = label.replace(/[[\]]/g, '').replace(/[\r\n]+/g, ' ').trim();
    return escapeMarkdownText(raw);
  }
  const l = label
    .replace(/\\([<>[\]])/g, '$1')
    .replace(/[[\]<>]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/=(?==)/g, '= ')
    .replace(/\|(?=\|)/g, '| ')
    .trim();
  if (!l || l === t) return `[[${t}]]`;
  return `[[${t}|${l}]]`;
}

/** An inline `text-align` other than the default, in an exported HTML style. */
export const ALIGN_RE = /text-align:\s*(center|right|justify)/i;

/** Escape raw `<script` / `</script` tags in prose so literal script tags stay text and never reach HTML parsing. */
const SCRIPT_TAG_RE = /<(\/?\s*script\b)/gi;
export function escapeScriptTags(prose: string): string {
  return prose.replace(SCRIPT_TAG_RE, '\\<$1');
}

/** Reject executable link or media schemes (`javascript:`, `vbscript:`, `data:`). */
export function isUnsafeUrl(url: string): boolean {
  const cleaned = url.replace(/[\u0000-\u0020]+/g, '');
  return /^(?:javascript|vbscript|data):/i.test(cleaned);
}

const UNESCAPED_DOLLAR_RE = /(?<!\\)((?:\\\\)*)\$/g;

function endsWithInlineMath(s: string): boolean {
  const len = s.length;
  if (len < 2 || s.charCodeAt(len - 1) !== 0x24) return false;
  const prev = s.charCodeAt(len - 2);
  return prev !== 0x5c && prev !== 0x24;
}

function startsWithDigitOrDollar(s: string): boolean {
  if (s.length === 0) return false;
  const ch = s.charCodeAt(0);
  return ch === 0x24 || (ch >= 0x30 && ch <= 0x39);
}

/**
 * Single-line LaTeX for `$...$` inline math: collapses line breaks, escapes
 * unescaped `$` delimiters so content stays inside the math token, breaks `==`
 * and pipe pairs (`||`, `\|\|`) so surrounding highlight or spoiler marks never
 * close early even after GFM table pipe un-escaping, and appends `{}` after a
 * trailing `\` or `\$` so the closing `$` stays clear of backslash escaping
 * and `$$` pairs.
 */
export function sanitizeInlineLatex(raw: string): string {
  const singleLine = raw.replace(/[\r\n]+/g, ' ').trim();
  if (!singleLine) return '';
  const escaped = singleLine
    .replace(UNESCAPED_DOLLAR_RE, '$1\\$')
    .replace(/=(?==)/g, '= ')
    .replace(/\|(?=(?:\\)*\|)/g, '| ');
  return escaped.endsWith('\\') || escaped.endsWith('\\$') ? `${escaped}{}` : escaped;
}

const UNESCAPED_PIPE_RE = /(?<!\\)((?:\\\\)*)\|/g;

function escapeUnescapedPipes(s: string): string {
  return s.includes('|') ? s.replace(UNESCAPED_PIPE_RE, '$1\\|') : s;
}

/**
 * Normalize a URL or relative path for placement inside `[label](target)` or
 * `![alt](target)` so whitespace, control characters, angle brackets, or
 * unbalanced parentheses never terminate the Markdown destination early.
 */
export function formatMarkdownLinkTarget(raw: string): string {
  const clean = raw.replace(/[\r\n\x00-\x1f\x7f]+/g, '').trim();
  if (!clean) return '';
  let depth = 0;
  let balanced = true;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean.charCodeAt(i);
    if (ch <= 0x20 || ch === 0x3c || ch === 0x3e) {
      balanced = false;
      break;
    }
    if (ch === 0x5c && i + 1 < clean.length) {
      if (clean.charCodeAt(i + 1) === 0x20) {
        balanced = false;
        break;
      }
      i++;
      continue;
    }
    if (ch === 0x28) {
      depth++;
      if (depth > 32) {
        balanced = false;
        break;
      }
    } else if (ch === 0x29) {
      if (depth === 0) {
        balanced = false;
        break;
      }
      depth--;
    }
  }
  const encodedMarks = clean.replace(/==/g, '=%3D').replace(/\|\|/g, '|%7C');
  if (balanced && depth === 0) return encodedMarks;
  return encodedMarks
    .replace(/ /g, '%20')
    .replace(/\t/g, '%09')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/** Prefix every `|` with a backslash without touching other backslashes inside code spans or LaTeX. */
function prefixPipesWithBackslash(text: string): string {
  if (!text.includes('|')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    out += ch === '|' ? '\\|' : ch;
  }
  return out;
}

/**
 * Escape pipes in a single-line GFM table cell. Markdown-it's table splitter
 * strips one backslash before every `\|` across the whole cell before inline
 * rules run: inline `$...$` math, backtick code spans, and escaped prose pipe
 * runs (`\|\|`, `\\\|`) therefore keep an extra backslash so LaTeX `\|x\|`
 * norms survive and `spoilerRule` never opens on typed `||`, while `[label](url)`
 * link destinations, `<...>` autolinks, HTML tags, and lone prose pipes emit a
 * single `\|` and advance past `$` in URLs or attributes before matching `$...$`.
 */
export function escapePipeCell(cellText: string): string {
  if (!cellText) return ' ';
  if (!cellText.includes('|')) return cellText;

  const len = cellText.length;
  const idx = createLineIndex(0, len, false);
  const destEndAtClose = new Map<number, number>();
  const closeBracketStack: number[] = [];
  let out = '';
  let pos = 0;

  while (pos < len) {
    while (
      closeBracketStack.length > 0 &&
      closeBracketStack[closeBracketStack.length - 1]! < pos
    ) {
      closeBracketStack.pop();
    }
    const ch = cellText.charCodeAt(pos);

    if (ch === 0x5c && pos + 1 < len) {
      const next = cellText.charCodeAt(pos + 1);
      if (next === 0x20) {
        out += '\\';
        pos++;
        continue;
      }
      if (
        next === 0x7c &&
        ((pos > 0 &&
          (cellText.charCodeAt(pos - 1) === 0x7c || cellText.charCodeAt(pos - 1) === 0x5c)) ||
          cellText.charCodeAt(pos + 2) === 0x7c ||
          (cellText.charCodeAt(pos + 2) === 0x5c && cellText.charCodeAt(pos + 3) === 0x7c))
      ) {
        out += '\\\\|';
      } else {
        out += cellText.slice(pos, pos + 2);
      }
      pos += 2;
      continue;
    }

    if (ch === 0x60) {
      const { closeEnd, afterOpen } = scanCodeSpan(cellText, pos, idx);
      if (closeEnd >= 0) {
        out += prefixPipesWithBackslash(cellText.slice(pos, closeEnd));
        pos = closeEnd;
      } else {
        out += cellText.slice(pos, afterOpen);
        pos = afterOpen;
      }
      continue;
    }

    if (ch === 0x5b) {
      const link = scanMarkdownLink(cellText, pos, idx);
      if (link) {
        destEndAtClose.set(link.closeBracket, link.linkEnd);
        closeBracketStack.push(link.closeBracket);
        out += '[';
        pos++;
        continue;
      }
      const bound =
        closeBracketStack.length > 0
          ? closeBracketStack[closeBracketStack.length - 1]!
          : len;
      const noteLinkEnd = scanNoteLinkEnd(cellText, pos, bound, idx);
      if (noteLinkEnd > pos) {
        out += escapeUnescapedPipes(cellText.slice(pos, noteLinkEnd));
        pos = noteLinkEnd;
        continue;
      }
      out += '[';
      pos++;
      continue;
    }

    if (ch === 0x5d) {
      const linkEnd = destEndAtClose.get(pos);
      if (linkEnd !== undefined) {
        if (closeBracketStack[closeBracketStack.length - 1] === pos) {
          closeBracketStack.pop();
        }
        out += `]${escapeUnescapedPipes(cellText.slice(pos + 1, linkEnd))}`;
        pos = linkEnd;
        continue;
      }
      out += ']';
      pos++;
      continue;
    }

    if (ch === 0x3c) {
      const tagEnd = scanAngleTokenEnd(cellText, pos, idx);
      if (tagEnd > pos) {
        out += escapeUnescapedPipes(cellText.slice(pos, tagEnd));
        pos = tagEnd;
        continue;
      }
      out += '<';
      pos++;
      continue;
    }

    if (ch === 0x24) {
      const bound =
        closeBracketStack.length > 0
          ? closeBracketStack[closeBracketStack.length - 1]!
          : len;
      const mathEnd = scanInlineMathEnd(cellText, pos, bound, idx);
      if (mathEnd > pos) {
        out += prefixPipesWithBackslash(cellText.slice(pos, mathEnd));
        pos = mathEnd;
        continue;
      }
      out += '$';
      pos++;
      continue;
    }

    if (ch === 0x7c) {
      out += '\\|';
      pos++;
      continue;
    }

    out += cellText[pos]!;
    pos++;
  }

  return out;
}

/**
 * Clamp an HTML `<ol start="...">` attribute to an integer in CommonMark's
 * 1..999_999_999 ordered-list marker range so every item stays a valid list
 * marker and never falls back to a paragraph or indented code block.
 */
export function orderedListStart(rawStart: string | null, itemCount: number): number {
  if (!rawStart) return 1;
  const parsed = Math.trunc(Number(rawStart));
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.max(1, Math.min(parsed, 999_999_999 - Math.max(0, itemCount - 1)));
}

/**
 * True when a rendered Markdown sublist cannot interrupt a preceding paragraph
 * without a blank line in CommonMark: an ordered list starting at a number
 * other than 1, or a list whose first item has no inline text after its marker.
 */
export function sublistNeedsBlankLine(sub: string): boolean {
  const nl = sub.indexOf('\n');
  const firstLine = (nl >= 0 ? sub.slice(0, nl) : sub).trimStart();
  const ordered = /^(\d+)[.)](?:\s|$)/.exec(firstLine);
  if (ordered && Number(ordered[1]) !== 1) return true;
  return /^(?:[-+*]|\d+[.)])\s*$/.test(firstLine);
}

/**
 * Multi-line LaTeX for `$$...$$` block math: escapes unescaped `$` delimiters
 * so an inner `$$` never closes the math block early.
 */
export function sanitizeBlockLatex(raw: string): string {
  const trimmed = raw.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return '';
  return trimmed.replace(UNESCAPED_DOLLAR_RE, '$1\\$');
}

const BRACKET_PREFIX_RE = /(?:[!^]|:(?:icon|logo|remind))$/;

/**
 * True when concatenating `before` and `next` without a space would fuse
 * `$...$` with a following digit/`$` or fuse `!`, `^`, `:icon`, `:logo`, or
 * `:remind` with a following `[label](url)` or `[[note-link]]`.
 */
export function needsInlineBoundarySpace(before: string, next: string): boolean {
  if (!before || !next) return false;
  if (endsWithInlineMath(before) && startsWithDigitOrDollar(next)) return true;
  if (next.charCodeAt(0) === 0x5b && BRACKET_PREFIX_RE.test(before)) {
    const suffixLen = before.endsWith(':remind')
      ? 7
      : before.endsWith(':icon') || before.endsWith(':logo')
        ? 5
        : 1;
    let bs = 0;
    let k = before.length - suffixLen - 1;
    while (k >= 0 && before.charCodeAt(k) === 0x5c) {
      bs++;
      k--;
    }
    if (bs % 2 === 0 || (before.endsWith('!') && next.startsWith('[['))) return true;
  }
  return false;
}

const INLINE_MARK_BLOCK_RE =
  /(?:^|\n)(?:(?:[ \t>]|[-+*] |\d+[.)] )*\$\$|[ \t]*(?:`{3,}|~{3,}|>|#{1,6}(?:[ \t]|$)|[-+*][ \t]+|\d+[.)][ \t]+|\||(?:---+|\*\*\*+|___+|===+)[ \t]*(?:\n|$)|<(?:table|h[1-6]|p|div|ul|ol|blockquote|pre|hr|details|figure)\b))/i;

/** True when `core` holds a paragraph break or Markdown block opener an inline mark must not wrap. */
export function containsMarkdownBlock(core: string): boolean {
  return /\n[ \t]*\n/.test(core) || INLINE_MARK_BLOCK_RE.test(core);
}

/** True when default highlight content cannot use `==...==` without breaking `highlightRule`. */
export function shouldUseHtmlMark(core: string): boolean {
  return (
    core.includes('==') ||
    core.includes('\n') ||
    core.startsWith('=') ||
    core.endsWith('=')
  );
}

/**
 * Append a converted Markdown fragment while inserting a space across math-digit
 * or bracket-prefix (`!`, `^`, `:icon`, `:logo`, `:remind` + `[`) boundaries.
 */
export function appendMathSafe(acc: string, next: string): string {
  if (!next) return acc;
  if (needsInlineBoundarySpace(acc, next)) {
    return `${acc} ${next}`;
  }
  return acc + next;
}

export function joinMathSafe(parts: readonly string[]): string {
  const out: string[] = [];
  let prev = '';
  for (const part of parts) {
    if (!part) continue;
    if (needsInlineBoundarySpace(prev, part)) {
      out.push(' ');
    }
    out.push(part);
    prev = part;
  }
  return out.join('');
}

/** A `<` that would open raw HTML: before a letter, `/`, `!` or `?`, and not
 *  an autolink (`<https://x.com>`, `<me@x.com>`), which stays a link. */
const TAG_OPEN_RE = /(?<!\\)<(?=[A-Za-z/!?])(?![A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|[^\s<>@]+@[^\s<>]+>)/g;

/**
 * Typed text that is Markdown already, with each `<` that would open an HTML
 * tag escaped. The editor reads raw HTML, so `<url>`, `<your-api-key>` or
 * `List<T>` is an unknown tag there: the word is not shown, and the next save
 * drops it. `a < b > c` needs nothing and is left as it is, and so are code
 * spans and fences. Run it on text only, before the importer adds its own
 * tags (`<u>`, `<sup>`). Beta #149.
 */
export function escapeTypedTags(md: string): string {
  return md.includes('<') ? mapOutsideCode(md, (prose) => prose.replace(TAG_OPEN_RE, '\\<')) : md;
}

interface FrontMatter {
  values: Map<string, string[]>;
  body: string;
}

function unquoteYaml(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // YAML's \U and \u escapes, which JSON does not have in that form.
    const yaml = s.replace(/\\U([0-9a-fA-F]{8})|\\u([0-9a-fA-F]{4})/g, (whole, long: string | undefined, short: string | undefined) => {
      const cp = parseInt(long ?? short ?? '', 16);
      return cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
    });
    if (yaml !== s) return yaml.slice(1, -1);
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* not JSON-shaped: strip the quotes only */
    }
    return s.slice(1, -1);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Flat YAML front matter, as Anytype and Capacities write it: `Key: value`,
 *  or `Key:` and a list of `- item` lines. A flow list `[a, b]` stays one
 *  value; the caller splits it. */
export function splitFrontMatter(text: string): FrontMatter {
  const values = new Map<string, string[]>();
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return { values, body: t };
  const end = t.indexOf('\n---\n', 3);
  const endAtEof = end < 0 && t.endsWith('\n---') ? t.length - 4 : -1;
  const stop = end >= 0 ? end : endAtEof;
  if (stop < 0) return { values, body: t };
  let key = '';
  for (const line of t.slice(4, stop).split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const item = /^\s+-\s?(.*)$/.exec(line);
    if (item && key) {
      values.get(key)!.push(unquoteYaml(item[1]!));
      continue;
    }
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1]!.trim();
    values.set(key, kv[2]!.trim() ? [unquoteYaml(kv[2]!)] : []);
  }
  return { values, body: t.slice(stop + 5) };
}
