import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth';
import { LogoIcon } from './LogoIcon';
import { Hourglass } from './icons';
import { formatInstant } from './intlFormat';
import { Button } from './ui';

/**
 * Full-screen error state for a failed OAuth hydration
 * (`auth.status === 'oauth_hydrate_failed'`).
 *
 * Deliberately loud: swallowing a hydrate failure would fall through to
 * the custody-choice / phrase-entry screens, offering an existing user a
 * fresh account, which orphans their data.
 * This screen makes the failure visible and recoverable: retry against
 * the current session, or give up and return to the sign-in options.
 * Nothing is wiped either way. When the server refused the phrase to this
 * session for good (`reason`), a retry cannot pass: the screen says why and
 * offers only the way back to the sign-in options, where a new sign-in can.
 * While another device of the account has to allow the sign-in, the screen
 * says so, can ask again, and offers the wait for a person who does not have
 * that device; a denied sign-in offers only the way back.
 * Spec: docs/internal/domain-split.md (pre-cutover gate),
 * docs/internal/plans/custodial-release-hardening.md (section 3.3)
 */
export function OAuthRetryScreen({ trust }: { trust: boolean }) {
  const { t } = useTranslation('auth');
  const { auth, retryOAuthHydration, abandonOAuthHydration } = useAuth();
  const [busy, setBusy] = useState(false);
  const reason = auth.status === 'oauth_hydrate_failed' ? auth.reason : undefined;
  const until = auth.status === 'oauth_hydrate_failed' ? auth.until : undefined;
  const code = auth.status === 'oauth_hydrate_failed' ? auth.code ?? '' : '';
  const approval = reason === 'approval_needed' || reason === 'approval_waiting';
  const retry = (wait: boolean) => {
    setBusy(true);
    void retryOAuthHydration(trust, { wait }).finally(() => setBusy(false));
  };

  return (
    <div className="min-h-dvh flex items-center justify-center p-4">
      <div className="bg-surface-2 border border-divider text-pn rounded-lg max-w-md w-full p-6 space-y-5 text-center">
        <div className="flex justify-center">
          <LogoIcon size={40} />
        </div>
        <div className="space-y-2">
          <h1 className="text-heading font-semibold">{t('hydrateError.title')}</h1>
          <p className="text-body text-pn-muted leading-relaxed">
            {reason === 'sign_in_again' ? t('hydrateError.signInAgain')
              : reason === 'release_limit' ? t('hydrateError.releaseLimit')
              : reason === 'approval_needed' ? t('hydrateError.approvalNeeded', { code })
              : reason === 'approval_waiting' ? t('hydrateError.approvalWaiting', { when: until ? formatInstant(until, 'dateTime') : '', code })
              : reason === 'approval_denied' ? t('hydrateError.approvalDenied')
              : t('hydrateError.body')}
          </p>
        </div>
        {approval ? (
          <>
            <Button action="restore" className="w-full justify-center" disabled={busy} onClick={() => retry(false)}>
              {t('signIn.tryAgain')}
            </Button>
            {reason === 'approval_needed' && (
              <Button variant="secondary" icon={<Hourglass aria-hidden="true" />} className="w-full justify-center" disabled={busy} onClick={() => retry(true)}>
                {t('hydrateError.noOtherDevice')}
              </Button>
            )}
            <Button action="back" className="w-full justify-center" disabled={busy} onClick={() => void abandonOAuthHydration()}>
              {t('oauthHandoff.backToOptions')}
            </Button>
          </>
        ) : reason ? (
          <Button action="back" variant="primary" className="w-full justify-center" onClick={() => void abandonOAuthHydration()}>
            {t('oauthHandoff.backToOptions')}
          </Button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void retryOAuthHydration(trust).finally(() => setBusy(false));
              }}
              className="w-full rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover px-4 py-3 font-medium transition shadow-sm disabled:opacity-60"
            >
              {t('signIn.tryAgain')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void abandonOAuthHydration()}
              className="w-full text-body text-pn-muted hover:text-pn transition"
            >
              {t('oauthHandoff.backToOptions')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
