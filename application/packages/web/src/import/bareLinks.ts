/**
 * The bare-link pass: once, after an importer's parse, every note whose body
 * is Markdown goes through `linkifyMarkdown` (linkify.ts, which holds the
 * rules and why each importer needs them), and the import says how many
 * notes it changed, in one message, only when it changed one. An importer
 * wraps its exported parse in `withBareLinks`; `tests/importerBareLinks.test.ts`
 * fails for a registry entry that neither runs the pass nor is named there as
 * exempt with its reason.
 */
import i18n from '../i18n';
import type { NoteType } from '@notes/shared';
import { linkifyMarkdown } from './linkify';
import type { ImportedNote, ParsedImport } from './types';

/** The note types whose body is Markdown. Every other type's body is JSON
 *  that a form reads (a login, a card, a key, a bookmark, a contact, a
 *  drawing, a file): a link made inside it would corrupt the stored field. */
const MARKDOWN_BODY: ReadonlySet<NoteType> = new Set(['note', 'task', 'journal', 'event']);

/** One note through the pass: the same note when its body is not Markdown
 *  or holds no bare link. For a door that makes one note without an import
 *  run (the Markdown pillar's "Save to notes"). */
export function linkifyNote<N extends Pick<ImportedNote, 'body' | 'type'>>(n: N): N {
  if (!MARKDOWN_BODY.has(n.type ?? 'note')) return n;
  const body = linkifyMarkdown(n.body);
  return body === n.body ? n : { ...n, body };
}

/** The one bare-link pass over a finished import: every Markdown body through
 *  `linkifyMarkdown`, and one message with the number of notes it changed,
 *  only when it changed one. */
export function linkifyParsed(parsed: ParsedImport): ParsedImport {
  let changed = 0;
  const notes = parsed.notes.map((n) => {
    const linked = linkifyNote(n);
    if (linked !== n) changed++;
    return linked;
  });
  if (changed === 0) return parsed;
  return {
    ...parsed,
    notes,
    transforms: [...parsed.transforms, i18n.t('importLog:shared.linkifiedNotes', { count: changed })],
  };
}

const wrapped = new WeakSet<(...args: never[]) => unknown>();

/** An importer's parse with the bare-link pass after it. */
export function withBareLinks<A extends unknown[]>(
  parse: (...args: A) => Promise<ParsedImport>,
): (...args: A) => Promise<ParsedImport> {
  const run = async (...args: A) => linkifyParsed(await parse(...args));
  wrapped.add(run);
  return run;
}

/** Whether `parse` runs the bare-link pass (`withBareLinks`). */
export function hasBareLinks(parse: (...args: never[]) => unknown): boolean {
  return wrapped.has(parse);
}
