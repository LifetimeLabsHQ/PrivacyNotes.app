/**
 * Automatic backups, the runner: decides when a backup may start, builds it
 * with the same builders the manual export uses, checks it, places it, and
 * then lets old copies go. One instance per page; NotesView connects it to
 * the vault through `useAutoBackupRunner` and the Automatic tab drives it.
 *
 * The order of a run is the safety argument, so it is kept in one function:
 * gates, "no changes", build, open the seal again, place, read back, list
 * the file, shrink guard, prune. A step that fails ends the run before any
 * old copy is touched.
 * Spec: docs/internal/plans/auto-backup.md (sections 4, 6, 8 and 10)
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { decodeBackup, decodeZipBackup } from '@notes/shared';
import type { LocalNote } from '../db';
import type { ImageStore } from '../imageStore';
import type { AttachmentStore } from '../attachmentStore';
import type { UserSettings } from '../userSettings';
import type { ExportStep } from '../export';
import { sha256Hex } from '../sha256Hex';
import { backupSettingsKey, carriedSettings } from '../backupRestore';
import { restoreGateNow } from '../pullState';
import {
  backupExists, clearDestination, connectionIsMetered, DestinationError, destinationKind, destinationStatus,
  isPhone, placeBackup, removeBackup,
} from './destination';
import { backupName, deviceSlug, fingerprint, isDue, isOverdue, isShrunk, mayRetry, pruneList, shrinkBaseline, SNOOZE_MS, stillThere } from './plan';
import { addLog, clearAutoBackup, getAutoBackup, patchConfig, setFiles, setPhoneDefaults, type FailureCause } from './store';

/** What the runner reads from the vault. Functions, so a run always sees
 *  the state of the moment it starts, not of the render that connected it. */
export interface AutoBackupDeps {
  notes: () => LocalNote[];
  /** False until the local read finished without an error. */
  loaded: () => boolean;
  encryptionKey: () => Uint8Array | null;
  imageStore: () => ImageStore | null;
  attachmentStore: () => AttachmentStore | null;
  settings: () => UserSettings;
  deviceName: () => string;
  /** A manual export has the progress window open. */
  exporting: () => boolean;
}

/** What the runner wants said outside the tab; the toast owns the wording. */
type BackupMessage =
  | { kind: 'failed'; cause: FailureCause }
  | { kind: 'overdue'; days: number }
  | { kind: 'due' }
  | { kind: 'permission'; folder: string }
  | { kind: 'shrunk'; items: number; previous: number };

export interface LiveState {
  running: boolean;
  step?: ExportStep;
  message?: BackupMessage;
}

// Spec: docs/internal/plans/auto-backup.md (section 6, Checks)
const FIRST_CHECK_MS = 60_000;
const FIRST_CHECK_PHONE_MS = 10_000;
const CHECK_EVERY_MS = 30 * 60_000;
const DAY_MS = 24 * 3_600_000;
const LOCK_NAME = 'privacynotes-auto-backup';

let deps: AutoBackupDeps | null = null;
let live: LiveState = { running: false };
const liveListeners = new Set<() => void>();
let abort: AbortController | null = null;
const startedAt = Date.now();
/** One message per cause per day, and one overdue message per start. */
const told = new Map<string, number>();

function setLive(patch: Partial<LiveState>): void {
  live = { ...live, ...patch };
  liveListeners.forEach((cb) => cb());
}

function tell(message: BackupMessage, key: string): void {
  const last = told.get(key);
  if (last !== undefined && Date.now() - last < DAY_MS) return;
  told.set(key, Date.now());
  setLive({ message });
}

export function dismissBackupMessage(): void {
  setLive({ message: undefined });
}

export function useBackupLive(): LiveState {
  return useSyncExternalStore(
    (cb) => {
      liveListeners.add(cb);
      return () => {
        liveListeners.delete(cb);
      };
    },
    () => live,
    () => live,
  );
}

class RunFailure extends Error {
  constructor(readonly cause: FailureCause) {
    super(cause);
  }
}

/** A typed array the engine could not make is how "too large" shows itself. */
function causeOf(err: unknown): FailureCause {
  if (err instanceof RunFailure || err instanceof DestinationError) return err.cause;
  if (err instanceof RangeError) return 'tooLarge';
  const text = String((err as Error | null)?.message ?? '');
  if (/allocation|out of memory|array buffer/i.test(text)) return 'tooLarge';
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'offline';
  return 'unknown';
}

const liveRows = (rows: LocalNote[]) => rows.filter((n) => n.deleted !== 1);

/** Build the file and open it again. Returns the bytes to place. */
async function buildChecked(
  d: AutoBackupDeps,
  rows: LocalNote[],
  key: Uint8Array,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; missing: { reason: string }[] }> {
  const ex = await import('../export');
  const s = d.settings();
  const { type } = getAutoBackup().config;
  if (type === 'text') {
    const bytes = ex.buildEncryptedTextBackup(rows, key, s.folders, s.itemStyles, s.customThemes, s.factors, s.customHabits);
    if (decodeBackup(bytes, key).notes.length !== rows.length) throw new RunFailure('seal');
    return { bytes, missing: [] };
  }
  const { sealed, zip, missing } = await ex.buildEncryptedFullBackup(
    rows, d.imageStore(), d.attachmentStore(), key, (step) => setLive({ step }), s.folders,
    carriedSettings(s),
    signal,
  );
  signal.throwIfAborted();
  // The seal opened again with the key must be the zip that went in, and
  // the zip must list every item. A file that fails either is never placed.
  const opened = decodeZipBackup(sealed, key);
  if (opened.length !== zip.length || (await sha256Hex(opened)) !== (await sha256Hex(zip))) throw new RunFailure('seal');
  const { default: JSZip } = await import('jszip');
  const manifest = (await JSZip.loadAsync(zip)).file('manifest.json');
  const listed = manifest ? (JSON.parse(await manifest.async('text')) as { noteCount?: number }).noteCount : undefined;
  if (listed !== rows.length) throw new RunFailure('seal');
  return { bytes: sealed, missing };
}

/** True when the run ended well: a placed file, or "no changes". False when it did not start. */
async function runOnce(d: AutoBackupDeps, manual: boolean, signal: AbortSignal): Promise<boolean> {
  const key = d.encryptionKey();
  if (!key) return false;
  const kind = destinationKind();
  const status = kind === 'download' ? null : await destinationStatus();
  if (kind !== 'download') {
    if (!status || !status.reachable) throw new RunFailure('gone');
    // The browser took the write permission back; only a click returns it.
    if (status.needsPermission) {
      if (manual) throw new RunFailure('permission');
      tell({ kind: 'permission', folder: status.label }, 'permission');
      return false;
    }
  }
  const { config, files } = getAutoBackup();
  if (!manual && config.wifiOnly && (await connectionIsMetered())) return false;

  const rows = liveRows(d.notes());
  const items = rows.filter((n) => n.trashed !== 1).length;
  const print = fingerprint({
    type: config.type,
    destination: status?.path ?? status?.label ?? kind,
    live: items,
    trashed: rows.length - items,
    newest: rows.reduce((max, n) => (n.updatedAt > max ? n.updatedAt : max), ''),
    settings: await sha256Hex(new TextEncoder().encode(backupSettingsKey(d.settings()))),
  });
  const newest = files.reduce<(typeof files)[number] | undefined>((a, b) => (!a || b.at > a.at ? b : a), undefined);
  // Back up now checks too: an unchanged copy would push an older, different
  // backup out of Keep (owner, 2026-11-11). Export still writes a file.
  if (print === config.lastFingerprint && newest && (await backupExists(newest.ref))) {
    patchConfig({ lastGood: Date.now(), lastFailure: undefined });
    addLog({ at: Date.now(), result: 'unchanged' });
    return true;
  }

  setLive({ running: true, step: undefined });
  const { bytes, missing } = await buildChecked(d, rows, key, signal);
  signal.throwIfAborted();
  const name = backupName(new Date(), deviceSlug(d.deviceName(), kind === 'native' ? (isPhone() ? 'phone' : 'desktop') : 'web'), config.type);
  const placed = await placeBackup(name, bytes, signal);
  const now = Date.now();

  // Two runs in one minute share a name, and the second replaces the first
  // file: one row per file, never two for one.
  // A copy deleted by hand leaves the list here, before Keep counts it.
  const older = await stillThere(files.filter((f) => f.ref !== placed.ref), backupExists);
  let kept = [...older, { ref: placed.ref, name: placed.name, at: now, bytes: placed.bytes, items }];
  // A browser download is not ours to list or prune.
  if (kind === 'download') kept = [];
  // Until the person answers, every run is measured against the count the
  // warning named, so the older copies stay for as long as it is unanswered.
  // A vault that is back near that count ends the warning by itself.
  const before = shrinkBaseline(newest?.items, config.shrunk?.previous);
  const shrunk = isShrunk(items, before);
  if (shrunk && !config.shrinkAck) {
    patchConfig({ shrunk: { items, previous: before! } });
    tell({ kind: 'shrunk', items, previous: before! }, 'shrunk');
  } else {
    for (const old of pruneList(kept, config.keep)) {
      if (await removeBackup(old.ref)) kept = kept.filter((f) => f.ref !== old.ref);
      else if (!(await backupExists(old.ref))) kept = kept.filter((f) => f.ref !== old.ref);
    }
    if (!shrunk) patchConfig({ shrunk: undefined, shrinkAck: undefined });
  }
  setFiles(kept);
  // A picture that failed to load can be there tomorrow, so this run is no
  // baseline for "no changes".
  const retryBlobs = missing.some((m) => m.reason === 'failed');
  patchConfig({ lastGood: now, lastFingerprint: retryBlobs ? undefined : print, lastFailure: undefined, snoozedUntil: undefined });
  addLog({ at: now, result: 'ok', bytes: placed.bytes, checked: placed.checked, ...(missing.length ? { missing: missing.length } : {}) });
  return true;
}

/** One run, with the page-wide lock and the failure handling. `manual` is a
 *  click on Back up now: it skips Wi-Fi and the retry wait, and an unchanged
 *  vault still writes nothing. */
export async function runBackup(manual = false): Promise<boolean> {
  const d = deps;
  if (!d || live.running) return false;
  abort = new AbortController();
  const { signal } = abort;
  const body = async (): Promise<boolean> => {
    try {
      return await runOnce(d, manual, signal);
    } catch (err) {
      if ((err as Error | null)?.name === 'AbortError') {
        addLog({ at: Date.now(), result: 'stopped' });
        return false;
      }
      const cause = causeOf(err);
      patchConfig({ lastFailure: Date.now() });
      addLog({ at: Date.now(), result: 'failed', cause });
      if (manual) setLive({ message: { kind: 'failed', cause } });
      else tell({ kind: 'failed', cause }, `failed:${cause}`);
      return false;
    } finally {
      setLive({ running: false, step: undefined });
      abort = null;
    }
  };
  // One tab at a time: two tabs of one browser share the folder and the list.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return body();
  return locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? body() : false));
}

export function stopBackup(): void {
  abort?.abort();
}

/** Whether a run may start by itself right now. */
function mayStart(d: AutoBackupDeps, now: number): boolean {
  const { config } = getAutoBackup();
  return config.on
    && !live.running
    && d.loaded()
    && d.encryptionKey() !== null
    && !d.exporting()
    && restoreGateNow() === 'open'
    && isDue(config.lastGood, config.period, now)
    && mayRetry(config.lastFailure, startedAt, now);
}

/** The periodic check. Never throws. */
export async function checkBackup(): Promise<void> {
  const d = deps;
  if (!d) return;
  const now = Date.now();
  const { config } = getAutoBackup();
  if (!config.on) return;
  if (destinationKind() === 'download') {
    // No folder to write to: say so once a backup is due, and let a click save it.
    if (d.loaded() && isDue(config.lastGood, config.period, now) && (config.snoozedUntil ?? 0) <= now) tell({ kind: 'due' }, 'due');
    return;
  }
  if (mayStart(d, now)) await runBackup(false);
  const after = getAutoBackup().config;
  if (!live.running && isOverdue(after.lastGood, after.period, Date.now())) {
    tell({ kind: 'overdue', days: Math.floor((Date.now() - (after.lastGood ?? 0)) / DAY_MS) }, 'overdue');
  }
}

/** Tier 3 "Not today". */
export function snoozeBackup(): void {
  patchConfig({ snoozedUntil: Date.now() + SNOOZE_MS });
  dismissBackupMessage();
}

/** The first backup decides whether the feature turns on: a folder that
 *  cannot take a file never holds a promise. */
export async function turnOnWithFirstBackup(): Promise<boolean> {
  const ok = await runBackup(true);
  if (ok) patchConfig({ on: true });
  return ok;
}

export function turnOffBackups(): void {
  stopBackup();
  patchConfig({ on: false });
  dismissBackupMessage();
}

/** "That is expected": old copies may go again. */
export function confirmShrunk(): void {
  patchConfig({ shrinkAck: true, shrunk: undefined });
  dismissBackupMessage();
}

/** A new folder starts a new list: earlier copies stay where they are. */
export function destinationChanged(): void {
  setFiles([]);
  patchConfig({ lastFingerprint: undefined, shrunk: undefined, shrinkAck: undefined });
}

/** A different account arrived on this device (auth.tsx). */
export async function forgetAutoBackup(): Promise<void> {
  stopBackup();
  clearAutoBackup();
  await clearDestination();
}

/** Connects the runner to the vault for as long as NotesView is mounted. */
export function useAutoBackupRunner(d: AutoBackupDeps): void {
  const ref = useRef(d);
  ref.current = d;
  useEffect(() => {
    setPhoneDefaults(isPhone());
    deps = {
      notes: () => ref.current.notes(),
      loaded: () => ref.current.loaded(),
      encryptionKey: () => ref.current.encryptionKey(),
      imageStore: () => ref.current.imageStore(),
      attachmentStore: () => ref.current.attachmentStore(),
      settings: () => ref.current.settings(),
      deviceName: () => ref.current.deviceName(),
      exporting: () => ref.current.exporting(),
    };
    const first = window.setTimeout(() => void checkBackup(), isPhone() ? FIRST_CHECK_PHONE_MS : FIRST_CHECK_MS);
    const every = window.setInterval(() => void checkBackup(), CHECK_EVERY_MS);
    // A phone app that comes back to the front is the phone's "start".
    const onVisible = () => {
      if (isPhone() && document.visibilityState === 'visible') window.setTimeout(() => void checkBackup(), FIRST_CHECK_PHONE_MS);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
      document.removeEventListener('visibilitychange', onVisible);
      stopBackup();
      deps = null;
    };
  }, []);
}
