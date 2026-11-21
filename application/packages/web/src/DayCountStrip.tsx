import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowsLeftRight } from './icons';
import { Checkbox, CloseButton, IconButton, NumberStepper, choiceTileClass } from './ui';
import { capitalize, formatInstant, relativeDayName, toLocalIso } from './intlFormat';
import { intlLocale } from './languages';
import { dayAtNoon } from './MonthGrid';
import { countDays, type DayCountState } from './dayCount';
import { dayNumber } from './schedule';

/**
 * The day counter's strip under the calendar header (#815): the From and To
 * days, the count between them, and what the count is in weeks, workdays
 * and from today. The tile pressed is the day a click in the calendar or a
 * typed count moves; the other day stays. `preview` is the day under the
 * pointer, shown in place of the moving day until a click locks it.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 15)
 */

/** A count can reach back past a birth date and forward past a lifetime. */
const MAX_DAYS = 99_999;
/** How long the number runs to a new count while the pointer moves. */
const TWEEN_MS = 240;

/** The number on its way to `target`: it runs there while `run` holds (the
 *  pointer moves over the days) and is `target` itself otherwise, in the same
 *  render, so the stepper's minus and plus always start from the count: two
 *  quick presses on plus add 2. */
function useTween(target: number | null, run: boolean): number | null {
  const [running, setRunning] = useState<number | null>(null);
  const last = useRef(target);
  useEffect(() => {
    const start = last.current;
    last.current = target;
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!run || target == null || start == null || Math.abs(target - start) <= 1 || still) {
      setRunning(null);
      return;
    }
    const t0 = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / TWEEN_MS);
      setRunning(p < 1 ? Math.round(start + (target - start) * (1 - (1 - p) ** 3)) : null);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    setRunning(start);
    frame = requestAnimationFrame(step);
    // A browser can hold animation frames back (a hidden tab, a window in
    // the background): the timer still ends on the count, never on a number
    // half way.
    const end = window.setTimeout(() => setRunning(null), TWEEN_MS + 40);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(end); };
  }, [target, run]);
  return run && running !== null ? running : target;
}

export function DayCountStrip({ count, preview, both, onBoth, onEnd, onDays, onSwap, onClose }: {
  count: DayCountState;
  preview: string | null;
  both: boolean;
  onBoth: (both: boolean) => void;
  onEnd: (end: 'from' | 'to') => void;
  onDays: (days: number) => void;
  onSwap: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('shell');
  const loc = intlLocale();
  const today = toLocalIso(new Date());
  const from = count.end === 'from' && preview ? preview : count.from;
  const to = count.end === 'to' && preview ? preview : count.to;
  const result = to ? countDays(from, to, both) : null;
  const shown = useTween(result?.days ?? null, preview !== null);

  const dayName = (day: string) => (day === today ? capitalize(relativeDayName(0), loc) : formatInstant(dayAtNoon(day), 'weekdayDate'));
  const summaryOf = (f: string, tt: string | null) => {
    if (!tt) return t('calendar.count.hint');
    const c = countDays(f, tt, both);
    const parts: string[] = [];
    if (c.days >= 14) {
      const weeks = t('calendar.count.weeks', { count: c.weeks });
      parts.push(c.rest ? t('calendar.count.weeksAndDays', { weeks, days: t('stats:wellness.units.days', { count: c.rest }) }) : weeks);
    }
    if (c.days > 0) parts.push(t('calendar.count.workdays', { count: c.workdays }));
    // How far the other day is from today, when one of the two is today.
    const away = f === today ? tt : tt === today ? f : null;
    if (away && away !== today) parts.push(relativeDayName(dayNumber(away) - dayNumber(today)));
    return parts.join(' · ');
  };

  // The live line starts empty and fills after the strip mounts: a screen
  // reader skips what a live region holds when it appears, so a count opened
  // on two days (Ninja) would go unheard.
  const said = count.to ? `${t('stats:wellness.units.days', { count: countDays(count.from, count.to, both).days })}, ${summaryOf(count.from, count.to)}` : '';
  const [spoken, setSpoken] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setSpoken(said), 50);
    return () => window.clearTimeout(id);
  }, [said]);

  const tile = (end: 'from' | 'to', day: string | null) => {
    const on = count.end === end;
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => onEnd(end)}
        className={`${choiceTileClass(on, 'soft')} h-12 flex-col gap-0 px-2`}
      >
        <span className={`text-meta ${on ? 'text-accent' : 'text-pn-muted'}`}>{t(end === 'from' ? 'calendar.count.from' : 'calendar.count.to')}</span>
        <span className="max-w-full truncate font-semibold">{day ? dayName(day) : t('calendar.count.pickDay')}</span>
      </button>
    );
  };

  return (
    <div data-no-wheel-step className="w-full mt-1 flex flex-col gap-2 rounded-lg border border-divider bg-surface-1 p-2">
      <div className="flex items-center gap-2">
        {/* Narrow, the two days share a row and the count goes under them;
            wide, the count sits between the days it measures. */}
        <div className="flex-1 min-w-0 grid grid-cols-2 @min-[520px]/calhead:grid-cols-[minmax(0,1fr)_minmax(9rem,12rem)_minmax(0,1fr)] items-center gap-2">
          {tile('from', from)}
          <div className="order-last col-span-2 @min-[520px]/calhead:order-none @min-[520px]/calhead:col-span-1">
            <NumberStepper
              value={shown}
              onChange={onDays}
              min={both ? 1 : 0}
              max={MAX_DAYS}
              unit={t('repeat.units.day', { count: shown ?? 0 })}
              placeholder="0"
              label={t('calendar.count.daysLabel')}
              expanded
            />
          </div>
          {tile('to', to)}
        </div>
        <div className="shrink-0 flex flex-col @min-[520px]/calhead:flex-row items-center gap-1">
          <IconButton label={t('calendar.count.swap')} position="below-end" onClick={onSwap} disabled={!count.to}>
            <ArrowsLeftRight aria-hidden="true" />
          </IconButton>
          <CloseButton onClick={onClose} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="flex-1 min-w-48 text-small text-pn-muted tabular-nums">{summaryOf(from, to)}</p>
        <Checkbox label={<span className="text-small">{t('calendar.count.both')}</span>} checked={both} onChange={(e) => onBoth(e.target.checked)} />
      </div>
      {/* What a screen reader hears: the count that holds, not the one under the pointer. */}
      <p className="sr-only" aria-live="polite">{spoken}</p>
    </div>
  );
}
