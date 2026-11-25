import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { BellSimple, CalendarX, CalendarDots, Check, Clock, Repeat as RepeatGlyph, Sun, X, ArrowRight } from './icons';
import type { LocalNote } from './db';
import { MonthGrid } from './MonthGrid';
import { formatDay, toLocalIso, weekdayDate, weekdayLabel } from './intlFormat';
import { timeLabel } from './JournalCalendar';
import { entryDayOf, journalDateOf, type JournalDays } from './notesViewUtils';
import { pushEscapeHandler } from './useEscapeToClose';
import {
  MAX_ALERTS,
  dayNumber,
  isTime,
  nthOf,
  scheduleOf,
  shiftDay,
  weekdayOf,
  type Alert,
  type Repeat,
  type RepeatUnit,
  type ScheduleEdit,
} from './schedule';
import {
  ALL_DAY_ALERTS,
  TIMED_ALERTS,
  alertLabel,
  alertOrder,
  alertsSummary,
  describeRepeat,
  presetEdit,
  repeatPresets,
  sameRule,
} from './scheduleText';
import { taskReminderPresets } from './taskReminderSyntax';
import { taskReminderDayLabel } from './taskReminderText';
import { NO_SPIN, RepeatIntervalFields } from './RepeatIntervalFields';
import { intlLocale } from './languages';
import { askForRemindersOnce } from './notesView/useReminders';
import { Button, Select, TextField } from './ui';
import { TimeInput } from './TimeInput';

/**
 * The Schedule view of the "..." menu: the day on the grid, then the rows a
 * type gets. An event: Ends, All day, Starts and Ends at, Repeat, Alert. A
 * note or a task list: the same, with "Convert to Event to repeat it" in
 * place of Repeat, and Remove from calendar. A journal entry: Entry date, All
 * day, the times and Alert. Repeat, Ends and Alert open their own views
 * inside the same menu, as Color does. Every change goes through `onEdit`,
 * which asks "Change this item?" on a repeating event.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (steps 4, 6 and 7, section 4.4)
 */

/** The menu's own row parts, handed in so the view draws exactly like the menu. */
export type MenuUi = {
  BackRow: ComponentType<{ title: string; onBack: () => void }>;
  Group: ComponentType<{ children: ReactNode }>;
  ActionItem: ComponentType<{ label: ReactNode; icon: ReactNode; onClick: () => void; pro?: boolean; disabled?: boolean; value?: ReactNode; chevron?: boolean; tone?: 'accent' | 'muted' | 'danger' }>;
  ToggleItem: ComponentType<{ label: string; icon: ReactNode; checked: boolean; pro?: boolean; onClick: () => void }>;
};

type Props = {
  ui: MenuUi;
  note: LocalNote;
  /** The occurrence a repeating event was opened on. */
  occurrence: string | null;
  journalDays?: JournalDays;
  onSetJournalDate?: (day: string) => void;
  onSetNoteDate?: (day: string | null) => void;
  onEdit: (edit: ScheduleEdit) => void;
  /** Opens Convert to, where a note becomes an event. */
  onMakeEvent: () => void;
  /** Alerts open (Pro, or the demo). */
  alertsUnlocked: boolean;
  /** Draw the Pro mark (not Pro, the demo included). */
  showPro: boolean;
  onUpgrade: () => void;
  onBack: () => void;
  /** The row the view opens on: the event card opens Repeat, Alert or Ends directly. */
  initialSub?: 'ends' | 'repeat' | 'alerts';
};

type Sub = 'main' | 'ends' | 'repeat' | 'repeatCustom' | 'alerts';

const NO_DAYS: ReadonlySet<string> = new Set();
const TIME_FIELD = 'w-[5.5rem] h-8 rounded-md border border-divider bg-track px-2 text-body text-pn tabular-nums text-center focus:border-accent outline-none';

/** A time field of this view: its box, and a cleared field clears the time. */
function TimeField({ day, value, onCommit, onDraft, label, className = TIME_FIELD }: { day: string; value: string | undefined; onCommit: (time: string | null) => void; onDraft?: (time: string | null) => void; label: string; className?: string }) {
  return <TimeInput day={day} value={value} label={label} onCommit={onCommit} onDraft={onDraft} className={className} clearable />;
}

export default function ScheduleView({
  ui, note, occurrence, journalDays, onSetJournalDate, onSetNoteDate, onEdit, onMakeEvent,
  alertsUnlocked, showPro, onUpgrade, onBack, initialSub,
}: Props) {
  const { t } = useTranslation('shell');
  const { BackRow, Group, ActionItem, ToggleItem } = ui;
  const [sub, setSub] = useState<Sub>(initialSub ?? 'main');
  useEffect(() => (sub === 'main' ? undefined : pushEscapeHandler(() => setSub(sub === 'repeatCustom' ? 'repeat' : 'main'))), [sub]);

  const journal = note.type === 'journal';
  const event = note.type === 'event';
  const s = scheduleOf(note.trackers as Record<string, unknown> | undefined, note.type, journal ? entryDayOf(note) : journalDateOf(note));
  // The day the view shows: the occurrence a series was opened on.
  const shownDay = s ? (occurrence && s.repeat ? occurrence : s.day) : null;
  const len = s?.end ? dayNumber(s.end) - dayNumber(s.day) : 0;
  const shownEnd = shownDay && len > 0 ? shiftDay(shownDay, len) : null;

  function pickDay(day: string) {
    if (journal) {
      if (day !== entryDayOf(note)) onSetJournalDate?.(day);
      return;
    }
    if (!shownDay) {
      onSetNoteDate?.(day);
      return;
    }
    if (day !== shownDay) onEdit({ shiftDays: dayNumber(day) - dayNumber(shownDay) });
  }

  const todayIso = toLocalIso(new Date());
  const quickPresets = useMemo(
    () => (journal ? [] : taskReminderPresets(new Date(), '09:00')),
    [journal, todayIso],
  );

  function pickQuickPreset(day: string, time: string) {
    const alerts: Alert[] | undefined =
      alertsUnlocked && (!s?.alerts || s.alerts.length === 0) ? [{ before: 0 }] : undefined;
    if (alerts) askForRemindersOnce();
    if (!shownDay) {
      onEdit({ day, time, ...(alerts ? { alerts } : {}) });
      return;
    }
    const shiftDays = dayNumber(day) - dayNumber(shownDay);
    onEdit({
      ...(shiftDays ? { shiftDays } : {}),
      time,
      ...(alerts ? { alerts } : {}),
    });
  }

  if (sub === 'ends' && shownDay) {
    return (
      <>
        <BackRow title={t('noteOptionsMenu.ends')} onBack={() => setSub('main')} />
        <div className="flex justify-center px-2 pt-3 pb-2">
          <MonthGrid
            marked={NO_DAYS}
            selected={shownEnd ?? shownDay}
            initialMonth={shownEnd ?? shownDay}
            onPick={(day) => {
              onEdit({ end: day > shownDay ? day : null });
              setSub('main');
            }}
          />
        </div>
        <Group>
          <ActionItem
            label={t('noteOptionsMenu.sameDay')}
            icon={<CalendarDots aria-hidden="true" />}
            value={!shownEnd ? <Check aria-hidden="true" /> : undefined}
            onClick={() => { onEdit({ end: null }); setSub('main'); }}
          />
        </Group>
      </>
    );
  }

  if (sub === 'repeat' && shownDay) {
    const current = s?.repeat ?? null;
    return (
      <>
        <BackRow title={t('repeat.label')} onBack={() => setSub('main')} />
        <Group>
          {repeatPresets(s!.day).map(({ key, repeat }) => {
            const on = sameRule(current, repeat);
            return (
              <ActionItem
                key={key}
                label={repeat ? describeRepeat(repeat, s!.day, t) : t('repeat.never')}
                icon={on ? <Check aria-hidden="true" /> : <span className="inline-block w-4" />}
                onClick={() => {
                  const change = presetEdit(repeat, current);
                  if (change) onEdit(change);
                  setSub('main');
                }}
              />
            );
          })}
          <ActionItem
            label={t('repeat.custom')}
            icon={<span className="inline-block w-4" />}
            chevron
            onClick={() => setSub('repeatCustom')}
          />
        </Group>
      </>
    );
  }

  if (sub === 'repeatCustom' && s) {
    return <CustomRepeat ui={ui} day={s.day} current={s.repeat ?? null} onBack={() => setSub('repeat')} onApply={(r) => { onEdit({ repeat: r }); setSub('main'); }} />;
  }

  if (sub === 'alerts' && s && shownDay) {
    return <AlertsView ui={ui} day={shownDay} timed={!!s.time} alerts={s.alerts ?? []} onBack={() => setSub('main')} onChange={(alerts) => onEdit({ alerts })} />;
  }

  const title = journal ? t('noteOptionsMenu.entryDate') : t('noteOptionsMenu.schedule');
  return (
    <>
      <BackRow title={title} onBack={onBack} />
      {quickPresets.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 px-3 pt-2.5 pb-2">
          {quickPresets.map((p) => {
            const label =
              p.key === 'laterToday'
                ? t('taskReminder.laterToday')
                : p.key === 'tomorrow'
                  ? taskReminderDayLabel(p.day, todayIso)
                  : t('monthGrid.nextWeek');
            const sub =
              p.key === 'laterToday'
                ? timeLabel(p.day, p.time)
                : `${formatDay(p.day, 'weekdayShort')}, ${timeLabel(p.day, p.time)}`;
            const active = shownDay === p.day && s?.time === p.time;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => pickQuickPreset(p.day, p.time)}
                className={`flex flex-col items-center rounded-lg px-1.5 py-1.5 text-center transition ${
                  active
                    ? 'bg-accent/15 text-accent'
                    : 'bg-surface-1 text-pn hover:bg-accent/10 hover:text-accent'
                }`}
              >
                <span className="max-w-full truncate text-meta font-semibold leading-tight">{label}</span>
                <span className="max-w-full truncate text-meta text-pn-muted leading-tight mt-0.5">{sub}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex justify-center px-2 pt-3 pb-2">
        <MonthGrid
          key={note.id}
          marked={journal ? (journalDays ?? NO_DAYS) : NO_DAYS}
          selected={shownDay ?? undefined}
          initialMonth={shownDay ?? undefined}
          onPick={pickDay}
        />
      </div>
      {s && shownDay && (
        <Group>
          {!journal && (
            <ActionItem
              label={t('noteOptionsMenu.ends')}
              icon={<ArrowRight aria-hidden="true" />}
              value={shownEnd ? formatDay(shownEnd, 'weekdayDate') : t('noteOptionsMenu.sameDay')}
              chevron
              onClick={() => setSub('ends')}
            />
          )}
          <ToggleItem
            label={t('shell:calendar.allDay')}
            icon={<Sun aria-hidden="true" />}
            checked={!s.time}
            onClick={() => onEdit(s.time ? { time: null } : { time: '09:00', timeEnd: '10:00' })}
          />
          {s.time && (
            <div className="px-4 py-1.5 flex items-center gap-3 text-body text-pn">
              <Clock aria-hidden="true" className="shrink-0 text-accent" />
              <span className="flex-1 min-w-0 truncate">{t('noteOptionsMenu.starts')}</span>
              <TimeField day={shownDay} value={s.time} label={t('noteOptionsMenu.starts')} onCommit={(time) => onEdit({ time })} />
            </div>
          )}
          {s.time && (
            <div className="px-4 py-1.5 flex items-center gap-3 text-body text-pn">
              <span className="shrink-0 w-4" />
              <span className="flex-1 min-w-0 truncate">{t('noteOptionsMenu.endsAt')}</span>
              <TimeField day={shownDay} value={s.timeEnd} label={t('noteOptionsMenu.endsAt')} onCommit={(timeEnd) => onEdit({ timeEnd })} />
            </div>
          )}
          {event && (
            <ActionItem
              label={t('repeat.label')}
              icon={<RepeatGlyph aria-hidden="true" />}
              value={s.repeat ? describeRepeat(s.repeat, s.day, t) : t('repeat.never')}
              chevron
              onClick={() => setSub('repeat')}
            />
          )}
          {(note.type === 'note' || note.type === 'task') && (
            <ActionItem
              label={<Trans i18nKey="shell:noteOptionsMenu.makeEvent" components={{ b: <b className="font-semibold" /> }} />}
              icon={<RepeatGlyph aria-hidden="true" />}
              chevron
              onClick={onMakeEvent}
            />
          )}
          <ActionItem
            label={t('alerts.label')}
            icon={<BellSimple aria-hidden="true" />}
            pro={showPro}
            value={alertsUnlocked ? alertsSummary(s.alerts, shownDay, t) : undefined}
            chevron={alertsUnlocked}
            onClick={() => {
              if (!alertsUnlocked) { onUpgrade(); return; }
              setSub('alerts');
            }}
          />
        </Group>
      )}
      {(note.type === 'note' || note.type === 'task') && s && (
        <Group>
          <ActionItem
            label={t('noteOptionsMenu.removeFromCalendar')}
            icon={<CalendarX aria-hidden="true" />}
            onClick={() => { onSetNoteDate?.(null); onBack(); }}
          />
        </Group>
      )}
    </>
  );
}

/** The alerts of an item: the presets as switches (five at most), then a
 *  custom row. A timed item counts in minutes before; an all-day item in
 *  days before, at a time. */
function AlertsView({ ui, day, timed, alerts, onBack, onChange }: { ui: MenuUi; day: string; timed: boolean; alerts: Alert[]; onBack: () => void; onChange: (alerts: Alert[]) => void }) {
  const { t } = useTranslation('shell');
  const { BackRow, Group, ActionItem } = ui;
  const allDayAt = alerts.find((a): a is { days: number; at: string } => 'days' in a)?.at ?? '09:00';
  const presets: Alert[] = timed ? TIMED_ALERTS.map((before) => ({ before })) : ALL_DAY_ALERTS.map((days) => ({ days, at: allDayAt }));
  const key = (a: Alert) => ('before' in a ? `b${a.before}` : `d${a.days}@${a.at}`);
  const held = new Set(alerts.map(key));
  const custom = alerts.filter((a) => !presets.some((p) => key(p) === key(a)));
  const full = alerts.length >= MAX_ALERTS;
  const [amount, setAmount] = useState('1');
  const [unit, setUnit] = useState<'minutes' | 'hours' | 'days' | 'weeks'>(timed ? 'hours' : 'days');
  const [at, setAt] = useState(allDayAt);
  // The time still being typed: Add follows it, since a click on Add first
  // blurs the field and commits it (#833).
  const [typedAt, setTypedAt] = useState<string | null>(null);
  const set = (next: Alert[]) => {
    if (next.length > alerts.length) askForRemindersOnce();
    onChange([...next].sort((a, b) => alertOrder(a) - alertOrder(b)));
  };
  const n = Math.max(0, Math.min(999, Number(amount) || 0));
  const candidate: Alert = timed
    ? { before: n * { minutes: 1, hours: 60, days: 1440, weeks: 10080 }[unit] }
    : { days: Math.min(28, n * (unit === 'weeks' ? 7 : 1)), at: typedAt ?? (isTime(at) ? at : '09:00') };
  // An alert that is already on (a preset with its check, or a custom row)
  // cannot be added twice, so Add waits for a different amount.
  const taken = held.has(key(candidate));
  function addCustom() {
    if (!taken && !full) set([...alerts, candidate]);
  }
  return (
    <>
      <BackRow title={t('alerts.label')} onBack={onBack} />
      <Group>
        <ActionItem
          label={t('alerts.none')}
          icon={alerts.length === 0 ? <Check aria-hidden="true" /> : <span className="inline-block w-4" />}
          onClick={() => set([])}
        />
        {presets.map((p) => {
          const on = held.has(key(p));
          return (
            <ActionItem
              key={key(p)}
              label={alertLabel(p, day, t)}
              icon={on ? <Check aria-hidden="true" /> : <span className="inline-block w-4" />}
              disabled={!on && full}
              onClick={() => set(on ? alerts.filter((a) => key(a) !== key(p)) : [...alerts, p])}
            />
          );
        })}
        {custom.map((a) => (
          <ActionItem
            key={key(a)}
            label={alertLabel(a, day, t)}
            icon={<Check aria-hidden="true" />}
            value={<X aria-label={t('alerts.remove', { alert: alertLabel(a, day, t) })} />}
            onClick={() => set(alerts.filter((x) => key(x) !== key(a)))}
          />
        ))}
      </Group>
      {/* The custom alert in two balanced full-width rows: amount + unit on
          row 1 (so longer translations never clip), and on row 2 the all-day
          time beside Add (or Add across the row for timed alerts) (#894). */}
      <div className="px-4 py-2.5 flex flex-col gap-2 text-compact text-pn">
        <span className="text-small text-pn-muted">{t('alerts.custom')}</span>
        <div className="flex items-center gap-2">
          <TextField
            size="sm"
            type="number"
            inputMode="numeric"
            min={0}
            max={999}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label={t('alerts.custom')}
            className={`w-14 shrink-0 !ps-2 !pe-2 text-center tabular-nums ${NO_SPIN}`}
          />
          <Select
            size="sm"
            value={unit}
            onChange={(e) => setUnit(e.target.value as typeof unit)}
            aria-label={t('alerts.custom')}
            className="flex-1 min-w-0"
          >
            {(timed ? (['minutes', 'hours', 'days', 'weeks'] as const) : (['days', 'weeks'] as const)).map((u) => (
              <option key={u} value={u}>{t(`alerts.units.${u}`)}</option>
            ))}
          </Select>
        </div>
        {!timed ? (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-pn-muted">{t('alerts.at')}</span>
            <TimeField
              day={day}
              value={at}
              label={t('alerts.at')}
              onCommit={(v) => v && setAt(v)}
              onDraft={setTypedAt}
              className="w-[5.25rem] shrink-0 rounded-md border border-divider bg-track px-2 py-1.5 text-body text-pn tabular-nums text-center focus:border-accent outline-none"
            />
            <Button action="add" disabled={full || taken} onClick={addCustom} className="flex-1 min-w-0 justify-center whitespace-nowrap">
              {t('common:actions.add')}
            </Button>
          </div>
        ) : (
          <Button action="add" disabled={full || taken} onClick={addCustom} className="w-full justify-center">
            {t('common:actions.add')}
          </Button>
        )}
        {full && <span className="text-small text-pn-muted">{t('alerts.max')}</span>}
      </div>
    </>
  );
}

/** Custom repeat: every N units, the weekdays of a weekly repeat, the day or
 *  the Nth weekday of a monthly one, and how it ends. */
function CustomRepeat({ ui, day, current, onBack, onApply }: { ui: MenuUi; day: string; current: Repeat | null; onBack: () => void; onApply: (r: Repeat) => void }) {
  const { t } = useTranslation('shell');
  const { BackRow } = ui;
  const [every, setEvery] = useState<RepeatUnit>(current?.every ?? 'week');
  const [interval, setInterval] = useState(String(current?.interval ?? 1));
  const [weekdays, setWeekdays] = useState<number[]>(current?.weekdays ?? [weekdayOf(day)]);
  const [monthly, setMonthly] = useState<'day' | 'weekday'>(current?.monthly ?? 'day');
  const [ends, setEnds] = useState<'never' | 'on' | 'after'>(current?.until ? 'on' : current?.count ? 'after' : 'never');
  const [until, setUntil] = useState(current?.until ?? shiftDay(day, 30));
  const [count, setCount] = useState(String(current?.count ?? 10));
  const n = Math.max(1, Math.min(999, Number(interval) || 1));
  const nth = nthOf(day) > 4 ? -1 : (nthOf(day) as 1 | 2 | 3 | 4);
  const draft: Repeat = {
    every,
    interval: n,
    ...(every === 'week' && weekdays.length ? { weekdays: [...weekdays].sort((a, b) => a - b) } : {}),
    ...(every === 'month' ? { monthly, ...(monthly === 'weekday' ? { nth } : {}) } : {}),
    ...(ends === 'on' ? { until } : {}),
    ...(ends === 'after' ? { count: Math.max(1, Math.min(999, Number(count) || 1)) } : {}),
    ...(current?.skip?.length ? { skip: current.skip } : {}),
  };
  const radio = (on: boolean) => `w-4 h-4 rounded-full border-2 ${on ? 'border-accent bg-accent' : 'border-divider'}`;
  return (
    <>
      <BackRow title={t('repeat.custom')} onBack={onBack} />
      <div className="px-4 py-3 space-y-3 text-compact text-pn">
        <RepeatIntervalFields
          interval={interval}
          onIntervalChange={setInterval}
          every={every}
          onEveryChange={setEvery}
          showWeekdays={every === 'week'}
          weekdays={weekdays}
          onToggleWeekday={(w) =>
            setWeekdays((cur) => (cur.includes(w) ? (cur.length > 1 ? cur.filter((x) => x !== w) : cur) : [...cur, w]))
          }
        />
        {every === 'month' && (
          <div className="flex flex-col gap-1.5">
            {(['day', 'weekday'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 cursor-pointer">
                <input type="radio" className="sr-only" checked={monthly === m} onChange={() => setMonthly(m)} />
                <span aria-hidden="true" className={radio(monthly === m)} />
                {m === 'day'
                  ? t('repeat.onDay', { day: Number(day.slice(8, 10)) })
                  : t('repeat.onNth', { nth: t(nth === -1 ? 'repeat.nth.last' : `repeat.nth.${nth}`), weekday: weekdayLabel(weekdayDate(weekdayOf(day)), 'long') })}
              </label>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-pn-muted">{t('repeat.ends')}</span>
          {(['never', 'on', 'after'] as const).map((e) => (
            <label key={e} className="flex items-center gap-2 cursor-pointer min-h-8">
              <input type="radio" className="sr-only" checked={ends === e} onChange={() => setEnds(e)} />
              <span aria-hidden="true" className={radio(ends === e)} />
              <span className="flex-1">{t(e === 'never' ? 'repeat.endsNever' : e === 'on' ? 'repeat.endsOn' : 'repeat.endsAfter')}</span>
              {e === 'on' && ends === 'on' && <span className="tabular-nums text-pn-muted">{formatDay(until, 'date')}</span>}
              {e === 'after' && ends === 'after' && (
                <TextField
                  size="sm"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={999}
                  value={count}
                  onChange={(ev) => setCount(ev.target.value)}
                  onKeyDown={(ev) => ev.stopPropagation()}
                  aria-label={t('repeat.endsAfter')}
                  className={`w-16 h-8 shrink-0 !ps-2 !pe-2 py-0 text-center tabular-nums ${NO_SPIN}`}
                />
              )}
            </label>
          ))}
          {ends === 'on' && (
            <div className="flex justify-center pt-1">
              <MonthGrid marked={NO_DAYS} selected={until} initialMonth={until} onPick={(d) => setUntil(d < day ? day : d)} />
            </div>
          )}
        </div>
        <p className="text-small text-pn-muted">{describeRepeat(draft, day, t)}</p>
        <Button action="apply" onClick={() => onApply(draft)} className="w-full justify-center">
          {t('repeat.apply')}
        </Button>
      </div>
    </>
  );
}

