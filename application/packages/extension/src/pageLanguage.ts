/**
 * An extension page takes the language its strings came in, and that
 * language's direction, as the app does (web/src/i18n.ts). It reads the
 * language i18next resolved, not the browser's: a browser in a language with
 * no catalog shows the English fallback and stays left to right. The
 * background's worker has no page.
 */
import type { i18n as I18n } from 'i18next';

export function setPageLanguage(i18n: I18n): void {
  if (typeof document === 'undefined') return;
  const lng = i18n.resolvedLanguage ?? 'en';
  document.documentElement.lang = lng;
  document.documentElement.dir = i18n.dir(lng);
}
