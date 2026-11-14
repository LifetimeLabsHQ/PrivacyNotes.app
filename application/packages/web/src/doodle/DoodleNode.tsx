/**
 * The doodle block (issue #736): a ```doodle fence (doodleFormat.ts) that
 * the editor draws as a board (DoodleView.tsx). Built like the map block
 * (PlaceMapNode.tsx): a parse rule above the code block's own, and a fence
 * the parse cannot read stays a code block, so nothing is lost.
 */
import { lazy, Suspense } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { BOARD_HEIGHT_DEFAULT, DOODLE_FENCE, looksLikeDoodle } from './doodleFence';

/** `text` is the fence's one line, kept as it is: the board reads it
 *  (doodleFormat.ts) when it loads, so the editor needs no stroke code. */
type DoodleAttrs = { text: string; height: number | null };

/** The fence line's height, a whole number of board units, or null. */
function readHeight(raw: string | undefined): number | null {
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 99999 && n !== BOARD_HEIGHT_DEFAULT ? n : null;
}

// The board and the stroke engine load with the first doodle a note shows,
// not with the editor: they stay off the boot path.
const DoodleView = lazy(() => import('./DoodleView').then((m) => ({ default: m.DoodleView })));

function DoodleViewLoader(props: NodeViewProps) {
  return (
    <Suspense fallback={<NodeViewWrapper className="pn-doodle my-6" />}>
      <DoodleView {...props} />
    </Suspense>
  );
}

/** Whether the last press in a doodle block began on its board or tools. */
let pressInDoodle = false;

export const DoodleNode = Node.create({
  name: 'doodle',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      text: { default: '' },
      // Null is the default height, BOARD_HEIGHT_DEFAULT.
      height: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'pre',
        priority: 60,
        getAttrs(dom) {
          const code = (dom as HTMLElement).querySelector('code');
          if (!code || !code.classList.contains(`language-${DOODLE_FENCE}`)) return false;
          const text = (code.textContent ?? '').trim();
          if (!looksLikeDoodle(text)) return false;
          return { text, height: readHeight((dom as HTMLElement).dataset['height']) };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as DoodleAttrs;
    const size = attrs.height ? { 'data-height': String(attrs.height) } : {};
    return ['pre', mergeAttributes(HTMLAttributes, size), ['code', { class: `language-${DOODLE_FENCE}` }, attrs.text]];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DoodleViewLoader as never, {
      // The board and the tools keep their presses, strokes and pinches: the
      // editor never sees them, so it neither selects nor drags the block
      // from there. A block dragged over the board can still drop.
      stopEvent: ({ event }) => {
        const target = event.target as Element | null;
        const inside = Boolean(target?.closest?.('[data-doodle-surface]'));
        if (event.type === 'mousedown' || event.type === 'touchstart') pressInDoodle = inside;
        if (event.type === 'dragstart' && (inside || pressInDoodle)) {
          event.preventDefault();
          return true;
        }
        if (/^(dragover|dragenter|dragleave|drop)$/.test(event.type)) return false;
        return inside;
      },
    });
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write: (s: string) => void; text: (s: string, escape?: boolean) => void; ensureNewLine: () => void; closeBlock: (n: unknown) => void },
          node: { attrs: DoodleAttrs },
        ) {
          if (!node.attrs.text) return;
          const size = node.attrs.height ? ` height=${node.attrs.height}` : '';
          // As the code block writes itself: `text` puts the container's
          // prefix (a list's indent, a callout's `> `) before the line, which
          // one `write` of the whole block would not. The text is one line of
          // JSON with no backticks, so the closing fence is this one.
          state.write(`\`\`\`${DOODLE_FENCE}${size}\n`);
          state.text(node.attrs.text.replace(/\n/g, ' '), false);
          state.ensureNewLine();
          state.write('```');
          state.closeBlock(node);
        },
        parse: {
          // The fence comes in through markdown-it as `pre > code.language-doodle`,
          // which parseHTML above turns into this node.
        },
      },
    };
  },
});
