/**
 * The words and the date engine quick add reads with, for the language the
 * app shows. Ninja's `+` line and the Ninja box's note mode read the same way.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (step 8)
 */
import i18n, { activeLocale } from './i18n';
import { intlLocale } from './languages';
import { formatDay } from './intlFormat';
import { engineWords, readWords, type EngineWords, type QuickAddWords } from './quickAdd';

export function quickAddContext(): { words: QuickAddWords; engine: EngineWords } {
  const locale = intlLocale();
  const sample = formatDay('2026-10-06', 'numeric');
  const order: 'dmy' | 'mdy' | 'ymd' = /^2026/.test(sample) ? 'ymd' : sample.indexOf('6') < sample.indexOf('10') ? 'dmy' : 'mdy';
  const bundle = (lng: string) => (i18n.getResourceBundle(lng, 'quickAdd') as { words?: Record<string, string> } | undefined)?.words;
  return { words: readWords(bundle(activeLocale()), bundle('en') ?? {}), engine: engineWords(locale, order) };
}
