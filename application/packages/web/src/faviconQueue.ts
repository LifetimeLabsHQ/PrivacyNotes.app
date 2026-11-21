/**
 * Client-side favicon fetch queue with IndexedDB persistence.
 *
 * Two layers:
 * 1. Concurrency queue - caps outbound requests at 5 so mass-import
 *    vaults (2000+ logins) don't hammer the Worker.
 * 2. IndexedDB cache - stores favicon blobs locally with a 90-day TTL,
 *    sealed under the local seal key and keyed by an HMAC of the URL.
 *    Eliminates network requests for repeat loads and works offline.
 *    With no local key (locked, signed out) nothing is read or written.
 *
 * Flow: check in-memory map → check IndexedDB → fetch through queue →
 * store in IndexedDB → return blob URL.
 *
 * Spec: docs/internal/backlog.md (#69 - favicon concurrency cap + IDB cache)
 */

import { bytesToHex, decryptBytesAad, encryptBytesAad } from '@notes/shared';
import { isDemoMode } from './demo';
import { localDataKeyCopy } from './localKey';
import { localAad } from './localSeal';

// ── Concurrency queue ────────────────────────────────────────────

// Spec: docs/internal/backlog.md (#69 - client concurrency cap of 5)
const MAX_CONCURRENT = 5;

let active = 0;
const waiting: Array<() => void> = [];

function drain() {
  while (active < MAX_CONCURRENT && waiting.length > 0) {
    active++;
    waiting.shift()!();
  }
}

// ── IndexedDB cache ──────────────────────────────────────────────

// Spec: docs/public/THREAT_MODEL.md (Local storage at rest - the favicon cache)
// Version 2 drops the version 1 store, whose keys were the lookup URLs (so
// the domain of every link and login, readable on disk) and whose values
// were the plain icons. Version 2 keys each icon by an HMAC of its URL under
// the local seal key and seals the icon under the same key, so a copy of the
// files shows only how many icons there are, their sizes, types and times.
const DB_NAME = 'pn-favicons';
const STORE_NAME = 'sealed';
const OLD_STORE_NAME = 'icons';
const DB_VERSION = 2;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
// How long clearing the cache waits for the delete. Without a blocking tab
// it lands at once.
const DELETE_WAIT_MS = 2000;
const AAD_TAG = 'favicon';
const ID_PREFIX = 'pn-favicon-v1:';
// The record that names the key the cache was written under. It cannot
// collide with an icon id, which is 64 hex digits.
const KEY_CHECK_ID = '#key';

interface SealedFavicon {
  n: Uint8Array;
  ct: Uint8Array;
  /** The icon's media type, kept so an SVG still renders from a blob URL. */
  type: string;
  storedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const names = req.result.objectStoreNames;
      if (names.contains(OLD_STORE_NAME)) req.result.deleteObjectStore(OLD_STORE_NAME);
      if (!names.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => {
      const db = req.result;
      // A delete of the cache, from this tab or another one, waits until
      // every connection closes, and each later delete queues behind it
      // without firing any event. So let go at once; the next lookup opens
      // the cache again.
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opening) dbPromise = null;
        checkedFor = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  dbPromise = opening;
  return opening;
}

/** The HMAC of `value` under the local seal key, as hex. */
async function keyedId(key: Uint8Array, value: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(ID_PREFIX + value));
  return bytesToHex(new Uint8Array(mac));
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The key check this tab already confirmed, so a lookup checks once. */
let checkedFor: string | null = null;

/**
 * The cache opened for the current local key, or null with no key (locked,
 * signed out, before the first unlock). Icons written under another key (a
 * phrase change, another account) can never be found again, so the first
 * lookup under a new key empties the store instead of leaving them to sit.
 */
async function openFor(key: Uint8Array): Promise<IDBDatabase> {
  const db = await openDB();
  const check = await keyedId(key, KEY_CHECK_ID);
  if (checkedFor === check) return db;
  const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
  const stored = await request(store.get(KEY_CHECK_ID)) as string | undefined;
  if (stored !== check) {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.objectStore(STORE_NAME).put(check, KEY_CHECK_ID);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  checkedFor = check;
  return db;
}

async function getFromIDB(url: string): Promise<Blob | null> {
  const key = localDataKeyCopy();
  if (!key) return null;
  try {
    const db = await openFor(key);
    const id = await keyedId(key, url);
    const entry = await request(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)) as SealedFavicon | undefined;
    if (!entry) return null;
    if (Date.now() - entry.storedAt > MAX_AGE_MS) {
      void deleteFromIDB(db, id);
      return null;
    }
    try {
      const bytes = decryptBytesAad(entry.ct, entry.n, key, localAad(AAD_TAG, id));
      return new Blob([bytes as BlobPart], { type: entry.type });
    } catch {
      // Damaged, or moved from another id: drop it and fetch again.
      void deleteFromIDB(db, id);
      return null;
    }
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

async function putInIDB(url: string, blob: Blob): Promise<void> {
  const key = localDataKeyCopy();
  if (!key) return;
  try {
    const db = await openFor(key);
    const id = await keyedId(key, url);
    const data = new Uint8Array(await blob.arrayBuffer());
    const { ciphertext, nonce } = encryptBytesAad(data, key, localAad(AAD_TAG, id));
    db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(
      { n: nonce, ct: ciphertext, type: blob.type, storedAt: Date.now() } satisfies SealedFavicon,
      id,
    );
  } catch {
    // QuotaExceededError or other IDB failure - continue without caching.
  } finally {
    key.fill(0);
  }
}

function deleteFromIDB(db: IDBDatabase, id: string): void {
  try {
    db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
  } catch {
    // Ignore.
  }
}

// ── Public API ───────────────────────────────────────────────────

/** In-memory map: original URL → blob URL (lives for the session). */
const blobUrls = new Map<string, string>();

/**
 * Domains the proxy answered for, but with no icon. Kept for the session so
 * a note full of icon-less links costs one request each, not one per render.
 * Only set when the server actually said so - a network error or an offline
 * tab leaves the URL unknown, because the icon may well exist.
 */
const misses = new Set<string>();

/** Requests in flight, so concurrent callers for one URL fetch once. */
const inFlight = new Set<string>();

/**
 * Wipe the favicon cache, in memory and on disk.
 *
 * The favicon cache is a SEPARATE IndexedDB (`pn-favicons`), outside the
 * Dexie database, so neither `clearLocalDatabase` nor `db.delete()` reaches
 * it. Left alone it kept a per-domain record derived from a user's links and
 * vault logins for 90 days after sign-out or account deletion, which made
 * THREAT_MODEL.md's "sign-out clears the local database" untrue and let the
 * next account on a shared machine inherit the previous one's domains.
 * Callers: clearLocalDatabase and deleteEntireLocalDatabase. Added 2026-08-28.
 */
export async function clearFaviconCache(): Promise<void> {
  // Session memory first, so a re-render right after cannot resurrect an
  // icon from the old account and cannot leak a blob URL.
  for (const blobUrl of blobUrls.values()) {
    try { URL.revokeObjectURL(blobUrl); } catch { /* already revoked */ }
  }
  blobUrls.clear();
  misses.clear();

  // Then the on-disk store. Close our handle first, or the delete blocks
  // behind the open connection and silently never completes.
  const open = dbPromise;
  dbPromise = null;
  checkedFor = null;
  const deletion = (async () => {
    if (open) {
      try { (await open).close(); } catch { /* opening failed; nothing to close */ }
    }
    await new Promise<void>((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  })();
  // A tab that does not let go, such as one still running a build without
  // the close in openDB, holds the delete back, and a delete queued behind
  // it fires no event at all. It lands once that tab closes; the sign-out or
  // account switch awaiting this does not wait for that.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([deletion, new Promise<void>((resolve) => { timer = setTimeout(resolve, DELETE_WAIT_MS); })]);
  clearTimeout(timer);
}

/**
 * Fetch a favicon through the concurrency queue + IDB cache.
 *
 * Returns a blob URL on success (usable as `<img src>`), or `null`
 * on failure / offline-with-no-cache.
 */
export async function prefetchFavicon(url: string): Promise<string | null> {
  // The demo sends nothing, so it has no icons: whatever URL a caller built,
  // nothing is fetched and nothing cached is read.
  if (isDemoMode()) return null;

  // 1. Already resolved this session - return immediately.
  const existing = blobUrls.get(url);
  if (existing) return existing;
  if (misses.has(url)) return null;

  // 2. Check IndexedDB (no network slot needed).
  const cached = await getFromIDB(url);
  if (cached) {
    const blobUrl = URL.createObjectURL(cached);
    blobUrls.set(url, blobUrl);
    return blobUrl;
  }

  // 3. Skip network if offline.
  if (!navigator.onLine) return null;

  // 4. Wait for a concurrency slot.
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>(resolve => waiting.push(resolve));
  } else {
    active++;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) { misses.add(url); return null; }
    const blob = await res.blob();
    if (blob.size < 100) { misses.add(url); return null; }

    // Store in IDB for future sessions (fire-and-forget).
    void putInIDB(url, blob);

    const blobUrl = URL.createObjectURL(blob);
    blobUrls.set(url, blobUrl);
    return blobUrl;
  } catch {
    return null;
  } finally {
    active--;
    drain();
  }
}

/**
 * Synchronous read of a favicon that is already in hand, starting the fetch
 * if it is not. Returns the blob URL when the icon is known to exist, and
 * `undefined` in every other case - not yet fetched, no icon, offline.
 *
 * Callers that paint the icon into a live DOM (the editor's decoration
 * plugin) need exactly this shape: something to render NOW, and a callback
 * for the one moment the answer changes. `onResolved` fires only when an
 * icon actually arrives, so a miss never triggers a repaint.
 */
export function ensureFavicon(url: string, onResolved: () => void): string | undefined {
  const existing = blobUrls.get(url);
  if (existing) return existing;
  if (misses.has(url) || inFlight.has(url)) return undefined;

  inFlight.add(url);
  void prefetchFavicon(url).then((blobUrl) => {
    inFlight.delete(url);
    if (blobUrl) onResolved();
  });
  return undefined;
}
