import { detectPlatform } from '../devices';
import { PLUGINS_ORIGIN } from '../hosts';

/**
 * Where the files of Settings > Plugins are kept, by file name. The desktop
 * apps keep them in a folder of their own under the app's data folder
 * (`plugin_files.rs`), so a person or a cleanup tool sees them apart from the
 * web view's data; every other build keeps them in Cache Storage. The store
 * only holds bytes: `fetchChecked` checks every file against its pin.
 * Spec: docs/internal/plans/plugins.md (section 3)
 */
export type StoreId = 'pn-plugins' | 'pn-on-device-ai';

export interface PluginStore {
  names(): Promise<string[]>;
  /** Null when the file is not there. */
  read(name: string): Promise<ArrayBuffer | null>;
  write(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  remove(name: string): Promise<void>;
  /** Every file of the store. */
  clear(): Promise<void>;
}

/** A cached file is found by its name, which carries its hash, not by its address. */
export const fileNameOf = (url: string): string => new URL(url, location.href).pathname.split('/').pop() ?? '';

function cacheStore(id: StoreId): PluginStore {
  const keyOf = async (cache: Cache, name: string) => (await cache.keys()).find((r) => fileNameOf(r.url) === name);
  return {
    async names() {
      try {
        return (await (await caches.open(id)).keys()).map((r) => fileNameOf(r.url));
      } catch {
        return [];
      }
    },
    async read(name) {
      const cache = await caches.open(id);
      const key = await keyOf(cache, name);
      const hit = key && (await cache.match(key));
      return hit ? hit.arrayBuffer() : null;
    },
    async write(name, bytes) {
      // Keyed on the plugin host, not the page: Cache Storage takes only http(s)
      // keys, and the iOS app's page is tauri://localhost, where every write
      // threw and no plugin could be downloaded (2026-11-18). Reads match by name.
      await (await caches.open(id)).put(new URL(name, `${PLUGINS_ORIGIN}/`).href, new Response(bytes));
    },
    async remove(name) {
      const cache = await caches.open(id);
      const key = await keyOf(cache, name);
      if (key) await cache.delete(key);
    },
    async clear() {
      try {
        await caches.delete(id);
      } catch {
        // no Cache Storage here
      }
    },
  };
}

/** Rust answers a short code; a full disk reads as the browser's quota error. */
async function call<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(cmd, args, headers ? { headers } : undefined);
  } catch (e) {
    if (String(e) === 'full') throw new DOMException('Not enough space', 'QuotaExceededError');
    if (String(e) === 'gone') return null as T;
    throw new Error(`plugin store: ${String(e)}`);
  }
}

function folderStore(id: StoreId): PluginStore {
  return {
    names: () => call<string[]>('plugin_files_list', { store: id }),
    read: (name) => call<ArrayBuffer | null>('plugin_file_read', { store: id, name }),
    write: (name, bytes) => call<void>('plugin_file_write', bytes, { 'x-plugin-store': id, 'x-plugin-name': name }),
    remove: (name) => call<void>('plugin_file_delete', { store: id, name }),
    clear: () => call<void>('plugin_files_clear', { store: id }),
  };
}

/**
 * A desktop app that kept its files in Cache Storage before moves them into
 * the folder once, so nobody downloads them again. Each file is checked
 * against its pin when it is next read, as always.
 */
async function moveOldCache(id: StoreId, to: PluginStore): Promise<void> {
  try {
    if (!(await caches.has(id))) return;
    const from = cacheStore(id);
    for (const name of await from.names()) {
      const bytes = await from.read(name);
      if (bytes) await to.write(name, new Uint8Array(bytes));
    }
    await from.clear();
  } catch {
    // A file left behind downloads again on its next use.
  }
}

const opened = new Map<StoreId, Promise<PluginStore>>();

export function openPluginStore(id: StoreId): Promise<PluginStore> {
  let store = opened.get(id);
  if (!store) {
    store = detectPlatform() === 'desktop'
      ? (async () => {
          const folder = folderStore(id);
          await moveOldCache(id, folder);
          return folder;
        })()
      : Promise.resolve(cacheStore(id));
    opened.set(id, store);
  }
  return store;
}

/** Desktop: deletes both plugin folders (the full wipe). Nothing elsewhere. */
export async function clearPluginFolders(): Promise<void> {
  if (detectPlatform() !== 'desktop') return;
  for (const id of ['pn-plugins', 'pn-on-device-ai'] as const) await folderStore(id).clear();
}

/** Desktop: shows the folder of the plugin files in the file manager. */
export async function revealPluginFolder(): Promise<void> {
  await call<void>('plugin_files_reveal').catch(() => {});
}
