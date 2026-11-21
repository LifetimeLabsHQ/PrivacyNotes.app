/**
 * Tag and folder suggestions and the duplicate line, over the meaning vectors
 * of Smart connections. Pure: the neighbors come in with their scores, so the
 * votes are tested without a model.
 * Spec: docs/internal/specs/plugins-tuning.md (sections 1.7, 2.4, 3.3)
 */

/** Two notes at or above this cosine are shown as a possible duplicate. Spec: docs/internal/specs/plugins-tuning.md (1.7) */
export const DUPLICATE_LINE = 0.85;
/** At most this many pairs, best first. Spec: docs/internal/specs/plugins-tuning.md (1.7) */
export const DUPLICATE_CAP = 50;
/** The neighbors that vote. Spec: docs/internal/specs/plugins-tuning.md (2.4, 3.3) */
export const SUGGEST_NEIGHBORS = 20;
const MIN_VOTES = 2;
/** A tag's weight against the weight of the neighbors that have any tag. Spec: docs/internal/specs/plugins-tuning.md (2.4) */
const TAG_SHARE = 0.3;
/** A folder's weight against the weight of the neighbors in any folder. Spec: docs/internal/specs/plugins-tuning.md (3.3) */
const FOLDER_SHARE = 0.5;
const MAX_TAG_CHIPS = 3;

export type Neighbor = { id: string; score: number };

/**
 * The tags the nearest notes carry, weighted by score, minus the note's own:
 * each with at least two votes and at least 30 % of the weight of the tagged
 * neighbors. Three at most, heaviest first.
 */
export function suggestTags(neighbors: readonly Neighbor[], tagsOf: (id: string) => readonly string[], own: readonly string[]): string[] {
  const have = new Set(own.map((t) => t.toLowerCase()));
  const weight = new Map<string, { w: number; votes: number }>();
  let tagged = 0;
  for (const { id, score } of neighbors) {
    const tags = tagsOf(id);
    if (tags.length === 0) continue;
    tagged += score;
    for (const tag of new Set(tags)) {
      const v = weight.get(tag) ?? { w: 0, votes: 0 };
      v.w += score;
      v.votes++;
      weight.set(tag, v);
    }
  }
  return [...weight]
    .filter(([tag, v]) => !have.has(tag.toLowerCase()) && v.votes >= MIN_VOTES && v.w >= TAG_SHARE * tagged)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, MAX_TAG_CHIPS)
    .map(([tag]) => tag);
}

/**
 * The folder most of the nearest notes live in: at least two votes, and at
 * least half of the weight of the neighbors that are in a folder. Null when
 * they do not agree.
 */
export function suggestFolder(neighbors: readonly Neighbor[], folderOf: (id: string) => string | null): string | null {
  const weight = new Map<string, { w: number; votes: number }>();
  let filed = 0;
  for (const { id, score } of neighbors) {
    const folder = folderOf(id);
    if (!folder) continue;
    filed += score;
    const v = weight.get(folder) ?? { w: 0, votes: 0 };
    v.w += score;
    v.votes++;
    weight.set(folder, v);
  }
  let best: [string, { w: number; votes: number }] | null = null;
  for (const entry of weight) if (!best || entry[1].w > best[1].w) best = entry;
  return best && best[1].votes >= MIN_VOTES && best[1].w >= FOLDER_SHARE * filed ? best[0] : null;
}
