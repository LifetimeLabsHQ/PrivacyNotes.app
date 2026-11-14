import type { LocalNote } from './db';
import { isDemoMode } from './demo';
import type { StaticModel } from './staticEmbed';
import type { NotesIndexOps } from './searchIndexSync';
import { sha256Hex } from './sha256Hex';
import { plainNoteText } from './relatedNotes';
import { CACHE, ENABLED_KEY, MEANING_BYTES, MEANING_FILES, modelBase, setMeaningState } from './onDeviceAi';

/**
 * The heavy half of Smart connections: the download into Cache Storage, the model,
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

/**
 * One model file: from the cache, else downloaded into it with progress. The
 * bytes must match the SHA-256 the app ships with (MEANING_FILES); a cached
 * copy that does not is thrown away and downloaded again, and a download that
 * does not is never stored or loaded.
 */
async function fetchChecked(cache: Cache, url: string, sha256: string, onBytes: (n: number) => void, signal: AbortSignal): Promise<ArrayBuffer> {
  const hit = await cache.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if ((await sha256Hex(buf)) === sha256) {
      onBytes(buf.byteLength);
      return buf;
    }
    await cache.delete(url);
  }
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`model download failed: ${res.status}`);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
    onBytes(value.byteLength);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.byteLength;
  }
  if ((await sha256Hex(buf.buffer)) !== sha256) throw new Error('model file does not match its hash');
  await cache.put(url, new Response(buf));
  return buf.buffer;
}

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
    const cache = await caches.open(CACHE);
    const urls = modelUrls();
    // A file of an older model is never read again.
    for (const req of await cache.keys()) if (!urls.includes(req.url)) await cache.delete(req);
    const [vocab, vectors] = await Promise.all(MEANING_FILES.map((f, i) => fetchChecked(cache, urls[i]!, f.sha256, progress, own.signal)));
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
  } catch {
    model = null;
    // A stopped download: whoever stopped it sets the state.
    if (!own.signal.aborted) setMeaningState({ status: 'error' });
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
    const cache = await caches.open(CACHE);
    kept = (await Promise.all(modelUrls().map((u) => cache.match(u)))).every(Boolean);
  } catch {
    // no Cache Storage here
  }
  setMeaningState({ status: kept ? 'kept' : 'off' });
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
    await caches.delete(CACHE);
  } catch {
    // no Cache Storage here
  }
  resetMeaningIndex();
  setMeaningState({ status: 'off' });
}

// The meaning index: one vector per related source, in memory only.
let vectors = new Map<string, Float32Array>();
let built = false;

// The text the word index reads too: no markup, image syntax or link targets.
const textOf = plainNoteText;

function resetMeaningIndex() {
  vectors = new Map();
  built = false;
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
