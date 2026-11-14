/**
 * The Steps tool (issue #690): each click on the canvas drops a numbered
 * circle, 1, 2, 3, for a how-to over a screenshot. A marker is an ordinary
 * Excalidraw ellipse with its number as bound text, so it exports, imports
 * and opens in other tools like any shape. `customData.pnStep` holds the
 * number, so the next click counts on from the highest marker left, and
 * the markers left close up to 1, 2, 3 when one goes (`renumberSteps`).
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

type Element = Marked & { id: string; type?: string; boundElements?: readonly { id: string; type: string }[] | null };

/** The markers whose number changes so that the markers left read 1 to n.
 *  Known markers (`known`: ids the canvas saw before, Undo's returns
 *  among them) keep the order of their numbers, the earlier shape first on
 *  a tie; new ones (a paste) follow at the end. A deleted step closes its
 *  gap. Empty when nothing changes. */
export function renumberSteps(elements: readonly Element[], known: ReadonlySet<string>): { id: string; from: number; to: number }[] {
  const live = elements
    .map((e, at) => ({ e, at, n: e.customData?.pnStep, fresh: known.has(e.id) ? 0 : 1 }))
    .filter((m): m is { e: Element; at: number; n: number; fresh: number } => !m.e.isDeleted && typeof m.n === 'number' && Number.isInteger(m.n))
    .sort((a, b) => a.fresh - b.fresh || a.n - b.n || a.at - b.at);
  return live.flatMap((m, i) => (m.n === i + 1 ? [] : [{ id: m.e.id, from: m.n, to: i + 1 }]));
}

/** The ids of the markers on the canvas, deleted ones too. */
export function stepIds(elements: readonly Element[]): string[] {
  return elements.filter((e) => typeof e.customData?.pnStep === 'number').map((e) => e.id);
}

/** How many markers are on the canvas: the canvas renumbers only when this
 *  changes, so a drawing saved with a gap is not changed by opening it. */
export function stepCount(elements: readonly Marked[]): number {
  let count = 0;
  for (const e of elements) {
    const n = e.customData?.pnStep;
    if (!e.isDeleted && typeof n === 'number' && Number.isInteger(n)) count++;
  }
  return count;
}

/** The label's new text and box, centred where the old one was. A label
 *  the person typed over (not the old number) keeps its text. */
export function relabel(text: { text: string; x: number; width: number }, from: number, to: number) {
  if (text.text !== String(from)) return null;
  const label = String(to);
  const width = (text.width * label.length) / text.text.length;
  return { text: label, originalText: label, width, x: text.x + (text.width - width) / 2 };
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
