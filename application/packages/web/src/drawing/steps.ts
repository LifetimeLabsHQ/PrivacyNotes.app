/**
 * The Steps tool (issue #690): each click on the canvas drops a numbered
 * circle, 1, 2, 3, for a how-to over a screenshot. A marker is an ordinary
 * Excalidraw ellipse with its number as bound text, so it exports, imports
 * and opens in other tools like any shape. `customData.pnStep` holds the
 * number, so the next click counts on from the highest marker left.
 *
 * Imported by DrawingCanvas.tsx only (the lazy chunk); it imports nothing
 * of Excalidraw, so a test reads it without the canvas.
 * Spec: docs/internal/specs/drawing.md (section 0)
 */

/** The custom tool's name, as Excalidraw's `activeTool.customType`. */
export const STEPS_TOOL = 'steps';

/** The circle's width as a multiple of the font size: room for two digits
 *  inside an ellipse's text box without Excalidraw growing it. */
const SIZE_PER_FONT = 2.6;

type Marked = { isDeleted?: boolean; customData?: Record<string, unknown> };

/** The number the next marker carries: one more than the highest marker
 *  still on the canvas, so a deleted last marker is placed again. */
export function nextStep(elements: readonly Marked[]): number {
  let top = 0;
  for (const e of elements) {
    const n = e.customData?.pnStep;
    if (!e.isDeleted && typeof n === 'number' && Number.isInteger(n) && n > top) top = n;
  }
  return top + 1;
}

/** The style the next shape takes, from Excalidraw's app state. */
export type StepStyle = {
  currentItemStrokeColor: string;
  currentItemBackgroundColor: string;
  currentItemFillStyle: string;
  currentItemStrokeWidth: number;
  currentItemStrokeStyle: string;
  currentItemRoughness: number;
  currentItemOpacity: number;
  currentItemFontFamily: number;
  currentItemFontSize: number;
};

/** A marker as an element skeleton for `convertToExcalidrawElements`,
 *  centred on the click, in the style the panel shows. */
export function stepSkeleton(n: number, at: { x: number; y: number }, s: StepStyle) {
  const size = Math.round(s.currentItemFontSize * SIZE_PER_FONT);
  return {
    type: 'ellipse' as const,
    x: at.x - size / 2,
    y: at.y - size / 2,
    width: size,
    height: size,
    strokeColor: s.currentItemStrokeColor,
    backgroundColor: s.currentItemBackgroundColor,
    fillStyle: s.currentItemFillStyle,
    strokeWidth: s.currentItemStrokeWidth,
    strokeStyle: s.currentItemStrokeStyle,
    roughness: s.currentItemRoughness,
    opacity: s.currentItemOpacity,
    customData: { pnStep: n },
    label: {
      text: String(n),
      fontSize: s.currentItemFontSize,
      fontFamily: s.currentItemFontFamily,
      strokeColor: s.currentItemStrokeColor,
      textAlign: 'center' as const,
      verticalAlign: 'middle' as const,
    },
  };
}
