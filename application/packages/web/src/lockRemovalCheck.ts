/**
 * The device removal check while the app is locked (beta.privacynotes.app
 * #214 item 10).
 *
 * A removal reaches a device through the heartbeat of a sync pass, and the
 * sync runs only in the notes view, which a locked app does not draw. So a
 * lost phone with the app lock on, removed by its owner, kept its sealed
 * notes and the PIN wrap of the phrase for as long as nobody unlocked it,
 * online or not. The lock screen asks the heartbeat's verdict with the
 * session this device stores, through `device_registered` (migration 0154),
 * which writes nothing: the heartbeat itself moves `devices.last_seen_at`,
 * activity for the dead man's switch, so a thief who kept the locked app
 * online would hold the switch off. An explicit `false` (no live device row,
 * or a ban) is the removal verdict, and the device wipes as a forced sign-out does,
 * keeping rows the server has not confirmed. Anything else, a failed call
 * included, is no verdict and changes nothing: only a definitive server
 * verdict ends a session.
 * A device kept offline is out of reach of any remote wipe.
 */
import type { SupabaseClient } from '@notes/shared';
import { isDemoMode } from './demo';
import { deviceRegistered, getDeviceId } from './devices';
import { jwtPayloadPubkey, ownsLocalData } from './authStorage';
import { logAuthEvent } from './authDiag';
import { beginSignOutMark } from './liveSignIn';
import { finishInterruptedSignOut, signOutFinishSettled } from './signOutFinish';

/** Whether the owner removed this device: the server's explicit no, for the
 *  session this device stores and the account that owns its data. */
export async function removedWhileLocked(supabase: SupabaseClient): Promise<boolean> {
  if (isDemoMode()) return false;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const pubkey = token ? jwtPayloadPubkey(token) : null;
    if (!pubkey || !ownsLocalData(pubkey)) return false;
    return !(await deviceRegistered(supabase, getDeviceId(pubkey)));
  } catch {
    return false;
  }
}

/**
 * The wipe of a removed device behind the lock: the forced sign-out's local
 * half, through the same steps a start runs for a sign-out that did not end.
 * With a live sign-in under the lock, its own forced sign-out runs instead.
 */
export async function wipeRemovedWhileLocked(forceSignOut: (() => Promise<void>) | null): Promise<void> {
  logAuthEvent('auth:locked-device-removed');
  if (forceSignOut) {
    await forceSignOut();
    return;
  }
  beginSignOutMark('signout');
  finishInterruptedSignOut();
  await signOutFinishSettled();
}
