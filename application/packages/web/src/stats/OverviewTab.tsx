import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalNote } from '../db';
import type { Stats } from '../stats';
import { NO_FACTORS, type FactorDef, type MedicationTemplate, type TrackerSettings } from '../trackerTypes';
import { computeTrackerStats } from '../trackerStats';
import { SectionEyebrow } from '../settingsUI';
import { Bell, CalendarBlank, CaretRight, ChartBar, ChartLineUp, Clock, Fire, Flag, NotePencil, PencilSimple, Plus, Pulse, SquaresFour, Tag } from '../icons';
import { formatDay, formatInstant } from '../intlFormat';
import { toLocalIso } from '../notesViewUtils';
import { milestoneLabel, milestoneProgress } from '../milestones';
import { aggregate, buildSeries, previousWindow } from '../trackerSeries';
import { intlLocale } from '../languages';
import { occurrencesOf, scheduleOf } from '../schedule';
import { MoodMark } from '../moodMark';
import { checkInStreak, moodWord } from '../checkIn';
import { PALETTE } from '../editorColors';
import { buildWellnessModel, formatDelta } from './wellnessModel';
import { StatPill } from './statsParts';
import { CheckInStreakTile, RhythmHeatmap, RHYTHM_WEEKS, WeekTiles, WritingStreakTile, shiftDay as shift, useLedger, useLedgerNote } from './overviewParts';

const HOURS_DAYS = 30;
/** How many growing tags the list names. */
const TAGS_MAX = 3;
/** Each pillar's name, the key the sidebar already shows. */
const PILLAR_LABEL: Record<string, string> = {
  notes: 'shell:tagsRail.notes',
  journals: 'overview.pillars.journals',
  tasks: 'shell:tagsRail.tasks',
  files: 'shell:tagsRail.files',
  bookmarks: 'shell:tagsRail.bookmarks',
  contacts: 'shell:tagsRail.contacts',
  logins: 'notes:vaultFilter.logins',
};

/**
 * The Overview tab, for every kind of user: today, this week against the
 * week before, the streaks, the writing rhythm, the counts per kind, the
 * growing tags, the next milestones, and one card that leads to Trackers.
 * Spec: docs/internal/specs/wellness-statistics.md (section 22)
 */
export function OverviewTab({ notes, stats, isNoteLocked, trackerSettings, factors = NO_FACTORS, medications, notesCreated, firstSeenAt, onOpenTrackers }: {
  notes: LocalNote[];
  stats: Stats;
  isNoteLocked: (n: LocalNote) => boolean;
  trackerSettings: TrackerSettings;
  factors?: FactorDef[];
  medications: MedicationTemplate[];
  notesCreated: number;
  firstSeenAt: string | null;
  onOpenTrackers: () => void;
}) {
  const { t } = useTranslation('stats');
  const today = toLocalIso(new Date());
  const weekFrom = shift(today, -6);
  const fmt = (n: number) => n.toLocaleString(intlLocale());

  const month = useMemo(() => buildWellnessModel(notes, isNoteLocked, trackerSettings, medications, '30d', factors), [notes, isNoteLocked, trackerSettings, medications, factors]);
  const tStats = useMemo(() => computeTrackerStats(notes, medications, isNoteLocked), [notes, medications, isNoteLocked]);

  const ledger = useLedger(notes);
  const ledgerByDay = useMemo(() => new Map((ledger?.rows ?? []).map((r) => [r.date, r])), [ledger]);
  const wordsOn = (d: string) => Math.max(0, ledgerByDay.get(d)?.words ?? 0);

  const live = useMemo(() => notes.filter((n) => n.deleted === 0 && n.trashed === 0 && !isNoteLocked(n)), [notes, isNoteLocked]);
  const dayOf = (iso: string | number) => toLocalIso(new Date(iso));

  // Today: what changed, and what the calendar holds.
  const todayBlock = useMemo(() => {
    let edited = 0, created = 0, lastEdit = 0, scheduled = 0;
    let next: { title: string; time: string } | null = null;
    const nowTime = new Date().toTimeString().slice(0, 5);
    for (const n of live) {
      const updated = new Date(n.updatedAt).getTime();
      if (dayOf(n.updatedAt) === today) edited++;
      if (dayOf(n.createdAt) === today) created++;
      if (updated > lastEdit) lastEdit = updated;
      if (n.type === 'journal') continue;
      const s = scheduleOf(n.trackers as Record<string, unknown> | undefined, n.type);
      if (!s || occurrencesOf(s.day, s.repeat, today, today).length === 0) continue;
      scheduled++;
      if (s.time && s.time >= nowTime && (!next || s.time < next.time)) next = { title: n.title || t('common:state.untitled'), time: s.time };
    }
    return { edited, created, lastEdit, scheduled, next };
  }, [live, today, t]);

  const mood = month.byId('mood');
  const todayMood = mood ? month.seriesOf(mood).points.find((p) => p.date === today)?.value : undefined;

  const tracks = month.entries.length > 0;

  // Edits by hour over the last 30 days, from the ledger.
  const hours = useMemo(() => {
    const sums = new Array<number>(24).fill(0);
    for (const r of ledger?.rows ?? []) r.hours.forEach((h, i) => { sums[i] = (sums[i] ?? 0) + h; });
    return sums;
  }, [ledger]);
  const hoursTotal = hours.reduce((a, b) => a + b, 0);
  const peak = useMemo(() => {
    let best = 0, bestAt = 0;
    for (let i = 0; i < 24; i++) {
      const s = (hours[i] ?? 0) + (hours[(i + 1) % 24] ?? 0) + (hours[(i + 2) % 24] ?? 0);
      if (s > best) { best = s; bestAt = i; }
    }
    return { from: bestAt, to: (bestAt + 3) % 24 };
  }, [hours]);
  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;

  const pillars = useMemo(() => {
    const count = (type: string) => live.filter((n) => n.type === type);
    const fresh = (xs: LocalNote[]) => xs.filter((n) => dayOf(n.createdAt) >= weekFrom).length;
    return (['note', 'journal', 'task', 'file', 'bookmark', 'contact', 'login'] as const)
      .map((type) => ({ key: type === 'note' ? 'notes' : type === 'login' ? 'logins' : `${type}s`, xs: count(type) }))
      .map(({ key, xs }) => ({ key, n: xs.length, sub: fresh(xs) }))
      .filter((p) => p.n > 0);
  }, [live, weekFrom]);

  // Tags used on more items made this month than the month before.
  const tags = useMemo(() => {
    const now = new Map<string, number>(); const before = new Map<string, number>();
    const monthFrom = shift(today, -29); const prevFrom = shift(today, -59);
    for (const n of live) {
      const day = dayOf(n.createdAt);
      const bucket = day >= monthFrom ? now : day >= prevFrom ? before : null;
      if (!bucket) continue;
      for (const tag of n.tags) bucket.set(tag, (bucket.get(tag) ?? 0) + 1);
    }
    return [...now].map(([tag, c]) => ({ tag, c, b: before.get(tag) ?? 0, grew: c - (before.get(tag) ?? 0) })).filter((x) => x.grew > 0).sort((a, b) => b.grew - a.grew).slice(0, TAGS_MAX);
  }, [live, today]);

  const meters = useMemo(() => milestoneProgress(stats, notesCreated, firstSeenAt), [stats, notesCreated, firstSeenAt]);

  // The trackers card: the month's average mood and its change.
  const moodAgg = mood ? aggregate(month.seriesOf(mood), mood) : null;
  const moodAvg = moodAgg?.kind === 'numeric' ? moodAgg.avg : null;
  const moodBefore = mood ? aggregate(buildSeries(month.entries, mood, previousWindow(month.range)), mood) : null;
  const moodDelta = moodAvg !== null && moodBefore?.kind === 'numeric' && moodBefore.avg !== null && moodBefore.n >= 3 ? moodAvg - moodBefore.avg : null;
  // The check-in card's own rule: any logged tracker keeps the run, mood or not.
  const checkIns = useMemo(() => checkInStreak(notes, today, isNoteLocked), [notes, today, isNoteLocked]);

  const ledgerNote = useLedgerNote(ledger);

  return (
    <>
      <div data-setting="stats.overview" className="rounded-xl border border-divider bg-surface-2 p-3 space-y-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="inline-flex w-8 h-8 items-center justify-center rounded-md bg-accent/10 text-accent"><CalendarBlank /></span>
          <div className="min-w-0">
            <p className="text-body font-semibold text-pn">{t('overview.today', { date: formatDay(today, 'weekdayDate') })}</p>
            {todayBlock.lastEdit > 0 && <p className="text-meta text-pn-muted">{t('overview.lastEdit', { time: formatInstant(new Date(todayBlock.lastEdit), dayOf(todayBlock.lastEdit) === today ? 'time' : 'dateTime') })}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ledger?.since && <StatPill icon={<PencilSimple aria-hidden="true" />}>{t('overview.wordsToday', { count: wordsOn(today), formatted: fmt(wordsOn(today)) })}</StatPill>}
          <StatPill icon={<NotePencil aria-hidden="true" />} muted={todayBlock.edited === 0}>{t('overview.edited', { count: todayBlock.edited })}</StatPill>
          {todayBlock.created > 0 && <StatPill icon={<Plus aria-hidden="true" />}>{t('overview.created', { count: todayBlock.created })}</StatPill>}
          {todayBlock.scheduled > 0 && <StatPill icon={<CalendarBlank aria-hidden="true" />} muted>{t('overview.scheduled', { count: todayBlock.scheduled })}</StatPill>}
          {todayBlock.next && <StatPill icon={<Bell aria-hidden="true" />} muted>{t('overview.next', { title: todayBlock.next.title, time: formatInstant(new Date(`${today}T${todayBlock.next.time}`), 'time') })}</StatPill>}
          {typeof todayMood === 'number' && (
            <StatPill icon={<MoodMark mood={todayMood} size={16} />}>{t('overview.checkedIn', { word: moodWord(todayMood) })}</StatPill>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <SectionEyebrow icon={ChartLineUp}>{t('overview.thisWeek')}</SectionEyebrow>
          <span className="hidden sm:inline text-small text-pn-muted">{t('overview.thisWeekHint')}</span>
        </div>
        <WeekTiles stats={stats} live={live} month={month} ledger={ledger} gridClass="grid-cols-2 sm:grid-cols-4" />
      </div>

      <div>
        <SectionEyebrow className="mb-2" icon={Fire}>{t('overview.streaks')}</SectionEyebrow>
        <div className={`grid grid-cols-1 gap-2 ${tracks ? 'sm:grid-cols-2' : ''}`}>
          <div data-setting="stats.streak" className="min-w-0">
            <WritingStreakTile stats={stats} />
          </div>
          {tracks && <CheckInStreakTile run={checkIns.run} week={checkIns.week} />}
        </div>
      </div>

      <div>
        <RhythmHeatmap
          heatmap={stats.heatmap}
          moodHeatmap={tStats.moodHeatmap}
          tracks={tracks}
          header={(layerSwitch) => (
            <div className="flex items-center justify-between mb-2 gap-2">
              <SectionEyebrow icon={SquaresFour}>{t('overview.rhythm', { weeks: RHYTHM_WEEKS })}</SectionEyebrow>
              {layerSwitch}
            </div>
          )}
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2 gap-2">
          <SectionEyebrow icon={Clock}>{t('overview.hours')}</SectionEyebrow>
          <span className="text-small text-pn-muted">{t('overview.hoursSub', { days: HOURS_DAYS })}</span>
        </div>
        {hoursTotal === 0 ? (
          <p className="text-small text-pn-muted">{ledgerNote}</p>
        ) : (
          <div dir="ltr">
            <svg viewBox="0 0 600 54" width="100%" style={{ display: 'block' }} aria-label={t('overview.hours')} role="img">
              {hours.map((v, i) => {
                const h = Math.max(2, (v / Math.max(...hours, 1)) * 40);
                const inPeak = ((i - peak.from + 24) % 24) < 3;
                return <rect key={i} x={i * 25 + 2} y={42 - h} width={21} height={h} rx={2} fill={PALETTE.blue} fillOpacity={inPeak ? 1 : 0.45} />;
              })}
              {[0, 6, 12, 18, 23].map((h) => (
                // The last label ends at the chart's edge, so it is never cut off.
                <text key={h} x={h === 23 ? 598 : h * 25 + 2} y={53} textAnchor={h === 23 ? 'end' : 'start'} fontSize={9} fill="currentColor" opacity={0.6}>{hour(h)}</text>
              ))}
            </svg>
            <p className="text-small text-pn-muted mt-1">{t('overview.hoursPeak', { from: hour(peak.from), to: hour(peak.to) })}</p>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionEyebrow icon={ChartBar}>{t('overview.keep')}</SectionEyebrow>
          <span className="text-small text-pn-muted">{t('overview.keepSub')}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {pillars.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-divider bg-surface-2 text-small">
              {t(PILLAR_LABEL[p.key]!)} <span className="font-semibold tabular-nums">{fmt(p.n)}</span>
              {p.sub > 0 && <span className="text-meta text-success">+{fmt(p.sub)}</span>}
            </span>
          ))}
        </div>
      </div>

      {tags.length > 0 && (
        <div>
          <SectionEyebrow className="mb-2" icon={Tag}>{t('overview.growingTags')}</SectionEyebrow>
          <div className="rounded-lg border border-divider bg-surface-2 px-3 py-2 space-y-2">
            {tags.map((x) => {
              const top = Math.max(...tags.map((y) => y.c), 1);
              return (
                <div key={x.tag} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3">
                  <span title={`#${x.tag}`} className="justify-self-start inline-flex max-w-full items-center text-meta px-1.5 py-0.5 rounded pn-chip text-accent-strong">
                    <span className="truncate" dir="auto">#{x.tag}</span>
                  </span>
                  {/* Items with the tag this month, on one scale for every row. */}
                  <span aria-hidden="true" className="block h-1.5 rounded-full bg-accent-fill" style={{ width: `${(x.c / top) * 100}%` }} />
                  <span className="text-small font-semibold tabular-nums text-success">+{fmt(x.grew)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div data-setting="stats.milestones">
        <SectionEyebrow className="mb-2" icon={Flag}>{t('stats:milestones.heading')}</SectionEyebrow>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {meters.filter((row) => row.next !== null).map((row) => (
            <div key={row.family} className="rounded-lg border border-divider bg-surface-2 px-3 py-2.5">
              <p className="text-small text-pn-muted truncate">{t('milestones.next', { label: milestoneLabel(row.family, row.next!) })}</p>
              <p className="text-title font-semibold tabular-nums">{t('milestones.ofTarget', { current: fmt(row.current), target: fmt(row.next!) })}</p>
              <div className="mt-1.5 h-1.5 rounded-full bg-surface-0 overflow-hidden"><div className="h-full rounded-full bg-accent-fill" style={{ width: `${Math.round(row.progress * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      </div>

      {tracks && moodAvg !== null && (
        <div>
          <SectionEyebrow className="mb-2" icon={Pulse}>{t('notes:settings.trackersLabel')}</SectionEyebrow>
          <div className="rounded-lg border border-divider bg-surface-2 hover:border-pn-muted transition-colors">
          <button type="button" onClick={onOpenTrackers} className="w-full flex items-center gap-3 px-3 py-2.5 text-start min-w-0">
            <MoodMark mood={Math.round(moodAvg * 10) / 10} size={36} />
            <span className="flex-1 min-w-0">
              <span className="block text-body font-semibold text-pn">{t('overview.moodMonth', { word: moodWord(Math.round(moodAvg)) })}</span>
              {moodDelta !== null && <span className={`block text-meta ${moodDelta >= 0 ? 'text-success' : 'text-danger'}`}>{t('home.delta', { delta: formatDelta(moodDelta) })}</span>}
            </span>
            <CaretRight className="shrink-0 text-pn-muted" aria-hidden="true" />
          </button>
          </div>
        </div>
      )}
    </>
  );
}

