import type { LocalNote } from './db';
import { hasCJK } from './cjkSegment';
import { perfSpan } from './perf';
import { cosine, fuseRankings, sharedTerms, termCounts, termVector, type TermVector } from './relatedCore';
import { termsWithWords } from './search';
import { stripToPlainText } from './notesViewUtils';
import type { NotesIndexOps } from './searchIndexSync';

/**
 * The Related group of the Connections panel: notes the open note does not
 * link, but that are about the same thing. Three signals, each a ranking of
 * its own, fused by Reciprocal Rank Fusion (`fuseRankings`):
 *
 * - Words: the open note's 25 heaviest terms by TF-IDF, compared by cosine
 *   with every note that shares one of them (the MoreLikeThis method).
 * - Links: notes that link to the same note, and notes linked from the same
 *   note, weighed by how rare that shared note's links are (Adamic-Adar).
 * - Tags: a shared tag that few notes carry.
 * - Meaning, when the user turned on the on-device model (onDeviceAi.ts):
 *   the notes nearest in meaning. It joins the fusion; it never replaces words.
 *
 * Every hit carries its reason, so the panel can say why it is there. Only
 * markdown notes that are listable take part: never a PIN-protected or locked
 * note, never a vault entry or a contact (`isEligible` in the caller). The
 * index lives in memory only, like the search index, and is never persisted.
 *
 * Spec: docs/internal/plans/related-notes.md (section 5)
 */

// Spec: docs/internal/plans/related-notes.md (section 5)
const TOP_TERMS = 25;
const MIN_DF = 2;
const MAX_DF_SHARE = 0.2;
/** Below this cosine a word match is noise. Precision over recall. */
const MIN_WORD_SCORE = 0.12;
const MIN_SHARED_WORDS = 2;
/** A note with more links than this is a hub (an index note): it relates nothing. */
const MAX_HUB_LINKS = 30;
/** A tag on more than this share of notes says nothing about a pair. */
const MAX_TAG_SHARE = 0.1;
const MAX_RELATED = 5;
/** How many hits per signal go into the fusion. */
const PER_SIGNAL = 20;
/** Below this many notes, word rarity means nothing. */
const MIN_NOTES = 5;

/**
 * The text a note is scored by: the title counts twice, as in the help
 * center, and the body is read as the list row reads it (`stripToPlainText`),
 * so markup and link targets add no words.
 */
function scoredText(n: Pick<LocalNote, 'title' | 'body'>): string {
  return `${n.title}\n${plainNoteText(n)}`;
}

/**
 * A note as plain text, read as the list row reads it: markup, image syntax
 * and link targets add no words. The meaning index reads the same text
 * (onDeviceAiModel.ts), so a file note does not match another on its markup.
 * Spec: docs/internal/plans/related-notes.md (section 4e)
 */
export function plainNoteText(n: Pick<LocalNote, 'title' | 'body'>): string {
  return `${n.title}\n${n.body.split('\n').map(stripToPlainText).join('\n')}`;
}

/**
 * English words too common to say two notes share a topic. The rarity cut
 * (MAX_DF_SHARE) drops them in a large library, but in a small one "for" or
 * "with" can pass it and end up in the reason line ("Buy and for"). Three
 * letters and up only: shorter terms never count (keepTerm).
 * Spec: docs/internal/plans/related-notes.md (section 9, "Not related")
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'him', 'his',
  'how', 'its', 'may', 'new', 'now', 'own', 'she', 'too', 'use', 'way', 'who', 'did', 'get', 'got', 'let', 'say', 'yet', 'off',
  'with', 'that', 'this', 'from', 'have', 'they', 'will', 'your', 'what', 'when', 'were', 'been', 'than', 'then', 'them', 'into',
  'just', 'also', 'more', 'some', 'very', 'only', 'over', 'such', 'each', 'much', 'most', 'here', 'there', 'their', 'these', 'those',
  'which', 'would', 'could', 'should', 'about', 'after', 'before', 'other', 'where', 'while', 'being', 'does', 'done', 'make',
]);

/** A term worth scoring: long enough to mean something, not a number, not a common word. */
function keepTerm(term: string): boolean {
  if (/^\d+$/.test(term) || STOP_WORDS.has(term)) return false;
  return hasCJK(term) ? term.length >= 2 : term.length >= 3;
}

function noteTerms(n: Pick<LocalNote, 'title' | 'body'>): Array<[string, string]> {
  return termsWithWords(scoredText(n)).filter(([term]) => keepTerm(term));
}

// The index. Module state, like search.ts: one per app.
let tfs = new Map<string, Map<string, number>>();
let df = new Map<string, number>();
let vectors = new Map<string, TermVector>();
let postings = new Map<string, Set<string>>();
let tagNotes = new Map<string, Set<string>>();
let ready = false;
/** Notes re-weighed one at a time since the last full build: the others still use older rarities. */
let drift = 0;

/** The vector options for a library of `n` notes: a small one still lets a word shared by two count. */
const vectorOptions = (n: number) => ({ topK: TOP_TERMS, minDf: MIN_DF, maxDfShare: Math.max(MAX_DF_SHARE, MIN_DF / n) });

const vectorOf = (tf: ReadonlyMap<string, number>, n: number) => termVector(tf, df, n, vectorOptions(n));

function addPostings(id: string, vec: TermVector) {
  for (const term of vec.keys()) {
    const set = postings.get(term);
    if (set) set.add(id);
    else postings.set(term, new Set([id]));
  }
}

function dropPostings(id: string, vec: TermVector | undefined) {
  if (!vec) return;
  for (const term of vec.keys()) postings.get(term)?.delete(id);
}

function addTags(n: LocalNote) {
  for (const tag of n.tags) {
    const set = tagNotes.get(tag);
    if (set) set.add(n.id);
    else tagNotes.set(tag, new Set([n.id]));
  }
}

function dropNote(id: string) {
  const tf = tfs.get(id);
  if (tf) for (const term of tf.keys()) {
    const d = (df.get(term) ?? 1) - 1;
    if (d > 0) df.set(term, d);
    else df.delete(term);
  }
  dropPostings(id, vectors.get(id));
  for (const set of tagNotes.values()) set.delete(id);
  tfs.delete(id);
  vectors.delete(id);
}

function addNote(n: LocalNote) {
  const tf = termCounts(noteTerms(n).map(([term]) => term));
  tfs.set(n.id, tf);
  for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  addTags(n);
}

function relatedIndexReady(): boolean {
  return ready;
}

/** A full build beats updates when most notes changed, or the rarities drifted. */
export function wantsFullRelatedBuild(changed: { added: string[]; updated: string[] }): boolean {
  const size = tfs.size;
  return !ready || changed.added.length + changed.updated.length > size / 2 || drift > Math.max(20, size / 10);
}

const SLICE_MS = 12;
const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The full build, in slices of about SLICE_MS so a large vault never blocks input. */
export async function buildRelatedIndexSliced(notes: LocalNote[]): Promise<void> {
  const end = perfSpan('buildRelatedIndex');
  const nextTfs = new Map<string, Map<string, number>>();
  const nextTags = new Map<string, Set<string>>();
  let sliceStart = performance.now();
  const breathe = async () => {
    if (performance.now() - sliceStart > SLICE_MS) {
      await yieldToMain();
      sliceStart = performance.now();
    }
  };
  for (const n of notes) {
    nextTfs.set(n.id, termCounts(noteTerms(n).map(([term]) => term)));
    for (const tag of n.tags) {
      const set = nextTags.get(tag);
      if (set) set.add(n.id);
      else nextTags.set(tag, new Set([n.id]));
    }
    await breathe();
  }
  const nextDf = new Map<string, number>();
  for (const tf of nextTfs.values()) for (const term of tf.keys()) nextDf.set(term, (nextDf.get(term) ?? 0) + 1);
  const nextVectors = new Map<string, TermVector>();
  const nextPostings = new Map<string, Set<string>>();
  for (const [id, tf] of nextTfs) {
    const vec = termVector(tf, nextDf, nextTfs.size, vectorOptions(nextTfs.size));
    nextVectors.set(id, vec);
    for (const term of vec.keys()) {
      const set = nextPostings.get(term);
      if (set) set.add(id);
      else nextPostings.set(term, new Set([id]));
    }
    await breathe();
  }
  tfs = nextTfs;
  df = nextDf;
  vectors = nextVectors;
  postings = nextPostings;
  tagNotes = nextTags;
  drift = 0;
  ready = true;
  end();
}

/** Applies a few changed notes. The other notes keep their vectors until the next full build. */
export function updateRelatedIndex(
  notes: LocalNote[],
  changed: { added: string[]; updated: string[]; removed: string[] },
): void {
  const byId = new Map(notes.map((n) => [n.id, n]));
  for (const id of [...changed.removed, ...changed.updated]) dropNote(id);
  const fresh: string[] = [];
  for (const id of [...changed.updated, ...changed.added]) {
    const n = byId.get(id);
    if (!n || tfs.has(id)) continue;
    addNote(n);
    fresh.push(id);
  }
  for (const id of fresh) {
    const vec = vectorOf(tfs.get(id)!, tfs.size);
    vectors.set(id, vec);
    addPostings(id, vec);
  }
  drift += changed.added.length + changed.updated.length + changed.removed.length;
}

/** Why a note is in the Related list. */
export type RelatedReason =
  | { kind: 'words'; words: string[] }
  | { kind: 'linksTo'; via: string }
  | { kind: 'linkedFrom'; via: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'meaning' };

export type RelatedHit = { id: string; reason: RelatedReason };

/**
 * The links the ranking reads: `buildLinkIndex`'s maps, or a view of them in
 * which the open note's own links come from the text being edited.
 */
export type RelatedLinks = {
  incoming: { get(id: string): readonly string[] | undefined };
  outgoing: { get(id: string): { ids: readonly string[] } | undefined };
};

type Ranked<T> = { id: string; score: number; reason: T }[];

function wordHits(note: Pick<LocalNote, 'id' | 'title' | 'body'>, skip: (id: string) => boolean): Ranked<RelatedReason> {
  const n = tfs.size;
  if (!ready || n < MIN_NOTES) return [];
  const pairs = noteTerms(note);
  // The open note's own spelling of each term, for the reason line.
  const spelled = new Map<string, string>();
  for (const [term, word] of pairs) if (!spelled.has(term)) spelled.set(term, word);
  const vec = vectorOf(termCounts(pairs.map(([term]) => term)), n);
  const candidates = new Set<string>();
  for (const term of vec.keys()) for (const id of postings.get(term) ?? []) if (!skip(id)) candidates.add(id);
  const out: Ranked<RelatedReason> = [];
  for (const id of candidates) {
    const other = vectors.get(id);
    if (!other) continue;
    const score = cosine(vec, other);
    if (score < MIN_WORD_SCORE) continue;
    const shared = sharedTerms(vec, other);
    if (shared.length < MIN_SHARED_WORDS) continue;
    out.push({ id, score, reason: { kind: 'words', words: shared.slice(0, 2).map((t) => spelled.get(t) ?? t) } });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, PER_SIGNAL);
}

function linkHits(id: string, links: RelatedLinks, skip: (id: string) => boolean): Ranked<RelatedReason> {
  const score = new Map<string, { score: number; best: number; reason: RelatedReason }>();
  const add = (other: string, weight: number, reason: RelatedReason) => {
    if (skip(other)) return;
    const cur = score.get(other);
    if (!cur) score.set(other, { score: weight, best: weight, reason });
    else {
      cur.score += weight;
      if (weight > cur.best) Object.assign(cur, { best: weight, reason });
    }
  };
  // Both link to the same note.
  for (const via of links.outgoing.get(id)?.ids ?? []) {
    const sources = links.incoming.get(via) ?? [];
    if (sources.length < 2 || sources.length > MAX_HUB_LINKS) continue;
    const weight = 1 / Math.log(1 + sources.length);
    for (const other of sources) add(other, weight, { kind: 'linksTo', via });
  }
  // Both linked from the same note.
  for (const via of links.incoming.get(id) ?? []) {
    const targets = links.outgoing.get(via)?.ids ?? [];
    if (targets.length < 2 || targets.length > MAX_HUB_LINKS) continue;
    const weight = 1 / Math.log(1 + targets.length);
    for (const other of targets) add(other, weight, { kind: 'linkedFrom', via });
  }
  return [...score.entries()]
    .map(([other, s]) => ({ id: other, score: s.score, reason: s.reason }))
    .sort((a, b) => b.score - a.score)
    .slice(0, PER_SIGNAL);
}

function tagHits(note: Pick<LocalNote, 'tags'>, skip: (id: string) => boolean): Ranked<RelatedReason> {
  const n = tfs.size;
  if (n < MIN_NOTES) return [];
  const score = new Map<string, { score: number; best: number; tag: string }>();
  for (const tag of note.tags) {
    const holders = tagNotes.get(tag);
    if (!holders || holders.size < 2 || holders.size > Math.max(2, MAX_TAG_SHARE * n)) continue;
    const weight = Math.log(n / holders.size);
    for (const other of holders) {
      if (skip(other)) continue;
      const cur = score.get(other);
      if (!cur) score.set(other, { score: weight, best: weight, tag });
      else {
        cur.score += weight;
        if (weight > cur.best) Object.assign(cur, { best: weight, tag });
      }
    }
  }
  return [...score.entries()]
    .map(([other, s]) => ({ id: other, score: s.score, reason: { kind: 'tag' as const, tag: s.tag } }))
    .sort((a, b) => b.score - a.score)
    .slice(0, PER_SIGNAL);
}

/**
 * The related notes of one note, best first, at most MAX_RELATED. A note the
 * open note links to, or that links to it, is already in the panel and never
 * listed again. `isListable` says whether an id may be shown (live, markdown,
 * not PIN-protected, not locked).
 */
export function relatedNotes(
  note: Pick<LocalNote, 'id' | 'title' | 'body' | 'tags'>,
  links: RelatedLinks,
  isListable: (id: string) => boolean,
  /** The ids nearest in meaning, best first (`meaningHits`); absent while the model is off. */
  meaning?: (skip: (id: string) => boolean, limit: number) => string[],
): RelatedHit[] {
  const linked = new Set<string>([note.id, ...(links.outgoing.get(note.id)?.ids ?? []), ...(links.incoming.get(note.id) ?? [])]);
  const skip = (id: string) => linked.has(id) || !isListable(id);
  const meaningList: Ranked<RelatedReason> = (meaning?.(skip, PER_SIGNAL) ?? [])
    .map((id, rank) => ({ id, score: -rank, reason: { kind: 'meaning' } }));
  const signals = [wordHits(note, skip), linkHits(note.id, links, skip), tagHits(note, skip), meaningList];
  const reasonOf = new Map<string, RelatedReason>();
  // The reason shown is the signal where the note ranks best; words win a tie.
  const bestRank = new Map<string, number>();
  for (const list of signals) {
    list.forEach((hit, rank) => {
      if (rank < (bestRank.get(hit.id) ?? Infinity)) {
        bestRank.set(hit.id, rank);
        reasonOf.set(hit.id, hit.reason);
      }
    });
  }
  return fuseRankings(signals.map((list) => list.map((h) => h.id)))
    .slice(0, MAX_RELATED)
    .map((id) => ({ id, reason: reasonOf.get(id)! }));
}

/** The index as `useIndexSync` drives it. */
export const RELATED_INDEX: NotesIndexOps = {
  ready: relatedIndexReady,
  wantsFullBuild: wantsFullRelatedBuild,
  update: updateRelatedIndex,
  buildSliced: buildRelatedIndexSliced,
};

/** Clears the index. For the tests. */
export function resetRelatedIndex(): void {
  tfs = new Map();
  df = new Map();
  vectors = new Map();
  postings = new Map();
  tagNotes = new Map();
  ready = false;
  drift = 0;
}
