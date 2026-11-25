import { useTranslation } from 'react-i18next';
import { GithubLogo } from './icons';
import { ANNOUNCEMENTS, type Announcement } from './announcements';
import { Banner, CloseButton, FeedbackButton } from './ui';

type Props = {
  surface: 'app' | 'site';
  dismissedIds: readonly string[];
  onDismiss: (id: string) => void;
};

/**
 * The general announcement banner (backlog #175): one bar, two surfaces,
 * copy per announcement from the landing catalog. Renders the first
 * registry entry for its surface that is not dismissed, or nothing.
 *
 * Both surfaces wear the DemoBanner emerald design: green reads as good
 * news in both themes, where an amber bar read as a warning in dark mode.
 * In the app it is a sibling in NotesView's h-dvh flex column, exactly
 * like DemoBanner - in-flow chrome cannot occlude editor controls.
 * Spec: docs/internal/design/ui-patterns.md section 39 (persistent chrome sits in the flow)
 *
 * On the site it is the first strip of the landing page. It reads its
 * dismissal synchronously from localStorage state in LandingPage, so it
 * never appears after paint and never shifts layout except on the user's
 * own dismiss click.
 *
 * The narrow copy takes over below the md line (768), a canonical tier
 * (ui-patterns section 40). Measured in Chrome: the wide English text
 * needs 415px beside a ~136px CTA, which truncates at a 640px viewport
 * and fits from 768 with room for longer locales. Below md the text may
 * wrap to a second line instead of truncating, so no copy is ever cut.
 */
export function AnnouncementBanner({ surface, dismissedIds, onDismiss }: Props) {
  const { t } = useTranslation('landing');
  const active: Announcement | undefined = ANNOUNCEMENTS.find(
    (a) =>
      (a.surface === surface || a.surface === 'both') &&
      !dismissedIds.includes(a.id)
  );
  if (!active) return null;

  const text = (
    <>
      <span className="hidden md:inline">{t(active.textKey)}</span>
      <span className="md:hidden">{t(active.textNarrowKey)}</span>
    </>
  );

  const cta = (
    <FeedbackButton
      action="open"
      href={active.href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="hidden md:inline">{t(active.ctaKey)}</span>
      <span className="md:hidden">{t(active.ctaNarrowKey)}</span>
    </FeedbackButton>
  );

  if (surface === 'site') {
    return (
      <div className="border-b border-success/30 bg-success/10">
        <div className="mx-auto max-w-5xl xl:max-w-7xl px-5 sm:px-8 py-2.5 flex items-center gap-3">
          <GithubLogo weight="fill" className="shrink-0 text-success" aria-hidden="true" />
          <p className="min-w-0 flex-1 md:truncate text-body leading-snug text-pn">{text}</p>
          {cta}
          <CloseButton onClick={() => onDismiss(active.id)} label={t('announcement.dismiss')} />
        </div>
      </div>
    );
  }

  return (
    <Banner
      tone="success"
      icon={GithubLogo}
      action={cta}
      onDismiss={() => onDismiss(active.id)}
      dismissLabel={t('announcement.dismiss')}
    >
      {text}
    </Banner>
  );
}
