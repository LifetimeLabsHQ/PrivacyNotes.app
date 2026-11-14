/**
 * Automatic backups, what this device remembers: the setup, the files it
 * placed, and the last runs. Device-local and never synced, because a folder
 * belongs to one machine. It lives outside the encrypted store, like the tray
 * switch (trayMode.ts), and every key goes through the demo bucket: `?demo=1`
 * shares the origin with a real account, and an unbucketed demo tab would
 * prune a real person's backups with demo data.
 * Spec: docs/internal/plans/auto-backup.md (section 9)
 */
import { useSyncExternalStore } from 'react';
import { credentialKey } from '../demo';
import { createListeners } from '../listeners';
import { readJson, writeJson } from '../localStore';
import type { BackupKeep, BackupPeriod, BackupType, PlacedFile } from './plan';

export interface AutoBackupConfig {
  on: boolean;
  type: BackupType;
  period: BackupPeriod;
  keep: BackupKeep;
  /** Phones: skip a run on a metered connection. */
  wifiOnly: boolean;
  /** Phones: a system notification when a backup is overdue. */
  notify: boolean;
  /** The last good run, ms: a placed file or "no changes". */
  lastGood?: number;
  lastFingerprint?: string;
  /** The last failed run, ms, and its cause. */
  lastFailure?: number;
  /** The person confirmed a backup with far fewer items; cleared by the next normal one. */
  shrinkAck?: boolean;
  /** A shrunk backup waits for that confirmation. */
  shrunk?: { items: number; previous: number };
  /** Tier 3 "Not today": no due message before this time, ms. */
  snoozedUntil?: number;
}

type RunResult = 'ok' | 'unchanged' | 'failed' | 'stopped';
/** Why a run failed. The pane and the messages own the wording. */
export type FailureCause =
  | 'gone' | 'denied' | 'full' | 'mismatch' | 'tooLarge' | 'seal' | 'permission' | 'offline' | 'unknown';

export interface RunLogEntry {
  at: number;
  result: RunResult;
  bytes?: number;
  /** Pictures and files the backup could not include. */
  missing?: number;
  cause?: FailureCause;
  /** The destination read the file back and it matched. */
  checked?: boolean;
}

export interface AutoBackupState {
  config: AutoBackupConfig;
  files: PlacedFile[];
  log: RunLogEntry[];
}

// Spec: docs/internal/plans/auto-backup.md (section 9, the run history)
const LOG_MAX = 20;

const CONFIG_KEY = () => credentialKey('privacynotes.autoBackup');
const FILES_KEY = () => credentialKey('privacynotes.autoBackup.files');
const LOG_KEY = () => credentialKey('privacynotes.autoBackup.log');

/** Phones back up weekly and keep three; a computer daily and seven.
 *  Spec: docs/internal/plans/auto-backup.md (section 9, Defaults) */
function defaultConfig(phone: boolean): AutoBackupConfig {
  return phone
    ? { on: false, type: 'full', period: 'week', keep: 3, wifiOnly: true, notify: true }
    : { on: false, type: 'full', period: 'day', keep: 7, wifiOnly: false, notify: true };
}

let phoneDefault = false;
let state: AutoBackupState | null = null;
const { subscribe, notify } = createListeners();

function load(): AutoBackupState {
  if (state) return state;
  const stored = readJson<Partial<AutoBackupConfig> | null>(CONFIG_KEY(), null);
  state = {
    config: { ...defaultConfig(phoneDefault), ...(stored ?? {}) },
    files: readJson<PlacedFile[]>(FILES_KEY(), []),
    log: readJson<RunLogEntry[]>(LOG_KEY(), []),
  };
  return state;
}

function publish(next: AutoBackupState): void {
  state = next;
  notify();
}

/** Called once at start, before the first read, so a phone gets phone defaults. */
export function setPhoneDefaults(phone: boolean): void {
  if (phoneDefault === phone) return;
  phoneDefault = phone;
  state = null;
}

export function getAutoBackup(): AutoBackupState {
  return load();
}

export function patchConfig(patch: Partial<AutoBackupConfig>): void {
  const prev = load();
  const config = { ...prev.config, ...patch };
  for (const key of Object.keys(config) as (keyof AutoBackupConfig)[]) {
    if (config[key] === undefined) delete config[key];
  }
  writeJson(CONFIG_KEY(), config);
  publish({ ...prev, config });
}

export function setFiles(files: PlacedFile[]): void {
  writeJson(FILES_KEY(), files);
  publish({ ...load(), files });
}

export function addLog(entry: RunLogEntry): void {
  const log = [entry, ...load().log].slice(0, LOG_MAX);
  writeJson(LOG_KEY(), log);
  publish({ ...load(), log });
}

/** Forget everything: a different account arrived on this device, and one
 *  account never writes into another account's folder. */
export function clearAutoBackup(): void {
  for (const key of [CONFIG_KEY(), FILES_KEY(), LOG_KEY()]) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing stored that could be read back either */
    }
  }
  state = null;
  publish(load());
}

// Another tab of this browser wrote the setup, the list or the history.
// Without a fresh read, this tab would run on its old copy: a backup that
// is not due, and a files list that drops the other tab's newest file.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && ![CONFIG_KEY(), FILES_KEY(), LOG_KEY()].includes(e.key)) return;
    state = null;
    publish(load());
  });
}

export function useAutoBackupState(): AutoBackupState {
  return useSyncExternalStore(subscribe, getAutoBackup, getAutoBackup);
}
