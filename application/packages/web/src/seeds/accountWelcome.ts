/**
 * The one note a real account starts with (GitHub #661, #708).
 *
 * A real account used to get the whole demo: about ten notes, a folder tree,
 * Vault items, bookmarks, contacts, a medication and factors. Now it gets a
 * single note, and the demo keeps the rest. That note is not a file of its
 * own: it is the welcome seed followed by the moving-in, security and
 * markdown seeds, joined at seed time. Every locale already translates those
 * four files, so the joined note needs no translation of its own.
 *
 * Joining takes three mechanical steps, all outside code:
 *   - each joined seed becomes a section under its own title (an `##`
 *     heading), and its own headings step down one level;
 *   - a note-link to a joined seed becomes a link to that section in this
 *     note (`[[#Title]]`, or `[[#Heading]]` for a heading link), keeping its
 *     words on the page;
 *   - a paragraph that links to a note the account does not get (a demo-only
 *     seed) is dropped, so no link in the note goes nowhere.
 *
 * `tests/accountWelcome.test.ts` runs this over every locale and checks that
 * each link lands on a heading the note holds.
 */

import { nextFence, type Fence } from '../markdownFence';
import { mapNoteLinks, noteLinkKey, noteLinkTargets, parseNoteLinkTarget } from '../noteLinks';
import type { SeedDoc } from './index';

/** The seeds joined under the welcome note, in order. */
const ACCOUNT_WELCOME_PARTS = ['moving-in', 'security', 'markdown'] as const;

/**
 * Split markdown into blocks at blank lines, keeping a fenced code block
 * whole even when it holds blank lines. `code` marks a block that is a fence.
 */
function blocks(body: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  let lines: string[] = [];
  let code = false;
  let fence: Fence | null = null;
  const flush = () => {
    if (lines.length) out.push({ text: lines.join('\n'), code });
    lines = [];
    code = false;
  };
  for (const line of body.split('\n')) {
    const step = nextFence(fence, line);
    if (fence === null && !step.isFence && line.trim() === '') {
      flush();
      continue;
    }
    if (step.isFence) code = true;
    fence = step.fence;
    lines.push(line);
  }
  flush();
  return out;
}

/** One heading level down for every heading line of a non-code block. */
function demote(text: string): string {
  return text.replace(/^( {0,3})(#{1,5})(?=[ \t])/gm, '$1$2#');
}

/**
 * The welcome note of a real account, built from the resolved seeds of the
 * active locale. Returns null when a seed it needs is missing.
 */
export function composeAccountWelcome(docs: readonly SeedDoc[]): SeedDoc | null {
  const byStem = new Map(docs.map((d) => [d.stem, d]));
  const welcome = byStem.get('welcome');
  const parts = ACCOUNT_WELCOME_PARTS.map((stem) => byStem.get(stem));
  if (!welcome || parts.some((p) => !p)) return null;

  // The section heading of each joined seed, by link key.
  const sections = new Map(parts.map((p) => [noteLinkKey(p!.title), p!.title]));
  const hasNote = (name: string) => sections.has(noteLinkKey(name));

  /** Keep a block unless it links to a note this account does not get. */
  const keeps = (b: { text: string; code: boolean }) =>
    b.code || noteLinkTargets(b.text).every((t) => {
      const { note } = parseNoteLinkTarget(t, hasNote);
      return note === '' || hasNote(note);
    });

  const pieces = [
    ...blocks(welcome.body).filter(keeps).map((b) => b.text),
    ...parts.flatMap((p) => [
      `## ${p!.title}`,
      ...blocks(p!.body).filter(keeps).map((b) => (b.code ? b.text : demote(b.text))),
    ]),
  ];

  const joined = pieces.join('\n\n');
  const linked = mapNoteLinks(joined, (target, label) => {
    const { note, heading } = parseNoteLinkTarget(target, hasNote);
    const title = sections.get(noteLinkKey(note));
    if (!title) return null;
    // `[[#Heading]]` shows the heading, so a link with no label of its own
    // needs none. Adding one would break a link in a table, where the `|`
    // ends the cell (the welcome note's table holds three).
    const anchor = heading ?? title;
    return label ? `[[#${anchor}|${label}]]` : `[[#${anchor}]]`;
  });

  return {
    ...welcome,
    body: linked?.body ?? joined,
    // The only note in the vault: no folder to file it in, no tag to sort
    // it by, and no star to lift it above nothing.
    tags: [],
    starred: false,
    folder: null,
  };
}
