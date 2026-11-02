/**
 * Typed symbols (#660): a typed pair turns into its symbol, in the note body
 * and in the title field, when the "Turn typed symbols into arrows and math
 * signs" setting is on (`typedSymbols` in userSettingsShape.ts). The body uses
 * the TipTap input rules in editorTypedSymbols.ts; the title uses the two
 * helpers below. No imports, so the title field pulls in no editor code.
 */
export const TYPED_SYMBOLS: ReadonlyArray<readonly [pair: string, symbol: string]> = [
  ['->', '→'],
  ['<-', '←'],
  ['=>', '⇒'],
  ['!=', '≠'],
  ['>=', '≥'],
  ['<=', '≤'],
];

/**
 * True when the text before a pair is inside inline code still being typed
 * (an odd number of backticks: the closing one makes the mark) or inside a
 * web address in progress, where a symbol would break the code or the link.
 */
export function typedSymbolBlocked(before: string): boolean {
  return (before.split('`').length - 1) % 2 === 1 || /\bhttps?:\/\/\S*$/.test(before);
}

/** The last change the title field made, so Backspace can take it back. */
export interface TypedSymbolChange {
  /** Where the symbol sits in the value. */
  at: number;
  pair: string;
  /** The value right after the change. */
  value: string;
}

/**
 * Turns the pair that ends at `caret` into its symbol. Call it after a typed
 * character only, never after a paste. Returns null when no pair ends there.
 */
export function convertTypedSymbol(value: string, caret: number): { value: string; caret: number; change: TypedSymbolChange } | null {
  if (caret < 2) return null;
  const typed = value.slice(caret - 2, caret);
  const hit = TYPED_SYMBOLS.find(([pair]) => pair === typed);
  if (!hit || typedSymbolBlocked(value.slice(0, caret - 2))) return null;
  const next = value.slice(0, caret - 2) + hit[1] + value.slice(caret);
  return { value: next, caret: caret - 1, change: { at: caret - 2, pair: hit[0], value: next } };
}

/**
 * Backspace right after a change puts the typed pair back. Returns null when
 * the value moved on since the change or the caret is somewhere else.
 */
export function undoTypedSymbol(value: string, caret: number, change: TypedSymbolChange | null): { value: string; caret: number } | null {
  if (!change || value !== change.value || caret !== change.at + 1) return null;
  return { value: value.slice(0, change.at) + change.pair + value.slice(change.at + 1), caret: change.at + 2 };
}
