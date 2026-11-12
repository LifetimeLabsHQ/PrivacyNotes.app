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

const KEY = 'privacynotes.startMinimized';

let on: boolean | null = null;

/** Off by default: a start at sign-in opens the window. Spec: docs/internal/plans/ninja-anywhere-694.md (N12) */
function getStartMinimized(): boolean {
  if (on === null) {
    try {
      on = localStorage.getItem(KEY) === '1';
    } catch {
      on = false;
    }
  }
  return on;
}

const listeners = new Set<() => void>();

export function setStartMinimized(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    /* Storage refused: the choice holds for this session only. */
  }
  listeners.forEach((cb) => cb());
}

export function useStartMinimized(): boolean {
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, getStartMinimized);
}

/** At start, after the tray switch went to Rust: how a start at sign-in shows. Any other start ignores it. */
export function finishLoginStart(): void {
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('finish_login_start', { minimized: getStartMinimized() }))
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
