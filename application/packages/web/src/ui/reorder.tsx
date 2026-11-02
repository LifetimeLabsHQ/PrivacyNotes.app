import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { SIDEBAR_DROP_INSIDE } from '../sidebarUI';
import { pushEscapeHandler } from '../useEscapeToClose';

/**
 * Drag to reorder: one engine and one look for every list a person arranges
 * (the folder tree, the sidebar rows, the toolbar board, the tab strip), so
 * they all feel the same. GitHub #621.
 *
 * Pointer events, not HTML5 drag: they work with a finger, they fire no
 * dragleave on child elements, and Firefox exposes no data mid-drag. A list
 * whose rows must also take something from outside (a note dropped on a tab)
 * keeps an HTML5 drop target for that alone.
 *
 * The engine owns what every list got wrong once: a threshold before a press
 * becomes a drag, pointer capture only from then on (an earlier capture eats
 * the click on a control in the row), the move and release listened for on
 * the window (a release outside the list still ends the drag), Escape and
 * pointercancel abort and never drop, a move with no button held ends a drag
 * that lost its release, the edge auto-scroll, no text selection, and a
 * re-render only when the target changes. The site says only where a point
 * lands (`resolve`) and what a drop does (`onDrop`).
 * Spec: docs/internal/design/patterns/151-160.md (section 158)
 */

/** Pointer travel before a press is a drag, not a shaky click. */
const THRESHOLD_PX = 8;
/** How near a scroll edge the drag pulls the list, and how fast. */
const AUTOSCROLL_EDGE_PX = 36;
const AUTOSCROLL_STEP_PX = 8;

/** The dragged row. */
export const DRAG_SOURCE = 'opacity-40';
/** A row that a drop goes INTO (a folder), not between. */
export const DROP_INSIDE = SIDEBAR_DROP_INSIDE;

export interface ReorderDrag<T> {
  id: string;
  /** Where a release now lands; null means nowhere (or a refused spot). */
  target: T | null;
  /** Past the threshold. Before that, the press may still be a click. */
  active: boolean;
}

export interface PointerReorderOptions<T> {
  /** Where a point lands for the dragged id, or null when it does not. */
  resolve: (id: string, x: number, y: number) => T | null;
  /** A string that changes when the target does; the list re-renders only then. */
  targetKey: (target: T) => string;
  onDrop: (id: string, target: T) => void;
  /** Off for a read-only list. */
  enabled?: boolean;
}

export interface PressOptions {
  /**
   * A grip owns no click, so it captures at once and takes touch: a row
   * that swallowed a vertical swipe would stop its list scrolling.
   */
  grip?: boolean;
}

export function usePointerReorder<T>({ resolve, targetKey, onDrop, enabled = true }: PointerReorderOptions<T>) {
  const [drag, setDrag] = useState<ReorderDrag<T> | null>(null);
  const live = useRef<{
    id: string;
    target: T | null;
    active: boolean;
    pointerId: number;
    el: HTMLElement;
    startX: number;
    startY: number;
    x: number;
    y: number;
    scroller: HTMLElement | null;
  } | null>(null);
  /** Set by a drag, so the click it ends on does not also select. */
  const dragged = useRef(false);
  const opts = useRef({ resolve, targetKey, onDrop });
  opts.current = { resolve, targetKey, onDrop };

  const publish = useCallback(() => {
    const d = live.current;
    setDrag((prev) => {
      if (!d) return null;
      const key = d.target === null ? null : opts.current.targetKey(d.target);
      const prevKey = prev?.target == null ? null : opts.current.targetKey(prev.target);
      if (prev && prev.id === d.id && prev.active === d.active && prevKey === key) return prev;
      return { id: d.id, target: d.target, active: d.active };
    });
    document.documentElement.classList.toggle('pn-reorder-refused', !!d?.active && d.target === null);
  }, []);

  /** Removes the window listeners of the current press. */
  const detach = useRef<(() => void) | null>(null);

  const finish = useCallback((drop: boolean) => {
    detach.current?.();
    detach.current = null;
    const d = live.current;
    live.current = null;
    document.documentElement.classList.remove('pn-reorder-active', 'pn-reorder-refused');
    try {
      if (d && d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
    } catch {
      // Already released.
    }
    setDrag(null);
    if (drop && d?.active && d.target !== null) opts.current.onDrop(d.id, d.target);
    // The click after this release must not select, but a release over empty
    // space makes no click, and a flag left standing would eat the next real
    // one. A timer runs after the click, so it covers both.
    setTimeout(() => {
      dragged.current = false;
    }, 0);
  }, []);

  const aim = useCallback(() => {
    const d = live.current;
    if (!d) return;
    d.target = opts.current.resolve(d.id, d.x, d.y);
    publish();
  }, [publish]);

  // Window listeners for the life of a press: a release or a move outside the
  // list still reaches the drag. Added in the press handler itself, not in an
  // effect after the next render, or a fast first move is lost.
  const attach = useCallback(() => {
    const move = (e: PointerEvent) => {
      const d = live.current;
      if (!d || e.pointerId !== d.pointerId) return;
      // The release happened where no listener heard it (another window, a
      // native drag): end without a drop rather than drag on with no button.
      if (e.buttons === 0 && e.pointerType === 'mouse') return finish(false);
      d.x = e.clientX;
      d.y = e.clientY;
      if (!d.active) {
        if (Math.hypot(d.x - d.startX, d.y - d.startY) <= THRESHOLD_PX) return;
        d.active = true;
        dragged.current = true;
        document.documentElement.classList.add('pn-reorder-active');
        // Capture from here on, and only from here: before this a click is
        // still possible, and capture would retarget it to the row.
        try {
          d.el.setPointerCapture(d.pointerId);
        } catch {
          // The window listeners still see the drag.
        }
        window.getSelection()?.removeAllRanges();
        // On the app's Escape stack, so Escape cancels the drag and not the
        // window the list sits in.
        const pop = pushEscapeHandler(() => finish(false));
        const off = detach.current;
        detach.current = () => {
          pop();
          off?.();
        };
      }
      aim();
    };
    const up = (e: PointerEvent) => {
      if (live.current && e.pointerId === live.current.pointerId) finish(true);
    };
    const cancel = (e: PointerEvent) => {
      if (live.current && e.pointerId === live.current.pointerId) finish(false);
    };
    const blur = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', blur);
    detach.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', blur);
    };
  }, [aim, finish]);

  // Auto-scroll near either edge of the list's scroller. The target is aimed
  // again each frame, because the rows move under a pointer that holds still.
  const active = !!drag?.active;
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const step = () => {
      const d = live.current;
      const el = d?.scroller;
      if (d?.active && el) {
        const box = el.getBoundingClientRect();
        const before = [el.scrollTop, el.scrollLeft];
        if (el.scrollHeight > el.clientHeight) {
          if (d.y < box.top + AUTOSCROLL_EDGE_PX) el.scrollTop -= AUTOSCROLL_STEP_PX;
          else if (d.y > box.bottom - AUTOSCROLL_EDGE_PX) el.scrollTop += AUTOSCROLL_STEP_PX;
        }
        // A sideways strip (the tabs) scrolls along its own axis.
        if (el.scrollWidth > el.clientWidth) {
          if (d.x < box.left + AUTOSCROLL_EDGE_PX) el.scrollLeft -= AUTOSCROLL_STEP_PX;
          else if (d.x > box.right - AUTOSCROLL_EDGE_PX) el.scrollLeft += AUTOSCROLL_STEP_PX;
        }
        if (el.scrollTop !== before[0] || el.scrollLeft !== before[1]) aim();
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active, aim]);

  // A list that unmounts mid-drag leaves no listener and no class behind.
  useEffect(
    () => () => {
      detach.current?.();
      document.documentElement.classList.remove('pn-reorder-active', 'pn-reorder-refused');
    },
    [],
  );

  /** Spread on a row (mouse and pen) or a grip (every pointer). */
  const pressProps = (id: string, { grip = false }: PressOptions = {}) =>
    enabled
      ? {
          onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
            // Left button only: a right-click opens the row menu.
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (!grip && e.pointerType === 'touch') return;
            // A control that owns its own click (a caret, a "..." menu).
            if (!grip && (e.target as HTMLElement).closest('[data-no-drag]')) return;
            // The grip sits inside the row: one press, one drag.
            if (live.current) return;
            const el = e.currentTarget;
            if (grip) {
              try {
                el.setPointerCapture(e.pointerId);
              } catch {
                // The window listeners still see the drag.
              }
            }
            live.current = {
              id,
              target: null,
              active: false,
              pointerId: e.pointerId,
              el,
              startX: e.clientX,
              startY: e.clientY,
              x: e.clientX,
              y: e.clientY,
              scroller: findScroller(el),
            };
            dragged.current = false;
            attach();
          },
          // A press that moves over text starts the browser's own drag, which
          // ends the pointer stream with a pointercancel: the reorder died
          // mid-gesture, or (before this engine) dropped wherever the line
          // was. No native drag starts from a row that reorders.
          onDragStart: (e: React.DragEvent<HTMLElement>) => e.preventDefault(),
          ...(grip ? { style: { touchAction: 'none' } as CSSProperties } : {}),
        }
      : {};

  return {
    drag: drag?.active ? drag : null,
    pressProps,
    /** True for the click that ends a drag: skip its selection. */
    endedDrag: () => dragged.current,
  };
}

/**
 * Before or after a row, from which half of it the point is in. `axis` 'x'
 * is a sideways strip; RTL flips which half is "before".
 */
export function halfOf(el: Element, x: number, y: number, axis: 'x' | 'y' = 'y'): 'before' | 'after' {
  const box = el.getBoundingClientRect();
  if (axis === 'y') return y < box.top + box.height / 2 ? 'before' : 'after';
  const rtl = getComputedStyle(el).direction === 'rtl';
  const firstHalf = x < box.left + box.width / 2;
  return firstHalf !== rtl ? 'before' : 'after';
}

/**
 * The row of a list nearest to a point along `axis`, by its `data-reorder-id`.
 * A point in the gap between two rows takes the nearer one, so the line never
 * blinks off while it crosses a gap.
 */
export function nearestRow(root: Element | null, x: number, y: number, axis: 'x' | 'y' = 'y'): HTMLElement | null {
  if (!root) return null;
  let best: HTMLElement | null = null;
  let bestGap = Infinity;
  for (const el of root.querySelectorAll<HTMLElement>('[data-reorder-id]')) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const [lo, hi, p] = axis === 'y' ? [box.top, box.bottom, y] : [box.left, box.right, x];
    const gap = p < lo ? lo - p : p > hi ? p - hi : 0;
    if (gap < bestGap) {
      best = el;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * The landing line, drawn ON a row, never in the flow: in the flow it adds
 * its own height mid-drag, moves the rows it is measured against, and
 * flickers between two slots. The row must be `relative`.
 */
export function DropLine({ edge, inset = 0 }: { edge: 'top' | 'bottom' | 'start' | 'end'; inset?: number }) {
  const sideways = edge === 'start' || edge === 'end';
  const place = {
    top: 'top-0 -mt-px h-0.5',
    bottom: 'bottom-0 -mb-px h-0.5',
    start: 'start-0 -ms-px w-0.5 top-1 bottom-1',
    end: 'end-0 -me-px w-0.5 top-1 bottom-1',
  }[edge];
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute z-10 rounded-full bg-accent-fill ${place}`}
      style={sideways ? undefined : { insetInlineStart: inset, insetInlineEnd: 4 }}
    />
  );
}

/**
 * Nearest scrollable ancestor, so a drag can pull a long list past its pane.
 * The walk stops at a dialog: a list too short to scroll would otherwise hand
 * the auto-scroll to the app behind the modal.
 */
function findScroller(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  const scrolls = (v: string) => v === 'auto' || v === 'scroll';
  while (node) {
    const style = getComputedStyle(node);
    if (scrolls(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    if (scrolls(style.overflowX) && node.scrollWidth > node.clientWidth) return node;
    if (node.getAttribute('role') === 'dialog') return null;
    node = node.parentElement;
  }
  return null;
}
