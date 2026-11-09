/**
 * An icon or a logo inside the text of a note, from the same catalog the look
 * picker offers (Insert > Icons & logos).
 *
 * Stored as `:icon[heart]` or `:logo[github]`, the inline form of the
 * generic directive syntax that remark-directive and other Markdown tools
 * read: short and readable in any app. Inside the app the id is the one the
 * folder and tag looks store (`heart`, `logo:github`). The name alphabet has
 * no character Markdown escapes, so the stored text is exactly what the parse
 * rule reads back. The icon draws in the text's color at the text's size.
 * Spec: docs/internal/specs/folder-tag-icons.md (section 3.7)
 */
import { mergeAttributes, Node, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { Shapes } from './icons';
import { atomDeleteKeys } from './editorAtomKeys';
import { PathGlyph } from './looks/LookGlyph';
import { useLookPaths } from './looks/lookIconsLoader';
import { INLINE_ICON_ID, inlineIconId, inlineIconMarkdown } from './editorIconSyntax';

/** Minimal typing for the markdown-it inline state the rule touches. */
interface IconParseState {
  src: string;
  pos: number;
  posMax: number;
  push: (type: string, tag: string, nesting: number) => { content: string };
}

const STORED = /^:(icon|logo)\[([a-z0-9][a-z0-9-]*)\]/;

/** `:icon[name]` or `:logo[name]` -> the span parseHTML reads, right after a
 *  word too: an icon inserted after a letter is stored that way. The same
 *  letters typed as text are stored as `:icon\[...]`, because the serializer
 *  escapes a typed `[`, so they stay text. */
function inlineIconRule(state: IconParseState, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3a) return false;
  const m = STORED.exec(state.src.slice(state.pos, Math.min(state.posMax, state.pos + 80)));
  if (!m) return false;
  if (!silent) state.push('html_inline', '', 0).content = `<span data-pn-inline-icon="${inlineIconId(m[1]!, m[2]!)}"></span>`;
  state.pos += m[0].length;
  return true;
}

function InlineIconView({ node }: ReactNodeViewProps) {
  const id = String(node.attrs.id ?? '');
  const paths = useLookPaths(id);
  // Inline in the line: the base styles make every svg a block.
  const style = { display: 'inline-block', width: '1.1em', height: '1.1em', verticalAlign: '-0.18em' };
  return (
    <NodeViewWrapper as="span" className="pn-inline-icon" data-pn-inline-icon={id}>
      {paths ? (
        <PathGlyph paths={paths} style={style} />
      ) : (
        <Shapes style={style} className="text-pn-muted" aria-hidden="true" />
      )}
    </NodeViewWrapper>
  );
}

export const InlineIcon = Node.create({
  name: 'inlineIcon',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { id: { default: '' } };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-pn-inline-icon]',
        getAttrs: (el) => {
          const id = (el as HTMLElement).getAttribute('data-pn-inline-icon') ?? '';
          return INLINE_ICON_ID.test(id) ? { id } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const { id, ...rest } = HTMLAttributes;
    return ['span', mergeAttributes(rest, { 'data-pn-inline-icon': id })];
  },

  renderText({ node }) {
    return inlineIconMarkdown(String(node.attrs.id));
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineIconView as never);
  },

  addKeyboardShortcuts() {
    return atomDeleteKeys(this.editor, this.type);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: { id?: string } }) {
          state.write(inlineIconMarkdown(node.attrs.id ?? ''));
        },
        parse: {
          setup(md: { inline: { ruler: { push: (name: string, fn: typeof inlineIconRule) => void } } }) {
            md.inline.ruler.push('pnInlineIcon', inlineIconRule);
          },
        },
      },
    };
  },
});

/** Put an icon at the caret with the marks a typed letter there would take
 *  (a text color, bold), so it matches the words around it. */
export function insertInlineIcon(editor: Editor, id: string): void {
  const { storedMarks, selection } = editor.state;
  const marks = (storedMarks ?? selection.$from.marks()).map((m) => m.toJSON());
  editor.chain().focus().insertContent({ type: 'inlineIcon', attrs: { id }, marks }).run();
}
