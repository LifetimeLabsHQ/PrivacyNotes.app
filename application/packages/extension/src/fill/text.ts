/**
 * One way to compare a word of the list with the text of a field. Both go
 * through the same three steps, so `user-name`, `user_name`, `User Name` and
 * `userName` are all the word `username`, and `Contraseña` is `contrasena`.
 * Spec: docs/internal/plans/click-to-fill-words.md (section 1)
 */
import type { Words } from './words';

/** A text, ready to be asked for a word. */
export interface Prepared {
  /** Folded, with every character that is not a letter or a digit removed. */
  squashed: string;
  /** Folded whole words, in their order. */
  tokens: string[];
}

/** A list of the words file, ready to be looked for. */
export interface WordList {
  sub: string[];
  tok: string[][];
}

const LETTERS: Record<string, string> = { ß: 'ss', ł: 'l', ø: 'o', đ: 'd', ı: 'i', æ: 'ae', œ: 'oe', ς: 'σ' };

/** Lower case, no accents, the few letters NFKD leaves alone mapped by hand. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[ßłøđıæœς]/g, (c) => LETTERS[c] ?? c);
}

const squash = (folded: string): string => folded.replace(/[^\p{L}\p{N}]+/gu, '');

/** camelCase and letter-digit borders become word borders, before the fold
 *  takes the capitals away. */
function tokensOf(text: string): string[] {
  const split = text
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2');
  return fold(split).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export const EMPTY: Prepared = { squashed: '', tokens: [] };

export function prepare(text: string): Prepared {
  if (!text) return EMPTY;
  return { squashed: squash(fold(text)), tokens: tokensOf(text) };
}

/** The words of one list, each squashed word once. More lists can be added
 *  as plain arrays of `sub` words. */
export function compile(words: Words, ...more: readonly string[][]): WordList {
  const sub = new Set<string>();
  for (const w of [...words.sub, ...more.flat()]) {
    const s = squash(fold(w));
    if (s) sub.add(s);
  }
  const seen = new Set<string>();
  const tok: string[][] = [];
  for (const w of words.tok) {
    const run = tokensOf(w);
    const key = run.join(' ');
    if (run.length && !seen.has(key)) {
      seen.add(key);
      tok.push(run);
    }
  }
  return { sub: [...sub], tok };
}

function hasRun(tokens: readonly string[], run: readonly string[]): boolean {
  const first = run[0];
  if (first === undefined) return false;
  for (let i = tokens.indexOf(first); i !== -1; i = tokens.indexOf(first, i + 1)) {
    if (run.every((t, k) => tokens[i + k] === t)) return true;
  }
  return false;
}

/** Does the text hold a word of the list? */
export function has(text: Prepared, list: WordList): boolean {
  if (!text.squashed) return false;
  return list.sub.some((w) => text.squashed.includes(w)) || list.tok.some((run) => hasRun(text.tokens, run));
}

/** The text with some words taken out of it first (`research` holds `search`). */
export function without(text: Prepared, words: readonly string[]): Prepared {
  let squashed = text.squashed;
  for (const w of words) squashed = squashed.split(squash(fold(w))).join('');
  return { squashed, tokens: text.tokens };
}
