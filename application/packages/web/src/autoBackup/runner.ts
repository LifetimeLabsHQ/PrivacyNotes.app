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
import { PUBKEY_OWNER_KEY, ownsLocalData } from '../authStorage';
import { isDemoMode } from '../demo';
import { backupGateOpen, forgetPulledBefore } from '../pullState';
import {
  backupConfirmed, backupExists, clearDestination, connectionIsMetered, DestinationError, destinationKind, destinationStatus,
  isPhone, placeBackup, removeBackup,
} from './destination';
import { backupName, deviceSlug, editsText, fingerprint, isDue, isOverdue, isShrunk, mayRetry, pruneList, shrinkBaseline, SNOOZE_MS, stillThere } from './plan';
import { addLog, AUTO_BACKUP_CONFIG_KEY, clearAutoBackup, getAutoBackup, patchConfig, setFiles, setPhoneDefaults, type FailureCause } from './store';

/** What the runner reads from the vault. Functions, so a run always sees
 *  the state of the moment it starts, not of the render that connected it. */
export interface AutoBackupDeps {
  notes: () => LocalNote[];
  /** False until the local read finished without an error. */
  loaded: () => boolean;
  encryptionKey: () => Uint8Array | null;
  /** Optional account pubkey of the mounted vault for cross-tab fencing. */
  pubkey?: () => string;
  imageStore: () => ImageStore | null;
  attachmentStore: () => AttachmentStore | null;
  settings: () => UserSettings;
  deviceName: () => string;
  /** This device's id, for the file name of a device with no name. */
  deviceId: () => string;
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

const IDLE_LIVE: LiveState = { running: false };

let deps: AutoBackupDeps | null = null;
let live: LiveState = { running: false };
const liveListeners = new Set<() => void>();
let abort: AbortController | null = null;
/** Raised by every Stop, so a run that waits for the lock sees one (`runBackup`). */
let stops = 0;
/** Raised when another account arrives (`forgetAutoBackup` or cross-tab owner
 *  switch), so an in-flight run or check from the prior account writes nothing
 *  back to storage or UI. */
let accountEpoch = 0;
let activeOwner: string | null = null;
const startedAt = Date.now();
/** One message per cause per day, and one overdue message per start. */
const told = new Map<string, number>();

type RunOwner = {
  readonly pubkey: string | null;
  readonly storedOwner: string | null;
};

function currentOwner(): string | null {
  if (isDemoMode()) return null;
  try {
    return localStorage.getItem(PUBKEY_OWNER_KEY);
  } catch {
    return null;
  }
}

function setLive(patch: Partial<LiveState>): void {
  const next: LiveState = { ...live, ...patch };
  if (next.running === live.running && next.step === live.step && next.message === live.message) {
    return;
  }
  live = next;
  liveListeners.forEach((cb) => cb());
}

function resetForAccountChange(nextOwner: string | null = currentOwner()): void {
  accountEpoch++;
  activeOwner = nextOwner;
  stopBackup();
  told.clear();
  setLive({ running: false, step: undefined, message: undefined });
}

function syncActiveOwner(explicitOwner?: string | null): void {
  if (isDemoMode()) return;
  const next = explicitOwner ?? currentOwner();
  if (activeOwner !== null && next !== activeOwner) {
    resetForAccountChange(next);
    return;
  }
  if (next !== null) {
    activeOwner = next;
  }
}

function captureRunOwner(d: AutoBackupDeps | null): RunOwner {
  const explicit = isDemoMode() ? null : (d?.pubkey?.() ?? null);
  syncActiveOwner(explicit);
  return {
    pubkey: explicit,
    storedOwner: currentOwner(),
  };
}

function stillSameAccount(epoch: number, owner: RunOwner): boolean {
  if (epoch !== accountEpoch) return false;
  if (isDemoMode()) return true;
  const nowStored = currentOwner();
  if (owner.storedOwner !== null && nowStored !== owner.storedOwner) return false;
  if (owner.storedOwner === null && nowStored !== null && nowStored !== owner.pubkey) return false;
  if (owner.pubkey !== null && !ownsLocalData(owner.pubkey)) return false;
  return true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null) {
      resetForAccountChange(null);
      return;
    }
    if (!isDemoMode() && e.key === PUBKEY_OWNER_KEY) {
      if (e.newValue !== activeOwner) {
        resetForAccountChange(e.newValue);
      }
      return;
    }
    if (e.key === AUTO_BACKUP_CONFIG_KEY() && e.newValue === null) {
      resetForAccountChange(currentOwner());
    }
  });
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
    () => {
      if (!isDemoMode() && activeOwner !== null && currentOwner() !== activeOwner) {
        return IDLE_LIVE;
      }
      return live;
    },
    () => IDLE_LIVE,
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
  epoch: number,
  owner: RunOwner,
): Promise<{ bytes: Uint8Array; missing: { reason: string }[] }> {
  const ex = await import('../export');
  const s = d.settings();
  const { type } = getAutoBackup().config;
  if (type === 'text') {
    const bytes = ex.buildEncryptedTextBackup(rows, key, s.folders, s.itemStyles, s.customThemes, s.factors, s.customHabits, s.customIcons);
    if (decodeBackup(bytes, key).notes.length !== rows.length) throw new RunFailure('seal');
    return { bytes, missing: [] };
  }
  const { sealed, zip, missing } = await ex.buildEncryptedFullBackup(
    rows, d.imageStore(), d.attachmentStore(), key, (step) => { if (stillSameAccount(epoch, owner)) setLive({ step }); }, s.folders,
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

/**
 * True when the run ended well: a placed file, or "no changes". False when it did not start.
 *
 * A run seals with a copy of the key that is its own. The array the app hands
 * out is the account's live one, which a sign-out clears in place; a run can
 * be between its first await and its seal at that moment, and the file's own
 * check opens it with whatever sealed it. So the run copies the key while it
 * is whole, never starts on one that is all zero, and clears its copy when it
 * ends.
 */
async function runOnce(d: AutoBackupDeps, manual: boolean, signal: AbortSignal, epoch: number, owner: RunOwner): Promise<boolean> {
  if (!stillSameAccount(epoch, owner)) return false;
  const live = d.encryptionKey();
  if (!live || live.every((byte) => byte === 0)) return false;
  const key = Uint8Array.from(live);
  try {
    return await runWithKey(d, manual, signal, key, epoch, owner);
  } finally {
    key.fill(0);
  }
}

async function runWithKey(
  d: AutoBackupDeps,
  manual: boolean,
  signal: AbortSignal,
  key: Uint8Array,
  epoch: number,
  owner: RunOwner,
): Promise<boolean> {
  const kind = destinationKind();
  const status = kind === 'download' ? null : await destinationStatus();
  if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
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
  if (!stillSameAccount(epoch, owner) || signal.aborted) return false;

  const rows = liveRows(d.notes());
  const items = rows.filter((n) => n.trashed !== 1).length;
  const print = fingerprint({
    type: config.type,
    destination: status?.path ?? status?.label ?? kind,
    live: items,
    trashed: rows.length - items,
    edits: await sha256Hex(new TextEncoder().encode(editsText(rows))),
    settings: await sha256Hex(new TextEncoder().encode(backupSettingsKey(d.settings()))),
  });
  if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
  const newest = files.reduce<(typeof files)[number] | undefined>((a, b) => (!a || b.at > a.at ? b : a), undefined);
  // Back up now checks too: an unchanged copy would push an older, different
  // backup out of Keep (owner, 2026-11-11). Export still writes a file.
  // Only a copy the place confirms counts: one it cannot answer for is
  // written again, or a provider error would skip every run.
  if (print === config.lastFingerprint && newest && (await backupConfirmed(newest.ref))) {
    if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
    patchConfig({ lastGood: Date.now(), lastFailure: undefined });
    addLog({ at: Date.now(), result: 'unchanged' });
    return true;
  }
  if (!stillSameAccount(epoch, owner) || signal.aborted) return false;

  setLive({ running: true, step: undefined });
  const { bytes, missing } = await buildChecked(d, rows, key, signal, epoch, owner);
  if (!stillSameAccount(epoch, owner)) return false;
  signal.throwIfAborted();
  const name = backupName(new Date(), deviceSlug(d.deviceName(), kind === 'native' ? (isPhone() ? 'phone' : 'desktop') : 'web', d.deviceId()), config.type);
  const placed = await placeBackup(name, bytes, signal);
  if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
  const now = Date.now();

  // Two runs in one minute share a name, and the second replaces the first
  // file: one row per file, never two for one.
  // A copy deleted by hand leaves the list here, before Keep counts it.
  const older = await stillThere(files.filter((f) => f.ref !== placed.ref), backupExists);
  if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
  let kept = [...older, { ref: placed.ref, name: placed.name, at: now, bytes: placed.bytes, items }];
  // A browser download is not ours to list or prune.
  if (kind === 'download') kept = [];
  // Until the person answers, every run is measured against the count the
  // warning named, so the older copies stay for as long as it is unanswered.
  // A vault that is back near that count ends the warning by itself.
  const before = shrinkBaseline(newest?.items, config.shrunk?.previous);
  const shrunk = isShrunk(items, before);
  if (shrunk && !config.shrinkAck) {
    if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
    patchConfig({ shrunk: { items, previous: before! } });
    tell({ kind: 'shrunk', items, previous: before! }, 'shrunk');
  } else {
    for (const old of pruneList(kept, config.keep, placed.ref)) {
      if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
      if (await removeBackup(old.ref, signal)) kept = kept.filter((f) => f.ref !== old.ref);
      else if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
      else if (!(await backupExists(old.ref))) kept = kept.filter((f) => f.ref !== old.ref);
    }
    if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
    if (!shrunk) patchConfig({ shrunk: undefined, shrinkAck: undefined });
  }
  if (!stillSameAccount(epoch, owner) || signal.aborted) return false;
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
  if (!d) return false;
  const owner = captureRunOwner(d);
  if (live.running) return false;
  // The lock is granted a task later, when no controller exists yet: a Stop
  // in that gap moves this count, and the run ends as stopped (beta #200).
  const asked = stops;
  const epoch = accountEpoch;
  const body = async (): Promise<boolean> => {
    if (!stillSameAccount(epoch, owner)) return false;
    // Made after the lock, so a run that waits for no lock never replaces the
    // controller of the run that holds it (beta #171).
    const own = new AbortController();
    abort = own;
    const { signal } = own;
    try {
      if (stops !== asked) {
        if (stillSameAccount(epoch, owner)) addLog({ at: Date.now(), result: 'stopped' });
        return false;
      }
      return await runOnce(d, manual, signal, epoch, owner);
    } catch (err) {
      if (!stillSameAccount(epoch, owner)) return false;
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
      if (stillSameAccount(epoch, owner)) setLive({ running: false, step: undefined });
      if (abort === own) abort = null;
    }
  };
  // One tab at a time: two tabs of one browser share the folder and the list.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return body();
  return locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? body() : false));
}

export function stopBackup(): void {
  stops++;
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
    // A pull in this start or an earlier one, no wipe since (pullState.ts).
    && backupGateOpen()
    && isDue(config.lastGood, config.period, now)
    && mayRetry(config.lastFailure, startedAt, now);
}

/** The periodic check. Never throws. */
export async function checkBackup(): Promise<void> {
  const d = deps;
  if (!d) return;
  const owner = captureRunOwner(d);
  const epoch = accountEpoch;
  const now = Date.now();
  const { config } = getAutoBackup();
  if (!config.on) return;
  if (destinationKind() === 'download') {
    // No folder to write to: say so once a backup is due, and let a click save it.
    if (d.loaded() && isDue(config.lastGood, config.period, now) && (config.snoozedUntil ?? 0) <= now) tell({ kind: 'due' }, 'due');
    return;
  }
  if (mayStart(d, now)) await runBackup(false);
  if (!stillSameAccount(epoch, owner)) return;
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
  const owner = captureRunOwner(deps);
  const epoch = accountEpoch;
  const ok = await runBackup(true);
  if (!stillSameAccount(epoch, owner)) return false;
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
  const clearSavedState = () => {
    clearAutoBackup();
    forgetPulledBefore();
  };
  resetForAccountChange(null);
  clearSavedState();
  await clearDestination();
  clearSavedState();
}

/** Connects the runner to the vault for as long as NotesView is mounted. */
export function useAutoBackupRunner(d: AutoBackupDeps): void {
  const ref = useRef(d);
  ref.current = d;
  useEffect(() => {
    syncActiveOwner(ref.current.pubkey?.());
    setPhoneDefaults(isPhone());
    deps = {
      notes: () => ref.current.notes(),
      loaded: () => ref.current.loaded(),
      encryptionKey: () => ref.current.encryptionKey(),
      ...(ref.current.pubkey ? { pubkey: () => ref.current.pubkey!() } : {}),
      imageStore: () => ref.current.imageStore(),
      attachmentStore: () => ref.current.attachmentStore(),
      settings: () => ref.current.settings(),
      deviceName: () => ref.current.deviceName(),
      deviceId: () => ref.current.deviceId(),
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
