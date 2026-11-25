import { withMfaAwareTimeout } from './mfaStep';
import { lazy, Suspense, useState, useEffect, useRef, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { generatePhrase, isValidPhrase } from '@notes/shared';
import { CaretDown, Check, Copy, FileText, Fingerprint, Key, KeyReturn, Lock, Password, QrCode, Scales, Scan, Upload } from './icons';
import { QRCodeCanvas } from 'qrcode.react';
import { buildPhraseFile, PHRASE_FILE_NAME } from './phraseFile';
import { buildSignInCode, extractPhraseFromScan } from './qrSignIn';
import { passkeySignInAvailable, signInPasskeyPhrase, type SignInPasskeyResult } from './passkeySignIn';
import { saveBlob } from './saveFile';
import { useAuth } from './auth';
import type { OAuthProvider } from './auth';
import { QrScannerModal } from './QrScannerModal';
import { TurnstileWidget } from './TurnstileWidget';
import { readResumablePhrase } from './phraseAtRest';
import { isTrustedDevice } from './trustStorage';
import { detectPlatform, warmAuthEdgeFunctions } from './devices';
import { useSecretOnScreen } from './privacyScreen';
import { isAppHost, isBetaHost } from './hosts';
import { applyStoredTheme } from './theme';
import { ConfirmModal } from './ConfirmModal';
import { switchWouldWipe } from './authStorage';
import { LoadingScreen } from './LoadingScreen';
import { LandingPage, FX_CSS } from './LandingPage';
import { LogoIcon } from './LogoIcon';
import { Brand } from './Brand';
import { PrivacyLadder } from './PrivacyLadder';
import { PHRASE_CHANGE_PREVIEW } from './phraseLaunch';
import { isSyncPaused, setSyncPaused } from './syncPause';
import { isLocalOnly } from './localOnly';
import { Badge, Button, Callout, Checkbox, IconTile, StatusLine, TextField } from './ui';
import { PhraseInput } from './PhraseInput';
import { isImeComposing } from './imeComposing';
import { AppleIcon, GithubIcon, GoogleIcon, PROVIDER_CONTINUE_KEY, PROVIDER_ORDER } from './providerIcons';

/** Native (Tauri) build - desktop or mobile wrapper, not the web app.
 *  Checked dynamically so tests and embedded shells see the live runtime. */
function isInstalledApp(): boolean {
  return detectPlatform() !== 'web';
}

type Mode = 'choose' | 'create' | 'import' | 'signin';


/**
 * Minimal full-screen wrapper for post-OAuth steps (custody choice,
 * phrase entry for returning users). Shows only the logo + a centered
 * card - no hero text, feature pillars, or pricing. Gives the user a
 * clear visual break after the provider redirect.
 */
function OAuthSetupScreen({ children }: { children: ReactNode }) {
  return (
    <div className="pn-washi min-h-screen bg-[var(--wl-bg)] text-[var(--wl-ink)] flex flex-col items-center justify-center px-5 py-10">
      {/* The washi variables live in FX_CSS; this screen renders without
          the LandingPage shell, so it brings the style tag itself. */}
      <style>{FX_CSS}</style>
      {/* Logo */}
      <div className="flex items-center gap-3 mb-8">
        <LogoIcon size={56} className="text-accent w-14 h-14" />
        <span className="text-display-3 tracking-tight">
          <Brand />
        </span>
      </div>
      {/* Step card */}
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-[var(--wl-line)] bg-[var(--wl-card)] shadow-sm p-5 sm:p-6">
          {children}
        </div>
      </div>
    </div>
  );
}


/** Detect OAuth redirect tokens in the URL hash on mount. */
function hasOAuthHashTokens(): boolean {
  try {
    return window.location.hash.includes('access_token=');
  } catch { return false; }
}

export function Onboarding({ onAuthedEnterApp }: { onAuthedEnterApp?: () => void } = {}) {
  const { auth, signOut } = useAuth();
  const [mode, setMode] = useState<Mode>('choose');
  const [pendingPhrase, setPendingPhrase] = useState<string | null>(null);
  // When false, session data goes into sessionStorage (cleared on tab close).
  const [trustDevice, setTrustDevice] = useState(true);
  // Whether a new phrase account syncs (GitHub #821): a phrase sign-up
  // starts on this device only, and SignInStep applies it as the sync pause.
  const [syncOn, setSyncOn] = useState(false);

  // True while hydration is still running after an OAuth redirect. Shows
  // the setup screen with a spinner immediately so the user doesn't stare
  // at the marketing page wondering if the sign-in worked.
  const [oauthLoading, setOauthLoading] = useState(hasOAuthHashTokens);
  useEffect(() => {
    // Once auth resolves past 'loading', hydration is done.
    if (auth.status !== 'loading') setOauthLoading(false);
  }, [auth.status]);

  // Returning OAuth users: hydrate sets this flag so we show a focused
  // "enter your phrase" screen instead of the full landing page.
  // Once set, stays true through the entire import->signin flow so the
  // user never sees the marketing page mid-auth.
  const [oauthHandoff, setOauthHandoff] = useState(false);
  useEffect(() => {
    if (auth.status !== 'onboarding') return;
    try {
      if (sessionStorage.getItem('privacynotes.oauth.handoffPending') === '1') {
        setOauthHandoff(true);
        sessionStorage.removeItem('privacynotes.oauth.handoffPending');
      }
    } catch { /* ignore */ }
    // Depend on the whole `auth` object, not just `auth.status`: a native
    // OAuth handoff that lands while we are ALREADY on 'onboarding' (sign
    // out, then sign in again) re-runs setAuth('onboarding') with a fresh
    // object but an unchanged status string. Keying on the status string
    // alone would miss it and never show the phrase-entry handoff.
  }, [auth]);

  // Force light theme on the landing page - the marketing copy and brand
  // palette are designed for light mode. The OAuth setup screens (redirect
  // spinner, custody choice, returning-user phrase handoff) never show the
  // landing page, so they adopt the stored/system theme like the rest of
  // the app. On unmount (sign-in), restore the user's stored preference
  // from localStorage so the app gets the right theme even before
  // NotesView's useTheme hook runs.
  const inOAuthFlow = oauthLoading || oauthHandoff || auth.status === 'oauth_custody_choice';

  // Track which mode spawned the sign-in step so Back returns there.
  const [preSignInMode, setPreSignInMode] = useState<'create' | 'import'>('import');

  // Installed apps creating a phrase vault with Sync off start completely
  // offline and must not pre-warm backend edge functions.
  const isLocalOnlyCreate =
    (mode === 'create' || (mode === 'signin' && preSignInMode === 'create')) &&
    !syncOn &&
    isInstalledApp();

  // Warm the NotesView chunk and the sign-in edge functions as soon as the
  // visitor commits to an auth flow (any phrase step, or any OAuth setup
  // screen). The chunk then downloads in parallel with the sign-in
  // round-trips, so the post-auth <Suspense> fallback in App.tsx resolves
  // instantly instead of showing a second full-screen typewriter while the
  // notes app downloads. Pure marketing visitors never trigger this, so the
  // code-split still pays off where it matters and they send nothing to the
  // sync backend. Repeat calls hit the module cache and the warm-up's guard.
  useEffect(() => {
    if (inOAuthFlow || mode !== 'choose') {
      void import('./NotesView');
      if (!isLocalOnlyCreate) warmAuthEdgeFunctions();
    }
  }, [inOAuthFlow, mode, isLocalOnlyCreate]);
  useEffect(() => {
    // The marketing page and the auth screens all follow the stored/system
    // theme, like the rest of the app; the landing header's ThemeToggle
    // pins an explicit choice. The landing was pinned light until the washi
    // redesign shipped a real dark palette for it (LandingPage FX_CSS).
    // This call still matters: it re-resolves the mode on entry, so a stale
    // paint from a previous view cannot survive into this one.
    applyStoredTheme();
  }, [inOAuthFlow]);

  // Re-resolve the stored theme on unmount as well. The Turnstile script is
  // deliberately not preloaded: it is fetched only if the server actually
  // asks for a challenge, so onboarding hits challenges.cloudflare.com only
  // when there is something to solve.
  useEffect(() => {
    return () => {
      applyStoredTheme();
    };
  }, []);

  function onPhraseReady(phrase: string) {
    setPreSignInMode(mode as 'create' | 'import');
    // Record whether this phrase came from "Sign in with existing
    // phrase" (import) vs a freshly generated one (create). NotesView's
    // welcome-note seed gate reads this: when an *imported* phrase turns
    // out to have no server data, the user expected an existing vault,
    // so we skip the onboarding seed and surface a "new vault created"
    // notice instead of silently fabricating content.
    try {
      if (mode === 'import') {
        sessionStorage.setItem('privacynotes.phraseImport', '1');
      } else {
        sessionStorage.removeItem('privacynotes.phraseImport');
      }
    } catch { /* ignore */ }
    setPendingPhrase(phrase);
    setMode('signin');
  }

  function handleSignInBack() {
    setPendingPhrase(null);
    setMode(preSignInMode);
  }

  // --- OAuth flows: full-screen setup screen, no marketing content ---

  // OAuth redirect in progress: show spinner immediately so the user
  // sees the setup screen instead of the marketing page during hydration.
  if (oauthLoading) {
    return (
      <OAuthSetupScreen>
        <LoadingScreen inline />
      </OAuthSetupScreen>
    );
  }

  // New OAuth user: custody choice
  if (auth.status === 'oauth_custody_choice') {
    return (
      <OAuthSetupScreen>
        <KeyCustodyChoice onBack={() => { void signOut(); }} />
      </OAuthSetupScreen>
    );
  }

  // Returning OAuth user: handoff screen or subsequent phrase entry/signin
  if (oauthHandoff) {
    let content: ReactNode;
    if (mode === 'choose') {
      // Initial handoff: "sign-in verified, enter your phrase"
      content = <OAuthHandoffStep onEnterPhrase={() => setMode('import')} onBack={() => setOauthHandoff(false)} />;
    } else if (mode === 'import') {
      content = (
        <ImportPhrase
          onReady={onPhraseReady}
          onBack={() => setMode('choose')}
          trustDevice={trustDevice}
          onTrustDeviceChange={setTrustDevice}
        />
      );
    } else if (mode === 'signin' && pendingPhrase) {
      content = <SignInStep phrase={pendingPhrase} trustDevice={trustDevice} freshVault={preSignInMode === 'create'} onBack={handleSignInBack} />;
    } else {
      content = null;
    }
    return (
      <OAuthSetupScreen>
        {content}
      </OAuthSetupScreen>
    );
  }

  // --- Normal (non-OAuth) onboarding: full landing page ---
  return (
    <LandingPage onAuthedEnterApp={onAuthedEnterApp}>
      {mode === 'choose' ? (
        <ChooseMode onPick={setMode} />
      ) : mode === 'create' ? (
        <CreatePhrase
          onReady={onPhraseReady}
          onBack={() => setMode('choose')}
          trustDevice={trustDevice}
          onTrustDeviceChange={setTrustDevice}
          syncOn={syncOn}
          onSyncOnChange={setSyncOn}
        />
      ) : mode === 'import' ? (
        <ImportPhrase
          onReady={onPhraseReady}
          onBack={() => setMode('choose')}
          trustDevice={trustDevice}
          onTrustDeviceChange={setTrustDevice}
        />
      ) : pendingPhrase ? (
        <SignInStep phrase={pendingPhrase} trustDevice={trustDevice} freshVault={preSignInMode === 'create'} syncOn={preSignInMode === 'create' ? syncOn : undefined} onBack={handleSignInBack} />
      ) : null}
    </LandingPage>
  );
}


/**
 * Shown inside OAuthSetupScreen for returning OAuth users whose data
 * is locked behind a phrase. Extracted from ChooseMode so the handoff
 * flow lives entirely at the Onboarding level.
 */
function OAuthHandoffStep({ onEnterPhrase, onBack }: { onEnterPhrase: () => void; onBack: () => void }) {
  const { t } = useTranslation('auth');
  const provider = useSessionProvider();
  if (provider === undefined) return <LoadingScreen inline />;
  return (
    <div className="space-y-5">
      {/* Success confirmation */}
      <div className="text-center space-y-1">
        <div className="flex justify-center">
          <IconTile tone="success">
            <Check aria-hidden="true" />
          </IconTile>
        </div>
        <h3 className="text-heading font-bold text-[var(--wl-ink)] mt-3">
          {provider
            ? t('oauthHandoff.verifiedTitle', { provider: OAUTH_META[provider].name })
            : t('oauthHandoff.verifiedTitleGeneric')}
        </h3>
        <p className="text-body text-[var(--wl-sub)] leading-relaxed">
          {t('oauthHandoff.verifiedBody')}
        </p>
      </div>

      <Button
        variant="primary"
        icon={<Key aria-hidden="true" />}
        onClick={onEnterPhrase}
        className="w-full py-3"
      >
        {t('oauthHandoff.enterPhrase')}
      </Button>

      <p className="text-body text-[var(--wl-sub)] text-center leading-relaxed">
        <Trans i18nKey="auth:oauthHandoff.noPhraseHint" components={{ strong: <strong /> }} />
      </p>

      <button
        type="button"
        onClick={onBack}
        className="w-full text-body text-[var(--wl-sub)] hover:text-[var(--wl-ink)] transition py-1"
      >
        {t('oauthHandoff.backToOptions')}
      </button>
    </div>
  );
}


function ChooseMode({ onPick }: { onPick: (m: Mode) => void }) {
  const { t } = useTranslation('auth');
  const { signInWithOAuth, completeDesktopOAuth, signInWithPhrase, unlockLocally } = useAuth();
  const [oauthPending, setOauthPending] = useState<null | 'google' | 'apple' | 'github'>(
    null
  );
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [ladderOpen, setLadderOpen] = useState(false);
  // Non-null once a desktop sign-in is waiting for the code the browser is
  // showing. Desktop gets no callback of its own: no desktop operating system
  // can say which application owns a custom scheme, so the browser stops on
  // our own return page and the person carries the code across.
  // Spec: docs/internal/plans/oauth-redirect-binding-handoff.md (section 8.3)
  const [pastedCode, setPastedCode] = useState<string | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  // Set when this install is still holding a usable phrase while showing this
  // screen. A boot that could not finish its handshake lands here on purpose
  // and leaves the phrase alone, because an unreachable server is not a
  // verdict; a deliberate sign-out clears it first and never reaches this.
  // Without this the app asks for something it already has, and the only way
  // through is retyping twelve words it is holding.
  // Spec: docs/internal/plans/oauth-redirect-binding-handoff.md (section 8.8)
  const [resumable, setResumable] = useState<string | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void readResumablePhrase().then((p) => {
      if (cancelled) return;
      setResumable(p);
      // A held phrase makes the resume button the likely next click, and
      // it starts the handshake at once - unless this device holds a
      // local-only vault, which resumes offline without contacting the server.
      if (p && !isLocalOnly()) warmAuthEdgeFunctions();
    });
    return () => { cancelled = true; };
  }, []);
  // In the apps the phrase can sit under a device key whose store failed for
  // a moment at boot (busy, or a keyring still locked). Coming back to the
  // window asks again, silently, so the resume button appears once it opens.
  // Spec: docs/internal/plans/device-bound-phrase-key.md (section 4)
  useEffect(() => {
    if (resumable) return;
    let cancelled = false;
    function recheck(): void {
      if (document.visibilityState !== 'visible') return;
      void readResumablePhrase().then((p) => {
        if (cancelled || !p) return;
        setResumable(p);
        if (!isLocalOnly()) warmAuthEdgeFunctions();
      });
    }
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [resumable]);

  // Reset "Redirecting..." state when the user navigates back via browser
  // Back button. The OAuth redirect navigates away entirely; if the user
  // hits Back, the browser restores this page from bfcache (pageshow with
  // persisted=true) or re-renders it (popstate). Without this reset the
  // button stays stuck on "Redirecting..." until a manual refresh.
  // See: github.com/LifetimeLabsHQ/PrivacyNotes.app/issues/123
  useEffect(() => {
    function reset() { setOauthPending(null); }
    function handlePageShow(e: PageTransitionEvent) {
      if (e.persisted) reset();
    }
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('popstate', reset);
    return () => {
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('popstate', reset);
    };
  }, []);

  async function handleOAuth(provider: 'google' | 'apple' | 'github') {
    setOauthError(null);
    setOauthPending(provider);
    // The handshake follows the provider round trip, which gives the
    // isolates time to boot.
    warmAuthEdgeFunctions();
    const result = await signInWithOAuth(provider);
    // On failure we surface the error inline and clear the pending state so
    // the user can retry. On success the browser takes over, except on
    // desktop, where it stops on our return page and hands the code back
    // through the person: show the box that asks for it, or the button sits
    // on "Redirecting..." waiting for a callback that never arrives.
    if (!result.ok) {
      setOauthError(result.error);
      setOauthPending(null);
      return;
    }
    if (result.awaitPastedCode) {
      setOauthPending(null);
      setPastedCode('');
    }
  }

  async function handleResume() {
    if (!resumable || resumeBusy) return;
    setOauthError(null);
    setResumeBusy(true);
    // A local-only vault whose OS keyring was locked at boot resumes straight
    // into local-only mode without contacting any server.
    if (isLocalOnly()) {
      if (!(await unlockLocally(resumable))) {
        setOauthError(t('signIn.failedUnexpectedly'));
      }
      setResumeBusy(false);
      return;
    }
    // Trust stays as this device already had it: the phrase is on disk
    // because a previous sign-in put it there, so carrying on is not a new
    // trust decision. A failure leaves the offer in place and says why.
    // The stored phrase, not one typed: a device the owner removed is signed
    // out rather than brought back (register-device `reactivate`).
    // The answer is an object, never falsy: its `ok` says whether it worked
    // (beta.privacynotes.app #213 item 7).
    const result = await signInWithPhrase(resumable, isTrustedDevice(), false, undefined, false);
    setResumeBusy(false);
    if (!result.ok) setOauthError(result.error || t('chooseMode.resumeFailed'));
  }

  async function handlePastedCode() {
    if (pasteBusy) return;
    setOauthError(null);
    setPasteBusy(true);
    const result = await completeDesktopOAuth(pastedCode ?? '');
    setPasteBusy(false);
    // A success replaces this whole screen, so only a failure needs handling:
    // keep the box open with the reason beside it, because the person is
    // looking at the box rather than at the buttons above it.
    if (!result.ok) setOauthError(result.error);
  }

  // ---------- Default: normal login options ----------
  return (
    <div className="space-y-6">
      <h3 className="text-display-3 sm:text-display-4 font-black tracking-tight text-[var(--wl-ink)]">
        {t('chooseMode.welcomeBack')}
      </h3>

      {resumable && (
        <div className="rounded-2xl border border-[var(--wl-line)] bg-[var(--wl-bg)] shadow-sm p-5 flex flex-col gap-3">
          <div>
            <div className="text-body font-semibold text-[var(--wl-ink)]">
              {t('chooseMode.resumeTitle')}
            </div>
            <div className="text-small text-[var(--wl-sub)] mt-0.5">
              {t('chooseMode.resumeSubtitle')}
            </div>
          </div>
          <Button
            action="next"
            variant="primary"
            disabled={resumeBusy}
            onClick={() => void handleResume()}
            className="w-full py-3"
          >
            {resumeBusy ? t('chooseMode.resumeWorking') : t('chooseMode.resumeAction')}
          </Button>
        </div>
      )}

      {/* Desktop OAuth stops on our return page, so the next step is here,
          above both cards and in the accent colour: it is the one thing left
          to do, and at the foot of a card it read as an afterthought. */}
      {pastedCode !== null && (
        <div className="rounded-2xl border-2 border-[var(--wl-pro)] bg-[var(--wl-tint-blue)] shadow-sm p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="sm:w-56 sm:shrink-0">
            <div className="text-body font-semibold text-[var(--wl-ink)]">
              {t('chooseMode.desktopCodeTitle')}
            </div>
            <div className="text-small text-[var(--wl-sub)] mt-0.5">
              {t('chooseMode.desktopCodeHint')}
            </div>
          </div>
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex flex-wrap gap-2 sm:flex-nowrap">
              <TextField
                type="text"
                autoFocus
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                value={pastedCode}
                onChange={(e) => setPastedCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !isImeComposing(e)) void handlePastedCode(); }}
                placeholder={t('chooseMode.desktopCodePlaceholder')}
                className="basis-full sm:basis-0 flex-1 font-mono"
              />
              <Button
                action="next"
                variant="primary"
                disabled={pasteBusy || !pastedCode.trim()}
                onClick={() => void handlePastedCode()}
                className="flex-1 sm:flex-none"
              >
                {pasteBusy ? t('auth:chooseMode.resumeWorking') : t('auth:chooseMode.resumeAction')}
              </Button>
              <Button
                action="cancel"
                disabled={pasteBusy}
                onClick={() => { setPastedCode(null); setOauthError(null); }}
              />
            </div>
            {oauthError && (
              <p className="text-body text-danger">{oauthError}</p>
            )}
          </div>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        {/* Easy & Convenient - OAuth providers */}
        <div className="rounded-2xl border border-[var(--wl-line)] bg-[var(--wl-bg)] shadow-sm p-5 flex flex-col gap-3">
          <div className="flex-1 flex flex-col items-center text-center">
            <div className="mb-2 flex flex-wrap items-center justify-center gap-1.5">
              <Badge tone="success">{t('chooseMode.oneClickLogin')}</Badge>
            </div>
            <div className="text-body font-semibold text-[var(--wl-ink)]">
              {t('chooseMode.easyTitle')}
            </div>
            <div className="text-small text-[var(--wl-sub)] mt-0.5 text-balance">
              {t('chooseMode.easySubtitle')}
            </div>
          </div>
          <div className="space-y-2">
            {OAUTH_ORDER.map((p) => {
              const { Icon, labelKey } = OAUTH_META[p];
              return (
                <button
                  key={p}
                  type="button"
                  disabled={OAUTH_OFF || oauthPending !== null}
                  onClick={() => handleOAuth(p)}
                  className="w-full rounded-lg border border-[var(--wl-line)] bg-[var(--wl-card)] px-4 py-3 font-medium text-[var(--wl-ink)] flex items-center justify-center gap-2.5 hover:bg-[var(--wl-tint)] transition disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <Icon />
                  {oauthPending === p ? t('chooseMode.redirecting') : t(labelKey)}
                </button>
              );
            })}
          </div>
          {oauthError && pastedCode === null && (
            <p className="text-body text-danger">{oauthError}</p>
          )}
        </div>

        {/* Anonymous & Uncompromising - phrase auth */}
        <div className="rounded-2xl border border-[var(--wl-line)] bg-[var(--wl-bg)] shadow-sm p-5 flex flex-col gap-3">
          <div className="flex-1 flex flex-col items-center text-center">
            <div className="mb-2 flex flex-wrap items-center justify-center gap-1.5">
              <Badge tone="success">{t('chooseMode.worksOffline')}</Badge>
              <Badge tone="success">{t('ladder.zeroKnowledge')}</Badge>
            </div>
            <div className="text-body font-semibold text-[var(--wl-ink)]">
              {t('chooseMode.anonymousTitle')}
            </div>
            <div className="text-small text-[var(--wl-sub)] mt-0.5 text-balance">
              {t('chooseMode.anonymousSubtitle')}
            </div>
          </div>
          <div className="space-y-2">
            <Button
              variant="primary"
              icon={<Password aria-hidden="true" />}
              onClick={() => onPick('create')}
              className="w-full py-3"
            >
              {t('chooseMode.generatePhrase')}
            </Button>
            <Button
              variant="secondary"
              icon={<KeyReturn aria-hidden="true" />}
              onClick={() => onPick('import')}
              className="w-full py-3"
            >
              {t('chooseMode.signInExisting')}
            </Button>
            {/* Third row on this side, so the two cards stay the same height
                once GitHub makes three buttons of the other one. Deliberately
                quieter than its neighbours - it is not a way to sign in, and
                at equal weight it read as one. */}
            <button
              type="button"
              onClick={() => setLadderOpen((v) => !v)}
              aria-expanded={ladderOpen}
              aria-controls="pn-signin-ladder"
              className="w-full rounded-lg border border-[var(--wl-line)] hover:bg-[var(--wl-tint)] px-4 py-3 text-[var(--wl-sub)] flex items-center justify-center gap-2 transition"
            >
              <Scales aria-hidden="true" />
              {t('chooseMode.compareOptions')}
              <CaretDown
                aria-hidden="true"
                className={`transition-transform ${ladderOpen ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
        </div>
      </div>

      {ladderOpen && <PrivacyLadder id="pn-signin-ladder" tone="washi" />}

      {/* Trust signals */}
      <div className="pt-4 border-t border-[var(--wl-line)] flex flex-col sm:flex-row sm:flex-wrap items-center justify-center gap-x-6 gap-y-1.5 text-meta text-[var(--wl-sub)]">
        <span className="inline-flex items-center gap-1.5">
          <svg data-ic="" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0 rounded-[2px]">
            <rect width="32" height="32" fill="#da291c" />
            <rect x="13" y="6" width="6" height="20" fill="#fff" />
            <rect x="6" y="13" width="20" height="6" fill="#fff" />
          </svg>
          {t('chooseMode.trustSwitzerland')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Lock />
          {t('chooseMode.trustEncrypted')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Check className="text-success" />
          {t('chooseMode.trustAuditable')}
        </span>
      </div>
    </div>
  );
}

/** Sign-in order: one list for every screen that offers the providers. */
const OAUTH_ORDER = PROVIDER_ORDER;

/** The provider logins return to use.privacynotes.app, never to the beta
 *  site, so on beta the buttons stay disabled and only the phrase signs in
 *  (GitHub #847). Spec: docs/internal/repos-runbook.md (section 2) */
const OAUTH_OFF = isBetaHost();

const OAUTH_META: Record<OAuthProvider, {
  Icon: () => ReactNode;
  labelKey: string;
  /** The brand, printed untranslated in every language. */
  name: string;
}> = {
  google: { Icon: GoogleIcon, labelKey: PROVIDER_CONTINUE_KEY.google, name: 'Google' },
  apple: { Icon: AppleIcon, labelKey: PROVIDER_CONTINUE_KEY.apple, name: 'Apple' },
  github: { Icon: GithubIcon, labelKey: PROVIDER_CONTINUE_KEY.github, name: 'GitHub' },
};

/**
 * The provider the OAuth session carries (`app_metadata.provider`, the claim
 * Settings reads): undefined while the read is in flight, null when it names
 * no provider offered here. Never a guess: a wrong name can send the reader to
 * a different, empty account on their next device.
 */
function useSessionProvider(): OAuthProvider | null | undefined {
  const { supabase } = useAuth();
  const [provider, setProvider] = useState<OAuthProvider | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getSession().then(
      ({ data }) => {
        const claim = data.session?.user?.app_metadata?.provider;
        if (!cancelled) setProvider(OAUTH_ORDER.find((p) => p === claim) ?? null);
      },
      () => {
        if (!cancelled) setProvider(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [supabase]);
  return provider;
}

/**
 * Key custody choice screen for new OAuth users.
 * "Keep it simple & convenient" (custodial) vs "Maximum security & privacy" (self-custody).
 * Spec: docs/contrib/custodial-key-spec.md (one-way: custodial can upgrade later, self-custody cannot downgrade)
 */
function KeyCustodyChoice({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('auth');
  const { completeCustodyChoice } = useAuth();
  const [choice, setChoice] = useState<'custodial' | 'self-custody'>('custodial');
  // The phrase length, for self-custody only: a custodial person never
  // writes the phrase down, so the default 12 words serve them.
  const [words, setWords] = useState<12 | 24>(12);
  // A provider login starts with sync on: its login restores the notes only
  // while they sync (GitHub #821).
  const [syncOn, setSyncOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = useSessionProvider();

  async function handleContinue() {
    // The pause is set before the account opens, so the first sync never
    // runs for a local choice; a failed sign-up puts the old value back.
    const pausedBefore = isSyncPaused();
    setSyncPaused(!syncOn);
    if (choice === 'self-custody') {
      // Generate phrase and authenticate, then show backup screen.
      setBusy(true);
      setError(null);
      const result = await completeCustodyChoice('self-custody', words);
      setBusy(false);
      if (!result.ok) {
        setSyncPaused(pausedBefore);
        setError(result.error);
        return;
      }
      // User is now authenticated but we want them to see their phrase.
      // The auth state is 'authenticated' with showPhraseOnce flag set.
      // NotesView will pop the phrase tab. Nothing more to do here.
      return;
    }

    // Custodial path: authenticate + store phrase server-side.
    setBusy(true);
    setError(null);
    const result = await completeCustodyChoice('custodial');
    setBusy(false);
    if (!result.ok) {
      setSyncPaused(pausedBefore);
      setError(result.error);
    }
    // On success, auth state transitions to 'authenticated' and
    // App.tsx renders NotesView. No phrase reveal needed.
  }

  if (busy || provider === undefined) {
    return <LoadingScreen inline />;
  }

  const tradeoffText = choice === 'custodial'
    ? t('custody.tradeoffCustodial')
    : t('custody.tradeoffSelfCustody');

  return (
    <div className="space-y-5">
      {/* Welcome header */}
      <div className="text-center space-y-1">
        <div className="flex justify-center">
          <IconTile tone="success">
            <Check aria-hidden="true" />
          </IconTile>
        </div>
        <h3 className="text-heading font-bold text-[var(--wl-ink)] mt-3">
          {provider
            ? t('custody.signedIn', { provider: OAUTH_META[provider].name })
            : t('custody.signedInGeneric')}
        </h3>
        <p className="text-body text-[var(--wl-sub)]">
          {t('custody.intro')}
        </p>
      </div>

      {/* Custodial option */}
      <label
        className={`block w-full text-start rounded-xl p-4 cursor-pointer transition ${
          choice === 'custodial'
            ? 'border-2 border-accent bg-[var(--wl-bg)]'
            : 'border border-[var(--wl-line)] bg-[var(--wl-bg)]'
        }`}
      >
        <input
          type="radio"
          name="custody-choice"
          checked={choice === 'custodial'}
          onChange={() => setChoice('custodial')}
          className="sr-only"
        />
        <div className="flex items-start gap-3">
          <div className={`w-5 h-5 rounded-full border-2 mt-0.5 flex items-center justify-center shrink-0 ${
            choice === 'custodial' ? 'border-accent' : 'border-[var(--wl-muted)]/60'
          }`}>
            {choice === 'custodial' && (
              <div className="w-2.5 h-2.5 rounded-full bg-accent-fill" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium text-body text-[var(--wl-ink)]">
                {t('custody.simpleTitle')}
              </div>
              {/* The chips the comparison ladder gives these two options
                  (PrivacyLadder.tsx), not "Recommended": that word on the
                  least private option read as advice to pick it. */}
              <Badge tone="info">{t('ladder.easyRecovery')}</Badge>
            </div>
            <div className="text-small text-[var(--wl-sub)] mt-1 leading-relaxed">
              {t('custody.simpleBody')}
            </div>
          </div>
        </div>
      </label>

      {/* Self-custody option */}
      <label
        className={`block w-full text-start rounded-xl p-4 cursor-pointer transition ${
          choice === 'self-custody'
            ? 'border-2 border-accent bg-[var(--wl-bg)]'
            : 'border border-[var(--wl-line)] bg-[var(--wl-bg)]'
        }`}
      >
        <input
          type="radio"
          name="custody-choice"
          checked={choice === 'self-custody'}
          onChange={() => setChoice('self-custody')}
          className="sr-only"
        />
        <div className="flex items-start gap-3">
          <div className={`w-5 h-5 rounded-full border-2 mt-0.5 flex items-center justify-center shrink-0 ${
            choice === 'self-custody' ? 'border-accent' : 'border-[var(--wl-muted)]/60'
          }`}>
            {choice === 'self-custody' && (
              <div className="w-2.5 h-2.5 rounded-full bg-accent-fill" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium text-body text-[var(--wl-ink)]">
                {t('custody.maxSecurityTitle')}
              </div>
              <Badge tone="success">{t('ladder.zeroKnowledge')}</Badge>
            </div>
            <div className="text-small text-[var(--wl-sub)] mt-1 leading-relaxed">
              {t('custody.maxSecurityBody')}
            </div>
          </div>
        </div>
      </label>
      {choice === 'self-custody' && PHRASE_CHANGE_PREVIEW && (
        <Suspense fallback={null}><PhraseLengthChoice words={words} onChange={setWords} /></Suspense>
      )}

      <SyncCheckbox syncOn={syncOn} onSyncOnChange={setSyncOn} restoreBy={choice === 'custodial' ? 'login' : 'phrase'} />

      {error && (
        <p className="text-body text-danger">{error}</p>
      )}

      <Button
        action="next"
        variant="primary"
        onClick={handleContinue}
        className="w-full py-3"
      >
        {t('continue')}
      </Button>

      <p className="text-small text-[var(--wl-muted)] text-center leading-relaxed">
        {tradeoffText}
      </p>

      <button
        type="button"
        onClick={onBack}
        className="w-full text-body text-[var(--wl-sub)] hover:text-[var(--wl-ink)] transition py-1"
      >
        {t('oauthHandoff.backToOptions')}
      </button>
    </div>
  );
}

/**
 * The length choice of a new account (security/PhraseLengthChoice.tsx), loaded
 * only when it shows: onboarding is on the boot path, and before launch only a
 * dev build shows the choice (phraseLaunch.ts).
 */
const PhraseLengthChoice = lazy(() => import('./security/PhraseLengthChoice').then((m) => ({ default: m.PhraseLengthChoice })));

/** A sign-up option: a checkbox with a bold label and one line under it. */
function OptionCheckbox({ checked, onChange, label, description, tone, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
  /** A line that names a risk (warning) or a safe state (success). */
  tone?: 'warning' | 'success';
  disabled?: boolean;
}) {
  return (
    <Checkbox
      card
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      label={<span className="font-medium">{label}</span>}
      description={
        <span className={`leading-relaxed text-pretty ${tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : ''}`}>
          {description}
        </span>
      }
    />
  );
}

function TrustDeviceCheckbox({
  trustDevice,
  onTrustDeviceChange,
  disabled,
  description,
}: {
  trustDevice: boolean;
  onTrustDeviceChange: (v: boolean) => void;
  disabled?: boolean;
  description?: string;
}) {
  const { t } = useTranslation('auth');
  return (
    <OptionCheckbox
      checked={trustDevice}
      onChange={onTrustDeviceChange}
      label={t('trustDevice.label')}
      description={description ?? t('trustDevice.description')}
      disabled={disabled}
    />
  );
}

/**
 * Whether a new account's notes sync (GitHub #821), set as the sync pause
 * before the sign-in. The line under it says what each state means: off, the
 * notes live only in this browser or app; on, `restoreBy` brings them back.
 * Spec: docs/internal/plans/sync-choice-821.md
 */
function SyncCheckbox({ syncOn, onSyncOnChange, restoreBy, localOnly = false }: {
  syncOn: boolean;
  onSyncOnChange: (v: boolean) => void;
  restoreBy: 'phrase' | 'login';
  /** True on installed apps for phrase creation: Sync off starts completely
   *  offline without contacting our servers (GitHub #862). */
  localOnly?: boolean;
}) {
  const { t } = useTranslation('auth');
  const off = detectPlatform() === 'web'
    ? 'syncChoice.offWeb'
    : localOnly
      ? 'syncChoice.offAppLocalOnly'
      : 'syncChoice.offApp';
  const on = restoreBy === 'login' ? 'syncChoice.onLogin' : 'syncChoice.onPhrase';
  return (
    <OptionCheckbox
      checked={syncOn}
      onChange={onSyncOnChange}
      label={t('syncChoice.label')}
      description={t(syncOn ? on : off)}
      tone={syncOn ? 'success' : localOnly ? undefined : 'warning'}
    />
  );
}

function CreatePhrase({
  onReady,
  onBack,
  trustDevice,
  onTrustDeviceChange,
  syncOn,
  onSyncOnChange,
}: {
  onReady: (phrase: string) => void;
  onBack: () => void;
  trustDevice: boolean;
  onTrustDeviceChange: (v: boolean) => void;
  syncOn: boolean;
  onSyncOnChange: (v: boolean) => void;
}) {
  const { t } = useTranslation('auth');
  const [phrase, setPhrase] = useState(() => generatePhrase());
  // The new phrase is on screen for as long as this step is: no capture of it.
  useSecretOnScreen(true);
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  // The phrase files whose last save failed. A failed native save can leave an
  // empty or partial file, so a file's message stays until that same file
  // saves; a dismissed dialog changes nothing.
  const [failedFiles, setFailedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const qrWrapperRef = useRef<HTMLDivElement | null>(null);

  const words = phrase.split(' ');

  // A new phrase of the picked length, in place: nothing was saved under the
  // one on screen, so what the person confirmed or saved starts over.
  function switchLength(length: 12 | 24) {
    if (length === words.length) return;
    setPhrase(generatePhrase(length));
    setConfirmed(false);
    setCopied(false);
    setFailedFiles(new Set());
  }

  async function copyPhrase() {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  }

  // Download only. Never route the phrase through `navigator.share` -
  // it decrypts the entire vault. Direct local save only (same rule as
  // PhraseView's Save QR).
  async function savePhraseFile(blob: Blob, filename: string) {
    // Direct local save only (web download / native Save As).
    const saved = await saveBlob(blob, filename);
    if (!saved.ok && saved.reason === 'cancelled') return;
    setFailedFiles((files) => {
      const next = new Set(files);
      if (saved.ok) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }

  async function handleDownloadTxt() {
    const text = buildPhraseFile(phrase, {
      title: t('createPhrase.txtTitle'),
      oneLine: t('createPhrase.txtOneLine', { count: phrase.split(' ').length }),
      footer: t('createPhrase.txtFooter', { count: phrase.split(' ').length }),
    });
    await savePhraseFile(new Blob([text], { type: 'text/plain' }), PHRASE_FILE_NAME);
  }

  async function handleDownloadQR() {
    const canvas = qrWrapperRef.current?.querySelector('canvas');
    if (!canvas) return;
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), 'image/png');
      } catch {
        resolve(null);
      }
    });
    if (!blob) return;
    await savePhraseFile(blob, 'privacynotes-phrase-qr.png');
  }

  return (
    <div className="space-y-4">
      <Callout tone="warning">
        <Trans i18nKey="auth:createPhrase.warning" components={{ strong: <strong /> }} />
      </Callout>

      {PHRASE_CHANGE_PREVIEW && <Suspense fallback={null}><PhraseLengthChoice words={words.length} onChange={switchLength} /></Suspense>}

      {/* Two columns below sm: at 375px a three-column cell holds 69px of
          content, and an eight-letter word plus its index needs 87px, so
          the longest words in the BIP-39 list painted over the cell border
          and into the next one. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" dir="ltr">
        {/* rtl-ok: BIP-39 phrase words, always LTR */}
        {words.map((w, i) => (
          <div
            key={i}
            className="rounded-md bg-[var(--wl-bg)] border border-[var(--wl-line)] text-[var(--wl-ink)] px-3 py-2 text-body font-mono"
          >
            <span className="text-[var(--wl-muted)] text-small me-1">{i + 1}.</span>
            {w}
          </div>
        ))}
      </div>


      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Button
          variant={copied ? 'primary' : 'secondary'}
          icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          onClick={copyPhrase}
        >
          {copied ? t('createPhrase.copied') : t('common:actions.copy')}
        </Button>
        <Button
          icon={<FileText aria-hidden="true" />}
          onClick={() => { void handleDownloadTxt(); }}
        >
          {t('createPhrase.downloadTxt')}
        </Button>
        <Button
          icon={<QrCode aria-hidden="true" />}
          onClick={() => { void handleDownloadQR(); }}
        >
          {t('createPhrase.downloadQr')}
        </Button>
      </div>

      {failedFiles.size > 0 && (
        <p className="text-body text-danger">{t('createPhrase.saveFailed')}</p>
      )}

      {/* Hidden QR canvas: stays mounted so Download QR can always read
          it. marginSize=4 bakes a spec-compliant quiet zone into the
          canvas pixels (see PhraseView for the full rationale). */}
      <div className="hidden" ref={qrWrapperRef} aria-hidden="true">
        <QRCodeCanvas value={buildSignInCode(phrase)} size={320} level="M" marginSize={4} />
      </div>

      <Checkbox
        card
        checked={confirmed}
        onChange={(e) => setConfirmed(e.target.checked)}
        label={<span className="font-medium">{t('createPhrase.stored')}</span>}
      />

      {(() => {
        const installed = isInstalledApp();
        const localOnly = !syncOn && installed;
        return (
          <>
            <SyncCheckbox syncOn={syncOn} onSyncOnChange={onSyncOnChange} restoreBy="phrase" localOnly={installed} />
            <TrustDeviceCheckbox
              trustDevice={localOnly ? true : trustDevice}
              onTrustDeviceChange={onTrustDeviceChange}
              disabled={localOnly}
              description={localOnly ? t('trustDevice.lockedLocalOnly') : undefined}
            />
          </>
        );
      })()}

      <div className="grid grid-cols-2 gap-2">
        <Button action="back" onClick={onBack}>
          {t('createPhrase.oneClickInstead')}
        </Button>
        <Button
          action="next"
          variant="primary"
          onClick={() => onReady(phrase)}
          disabled={!confirmed}
        >
          {t('continue')}
        </Button>
      </div>

    </div>
  );
}

/** The line under the passkey button for each failure. A cancelled prompt
 *  shows nothing. Spec: docs/contrib/passkeys.md (4.5) */
const PASSKEY_FAILURE = {
  no_prf: 'passkeySignIn.noPrf',
  not_found: 'passkeySignIn.notFound',
  retired: 'passkeySignIn.retired',
  rate_limited: 'passkeySignIn.rateLimited',
  network: 'passkeySignIn.failed',
} as const;

function ImportPhrase({
  onReady,
  onBack,
  trustDevice,
  onTrustDeviceChange,
}: {
  onReady: (phrase: string) => void;
  onBack: () => void;
  trustDevice: boolean;
  onTrustDeviceChange: (v: boolean) => void;
}) {
  const { t } = useTranslation('auth');
  const { supabase } = useAuth();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [scanning, setScanning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Passkey sign-in: the passkey opens the phrase, and the phrase goes on
  // through the same onReady as a typed one (sign-in step, captcha, "Trust
  // this device", 2FA). Spec: docs/contrib/passkeys.md (4.3, P8)
  const [passkeyOffered] = useState(() => passkeySignInAvailable());
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  async function handlePasskey() {
    setPasskeyError(null);
    setPasskeyBusy(true);
    let result: SignInPasskeyResult;
    try {
      result = await signInPasskeyPhrase(supabase);
    } catch {
      result = { ok: false, reason: 'network' };
    }
    setPasskeyBusy(false);
    if (result.ok) {
      onReady(result.phrase);
      return;
    }
    if (result.reason === 'cancelled' || result.reason === 'unavailable') return;
    setPasskeyError(t(PASSKEY_FAILURE[result.reason]));
  }

  function handleSubmit() {
    const trimmed = input.trim().toLowerCase();
    if (!isValidPhrase(trimmed)) {
      setError(t('importPhrase.invalidPhrase'));
      return;
    }
    onReady(trimmed);
  }

  // Scanner success path: fill the textarea instead of auto-advancing,
  // so the user can eyeball the phrase before committing. A surprise
  // auto-sign-in would make scan-a-wrong-QR mistakes invisible.
  function handleScanned(phrase: string) {
    setInput(phrase);
    setError(null);
    setShowScanner(false);
  }

  // Upload path: decode a QR out of a chosen image file and fill the
  // textarea (same review-before-commit rationale as handleScanned). No
  // camera needed, so it also covers a computer without one. Reuses the
  // same qr-scanner scanImage decode the modal uses.
  async function handleUploadFile(file: File) {
    setScanning(true);
    setError(null);
    try {
      const mod = await import('qr-scanner');
      const QrScanner: any = (mod as any).default ?? mod;
      const decoded: string = await QrScanner.scanImage(file);
      const phrase = extractPhraseFromScan(decoded);
      if (!phrase) {
        setError(t('qrScanner.imageNotSignInCode'));
        return;
      }
      setInput(phrase);
    } catch {
      setError(t('qrScanner.imageUnreadable'));
    } finally {
      setScanning(false);
      // Reset so picking the same file again still fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          <IconTile tone="info" size="sm">
            <Key aria-hidden="true" />
          </IconTile>
        </span>
        <div className="min-w-0">
          <h3 className="text-title font-semibold text-[var(--wl-ink)]">
            {t('chooseMode.signInExisting')}
          </h3>
          <p className="text-small text-[var(--wl-sub)] mt-0.5">
            {t('importPhrase.instructions')}
          </p>
        </div>
      </div>
      <PhraseInput
        tone="washi"
        value={input}
        onChange={(next) => {
          setInput(next);
          setError(null);
        }}
        placeholder={t('importPhrase.placeholder')}
        autoFocus
      />
      <div className="flex items-center gap-3 pt-1">
        <span className="h-px flex-1 bg-[var(--wl-line)]" />
        <span className="text-small text-[var(--wl-muted)]">{t('importPhrase.orOtherWays')}</span>
        <span className="h-px flex-1 bg-[var(--wl-line)]" />
      </div>
      {passkeyOffered && (
        <div className="space-y-1.5">
          <Button
            variant="primary"
            icon={<Fingerprint aria-hidden="true" />}
            onClick={() => void handlePasskey()}
            disabled={passkeyBusy}
            className="w-full"
          >
            {passkeyBusy ? t('passkeySignIn.working') : t('passkeySignIn.button')}
          </Button>
          {passkeyError && <p className="text-body text-danger">{passkeyError}</p>}
        </div>
      )}
      <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
        <Button
          icon={<Upload aria-hidden="true" className="text-accent" />}
          onClick={() => fileInputRef.current?.click()}
          disabled={scanning}
          className="w-full"
        >
          {scanning ? t('qrScanner.readingImage') : t('importPhrase.uploadQr')}
        </Button>
        <Button
          icon={<Scan aria-hidden="true" className="text-accent" />}
          onClick={() => setShowScanner(true)}
          className="w-full"
        >
          {t('importPhrase.scanQr')}
        </Button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUploadFile(file);
        }}
      />
      {error && <p className="text-body text-danger">{error}</p>}
      <TrustDeviceCheckbox
        trustDevice={trustDevice}
        onTrustDeviceChange={onTrustDeviceChange}
      />
      <div className="flex gap-2 pt-1">
        <Button action="back" onClick={onBack} />
        <Button
          action="next"
          variant="primary"
          onClick={handleSubmit}
          disabled={!input.trim()}
          className="flex-1"
        >
          {t('continue')}
        </Button>
      </div>

      {showScanner && (
        <QrScannerModal
          onScanned={handleScanned}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}

/** Lean sign-in step: signInWithPhrase straight away, with a Turnstile
 *  challenge only if the server refuses for want of one. Supabase Auth
 *  CAPTCHA is a dashboard toggle nothing in the client can read, so the
 *  refusal IS the signal - a challenge nobody asked for is friction on
 *  every signup and, in a mobile webview, a hard block (#120).
 *  The one-shot Turnstile token is passed through to Supabase Auth as
 *  `captchaToken` on the anonymous sign-in - GoTrue verifies it against
 *  siteverify itself once Attack Protection CAPTCHA is enabled, so the
 *  token must NOT be spent on any other siteverify call first.
 *  PIN and biometric setup are deliberately not part of onboarding - both
 *  are available later from Security settings. */
function SignInStep({
  phrase,
  trustDevice,
  freshVault,
  syncOn,
  onBack,
}: {
  phrase: string;
  trustDevice: boolean;
  /** True when this phrase was generated by the create flow, so the
   *  vault is provably new and may seed its onboarding notes. */
  freshVault: boolean;
  /** A new phrase account's sync choice, set as the sync pause before the
   *  sign-in so a local account never pushes. Absent for a phrase that signs
   *  in to an account that exists: that device keeps its pause. */
  syncOn?: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation('auth');
  const { signInWithPhrase, createLocalVault } = useAuth();
  const isLocalOnlyFlow = freshVault && syncOn === false && isInstalledApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signing in with a phrase this device does not own destroys what is
  // on it. The question is asked here rather than inside the sign-in,
  // which also runs on boot paths with no screen to ask from, and only a
  // person on the signed-out screen ever sees it - which is where
  // switching accounts is the deliberate act it looks like.
  const [askSwitch, setAskSwitch] = useState(false);
  const switchConfirmed = useRef(false);

  const [turnstileOk, setTurnstileOk] = useState(false);
  const [turnstileKey, setTurnstileKey] = useState(0);
  const autoFired = useRef(false);
  const captchaTokenRef = useRef<string | null>(null);
  // Set only after the server has actually refused a tokenless sign-in.
  // Until then no challenge is rendered and nothing is fetched from
  // Cloudflare - and under the web-only link-pubkey gate, native
  // clients are never refused, so the widget below is web-only in
  // practice. Spec: docs/internal/design-decisions.md (Turnstile is
  // web-only, enforced at link-pubkey)
  const [needsChallenge, setNeedsChallenge] = useState(false);

  // Warm the NotesView chunk while authentication runs. Without this, the
  // app's <Suspense> fallback paints a SECOND full-screen loading screen
  // after sign-in while the heavy chunk loads cold. Preloading here (the
  // user has already committed a phrase) means the app appears instantly
  // when auth resolves, so phrase sign-in shows exactly one loading state.
  useEffect(() => {
    void import('./NotesView');
  }, []);

  // Network timeout for sign-in - matches the 15s used by the
  // auto-sign-in-on-mount path in auth.tsx. Without this, a hanging
  // network call traps the user on the loading screen indefinitely.
  const SIGNIN_TIMEOUT_MS = 15_000;

  function handleToken(token: string | null) {
    // Missing-site-key builds emit the synthetic 'dev-bypass'
    // token. Never forward it as a captchaToken: with CAPTCHA off
    // GoTrue ignores tokens anyway, and with CAPTCHA on a bogus token
    // and a missing token fail identically - so dev keeps working
    // against a CAPTCHA-off project and fails closed otherwise. The
    // retry it triggers lands on the error screen, which is the honest
    // outcome for a keyless build against an enforcing server.
    if (token === 'dev-bypass') {
      setTurnstileOk(true);
      return;
    }
    if (!token) {
      // Challenge errored or the token expired; the widget resets
      // itself for a fresh challenge (see TurnstileWidget callbacks).
      // Gate closes with the token: turnstileOk must never be true
      // while the ref is empty, or the retry submits tokenless again.
      captchaTokenRef.current = null;
      setTurnstileOk(false);
      return;
    }
    captchaTokenRef.current = token;
    // No setError(null) here: after a failed sign-in the error view
    // keeps a live widget whose managed challenge auto-solves within
    // seconds - clearing the error would dismiss the retry screen into
    // a dead "Signing you in" state before the user can read it (the
    // auto-fire latch is still set, so nothing would re-run finish()).
    setTurnstileOk(true);
  }

  async function finish() {
    // Before the loading screen, which would cover the question.
    if (!switchConfirmed.current && (await switchWouldWipe(phrase, !isLocalOnlyFlow))) {
      setAskSwitch(true);
      return;
    }
    setBusy(true);
    setError(null);

    // Installed-app local-only vault creation (GitHub #862): skip all backend
    // auth, Turnstile, and timeouts; initialize the encrypted local vault.
    if (isLocalOnlyFlow) {
      try {
        const result = await createLocalVault(phrase);
        if (!result.ok) {
          setError(result.error);
          setBusy(false);
        }
      } catch (err) {
        setError((err as Error).message || t('signIn.failedUnexpectedly'));
        setBusy(false);
      }
      return;
    }

    const pausedBefore = isSyncPaused();
    if (syncOn !== undefined) setSyncPaused(!syncOn);

    try {
      const result = await withMfaAwareTimeout(
        signInWithPhrase(
          phrase,
          trustDevice,
          freshVault,
          captchaTokenRef.current ?? undefined,
        ),
        SIGNIN_TIMEOUT_MS,
        () => ({ ok: false as const, error: t('signIn.timedOut') }),
      );
      if (!result.ok) {
        if (syncOn !== undefined) setSyncPaused(pausedBefore);
        // The token is single-use and now spent (or stale) - drop it so
        // the retry path gets a fresh challenge instead of resubmitting
        // a dead token.
        captchaTokenRef.current = null;
        setBusy(false);
        // The server refused for want of a challenge token: show the
        // challenge and re-arm the latch so its token fires the retry.
        // Not an error state - nothing has gone wrong yet. Guarded on
        // needsChallenge so a token the server rejects surfaces as an
        // error on the second pass instead of looping the user through
        // solve-submit-refuse forever.
        if (result.captchaRequired && !needsChallenge) {
          setNeedsChallenge(true);
          autoFired.current = false;
          return;
        }
        // Latch stays set: a widget already on screen re-solves within
        // seconds, and auto-firing on that token would replace the
        // error with another attempt before the user can read it. Try
        // again is the way out. A second challenge refusal carries the
        // internal 'session_expired' taxonomy string as its message -
        // show the generic failure copy instead of that raw token.
        setError(
          result.captchaRequired ? t('signIn.failedUnexpectedly') : result.error,
        );
      }
    } catch (err) {
      if (syncOn !== undefined) setSyncPaused(pausedBefore);
      captchaTokenRef.current = null;
      setError((err as Error).message || t('signIn.failedUnexpectedly'));
      setBusy(false);
    }
  }

  // Sign-in is attempted with no token, on every platform: only the
  // server knows whether the link-pubkey gate is enforcing, so the user
  // is shown a challenge only once it actually refuses one. That keeps
  // the TURNSTILE_WEB_ENFORCE secret the single source of truth -
  // flipping it takes effect with no release - and means a vault signup
  // runs zero Turnstile code while enforcement is off or the caller is
  // not a web origin. Re-runs when a challenge token lands (see
  // finish()).
  useEffect(() => {
    if (autoFired.current) return;
    autoFired.current = true;
    void finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnstileOk]);

  if (askSwitch) {
    return (
      <ConfirmModal
        title={t('signIn.switchTitle')}
        confirmLabel={t('signIn.switchConfirm')}
        variant="info"
        onConfirm={() => {
          switchConfirmed.current = true;
          setAskSwitch(false);
          void finish();
        }}
        // The confirm button runs onConfirm and then onClose, so a plain
        // `onBack` here answered the question and then walked away from the
        // answer: the sign-in it had just started was unmounted, the create
        // step remounted, and a brand new phrase was generated under a user
        // who had already written the old one down. The dismiss routes -
        // backdrop, Escape, the cancel button - still go back, which is what
        // declining the switch means.
        onClose={() => {
          if (switchConfirmed.current) return;
          onBack();
        }}
      >
        {t('signIn.switchBody')}
      </ConfirmModal>
    );
  }

  if (busy) {
    return <LoadingScreen inline />;
  }

  // Error state: show the error with retry + back buttons so the user
  // isn't stranded - without them the only escape from a failed sign-in
  // is reloading the entire page and re-entering the phrase.
  if (error) {
    // A published phrase is refused every time, so a retry cannot help.
    const retryable = error !== t('signIn.publicPhrase');
    return (
      <div className="space-y-4">
        <Callout tone="danger">
          {error}
        </Callout>
        <div className="flex gap-2">
          <Button
            action="back"
            onClick={onBack}
            className={retryable ? '' : 'flex-1'}
          />
          {retryable && (
            <Button
              action="retry"
              variant="primary"
              onClick={() => {
                setError(null);
                autoFired.current = false;
                if (needsChallenge) {
                  // A spent token cannot be resubmitted: re-key Turnstile
                  // so a fresh challenge issues a fresh one, which
                  // triggers finish() via the effect.
                  setTurnstileOk(false);
                  setTurnstileKey((k) => k + 1);
                } else {
                  // No challenge on screen (ordinary failure - offline,
                  // timeout): nothing will flip turnstileOk, so fire the
                  // retry directly.
                  autoFired.current = true;
                  void finish();
                }
              }}
              className="flex-1"
            >
              {t('signIn.tryAgain')}
            </Button>
          )}
        </div>
        {needsChallenge && (
          <TurnstileWidget
            key={turnstileKey}
            onToken={handleToken}
            // Without this the user waits on "Signing you in..." forever
            // when a challenge cannot complete (#120). Reuses the existing
            // timeout copy; the error branch gives Back + Try again.
            onTimeout={() => setError(t('signIn.timedOut'))}
            className="flex justify-center"
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-center py-4">
        <StatusLine busy>{t('signIn.signingIn')}</StatusLine>
      </div>
      {/* Until the server actually refuses a tokenless sign-in there is
          nothing for the user to do, so show them nothing to do. */}
      {needsChallenge && (
        <TurnstileWidget
          key={turnstileKey}
          onToken={handleToken}
          // Without this a challenge that never completes strands the
          // user on "Signing in..." with no error and no way out - the
          // #120 fix landed on the error branch above and missed this
          // one, which is the path a first sign-in actually takes.
          onTimeout={() => setError(t('signIn.timedOut'))}
          className="flex justify-center"
        />
      )}
    </div>
  );
}
