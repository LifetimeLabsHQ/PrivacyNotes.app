/**
 * Three faults of Excalidraw's link popup (0.18.1) inside the app's pane,
 * where the canvas does not start at the page's corner:
 *
 * - It is centred over the shape with no check of the canvas edges. A shape
 *   near the left edge put it partly outside the canvas, which cuts it off
 *   (`[[Note]]` read `[Note]]`); a shape near the top put it wholly above
 *   the canvas, out of sight. It also lay on the shape panel.
 * - Its auto-hide compares the pointer's page position with the popup's
 *   position in the canvas, so the popup closed under the pointer as soon
 *   as the pointer left the shape's column (`shouldHideLinkPopup`).
 *
 * This keeps the popup inside the canvas: right of the shape panel where
 * there is room for both, and under the shape where there is no room above
 * it. A pointer move over the popup reaches Excalidraw as the same point of
 * the popup at the place Excalidraw put it, which its check takes for "on
 * the popup".
 *
 * Excalidraw writes the popup's `left` and `top` inline on each render
 * where the value changes, so a style change is the moment to correct it;
 * the values Excalidraw wrote are kept on the element (`data-pn-stock-*`).
 * Spec: docs/internal/specs/drawing.md (section 3)
 */

const GAP = 8;
/** Excalidraw's `SPACE_BOTTOM`: its popup top is the shape's top less this. */
const SPACE_ABOVE = 85;
/** Excalidraw's own hide check takes a pointer this near the popup as on it. */
const NEAR = 15;
const POPUP = ':scope > .excalidraw-hyperlinkContainer';

type Stock = { left: number; top: number };

/** The place Excalidraw gave the popup. React writes `left` and `top` one at
 *  a time, only the one that changed, so each is read again on its own. */
function stockOf(popup: HTMLElement): Stock | null {
  const d = popup.dataset;
  if (popup.style.left !== d.pnLeft) d.pnStockLeft = popup.style.left;
  if (popup.style.top !== d.pnTop) d.pnStockTop = popup.style.top;
  const left = parseFloat(d.pnStockLeft ?? '');
  const top = parseFloat(d.pnStockTop ?? '');
  return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
}

function fit(canvas: HTMLElement, shapeHeight: () => number | null): void {
  const popup = canvas.querySelector<HTMLElement>(POPUP);
  if (!popup) return;
  const stock = stockOf(popup);
  if (!stock) return;
  const box = canvas.getBoundingClientRect();
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;

  let top = stock.top;
  if (top < GAP) {
    // No room above the shape: under it, else at the top edge.
    // The same gap Excalidraw leaves between the popup and a shape under it.
    const below = stock.top + SPACE_ABOVE + (shapeHeight() ?? 0) + (SPACE_ABOVE - height);
    top = below + height + GAP <= box.height ? below : GAP;
  }
  top = Math.max(GAP, Math.min(top, box.height - height - GAP));

  let min = GAP;
  const panel = canvas.querySelector('.App-menu__left')?.getBoundingClientRect();
  if (panel && panel.width > 0 && panel.top - box.top < top + height && panel.bottom - box.top > top) {
    const right = panel.right - box.left + GAP;
    if (right + width + GAP <= box.width) min = right;
  }
  const left = Math.max(min, Math.min(stock.left, box.width - width - GAP));

  // A write of the same value is still a style change, which would call
  // this again: write only what moved.
  if (popup.style.left !== `${left}px`) popup.style.left = `${left}px`;
  if (popup.style.top !== `${top}px`) popup.style.top = `${top}px`;
  popup.dataset.pnLeft = popup.style.left;
  popup.dataset.pnTop = popup.style.top;
}

/**
 * Watch the canvas under `host` and keep its link popup in view and open
 * under the pointer. `shapeHeight` is the linked shape's height on screen.
 */
export function keepLinkPopupInView(host: HTMLElement | null, shapeHeight: () => number | null): () => void {
  if (!host) return () => {};
  const canvasOf = () => host.querySelector<HTMLElement>('.excalidraw');
  const observer = new MutationObserver(() => {
    const canvas = canvasOf();
    if (canvas) fit(canvas, shapeHeight);
  });
  observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  const ours = new WeakSet<Event>();
  const onMove = (e: PointerEvent) => {
    if (ours.has(e)) return;
    const popup = canvasOf()?.querySelector<HTMLElement>(POPUP);
    const stock = popup && stockOf(popup);
    if (!popup || !stock) return;
    const r = popup.getBoundingClientRect();
    if (e.clientX < r.left - NEAR || e.clientX > r.right + NEAR || e.clientY < r.top - NEAR || e.clientY > r.bottom + NEAR) return;
    e.stopImmediatePropagation();
    const moved = new PointerEvent('pointermove', {
      clientX: stock.left + Math.min(Math.max(e.clientX - r.left, 0), r.width),
      clientY: stock.top + Math.min(Math.max(e.clientY - r.top, 0), r.height),
      pointerId: e.pointerId,
      pointerType: e.pointerType,
    });
    ours.add(moved);
    window.dispatchEvent(moved);
  };
  window.addEventListener('pointermove', onMove, true);
  return () => {
    observer.disconnect();
    window.removeEventListener('pointermove', onMove, true);
  };
}
