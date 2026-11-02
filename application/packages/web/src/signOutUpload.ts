import type { SupabaseClient } from '@notes/shared';
import { sync } from './sync';
import { countUnsyncedNotes } from './notesRepo';
import { hasUnpushedSettings, syncUserSettings } from './userSettings';
import { isServerWriteBlocked } from './syncPause';

/**
 * The upload a chosen sign-out waits for, before signOut() removes anything.
 *
 * signOut() itself flushes on a fixed budget (2 s, or 10 s with unsent rows)
 * and then wipes whatever the flush did not reach, after it has already
 * removed the phrase. A sign-out the person chooses runs this first instead,
 * while the session is whole: it pushes the unsent notes and the unsent
 * settings change with no time limit, and answers 'done' only when nothing
 * is left. 'failed' (offline, writes paused, a push that threw or left rows
 * behind) means the caller asks before it signs out; 'cancelled' means the
 * person pressed Cancel and stays signed in. Pictures and files are not
 * uploaded here: the sign-out confirm names them (neverBackedUp.tsx).
 *
 * A forced sign-out (device removed, session gone) never runs this: it
 * keeps its unsent rows through the wipe instead (keepUnsyncedNotes).
 */
export type SignOutUploadResult = 'done' | 'failed' | 'cancelled';

export interface SignOutUploadDeps {
  countUnsentNotes: () => Promise<number>;
  hasUnsentSettings: () => boolean;
  /** One push-only pass. `ran` is false while another pass holds the slot. */
  pushNotes: () => Promise<{ ran: boolean }>;
  pushSettings: () => Promise<unknown>;
  /** False when offline or while server writes are paused (syncPause.ts). */
  canReachServer: () => boolean;
  wait: (ms: number) => Promise<void>;
}

export async function uploadBeforeSignOut(
  deps: SignOutUploadDeps,
  signal: AbortSignal,
  /** Called once, before the first push: there is something to upload. */
  onStart?: () => void,
): Promise<SignOutUploadResult> {
  // A failed count is not an empty one.
  const unsent = await deps.countUnsentNotes().catch(() => 1);
  if (unsent === 0 && !deps.hasUnsentSettings()) return 'done';
  if (signal.aborted) return 'cancelled';
  if (!deps.canReachServer()) return 'failed';
  onStart?.();
  try {
    if (unsent > 0) {
      // A pass that holds the slot pushes the same rows; wait for a slot
      // and push once more. No fixed limit: Cancel ends the wait.
      while (!(await deps.pushNotes()).ran) {
        if (signal.aborted) return 'cancelled';
        if (!deps.canReachServer()) return 'failed';
        await deps.wait(250);
      }
    }
    if (signal.aborted) return 'cancelled';
    if (deps.hasUnsentSettings()) await deps.pushSettings();
  } catch {
    return signal.aborted ? 'cancelled' : 'failed';
  }
  if (signal.aborted) return 'cancelled';
  const left = await deps.countUnsentNotes().catch(() => 1);
  return left === 0 && !deps.hasUnsentSettings() ? 'done' : 'failed';
}

/** The live dependencies for a signed-in vault. */
export function liveSignOutUploadDeps(
  supabase: SupabaseClient,
  auth: { pubkey: string; encryptionKey: Uint8Array; deviceId: string },
): SignOutUploadDeps {
  return {
    countUnsentNotes: countUnsyncedNotes,
    hasUnsentSettings: hasUnpushedSettings,
    pushNotes: () =>
      sync(supabase, auth.pubkey, auth.encryptionKey, auth.deviceId, undefined, undefined, undefined, { flushOnly: true }),
    pushSettings: () => syncUserSettings(supabase, auth.pubkey, auth.encryptionKey),
    canReachServer: () => navigator.onLine && !isServerWriteBlocked(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
