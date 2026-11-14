import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DIASTOLIC_RANGE, SYSTOLIC_RANGE, bloodPressureText, hasBloodPressure, type BloodPressure } from '../trackerTypes';
import { PillShell } from './PillShell';
import { useLastLogged } from '../trackerLastLogged';
import { TRACKER_ICONS } from './icons';
import { NumberStepper, PanelQuestion } from './panelUI';

const QUICK_SYSTOLIC = [110, 120, 130, 140] as const;
const QUICK_DIASTOLIC = [70, 80, 90] as const;

/**
 * Blood pressure pill (GitHub #746) - one reading as two steppers in mmHg,
 * the top number and the bottom number. Each saves as it changes; a side
 * not logged yet shows as a dash on the pill. Clearing both removes the
 * reading.
 */
export function BloodPressurePill({
  value,
  expanded,
  onToggle,
  onChange,
  readOnly,
}: {
  value?: BloodPressure;
  expanded: boolean;
  onToggle: () => void;
  /** `undefined` removes the reading. */
  onChange: (v: BloodPressure | undefined) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation('trackers');
  const lastSys = useLastLogged((d) => d.bloodPressure?.systolic);
  const lastDia = useLastLogged((d) => d.bloodPressure?.diastolic);
  const unit = t('units.mmHg');
  // Each stepper writes the pair, built from the last pair this pill wrote:
  // a typed number saves on blur, a moment before or after the other side's
  // write, and `value` can still be the pair from before it.
  const latest = useRef<BloodPressure | undefined>(value);
  useEffect(() => { latest.current = value; }, [value]);
  const write = (side: keyof BloodPressure, n: number | undefined) => {
    const next: BloodPressure = { ...latest.current };
    if (n === undefined) delete next[side];
    else next[side] = n;
    const v = next.systolic == null && next.diastolic == null ? undefined : next;
    latest.current = v;
    onChange(v);
  };

  return (
    <PillShell
      label={t('labels.bloodPressure')}
      filled={hasBloodPressure(value)}
      expanded={expanded}
      onToggle={onToggle}
      filledLabel={hasBloodPressure(value) ? `${bloodPressureText(value)} ${unit}` : undefined}
      icon={TRACKER_ICONS.bloodPressure}
      readOnly={readOnly}
    >
      <div className="flex flex-col gap-4 max-w-[420px]">
        <div>
          <PanelQuestion>{t('bloodPressure.systolic')}</PanelQuestion>
          <NumberStepper
            value={value?.systolic ?? null}
            onChange={(n) => write('systolic', n)}
            onClear={() => write('systolic', undefined)}
            min={SYSTOLIC_RANGE.min}
            max={SYSTOLIC_RANGE.max}
            step={1}
            unit={unit}
            quick={QUICK_SYSTOLIC}
            start={lastSys}
            placeholder="120"
            expanded={expanded}
          />
        </div>
        <div>
          <PanelQuestion>{t('bloodPressure.diastolic')}</PanelQuestion>
          <NumberStepper
            value={value?.diastolic ?? null}
            onChange={(n) => write('diastolic', n)}
            onClear={() => write('diastolic', undefined)}
            min={DIASTOLIC_RANGE.min}
            max={DIASTOLIC_RANGE.max}
            step={1}
            unit={unit}
            quick={QUICK_DIASTOLIC}
            start={lastDia}
            placeholder="80"
            expanded={expanded}
          />
        </div>
      </div>
    </PillShell>
  );
}
