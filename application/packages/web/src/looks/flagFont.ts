/**
 * Windows-only fallback font for country flag emojis.
 *
 * Windows omits country flag glyphs from Segoe UI Emoji and draws the regional
 * indicator pair as two letters (for example "US" or "CH"). macOS, iOS,
 * Android and Linux draw every flag natively (and the Linux AppImage carries
 * its own bitmap Noto Color Emoji, see packages/desktop/src-tauri/src/emoji_font.rs).
 *
 * Strictly gated to Windows so no other platform ever loads or touches the
 * font. The @font-face rule narrows `unicode-range` to regional indicators and
 * subdivision flag tags, so even on Windows the font only downloads when a
 * flag actually appears on screen, and every other character keeps its own
 * font.
 * Spec: docs/internal/specs/folder-tag-icons.md (section 3.8)
 */
import flagFontUrl from './TwemojiCountryFlags.woff2?url';

export const FLAG_FONT_FAMILY = 'PN Country Flags';
export const FLAG_FONT_RANGE =
  'U+1F1E6-1F1FF, U+1F3F4, U+E0062-E0063, U+E0065, U+E0067, U+E006C, U+E006E, U+E0073-E0074, U+E0077, U+E007F';

const EMOJI_PROBE_STACK =
  '"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji","Android Emoji",sans-serif';

let installed = false;

function isWindowsHost(): boolean {
  return typeof navigator !== 'undefined' && /\bWindows\b/i.test(navigator.userAgent);
}

/** True when the browser draws `ch` as a full-color glyph (white and black
 *  fill produce the same non-transparent pixel). Monochrome fallback letters
 *  change color with fillStyle, so they return false. */
function rendersColorGlyph(ch: string): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.textBaseline = 'top';
    ctx.font = `100px ${EMOJI_PROBE_STACK}`;
    ctx.scale(0.01, 0.01);
    const sample = (fill: string) => {
      ctx.clearRect(0, 0, 100, 100);
      ctx.fillStyle = fill;
      ctx.fillText(ch, 0, 0);
      return ctx.getImageData(0, 0, 1, 1).data.join(',');
    };
    const w = sample('#fff');
    const b = sample('#000');
    return w === b && !b.startsWith('0,0,0,');
  } catch {
    return false;
  }
}

/**
 * Registers the bundled flag-only WOFF2 font on Windows when the OS does not
 * draw country flags natively. Idempotent and a no-op on every other OS.
 */
export function installWindowsFlagFont(): boolean {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (!isWindowsHost()) return false;
  // Built via code points so no literal flag emoji appears in source (lint-house-rules).
  const swissFlag = String.fromCodePoint(0x1f1e8, 0x1f1ed);
  if (rendersColorGlyph(swissFlag)) return false;
  installed = true;
  const style = document.createElement('style');
  style.dataset.pnFlagFont = 'on';
  style.textContent = `@font-face { font-family: "${FLAG_FONT_FAMILY}"; unicode-range: ${FLAG_FONT_RANGE}; src: url("${flagFontUrl}") format("woff2"); font-display: swap; }`;
  document.head.appendChild(style);
  document.documentElement.dataset.pnFlagFont = 'on';
  return true;
}
