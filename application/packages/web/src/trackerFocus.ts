import type { TFunction } from 'i18next';
import type { LocalNote } from './db';
import type { FactorDef, JournalTrackerData, MedicationTemplate, TrackerSettings } from './trackerTypes';
import type { RangeId, TrackerDescriptor, TrackerValue } from './wellnessTypes';
import { buildWellnessModel, formatNumber, formatValue, levelLabel, trackerName, type WellnessModel } from './stats/wellnessModel';
import { dayTone, formatPoint, learnedDirection } from './stats/statsParts';
import { visibleInUi } from './trackerRegistry';
import { daysApart } from './localDate';
import { entryDayOf } from './notesViewUtils';
import { tonePaint, type PillTone } from './trackerTone';
import type { TrackerFocus } from './trackerFocusStore';
import { readWellnessRange } from './stats/wellnessRange';

/** The Statistics range on this device, which the tones are measured against (D6). */
export function readRange(): RangeId {
  return readWellnessRange();
}

/**
 * One tracker in focus, read from the same registry, merge and tone rule as
 * Statistics: which journal entries hold it, the value each one shows, the
 * days with it and the days between them, and the values a Calendar day
 * shows for the trackers switched on there. Loaded on demand, like
 * Statistics, so the boot chunk does not carry the wellness engine.
 * Spec: docs/internal/specs/tracker-focus-771.md (section 3)
 */

/** Whether a logged value answers the focus: any value of a number or a
 *  level; the chosen answer of a yes or no (Yes by default); a tag set that
 *  holds the chosen tag, or any tag when none is chosen. A day with no
 *  answer never counts as No. */
export function matchesValue(v: TrackerValue | undefined, focus: TrackerFocus): boolean {
  if (v === undefined) return false;
  const answer = focus.answer ?? 'yes';
  if (typeof v === 'boolean') return answer === 'any' || v === (answer === 'yes');
  if (Array.isArray(v)) {
    if (v.length === 0) return false;
    if (!focus.tag || answer === 'any') return true;
    return v.includes(focus.tag) === (answer === 'yes');
  }
  return true;
}

/** The other number of a two-number reading (blood pressure, a custom
 *  pair), which the registry keeps as two descriptors. */
export function partnerOf(id: string): { other: string; first: boolean } | null {
  if (id === 'bpSystolic') return { other: 'bpDiastolic', first: true };
  if (id === 'bpDiastolic') return { other: 'bpSystolic', first: false };
  const m = /^(.+)~([12])$/.exec(id);
  if (!m) return null;
  return { other: `${m[1]}~${m[2] === '1' ? '2' : '1'}`, first: m[2] === '1' };
}

/** The usual gap between the days, newest first and each day once: the
 *  median, rounded to a whole day, or null below two days. */
export function usualGap(days: readonly string[]): number | null {
  if (days.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(daysApart(days[i - 1]!, days[i]!));
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
  return Math.max(1, Math.round(median));
}

export interface FocusChoice {
  d: TrackerDescriptor;
  /** The newest day with a value. */
  last: string;
  /** Stopped or deleted: listed after the others. */
  stopped: boolean;
}
export interface FocusBadge { text: string; tone: PillTone }
export interface FocusDay { date: string; tone: PillTone; paint: string }
/** One tracker's mark on a Calendar day: its value, its tone, and the
 *  entry that holds the day's values, which a tap opens. */
export interface DayMark {
  id: string; d: TrackerDescriptor; name: string; text: string; tone: PillTone; paint: string; entryId: string | null;
  /** A tag set's tags by name (emotions, factors), drawn as chips on their own line. */
  tags?: string[];
}

export interface FocusEngine {
  model: WellnessModel;
  /** The trackers with at least one value, newest logged first, stopped ones last. */
  choices: FocusChoice[];
  byId: (id: string) => TrackerDescriptor | undefined;
  /** The tracker's name; a two-number reading is named once ("Blood Pressure"). */
  name: (d: TrackerDescriptor) => string;
  /** The tag sets' tag name, for the chip's tag picker. */
  tagName: (d: TrackerDescriptor, tag: string) => string;
  /** The entry holds the focus. An entry behind its PIN never does. */
  matches: (n: LocalNote, focus: TrackerFocus) => boolean;
  /** The entry's own value for the focus, as the row shows it. */
  badge: (n: LocalNote, focus: TrackerFocus) => FocusBadge | null;
  /** The days whose merged value holds the focus, newest first. */
  days: (focus: TrackerFocus) => FocusDay[];
  /** The marks of one day for the trackers the Calendar shows, in that order. */
  marks: (day: string, ids: readonly string[]) => DayMark[];
}

export function buildFocusEngine({ notes, isGated, trackerSettings, medications, factors, rangeId, t }: {
  notes: LocalNote[];
  isGated: (n: LocalNote) => boolean;
  trackerSettings: TrackerSettings;
  medications: MedicationTemplate[];
  factors: FactorDef[];
  rangeId: RangeId;
  t: TFunction;
}): FocusEngine {
  const model = buildWellnessModel(notes, isGated, trackerSettings, medications, rangeId, factors);
  const byId = model.byId;
  // Directions learned from mood, once per tracker that has no known one.
  const dirs = new Map<string, 1 | -1 | 0>();
  const dirOf = (d: TrackerDescriptor) => {
    if (d.source !== 'custom' && d.kind !== 'yesno') return 0;
    let dir = dirs.get(d.id);
    if (dir === undefined) {
      dir = learnedDirection(model, d);
      dirs.set(d.id, dir);
    }
    return dir;
  };
  const toneOf = (d: TrackerDescriptor, v: TrackerValue | undefined): PillTone =>
    dayTone(d, v, model.seriesOf(d), dirOf(d));

  const name = (d: TrackerDescriptor): string => {
    const pair = partnerOf(d.id);
    if (pair && d.source === 'builtin') return t('trackers:labels.bloodPressure');
    if (pair && d.name) return d.name;
    return trackerName(d, t);
  };

  const text = (d: TrackerDescriptor, v: TrackerValue, data: JournalTrackerData, focus?: TrackerFocus): string => {
    const pair = partnerOf(d.id);
    const other = pair ? byId(pair.other) : undefined;
    if (pair && other && typeof v === 'number') {
      const w = other.read(data);
      if (typeof w === 'number') {
        const [a, b] = pair.first ? [v, w] : [w, v];
        const second = pair.first ? other : d;
        return `${formatNumber(a, 0)}/${second.unit ? formatValue(second, b, t) : formatNumber(b, 1)}`;
      }
    }
    if (Array.isArray(v) && focus?.tag && focus.answer !== 'any') return levelLabel(d, focus.tag, t);
    return formatPoint(d, v, t);
  };

  const entryValue = (n: LocalNote, d: TrackerDescriptor) => {
    const data = n.trackers as JournalTrackerData | undefined;
    return data ? d.read(data) : undefined;
  };

  const entryOn = new Map(model.entries.map((e) => [e.date, e] as const));
  // The entry a Calendar day's marks open: the newest one of the day that
  // holds tracker values, behind no PIN.
  const entryIdOn = new Map<string, { id: string; at: string }>();
  for (const n of notes) {
    if (n.type !== 'journal' || n.deleted === 1 || n.trashed === 1 || !n.trackers || isGated(n)) continue;
    const day = entryDayOf(n);
    const had = entryIdOn.get(day);
    if (!had || n.createdAt > had.at) entryIdOn.set(day, { id: n.id, at: n.createdAt });
  }
  const choices: FocusChoice[] = [];
  for (const d of model.registry) {
    let last: string | null = null;
    for (let i = model.entries.length - 1; i >= 0; i--) {
      const e = model.entries[i]!;
      if (matchesValue(d.read(e.data), { id: d.id, answer: 'any' })) {
        last = e.date;
        break;
      }
    }
    // A two-number reading is offered once, by its first number.
    const pair = partnerOf(d.id);
    if (last && (!pair || pair.first)) choices.push({ d, last, stopped: !visibleInUi(d) });
  }
  choices.sort((a, b) => (a.stopped !== b.stopped ? (a.stopped ? 1 : -1) : a.last < b.last ? 1 : a.last > b.last ? -1 : 0));

  return {
    model,
    choices,
    byId,
    name,
    tagName: (d, tag) => levelLabel(d, tag, t),
    matches: (n, focus) => {
      if (n.type !== 'journal' || isGated(n)) return false;
      const d = byId(focus.id);
      return !!d && matchesValue(entryValue(n, d), focus);
    },
    badge: (n, focus) => {
      const d = byId(focus.id);
      if (!d || n.type !== 'journal' || isGated(n)) return null;
      const v = entryValue(n, d);
      if (!matchesValue(v, focus) || v === undefined) return null;
      return { text: text(d, v, n.trackers as JournalTrackerData, focus), tone: toneOf(d, v) };
    },
    days: (focus) => {
      const d = byId(focus.id);
      if (!d) return [];
      const out: FocusDay[] = [];
      for (let i = model.entries.length - 1; i >= 0; i--) {
        const e = model.entries[i]!;
        const v = d.read(e.data);
        if (!matchesValue(v, focus)) continue;
        const tone = toneOf(d, v);
        out.push({ date: e.date, tone, paint: tonePaint(tone, d.color) });
      }
      return out;
    },
    marks: (day, ids) => {
      const e = entryOn.get(day);
      if (!e) return [];
      const out: DayMark[] = [];
      for (const id of ids) {
        const d = byId(id);
        if (!d) continue;
        const v = d.read(e.data);
        if (!matchesValue(v, { id, answer: 'yes' })) continue;
        const tone = toneOf(d, v);
        out.push({
          id, d, name: name(d), text: text(d, v!, e.data), tone, paint: tonePaint(tone, d.color), entryId: entryIdOn.get(day)?.id ?? null,
          ...(Array.isArray(v) ? { tags: v.map((tag) => levelLabel(d, String(tag), t)) } : {}),
        });
      }
      return out;
    },
  };
}
