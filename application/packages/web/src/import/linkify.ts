/**
 * Convert bare URLs and emails in a markdown body into `<...>` autolinks so
 * that tiptap-markdown's parser emits proper link nodes when the note loads.
 *
 * EVERY IMPORTER THAT PRODUCES A MARKDOWN NOTE BODY RUNS THIS, once, after
 * its parse: its exported parse is wrapped in `withBareLinks` (bareLinks.ts),
 * which passes every note whose body is Markdown through `linkifyMarkdown`
 * and says in one message how many notes it changed. It is not optional
 * polish - skipping it ships notes whose links are dead until the user puts a
 * caret behind each one and presses space. The failure is invisible in review
 * (the text looks right, it just is not a link), which is how the markdown
 * importer went without it from the start, and a per-branch call missed a
 * body path twice (standardNotes' converted checklists, bitwarden's
 * identities). One pass over the finished notes has no branch to miss, and
 * `tests/importerBareLinks.test.ts` fails for a registry entry whose parse
 * neither runs it nor is named there as exempt.
 *
 * The converters call this module themselves, because only they know which
 * text is literal as they write Markdown from HTML or plain text
 * (`linkifyLiteralText`), and count what they link: upnote, notesnook,
 * standardNotes (with standardNotesSuper), siyuan's .sy reader, googleJournal,
 * googleCalendar and raindrop (a bookmark's own notes, inside its JSON body).
 * Each still runs `linkifyMarkdown` on what it writes, as before.
 *
 * Never linked, and each for a reason that must be checked rather than
 * assumed:
 *   - structured bodies (a bookmark's JSON `{ url }`, a login's vault JSON, a
 *     contact card, a drawing, a file) consumed by forms, not markdown: the
 *     pass reads only the Markdown types (`MARKDOWN_BODY` in bareLinks.ts).
 *     Linkifying one would wrap a URL inside a JSON string value and corrupt
 *     the stored field.
 *   - `privacynotes.ts` - restores our OWN export, whose bodies were already
 *     serialized out of the editor with real link nodes. A restore should
 *     reproduce what was backed up, not rewrite it.
 *
 * Why this exists:
 *   TipTap's Link extension is configured with `autolink: true`, but
 *   that only fires while the user is typing - it scans the word behind
 *   the cursor on a word break. Content loaded into the editor from
 *   markdown storage is parsed by tiptap-markdown, which only creates
 *   link nodes for URLs that are already in `<...>` autolink syntax or
 *   `[text](url)` inline-link syntax. Bare URLs come in as plain text.
 *
 *   So when we import 552 Standard Notes notes, the user has to go into
 *   each note and press Enter after every URL to trigger autolink.
 *   Preprocessing the body to wrap bare URLs in `<...>` means they load
 *   as clickable links from the very first render. That's the whole
 *   "we make your URLs clickable" selling point we want to pitch.
 *
 * Safety:
 *   We skip regions that are already handled by markdown - fenced code
 *   blocks (both ``` and ~~~), inline code spans, existing markdown links,
 *   existing autolinks, and raw HTML tags. Plain text outside those regions
 *   is the only place we rewrite.
 *
 *   KNOWN GAP, deliberate: an INDENTED (4-space) code block is not skipped,
 *   so a URL inside one is linkified. Detecting it needs block-level parsing,
 *   because four spaces after a list item is list continuation rather than
 *   code, and a regex that guesses would silently stop linkifying real links
 *   inside lists. The failure it leaves is cosmetic (visible angle brackets in
 *   a code block) rather than corrupting, which is why it lost to the risk of
 *   the fix. An unclosed fence has the same shape and the same verdict. Both
 *   are locked in by tests so the behavior is visible rather than assumed.
 *
 *   Do not reason about these from what OUR serializer emits. This pass runs
 *   over markdown produced by other apps, so the input space is all of
 *   CommonMark, not the subset we happen to write.
 *
 * Protocol support: `http`, `https`, `mailto` - matches what the editor
 * recognizes. `www.` without a scheme is intentionally left alone
 * (too many false positives on things like "filename.txt").
 */

import { SUGGESTED_LINK_MARKER } from '../noteLinks';

// Bare URL matcher. Terminators: whitespace, angle brackets (would mean
// it's already an autolink), backticks (code span), double quotes, and
// control characters, which markdown refuses inside an autolink: the text
// after one would then be read as markdown.
// Trailing punctuation is trimmed in the replace callback.
const URL_RE = /(?:https?:\/\/|mailto:)[^\s<>`"\x00-\x1f\x7f]+/g;

/**
 * Bare email addresses, no `mailto:` prefix. Group 2 is the address; group 1
 * is the run of `.`, `+` and `-` in front of it, which stays text.
 *
 * The editor's Link extension autolinks these while typing (linkifyjs detects
 * them), so leaving them alone on import made the same address behave two
 * different ways depending on how it got into the note.
 *
 * Deliberately strict to keep false positives out: the domain must carry at
 * least one dot, which rules out `@media`, `@font-face`, `@user` handles and
 * npm scopes like `@tiptap/core`. Code spans and fences are already skipped by
 * the caller, so decorators and shell redirects never reach this.
 *
 * The lookbehind lets a match start only where a run of local-part characters
 * starts. `@` is not one of them, so every start inside one run reaches the
 * same `@` and only the first can match; letting the engine try the others
 * rescanned the run once per letter, which froze an import on a long
 * `a.a.a.` token. The address itself begins at the run's first word
 * character, where a word boundary would have put it.
 */
const EMAIL_RE = /(?<![\w.+-])([.+-]*)(\w[\w.+-]*@[\w-]+(?:\.[\w-]+)+\b)/g;

/**
 * Text this module's pass would rewrite: a bare URL or a bare email.
 *
 * Exported for the HTML-converting importers (upnote, notesnook), which
 * must NOT emit an aligned `<p style="text-align: ...">` HTML block around
 * text that linkify would touch: the `<...>` autolink it inserts reads as
 * a broken tag inside an HTML block and the address vanishes in the
 * editor. Those importers drop the alignment instead. Lives here so the
 * guard cannot drift from URL_RE / EMAIL_RE above.
 */
export const BARE_LINKABLE_RE = /(?:https?:\/\/|mailto:)|(?<![\w.+-])[.+-]*\w[\w.+-]*@[\w-]+(?:\.[\w-]+)+\b/;

// Punctuation characters that are almost never the final character of
// a real URL. `)` and `]` are handled separately because they can
// legitimately appear inside a URL (Wikipedia article names, query keys
// like `a[]`) - we balance them before stripping a trailing one.
//
// `*`, `_` and `~` are here because they are markdown's emphasis and
// strikethrough delimiters, and the URL matcher does not treat them as
// terminators. Without them `**https://example.com**` matched through the
// closing markers and emitted `**<https://example.com**>`, which breaks the
// link AND leaves the bold unclosed. A URL whose final character is genuinely
// one of these exists but is vanishingly rare, and losing that last character
// is a far smaller failure than corrupting the surrounding markdown.
const TRAILING_PUNCT_RE = /[.,;:!?"'}*_~]/;

type Span = { start: number; end: number };

interface BracketMatch {
  close: number;
  linkEnd: number;
  nested: boolean;
}

export interface LineIndex {
  lineStart: number;
  lineEnd: number;
  line: string | null;
  linkifyBareUrls: boolean;
  indexed: boolean;
  backtickLenAt: Map<number, number>;
  backtickRunsByLen: Map<number, number[]>;
  brackets: Map<number, BracketMatch>;
  lastCloseParen: number;
  noCloseParenUntil: number;
  lastCloseAngle: number;
  noCloseAngleUntil: number;
  lastDoubleCloseBracket: number;
  noDoubleCloseBracketUntil: number;
  blankNoteLinkFailUntil: number;
  lastUnescapedDollar: number;
  dollarScanPos: number;
  doubleQuoteFailUntil: number;
  singleQuoteFailUntil: number;
  tagDoubleQuoteFailUntil: number;
  tagSingleQuoteFailUntil: number;
  skipHtmlSpecial: boolean;
}

export function createLineIndex(
  lineStart: number,
  lineEnd: number,
  linkifyBareUrls = false,
): LineIndex {
  return {
    lineStart,
    lineEnd,
    line: null,
    linkifyBareUrls,
    indexed: false,
    backtickLenAt: new Map(),
    backtickRunsByLen: new Map(),
    brackets: new Map(),
    lastCloseParen: -1,
    noCloseParenUntil: -1,
    lastCloseAngle: -1,
    noCloseAngleUntil: -1,
    lastDoubleCloseBracket: -1,
    noDoubleCloseBracketUntil: -1,
    blankNoteLinkFailUntil: -1,
    lastUnescapedDollar: -1,
    dollarScanPos: lineStart,
    doubleQuoteFailUntil: -1,
    singleQuoteFailUntil: -1,
    tagDoubleQuoteFailUntil: -1,
    tagSingleQuoteFailUntil: -1,
    skipHtmlSpecial: false,
  };
}

function lineIndexOf(input: string, idx: LineIndex, needle: string, from: number): number {
  if (from >= idx.lineEnd) return -1;
  if (idx.line === null) idx.line = input.slice(idx.lineStart, idx.lineEnd);
  const rel = idx.line.indexOf(needle, Math.max(0, from - idx.lineStart));
  return rel < 0 ? -1 : idx.lineStart + rel;
}

function findNextRunAfter(runs: readonly number[], pos: number): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid]! <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo < runs.length ? runs[lo]! : -1;
}

/**
 * Match a `[[target]]` or `[[target|label]]` note-link (plus optional
 * `<!--suggested-->` suffix) starting at `input[pos] === '['` within `bound`,
 * mirroring `wikiLinkRule` (`NoteLink.tsx`) in O(1) amortized time.
 */
export function scanNoteLinkEnd(
  input: string,
  pos: number,
  bound: number,
  idx: LineIndex,
): number {
  if (pos + 3 >= bound || pos < idx.noDoubleCloseBracketUntil) return -1;
  if (input.charCodeAt(pos) !== 0x5b || input.charCodeAt(pos + 1) !== 0x5b) return -1;
  if (pos > 0 && input.charCodeAt(pos - 1) === 0x21) return -1;

  if (idx.lastDoubleCloseBracket < pos + 2) {
    idx.lastDoubleCloseBracket = lineIndexOf(input, idx, ']]', pos + 2);
    if (idx.lastDoubleCloseBracket < 0) {
      idx.noDoubleCloseBracketUntil = idx.lineEnd;
      return -1;
    }
  }
  const closeIdx = idx.lastDoubleCloseBracket;
  if (closeIdx + 2 > bound) return -1;
  if (pos + 2 <= idx.blankNoteLinkFailUntil) return -1;

  let k = pos + 2;
  while (k < closeIdx && /\s/.test(input[k]!)) k++;
  if (k >= closeIdx || input.charCodeAt(k) === 0x7c) {
    idx.blankNoteLinkFailUntil = k;
    return -1;
  }

  const end = closeIdx + 2;
  if (
    end + SUGGESTED_LINK_MARKER.length <= bound &&
    input.startsWith(SUGGESTED_LINK_MARKER, end)
  ) {
    return end + SUGGESTED_LINK_MARKER.length;
  }
  return end;
}

/**
 * Match `$...$` inline math starting at `input[pos] === '$'` within `bound`
 * (`bound <= idx.lineEnd`), mirroring `inlineMathRule` (`editorInlineSyntax.ts`)
 * in O(1) amortized time across the line.
 */
export function scanInlineMathEnd(
  input: string,
  pos: number,
  bound: number,
  idx: LineIndex,
): number {
  const start = pos + 1;
  if (start >= bound) return -1;
  if (input.charCodeAt(start) === 0x24 || /\s/.test(input[start]!)) return -1;

  if (idx.lastUnescapedDollar < start) {
    let q = Math.max(start, idx.dollarScanPos);
    while (q < idx.lineEnd) {
      if (input.charCodeAt(q) === 0x24 && input.charCodeAt(q - 1) !== 0x5c) {
        break;
      }
      q++;
    }
    idx.dollarScanPos = q + 1;
    idx.lastUnescapedDollar = q;
  }

  const end = idx.lastUnescapedDollar;
  if (end <= start || end >= bound) return -1;
  if (/\s/.test(input[end - 1]!) || /\d/.test(input[end + 1] ?? '')) return -1;
  return end + 1;
}

function tryScanLinkDest(input: string, openParen: number, idx: LineIndex): number {
  const { lineEnd } = idx;
  if (openParen >= lineEnd || input.charCodeAt(openParen) !== 0x28) return -1;
  if (openParen < idx.noCloseParenUntil) return -1;
  if (idx.lastCloseParen <= openParen) {
    idx.lastCloseParen = lineIndexOf(input, idx, ')', openParen + 1);
    if (idx.lastCloseParen < 0) {
      idx.noCloseParenUntil = lineEnd;
      return -1;
    }
  }
  return scanLinkDestinationEnd(input, openParen, idx);
}

function bareUrlPrefixLen(input: string, pos: number): number {
  const ch = input.charCodeAt(pos);
  if (ch === 0x68) {
    if (input.startsWith('https://', pos)) return 8;
    if (input.startsWith('http://', pos)) return 7;
  } else if (ch === 0x6d && input.startsWith('mailto:', pos)) {
    return 7;
  }
  return 0;
}

function scanBareUrlDuringIndex(
  input: string,
  pos: number,
  lineStart: number,
  lineEnd: number,
): number {
  const prefixLen = bareUrlPrefixLen(input, pos);
  if (prefixLen === 0) return -1;
  let end = pos + prefixLen;
  while (end < lineEnd) {
    const c = input.charCodeAt(end);
    if (c <= 0x20 || c === 0x7f || c === 0x3c || c === 0x3e || c === 0x60 || c === 0x22) {
      break;
    }
    if (c === 0x21 && end + 1 < lineEnd && input.charCodeAt(end + 1) === 0x5b) break;
    if (c === 0x5b) {
      if (
        end + 1 < lineEnd &&
        input.charCodeAt(end + 1) === 0x5d &&
        (end + 2 >= lineEnd || input.charCodeAt(end + 2) !== 0x28)
      ) {
        end += 2;
        continue;
      }
      break;
    }
    end++;
  }
  if (end === pos + prefixLen) return -1;
  const rawMatch = input.slice(pos, end);
  let inHighlight = false;
  if (rawMatch.endsWith('==')) {
    inHighlight = (input.slice(lineStart, pos).match(/==/g)?.length ?? 0) % 2 === 1;
  }
  const { url } = trimUrl(rawMatch, inHighlight);
  return url.length > 0 ? pos + url.length : -1;
}

function ensureLineIndexed(input: string, idx: LineIndex): void {
  if (idx.indexed) return;
  idx.indexed = true;
  const { lineStart, lineEnd } = idx;

  // Index every maximal contiguous backtick run on the line so `scanCodeSpan`
  // can find CommonMark's matching closing run in logarithmic time. When a run
  // starts right after `\`, `escape` consumes the first backtick and `backticks`
  // opens on the remaining `ticks - 1` backticks starting at `i + 1`.
  let i = lineStart;
  while (i < lineEnd) {
    if (input.charCodeAt(i) === 0x60) {
      let p = i + 1;
      while (p < lineEnd && input.charCodeAt(p) === 0x60) p++;
      const ticks = p - i;
      idx.backtickLenAt.set(i, ticks);
      if (ticks > 1 && i > lineStart && input.charCodeAt(i - 1) === 0x5c) {
        idx.backtickLenAt.set(i + 1, ticks - 1);
      }
      let list = idx.backtickRunsByLen.get(ticks);
      if (!list) {
        list = [];
        idx.backtickRunsByLen.set(ticks, list);
      }
      list.push(i);
      i = p;
      continue;
    }
    i++;
  }

  // Pair `[` / `![` with `](destination)` in left-to-right token precedence
  // order, skipping escapes, code spans, `[[...]]` note-links, `<...>` HTML
  // tags/autolinks, `$...$` inline math, and completed link destinations, while
  // enforcing CommonMark's rule against nested links inside link labels.
  const stack: {
    open: number;
    isImage: boolean;
    nested: boolean;
    hasInnerLink: boolean;
  }[] = [];
  i = lineStart;
  while (i < lineEnd) {
    const ch = input.charCodeAt(i);
    if (ch === 0x5c && i + 1 < lineEnd) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x20) {
        i++;
        continue;
      }
      if (next === 0x5d && stack.length > 0) {
        stack[stack.length - 1]!.nested = true;
      }
      i += 2;
      continue;
    }
    if (ch === 0x60) {
      const { closeEnd, afterOpen } = scanCodeSpan(input, i, idx);
      i = closeEnd >= 0 ? closeEnd : afterOpen;
      continue;
    }
    if (ch === 0x21 && i + 1 < lineEnd && input.charCodeAt(i + 1) === 0x5b) {
      if (stack.length > 0) stack[stack.length - 1]!.nested = true;
      stack.push({
        open: i + 1,
        isImage: true,
        nested: false,
        hasInnerLink: false,
      });
      i += 2;
      continue;
    }
    if (ch === 0x5b) {
      const noteLinkEnd = scanNoteLinkEnd(input, i, lineEnd, idx);
      if (noteLinkEnd > i) {
        const closeAfter = input.startsWith(
          SUGGESTED_LINK_MARKER,
          noteLinkEnd - SUGGESTED_LINK_MARKER.length,
        )
          ? noteLinkEnd - SUGGESTED_LINK_MARKER.length
          : noteLinkEnd;
        const canOuterLink =
          (stack.length === 0 || stack[stack.length - 1]!.isImage) &&
          input.charCodeAt(i + 2) !== 0x5b &&
          !input.slice(i + 2, closeAfter - 2).includes('[') &&
          tryScanLinkDest(input, closeAfter, idx) > 0;
        if (!canOuterLink) {
          if (stack.length > 0 && !stack[stack.length - 1]!.isImage) {
            stack[stack.length - 1]!.hasInnerLink = true;
          }
          i = noteLinkEnd;
          continue;
        }
      }
      if (stack.length > 0) stack[stack.length - 1]!.nested = true;
      stack.push({
        open: i,
        isImage: false,
        nested: false,
        hasInnerLink: false,
      });
      i++;
      continue;
    }
    if (ch === 0x5d) {
      if (stack.length > 0) {
        const top = stack.pop()!;
        if (stack.length > 0 && top.nested) {
          stack[stack.length - 1]!.nested = true;
        }
        const canFormLink = top.isImage || !top.hasInnerLink;
        const linkEnd = canFormLink ? tryScanLinkDest(input, i + 1, idx) : -1;
        if (linkEnd > 0) {
          idx.brackets.set(top.open, { close: i, linkEnd, nested: top.nested });
          if (!top.isImage && stack.length > 0) {
            stack[stack.length - 1]!.hasInnerLink = true;
          }
          i = linkEnd;
          continue;
        }
        if (!top.isImage && top.hasInnerLink && stack.length > 0) {
          stack[stack.length - 1]!.hasInnerLink = true;
        }
      }
      i++;
      continue;
    }
    if (ch === 0x3c) {
      const tagEnd = scanAngleTokenEnd(input, i, idx, false);
      i = tagEnd > i ? tagEnd : i + 1;
      continue;
    }
    if (idx.linkifyBareUrls && stack.length === 0 && (ch === 0x68 || ch === 0x6d)) {
      const bareEnd = scanBareUrlDuringIndex(input, i, lineStart, lineEnd);
      if (bareEnd > i) {
        i = bareEnd;
        continue;
      }
    }
    if (ch === 0x24) {
      const mathEnd = scanInlineMathEnd(input, i, lineEnd, idx);
      i = mathEnd > i ? mathEnd : i + 1;
      continue;
    }
    i++;
  }

  idx.lastCloseParen = -1;
  idx.lastCloseAngle = -1;
  idx.lastDoubleCloseBracket = -1;
  idx.blankNoteLinkFailUntil = -1;
  idx.lastUnescapedDollar = -1;
  idx.dollarScanPos = lineStart;
  idx.skipHtmlSpecial = false;
}

/**
 * If `input[pos]` opens an unescaped CommonMark inline code span on `idx`'s
 * line, return the index right after its matching closing backtick run; else
 * return `closeEnd: -1` and `afterOpen` past the opening run.
 */
export function scanCodeSpan(
  input: string,
  pos: number,
  idx: LineIndex,
): { closeEnd: number; afterOpen: number } {
  ensureLineIndexed(input, idx);
  const ticks = idx.backtickLenAt.get(pos);
  if (ticks === undefined) return { closeEnd: -1, afterOpen: pos + 1 };
  const runs = idx.backtickRunsByLen.get(ticks);
  const matchStart = runs ? findNextRunAfter(runs, pos) : -1;
  if (matchStart >= 0) {
    return { closeEnd: matchStart + ticks, afterOpen: pos + ticks };
  }
  return { closeEnd: -1, afterOpen: pos + ticks };
}

function scanLinkDestinationEnd(input: string, openParen: number, idx: LineIndex): number {
  const { lineEnd } = idx;
  let k = openParen + 1;
  while (k < lineEnd && (input[k] === ' ' || input[k] === '\t')) k++;
  if (k >= lineEnd) return -1;

  if (input.charCodeAt(k) === 0x3c) {
    k++;
    while (k < lineEnd) {
      const ch = input.charCodeAt(k);
      if (ch === 0x3c) return -1;
      if (ch === 0x3e) {
        k++;
        break;
      }
      if (ch === 0x5c && k + 1 < lineEnd) {
        k += 2;
        continue;
      }
      k++;
    }
    if (k > lineEnd || input.charCodeAt(k - 1) !== 0x3e) return -1;
  } else {
    let depth = 0;
    while (k < lineEnd) {
      const ch = input.charCodeAt(k);
      if (ch <= 0x20 || ch === 0x7f) break;
      if (ch === 0x5c && k + 1 < lineEnd) {
        if (input.charCodeAt(k + 1) === 0x20) {
          k++;
          break;
        }
        k += 2;
        continue;
      }
      if (ch === 0x28) {
        depth++;
        if (depth > 32) return -1;
      } else if (ch === 0x29) {
        if (depth === 0) return k + 1;
        depth--;
      }
      k++;
    }
    if (depth !== 0) return -1;
  }

  const afterDest = k;
  while (k < lineEnd && (input[k] === ' ' || input[k] === '\t')) k++;
  if (k < lineEnd && input.charCodeAt(k) === 0x29) return k + 1;
  if (k === afterDest || k >= lineEnd) return -1;
  const quote = input.charCodeAt(k);
  if (quote !== 0x22 && quote !== 0x27 && quote !== 0x28) return -1;
  if (quote === 0x22 && k < idx.doubleQuoteFailUntil) return -1;
  if (quote === 0x27 && k < idx.singleQuoteFailUntil) return -1;
  const closeMarker = quote === 0x28 ? 0x29 : quote;
  k++;
  while (k < lineEnd) {
    const ch = input.charCodeAt(k);
    if (ch === closeMarker) {
      k++;
      while (k < lineEnd && (input[k] === ' ' || input[k] === '\t')) k++;
      return k < lineEnd && input.charCodeAt(k) === 0x29 ? k + 1 : -1;
    }
    if (quote === 0x28 && ch === 0x28) return -1;
    if (ch === 0x5c && k + 1 < lineEnd) {
      k += 2;
      continue;
    }
    k++;
  }
  if (quote === 0x22) idx.doubleQuoteFailUntil = lineEnd;
  else if (quote === 0x27) idx.singleQuoteFailUntil = lineEnd;
  return -1;
}

/**
 * Match `[label](destination)` starting at `input[pos] === '['` in O(1)
 * amortized time using `idx`'s pre-indexed bracket pairs.
 */
export function scanMarkdownLink(
  input: string,
  pos: number,
  idx: LineIndex,
): { closeBracket: number; linkEnd: number; nested: boolean } | null {
  ensureLineIndexed(input, idx);
  const match = idx.brackets.get(pos);
  if (!match) return null;
  return { closeBracket: match.close, linkEnd: match.linkEnd, nested: match.nested };
}

const SCHEME_AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)>$/;
const EMAIL_AUTOLINK_RE =
  /^<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*>$/;
const BAD_AUTOLINK_PROTO_RE = /^(?:vbscript|javascript|file|data):/i;
const DATA_IMAGE_AUTOLINK_RE = /^data:image\/(?:gif|png|jpeg|webp);/i;

function isAsciiLetter(ch: number): boolean {
  const lc = ch | 0x20;
  return lc >= 0x61 && lc <= 0x7a;
}

function isMarkdownAutolink(slice: string): boolean {
  if (EMAIL_AUTOLINK_RE.test(slice)) return true;
  if (!SCHEME_AUTOLINK_RE.test(slice)) return false;
  const inner = slice.slice(1, -1);
  return !BAD_AUTOLINK_PROTO_RE.test(inner) || DATA_IMAGE_AUTOLINK_RE.test(inner);
}

function parseSpecialHtmlHeader(
  input: string,
  pos: number,
  limit: number,
): { immediateEnd: number; start: number; terminator: string } | null {
  if (pos + 2 >= limit) return null;
  const c1 = input.charCodeAt(pos + 1);
  if (c1 === 0x21) {
    if (input.startsWith('<!--', pos)) {
      if (pos + 5 <= limit && input.startsWith('>', pos + 4)) {
        return { immediateEnd: pos + 5, start: -1, terminator: '' };
      }
      if (pos + 6 <= limit && input.startsWith('->', pos + 4)) {
        return { immediateEnd: pos + 6, start: -1, terminator: '' };
      }
      return { immediateEnd: -1, start: pos + 4, terminator: '-->' };
    }
    if (input.startsWith('<![CDATA[', pos)) {
      return { immediateEnd: -1, start: pos + 9, terminator: ']]>' };
    }
    if (isAsciiLetter(input.charCodeAt(pos + 2))) {
      return { immediateEnd: -1, start: pos + 3, terminator: '>' };
    }
    return null;
  }
  if (c1 === 0x3f) {
    return { immediateEnd: -1, start: pos + 2, terminator: '?>' };
  }
  return null;
}

function scanSpecialHtmlLineEnd(input: string, pos: number, idx: LineIndex): number {
  const spec = parseSpecialHtmlHeader(input, pos, idx.lineEnd);
  if (!spec) return -1;
  if (spec.immediateEnd > 0) return spec.immediateEnd;
  if (spec.start > idx.lineEnd || idx.skipHtmlSpecial) return -1;
  const end = lineIndexOf(input, idx, spec.terminator, spec.start);
  if (end < 0) {
    idx.skipHtmlSpecial = true;
    return -1;
  }
  return end + spec.terminator.length;
}

function scanHtmlTagEnd(input: string, pos: number, idx: LineIndex): number {
  const { lineEnd } = idx;
  let k = pos + 1;
  if (k >= lineEnd) return -1;
  const closing = input.charCodeAt(k) === 0x2f;
  if (closing) k++;
  if (k >= lineEnd) return -1;
  const first = input.charCodeAt(k);
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) return -1;
  k++;
  while (k < lineEnd) {
    const c = input.charCodeAt(k);
    if (
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x2d
    ) {
      k++;
    } else {
      break;
    }
  }
  if (closing) {
    while (k < lineEnd && (input[k] === ' ' || input[k] === '\t')) k++;
    return k < lineEnd && input.charCodeAt(k) === 0x3e ? k + 1 : -1;
  }
  while (k < lineEnd) {
    const wsStart = k;
    while (k < lineEnd && (input[k] === ' ' || input[k] === '\t')) k++;
    if (k >= lineEnd) return -1;
    const ch = input.charCodeAt(k);
    if (ch === 0x3e) return k + 1;
    if (ch === 0x2f) {
      return k + 1 < lineEnd && input.charCodeAt(k + 1) === 0x3e ? k + 2 : -1;
    }
    if (k === wsStart) return -1;
    if (
      !((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || ch === 0x5f || ch === 0x3a)
    ) {
      return -1;
    }
    k++;
    while (k < lineEnd) {
      const ac = input.charCodeAt(k);
      if (
        (ac >= 0x41 && ac <= 0x5a) ||
        (ac >= 0x61 && ac <= 0x7a) ||
        (ac >= 0x30 && ac <= 0x39) ||
        ac === 0x5f ||
        ac === 0x2e ||
        ac === 0x3a ||
        ac === 0x2d
      ) {
        k++;
      } else {
        break;
      }
    }
    const afterName = k;
    while (k < lineEnd && (input[k] === ' ' || input[k] === '\t')) k++;
    if (k >= lineEnd || input.charCodeAt(k) !== 0x3d) {
      k = afterName;
      continue;
    }
    k++;
    while (k < lineEnd && (input[k] === ' ' || input[k] === '\t')) k++;
    if (k >= lineEnd) return -1;
    const vc = input.charCodeAt(k);
    if (vc === 0x22) {
      if (k < idx.tagDoubleQuoteFailUntil) return -1;
      const closeQ = lineIndexOf(input, idx, '"', k + 1);
      if (closeQ < 0) {
        idx.tagDoubleQuoteFailUntil = lineEnd;
        return -1;
      }
      k = closeQ + 1;
    } else if (vc === 0x27) {
      if (k < idx.tagSingleQuoteFailUntil) return -1;
      const closeQ = lineIndexOf(input, idx, "'", k + 1);
      if (closeQ < 0) {
        idx.tagSingleQuoteFailUntil = lineEnd;
        return -1;
      }
      k = closeQ + 1;
    } else {
      const valStart = k;
      while (k < lineEnd) {
        const uc = input.charCodeAt(k);
        if (
          uc <= 0x20 ||
          uc === 0x22 ||
          uc === 0x27 ||
          uc === 0x3d ||
          uc === 0x3c ||
          uc === 0x3e ||
          uc === 0x60
        ) {
          break;
        }
        k++;
      }
      if (k === valStart) return -1;
    }
  }
  return -1;
}

/**
 * Match an autolink (`<scheme:...>`, `<me@example.com>`) or CommonMark inline
 * HTML token (`<tag...>`, `</tag>`, `<!--...-->`, `<?...?>`, `<![CDATA[...]]>`,
 * `<![A-Za-z]...>` ) starting at `input[pos] === '<'` in linear time. When
 * `escapedOpen` is true (`\<`), special HTML constructs are rejected and any
 * `$`, `` ` ``, `[`, or `]` disqualifies it so escaped prose angle brackets
 * never swallow following syntax.
 */
export function scanAngleTokenEnd(
  input: string,
  pos: number,
  idx: LineIndex,
  escapedOpen = false,
): number {
  const { lineEnd } = idx;
  if (pos + 2 >= lineEnd) return -1;
  const c1 = input.charCodeAt(pos + 1);
  if (c1 <= 0x20 || c1 === 0x3c || c1 === 0x3e) return -1;
  if (!escapedOpen && (c1 === 0x21 || c1 === 0x3f)) {
    return scanSpecialHtmlLineEnd(input, pos, idx);
  }
  if (pos < idx.noCloseAngleUntil) return -1;
  if (idx.lastCloseAngle <= pos) {
    idx.lastCloseAngle = lineIndexOf(input, idx, '>', pos + 1);
    if (idx.lastCloseAngle < 0) {
      idx.noCloseAngleUntil = lineEnd;
      return -1;
    }
  }
  const tagEnd = scanHtmlTagEnd(input, pos, idx);
  if (tagEnd > pos) {
    if (escapedOpen && /[$`[\]]/.test(input.slice(pos, tagEnd))) return -1;
    return tagEnd;
  }
  const gt = idx.lastCloseAngle;
  if (gt - pos > 2048) return -1;
  const slice = input.slice(pos, gt + 1);
  if (escapedOpen && /[$`[\]]/.test(slice)) return -1;
  return isMarkdownAutolink(slice) ? gt + 1 : -1;
}

function isBlockMathPrefix(input: string, start: number, end: number): boolean {
  let k = start;
  while (k < end) {
    const c = input.charCodeAt(k);
    if (c === 0x20 || c === 0x09 || c === 0x3e) {
      k++;
      continue;
    }
    if (
      (c === 0x2d || c === 0x2b || c === 0x2a) &&
      k + 1 < end &&
      (input.charCodeAt(k + 1) === 0x20 || input.charCodeAt(k + 1) === 0x09)
    ) {
      k += 2;
      while (k < end && (input.charCodeAt(k) === 0x20 || input.charCodeAt(k) === 0x09)) k++;
      if (
        k + 3 < end &&
        input.charCodeAt(k) === 0x5b &&
        (input.charCodeAt(k + 1) === 0x20 ||
          input.charCodeAt(k + 1) === 0x78 ||
          input.charCodeAt(k + 1) === 0x58) &&
        input.charCodeAt(k + 2) === 0x5d &&
        (input.charCodeAt(k + 3) === 0x20 || input.charCodeAt(k + 3) === 0x09)
      ) {
        k += 4;
      }
      continue;
    }
    if (c >= 0x30 && c <= 0x39) {
      let d = k + 1;
      while (d < end && input.charCodeAt(d) >= 0x30 && input.charCodeAt(d) <= 0x39) d++;
      if (
        d + 1 < end &&
        (input.charCodeAt(d) === 0x2e || input.charCodeAt(d) === 0x29) &&
        (input.charCodeAt(d + 1) === 0x20 || input.charCodeAt(d + 1) === 0x09)
      ) {
        k = d + 2;
        continue;
      }
    }
    return false;
  }
  return true;
}

function skipQuotePrefix(input: string, start: number, end: number): number {
  let k = start;
  while (k < end) {
    let sp = 0;
    while (sp < 3 && k + sp < end && input.charCodeAt(k + sp) === 0x20) sp++;
    if (k + sp < end && input.charCodeAt(k + sp) === 0x3e) {
      k += sp + 1;
      if (k < end && (input.charCodeAt(k) === 0x20 || input.charCodeAt(k) === 0x09)) k++;
    } else {
      break;
    }
  }
  return k;
}

function isBlankOrQuoteBlank(input: string, start: number, end: number): boolean {
  let k = skipQuotePrefix(input, start, end);
  while (k < end) {
    const c = input.charCodeAt(k);
    if (c !== 0x20 && c !== 0x09) return false;
    k++;
  }
  return true;
}

type HtmlBlockKind = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const HTML_BLOCK_TYPE1_OPEN_RE = /^<(?:script|pre|style|textarea)(?=[\s>]|$)/i;
const HTML_BLOCK_TYPE1_CLOSE_RE = /<\/(?:script|pre|style|textarea)>/i;

const HTML_BLOCK_TAG_RE =
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s>]|\/?>|$)/i;

function detectHtmlBlockStart(input: string, start: number, end: number): HtmlBlockKind {
  let k = skipQuotePrefix(input, start, end);
  let sp = 0;
  while (sp < 4 && k < end && input.charCodeAt(k) === 0x20) {
    k++;
    sp++;
  }
  if (sp >= 4 || k >= end || input.charCodeAt(k) !== 0x3c) return 0;
  if (k + 1 >= end) return 0;
  const c1 = input.charCodeAt(k + 1);
  if (c1 === 0x21) {
    if (input.startsWith('<!--', k)) return 2;
    if (input.startsWith('<![CDATA[', k)) return 5;
    if (k + 2 < end && isAsciiLetter(input.charCodeAt(k + 2))) return 4;
    return 0;
  }
  if (c1 === 0x3f) return 3;
  const head = input.slice(k, Math.min(end, k + 24));
  if (HTML_BLOCK_TYPE1_OPEN_RE.test(head)) return 1;
  if (HTML_BLOCK_TAG_RE.test(head)) return 6;
  return 0;
}

function htmlBlockClosesOnLine(kind: HtmlBlockKind, lineSlice: string): boolean {
  switch (kind) {
    case 1:
      return HTML_BLOCK_TYPE1_CLOSE_RE.test(lineSlice);
    case 2:
      return lineSlice.includes('-->');
    case 3:
      return lineSlice.includes('?>');
    case 4:
      return lineSlice.includes('>');
    case 5:
      return lineSlice.includes(']]>');
    default:
      return false;
  }
}

function nestedLinkNeedsOuterSkip(destSlice: string): boolean {
  const inner = destSlice.slice(1, -1);
  if (!inner || inner.endsWith('==')) return true;
  if (inner.includes('$') || /[\s"'<>\\`\x00-\x1f\x7f]/.test(inner)) return true;
  if (!/^(?:https?:\/\/|mailto:)/i.test(inner)) return true;
  return trimUrl(inner, false).trailing !== '';
}

function scanEscapedBracketPseudoLink(
  input: string,
  backslashPos: number,
  lineEnd: number,
): number {
  const labelLimit = Math.min(lineEnd, backslashPos + 2048);
  let j = backslashPos + 2;
  while (j < labelLimit) {
    const c = input.charCodeAt(j);
    if (c === 0x5c && j + 1 < lineEnd) {
      const next = input.charCodeAt(j + 1);
      if (next === 0x5b) return -1;
      if (next === 0x5d) {
        if (j + 2 >= lineEnd || input.charCodeAt(j + 2) !== 0x28) return -1;
        const destLimit = Math.min(lineEnd, j + 2051);
        let k = j + 3;
        while (k < destLimit) {
          const dc = input.charCodeAt(k);
          if (dc === 0x29) return k > j + 3 ? k + 1 : -1;
          if (
            (dc < 0x20 && dc !== 0x09) ||
            dc === 0x7f ||
            dc === 0x24 ||
            dc === 0x5b ||
            dc === 0x5d ||
            dc === 0x28 ||
            dc === 0x3c ||
            dc === 0x3e ||
            dc === 0x60 ||
            dc === 0x5c
          ) {
            return -1;
          }
          k++;
        }
        return -1;
      }
      j += 2;
      continue;
    }
    if (c === 0x5b || c === 0x5d || c === 0x60 || c === 0x3c || c === 0x24) return -1;
    j++;
  }
  return -1;
}

function scanBareUrlInSegment(input: string, pos: number, idx: LineIndex): number {
  const prefixLen = bareUrlPrefixLen(input, pos);
  if (prefixLen === 0) return -1;
  const { lineStart, lineEnd } = idx;
  let end = pos + prefixLen;
  while (end < lineEnd) {
    const c = input.charCodeAt(end);
    if (c <= 0x20 || c === 0x7f || c === 0x3c || c === 0x3e || c === 0x60 || c === 0x22) {
      break;
    }
    if (c === 0x21 && end + 1 < lineEnd && input.charCodeAt(end + 1) === 0x5b) {
      ensureLineIndexed(input, idx);
      if (idx.brackets.has(end + 1)) break;
    } else if (c === 0x5b) {
      ensureLineIndexed(input, idx);
      if (idx.brackets.has(end) || scanNoteLinkEnd(input, end, lineEnd, idx) > end) {
        break;
      }
    }
    end++;
  }
  if (end === pos + prefixLen) return -1;
  const rawMatch = input.slice(pos, end);
  let inHighlight = false;
  if (rawMatch.endsWith('==')) {
    inHighlight = (input.slice(lineStart, pos).match(/==/g)?.length ?? 0) % 2 === 1;
  }
  const { url } = trimUrl(rawMatch, inHighlight);
  return url.length > 0 ? pos + url.length : -1;
}

function extendMathSpanPastEnclosingHtmlTag(
  input: string,
  from: number,
  mathEnd: number,
  idx: LineIndex,
): number {
  let lt = from;
  while (lt < mathEnd) {
    if (
      input.charCodeAt(lt) === 0x3c &&
      (lt === idx.lineStart || input.charCodeAt(lt - 1) !== 0x5c)
    ) {
      const tagEnd = scanHtmlTagEnd(input, lt, idx);
      if (tagEnd > mathEnd) {
        return /[[`$\]]/.test(input.slice(mathEnd, tagEnd)) ? mathEnd : tagEnd;
      }
      if (tagEnd > lt) {
        lt = tagEnd;
        continue;
      }
    }
    lt++;
  }
  return mathEnd;
}

function findParagraphEnd(input: string, fromLineEnd: number, segEnd: number): number {
  let p = fromLineEnd;
  while (p < segEnd && input.charCodeAt(p) === 0x0a) {
    const lineStart = p + 1;
    const nl = input.indexOf('\n', lineStart);
    const lEnd = nl < 0 || nl > segEnd ? segEnd : nl;
    if (
      isBlankOrQuoteBlank(input, lineStart, lEnd) ||
      detectHtmlBlockStart(input, lineStart, lEnd) !== 0
    ) {
      return p;
    }
    p = lEnd;
  }
  return p;
}

/**
 * Scan `[segStart, segEnd)` left-to-right outside fenced code blocks to collect
 * CommonMark HTML blocks, inline code spans, `[label](url)` links, `[[...]]`
 * note-links, `<...>` autolinks, raw HTML tags/comments, `$$...$$` block math,
 * and `$...$` inline math in markdown-it's precedence order so `$` inside code,
 * links, note-links, autolinks, bare URLs, comments, or tag attributes never
 * pairs with a following `$...$` equation.
 */
function scanSegmentSkips(input: string, segStart: number, segEnd: number, out: Span[]): void {
  let pos = segStart;
  let lineEnd = -1;
  let idx = createLineIndex(segStart, segStart, true);
  let noBlockMathClose = false;
  let escapedAngleAt = -1;
  let htmlBlockKind: HtmlBlockKind = 0;
  let paraEnd = -1;
  let paraSkipHtmlSpecial = false;

  const refreshLine = (atLineStart: boolean) => {
    const nl = input.indexOf('\n', pos);
    lineEnd = nl < 0 || nl > segEnd ? segEnd : nl;
    const actualStart = atLineStart
      ? pos
      : Math.max(segStart, input.lastIndexOf('\n', pos - 1) + 1);
    idx = createLineIndex(actualStart, lineEnd, true);
    escapedAngleAt = -1;
    if (!atLineStart) return;
    if (htmlBlockKind !== 0) {
      if (htmlBlockKind === 6 && isBlankOrQuoteBlank(input, pos, lineEnd)) {
        htmlBlockKind = 0;
        paraEnd = -1;
        paraSkipHtmlSpecial = false;
      } else {
        out.push({ start: pos, end: lineEnd });
        if (htmlBlockKind !== 6 && htmlBlockClosesOnLine(htmlBlockKind, input.slice(pos, lineEnd))) {
          htmlBlockKind = 0;
        }
        pos = lineEnd;
      }
      return;
    }
    if (isBlankOrQuoteBlank(input, pos, lineEnd)) {
      paraEnd = -1;
      paraSkipHtmlSpecial = false;
      return;
    }
    const kind = detectHtmlBlockStart(input, pos, lineEnd);
    if (kind !== 0) {
      paraEnd = -1;
      paraSkipHtmlSpecial = false;
      out.push({ start: pos, end: lineEnd });
      if (kind === 6 || !htmlBlockClosesOnLine(kind, input.slice(pos, lineEnd))) {
        htmlBlockKind = kind;
      }
      pos = lineEnd;
    }
  };
  refreshLine(segStart === 0 || input.charCodeAt(segStart - 1) === 0x0a);

  while (pos < segEnd) {
    if (pos > lineEnd) refreshLine(pos === 0 || input.charCodeAt(pos - 1) === 0x0a);
    if (pos >= segEnd) break;
    const ch = input.charCodeAt(pos);
    if (ch === 0x0a) {
      pos++;
      refreshLine(true);
      continue;
    }
    if (ch === 0x5c && pos + 1 < lineEnd) {
      const next = input.charCodeAt(pos + 1);
      if (next === 0x20) {
        pos++;
        continue;
      }
      if (next === 0x5b) {
        const pseudoEnd = scanEscapedBracketPseudoLink(input, pos, lineEnd);
        if (pseudoEnd > pos) {
          out.push({ start: pos, end: pseudoEnd });
          pos = pseudoEnd;
          continue;
        }
      } else if (next === 0x3c) {
        escapedAngleAt = pos + 1;
        pos++;
        continue;
      }
      pos += 2;
      continue;
    }
    if (ch === 0x60) {
      const { closeEnd, afterOpen } = scanCodeSpan(input, pos, idx);
      if (closeEnd >= 0) {
        out.push({ start: pos, end: closeEnd });
        pos = closeEnd;
      } else {
        pos = afterOpen;
      }
      continue;
    }
    if (ch === 0x5b) {
      const link = scanMarkdownLink(input, pos, idx);
      if (link) {
        if (
          !link.nested ||
          nestedLinkNeedsOuterSkip(input.slice(link.closeBracket + 1, link.linkEnd))
        ) {
          out.push({ start: pos, end: link.linkEnd });
        } else {
          out.push({ start: pos, end: link.closeBracket + 1 });
        }
        pos = link.linkEnd;
        continue;
      }
      const noteLinkEnd = scanNoteLinkEnd(input, pos, lineEnd, idx);
      if (noteLinkEnd > pos) {
        out.push({ start: pos, end: noteLinkEnd });
        pos = noteLinkEnd;
        continue;
      }
      pos++;
      continue;
    }
    if (ch === 0x3c) {
      const isEscaped = escapedAngleAt === pos;
      let tagEnd = scanAngleTokenEnd(input, pos, idx, isEscaped);
      if (tagEnd < 0 && !isEscaped && pos + 2 < segEnd) {
        const c1 = input.charCodeAt(pos + 1);
        if ((c1 === 0x21 || c1 === 0x3f) && !paraSkipHtmlSpecial) {
          if (paraEnd < lineEnd) paraEnd = findParagraphEnd(input, lineEnd, segEnd);
          if (paraEnd > lineEnd) {
            const spec = parseSpecialHtmlHeader(input, pos, paraEnd);
            if (spec && spec.start > 0 && spec.start <= paraEnd) {
              const pSlice = input.slice(spec.start, paraEnd);
              const rel = pSlice.indexOf(spec.terminator);
              if (rel >= 0) {
                tagEnd = spec.start + rel + spec.terminator.length;
              } else {
                paraSkipHtmlSpecial = true;
              }
            }
          } else {
            paraSkipHtmlSpecial = true;
          }
        }
      }
      if (tagEnd > pos) {
        out.push({ start: pos, end: tagEnd });
        pos = tagEnd;
        if (pos > lineEnd) refreshLine(pos === 0 || input.charCodeAt(pos - 1) === 0x0a);
        continue;
      }
      pos++;
      continue;
    }
    if (ch === 0x68 || ch === 0x6d) {
      const bareEnd = scanBareUrlInSegment(input, pos, idx);
      if (bareEnd > pos) {
        pos = bareEnd;
        continue;
      }
      pos++;
      continue;
    }
    if (ch === 0x24) {
      if (
        pos + 1 < segEnd &&
        input.charCodeAt(pos + 1) === 0x24 &&
        isBlockMathPrefix(input, idx.lineStart, pos)
      ) {
        if (!noBlockMathClose) {
          const close = input.indexOf('$$', pos + 2);
          if (close >= 0 && close + 2 <= segEnd) {
            out.push({ start: pos, end: close + 2 });
            pos = close + 2;
            if (pos > lineEnd) refreshLine(pos === 0 || input.charCodeAt(pos - 1) === 0x0a);
            continue;
          }
          noBlockMathClose = true;
        }
        pos += 2;
        while (pos < segEnd && input.charCodeAt(pos) === 0x24) pos++;
        continue;
      }
      const mathEnd = scanInlineMathEnd(input, pos, lineEnd, idx);
      if (mathEnd > pos) {
        const safeEnd = extendMathSpanPastEnclosingHtmlTag(input, pos + 1, mathEnd, idx);
        out.push({ start: pos, end: safeEnd });
        pos = mathEnd;
        continue;
      }
      pos++;
      continue;
    }
    pos++;
  }
}

function mergeSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

export function linkifyMarkdown(input: string): string {
  if (!input) return input;

  // Fenced code blocks (` ``` ` and `~~~`) are skipped first at the block level
  // so tokens inside fences never pair with prose outside them.
  const fenceSpans: Span[] = [];
  for (const re of [/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g]) {
    for (const m of input.matchAll(re)) {
      const start = m.index ?? 0;
      fenceSpans.push({ start, end: start + m[0].length });
    }
  }
  const mergedFences = mergeSpans(fenceSpans);

  const skipSpans: Span[] = [...mergedFences];
  let segCursor = 0;
  for (const fence of mergedFences) {
    if (segCursor < fence.start) {
      scanSegmentSkips(input, segCursor, fence.start, skipSpans);
    }
    segCursor = fence.end;
  }
  if (segCursor < input.length) {
    scanSegmentSkips(input, segCursor, input.length, skipSpans);
  }
  const merged = mergeSpans(skipSpans);

  // Walk the input: copy skipped regions verbatim, run the linkify pass
  // on the gaps between them.
  const parts: string[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (cursor < span.start) {
      parts.push(linkifyPlainSegment(input.slice(cursor, span.start)));
    }
    parts.push(input.slice(span.start, span.end));
    cursor = span.end;
  }
  if (cursor < input.length) {
    parts.push(linkifyPlainSegment(input.slice(cursor)));
  }
  return parts.join('');
}

/** An autolink as the link pass writes one: `<https://...>`, `<mailto:...>` or `<me@example.com>`. */
const AUTOLINK_RE = /<(?:https?:\/\/[^<>\s]+|mailto:[^<>\s]+|[^<>\s@]+@[^<>\s@]+)>/g;
const autolinks = (text: string): number => text.match(AUTOLINK_RE)?.length ?? 0;

/** `linkifyMarkdown` for a converter that links its own text (upnote,
 *  notesnook): the autolinks it adds count in `counter.bareLinks`, so the
 *  converter says "Made bare URLs clickable" only when it made a link. */
export function linkifyCounting(body: string, counter: { bareLinks: number }): string {
  const out = linkifyMarkdown(body);
  if (out !== body) counter.bareLinks += Math.max(0, autolinks(out) - autolinks(body));
  return out;
}

function linkifyPlainSegment(text: string): string {
  return linkifyEmails(linkifyUrls(text));
}

/**
 * Wrap bare emails in `<...>` autolinks. Runs AFTER the URL pass so an address
 * already inside an autolink or an `https://` URL's query string is behind an
 * angle bracket and no longer matches as bare.
 *
 * Emits the BARE form `<me@example.com>`, never `<mailto:me@example.com>`.
 * CommonMark's email-autolink rule already prepends `mailto:` to the href while
 * leaving the visible text clean; writing the prefix ourselves takes the other
 * branch, which renders the link with `mailto:` showing in the note body.
 */
function linkifyEmails(text: string): string {
  return text.replace(EMAIL_RE, (whole: string, lead: string, match: string, at: number, src: string) => {
    const offset = at + lead.length;
    // Skip anything already inside an autolink we just produced, and anything
    // that is really the tail of a longer token (an already-linkified URL).
    const before = src.slice(Math.max(0, offset - 8), offset);
    if (/<(?:mailto:)?$/.test(before) || /[/@:]$/.test(before)) return whole;
    if (src[offset + match.length] === '>') return whole;
    return `${lead}<${match}>`;
  });
}

function linkifyUrls(text: string): string {
  return text.replace(URL_RE, (match: string, offset: number) => {
    // Inside an open `==highlight==` on this line, a closing `==` is the
    // highlight's, not the URL's. Outside one, `=` stays: base64 padding
    // ends real URLs.
    // Counted only when the URL ends in `==`, so a long line of URLs stays linear.
    let inHighlight = false;
    if (match.endsWith('==')) {
      const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
      inHighlight = (text.slice(lineStart, offset).match(/==/g)?.length ?? 0) % 2 === 1;
    }
    const { url, trailing } = trimUrl(match, inHighlight);
    // Degenerate: the whole match was punctuation somehow. Leave it alone.
    if (url.length === 0) return match;
    return `<${url}>${trailing}`;
  });
}

/**
 * Split a URL match into the URL and the characters after it that are not
 * part of it. We keep stripping until the last char is a plausible URL
 * character. `literal` text has no markdown, so `*`, `_` and `~` at the end
 * are the URL's own. The brackets are counted once, so a long run of them
 * stays linear.
 */
function trimUrl(match: string, inHighlight: boolean, literal = false): { url: string; trailing: string } {
  let parens = 0;
  let brackets = 0;
  for (let i = 0; i < match.length; i++) {
    const ch = match[i];
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  let end = match.length;
  while (end > 0) {
    const last = match[end - 1]!;
    if (last === ')' || last === ']') {
      // Balanced: the closing sign belongs to the URL (Wikipedia article
      // names like "Foo_(bar)", query keys like "a[]"). Keep it.
      if ((last === ')' ? parens : brackets) >= 0) break;
      if (last === ')') parens++;
      else brackets++;
      end--;
    } else if (TRAILING_PUNCT_RE.test(last) && !(literal && /[*_~]/.test(last))) {
      end--;
    } else if (inHighlight && match.endsWith('==', end)) {
      end -= 2;
      inHighlight = false;
    } else {
      break;
    }
  }
  return { url: match.slice(0, end), trailing: match.slice(end) };
}

/**
 * Text typed in an app that shows every character literally, as markdown:
 * each bare URL and email becomes an autolink, and everything between them
 * goes through `escape`. The escape must never reach a URL, because markdown
 * reads no backslash escape inside an autolink: an escaped `_`, `~` or `[`
 * there lands in the href as `%5C` and on screen as a backslash.
 * `wrap` writes a URL's autolink, for a caller that must escape inside it
 * (a table cell, where `|` splits the row). `links` counts the autolinks made.
 */
export function linkifyLiteralText(
  text: string,
  escape: (s: string) => string,
  wrap: (url: string) => string = (url) => `<${url}>`,
): { markdown: string; links: number } {
  let links = 0;
  const gap = (s: string): string => {
    let out = '';
    let cursor = 0;
    for (const m of s.matchAll(EMAIL_RE)) {
      const at = (m.index ?? 0) + m[1]!.length;
      // The tail of a longer token (`user:me@x.com`, `a/b@c.com`) stays text.
      if (at > 0 && /[/@:]/.test(s[at - 1]!)) continue;
      out += `${escape(s.slice(cursor, at))}<${m[2]}>`;
      cursor = at + m[2]!.length;
      links++;
    }
    return out + escape(s.slice(cursor));
  };
  let markdown = '';
  let cursor = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    const { url } = trimUrl(m[0], false, true);
    if (!url) continue;
    markdown += `${gap(text.slice(cursor, at))}${wrap(url)}`;
    cursor = at + url.length;
    links++;
  }
  return { markdown: markdown + gap(text.slice(cursor)), links };
}
