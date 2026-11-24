import {
  createContext,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { LocalNote } from './db';

/** Width of each action button revealed behind a swiped list row. */
export const SWIPE_ACTION_WIDTH_PX = 72;
/** Horizontal travel required before claiming a touch over scroll/tap. */
const SWIPE_LOCK_PX = 10;
/** Flick velocity (px/ms) that snaps the tray open or closed even short of the midpoint. */
const FLICK_VELOCITY = 0.35;

export interface SwipeRowAction {
  key: string;
  /** Accessible name (aria-label). */
  label: string;
  /** Short visible label under the icon; omit for icon-only (e.g. More "..."). */
  shortLabel?: string;
  icon: ReactNode;
  tone: 'neutral' | 'accent' | 'danger';
  onTrigger: (buttonEl: HTMLElement) => void;
}

/**
 * Context providing per-note swipe-left actions for list rows on touch devices.
 * Null outside a swipeable list (e.g. Home dashboard widgets, desktop).
 */
export const SwipeRowActionsContext = createContext<((note: LocalNote) => SwipeRowAction[]) | null>(null);

// ── Single-open-row store (zero parent re-renders) ──────────────────────────

let openRowId: string | null = null;
const listeners = new Set<() => void>();
let globalListenersAttached = false;

function notify(): void {
  for (const cb of listeners) cb();
}

function onGlobalPointerDown(e: Event): void {
  if (!openRowId) return;
  const target = e.target instanceof Element ? e.target : null;
  const host = target?.closest<HTMLElement>('[data-swipe-row]');
  if (host?.dataset.swipeRow === openRowId) return;
  closeOpenSwipeRow();
}

function onGlobalScroll(e: Event): void {
  if (!openRowId) return;
  // Ignore scroll events inside a menu or popover opened from the row's More button.
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest('[role="menu"]')) return;
  closeOpenSwipeRow();
}

function syncGlobalListeners(): void {
  if (typeof window === 'undefined') return;
  if (openRowId && !globalListenersAttached) {
    globalListenersAttached = true;
    window.addEventListener('touchstart', onGlobalPointerDown, { capture: true, passive: true });
    window.addEventListener('pointerdown', onGlobalPointerDown, { capture: true, passive: true });
    window.addEventListener('scroll', onGlobalScroll, { capture: true, passive: true });
  } else if (!openRowId && globalListenersAttached) {
    globalListenersAttached = false;
    window.removeEventListener('touchstart', onGlobalPointerDown, true);
    window.removeEventListener('pointerdown', onGlobalPointerDown, true);
    window.removeEventListener('scroll', onGlobalScroll, true);
  }
}

export function setOpenSwipeRow(id: string | null): void {
  if (openRowId === id) return;
  openRowId = id;
  syncGlobalListeners();
  notify();
}

export function closeOpenSwipeRow(): void {
  setOpenSwipeRow(null);
}

export function hasOpenSwipeRow(): boolean {
  return openRowId !== null;
}

function useSwipeRowOpen(id: string | undefined): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    () => !!id && openRowId === id,
    () => false,
  );
}

/**
 * Decide whether a released swipe snaps open or closed.
 * `velocityPxPerMs` is positive in the reveal direction, negative toward closed.
 */
export function resolveSwipeRelease(
  offset: number,
  trayWidth: number,
  velocityPxPerMs: number,
  wasOpen: boolean,
): boolean {
  if (trayWidth <= 0) return false;
  if (velocityPxPerMs > FLICK_VELOCITY && offset > 24) return true;
  if (velocityPxPerMs < -FLICK_VELOCITY) return false;
  return wasOpen ? offset > trayWidth * 0.7 : offset >= trayWidth * 0.35;
}

const TONE_CLASS: Record<SwipeRowAction['tone'], string> = {
  neutral: 'bg-surface-2 text-pn border-s border-divider active:bg-pn/10',
  accent: 'bg-accent/12 text-accent-strong border-s border-divider active:bg-accent/20',
  danger: 'bg-danger/12 text-danger border-s border-divider active:bg-danger/20',
};

interface TouchTrack {
  id: number;
  startX: number;
  startY: number;
  startOffset: number;
  lastX: number;
  lastTime: number;
  velocity: number;
  offset: number;
  locked: null | 'h' | 'v';
  dir: -1 | 1;
}

export interface SwipeRowProps {
  id: string;
  actions: SwipeRowAction[];
  /** Outer `<li>` attributes (data-item-id, data-color, ref, drag, etc.). */
  outerProps: Record<string, unknown>;
  /** Extra classes on the outer `<li>` owned by listItem.tsx (e.g. lazy-paint hook). */
  outerClassName?: string;
  /** Classes for the sliding foreground (padding, state tint, cursor). */
  foregroundClassName: string;
  /** Optional inline background style (e.g. tinted note row) kept opaque while sliding. */
  foregroundStyle?: CSSProperties;
  /** Underlying row click and touch handlers. */
  onRowClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onRowTouchStart?: (e: React.TouchEvent<HTMLElement>) => void;
  onRowTouchMove?: (e: React.TouchEvent<HTMLElement>) => void;
  onRowTouchEnd?: (e: React.TouchEvent<HTMLElement>) => void;
  onRowTouchCancel?: (e: React.TouchEvent<HTMLElement>) => void;
  children: ReactNode;
}

/**
 * Touch swipe-left action container for list rows.
 * - Swiping left on a closed row reveals the trailing action tray (in RTL, swiping right reveals end-0).
 * - Swiping right on a closed row yields immediately so the sidebar drawer swipe still works.
 * - Swiping right on an open row closes it (and `hasOpenSwipeRow()` keeps the drawer closed).
 * - At rest, the tray stays unmounted so closed rows carry zero extra DOM.
 */
export function SwipeRow({
  id,
  actions,
  outerProps,
  outerClassName = '',
  foregroundClassName,
  foregroundStyle,
  onRowClick,
  onRowTouchStart,
  onRowTouchMove,
  onRowTouchEnd,
  onRowTouchCancel,
  children,
}: SwipeRowProps) {
  const isOpen = useSwipeRowOpen(id);
  const [drag, setDrag] = useState<{ active: boolean; offset: number }>({ active: false, offset: 0 });
  const trackRef = useRef<TouchTrack | null>(null);
  const suppressClickUntilRef = useRef(0);

  const trayWidth = actions.length * SWIPE_ACTION_WIDTH_PX;
  const activeOffset = drag.active ? drag.offset : isOpen ? trayWidth : 0;
  const revealed = drag.active || isOpen;
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const dir: -1 | 1 = rtl ? 1 : -1;

  function onTouchStart(e: React.TouchEvent<HTMLElement>) {
    if (e.touches.length !== 1) {
      trackRef.current = null;
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    if (hasOpenSwipeRow() && !isOpen) {
      closeOpenSwipeRow();
    }
    const startOffset = isOpen ? trayWidth : 0;
    trackRef.current = {
      id: t.identifier,
      startX: t.clientX,
      startY: t.clientY,
      startOffset,
      lastX: t.clientX,
      lastTime: performance.now(),
      velocity: 0,
      offset: startOffset,
      locked: null,
      dir,
    };
    if (!isOpen) onRowTouchStart?.(e);
  }

  function onTouchMove(e: React.TouchEvent<HTMLElement>) {
    const tr = trackRef.current;
    if (!tr) {
      onRowTouchMove?.(e);
      return;
    }
    let t: React.Touch | undefined;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const c = e.changedTouches[i];
      if (c && c.identifier === tr.id) { t = c; break; }
    }
    if (!t) return;

    const dx = t.clientX - tr.startX;
    const dy = t.clientY - tr.startY;

    if (tr.locked === null) {
      if (Math.abs(dx) < SWIPE_LOCK_PX && Math.abs(dy) < SWIPE_LOCK_PX) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        tr.locked = 'v';
        onRowTouchMove?.(e);
        return;
      }
      const towardReveal = dx * tr.dir;
      if (!isOpen && towardReveal <= 0) {
        // Rightward swipe on a closed row belongs to the mobile drawer.
        tr.locked = 'v';
        onRowTouchMove?.(e);
        return;
      }
      tr.locked = 'h';
      onRowTouchCancel?.(e);
    }

    if (tr.locked !== 'h') return;

    const now = performance.now();
    const dt = now - tr.lastTime;
    if (dt > 0) {
      tr.velocity = ((t.clientX - tr.lastX) * tr.dir) / dt;
      tr.lastX = t.clientX;
      tr.lastTime = now;
    }

    const raw = tr.startOffset + dx * tr.dir;
    const offset = raw <= 0
      ? 0
      : raw > trayWidth
        ? trayWidth + Math.round((raw - trayWidth) * 0.25)
        : Math.round(raw);
    tr.offset = offset;
    setDrag({ active: true, offset });
  }

  function finishTouch(e: React.TouchEvent<HTMLElement>, cancelled: boolean) {
    const tr = trackRef.current;
    trackRef.current = null;
    if (tr?.locked === 'h') {
      suppressClickUntilRef.current = performance.now() + 350;
      const shouldOpen = !cancelled && resolveSwipeRelease(tr.offset, trayWidth, tr.velocity, isOpen);
      setOpenSwipeRow(shouldOpen ? id : null);
      setDrag({ active: false, offset: 0 });
      return;
    }
    if (cancelled) onRowTouchCancel?.(e);
    else onRowTouchEnd?.(e);
  }

  function onClick(e: React.MouseEvent<HTMLElement>) {
    if (performance.now() < suppressClickUntilRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (isOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeOpenSwipeRow();
      return;
    }
    onRowClick?.(e);
  }

  return (
    <li
      {...outerProps}
      data-swipe-row={id}
      data-swipe-open={isOpen ? '' : undefined}
      className={`${outerClassName ? `${outerClassName} ` : ''}pn-swipe-row relative overflow-hidden border-b border-divider/50 [@media(hover:none)]:select-none`}
    >
      {revealed && (
        <div
          data-swipe-tray=""
          className="absolute inset-y-0 end-0 flex items-stretch"
          style={{ width: trayWidth }}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              aria-label={action.label}
              onClick={(e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                closeOpenSwipeRow();
                action.onTrigger(btn);
              }}
              className={`flex w-[72px] shrink-0 flex-col items-center justify-center gap-1 text-meta font-medium leading-tight select-none transition-opacity ${TONE_CLASS[action.tone]}`}
            >
              <span aria-hidden="true" className="text-body inline-flex items-center justify-center">
                {action.icon}
              </span>
              {action.shortLabel && (
                <span className="max-w-[64px] truncate text-center">{action.shortLabel}</span>
              )}
            </button>
          ))}
        </div>
      )}
      <div
        data-swipe-foreground=""
        onClick={onClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={(e) => finishTouch(e, false)}
        onTouchCancel={(e) => finishTouch(e, true)}
        style={{
          ...(revealed ? foregroundStyle : undefined),
          transform: activeOffset ? `translate3d(${dir * activeOffset}px, 0, 0)` : undefined,
        }}
        className={`relative touch-pan-y ${revealed ? 'bg-surface-1 ' : ''}${
          drag.active ? '' : 'transition-transform duration-200 ease-out motion-reduce:transition-none '
        }${foregroundClassName}`}
      >
        {children}
      </div>
    </li>
  );
}
