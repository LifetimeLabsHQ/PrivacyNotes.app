import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BellSimple,
  CalendarBlank,
  CalendarPlus,
  Check,
  Clock,
  Repeat as RepeatGlyph,
  Sun,
  X,
} from './icons';
import { ActionItem, Group, OptionsMenu, ProBadge } from './OptionsMenu';
import { BackRow, Button, CloseButton, SettingsSegmented } from './ui';
import { MonthGrid } from './MonthGrid';
import { RepeatIntervalFields } from './RepeatIntervalFields';
import { TimeInput } from './TimeInput';
import { formatDay, toLocalIso } from './intlFormat';
import { timeLabel } from './JournalCalendar';
import { askForRemindersOnce } from './notesView/useReminders';
import { isTime, shiftDay, type RepeatUnit } from './schedule';
import {
  taskReminderPresets,
  type TaskReminder,
  type TaskRepeat,
  type TaskRepeatUnit,
  type TaskScheduleEvery,
} from './taskReminderSyntax';
import { formatTaskRepeatLabel, taskReminderDayLabel } from './taskReminderText';

/**
 * Shared reminder & repeat picker for individual checkboxes.
 * Used by both the note editor (`Editor.tsx`) and the Tasks list (`TasksList.tsx`).
 * Shares `OptionsMenu`, `Group`, `ActionItem`, `ProBadge`, `BackRow`, `MonthGrid`,
 * `TimeInput`, and `RepeatIntervalFields` with `NoteOptionsMenu` / `ScheduleView`.
 */

type Screen = 'quick' | 'custom' | 'repeat';

const NO_DAYS: ReadonlySet<string> = new Set();
const WORKWEEK = [1, 2, 3, 4, 5];

const UNIT_TO_EVERY: Record<TaskRepeatUnit, TaskScheduleEvery> = {
  d: 'day',
  w: 'week',
  m: 'month',
  y: 'year',
};

const EVERY_TO_UNIT: Record<RepeatUnit, TaskRepeatUnit> = {
  day: 'd',
  week: 'w',
  month: 'm',
  year: 'y',
};

function sameTaskRepeat(a: TaskRepeat | undefined, b: TaskRepeat | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.mode !== b.mode) return false;
  if (a.mode === 'after' && b.mode === 'after') {
    return a.interval === b.interval && a.unit === b.unit;
  }
  if (a.mode === 'schedule' && b.mode === 'schedule') {
    const wa = [...(a.weekdays ?? [])].sort().join(',');
    const wb = [...(b.weekdays ?? [])].sort().join(',');
    return a.every === b.every && a.interval === b.interval && wa === wb;
  }
  return false;
}

export interface TaskReminderPopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  current: TaskReminder | null;
  alertsUnlocked: boolean;
  showPro: boolean;
  onUpgrade: () => void;
  onSave: (next: TaskReminder | null) => void;
  onClose: () => void;
}

export default function TaskReminderPopover({
  open,
  anchorRef,
  current,
  alertsUnlocked,
  showPro,
  onUpgrade,
  onSave,
  onClose,
}: TaskReminderPopoverProps) {
  const { t } = useTranslation('shell');

  const todayIso = toLocalIso(new Date());
  const defaultDay = current?.day ?? shiftDay(todayIso, 1);
  const defaultTime = current?.time ?? '09:00';

  const [screen, setScreen] = useState<Screen>('quick');
  const [repeatFrom, setRepeatFrom] = useState<'quick' | 'custom'>('quick');
  const [draftDay, setDraftDay] = useState(defaultDay);
  const [draftTime, setDraftTime] = useState(defaultTime);
  const [typedTime, setTypedTime] = useState<string | null>(null);
  const [draftRepeat, setDraftRepeat] = useState<TaskRepeat | undefined>(current?.repeat);

  // Custom repeat editor state
  const [repeatMode, setRepeatMode] = useState<'schedule' | 'after'>(current?.repeat?.mode ?? 'schedule');
  const [repeatInterval, setRepeatInterval] = useState(String(current?.repeat?.interval ?? 1));
  const [repeatEvery, setRepeatEvery] = useState<RepeatUnit>(
    current?.repeat
      ? current.repeat.mode === 'after'
        ? UNIT_TO_EVERY[current.repeat.unit]
        : current.repeat.every
      : 'week',
  );
  const [repeatWeekdays, setRepeatWeekdays] = useState<number[]>(
    current?.repeat?.mode === 'schedule' && current.repeat.weekdays?.length
      ? current.repeat.weekdays
      : [],
  );

  // Reset local draft each time the popover opens on a (possibly different) task.
  useEffect(() => {
    if (!open) return;
    const nowDay = toLocalIso(new Date());
    const nextDay = current?.day ?? shiftDay(nowDay, 1);
    const nextTime = current?.time ?? '09:00';
    setScreen('quick');
    setRepeatFrom('quick');
    setDraftDay(nextDay);
    setDraftTime(nextTime);
    setTypedTime(null);
    setDraftRepeat(current?.repeat);
    setRepeatMode(current?.repeat?.mode ?? 'schedule');
    setRepeatInterval(String(current?.repeat?.interval ?? 1));
    setRepeatEvery(
      current?.repeat
        ? current.repeat.mode === 'after'
          ? UNIT_TO_EVERY[current.repeat.unit]
          : current.repeat.every
        : 'week',
    );
    setRepeatWeekdays(
      current?.repeat?.mode === 'schedule' && current.repeat.weekdays?.length
        ? current.repeat.weekdays
        : [],
    );
  }, [open, current]);

  const presets = useMemo(() => (open ? taskReminderPresets(new Date(), '09:00') : []), [open]);

  if (!open) return null;

  function commitReminder(next: TaskReminder | null) {
    if (next && !alertsUnlocked) {
      onClose();
      onUpgrade();
      return;
    }
    if (next) askForRemindersOnce();
    onSave(next);
    onClose();
  }

  function applyQuickPreset(day: string, time: string) {
    commitReminder({ day, time, ...(draftRepeat ? { repeat: draftRepeat } : {}) });
  }

  function resolvedDraftTime(): string {
    return typedTime ?? (isTime(draftTime) ? draftTime : '09:00');
  }

  function applyCustomDateTime() {
    commitReminder({
      day: draftDay,
      time: resolvedDraftTime(),
      ...(draftRepeat ? { repeat: draftRepeat } : {}),
    });
  }

  function openRepeatFrom(origin: 'quick' | 'custom') {
    if (origin === 'custom' && typedTime) setDraftTime(typedTime);
    setRepeatFrom(origin);
    setScreen('repeat');
  }

  function pickRepeatPreset(repeat: TaskRepeat | undefined) {
    setDraftRepeat(repeat);
    if (repeatFrom === 'custom') {
      setScreen('custom');
      return;
    }
    commitReminder({ day: draftDay, time: resolvedDraftTime(), ...(repeat ? { repeat } : {}) });
  }

  function applyCustomRepeat() {
    const n = Math.max(1, Math.min(999, Number(repeatInterval) || 1));
    const nextRepeat: TaskRepeat =
      repeatMode === 'after'
        ? { mode: 'after', interval: n, unit: EVERY_TO_UNIT[repeatEvery] }
        : {
            mode: 'schedule',
            every: repeatEvery,
            interval: n,
            ...(repeatEvery === 'week' && repeatWeekdays.length > 0
              ? { weekdays: [...repeatWeekdays].sort((a, b) => a - b) }
              : {}),
          };
    pickRepeatPreset(nextRepeat);
  }

  const repeatPresets: Array<{ key: string; label: string; value: TaskRepeat | undefined }> = [
    { key: 'never', label: t('repeat.never'), value: undefined },
    { key: 'daily', label: t('repeat.daily', { count: 1 }), value: { mode: 'schedule', every: 'day', interval: 1 } },
    { key: 'weekdays', label: t('repeat.weekdays'), value: { mode: 'schedule', every: 'week', interval: 1, weekdays: WORKWEEK } },
    { key: 'weekly', label: t('taskReminder.everyWeeks', { count: 1 }), value: { mode: 'schedule', every: 'week', interval: 1 } },
    { key: 'monthly', label: t('taskReminder.everyMonths', { count: 1 }), value: { mode: 'schedule', every: 'month', interval: 1 } },
    { key: 'yearly', label: t('taskReminder.everyYears', { count: 1 }), value: { mode: 'schedule', every: 'year', interval: 1 } },
  ];

  const backFromCurrent = () => setScreen(screen === 'repeat' ? repeatFrom : 'quick');

  return (
    <OptionsMenu
      anchorRef={anchorRef}
      label={t('alerts.reminder')}
      view={screen}
      onClose={onClose}
      onEscape={screen === 'quick' ? onClose : backFromCurrent}
      className="w-72"
    >
      {screen === 'quick' && (
        <>
          <div className="flex items-center justify-between gap-2 px-4 py-2.5">
            <span className="inline-flex items-center gap-2 text-body font-semibold text-pn">
              <BellSimple className="shrink-0 text-accent" aria-hidden="true" />
              <span>{t('alerts.reminder')}</span>
              {showPro && <ProBadge />}
            </span>
            <CloseButton onClick={onClose} />
          </div>

          <Group>
            {presets.map((p) => {
              const Icon =
                p.key === 'laterToday' ? Clock : p.key === 'tomorrow' ? Sun : CalendarBlank;
              const label =
                p.key === 'laterToday'
                  ? t('taskReminder.laterToday')
                  : p.key === 'tomorrow'
                    ? taskReminderDayLabel(p.day, todayIso)
                    : t('monthGrid.nextWeek');
              const right =
                p.key === 'laterToday'
                  ? timeLabel(p.day, p.time)
                  : `${formatDay(p.day, 'weekdayShort')}, ${timeLabel(p.day, p.time)}`;
              return (
                <ActionItem
                  key={p.key}
                  label={label}
                  icon={<Icon aria-hidden="true" />}
                  value={right}
                  onClick={() => applyQuickPreset(p.day, p.time)}
                />
              );
            })}
          </Group>

          <Group>
            <ActionItem
              label={t('taskReminder.pickDateTime')}
              icon={<CalendarPlus aria-hidden="true" />}
              chevron
              onClick={() => setScreen('custom')}
            />
            <ActionItem
              label={t('repeat.label')}
              icon={<RepeatGlyph aria-hidden="true" />}
              value={draftRepeat ? formatTaskRepeatLabel(draftRepeat, t) : t('repeat.never')}
              chevron
              onClick={() => openRepeatFrom('quick')}
            />
          </Group>

          {current && (
            <Group>
              <ActionItem
                label={t('taskReminder.remove')}
                icon={<X aria-hidden="true" />}
                tone="danger"
                onClick={() => commitReminder(null)}
              />
            </Group>
          )}
        </>
      )}

      {screen === 'custom' && (
        <>
          <BackRow title={t('taskReminder.dateTime')} onBack={() => setScreen('quick')} />
          <div className="flex justify-center px-2 pt-3 pb-2">
            <MonthGrid
              marked={NO_DAYS}
              selected={draftDay}
              initialMonth={draftDay}
              onPick={setDraftDay}
            />
          </div>
          <Group>
            <div className="flex items-center gap-3 px-4 py-1.5 text-body text-pn">
              <Clock className="shrink-0 text-accent" aria-hidden="true" />
              <span className="flex-1 min-w-0 truncate">{t('quickAdd.syntax.time.label')}</span>
              <TimeInput
                day={draftDay}
                value={draftTime}
                label={t('quickAdd.syntax.time.label')}
                onCommit={(v) => { if (v) setDraftTime(v); }}
                onDraft={setTypedTime}
                className="w-[5.5rem] h-8 rounded-md border border-divider bg-track px-2 text-body text-pn tabular-nums text-center focus:border-accent outline-none"
              />
            </div>
            <ActionItem
              label={t('repeat.label')}
              icon={<RepeatGlyph aria-hidden="true" />}
              value={draftRepeat ? formatTaskRepeatLabel(draftRepeat, t) : t('repeat.never')}
              chevron
              onClick={() => openRepeatFrom('custom')}
            />
          </Group>
          <div className="px-4 py-2.5">
            <Button action="save" onClick={applyCustomDateTime} className="w-full justify-center" />
          </div>
        </>
      )}

      {screen === 'repeat' && (
        <>
          <BackRow title={t('repeat.label')} onBack={backFromCurrent} />
          <Group>
            {repeatPresets.map((p) => {
              const active = sameTaskRepeat(draftRepeat, p.value);
              return (
                <ActionItem
                  key={p.key}
                  label={p.label}
                  icon={active ? <Check aria-hidden="true" /> : <span className="inline-block w-4" />}
                  onClick={() => pickRepeatPreset(p.value)}
                />
              );
            })}
          </Group>
          <div className="px-4 py-3 flex flex-col gap-2.5 text-compact text-pn">
            <span className="text-small font-medium text-pn-muted">{t('repeat.custom')}</span>
            <SettingsSegmented
              value={repeatMode}
              onChange={(v) => setRepeatMode(v as 'schedule' | 'after')}
              label={t('repeat.custom')}
              options={[
                { value: 'schedule', label: t('taskReminder.onSchedule') },
                { value: 'after', label: t('taskReminder.afterCompletion') },
              ]}
            />
            <RepeatIntervalFields
              interval={repeatInterval}
              onIntervalChange={setRepeatInterval}
              every={repeatEvery}
              onEveryChange={setRepeatEvery}
              showWeekdays={repeatMode === 'schedule' && repeatEvery === 'week'}
              weekdays={repeatWeekdays}
              onToggleWeekday={(w) =>
                setRepeatWeekdays((cur) => (cur.includes(w) ? cur.filter((x) => x !== w) : [...cur, w]))
              }
            />
            {repeatMode === 'after' && (
              <p className="text-small text-pn-muted">{t('taskReminder.afterDoneHint')}</p>
            )}
            <Button action="apply" onClick={applyCustomRepeat} className="w-full justify-center">
              {t('repeat.apply')}
            </Button>
          </div>
        </>
      )}
    </OptionsMenu>
  );
}
