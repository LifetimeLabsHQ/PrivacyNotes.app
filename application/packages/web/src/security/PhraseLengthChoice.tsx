import { useTranslation } from 'react-i18next';
import { Ruler } from '../icons';
import { SectionEyebrow } from '../settingsUI';
import { CompareTiles } from '../ui';
import { usePhraseLengthTiles } from './phraseLengthTiles';

/**
 * The length choice of a new account, in onboarding and the OAuth
 * self-custody sign-up: the same 12 and 24 word tiles as the Phrase tab
 * (`usePhraseLengthTiles`, one source for their words), without the "Your
 * phrase" row. A tile acts at once: nothing is saved yet, so the phrase on
 * screen is simply replaced by one of the picked length. Onboarding loads it
 * lazily, so it stays off the boot path.
 * Spec: docs/internal/plans/phrase-change.md (section 2.2)
 */
export function PhraseLengthChoice({ words, onChange }: { words: number; onChange: (words: 12 | 24) => void }) {
  const { t } = useTranslation('security');
  const tiles = usePhraseLengthTiles();
  return (
    <div>
      <SectionEyebrow icon={Ruler} className="mb-2">{t('phraseChange.lengthGroup')}</SectionEyebrow>
      <CompareTiles
        label={t('phraseChange.lengthGroup')}
        value={words === 24 ? '24' : '12'}
        tiles={tiles}
        onChange={(v) => onChange(v === '24' ? 24 : 12)}
      />
    </div>
  );
}
