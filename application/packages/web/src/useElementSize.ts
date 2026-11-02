import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** The content box, as a ResizeObserver reports it: the padding and the
 *  border left out. */
function contentSide(el: HTMLElement, side: 'width' | 'height'): number {
  const cs = getComputedStyle(el);
  const frame = side === 'width'
    ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
    : parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  return el.getBoundingClientRect()[side] - frame;
}

function useElementSide(el: HTMLElement | null, side: 'width' | 'height'): number {
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setSize(contentSide(el, side));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setSize(entries[0]?.contentRect[side] ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, side]);
  return size;
}

/** The height of an element, kept current. */
export function useElementHeight(el: HTMLElement | null): number {
  return useElementSide(el, 'height');
}

/**
 * An element's width, renewed only when `stepOf` gives a new key for it: a
 * pane dragged wider draws again at the steps where its layout changes, not
 * at every pixel. The ref holds the live width, for a gesture that needs it
 * between steps. `stepOf` is read fresh at each resize.
 */
export function useSteppedWidth(el: HTMLElement | null, stepOf: (width: number) => string): [number, RefObject<number>] {
  const [width, setWidth] = useState(0);
  const live = useRef(0);
  const step = useRef(stepOf);
  step.current = stepOf;
  const key = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const read = (w: number) => {
      live.current = w;
      const next = step.current(w);
      if (next === key.current) return;
      key.current = next;
      setWidth(w);
    };
    key.current = null;
    read(contentSide(el, 'width'));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => read(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [width, live];
}
