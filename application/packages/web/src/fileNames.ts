/**
 * The name a stored file shows, and the two characters that decide whether
 * it survives.
 *
 * A file's name is the link text of its reference in the note body,
 * `[name|size|mime](pn:file/<uuid>)`, so it is written and read as markdown.
 * `|` separates the three fields and the markdown serializer does not escape
 * it, so a name holding one re-parses as a shorter name plus a wrong size
 * and mime. `cleanFileName` takes it out on the way in.
 *
 * The serializer does escape ` * \ ~ [ ] _ and the editor is fine, because
 * markdown-it unescapes on the way back. The surfaces that read the raw body
 * text instead of the parsed document are not: they show the backslashes.
 * `unescapeMarkdownText` is for those, and `escapeMarkdownText` is for the
 * one place that writes a link by hand rather than through the serializer.
 */

import { nextStop } from './linkScan';

/** Longest name a file may carry. Matches the note title cap, because a
 *  single-file note carries its name in both places. */
// Spec: docs/internal/specs/file-rename-and-audio-seek.md (character rules)
export const FILE_NAME_MAX_LENGTH = 200;

/**
 * Make a typed name safe to store as link text. Removes what breaks the
 * link and what has no business in a filename, then caps the length.
 * Returns `fallback` when nothing usable is left, so an empty commit keeps
 * the name the file already had instead of clearing it.
 */
export function cleanFileName(raw: string, fallback: string): string {
  const cleaned = raw
    // The direction overrides and isolates draw the rest of a name in another
    // order, so "photo<U+202E>gpj.exe" reads as a picture. The marks U+200E
    // and U+200F change no order and right-to-left names need them.
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FILE_NAME_MAX_LENGTH)
    .trim();
  return cleaned || fallback;
}

/**
 * Undo the escaping the markdown serializer applies to link text. The
 * character class mirrors prosemirror-markdown's own `esc`, and
 * `tests/fileNames.test.ts` pins the pair against a real serializer round
 * trip - a dependency that starts escaping something new reddens there
 * rather than shipping a stray backslash into the Files list.
 *
 * One left-to-right pass is correct for the nested case: `a\b` serializes
 * as `a\\b`, whose leading `\\` is consumed as an escaped backslash before
 * the `b` is reached.
 */
export function unescapeMarkdownText(s: string): string {
  return s.replace(/\\([`*\\~[\]_])/g, '$1');
}

/** Escape a name for use as markdown link text. */
export function escapeMarkdownText(s: string): string {
  return s.replace(/([`*\\~[\]_])/g, '\\$1');
}

/**
 * Split a name into the part a rename may change and the extension it may
 * not. The extension is the last dot's tail when that tail is at most ten
 * characters, holds no space and holds a letter; everything else is all
 * base. So nothing is appended to a name that arrived without an extension,
 * and a date such as `Notes 2026.09.10 draft` is not mistaken for one.
 */
export function splitFileName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, ext: '' };
  const tail = name.slice(dot + 1);
  if (!/^[A-Za-z0-9]{1,10}$/.test(tail) || !/[A-Za-z]/.test(tail)) {
    return { base: name, ext: '' };
  }
  return { base: name.slice(0, dot), ext: tail };
}

/** One `[name|size|mime](pn:file/<uuid>)` in a body, its fields as written.
 *  It spans `index` up to, not including, `end`. */
export type AttachmentLink = { index: number; end: number; name: string; size: string; mime: string; uuid: string };

const UUID_TAIL_RE = /^[0-9a-f-]{36}\)/;

/**
 * Every attachment link in a body, as
 * `/\[([^|\n]*)\|([^|\n]*)\|([^\]\n]*)\]\(pn:file\/([0-9a-f-]{36})\)/g` finds
 * them. No field spans a line, so the name cannot swallow the text before it
 * (a `- [ ] task` checkbox) up to the first `|` further down.
 *
 * `acrossLines` lets the fields span lines, as
 * `/\[([^|]*)\|([^|]*)\|([^\]]*)\]\(pn:file\/[0-9a-f-]{36}\)/g` does; the
 * readers that sum sizes, name a file note's type and print a body use that
 * one. `anyId` drops the uuid check, as `/\[[^|]*\|[^|]*\|([^\]]*)\]\(pn:file\//`
 * does, and gives an empty uuid.
 *
 * Each field ends at its first stop character, so a link opening at a bracket
 * has one possible shape (see `linkScan.ts`). The regex read from every
 * bracket to the next `]`, and a long line of `[a|` cost quadratic time
 * (external report, 2026-10-24, bug report 23.1). `tests/bracketRunCost.test.ts`
 * and `tests/linkScan.test.ts` compare this with the regexes.
 */
export function attachmentLinks(
  body: string,
  { acrossLines = false, anyId = false }: { acrossLines?: boolean; anyId?: boolean } = {},
): AttachmentLink[] {
  const links: AttachmentLink[] = [];
  const pipe = nextStop(body, acrossLines ? /\|/ : /[|\n]/);
  const close = nextStop(body, acrossLines ? /\]/ : /[\]\n]/);
  let open = body.indexOf('[');
  while (open >= 0) {
    const sizeAt = pipe(open);
    // A bracket before the name's pipe would fail the same way.
    let from = sizeAt;
    if (body[sizeAt] === '|') {
      const mimeAt = pipe(sizeAt);
      if (body[mimeAt] === '|') {
        const end = close(mimeAt);
        const uuidAt = end + '](pn:file/'.length;
        const idEnd = anyId ? uuidAt : uuidAt + 37;
        if (body.startsWith('](pn:file/', end) && (anyId || UUID_TAIL_RE.test(body.slice(uuidAt, idEnd)))) {
          links.push({
            index: open,
            end: idEnd,
            name: body.slice(open + 1, sizeAt),
            size: body.slice(sizeAt + 1, mimeAt),
            mime: body.slice(mimeAt + 1, end),
            uuid: body.slice(uuidAt, anyId ? uuidAt : uuidAt + 36),
          });
          from = idEnd;
        }
      }
    }
    open = body.indexOf('[', from);
  }
  return links;
}

/** Rejoin what `splitFileName` took apart. */
export function joinFileName(base: string, ext: string): string {
  return ext ? `${base}.${ext}` : base;
}

/**
 * The name a single-file item's file takes when its title changes (GitHub
 * #610): the title as the base, with the file's own extension kept, as a
 * chip rename keeps it. A title that already ends in that extension does not
 * get it twice. Null when the name would not change or nothing usable is left.
 */
// Spec: docs/internal/specs/file-rename-and-audio-seek.md (section 3.4)
export function fileNameForTitle(title: string, current: string): string | null {
  const { ext } = splitFileName(current);
  let base = title.trim();
  if (ext && base.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) base = base.slice(0, -ext.length - 1);
  base = cleanFileName(base, '');
  // Nothing but dots and spaces is no name, the same rule the chip applies.
  if (!/[^.]/.test(base)) return null;
  const next = joinFileName(base, ext);
  return next === current ? null : next;
}

type NameListener = (uuid: string, name: string) => void;
const nameListeners = new Set<NameListener>();

/**
 * Ask the chip holding `uuid` to take `name`. Only the chip inside the live
 * editor writes a file name, so an edit still pending there cannot overwrite
 * it. It lives here, not in the chip's module, so the title commit does not
 * pull the editor into the boot path.
 */
export function requestAttachmentName(uuid: string, name: string) {
  for (const listener of nameListeners) listener(uuid, name);
}

export function subscribeToAttachmentNames(listener: NameListener): () => void {
  nameListeners.add(listener);
  return () => { nameListeners.delete(listener); };
}
