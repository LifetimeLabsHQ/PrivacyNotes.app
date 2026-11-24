/**
 * Open at login (Settings > System), the web half of `autostart.rs`. The
 * sign-in entry itself lives in the system: this module reads it once and
 * shares what it found, for the switch and for the hint under the Ninja
 * hotkey. It keeps the one choice that belongs to the app, Start minimized,
 * as a device setting, and tells Rust at every start how a start at sign-in
 * shows.
 * Spec: docs/internal/plans/ninja-anywhere-694.md (section 7)
 */

import { useSyncExternalStore } from 'react';
import { createListeners } from './listeners';
import { readFlag } from './localStore';
import { getTrayMode } from './trayMode';

const KEY = 'privacynotes.startMinimized';
// One-shot flag written right before an updater restart so a Windows launch
// that originally started with `--autostart` reopens visibly instead of hiding
// back into the tray when Start minimized is on. Expires after 5 minutes so a
// cancelled or blocked installer does not affect a later Windows sign-in.
const RELAUNCH_SHOW_KEY = 'privacynotes.relaunchShowWindow';
const RELAUNCH_SHOW_TTL_MS = 5 * 60 * 1000;

let on: boolean | null = null;
let loginStartSent = false;

/** Mark the next start as an explicit updater restart that should show its window. */
export function markRelaunchShowWindow(): void {
  try {
    localStorage.setItem(RELAUNCH_SHOW_KEY, String(Date.now()));
  } catch {
    /* Storage refused: best effort. */
  }
}

/** Clear the relaunch flag when an updater restart failed to leave the app. */
export function clearRelaunchShowWindow(): void {
  try {
    localStorage.removeItem(RELAUNCH_SHOW_KEY);
  } catch {
    /* Storage refused: best effort. */
  }
}

function consumeRelaunchShowWindow(): boolean {
  try {
    const raw = localStorage.getItem(RELAUNCH_SHOW_KEY);
    if (!raw) return false;
    localStorage.removeItem(RELAUNCH_SHOW_KEY);
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts >= 0 && Date.now() - ts < RELAUNCH_SHOW_TTL_MS;
  } catch {
    return false;
  }
}

/** Off by default: a start at sign-in opens the window. Spec: docs/internal/plans/ninja-anywhere-694.md (N12) */
function getStartMinimized(): boolean {
  if (on === null) on = readFlag(KEY);
  return on;
}

const { subscribe, notify } = createListeners();

export function setStartMinimized(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    /* Storage refused: the choice holds for this session only. */
  }
  notify();
}

export function useStartMinimized(): boolean {
  return useSyncExternalStore(subscribe, getStartMinimized);
}

/** At start: how a start at sign-in shows, with the tray switch, which Rust may not have yet. Any other start ignores it. */
export function finishLoginStart(): void {
  if (loginStartSent) return;
  loginStartSent = true;
  const minimized = consumeRelaunchShowWindow() ? false : getStartMinimized();
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('finish_login_start', { minimized, tray: getTrayMode() }))
    .catch(() => {});
}

/** The sign-in entry as the system last answered; false until it has. */
let atLogin = false;
let asked = false;
const loginListeners = new Set<() => void>();

function setAtLogin(next: boolean): void {
  atLogin = next;
  loginListeners.forEach((cb) => cb());
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function useOpenAtLogin(): boolean {
  if (!asked) {
    asked = true;
    call<boolean>('autostart_enabled').then(setAtLogin, () => {});
  }
  return useSyncExternalStore((cb) => {
    loginListeners.add(cb);
    return () => {
      loginListeners.delete(cb);
    };
  }, () => atLogin);
}

/** Write or remove the sign-in entry; the switch shows what the system then has. */
export function setOpenAtLogin(next: boolean): void {
  setAtLogin(next);
  call<boolean>('set_autostart', { enabled: next }).then(setAtLogin, () => setAtLogin(!next));
}
