// The one verification a SessionExpiredError passes before the re-auth modal
// (session audit section 0, layer 3).
//
// getUser() refreshes an expired access token as a side effect, but auth-js
// decides "expired" from the device clock. On a device whose clock runs hours
// behind, the token the server already refuses still looks fresh, so getUser
// sends it as it is and the server answers 403 bad_jwt. The modal then showed
// for a session that was alive the whole time, and no refresh ever happened
// (production, 2026-11-02: one desktop session refused 1,178 times in four
// hours). refreshSession() asks the server whatever the clock says, so a
// refused token gets one forced refresh before it counts as a verdict. A
// refresh the server refuses IS a verdict; one that never reached it is not.
import type { SupabaseClient } from '@notes/shared';
import { logAuthEvent } from './authDiag';
import { hasLiveSignIn } from './liveSignIn';

/** What the check found. Only `dead` and `claim-mismatch` may raise the modal. */
type SessionVerdict = 'healthy' | 'claim-mismatch' | 'dead' | 'unverifiable';

type ErrLike = { name?: string; status?: number } | null | undefined;

/** An explicit server "no" for this token or session. Same allowlist as the
 *  wipe site in auth.tsx: a 429 or an unparseable body is never one. */
function isRefusal(err: ErrLike): boolean {
  if (!err) return false;
  if (err.name === 'AuthSessionMissingError') return true;
  return err.name === 'AuthApiError' && (err.status === 401 || err.status === 403);
}

/** A refresh the server answered with a no: the refresh token is gone or used. */
function isRefreshRefusal(err: ErrLike): boolean {
  if (!err) return false;
  if (err.name === 'AuthSessionMissingError') return true;
  return err.name === 'AuthApiError' && (err.status === 400 || err.status === 401 || err.status === 403);
}

export async function verifyExpiredSession(supabase: SupabaseClient, pubkey: string | null): Promise<SessionVerdict> {
  let { data, error } = await supabase.auth.getUser();
  if (isRefusal(error) && error?.name !== 'AuthSessionMissingError') {
    // A refresh writes a session. Never after a sign-out began: that would
    // put back the session the sign-out removed.
    if (!hasLiveSignIn()) return 'unverifiable';
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error) {
      const status = (refreshed.error as ErrLike)?.status;
      if (isRefreshRefusal(refreshed.error as ErrLike)) {
        logAuthEvent('sync:session-expired-confirmed', { name: refreshed.error.name, status, after: 'refresh' });
        return 'dead';
      }
      logAuthEvent('sync:session-expired-unverifiable', { name: refreshed.error.name, status, after: 'refresh' });
      return 'unverifiable';
    }
    logAuthEvent('sync:session-expired-refreshed', { status: (error as ErrLike)?.status });
    ({ data, error } = await supabase.auth.getUser());
  }
  if (!error && data.user) {
    const claimPk = (data.user.app_metadata as { pubkey?: string } | undefined)?.pubkey;
    if (claimPk === pubkey) {
      logAuthEvent('sync:session-expired-suppressed', { reason: 'verified-healthy' });
      return 'healthy';
    }
    logAuthEvent('sync:session-expired-claim-mismatch', { claimPk: claimPk?.slice(0, 8) ?? null });
    return 'claim-mismatch';
  }
  const status = (error as ErrLike)?.status;
  if (isRefusal(error)) {
    logAuthEvent('sync:session-expired-confirmed', { name: error?.name, status });
    return 'dead';
  }
  logAuthEvent('sync:session-expired-unverifiable', { name: error?.name, status });
  return 'unverifiable';
}
