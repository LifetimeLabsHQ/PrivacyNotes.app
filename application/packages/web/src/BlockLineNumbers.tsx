import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Editor as TipTapEditor } from '@tiptap/react';
import { blockStartFor, numberBlocks, type NumberedBlock } from './lineNumbers';

type Placed = { line: number; top: number; height: number; el: HTMLElement };

/** The box a block's first line is drawn in: a table row's first cell, a
 *  cell's first paragraph. */
function firstLineBox(el: HTMLElement): HTMLElement {
  const cell = el instanceof HTMLTableRowElement ? el.cells[0] ?? el : el;
  const inner = cell.matches('td, th') ? cell.querySelector<HTMLElement>('p') : null;
  return inner ?? cell;
}

/**
 * The line numbers beside a formatted body (the formatted view, the split
 * view's preview): each block shows the Markdown line it starts on
 * (lineNumbers.ts), in the gutter at the start of the text, level with the
 * block's first line. The block that holds the caret shows its number in the
 * accent color: `caretLine` from the Markdown text beside it, or the
 * editor's own caret.
 *
 * `text` is the Markdown the numbers count; `tap` hands in each newer one
 * the save serializes, so the formatted view counts what it saves without a
 * serialization of its own. Pairs are read again only when the text changes;
 * a change of the body's size moves the numbers. A layer of plain spans
 * beside ProseMirror, never in its DOM, so nothing it draws is a document
 * change. Spec: docs/internal/specs/editor-mode-toggle.md (Line numbers)
 */
export function BlockLineNumbers({ editor, text, tap, caretLine, gap }: {
  editor: TipTapEditor;
  text: string;
  tap?: RefObject<((markdown: string) => void) | null>;
  /** The Markdown text's caret line; absent: the editor's own caret. */
  caretLine?: number | null;
  gap: number;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [counted, setCounted] = useState(text);
  useEffect(() => setCounted(text), [text]);
  useEffect(() => {
    if (!tap) return;
    tap.current = setCounted;
    return () => {
      tap.current = null;
    };
  }, [tap]);

  const [placed, setPlaced] = useState<Placed[]>([]);
  const [edge, setEdge] = useState<{ x: number; rtl: boolean }>({ x: 0, rtl: false });
  const [caretEl, setCaretEl] = useState<HTMLElement | null>(null);
  const blocksRef = useRef<NumberedBlock[]>([]);
  const lines = useMemo(() => counted.split('\n'), [counted]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || editor.isDestroyed) return;
    const body = editor.view.dom as HTMLElement;
    let frame = 0;
    let paired = false;
    const draw = () => {
      if (editor.isDestroyed) return;
      if (!paired) {
        blocksRef.current = numberBlocks(counted, body);
        paired = true;
      }
      const origin = layer.getBoundingClientRect();
      const box = body.getBoundingClientRect();
      const cs = getComputedStyle(body);
      const rtl = cs.direction === 'rtl';
      setEdge({
        rtl,
        x: rtl
          ? box.right - (parseFloat(cs.paddingRight) || 0) - origin.left + gap
          : box.left + (parseFloat(cs.paddingLeft) || 0) - origin.left - gap,
      });
      setPlaced(blocksRef.current.flatMap(({ line, el }) => {
        if (!el.isConnected) return [];
        const target = firstLineBox(el);
        if (target.getClientRects().length === 0) return [];
        const r = target.getBoundingClientRect();
        const tcs = getComputedStyle(target);
        const fontSize = parseFloat(tcs.fontSize) || 16;
        const height = Math.min(r.height, parseFloat(tcs.lineHeight) || fontSize * 1.5) || 24;
        const top = r.top - origin.top + (parseFloat(tcs.paddingTop) || 0) + (parseFloat(tcs.borderTopWidth) || 0);
        return [{ line, top, height, el }];
      }));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(body);
    // A typed change moves the blocks under it before the save counts it.
    editor.on('update', schedule);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      editor.off('update', schedule);
    };
  }, [editor, counted, gap]);

  // The formatted view's own caret: the numbered block that holds it.
  const ownCaret = caretLine === undefined;
  useEffect(() => {
    if (!ownCaret || editor.isDestroyed) return;
    const read = () => {
      if (editor.isDestroyed) return;
      const { node } = editor.view.domAtPos(editor.state.selection.head);
      const at = node instanceof HTMLElement ? node : node.parentElement;
      setCaretEl(at ? blocksRef.current.find((b) => b.el.contains(at))?.el ?? null : null);
    };
    read();
    editor.on('selectionUpdate', read);
    editor.on('update', read);
    return () => {
      editor.off('selectionUpdate', read);
      editor.off('update', read);
    };
  }, [editor, ownCaret, placed]);

  const activeLine = ownCaret
    ? null
    : caretLine === null ? null : blockStartFor(placed.map((p) => p.line), lines, caretLine);

  return (
    <div ref={layerRef} aria-hidden="true" className="pointer-events-none absolute inset-0 select-none">
      {placed.map((p) => {
        const active = ownCaret ? p.el === caretEl : p.line === activeLine;
        return (
          <span
            key={`${p.line}:${Math.round(p.top)}`}
            className={`absolute flex items-center font-mono leading-none tabular-nums ${active ? 'text-accent' : 'text-pn-muted/70'}`}
            style={{
              top: p.top,
              height: p.height,
              left: edge.x,
              transform: edge.rtl ? undefined : 'translateX(-100%)',
              fontSize: 'calc(14px * var(--pn-text-scale))',
            }}
          >
            {p.line + 1}
          </span>
        );
      })}
    </div>
  );
}
