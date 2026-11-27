import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './auth';
import { dropPhraseFragment } from './qrSignIn';
import { QrLinkNotice } from './QrLinkNotice';
import { LoadingScreen } from './LoadingScreen';
import { LockScreen } from './LockScreen';
import { OAuthRetryScreen } from './OAuthRetryScreen';
import { VersionUpdateToast } from './VersionUpdateToast';
import { DesktopUpdater, releaseDownloadedUpdate } from './DesktopUpdater';
import { AndroidUpdateToast } from './AndroidUpdateToast';
import { StoreUpdateToast } from './StoreUpdateToast';
import {
  hasBiometricCredential,
  hasPinWrappedPhrase,
  hasStoredPhrase,
  onWrappedBlobChange,
  sealLocalPinWrap,
  type PinWrapBlob,
  type ReplacedPinWrap,
} from './biometric';
import { shouldPromptForAppLock, markAppUnlocked, clearPinUnlock, hasPin, holdPinWrapUpgrade } from './pin';
import { clearPin, phraseMatches } from './pinRecovery';
import { phraseOwnsThisDevice } from './authStorage';
import { phraseSignsFor } from './identity';
import { clearManualLock, lockCurtainIsStale, lockReloadKeptReminders, manualLockArmed, startReLockWatch } from './appReLock';
import { lockReloadHeld, lockReloadsPage, reloadForLock } from './lockReload';
import { exitWritesRun, flushEditorsForExit, tabEditWaits } from './flushStash';
import { syncPassRunning } from './sync';
import { startAppIcon } from './appIcon';
import { startTrayMode } from './trayMode';
import { ninjaKeySupported, startNinjaShortcut } from './ninjaShortcut';
import { startNinjaHost } from './ninjaHost';
import { finishLoginStart } from './openAtLogin';
import { applyPrivacyScreen } from './privacyScreen';
import { removedWhileLocked, wipeRemovedWhileLocked } from './lockRemovalCheck';
import { loadLocalSettings, saveLocalSettings } from './userSettings';
import { isTrustedDevice } from './trustStorage';
import { isDemoMode } from './demo';
import { hasLocalOnlyVault, hasUnsyncedLocalVault, isLocalOnly, isUnsyncedLocalVault } from './localOnly';
import { reopenDb } from './db';
import { detectPlatform, isOpenLinkModifier } from './devices';
import { isApexHost, usesOfficialServer } from './hosts';
import { isTouchPointer } from './useIsMobile';
import { readLinkModifier } from './theme';
import { isComputerBrowser, peekPendingShortcut } from './noteShortcut';
import { handleNativeAnchorClick } from './openExternal';
import { localeFromPath } from './localeRoutes';
import { setLanguage } from './languages';
import { applyMarketingSeo } from './seo';
import i18n from './i18n';
import { stopAllJobs } from './plugins/jobs';
import { closePluginSheet } from './plugins/pluginDoors';

/** Native (Tauri) apps never show the marketing page; see LandingPage. */
const IS_DESKTOP = detectPlatform() !== 'web';

// Apex retirement (domain-split, executed 2026-08-25): the web apex no
// longer boots the notes app. A signed-in straggler gets the MoveScreen
// (one job: send the person to sign in at use.privacynotes.app) instead of
// NotesView; the only way back into NotesView on the apex is the
// MoveScreen's stuck-state escape hatch, so the retirement metric
// (NotesView-chunk fetches on the apex) counts only sessions that
// genuinely cannot move yet. Demo (?demo=1) keeps its own behavior.
// Spec: docs/internal/domain-split.md (retirement phase)
const APEX_APP_RETIRED =
  isApexHost() && !isDemoMode() && detectPlatform() === 'web';

// True when this page load is an OAuth redirect return: the URL still carries
// a PKCE `?code=` in the query. Every flow is PKCE (auth.tsx), so no token
// arrives in the hash. Captured at module eval, before the callback handler
// strips it. Used to hold the loading screen through callback processing
// instead of flashing the landing page.

const OAUTH_CALLBACK_AT_BOOT =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('code');

// Code-split the two big halves of the app: visitors never parse the
// notes app (TipTap, sync, modals) and returning users never parse the
// marketing page + onboarding flow. Each lazy chunk is fetched on demand
// and served immutable from the browser cache on repeat visits, so the
// extra request is only paid cold. vite:preloadError in main.tsx covers
// the stale-chunk-after-deploy case.
const Onboarding = lazy(() =>
  import('./Onboarding').then((m) => ({ default: m.Onboarding })),
);
const NotesView = lazy(() =>
  import('./NotesView').then((m) => ({ default: m.NotesView })),
);
// Lazy despite being a small component: it pulls PhraseView -> qrcode.react
// and billing.ts -> paddle.ts into whatever chunk holds it, and the free-tier
// device cap is a state almost no session ever reaches. Rendered inside the
// same <Suspense> as the other two.
const DeviceLimitModal = lazy(() =>
  import('./DeviceLimitModal').then((m) => ({ default: m.DeviceLimitModal })),
);
// The account changed its recovery phrase elsewhere (phrase change, 2.4).
const PhraseReplacedScreen = lazy(() =>
  import('./PhraseReplacedScreen').then((m) => ({ default: m.PhraseReplacedScreen })),
);
const MoveScreen = lazy(() =>
  import('./MoveScreen').then((m) => ({ default: m.MoveScreen })),
);

// Start downloading the chunk this user will need immediately at
// module-eval time, so on a cold cache the fetch overlaps key derivation
// and auth instead of waiting for the first render. The module cache
// dedups this against the lazy() load above. On the retired apex a
// session leads to the MoveScreen, never NotesView - preloading the
// NotesView chunk there would also poison the retirement metric.
if (hasStoredPhrase()) {
  if (APEX_APP_RETIRED) {
    void import('./MoveScreen');
  } else {
    void import('./NotesView');
  }
} else {
  void import('./Onboarding');
}

// Loaded only when a shortcut waits for sign-in in a computer browser.
// Spec: docs/internal/specs/note-shortcuts.md (6.2)
const ShortcutSignInCard = lazy(() => import('./ShortcutOffer').then((m) => ({ default: m.ShortcutSignInCard })));

export default function App() {
  const { auth, supabase, forceSignOut, signInWithPhrase, unlockLocally, finishPhraseChangeWithPin } = useAuth();

  // Explicit per-language marketing URL (/de, /en, ...). Locale slugs are the
  // public marketing site and stay browsable at that URL for everyone -
  // signed-out visitors, crawlers, and signed-in users who open one (e.g. via
  // an in-app "Website" link). Held in state so entering the app can strip the
  // slug without a full reload (which would drop an in-memory, untrusted-device
  // session).
  const [marketingSlug, setMarketingSlug] = useState<string | null>(() =>
    localeFromPath()
  );

  // A fresh sign-in (or vault creation) on a locale-slug page lands in the app
  // at the clean apex URL, carrying the slug's language forward so it survives
  // the dropped slug. Guarded to a genuine sign-in here (no stored session at
  // mount): a returning session that just opens /en stays on the browsable
  // marketing page - that visitor is moved on by the landing CTAs instead (the
  // handler passed to Onboarding below).
  const hadSessionAtMount = useRef(hasStoredPhrase());
  useEffect(() => {
    if (
      marketingSlug &&
      !hadSessionAtMount.current &&
      (auth.status === 'authenticated' ||
        auth.status === 'device_limit_reached')
    ) {
      setLanguage(marketingSlug);
      window.history.replaceState(null, '', '/');
      setMarketingSlug(null);
    }
  }, [marketingSlug, auth.status]);

  // Marketing pages own their localized SEO (title, description, canonical,
  // hreflang, html lang); the authenticated app just uses the short brand title.
  useEffect(() => {
    const marketing =
      marketingSlug !== null ||
      (auth.status !== 'authenticated' && auth.status !== 'device_limit_reached');
    if (!marketing) {
      document.title = 'PrivacyNotes';
      return;
    }
    applyMarketingSeo();
    const onChange = () => applyMarketingSeo();
    i18n.on('languageChanged', onChange);
    return () => {
      i18n.off('languageChanged', onChange);
    };
  }, [auth.status, marketingSlug]);

  // External links are dead in the native (Tauri) webview: an
  // <a target="_blank"> click is silently swallowed by WKWebView (no new
  // window, no navigation), and a same-tab href would replace the app
  // itself. So on native builds we intercept clicks on external links in the
  // capture phase and route them through openExternal. Web is untouched - the
  // listener is never installed.
  // Spec: docs/internal/macos-ios-setup.md (native flows use the same opener plugin)
  useEffect(() => {
    if (!IS_DESKTOP) return;
    const onClick = (e: MouseEvent) => {
      handleNativeAnchorClick(e, {
        isTouch: isTouchPointer(),
        linkModifier: readLinkModifier(),
        isModifier: isOpenLinkModifier(e),
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // Show the loading screen only when there's a stored phrase (a session
  // to restore). The trust flag survives sign-out, so gating on
  // isTrustedDevice() would show a loading screen to signed-out users on
  // a previously-trusted device while Supabase initializes. A stored
  // phrase is the honest signal: no phrase = nothing to restore = skip
  // straight to onboarding/landing page.
  //
  // No artificial minimum display time: the local-first fast boot in
  // auth.tsx flips to 'authenticated' as soon as keys are derived and
  // local notes are confirmed, so the goal is to get OFF this screen as
  // fast as possible. The typewriter screen still covers the slow path
  // (first sync on a fresh device).
  const hasSession = hasStoredPhrase();
  // Native apps hold the loading screen through the whole auth-resolve
  // window (even with no stored phrase) so an incoming OAuth session
  // restore doesn't flash the onboarding auth card first. Web keeps the
  // old behaviour: show onboarding immediately when there's nothing to
  // restore.
  //
  // Exception on web: an OAuth redirect return (`?code=` in the query)
  // also holds the loading screen. Without it, the landing page renders
  // for the several seconds hydrateFromOAuthSession spends on its edge
  // function round-trips - which reads as a silently failed sign-in, and
  // invites the user into a manual phrase entry that races the pending
  // hydration (its branch-b signOut then tears down the in-flight
  // handshake - the "Session is missing the account link" error). If the
  // code exchange fails, `exchangeAndHydrate` in authOAuth.ts moves the
  // state past 'loading' (the failed sign-in screen, or the sign-in
  // options for a cancelled step) and dismisses this screen.
  const showLoading =
    auth.status === 'loading' &&
    (hasSession || IS_DESKTOP || OAUTH_CALLBACK_AT_BOOT);

  // ── Lock screen state ─────────────────────────────────────────
  // The lock screen gates the entire app when a wrapped phrase blob
  // exists (biometric or PIN) and either appLockEnabled is true or no
  // phrase is at rest. The phrase is only in memory after a successful
  // unlock - and stays there while the lock is armed: the post-unlock
  // sign-in deliberately skips the storage persist then (see
  // signInWithPhrase), so the unlock can never quietly write the
  // phrase back to disk.
  const [locked, setLocked] = useState<boolean>(() => {
    const hasWrapped = hasBiometricCredential() || hasPinWrappedPhrase();
    // Locked with the Lock app button and not unlocked since: a reload keeps
    // the lock, also with the app lock off, as long as a door is left (a PIN
    // alone is checked against its hash once the session is up).
    if (manualLockArmed() && (hasWrapped || hasPin())) return true;
    if (!hasWrapped) return false;
    // Wrapped-only state: enabling app lock strips the stored
    // phrase, so after a reload the ONLY path back into the session
    // runs through an unlock - the phrase exists nowhere else. That
    // holds whatever the flag says. A version before #662 synced the
    // flag, and switching the lock off on another device wrote the
    // phrase back there, not here; unlocked, this device would boot to the sign-in screen with
    // a wrap on disk that nothing opens. Locked, the unlock's sign-in
    // finds the lock no longer armed and writes the phrase back, so the
    // next start is a normal one. The re-lock window must not excuse
    // the prompt either: with locked=false and no stored phrase, boot
    // found nothing to restore and landed a fully healthy account on
    // the signed-out landing page with no way back in (session audit
    // 2026-08-25). The flag and the window apply while a stored phrase
    // exists, where skipping the prompt is recoverable.
    // Pinned by tests/sync/scenarios-app-lock-remote-off.test.ts.
    if (!hasStoredPhrase()) return true;
    const settings = loadLocalSettings();
    if (!settings.appLockEnabled) return false;
    return shouldPromptForAppLock(settings.appLockTimeoutMinutes);
  });

  // Arm the native cover the operating system photographs in place of the
  // notes. Settings writes carry it from then on (writeLocal in
  // userSettings.ts); a cold start writes nothing, so it starts here.
  // Spec: docs/internal/specs/app-switcher-privacy-screen.md
  useEffect(() => {
    applyPrivacyScreen(loadLocalSettings().appLockEnabled);
  }, []);

  // In the apps a PIN wrap written before the device-key seal moves under it
  // once (pinWrapSeal.ts); every later write seals on its own.
  // Spec: docs/internal/plans/pin-wrap-hardening.md (section 5.4, C2-1)
  useEffect(() => {
    void sealLocalPinWrap();
  }, []);

  // Keep running in the tray: push the stored switch to the desktop shell.
  // Ninja from any app: push the key, and answer the box (#694). A start at
  // sign-in shows as Start minimized says (Settings > System).
  useEffect(() => {
    startAppIcon();
    startTrayMode();
    if (ninjaKeySupported()) {
      startNinjaShortcut();
      startNinjaHost();
      finishLoginStart();
    }
  }, []);

  // Re-lock after the idle window the user picked. Armed only while the app is
  // open and signed in: locking a lock screen is a no-op, and locking a
  // half-booted session would fight the boot check above. The watch itself
  // decides whether this device has a door back in.
  // Spec: docs/contrib/biometric-unlock.md (section 3.3 re-lock)
  //
  // With the app lock armed and no phrase at rest, the lock reloads the page
  // (lockReload.ts, lockReloadsPage): the open editors write their last typing
  // first, while they are still mounted (their unmount flush writes no flush
  // stash), and a plain screen covers the wait for the save and the sync pass.
  // A job that holds the reload (an import) keeps the lock screen up until it
  // ends. Leaving the lock meanwhile cancels the reload (lockReloadSeq,
  // lockedNow).
  // Spec: docs/internal/plans/phrase-lock-hardening.md (section 3.2)
  const [lockReloading, setLockReloading] = useState(false);
  const lockReloadSeq = useRef(0);
  // Read during the wait: the unlock's render clears it before the effect
  // below bumps the sequence, so a hold that ends in between reloads nothing.
  const lockedNow = useRef(locked);
  lockedNow.current = locked;
  useEffect(() => {
    if (locked || auth.status !== 'authenticated') return;
    return startReLockWatch(() => {
      if (!lockReloadsPage()) {
        setLocked(true);
        return;
      }
      flushEditorsForExit();
      const seq = ++lockReloadSeq.current;
      if (!lockReloadHeld()) setLockReloading(true);
      lockedNow.current = true;
      setLocked(true);
      const cancelled = () => lockReloadSeq.current !== seq || !lockedNow.current;
      void reloadForLock({
        saveWaits: () => tabEditWaits() || exitWritesRun(),
        syncRuns: syncPassRunning,
        cancelled,
        onQuiet: () => setLockReloading(true),
        keep: async () => {
          await releaseDownloadedUpdate();
          await import('./notesView/useReminders').then((m) => m.keepLockedPlan());
        },
        reload: () => window.location.reload(),
      }).then((reloaded) => {
        // Offline by now, or out of the lock: the lock screen, as a curtain.
        if (!reloaded && !cancelled()) setLockReloading(false);
      });
    });
  }, [locked, auth.status]);
  // Out of the lock (an unlock, a curtain gone stale): a reload the lock had
  // planned is no longer due.
  useEffect(() => {
    if (locked) return;
    lockReloadSeq.current++;
    setLockReloading(false);
  }, [locked]);

  // A plugin's work and its results end when the app locks, and the request
  // of an open sheet goes with them, so no sheet opens again after the unlock.
  // Spec: docs/internal/plans/plugins.md (section 3.1)
  useEffect(() => {
    if (locked) {
      stopAllJobs();
      closePluginSheet();
    }
  }, [locked]);

  // The lock screen replaces the notes view and its reminder timer: ring the
  // view's last plan from here while the lock is up (GitHub #667). A dynamic
  // import keeps it off the boot path; a plan exists only after the notes
  // view ran, and that view loaded the module already.
  // After a lock's reload the page holds no session and no notes view; the
  // plan that reload kept for this tab rings instead (lockReloadKeptReminders).
  useEffect(() => {
    if (!locked || (auth.status !== 'authenticated' && !lockReloadKeptReminders())) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void import('./notesView/useReminders').then((m) => { if (!gone) stop = m.ringWhileLocked(); });
    return () => { gone = true; stop?.(); };
  }, [locked, auth.status]);

  // A locked app shuts the PIN gate behind it, so the person who unlocks the
  // app next meets the gate again at the first protected note.
  // Any way out of the lock ends a lock the button armed, and only a tab that
  // was locked has a way out. The mark is one key for the whole browser: a tab
  // that starts unlocked (on a device that is not trusted, a new tab holds no
  // session and no PIN, so it shows the sign-in screen) must leave it for the
  // tab that is locked, or a reload of that tab opens with no PIN.
  // Test: tests/lockAppSecondTab.test.ts
  const lockedBefore = useRef(locked);
  useEffect(() => {
    const leftTheLock = lockedBefore.current && !locked;
    lockedBefore.current = locked;
    if (locked) clearPinUnlock();
    else if (leftTheLock) clearManualLock();
  }, [locked]);

  // A sign-out in another tab signs this one out and removes the wrapped
  // doors. The curtain then has nothing behind it to guard, and its doors no
  // longer open, so it drops to the signed-out screen. That tab announces
  // before it removes the doors, so this asks on the status change and
  // again on the wrap change below.
  const authStatusRef = useRef(auth.status);
  authStatusRef.current = auth.status;
  useEffect(() => {
    if (locked && lockCurtainIsStale(auth.status)) setLocked(false);
  }, [locked, auth.status]);

  // A device its owner removed wipes while it is locked, when it is online:
  // the notes view and its heartbeat do not run behind the lock, so the lock
  // screen asks once when it comes up and again when the device comes online
  // or back to the screen (beta.privacynotes.app #214 item 10). The check
  // reads and writes nothing, so it is no activity for the dead man's switch.
  useEffect(() => {
    if (!locked) return;
    let gone = false;
    let wiping = false;
    const check = async () => {
      if (wiping || !(await removedWhileLocked(supabase)) || gone || wiping) return;
      wiping = true;
      const live = authStatusRef.current === 'authenticated';
      await wipeRemovedWhileLocked(live ? () => forceSignOut('device revoked') : null);
      // The doors are gone with the wipe; a start from nothing shows the
      // signed-out screen.
      if (!live) window.location.reload();
    };
    void check();
    const again = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      gone = true;
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  // Listen for cross-tab changes to wrapped blobs (e.g. biometric
  // disabled in another tab).
  useEffect(() => {
    return onWrappedBlobChange(() => {
      if (lockCurtainIsStale(authStatusRef.current)) {
        setLocked(false);
        return;
      }
      // A sign-out in another tab removes these same wrapped blobs AND
      // clears the settings blob, so both unlock branches below would
      // otherwise fire on a signal that has nothing to do with this user
      // turning app lock off - dropping a locked, unattended tab straight
      // into the notes. A stored phrase means this browser is still
      // signed in, which is the only state where a blob change is a real
      // app-lock config change.
      if (!hasStoredPhrase()) return;
      // A lock the Lock app button armed is not the app lock setting: a
      // change to the wraps does not lift it. Only an unlock does.
      if (manualLockArmed()) return;
      const settings = loadLocalSettings();
      if (!settings.appLockEnabled) {
        setLocked(false);
        return;
      }
      const hasWrapped = hasBiometricCredential() || hasPinWrappedPhrase();
      if (!hasWrapped) setLocked(false);
    });
  }, []);

  // The post-unlock sign-in state, rendered by LockScreen. The lock holds
  // until the sign-in resolves, with a status line and a retry: dropping
  // it on a fire-and-forget signInWithPhrase lets a transient failure
  // (offline, rate limit, slow link) silently land a user who had just
  // proven their PIN on the signed-out landing page (session audit
  // 2026-08-25). The unwrapped phrase is held in a ref for the retry
  // only; it is cleared the moment the sign-in succeeds.
  const [unlockSignIn, setUnlockSignIn] = useState<'idle' | 'busy' | 'error'>('idle');
  const unlockPhraseRef = useRef<string | null>(null);
  // Held beside the phrase so the retry button keeps the intent.
  const unlockRecoverRef = useRef(false);

  /**
   * Take the PIN off, from the lock screen's "Forgot your PIN?" door.
   *
   * Runs only after the unlock proves the phrase, so a phrase that passes
   * its checksum but belongs elsewhere cannot cost this device the PIN it
   * still remembers. NotesView is unmounted while the lock is up and reads
   * this cache in its own initializer, so writing it here is what carries
   * the removal to the other devices on the next sync.
   *
   * clearPin answers null, having removed nothing, when the PIN wrap is the
   * last door and the phrase did not read back at rest. The PIN then stays
   * and the unlock goes ahead: the phrase has already proved itself, and
   * the next lock screen offers the same door.
   * Spec: docs/internal/specs/pin-recovery.md
   */
  async function applyPinRecovery(phrase: string) {
    const cleared = await clearPin(loadLocalSettings(), phrase);
    if (cleared) saveLocalSettings(cleared.settings);
    unlockRecoverRef.current = false;
  }

  /**
   * Carry a re-wrapped legacy PIN blob to the account, the same way as the
   * recovery above: the lock screen holds no settings, NotesView is
   * unmounted while the lock is up, and this cache is what the next pass
   * pushes. Every device replaces a wrap that differs from the account's,
   * so an upgrade the account never learned of would be undone on the next
   * pass and redone on the next unlock.
   */
  function applyPinWrapUpgrade(blob: PinWrapBlob, replaced: ReplacedPinWrap) {
    // Held, not written: the first settings pass after the unlock that reads
    // the account's row saves it, and only over the wrap that opened
    // (saveHeldPinRehash in pinRecovery.ts). Written here, before any pull,
    // it went out as a change made on this device, and a cache with no merge
    // base pushed it over a newer secret.
    // Spec: docs/internal/plans/pin-wrap-hardening.md (section 3)
    holdPinWrapUpgrade({ blob, replaced });
  }

  async function runUnlockSignIn(phrase: string) {
    setUnlockSignIn('busy');
    // No Turnstile widget here, so no captchaToken: if the link-pubkey
    // gate demands one on this rare path (session lost while the
    // phrase sat wrapped, web origin only), fall through to
    // onboarding, which has the widget. Deliberate - not worth a
    // challenge on every lock-screen unlock.
    // An unlock is no sign-in made by hand: a device the owner removed is
    // signed out, not brought back (register-device `reactivate`).
    const result = await signInWithPhrase(phrase, isTrustedDevice(), false, undefined, false);
    if (result.ok) {
      if (unlockRecoverRef.current) await applyPinRecovery(phrase);
      unlockPhraseRef.current = null;
      setUnlockSignIn('idle');
      setLocked(false);
      return;
    }
    // The account replaced the phrase this lock opened: the person passed
    // the lock, and the screen that asks for the new phrase takes over.
    if (result.phraseReplaced) {
      unlockPhraseRef.current = null;
      setUnlockSignIn('idle');
      setLocked(false);
      return;
    }
    if (result.captchaRequired) {
      unlockPhraseRef.current = null;
      setUnlockSignIn('idle');
      setLocked(false);
      return;
    }
    setUnlockSignIn('error');
  }

  /**
   * Every door on the lock screen lands here. The fingerprint and the PIN
   * unwrap a blob this device holds, so their phrase is this account's by
   * construction. The third door is typed, and a BIP-39 checksum says only
   * that the words are well formed, never whose they are.
   *
   * Answers false when the phrase does not belong to the session behind the
   * lock, so the screen can say so rather than appear to hang.
   */
  async function handleLockScreenUnlock(phrase: string, recover = false): Promise<boolean> {
    // The lock screen is not a sign-in screen. It is up because this device
    // armed an app lock, so the phrase typed into it has to be the phrase of
    // the account behind that lock, and the refusal comes before anything
    // here has a side effect, markAppUnlocked included.
    //
    // Two questions, because the two branches below know the account in two
    // different ways. A re-lock leaves the session, the phrase and the seal
    // key live behind the curtain, so there the phrase itself is the
    // comparison. A cold start has no session, so the owner marker is - and
    // that half is load-bearing: `tryFastBoot` refuses a foreign phrase but
    // the branch below then falls through to a full sign-in, which signs the
    // holder into their own account and takes the local vault with it on the
    // owner-mismatch wipe. Signing in as somebody else stays available from
    // the signed-out screen, where it is the deliberate act it looks like.
    // Over the screen of a replaced phrase, the new phrase belongs here too,
    // and only the server can say so: this device has no record of it yet.
    // A cold start asks the server too, once the offline test says no: an
    // adopted device whose record went missing still takes its current phrase.
    const localOnly = (await hasLocalOnlyVault()) || (await hasUnsyncedLocalVault());
    const onlineCheck = !localOnly;
    const belongsHere =
      auth.status === 'authenticated'
        ? phraseMatches(phrase, auth.phrase)
        : auth.status === 'phrase_replaced' && auth.pubkey !== null
          ? await phraseSignsFor(phrase, auth.pubkey, onlineCheck)
          : await phraseOwnsThisDevice(phrase, onlineCheck);
    if (!belongsHere) return false;
    markAppUnlocked();
    unlockRecoverRef.current = recover;
    // The curtain was up over the screen of a replaced phrase: lift it, and
    // that screen asks for the new phrase. Opening the vault with the
    // replaced one would only meet the change again.
    if (auth.status === 'phrase_replaced') {
      setLocked(false);
      return true;
    }
    if (auth.status === 'authenticated') {
      if (recover) await applyPinRecovery(phrase);
      setLocked(false);
      return true;
    }
    // Local-first, for the same reason the boot path is. Enabling app
    // lock strips the stored phrase, so a cold start has no session and
    // this unlock is the sign-in - which made a reachable server the
    // price of opening notes that are already on this disk, under the
    // very phrase the PIN or biometric just unwrapped. Render them, then
    // establish the session behind the app. A device whose access was
    // revoked is still caught by the heartbeat on the first sync; it
    // sees its own local data a moment sooner, which is the trade
    // `tryFastBoot` already makes on every normal boot.
    if (await unlockLocally(phrase)) {
      // Before the sign-in, not after: it reads app lock's armed state to
      // decide whether to write the phrase back at rest, and after a
      // recovery the lock is off and that write is the right one.
      if (recover) await applyPinRecovery(phrase);
      unlockPhraseRef.current = null;
      setUnlockSignIn('idle');
      setLocked(false);
      // Not awaited and not surfaced: the user is in, and sync owns its
      // own error reporting from here. signInWithPhrase skips the phrase
      // persist while the lock is armed, so this cannot write the phrase
      // back to disk and undo the lock. Local-only vaults stay offline.
      if (!localOnly && !isLocalOnly() && !isUnsyncedLocalVault()) {
        void signInWithPhrase(phrase, isTrustedDevice(), false, undefined, false);
      }
      return true;
    }
    if (localOnly || isLocalOnly() || isUnsyncedLocalVault()) {
      // Never fall through to network sign-in for a local-only vault: a
      // transient IndexedDB hiccup must not silently register/graduate the
      // vault or strand an offline user on a network error screen. Retry
      // once after reopening Dexie.
      try { await reopenDb(); } catch { /* ignore */ }
      if (await unlockLocally(phrase)) {
        if (recover) await applyPinRecovery(phrase);
        unlockPhraseRef.current = null;
        setUnlockSignIn('idle');
        setLocked(false);
        return true;
      }
      return false;
    }
    // Nothing local to render (a wiped or brand-new device), so the
    // network sign-in is the only door, exactly as before.
    unlockPhraseRef.current = phrase;
    void runUnlockSignIn(phrase);
    return true;
  }

  // Consume any `#phrase=…` fragment once on mount: it no longer signs in.
  // dropPhraseFragment clears it from the address bar and answers true when
  // it held a valid phrase (an old sign-in QR read by a camera app); the
  // sign-in screen then says what the browser history kept. Elsewhere (signed
  // in, locked) it is dropped silently.
  // Spec: docs/internal/plans/qr-signin-content.md (3.3)
  const [qrLinkOpened, setQrLinkOpened] = useState(() => dropPhraseFragment());
  // A signed-in or locked device drops it silently: the notice must not
  // wait for a later sign-out in this tab.
  useEffect(() => {
    if (qrLinkOpened && auth.status === 'authenticated') setQrLinkOpened(false);
  }, [qrLinkOpened, auth.status]);

  // A shortcut that waits for sign-in offers the desktop app first, in a
  // computer browser. Spec: docs/internal/specs/note-shortcuts.md (6.2)
  // Read on every render, so a target the notes view already opened never
  // shows on a later sign-in screen.
  const [shortcutCardOpen, setShortcutCardOpen] = useState(isComputerBrowser);
  const shortcutCard = shortcutCardOpen ? peekPendingShortcut() : null;

  // Retired apex only: the MoveScreen's stuck-state escape hatch. One
  // legacy boot of NotesView so a sync error or conflict can be fixed
  // where the tools live (ConflictModal, push-error banner, and the
  // MoveBanner to try the move again). Session-scoped on purpose - the
  // next visit lands on the MoveScreen again.
  const [legacyNotesOpen, setLegacyNotesOpen] = useState(false);

  // Lock screen - shown over everything when app lock is active.
  // Must come before the loading check so a locked app stays locked
  // even during auth restoration. Exception: explicit locale slugs
  // (/en, /de, ...) are the public marketing site - they render no
  // notes, so the lock must not gate them (it would fire a biometric
  // prompt on a plain website visit). Entering the app from a slug
  // page clears the slug, and the locked branch then takes over
  // before any notes render.
  let screen: ReactNode;
  if (marketingSlug) {
    // Locale slug: the public marketing site, browsable in every language by
    // everyone - signed-out visitors, crawlers, and signed-in users who open an
    // in-app "Website" link here. A fresh sign-in strips the slug (effect
    // above); an already-signed-in visitor who taps a landing CTA is sent to
    // the app via onAuthedEnterApp.
    screen = (
      <Onboarding
        onAuthedEnterApp={() => {
          window.history.replaceState(null, '', '/');
          setMarketingSlug(null);
        }}
      />
    );
  } else if (locked && lockReloading) {
    // A lock that reloads the page: nothing to read and no door to open while
    // the last save and the sync pass finish.
    screen = <div className="min-h-dvh bg-surface-0" aria-busy="true" />;
  } else if (locked) {
    screen = (
      <LockScreen
        onUnlock={handleLockScreenUnlock}
        // With the session live, the PIN or passcode may lift the screen by its
        // hash, for a device that has a PIN but no wrap (Lock app with the app
        // lock off). The notes are already open behind it; this is the same
        // UI-only gate as the idle re-lock.
        // Over the screen of a replaced phrase too: it opens no notes.
        onPinVerified={auth.status === 'authenticated' || auth.status === 'phrase_replaced' ? () => { markAppUnlocked(); setLocked(false); } : undefined}
        onWrapUpgraded={applyPinWrapUpgrade}
        onPendingPhraseChange={finishPhraseChangeWithPin}
        signInState={unlockSignIn}
        onRetrySignIn={() => {
          if (unlockPhraseRef.current) void runUnlockSignIn(unlockPhraseRef.current);
        }}
      />
    );
  } else if (auth.status === 'oauth_hydrate_failed') {
    // OAuth hydration failed - loud, retryable error instead of the old
    // silent fall-through to custody choice (data-orphaning footgun).
    screen = <OAuthRetryScreen trust={auth.trust} />;
  } else if (showLoading || (isDemoMode() && auth.status === 'loading')) {
    // Demo seeds + key derivation happen async on mount; hold the loading
    // screen until authenticated so the landing page never flashes.
    screen = <LoadingScreen />;
  } else if (auth.status === 'onboarding' || auth.status === 'oauth_custody_choice' || (!hasSession && auth.status === 'loading')) {
    // No stored phrase: treat 'loading' as 'onboarding' - show the
    // landing page immediately while Supabase resolves getSession() in
    // the background. The result will be 'onboarding' anyway; no point
    // showing a loading animation.
    screen = (
      <>
        <Onboarding />
        {shortcutCard && !qrLinkOpened && (
          <Suspense fallback={null}>
            <ShortcutSignInCard target={shortcutCard} onSignIn={() => setShortcutCardOpen(false)} />
          </Suspense>
        )}
        {qrLinkOpened && <QrLinkNotice onClose={() => setQrLinkOpened(false)} />}
      </>
    );
  } else if (auth.status === 'device_limit_reached') {
    // Free-tier device cap hit - block the whole app until the user
    // either revokes a device or signs out. No notes rendered behind it.
    screen = <DeviceLimitModal />;
  } else if (auth.status === 'phrase_replaced') {
    // The account changed its recovery phrase on another device. No notes
    // rendered behind it and nothing wiped: the screen asks for the new phrase.
    screen = <PhraseReplacedScreen />;
  } else if (APEX_APP_RETIRED && !legacyNotesOpen) {
    // Apex retirement: a signed-in apex session gets the move screen,
    // not the notes app. See the constant above for the full story.
    screen = <MoveScreen onOpenNotes={() => setLegacyNotesOpen(true)} />;
  } else {
    screen = <NotesView />;
  }

  // Suspense fallback while a lazy chunk (Onboarding / NotesView) loads.
  // The typewriter LoadingScreen is right for a RETURNING user waiting on
  // the NotesView chunk ("your notes are coming back"), but wrong for a
  // first-time visitor waiting on the Onboarding chunk: it flashed the
  // typewriter on the marketing homepage for the chunk-fetch window
  // (~250 ms on fast links, seconds on slow ones) before the hero
  // painted. Gate it on the same condition as showLoading - a session to
  // restore, native, or an OAuth return - and give the signed-out
  // marketing path a plain surface splash instead.
  const suspenseFallback =
    !marketingSlug && (hasSession || IS_DESKTOP || OAUTH_CALLBACK_AT_BOOT) ? (
      <LoadingScreen />
    ) : (
      <div className="min-h-dvh bg-surface-0" />
    );

  return (
    <>
      <VersionUpdateToast />
      {/* A build that syncs with another server never asks our release host. */}
      {usesOfficialServer() && (
        <>
          <DesktopUpdater />
          <AndroidUpdateToast />
          <StoreUpdateToast />
        </>
      )}
      <Suspense fallback={suspenseFallback}>{screen}</Suspense>
    </>
  );
}
