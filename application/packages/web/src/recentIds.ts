/**
 * Bounded MRU id lists stored in localStorage (used by Ninja's `>` recent
 * commands and the editor's `/` slash menu without pulling `ninjaFeatures.ts`
 * onto the editor boot path).
 */

/** Read a bounded recent-id list from localStorage, newest first; empty when storage is unavailable. */
export function readRecentIds(storageKey: string, max: number): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, max) : [];
  } catch {
    return [];
  }
}

/** Put an id first in a bounded recent-id list in localStorage. */
export function noteRecentId(storageKey: string, id: string, max: number): void {
  try {
    const next = [id, ...readRecentIds(storageKey, max).filter((x) => x !== id)].slice(0, max);
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // A private window or blocked storage: the list stays as it was.
  }
}
