/**
 * Automatic backups, where the file goes. One interface over three kinds of
 * place:
 *
 *   - `native`: the desktop and phone apps. Rust holds the folder
 *     (backup_dest.rs); this side names a file and sends its bytes, never a
 *     path, so nothing here can write or delete outside the picked folder.
 *   - `folder`: a browser with `showDirectoryPicker`. The handle lives in
 *     its own IndexedDB database; the browser can take the write permission
 *     away between visits and gives it back only on a click.
 *   - `download`: every other browser. The app cannot write alone, so it
 *     asks when a backup is due and saves through `saveBlob`.
 *
 * Every placed file is read back and compared with the sealed bytes, except
 * a download, which the browser owns from the click on.
 * Spec: docs/internal/plans/auto-backup.md (section 7)
 */
import { bytesToBase64 } from '@notes/shared';
import { isDemoMode } from '../demo';
import { detectPlatform } from '../devices';
import { sha256hex } from '../import/blobImport';
import { saveBlob } from '../saveFile';
import type { FailureCause } from './store';

export type DestinationKind = 'native' | 'folder' | 'download';

export interface DestinationStatus {
  /** The folder's name, for display. */
  label: string;
  /** Desktop only: the full path. */
  path?: string;
  reachable: boolean;
  /** `folder` only: the browser wants a click before the next write. */
  needsPermission?: boolean;
}

export interface Placed {
  ref: string;
  name: string;
  bytes: number;
  /** The destination read the file back and it matched. */
  checked: boolean;
}

/** A run that could not place its file, with a cause the UI can word. */
export class DestinationError extends Error {
  constructor(readonly cause: FailureCause) {
    super(cause);
    this.name = 'DestinationError';
  }
}

export function destinationKind(): DestinationKind {
  if (detectPlatform() !== 'web') return 'native';
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window ? 'folder' : 'download';
}

export function isPhone(): boolean {
  const p = detectPlatform();
  return p === 'ios' || p === 'android';
}

// ── native ──────────────────────────────────────────────────────────

// Spec: docs/internal/plans/auto-backup.md (section 7, 8 MB raw-IPC pieces)
const CHUNK_BYTES = 8 * 1024 * 1024;

const NATIVE_CAUSES: Record<string, FailureCause> = {
  gone: 'gone', 'no-destination': 'gone', denied: 'denied', full: 'full', mismatch: 'mismatch',
};

async function native<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(cmd, args, headers ? { headers } : undefined);
  } catch (err) {
    throw new DestinationError(NATIVE_CAUSES[String(err)] ?? 'unknown');
  }
}

interface NativeStatus { label: string; path?: string | null; reachable?: boolean }

const fromNative = (s: NativeStatus | null): DestinationStatus | null =>
  s ? { label: s.label, ...(s.path ? { path: s.path } : {}), reachable: s.reachable ?? true } : null;

/** The web view's own encoder takes 3 ms for 8 MB on a Pixel 10; the shared
 *  helper, the fallback for an older web view, takes about 500 ms. */
function pieceBase64(piece: Uint8Array): string {
  const own = (piece as Uint8Array & { toBase64?: () => string }).toBase64;
  return own ? own.call(piece) : bytesToBase64(piece);
}

async function placeNative(name: string, bytes: Uint8Array, hash: string, signal?: AbortSignal): Promise<Placed> {
  const id = await native<number>('backup_dest_begin', { name });
  try {
    // Android's web view has no raw request body: Tauri would send the
    // piece as a JSON array of numbers, which is too slow for a backup.
    // Base64 text is one JSON string that Rust decodes in one pass.
    const android = detectPlatform() === 'android';
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
      signal?.throwIfAborted();
      const piece = bytes.subarray(at, at + CHUNK_BYTES);
      await native<void>('backup_dest_chunk', android ? { b64: pieceBase64(piece) } : piece, { 'x-backup-id': String(id) });
    }
    signal?.throwIfAborted();
    const placed = await native<{ ref: string; name: string; bytes: number }>('backup_dest_finish', { id, size: bytes.length, sha256: hash });
    return { ...placed, checked: true };
  } catch (err) {
    await native<void>('backup_dest_abort', { id }).catch(() => {});
    throw err;
  }
}

// ── browser folder ──────────────────────────────────────────────────

const DB_NAME = 'privacynotes-backup';
const DEMO_DB = 'privacynotes-backup-demo';
const STORE = 'folder';
const KEY = 'destination';

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(isDemoMode() ? DEMO_DB : DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
      db.close();
    });
  } catch {
    return null;
  }
}

const storedHandle = () => withStore<PermissionHandle>('readonly', (s) => s.get(KEY) as IDBRequest<PermissionHandle>);

async function folderStatus(): Promise<DestinationStatus | null> {
  const handle = await storedHandle();
  if (!handle) return null;
  const permission = (await handle.queryPermission?.({ mode: 'readwrite' }).catch(() => 'denied' as const)) ?? 'granted';
  return { label: handle.name, reachable: permission !== 'denied', needsPermission: permission !== 'granted' };
}

/** The browser's own name for a failed write. */
function folderCause(err: unknown): FailureCause {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotFoundError') return 'gone';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission';
  if (name === 'QuotaExceededError') return 'full';
  return 'unknown';
}

async function placeInFolder(name: string, bytes: Uint8Array, hash: string): Promise<Placed> {
  const handle = await storedHandle();
  if (!handle) throw new DestinationError('gone');
  try {
    const file = await handle.getFileHandle(name, { create: true });
    // The browser stages the bytes and swaps them in on close, so a tab
    // that goes away mid-write leaves no half file under this name.
    const out = await file.createWritable();
    await out.write(bytes as BufferSource);
    await out.close();
    const back = new Uint8Array(await (await file.getFile()).arrayBuffer());
    if (back.length !== bytes.length || (await sha256hex(back)) !== hash) {
      await handle.removeEntry(name).catch(() => {});
      throw new DestinationError('mismatch');
    }
    return { ref: name, name, bytes: bytes.length, checked: true };
  } catch (err) {
    if (err instanceof DestinationError) throw err;
    throw new DestinationError(folderCause(err));
  }
}

// ── the one interface ───────────────────────────────────────────────

export async function destinationStatus(): Promise<DestinationStatus | null> {
  const kind = destinationKind();
  if (kind === 'native') return fromNative(await native<NativeStatus | null>('backup_dest_status').catch(() => null));
  if (kind === 'folder') return folderStatus();
  return null;
}

/** Opens the folder picker. Null when the person cancels. */
export async function pickDestination(): Promise<DestinationStatus | null> {
  const kind = destinationKind();
  if (kind === 'native') return fromNative(await native<NativeStatus | null>('backup_dest_pick'));
  if (kind !== 'folder') return null;
  const picker = (window as unknown as {
    showDirectoryPicker: (o: { mode: 'readwrite'; id: string }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker({ mode: 'readwrite', id: 'pn-backups' });
  } catch {
    return null; // dismissed
  }
  await withStore('readwrite', (s) => s.put(handle, KEY));
  return { label: handle.name, reachable: true, needsPermission: false };
}

/** `folder` only, from a click: ask the browser for the write permission again. */
export async function requestFolderPermission(): Promise<boolean> {
  const handle = await storedHandle();
  if (!handle?.requestPermission) return false;
  return (await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied')) === 'granted';
}

export async function placeBackup(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Placed> {
  const kind = destinationKind();
  const hash = await sha256hex(bytes);
  signal?.throwIfAborted();
  if (kind === 'native') return placeNative(name, bytes, hash, signal);
  if (kind === 'folder') return placeInFolder(name, bytes, hash);
  const saved = await saveBlob(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), name);
  if (!saved.ok) throw new DestinationError('unknown');
  return { ref: name, name, bytes: bytes.length, checked: false };
}

/** Whether a file this device placed is still there. True when the place cannot say. */
export async function backupExists(ref: string): Promise<boolean> {
  const kind = destinationKind();
  if (kind === 'native') return native<boolean>('backup_dest_exists', { ref }).catch(() => true);
  if (kind === 'folder') {
    const handle = await storedHandle();
    if (!handle) return false;
    return handle.getFileHandle(ref).then(() => true, (err) => (err as { name?: string })?.name !== 'NotFoundError');
  }
  return true;
}

/** Delete one file this device placed. Never throws: an old copy that will
 *  not go is not a failed backup. */
export async function removeBackup(ref: string): Promise<boolean> {
  const kind = destinationKind();
  try {
    if (kind === 'native') return await native<boolean>('backup_dest_delete', { ref });
    if (kind === 'folder') {
      const handle = await storedHandle();
      if (!handle) return false;
      await handle.removeEntry(ref);
      return true;
    }
  } catch {
    /* gone already, or the folder is not reachable: leave it on the list */
  }
  return false;
}

export async function clearDestination(): Promise<void> {
  const kind = destinationKind();
  if (kind === 'native') await native<void>('backup_dest_clear').catch(() => {});
  if (kind === 'folder') await withStore('readwrite', (s) => s.delete(KEY));
}

/** Desktop: show the backup folder in the file manager. */
export async function revealDestination(): Promise<void> {
  if (detectPlatform() === 'desktop') await native<void>('backup_dest_reveal').catch(() => {});
}

/** Phones: the connection costs money or is limited. */
export async function connectionIsMetered(): Promise<boolean> {
  if (!isPhone()) return false;
  return native<boolean>('backup_dest_metered').catch(() => false);
}
