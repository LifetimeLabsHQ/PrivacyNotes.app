import { forwardRef, type ReactNode } from 'react';

const BASE = 'shrink-0 inline-flex items-center gap-1 text-small font-medium px-2 py-0.5 rounded-md border text-accent-strong';

/**
 * @catalog RowChip
 * use: the one-per-note chip in the editor's tag row: the folder the note lives in, the place set on it. Square corners and a border, against the round pills of the tags, because the note has one of each. `empty` is the dashed "nothing here yet". Without `onClick` it is the read-only text a locked note shows. `icon` before the text, `trailing` after it (a caret, the Pro mark).
 * never: a <button> or <span> in the tag row with its own accent border, rounded-md and padding.
 * Spec: docs/internal/design/ui-patterns.md (editor tag row)
 */
export const RowChip = forwardRef<HTMLButtonElement, {
  icon: ReactNode;
  children: ReactNode;
  empty?: boolean;
  onClick?: () => void;
  /** The accessible name when the text alone does not say what the chip does. */
  label?: string;
  expanded?: boolean;
  trailing?: ReactNode;
}>(function RowChip({ icon, children, empty = false, onClick, label, expanded, trailing }, ref) {
  const body = (
    <>
      {icon}
      <span className="truncate max-w-[120px]">{children}</span>
      {trailing}
    </>
  );
  if (!onClick) {
    return (
      <span className={`${BASE} ${empty ? 'border-dashed border-accent/40 bg-accent/8' : 'border-accent/40 bg-accent/15'}`}>
        {body}
      </span>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      className={`${BASE} transition ${
        empty
          ? 'border-dashed border-accent/40 bg-accent/8 hover:bg-accent/15 hover:border-accent/60'
          : 'border-accent/40 bg-accent/15 hover:bg-accent/25'
      }`}
    >
      {body}
    </button>
  );
});
