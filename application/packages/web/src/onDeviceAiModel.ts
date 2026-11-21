import type { LocalNote } from './db';
import { isDemoMode } from './demo';
import type { StaticModel } from './staticEmbed';
import type { NotesIndexOps } from './searchIndexSync';
import { plainNoteText } from './relatedNotes';
import { CACHE, ENABLED_KEY, MEANING_BYTES, MEANING_FILES, modelBase, setMeaningIndexReady, setMeaningState } from './onDeviceAi';
import { fetchChecked, isQuotaError } from './plugins/pluginManager';
import { openPluginStore } from './plugins/pluginStore';
import { DUPLICATE_CAP, DUPLICATE_LINE, type Neighbor } from './plugins/smartSuggest';

/**
 * The heavy half of Smart connections: the download into the plugin store, the model,
 * and the meaning vectors of the notes (memory only). Loaded on demand by
 * `onDeviceAi.ts` and the settings pane, so none of it is on the boot path.
 * Spec: docs/internal/plans/related-notes.md (part 2)
 */

let model: StaticModel | null = null;
/** The download in progress, so Cancel can stop it. */
let download: AbortController | null = null;

/** The cache addresses of the model files of this build. */
function modelUrls(): string[] {
  const root = modelBase();
  return MEANING_FILES.map((f) => new URL(`${root}${f.name}`, location.href).href);
}

const MEANING_NAMES: readonly string[] = MEANING_FILES.map((f) => f.name);

/** Downloads (or reads from the cache) and loads the model, then turns meaning on for this device. */
export async function turnMeaningOn(): Promise<void> {
  if (isDemoMode()) {
    setMeaningState({ status: 'unavailable' });
    return;
  }
  download?.abort();
  const own = new AbortController();
  download = own;
  let loaded = 0;
  const total = MEANING_BYTES;
  setMeaningState({ status: 'downloading', loaded, total });
  const progress = (n: number) => {
    loaded += n;
    setMeaningState({ status: 'downloading', loaded: Math.min(loaded, total), total });
  };
  try {
    const store = await openPluginStore(CACHE);
    const urls = modelUrls();
    // A file of an older model is never read again.
    for (const name of await store.names()) if (!MEANING_NAMES.includes(name)) await store.remove(name);
    const [vocab, vectors] = await Promise.all(MEANING_FILES.map((f, i) => fetchChecked(store, urls[i]!, f, progress, own.signal)));
    own.signal.throwIfAborted();
    setMeaningState({ status: 'loading' });
    // The loader itself loads only now: it stays off the boot path.
    const { loadStaticModel } = await import('./staticEmbed');
    model = loadStaticModel(new TextDecoder().decode(vocab), vectors!);
    try {
      localStorage.setItem(ENABLED_KEY, '1');
    } catch {
      // A private window: on for this session only.
    }
    setMeaningState({ status: 'on' });
  } catch (e) {
    model = null;
    // A stopped download: whoever stopped it sets the state.
    if (!own.signal.aborted) setMeaningState(isQuotaError(e) ? { status: 'error', reason: 'space' } : { status: 'error' });
  } finally {
    if (download === own) download = null;
  }
}

function stopDownload(): void {
  download?.abort();
  download = null;
}

/** Cancel: stops a download in progress. A file already complete stays in the cache. */
export async function cancelMeaningDownload(): Promise<void> {
  stopDownload();
  await checkKeptModel();
}

/** Turns meaning off and keeps the model on this device, so turning it on again downloads nothing. */
export function turnMeaningOff(): void {
  model = null;
  try {
    localStorage.removeItem(ENABLED_KEY);
  } catch {
    // nothing stored
  }
  resetMeaningIndex();
  setMeaningState({ status: 'kept' });
}

/**
 * While meaning is off: whether this device still holds the model files, so
 * the settings row shows the switch instead of the download. Only a look at
 * the cache; the hashes are checked when it turns on.
 */
export async function checkKeptModel(): Promise<void> {
  // The demo shares Cache Storage with a signed-in tab of the same origin:
  // it never reads, offers or removes that copy.
  if (isDemoMode()) return;
  let kept = false;
  try {
    const names = await (await openPluginStore(CACHE)).names();
    kept = MEANING_NAMES.every((n) => names.includes(n));
  } catch {
    // no Cache Storage here
  }
  setMeaningState({ status: kept ? 'kept' : 'off' });
}

/**
 * A free account (D23): the model leaves memory and the index goes, but the
 * file and the device's flag stay, so Pro again loads it with no download.
 */
export function suspendMeaning(): void {
  stopDownload();
  model = null;
  resetMeaningIndex();
  setMeaningState({ status: 'needsPro' });
}

/** Turns meaning off and deletes the model from this device. */
export async function removeMeaning(): Promise<void> {
  stopDownload();
  model = null;
  try {
    localStorage.removeItem(ENABLED_KEY);
  } catch {
    // nothing stored
  }
  try {
    await (await openPluginStore(CACHE)).clear();
  } catch {
    // no store here
  }
  resetMeaningIndex();
  setMeaningState({ status: 'off' });
}

// The meaning index: one vector per related source, in memory only.
let vectors = new Map<string, Float32Array>();
let built = false;

// The text the word index reads too: no markup, image syntax or link targets.
const textOf = plainNoteText;

/** Empties the index; the next pass of `useIndexSync` builds it again. */
export function resetMeaningIndex() {
  vectors = new Map();
  built = false;
  setMeaningIndexReady(false);
}

const SLICE_MS = 12;
const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The index as `useIndexSync` drives it. Fed no notes while the model is off. */
export const MEANING_INDEX_OPS: NotesIndexOps = {
  ready: () => built,
  wantsFullBuild: (changed) => !built || changed.added.length + changed.updated.length > vectors.size / 2,
  update: (notes, changed) => {
    if (!model) return;
    const byId = new Map(notes.map((n) => [n.id, n]));
    for (const id of changed.removed) vectors.delete(id);
    for (const id of [...changed.added, ...changed.updated]) {
      const n = byId.get(id);
      const v = n && model.embed(textOf(n));
      if (v) vectors.set(id, v);
      else vectors.delete(id);
    }
  },
  buildSliced: async (notes) => {
    const next = new Map<string, Float32Array>();
    let sliceStart = performance.now();
    for (const n of notes) {
      if (!model) return;
      const v = model.embed(textOf(n));
      if (v) next.set(n.id, v);
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToMain();
        sliceStart = performance.now();
      }
    }
    vectors = next;
    built = notes.length > 0;
    setMeaningIndexReady(built);
  },
};

/** Cosine of two unit vectors. */
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Below this cosine two notes are not about the same thing. Measured on
 * Wikipedia text in seven languages: unrelated notes stay below about 0.34,
 * while the same topic in another language is often 0.43 to 0.49, which a
 * line of 0.5 cut off. Spec: docs/internal/plans/related-notes.md (section 4g)
 */
const MIN_MEANING = 0.42;

/** The notes nearest in meaning to one note, with their scores, best first. Empty while meaning is off. */
export function nearestScored(note: Pick<LocalNote, 'id' | 'title' | 'body'>, skip: (id: string) => boolean, limit: number): Neighbor[] {
  if (!model || !built) return [];
  const v = vectors.get(note.id) ?? model.embed(textOf(note));
  if (!v) return [];
  const out: Neighbor[] = [];
  for (const [id, w] of vectors) {
    if (id === note.id || skip(id)) continue;
    const s = dot(v, w);
    if (s >= MIN_MEANING) out.push({ id, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Cosine of two unit vectors, four at a time: the pair scan runs it n² / 2 times. */
function dot4(a: Float32Array, b: Float32Array): number {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n = a.length - (a.length % 4);
  let i = 0;
  for (; i < n; i += 4) {
    s0 += a[i]! * b[i]!;
    s1 += a[i + 1]! * b[i + 1]!;
    s2 += a[i + 2]! * b[i + 2]!;
    s3 += a[i + 3]! * b[i + 3]!;
  }
  for (; i < a.length; i++) s0 += a[i]! * b[i]!;
  return s0 + s1 + s2 + s3;
}

/**
 * Pairs of notes at or above the duplicate line, best first, at most
 * DUPLICATE_CAP. Runs in 12 ms slices so a large vault never blocks the page.
 * `take` leaves out notes that do not take part (journal entries, D21);
 * `hidden` leaves out pairs the user marked "Not duplicates".
 * Spec: docs/internal/specs/plugins-tuning.md (sections 1.6, 1.7)
 */
export async function findDuplicates(take: (id: string) => boolean, hidden: (a: string, b: string) => boolean, signal?: AbortSignal): Promise<{ a: string; b: string; score: number }[]> {
  if (!model || !built) return [];
  const list = [...vectors].filter(([id]) => take(id));
  const out: { a: string; b: string; score: number }[] = [];
  let sliceStart = performance.now();
  for (let i = 0; i < list.length; i++) {
    const [a, va] = list[i]!;
    for (let j = i + 1; j < list.length; j++) {
      const [b, vb] = list[j]!;
      const s = dot4(va, vb);
      if (s >= DUPLICATE_LINE && !hidden(a, b)) out.push({ a, b, score: s });
    }
    if (performance.now() - sliceStart > SLICE_MS) {
      await yieldToMain();
      if (signal?.aborted || !model) return [];
      sliceStart = performance.now();
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, DUPLICATE_CAP);
}

/** The notes nearest in meaning to one note, best first. Empty while meaning is off. */
export function nearestInMeaning(note: Pick<LocalNote, 'id' | 'title' | 'body'>, skip: (id: string) => boolean, limit: number): string[] {
  if (!model || !built) return [];
  const v = vectors.get(note.id) ?? model.embed(textOf(note));
  if (!v) return [];
  const out: { id: string; s: number }[] = [];
  for (const [id, w] of vectors) {
    if (skip(id)) continue;
    const s = dot(v, w);
    if (s >= MIN_MEANING) out.push({ id, s });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, limit).map((h) => h.id);
}
