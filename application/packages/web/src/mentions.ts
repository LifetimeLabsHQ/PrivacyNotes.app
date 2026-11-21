import { foldText } from './textFold';
import { hasCJK } from './cjkSegment';

/**
 * Suggested connections by name: a note whose text names a contact, a
 * bookmark, a login, a card, an SSH key or a drawing suggests that item
 * ("Mentions Anna Berg"). Only the item's name is read, never a field of its
 * form, so a password or a card number can never match or show in a reason.
 * A PIN-protected or locked item never takes part (the caller filters).
 *
 * A name matches as whole words, in any case and with any accent, the way
 * search folds text (`foldText`). A name in a script with no spaces (Chinese,
 * Japanese) matches as a run of characters. A one-word name needs five
 * letters, and any name three: a drawing called "Test" or a contact called
 * "Mom" would come up in every other note. A name of digits only matches
 * nothing.
 * Spec: docs/internal/issues/0852.md (Smart connections by name)
 */

const WORD = /[\p{L}\p{N}]+/gu;
const MIN_NAME = 3;
const MIN_ONE_WORD = 5;

type Named = { id: string; name: string; words: string[] };

export type MentionIndex = {
  /** First word of a name to the names that start with it. */
  byFirst: Map<string, Named[]>;
  /** Names in a script with no spaces, read as runs of characters. */
  runs: Named[];
};

const wordsOf = (text: string) => foldText(text).match(WORD) ?? [];

/** The index of the names to look for, built once per change of the items. */
export function buildMentionIndex(items: readonly { id: string; name: string }[]): MentionIndex {
  const byFirst = new Map<string, Named[]>();
  const runs: Named[] = [];
  for (const { id, name } of items) {
    const words = wordsOf(name);
    const joined = words.join('');
    if (joined.length < MIN_NAME || /^\d+$/.test(joined)) continue;
    const named = { id, name, words };
    if (hasCJK(name)) {
      runs.push(named);
      continue;
    }
    if (words.length === 1 && joined.length < MIN_ONE_WORD) continue;
    const list = byFirst.get(words[0]!);
    if (list) list.push(named);
    else byFirst.set(words[0]!, [named]);
  }
  return { byFirst, runs };
}

/** The items a text names, in the order the text first names them; `skip` ids never come back. */
export function mentionsIn(text: string, index: MentionIndex, skip: ReadonlySet<string>): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>(skip);
  const words = wordsOf(text);
  for (let i = 0; i < words.length; i++) {
    for (const named of index.byFirst.get(words[i]!) ?? []) {
      if (seen.has(named.id)) continue;
      if (named.words.every((w, j) => words[i + j] === w)) {
        seen.add(named.id);
        out.push({ id: named.id, name: named.name });
      }
    }
  }
  if (index.runs.length) {
    const folded = words.join('');
    for (const named of index.runs) {
      if (!seen.has(named.id) && folded.includes(named.words.join(''))) {
        seen.add(named.id);
        out.push({ id: named.id, name: named.name });
      }
    }
  }
  return out;
}
