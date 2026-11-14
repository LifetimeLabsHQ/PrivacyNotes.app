import { useSyncExternalStore } from 'react';
import { isBelowVersionFloor } from './versionFloor';
import { createListeners } from './listeners';
import { readFlag } from './localStore';

/**
 * User-controlled sync pause, per device.
 *
 * Same enforcement seam as the release floor (versionFloor.ts): every
 * server write asks `isServerWriteBlocked()` before touching the network,
 * so a paused device keeps working locally and stops talking to the
 * server. Unlike the floor, this is a deliberate user choice, stored
 * device-local (a "do not talk to the server" flag cannot itself travel
 * through the server) and it NEVER clears itself - a silent auto-resume
 * would break the promise the switch makes. The SyncStatus pill carries
 * the paused state for the whole pause.
 *
 * The heartbeat is deliberately NOT gated, same as the floor: it carries
 * no note data and it is the only channel through which a revoked device
 * learns it was revoked.
 */

const STORAGE_KEY = 'privacynotes.syncPaused';

// Unreadable storage reads as off: fail open, sync runs.
let paused = readFlag(STORAGE_KEY);
const { subscribe, notify } = createListeners();

// A pause set in another tab reaches this one: the storage event fires in
// every other tab of this origin, so the device stops talking to the server
// in all of them, as the switch promises (GitHub #655). A null key is a
// cleared storage.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    const next = readFlag(STORAGE_KEY);
    if (next === paused) return;
    paused = next;
    notify();
  });
}

function isSyncPaused(): boolean {
  return paused;
}

export function setSyncPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked - the in-memory flag still holds for this session.
  }
  notify();
}

/**
 * The dead man's switch hold: set when the server says this account was
 * wiped after this device last looked, and cleared only by the person's
 * answer in the dialog (dms.ts). In memory on purpose: an app closed
 * mid-dialog asks again at the next start, and no sign-in or account switch
 * may lift it the way they lift suspendSync().
 * Spec: docs/internal/specs/dead-mans-switch.md (section 6)
 */
let dmsHeld = false;

export function setDmsHold(next: boolean): void {
  if (dmsHeld === next) return;
  dmsHeld = next;
  notify();
}

/**
 * The one question every server-write path asks. Composes the release
 * floor, the user pause and the dead man's switch hold so a new
 * blocked-state never needs another sweep over the twelve call sites.
 */
export function isServerWriteBlocked(): boolean {
  return isBelowVersionFloor() || isSyncPaused() || dmsHeld;
}

/** Reactive isSyncPaused() for the pill and the sync panel. */
export function useSyncPaused(): boolean {
  return useSyncExternalStore(subscribe, isSyncPaused, () => false);
}

