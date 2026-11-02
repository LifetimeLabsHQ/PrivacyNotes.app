import { Trans, useTranslation } from 'react-i18next';
import { type Icon, BookOpenText, CheckFat, CloudCheck, Detective, Gavel, IdentificationCard, Key, Laptop, Lifebuoy, Lightning } from './icons';
import { Badge } from './ui';
import { activeLocale } from './languages';
import { helpPath } from './localeRoutes';
import { siteHref } from './siteLinks';

/** The three rungs, in ladder order: most convenient to most private. */
const RUNGS = ['custodial', 'self', 'phrase'] as const;
type Rung = (typeof RUNGS)[number];

const RUNG_ICON: Record<Rung, Icon> = { custodial: CloudCheck, self: Laptop, phrase: Detective };

/** The same four threat questions on every rung, so the eye compares across
 *  a row instead of reading three lists. Two labels are the Key custody
 *  table's own, so the two screens name them alike. */
const ROWS = [
  { key: 'key', icon: Key, label: 'security:custody.rowKey' },
  { key: 'reach', icon: Gavel, label: 'ladder.rows.reach' },
  { key: 'identity', icon: IdentificationCard, label: 'ladder.rows.identity' },
  { key: 'lost', icon: Lifebuoy, label: 'security:custody.rowLost' },
] as const;
type Row = (typeof ROWS)[number]['key'];

/** Each rung's answer, and how it reads for the person choosing: the colour
 *  backs the text, it never replaces it. Theme tones, so both surfaces
 *  follow. Answers two rungs share are one string. */
const ANSWERS: Record<Rung, Record<Row, [string, 'good' | 'mid' | 'bad']>> = {
  custodial: {
    key: ['security:custody.rowKeyCustodial', 'mid'],
    reach: ['ladder.answers.reachYes', 'bad'],
    identity: ['ladder.answers.identityEmail', 'bad'],
    lost: ['ladder.answers.lostRestored', 'good'],
  },
  self: {
    key: ['security:custody.rowKeySelf', 'good'],
    reach: ['ladder.answers.reachNo', 'good'],
    identity: ['ladder.answers.identityEmail', 'bad'],
    lost: ['ladder.answers.lostGone', 'bad'],
  },
  phrase: {
    key: ['security:custody.rowKeySelf', 'good'],
    reach: ['ladder.answers.reachNo', 'good'],
    identity: ['ladder.answers.identityNone', 'good'],
    lost: ['ladder.answers.lostGone', 'bad'],
  },
};
const VERDICT_TONE = { good: 'text-success', mid: 'text-warning', bad: 'text-danger' } as const;

/** One chip per rung, naming what it gives. The two self-custody rungs keep
 *  no key on our server: zero knowledge. The custodial rung's gain is
 *  recovery, in the info tone so it never reads as a security claim. */
const CHIP: Record<Rung, { label: string; tone: 'info' | 'success' }> = {
  custodial: { label: 'ladder.easyRecovery', tone: 'info' },
  self: { label: 'ladder.zeroKnowledge', tone: 'success' },
  phrase: { label: 'ladder.zeroKnowledge', tone: 'success' },
};

/**
 * The two surfaces this renders on carry different palettes, and both are
 * correct: the sign-in card wears the washi shell (`--wl-*`), while the
 * settings pane uses the app theme tokens. Everything else - structure,
 * strings, rung order, the help link - is shared, which is the point of
 * this file. Accent, the numeral chip and the emerald check need no entry:
 * those tokens resolve identically in both places.
 */
const TONES = {
  washi: {
    panel: 'border-[var(--wl-line)] bg-[var(--wl-card)]',
    rung: 'border-[var(--wl-line)] bg-[var(--wl-bg)]',
    body: 'text-[var(--wl-ink)]',
    muted: 'text-[var(--wl-sub)]',
  },
  app: {
    panel: 'border-divider bg-surface-1',
    rung: 'border-divider bg-surface-2',
    body: 'text-pn',
    muted: 'text-pn-muted',
  },
} as const;

/**
 * The privacy ladder: provider login with the key on our server, the same
 * login with the key on the device, and phrase-only. Expanded from
 * "Compare the options" on the sign-in card, and from the same control in
 * Settings > Security > Your Phrase so the comparison survives signup.
 *
 * ONE source of truth on purpose. The settings copy started life as a
 * second set of tiles and would have drifted from the sign-in copy the
 * first time either was edited.
 *
 * ONE help link, in the footer, and deliberately not one per rung. The
 * labels would be real FAQ questions running 78, 35 and 41 characters,
 * which puts a four-line block of blue under one card and two-line blocks
 * under the others. That link is labelled rather than carrying its
 * question, which is a deliberate exemption from the show-the-question
 * rule and the only one in the app - see docs/contrib/help-center.md
 * section 9 for what it costs.
 *
 * The rows are a shortened retelling of the `threat-model-levels` FAQ
 * entry and nothing links them: if that ladder changes, change these too.
 * Layout: a convenience-to-privacy scale on top, then one card per rung
 * answering the same four threat questions (docs/internal/design/patterns).
 *
 * Spec: docs/internal/design-decisions.md (Pro mark colour is unrelated; see
 * the sign-in ladder entry), docs/contrib/help-center.md (section 9)
 */
export function PrivacyLadder({
  id,
  tone = 'app',
}: {
  /** Target for the trigger's `aria-controls`. */
  id: string;
  tone?: keyof typeof TONES;
}) {
  const { t } = useTranslation('auth');
  const c = TONES[tone];
  return (
    <div id={id} className={`rounded-2xl border p-4 sm:p-5 space-y-3 ${c.panel}`}>
      <p className={`text-compact ${c.body}`}>{t('ladder.intro')}</p>
      {/* The scale is the point of the panel: the rungs below sit on it in
          order, so the trade-off reads before any card does. */}
      <div className={`flex items-center gap-2 text-small ${c.muted}`}>
        <Lightning aria-hidden="true" />
        <span>{t('ladder.scaleConvenient')}</span>
        <span className="h-px flex-1 bg-divider" aria-hidden="true" />
        <span>{t('ladder.scalePrivate')}</span>
        <Detective aria-hidden="true" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {RUNGS.map((key) => {
          const RungIcon = RUNG_ICON[key];
          return (
            <div key={key} className={`rounded-xl border p-3 flex flex-col ${c.rung}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className={`text-body font-medium ${c.body}`}>{t(`ladder.${key}Tag`)}</div>
                  <div className={`text-meta ${c.muted}`}>{t(`ladder.${key}Title`)}</div>
                </div>
                <RungIcon className={`shrink-0 ${c.muted}`} aria-hidden="true" />
              </div>
              <div className="mt-1.5">
                <Badge tone={CHIP[key].tone}>{t(CHIP[key].label)}</Badge>
              </div>
              <dl className="mt-1.5">
                {ROWS.map(({ key: row, icon: RowIcon, label }) => {
                  const [answer, verdict] = ANSWERS[key][row];
                  return (
                    <div key={row} className="flex items-start gap-2 border-t border-divider py-1.5">
                      <RowIcon size={15} className={`mt-0.5 shrink-0 ${VERDICT_TONE[verdict]}`} aria-hidden="true" />
                      <div className="min-w-0">
                        <dt className={`text-meta ${c.muted}`}>{t(label)}</dt>
                        <dd className={`text-small leading-snug ${c.body}`}>{t(answer)}</dd>
                      </div>
                    </div>
                  );
                })}
              </dl>
            </div>
          );
        })}
      </div>
      <div className="border-t border-divider pt-3">
        {/* One paragraph, the link at the end of the sentence (owner,
            2026-10-30): a two-column footer set the link apart from the
            sentence it explains.
            The reassurance mark, in the 600/500 pair the folder glyphs use.
            Not `--wl-emerald`: its light value #065F46 is 6.81:1 on cream and
            reads as near-black rather than as green. Not emerald-500 either,
            which is the light green it looks like but measures 2.25:1 on
            cream. emerald-600 is 3.34:1 there and emerald-500 is 7.28:1 on
            the dark ground, so both ends are lighter than one fixed value
            and both clear 3:1.
            The sentence is washi only, and this is not a styling split: it
            names Settings as the place to change your mind, which is true on
            the sign-in card and absurd in the settings pane, where the reader
            is already looking at the control it points at. The link is right
            on both surfaces, so only the sentence is gated. */}
        <p className={`flex items-start gap-1.5 text-compact ${c.body}`}>
          {tone === 'washi' && (
            <span className="flex h-5 shrink-0 items-center">
              <CheckFat weight="fill" className="text-success" aria-hidden="true" />
            </span>
          )}
          <span>
            {/* The option names stand out, so the sentence maps onto the cards. */}
            {tone === 'washi' && <><Trans t={t} i18nKey="ladder.footer" components={{ opt: <span className="font-medium" /> }} />{' '}</>}
            <a
              href={siteHref(`${helpPath(activeLocale())}/threat-model-levels`)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-baseline gap-1 whitespace-nowrap text-accent hover:underline"
            >
              <BookOpenText className="self-center" aria-hidden="true" />
              {t('ladder.moreInfo')}
            </a>
          </span>
        </p>
      </div>
    </div>
  );
}
