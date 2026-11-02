import { useTranslation } from 'react-i18next';
import { ArrowLineDown, BellRinging, BellSimple, CalendarCheck, CalendarDots, Cake, Clock, Devices, Hash, Eye, Sun } from './icons';
import { ROW_TITLE, RowTitle, SectionEyebrow, SETTINGS_HELP, SETTINGS_ROW, SETTINGS_SELECT, SETTINGS_TRACK, settingsSegClass, SettingsCallout, ResetDefaultsButton } from './settingsUI';
import { Switch } from './Switch';
import { ProMark } from './UpgradeModal';
import { formatDay, toLocalIso, weekdayDate, weekdayLabel, WEEK_STARTS, WEEK_START_DAY, type WeekStart } from './intlFormat';
import { intlLocale } from './languages';
import { firstWeekday } from './MonthGrid';
import { isTime } from './schedule';
import { TimeInput as TimeField } from './TimeInput';
import { alertLabel, ALL_DAY_ALERTS, TIMED_ALERTS } from './scheduleText';
import type { CalendarSettings as Settings } from './userSettings';
import { defaultCalendarSettings, defaultSettings } from './userSettingsShape';
import { ReminderPermissionControl, useReminderPermission, useRemindersThrough, REMINDER_PLATFORM } from './notesView/useReminders';

/**
 * Settings › Date & Time › Calendar: the default alerts (Pro), whether a reminder shows the
 * title, where reminders ring on this device, the first day of the week, the
 * hours the hour grid opens on and the week numbers. Every value syncs; where
 * a reminder rings is this device's own answer.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (decisions 11, 12, 15; step 7)
 */

// The end padding keeps the browser's own arrow off the border.
const SELECT = SETTINGS_SELECT;
const FIELD = 'w-24 rounded-md bg-track border border-divider px-2.5 py-1.5 text-body text-pn text-center tabular-nums focus:border-accent focus:outline-none';
const NONE = 'none';

/** A time field of a settings row; it cannot be emptied. */
export function TimeInput({ value, onCommit, label }: { value: string; onCommit: (t: string) => void; label: string }) {
  return <TimeField value={value} label={label} onCommit={(t) => t && onCommit(t)} className={FIELD} />;
}

export function CalendarSettings({ value, onChange, weekStart, onWeekStartChange, alertsUnlocked, showPro, onUpgrade }: {
  value: Settings;
  onChange: (next: Settings) => void;
  /** A top-level synced key, not part of `value`: an older client copies it through. */
  weekStart: WeekStart;
  onWeekStartChange: (weekStart: WeekStart) => void;
  alertsUnlocked: boolean;
  showPro: boolean;
  onUpgrade: () => void;
}) {
  const { t } = useTranslation('settings');
  const { t: ts } = useTranslation('shell');
  const today = toLocalIso(new Date());
  const through = useRemindersThrough();
  const permission = useReminderPermission();
  const set = (patch: Partial<Settings>) => onChange({ ...value, ...patch });
  const pro = showPro ? <ProMark /> : null;
  const guard = (fn: () => void) => () => (alertsUnlocked ? fn() : onUpgrade());
  // The weekday names come from Intl, so the choices need no strings of their own.
  const starts = WEEK_STARTS.map((v) => ({
    value: v,
    label: v === 'auto' ? t('language.automatic') : weekdayLabel(weekdayDate(WEEK_START_DAY[v]), 'long'),
  }));
  const firstDay = weekdayLabel(weekdayDate(firstWeekday(intlLocale(), weekStart)), 'long');

  const dayAlertRow = (icon: typeof Sun, title: string, current: { days: number; at: string } | null, write: (v: { days: number; at: string } | null) => void) => (
    <div className={SETTINGS_ROW}>
      <RowTitle icon={icon}>{title}</RowTitle>
      <div className="flex items-center gap-2 text-body">
        <select
          value={current === null ? NONE : String(current.days)}
          onChange={(e) => guard(() => write(e.target.value === NONE ? null : { days: Number(e.target.value), at: current?.at ?? '09:00' }))()}
          aria-label={title}
          className={SELECT}
        >
          <option value={NONE}>{ts('alerts.none')}</option>
          {ALL_DAY_ALERTS.map((days) => (
            <option key={days} value={days}>{days === 0 ? ts('alerts.onDay') : ts('alerts.daysBefore', { count: days })}</option>
          ))}
        </select>
        {current && <>
          <span className="text-pn-muted">{ts('alerts.at')}</span>
          <TimeInput value={current.at} label={title} onCommit={(at) => guard(() => write({ ...current, at }))()} />
        </>}
      </div>
    </div>
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto text-pn">
      <SectionEyebrow icon={CalendarDots} className="px-6 pt-4">{t('shell:listPrefs.view')}</SectionEyebrow>
      <div className="px-6 divide-y divide-divider">
        <div data-setting="calendar.weekStart" className={SETTINGS_ROW}>
          <div className="min-w-0">
            <RowTitle icon={CalendarCheck}>{t('calendar.weekStart')}</RowTitle>
            <p className={`${SETTINGS_HELP} mt-0.5`}>{t('calendar.weekStartHelp', { day: firstDay })}</p>
          </div>
          <div className={SETTINGS_TRACK}>
            {starts.map(({ value: v, label }) => (
              <button key={v} type="button" onClick={() => onWeekStartChange(v)} aria-pressed={weekStart === v} className={settingsSegClass(weekStart === v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div data-setting="calendar.hours" className={SETTINGS_ROW}>
          <div className="min-w-0">
            <RowTitle icon={ArrowLineDown}>{t('calendar.hours')}</RowTitle>
            <p className={`${SETTINGS_HELP} mt-0.5`}>{t('calendar.hoursHelp')}</p>
          </div>
          <TimeInput value={value.hourStart} label={t('calendar.hours')} onCommit={(v) => isTime(v) && set({ hourStart: v })} />
        </div>
        <Switch
          setting="calendar.weekNumbers"
          label={t('calendar.weekNumbers')}
          icon={<Hash className="text-accent" />}
          labelClassName={ROW_TITLE}
          description={t('calendar.weekNumbersHelp')}
          checked={value.weekNumbers}
          onChange={(on) => set({ weekNumbers: on })}
          className="py-3"
        />
      </div>
      <SectionEyebrow icon={BellRinging} className="px-6 pt-6">{t('calendar.groupReminders')}</SectionEyebrow>
      <div className="px-6 divide-y divide-divider">
        <div data-setting="calendar.where" className={`${SETTINGS_ROW}`}>
          <div className="min-w-0">
            <RowTitle icon={Devices}>{t('calendar.whereTitle')}</RowTitle>
            <p className={`${SETTINGS_HELP} mt-0.5`}>{t(`calendar.reminderHint.${REMINDER_PLATFORM}`)}</p>
            {through && <p className={`${SETTINGS_HELP} mt-0.5`}>{t('calendar.scheduledThrough', { date: formatDay(through, 'date') })}</p>}
            {permission === 'denied' && <SettingsCallout className="mt-1.5">{t('calendar.permissionDenied')}</SettingsCallout>}
          </div>
          <ReminderPermissionControl />
        </div>
        {/* The daily check-in reminder lives in Settings > Trackers > Check-in. */}
        <Switch
          setting="calendar.reminderTitles"
          label={t('calendar.reminderTitles')}
          icon={<Eye className="text-accent" />}
          labelClassName={ROW_TITLE}
          description={t('calendar.reminderTitlesHelp')}
          checked={value.reminderTitles}
          onChange={(on) => set({ reminderTitles: on })}
          className="py-3"
        />
      </div>
      <SectionEyebrow icon={BellSimple} className="px-6 pt-6">{t('calendar.groupDefaults')} {pro}</SectionEyebrow>
      <p className={`${SETTINGS_HELP} px-6 mt-1`}>{t('calendar.alertsHelp')}</p>
      <div className="px-6 pb-4 divide-y divide-divider">
        <div data-setting="calendar.alertTimed" className={SETTINGS_ROW}>
          <RowTitle icon={Clock}>{t('calendar.alertTimed')}</RowTitle>
          <select
            value={value.alertTimed === null ? NONE : String(value.alertTimed)}
            onChange={(e) => guard(() => set({ alertTimed: e.target.value === NONE ? null : Number(e.target.value) }))()}
            aria-label={t('calendar.alertTimed')}
            className={SELECT}
          >
            <option value={NONE}>{ts('alerts.none')}</option>
            {TIMED_ALERTS.map((before) => (
              <option key={before} value={before}>{alertLabel({ before }, today, ts)}</option>
            ))}
          </select>
        </div>
        <div data-setting="calendar.alertAllDay">{dayAlertRow(Sun, t('calendar.alertAllDay'), value.alertAllDay, (v) => set({ alertAllDay: v }))}</div>
        <div data-setting="calendar.alertBirthday">{dayAlertRow(Cake, ts('calendar.birthdays'), value.alertBirthday, (v) => set({ alertBirthday: v }))}</div>
      </div>
      {/* The device's own reminder switch is not a synced setting, so the reset leaves it. */}
      <div className="px-6 pb-6">
        <ResetDefaultsButton onReset={() => { onChange(defaultCalendarSettings()); onWeekStartChange(defaultSettings().weekStart); }} />
      </div>
    </div>
  );
}

