/**
 * The word-overlap score behind "related": TF-IDF vectors and their cosine.
 * Shared by the help center's "Related questions" (`faqRelated.ts`, at build
 * time in Node) and the Related group of the Connections panel
 * (`relatedNotes.ts`, in the app). Keep it import-free: `help-page.ts`
 * evaluates it next to `faq.ts`.
 *
 * A vector weighs each term by how often the text uses it, damped, times how
 * rare it is across all texts: (1 + ln tf) * ln(N / df). Rare shared words such
 * as "Cappadocia" carry the score; words every text uses carry almost none.
 *
 * Spec: docs/internal/plans/related-notes.md (section 5)
 */

/** A term to its weight, scaled to unit length. */
export type TermVector = Map<string, number>;

/** How often each term occurs in one text. */
export function termCounts(terms: Iterable<string>): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

export type VectorOptions = {
  /** Keep only the heaviest terms of each text (MoreLikeThis keeps 25). */
  topK?: number;
  /** Drop a term found in fewer texts than this: it cannot be shared. */
  minDf?: number;
  /**
   * Drop a term found in more than this share of the texts. It stands in for
   * a stop list in every language: "the", "und" and "est" go, because nearly
   * every note uses them.
   */
  maxDfShare?: number;
};

/**
 * The unit-length TF-IDF vector of one text, against document frequencies
 * `df` over `n` texts. Ties keep the text's own term order, so the result is
 * stable from run to run.
 */
export function termVector(
  tf: ReadonlyMap<string, number>,
  df: ReadonlyMap<string, number>,
  n: number,
  { topK = Infinity, minDf = 1, maxDfShare = 1 }: VectorOptions = {},
): TermVector {
  const maxDf = maxDfShare * n;
  const weighted: [string, number][] = [];
  for (const [term, count] of tf) {
    const d = df.get(term) ?? 0;
    if (d < minDf || d === 0 || d > maxDf) continue;
    const w = (1 + Math.log(count)) * Math.log(n / d);
    if (w > 0) weighted.push([term, w]);
  }
  if (weighted.length > topK) {
    weighted.sort((a, b) => b[1] - a[1]);
    weighted.length = topK;
  }
  let norm = 0;
  for (const [, w] of weighted) norm += w * w;
  norm = Math.sqrt(norm) || 1;
  return new Map(weighted.map(([t, w]) => [t, w / norm]));
}

/** How many texts use each term. */
export function documentFrequencies(counts: Iterable<ReadonlyMap<string, number>>): Map<string, number> {
  const df = new Map<string, number>();
  for (const tf of counts) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return df;
}

/** Cosine of two unit vectors: walks the smaller one. */
export function cosine(a: TermVector, b: TermVector): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let score = 0;
  for (const [t, x] of small) score += x * (large.get(t) ?? 0);
  return score;
}

/**
 * The terms two vectors share, heaviest first by their combined weight: the
 * words a "Both mention ..." line names.
 */
export function sharedTerms(a: TermVector, b: TermVector): string[] {
  const out: [string, number][] = [];
  for (const [t, x] of a) {
    const y = b.get(t);
    if (y !== undefined) out.push([t, x * y]);
  }
  return out.sort((p, q) => q[1] - p[1]).map(([t]) => t);
}

/** The constant of Reciprocal Rank Fusion (Cormack 2009). */
const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: one ranking from several, each id scored by the sum
 * of 1 / (60 + rank) over the lists that hold it. It needs no calibration
 * between the scores of the lists, so word, link and tag rankings add up
 * fairly. Ties keep first appearance.
 */
export function fuseRankings(lists: ReadonlyArray<readonly string[]>): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
