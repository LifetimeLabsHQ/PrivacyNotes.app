/**
 * Which way a block of the user's own text reads, decided by the text and
 * not by the app language. A list, a quote, a callout or the footnotes take
 * the direction of their first letter, the rule `dir="auto"` and
 * `unicode-bidi: plaintext` use (UAX #9, rules P2 and P3), so a Persian list
 * in an English app puts its bullets, numbers and checkboxes on the right
 * (GitHub #725). The editor (editorDirection.ts) and the export renderer
 * (markdownRender.ts) both ask here, so a note reads the same in both.
 * Spec: docs/internal/design/patterns/061-070.md (section 67)
 */
export type TextDirection = 'rtl' | 'ltr';

const LETTER = /\p{L}/u;

// The scripts whose letters are strong right-to-left (bidi class R or AL).
const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;

export const ARABIC_LETTER = /\p{Script=Arabic}/u;

// Letters and digits that Persian writes and Arabic does not: pe, che, zhe,
// gaf, the Persian kaf and yeh, and the Persian digits. Arabic text uses its
// own kaf and yeh (U+0643, U+064A), so a note that holds any of these is
// written in Persian or a language that counts the same way (Urdu, Kurdish).
const PERSIAN_MARK = /[پچژکگی۰-۹]/;

// Arabic's own teh marbuta, kaf and yeh, which Persian writes otherwise.
const ARABIC_MARK = /[ةكي]/;

/** The first letter in the text, or null when it holds none (digits, symbols, emoji). */
export function firstLetter(text: string): string | null {
  return LETTER.exec(text)?.[0] ?? null;
}

/** The direction a letter reads in. */
export function letterDirection(letter: string): TextDirection {
  return RTL_LETTER.test(letter) ? 'rtl' : 'ltr';
}

/** The direction of the text's first letter, or null when it has none. */
export function textDirection(text: string): TextDirection | null {
  const letter = firstLetter(text);
  return letter ? letterDirection(letter) : null;
}

/** True when the text holds a letter or digit that only Persian-family writing uses. */
export function writesPersian(text: string): boolean {
  return PERSIAN_MARK.test(text);
}

/**
 * The digits a numbered list counts in: Persian digits for a list in Arabic
 * script that writes Persian, else null (the ordinary 1, 2, 3). Arabic and
 * Hebrew lists keep 1, 2, 3, the same Western digits the app shows in Arabic
 * (`intlLocale` in languages.tsx). The list's own letters decide first; a
 * list whose letters Persian and Arabic share ("مثال اول") goes by the note.
 * `listText` and `notePersian` are functions so a caller reads the text only
 * when the list is in Arabic script.
 */
export function listNumerals(
  letter: string | null,
  listText: () => string,
  notePersian: () => boolean,
): 'persian' | null {
  if (!letter || !ARABIC_LETTER.test(letter)) return null;
  const text = listText();
  if (PERSIAN_MARK.test(text)) return 'persian';
  if (ARABIC_MARK.test(text)) return null;
  return notePersian() ? 'persian' : null;
}
