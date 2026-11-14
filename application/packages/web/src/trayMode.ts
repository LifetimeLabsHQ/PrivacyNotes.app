/**
 * Keep running in the tray (GitHub #667), the web half. The switch is a
 * device setting and never syncs: a tray belongs to one computer. This module
 * pushes it to `tray.rs` (with the menu labels, which only the web view can
 * translate) and passes the window's trips to the tray on to the idle re-lock,
 * which does not count them (`setInTray` in appReLock.ts). The tray menu's
 * Settings item arrives as `pn-tray-settings` and goes on to NotesView as the
 * window event `TRAY_SETTINGS_EVENT`.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 8); docs/contrib/biometric-unlock.md (section 3.3)
 */

import { useSyncExternalStore } from 'react';
import { appZoomSupported } from './appZoom';
import { setInTray } from './appReLock';
import i18n from './i18n';
import { createListeners } from './listeners';
import { readFlag } from './localStore';

const KEY = 'privacynotes.trayMode';
export const TRAY_SETTINGS_EVENT = 'pn:tray-settings';

/** Every desktop app; never a phone or the browser. */
const traySupported = appZoomSupported;

let on: boolean | null = null;

function getTrayMode(): boolean {
  if (on === null) on = readFlag(KEY);
  return on;
}

async function push(enabled: boolean): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_tray_mode', {
      enabled,
      open: i18n.t('settings:appearance.trayOpen'),
      settings: i18n.t('shell:contextMenu.settings'),
      quit: i18n.t('settings:appearance.trayQuit'),
    });
  } catch {
    /* An older build with no such command: the switch does nothing there. */
  }
}

let listening = false;

/** At start: push the stored switch, and listen for the window's trips. */
export function startTrayMode(): void {
  if (!traySupported() || listening) return;
  listening = true;
  void import('@tauri-apps/api/event')
    .then(({ listen }) => Promise.all([
      listen<boolean>('pn-tray', (e) => setInTray(e.payload)),
      listen('pn-tray-settings', () => window.dispatchEvent(new Event(TRAY_SETTINGS_EVENT))),
    ]))
    .catch(() => {});
  if (getTrayMode()) void push(true);
}

const { subscribe, notify } = createListeners();

export function setTrayMode(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    /* Storage refused: the switch holds for this session only. */
  }
  void push(next);
  notify();
}

export function useTrayMode(): boolean {
  return useSyncExternalStore(subscribe, getTrayMode);
}
