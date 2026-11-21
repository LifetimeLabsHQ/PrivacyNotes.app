import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Editor as TipTapEditor } from '@tiptap/react';
import { Editor } from './Editor';
import { collapseMediaGaps, fixEmptyTaskItems } from './editorExtensions';
import { OutlinePanel } from './OutlinePanel';
import { editDelay } from './useDebouncedMarkdownSave';
import { useCornerPanels } from './useEditorPanels';
import { useElementHeight } from './useElementSize';
import { createPreviewFollow, type PreviewFollow } from './viewSwitchAnchor';

const noop = () => {
  /* read only: never fires */
};

/** The sticky column's top: under the tag row and the Markdown bar. */
const UNDER_BARS = 'var(--pn-tagrow-h, 0px) + var(--pn-editor-toolbar-h, 0px)';

/**
 * The note as the formatted view draws it, beside the Markdown
 * text (the Markdown view with a preview, GitHub #727). A second `Editor`
 * with `preview` set, as the history modal draws its sides, so callouts,
 * tables, file chips, maps and math look exactly as they do in the
 * formatted view. The rich editor is not mounted in the Markdown view, so
 * there is still one note editor.
 *
 * It never saves itself. An edit in it goes to `onEdit` as Markdown, and the
 * caller writes that into the text, which saves as typing there does; with
 * no `onEdit` it is read only. It has no note id, so no flush stash and no
 * doc cache. The load cleanups change only its own copy and send nothing. It refreshes through `setContent` after a pause in typing, on
 * the save's own size steps (`editDelay`), never by a remount, which would
 * flash and lose its scroll.
 *
 * One scroller: the pane scrolls the text, and this column sticks under the
 * bars, as tall as the pane, and follows the text (createPreviewFollow).
 *
 * The formatted view's corner sits at the column's top right and acts on
 * the text: find opens the Markdown view's own bar, the outline's jump moves
 * the text (the preview follows), Connections is the same panel. `preview`
 * mode draws no corner of its own, so these come from here.
 * Spec: docs/internal/plans/heading-folds-and-source-preview.md (Part 2)
 */
export function SourcePreviewPane({ text, caretLine = null, lineNumbers = false, pane, first = false, findPill, connections, onEdit }: {
  text: string;
  /** An edit in the preview, as Markdown: the caller writes it into the text.
   *  Absent, the preview is read only (a read-only note). */
  onEdit?: (markdown: string) => void;
  /** The Markdown caret's line, for the accent on its block's number. */
  caretLine?: number | null;
  /** Number each block with the line it starts on (lineNumbers.ts). */
  lineNumbers?: boolean;
  pane: HTMLElement | null;
  /** The preview takes the start side (swapped), the text the end. A CSS
   *  order, so a swap moves the column and keeps its editor. */
  first?: boolean;
  /** The formatted view's find pill, pointed at the Markdown view's find. */
  findPill?: ReactNode;
  connections?: (open: boolean, onOpenChange: (open: boolean) => void) => ReactNode;
}) {
  const [firstText] = useState(text);
  const [editor, setEditor] = useState<TipTapEditor | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<PreviewFollow | null>(null);
  const shownRef = useRef(text);
  // The text the preview draws now, which its line numbers count.
  const [shownText, setShownText] = useState(text);
  const paneHeight = useElementHeight(pane);
  const { outlineOpen, setOutlineOpen, connectionsOpen, setConnectionsOpen } = useCornerPanels();
  const reveal = useCallback((el: Element) => followRef.current?.reveal(el), []);

  // Follow the text: on a scroll of the pane, and when either side changes
  // size (a picture loads, the window narrows).
  useEffect(() => {
    const column = columnRef.current;
    if (!pane || !column) return;
    const follow = createPreviewFollow(pane, column);
    followRef.current = follow;
    let frame = 0;
    const align = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(follow.align);
    };
    pane.addEventListener('scroll', align, { passive: true });
    const ro = new ResizeObserver(align);
    ro.observe(column);
    if (column.firstElementChild) ro.observe(column.firstElementChild);
    align();
    return () => {
      cancelAnimationFrame(frame);
      pane.removeEventListener('scroll', align);
      ro.disconnect();
      followRef.current = null;
    };
  }, [pane]);

  // The first draw has no text to follow yet when the editor arrives.
  useEffect(() => {
    if (!editor) return;
    const frame = requestAnimationFrame(() => followRef.current?.align());
    return () => cancelAnimationFrame(frame);
  }, [editor]);

  useEffect(() => {
    if (!editor || text === shownRef.current) return;
    // While the preview has the caret the change is its own edit coming
    // back: it already shows it, and a redraw would move the caret.
    if (editor.isFocused) {
      shownRef.current = text;
      setShownText(text);
      return;
    }
    const timer = window.setTimeout(() => {
      if (editor.isDestroyed) return;
      shownRef.current = text;
      setShownText(text);
      // The transforms the editor's own load applies (Editor.tsx `content`).
      editor.commands.setContent(collapseMediaGaps(fixEmptyTaskItems(text)), { emitUpdate: false });
      followRef.current?.invalidate();
      followRef.current?.align();
    }, editDelay(text.length));
    return () => window.clearTimeout(timer);
  }, [editor, text]);

  // The divider is on the grid cell, which runs the whole row down to the
  // footer; the sticky column inside it is only as tall as the pane.
  return (
    <div className={`min-w-0 border-divider ${first ? 'order-first border-e pe-6' : 'border-s ps-6'}`}>
    <div
      ref={columnRef}
      data-pn-source-preview
      className="sticky self-start min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain"
      style={{
        top: `calc(${UNDER_BARS})`,
        maxHeight: paneHeight > 0 ? `calc(${paneHeight}px - (${UNDER_BARS}))` : undefined,
      }}
    >
      {/* The corner, pinned to the column's top as the formatted view's is
          to the body's. */}
      <div className="sticky top-0 z-[5] flex h-0 items-start justify-end overflow-visible pointer-events-none">
        <div className="flex items-start gap-1.5">
          {findPill}
          {connections?.(connectionsOpen, setConnectionsOpen)}
          {editor && <OutlinePanel editor={editor} open={outlineOpen} onOpenChange={setOutlineOpen} reveal={reveal} />}
        </div>
      </div>
      {/* The first block starts under the corner pills, level with the
          text's first line (mt-11 over the field clears its copy pill the
          same way): 28px here and the body's own 16px. The bottom gap lets
          the end scroll clear of a pinned footer. */}
      <div className="pt-7 pb-12">
        <Editor
          value={firstText}
          onChange={onEdit ?? noop}
          readOnly={!onEdit}
          // The Markdown view's bar spans both columns: no second bar here.
          toolbarVisible={false}
          preview
          onReady={setEditor}
          lineNumbers={lineNumbers ? { text: shownText, caretLine } : false}
        />
      </div>
    </div>
    </div>
  );
}
