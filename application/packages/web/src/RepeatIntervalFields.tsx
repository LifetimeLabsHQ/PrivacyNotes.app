import { useTranslation } from 'react-i18next';
import { useWeekStart } from './MonthGrid';
import { weekdayDate, weekdayLabel } from './intlFormat';
import type { RepeatUnit } from './schedule';
import { Select, TextField } from './ui';

/** Hide native browser spin arrows on narrow number fields: they ignore the
 *  app's theme and eat half the box; keyboard arrows still step (GitHub #894). */
export const NO_SPIN =
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

const UNITS: readonly RepeatUnit[] = ['day', 'week', 'month', 'year'];

/**
 * Shared interval + unit + weekday picker used by both `ScheduleView`
 * (calendar events) and `TaskReminderPopover` (repeating checkboxes).
 */
export function RepeatIntervalFields({
  interval,
  onIntervalChange,
  every,
  onEveryChange,
  showWeekdays,
  weekdays,
  onToggleWeekday,
}: {
  interval: string;
  onIntervalChange: (next: string) => void;
  every: RepeatUnit;
  onEveryChange: (next: RepeatUnit) => void;
  showWeekdays: boolean;
  weekdays: readonly number[];
  onToggleWeekday: (weekday: number) => void;
}) {
  const { t } = useTranslation('shell');
  const weekStart = useWeekStart();
  const count = Math.max(1, Math.min(999, Number(interval) || 1));

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-pn-muted">{t('repeat.every')}</span>
        <TextField
          size="sm"
          type="number"
          inputMode="numeric"
          min={1}
          max={999}
          value={interval}
          onChange={(e) => onIntervalChange(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={t('repeat.every')}
          className={`w-14 h-8 shrink-0 !ps-2 !pe-2 py-0 text-center tabular-nums ${NO_SPIN}`}
        />
        <Select
          size="sm"
          value={every}
          onChange={(e) => onEveryChange(e.target.value as RepeatUnit)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={t('repeat.every')}
          className="flex-1 min-w-0 h-8 py-0"
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {t(`repeat.units.${u}`, { count })}
            </option>
          ))}
        </Select>
      </div>
      {showWeekdays && (
        <div role="group" aria-label={t('repeat.onDays')} className="flex justify-between gap-1">
          {Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7).map((w) => {
            const on = weekdays.includes(w);
            return (
              <button
                key={w}
                type="button"
                aria-pressed={on}
                aria-label={weekdayLabel(weekdayDate(w), 'long')}
                onClick={() => onToggleWeekday(w)}
                className={`w-8 h-8 rounded-full text-small font-semibold transition ${
                  on ? 'bg-accent-fill text-white' : 'bg-surface-1 text-pn-muted hover:text-pn'
                }`}
              >
                {weekdayLabel(weekdayDate(w), 'narrow')}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
