import { occurrencesOf, shiftDay, weekdayOf, type Repeat } from './schedule';
import { hhmm, toLocalIso } from './localDate';
import type {
  MedicationDose,
  MedicationLogEntry,
  MedicationScheduleEntry,
  MedicationStatus,
  MedicationTemplate,
} from './trackerTypes';

/**
 * The doses of a medication: which ones a day asks about, how a day's log
 * names them, what a day reads as, and the supply left. Pure: the Meds pill,
 * Settings, the statistics and the reminder plan all read these.
 * Spec: docs/internal/mood-wellness-tracker.md section 6.7
 */

/** The first dose of every medication. It logs under the bare template id,
 *  which is what every client before doses wrote. */
export const MAIN_DOSE = 'main';
/** Between the template id and the dose id in a log entry's `medicationId`. */
const DOSE_SEP = '~';
/** The most scheduled doses a day. */
export const MAX_DOSES = 6;
/** Below this many days of scheduled use, the supply reads as low. */
export const LOW_SUPPLY_DAYS = 7;

const EVERY_DAY: Repeat = { every: 'day', interval: 1 };
const ONE_DOSE: MedicationDose[] = [{ id: MAIN_DOSE, amount: 1 }];

/** The log id of one dose: the template id for the main dose. */
export function doseLogId(medId: string, doseId: string): string {
  return doseId === MAIN_DOSE ? medId : `${medId}${DOSE_SEP}${doseId}`;
}

/** The template a log entry belongs to. */
export function logMedicationId(logId: string): string {
  const at = logId.indexOf(DOSE_SEP);
  return at < 0 ? logId : logId.slice(0, at);
}

/** The dose a log entry records: `main` for a bare id. */
export function logDoseId(logId: string): string {
  const at = logId.indexOf(DOSE_SEP);
  return at < 0 ? MAIN_DOSE : logId.slice(at + 1);
}

/** A new dose id: short, and never the separator. */
export function newDoseId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/** The doses of the current schedule. */
export function dosesOf(med: Pick<MedicationTemplate, 'doses'>): MedicationDose[] {
  return med.doses?.length ? med.doses : ONE_DOSE;
}

/** The schedule fields of a template as one snapshot. */
export function currentSchedule(med: MedicationTemplate, id = 'current', editedAt = ''): MedicationScheduleEntry {
  return {
    id,
    changedAt: med.startedAt,
    editedAt,
    ...(med.asNeeded ? { asNeeded: true } : {}),
    ...(med.maxPerDay ? { maxPerDay: med.maxPerDay } : {}),
    ...(med.repeat ? { repeat: med.repeat } : {}),
    doses: dosesOf(med),
    ...(med.endsOn ? { endsOn: med.endsOn } : {}),
  };
}

/** Revision order: the effective day, then the edit, then the id, so every
 *  device picks the same one. */
function later(a: MedicationScheduleEntry, b: MedicationScheduleEntry): boolean {
  if (a.changedAt !== b.changedAt) return a.changedAt > b.changedAt;
  if (a.editedAt !== b.editedAt) return a.editedAt > b.editedAt;
  return a.id > b.id;
}

/** The revisions that still hold: one edited later with an effective day
 *  on or before another replaces it, so moving a future start earlier never
 *  lets the old future schedule come back on its day. A pure function of
 *  the set, so every device that holds the same revisions agrees. */
function liveRevisions(history: readonly MedicationScheduleEntry[] | undefined): MedicationScheduleEntry[] {
  const all = (history ?? []).filter(isRevision);
  return all.filter((r) => !all.some((o) => o !== r && o.editedAt > r.editedAt && o.changedAt <= r.changedAt));
}

/** The newest revision, or null without any. */
export function latestRevision(history: readonly MedicationScheduleEntry[] | undefined): MedicationScheduleEntry | null {
  let best: MedicationScheduleEntry | null = null;
  for (const h of liveRevisions(history)) if (!best || later(h, best)) best = h;
  return best;
}

/** A revision as this client writes it; anything else is ignored. */
function isRevision(h: unknown): h is MedicationScheduleEntry {
  const r = h as Partial<MedicationScheduleEntry> | null;
  return !!r && typeof r.id === 'string' && typeof r.changedAt === 'string' && typeof r.editedAt === 'string' && Array.isArray(r.doses);
}

/** The template with its schedule fields set from a revision. */
export function withRevision(med: MedicationTemplate, rev: MedicationScheduleEntry): MedicationTemplate {
  const next: MedicationTemplate = { ...med };
  delete next.asNeeded;
  delete next.maxPerDay;
  delete next.repeat;
  delete next.doses;
  delete next.endsOn;
  const isDefault = rev.doses.length === 1 && rev.doses[0]!.id === MAIN_DOSE && !rev.doses[0]!.time && rev.doses[0]!.amount === 1;
  return {
    ...next,
    ...(rev.asNeeded ? { asNeeded: true } : {}),
    ...(rev.maxPerDay ? { maxPerDay: rev.maxPerDay } : {}),
    ...(rev.repeat ? { repeat: rev.repeat } : {}),
    ...(isDefault ? {} : { doses: rev.doses }),
    ...(rev.endsOn ? { endsOn: rev.endsOn } : {}),
  };
}

/** The schedule that held on a day: the newest revision on or before it,
 *  else the oldest one (the day is before every recorded change), else the
 *  current fields. */
function scheduleOn(med: MedicationTemplate, day: string): MedicationScheduleEntry {
  const history = liveRevisions(med.scheduleHistory);
  if (history.length === 0) return currentSchedule(med);
  let best: MedicationScheduleEntry | null = null;
  let first: MedicationScheduleEntry | null = null;
  for (const h of history) {
    if (h.changedAt <= day && (!best || later(h, best))) best = h;
    if (!first || later(first, h)) first = h;
  }
  return best ?? first!;
}

/** Whether a day lies inside the medication's life: from its start to its
 *  end day, and not after it was removed. */
export function isLiveOn(med: MedicationTemplate, day: string): boolean {
  if (day < med.startedAt) return false;
  if (med.endsOn && day > med.endsOn) return false;
  if (med.deletedAt && day > toLocalIso(new Date(med.deletedAt))) return false;
  return true;
}

/** Whether a repeat counted from `start` falls on `day`. The calendar's
 *  repeat always holds its start day; a medication on weekdays does not, so
 *  a Monday medication started on a Thursday is not due that Thursday. */
function repeatsOn(start: string, repeat: Repeat | undefined, day: string): boolean {
  const r = repeat ?? EVERY_DAY;
  if (r.every === 'week' && r.weekdays?.length && !r.weekdays.includes(weekdayOf(day))) return false;
  return occurrencesOf(start, r, day, day).length > 0;
}

/** The first day on or after `start` that a repeat falls on, for the anchor
 *  of a reminder series. */
export function firstRepeatDay(start: string, repeat: Repeat | undefined): string {
  let day = start;
  for (let i = 0; i < 7 && !repeatsOn(start, repeat, day); i++) day = shiftDay(day, 1);
  return day;
}

/** The scheduled doses a day asks about, in time order, as the schedule of
 *  that day held them. None for an as-needed medication, outside its life,
 *  or on a day its repeat skips. */
export function dosesOn(med: MedicationTemplate, day: string): MedicationDose[] {
  if (!isLiveOn(med, day)) return [];
  const s = scheduleOn(med, day);
  if (s.asNeeded || (s.endsOn && day > s.endsOn) || !repeatsOn(med.startedAt, s.repeat, day)) return [];
  return sortDoses(s.doses.length ? s.doses : ONE_DOSE);
}

/** Doses by time; a dose with no time keeps its place after the timed ones. */
export function sortDoses(doses: MedicationDose[]): MedicationDose[] {
  return doses
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (a.d.time && b.d.time ? (a.d.time < b.d.time ? -1 : a.d.time > b.d.time ? 1 : a.i - b.i) : a.d.time ? -1 : b.d.time ? 1 : a.i - b.i))
    .map((x) => x.d);
}

/** Whether the medication is as needed on a day. */
export function asNeededOn(med: MedicationTemplate, day: string): boolean {
  return !!scheduleOn(med, day).asNeeded;
}

/** The log entries of one medication in a day's list. */
export function logsOf(logs: readonly MedicationLogEntry[] | undefined, medId: string): MedicationLogEntry[] {
  return (logs ?? []).filter((l) => logMedicationId(l.medicationId) === medId);
}

/** The doses of a day that are owed by now: on today, a dose with no log is
 *  not owed yet before its time (or, with no time, before the day ends). */
function owedDoses(med: MedicationTemplate, logs: readonly MedicationLogEntry[] | undefined, day: string, now: Date): { doses: MedicationDose[]; byDose: Map<string, MedicationLogEntry> } {
  const byDose = new Map(logsOf(logs, med.id).map((l) => [logDoseId(l.medicationId), l]));
  let doses = dosesOn(med, day);
  if (day === toLocalIso(now)) {
    const clock = hhmm(now);
    doses = doses.filter((d) => byDose.has(d.id) || (d.time !== undefined && d.time < clock));
  }
  return { doses, byDose };
}

/** Expected and taken doses of one medication on one day. As needed counts
 *  neither way; a dose of today that is not due yet counts neither way. */
export function adherenceOn(med: MedicationTemplate, logs: readonly MedicationLogEntry[] | undefined, day: string, now: Date = new Date()): { expected: number; taken: number } {
  const { doses, byDose } = owedDoses(med, logs, day, now);
  return { expected: doses.length, taken: doses.filter((d) => byDose.get(d.id)?.status === 'taken').length };
}

/** What a day reads as for one medication: taken when every owed dose is
 *  taken, skipped when every one is logged and one is a skip, missed when an
 *  owed dose has no log, nothing when the day holds no log. As needed: taken
 *  when the day holds a dose. A day the schedule does not ask about reads its
 *  logs as they are, so a dose logged then never hides. */
export function medicationDayStatus(med: MedicationTemplate, logs: readonly MedicationLogEntry[] | undefined, day: string | undefined, now: Date = new Date()): MedicationStatus | undefined {
  const own = logsOf(logs, med.id);
  if (own.length === 0) return undefined;
  const { doses, byDose } = day ? owedDoses(med, logs, day, now) : { doses: [] as MedicationDose[], byDose: new Map<string, MedicationLogEntry>() };
  if (doses.length === 0) {
    if (own.some((l) => l.status === 'taken')) return 'taken';
    return own.some((l) => l.status === 'skipped') ? 'skipped' : own[0]!.status;
  }
  const statuses = doses.map((d) => byDose.get(d.id)?.status);
  if (statuses.every((st) => st === 'taken')) return 'taken';
  if (statuses.every((st) => st === 'taken' || st === 'skipped')) return 'skipped';
  return 'missed';
}

// ── Supply ─────────────────────────────────────────────────────────

/** The newest refill, by its instant. */
function lastRefill(med: MedicationTemplate) {
  let best: NonNullable<MedicationTemplate['refills']>[number] | null = null;
  for (const r of med.refills ?? []) if (r && typeof r.at === 'string' && (!best || r.at > best.at)) best = r;
  return best;
}

/**
 * What is left: the newest refill's count minus each taken dose after it (a
 * later day, or the refill's own day at or after its time; a dose of that day
 * with no time is taken to be before the refill). The amount is the one the
 * schedule of that day gave the dose. Null without a refill. Computed, never
 * stored: a counter on the template would change with every dose, and the
 * whole-template merge would keep one device's count.
 */
export function supplyLeft(med: MedicationTemplate, days: ReadonlyArray<{ date: string; logs: readonly MedicationLogEntry[] | undefined }>): number | null {
  const refill = lastRefill(med);
  if (!refill) return null;
  const at = new Date(refill.at);
  const refillDay = toLocalIso(at);
  const refillTime = hhmm(at);
  let used = 0;
  for (const { date, logs } of days) {
    if (!date || date < refillDay) continue;
    const own = logsOf(logs, med.id).filter((l) => l.status === 'taken' && (date !== refillDay || (!!l.at && l.at >= refillTime)));
    if (own.length === 0) continue;
    const doses = scheduleOn(med, date).doses;
    const amountOf = new Map(doses.map((d) => [d.id, d.amount]));
    const fallback = doses[0]?.amount ?? 1;
    for (const l of own) used += amountOf.get(logDoseId(l.medicationId)) ?? fallback;
  }
  return Math.max(0, Math.round((refill.count - used) * 100) / 100);
}

/** The amount a scheduled day uses, averaged over the repeat. Zero for as needed. */
export function dailyUse(med: MedicationTemplate): number {
  if (med.asNeeded) return 0;
  const perDay = dosesOf(med).reduce((sum, d) => sum + d.amount, 0);
  const r = med.repeat;
  if (!r) return perDay;
  if (r.every === 'day') return perDay / r.interval;
  if (r.every === 'week') return (perDay * (r.weekdays?.length ?? 1)) / (7 * r.interval);
  return perDay / 30;
}

/** The day the supply runs out at the scheduled use, or null when it
 *  cannot be told (no count, as needed, nothing used). */
export function runsOutOn(med: MedicationTemplate, left: number | null, today: string): string | null {
  const days = daysLeft(med, left);
  return days === null ? null : shiftDay(today, days);
}

/** Whole days the supply lasts, or null when it cannot be told. */
export function daysLeft(med: MedicationTemplate, left: number | null): number | null {
  const use = dailyUse(med);
  if (left === null || use <= 0) return null;
  return Math.floor(left / use);
}

// ── Time grouping ──────────────────────────────────────────────────

export type TimeGroup = 'morning' | 'afternoon' | 'evening' | 'anytime';

const TIME_GROUP_ORDER: readonly TimeGroup[] = ['morning', 'afternoon', 'evening', 'anytime'];

/** Which part of the day a dose time (HH:MM) belongs to, or 'anytime' without one. */
export function timeGroupOf(time: string | undefined): TimeGroup {
  if (!time) return 'anytime';
  if (time < '12:00') return 'morning';
  if (time < '17:00') return 'afternoon';
  return 'evening';
}

export type ScheduledDoseItem = {
  med: MedicationTemplate;
  dose: MedicationDose;
  index: number;
  total: number;
  logId: string;
  group: TimeGroup;
};

/** Flatten scheduled medication rows into chronological time-of-day groups.
 *  Timed doses sort by HH:MM ascending (preserving template order on ties);
 *  untimed doses keep their template order under 'anytime'. As-needed rows
 *  are excluded so callers render them in their own section. */
export function groupScheduledDoses(
  rows: ReadonlyArray<{ med: MedicationTemplate; doses: MedicationDose[]; asNeeded: boolean }>,
): Array<{ group: TimeGroup; items: ScheduledDoseItem[] }> {
  const flat: Array<ScheduledDoseItem & { order: number }> = [];
  let order = 0;
  for (const r of rows) {
    if (r.asNeeded) continue;
    r.doses.forEach((dose, index) => {
      flat.push({
        med: r.med,
        dose,
        index,
        total: r.doses.length,
        logId: doseLogId(r.med.id, dose.id),
        group: timeGroupOf(dose.time),
        order: order++,
      });
    });
  }
  flat.sort((a, b) => {
    if (a.dose.time && b.dose.time) {
      if (a.dose.time !== b.dose.time) return a.dose.time < b.dose.time ? -1 : 1;
      return a.order - b.order;
    }
    if (a.dose.time) return -1;
    if (b.dose.time) return 1;
    return a.order - b.order;
  });
  const byGroup = new Map<TimeGroup, ScheduledDoseItem[]>();
  for (const item of flat) {
    const list = byGroup.get(item.group) ?? [];
    list.push(item);
    byGroup.set(item.group, list);
  }
  return TIME_GROUP_ORDER.flatMap((group) => {
    const items = byGroup.get(group);
    return items?.length ? [{ group, items }] : [];
  });
}

/** Partition chronological time groups into two balanced contiguous columns
 *  for wide layouts, keeping chronological order intact when stacked in one
 *  column on narrow panes. Returns `[groups, []]` when fewer than two groups
 *  exist. */
export function splitScheduledGroups<T extends { items: readonly unknown[] }>(
  groups: readonly T[],
): [T[], T[]] {
  if (groups.length < 2) return [[...groups], []];
  const weights = groups.map((g) => g.items.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let bestSplit = 1;
  let bestDiff = Infinity;
  let left = 0;
  for (let i = 1; i < groups.length; i++) {
    left += weights[i - 1]!;
    const diff = Math.abs(left - (total - left));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = i;
    }
  }
  return [groups.slice(0, bestSplit), groups.slice(bestSplit)];
}
