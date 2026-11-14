import { useCallback, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export interface PopoverPos {
  top: number;
  left: number;
  /** Set only with `shrink`, when the popover fits on neither side. */
  maxHeight?: number;
}

interface PopoverPositionOptions {
  /** Gap between the trigger and the popover, in px. */
  gap?: number;
  /** Minimum distance the popover keeps from every viewport edge, in px. */
  margin?: number;
  /**
   * Horizontal alignment to the trigger: 'start' aligns their left edges
   * (default), 'end' aligns their right edges, 'center' centers the popover
   * over the trigger. Either way the popover then
   * shifts inward so it never spills off a viewport edge.
   */
  align?: 'start' | 'end' | 'center';
  /**
   * For a popover that scrolls: when it fits neither below nor above the
   * trigger, keep it on the side with more room and return a `maxHeight`
   * for that room, instead of sliding it over the trigger. With an on-screen
   * keyboard up the viewport is short, and a menu laid over its own button
   * hides the toolbar it belongs to.
   */
  shrink?: boolean;
}

/**
 * The bottom of what can be seen. iOS lays the keyboard over the layout
 * without shrinking `innerHeight`, so a menu under a bar that sits on the
 * keyboard opened behind it (GitHub #623).
 */
export function visibleBottom(): number {
  const vv = window.visualViewport;
  return vv ? Math.min(window.innerHeight, vv.offsetTop + vv.height) : window.innerHeight;
}

let insetProbe: HTMLDivElement | null = null;

/**
 * The top of what can be seen: under the iOS status bar (the safe-area inset,
 * 0 everywhere else), and under the part of the page iOS scrolled out of view
 * to show a focused field over the keyboard. A menu that fits neither below
 * nor above its button was pushed to the window's top edge, which sat under
 * the clock (GitHub #707).
 */
function visibleTop(): number {
  if (!insetProbe) {
    insetProbe = document.createElement('div');
    insetProbe.setAttribute('aria-hidden', 'true');
    insetProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none';
    document.body.appendChild(insetProbe);
  }
  const vv = window.visualViewport;
  return Math.max(vv ? vv.offsetTop : 0, insetProbe.getBoundingClientRect().height);
}

/**
 * Place an editor suggestion list (`[[`, `=`) at the caret: below it, nudged
 * left off the right edge, and above it when it would not fit below (the
 * keyboard counts, through `visibleBottom`). With no room on either side it
 * sits on the bottom edge. Measured after the list is drawn.
 */
export function placeAtCaret(popup: HTMLElement, rect: DOMRect): void {
  popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
  popup.style.left = `${rect.left + window.scrollX}px`;
  requestAnimationFrame(() => {
    const popupRect = popup.getBoundingClientRect();
    if (popupRect.right > window.innerWidth - 8) {
      popup.style.left = `${window.innerWidth - popupRect.width - 8}px`;
    }
    const bottom = visibleBottom();
    if (popupRect.bottom <= bottom - 8) return;
    const top = rect.top - popupRect.height - 4 >= 8
      ? rect.top - popupRect.height - 4
      : Math.max(8, bottom - 8 - popupRect.height);
    popup.style.top = `${top + window.scrollY}px`;
  });
}

/**
 * Position a portal-rendered popover anchored under a trigger button so it can
 * never be clipped by the viewport, no matter where the trigger sits.
 *
 * It measures the *rendered* popover (so there are no hardcoded widths to keep
 * in sync), shifts horizontally to stay on-screen, and flips above the trigger
 * when there is no room below. Recomputes on scroll/resize while open.
 *
 * Returns null until the first measurement. Render the popover while `open` is
 * true and give it `visibility: pos ? 'visible' : 'hidden'` so it never flashes
 * at a stale position before it is placed. Spec: docs/internal/design/ui-patterns.md
 * (scroll listener uses capture phase to catch scrollable ancestors, not just window)
 */
export function usePopoverPosition<A extends HTMLElement, P extends HTMLElement>(
  open: boolean,
  anchorRef: RefObject<A | null>,
  popoverRef: RefObject<P | null>,
  { gap = 4, margin = 8, align = 'start', shrink = false }: PopoverPositionOptions = {},
): PopoverPos | null {
  const [pos, setPos] = useState<PopoverPos | null>(null);

  const compute = useCallback(() => {
    const anchor = anchorRef.current;
    const pop = popoverRef.current;
    if (!anchor || !pop) return;
    const a = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = visibleBottom();
    const minTop = visibleTop() + margin;

    // Horizontal: align to the trigger's chosen edge, then slide inward to fit.
    let left = align === 'end' ? a.right - p.width : align === 'center' ? a.left + (a.width - p.width) / 2 : a.left;
    if (left + p.width > vw - margin) left = vw - p.width - margin;
    left = Math.max(margin, left);

    // Vertical: open below the trigger; flip above when the bottom would clip;
    // if neither side fits (very short viewport), shift up to the last spot.
    // A shrinking popover is measured at its full content height, because the
    // height it renders at is the room it was given last time.
    const height = shrink ? pop.scrollHeight + (p.height - pop.clientHeight) : p.height;
    let top = a.bottom + gap;
    let maxHeight: number | undefined;
    if (top + height > vh - margin) {
      const above = a.top - height - gap;
      if (above >= minTop) {
        top = above;
      } else if (shrink) {
        const roomBelow = vh - margin - top;
        const roomAbove = a.top - gap - minTop;
        if (roomBelow >= roomAbove) {
          maxHeight = roomBelow;
        } else {
          top = minTop;
          maxHeight = roomAbove;
        }
      } else {
        top = Math.max(minTop, vh - p.height - margin);
      }
    }

    setPos({ top, left, maxHeight });
  }, [anchorRef, popoverRef, gap, margin, align, shrink]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    compute();
    const onScroll = () => compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', onScroll, true);
    // The iOS keyboard opens and closes without a window resize. A menu
    // placed while it was up kept its short maxHeight after it closed, and
    // its last rows were cut off (GitHub #745).
    const vv = window.visualViewport;
    vv?.addEventListener('resize', compute);
    vv?.addEventListener('scroll', compute);
    // Re-place when the popover's own size changes (e.g. a menu whose items
    // toggle while open) so it stays anchored and on-screen without callers
    // wiring content into the dep array.
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && popoverRef.current) {
      ro = new ResizeObserver(() => compute());
      ro.observe(popoverRef.current);
    }
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', onScroll, true);
      vv?.removeEventListener('resize', compute);
      vv?.removeEventListener('scroll', compute);
      ro?.disconnect();
    };
  }, [open, compute, popoverRef]);

  return pos;
}

/**
 * Position a fixed menu anchored to a *point* (a right-click location or a
 * computed corner) so it can never be clipped: it measures the rendered menu
 * and shifts it inward on both axes to stay within the viewport. Use this for
 * cursor/coordinate-anchored context menus - where there is no trigger element
 * to hand to usePopoverPosition. Mirrors the clamp in `ContextMenu.tsx`.
 *
 * `point` is the desired top-left corner in viewport coordinates (pass null
 * when the menu is closed). Returns null until measured; render the menu and
 * set `visibility: pos ? 'visible' : 'hidden'` to avoid a flash at the raw,
 * pre-clamp point. Spec: docs/internal/design/ui-patterns.md section 15 (measure the real
 * menu rather than a hardcoded height/width guess)
 */
export function usePointMenuPosition<P extends HTMLElement>(
  point: { x: number; y: number } | null,
  menuRef: RefObject<P | null>,
  { margin = 8 }: { margin?: number } = {},
): PopoverPos | null {
  const px = point?.x ?? null;
  const py = point?.y ?? null;
  const [pos, setPos] = useState<PopoverPos | null>(null);

  const compute = useCallback(() => {
    const menu = menuRef.current;
    if (px == null || py == null || !menu) return;
    const m = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = visibleBottom();
    let left = px;
    let top = py;
    if (left + m.width > vw - margin) left = Math.max(margin, vw - m.width - margin);
    if (top + m.height > vh - margin) top = Math.max(margin, vh - m.height - margin);
    setPos({ top, left });
  }, [px, py, menuRef, margin]);

  useLayoutEffect(() => {
    if (px == null || py == null) {
      setPos(null);
      return;
    }
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [px, py, compute]);

  return pos;
}
