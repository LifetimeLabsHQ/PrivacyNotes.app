import { forwardRef, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { bindingCaps, type KeyBinding, type KeyOs } from '../commandKeys';
import { useEscapeToClose } from '../useEscapeToClose';
import { FIELD_CLASS } from '../formFields';
import { SETTINGS_HELP, SETTINGS_SELECT } from '../settingsUI';

/** The two field boxes: `md` in a window or an item form, `sm` in a settings row. */
const BOX = { md: FIELD_CLASS, sm: SETTINGS_SELECT } as const;

/** The label over a field: the accent glyph and 12px medium text. */
const LABEL = 'mb-1 flex items-center gap-1.5 text-small font-medium text-pn-muted';

/**
 * @catalog TextField
 * use: every one-line text, number or time input. `size="md"` (the default) in a window or an item form, `size="sm"` in a settings row. `label` sits over it with an optional accent `icon` (13px), the anatomy of the item forms; `hint` sits under it in the helper style; `error` replaces the hint in red.
 * never: an <input> with its own border, padding or text size; a label of your own over a field; a placeholder that carries the only instruction.
 */
export const TextField = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label?: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  size?: 'md' | 'sm';
}>(function TextField({ label, icon, hint, error, size = 'md', className = '', id, ...rest }, ref) {
  const auto = useId();
  const fieldId = id ?? auto;
  const wrapped = Boolean(label || hint || error);
  const field = (
    <input
      ref={ref}
      id={fieldId}
      aria-invalid={error ? true : undefined}
      {...rest}
      className={`min-w-0${wrapped ? ' w-full' : ''} ${BOX[size]}${error ? ' border-danger' : ''}${className ? ` ${className}` : ''}`}
    />
  );
  if (!wrapped) return field;
  return (
    <div className="min-w-0">
      {label && (
        <label htmlFor={fieldId} className={LABEL} dir="auto">
          {icon && <span className="shrink-0 text-accent" aria-hidden="true">{icon}</span>}
          {label}
        </label>
      )}
      {field}
      {error ? <p className="mt-1 text-small text-danger">{error}</p> : hint && <p className={`mt-1 ${SETTINGS_HELP}`}>{hint}</p>}
    </div>
  );
});

/**
 * @catalog Select
 * use: a choice from a list too long for a segmented control (a range, a time, a unit). Native <select>; `size` as TextField.
 * never: a <select> with its own classes; a select for two or three options (use Segmented).
 */
export function Select({ size = 'md', className = '', children, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: 'md' | 'sm'; children: ReactNode }) {
  return (
    <select {...rest} className={`${BOX[size]}${className ? ` ${className}` : ''}`}>
      {children}
    </select>
  );
}

/**
 * @catalog HotkeyField
 * use: a key the person picks by pressing it (the Ninja hotkey). Every modifier cap is always drawn, bright when it is part of the key and dim when not, so the field says what is held and what is not; focus the field and press the key. `read` turns a press into a key or null, and a null calls `onInvalid`. Escape leaves the field.
 * never: a button that opens a dialog to record a key; a text input for a key.
 * Spec: docs/internal/design/patterns/171-180.md section 171
 */
export function HotkeyField({ value, os, read, onChange, onInvalid, onFocusChange, label }: {
  value: KeyBinding | null;
  os: KeyOs;
  read: (e: KeyboardEvent) => KeyBinding | null;
  onChange: (next: KeyBinding) => void;
  onInvalid?: () => void;
  /** The field took or lost the focus: a global key lets go while it listens. */
  onFocusChange?: (focused: boolean) => void;
  /** The control's name: the field shows key caps, not words. */
  label: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState(false);
  useEscapeToClose(() => ref.current?.blur(), focused);
  const mods: [string, boolean][] = os === 'mac'
    ? [['⌃', !!value?.ctrl], ['⌥', !!value?.alt], ['⇧', !!value?.shift], ['⌘', !!value?.mod]]
    : [['Ctrl', !!(value?.mod || value?.ctrl)], ['Alt', !!value?.alt], ['Shift', !!value?.shift]];
  const key = value ? bindingCaps(value, os).at(-1) : null;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      // WebKit (macOS, Linux) gives a clicked button no focus, so the field
      // would never get the keys: it takes the focus itself.
      onMouseDown={(e) => {
        e.preventDefault();
        e.currentTarget.focus();
      }}
      onFocus={() => {
        setFocused(true);
        onFocusChange?.(true);
      }}
      onBlur={() => {
        setFocused(false);
        onFocusChange?.(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Tab' || ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const next = read(e.nativeEvent);
        if (next) onChange(next);
        else onInvalid?.();
      }}
      className={`inline-flex min-w-48 items-center gap-1.5 ${SETTINGS_SELECT}`}
    >
      {mods.map(([cap, on]) => (
        <span key={cap} aria-hidden="true" className={on ? 'text-pn' : 'text-pn-muted/40'}>{cap}</span>
      ))}
      <span aria-hidden="true" className="ms-1 text-pn">{key}</span>
    </button>
  );
}
