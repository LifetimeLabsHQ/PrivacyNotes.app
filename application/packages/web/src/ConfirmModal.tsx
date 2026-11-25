import { useTranslation } from 'react-i18next';
import { useEffect, useRef, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import type { IconProps } from '@phosphor-icons/react';
import { isImeComposing } from './imeComposing';
import { Info, Trash, Warning } from './icons';
import { Modal, ModalFooter } from './ui/Modal';
import { ACTIONS } from './ui/actions';
import { Button } from './ui/Button';
import { DANGER_BTN_SKIN, PRIMARY_BTN_SKIN, SETTINGS_HELP, WARNING_BTN_SKIN } from './settingsUI';
import { Kbd } from './ui/misc';

type ConfirmVariant = 'danger' | 'warning' | 'info';

type Props = {
  title: string;
  /** Body content - string or JSX. */
  children: ReactNode;
  /** Label for the primary action button. */
  confirmLabel: string;
  /** Optional label for the cancel button. Defaults to "Cancel".
   *  Pass null to hide the cancel button entirely (notice-style modals
   *  with a single acknowledge action). */
  cancelLabel?: string | null;
  variant?: ConfirmVariant;
  onConfirm: () => void;
  /** Fires on backdrop click, X button, or Escape - true dismiss. */
  onClose: () => void;
  /** If provided, the cancel *button* calls this instead of onClose.
   *  Useful when the cancel button represents an explicit action
   *  (e.g. "Store as files") that differs from simply dismissing. */
  onCancel?: () => void;
  /**
   * Enter confirms, wherever the focus is, except on the cancel button. For
   * a step that can be undone (Move to trash keeps the items for 30 days),
   * never for a permanent delete. Shift+Enter runs `extra` where there is one. Only a fresh press counts: a held key, or
   * the key that opened the window, does nothing.
   * Spec: docs/internal/specs/keyboard-shortcuts.md (decision D10)
   */
  enterConfirms?: boolean;
  /**
   * Several answers in place of one confirm button, stacked, the first in the
   * variant's fill (the "Change this item?" question of a repeating event).
   * `confirmLabel` and `onConfirm` are then unused.
   */
  choices?: readonly { label: string; onSelect: () => void }[];
  /**
   * The confirm button's glyph, when its action has one of its own (Trash for
   * Move to trash). Without it the variant picks: Trash for danger, a check
   * for the rest. Every button carries an icon (docs/contrib/design/RULES.md, rule 5).
   */
  confirmIcon?: ComponentType<IconProps>;
  /**
   * A second, destructive answer beside Cancel ("Delete forever" in the
   * Delete window, #630). The answers then stack in one column: the
   * confirm, this one, Cancel. Plain Enter never runs it; with enterConfirms, Shift+Enter
   * does, a key that no one presses by habit (owner's request, D10).
   */
  extra?: { label: string; onSelect: () => void };
  /** A help line under the buttons (the Delete window's keys), hidden on a
   *  touch screen like the Enter key cap. */
  footnote?: ReactNode;
  /** The title's glyph, in the variant's color, when the window is about one
   *  action (the trash for the Delete window). Without it the variant picks. */
  titleIcon?: ComponentType<IconProps>;
  /** The stacking layer, as `Modal` takes it: a question that answers an
   *  action in a menu or another window sits above it. */
  layer?: ComponentProps<typeof Modal>['layer'];
};

/* ── Icon per variant ──────────────────────────────────── */

function VariantIcon({ variant, glyph: Glyph }: { variant: ConfirmVariant; glyph?: ComponentType<IconProps> }) {
  if (Glyph) return <Glyph className={variant === 'danger' ? 'text-danger' : variant === 'warning' ? 'text-warning' : ''} />;
  if (variant === 'danger') return <Trash className="text-danger" />;
  if (variant === 'warning') return <Warning className="text-warning" />;
  return <Info />;
}

/* ── Button glyphs, from the one action map ─────────────── */

const confirmGlyph: Record<ConfirmVariant, ComponentType<IconProps>> = {
  danger: ACTIONS.delete.icon,
  warning: ACTIONS.confirm.icon,
  info: ACTIONS.confirm.icon,
};
const CancelGlyph = ACTIONS.cancel.icon;
const BTN_ROW = 'inline-flex items-center justify-center gap-2 min-w-0';

/* ── Confirm button class per variant ──────────────────── */

// Danger, warning, and info share the same calm tinted-border grammar as
// PRIMARY_BTN_SKIN, so destructive and cautionary confirms match the rest of
// the app without shouting as solid color bricks.
const confirmBtnClass: Record<ConfirmVariant, string> = {
  danger: DANGER_BTN_SKIN,
  warning: WARNING_BTN_SKIN,
  info: PRIMARY_BTN_SKIN,
};

/* ── Component ─────────────────────────────────────────── */

export function ConfirmModal({
  title,
  children,
  confirmLabel,
  cancelLabel,
  variant = 'danger',
  onConfirm,
  onClose,
  onCancel,
  enterConfirms = false,
  extra,
  footnote,
  titleIcon,
  choices,
  confirmIcon,
  layer,
}: Props) {
  const ConfirmGlyph = confirmIcon ?? confirmGlyph[variant];
  const { t } = useTranslation('common');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirm = useRef(() => {});
  confirm.current = () => { onConfirm(); onClose(); };
  const runExtra = useRef<(() => void) | null>(null);
  runExtra.current = extra ? () => { extra.onSelect(); onClose(); } : null;
  useEffect(() => {
    if (!enterConfirms) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' || e.defaultPrevented || isImeComposing(e)) return;
      if (document.activeElement === cancelRef.current) return;
      // Captured, so the Enter never reaches the editor behind the window.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.shiftKey && runExtra.current) runExtra.current();
      else confirm.current();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enterConfirms]);
  // undefined -> default "Cancel" label; null -> hide the cancel button.
  const resolvedCancelLabel =
    cancelLabel === null ? null : cancelLabel ?? t('actions.cancel');
  // Drawn once, placed by the layout below: a row, or one column with `extra`.
  const cancelButton = (
    <Button
      ref={cancelRef}
      icon={<CancelGlyph aria-hidden="true" className="shrink-0" />}
      onClick={onCancel ?? onClose}
      className={`${extra ? 'whitespace-nowrap' : ''} !px-4 !py-2 !text-body`}
    >
      {resolvedCancelLabel}
    </Button>
  );
  const confirmButton = (
    <button
      onClick={() => { onConfirm(); onClose(); }}
      className={`${BTN_ROW} ${extra ? 'whitespace-nowrap' : ''} rounded-md px-4 py-2 text-body font-medium transition ${confirmBtnClass[variant]}`}
    >
      <ConfirmGlyph aria-hidden="true" className="shrink-0" />
      {confirmLabel}
      {/* Enter confirms: the button names its key, where there is a keyboard. */}
      {enterConfirms && (
        <span aria-hidden="true" className="[@media(hover:none)]:hidden">
          <Kbd>↵</Kbd>
        </span>
      )}
    </button>
  );
  return (
    <Modal onClose={onClose} layer={layer} title={title} icon={<VariantIcon variant={variant} glyph={titleIcon} />} className="max-w-sm p-6 space-y-4">
        {/* Body */}
        <div className="text-body text-pn-muted leading-relaxed">
          {children}
        </div>

        {/* Actions */}
        {choices ? (
          <div className="flex flex-col gap-2 pt-2">
            {choices.map((c, i) => (
              <button
                key={c.label}
                onClick={() => { c.onSelect(); onClose(); }}
                className={`${BTN_ROW} whitespace-nowrap rounded-md px-4 py-2 text-body font-medium transition ${i === 0 ? confirmBtnClass[variant] : 'border border-divider hover:bg-pn/5'}`}
              >
                <ConfirmGlyph aria-hidden="true" className="shrink-0" />
                {c.label}
              </button>
            ))}
            {resolvedCancelLabel !== null && (
              <button ref={cancelRef} onClick={onCancel ?? onClose} className={`${BTN_ROW} whitespace-nowrap rounded-md px-4 py-2 text-body text-pn-muted hover:bg-pn/5 transition`}>
                <CancelGlyph aria-hidden="true" className="shrink-0" />
                {resolvedCancelLabel}
              </button>
            )}
          </div>
        ) : extra ? (
        // A second answer stacks the three in one column, the safest first,
        // so no label shares a row and none wraps (#630). Cancel sits between
        // the two, so a hurried click under the first never lands on the
        // permanent one (#826).
        <div className="flex flex-col gap-2 pt-2">
          {confirmButton}
          {resolvedCancelLabel !== null && cancelButton}
          <Button action="delete" variant="danger" className="w-full justify-center" onClick={() => { extra.onSelect(); onClose(); }}>
            {extra.label}
            {enterConfirms && (
              <span aria-hidden="true" className="[@media(hover:none)]:hidden">
                <Kbd>⇧↵</Kbd>
              </span>
            )}
          </Button>
        </div>
        ) : (
        <ModalFooter>
          {resolvedCancelLabel !== null && cancelButton}
          {confirmButton}
        </ModalFooter>
        )}
        {footnote && <p className={`${SETTINGS_HELP} [@media(hover:none)]:hidden`}>{footnote}</p>}
    </Modal>
  );
}
