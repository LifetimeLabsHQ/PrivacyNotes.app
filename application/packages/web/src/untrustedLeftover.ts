/**
 * The local database a device that is not trusted leaves behind (GitHub
 * #795, point 6).
 *
 * A tab whose person did not tick "Trust this device" keeps its secrets in
 * memory (trustStorage.ts), so a reload or a closed tab signs it out, and the
 * sealed database stays on the disk with no way back to it but the phrase.
 * The next start of the app in that browser profile, with no session and no
 * sign-in anywhere, removes it as a forced sign-out does: the same finish as a
 * sign-out that did not end (signOutFinish.ts), so rows the server has not
 * confirmed, and notes with typing in the flush stash, stay as ciphertext for
 * the same phrase's next sign-in.
 *
 * A Web Lock keeps it from running under a sign-in. Every tab with a live or
 * starting sign-in holds it in shared mode for the page's life
 * (localDataLock.ts); the wipe asks for it exclusively and only if it is
 * free, and a sign-in that starts during a wipe waits for it to end.
 * Without the Web Locks API nothing is wiped.
 * Spec: docs/internal/plans/untrusted-device-memory.md (section 2.2)
 */
import { isDemoMode } from './demo';
import { LOCAL_DATA_LOCK, localDataLocks, markLeftoverWiped } from './localDataLock';
import { logAuthEvent } from './authDiag';
import { PHRASE_STORAGE_KEY, hasPendingPhraseChange } from './authStorage';
import { isTrustedDevice, tabSecrets, UNTRUSTED_IN_MEMORY } from './trustStorage';
import { hasLockWrap, dropBrowserKeyIfUnused } from './phraseAtRest';
import { hasOAuthPending } from './oauthPending';
import { beginSignOutMark, signOutMarkLeft } from './liveSignIn';
import { finishInterruptedSignOut, signOutFinishSettled } from './signOutFinish';

const TRUST_FLAG = 'privacynotes.trusted';

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Whether this start may remove what an untrusted sign-in left: every
 *  condition but the lock. */
function leftoverOnly(authKey: string): boolean {
  if (isDemoMode()) return false;
  // Exactly this version's untrusted value: the last sign-in by hand in this
  // browser kept its secrets in memory. An unset flag (never set, or an
  // evicted localStorage) and an older version's '0' never wipe.
  if (readLocal(TRUST_FLAG) !== UNTRUSTED_IN_MEMORY) return false;
  if (isTrustedDevice()) return false;
  // `-sealed`: the session the app lock sealed (sessionSeal.ts).
  for (const key of [PHRASE_STORAGE_KEY, authKey, `${authKey}-user`, `${authKey}-sealed`]) {
    if (readLocal(key) !== null || tabSecrets.getItem(key) !== null) return false;
  }
  if (hasLockWrap() || hasPendingPhraseChange()) return false;
  try {
    if (new URLSearchParams(window.location.search).has('code')) return false;
  } catch {
    return false;
  }
  return !hasOAuthPending();
}

/**
 * At start, after a sign-out that did not end was finished: remove the
 * database a tab that was not trusted left, when nothing could sign in from
 * it and no tab holds a sign-in. Answers whether it wiped.
 */
export async function wipeUntrustedLeftover(authKey: string): Promise<boolean> {
  if (!leftoverOnly(authKey)) return false;
  const manager = localDataLocks();
  if (!manager) return false;
  await signOutFinishSettled();
  let wiped = false;
  try {
    await manager.request(LOCAL_DATA_LOCK, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock || !leftoverOnly(authKey)) return;
      beginSignOutMark('signout');
      finishInterruptedSignOut();
      await signOutFinishSettled();
      // The finish removes its mark only once the database is clear; a mark
      // left means it failed, and the next start finishes it.
      if (signOutMarkLeft() !== null) {
        logAuthEvent('auth:untrusted-leftover-wipe-failed');
        return;
      }
      await dropBrowserKeyIfUnused();
      markLeftoverWiped();
      // A sign-in waiting for this wipe already wrote the flag for itself:
      // its own leftover is the next start's to remove.
      const waiting = typeof manager.query !== 'function'
        || (await manager.query().then((s) => (s.pending ?? []).some((l) => l.name === LOCAL_DATA_LOCK), () => true));
      try {
        if (!waiting && localStorage.getItem(TRUST_FLAG) === UNTRUSTED_IN_MEMORY) localStorage.removeItem(TRUST_FLAG);
      } catch {
        /* the next start asks again */
      }
      logAuthEvent('auth:untrusted-leftover-wiped');
      wiped = true;
    });
  } catch (err) {
    logAuthEvent('auth:untrusted-leftover-wipe-failed', { name: (err as Error | null)?.name });
  }
  return wiped;
}

