import type { TFunction } from 'i18next';
import { formatDay, relativeDayName, weekdayDate, weekdayLabel } from './intlFormat';
import { timeLabel } from './JournalCalendar';
import { localMoment } from './reminders';
import { shiftDay } from './schedule';
import { listOf } from './scheduleText';
import type { TaskReminder, TaskRepeat } from './taskReminderSyntax';

/**
 * Human-readable labels for per-checkbox reminders and their repeat rules.
 * Every date and time goes through `intlFormat.ts` / `timeLabel`, every word
 * comes from `shell` (`taskReminder.*` and `repeat.*`).
 */

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Short day label: Today, Tomorrow, Yesterday, weekdayDate (same year), or date. */
export function taskReminderDayLabel(day: string, todayIso: string): string {
  if (day === todayIso) return capitalize(relativeDayName(0));
  if (day === shiftDay(todayIso, 1)) return capitalize(relativeDayName(1));
  if (day === shiftDay(todayIso, -1)) return capitalize(relativeDayName(-1));
  if (day.slice(0, 4) === todayIso.slice(0, 4)) return formatDay(day, 'weekdayDate');
  return formatDay(day, 'date');
}

/** Compact date & time label for a reminder pill, e.g. "Tomorrow, 9:00 AM". */
export function formatTaskReminderLabel(r: TaskReminder, todayIso: string): string {
  return `${taskReminderDayLabel(r.day, todayIso)}, ${timeLabel(r.day, r.time)}`;
}

const WORKWEEK_KEY = '1,2,3,4,5';

const UNIT_KEY = {
  d: 'day',
  w: 'week',
  m: 'month',
  y: 'year',
} as const;

/** Short repeat text for a reminder chip or summary row. */
export function formatTaskRepeatLabel(repeat: TaskRepeat, t: TFunction): string {
  if (repeat.mode === 'after') {
    const unit = t(`shell:repeat.units.${UNIT_KEY[repeat.unit]}`, { count: repeat.interval });
    return t('shell:taskReminder.afterDone', { count: repeat.interval, unit });
  }
  const n = repeat.interval;
  if (repeat.every === 'day') return t('shell:repeat.daily', { count: n });
  if (repeat.every === 'month') return t('shell:taskReminder.everyMonths', { count: n });
  if (repeat.every === 'year') return t('shell:taskReminder.everyYears', { count: n });
  const days = repeat.weekdays?.length ? [...new Set(repeat.weekdays)].sort((a, b) => a - b) : [];
  if (n === 1 && days.join(',') === WORKWEEK_KEY) return t('shell:taskReminder.weekdaysShort');
  if (days.length > 0) {
    const names = listOf(days.map((w) => weekdayLabel(weekdayDate(w), 'short')));
    return t('shell:repeat.weekly', { count: n, days: names });
  }
  return t('shell:taskReminder.everyWeeks', { count: n });
}

/** True when a reminder's floating local time is already in the past. */
export function isTaskReminderOverdue(r: TaskReminder, nowMs = Date.now()): boolean {
  return localMoment(r.day, r.time).getTime() < nowMs;
}
