/**
 * The tone of one logged value against the person's own days: green when
 * better than usual, amber when a little worse, red when clearly worse,
 * neutral where the tracker has no direction. `dayTone` in
 * `stats/statsParts.tsx` decides the tone; this file only names the looks, so
 * the list row (on the boot path) and Statistics (loaded on demand) paint a
 * tone the same way.
 * Spec: docs/internal/specs/wellness-statistics.md (section 22), docs/internal/specs/tracker-focus-771.md (D6)
 */
export const PILL_TONE = {
  good: 'bg-success/10 text-success',
  bad: 'bg-danger/10 text-danger',
  warn: 'bg-warning/10 text-warning',
  neutral: 'bg-surface-0 text-pn-soft',
} as const;
export type PillTone = keyof typeof PILL_TONE;

/** The same tones as a paint, for a dot or a strip; neutral takes the tracker's own color. */
export function tonePaint(tone: PillTone, trackerColor: string): string {
  return tone === 'good' ? 'var(--color-success)' : tone === 'bad' ? 'var(--color-danger)' : tone === 'warn' ? 'var(--color-warning)' : trackerColor;
}
