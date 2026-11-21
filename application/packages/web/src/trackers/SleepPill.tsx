import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SLEEP_QUALITIES, type SleepQuality } from '../trackerTypes';
import { PillShell } from './PillShell';
import { useLastLogged } from '../trackerLastLogged';
import { TRACKER_ICONS } from './icons';
import { ChoiceGrid, NumberStepper, PanelQuestion } from './panelUI';
import { joinSleepHours, sleepHoursText, splitSleepHours } from '../trackerExport';

/** The hours the quick picks offer; the usual nights. */
const QUICK_HOURS = [6, 7, 8, 9] as const;
const QUICK_MINUTES = [0, 15, 30, 45] as const;
const DEFAULT_HOURS = 7.5;

/**
 * Sleep pill - the night as two steppers side by side, hours (0 to 14) and
 * minutes (0 to 59), then the quality as one choice. A night is a clock
 * length, so 7 and 37 is seven hours and 37 minutes, never 7.37 hours
 * (GitHub #792); it is stored as decimal hours, to the minute. Both fields
 * take the number pad. The hours save as they change; the quality tap
 * commits both and closes the panel, so it is the step that moves the pass
 * on. A quality without hours takes the default night. A tap on the chosen
 * quality removes the night, hours and all.
 */
export function SleepPill({
  value,
  expanded,
  onToggle,
  onChange,
  readOnly,
}: {
  value?: { quality: SleepQuality; hours?: number };
  expanded: boolean;
  onToggle: () => void;
  /** `undefined` removes the night. */
  onChange: (v: { quality: SleepQuality; hours?: number } | undefined) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation('trackers');
  const lastHours = useLastLogged((d) => d.sleep?.hours);
  const filledLabel = value
    ? `${t(`sleep.quality.${value.quality}`)} (${sleepHoursText(value.hours ?? DEFAULT_HOURS)})`
    : undefined;
  const qualities = SLEEP_QUALITIES.map((q) => ({ key: q, label: t(`sleep.quality.${q}`) }));
  // The hours and the quality each write the pair, built from the last pair
  // this pill wrote: the typed hours save on blur or on close, a moment
  // before or after the quality tap, and `value` can still be the pair from
  // before the other write.
  type Sleep = { quality: SleepQuality; hours?: number };
  const latest = useRef<Sleep | undefined>(value);
  useEffect(() => { latest.current = value; }, [value]);
  const write = (v: Sleep) => { latest.current = v; onChange(v); };
  // One side of the night changes, the other is kept: the stored night, else
  // the hint the empty field shows, the last night's hours and no minutes.
  const hintHours = splitSleepHours(lastHours ?? DEFAULT_HOURS).h;
  const night = value?.hours != null ? splitSleepHours(value.hours) : null;
  // A quality tap on an empty night fills the default length; hours typed
  // just before it save after it, and must not take the default's minutes.
  const defaulted = useRef(false);
  useEffect(() => { if (expanded) defaulted.current = false; }, [expanded]);
  const writeTime = (part: { h?: number; m?: number }) => {
    const held = latest.current?.hours != null && !defaulted.current ? splitSleepHours(latest.current.hours) : { h: hintHours, m: 0 };
    defaulted.current = false;
    write({ quality: latest.current?.quality ?? 'okay', hours: joinSleepHours(part.h ?? held.h, part.m ?? held.m) });
  };

  return (
    <PillShell
      label={t('labels.sleep')}
      filled={value != null}
      expanded={expanded}
      onToggle={onToggle}
      filledLabel={filledLabel}
      icon={TRACKER_ICONS.sleep}
      readOnly={readOnly}
    >
      <div className="flex flex-col gap-4 max-w-[420px]">
        <div>
          <PanelQuestion>{t('sleep.hoursLabel')}</PanelQuestion>
          <div className="grid grid-cols-2 gap-2">
            <NumberStepper
              value={night?.h ?? null}
              onChange={(h) => writeTime({ h })}
              min={0}
              max={14}
              step={1}
              unit={t('units.hoursSuffix')}
              quick={QUICK_HOURS}
              start={lastHours != null ? hintHours : undefined}
              placeholder={String(hintHours)}
              expanded={expanded}
            />
            <NumberStepper
              value={night?.m ?? null}
              onChange={(m) => writeTime({ m })}
              min={0}
              max={59}
              step={5}
              unit={t('units.minutesSuffix')}
              quick={QUICK_MINUTES}
              start={0}
              expanded={expanded}
            />
          </div>
        </div>
        <div>
          <PanelQuestion>{t('sleep.prompt')}</PanelQuestion>
          <ChoiceGrid
            options={qualities}
            value={value?.quality}
            onPick={(q) => {
              defaulted.current = latest.current?.hours == null;
              write({ quality: q, hours: latest.current?.hours ?? DEFAULT_HOURS });
              onToggle();
            }}
            onClear={() => { latest.current = undefined; onChange(undefined); }}
          />
        </div>
      </div>
    </PillShell>
  );
}
