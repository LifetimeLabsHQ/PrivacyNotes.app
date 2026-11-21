import { isDemoMode } from '../demo';
import { PLUGINS_ORIGIN } from '../hosts';
import { sha256Hex } from '../sha256Hex';
import { setPluginStopper, stopJobsForPlugin } from './jobs';
import { fileNameOf, openPluginStore, type PluginStore } from './pluginStore';
import { endPluginWorker } from './workerHost';
import { pluginFlagOn, pluginState, setPluginFlag, setPluginState, type PluginId, type PluginKey } from './pluginState';
import { PLUGINS, RUNTIME_FILES, TRANSLATE_MODEL, pluginEntry, translateFiles, type PluginFile } from './registry';

/**
 * The heavy half of the plugin manager: the download into the plugin store
 * (`pluginStore.ts`: a folder of the app's own in the desktop apps, Cache
 * Storage elsewhere), the
 * hash check of every file, the kept files, Remove. Loaded on demand by the
 * Plugins pane and by a plugin's first use, never at boot.
 *
 * The main thread fetches and checks every file; a plugin's worker gets the
 * bytes and never fetches (D22). Smart connections keeps its own cache and
 * flag (`onDeviceAiModel.ts`), so nobody downloads it again; it shares
 * `fetchChecked`.
 * Spec: docs/internal/plans/plugins.md (section 3)
 */

// Every plugin that runs in a worker stops by ending its own worker: a WASM
// call cannot stop halfway, and the next use starts a new one.
for (const id of ['ocr', 'translate', 'voice', 'cleanup'] as const) setPluginStopper(id, () => endPluginWorker(id));

/** The store of every plugin but Smart connections. */
const plugins = () => openPluginStore('pn-plugins');

/**
 * Where the files are served: the plugin host. A development build reads the
 * copy that `tools/plugin-files/fetch.mjs` writes into
 * `packages/web/node_modules/.cache/pn-plugins/`.
 */
function pluginBase(): string {
  return import.meta.env.DEV ? '/node_modules/.cache/pn-plugins/' : `${PLUGINS_ORIGIN}/`;
}

/** The device refused to store the bytes. */
export const isQuotaError = (e: unknown): boolean => e instanceof DOMException && e.name === 'QuotaExceededError';

/**
 * One file: from the cache, else downloaded into it with progress. The bytes
 * must match the pinned SHA-256: a cached copy that does not is thrown away
 * and downloaded again, and a download that does not is never stored. A
 * download is never read past its pinned size: an answer that says it is
 * larger, or runs past it, is refused before it fills memory (beta #218).
 */
export async function fetchChecked(
  store: PluginStore,
  url: string,
  pin: { sha256: string; bytes: number },
  onBytes: (n: number) => void,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const name = fileNameOf(url);
  const kept = await store.read(name);
  if (kept) {
    if ((await sha256Hex(kept)) === pin.sha256) {
      onBytes(kept.byteLength);
      return kept;
    }
    await store.remove(name);
  }
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`plugin download failed: ${res.status}`);
  // A compressed answer may say less than the pinned size, never more.
  const declared = Number(res.headers.get('Content-Length'));
  if (declared > pin.bytes) {
    await res.body.cancel();
    throw new Error('plugin file is larger than its pin');
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > pin.bytes) {
      await reader.cancel();
      throw new Error('plugin file is larger than its pin');
    }
    parts.push(value);
    onBytes(value.byteLength);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.byteLength;
  }
  if ((await sha256Hex(buf.buffer)) !== pin.sha256) throw new Error('plugin file does not match its hash');
  await store.write(name, buf);
  return buf.buffer;
}

const urlOf = (f: PluginFile) => new URL(`${pluginBase()}${f.path}`, location.href).href;

/** The files a key needs, its own first; a Translate language brings the Translate engine. */
function filesOf(key: PluginKey): PluginFile[] {
  if (key.startsWith('translate.')) return [...pluginEntry('translate').files, ...translateFiles(key.slice('translate.'.length))];
  return [...pluginEntry(key as PluginId).files];
}

const needsRuntime = (key: PluginKey) => !key.startsWith('translate.') && pluginEntry(key as PluginId).needsRuntime;

/** Every key that can hold files in `pn-plugins` (Smart connections has its own store). */
function pluginKeys(): PluginKey[] {
  const langs = new Set(Object.values(TRANSLATE_MODEL));
  return [...PLUGINS.filter((p) => p.id !== 'smartConnections' && p.id !== 'translate').map((p) => p.id), ...[...langs].map((m) => `translate.${m}` as PluginKey)];
}

async function cachedNames(): Promise<Set<string>> {
  try {
    return new Set(await (await plugins()).names());
  } catch {
    return new Set();
  }
}

const hasAll = (names: Set<string>, files: readonly PluginFile[]) => files.every((f) => names.has(fileNameOf(f.path)));

/** Every download that runs or waits, by key. */
const downloads = new Map<PluginKey, AbortController>();

/**
 * One download at a time: each waits for the one before it to end. So two
 * plugins never fetch the shared runtime twice (the second finds it in the
 * cache), and nothing is half-stored by two writers at once.
 */
let queue: Promise<void> = Promise.resolve();

/**
 * Downloads (or finds in the cache) every file of a plugin, the runtime first
 * when it needs one, then turns it on for this device. The plugin loads on its
 * first use. A download behind another one shows as waiting, with Cancel. The
 * demo cannot download.
 */
export async function downloadPlugin(key: PluginKey): Promise<void> {
  if (isDemoMode()) {
    setPluginState(key, { status: 'unavailable' });
    return;
  }
  // Already running or waiting: a second tap adds nothing.
  if (downloads.has(key)) return;
  const own = new AbortController();
  downloads.set(key, own);
  const files = [...(needsRuntime(key) ? RUNTIME_FILES : []), ...filesOf(key)];
  const total = files.reduce((s, f) => s + f.bytes, 0);
  let loaded = 0;
  const before = queue;
  let done!: () => void;
  queue = new Promise((resolve) => (done = resolve));
  setPluginState(key, { status: 'downloading', loaded, total, waiting: true });
  try {
    await before;
    // Canceled or removed while it waited: whoever stopped it set the state.
    if (own.signal.aborted) return;
    setPluginState(key, { status: 'downloading', loaded, total });
    const store = await plugins();
    // One file at a time, so a 250 MB plugin never sits in memory whole.
    for (const f of files) {
      await fetchChecked(store, urlOf(f), f, (n) => {
        loaded += n;
        if (!own.signal.aborted) setPluginState(key, { status: 'downloading', loaded: Math.min(loaded, total), total });
      }, own.signal);
      own.signal.throwIfAborted();
    }
    setPluginFlag(key, true);
    setPluginState(key, { status: 'on' });
  } catch (e) {
    // A stopped download: whoever stopped it sets the state.
    if (!own.signal.aborted) setPluginState(key, isQuotaError(e) ? { status: 'error', reason: 'space' } : { status: 'error' });
  } finally {
    if (downloads.get(key) === own) downloads.delete(key);
    done();
  }
}

/** Cancel: stops a download, or takes a waiting one out of the queue. A file already complete stays in the cache. */
export async function cancelPluginDownload(key: PluginKey): Promise<void> {
  downloads.get(key)?.abort();
  downloads.delete(key);
  await checkKeptPlugin(key, true);
}

/**
 * Whether this device holds every file of a plugin: `on` or `kept` by its
 * flag, `needsPro` on a free account (D23), else `off`. Only a look at the
 * cache; the hashes are checked when a file loads.
 */
export async function checkKeptPlugin(key: PluginKey, isPro: boolean): Promise<void> {
  // The demo shares Cache Storage with a signed-in tab: it never reads, offers or removes that copy.
  if (isDemoMode()) return;
  if (downloads.has(key) || pluginState(key).status === 'loading') return;
  const kept = hasAll(await cachedNames(), [...(needsRuntime(key) ? RUNTIME_FILES : []), ...filesOf(key)]);
  const pro = key.startsWith('translate.') || pluginEntry(key as PluginId).pro;
  if (!kept) setPluginState(key, { status: 'off' });
  else if (!isPro && pro) setPluginState(key, { status: 'needsPro' });
  else setPluginState(key, { status: pluginFlagOn(key) ? 'on' : 'kept' });
}

/** The switch: off keeps the files, so on again downloads nothing. Turning off stops the plugin's jobs. */
export function setPluginOn(key: PluginKey, on: boolean): void {
  setPluginFlag(key, on);
  if (!on && !key.startsWith('translate.')) stopJobsForPlugin(key as PluginId);
  // An engine that is off leaves memory with its plugin's worker.
  if (!on) endPluginWorker(key.startsWith('translate.') ? 'translate' : key);
  setPluginState(key, { status: on ? 'on' : 'kept' });
}

/**
 * Removes a plugin's files from this device. The runtime goes with the last
 * plugin that needs it, and the Translate engine with the last language.
 */
export async function removePlugin(key: PluginKey): Promise<void> {
  downloads.get(key)?.abort();
  downloads.delete(key);
  stopJobsForPlugin(key.startsWith('translate.') ? 'translate' : (key as PluginId));
  endPluginWorker(key.startsWith('translate.') ? 'translate' : key);
  setPluginFlag(key, false);
  const names = await cachedNames();
  // A download that runs or waits counts as here: its files and the runtime stay.
  const others = pluginKeys().filter((k) => k !== key && (hasAll(names, filesOf(k)) || downloads.has(k)));
  const keep = new Set(others.flatMap((k) => filesOf(k).map((f) => fileNameOf(f.path))));
  if (others.some(needsRuntime)) for (const f of RUNTIME_FILES) keep.add(fileNameOf(f.path));
  const drop = new Set([...filesOf(key), ...RUNTIME_FILES].map((f) => fileNameOf(f.path)).filter((n) => !keep.has(n)));
  try {
    const store = await plugins();
    for (const name of await store.names()) if (drop.has(name)) await store.remove(name);
  } catch {
    // no store here
  }
  setPluginState(key, { status: 'off' });
}

/** "Remove all": every plugin file, the runtime and every flag of `pn-plugins`. */
export async function removeAllPlugins(): Promise<void> {
  for (const key of pluginKeys()) {
    downloads.get(key)?.abort();
    setPluginFlag(key, false);
    if (!key.startsWith('translate.')) stopJobsForPlugin(key as PluginId);
  }
  stopJobsForPlugin('translate');
  downloads.clear();
  try {
    await (await plugins()).clear();
  } catch {
    // no store here
  }
  endPluginWorker();
  for (const key of pluginKeys()) setPluginState(key, { status: 'off' });
}

/**
 * The bytes on this device, per key that holds files, and the runtime, for
 * the storage strip. A key counts only when every file is there.
 */
export async function pluginStorage(): Promise<{ key: PluginKey; bytes: number }[]> {
  if (isDemoMode()) return [];
  const names = await cachedNames();
  const out: { key: PluginKey; bytes: number }[] = [];
  for (const key of pluginKeys()) {
    const own = key.startsWith('translate.') ? translateFiles(key.slice('translate.'.length)) : filesOf(key);
    if (hasAll(names, filesOf(key))) out.push({ key, bytes: own.reduce((s, f) => s + f.bytes, 0) });
  }
  return out;
}

/** The bytes of the shared engines on this device: the runtime and the Translate engine. */
export async function engineStorage(): Promise<number> {
  if (isDemoMode()) return 0;
  const names = await cachedNames();
  return [...RUNTIME_FILES, ...pluginEntry('translate').files].filter((f) => names.has(fileNameOf(f.path))).reduce((s, f) => s + f.bytes, 0);
}

/**
 * One checked file for a plugin's worker: from the cache, or downloaded again
 * when the cached copy is gone or damaged. A copy that does not match its hash
 * is never handed over.
 */
export async function readPluginFile(f: PluginFile, signal: AbortSignal): Promise<ArrayBuffer> {
  return fetchChecked(await plugins(), urlOf(f), f, () => {}, signal);
}
