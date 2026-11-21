/**
 * The Counter custom tracker type (GitHub #812): something used again and
 * again up to a limit, such as a razor blade that lasts 30 shaves.
 *
 * Nothing stores a running total. A total on a template or in one entry
 * would change with each use, and a whole-value merge would keep one
 * device's count, as the medication supply would (section 6.7 of the
 * tracker spec). So each journal day holds the uses of that day, and the
 * total is computed: the uses of the day and the days before it, back to
 * the newest day with a "Start again". That day's entry also holds `reset`,
 * the uses after the restart, and only those count.
 * Spec: docs/internal/mood-wellness-tracker.md section 16.1 (Counter)
 */

import { COUNTER_DAY_MAX, type CustomTrackerEntry, type JournalTrackerData } from './trackerTypes';

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(COUNTER_DAY_MAX, Math.floor(v)) : 0;

/** Whether an entry carries a "Start again" of its day. */
function restarted(e: CustomTrackerEntry): boolean {
  return typeof e.reset === 'number' && Number.isFinite(e.reset);
}

/**
 * The total of a counter on `day`: the uses of `day` (from `live`, the entry
 * as the open panel holds it, when there is one) and of every day before
 * it, back to the newest restart. Without `live`, the day's uses come from
 * the history, so a second entry of one day that holds no count shows the
 * count of the first. `history` is the tracker history, newest day first;
 * an entry without its day cannot be placed and does not count, and of two
 * entries of one day that both hold the counter, only the first counts.
 */
export function counterTotal(
  trackerId: string,
  history: readonly JournalTrackerData[],
  day: string,
  live?: CustomTrackerEntry,
): number {
  let total = 0;
  const add = (e: CustomTrackerEntry | undefined): boolean => {
    if (!e) return false;
    if (restarted(e)) {
      total += Math.min(count(e.reset), count(e.value));
      return true;
    }
    total += count(e.value);
    return false;
  };
  const seen = new Set<string>();
  if (live) {
    seen.add(day);
    if (add(live)) return total;
  }
  for (const d of history) {
    const date = d.journalDate;
    if (typeof date !== 'string' || date > day || seen.has(date)) continue;
    const e = d.customTrackers?.find((c) => c.trackerId === trackerId);
    if (!e) continue;
    seen.add(date);
    if (add(e)) break;
  }
  return total;
}

/**
 * The entry after the day's count is set to `uses`. The uses after a
 * restart move by the same amount, never below zero or above the day's
 * count. The entry goes when it holds nothing: no use and no restart.
 * `ts` lets the merge keep the newer of two writes (`mergeTrackers`).
 */
export function counterSetDay(
  trackerId: string,
  entry: CustomTrackerEntry | undefined,
  uses: number,
  now: Date = new Date(),
): CustomTrackerEntry | undefined {
  const value = count(uses);
  if (entry && restarted(entry)) {
    const before = count(entry.value);
    const reset = Math.max(0, Math.min(value, count(entry.reset) + (value - before)));
    return { trackerId, value, reset, ts: now.toISOString() };
  }
  if (value === 0) return undefined;
  return { trackerId, value, ts: now.toISOString() };
}

/** The entry after "Start again": the day keeps its uses, and from now on
 *  only the uses after this tap count. */
export function counterStartAgain(
  trackerId: string,
  entry: CustomTrackerEntry | undefined,
  now: Date = new Date(),
): CustomTrackerEntry {
  return { trackerId, value: count(entry?.value), reset: 0, ts: now.toISOString() };
}

/** The pill's text: "27/30" with a limit, "27" without. */
export function counterText(total: number, limit: number | undefined): string {
  return limit ? `${total}/${limit}` : `${total}`;
}
