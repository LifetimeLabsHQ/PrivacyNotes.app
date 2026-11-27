import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useAuth } from './auth';
import { NO_TEXT_ASSIST } from './formFields';
import { deleteAccountServer } from './devices';
import { deleteEntireLocalDatabase } from './notesRepo';
import { describeOnlyHere, useOnlyOnThisDevice } from './neverBackedUp';
import { setDeletingAccount } from './sync';
import { Trash } from './icons';
import { SectionEyebrow } from './settingsUI';
import { Button, Callout, Checkbox, TextField } from './ui';
import { isDemoMode } from './demo';
import { HelpChip } from './HelpChip';
import { ensureLevel2, MfaCancelledError, mfaSessionIdentity } from './mfaStep';
import { jwtPayloadPubkey, PHRASE_STORAGE_KEY } from './authStorage';
import { announceSignOut, beginSignOutMark, endLiveSignIn } from './liveSignIn';
import { trustAwareStorage } from './trustStorage';
import { removeBiometricCredential, removePinWrappedPhrase } from './biometric';
import { clearLocalOnlyFlagsSync, isLocalOnly } from './localOnly';
import { clearLocalDataKey } from './localKey';
import { forgetFolder } from './markdownFolder/folderMemory';
import { clearDestination } from './autoBackup/destination';
import { clearPluginFolders } from './plugins/pluginStore';
import { clearShareInbox } from './useShareInbox';
import { clearAllStorageKeys, forgetDeviceLeftovers, markPhoneShareInboxPending } from './signOutFinish';
import { cancelDeviceReminders, remindersTeardownSettled } from './notesView/useReminders';

/** How long the reload after a wipe waits for the reminders' teardown. */
const RELOAD_WAIT_MS = 10_000;
/** How long the wipe waits for the auth server's sign-out. */
const REMOTE_SIGN_OUT_MS = 4_000;

// ------------------------------------------------------------------
// Danger zone - account & data deletion
// ------------------------------------------------------------------

/**
 * The local half of a deletion: everything this account left on this
 * device, keys first, then the database and every app key in storage. The
 * caller reloads afterwards. Used by the Danger zone and by the dead man's
 * switch dialog (DmsReturnModal), so both wipes stay one wipe.
 */
export async function wipeThisDevice(
  authed: { encryptionKey: Uint8Array; signingPrivateKey: Uint8Array },
  supabase: ReturnType<typeof useAuth>['supabase'],
): Promise<void> {
  const localOnlyVault = isLocalOnly();
  // A sync pass already in flight must not write the phrase back
  // between this wipe and the reload, here or in another tab of this
  // browser (liveSignIn.ts).
  endLiveSignIn();
  announceSignOut();
  // The mark that this wipe began: a page that ends before the sweep below
  // leaves it, and the next start finishes the job (signOutFinish.ts). The
  // sweep takes the mark with every other app key.
  beginSignOutMark('wipe');
  markPhoneShareInboxPending();
  // The phrase and the wrapped doors go before the first await, as a
  // sign-out's do: a wipe that does not end must not leave the phrase at
  // rest for the next start to sign in with (beta.privacynotes.app #211).
  trustAwareStorage.removeItem(PHRASE_STORAGE_KEY);
  removeBiometricCredential();
  removePinWrappedPhrase();
  clearLocalOnlyFlagsSync();
  // A phone's scheduled reminders, while the map that names them
  // exists: the sweep below removes it, and the OS would ring them with
  // this account's titles after it is gone.
  await cancelDeviceReminders();
  // Zero key material.
  authed.encryptionKey.fill(0);
  authed.signingPrivateKey.fill(0);
  clearLocalDataKey();
  // Kill the Supabase session before wiping storage, locally only:
  // after an account deletion the server user is gone, and a device
  // wipe keeps the account. Without this the sb-* session key survives
  // and hydrateFromOAuthSession treats a re-signup as a returning user.
  // With a deadline: a request that never answers must not hold the wipe
  // below, which removes the session whatever the library did.
  //
  // Not in demo or local-only mode: neither holds a Supabase session.
  if (!isDemoMode()) {
    if (!localOnlyVault) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        supabase.auth.signOut({ scope: 'local' }).catch(() => {}),
        new Promise<void>((resolve) => { deadline = setTimeout(resolve, REMOTE_SIGN_OUT_MS); }),
      ]);
      clearTimeout(deadline);
    }
  }
  // What outlives the database: the Markdown folder the restore would
  // reopen for whoever signs in next, the backup destination, the model
  // and plugin files in Cache Storage (beta.privacynotes.app #214 items 2
  // and 3). Each one fails alone; none stops the wipe.
  const shareInboxCleared = await forgetDeviceLeftovers({
    forgetFolder,
    clearDestination,
    clearPluginFolders,
    clearShareInbox,
  });
  // Nuke IndexedDB (notes, images, attachments, dedup tables).
  await deleteEntireLocalDatabase();
  // Wipe all localStorage/sessionStorage privacynotes.* + sb-* keys.
  clearAllStorageKeys();
  // If iOS file protection held ShareInbox while locked, keep the pending
  // inbox-clear flag so the next unlocked boot or vault open clears it.
  if (!shareInboxCleared) markPhoneShareInboxPending();
  // The sweep took the sign-out notice too, and a stamp taken before
  // any notice existed would read as current again without one.
  announceSignOut();
  // The reload below drops the page, and with it the reminders'
  // second cancel if the OS was slow to answer; it goes first.
  await remindersTeardownSettled(RELOAD_WAIT_MS);
}

export function DangerZone({ onDeleteStarted }: { onDeleteStarted: () => void }) {
  const { t } = useTranslation('settings');
  const { auth, supabase } = useAuth();
  const authed = auth.status === 'authenticated' ? auth : null;
  const isLocalOnlyVault = authed?.localOnly === true;
  const noServerAccount = isDemoMode() || isLocalOnlyVault;
  const [expanded, setExpanded] = useState(false);
  const [deleteLocal, setDeleteLocal] = useState(true);
  // Demo and local-only vaults have no server-side account to delete, so the
  // option is neither offered nor pre-selected - local wipe is the only action.
  const [deleteServer, setDeleteServer] = useState(!noServerAccount);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = unchecked, true/false = result of has_active_storage_sub RPC.
  // We block server-side deletion until the user cancels their storage
  // sub in Paddle (surface-and-defer per gap #8).
  const [hasActiveSub, setHasActiveSub] = useState<boolean | null>(null);

  const authRef = useRef(authed);
  authRef.current = authed;

  useEffect(() => {
    if (noServerAccount) setDeleteServer(false);
  }, [noServerAccount]);

  // Preflight when the danger zone expands. Cheap RPC, returns boolean.
  useEffect(() => {
    if (!expanded || !authed) return;
    // Demo and local-only mode make zero server calls - there is no account
    // and no storage sub, so answer the preflight locally.
    if (noServerAccount) { setHasActiveSub(false); return; }
    let cancelled = false;
    void (async () => {
      const { data, error: rpcErr } = await supabase.rpc(
        'has_active_storage_sub',
      );
      if (cancelled) return;
      if (rpcErr) {
        // RPC unavailable (migration not applied) → fail open. Server
        // still preflights, so this only affects the warning surface.
        console.warn('[DangerZone] has_active_storage_sub failed', rpcErr);
        setHasActiveSub(false);
        return;
      }
      setHasActiveSub(data === true);
    })();
    return () => { cancelled = true; };
  }, [expanded, authed, supabase, noServerAccount]);

  // What the local wipe destroys outright. Live while the panel is open,
  // and released before the wipe starts.
  const atStake = useOnlyOnThisDevice(expanded && authed !== null && !busy);

  if (!authed) return null;

  // Deleting the server account always implies wiping local state too -
  // without a valid auth.users row the local session is dead anyway.
  const effectiveDeleteLocal = deleteLocal || deleteServer;
  const blockedByStorageSub = deleteServer && hasActiveSub === true;
  // "Delete local data" on its own pushes nothing first, so it names the
  // notes and files that exist only on this device before the DELETE field.
  // An account deletion takes the server copy as well, and says so above.
  const localOnly = deleteLocal && !deleteServer;
  const atStakeLine = describeOnlyHere(t, atStake);
  const canDelete =
    confirmText.toUpperCase() === 'DELETE' &&
    (deleteLocal || deleteServer) &&
    !blockedByStorageSub;

  async function handleDelete() {
    if (!authed || !canDelete) return;
    setBusy(true);
    setError(null);

    try {
      // Server deletion first (while we still have credentials).
      if (deleteServer) {
        // A person may take longer than the network timeout to find a code.
        // Keep this prompt before the timed deletion and bind its result to
        // the same vault/session before touching data. tests/dangerZoneMfa.test.ts.
        const before = (await supabase.auth.getSession()).data.session;
        const identity = mfaSessionIdentity(before);
        if (!identity || !before || jwtPayloadPubkey(before.access_token) !== authed.pubkey) throw new MfaCancelledError();
        await ensureLevel2(supabase, { force: true, allowLocalUse: true });
        // Re-poll storage sub status right before deleting - the user may
        // have cancelled their sub in another tab since the DangerZone
        // expanded. Catches multi-tab races before the 409. See gap #44.
        const { data: subNow } = await supabase.rpc('has_active_storage_sub');
        if (subNow === true) {
          setHasActiveSub(true);
          setBusy(false);
          return;
        }
        const { data: sessData } = await supabase.auth.getSession();
        const session = sessData.session;
        if (!session?.access_token || !session.user?.id) {
          throw new Error(t('settings:errors.noSession'));
        }
        if (authRef.current?.pubkey !== authed.pubkey || mfaSessionIdentity(session) !== identity || jwtPayloadPubkey(session.access_token) !== authed.pubkey) throw new MfaCancelledError();

        // Block any further sync calls before we kick off deletion. An
        // in-flight `sync()` started before this click can still land
        // upserts after the server delete - we can't abort it from out
        // here, but we can prevent NEW syncs; the server settles the old
        // one (see below). See gap #3.
        setDeletingAccount(true);

        const deleteArgs = {
          supabase,
          accessToken: session.access_token,
          authUid: session.user.id,
          account: authed.pubkey,
          signingPrivateKey: authed.signingPrivateKey,
        };
        // Timeout guard: if the edge function hangs, don't leave sync
        // paused indefinitely. 60s is generous for a cold-start + DB ops.
        // See gap #43.
        const DELETE_TIMEOUT_MS = 60_000;
        await Promise.race([
          deleteAccountServer(deleteArgs),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(t('danger.deleteTimeout'))), DELETE_TIMEOUT_MS),
          ),
        ]);

        // No second call: once the Auth user is gone no request of ours gets
        // past the session check. A sync that was already in flight is the
        // server's to settle: every client write takes a lock the deletion's
        // last step takes exclusively, which then deletes what such a write
        // stored, and a later write finds no user and is refused.
        // Spec: packages/supabase/migrations/history/0136_deletion_file_bytes_pin_window.sql
      }

      // Local wipe - always runs when server is deleted (the session
      // is gone), and optionally runs on its own ("wipe this device").
      if (effectiveDeleteLocal) {
        if (authRef.current?.pubkey !== authed.pubkey) throw new MfaCancelledError();
        await wipeThisDevice(authed, supabase);
      }

      onDeleteStarted();

      // Hard reload to onboarding. Both phrase and OAuth users land on
      // the clean signup page and can create a fresh account.
      window.location.replace('/');
    } catch (err) {
      // Roll back the deletion flag - the user is still authenticated
      // and may want to keep using the app, so let sync resume.
      setDeletingAccount(false);
      const msg = (err as Error).message;
      // Server-side fallback when the preflight didn't catch an
      // active storage sub (stale client, RPC unavailable, etc.).
      if (msg.includes('active_storage_sub')) {
        setHasActiveSub(true);
        setError(t('danger.activeSubError'));
      } else {
        setError(msg);
      }
      setBusy(false);
    }
  }

  if (!expanded) {
    return (
      <div>
        <Button
          variant="danger"
          icon={<Trash aria-hidden="true" />}
          onClick={() => setExpanded(true)}
          className="w-full"
        >
          {t('danger.deleteCta')}
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-danger/40 bg-danger/5 p-4 space-y-3">
      <SectionEyebrow danger setting="plan.dangerZone">
        {t('danger.heading')}
      </SectionEyebrow>

      <p className="text-small text-pn-soft leading-relaxed">
        {t('danger.warning')}
      </p>

      <HelpChip surface="deleteAccount" />

      {blockedByStorageSub && (
        <Callout tone="warning">
          {t('danger.blockedByStorage')}
        </Callout>
      )}

      <Checkbox
        checked={effectiveDeleteLocal}
        onChange={(e) => setDeleteLocal(e.target.checked)}
        disabled={busy || deleteServer}
        label={t('danger.localLabel')}
        description={
          <>
            {t(isLocalOnlyVault ? 'danger.localDescLocalOnly' : 'danger.localDesc')}
            {deleteServer && !deleteLocal && ` ${t('danger.localRequired')}`}
          </>
        }
      />

      {!noServerAccount && (
        <Checkbox
          checked={deleteServer}
          onChange={(e) => setDeleteServer(e.target.checked)}
          disabled={busy}
          label={t('danger.cloudLabel')}
          description={t('danger.cloudDesc')}
        />
      )}

      {localOnly && atStakeLine && (
        <Callout tone="warning">
          {atStakeLine}
        </Callout>
      )}

      <TextField
        label={
          <Trans
            i18nKey="settings:danger.confirmPrompt"
            components={{ kbd: <span className="font-mono font-semibold text-danger" /> }}
          />
        }
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        disabled={busy}
        placeholder="DELETE"
        autoComplete="off"
        {...NO_TEXT_ASSIST}
      />

      {error && (
        <Callout tone="danger">
          {error}
        </Callout>
      )}

      <div className="flex gap-2">
        <Button
          action="cancel"
          onClick={() => {
            setExpanded(false);
            setConfirmText('');
            setError(null);
          }}
          disabled={busy}
          className="flex-1"
        />
        <Button
          action="delete"
          variant="danger"
          onClick={() => void handleDelete()}
          disabled={!canDelete || busy}
          className="flex-1"
        >
          {busy ? t('danger.deleting') : t('danger.deletePermanently')}
        </Button>
      </div>
    </div>
  );
}
