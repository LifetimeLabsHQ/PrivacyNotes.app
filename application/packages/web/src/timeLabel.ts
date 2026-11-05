import { parseTimeText } from './schedule';
import { latinTimeText, latinTimeTextWith, type DatePrefs } from './intlFormat';

/**
 * A time a person typed into a time field, as "HH:MM", or null: the Latin
 * forms directly, else the field's own display in the app language
 * ("오후 3:00", "下午3:30", "3:30 م") through `latinTimeTextWith`. Kept out
 * of intlFormat.ts, which is on the boot path, because schedule.ts is not.
 */
export function parseTimeLabelWith(prefs: DatePrefs, text: string): string | null {
  return parseTimeText(text) ?? parseTimeText(latinTimeTextWith(prefs, text));
}

/** `parseTimeLabelWith` under the synced date settings. */
export function parseTimeLabel(text: string): string | null {
  return parseTimeText(text) ?? parseTimeText(latinTimeText(text));
}
