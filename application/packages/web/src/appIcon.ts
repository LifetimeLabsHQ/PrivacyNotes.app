/**
 * Alternative desktop app icons (Settings > System, GitHub #977).
 *
 * Device-local setting (never synced): the icon lives in localStorage and is
 * pushed to `app_icon.rs` on every change and on desktop startup (so a self-
 * update that replaces the bundle or shortcuts re-applies the chosen icon).
 */

import { useSyncExternalStore } from 'react';
import { appZoomSupported } from './appZoom';
import { createListeners } from './listeners';

const KEY = 'privacynotes.appIcon';

export const APP_ICON_IDS = [
  'default',
  'dark',
  'tinted',
  'liquid',
  'note-boy',
  'plain-page',
  'calculator',
  'journal',
  'archive',
  'minimal-fold',
] as const;

export type AppIconId = (typeof APP_ICON_IDS)[number];

export const DEFAULT_APP_ICON: AppIconId = 'default';

export interface AppIconPreset {
  id: AppIconId;
  group: 'brand' | 'discreet';
  nameKey: string;
  descKey: string;
}

export const APP_ICON_PRESETS: readonly AppIconPreset[] = [
  { id: 'default', group: 'brand', nameKey: 'settings:appearance.textSizeDefault', descKey: 'settings:system.appIcon.defaultDesc' },
  { id: 'dark', group: 'brand', nameKey: 'settings:appearance.dark', descKey: 'settings:system.appIcon.darkDesc' },
  { id: 'tinted', group: 'brand', nameKey: 'settings:system.appIcon.tintedName', descKey: 'settings:system.appIcon.tintedDesc' },
  { id: 'liquid', group: 'brand', nameKey: 'settings:system.appIcon.liquidName', descKey: 'settings:system.appIcon.liquidDesc' },
  { id: 'note-boy', group: 'brand', nameKey: 'settings:system.appIcon.noteBoyName', descKey: 'settings:system.appIcon.noteBoyDesc' },
  { id: 'plain-page', group: 'discreet', nameKey: 'settings:system.appIcon.plainPageName', descKey: 'settings:system.appIcon.plainPageDesc' },
  { id: 'calculator', group: 'discreet', nameKey: 'looks:icons.calculator', descKey: 'settings:system.appIcon.calculatorDesc' },
  { id: 'journal', group: 'discreet', nameKey: 'notes:newMenu.journal', descKey: 'settings:system.appIcon.journalDesc' },
  { id: 'archive', group: 'discreet', nameKey: 'shell:tagsRail.archive', descKey: 'settings:system.appIcon.archiveDesc' },
  { id: 'minimal-fold', group: 'discreet', nameKey: 'settings:system.appIcon.minimalFoldName', descKey: 'settings:system.appIcon.minimalFoldDesc' },
];

interface AppIconResult {
  platform: string;
  persisted: boolean;
  note: string | null;
}

interface AppIconState {
  icon: AppIconId;
  status: AppIconResult | null;
  error: string | null;
  busy: boolean;
}

export function isAppIconId(value: unknown): value is AppIconId {
  return typeof value === 'string' && (APP_ICON_IDS as readonly string[]).includes(value);
}

/** Desktop apps only (macOS, Windows, Linux); never phones or browsers. */
const appIconSupported = appZoomSupported;

function readStored(): AppIconId {
  try {
    const raw = localStorage.getItem(KEY);
    return isAppIconId(raw) ? raw : DEFAULT_APP_ICON;
  } catch {
    return DEFAULT_APP_ICON;
  }
}

let state: AppIconState = {
  icon: readStored(),
  status: null,
  error: null,
  busy: false,
};

let pushes = 0;
let started = false;
const { subscribe, notify } = createListeners();

function setState(patch: Partial<AppIconState>): void {
  state = { ...state, ...patch };
  notify();
}

function getSnapshot(): AppIconState {
  return state;
}

async function invokeSetIcon(id: AppIconId): Promise<AppIconResult | null> {
  let invoke: typeof import('@tauri-apps/api/core').invoke;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch {
    return null;
  }
  return invoke<AppIconResult>('set_app_icon', { id });
}

/** Re-apply a non-default icon on desktop startup so updates keep the choice. */
export function startAppIcon(): void {
  if (!appIconSupported() || started) return;
  started = true;
  const stored = readStored();
  if (stored !== state.icon) {
    setState({ icon: stored });
  }
  if (stored === DEFAULT_APP_ICON) return;
  void invokeSetIcon(stored)
    .then((res) => {
      if (res) setState({ status: res, error: null });
    })
    .catch(() => {});
}

/** Switch to a preset, persist locally, and update the OS icon. */
export async function setAppIcon(next: AppIconId): Promise<void> {
  const prev = state.icon;
  const mine = ++pushes;
  setState({ icon: next, error: null, busy: true });
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* Storage refused: holds for this session only. */
  }
  if (!appIconSupported()) {
    setState({ busy: false, status: null });
    return;
  }
  try {
    const res = await invokeSetIcon(next);
    if (mine !== pushes) return;
    setState({ status: res, error: null, busy: false });
  } catch (err) {
    if (mine !== pushes) return;
    try {
      localStorage.setItem(KEY, prev);
    } catch {
      /* Ignore */
    }
    setState({
      icon: prev,
      busy: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function useAppIcon(): AppIconState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
