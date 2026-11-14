import type { LocalNote } from './db';
import { MARKDOWN_NOTE_TYPES } from './noteTypes';
import type { NotesIndexOps } from './searchIndexSync';

/**
 * The small part of link suggestions that the boot path carries: which notes
 * take part, the "Not related" pair key, where a cursor link goes, and the
 * index ops that load `relatedNotes.ts` (the ranking and its index) the first
 * time a note opens. Everything else stays off the boot path.
 * Spec: docs/internal/plans/related-notes.md
 */

type RelatedModule = {
  index: NotesIndexOps;
  relatedNotes: typeof import('./relatedNotes').relatedNotes;
};

let loaded: RelatedModule | null = null;
let loading: Promise<RelatedModule> | null = null;

function loadRelated(): Promise<RelatedModule> {
  loading ??= import('./relatedNotes').then((m) => (loaded = { index: m.RELATED_INDEX, relatedNotes: m.relatedNotes }));
  return loading;
}

/** The ranking module once it has loaded, else null (the panel shows no suggestions yet). */
export function relatedModule(): RelatedModule | null {
  return loaded;
}

/** The related index as `useIndexSync` drives it; the first build loads the module. */
export const RELATED_INDEX: NotesIndexOps = {
  ready: () => !!loaded && loaded.index.ready(),
  wantsFullBuild: (changed) => !loaded || loaded.index.wantsFullBuild(changed),
  update: (notes, changed) => loaded?.index.update(notes, changed),
  buildSliced: async (notes) => (await loadRelated()).index.buildSliced(notes),
};

/**
 * Whether a note can be scored and listed at all: live, markdown, and not
 * PIN-protected. A locked note is left out by the caller, which knows the gate.
 */
export function isRelatedSource(n: LocalNote): boolean {
  return n.trashed === 0 && MARKDOWN_NOTE_TYPES.includes(n.type ?? 'note') && n.pinProtected !== 1;
}

/** The key of a "Not related" pair: the two ids sorted, so either note finds it. */
export function suggestionPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Where "Link at the cursor" puts its link in a line of text: a cursor inside
 * a word moves to the word's end, so the link never splits it, and a space
 * goes before the link when it would touch the word before.
 */
export function linkInsertPoint(text: string, offset: number): { offset: number; spaceBefore: boolean } {
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
  let at = offset;
  if (isWord(text[at - 1])) while (isWord(text[at])) at += 1;
  return { offset: at, spaceBefore: at > 0 && !/\s/u.test(text[at - 1]!) };
}
