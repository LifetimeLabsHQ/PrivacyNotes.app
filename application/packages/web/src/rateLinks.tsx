import { useTranslation } from 'react-i18next';
import type { ModalLink } from './LinksList';
import { APP_STORE_URL, PLAY_STORE_URL } from './hosts';
import { AppleLogo, ArrowsLeftRight, GithubLogo, GooglePlayLogo, Heart, ShieldCheck, SquaresFour, Star } from './icons';

/**
 * The review platforms where a public rating helps discovery.
 *
 * Two surfaces render this list: the Rate modal off the sidebar footer, and
 * the About modal's Rating tab. It lives here so adding a platform is one
 * edit rather than two that drift.
 */
export function useRateLinks(): ModalLink[] {
  const { t } = useTranslation('landing');

  return [
    {
      href: 'https://alternativeto.net/software/privacynotes/about/',
      label: 'AlternativeTo.net',
      desc: t('rate.descAlternativeTo'),
      rel: 'noopener noreferrer',
      icon: <ArrowsLeftRight weight="fill" className="shrink-0" />,
    },
    {
      // A star costs one click and needs no account setup or review text, so it is the
      // cheapest ask on the list.
      href: 'https://github.com/LifetimeLabsHQ/PrivacyNotes.app',
      label: 'GitHub.com',
      desc: t('rate.descGithub'),
      rel: 'noopener noreferrer',
      icon: <GithubLogo weight="fill" className="shrink-0" />,
    },
    {
      href: PLAY_STORE_URL,
      label: 'Google Play',
      desc: t('rate.descPlay'),
      rel: 'noopener noreferrer',
      icon: <GooglePlayLogo weight="fill" className="shrink-0" />,
    },
    {
      // `action=write-review` opens the review sheet straight away on iOS;
      // on any other device it lands on the listing.
      href: `${APP_STORE_URL}?action=write-review`,
      label: 'App Store',
      desc: t('rate.descAppStore'),
      rel: 'noopener noreferrer',
      icon: <AppleLogo weight="fill" className="shrink-0" />,
    },
    {
      href: 'https://privacytools.io/app/privacynotes',
      label: 'PrivacyTools.io',
      desc: t('rate.descPrivacyTools'),
      rel: 'noopener noreferrer',
      icon: <ShieldCheck weight="fill" className="shrink-0" />,
    },
    {
      href: 'https://www.saashub.com/privacynotes-alternatives',
      label: 'SaaSHub.com',
      desc: t('rate.descSaasHub'),
      rel: 'noopener noreferrer',
      icon: <SquaresFour weight="fill" className="shrink-0" />,
    },
    {
      href: 'https://www.capterra.com/p/10050664/PrivacyNotes/',
      label: 'Capterra.com',
      desc: t('rate.descCapterra'),
      rel: 'noopener noreferrer',
      icon: <Star weight="fill" className="shrink-0" />,
    },
  ];
}

/**
 * The closing line under the platform list. The heart is a filled Phosphor
 * mark rather than an emoji, so it matches the star in the title and renders
 * the same on every platform. The project ships no emojis; the heart is a
 * deliberate exception for this one line, and it ships as a mark rather than
 * a character.
 * It follows the last word inline, so it never orphans onto its own line.
 */
export function RateOutro() {
  const { t } = useTranslation('landing');
  return (
    <>
      {t('rate.outro')}
      <Heart
        weight="fill"
        className="ms-1.5 inline-block align-[-0.1em] text-red-500"
        aria-hidden="true"
      />
    </>
  );
}
