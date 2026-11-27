import { useSyncExternalStore } from 'react';
import { isDemoMode } from './demo';
import { createListeners } from './listeners';
import { readFlag } from './localStore';
import { isSyncPaused, setSyncPaused, useSyncPaused } from './syncPause';

/**
 * Local-only mode for offline installs (GitHub #862).
 *
 * Two orthogonal flags keep the unregistered transport gate separate from
 * "local state is complete truth" (spec section 3):
 *   - `localOnly`: this vault has never registered on our backend. The
 *     transport gate in `accountOAuthFetch` blocks all Supabase traffic until
 *     an intentional online action opens it (`withBackendNetworkAllowed`).
 *   - `neverSynced`: this vault was born locally and has never synced to our
 *     servers. Keeps backup restore, automatic backups, trash auto-purge and
 *     local blob GC working even if the user buys Pro while keeping Sync off.
 *
 * Both flags have Dexie `db.kv` mirrors written alongside `PUBKEY_OWNER_KEY`,
 * so a `localStorage` eviction never misclassifies a local-only vault on cold
 * start. Kept as a tiny boot-path leaf module (imports only `demo`,
 * `listeners`, `localStore` and `syncPause`; lazy-imports `db`).
 * Spec: docs/internal/specs/local-only-862.md (sections 3, 4)
 */

const LOCAL_ONLY_KEY = 'privacynotes.localOnly';
const NEVER_SYNCED_KEY = 'privacynotes.neverSynced';
export const LOCAL_ONLY_OWNER_KEY = 'localOnlyOwner';
export const NEVER_SYNCED_OWNER_KEY = 'neverSyncedOwner';

const { subscribe, notify } = createListeners();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === LOCAL_ONLY_KEY || e.key === NEVER_SYNCED_KEY) {
      notify();
    }
  });
}

/** Error thrown by the single transport gate when a local-only vault tries to
 *  contact the app backend outside an explicit online action. */
export class LocalOnlyNetworkBlockedError extends Error {
  constructor() {
    super('Network request blocked in local-only mode.');
    this.name = 'LocalOnlyNetworkBlockedError';
  }
}

let backendNetworkAllowed = 0;

/** True while an explicit online flow (graduation or Onboarding sign-in) has
 *  opened the transport gate. */
export function isBackendNetworkAllowed(): boolean {
  return backendNetworkAllowed > 0;
}

/** Run an intentional online action (graduation, Onboarding online sign-in or
 *  OAuth) with the transport gate temporarily open. */
export async function withBackendNetworkAllowed<T>(fn: () => Promise<T>): Promise<T> {
  backendNetworkAllowed += 1;
  try {
    return await fn();
  } finally {
    backendNetworkAllowed = Math.max(0, backendNetworkAllowed - 1);
  }
}

/** True when the active install holds an unregistered local-only vault. */
export function isLocalOnly(): boolean {
  return !isDemoMode() && readFlag(LOCAL_ONLY_KEY);
}

/** True when this vault was created locally and has never synced (includes
 *  `localOnly`, and stays true after buying Pro with Sync off). */
export function isLocalTruthOnly(): boolean {
  return !isDemoMode() && (readFlag(LOCAL_ONLY_KEY) || readFlag(NEVER_SYNCED_KEY));
}

/** True when this vault operates strictly as a local-only vault in UI and
 *  network policy: either unregistered (`localOnly`), or locally created,
 *  never synced, and still paused (`neverSynced && isSyncPaused()`, such as
 *  after registering for Pro checkout with Sync kept off).
 *  Spec: docs/internal/specs/local-only-862.md (D2, D3, D5) */
export function isUnsyncedLocalVault(): boolean {
  return (
    !isDemoMode() &&
    (readFlag(LOCAL_ONLY_KEY) ||
      (readFlag(NEVER_SYNCED_KEY) && (isSyncPaused() || readFlag('privacynotes.syncPaused'))))
  );
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable - the Dexie mirror carries the state across starts */
  }
}

/** Synchronously set or clear the localStorage flags and notify subscribers. */
export function setLocalOnlyFlags(opts: { localOnly?: boolean; neverSynced?: boolean }): void {
  if (opts.localOnly !== undefined) writeFlag(LOCAL_ONLY_KEY, opts.localOnly);
  if (opts.neverSynced !== undefined) writeFlag(NEVER_SYNCED_KEY, opts.neverSynced);
  notify();
}

/** Mark this vault as local-only and never-synced in both localStorage and Dexie. */
export async function markLocalOnlyVault(pubkey: string): Promise<void> {
  setLocalOnlyFlags({ localOnly: true, neverSynced: true });
  try {
    const { db } = await import('./db');
    await db.kv.bulkPut([
      { key: LOCAL_ONLY_OWNER_KEY, value: pubkey },
      { key: NEVER_SYNCED_OWNER_KEY, value: pubkey },
    ]);
  } catch {
    /* best-effort mirror */
  }
}

/** Clear localOnly after successful server registration; also clear neverSynced
 *  when sync is being turned on. */
export async function commitLocalOnlyGraduation(enableSync: boolean): Promise<void> {
  setLocalOnlyFlags(enableSync ? { localOnly: false, neverSynced: false } : { localOnly: false });
  try {
    const { db } = await import('./db');
    await db.kv.delete(LOCAL_ONLY_OWNER_KEY);
    if (enableSync) await db.kv.delete(NEVER_SYNCED_OWNER_KEY);
  } catch {
    /* best-effort mirror */
  }
}

/** Clear neverSynced once a registered vault begins its first sync pass. */
export async function clearNeverSynced(): Promise<void> {
  if (!readFlag(NEVER_SYNCED_KEY)) {
    try {
      const { db } = await import('./db');
      await db.kv.delete(NEVER_SYNCED_OWNER_KEY);
    } catch { /* ignore */ }
    return;
  }
  setLocalOnlyFlags({ neverSynced: false });
  try {
    const { db } = await import('./db');
    await db.kv.delete(NEVER_SYNCED_OWNER_KEY);
  } catch {
    /* ignore */
  }
}

/** Clear both localStorage flags synchronously (used on sign-out and wipes;
 *  the Dexie mirrors are removed with ACCOUNT_KV_KEYS in clearLocalDatabase). */
export function clearLocalOnlyFlagsSync(): void {
  setLocalOnlyFlags({ localOnly: false, neverSynced: false });
}

async function readMirror(key: string): Promise<string | null> {
  try {
    const { db } = await import('./db');
    const val = (await db.kv.get(key))?.value;
    return typeof val === 'string' ? val : null;
  } catch {
    return null;
  }
}

/** True if this device holds a local-only vault for `pubkey`, checking
 *  localStorage first and falling back to the Dexie mirror after eviction. */
export async function isLocalOnlyFor(pubkey: string): Promise<boolean> {
  if (isDemoMode()) return false;
  if (readFlag(LOCAL_ONLY_KEY)) return true;
  return (await readMirror(LOCAL_ONLY_OWNER_KEY)) === pubkey;
}

/** True if this device holds a local-only vault for any owner, checking
 *  localStorage first and repairing localStorage from the Dexie mirror after
 *  eviction so cold-start LockScreen never opens the backend transport gate. */
export async function hasLocalOnlyVault(): Promise<boolean> {
  if (isDemoMode()) return false;
  if (readFlag(LOCAL_ONLY_KEY)) return true;
  const mirror = await readMirror(LOCAL_ONLY_OWNER_KEY);
  if (mirror !== null) {
    setLocalOnlyFlags({ localOnly: true, neverSynced: true });
    return true;
  }
  return false;
}

/** True if this device holds an unsynced local vault for any owner (`localOnly`,
 *  or `neverSynced` with sync paused), repairing localStorage flags from the
 *  Dexie mirrors after eviction so cold-start LockScreen stays offline. */
export async function hasUnsyncedLocalVault(): Promise<boolean> {
  if (await hasLocalOnlyVault()) {
    setSyncPaused(true);
    return true;
  }
  if (isDemoMode()) return false;
  if (readFlag(NEVER_SYNCED_KEY)) return isSyncPaused();
  const mirror = await readMirror(NEVER_SYNCED_OWNER_KEY);
  if (mirror !== null) {
    setLocalOnlyFlags({ neverSynced: true });
    setSyncPaused(true);
    return true;
  }
  return false;
}

/** True if this device holds a locally-born never-synced vault for `pubkey`. */
export async function isNeverSyncedFor(pubkey: string): Promise<boolean> {
  if (isDemoMode()) return false;
  if (readFlag(LOCAL_ONLY_KEY) || readFlag(NEVER_SYNCED_KEY)) return true;
  if ((await readMirror(LOCAL_ONLY_OWNER_KEY)) === pubkey) return true;
  return (await readMirror(NEVER_SYNCED_OWNER_KEY)) === pubkey;
}

/** Reactive `isLocalOnly()` for UI components. */
export function useLocalOnly(): boolean {
  return useSyncExternalStore(subscribe, isLocalOnly, () => false);
}

/** Reactive `isLocalTruthOnly()` for restore, status and backup surfaces. */
export function useLocalTruthOnly(): boolean {
  return useSyncExternalStore(subscribe, isLocalTruthOnly, () => false);
}

/** Reactive `isUnsyncedLocalVault()` for status indicators, effects and sign-out. */
export function useUnsyncedLocalVault(): boolean {
  const localOnly = useLocalOnly();
  const localTruth = useLocalTruthOnly();
  const paused = useSyncPaused();
  return localOnly || (localTruth && paused);
}
