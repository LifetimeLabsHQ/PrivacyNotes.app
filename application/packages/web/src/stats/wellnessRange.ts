import type { RangeId } from '../wellnessTypes';

/** The range presets of Statistics > Trackers and its export tab. */
export const RANGE_IDS: RangeId[] = ['7d', '14d', '30d', '3mo', '6mo', '12mo', 'all'];
// Per-device view preference, like the Writing tab's range; not synced.
// Under the app's prefix, so "Delete local data" takes it with every other
// app key (beta.privacynotes.app #214 item 3); the old name is still read.
const RANGE_KEY = 'privacynotes.wellnessRange';
const OLD_RANGE_KEY = 'pn-wellness-range';

/** The range last picked on this device, or null on a first open. */
export function savedWellnessRange(): RangeId | null {
  try {
    const saved = localStorage.getItem(RANGE_KEY) ?? localStorage.getItem(OLD_RANGE_KEY);
    if (saved && RANGE_IDS.includes(saved as RangeId)) return saved as RangeId;
  } catch { /* localStorage unavailable */ }
  return null;
}

export function readWellnessRange(): RangeId {
  return savedWellnessRange() ?? 'all';
}

export function writeWellnessRange(id: RangeId): void {
  try {
    localStorage.setItem(RANGE_KEY, id);
    localStorage.removeItem(OLD_RANGE_KEY);
  } catch { /* ignore */ }
}
