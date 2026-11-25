import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { isTime } from './schedule';
import { timeLabel } from './JournalCalendar';
import { toLocalIso } from './intlFormat';
import { parseTimeLabel } from './timeLabel';
import { NO_TEXT_ASSIST } from './formFields';
import { isTouchOnly } from './touchOnly';
import { detectDeviceOs } from './deviceFingerprint';

/** iPhone and iPad draw the time as a wheel that reports every step. */
const IOS_WHEEL = typeof navigator !== 'undefined' && ['iPhone', 'iPad'].includes(detectDeviceOs());

/** What a native time input's value commits: an `HH:MM` time, `null` for a
 *  cleared field that may be cleared, or `undefined` for nothing to commit. */
export function nativeTimeCommit(raw: string, clearable: boolean): string | null | undefined {
  if (raw === '') return clearable ? null : undefined;
  return isTime(raw) ? raw : undefined;
}

/**
 * A time field. A phone or tablet gets the device's own time picker, which
 * reads and writes the stored `HH:MM` and shows the device's 12 or 24 hour
 * clock. A pointer device gets a text field that shows the time as the clock
 * setting writes it and takes it as typed ("15:00", "3pm"). Both commit on
 * Enter, on the picker's change (not on iOS, whose wheel changes before its
 * Done tick), or when the field loses focus.
 * Spec: docs/internal/issues/0550.md (Spec)
 */
export function TimeInput({ value, onCommit, onDraft, label, className, day, clearable = false }: {
  value: string | undefined;
  onCommit: (time: string | null) => void;
  /** The time as typed, before it commits: `HH:MM`, or `null` while the
   *  field holds no time it can read and once the draft ends. A button that
   *  depends on the time reads it, so it does not wait for the blur that the
   *  click on it causes (#833). */
  onDraft?: (time: string | null) => void;
  label: string;
  className: string;
  /** The day the time falls on, for the label of a day with a clock change. */
  day?: string;
  /** An emptied field commits `null`; otherwise it keeps the old time. */
  clearable?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const native = isTouchOnly();
  const ref = useRef<HTMLInputElement>(null);
  const commitRef = useRef<(raw: string | null) => void>(() => {});

  const commitRaw = (raw: string | null) => {
    if (raw === null) return;
    setDraft(null);
    onDraft?.(null);
    const next = native
      ? nativeTimeCommit(raw, clearable)
      : raw.trim() === '' ? (clearable ? null : undefined) : parseTimeLabel(raw) ?? undefined;
    if (next !== undefined && next !== (value ?? null)) onCommit(next);
  };
  const commit = () => commitRaw(draft);
  commitRef.current = commitRaw;

  // The picker's own change event fires once a time is picked; React's
  // onChange follows every wheel step on iOS, which is too early to save.
  // This listener runs before React's, so it reads the value off the field.
  // On iOS the change fires when the wheel settles, before the picker's Done
  // tick, so a repeating event asked its question mid-pick (#696): there the
  // time saves on blur, which Done and a tap outside both cause.
  useEffect(() => {
    const el = ref.current;
    if (!native || !el || IOS_WHEEL) return;
    const onChange = () => commitRef.current(el.value);
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, [native]);

  // Safari's Reset puts back the field's default value, which React keeps
  // equal to the current time; without it, Reset empties a clearable field.
  useEffect(() => {
    if (native && clearable) ref.current?.removeAttribute('value');
  });

  const shared = {
    ref,
    'aria-label': label,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setDraft(raw);
      onDraft?.((native ? nativeTimeCommit(raw, false) : parseTimeLabel(raw)) ?? null);
    },
    onBlur: commit,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      e.stopPropagation();
    },
    className,
  };

  // A tap on the field opens the picker, so Chrome's clock glyph inside the
  // box only takes room from the time.
  if (native) return <input type="time" value={draft ?? value ?? ''} {...shared} className={`${className} min-w-[6.5rem] [&::-webkit-calendar-picker-indicator]:hidden`} />;
  return (
    <input
      type="text"
      inputMode="text"
      autoComplete="off"
      {...NO_TEXT_ASSIST}
      value={draft ?? (value ? timeLabel(day ?? toLocalIso(new Date()), value) : '')}
      placeholder="--:--"
      onFocus={(e) => e.currentTarget.select()}
      {...shared}
    />
  );
}
