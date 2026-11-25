import { dayNumber, daysInMonth, isTime, shiftDay, weekdayOf } from './schedule';

/**
 * Inline Markdown syntax and recurrence math for per-checkbox reminders.
 *
 * Stored directly on the checkbox line as `:remind[<spec>]`, sibling of
 * `:icon[name]` (editorIconSyntax.ts):
 *   - One-time:          `:remind[2026-11-26 09:00]`
 *   - Fixed schedule:    `:remind[2026-11-26 09:00 daily]`
 *                        `:remind[2026-11-26 09:00 weekdays]`
 *                        `:remind[2026-11-26 09:00 weekly]`
 *                        `:remind[2026-11-26 09:00 weekly mon,thu]`
 *                        `:remind[2026-11-26 09:00 monthly]`
 *                        `:remind[2026-11-26 09:00 yearly]`
 *                        `:remind[2026-11-26 09:00 every 2w mon,thu]`
 *   - After completion:  `:remind[2026-11-26 09:00 +7d]`
 *                        `:remind[2026-11-26 09:00 +2w]`
 *                        `:remind[2026-11-26 09:00 +1m]`
 *                        `:remind[2026-11-26 09:00 +1y]`
 *
 * Leaf module: no TipTap, DOM, or i18n imports so boot-path readers
 * (`tasks.ts`, `notesViewUtils.ts`, `taskReminders.ts`, importers) stay light.
 */

export type TaskRepeatUnit = 'd' | 'w' | 'm' | 'y';
export type TaskScheduleEvery = 'day' | 'week' | 'month' | 'year';

export type TaskRepeat =
  | {
      mode: 'schedule';
      every: TaskScheduleEvery;
      interval: number;
      /** 0..6 (0 = Sunday). Only used when `every === 'week'`. */
      weekdays?: number[];
    }
  | {
      mode: 'after';
      interval: number;
      unit: TaskRepeatUnit;
    };

export type TaskReminder = {
  /** Local floating ISO day `YYYY-MM-DD`. */
  day: string;
  /** Local floating 24h time `HH:MM`. */
  time: string;
  repeat?: TaskRepeat;
};

/** Global regex matching `:remind[...]` tokens in a line or body (bounded to 64 inner chars). */
export const TASK_REMINDER_RE = /:remind\[([a-z0-9: +,-]{10,64})\]/g;

/** Anchored regex for parsing at the start of a slice (markdown-it inline rule). */
export const TASK_REMINDER_HEAD_RE = /^:remind\[([a-z0-9: +,-]{10,64})\]/;

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const WEEKDAY_BY_NAME: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
const WORKWEEK = [1, 2, 3, 4, 5];

const UNIT_TO_EVERY: Record<TaskRepeatUnit, TaskScheduleEvery> = {
  d: 'day',
  w: 'week',
  m: 'month',
  y: 'year',
};

const EVERY_TO_UNIT: Record<TaskScheduleEvery, TaskRepeatUnit> = {
  day: 'd',
  week: 'w',
  month: 'm',
  year: 'y',
};

function isoOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isValidIsoDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(5, 7));
  const d = Number(v.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

function parseWeekdaysToken(raw: string): number[] | null {
  const parts = raw.split(',');
  if (parts.length === 0 || parts.length > 7) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!Object.hasOwn(WEEKDAY_BY_NAME, p)) return null;
    out.push(WEEKDAY_BY_NAME[p]!);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function parseRepeatTail(tail: string): TaskRepeat | null {
  const trimmed = tail.trim();
  if (!trimmed) return null;
  // After completion: `+7d`, `+2w`, `+1m`, `+1y`
  const afterMatch = /^\+([1-9]\d{0,2})([dwmy])$/.exec(trimmed);
  if (afterMatch) {
    const interval = Number(afterMatch[1]);
    if (interval < 1 || interval > 999) return null;
    return { mode: 'after', interval, unit: afterMatch[2] as TaskRepeatUnit };
  }
  if (trimmed === 'daily') return { mode: 'schedule', every: 'day', interval: 1 };
  if (trimmed === 'weekdays') return { mode: 'schedule', every: 'week', interval: 1, weekdays: [...WORKWEEK] };
  if (trimmed === 'monthly') return { mode: 'schedule', every: 'month', interval: 1 };
  if (trimmed === 'yearly') return { mode: 'schedule', every: 'year', interval: 1 };
  if (trimmed === 'weekly') return { mode: 'schedule', every: 'week', interval: 1 };

  const weeklyDays = /^weekly ([a-z,]+)$/.exec(trimmed);
  if (weeklyDays) {
    const weekdays = parseWeekdaysToken(weeklyDays[1]!);
    if (!weekdays) return null;
    return { mode: 'schedule', every: 'week', interval: 1, weekdays };
  }

  const everyMatch = /^every ([1-9]\d{0,2})([dwmy])(?: ([a-z,]+))?$/.exec(trimmed);
  if (everyMatch) {
    const interval = Number(everyMatch[1]);
    if (interval < 1 || interval > 999) return null;
    const every = UNIT_TO_EVERY[everyMatch[2] as TaskRepeatUnit];
    if (everyMatch[3]) {
      if (every !== 'week') return null;
      const weekdays = parseWeekdaysToken(everyMatch[3]);
      if (!weekdays) return null;
      return { mode: 'schedule', every, interval, weekdays };
    }
    return { mode: 'schedule', every, interval };
  }

  return null;
}

/** Parse the inner payload of `:remind[<spec>]`, or null when invalid. */
export function parseTaskReminderSpec(spec: string): TaskReminder | null {
  const clean = spec.trim();
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?: (.+))?$/.exec(clean);
  if (!m) return null;
  const day = m[1]!;
  const time = m[2]!;
  if (!isValidIsoDay(day) || !isTime(time)) return null;
  if (m[3] === undefined) return { day, time };
  const repeat = parseRepeatTail(m[3]);
  if (!repeat) return null;
  return { day, time, repeat };
}

/** Format a TaskRepeat into its compact canonical suffix. */
function formatTaskRepeatToken(repeat: TaskRepeat): string {
  if (repeat.mode === 'after') {
    const n = Math.max(1, Math.min(999, Math.floor(repeat.interval)));
    return `+${n}${repeat.unit}`;
  }
  const n = Math.max(1, Math.min(999, Math.floor(repeat.interval)));
  const days = repeat.every === 'week' && repeat.weekdays?.length
    ? [...new Set(repeat.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : undefined;
  const daysStr = days?.length ? days.map((d) => WEEKDAY_NAMES[d]!).join(',') : '';

  if (n === 1) {
    if (repeat.every === 'day') return 'daily';
    if (repeat.every === 'month') return 'monthly';
    if (repeat.every === 'year') return 'yearly';
    if (days && days.join(',') === WORKWEEK.join(',')) return 'weekdays';
    return daysStr ? `weekly ${daysStr}` : 'weekly';
  }
  const unit = EVERY_TO_UNIT[repeat.every];
  return daysStr ? `every ${n}${unit} ${daysStr}` : `every ${n}${unit}`;
}

/** Canonical inner payload for `:remind[<spec>]`. */
export function formatTaskReminderSpec(r: TaskReminder): string {
  const base = `${r.day} ${r.time}`;
  return r.repeat ? `${base} ${formatTaskRepeatToken(r.repeat)}` : base;
}

/** Full Markdown directive token `:remind[...]`. */
export function taskReminderMarkdown(r: TaskReminder): string {
  return `:remind[${formatTaskReminderSpec(r)}]`;
}

/** Extract the first valid task reminder from a task line's text. */
export function extractTaskReminder(text: string): TaskReminder | null {
  TASK_REMINDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TASK_REMINDER_RE.exec(text)) !== null) {
    const parsed = parseTaskReminderSpec(m[1]!);
    if (parsed) return parsed;
  }
  return null;
}

/** Strip every valid `:remind[...]` token from text (leaves invalid text untouched). */
export function stripTaskReminders(text: string): string {
  return text
    .replace(TASK_REMINDER_RE, (run, inner: string) => (parseTaskReminderSpec(inner) ? '' : run))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Replace, append, or remove the `:remind[...]` token inside a task line's text.
 * Keeps surrounding text intact; passing `null` removes all valid tokens.
 */
export function replaceTaskReminderInText(text: string, next: TaskReminder | null): string {
  let replaced = false;
  const out = text.replace(TASK_REMINDER_RE, (run, inner: string) => {
    if (!parseTaskReminderSpec(inner)) return run;
    if (!next || replaced) return '';
    replaced = true;
    return taskReminderMarkdown(next);
  });
  if (!next) {
    return out.replace(/[ \t]{2,}/g, ' ').trim();
  }
  if (replaced) {
    return out.replace(/[ \t]{2,}/g, ' ').trim();
  }
  const trimmed = out.trimEnd();
  return trimmed ? `${trimmed} ${taskReminderMarkdown(next)}` : taskReminderMarkdown(next);
}

// ── Recurrence stepping ───────────────────────────────────────────────

function addMonthsClamped(day: string, months: number): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1;
  const d = Number(day.slice(8, 10));
  const total = m + months;
  const nextY = y + Math.floor(total / 12);
  const nextM = ((total % 12) + 12) % 12 + 1;
  const clampedD = Math.min(d, daysInMonth(nextY, nextM));
  return isoOf(nextY, nextM, clampedD);
}

function nextScheduledDay(startDay: string, repeat: Extract<TaskRepeat, { mode: 'schedule' }>, afterDay: string): string {
  const interval = Math.max(1, repeat.interval);
  const floor = startDay >= afterDay ? startDay : afterDay;

  if (repeat.every === 'day') {
    const diff = dayNumber(floor) - dayNumber(startDay);
    const steps = Math.floor(diff / interval) + 1;
    return shiftDay(startDay, steps * interval);
  }

  if (repeat.every === 'month') {
    const sy = Number(startDay.slice(0, 4));
    const sm = Number(startDay.slice(5, 7));
    const fy = Number(floor.slice(0, 4));
    const fm = Number(floor.slice(5, 7));
    const monthsDiff = (fy - sy) * 12 + (fm - sm);
    let k = Math.max(1, Math.floor(monthsDiff / interval));
    for (let guard = 0; guard < 24; guard++, k++) {
      const candidate = addMonthsClamped(startDay, k * interval);
      if (candidate > floor) return candidate;
    }
    return addMonthsClamped(startDay, (k + 1) * interval);
  }

  if (repeat.every === 'year') {
    const sy = Number(startDay.slice(0, 4));
    const fy = Number(floor.slice(0, 4));
    let k = Math.max(1, Math.floor((fy - sy) / interval));
    for (let guard = 0; guard < 12; guard++, k++) {
      const candidate = addMonthsClamped(startDay, k * interval * 12);
      if (candidate > floor) return candidate;
    }
    return addMonthsClamped(startDay, (k + 1) * interval * 12);
  }

  // Weekly: honor `weekdays` (0=Sun..6=Sat), defaulting to startDay's weekday.
  const weekdays = repeat.weekdays?.length
    ? [...new Set(repeat.weekdays)].sort((a, b) => a - b)
    : [weekdayOf(startDay)];
  const startWeekSun = shiftDay(startDay, -weekdayOf(startDay));
  const floorWeekSun = shiftDay(floor, -weekdayOf(floor));
  const weeksDiff = Math.floor((dayNumber(floorWeekSun) - dayNumber(startWeekSun)) / 7);
  let k = Math.max(0, Math.floor(weeksDiff / interval));
  for (let guard = 0; guard < 500; guard++, k++) {
    const weekSun = shiftDay(startWeekSun, k * interval * 7);
    for (const w of weekdays) {
      const candidate = shiftDay(weekSun, w);
      if (candidate > floor) return candidate;
    }
  }
  return shiftDay(floor, interval * 7);
}

/**
 * The next reminder day when a repeating task is checked off on `completedOn`.
 * - `mode: 'after'`: counts from `completedOn` (GitHub #934).
 * - `mode: 'schedule'`: steps forward along the fixed schedule strictly past
 *   `max(r.day, completedOn)`, so overdue chores advance to the next upcoming
 *   date and tasks finished early still step cleanly to the next cycle.
 * Returns null for a non-repeating reminder.
 */
export function nextTaskReminderDay(r: TaskReminder, completedOn: string): string | null {
  if (!r.repeat) return null;
  if (r.repeat.mode === 'after') {
    const n = Math.max(1, r.repeat.interval);
    switch (r.repeat.unit) {
      case 'd': return shiftDay(completedOn, n);
      case 'w': return shiftDay(completedOn, n * 7);
      case 'm': return addMonthsClamped(completedOn, n);
      case 'y': return addMonthsClamped(completedOn, n * 12);
    }
  }
  return nextScheduledDay(r.day, r.repeat, completedOn);
}

/** The next TaskReminder when a repeating task is completed on `completedOn`. */
export function nextTaskReminder(r: TaskReminder, completedOn: string): TaskReminder | null {
  const day = nextTaskReminderDay(r, completedOn);
  return day ? { ...r, day } : null;
}

/** Quick-pick reminder presets (Later today, Tomorrow, Next week). */
export function taskReminderPresets(
  now: Date = new Date(),
  defaultTime = '09:00',
): Array<{ key: 'laterToday' | 'tomorrow' | 'nextWeek'; day: string; time: string }> {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const today = isoOf(y, m, d);
  const out: Array<{ key: 'laterToday' | 'tomorrow' | 'nextWeek'; day: string; time: string }> = [];

  // Later today: +3 hours rounded up to the hour, up to 21:00; omitted late at night.
  const nextHour = now.getHours() + (now.getMinutes() > 0 ? 1 : 0);
  if (nextHour <= 20) {
    const targetHour = Math.min(21, Math.max(nextHour + 1, nextHour + 2));
    const time = `${String(targetHour).padStart(2, '0')}:00`;
    out.push({ key: 'laterToday', day: today, time });
  }

  const morning = isTime(defaultTime) ? defaultTime : '09:00';
  out.push({ key: 'tomorrow', day: shiftDay(today, 1), time: morning });

  // Next week: upcoming Monday (1..7 days ahead; on Monday -> next Monday).
  const dow = weekdayOf(today); // 0=Sun..6=Sat
  const daysToMon = dow === 0 ? 1 : 8 - dow;
  out.push({ key: 'nextWeek', day: shiftDay(today, daysToMon), time: morning });
  return out;
}
