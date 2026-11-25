import { useId, useState, type ReactNode } from 'react';
import { CaretRight } from '../icons';

/**
 * @catalog Disclosure
 * use: an accessible collapsible disclosure with a rotating caret, optional `meta` count or summary, and controlled (`open`) or uncontrolled (`defaultOpen`) state.
 * never: a hand-rolled accordion button missing `aria-expanded` or `aria-controls`; a disclosure with its own caret rotation classes.
 */
export function Disclosure({
  label,
  meta,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  panelClassName,
  children,
}: {
  label: ReactNode;
  meta?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open !== undefined ? open : uncontrolledOpen;
  const panelId = useId();

  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
        className="inline-flex items-center gap-1.5 text-body text-pn-soft hover:text-pn transition"
      >
        <CaretRight
          aria-hidden="true"
          className={`shrink-0 transition-transform ${isOpen ? 'rotate-90 rtl:-rotate-90' : ''}`}
        />
        <span>{label}</span>
        {meta && <span className="text-small text-pn-muted">{meta}</span>}
      </button>
      {isOpen && (
        <div id={panelId} className={panelClassName ?? 'mt-2'}>
          {children}
        </div>
      )}
    </div>
  );
}
