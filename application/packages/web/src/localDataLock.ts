/**
 * The Web Lock every page that opens the vault holds for its life, so the
 * start wipe of an untrusted device's leftover (untrustedLeftover.ts) never
 * runs under a sign-in in any tab. Imports only the demo check: the sign-in
 * paths (auth.tsx, authOAuth.ts) take it at their first step.
 * Spec: docs/internal/plans/untrusted-device-memory.md (section 2.2)
 */
import { isDemoMode } from './demo';

export const LOCAL_DATA_LOCK = 'privacynotes-local-data';
// Written by every wipe: a page the back/forward cache restores compares it
// with the value it saw when it took the lock.
const WIPED_AT = 'privacynotes.leftoverWipedAt';

export function localDataLocks(): LockManager | null {
  try {
    return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
  } catch {
    return null;
  }
}

let held: Promise<void> | null = null;
let wipeSeen: string | null = null;

function readWiped(): string | null {
  try {
    return localStorage.getItem(WIPED_AT);
  } catch {
    return null;
  }
}

/**
 * Hold the shared lock for the rest of this page's life: a sign-in that runs
 * here, trusted or not, keeps another tab's start wipe away from its data.
 * Resolves once it is held, which waits for a wipe that runs. Never released
 * by hand: the page's end releases it, a crash included.
 */
export function holdLocalDataLock(): Promise<void> {
  if (isDemoMode()) return Promise.resolve();
  const manager = localDataLocks();
  if (!manager) return Promise.resolve();
  if (!held) {
    held = new Promise<void>((resolve) => {
      manager
        .request(LOCAL_DATA_LOCK, { mode: 'shared' }, () => {
          wipeSeen = readWiped();
          resolve();
          return new Promise<never>(() => {});
        })
        .catch(() => resolve());
    });
  }
  return held;
}

/**
 * The lock for a path that opens the vault (auth.tsx): true once held, false
 * when a wipe in another tab still runs after `ms`. The request stays queued
 * either way, so the next attempt waits on the same one and no sign-in ever
 * runs beside a wipe.
 */
export function waitForLocalDataLock(ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void holdLocalDataLock().then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}


/** A wipe ran: pages the back/forward cache restores reload (`watchRestoredPage`). */
export function markLeftoverWiped(): void {
  try {
    localStorage.setItem(WIPED_AT, String(Date.now()));
  } catch {
    /* a restored page then cannot tell; it holds the lock again */
  }
}

/**
 * A page the browser brings back from its back/forward cache had no lock
 * meanwhile (a browser may drop it, or keep such a page out of the cache), so
 * a start wipe may have run under it, or may still run. A page that held the
 * lock reloads when the wipe count moved, now or once its new request is
 * granted; else it holds the lock again. The phrase-replaced screen holds
 * no live sign-in and still guards this device's notes, so the test is
 * "held the lock", not "signed in".
 */
export function watchRestoredPage(): void {
  if (isDemoMode() || typeof window === 'undefined' || !localDataLocks()) return;
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !held) return;
    const before = wipeSeen;
    if (readWiped() !== before) {
      window.location.reload();
      return;
    }
    held = null;
    void holdLocalDataLock().then(() => {
      if (wipeSeen !== before) window.location.reload();
    });
  });
}
