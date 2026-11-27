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
 * An interrupted `wipe.*` mark finishes as `wipeThisDevice` does: device
 * leftovers, the entire local database, and every app and auth storage key go.
 * An interrupted `signout.*` mark on an unsynced local vault (`localOnly`, or
 * `neverSynced` with sync paused) clears all local rows and settings
 * permanently, matching its Delete & sign out confirmation; on a
 * synced account it finishes as a forced sign-out does, keeping rows the
 * server has not confirmed and any unsent settings change without PIN fields.
 * The credential part is synchronous, so the auth library and the lock screen
 * find nothing; the database follows, and the mark goes once it is done, so a
 * start that ends again finishes again. A sign-in that goes live meanwhile
 * owns the storage and removes the mark (adoptLiveSignIn).
 */
import { credentialKey, isDemoMode, isDemoOwnedKey } from './demo';
import { settingsLocalKey } from './settingsLocalKey';
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
import { tabSecrets, trustAwareStorage } from './trustStorage';
import { removeBiometricCredential, removePinWrappedPhrase } from './biometric';
import { clearEverRegistered, detectPlatform } from './devices';
import { clearPanelCache } from './accountPanelCache';
import { clearPinCache } from './pin';
import { clearLocalSettings } from './userSettings';
import { clearMassDeleteState } from './massDelete';
import { db } from './db';
import { clearLocalDatabase, deleteEntireLocalDatabase } from './notesRepo';
import {
  announceSignOut,
  clearShareInboxPendingMark,
  endSignOutMark,
  hasShareInboxClearPending,
  holdsSignOutMark,
  markShareInboxClearPending,
  shareInboxPendingKey,
  signOutFinishSettled,
  signOutMarkLeft,
  trackSignOutFinish,
} from './liveSignIn';
import {
  clearLocalOnlyFlagsSync,
  isUnsyncedLocalVault,
  LOCAL_ONLY_OWNER_KEY,
  NEVER_SYNCED_OWNER_KEY,
} from './localOnly';
import { readFlag } from './localStore';
import { isSyncPaused } from './syncPause';

export { signOutFinishSettled };

/** Key of OS reminder ids still awaiting cancellation (notesView/useReminders.tsx). */
const REMINDER_TO_CANCEL_KEY = 'privacynotes.reminderToCancel';

/** The Cache Storage names of the on-device model and the plugins
 *  (plugins/pluginStore.ts StoreId); desktop keeps them in folders too. */
const DEVICE_CACHES = ['pn-on-device-ai', 'pn-plugins'] as const;

interface DeviceLeftoverCleaners {
  forgetFolder: () => Promise<void>;
  clearDestination: () => Promise<void>;
  clearPluginFolders: () => Promise<void>;
  clearShareInbox?: () => Promise<boolean>;
}

/**
 * The parts of this device's state that live outside the app's database and
 * outside the `privacynotes.` keys, which a full wipe takes too. Not in the
 * demo: the folder and backup records have demo buckets of their own, and
 * the caches are the real install's.
 */
export async function forgetDeviceLeftovers(cleaners?: DeviceLeftoverCleaners): Promise<boolean> {
  if (isDemoMode()) return true;
  const shareInboxCleared = cleaners?.clearShareInbox
    ? await cleaners.clearShareInbox()
    : await clearPhoneShareInbox();
  try {
    const { forgetFolder } = cleaners ?? (await import('./markdownFolder/folderMemory'));
    await forgetFolder();
  } catch { /* ignore */ }
  try {
    const { clearDestination } = cleaners ?? (await import('./autoBackup/destination'));
    await clearDestination();
  } catch { /* ignore */ }
  // The tracker range under its name from before the app's prefix
  // (stats/wellnessRange.ts); the sweep takes the new one.
  try { localStorage.removeItem('pn-wellness-range'); } catch { /* ignore */ }
  for (const name of DEVICE_CACHES) {
    try {
      await caches.delete(name);
    } catch {
      /* no Cache Storage here */
    }
  }
  // Desktop: the plugin folders. The caches go first, so nothing is moved into them.
  try {
    const { clearPluginFolders } = cleaners ?? (await import('./plugins/pluginStore'));
    await clearPluginFolders();
  } catch {
    /* nothing to clear */
  }
  return shareInboxCleared;
}

/**
 * Wipe this session's keys from localStorage, from the tab's own memory
 * (a tab that is not trusted, trustStorage.ts) and from sessionStorage.
 * Catches per-key to avoid one bad key blocking the rest.
 *
 * The demo runs on the SAME origin as a real install whenever the URL
 * carries `?demo=1`, and it renders DangerZone with the local half
 * already ticked. In demo the sweep is restricted to the demo bucket plus
 * the demo settings key so a real account's credentials are untouched.
 */
export function clearAllStorageKeys(keepKey?: string): void {
  const demo = isDemoMode();
  const demoSettings = settingsLocalKey();
  for (const store of [localStorage, tabSecrets, sessionStorage]) {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k) continue;
      // Clear app keys AND Supabase auth session keys. Without the
      // sb- prefix, a stale OAuth session survives account deletion
      // and hydrateFromOAuthSession treats the deleted user as
      // existing on the next page load.
      const owned = demo
        ? isDemoOwnedKey(k) || k === demoSettings
        : k.startsWith('privacynotes.') || k.startsWith('sb-');
      // Keep unconfirmed OS reminder cancellation ids until the next start
      // cancels them, any pending phone share-inbox clear flag, plus an
      // optional in-progress wipe mark until DB deletion settles.
      if (
        owned &&
        k !== REMINDER_TO_CANCEL_KEY &&
        k !== shareInboxPendingKey() &&
        k !== keepKey
      ) {
        keys.push(k);
      }
    }
    for (const k of keys) {
      try { store.removeItem(k); } catch { /* ignore */ }
    }
  }
}

function clearFlushStashKeys(): void {
  for (const suffix of ['', '.kept', '.waiting']) {
    try { localStorage.removeItem(credentialKey(`privacynotes.flushStash${suffix}`)); } catch { /* ignore */ }
  }
}

/** The credentials and caches of the account that left, every one of them
 *  synchronous. */
function removeAccountKeys(keepUnsentSettings: boolean): void {
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
  if (!keepUnsentSettings) {
    clearMassDeleteState();
    clearFlushStashKeys();
  }
  clearPinCache();
  clearLocalSettings(keepUnsentSettings);
}

/** Marks the phone share inbox as needing a clear before any vault opens. */
export function markPhoneShareInboxPending(): void {
  const platform = detectPlatform();
  if (platform === 'ios' || platform === 'android') {
    markShareInboxClearPending();
  }
}

/** Empty the phone share inbox and reset its cached upload limit. Loaded on
 *  demand so desktop and web starts load nothing extra. Answers whether the
 *  native inbox is clean (true off mobile). */
export async function clearPhoneShareInbox(): Promise<boolean> {
  const platform = detectPlatform();
  if (platform !== 'ios' && platform !== 'android') {
    clearShareInboxPendingMark();
    return true;
  }
  markShareInboxClearPending();
  try {
    const { clearShareInbox } = await import('./useShareInbox');
    return await clearShareInbox();
  } catch {
    markShareInboxClearPending();
    return false;
  }
}

/** Flushes a pending native share-inbox clear left by a locked sign-out or wipe. */
export async function flushPendingShareInbox(): Promise<boolean> {
  if (!hasShareInboxClearPending()) return true;
  return clearPhoneShareInbox();
}

/**
 * At start, before anything reads a session: finish a sign-out or a wipe
 * this browser began and did not end. Answers whether there was one; the
 * database part runs on, and `signOutFinishSettled` waits for it.
 */
export function finishInterruptedSignOut(): boolean {
  if (isDemoMode()) return false;
  const mark = signOutMarkLeft();
  if (mark === null) {
    if (hasShareInboxClearPending()) {
      trackSignOutFinish(
        flushPendingShareInbox().then(() => {}).catch(() => {}),
      );
    }
    return false;
  }
  markPhoneShareInboxPending();
  const isWipe = mark.startsWith('wipe.');
  const localOnlySync = !isWipe && isUnsyncedLocalVault();
  logAuthEvent('auth:boot-finish-signout');
  removeAccountKeys(!isWipe && !localOnlySync);
  if (isWipe) {
    clearAllStorageKeys(credentialKey('privacynotes.signOutBegun'));
    announceSignOut();
    trackSignOutFinish(
      (async () => {
        const shareInboxCleared = await forgetDeviceLeftovers();
        if (!holdsSignOutMark(mark)) return;
        await deleteEntireLocalDatabase({ keepAutoOpen: true });
        // Only once the leftovers and database are gone: a start that ends
        // mid-wipe keeps the mark and finishes again on the next launch.
        if (!holdsSignOutMark(mark)) return;
        clearSupabaseAuthKeys();
        if (!shareInboxCleared) markPhoneShareInboxPending();
        endSignOutMark(mark);
      })().catch((err: unknown) => {
        logAuthEvent('auth:boot-finish-signout-failed', { name: (err as Error | null)?.name });
      }),
    );
    return true;
  }
  trackSignOutFinish(
    (async () => {
      const syncPaused = isSyncPaused() || readFlag('privacynotes.syncPaused');
      const localOnlyMirror =
        !localOnlySync &&
        ((await db.kv.get(LOCAL_ONLY_OWNER_KEY)) !== undefined ||
          (syncPaused && (await db.kv.get(NEVER_SYNCED_OWNER_KEY)) !== undefined));
      if (!holdsSignOutMark(mark)) return;
      const fullLocalOnlyWipe = localOnlySync || localOnlyMirror;
      if (localOnlyMirror) {
        clearMassDeleteState();
        clearFlushStashKeys();
        clearLocalSettings(false);
      }
      const [, shareInboxCleared] = await Promise.all([
        clearLocalDatabase({ keepUnsyncedNotes: !fullLocalOnlyWipe }),
        clearPhoneShareInbox(),
      ]);
      if (!shareInboxCleared) markPhoneShareInboxPending();
      // Only now: a start that ends during the wipe finishes it again.
      endSignOutMark(mark);
    })().catch((err: unknown) => {
      logAuthEvent('auth:boot-finish-signout-failed', { name: (err as Error | null)?.name });
    }),
  );
  return true;
}
