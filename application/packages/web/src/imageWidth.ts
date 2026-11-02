/**
 * A picture's width is a whole percent of the text column, stored in the
 * markdown suffix `![](src){width=N}`. The size bar's presets are four of
 * these values; the percent field and the corner handle set any other.
 * Spec: docs/internal/design/patterns/151-160.md section 160
 */
export const IMAGE_WIDTH_MIN = 10;
export const IMAGE_WIDTH_MAX = 100;

/**
 * Round a width to a whole percent and clamp it to the range, or null when
 * it is not a number. Every reader of a stored or typed width goes through
 * here, so no path keeps a value the bar cannot show.
 */
export function clampImageWidth(raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  return Math.min(IMAGE_WIDTH_MAX, Math.max(IMAGE_WIDTH_MIN, Math.round(raw)));
}
