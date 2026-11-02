/**
 * The parts of the Statistics Overview that Home draws as widgets too: the
 * seven-dot row, the small bars, the change against last week, the day
 * ledger read, the four "This week" tiles, the writing streak and the
 * 26-week rhythm. One copy for both surfaces.
 * Spec: docs/internal/specs/wellness-statistics.md (section 22), docs/internal/specs/dashboard.md (section 5)
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalNote } from '../db';
import type { Stats } from '../stats';
import { SettingsSegmented, StatTile as Tile } from '../settingsUI';
import { formatDay, weekdayDate, weekdayLabel } from '../intlFormat';
import { editedAtOf, toLocalIso } from '../notesViewUtils';
import { backfillLedger, firstCountedDay, firstLedgerDay, readLedger, type LedgerRow } from '../dayLedger';
import { intlLocale } from '../languages';
import { PALETTE } from '../editorColors';
import { formatDelta, moodColor, type WellnessModel } from './wellnessModel';

export const RHYTHM_WEEKS = 26;
/** Days of ledger read: this week, the week before, and the hours window. */
const LEDGER_DAYS = 30;

export function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalIso(d);
}

const dayOf = (iso: string | number) => toLocalIso(new Date(iso));
const fmt = (n: number) => n.toLocaleString(intlLocale());
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function DotRow({ days, color }: { days: boolean[]; color: string }) {
  return (
    <svg viewBox={`0 0 ${days.length * 17} 14`} className="mt-1 block h-auto w-full" style={{ maxWidth: days.length * 17, color: 'var(--color-pn-muted, currentColor)' }} aria-hidden="true">
      {days.map((on, i) => (
        <circle key={i} cx={8 + i * 17} cy={7} r={5} fill={on ? color : 'none'} stroke={on ? 'none' : 'currentColor'} strokeOpacity={0.5} strokeWidth={1} />
      ))}
    </svg>
  );
}

function MiniBars({ values, color }: { values: (number | null)[]; color: string }) {
  const w = values.length * 17;
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  return (
    <svg viewBox={`0 0 ${w} 28`} className="mt-1 block h-auto w-full" style={{ maxWidth: w }} aria-hidden="true">
      {values.map((v, i) => {
        if (v === null) return null;
        const h = Math.max(2, (v / max) * 26);
        return <rect key={i} x={i * 17 + 2} y={28 - h} width={13} height={h} rx={2} fill={color} fillOpacity={i === values.length - 1 ? 1 : 0.6} />;
      })}
    </svg>
  );
}

/** "+18%" or "-2" against last week, in the tone of the change. */
function VsLastWeek({ now, before, percent = false }: { now: number; before: number; percent?: boolean }) {
  const { t } = useTranslation('stats');
  if (percent && before === 0) return null;
  const delta = percent ? Math.round(((now - before) / before) * 100) : now - before;
  const text = percent ? `${delta >= 0 ? '+' : '-'}${Math.abs(delta)}%` : formatDelta(delta, 0);
  return <span className={delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : ''}>{t('overview.vsLastWeek', { delta: text })}</span>;
}

export interface Ledger {
  rows: LedgerRow[];
  /** The first day the ledger holds, estimated or not. */
  since: string | null;
  /** The first day counted at the keyboard, the only day "Counted on this
   *  device since" may name. */
  counted: string | null;
  estimated: boolean;
}

/**
 * The last 30 days of the day ledger. An empty ledger is estimated once from
 * the notes' own stamps, so the blocks show something on the first day.
 * Null while it loads.
 */
export function useLedger(notes: LocalNote[]): Ledger | null {
  const today = toLocalIso(new Date());
  const [ledger, setLedger] = useState<Ledger | null>(null);
  // Read again after a save: a page that stays open (Home) shows the words
  // just written. A read is 30 rows; the estimate runs once per device.
  // editedAt: a body edit moves it, and not always updatedAt.
  const lastSave = useMemo(() => notes.reduce((m, n) => { const at = editedAtOf(n); return at > m ? at : m; }, ''), [notes]);
  useEffect(() => {
    let alive = true;
    void backfillLedger(notes)
      .catch(() => false)
      .then(() => Promise.all([readLedger(shiftDay(today, -LEDGER_DAYS + 1), today), firstLedgerDay(), firstCountedDay()]))
      .then(([rows, since, counted]) => { if (alive) setLedger({ rows, since, counted, estimated: rows.some((r) => r.estimated) }); })
      // A database that cannot be read leaves the ledger blocks empty.
      .catch(() => { if (alive) setLedger({ rows: [], since: null, counted: null, estimated: false }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today, notes.length, lastSave]);
  return ledger;
}

/** The line that says where the ledger's numbers come from. */
export function useLedgerNote(ledger: Ledger | null): string {
  const { t } = useTranslation('stats');
  return ledger?.estimated ? t('overview.ledgerEstimated') : ledger?.counted ? t('overview.ledgerSince', { date: formatDay(ledger.counted, 'date') }) : t('overview.ledgerEmpty');
}

/** The seven days ending today, and the seven before them. */
function weekWindows(today: string) {
  const weekFrom = shiftDay(today, -6);
  const prevFrom = shiftDay(today, -13);
  return {
    weekFrom,
    weekDays: Array.from({ length: 7 }, (_, i) => shiftDay(weekFrom, i)),
    prevDays: Array.from({ length: 7 }, (_, i) => shiftDay(prevFrom, i)),
  };
}

/**
 * The four "This week" tiles: words, active days, items created, and the
 * check-ins (or the tag count for a person who logs none). `live` is the
 * notes the counts read, gated ones left out by the caller.
 */
export function WeekTiles({ stats, live, month, ledger, gridClass }: {
  stats: Stats;
  live: LocalNote[];
  month: WellnessModel;
  ledger: Ledger | null;
  /** The grid's column classes: the Overview follows the window, a Home tile its own width. */
  gridClass: string;
}) {
  const { t } = useTranslation('stats');
  const today = toLocalIso(new Date());
  const { weekDays, prevDays } = weekWindows(today);
  const ledgerNote = useLedgerNote(ledger);
  const byDay = useMemo(() => new Map((ledger?.rows ?? []).map((r) => [r.date, r])), [ledger]);
  const wordsOn = (d: string) => Math.max(0, byDay.get(d)?.words ?? 0);
  // One pass over the items for both weeks, not one per day: a page that
  // stays open (Home) draws this on every render of the shell.
  const createdByDay = useMemo(() => {
    const out = new Map<string, number>();
    for (const n of live) if (n.type !== 'journal') { const d = dayOf(n.createdAt); out.set(d, (out.get(d) ?? 0) + 1); }
    return out;
  }, [live]);
  const checkInDays = useMemo(() => new Set(month.entries.map((e) => e.date)), [month.entries]);
  const createdPerDay = (days: string[]) => days.map((d) => createdByDay.get(d) ?? 0);
  const activePerDay = (days: string[]) => days.map((d) => ((stats.heatmap[d] ?? 0) > 0 ? 1 : 0));
  const checkInPerDay = (days: string[]) => days.map((d) => (checkInDays.has(d) ? 1 : 0));
  const tracks = month.entries.length > 0;
  const wordsWeek = weekDays.map(wordsOn);
  const wordsPrev = prevDays.map(wordsOn);
  return (
    <div className={`grid gap-2 ${gridClass}`}>
      <Tile label={t('overview.words')} value={ledger?.since ? fmt(sum(wordsWeek)) : '-'} sub={ledger?.since ? <VsLastWeek now={sum(wordsWeek)} before={sum(wordsPrev)} percent /> : ledgerNote}>
        {ledger?.since && <MiniBars values={wordsWeek} color="#10b981" />}
      </Tile>
      <Tile label={t('overview.activeDays')} value={t('overview.daysLoggedOf', { logged: sum(activePerDay(weekDays)), days: 7 })} sub={<VsLastWeek now={sum(activePerDay(weekDays))} before={sum(activePerDay(prevDays))} />}>
        <DotRow days={activePerDay(weekDays).map(Boolean)} color="#10b981" />
      </Tile>
      <Tile label={t('overview.notesCreated')} value={fmt(sum(createdPerDay(weekDays)))} sub={<VsLastWeek now={sum(createdPerDay(weekDays))} before={sum(createdPerDay(prevDays))} />}>
        <MiniBars values={createdPerDay(weekDays)} color={PALETTE.blue} />
      </Tile>
      {tracks ? (
        <Tile label={t('overview.checkIns')} value={t('overview.daysLoggedOf', { logged: sum(checkInPerDay(weekDays)), days: 7 })} sub={<VsLastWeek now={sum(checkInPerDay(weekDays))} before={sum(checkInPerDay(prevDays))} />}>
          <DotRow days={checkInPerDay(weekDays).map(Boolean)} color={PALETTE.blue} />
        </Tile>
      ) : (
        <Tile label={t('writing.tags')} value={fmt(stats.uniqueTags)} />
      )}
    </div>
  );
}

/** The writing streak, the longest one, and this week's seven dots. */
export function WritingStreakTile({ stats, bare = false }: { stats: Stats; bare?: boolean }) {
  const { t } = useTranslation('stats');
  const today = toLocalIso(new Date());
  const { weekDays } = weekWindows(today);
  return (
    <Tile bare={bare} label={t('overview.streak')} value={t('stats:wellness.units.days', { count: stats.currentStreak })} sub={`${(stats.heatmap[today] ?? 0) > 0 ? t('overview.streakKept') : t('overview.streakNudge')} ${t('overview.longestStreak', { count: stats.longestStreak })}`}>
      <DotRow days={weekDays.map((d) => (stats.heatmap[d] ?? 0) > 0)} color="#10b981" />
    </Tile>
  );
}

/** The check-in streak and this week's seven dots. */
export function CheckInStreakTile({ run, week, bare = false }: { run: number; week: boolean[]; bare?: boolean }) {
  const { t } = useTranslation('stats');
  return (
    <Tile bare={bare} label={t('overview.checkInStreak')} value={t('stats:wellness.units.days', { count: run })}>
      <DotRow days={week} color={PALETTE.blue} />
    </Tile>
  );
}

/**
 * The rhythm grid: one column per week, Monday first, ending this week. The
 * cell is how much was written that day, the dot the mood of the day. The
 * layer switch shows when there are moods to show; `header` places it.
 */
export function RhythmHeatmap({ heatmap, moodHeatmap, tracks, header, fit = false }: {
  heatmap: Stats['heatmap'];
  moodHeatmap: Record<string, number>;
  tracks: boolean;
  /** Fit the box it sits in (a Home card): the weeks shrink to the height
   *  left, centred, instead of growing with the width. */
  fit?: boolean;
  /** Draws the section head with the layer switch in it. */
  header: (layerSwitch: React.ReactNode) => React.ReactNode;
}) {
  const { t } = useTranslation('stats');
  const today = toLocalIso(new Date());
  const rhythm = useMemo(() => {
    const end = new Date(`${today}T12:00:00`);
    const dow = (end.getDay() + 6) % 7;
    const last = shiftDay(today, 6 - dow);
    const first = shiftDay(last, -(RHYTHM_WEEKS * 7 - 1));
    const cells: { date: string; edits: number; mood: number | null; future: boolean }[] = [];
    for (let i = 0; i < RHYTHM_WEEKS * 7; i++) {
      const date = shiftDay(first, i);
      cells.push({ date, edits: heatmap[date] ?? 0, mood: moodHeatmap[date] ?? null, future: date > today });
    }
    return { first, cells };
  }, [heatmap, moodHeatmap, today]);
  const [layer, setLayer] = useState<'both' | 'writing' | 'mood'>('both');
  const maxEdits = Math.max(1, ...rhythm.cells.map((c) => c.edits));
  const layerSwitch = tracks ? (
    <SettingsSegmented
      label={t('overview.rhythm', { weeks: RHYTHM_WEEKS })}
      value={layer}
      onChange={setLayer}
      options={(['both', 'writing', 'mood'] as const).map((l) => ({ value: l, label: t(l === 'both' ? 'overview.layerBoth' : l === 'writing' ? 'stats:tabs.writing' : 'stats:wellness.mood.heading') }))}
    />
  ) : null;
  const body = (
    <>
      {header(layerSwitch)}
      <div dir="ltr" className={fit ? 'min-h-0 flex-1' : undefined}>
        <svg viewBox={`0 0 ${RHYTHM_WEEKS * 15 + 16} 112`} width="100%" height={fit ? '100%' : undefined} role="img" aria-label={t('overview.rhythmLegend')} style={{ display: 'block' }}>
          {/* Rows run Monday first, so rows 0, 2 and 4 are Monday, Wednesday and Friday (0 = Sunday). */}
          {[1, 3, 5].map((wd, i) => (
            <text key={wd} x={2} y={i * 30 + 12} fontSize={9} fill="currentColor" opacity={0.6}>{weekdayLabel(weekdayDate(wd), 'narrow')}</text>
          ))}
          {rhythm.cells.map((c, i) => {
            const x = 16 + Math.floor(i / 7) * 15;
            const y = (i % 7) * 15;
            const level = c.edits === 0 ? 0 : Math.min(4, Math.ceil((c.edits / maxEdits) * 4));
            const fills = ['rgba(127,127,127,0.12)', '#d1fae5', '#6ee7b7', '#10b981', '#047857'];
            return (
              <g key={c.date}>
                <title>{`${formatDay(c.date, 'date')}: ${c.edits}${c.mood !== null ? `, ${c.mood}/10` : ''}`}</title>
                <rect x={x} y={y} width={13} height={13} rx={2} fill={c.future ? 'none' : layer === 'mood' ? 'rgba(127,127,127,0.12)' : fills[level]} stroke={c.future ? 'currentColor' : 'none'} strokeOpacity={0.2} />
                {tracks && layer !== 'writing' && c.mood !== null && <circle cx={x + 6.5} cy={y + 6.5} r={3} fill={moodColor(c.mood)} stroke="#fff" strokeWidth={1} />}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex justify-between gap-2 text-meta text-pn-muted mt-1">
        <span className="shrink-0 whitespace-nowrap">{formatDay(rhythm.first, 'dayMonth')}</span>
        <span className="text-end">{t('overview.rhythmLegend')}</span>
      </div>
    </>
  );
  return fit ? <div className="flex h-full flex-col">{body}</div> : body;
}
