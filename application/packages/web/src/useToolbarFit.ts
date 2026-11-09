import { useLayoutEffect, useRef, useState } from 'react';

// What the ••• toggle costs row 1 once it appears: one 32px button box and
// the 6px gap before it. Only the frame that turns overflow on needs this -
// after that the toggle is in the cluster and the row is measured around it.
const MORE_TOGGLE_W = 38;

/**
 * How many of a toolbar row's buttons fit in one line, for the editor's
 * format bar and the drawing canvas's toolbar alike. Under a pointer, row 1
 * shows as many buttons as fit at the current width and the rest overflow
 * into a full-width row 2 behind a ••• toggle; when everything fits there is
 * no toggle. On a touch screen (`strip`) every button renders in one strip
 * that scrolls, with a fade (`data-fade` on the row) on the edge that has
 * more to show.
 *
 * `rowRef` goes on the row (its parent is the flex line it shares with the
 * cluster at its end), `clusterRef` on that cluster. `sig` names the row's
 * buttons in order: the width cache is indexed by position, so a new
 * arrangement starts it over, and until it is measured every button is drawn
 * (`measured` is false), so a button that was behind the ••• before the
 * change is still measured and shown.
 */
export function useToolbarFit(strip: boolean, sig: string) {
  // Collapsed (default), the buttons fill row 1 and any that don't fit wait
  // behind the •••, which reveals them in row 2.
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(99);
  const [hasOverflow, setHasOverflow] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const clusterRef = useRef<HTMLDivElement>(null);
  const itemWidthsRef = useRef<number[]>([]);
  const overflowRef = useRef(false);
  const [measuredSig, setMeasuredSig] = useState<string | null>(null);
  // Bumped to measure every button again (see the broken-layout check).
  const [remeasure, setRemeasure] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const flexRow = row?.parentElement;
    if (!row || !flexRow) return;
    itemWidthsRef.current = [];
    overflowRef.current = false;
    if (strip) {
      // Every button renders and the row scrolls; a fade on the edge that has
      // more to show says so. Logical edges: in RTL the start is on the right
      // and scrollLeft counts down from 0.
      setVisibleCount(99);
      setHasOverflow(false);
      setExpanded(false);
      const fade = () => {
        const max = row.scrollWidth - row.clientWidth;
        const pos = Math.abs(row.scrollLeft);
        const start = pos > 1;
        const end = pos < max - 1;
        row.dataset.fade = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
      };
      fade();
      row.addEventListener('scroll', fade, { passive: true });
      const ro = new ResizeObserver(fade);
      ro.observe(row);
      return () => { row.removeEventListener('scroll', fade); ro.disconnect(); };
    }
    delete row.dataset.fade;
    const recompute = () => {
      const kids = Array.from(row.children) as HTMLElement[];
      // Every button's width, captured while all of them are still in row 1.
      // Later passes see only the ones that fit, so they refresh that prefix
      // in place, and each entry keeps the WIDEST width it has been measured
      // at. The heading button is why: its glyph reads H in body copy and H1
      // to H6 inside a heading, so it grows by a digit as the caret moves.
      // Reserving the wider spelling is what stops the row dropping a button
      // the moment somebody puts the caret in a title.
      if (kids.length > itemWidthsRef.current.length) {
        itemWidthsRef.current = kids.map((k) => k.getBoundingClientRect().width);
      } else {
        const now = kids.map((k) => k.getBoundingClientRect().width);
        // A button at half the width it was measured at or less means that
        // measure came from a broken layout: one frame without the
        // stylesheet (a slow CSS load, a dev reload) draws every icon at its
        // natural size, and the widest-ever rule would keep the row at one
        // button for good. Start over: draw every button and measure again.
        if (now.some((w, i) => w > 0 && w * 2 <= (itemWidthsRef.current[i] ?? 0))) {
          itemWidthsRef.current = [];
          setMeasuredSig(null);
          setRemeasure((n) => n + 1);
          return;
        }
        now.forEach((w, i) => {
          itemWidthsRef.current[i] = Math.max(itemWidthsRef.current[i] ?? 0, w);
        });
      }
      const widths = itemWidthsRef.current;
      const total = widths.length;
      if (!total) return;
      // A button width is fractional - the heading button's glyph decides its
      // own - while the row's box is whole pixels, so a button whose last
      // fraction of a pixel lands outside still reads as fitting: the clip
      // takes a sliver of a rounded corner nobody can see. Hold that slack
      // open, because a 0.8px overhang otherwise costs a whole button.
      const SUBPIXEL = 1;
      const fit = (cap: number) => {
        let used = 0;
        let n = 0;
        for (; n < total; n++) {
          used += widths[n]! + (n ? 2 : 0);
          if (used - cap > SUBPIXEL) break;
        }
        return n;
      };
      // The row's own box is the width flexbox allotted it, and it already
      // accounts for the right cluster, including ••• when that is present.
      // The 6px gap to the cluster is part of the layout, so nothing is held
      // back for it here: a margin on top of that gap buys no space a reader
      // can see and costs the last button its place.
      const avail = row.getBoundingClientRect().width;
      let n = fit(avail);
      const overflow = n < total;
      // On the transition into overflow the ••• isn't in the cluster yet, so
      // reserve its width now - otherwise a button would clip for one frame
      // before the observer re-measures the (now wider) cluster.
      if (overflow && !overflowRef.current) n = Math.max(1, fit(avail - MORE_TOGGLE_W));
      overflowRef.current = overflow;
      setVisibleCount(overflow ? n : total);
      setHasOverflow(overflow);
      setMeasuredSig(sig);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(flexRow);
    if (clusterRef.current) ro.observe(clusterRef.current);
    return () => ro.disconnect();
  }, [strip, sig, remeasure]);

  return { rowRef, clusterRef, visibleCount, hasOverflow, measured: measuredSig === sig, expanded, setExpanded };
}
