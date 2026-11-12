/**
 * Password and passphrase generation, and the strength each carries.
 *
 * Pure functions over `crypto.getRandomValues`, so the vault form and the
 * tests share one implementation. Every number here is exact for the
 * construction below rather than an estimate: the bits shown in the
 * generator are the log of how many distinct outputs the same settings can
 * produce, each equally likely.
 * Spec: docs/internal/design/ui-patterns.md (the password generator)
 */

/**
 * Ambiguous characters (0, O, o, l, 1, I) are left out of every set, and the
 * symbols are the ones that survive most sites' rules: no brackets, pipes,
 * quotes, semicolons or angle brackets, which trip a WAF or a regex.
 */
export const CHAR_SETS = {
  lowercase: 'abcdefghjkmnpqrstuvwxyz',
  uppercase: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*-_+=?~',
} as const;

export const PASSWORD_LENGTH = { min: 8, max: 64 } as const;
export const PASSPHRASE_WORDS = { min: 3, max: 20 } as const;
/** The most digits, and the most symbols, a password is asked to carry. */
export const EXACT_COUNT_MAX = 9;

export const SEPARATORS = ['-', '.', '_', ' '] as const;
type Separator = (typeof SEPARATORS)[number];

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  /** Exact counts; 0 leaves the class out. */
  digits: number;
  symbols: number;
}

export interface PassphraseOptions {
  words: number;
  separator: Separator;
  /** One word, chosen at random, starts with a capital. */
  capitalize: boolean;
  /** One word, chosen at random, ends in a digit. */
  number: boolean;
  /** One word, chosen at random, ends in a symbol. */
  symbol: boolean;
}

/**
 * A uniform integer in [0, n). Rejection rather than a modulo: 2^32 is not
 * a multiple of most set sizes, and the remainder favours the low end of
 * the set by a hair on every draw.
 */
export function randomIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    if (draw[0]! < limit) return draw[0]! % n;
  }
}

function pick(chars: string): string {
  return chars.charAt(randomIndex(chars.length));
}

function shuffle(arr: string[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

/** The letters that fill what the exact counts leave; lowercase when both sets are off. */
function letterPool(o: { lowercase: boolean; uppercase: boolean }): string {
  const pool = (o.lowercase ? CHAR_SETS.lowercase : '') + (o.uppercase ? CHAR_SETS.uppercase : '');
  return pool || CHAR_SETS.lowercase;
}

/**
 * Exactly `digits` digits and `symbols` symbols, letters for the rest, all
 * shuffled. The exact counts win over the length: a password asked for more
 * of them than it has room for grows to hold them.
 */
export function generatePassword(o: PasswordOptions): string {
  const out: string[] = [];
  for (let i = 0; i < o.digits; i++) out.push(pick(CHAR_SETS.digits));
  for (let i = 0; i < o.symbols; i++) out.push(pick(CHAR_SETS.symbols));
  const pool = letterPool(o);
  const fill = Math.max(0, o.length - out.length);
  for (let i = 0; i < fill; i++) out.push(pick(pool));
  shuffle(out);
  return out.join('');
}

/**
 * Words drawn with replacement, then the options applied one word each:
 * the capital, the digit and the symbol each land on a word chosen at
 * random, and two of them may land on the same word. The digit and the
 * symbol come from the same sets the password uses.
 */
export function generatePassphrase(o: PassphraseOptions, list: readonly string[]): string {
  const words: string[] = [];
  for (let i = 0; i < o.words; i++) words.push(list[randomIndex(list.length)]!);
  if (o.capitalize) {
    const i = randomIndex(words.length);
    words[i] = words[i]!.charAt(0).toUpperCase() + words[i]!.slice(1);
  }
  if (o.number) words[randomIndex(words.length)] += pick(CHAR_SETS.digits);
  if (o.symbol) words[randomIndex(words.length)] += pick(CHAR_SETS.symbols);
  return words.join(o.separator);
}

function log2Factorial(n: number): number {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log2(i);
  return sum;
}

/**
 * log2 of the distinct passwords the options can produce. The three
 * alphabets are disjoint, so a password fixes which positions hold digits,
 * symbols and letters: the count is the ways to place them times the
 * choices in each slot, and the shuffle makes every one equally likely.
 */
export function passwordBits(o: PasswordOptions): number {
  const d = o.digits;
  const s = o.symbols;
  const n = Math.max(o.length, d + s);
  const l = n - d - s;
  const placements = log2Factorial(n) - log2Factorial(d) - log2Factorial(s) - log2Factorial(l);
  return (
    placements +
    l * Math.log2(letterPool(o).length) +
    d * Math.log2(CHAR_SETS.digits.length) +
    s * Math.log2(CHAR_SETS.symbols.length)
  );
}

/**
 * log2 of the distinct passphrases the options can produce from a list of
 * `listSize` lowercase words. Each option multiplies by its choice of word
 * and, for the digit and the symbol, by the character drawn.
 */
export function passphraseBits(o: PassphraseOptions, listSize: number): number {
  let bits = o.words * Math.log2(listSize);
  if (o.capitalize) bits += Math.log2(o.words);
  if (o.number) bits += Math.log2(o.words * CHAR_SETS.digits.length);
  if (o.symbol) bits += Math.log2(o.words * CHAR_SETS.symbols.length);
  return bits;
}

export type Strength = 'weak' | 'fair' | 'strong' | 'veryStrong';

/**
 * Four tiers, one per segment of the meter, read against an offline attack
 * at ten billion guesses a second, the pessimistic case for a leaked fast
 * hash: under 40 bits falls in minutes, 40 to 59 in hours to days, 60 and
 * up takes years, 90 and up outlasts everything. No online attack reaches
 * the second tier, so a vault login is strong from 60.
 */
export function strengthOf(bits: number): Strength {
  if (bits < 40) return 'weak';
  if (bits < 60) return 'fair';
  if (bits < 90) return 'strong';
  return 'veryStrong';
}

/** The generator's remembered options, in the synced settings and in the
 *  browser extension's own storage. */
export interface PwGen {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  numbers: boolean;
  symbols: boolean;
  exactNumbers: number;
  exactSymbols: number;
  mode: 'password' | 'passphrase';
  words: number;
  separator: (typeof SEPARATORS)[number];
  capitalize: boolean;
  addNumber: boolean;
  addSymbol: boolean;
}

export function defaultPwGen(): PwGen {
  return {
    length: 20,
    lowercase: true,
    uppercase: true,
    numbers: true,
    symbols: true,
    exactNumbers: 1,
    exactSymbols: 1,
    mode: 'password',
    words: 5,
    separator: '-',
    capitalize: true,
    addNumber: true,
    addSymbol: false,
  };
}

/** Stored options from an untrusted blob: each field that holds, the default for the rest. */
export function readPwGen(value: unknown): PwGen {
  const out = defaultPwGen();
  if (!value || typeof value !== 'object') return out;
  const pg = value as Partial<PwGen>;
  if (typeof pg.length === 'number' && pg.length >= PASSWORD_LENGTH.min && pg.length <= PASSWORD_LENGTH.max) out.length = pg.length;
  if (typeof pg.lowercase === 'boolean') out.lowercase = pg.lowercase;
  if (typeof pg.uppercase === 'boolean') out.uppercase = pg.uppercase;
  if (typeof pg.numbers === 'boolean') out.numbers = pg.numbers;
  if (typeof pg.symbols === 'boolean') out.symbols = pg.symbols;
  if (typeof pg.exactNumbers === 'number' && pg.exactNumbers >= 0 && pg.exactNumbers <= EXACT_COUNT_MAX) out.exactNumbers = pg.exactNumbers;
  if (typeof pg.exactSymbols === 'number' && pg.exactSymbols >= 0 && pg.exactSymbols <= EXACT_COUNT_MAX) out.exactSymbols = pg.exactSymbols;
  if (pg.mode === 'password' || pg.mode === 'passphrase') out.mode = pg.mode;
  if (typeof pg.words === 'number' && Number.isInteger(pg.words) && pg.words >= PASSPHRASE_WORDS.min && pg.words <= PASSPHRASE_WORDS.max) out.words = pg.words;
  if (SEPARATORS.includes(pg.separator as PwGen['separator'])) out.separator = pg.separator as PwGen['separator'];
  if (typeof pg.capitalize === 'boolean') out.capitalize = pg.capitalize;
  if (typeof pg.addNumber === 'boolean') out.addNumber = pg.addNumber;
  if (typeof pg.addSymbol === 'boolean') out.addSymbol = pg.addSymbol;
  return out;
}

/** The password options a remembered setting means. */
export function passwordOptions(g: PwGen): PasswordOptions {
  return {
    length: g.length,
    lowercase: g.lowercase,
    uppercase: g.uppercase,
    digits: g.numbers ? g.exactNumbers : 0,
    symbols: g.symbols ? g.exactSymbols : 0,
  };
}

/** The passphrase options a remembered setting means. */
export function passphraseOptions(g: PwGen): PassphraseOptions {
  return { words: g.words, separator: g.separator, capitalize: g.capitalize, number: g.addNumber, symbol: g.addSymbol };
}

/** A new value from the remembered settings: the generator panel's, and the
 *  browser extension's Generate password key. The word list is a parameter,
 *  so a caller that only makes passwords does not load it. */
export function generateFrom(g: PwGen, words: readonly string[]): string {
  return g.mode === 'passphrase' ? generatePassphrase(passphraseOptions(g), words) : generatePassword(passwordOptions(g));
}
