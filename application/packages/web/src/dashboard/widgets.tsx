/**
 * One component per Home widget. Each draws its content only: Dashboard.tsx
 * puts it in its GridCard and owns the edit mode. Every list reads the env's
 * pool, and every memo that reads a body, a title or an excerpt keys on
 * `gatedKey` too, so a PIN window that closes hides the content at once.
 * Spec: docs/internal/specs/dashboard.md (section 5)
 */
import { createContext, lazy, Suspense, useContext, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NoteType } from '@notes/shared';
import type { LocalNote } from '../db';
import { VIEW_NOTE_TYPES, type View } from '../views';
import NoteRow from '../NoteRow';
import {
  Button, DeleteButton, EmptyState, IconButton, ProgressBar, QuotaRing, SettingsTabStrip, settingsTabClass, Spinner, StatusLine, TaskCheckbox, TextField,
} from '../ui';
import {
  ArrowCounterClockwise, ArrowRight, ArrowsClockwise, BellSimple, Cake, CalendarDot, CalendarDots, CheckFat, FileImage, FileText, LockSimple, Minus, NotePencil, Plus, Sparkle,
} from '../icons';
import type { DayKind } from '../notesViewUtils';
import { editedAtOf, entryDayOf, journalOn, stripToPlainText, toLocalIso } from '../notesViewUtils';
import type { TaskItem } from '../tasks';
import { formatTaskReminderLabel, isTaskReminderOverdue } from '../taskReminderText';
import { sortTasksDueFirst } from './dashboardLayout';
import { contactBirthday, contactDisplayName, parseContactBody } from '../contactBody';
import { computeStats, type Stats } from '../stats';
import { milestoneLabel, milestoneProgress } from '../milestones';
import { folderScope } from '../folders';
import { capitalize, formatDay, formatInstant, relativeDayName } from '../intlFormat';
import { intlLocale } from '../languages';
import { MARKDOWN_NOTE_TYPES } from '../noteTypes';
import { StatTile } from '../settingsUI';
import { checkInEntry, checkInStreak } from '../checkIn';
import { computeTrackerStats, insightText } from '../trackerStats';
import { compareAll } from '../trackerCompare';
import { visibleInUi } from '../trackerRegistry';
import { TrackerChart } from '../TrackerChart';
import { buildWellnessModel, hasData, standoutLabel, trackerName, type WellnessModel } from '../stats/wellnessModel';
import { cardNumbers, chartSpecFor } from '../stats/TrackerCard';
import { Change, changeOf, loggedSpan } from '../stats/StatsPage';
import { EffectBarRow, SureDots } from '../stats/statsParts';
import { WeekRecap } from '../stats/WeekRecap';
import { YearInPixels } from '../stats/YearInPixels';
import { CheckInStreakTile, RhythmHeatmap, WeekTiles, WritingStreakTile, shiftDay, useLedger, type RhythmLayer } from '../stats/overviewParts';
import type { ListPrefs } from '../listPrefs';
import { useDashboardEnv } from './env';
import { useElementHeight, useElementSize } from '../useElementSize';
import { useTrackerHistory } from '../trackerLastLogged';
import { counterSetDay, counterStartAgain, counterTotal } from '../customCounter';
import { formatBytes } from '../formatBytes';
import {
  activeCustomTrackers,
  COUNTER_DAY_MAX,
  type CustomTrackerTemplate,
  type JournalTrackerData,
} from '../trackerTypes';
import { ItemList, useItemList } from '../itemList';

const NotePreview = lazy(() => import('./NotePreview'));
const GraphWidgetLazy = lazy(() => import('./GraphWidget'));
const PlacesWidgetLazy = lazy(() => import('./PlacesWidget'));
export { QuickCaptureWidget } from './QuickCaptureWidget';

/** A plain row in a widget: an item, an event, a file; its glyph first. */
const ROW_BUTTON = 'flex w-full min-w-0 gap-2 rounded-md px-1 py-0.5 text-start text-compact text-pn hover:bg-pn/5 transition';

/** Most rows a list widget hands to the page; what shows is what fits its box. */
const MAX_ROWS = 30;
/** Below this height a tracker draws its sparkline, above it the chart. */
const CHART_MIN = 80;
/** Below this height a tracker draws no chart: bars this short read as a line. */
const SPARK_MIN = 24;
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
 * The last row that shows is marked (`data-fit-last`): index.css takes its
 * divider off, so no line stands alone over the card's edge. When rows were
 * hidden, the room left under the last one is shared out as
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
        delete row.dataset.fitLast;
      }
      const bottom = box.getBoundingClientRect().bottom + 0.5;
      let cut = false;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        // Never hide the very first item if doing so would leave a populated
        // card completely blank; let the card's own edge clip it instead.
        if (i > 0) cut ||= row.getBoundingClientRect().bottom > bottom;
        if (cut) row.style.visibility = 'hidden';
      }
      const shown = rows.filter((row) => row.style.visibility !== 'hidden');
      const last = shown.at(-1);
      if (last && last.dataset.fitLabel !== undefined) {
        last.style.visibility = 'hidden';
        shown.pop();
      }
      const final = shown.at(-1);
      if (final) final.dataset.fitLast = '';
      const end = final?.getBoundingClientRect().bottom;
      if (!cut || end === undefined || shown.length === 0) return;
      // Cap extra breathing room so compact lists never stretch into sparse,
      // over-padded rows when one more row barely missed fitting.
      const share = Math.min(4, (bottom - 0.5 - end) / shown.length / 2);
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
          onContextMenu={env.onNoteContextMenu ? (e) => env.onNoteContextMenu!(e, n) : undefined}
        />
      ))}
    </ItemList>
  );
}

/** Nothing to show: said in the middle of the card. The card pads it: the
 *  line's own padding would cut a second line off in the smallest card. */
function Empty({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState compact flush>{children}</EmptyState>
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

/** Newest items of one or more chosen pillars, sorted by last edited. */
export function TypesWidget({ views }: { views: readonly View[] }) {
  const { t } = useTranslation('shell');
  const { pool } = useDashboardEnv();
  const notes = useMemo(() => {
    const allowed = new Set<NoteType>();
    for (const v of views) for (const nt of VIEW_NOTE_TYPES[v] ?? []) allowed.add(nt);
    return pool.filter((n) => allowed.has(n.type ?? 'note')).sort(byEdited).slice(0, MAX_ROWS);
  }, [pool, views]);
  return notes.length ? <Rows notes={notes} /> : <Empty>{t('dashboard.empty.recent')}</Empty>;
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
  const { t } = useTranslation(['shell', 'common']);
  const env = useDashboardEnv();
  const today = toLocalIso(new Date());
  // Asked of every listed item: an entry the list switches hide still exists,
  // and a second one must not be started beside it.
  const entry = useMemo(() => journalOn(env.listed, today), [env.listed, today]);
  const excerpt = useMemo(
    () => (entry && env.pool.includes(entry) && !env.isNoteLocked(entry) ? stripToPlainText(entry.body).trim() : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gatedKey tracks lock changes
    [entry, env.pool, env.gatedKey],
  );
  if (entry) {
    // An entry hidden by the list switches or PIN-gated shows only as its bare
    // row, never its body lines.
    if (!env.pool.includes(entry) || env.isNoteLocked(entry)) return <Rows notes={[entry]} />;
    return (
      <button
        type="button"
        onClick={() => env.open(entry.id)}
        className="flex h-full w-full min-h-0 flex-col gap-1.5 rounded-md p-1 -m-1 text-start hover:bg-pn/5 transition"
      >
        <span className="flex shrink-0 items-center gap-2 min-w-0">
          <NotePencil className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-pn" dir="auto">
            {entry.title || t('common:state.untitled')}
          </span>
        </span>
        {excerpt && (
          <span
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain text-compact leading-relaxed text-pn-muted whitespace-pre-line"
            dir="auto"
          >
            {excerpt}
          </span>
        )}
      </button>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-3">
      <Button action="create" onClick={env.startToday}>{t('shell:dashboard.startToday')}</Button>
    </div>
  );
}

/** Unchecked checkbox lines, overdue and due-today first, with inline quick-add.
 *  The box completes the line through the Tasks pane's own path. */
export function TasksWidget({ tasks }: { tasks: TaskItem[] }) {
  const { t } = useTranslation(['shell', 'common']);
  const env = useDashboardEnv();
  const fit = useFitRows();
  const [rootBox, setRootBox] = useState<HTMLElement | null>(null);
  const rootHeight = useElementHeight(rootBox);
  const compact = rootHeight > 0 && rootHeight < 100;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = tasks.slice(0, MAX_ROWS);
  const todayIso = toLocalIso(new Date());

  const submit = async () => {
    const clean = draft.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      const ok = await env.addQuickTask(clean);
      if (ok) setDraft('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={setRootBox} className="flex h-full min-h-0 flex-col gap-1.5">
      <div data-card-body="" className="min-h-0 flex-1 overflow-y-clip">
        {!shown.length ? (
          <Empty>{t('shell:dashboard.empty.tasks')}</Empty>
        ) : (
          <ul ref={fit} className="flex flex-col gap-0.5">
            {shown.map((task) => {
              const overdue = task.reminder ? isTaskReminderOverdue(task.reminder) : false;
              return (
                <li key={`${task.noteId}:${task.lineIdx}`} className="flex items-start gap-2 min-w-0">
                  <TaskCheckbox
                    checked={task.checked}
                    onChange={(e) => env.toggleTask(task, e.target.checked)}
                    aria-label={t('shell:tasksList.markComplete')}
                    className="mt-1"
                  />
                  <button
                    type="button"
                    onClick={() => env.openTaskSource(task)}
                    title={task.noteTitle}
                    className={`${ROW_BUTTON} flex-col gap-0`}
                  >
                    <span className="block truncate">{stripToPlainText(task.text)}</span>
                    {!compact && (
                      <span className="flex items-center gap-1.5 min-w-0 text-meta text-pn-muted">
                        <span className="truncate">{task.noteTitle}</span>
                        {task.reminder && (
                          <span className={`shrink-0 inline-flex items-center gap-0.5 ${overdue ? 'font-medium text-danger' : 'text-accent'}`}>
                            <BellSimple aria-hidden="true" />
                            <span>{formatTaskReminderLabel(task.reminder, todayIso)}</span>
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex shrink-0 items-center gap-1.5 border-t border-divider pt-1.5"
      >
        <TextField
          size="sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('shell:dashboard.quickCapture.placeholderTask')}
          aria-label={t('shell:dashboard.quickCapture.placeholderTask')}
          disabled={busy}
          className="flex-1"
        />
        <IconButton
          type="submit"
          tone="accent"
          label={t('common:actions.add')}
          disabled={!draft.trim() || busy}
        >
          <Plus aria-hidden="true" />
        </IconButton>
      </form>
    </div>
  );
}

/** Open tasks of the pool, overdue and due-today first; gated notes left out. */
export function useOpenTasks(): TaskItem[] {
  const env = useDashboardEnv();
  const { pool, isNoteLocked, gatedKey } = env;
  return useMemo(() => {
    const readable = pool.filter((n) => !isNoteLocked(n));
    // A line with nothing to read once its markdown is gone is left out.
    const open = env.tasksOf(readable).filter((task) => !task.checked && stripToPlainText(task.text).trim() !== '');
    return sortTasksDueFirst(open);
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
      if (!day) continue;
      // The age that day, when the birthday row has the year of birth (#750).
      const name = contactDisplayName(n.title, c);
      const age = b.year ? Number(day.slice(0, 4)) - b.year : 0;
      out.push({ id: n.id, name: age > 0 ? t('calendar.birthdayAge', { name, count: age }) : name, day });
    }
    return out.sort((a, b) => a.day.localeCompare(b.day)).slice(0, MAX_ROWS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.pool, env.gatedKey, today, t]);
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

export function RhythmWidget({ stats, layer }: { stats: Stats; layer?: RhythmLayer }) {
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
      layer={layer}
      heatmap={stats.heatmap}
      moodHeatmap={tStats.moodHeatmap}
      tracks={month.entries.length > 0}
      header={() => null}
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

/** One tracker: its number and change, and its days, the chart as tall as
 *  the card leaves: a sparkline of the logged span in a short card, the 30
 *  days with their axis in a taller one, none where bars would be a line.
 *  The days sit under the number, and beside it in a card two columns wide,
 *  where a short card would leave them no height. */
export function TrackerWidget({ trackerId }: { trackerId: string }) {
  const { t } = useTranslation('stats');
  const { t: tShell } = useTranslation('shell');
  const env = useDashboardEnv();
  const month = useMonthModel();
  const [rootBox, setRootBox] = useState<HTMLElement | null>(null);
  const rootHeight = useElementHeight(rootBox);
  const [chartBox, setChartBox] = useState<HTMLElement | null>(null);
  const chartHeight = useElementHeight(chartBox);
  const d = month.byId(trackerId);
  if (!d) return null;
  const counter = env.trackerSettings.customTrackers.find((c) => c.id === trackerId && c.type === 'counter');
  if (counter) return <CounterWidget template={counter} onOpen={env.openStats} />;
  const series = month.seriesOf(d);
  if (!hasData(series)) return <Empty>{tShell('dashboard.empty.tracker')}</Empty>;
  const { headline, sub } = cardNumbers(d, series, t);
  const raw = changeOf(month, d, series);
  const delta = raw !== null && Math.abs(raw) >= (d.unit === 'steps' || d.unit === 'bpm' ? 0.5 : 0.05) ? raw : null;
  const span = loggedSpan(series);
  // In a short card (like 1x2, ~72px body), stacking leaves under 24px for the
  // sparkline; placing the sparkline beside the number lets it draw cleanly.
  const compactRow = rootHeight > 0 && rootHeight < 104;
  return (
    <button
      ref={setRootBox}
      type="button"
      onClick={env.openStats}
      className={`flex h-full w-full min-h-0 min-w-0 overflow-hidden text-start ${
        compactRow
          ? 'flex-row items-center gap-3'
          : 'flex-col justify-center gap-2 @md:flex-row @md:items-stretch @md:gap-4'
      }`}
    >
      <span className={`flex shrink-0 min-w-0 flex-col justify-center ${compactRow ? 'max-w-[56%]' : '@md:max-w-[45%]'}`}>
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="text-display font-semibold tabular-nums truncate">{headline}</span>
          {delta !== null && <Change d={d} delta={delta} />}
        </span>
        <span className={`block text-meta text-pn-muted ${compactRow ? 'line-clamp-2 leading-tight' : 'truncate'}`}>{sub}</span>
      </span>
      {span && (
        <span
          ref={setChartBox}
          aria-hidden={chartHeight < CHART_MIN}
          className={`relative block min-h-0 min-w-0 flex-1 overflow-hidden ${compactRow ? 'h-full self-stretch' : ''}`}
        >
          {chartHeight >= SPARK_MIN && (
            <span className="absolute inset-0 block">
              <TrackerChart spec={chartSpecFor(d, chartHeight < CHART_MIN ? span : series, false)} height={Math.floor(chartHeight)} ariaLabel={`${trackerName(d, t)}: ${headline}`} />
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** A Counter tracker on Home: its total today against its limit, as the
 *  pill shows it, not the sum of its days that the other trackers chart.
 *  Spec: docs/internal/mood-wellness-tracker.md section 16.1 (Counter) */
function CounterWidget({ template, onOpen }: { template: CustomTrackerTemplate; onOpen: () => void }) {
  const { t } = useTranslation('trackers');
  const total = counterTotal(template.id, useTrackerHistory(), toLocalIso(new Date()));
  const limit = template.limit;
  return (
    <button type="button" onClick={onOpen} className="flex h-full w-full min-w-0 flex-col justify-center gap-2 text-start">
      <span className="flex items-baseline gap-2 min-w-0">
        <span className="text-display font-semibold tabular-nums truncate">{total}</span>
        {limit !== undefined && <span className="text-meta text-pn-muted truncate">{t('custom.counterOf', { limit })}</span>}
      </span>
      {limit !== undefined && <ProgressBar value={total / limit} label={template.name} tone={total >= limit ? 'warning' : 'info'} />}
    </button>
  );
}

export function WeekRecapWidget({ back }: { back?: number }) {
  const env = useDashboardEnv();
  const month = useMonthModel();
  return <WeekRecap model={month} notes={env.pool} bare hideHeader back={back} />;
}

/** Year in pixels mood grid on Home, clicking a day opens that journal entry. */
export function YearPixelsWidget({ year }: { year?: number }) {
  const { t } = useTranslation('shell');
  const env = useDashboardEnv();
  const month = useMonthModel();
  const [box, setBox] = useState<HTMLElement | null>(null);
  const boxSize = useElementSize(box);
  const hasMood = useMemo(() => {
    const mood = month.byId('mood');
    return mood ? month.entries.some((e) => typeof e.data.mood === 'number') : false;
  }, [month]);
  if (!hasMood) return <Empty>{t('dashboard.empty.yearPixels')}</Empty>;
  return (
    <div ref={setBox} className="flex h-full w-full min-h-0 items-center justify-center">
      <YearInPixels model={month} bare hideHeader year={year} onOpenDay={env.openJournalDay} fitBox={boxSize} />
    </div>
  );
}

/** Patterns (Pro): mood effect correlations (Same day / Next day) and detected insights. */
export function PatternsWidget() {
  const { t } = useTranslation(['stats', 'shell']);
  const env = useDashboardEnv();
  const month = useMonthModel();
  const fit = useFitRows();
  const [tab, setTab] = useState<'same' | 'next' | 'insights'>('same');
  const mood = month.byId('mood');
  const compareRange = useMemo(
    () => ({ from: shiftDay(month.range.to, -89), to: month.range.to }),
    [month.range.to],
  );
  const lag: 0 | 1 = tab === 'next' ? 1 : 0;
  const rows = useMemo(
    () => (mood && tab !== 'insights' ? compareAll(month.entries, month.registry, mood, compareRange, lag) : []),
    [month, mood, compareRange, lag, tab],
  );
  const shown = useMemo(
    () => rows.filter((r) => r.delta !== null).sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)),
    [rows],
  );
  const scale = Math.max(1, ...shown.map((r) => Math.abs(r.delta ?? 0)));
  const tStats = useMemo(
    () => computeTrackerStats(env.pool, env.medications, env.isNoteLocked),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env.pool, env.medications, env.gatedKey],
  );
  const insights = tStats.patterns;

  const hasAny = !!mood || insights.length > 0;
  if (!hasAny) {
    return <Empty>{t('shell:dashboard.empty.patterns')}</Empty>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <SettingsTabStrip
        role="tablist"
        aria-label={t('stats:wellness.subTabs.patterns')}
        className="-mx-3 -mt-1 shrink-0 px-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'same'}
          onClick={() => setTab('same')}
          className={settingsTabClass(tab === 'same')}
        >
          <CalendarDot aria-hidden="true" />
          <span>{t('stats:wellness.effects.sameDay')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'next'}
          onClick={() => setTab('next')}
          className={settingsTabClass(tab === 'next')}
        >
          <ArrowRight aria-hidden="true" className="rtl:-scale-x-100" />
          <span>{t('stats:wellness.effects.nextDay')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'insights'}
          onClick={() => setTab('insights')}
          className={settingsTabClass(tab === 'insights')}
        >
          <Sparkle aria-hidden="true" />
          <span>{t('stats:wellness.patterns.insights')}</span>
        </button>
      </SettingsTabStrip>
      <div data-card-body="" className="min-h-0 flex-1 overflow-y-clip">
        {tab === 'insights' ? (
          insights.length > 0 ? (
            <div ref={fit} className="divide-y divide-divider [&>[data-fit-last]]:border-b-0">
              {insights.map((p, i) => (
                <div key={i} className="flex items-center gap-2 py-2 text-compact text-pn">
                  <Sparkle aria-hidden="true" className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">{insightText(p, t)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>{t('shell:dashboard.empty.patterns')}</Empty>
          )
        ) : shown.length > 0 ? (
          <div ref={fit} className="divide-y divide-divider [&>[data-fit-last]]:border-b-0">
            {shown.map((r) => {
              const d = month.byId(r.trackerId);
              return d ? (
                <EffectBarRow
                  key={r.trackerId + (r.tag ?? '')}
                  d={d}
                  label={standoutLabel(r, d, t)}
                  sub={t('stats:home.daysSplit', { a: r.a.n, b: r.b.n })}
                  delta={r.delta ?? 0}
                  sure={<SureDots r={r} />}
                  share={Math.abs(r.delta ?? 0) / scale}
                />
              ) : null;
            })}
          </div>
        ) : (
          <Empty>{t('shell:dashboard.empty.patterns')}</Empty>
        )}
      </div>
    </div>
  );
}

/** Interactive Counter widget (Pro): +1 / -1 / Start again straight on Home. */
export function InteractiveCounterWidget({ trackerId }: { trackerId: string }) {
  const { t } = useTranslation(['trackers', 'shell']);
  const env = useDashboardEnv();
  const today = toLocalIso(new Date());
  const history = useTrackerHistory();
  const template = useMemo(
    () => activeCustomTrackers(env.trackerSettings.customTrackers).find((c) => c.id === trackerId && c.type === 'counter'),
    [env.trackerSettings.customTrackers, trackerId],
  );
  if (!template) return null;

  const entry = checkInEntry(env.listed, today);
  const guarded = !!entry && (env.isNoteLocked(entry) || entry.locked === 1);
  if (guarded) {
    return (
      <div className="flex h-full items-center justify-center">
        <button
          type="button"
          onClick={() => env.openJournalDay(today)}
          className="inline-flex items-center gap-2 text-compact text-pn-muted hover:text-pn transition"
        >
          <span>{t('shell:checkIn.locked')}</span>
          <LockSimple aria-hidden="true" className="shrink-0" />
        </button>
      </div>
    );
  }

  const customs = (entry?.trackers as JournalTrackerData | undefined)?.customTrackers ?? [];
  const live = customs.find((c) => c.trackerId === template.id);
  const todayUses = typeof live?.value === 'number' && Number.isFinite(live.value) ? Math.max(0, Math.floor(live.value)) : 0;
  const total = counterTotal(template.id, history, today, live);
  const limit = template.limit;
  const reached = limit !== undefined && total >= limit;

  const writeEntry = (nextEntry: ReturnType<typeof counterSetDay>) => {
    const rest = customs.filter((c) => c.trackerId !== template.id);
    const nextList = nextEntry ? [...rest, nextEntry] : rest;
    void env.saveCheckIn(today, { customTrackers: nextList });
  };

  const step = (delta: number) => {
    const nextUses = Math.max(0, Math.min(COUNTER_DAY_MAX, todayUses + delta));
    if (nextUses === todayUses) return;
    writeEntry(counterSetDay(template.id, live, nextUses));
  };

  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-display font-semibold tabular-nums text-pn truncate">{total}</span>
            {limit !== undefined && <span className="text-meta text-pn-muted truncate">{t('trackers:custom.counterOf', { limit })}</span>}
          </div>
          <p className="text-meta text-pn-muted tabular-nums truncate">
            {todayUses} {t('trackers:custom.counterToday')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label={t('shell:dashboard.counterDecrease', { name: template.name })}
            disabled={todayUses <= 0}
            onClick={() => step(-1)}
          >
            <Minus aria-hidden="true" />
          </IconButton>
          <IconButton
            label={t('shell:dashboard.counterIncrease', { name: template.name })}
            tone="accent"
            disabled={todayUses >= COUNTER_DAY_MAX}
            onClick={() => step(1)}
          >
            <Plus aria-hidden="true" />
          </IconButton>
          <DeleteButton
            kind="remove"
            icon={ArrowCounterClockwise}
            label={t('trackers:custom.counterStartAgain', { name: template.name })}
            confirmLabel={t('trackers:custom.counterStartAgainConfirm')}
            onConfirm={() => writeEntry(counterStartAgain(template.id, live))}
            position="above-end"
          />
        </div>
      </div>
      {limit !== undefined && (
        <ProgressBar value={total / limit} label={template.name} tone={reached ? 'warning' : 'info'} />
      )}
    </div>
  );
}

/** Storage quota gauge on Home: QuotaRing + recount button + local counts. */
export function StorageWidget() {
  const { t } = useTranslation(['shell', 'common']);
  const env = useDashboardEnv();
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState<HTMLElement | null>(null);
  const boxHeight = useElementHeight(box);

  const handleRefresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await Promise.all([
        env.refreshStorage(),
        new Promise((resolve) => setTimeout(resolve, 600)),
      ]);
    } finally {
      setBusy(false);
    }
  };

  const summary = t('shell:dashboard.storageSummary', {
    notes: fmt(env.storageNoteCount),
    files: fmt(env.storageFileCount),
  });

  if (env.storageMaxBytes <= 0) {
    return (
      <div ref={setBox} className="flex h-full items-center justify-between gap-2">
        <button
          type="button"
          onClick={env.openStorage}
          aria-label={t('common:storageBar.open')}
          className="min-w-0 flex-1 text-start"
        >
          <div className="text-heading font-semibold tabular-nums text-pn truncate">{formatBytes(env.storageUsedBytes)}</div>
          <div className="text-meta text-pn-muted truncate">{summary}</div>
        </button>
        <IconButton label={t('common:storageBar.refresh')} disabled={busy} onClick={() => void handleRefresh()}>
          {busy ? <Spinner size={14} /> : <ArrowsClockwise aria-hidden="true" />}
        </IconButton>
      </div>
    );
  }

  return (
    <div ref={setBox} className="flex h-full items-center gap-2">
      <button
        type="button"
        onClick={env.openStorage}
        aria-label={t('common:storageBar.open')}
        className="min-w-0 flex-1 rounded-lg p-1 -m-1 text-start hover:bg-pn/5 transition"
      >
        <QuotaRing compact={boxHeight >= 100 ? true : 'small'} usedBytes={env.storageUsedBytes} maxBytes={env.storageMaxBytes} label={summary} />
      </button>
      <IconButton label={t('common:storageBar.refresh')} disabled={busy} onClick={() => void handleRefresh()}>
        {busy ? <Spinner size={14} /> : <ArrowsClockwise aria-hidden="true" />}
      </IconButton>
    </div>
  );
}

/** Lazy Graph constellation tile. */
export function GraphWidgetSlot() {
  const { t } = useTranslation('common');
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center"><StatusLine busy>{t('state.loading')}</StatusLine></div>}>
      <GraphWidgetLazy />
    </Suspense>
  );
}

/** Lazy Places map tile (Pro). */
export function PlacesWidgetSlot() {
  const { t } = useTranslation('notes');
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center"><StatusLine busy>{t('location.mapLoading')}</StatusLine></div>}>
      <PlacesWidgetLazy />
    </Suspense>
  );
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
