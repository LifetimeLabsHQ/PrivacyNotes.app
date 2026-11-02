/**
 * One component per Home widget. Each draws its content only: Dashboard.tsx
 * puts it in its GridCard and owns the edit mode. Every list reads the env's
 * pool, and every memo that reads a body, a title or an excerpt keys on
 * `gatedKey` too, so a PIN window that closes hides the content at once.
 * Spec: docs/internal/specs/dashboard.md (section 5)
 */
import { createContext, lazy, Suspense, useContext, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalNote } from '../db';
import NoteRow from '../NoteRow';
import { Button, EmptyState, ProgressBar, TaskCheckbox } from '../ui';
import { Cake, CalendarDots, CheckFat, FileImage, FileText, NotePencil } from '../icons';
import type { DayKind } from '../notesViewUtils';
import { editedAtOf, entryDayOf, journalOn, stripToPlainText, toLocalIso } from '../notesViewUtils';
import type { TaskItem } from '../tasks';
import { contactBirthday, contactDisplayName, parseContactBody } from '../contactBody';
import { computeStats, type Stats } from '../stats';
import { milestoneLabel, milestoneProgress } from '../milestones';
import { folderScope } from '../folders';
import { capitalize, formatDay, formatInstant, relativeDayName } from '../intlFormat';
import { intlLocale } from '../languages';
import { MARKDOWN_NOTE_TYPES } from '../noteTypes';
import { StatTile } from '../settingsUI';
import { checkInStreak } from '../checkIn';
import { computeTrackerStats } from '../trackerStats';
import { visibleInUi } from '../trackerRegistry';
import { TrackerChart } from '../TrackerChart';
import { buildWellnessModel, hasData, trackerName, type WellnessModel } from '../stats/wellnessModel';
import { cardNumbers, chartSpecFor } from '../stats/TrackerCard';
import { Change, changeOf, loggedSpan } from '../stats/StatsPage';
import { WeekRecap } from '../stats/WeekRecap';
import { CheckInStreakTile, RhythmHeatmap, WeekTiles, WritingStreakTile, shiftDay, useLedger } from '../stats/overviewParts';
import type { ListPrefs } from '../listPrefs';
import { useDashboardEnv } from './env';
import { useElementHeight } from '../useElementSize';
import { ItemList, useItemList } from '../itemList';

const NotePreview = lazy(() => import('./NotePreview'));

/** A plain row in a widget: an item, an event, a file; its glyph first. */
const ROW_BUTTON = 'flex w-full min-w-0 gap-2 rounded-md px-1 py-0.5 text-start text-compact text-pn hover:bg-pn/5 transition';

/** Most rows a list widget hands to the page; what shows is what fits its box. */
const MAX_ROWS = 30;
/** Below this height a tracker draws its sparkline, above it the chart. */
const CHART_MIN = 80;
const fmt = (n: number) => n.toLocaleString(intlLocale());

/** The rows a widget draws: one line each, the title with its icon and
 *  flags; no preview, no chips, no date. */
function useRowPrefs(): ListPrefs {
  const { listPrefs } = useDashboardEnv();
  return useMemo(() => ({ ...listPrefs, showPreview: false, longPreview: false, showTags: false, showDate: false }), [listPrefs]);
}

/**
 * Show only the rows that fit the card: a row that would cross the bottom of
 * the card's box (GridCard's `data-card-body`), and every row after it, is
 * hidden, so a card never ends in half a row and a hidden row takes no Tab
 * stop. A day label left with no row under it hides too (`data-fit-label`).
 * When rows were hidden, the room left under the last one is shared out as
 * padding over the rows that show, so the list ends on the card's edge. It
 * runs again when the box's height or the rows change.
 */
function useFitRows(): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const box = el.closest<HTMLElement>('[data-card-body]') ?? el;
    const fit = () => {
      const rows = [...el.children] as HTMLElement[];
      for (const row of rows) {
        row.style.visibility = '';
        row.style.paddingBlock = '';
      }
      const bottom = box.getBoundingClientRect().bottom + 0.5;
      let cut = false;
      for (const row of rows) {
        cut ||= row.getBoundingClientRect().bottom > bottom;
        if (cut) row.style.visibility = 'hidden';
      }
      const shown = rows.filter((row) => row.style.visibility !== 'hidden');
      const last = shown.at(-1);
      if (last && last.dataset.fitLabel !== undefined) {
        last.style.visibility = 'hidden';
        shown.pop();
      }
      const end = shown.at(-1)?.getBoundingClientRect().bottom;
      if (!cut || end === undefined) return;
      const share = (bottom - 0.5 - end) / shown.length / 2;
      if (share <= 0) return;
      for (const row of shown) {
        const cs = getComputedStyle(row);
        row.style.paddingBlock = `${parseFloat(cs.paddingTop) + share}px ${parseFloat(cs.paddingBottom) + share}px`;
      }
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    // A pane dragged wider changes the widths only: the rows are one line
    // each and the card's height is the layout's, so only a new height
    // measures again.
    const heights = new Map<Element, number>();
    const ro = new ResizeObserver((entries) => {
      let taller = false;
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (heights.get(entry.target) !== h) taller = true;
        heights.set(entry.target, h);
      }
      if (taller) fit();
    });
    ro.observe(box);
    ro.observe(el);
    const mo = new MutationObserver(fit);
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [el]);
  return setEl;
}

/** A list of items as the list rows, edge to edge in the card. */
function Rows({ notes, prefs }: { notes: LocalNote[]; prefs?: ListPrefs }) {
  const env = useDashboardEnv();
  const rowPrefs = useRowPrefs();
  // The list shell, for its progressive reveal; a widget's rows are few.
  const list = useItemList([], notes.length);
  const fit = useFitRows();
  useLayoutEffect(() => fit(list.ref.current));
  return (
    <ItemList list={list} grid={false} className="-mx-3">
      {notes.slice(0, list.reveal.visible).map((n) => (
        <NoteRow
          key={n.id}
          note={n}
          isOpen={env.selectedId === n.id}
          listPrefs={prefs ?? rowPrefs}
          isNoteLocked={env.isNoteLocked(n)}
          onClick={() => env.open(n.id)}
        />
      ))}
    </ItemList>
  );
}

/** Nothing to show: said in the middle of the card. */
function Empty({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState compact>{children}</EmptyState>
    </div>
  );
}

const byEdited = (a: LocalNote, b: LocalNote) => editedAtOf(b).localeCompare(editedAtOf(a));

export function RecentWidget() {
  const { t } = useTranslation('shell');
  const { pool } = useDashboardEnv();
  const notes = useMemo(() => [...pool].sort(byEdited).slice(0, MAX_ROWS), [pool]);
  return notes.length ? <Rows notes={notes} /> : <Empty>{t('dashboard.empty.recent')}</Empty>;
}

export function PinnedWidget() {
  const { t } = useTranslation('shell');
  const { pool } = useDashboardEnv();
  const notes = useMemo(() => pool.filter((n) => n.starred === 1).sort(byEdited).slice(0, MAX_ROWS), [pool]);
  return notes.length ? <Rows notes={notes} /> : <Empty>{t('dashboard.empty.pinned')}</Empty>;
}

export function BookmarksWidget() {
  const { t } = useTranslation('shell');
  const { pool } = useDashboardEnv();
  const notes = useMemo(
    () => pool.filter((n) => n.type === 'link').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_ROWS),
    [pool],
  );
  return notes.length ? <Rows notes={notes} /> : <Empty>{t('dashboard.empty.bookmarks')}</Empty>;
}

export function TagWidget({ tag }: { tag: string }) {
  const { t } = useTranslation('shell');
  const { pool } = useDashboardEnv();
  const notes = useMemo(() => pool.filter((n) => n.tags.includes(tag)).sort(byEdited).slice(0, MAX_ROWS), [pool, tag]);
  return notes.length ? <Rows notes={notes} /> : <Empty>{t('dashboard.empty.tag')}</Empty>;
}

export function FolderWidget({ folderId }: { folderId: string }) {
  const { t } = useTranslation('shell');
  const { pool, folders, includeSubfolders } = useDashboardEnv();
  const notes = useMemo(() => {
    const inScope = folderScope(folders, folderId, includeSubfolders);
    return pool.filter((n) => inScope(n.folderId)).sort(byEdited).slice(0, MAX_ROWS);
  }, [pool, folders, folderId, includeSubfolders]);
  return notes.length ? <Rows notes={notes} /> : <Empty>{t('dashboard.empty.folder')}</Empty>;
}

/** Journal entries of today's month and day in earlier years, newest year first. */
export function OnThisDayWidget() {
  const { t } = useTranslation('shell');
  const { pool } = useDashboardEnv();
  const today = toLocalIso(new Date());
  const notes = useMemo(() => {
    const md = today.slice(5);
    return pool
      .filter((n) => n.type === 'journal')
      .map((n) => ({ n, day: entryDayOf(n) }))
      .filter(({ day }) => day.slice(5) === md && day < today)
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, MAX_ROWS)
      .map(({ n }) => n);
  }, [pool, today]);
  return notes.length ? <Rows notes={notes} /> : <Empty>{t('dashboard.empty.onThisDay')}</Empty>;
}

/** Today's journal entry, with its first lines, or the button that starts it. */
export function TodayWidget() {
  const { t } = useTranslation('shell');
  const env = useDashboardEnv();
  const today = toLocalIso(new Date());
  // Asked of every listed item: an entry the list switches hide still exists,
  // and a second one must not be started beside it.
  const entry = useMemo(() => journalOn(env.listed, today), [env.listed, today]);
  const prefs = useMemo(() => ({ ...env.listPrefs, showPreview: true, longPreview: true, showTags: false }), [env.listPrefs]);
  // An entry the list switches hide shows as its bare row, never its lines.
  if (entry) return <Rows notes={[entry]} {...(env.pool.includes(entry) ? { prefs } : {})} />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-3">
      <Button action="create" onClick={env.startToday}>{t('dashboard.startToday')}</Button>
    </div>
  );
}

/** Unchecked checkbox lines, newest edited note first. The box completes the
 *  line through the Tasks pane's own path. */
export function TasksWidget({ tasks }: { tasks: TaskItem[] }) {
  const { t } = useTranslation('shell');
  const env = useDashboardEnv();
  const fit = useFitRows();
  const shown = tasks.slice(0, MAX_ROWS);
  if (!shown.length) return <Empty>{t('dashboard.empty.tasks')}</Empty>;
  return (
    <ul ref={fit} className="flex flex-col gap-0.5">
      {shown.map((task) => (
        <li key={`${task.noteId}:${task.lineIdx}`} className="flex items-start gap-2 min-w-0">
          <TaskCheckbox
            checked={task.checked}
            onChange={(e) => env.toggleTask(task, e.target.checked)}
            aria-label={t('tasksList.markComplete')}
            className="mt-1"
          />
          <button
            type="button"
            onClick={() => env.openTaskSource(task)}
            title={task.noteTitle}
            className={`${ROW_BUTTON} flex-col gap-0`}
          >
            <span className="block truncate">{stripToPlainText(task.text)}</span>
            <span className="block truncate text-meta text-pn-muted">{task.noteTitle}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Open tasks of the pool, newest edited note first; gated notes left out. */
export function useOpenTasks(): TaskItem[] {
  const env = useDashboardEnv();
  const { pool, isNoteLocked, gatedKey } = env;
  return useMemo(() => {
    const readable = pool.filter((n) => !isNoteLocked(n));
    // A line with nothing to read once its markdown is gone is left out.
    return env.tasksOf(readable)
      .filter((task) => !task.checked && stripToPlainText(task.text).trim() !== '')
      .sort((a, b) => b.editedAt.localeCompare(a.editedAt));
    // gatedKey: the lock predicate is a fresh function each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, gatedKey]);
}

/** A day's label in a list: Today, Tomorrow, then the date. */
function dayLabel(day: string, today: string): string {
  if (day === today) return capitalize(relativeDayName(0), intlLocale());
  if (day === shiftDay(today, 1)) return capitalize(relativeDayName(1), intlLocale());
  return formatDay(day, 'weekdayDate');
}

const KIND_GLYPH: Record<DayKind, typeof CalendarDots> = { event: CalendarDots, task: CheckFat, contact: Cake, note: NotePencil, journal: NotePencil };

function KindGlyph({ kind }: { kind: DayKind }) {
  const Glyph = KIND_GLYPH[kind];
  return <Glyph className="shrink-0 self-center text-accent" aria-hidden="true" />;
}

/** Today and the next 7 days from the calendar index, in time order. */
export function UpcomingWidget() {
  const { t } = useTranslation('shell');
  const env = useDashboardEnv();
  const fit = useFitRows();
  const today = toLocalIso(new Date());
  const days = useMemo(() => {
    const out: { day: string; entries: ReturnType<typeof env.calendarDays.entriesOf>[number][] }[] = [];
    for (let i = 0; i < 8; i++) {
      const day = shiftDay(today, i);
      const entries = env.calendarDays.entriesOf(day).filter((e) => e.kind !== 'journal');
      if (entries.length) out.push({ day, entries: [...entries].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '')) });
    }
    return out;
  }, [env.calendarDays, today]);
  if (!days.length) return <Empty>{t('dashboard.empty.upcoming')}</Empty>;
  // One flat list, a day's label as a row of its own, so the rows that fit
  // the card show and a label never stands alone at the bottom.
  let budget = MAX_ROWS;
  return (
    <ul ref={fit} className="min-w-0">
      {days.flatMap(({ day, entries }, n) => {
        if (budget <= 0) return [];
        const rows = entries.slice(0, budget);
        budget -= rows.length;
        return [
          <li key={day} data-fit-label="" className={`text-meta font-semibold text-pn-muted ${n > 0 ? 'pt-2' : ''}`}>{dayLabel(day, today)}</li>,
          ...rows.map((e) => (
            <li key={`${day}:${e.id}:${e.occurrence ?? ''}`}>
              <button
                type="button"
                onClick={() => env.openCalendarItem(e.id, e.occurrence)}
                className={`${ROW_BUTTON} items-baseline`}
              >
                <KindGlyph kind={e.kind} />
                {e.time && <span className="shrink-0 tabular-nums text-meta text-pn-muted">{formatInstant(new Date(`${day}T${e.time}`), 'time')}</span>}
                <span className="min-w-0 truncate">{e.title}</span>
              </button>
            </li>
          )),
        ];
      })}
    </ul>
  );
}

/** Contacts with a birthday in the next 30 days. */
export function BirthdaysWidget() {
  const { t } = useTranslation('shell');
  const env = useDashboardEnv();
  const fit = useFitRows();
  const today = toLocalIso(new Date());
  const rows = useMemo(() => {
    const end = shiftDay(today, 30);
    const year = Number(today.slice(0, 4));
    const out: { id: string; name: string; day: string }[] = [];
    for (const n of env.pool) {
      if (n.type !== 'contact' || env.isNoteLocked(n)) continue;
      const c = parseContactBody(n.body);
      const b = contactBirthday(c);
      if (!b) continue;
      const day = [env.birthdayIn(year, b.month, b.day), env.birthdayIn(year + 1, b.month, b.day)].find((d) => d && d >= today && d <= end);
      if (day) out.push({ id: n.id, name: contactDisplayName(n.title, c), day });
    }
    return out.sort((a, b) => a.day.localeCompare(b.day)).slice(0, MAX_ROWS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.pool, env.gatedKey, today]);
  if (!rows.length) return <Empty>{t('dashboard.empty.birthdays')}</Empty>;
  return (
    <ul ref={fit}>
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => env.open(r.id)} className={`${ROW_BUTTON} items-baseline`}>
            <Cake className="shrink-0 self-center text-accent" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            <span className="shrink-0 text-meta text-pn-muted">{dayLabel(r.day, today)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The newest pictures and files, as rows that open the note holding them. */
export function FilesWidget() {
  const { t } = useTranslation('shell');
  const env = useDashboardEnv();
  const fit = useFitRows();
  const files = useMemo(
    () => env.fileItemsOf(env.pool.filter((n) => !env.isNoteLocked(n))).slice(0, MAX_ROWS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env.pool, env.gatedKey],
  );
  if (!files.length) return <Empty>{t('dashboard.empty.files')}</Empty>;
  return (
    <ul ref={fit}>
      {files.map((f) => {
        const Glyph = f.kind === 'image' ? FileImage : FileText;
        return (
          <li key={`${f.noteId}:${f.uuid}`}>
            <button type="button" onClick={() => env.open(f.noteId)} title={f.noteTitle} className={`${ROW_BUTTON} items-center`}>
              <Glyph className="shrink-0 text-accent" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{f.label}</span>
              {f.sizeLabel && <span className="shrink-0 text-meta text-pn-muted">{f.sizeLabel}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The writing stats every stats widget reads, from the readable pool. */
export function useWritingStats(): { stats: Stats; live: LocalNote[] } {
  const { pool, isNoteLocked, gatedKey } = useDashboardEnv();
  return useMemo(() => {
    const live = pool.filter((n) => !isNoteLocked(n));
    return { stats: computeStats(live), live };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, gatedKey]);
}

/** The 30-day wellness model, built once by the pane and shared, so a page
 *  of tracker widgets does not build it once each. */
export function useBuildMonthModel(): WellnessModel {
  const env = useDashboardEnv();
  return useMemo(
    () => buildWellnessModel(env.pool, env.isNoteLocked, env.trackerSettings, env.medications, '30d', env.factors),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env.pool, env.gatedKey, env.trackerSettings, env.medications, env.factors],
  );
}

export const MonthModelContext = createContext<WellnessModel | null>(null);

function useMonthModel(): WellnessModel {
  const month = useContext(MonthModelContext);
  if (!month) throw new Error('Home widget outside the dashboard');
  return month;
}

export function WeekWidget({ stats, live }: { stats: Stats; live: LocalNote[] }) {
  const month = useMonthModel();
  // The ledger is one per device and fills itself once from every item, so
  // it is seeded from them all, never from Home's filtered pool.
  const ledger = useLedger(useDashboardEnv().everywhere);
  return <WeekTiles stats={stats} live={live} month={month} ledger={ledger} gridClass="h-full auto-rows-fr grid-cols-2 @lg:grid-cols-4" />;
}

export function StreakWidget({ stats }: { stats: Stats }) {
  return <WritingStreakTile stats={stats} bare />;
}

export function CheckInStreakWidget() {
  const { pool, isNoteLocked, gatedKey } = useDashboardEnv();
  const today = toLocalIso(new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useMemo(() => checkInStreak(pool, today, isNoteLocked), [pool, today, gatedKey]);
  return <CheckInStreakTile run={run.run} week={run.week} bare />;
}

export function RhythmWidget({ stats }: { stats: Stats }) {
  const env = useDashboardEnv();
  const month = useMonthModel();
  const tStats = useMemo(
    () => computeTrackerStats(env.pool, env.medications, env.isNoteLocked),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env.pool, env.medications, env.gatedKey],
  );
  return (
    <RhythmHeatmap
      fit
      heatmap={stats.heatmap}
      moodHeatmap={tStats.moodHeatmap}
      tracks={month.entries.length > 0}
      header={(layerSwitch) => (layerSwitch ? <div className="mb-2 flex justify-end">{layerSwitch}</div> : null)}
    />
  );
}

export function MilestoneWidget({ stats }: { stats: Stats }) {
  const { t } = useTranslation('stats');
  const env = useDashboardEnv();
  const next = useMemo(
    () => milestoneProgress(stats, env.notesCreated, env.firstSeenAt)
      .filter((row) => row.next !== null)
      .sort((a, b) => b.progress - a.progress)[0] ?? null,
    [stats, env.notesCreated, env.firstSeenAt],
  );
  const { t: tShell } = useTranslation('shell');
  if (!next) return <Empty>{tShell('dashboard.empty.milestone')}</Empty>;
  const label = t('milestones.next', { label: milestoneLabel(next.family, next.next!) });
  return (
    <StatTile bare label={label} value={t('milestones.ofTarget', { current: fmt(next.current), target: fmt(next.next!) })}>
      <div className="mt-2">
        <ProgressBar value={next.progress} label={label} />
      </div>
    </StatTile>
  );
}

/** The trackers a person can put on Home: shown ones, mood first. */
export function useTrackerChoices(month: WellnessModel): WellnessModel['registry'] {
  return useMemo(() => [...month.registry].filter(visibleInUi).sort((a, b) => (a.id === 'mood' ? -1 : b.id === 'mood' ? 1 : 0)), [month]);
}

/** One tracker: its number and change, and its days under them, the chart as
 *  tall as the card leaves: a sparkline of the logged span in a short card,
 *  the 30 days with their axis in a taller one. */
export function TrackerWidget({ trackerId }: { trackerId: string }) {
  const { t } = useTranslation('stats');
  const { t: tShell } = useTranslation('shell');
  const env = useDashboardEnv();
  const month = useMonthModel();
  const [chartBox, setChartBox] = useState<HTMLElement | null>(null);
  const chartHeight = useElementHeight(chartBox);
  const d = month.byId(trackerId);
  if (!d) return null;
  const series = month.seriesOf(d);
  if (!hasData(series)) return <Empty>{tShell('dashboard.empty.tracker')}</Empty>;
  const { headline, sub } = cardNumbers(d, series, t);
  const raw = changeOf(month, d, series);
  const delta = raw !== null && Math.abs(raw) >= (d.unit === 'steps' || d.unit === 'bpm' ? 0.5 : 0.05) ? raw : null;
  const span = loggedSpan(series);
  return (
    <button type="button" onClick={env.openStats} className="flex h-full w-full min-w-0 flex-col text-start">
      <span className="flex items-baseline gap-2 min-w-0">
        <span className="text-display font-semibold tabular-nums truncate">{headline}</span>
        {delta !== null && <Change d={d} delta={delta} />}
      </span>
      <span className="block text-meta text-pn-muted truncate">{sub}</span>
      {span && (
        <span ref={setChartBox} aria-hidden={chartHeight < CHART_MIN} className="mt-2 block min-h-0 flex-1">
          {chartHeight >= 16 && (
            <TrackerChart spec={chartSpecFor(d, chartHeight < CHART_MIN ? span : series, false)} height={Math.floor(chartHeight)} ariaLabel={`${trackerName(d, t)}: ${headline}`} />
          )}
        </span>
      )}
    </button>
  );
}

export function WeekRecapWidget() {
  const env = useDashboardEnv();
  const month = useMonthModel();
  return <WeekRecap model={month} notes={env.pool} bare />;
}

/** A chosen markdown note, read-only, its note-links live. A gated note or
 *  one that is not markdown shows as its row. */
export function NoteWidget({ note }: { note: LocalNote }) {
  const env = useDashboardEnv();
  const locked = env.isNoteLocked(note);
  // A note the list switches hide (read-only or protected off) shows as its
  // bare row too: the person chose not to see those in lists.
  if (locked || !MARKDOWN_NOTE_TYPES.includes(note.type) || !env.pool.includes(note)) return <Rows notes={[note]} />;
  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <Suspense fallback={null}>
        <NotePreview key={`${note.id}:${note.updatedAt}`} note={note} everywhere={env.everywhere} isNoteLocked={env.isNoteLocked} onOpen={env.open} />
      </Suspense>
    </div>
  );
}
