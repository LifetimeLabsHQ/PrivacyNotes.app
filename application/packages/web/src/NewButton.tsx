import { createContext, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref, type TouchEvent as ReactTouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { isTouchContextMenu } from './ContextMenu';
import { HoverLabel } from './HoverLabel';
import { keyText } from './shortcutMatch';
import { useEscapeToClose } from './useEscapeToClose';
import { Kbd } from './ui/misc';
import { CaretDown, PlusCircle } from './icons';

/** Delay before a touch hold on the docked phone-bar "+" opens the All menu (matches useLongPressContextMenu). */
const LONG_PRESS_MS = 500;
/** Finger travel that cancels the touch hold so drags never fire the menu. */
const LONG_PRESS_MOVE_PX = 10;
/** Window after touchend in which a synthetic click from the long press is dropped. */
const LONG_PRESS_CLICK_GUARD_MS = 500;

/** One entry in a "New" dropdown menu. */
export type NewMenuOption = {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  /** The key that runs it, drawn at the row's end. */
  keys?: string;
};

/**
 * Where a list's New button lives. On a phone it leaves the list header for
 * the end of the bottom bar, where a thumb reaches it; `slot` is the bar's
 * empty box for it, and null while the bar holds no New (an item is open, the
 * keyboard is up). Wider screens keep the button in the header.
 *
 * `allOptions` is the full type picker (same array the All view uses). While
 * `docked`, a touch long-press on ANY list's bottom "+" button opens it so a
 * person can add another type without switching pillars first (GitHub #956).
 * Spec: docs/internal/design/ui-patterns.md section 137
 */
export const NewButtonDock = createContext<{
  docked: boolean;
  slot: HTMLElement | null;
  allOptions?: NewMenuOption[];
}>({ docked: false, slot: null });

// No word in either home, so no locale has to squeeze its "New" into the
// header. In the header a filled square, 36px like the view picker and the
// quick switcher beside it. In the bar a solid plus with no box, so it sits
// among the bar's plain icons with a little more weight than they have; its
// 44px box is the smallest touch target either phone platform recommends.
// The two never show at once.
const HEADER_LOOK = 'inline-flex h-9 items-center justify-center rounded-lg bg-accent-fill hover:bg-accent-fill-hover active:scale-95 text-white transition cursor-pointer';
const DOCKED_LOOK = 'inline-flex h-11 w-11 items-center justify-center rounded-lg text-accent hover:bg-pn/5 active:bg-pn/10 transition cursor-pointer select-none';

/** Shared menu list drawn by NewDropdown and by NewButton's docked touch long-press. */
function NewMenuList({
  options,
  docked,
  onClose,
}: {
  options: NewMenuOption[];
  docked: boolean;
  onClose: () => void;
}) {
  return (
    /*
      `w-max` on the menu below is load-bearing, not decoration. The menu is
      absolutely positioned inside a `relative` wrapper that is only as wide as
      the "New" button, and an auto-width absolute box with `end-0` and no
      `start` shrink-to-fits against its CONTAINING BLOCK, not the viewport. So
      the menu was capped at the button's ~110px and every label longer than
      that wrapped onto two lines. English never showed it ("Credit Card", 11
      chars, fits); es "Tarjeta de credito" (18), pt "Cartao de Credito" (17),
      ca (17), it (16), pl (15), fr (14) and cs (18) all wrapped, and had done
      since each locale shipped. `w-max` opts out of the containing-block cap;
      `max-w` keeps a pathological string from running off a narrow viewport;
      `whitespace-nowrap` on the rows stops a two-word label breaking anyway.
      Spec: docs/internal/design/ui-patterns.md section 45.
    */
    <div
      role="menu"
      className={`absolute end-0 ${docked ? 'bottom-full mb-2 max-h-[calc(100dvh-5rem)] overflow-y-auto' : 'top-full mt-1'} z-50 w-max max-w-[calc(100vw-1.5rem)] bg-surface-2 border border-divider rounded-lg shadow-lg py-1`}
    >
      {options.map(({ key, label, icon, onSelect, keys }) => (
        <button
          key={key}
          type="button"
          role="menuitem"
          onClick={() => { onSelect(); onClose(); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-body text-start whitespace-nowrap text-pn-soft hover:bg-pn/5 transition cursor-pointer"
        >
          {/* Accent, like every other menu that lists things to go to or
              make: the rail rows, the sidebar option menus and the view
              picker. Grey here made this the one menu whose glyphs read as
              decoration. The colour lives on the row rather than in
              NEW_GLYPHS, because the same glyphs are also drawn inside the
              New button itself, where they sit on an accent-tinted pill. */}
          <span className="text-accent">{icon}</span>
          {label}
          {keys && <span className="ms-auto ps-4"><Kbd>{keys}</Kbd></span>}
        </button>
      ))}
    </div>
  );
}

/** The New button of every list pane. `label` names it for screen readers and the tip. */
export function NewButton({
  label,
  keys,
  onClick,
  onLongPress,
  onLongPressOpen,
  buttonRef,
  wrapRef,
  popup,
  expanded,
  tabIndex,
  children,
}: {
  label: string;
  /** The shortcut that does the same, for the tip. */
  keys?: string;
  onClick: () => void;
  /** Replaces the default docked long-press menu (used when this button's own dropdown IS allOptions). */
  onLongPress?: () => void;
  /** Called right before the docked long-press menu opens so a sibling popup (Vault, Tasks, Journal) closes. */
  onLongPressOpen?: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  /** The box that holds the button and its menu, for an outside-click test. */
  wrapRef?: Ref<HTMLDivElement>;
  popup?: 'menu' | 'dialog';
  expanded?: boolean;
  tabIndex?: number;
  /** A menu or popover hung off the button. */
  children?: ReactNode;
}) {
  const { docked, slot, allOptions } = useContext(NewButtonDock);
  const [longPressOpen, setLongPressOpen] = useState(false);
  const internalWrapRef = useRef<HTMLDivElement | null>(null);
  const pressRef = useRef<{
    timer: number | null;
    touchId: number | null;
    startX: number;
    startY: number;
    fired: boolean;
    suppressClickUntil: number;
  }>({
    timer: null,
    touchId: null,
    startX: 0,
    startY: 0,
    fired: false,
    suppressClickUntil: 0,
  });

  const canLongPress = docked && (!!onLongPress || !!allOptions?.length);

  const cancelLongPressTimer = () => {
    const s = pressRef.current;
    if (s.timer !== null) {
      window.clearTimeout(s.timer);
      s.timer = null;
    }
    s.touchId = null;
  };

  useEffect(() => cancelLongPressTimer, []);
  useEffect(() => setLongPressOpen(false), [slot, docked, label, onLongPress]);
  useEscapeToClose(() => setLongPressOpen(false), !onLongPress && longPressOpen);

  useEffect(() => {
    if (!longPressOpen) return;
    const handler = (e: PointerEvent | MouseEvent) => {
      if (internalWrapRef.current && !internalWrapRef.current.contains(e.target as Node)) {
        setLongPressOpen(false);
      }
    };
    const evt = typeof PointerEvent !== 'undefined' ? 'pointerdown' : 'mousedown';
    document.addEventListener(evt, handler as EventListener);
    return () => document.removeEventListener(evt, handler as EventListener);
  }, [longPressOpen]);

  const setWrapEl = (node: HTMLDivElement | null) => {
    internalWrapRef.current = node;
    if (typeof wrapRef === 'function') wrapRef(node);
    else if (wrapRef && 'current' in wrapRef) (wrapRef as { current: HTMLDivElement | null }).current = node;
  };

  const triggerLongPress = () => {
    if (onLongPress) {
      onLongPress();
      return;
    }
    onLongPressOpen?.();
    setLongPressOpen(true);
  };

  const longPressHandlers = canLongPress
    ? {
        onContextMenu: (e: ReactMouseEvent<HTMLButtonElement>) => {
          const s = pressRef.current;
          if (s.fired || performance.now() < s.suppressClickUntil) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (!isTouchContextMenu(e)) return;
          const activeTouch = s.touchId !== null;
          cancelLongPressTimer();
          e.preventDefault();
          e.stopPropagation();
          s.fired = activeTouch;
          s.suppressClickUntil = activeTouch ? Infinity : performance.now() + LONG_PRESS_CLICK_GUARD_MS;
          triggerLongPress();
        },
        onTouchStart: (e: ReactTouchEvent<HTMLButtonElement>) => {
          cancelLongPressTimer();
          const s = pressRef.current;
          s.fired = false;
          s.suppressClickUntil = 0;
          if (e.touches.length !== 1) return;
          const touch = e.touches[0];
          if (!touch) return;
          s.touchId = touch.identifier;
          s.startX = touch.clientX;
          s.startY = touch.clientY;
          s.timer = window.setTimeout(() => {
            s.timer = null;
            s.fired = true;
            s.suppressClickUntil = Infinity;
            triggerLongPress();
          }, LONG_PRESS_MS);
        },
        onTouchMove: (e: ReactTouchEvent<HTMLButtonElement>) => {
          const s = pressRef.current;
          if (s.timer === null || s.touchId === null) return;
          if (e.touches.length > 1) {
            cancelLongPressTimer();
            return;
          }
          let touch: React.Touch | undefined;
          for (let i = 0; i < e.touches.length; i++) {
            if (e.touches[i]?.identifier === s.touchId) {
              touch = e.touches[i];
              break;
            }
          }
          if (!touch) {
            cancelLongPressTimer();
            return;
          }
          const dx = touch.clientX - s.startX;
          const dy = touch.clientY - s.startY;
          if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) {
            cancelLongPressTimer();
          }
        },
        onTouchEnd: (e: ReactTouchEvent<HTMLButtonElement>) => {
          cancelLongPressTimer();
          const s = pressRef.current;
          if (s.fired) {
            s.fired = false;
            s.suppressClickUntil = performance.now() + LONG_PRESS_CLICK_GUARD_MS;
            if (e.cancelable) e.preventDefault();
          }
        },
        onTouchCancel: () => {
          cancelLongPressTimer();
          const s = pressRef.current;
          if (s.fired) {
            s.fired = false;
            s.suppressClickUntil = performance.now() + LONG_PRESS_CLICK_GUARD_MS;
          }
        },
        onClickCapture: (e: ReactMouseEvent<HTMLButtonElement>) => {
          const s = pressRef.current;
          if (performance.now() < s.suppressClickUntil) {
            s.suppressClickUntil = 0;
            e.preventDefault();
            e.stopPropagation();
          }
        },
      }
    : undefined;

  if (docked && !slot) return null;
  const body = (
    <div ref={setWrapEl} className="relative shrink-0">
      <HoverLabel label={label} keys={keys} position={docked ? 'above-end' : 'below-end'}>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => {
            if (longPressOpen) {
              setLongPressOpen(false);
              return;
            }
            onClick();
          }}
          {...longPressHandlers}
          data-pn-no-touch-tip={canLongPress ? '' : undefined}
          style={canLongPress ? { WebkitTouchCallout: 'none' } : undefined}
          aria-label={label}
          aria-haspopup={popup ?? (longPressOpen ? 'menu' : undefined)}
          aria-expanded={longPressOpen ? true : popup ? expanded : undefined}
          tabIndex={tabIndex}
          className={docked ? DOCKED_LOOK : `${HEADER_LOOK} ${popup ? 'gap-1 px-2' : 'w-9'}`}
        >
          {docked ? <PlusCircle size={32} weight="fill" /> : <PlusCircle size={22} weight="bold" />}
          {/* In the header a caret marks the buttons that open a menu or a
              calendar. The bar's button stays a plain square: it is the one
              action at the end of the bar, and its menu opens on the tap. */}
          {popup && !docked && <CaretDown weight="bold" />}
        </button>
      </HoverLabel>
      {children}
      {!onLongPress && longPressOpen && allOptions && allOptions.length > 0 && (
        <NewMenuList options={allOptions} docked={docked} onClose={() => setLongPressOpen(false)} />
      )}
    </div>
  );
  return docked && slot ? createPortal(body, slot) : body;
}

/* ── Shared "New" dropdown ──────────────────────────────────────────
 * One menu, reused by the Vault view (login / card / ssh-key), the All
 * view (every type) and the Tasks view (task list / Kanban board) so they can't drift in
 * style or behaviour. Callers pass fully-built, already-translated options;
 * the button label ("New") is the only string this component owns. */
export function NewDropdown({ options, label }: { options: NewMenuOption[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { docked, slot, allOptions } = useContext(NewButtonDock);
  const isAllMenu = !!allOptions && options === allOptions;
  useEscapeToClose(() => setOpen(false), open);
  // The bar's slot comes and goes with an open item; a menu left open would
  // greet the person on the way back.
  useEffect(() => setOpen(false), [slot]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent | MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Use pointerdown for reliable mobile touch support; fall back to
    // mousedown for environments where PointerEvent isn't available.
    const evt = typeof PointerEvent !== 'undefined' ? 'pointerdown' : 'mousedown';
    document.addEventListener(evt, handler as EventListener);
    return () => document.removeEventListener(evt, handler as EventListener);
  }, [open]);

  return (
    // Spec: docs/internal/design/ui-patterns.md section 45 (z-index tier system - the
    // NewButton wrapper must not create a z-20 stacking context, or it traps the
    // MobileHeader's z-50 pillar dropdown beneath it in the Vault view).
    <NewButton
      wrapRef={ref}
      onClick={() => setOpen(!open)}
      onLongPress={isAllMenu ? () => setOpen(true) : undefined}
      onLongPressOpen={isAllMenu ? undefined : () => setOpen(false)}
      label={label}
      keys={keyText('newMenu')}
      popup="menu"
      expanded={open}
    >
      {open && <NewMenuList options={options} docked={docked} onClose={() => setOpen(false)} />}
    </NewButton>
  );
}
