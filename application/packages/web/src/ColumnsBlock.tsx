/**
 * TipTap nodes and React node view for borderless side-by-side columns (#647).
 *
 * Stored as nested Obsidian callouts (`> [!columns]+` holding `> > [!col|33]+`),
 * parsed through Callout.tsx's markdown-it block rule so load, import, paste,
 * export, Markdown folder and older clients all preserve every word.
 *
 * Spec: docs/contrib/callouts.md (Columns)
 */

import { useCallback, useEffect, useRef } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { useTranslation } from 'react-i18next';
import { isBlank } from './kanban';
import {
  columnBorderOf,
  columnWeightsOf,
  columnsGridTemplate,
  columnsPlugin,
  commitColumnWeights,
  dispatchColumnEdit,
  dragColumnWeights,
  isColumnsBlock,
  isColumnsCol,
  parseColumnWidth,
  setColumnWidths,
} from './columns';
import { columnBorderGapCss, columnBorderHasTint, formatColumnBorder, parseColumnBorder } from './columnBorders';

/** CSS `inset-inline-start` of gap `border` (between col `border` and `border + 1`). */
function gapCenterCss(weights: readonly number[], border: number, gapCss: string): string {
  const n = weights.length;
  let before = 0;
  for (let i = 0; i <= border; i++) before += weights[i]!;
  if (gapCss === '0px') return `${before}%`;
  return `calc((100% - ${n - 1} * ${gapCss}) * ${before / 100} + ${border + 0.5} * ${gapCss})`;
}

/**
 * ArrowUp from the top line of a leading columns block (or ArrowLeft from the
 * very start of its first column) drops a gap cursor before the block so text
 * can be typed above it, matching escapeAboveCallout in Callout.tsx.
 */
function escapeAboveColumns(state: EditorState, view: EditorView, requireStart: boolean): boolean {
  const sel = state.selection;
  if (!sel.empty) return false;
  const { $from } = sel;
  if (requireStart ? $from.parentOffset !== 0 : !view.endOfTextblock('up')) return false;
  let blockDepth = -1;
  let colDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if (colDepth < 0 && isColumnsCol($from.node(d))) colDepth = d;
    if (isColumnsBlock($from.node(d))) {
      blockDepth = d;
      break;
    }
  }
  if (blockDepth < 1 || colDepth !== blockDepth + 1) return false;
  // Must be on the first block of the first column (or first block of any column for ArrowUp).
  if ($from.index(colDepth) !== 0) return false;
  if (requireStart && $from.index(blockDepth) !== 0) return false;
  // Only intercept when directly inside the column's first textblock (not nested in a list/callout).
  if ($from.depth !== colDepth + 1) return false;

  const before = $from.before(blockDepth);
  const nodeBefore = state.doc.resolve(before).nodeBefore;
  if (nodeBefore && nodeBefore.isTextblock) return false;

  const $pos = state.doc.resolve(before);
  const parent = $pos.parent;
  const deflt = parent.contentMatchAt($pos.index()).defaultType;
  const gapCursorOk =
    !parent.isTextblock &&
    parent.type.spec.allowGapCursor !== false &&
    !!deflt &&
    deflt.isTextblock;
  if (gapCursorOk) {
    view.dispatch(state.tr.setSelection(new GapCursor($pos)).scrollIntoView());
    return true;
  }
  const paragraph = state.schema.nodes.paragraph?.createAndFill();
  if (!paragraph) return false;
  const tr = state.tr.insert(before, paragraph);
  tr.setSelection(TextSelection.create(tr.doc, before + 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Third Enter on a blank last line of a column exits to a new paragraph below
 * the entire columns block, matching enterAtEndOfBox in Callout.tsx.
 */
function enterAtEndOfColumn(state: EditorState, view: EditorView): boolean {
  const { $from, empty } = state.selection;
  if (!empty || !isBlank($from.parent)) return false;
  const colDepth = $from.depth - 1;
  if (colDepth < 1) return false;
  const col = $from.node(colDepth);
  const block = $from.node(colDepth - 1);
  if (!isColumnsCol(col) || !isColumnsBlock(block)) return false;
  const index = $from.index(colDepth);
  if (index !== col.childCount - 1) return false;
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return false;
  const prev = index > 0 ? col.child(index - 1) : null;
  const lineStart = $from.before();
  const tr = state.tr;
  if (!prev || !isBlank(prev)) {
    tr.insert($from.after(), paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, $from.after() + 1));
  } else {
    const removeFrom = index - 1 > 0 ? lineStart - prev.nodeSize : lineStart;
    tr.delete(removeFrom, $from.end(colDepth));
    const after = tr.mapping.map($from.after(colDepth - 1));
    tr.insert(after, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/* ------------------------------------------------------------------ */
/* Node view                                                          */
/* ------------------------------------------------------------------ */

function ColumnsBlockView({ node, editor, getPos }: NodeViewProps) {
  const { t } = useTranslation('editor');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const weights = columnWeightsOf(node);
  const borderCfg = columnBorderOf(node);
  const borderAttr = formatColumnBorder(borderCfg);
  const gapCss = columnBorderGapCss(borderCfg.style);
  const count = weights.length;
  const editable = editor.isEditable;

  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  const startDrag = useCallback((border: number, e: React.PointerEvent<HTMLDivElement>) => {
    if (!editor.isEditable) return;
    // Mouse and pen only (touch scrolls/selects; preset bar handles mobile).
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    e.preventDefault();
    e.stopPropagation();

    const startWeights = columnWeightsOf(node);
    const activeGap = columnBorderGapCss(columnBorderOf(node).style);
    const startX = e.clientX;
    const rtl = getComputedStyle(wrap).direction === 'rtl';
    const rect = wrap.getBoundingClientRect();
    const totalPx = rect.width;
    if (totalPx <= 0) return;

    const handle = e.currentTarget;
    handle.classList.add('pn-columns-dragging');
    document.documentElement.classList.add('pn-col-resizing');

    const pill = document.createElement('span');
    pill.className = 'pn-columns-drag-pill';
    pill.textContent = `${startWeights[border]}% · ${startWeights[border + 1]}%`;
    handle.appendChild(pill);

    let live = startWeights.slice();
    let fine = e.altKey;

    const applyLive = (next: number[]) => {
      live = next;
      wrap.style.setProperty('--pn-cols-template', columnsGridTemplate(live));
      handle.style.insetInlineStart = gapCenterCss(live, border, activeGap);
      pill.textContent = `${live[border]}% · ${live[border + 1]}%`;
    };

    let lastClientX = startX;
    const onMove = (ev: PointerEvent) => {
      lastClientX = ev.clientX;
      fine = ev.altKey;
      const rawDelta = ((ev.clientX - startX) / totalPx) * 100;
      const delta = rtl ? -rawDelta : rawDelta;
      applyLive(dragColumnWeights(startWeights, border, delta, fine));
    };

    const cleanup = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
      handle.classList.remove('pn-columns-dragging');
      document.documentElement.classList.remove('pn-col-resizing');
      pill.remove();
      dragCleanupRef.current = null;

      if (!commit) {
        wrap.style.setProperty('--pn-cols-template', columnsGridTemplate(startWeights));
        handle.style.insetInlineStart = gapCenterCss(startWeights, border, activeGap);
        return;
      }
      const pos = getPos();
      if (typeof pos !== 'number' || !editor.isEditable) return;
      const committed = commitColumnWeights(live, fine);
      if (!dispatchColumnEdit(editor.view, (tr) => setColumnWidths(tr, pos, committed))) {
        // Restore visual styles to the exact committed template if drag ended unchanged.
        wrap.style.setProperty('--pn-cols-template', columnsGridTemplate(startWeights));
        handle.style.insetInlineStart = gapCenterCss(startWeights, border, activeGap);
      }
    };

    const onUp = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cleanup(false);
      } else if (ev.key === 'Alt') {
        fine = true;
        const rawDelta = ((lastClientX - startX) / totalPx) * 100;
        applyLive(dragColumnWeights(startWeights, border, rtl ? -rawDelta : rawDelta, true));
      }
    };

    dragCleanupRef.current = () => cleanup(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
  }, [editor, getPos, node]);

  const wrapperStyle: Record<string, string> = {
    '--pn-cols-template': columnsGridTemplate(weights),
    '--pn-cols-gap': gapCss,
  };
  if (borderCfg.style !== 'none') {
    wrapperStyle['--pn-col-bw'] = `${borderCfg.weight}px`;
    wrapperStyle['--pn-col-bs'] = borderCfg.line;
    wrapperStyle['--pn-col-bc'] = borderCfg.color
      ? `color-mix(in srgb, var(--pn-label-${borderCfg.color}-ink) 62%, transparent)`
      : 'rgb(var(--pn-text) / 0.24)';
    if (columnBorderHasTint(borderCfg)) {
      wrapperStyle['--pn-col-bg'] = borderCfg.color
        ? `var(--pn-label-${borderCfg.color}-tint)`
        : 'rgb(var(--pn-text) / 0.045)';
    }
  }

  return (
    <NodeViewWrapper
      ref={wrapRef}
      as="div"
      className="pn-columns"
      data-columns=""
      data-cols={count}
      data-border={borderAttr ?? undefined}
      data-border-style={borderCfg.style !== 'none' ? borderCfg.style : undefined}
      role="group"
      aria-label={t('kanban.columns')}
      style={wrapperStyle as React.CSSProperties}
    >
      <NodeViewContent className="pn-columns-content" />
      {editable && count >= 2 && weights.slice(0, -1).map((_, border) => (
        <div
          key={border}
          className="pn-columns-handle"
          contentEditable={false}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('columns.resizeColumn')}
          style={{ insetInlineStart: gapCenterCss(weights, border, gapCss) }}
          onPointerDown={(e) => startDrag(border, e)}
        />
      ))}
    </NodeViewWrapper>
  );
}

/* ------------------------------------------------------------------ */
/* TipTap Nodes                                                       */
/* ------------------------------------------------------------------ */

export const ColumnsCol = Node.create({
  name: 'columnsCol',
  content: 'block+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      width: {
        default: null,
        parseHTML: (el) => parseColumnWidth(el.getAttribute('data-width')),
        renderHTML: (attrs) => (typeof attrs.width === 'number' ? { 'data-width': String(attrs.width) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-columns-col]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-columns-col': '', class: 'pn-columns-col' }), 0];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            wrapBlock: (delim: string, first: string | null, node: unknown, f: () => void) => void;
            write: (s: string) => void;
            ensureNewLine: () => void;
            render: (n: unknown, parent: unknown, i: number) => void;
          },
          node: {
            attrs: { width: number | null };
            forEach: (f: (child: unknown, offset: number, index: number) => void) => void;
          },
        ) {
          const w = typeof node.attrs.width === 'number' ? `|${node.attrs.width}` : '';
          state.wrapBlock('> ', null, node, () => {
            state.write(`[!col${w}]+`);
            state.ensureNewLine();
            node.forEach((child, _offset, index) => {
              state.render(child, node, index);
            });
          });
        },
        parse: {},
      },
    };
  },
});

export const ColumnsBlock = Node.create({
  name: 'columnsBlock',
  group: 'block',
  content: 'columnsCol+',
  defining: true,

  addAttributes() {
    return {
      border: {
        default: null,
        parseHTML: (el) => formatColumnBorder(parseColumnBorder(el.getAttribute('data-border'))),
        renderHTML: (attrs) => (typeof attrs.border === 'string' && attrs.border ? { 'data-border': attrs.border } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-columns]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-columns': '', class: 'pn-columns' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ColumnsBlockView as never, {
      // Same Android WebView safeguard as Callout.tsx (docs/contrib/callouts.md).
      ignoreMutation: ({ mutation }) => mutation.type !== 'selection',
    });
  },

  addProseMirrorPlugins() {
    return [columnsPlugin()];
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => enterAtEndOfColumn(editor.state, editor.view),
      ArrowUp: ({ editor }) => escapeAboveColumns(editor.state, editor.view, false),
      ArrowLeft: ({ editor }) => escapeAboveColumns(editor.state, editor.view, true),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            wrapBlock: (delim: string, first: string | null, node: unknown, f: () => void) => void;
            write: (s: string) => void;
            ensureNewLine: () => void;
            render: (n: unknown, parent: unknown, i: number) => void;
          },
          node: {
            attrs: { border?: string | null };
            forEach: (f: (child: unknown, offset: number, index: number) => void) => void;
          },
        ) {
          const borderMeta = formatColumnBorder(parseColumnBorder(node.attrs.border));
          state.wrapBlock('> ', null, node, () => {
            state.write(borderMeta ? `[!columns|${borderMeta}]+` : '[!columns]+');
            state.ensureNewLine();
            node.forEach((child, _offset, index) => {
              state.render(child, node, index);
            });
          });
        },
        parse: {},
      },
    };
  },
});
