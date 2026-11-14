/**
 * "Not related" pairs in `userSettings.dismissedSuggestions`, with a counter
 * per pair so a restore can sync. An entry is the pair key (`a|b`, from
 * `suggestionPairKey`), which is version 1, or `a|b#n` for version n. An odd
 * version hides the pair, an even one shows it again, and every change takes
 * the next version, so the merge keeps the highest version of each pair and
 * the newest change wins on every device. An older app reads `a|b#2` as a key
 * that matches no pair, so it shows the pair too.
 * Import-free: `userSettings.ts` and the panel both read it.
 * Spec: docs/internal/plans/related-notes.md (section 9, "Not related")
 */

/** Pairs kept, newest last. Spec: docs/internal/plans/related-notes.md (section 9) */
export const MAX_DISMISSED_SUGGESTIONS = 2000;

function parse(entry: string): [key: string, version: number] {
  const at = entry.lastIndexOf('#');
  if (at > 0) {
    const n = Number(entry.slice(at + 1));
    if (Number.isInteger(n) && n > 0) return [entry.slice(0, at), n];
  }
  return [entry, 1];
}

const entryOf = (key: string, version: number) => (version === 1 ? key : `${key}#${version}`);

/** The highest version of each pair, in the order of each pair's latest entry. */
function versions(list: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of list) {
    const [key, n] = parse(entry);
    const had = out.get(key) ?? 0;
    out.delete(key);
    out.set(key, Math.max(had, n));
  }
  return out;
}

function listOf(map: Map<string, number>): string[] {
  return [...map].map(([key, n]) => entryOf(key, n)).slice(-MAX_DISMISSED_SUGGESTIONS);
}

/** The pair keys that are hidden now. */
export function hiddenPairs(list: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const [key, n] of versions(list)) if (n % 2 === 1) out.add(key);
  return out;
}

/** The list after hiding (Not related) or showing (Undo, Restore) one pair. */
export function setPairHidden(list: readonly string[], key: string, hidden: boolean): string[] {
  const map = versions(list);
  const n = map.get(key) ?? 0;
  const isHidden = n % 2 === 1;
  if (isHidden === hidden) return [...list];
  map.delete(key);
  map.set(key, n + 1);
  return listOf(map);
}

/** Two devices' lists: the highest version of each pair wins. */
export function mergeDismissedSuggestions(remote: readonly string[], local: readonly string[]): string[] {
  return listOf(versions([...remote, ...local]));
}
