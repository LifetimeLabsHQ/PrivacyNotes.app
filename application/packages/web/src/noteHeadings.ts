import type { Node as PMNode } from '@tiptap/pm/model';
import { noteLinkKey } from './noteLinks';
import type { NoteType } from '@notes/shared';
import { hasStructuredBody, stripToPlainText } from './notesViewUtils';
import { nextFence, type Fence } from './markdownFence';
import { headingCodes } from './noteShortcut';

/**
 * The headings a note-link can point at (`[[Note#Heading]]`), read two ways
 * that must agree: from the open editor's document, and from the markdown
 * body of a note that is not open. A link made from one list is followed
 * with the other, so a heading text that differs between them is a link
 * that opens its note at the top. `tests/noteHeadings.test.ts` holds the two
 * readers to the same answer.
 *
 * A callout's title is a target too (#726), with the same name rules as a
 * heading. A heading inside a callout is not a target, the same rule the
 * outline follows. Neither is a heading or a callout inside a quote, a list
 * or another callout, because the markdown reader skips those lines.
 *
 * Spec: docs/internal/specs/note-link-headings.md
 */

/** One target. A callout's `level` is one step under the heading above it,
 *  the indent it gets in the `[[` menu. */
export type HeadingEntry = { level: number; text: string; callout?: true };

/** A note's headings, or 'locked' when its lock is closed. */
export type NoteHeadingsAnswer = HeadingEntry[] | 'locked';

/**
 * The headings another note offers a link: none from a form-shaped item,
 * and 'locked' from a note behind a closed lock, because its headings are
 * its content and the `[[` menu must not show them.
 */
export function noteHeadingsFor(note: { type: NoteType; body: string }, locked: boolean): NoteHeadingsAnswer {
  if (locked) return 'locked';
  return hasStructuredBody(note.type) ? [] : headingsFromMarkdown(note.body);
}

/** Containers whose headings and callouts the markdown body does not show
 *  at the start of a line (a quote, a list item, a table cell), so neither
 *  reader lists them and a target is one both can find. A callout stops the
 *  walk too, once its own title is read. */
const NO_HEADING_TARGETS = new Set(['blockquote', 'listItem', 'taskItem', 'tableCell', 'tableHeader']);

/** Every heading and callout title of an editor document, with its
 *  position, in order. */
export function headingsFromDoc(doc: PMNode): (HeadingEntry & { pos: number })[] {
  const out: (HeadingEntry & { pos: number })[] = [];
  let section = 0;
  doc.descendants((node, pos) => {
    if (node.type.name === 'callout') {
      const title = node.firstChild?.type.name === 'calloutTitle' ? node.firstChild.textContent.trim() : '';
      if (title) out.push({ pos, level: Math.min(section + 1, 6), text: title, callout: true });
      return false;
    }
    if (NO_HEADING_TARGETS.has(node.type.name)) return false;
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (text) {
        section = node.attrs.level ?? 1;
        out.push({ pos, level: section, text });
      }
      return false;
    }
    return true;
  });
  return out;
}

/** A callout's first line as the editor writes it, `> [!tip]+ Title`, at
 *  the start of the line. An indented one sits in a list item. */
const CALLOUT_LINE = /^>[ \t]?\[![\w-]+(?:\|[\w-]+)?\][+-]?[ \t]?(.*)$/;

/** Every ATX heading and callout title of a markdown body, outside code
 *  fences and quotes. */
export function headingsFromMarkdown(body: string): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  let fence: Fence | null = null;
  let section = 0;
  let quoted = false;
  for (const line of body.split(/\r?\n/)) {
    const step = nextFence(fence, line);
    fence = step.fence;
    if (step.isFence || fence !== null) {
      quoted = false;
      continue;
    }
    // Only the first line of a quote can open a callout: the `>` lines
    // after it are its body, or the rest of a plain quote.
    const opensQuote = !quoted;
    quoted = /^ {0,3}>/.test(line);
    if (quoted) {
      const c = opensQuote ? CALLOUT_LINE.exec(line) : null;
      const title = c ? stripToPlainText(c[1]!) : '';
      if (title) out.push({ level: Math.min(section + 1, 6), text: title, callout: true });
      continue;
    }
    // A top-level list line that opens with a heading loads as that heading,
    // lifted out of its list, so it reads as one here too.
    const h = /^ {0,3}(?:[-*+][ \t]+)?(#{1,6})[ \t]+(.*)$/.exec(line);
    if (!h) continue;
    const text = stripToPlainText(h[2]!.replace(/[ \t]+#+[ \t]*$/, ''));
    if (text) {
      section = h[1]!.length;
      out.push({ level: section, text });
    }
  }
  return out;
}

/**
 * The order a name is looked up in: every heading before every callout,
 * each in document order. A callout titled like a heading never takes that
 * heading's links or shortcut codes, which were made before callouts were
 * targets. Spec: docs/internal/specs/note-link-headings.md (3.1)
 */
function linkOrder<T extends HeadingEntry>(list: readonly T[]): T[] {
  return [...list.filter((h) => !h.callout), ...list.filter((h) => h.callout)];
}

/** One row per text, the one a link opens, kept in document order. */
export function uniqueHeadings<T extends HeadingEntry>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const opened = new Set(linkOrder(list).filter((h) => {
    const key = noteLinkKey(h.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
  return list.filter((h) => opened.has(h));
}

/**
 * The position of the heading or callout a link names, or -1. The first
 * match in link order wins. Obsidian's nested form `[[Note#Part 1#Step 2]]`
 * falls back to its last part.
 */
export function findHeadingPos(doc: PMNode, heading: string): number {
  const list = linkOrder(headingsFromDoc(doc));
  const find = (name: string) => {
    const key = noteLinkKey(name);
    return key ? list.find((h) => noteLinkKey(h.text) === key)?.pos ?? -1 : -1;
  };
  const pos = find(heading);
  if (pos >= 0 || !heading.includes('#')) return pos;
  return find(heading.slice(heading.lastIndexOf('#') + 1));
}

/** Where the caret goes when a link opens the target at `pos`: the start
 *  of the heading's text, or of the callout's title. */
export function headingCaretPos(doc: PMNode, pos: number): number {
  return doc.nodeAt(pos)?.type.name === 'callout' ? pos + 2 : pos + 1;
}

/** The shortcut code of the heading or callout at `pos`, or null when it is
 *  not a target. Spec: docs/internal/specs/note-shortcuts.md (3.3) */
export function headingCodeAt(doc: PMNode, itemId: string, pos: number): string | null {
  const list = linkOrder(headingsFromDoc(doc));
  const i = list.findIndex((h) => h.pos === pos);
  return i < 0 ? null : headingCodes(itemId, list.map((h) => noteLinkKey(h.text)))[i]!;
}

/** The position of the heading or callout a shortcut code names, or -1. */
export function headingPosByCode(doc: PMNode, itemId: string, code: string): number {
  const list = linkOrder(headingsFromDoc(doc));
  const i = headingCodes(itemId, list.map((h) => noteLinkKey(h.text))).indexOf(code);
  return i < 0 ? -1 : list[i]!.pos;
}
