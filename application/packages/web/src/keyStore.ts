import { isDemoMode } from './demo';

/**
 * A small IndexedDB database of one object store, outside the app's Dexie
 * one, with its own database for the demo (same origin as a real install).
 * Each call opens it, runs one request and closes it; any failure (private
 * mode, blocked storage) reads as null.
 */
export function createKeyStore(name: string, demoName: string, store: string) {
  return async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(isDemoMode() ? demoName : name, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return await new Promise<T | null>((resolve) => {
        const req = fn(db.transaction(store, mode).objectStore(store));
        // `close()` waits for the pending transaction to commit, so each
        // call leaves no live connection behind.
        const settle = (value: T | null) => { db.close(); resolve(value); };
        req.onsuccess = () => settle(req.result ?? null);
        req.onerror = () => settle(null);
      });
    } catch {
      return null;
    }
  };
}
