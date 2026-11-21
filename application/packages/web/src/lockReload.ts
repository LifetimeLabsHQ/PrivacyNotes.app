/**
 * The lock that reloads the page (GitHub #841): the phrase, the keys and the
 * decrypted notes lose their last reference, and the page starts again behind
 * the lock. Apart from appReLock.ts, which windows without the notes (Ninja,
 * About) load through trayMode.ts: this module reaches the device key and the
 * note store, whose commands those windows do not hold.
 * Spec: docs/internal/plans/phrase-lock-hardening.md (section 3)
 */

import { keepReopenNote } from './appReLock';
import { hasStoredPhrase } from './biometric';
import { isDemoMode } from './demo';
import { detectPlatform } from './devices';
import { appLockArmed } from './phraseAtRest';
import { clearPinUnlock } from './pin';
import { settleStoredSession } from './sessionSeal';

/**
 * Whether this lock reloads the page instead of drawing the curtain.
 * Only with the app lock armed and no phrase at rest: the page that starts
 * after the reload boots locked (App.tsx) and opens only through an unlock,
 * while a phrase at rest would start it signed in again. The web needs the
 * network to load the page again (it has no offline copy of the app), so an
 * offline browser keeps the curtain; the apps load their files from the
 * bundle. The demo holds no real secret and keeps the curtain.
 * Spec: docs/internal/plans/phrase-lock-hardening.md (section 3.2, section 4 Q1)
 */
export function lockReloadsPage(): boolean {
  if (isDemoMode()) return false;
  if (!appLockArmed() || hasStoredPhrase()) return false;
  return detectPlatform() !== 'web' || navigator.onLine !== false;
}

/**
 * Long jobs that hold the reload: idle counts input only, so a job the
 * person left running (an import, `ImportModal.tsx`) would die with the page.
 * While one holds, the lock draws the curtain, and the reload follows when
 * the last hold ends. A job releases in a `finally`, once; a reload the
 * unlock cancelled meanwhile answers false when the hold ends.
 */
const reloadHolds = new Set<symbol>();
const holdsEnded = new Set<() => void>();

export function holdLockReload(): () => void {
  const hold = Symbol('lock-reload-hold');
  reloadHolds.add(hold);
  return () => {
    if (!reloadHolds.delete(hold) || reloadHolds.size > 0) return;
    for (const done of [...holdsEnded]) done();
  };
}

export function lockReloadHeld(): boolean {
  return reloadHolds.size > 0;
}

function holdsReleased(): Promise<void> {
  if (reloadHolds.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      holdsEnded.delete(done);
      resolve();
    };
    holdsEnded.add(done);
  });
}

/**
 * How long the lock waits for a note save and a sync pass before it reloads
 * anyway, and how often it asks. A save cut by the cap is not lost: the
 * synchronous flush before the wait wrote it to the flush stash, which the
 * next unlock replays. A pass cut by the cap runs again after the unlock.
 * The settle time is the least it waits: a write no stash covers (a title,
 * a save its debounce had already started) commits within it.
 */
export const LOCK_RELOAD_WAIT_MS = 5_000;
export const LOCK_RELOAD_SETTLE_MS = 300;
const LOCK_RELOAD_POLL_MS = 50;

export interface LockReloadDeps {
  /** A save this tab started has not written yet (flushStash.ts). */
  saveWaits: () => boolean;
  /** A sync pass runs (sync.ts). */
  syncRuns: () => boolean;
  /** The app left the lock meanwhile: the reload is no longer due. */
  cancelled: () => boolean;
  /** Called once the jobs have ended, before the wait: hide the screen. */
  onQuiet?: () => void;
  /** Store what the next page needs (the times-only reminder plan). */
  keep?: () => void | Promise<void>;
  reload: () => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The reload of a lock, after its caller flushed the open editors (the
 * synchronous `beforeunload` flush, which writes the flush stash) and put
 * the lock up. Waits for the jobs that hold it, then at least
 * `LOCK_RELOAD_SETTLE_MS` and up to `LOCK_RELOAD_WAIT_MS` for the pending
 * saves and the sync pass, asks `lockReloadsPage` again (the browser may have
 * gone offline during a long hold), keeps the open note and the reminder plan
 * for this tab, clears the PIN unlock stamps, and reloads. Nothing is zeroed
 * first: the page dies anyway, a zeroed key would make the flush stash
 * refuse, and a pass still running would push with it. Answers false, having
 * reloaded nothing, when the app left the lock meanwhile or the reload is no
 * longer possible; the caller then shows the lock screen.
 */
export async function reloadForLock(deps: LockReloadDeps): Promise<boolean> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  await holdsReleased();
  if (deps.cancelled()) return false;
  deps.onQuiet?.();
  const start = now();
  const settled = start + LOCK_RELOAD_SETTLE_MS;
  const until = start + LOCK_RELOAD_WAIT_MS;
  while ((now() < settled || deps.saveWaits() || deps.syncRuns()) && now() < until) {
    await wait(LOCK_RELOAD_POLL_MS);
    if (deps.cancelled()) return false;
  }
  if (deps.cancelled() || !lockReloadsPage()) return false;
  keepReopenNote();
  try {
    await deps.keep?.();
  } catch {
    /* the lock screen rings nothing until the unlock */
  }
  if (deps.cancelled()) return false;
  clearPinUnlock();
  // The page ends with the seal key: a plain copy left (the first lock after
  // the update) is sealed while the key still exists (sessionSeal.ts).
  settleStoredSession(true, true);
  deps.reload();
  return true;
}
