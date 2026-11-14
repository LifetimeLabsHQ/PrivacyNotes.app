/**
 * Remembering the chosen folder across reloads.
 *
 * The two platforms differ in what is even possible, and the difference is
 * visible to the user, so it is worth stating plainly:
 *
 *   - **Desktop** stores a path string. The fs grants carry no static
 *     allow, so the path opens only while the fs scope holds it, which
 *     `tauri-plugin-persisted-scope` restores at start: the folder reopens
 *     silently and completely. A folder the saved scope lacks (one picked
 *     before that change) is a one-click re-pick (`useFolderRestore`).
 *   - **Chromium browsers** store the `FileSystemDirectoryHandle` itself, which
 *     is structured-cloneable and therefore IndexedDB-storable. The handle
 *     survives - but the PERMISSION attached to it does not, by design. After a
 *     reload `queryPermission` usually reports `prompt`, and `requestPermission`
 *     may only be called from a user gesture. So the folder is remembered and
 *     reopening is one click, rather than navigating the picker again. Installed
 *     PWAs can be granted persistent permission, in which case the check below
 *     returns `granted` and it reopens with no click at all.
 *
 * Deliberately its OWN IndexedDB database rather than a table in the app's
 * Dexie one. The Markdown pillar must not be able to reach the encrypted store,
 * and the cleanest way to guarantee that is for it to keep its state somewhere
 * that store cannot see.
 *
 * Spec: docs/internal/specs/markdown-folder.md (section 5)
 */

import { createKeyStore } from '../keyStore';

const DB_NAME = 'privacynotes-markdown';
// `?demo=1` runs on the same origin as a real install, so the demo keeps its
// folder in a database of its own, the way DEMO_DB_NAME keeps its notes: a
// demo tab can neither reopen the real remembered folder nor forget it.
const DEMO_DB = 'privacynotes-markdown-demo';
const STORE = 'folder';
const KEY = 'last';

export type StoredFolder =
  | { kind: 'path'; path: string }
  | { kind: 'handle'; handle: FileSystemDirectoryHandle };

// A failed read or write forgets the folder: a downgrade, never a failure,
// the picker still works.
const withStore = createKeyStore(DB_NAME, DEMO_DB, STORE);

export async function rememberFolder(folder: StoredFolder): Promise<void> {
  await withStore('readwrite', (s) => s.put(folder, KEY) as IDBRequest<unknown>);
}

export async function recallFolder(): Promise<StoredFolder | null> {
  return withStore<StoredFolder>('readonly', (s) => s.get(KEY) as IDBRequest<StoredFolder>);
}

export async function forgetFolder(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(KEY) as IDBRequest<unknown>);
}

// The first-run explainer's seen-flag (`hasSeenExplainer` / `markExplainerSeen`,
// key `explained`) lived here until 2026-08-14. The gate it drove is gone: the
// empty state renders the pitch itself, so the modal in front of the picker was
// showing the reader content already on their screen. Existing profiles keep a
// stray `explained: true` record, which nothing reads and which costs a byte.

/** Whether a remembered handle can be used without asking again. */
export type HandlePermission = 'granted' | 'needs-click' | 'lost';

/**
 * Ask the browser whether a stored handle is still usable.
 *
 * `prompt` is not a failure: it means the handle is valid and the user can
 * re-grant with one click. Only a throw means the handle is genuinely gone -
 * the folder was deleted, or the browser dropped it.
 */
export async function checkHandle(handle: FileSystemDirectoryHandle): Promise<HandlePermission> {
  try {
    const h = handle as unknown as {
      queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
    };
    if (!h.queryPermission) return 'needs-click';
    const state = await h.queryPermission({ mode: 'readwrite' });
    return state === 'granted' ? 'granted' : 'needs-click';
  } catch {
    return 'lost';
  }
}

/** Re-grant a stored handle. MUST be called from a user gesture - the browser
 *  rejects it otherwise, which is exactly why this cannot happen on load. */
export async function requestHandle(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const h = handle as unknown as {
      requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
    };
    if (!h.requestPermission) return false;
    return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}
