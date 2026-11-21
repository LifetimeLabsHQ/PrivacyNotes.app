import { dayNumber, shiftDay } from './schedule';

/**
 * The calendar's day counter (#815): how many days lie between two days, and
 * the day a typed count lands on. A count is the difference of the two days,
 * as the usual day calculators count: the earlier day counts and the later
 * one does not, so a day to the next one is 1 day. With `both` ("Include the
 * end day") the later day counts too, as for a trip: Monday to Friday is 4
 * days, or 5 with it.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 15)
 */

/** The count the calendar shows: `to` is null until a day is picked; `end`
 *  is the day a click in the grid or a typed number moves. While `picking`,
 *  the day under the pointer previews the moving day; a click locks it, and
 *  a press on the From or To tile previews again. */
export type DayCountState = { from: string; to: string | null; end: 'from' | 'to'; picking: boolean };

export type DayCount = {
  days: number;
  /** Monday to Friday only, among the days that count. */
  workdays: number;
  /** `days` as whole weeks and the days left over. */
  weeks: number;
  rest: number;
  /** 1 when `to` is after `from`, -1 when before, 0 on the same day. */
  dir: -1 | 0 | 1;
};

/** Monday to Friday in the day numbers after `lo` up to and with `hi`. Day
 *  number 0 (1970-01-01) was a Thursday. */
function workdaysAfter(lo: number, hi: number): number {
  const weeks = Math.floor((hi - lo) / 7);
  let n = weeks * 5;
  for (let d = lo + 1 + weeks * 7; d <= hi; d++) {
    const weekday = (((d + 4) % 7) + 7) % 7;
    if (weekday !== 0 && weekday !== 6) n++;
  }
  return n;
}

export function countDays(from: string, to: string, both = false): DayCount {
  const a = dayNumber(from);
  const b = dayNumber(to);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const days = hi - lo + (both ? 1 : 0);
  return {
    days,
    // The same days the count counts: from the earlier day, up to the later
    // one, with it only with `both`.
    workdays: workdaysAfter(lo - 1, both ? hi : hi - 1),
    weeks: Math.floor(days / 7),
    rest: days % 7,
    dir: Math.sign(b - a) as -1 | 0 | 1,
  };
}

/** The day `days` away from `anchor` in direction `dir`, so that counting
 *  from the anchor to it gives `days` again. With `both`, 1 day is the
 *  anchor itself. */
export function dayAfterCount(anchor: string, days: number, both: boolean, dir: 1 | -1): string {
  const span = both ? Math.max(0, days - 1) : Math.max(0, days);
  return shiftDay(anchor, dir * span);
}

// ── The counter's steps ──────────────────────────────────────────────
// Each user action is one function from the count before to the count
// after, so `tests/dayCount.test.ts` checks every step without a browser.

/** A count opened with no day picked yet (the tool, "Count days from
 *  here"): the pointer previews the To day. Opened on two days (Ninja, a
 *  shift-click): locked. */
export function startCount(from: string, to: string | null = null): DayCountState {
  return { from, to, end: 'to', picking: to === null };
}

/** A click on a day: the moving day goes there and locks. With no count open
 *  (a shift-click), a count from today to that day. A From picked while To
 *  is still empty hands the preview on to To, so the next click sets it. */
export function pickDay(count: DayCountState | null, day: string, today: string): DayCountState {
  if (!count) return startCount(today, day);
  if (count.end === 'from' && count.to === null) return { from: day, to: null, end: 'to', picking: true };
  return { ...count, [count.end]: day, picking: false };
}

/** A press on the From or To tile: that day moves, previewed again. */
export function chooseEnd(count: DayCountState, end: 'from' | 'to'): DayCountState {
  return { ...count, end, picking: true };
}

/** A typed count, or the stepper's minus and plus: the moving day goes that
 *  many days from the other one, on the side it lies now (forward when the
 *  two are the same day or To is empty). */
export function typeDays(count: DayCountState, days: number, both: boolean): DayCountState {
  const end = count.to ? count.end : 'to';
  const anchor = end === 'to' ? count.from : (count.to as string);
  const current = end === 'to' ? count.to : count.from;
  const dir = current && dayNumber(current) < dayNumber(anchor) ? -1 : 1;
  return { ...count, end, [end]: dayAfterCount(anchor, days, both, dir), picking: false };
}

/** Swap: the two days trade places; the same tile stays pressed. */
export function swapDays(count: DayCountState): DayCountState {
  return count.to ? { from: count.to, to: count.from, end: count.end, picking: false } : count;
}

/** What the screen shows: the moving day replaced by `hover` while picking,
 *  the earlier and the later day, and the moving and the other day. */
export function shownCount(count: DayCountState, hover: string | null) {
  const preview = count.picking ? hover : null;
  const from = count.end === 'from' && preview ? preview : count.from;
  const to = count.end === 'to' && preview ? preview : count.to;
  const lo = to && to < from ? to : from;
  const hi = to && to > from ? to : from;
  return { preview, from, to, lo, hi, moving: count.end === 'from' ? from : to, anchor: count.end === 'from' ? to : from };
}

