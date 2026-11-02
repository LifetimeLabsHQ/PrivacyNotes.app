/**
 * Markdown links and pictures found in one forward pass.
 *
 * Every pattern here opens on `[` (or `![`) and has fields that each end at
 * their first stop character: the text at the first `]`, the target at the
 * first `)`. So a link opening at a bracket has one possible shape. A regex
 * finds it by reading from every bracket to the stop, and a long run of
 * brackets with no stop cost quadratic time, cubic for a lazy pattern
 * (external report, 2026-10-24, bug report 23.1). `nextStop` remembers the
 * stop it found, so the text between two stops is read once.
 *
 * Each caller names the regex it replaced, and `tests/linkScan.test.ts`
 * compares the two on random strings.
 */

/**
 * The first index after `i` whose character matches `stop` (one character
 * class), or the length. Calls that only move forward read the text between
 * two stops once.
 */
export function nextStop(body: string, stop: RegExp): (i: number) => number {
  let from = 0;
  let at = -1;
  return (i) => {
    if (i < from || i >= at) {
      from = i;
      at = i + 1;
      while (at < body.length && !stop.test(body[at]!)) at++;
    }
    return at;
  };
}

/** Where a link target ends: `[^)]*\)`, `[^)\s]+\)` or `.*?\)`. */
const TARGET_STOPS = { paren: /\)/, space: /[)\s]/, line: /[)\n\r\u2028\u2029]/ } as const;

export type LinkShape = {
  /** Opens on `![` instead of `[`. */
  picture?: boolean;
  /** A `[` right after a `!` opens nothing: `(?<!!)\[`. */
  notAfterBang?: boolean;
  /** The text stops at a line break: `[^\]\n]*` instead of `[^\]]*`. */
  oneLine?: boolean;
  /** The text holds at least one character: `[^\]]+`. */
  textRequired?: boolean;
  /** How the target ends. A `space` target holds at least one character. */
  target: keyof typeof TARGET_STOPS;
  /** The whole target must match this. */
  targetIs?: RegExp;
  /** An optional `{...}` after the link, `(?:\{([^}]*)\})?`. */
  suffix?: boolean;
  /** An optional line break after the link (and suffix), `\n?`. */
  newline?: boolean;
};

export type LinkMatch = {
  /** Where the match starts, at `[` or at the `!` of `![`. */
  index: number;
  /** Just after the match. */
  end: number;
  text: string;
  target: string;
  /** Inside the `{...}`, or undefined when there is none. */
  suffix: string | undefined;
};

/** Every match of the pattern `shape` describes, as its global regex finds them. */
export function markdownLinks(body: string, shape: LinkShape): LinkMatch[] {
  const matches: LinkMatch[] = [];
  const opener = shape.picture ? '![' : '[';
  const close = nextStop(body, shape.oneLine ? /[\]\n]/ : /\]/);
  const targetEnd = nextStop(body, TARGET_STOPS[shape.target]);
  const suffixEnd = shape.suffix ? nextStop(body, /\}/) : null;
  let index = body.indexOf(opener);
  while (index >= 0) {
    const match = linkAt(index);
    if (match) matches.push(match);
    index = body.indexOf(opener, match ? match.end : index + 1);
  }
  return matches;

  function linkAt(index: number): LinkMatch | null {
    if (shape.notAfterBang && body[index - 1] === '!') return null;
    const textAt = index + opener.length;
    const q = close(textAt - 1);
    if (body[q] !== ']' || body[q + 1] !== '(') return null;
    if (shape.textRequired && q === textAt) return null;
    const w = targetEnd(q + 1);
    if (body[w] !== ')') return null;
    const target = body.slice(q + 2, w);
    if (shape.target === 'space' && !target) return null;
    if (shape.targetIs && !shape.targetIs.test(target)) return null;
    let end = w + 1;
    let suffix: string | undefined;
    if (suffixEnd && body[end] === '{') {
      const s = suffixEnd(end);
      if (body[s] === '}') {
        suffix = body.slice(end + 1, s);
        end = s + 1;
      }
    }
    if (shape.newline && body[end] === '\n') end++;
    return { index, end, text: body.slice(textAt, q), target, suffix };
  }
}

/**
 * `body` with each match replaced by what `replace` returns for it; a null
 * keeps the match as written, as a replace callback returning the match does.
 */
export function replaceMatches<M extends { index: number; end: number }>(
  body: string,
  matches: readonly M[],
  replace: (match: M) => string | null,
): string {
  let out = '';
  let last = 0;
  for (const m of matches) {
    const next = replace(m);
    if (next === null) continue;
    out += body.slice(last, m.index) + next;
    last = m.end;
  }
  return last === 0 && out === '' ? body : out + body.slice(last);
}

// The shapes in use, each with the regex it replaced.

const FILE_ID = /^pn:file\/[0-9a-f-]{36}$/;

/** A file link, not a picture placed from Files:
 *  `/(?<!!)\[[^\]]*\]\(pn:file\/[0-9a-f-]{36}\)/g`. */
export const FILE_LINK: LinkShape = { notAfterBang: true, target: 'paren', targetIs: FILE_ID };

/** A picture placed from Files: `/!\[([^\]\n]*)\]\(pn:file\/([0-9a-f-]{36})\)/g`. */
export const FILE_PICTURE: LinkShape = { picture: true, oneLine: true, target: 'paren', targetIs: FILE_ID };

/** Any picture, its target read to the first `)`: `/!\[([^\]]*)\]\([^)]*\)/`. */
export const ANY_PICTURE: LinkShape = { picture: true, target: 'paren' };

/** A link whose target ends on its line: `/\[([^\]]*)\]\(.*?\)/g`. */
export const LINE_LINK: LinkShape = { target: 'line' };

/** A web link: `/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g`. */
export const WEB_LINK: LinkShape = { target: 'space', targetIs: /^https?:\/\/./ };

/** A picture with a target and its `{...}` attributes:
 *  `/!\[([^\]]*)\]\(([^)\s]+)\)(?:\{([^}]*)\})?/g`. */
export const RENDER_PICTURE: LinkShape = { picture: true, target: 'space', suffix: true };

/** A picture with a target: `/!\[([^\]]*)\]\(([^)\s]+)\)/g`. */
export const SRC_PICTURE: LinkShape = { picture: true, target: 'space' };

/** A link with text and a target: `/\[([^\]]+)\]\(([^)\s]+)\)/g`. */
export const RENDER_LINK: LinkShape = { textRequired: true, target: 'space' };

/** A picture from the picture store: `/!\[([^\]]*)\]\(pn:img\/[^)]*\)/g`. */
export const IMG_PICTURE: LinkShape = { picture: true, target: 'paren', targetIs: /^pn:img\// };

/** Any link to a file: `/\[([^\]]*)\]\(pn:file\/[^)]*\)/g`. */
export const ANY_FILE_LINK: LinkShape = { target: 'paren', targetIs: /^pn:file\// };

/** A stored picture with its attributes and line break:
 *  `/!\[[^\]]*\]\(pn:(?:img|file)\/([0-9a-f-]{36})\)(?:\{[^}]*\})?\n?/g`. */
export const MEDIA_PICTURE: LinkShape = {
  picture: true, target: 'paren', targetIs: /^pn:(?:img|file)\/[0-9a-f-]{36}$/, suffix: true, newline: true,
};

/** A file link with its line break: `/\[[^\]]*\]\(pn:file\/([0-9a-f-]{36})\)\n?/g`. */
export const MEDIA_FILE: LinkShape = { target: 'paren', targetIs: FILE_ID, newline: true };
