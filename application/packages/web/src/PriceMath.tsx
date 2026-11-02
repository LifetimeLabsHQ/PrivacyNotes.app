import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Check } from './icons';
import { Brand } from './Brand';
import { COMPARE_YEARS, STACK_CHECKED, STACK_GROUPS } from './pricing';
import { intlLocale } from './languages';
import { formatInstant } from './intlFormat';

/** A group's label: the app's own key where one says the same, else the comparison's. */
const GROUP_LABEL: Record<string, string> = {
  notes: 'shell:tagsRail.notes',
  tasks: 'shell:tagsRail.tasks',
  passwords: 'importExport:shell.tabVault',
  journal: 'notes:newMenu.journal',
  medication: 'common:ninja.features.medication.label',
  calendar: 'shell:tagsRail.calendar',
};

/** US dollars, as the prices are: whole dollars for a total, cents where the
 *  price has them, and always two decimals on the receipt. */
function usd(n: number, cents = false, always = false): string {
  return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: 'USD', minimumFractionDigits: always ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(n);
}

/**
 * The comparison's live half: the visitor ticks the app they pay for in each
 * row, one row per pillar of ours and one app per row, and the heading, the two bars and the saving
 * follow. The bars set COMPARE_YEARS of those fees against the one-time Pro
 * price. A hook, not a component: it hands back the heading, the picker and
 * the result, which sit apart in the section.
 * Spec: docs/internal/design/patterns/151-160.md section 154
 */
export function usePriceMath(proPrice: number) {
  const { t } = useTranslation('landing');
  // One app per group at most: the group's key to the ticked app's name.
  const [pick, setPick] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(STACK_GROUPS.flatMap((g) => g.apps.filter((a) => a.on).slice(0, 1).map((a) => [g.key, a.name]))),
  );
  const ticked = STACK_GROUPS.flatMap((g) => g.apps.filter((a) => pick[g.key] === a.name));
  const yearly = ticked.reduce((sum, a) => sum + a.perYear, 0);
  const them = yearly * COMPARE_YEARS;
  // With nothing ticked both bars stay empty: a full $48 bar against an
  // empty one would read as the dearer choice.
  const top = them > 0 ? Math.max(them, proPrice) : 0;
  const checkedOn = formatInstant(new Date(`${STACK_CHECKED}T12:00:00`), 'monthYear');
  const bar = 'h-5 rounded-md transition-[width] duration-500 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none';
  // A tap ticks that app and unticks the group's other one; a tap on the
  // ticked app leaves the group empty.
  function toggle(group: string, name: string) {
    setPick((p) => {
      const next = { ...p };
      if (next[group] === name) delete next[group];
      else next[group] = name;
      return next;
    });
  }
  return {
    heading: (
      <Trans
        i18nKey="landing:comparison.headingLive"
        values={{ amount: usd(Math.round(yearly)), pro: usd(proPrice) }}
        components={{ cost: <span className="text-[var(--wl-cost)] tabular-nums" />, free: <span className="text-accent" /> }}
      />
    ),
    picker: (
      <div className="bg-[var(--wl-card)] p-6 sm:p-7">
        <div className="font-mono font-semibold text-[var(--wl-sub)] uppercase tracking-[0.18em] text-meta">{t('comparison.pick')}</div>
        {/* One row per group, like a table: the label, then the group's
            apps on one line. On a phone the label sits above and the line
            scrolls sideways, so nine groups stay short. */}
        <div className="mt-3 divide-y divide-[var(--wl-line)]">
          {STACK_GROUPS.map((g) => (
            <div key={g.key} className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:gap-4">
              <div className="shrink-0 text-meta font-bold text-[var(--wl-muted)] sm:w-40">{t(GROUP_LABEL[g.key] ?? `comparison.group.${g.key}`)}</div>
              <div className="-mx-6 flex gap-1.5 overflow-x-auto px-6 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
                {g.apps.map((a) => {
                  const ticked = pick[g.key] === a.name;
                  return (
                    <button
                      key={a.name}
                      type="button"
                      aria-pressed={ticked}
                      onClick={() => toggle(g.key, a.name)}
                      className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border-[1.5px] px-2.5 py-[3px] text-small font-semibold transition ${ticked ? 'border-[var(--wl-ink)] bg-[var(--wl-ink)] text-[var(--wl-bg)]' : 'border-[var(--wl-line)] text-[var(--wl-sub)] hover:border-[var(--wl-edge)] hover:text-[var(--wl-ink)]'}`}
                    >
                      {ticked && <Check size={11} weight="bold" className="shrink-0" />}
                      {a.name}
                      <span className="tabular-nums opacity-70">{usd(a.perYear, true)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
    result: (
      <div className="flex flex-col justify-center gap-5 bg-[var(--wl-card)] p-6 sm:p-7">
        {/* The bill as a paper receipt: a slip with a torn edge
            (.pn-receipt in FX_CSS), every ticked app with its yearly price,
            the total, and the line every subscription prints in small type. */}
        <div className="pn-receipt-wrap mx-auto w-full max-w-sm -rotate-1">
          <div className="pn-receipt bg-[var(--wl-paper)] px-5 pt-4 pb-3 font-mono text-small text-[var(--wl-ink)]">
            <div className="text-center text-body font-bold uppercase tracking-[0.3em]">{t('comparison.receipt')}</div>
            <div className="mt-1 text-center text-meta text-[var(--wl-muted)]">
              {t('comparison.receiptCount', { count: ticked.length })} {'\u00b7'} {checkedOn}
            </div>
            <div className="my-2.5 border-t border-dashed border-[var(--wl-muted)]/50" />
            {ticked.length ? (
              <ul className="space-y-0.5">
                {ticked.map((a) => (
                  <li key={a.name} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">{a.name}</span>
                    <span className="tabular-nums">{usd(a.perYear, true, true)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-2 text-center text-[var(--wl-sub)]">{t('comparison.pickNone')}</p>
            )}
            <div className="my-2.5 border-t border-dashed border-[var(--wl-muted)]/50" />
            {/* The total, marked as with a highlighter pen. */}
            <div className="-mx-2 flex items-baseline justify-between gap-3 rounded-sm bg-[var(--wl-tint-amber)] px-2 py-1.5 text-body font-bold uppercase">
              <span>{t('comparison.perYear')}</span>
              <span className="text-heading tabular-nums text-[var(--wl-cost)]">{usd(yearly, true, true)}</span>
            </div>
            <div className="mt-2.5 border-t-[3px] border-double border-[var(--wl-muted)]/50 pt-2 text-center text-meta uppercase tracking-[0.12em] text-[var(--wl-sub)]">
              {t('comparison.receiptRenews')}
            </div>
            <div aria-hidden="true" className="pn-receipt-code mx-auto mt-2 h-5 w-40" />
          </div>
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 text-small">
          <span className="text-[var(--wl-sub)]">{t('comparison.barThem', { count: COMPARE_YEARS })}</span>
          <span className="rounded-md bg-[var(--wl-tint)]"><span className={`block bg-[var(--wl-cost)] ${bar}`} style={{ width: `${top ? (them / top) * 100 : 0}%` }} /></span>
          <span className="text-end font-bold tabular-nums text-[var(--wl-ink)]">{usd(Math.round(them))}</span>
          <span className="font-semibold text-[var(--wl-ink)]"><Trans i18nKey="landing:comparison.barUs" components={{ brand: <Brand /> }} /></span>
          <span className="rounded-md bg-[var(--wl-tint)]"><span className={`block bg-accent ${bar}`} style={{ width: `${top ? Math.max(3, (proPrice / top) * 100) : 0}%` }} /></span>
          <span className="text-end font-bold tabular-nums text-[var(--wl-ink)]">{usd(proPrice)}</span>
        </div>
        {them > proPrice && (
          <div className="rounded-xl bg-[var(--wl-tint-green)] px-4 py-3.5">
            <div className="text-meta font-bold uppercase tracking-[0.12em] text-[var(--wl-emerald)]">{t('comparison.keepLabel')}</div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5">
              <span className="text-display-3 font-black tracking-tight tabular-nums text-[var(--wl-emerald)]">{usd(Math.round(them - proPrice))}</span>
              <span className="text-body font-semibold text-[var(--wl-emerald)]">{t('comparison.keepLine', { count: COMPARE_YEARS })}</span>
            </div>
          </div>
        )}
        <p className="text-meta text-[var(--wl-muted)]">{t('comparison.checked', { date: checkedOn })}</p>
      </div>
    ),
  };
}
