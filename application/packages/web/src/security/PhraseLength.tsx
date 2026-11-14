import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowsClockwise, ArrowsLeftRight, Key, Ruler } from '../icons';
import { useAuth } from '../auth';
import { isDemoMode } from '../demo';
import { PHRASE_CHANGE_PREVIEW } from '../phraseLaunch';
import { SectionEyebrow, SETTINGS_HELP } from '../settingsUI';
import { Button, CompareTiles, Divider, IconTile } from '../ui';
import { PhraseChangeWizard } from './PhraseChangeWizard';
import { usePhraseLengthTiles, type PhraseWordCount } from './phraseLengthTiles';

/**
 * The phrase length and the phrase change, under the phrase on the Phrase
 * tab: two cards that only stage a length (native radios fire on arrow keys,
 * so a selection never starts anything), one button that switches to the
 * staged length and states what a switch costs, and a separate "Change
 * phrase" row that makes a new phrase of the same length, for a phrase
 * somebody else may have seen. Both open the same wizard with the length
 * preset. Shown only when the server says this account may change its
 * phrase (the allowlist until launch), and in the demo (before launch only
 * in a dev build).
 * Spec: docs/internal/plans/phrase-change.md (section 2.1)
 */
export function PhraseLength({ words, onOpenTwoFactor }: { words: number; onOpenTwoFactor?: () => void }) {
  const { t } = useTranslation('security');
  const { supabase, loadPhraseChange } = useAuth();
  const demo = isDemoMode();
  // The demo asks no server: it shows the tiles once launched, and before
  // that only in a dev build (phraseLaunch.ts).
  const [allowed, setAllowed] = useState(demo && PHRASE_CHANGE_PREVIEW);
  // Generation makes 12 or 24 words; an imported phrase of another valid
  // length (15 to 21) stages the nearer one, 24 on the tie at 18, so its
  // switch button shows at once.
  const current: PhraseWordCount | null = words === 12 || words === 24 ? words : null;
  const [staged, setStaged] = useState<PhraseWordCount>(current ?? (words >= 18 ? 24 : 12));
  const [wizard, setWizard] = useState<{ words: PhraseWordCount; reason: 'length' | 'leak' } | null>(null);
  const tiles = usePhraseLengthTiles({ current });

  useEffect(() => {
    if (demo) return;
    let live = true;
    // Any failure reads as "not allowed": the tiles stay hidden.
    void Promise.resolve()
      .then(() => loadPhraseChange())
      .then((m) => m.phraseChangeAllowed(supabase))
      .then((ok) => { if (live) setAllowed(ok); })
      .catch(() => {});
    return () => { live = false; };
  }, [demo, loadPhraseChange, supabase]);

  if (!allowed) return null;

  const sameLength = current ?? staged;

  return (
    <div className="space-y-4">
      <section>
        <SectionEyebrow icon={Ruler}>{t('phraseChange.lengthGroup')}</SectionEyebrow>
        <p className={`${SETTINGS_HELP} mt-1 mb-2.5`}>{t('phraseChange.lengthHint')}</p>
        <CompareTiles
          label={t('phraseChange.lengthGroup')}
          value={String(staged) as '12' | '24'}
          tiles={tiles}
          onChange={(v) => setStaged(v === '24' ? 24 : 12)}
          footer={staged !== current ? {
            note: t('phraseChange.switchCost'),
            button: (
              <Button variant="primary" icon={<ArrowsLeftRight />} onClick={() => setWizard({ words: staged, reason: 'length' })}>
                {t('phraseChange.switchTo', { count: staged })}
              </Button>
            ),
          } : undefined}
        />
      </section>
      <Divider />
      <section>
        <SectionEyebrow icon={ArrowsClockwise} className="mb-2.5">{t('phraseChange.changeRow')}</SectionEyebrow>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-lg border border-divider bg-surface-1 px-3.5 py-3">
          <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
            <IconTile size="sm"><Key /></IconTile>
            <div className="min-w-0">
              <p className="text-body font-medium text-pn">{t('phraseChange.changeTitle', { count: sameLength })}</p>
              <p className={`${SETTINGS_HELP} text-balance`}>{t('phraseChange.changeHelp')}</p>
            </div>
          </div>
          <Button icon={<ArrowsClockwise />} onClick={() => setWizard({ words: sameLength, reason: 'leak' })}>
            {t('phraseChange.changeRow')}
          </Button>
        </div>
      </section>
      {wizard && (
        <PhraseChangeWizard
          words={wizard.words}
          reason={wizard.reason}
          onClose={() => setWizard(null)}
          onOpenTwoFactor={onOpenTwoFactor}
        />
      )}
    </div>
  );
}
