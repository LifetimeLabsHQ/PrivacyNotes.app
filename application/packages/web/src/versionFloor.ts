import { useSyncExternalStore } from 'react';
import { compareSemver } from './versionCheck';
import { VERSION } from './version';

/**
 * "This build is below the release floor" as app-wide state.
 *
 * The floor (`minVersion` in packages/desktop/update-policy.json, published
 * per platform) used to drive presentation only: it decided whether the
 * update toast had a dismiss button. Since the sync-pause work it is also an
 * enforcement input: a below-floor client keeps working locally but stops
 * writing to the server (sync, settings, note versions, blob uploads and
 * deletes, blob GC), because the floor is only ever raised for a sync/auth
 * protocol change, a client security fix, or a data-corruption fix - exactly
 * the cases where an old client's writes can damage server data that newer
 * devices then pull.
 *
 * Who reports: whichever updater already fetches the floor for this channel
 * (AndroidUpdateToast for the direct APK, DesktopUpdater for the Linux .deb,
 * StoreUpdateToast for Play/iOS). Web and the self-updating desktops never
 * report, so they can never pause. Each of them reports only a floor from a
 * policy file the release signed for its channel (policySignature.ts): this
 * state stops server writes, so the file that sets it must be ours.
 *
 * Persistence: the last reported floor is kept in localStorage so the pause
 * holds from t=0 on the next launch instead of racing the manifest fetch.
 * The comparison always runs against the CURRENT bundled VERSION, so
 * installing the update un-pauses immediately with no cleanup step. No
 * report and unreadable storage mean "not below"; an unreadable policy after
 * a floor is known keeps that floor.
 *
 * The stored floor lives under a new key since the policy signature: the old
 * key could hold a floor from a policy nobody signed, and a build that checks
 * signatures must not keep it. The old key is removed on load. Beside the
 * floor sits the `issued` time of the signed policy it came from, and a
 * policy issued earlier than that is ignored, so an old signed file served
 * again cannot move the floor back. One issued at the same time with another
 * floor is ignored too: sign-policy.sh never signs two floors at one time.
 *
 * Spec: docs/internal/android-update-check.md (sync pause below the floor;
 * The policy signature)
 */

const STORAGE_KEY = 'privacynotes.versionFloor.signed';
const UNSIGNED_STORAGE_KEY = 'privacynotes.versionFloor';

type Stored = { minVersion: string | null; issued: number | null };

function readStored(): Stored {
  try {
    if (typeof localStorage === 'undefined') return { minVersion: null, issued: null };
    localStorage.removeItem(UNSIGNED_STORAGE_KEY);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { minVersion: null, issued: null };
    const parsed = JSON.parse(raw) as { minVersion?: unknown; issued?: unknown };
    return {
      minVersion: typeof parsed?.minVersion === 'string' ? parsed.minVersion : null,
      issued: Number.isSafeInteger(parsed?.issued) ? (parsed.issued as number) : null,
    };
  } catch {
    // Unreadable storage: fail open, treat as no floor.
    return { minVersion: null, issued: null };
  }
}

const stored = readStored();
let floor: string | null = stored.minVersion;
let issued: number | null = stored.issued;
const listeners = new Set<() => void>();

/**
 * Record the floor this channel's signed policy reported (null when a policy
 * that was read carries none), with the policy's `issued` time. Persisted so
 * the next launch enforces it before any network round trip. A policy that
 * cannot be read or is not signed, a 404 included, is no report at all:
 * callers keep the floor they hold, and a floor is lowered only by publishing
 * a lower one. A report issued before the last one taken is ignored.
 */
export function reportVersionFloor(minVersion: string | null, issuedAt?: number): void {
  if (issuedAt !== undefined && issued !== null) {
    if (issuedAt < issued || (issuedAt === issued && minVersion !== floor)) return;
  }
  // A report without a time (the dev hook, tests) clears the time held, so a
  // signed policy is taken again afterwards.
  const nextIssued = issuedAt ?? null;
  if (floor === minVersion && issued === nextIssued) return;
  const changed = floor !== minVersion;
  floor = minVersion;
  issued = nextIssued;
  try {
    if (minVersion === null && issued === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ minVersion, issued }));
  } catch {
    // Storage blocked - the in-memory flag still holds for this session.
  }
  if (changed) for (const cb of listeners) cb();
}

/** The last reported floor, or null when none is known. */
export function knownVersionFloor(): string | null {
  return floor;
}

/** True when the running build is below the last reported floor. */
export function isBelowVersionFloor(): boolean {
  return floor !== null && compareSemver(VERSION, floor) < 0;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Reactive isBelowVersionFloor() for the SyncStatus pill and store toast. */
export function useBelowVersionFloor(): boolean {
  return useSyncExternalStore(subscribe, isBelowVersionFloor, () => false);
}

// Dev-only console hook: no channel reports a floor in a browser, so this is
// the only way to exercise the pause against `pnpm dev`. Persists exactly like
// a real report - clear with __pnVersionFloor(null) when done. Folded out of
// every shipped build by import.meta.env.DEV.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__pnVersionFloor = (
    minVersion: string | null,
  ) => reportVersionFloor(minVersion);
}
