import { TIP_SKIN } from './HoverLabel';

// Spec: docs/internal/design/ui-patterns.md (section 18 - touch long-press tooltips)

/** Hold time before a touch tooltip appears, short enough to feel responsive
 *  on Android without firing during normal taps or scrolls. */
export const TOUCH_TIP_DELAY_MS = 400;
/** Time the tooltip stays readable after the finger lifts, unless dismissed
 *  sooner by another touch or scroll. */
export const TOUCH_TIP_LINGER_MS = 1200;
/** Window after touchend in which the trailing synthesized click is dropped so
 *  checking a tooltip never activates the control under the finger. */
const TOUCH_TIP_CLICK_GUARD_MS = 500;
/** Finger travel (px) that cancels a pending hold (scrolling a strip, swiping). */
const TOUCH_TIP_MOVE_PX = 10;

const EDGE = 8;
const GAP = 10;
const NO_TIP_ANCESTOR = '[data-pn-no-touch-tip], input, textarea, select, [contenteditable="true"], [contenteditable=""]';

export interface TouchTipBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TouchTipViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Place a touch tooltip centered above its target (clear of the finger),
 * clamped horizontally inside the visible viewport. Flips below when there is
 * no room above (for controls pinned to the top edge of the screen).
 */
export function placeTouchTip(
  target: TouchTipBox,
  tip: { width: number; height: number },
  vp: TouchTipViewport,
): { left: number; top: number } {
  const minLeft = vp.left + EDGE;
  const maxLeft = Math.max(minLeft, vp.left + vp.width - tip.width - EDGE);
  const centered = (target.left + target.right) / 2 - tip.width / 2;
  const left = Math.min(maxLeft, Math.max(minLeft, centered));

  const minTop = vp.top + EDGE;
  const maxTop = vp.top + vp.height - EDGE;
  const aboveTop = target.top - tip.height - GAP;
  const belowTop = target.bottom + GAP;
  const top =
    aboveTop >= minTop || belowTop + tip.height > maxTop
      ? Math.max(minTop, aboveTop)
      : belowTop;

  return { left, top };
}

function readViewport(): TouchTipViewport {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (vv) {
    return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height };
  }
  return {
    left: 0,
    top: 0,
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  };
}

function findTouchTipHost(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target : null;
  if (!el) return null;
  if (el.closest(NO_TIP_ANCESTOR)) return null;
  const host = el.closest<HTMLElement>('.pn-tip-host[data-pn-touch-tip]');
  if (!host) return null;
  if (host.closest('[data-pn-no-touch-tip]')) return null;
  if (!host.dataset.pnTouchTip?.trim()) return null;
  return host;
}

/**
 * One document-level touch long-press tooltip handler for every `HoverLabel`.
 *
 * Renders a single fixed pill on `document.body` so tips escape clipping scroll
 * strips such as the touch editor format bar (`.pn-format-strip`), without
 * adding listeners or state to every icon button in the app.
 */
export function installTouchTooltips(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};

  let holdTimer: number | null = null;
  let lingerTimer: number | null = null;
  let touchId: number | null = null;
  let startX = 0;
  let startY = 0;
  let activeHost: HTMLElement | null = null;
  let fired = false;
  let suppressClickUntil = 0;
  let pill: HTMLDivElement | null = null;

  const clearHold = () => {
    if (holdTimer !== null) {
      window.clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const clearLinger = () => {
    if (lingerTimer !== null) {
      window.clearTimeout(lingerTimer);
      lingerTimer = null;
    }
  };

  const hidePill = () => {
    clearLinger();
    if (pill) {
      pill.remove();
      pill = null;
    }
  };

  const showPill = (host: HTMLElement) => {
    const label = host.dataset.pnTouchTip?.trim();
    if (!label) return;
    hidePill();
    const el = document.createElement('div');
    el.setAttribute('role', 'tooltip');
    // theme-ok: TIP_SKIN is the dark tooltip pill shared across every theme
    el.className = `pn-touch-tip pointer-events-none select-none fixed z-[80] flex items-center gap-2 max-w-[min(280px,calc(100vw-16px))] shadow-lg ${TIP_SKIN}`;
    const text = document.createElement('span');
    text.textContent = label;
    el.appendChild(text);
    if (host.dataset.pnTouchTipPro === '1') {
      const pro = document.createElement('span');
      // theme-ok: gold on the dark tooltip pill
      pro.className = '-ms-1 font-semibold text-amber-300';
      pro.textContent = '· Pro';
      el.appendChild(pro);
    }
    el.style.left = '0px';
    el.style.top = '0px';
    document.body.appendChild(el);
    pill = el;

    const targetRect = host.getBoundingClientRect();
    const tipRect = el.getBoundingClientRect();
    const pos = placeTouchTip(targetRect, tipRect, readViewport());
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  };

  const triggerHold = (host: HTMLElement) => {
    clearHold();
    fired = true;
    suppressClickUntil = Infinity;
    showPill(host);
  };

  const onTouchStart = (e: TouchEvent) => {
    hidePill();
    clearHold();
    fired = false;
    touchId = null;
    activeHost = null;
    if (e.touches.length !== 1) return;
    const host = findTouchTipHost(e.target);
    if (!host) return;
    const t = e.touches[0];
    if (!t) return;
    touchId = t.identifier;
    startX = t.clientX;
    startY = t.clientY;
    activeHost = host;
    holdTimer = window.setTimeout(() => {
      holdTimer = null;
      if (activeHost) triggerHold(activeHost);
    }, TOUCH_TIP_DELAY_MS);
  };

  const onTouchMove = (e: TouchEvent) => {
    if (touchId === null) return;
    if (e.touches.length > 1) {
      clearHold();
      hidePill();
      touchId = null;
      activeHost = null;
      return;
    }
    let t: Touch | undefined;
    for (let i = 0; i < e.touches.length; i++) {
      if (e.touches[i]?.identifier === touchId) {
        t = e.touches[i];
        break;
      }
    }
    if (!t) {
      clearHold();
      touchId = null;
      activeHost = null;
      return;
    }
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (dx * dx + dy * dy > TOUCH_TIP_MOVE_PX * TOUCH_TIP_MOVE_PX) {
      clearHold();
      if (!fired) {
        touchId = null;
        activeHost = null;
      } else {
        hidePill();
      }
    }
  };

  const finishTouch = (e: TouchEvent, preventDefault: boolean) => {
    clearHold();
    touchId = null;
    activeHost = null;
    if (!fired) return;
    fired = false;
    suppressClickUntil = performance.now() + TOUCH_TIP_CLICK_GUARD_MS;
    if (preventDefault && e.cancelable) e.preventDefault();
    clearLinger();
    lingerTimer = window.setTimeout(() => {
      lingerTimer = null;
      hidePill();
    }, TOUCH_TIP_LINGER_MS);
  };

  const onTouchEnd = (e: TouchEvent) => finishTouch(e, true);
  const onTouchCancel = (e: TouchEvent) => finishTouch(e, false);

  const onContextMenu = (e: MouseEvent) => {
    if (fired || performance.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Android WebView/Chrome can fire native contextmenu slightly before our
    // 400ms timer on links and buttons; show the tooltip instead of the browser
    // link sheet, while leaving desktop mouse right-click untouched.
    if (touchId !== null && activeHost) {
      e.preventDefault();
      e.stopPropagation();
      triggerHold(activeHost);
    }
  };

  const onClickCapture = (e: MouseEvent) => {
    if (performance.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onDismiss = () => {
    clearHold();
    hidePill();
  };

  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  document.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
  document.addEventListener('contextmenu', onContextMenu, { capture: true });
  document.addEventListener('click', onClickCapture, { capture: true });
  window.addEventListener('scroll', onDismiss, { capture: true, passive: true });
  window.addEventListener('blur', onDismiss);

  return () => {
    clearHold();
    hidePill();
    document.removeEventListener('touchstart', onTouchStart, { capture: true });
    document.removeEventListener('touchmove', onTouchMove, { capture: true });
    document.removeEventListener('touchend', onTouchEnd, { capture: true });
    document.removeEventListener('touchcancel', onTouchCancel, { capture: true });
    document.removeEventListener('contextmenu', onContextMenu, { capture: true });
    document.removeEventListener('click', onClickCapture, { capture: true });
    window.removeEventListener('scroll', onDismiss, { capture: true });
    window.removeEventListener('blur', onDismiss);
  };
}
