/**
 * Typed text kept as text in a Markdown body: what an importer writes from
 * another app's plain text, and what a Ninja ">>" adds to a list. Small on
 * purpose, so the boot path can import it without an importer.
 */

/** Text the user typed, escaped so markdown shows it as the same characters. */
export function escapeMarkdownText(s: string): string {
  return s
    .replace(/[\\`*[\]<~$|]/g, '\\$&')
    .replace(/==/g, '=\\=')
    .replace(/&(?=#?\w+;)/g, '&amp;')
    // An underscore inside a word never starts emphasis; one at a word edge can.
    .replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (hit) => hit.replace('_', '\\_'));
}

/** Keep a line that merely LOOKS like markdown block syntax from becoming it. */
export function guardMarkdownLineStart(s: string): string {
  if (/^\d+[.)](\s|$)/.test(s)) return s.replace(/[.)]/, '\\$&');
  if (/^(#{1,6}(\s|$)|>|[-+](\s|$)|-{2,}\s*$)/.test(s)) return `\\${s}`;
  return s;
}
