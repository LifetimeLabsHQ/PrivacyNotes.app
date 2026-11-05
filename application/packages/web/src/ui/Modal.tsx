import { useEffect, useId, useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useEscapeToClose } from '../useEscapeToClose';
import { CloseButton } from './Button';

/**
 * @catalog Modal
 * use: every window over the app: the dark overlay, the panel, `role="dialog"` with `aria-modal`, Escape and a click outside, and the keyboard focus: in on open, Tab kept inside, back to the opener on close. `title` is required (with optional `icon` and `subtitle`): the part draws the header, an 18px semibold title with the close X at the end, inside the panel (`header="inline"`, a short window) or as a bar over a scrolling body (`header="bar"`). The X shows while `onClose` is set and `escape` is true. End the window with `ModalFooter`. Omit `onClose` for a window that must be answered (a device limit, an expired session). `embedded` draws the body alone inside Settings, which is the dialog there.
 * never: a `fixed inset-0 bg-black/50` overlay of your own; a hand-drawn window title or close X; a window without a close X that can be closed.
 */
export function Modal({
  onClose,
  title,
  icon,
  subtitle,
  header = 'inline',
  className = '',
  layer = 'z-50',
  escape = true,
  closeOnBackdrop = true,
  embedded = false,
  embeddedClassName = '',
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'onClick' | 'children'> & {
  /** Escape and a click outside the panel call it. */
  onClose?: () => void;
  /** The window's title: the part draws the header and the close X, so no window draws its own. */
  title: ReactNode;
  /** A 16px glyph before the title, in the accent. */
  icon?: ReactNode;
  /** One line under the title. */
  subtitle?: ReactNode;
  /** `inline`: the title inside the padded panel. `bar`: a title bar with a rule under it, over a body that scrolls. */
  header?: 'inline' | 'bar';
  /** The panel's own size, padding and layout (`max-w-md p-6 space-y-4`). */
  className?: string;
  /** The stacking layer: a window over another window takes a higher one. */
  layer?: 'z-50' | 'z-[60]' | 'z-[70]';
  /** False while Escape must not close it (a step is busy). */
  escape?: boolean;
  /** False while a click outside must not close it. */
  closeOnBackdrop?: boolean;
  embedded?: boolean;
  /** The body's classes inside Settings. */
  embeddedClassName?: string;
  children: ReactNode;
}) {
  const autoId = useId();
  const titleId = autoId;
  const panelRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(onClose ?? noop, Boolean(onClose) && escape && !embedded);
  useWindowFocus(panelRef, !embedded);
  if (embedded) return <div {...rest} className={embeddedClassName}>{children}</div>;
  const head = (
    <div className={`flex items-start justify-between gap-3${header === 'bar' ? ' shrink-0 border-b border-divider px-6 py-4' : ''}`}>
      <div className="min-w-0">
        <h2 id={titleId} className="flex items-center gap-2 text-heading font-semibold text-pn">
          {icon && <span className="shrink-0 text-accent" aria-hidden="true">{icon}</span>}
          <span className="min-w-0">{title}</span>
        </h2>
        {subtitle && <p className="mt-0.5 text-body text-pn-muted">{subtitle}</p>}
      </div>
      {onClose && escape && <CloseButton onClick={onClose} className="-me-2 -mt-1" />}
    </div>
  );
  return (
    <div
      {...rest}
      className={`fixed inset-0 bg-black/50 dark:bg-black/70 flex items-center justify-center p-4 sm:p-6 ${layer}`}
      onClick={onClose && closeOnBackdrop ? (e) => { if (e.target === e.currentTarget) onClose(); } : undefined}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => keepTabInside(e, panelRef.current)}
        // A wide window (max-w-lg and up) ends its footer at the end; a narrow one splits it in halves.
        data-wide={/\bmax-w-(lg|[2-7]?xl)\b/.test(className) || undefined}
        className={`group/window bg-surface-2 border border-divider text-pn rounded-lg w-full outline-none${className ? ` ${className}` : ''}`}
      >
        {head}
        {children}
      </div>
    </div>
  );
}

/**
 * @catalog ModalFooter
 * use: the last row of every window: `<Button action="cancel" />` then the primary action, each from the action map. In a narrow window (narrower than max-w-lg) and on a phone the buttons split the row in equal halves, a single one spans it; in a wide window they sit at the end, as wide as their words. `bar` puts a rule over it, for a window with a title bar. Cancel is the only secondary a footer has: Close is the X at the top, and an information window has no footer.
 * never: a footer "Close" (the X closes); actions at the start; a footer row of your own.
 */
export function ModalFooter({ bar = false, children }: { bar?: boolean; children: ReactNode }) {
  return (
    <div
      className={`grid grid-cols-2 gap-2 [&>:only-child]:col-span-2 sm:group-data-[wide=true]/window:flex sm:group-data-[wide=true]/window:justify-end${bar ? ' shrink-0 border-t border-divider px-6 py-4' : ' pt-2'}`}
    >
      {children}
    </div>
  );
}

function noop() {}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * The keyboard belongs to the open window (WAI-ARIA dialog pattern). On open
 * the focus moves into the panel, unless a field in it already took it
 * (`autoFocus`); on close it goes back to what had it before, the row a
 * shortcut acted on, so the arrow keys carry on from there.
 */
function useWindowFocus(panel: RefObject<HTMLDivElement | null>, on: boolean) {
  useEffect(() => {
    const el = panel.current;
    if (!on || !el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      // Only when the focus went down with the window: a window that hands
      // the keyboard on (opens a note, a second window) keeps that choice.
      const now = document.activeElement;
      if (now && now !== document.body && !el.contains(now)) return;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [panel, on]);
}

/** Tab and Shift+Tab go round the controls of the panel, never to the page under it. */
function keepTabInside(e: KeyboardEvent<HTMLDivElement>, panel: HTMLDivElement | null) {
  if (e.key !== 'Tab' || !panel) return;
  // A window opened from inside this one handles its own Tab.
  if ((e.target as HTMLElement).closest('[role="dialog"]') !== panel) return;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.getClientRects().length > 0);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
