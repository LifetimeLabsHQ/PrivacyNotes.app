import { useTranslation } from 'react-i18next';
import { DEMO_APP_URL } from './demo';
import { withSource } from './campaignSource';
import { Lock, UserPlus } from './icons';
import { Banner, FeedbackButton } from './ui';

type Props = {
  onDismiss: () => void;
};

/**
 * Dismissable demo banner: a full-width bar at the top of the app shell,
 * above the header. Frames the sandbox as zero-risk rather than as a
 * warning, and is explicit that demo notes do not carry over: an account
 * starts a fresh, encrypted notebook of the user's own. Carries the single
 * conversion CTA (sign up on the real app).
 *
 * Rendered as the first child of NotesView's h-dvh flex column, so it owns
 * its own strip and the header and panes below reflow around it. That is the
 * entire point. Earlier versions floated - pinned bottom-right, then centered
 * on the editor column - and each position landed on top of something else,
 * most recently the editor's word-count row and its "Show markdown" link. A
 * bar in the flow cannot occlude anything, and needs none of the
 * overlay-yielding or column-measuring machinery the floating one required.
 *
 * Dismissable, unlike the floating version. The permanent "nothing is saved"
 * signal is carried by SyncStatus in the footer, which reads "Not saved" in
 * demo and cannot be dismissed, so closing the conversion CTA costs no
 * honesty. Dismissal is session state: a reload brings it back.
 *
 * Spec: docs/internal/specs/editor-mode-toggle.md (that row's bottom position varies by note length via mt-auto)
 */
export function DemoBanner({ onDismiss }: Props) {
  const { t } = useTranslation('shell');
  return (
    <Banner
      tone="success"
      icon={Lock}
      compactMobile
      action={
        <FeedbackButton icon={<UserPlus aria-hidden="true" />} href={withSource(DEMO_APP_URL)}>
          {t('security:demoTeaser.createAccount')}
        </FeedbackButton>
      }
      onDismiss={onDismiss}
      dismissLabel={t('common:updateToast.dismiss')}
    >
      <span className="font-semibold sm:hidden">{t('demoBanner.shortTitle')}</span>
      <span className="hidden sm:inline font-semibold">{t('demoBanner.title')}</span>
      {/* Mini on phones: the description drops, leaving icon + short title + CTA on one row. */}
      <span className="hidden sm:inline text-pn-soft">
        {' '}
        {t('demoBanner.description')}
      </span>
    </Banner>
  );
}
