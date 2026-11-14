import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pairText, type CustomTrackerTemplate, type CustomTrackerType, type JournalTrackerData } from '../trackerTypes';
import { useLastLogged } from '../trackerLastLogged';
import { PillShell } from './PillShell';
import { CustomTrackerGlyph } from './CustomTrackerGlyph';
import { ScaleTiles } from '../MoodScale';
import { ChoiceGrid, NumberStepper, PanelQuestion } from './panelUI';

// Spec: docs/internal/design-decisions.md (number tracker bounds - prevents scientific-notation display)
const MAX_NUMBER = 1e12;

/** Clamp to a sane magnitude and round to 4 decimals so the value never stringifies to exponential form. */
function sanitizeNumber(n: number): number {
  const clamped = Math.max(-MAX_NUMBER, Math.min(MAX_NUMBER, n));
  return Math.round(clamped * 10000) / 10000;
}

/** The quick picks of a 0 to 100 slider tracker. */
const QUICK_HUNDRED = [25, 50, 75, 100] as const;

/**
 * Custom (Pro) tracker pill. Picker shape by template type:
 * scale10 (0-10) and scale5 (0-5) are tiles, slider100 (0-100) and number
 * (+unit) are steppers, yesno is a two-tile choice.
 */
export function CustomPill({
  template,
  value,
  value2,
  expanded,
  onToggle,
  onChange,
  onPairChange,
  readOnly,
}: {
  template: CustomTrackerTemplate;
  value?: number | boolean | string;
  /** A `pair`: the second number. */
  value2?: number;
  expanded: boolean;
  onToggle: () => void;
  /** `undefined` removes the value. */
  onChange: (v: number | boolean | string | undefined) => void;
  /** A `pair`: both numbers; a missing first number removes the reading. */
  onPairChange?: (first: number | undefined, second: number | undefined) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation('trackers');
  const readOwn = (d: JournalTrackerData) => {
    const v = d.customTrackers?.find((e) => e.trackerId === template.id)?.value;
    return typeof v === 'number' ? v : undefined;
  };
  const last = useLastLogged(readOwn);
  const last2 = useLastLogged((d) => d.customTrackers?.find((e) => e.trackerId === template.id)?.value2);

  const filledLabel = useMemo(() => {
    if (value == null) return undefined;
    if (template.type === 'yesno') return value ? t('custom.yes') : t('custom.no');
    if (template.type === 'slider100') return `${value}`;
    if (template.type === 'number') return `${value}`;
    if (template.type === 'pair') return typeof value === 'number' ? pairText(value, value2, template.unit) : `${value}`;
    return `${value}/${template.type === 'scale5' ? 5 : 10}`;
  }, [value, value2, template.type, template.unit, t]);
  const num = typeof value === 'number' ? value : null;

  return (
    <PillShell
      label={template.name}
      filled={value != null}
      expanded={expanded}
      onToggle={onToggle}
      filledLabel={filledLabel}
      icon={<CustomTrackerGlyph icon={template.icon} />}
      readOnly={readOnly}
    >
      <div className="max-w-[420px]">
        {template.type === 'pair' ? (
          <PairInput
            labels={template.pairLabels}
            unit={template.unit}
            value={typeof value === 'number' ? value : undefined}
            value2={value2}
            onChange={(a, b) => onPairChange?.(a, b)}
            expanded={expanded}
            start={template.startFromLast === false ? undefined : last}
            start2={template.startFromLast === false ? undefined : last2}
          />
        ) : (<>
        <PanelQuestion>{template.name}</PanelQuestion>
        <CustomTrackerInput
          name={template.name}
          type={template.type}
          value={value}
          onChange={onChange}
          onClear={() => onChange(undefined)}
          onDone={onToggle}
          expanded={expanded}
          start={template.startFromLast === false ? undefined : last}
          autoFocus
        />
        </>)}
      </div>
    </PillShell>
  );
}

/**
 * The input of a custom tracker, by type: tiles for the two scales, a
 * stepper for the slider and the number, a two-tile choice for yes or no.
 * The pill draws it, and so does the preview of the new-tracker dialog, so
 * the preview is what the person will tap. `onDone` runs after a tap that
 * commits a single value (a tile, a choice).
 */
export function CustomTrackerInput({ name, type, value, onChange, onClear, onDone, expanded, start, autoFocus = false }: {
  name: string;
  type: CustomTrackerType;
  value: number | boolean | string | undefined;
  onChange: (v: number | boolean) => void;
  /** Removes the value: a tap on the chosen tile, an emptied number. */
  onClear?: () => void;
  onDone?: () => void;
  expanded: boolean;
  start?: number;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('trackers');
  const num = typeof value === 'number' ? value : null;
  if (type === 'scale10' || type === 'scale5') {
    const max = type === 'scale5' ? 5 : 10;
    return (
      <ScaleTiles
        min={0}
        max={max}
        value={num}
        onPick={(n) => { onChange(n); onDone?.(); }}
        onClear={onClear}
        label={name}
        ends={[`0 · ${t('scaleEnds.low')}`, `${max} · ${t('scaleEnds.high')}`]}
      />
    );
  }
  if (type === 'slider100') {
    return <NumberStepper value={num} onChange={onChange} onClear={onClear} min={0} max={100} step={1} quick={QUICK_HUNDRED} start={start} placeholder="50" expanded={expanded} />;
  }
  if (type === 'number') {
    return <NumberStepper value={num} onChange={(n) => onChange(sanitizeNumber(n))} onClear={onClear} step={1} freeDecimals start={start} placeholder="0" expanded={expanded} autoFocus={autoFocus} />;
  }
  if (type !== 'yesno') {
    // A type a newer version of the app made: shown, never written, so a
    // tap here cannot replace a value this version does not understand.
    return <p className="text-small text-pn-muted">{t('custom.unknownType')}</p>;
  }
  return (
    <ChoiceGrid
      options={[{ key: true, label: t('custom.yes') }, { key: false, label: t('custom.no') }]}
      value={typeof value === 'boolean' ? value : null}
      onPick={(v) => { onChange(v); onDone?.(); }}
      onClear={onClear}
      size="lg"
    />
  );
}

/**
 * A `pair` tracker's input (GitHub #746): two steppers, each under the name
 * of its number, with the tracker's unit. The reading is saved once the
 * first number is set; a second number typed before it waits here, says so,
 * and is saved with it. Clearing the first number removes the whole reading,
 * so the panel never shows a number it will not keep.
 */
export function PairInput({ labels, unit, value, value2, onChange, expanded, start, start2 }: {
  labels?: [string, string];
  unit?: string;
  value: number | undefined;
  value2: number | undefined;
  onChange: (first: number | undefined, second: number | undefined) => void;
  expanded: boolean;
  start?: number;
  start2?: number;
}) {
  const { t } = useTranslation('trackers');
  // The second number typed while the first is empty, kept until the first arrives.
  const [waiting, setWaiting] = useState<number | undefined>(undefined);
  // Both steppers write the pair from the last pair written here: a typed
  // number saves on blur, a moment before or after the other side's write.
  const latest = useRef<[number | undefined, number | undefined]>([value, value2]);
  useEffect(() => { latest.current = [value, value2]; }, [value, value2]);
  const write = (a: number | undefined, b: number | undefined) => {
    latest.current = [a, b];
    onChange(a, b);
  };
  const shown2 = value2 ?? (value === undefined ? waiting : undefined);
  const first = labels?.[0]?.trim() || t('config.pairFirst');
  const second = labels?.[1]?.trim() || t('config.pairSecond');
  return (
    <div className="flex flex-col gap-4">
      <div>
        <PanelQuestion>{first}</PanelQuestion>
        <NumberStepper
          value={value ?? null}
          onChange={(n) => { write(sanitizeNumber(n), latest.current[1] ?? waiting); setWaiting(undefined); }}
          onClear={() => { setWaiting(undefined); write(undefined, undefined); }}
          step={1}
          freeDecimals
          unit={unit}
          start={start}
          placeholder="0"
          expanded={expanded}
        />
      </div>
      <div>
        <PanelQuestion>{second}</PanelQuestion>
        <NumberStepper
          value={shown2 ?? null}
          onChange={(n) => {
            const b = sanitizeNumber(n);
            if (latest.current[0] === undefined) setWaiting(b);
            else write(latest.current[0], b);
          }}
          onClear={() => {
            if (latest.current[0] === undefined) setWaiting(undefined);
            else write(latest.current[0], undefined);
          }}
          step={1}
          freeDecimals
          unit={unit}
          start={start2}
          placeholder="0"
          expanded={expanded}
        />
        {value === undefined && waiting !== undefined && (
          <p className="mt-1.5 text-small text-pn-muted">{t('config.pairWaiting')}</p>
        )}
      </div>
    </div>
  );
}
