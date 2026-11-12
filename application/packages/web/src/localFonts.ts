/**
 * Which fonts this device has, for the suggestions under the Note font row
 * (GitHub #716). Nothing here leaves the device: the names only fill the
 * picker and paint the reader's own notes.
 *
 * Two sources. Every browser gets the short list below, kept to the names
 * that measure as installed. Chrome and Edge can also list every installed
 * family through `queryLocalFonts`, which asks the reader for permission
 * first, so it runs only when they press the button that asks for it.
 * Safari, Firefox and the Mac app have no such call; there the short list
 * and a typed name are the way in. Safari also hides fonts the reader
 * installed, so a name it measures as missing is one it would not draw.
 * Spec: theme.ts (custom note fonts)
 */
import type { NoteFont } from './theme';

/** Well-known families per note font, across macOS, Windows and Linux. */
const CANDIDATES: Record<NoteFont, string[]> = {
  sans: ['Arial', 'Avenir', 'Avenir Next', 'Calibri', 'Cantarell', 'DejaVu Sans', 'Futura', 'Gill Sans', 'Helvetica', 'Helvetica Neue', 'IBM Plex Sans', 'Inter', 'Lato', 'Noto Sans', 'Open Sans', 'Optima', 'Roboto', 'Segoe UI', 'Source Sans 3', 'Tahoma', 'Trebuchet MS', 'Ubuntu', 'Verdana'],
  serif: ['Baskerville', 'Book Antiqua', 'Cambria', 'Charter', 'Constantia', 'DejaVu Serif', 'Didot', 'EB Garamond', 'Garamond', 'Georgia', 'Hoefler Text', 'IBM Plex Serif', 'Iowan Old Style', 'Literata', 'Merriweather', 'Noto Serif', 'Palatino', 'Source Serif 4', 'Times New Roman'],
  mono: ['Andale Mono', 'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Courier New', 'DejaVu Sans Mono', 'Fira Code', 'Fira Mono', 'Hack', 'IBM Plex Mono', 'Inconsolata', 'Iosevka', 'JetBrains Mono', 'Lucida Console', 'Menlo', 'Monaco', 'Roboto Mono', 'SF Mono', 'Source Code Pro', 'Ubuntu Mono', 'Victor Mono'],
};

/** Wide and narrow letters and digits, so two fonts rarely measure alike. */
const SAMPLE = 'mmmmmmmmmmlli10OQW@';
const BASES = ['monospace', 'serif', 'sans-serif'] as const;

let ctx: CanvasRenderingContext2D | null | undefined;
function measure(family: string): number {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return 0;
  ctx.font = `32px ${family}`;
  return ctx.measureText(SAMPLE).width;
}

/**
 * Whether the browser draws this family. A missing family falls through to
 * the generic behind it, so the width matches that generic; an installed one
 * differs from at least one of the three, even when it IS one of them (Menlo
 * is the Mac's monospace, but it is not its serif).
 */
export function fontInstalled(name: string): boolean {
  if (!name) return false;
  return BASES.some((base) => measure(`"${name}", ${base}`) !== measure(base));
}

const installed = new Map<NoteFont, string[]>();

/** The short list for one note font, kept to what this device draws. */
export function installedCandidates(font: NoteFont): string[] {
  let list = installed.get(font);
  if (!list) {
    list = CANDIDATES[font].filter(fontInstalled);
    installed.set(font, list);
  }
  return list;
}

type LocalFontData = { family: string };
type FontWindow = Window & { queryLocalFonts?: () => Promise<LocalFontData[]> };

/** Whether this browser can list every installed font (Chrome and Edge). */
export function canListAllFonts(): boolean {
  return typeof window !== 'undefined' && typeof (window as FontWindow).queryLocalFonts === 'function';
}

/** Every installed family, sorted, or an empty list when the reader says no. */
export async function allLocalFonts(): Promise<string[]> {
  try {
    const fonts = (await (window as FontWindow).queryLocalFonts?.()) ?? [];
    return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
