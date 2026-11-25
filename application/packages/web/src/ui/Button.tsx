import type { ComponentProps, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { HoverLabel } from '../HoverLabel';
import { X } from '../icons';
import { ACTIONS, type ActionName } from './actions';
import { IconUpgrade } from '../proMark';
import { SETTINGS_BTN, SETTINGS_BTN_DANGER, SETTINGS_BTN_PRIMARY, SETTINGS_BTN_UPGRADE } from '../settingsUI';

type Variant = 'secondary' | 'primary' | 'danger' | 'successSoft' | 'upgrade';

// Settings callouts also use Button; read their tokens after modules initialize.
function buttonLook(variant: Variant): string {
  switch (variant) {
    case 'secondary': return SETTINGS_BTN;
    case 'primary': return SETTINGS_BTN_PRIMARY;
    case 'danger': return SETTINGS_BTN_DANGER;
    case 'successSoft': return `${SETTINGS_BTN} !border-success/30 bg-success/10 hover:!bg-success/10 [&_svg]:text-success`;
    case 'upgrade': return SETTINGS_BTN_UPGRADE;
  }
}

/**
 * @catalog Button
 * use: every labeled action. Name it with `action` (save, add, create, done, confirm, apply, next, restore, delete, remove, cancel, back, edit, rename, copy, search, open): that brings the one icon, the label and the look of that action (`ui/actions.ts`), so a Save is the same everywhere. Words that say more ("Add medication") go in `children`; the icon stays. `icon` and `variant` only for an action the map does not have. One size for every button, everywhere; `pro` adds the rocket; `iconEnd` puts the glyph after the label, as Next's arrow, for a button that moves a flow on to its next step (a Done that opens the next step of a wizard). Four app variants (`secondary`, `primary`, `danger`, `upgrade`) share one calm tinted-border grammar; `successSoft` is the green done state of the browser extension's SaveButton (pattern 177).
 * never: a <button> with its own border, fill or padding classes; a Save, Add or Remove without its icon; a second icon for an action the map has; a smaller or larger button.
 */
export function Button({
  action,
  variant,
  icon,
  pro = false,
  iconEnd = false,
  className = '',
  type = 'button',
  children,
  ...rest
}: ComponentProps<'button'> & {
  variant?: Variant;
  /** Shows the Pro rocket after the label (a free account's Pro door). */
  pro?: boolean;
  /** The glyph follows the label, as Next's arrow does: for a button that
   *  moves a flow on to its next step. */
  iconEnd?: boolean;
  children?: ReactNode;
} & (
  /** The action this button does: its icon, label and look come from the map. */
  | { action: ActionName; icon?: never }
  /** A 15px glyph before the label, for an action the map does not have; give it `aria-hidden`. */
  | { action?: never; icon: ReactNode }
)) {
  const { t } = useTranslation('common');
  const spec = action ? ACTIONS[action] : null;
  const look = variant ?? spec?.variant ?? 'secondary';
  const Glyph = spec?.icon;
  const after = action === 'next' || iconEnd;
  return (
    <button type={type} {...rest} className={`${buttonLook(look)}${className ? ` ${className}` : ''}`}>
      {/* Next points the way it goes: its arrow follows the label ("Connect ->"),
          and so does the glyph of any button that moves a flow on (iconEnd). */}
      {!after && (Glyph ? <Glyph aria-hidden="true" className="shrink-0" /> : icon)}
      {children ?? (spec?.label ? t(`actions.${spec.label}`) : null)}
      {after && (Glyph ? <Glyph aria-hidden="true" className="shrink-0" /> : icon)}
      {pro && <IconUpgrade size={12} />}
    </button>
  );
}

/**
 * @catalog IconButton
 * use: a tool on a row or a bar (edit, delete, more, close), where words do not fit. The label is required: it names the button for screen readers and shows as the tooltip; `keys` adds the keyboard shortcut to the tooltip, as the app's toolbar shows it; `active` highlights a toggled-on state and sets `aria-pressed`.
 * never: a primary action (Save, Add, Remove); a <button> with only an icon and no label.
 */
export function IconButton({
  label,
  tone = 'quiet',
  active = false,
  position = 'above',
  keys,
  className = '',
  type = 'button',
  children,
  ...rest
}: ComponentProps<'button'> & {
  label: string;
  /** The shortcut that does the same, shown in the tooltip. */
  keys?: string;
  /** `danger` turns the glyph red on hover (delete). */
  tone?: 'quiet' | 'danger' | 'accent';
  /** Highlighted on-state for a toggle tool on a bar. */
  active?: boolean;
  position?: 'above' | 'below' | 'above-end' | 'below-end' | 'above-start' | 'below-start' | 'start' | 'end';
  children: ReactNode;
}) {
  // One color class only: with two, the stylesheet's order picks the winner,
  // and it picked the muted one over the accent.
  const toneClass = active
    ? 'bg-accent/15 text-accent hover:bg-accent/20'
    : tone === 'danger'
      ? 'text-pn-muted hover:text-danger hover:bg-pn/10'
      : tone === 'accent'
        ? 'text-accent hover:text-accent hover:bg-pn/10'
        : 'text-pn-muted hover:text-pn hover:bg-pn/10';
  return (
    <HoverLabel label={label} position={position} keys={keys}>
      <button
        type={type}
        aria-label={label}
        aria-pressed={rest['aria-pressed'] ?? (active || undefined)}
        {...rest}
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition disabled:opacity-40 ${toneClass}${className ? ` ${className}` : ''}`}
      >
        {children}
      </button>
    </HoverLabel>
  );
}

/**
 * @catalog CloseButton
 * use: the one X that closes a window, a panel, a popover or a sheet, at its top end: the 18px X, the quiet IconButton look, "Close" as its label and tooltip. Modal and Popover draw it themselves; a surface that is not one of them places it.
 * never: an X button of your own (its own size, padding, hover or color); a second close control in the footer.
 */
export function CloseButton({
  onClick,
  onMouseDown,
  disabled,
  label,
  keys,
  className = '',
}: {
  onClick: () => void;
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  label?: string;
  keys?: string;
  className?: string;
}) {
  const { t } = useTranslation('common');
  return (
    <IconButton
      label={label ?? t('actions.close')}
      keys={keys}
      position="below-end"
      onMouseDown={onMouseDown}
      onClick={onClick}
      disabled={disabled}
      className={className}
      data-close-button=""
    >
      <X aria-hidden="true" />
    </IconButton>
  );
}
