import { useSyncExternalStore } from 'react';
import { detectPlatform } from './devices';
import { createListeners } from './listeners';
import { readFlag } from './localStore';

/**
 * "Files on wifi only" - Android only, device-local.
 *
 * When on, image and attachment UPLOADS wait while the connection is
 * cellular; note text always syncs (a note is bytes, a video is
 * megabytes). Nothing else is gated: downloads, deletes and GC run as
 * normal, and the pending-upload queue simply holds its rows.
 *
 * Android only because the Android webview is the one place the Network
 * Information API reliably reports wifi vs cellular. The iOS webview has
 * no such API (a native reachability plugin was considered and skipped),
 * and desktop is effectively always on wifi or cable, so the switch is
 * hidden everywhere but Android.
 */

const STORAGE_KEY = 'privacynotes.filesWifiOnly';

type NetworkInformation = { type?: string; addEventListener?: (ev: string, cb: () => void) => void };

function connection(): NetworkInformation | null {
  const c = (navigator as unknown as { connection?: NetworkInformation }).connection;
  return c && typeof c === 'object' ? c : null;
}

/** True where the switch should exist at all. */
export function wifiOnlyAvailable(): boolean {
  return detectPlatform() === 'android' && connection() !== null;
}

let enabled = readFlag(STORAGE_KEY);
const { subscribe, notify } = createListeners();

function isFilesWifiOnly(): boolean {
  return enabled;
}

export function setFilesWifiOnly(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked - the in-memory flag still holds for this session.
  }
  notify();
}

/**
 * True while file uploads must wait: the switch is on and the current
 * connection is cellular. Fails open - an unknown or missing connection
 * type never holds an upload hostage.
 */
export function uploadsHeldForWifi(): boolean {
  if (!enabled) return false;
  return connection()?.type === 'cellular';
}

// Re-evaluate on connection change so the pill flips live, and nudge the
// upload queues the moment wifi returns instead of waiting out the
// post-sync retry cooldown. Listener installed once at module load;
// harmless where the API does not exist.
let wasHeld = uploadsHeldForWifi();
connection()?.addEventListener?.('change', () => {
  const held = uploadsHeldForWifi();
  if (wasHeld && !held) {
    window.dispatchEvent(new Event('privacynotes:wifi-restored'));
  }
  wasHeld = held;
  notify();
});

/** Reactive [enabled, held] pair for the switch and the pill. */
export function useFilesWifiOnly(): { enabled: boolean; held: boolean } {
  const on = useSyncExternalStore(subscribe, isFilesWifiOnly, () => false);
  const held = useSyncExternalStore(subscribe, uploadsHeldForWifi, () => false);
  return { enabled: on, held };
}
