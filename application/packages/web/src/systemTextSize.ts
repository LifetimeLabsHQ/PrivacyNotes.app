/**
 * The iPhone's own text size (Dynamic Type) on iOS.
 *
 * Android needs nothing: its webview applies the system font size as text
 * zoom. The iOS webview does not, except to one font keyword,
 * `-apple-system-body`, which WebKit sizes from the system setting and
 * re-sizes live when the setting changes. A hidden probe in that font gives
 * the size, and the size over its default (17px at the Large setting) is the
 * factor, `--pn-system-text`. Every text role in typeScale.css multiplies by
 * it, and so does the editor's `--pn-text-scale`, so app and note text grow
 * while buttons, rows and icons keep their size, as on Android. The in-app
 * Text size and App size stay on top of it.
 *
 * Spec: docs/internal/design-decisions.md (system text size on iOS)
 */

/** `-apple-system-body` at the default (Large) setting. */
const DEFAULT_BODY_PX = 17;
/** The largest factor, Android's largest font size.
 *  Spec: docs/internal/design-decisions.md (system text size on iOS) */
const MAX_SYSTEM_TEXT = 2;

export function initSystemTextSize(): void {
  if (__PN_BUILD_PLATFORM__ !== 'ios') return;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.textContent = 'M';
  probe.style.cssText = 'font:-apple-system-body;position:fixed;top:0;left:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const apply = () => {
    const px = parseFloat(getComputedStyle(probe).fontSize);
    if (!(px > 0)) return;
    const factor = Math.min(MAX_SYSTEM_TEXT, px / DEFAULT_BODY_PX);
    document.documentElement.style.setProperty('--pn-system-text', factor.toFixed(3));
  };
  apply();
  // The probe's box changes size with its font, which is the one signal a
  // live change of the system setting gives the page.
  new ResizeObserver(apply).observe(probe);
}
