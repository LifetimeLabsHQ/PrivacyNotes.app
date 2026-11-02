import { Extension, InputRule } from '@tiptap/core';
import { TYPED_SYMBOLS, typedSymbolBlocked } from './typedSymbols';

/**
 * The note body half of typed symbols (#660), one input rule per pair in
 * typedSymbols.ts. TipTap runs no input rule in a code block or next to
 * inline code, and its Backspace takes the last rule back, so both come free.
 * Inline code still being typed has no mark until its closing backtick, so
 * the handler also skips an open backtick, a link and a web address (#12).
 * `enabled` is read at each keystroke, so the setting applies to an editor
 * that is already open; when it is off, the rule changes nothing and the
 * character is typed as it is.
 */
export const TypedSymbols = Extension.create<{ enabled: () => boolean }>({
  name: 'typedSymbols',
  addOptions() {
    return { enabled: () => false };
  },
  addInputRules() {
    return TYPED_SYMBOLS.map(([pair, symbol]) => new InputRule({
      // No character of a pair is special in a pattern.
      find: new RegExp(`${pair}$`),
      handler: ({ state, range }) => {
        if (!this.options.enabled()) return null;
        const $from = state.doc.resolve(range.from);
        const link = state.schema.marks['link'];
        if (link && (state.doc.rangeHasMark(range.from, range.to, link) || link.isInSet($from.marks()))) return null;
        if (typedSymbolBlocked(state.doc.textBetween($from.start(), range.from, undefined, '\ufffc'))) return null;
        state.tr.insertText(symbol, range.from, range.to);
      },
    }));
  },
});
