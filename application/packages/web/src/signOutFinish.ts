/**
 * Finishing a sign-out or a wipe that did not end (beta.privacynotes.app
 * #211).
 *
 * A sign-out removes the phrase first and the session last, and a wipe asks
 * the auth server before it removes the database. A page that ends in
 * between (the tab closed, the browser quit, a reload) left the session, the
 * fast-boot flags, the registration marker, the settings cache and the
 * database on disk, and nothing at the next start finished the job: a
 * provider login whose phrase the server keeps then signed itself back in
 * with nobody typing anything. Both write a mark with their first removal
 * and remove it as their last step (liveSignIn.ts), and a start that finds
 * it runs this before anything reads a session.
 *
 * It finishes as a forced sign-out does: rows the server has not confirmed
 * stay (ciphertext under a key nobody holds until the same phrase signs in
 * again, which pushes them; another account's sign-in wipes them), and so
 * does an unsent settings change, without its PIN fields. The credential
 * part is synchronous, so the auth library and the lock screen find nothing;
 * the database follows, and the mark goes once it is done, so a start that
 * ends again finishes again. A sign-in that goes live meanwhile owns the
 * storage and removes the mark (adoptLiveSignIn).
 */
import { isDemoMode } from './demo';
import { logAuthEvent } from './authDiag';
import {
  OAUTH_FLAG_KEY,
  PHRASE_STORAGE_KEY,
  clearAccountScopedUiState,
  clearCachedAccountFlags,
  clearRegistrationMarker,
  clearReplacedAccount,
  clearSupabaseAuthKeys,
  removePendingPhraseChange,
} from './authStorage';
import { trustAwareStorage } from './trustStorage';
import { removeBiometricCredential, removePinWrappedPhrase } from './biometric';
import { clearEverRegistered } from './devices';
import { clearPanelCache } from './accountPanelCache';
import { clearPinCache } from './pin';
import { clearLocalSettings } from './userSettings';
import { clearLocalDatabase } from './notesRepo';
import { endSignOutMark, signOutMarkLeft } from './liveSignIn';
import { clearLocalOnlyFlagsSync } from './localOnly';

/** The credentials and caches of the account that left, every one of them
 *  synchronous. */
function removeAccountKeys(): void {
  clearSupabaseAuthKeys();
  trustAwareStorage.removeItem(PHRASE_STORAGE_KEY);
  removeBiometricCredential();
  removePinWrappedPhrase();
  removePendingPhraseChange();
  trustAwareStorage.removeItem(OAUTH_FLAG_KEY);
  trustAwareStorage.removeItem('privacynotes.lastSync');
  clearCachedAccountFlags();
  clearRegistrationMarker();
  clearEverRegistered();
  clearReplacedAccount();
  clearPanelCache();
  clearAccountScopedUiState();
  clearLocalOnlyFlagsSync();
  clearPinCache();
  clearLocalSettings(true);
}

let settled: Promise<void> = Promise.resolve();

/**
 * At start, before anything reads a session: finish a sign-out or a wipe
 * this browser began and did not end. Answers whether there was one; the
 * database part runs on, and `signOutFinishSettled` waits for it.
 */
export function finishInterruptedSignOut(): boolean {
  const mark = isDemoMode() ? null : signOutMarkLeft();
  if (mark === null) return false;
  logAuthEvent('auth:boot-finish-signout');
  removeAccountKeys();
  settled = clearLocalDatabase({ keepUnsyncedNotes: true })
    .then(() => {
      // Only now: a start that ends during the wipe finishes it again.
      endSignOutMark(mark);
    })
    .catch((err: unknown) => {
      logAuthEvent('auth:boot-finish-signout-failed', { name: (err as Error | null)?.name });
    });
  return true;
}

/** Resolves once the database part of `finishInterruptedSignOut` ended. */
export function signOutFinishSettled(): Promise<void> {
  return settled;
}
