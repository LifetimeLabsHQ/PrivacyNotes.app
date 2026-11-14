import { useTranslation } from 'react-i18next';
import { intlLocale } from '../languages';
import type { CompareTile } from '../ui';

export type PhraseWordCount = 12 | 24;

/**
 * The 12 and 24 word tiles, the one source of their words for every screen
 * that offers the choice: the Phrase tab, onboarding and the OAuth sign-up.
 * The rows "To write down" and "Against guessing" are the same everywhere;
 * `current` adds the row "Your phrase", which only an account that has a
 * phrase can show (Settings).
 * Spec: docs/internal/plans/phrase-change.md (sections 2.1 and 2.2)
 */
export function usePhraseLengthTiles(opts: { current?: PhraseWordCount | null } = {}): CompareTile<'12' | '24'>[] {
  const { t } = useTranslation('security');
  const withYours = opts.current !== undefined;
  const title = (count: PhraseWordCount) => t('editor:wordCount.words', { count, formatted: count.toLocaleString(intlLocale()) });
  const yours = (length: PhraseWordCount) => length === opts.current
    ? { label: t('phraseChange.rowYours'), mark: 'yes' as const, text: t('phraseChange.yoursNow') }
    : { label: t('phraseChange.rowYours'), mark: 'meh' as const, text: t('phraseChange.yoursSwitch') };
  return [
    {
      value: '12',
      title: title(12),
      badge: { label: t('pinTab.badgeDefault'), tone: 'info' },
      rows: [
        { label: t('phraseChange.rowWrite'), mark: 'yes', text: t('phraseChange.write12') },
        { label: t('phraseChange.rowGuess'), mark: 'yes', text: t('phraseChange.guess12') },
        ...(withYours ? [yours(12)] : []),
      ],
    },
    {
      value: '24',
      title: title(24),
      badge: { label: t('phraseChange.badgeMargin'), tone: 'success' },
      rows: [
        { label: t('phraseChange.rowWrite'), mark: 'meh', text: t('phraseChange.write24') },
        { label: t('phraseChange.rowGuess'), mark: 'yes', text: t('phraseChange.guess24') },
        ...(withYours ? [yours(24)] : []),
      ],
    },
  ];
}
