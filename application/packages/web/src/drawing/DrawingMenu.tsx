/**
 * Excalidraw's right-click (long-press) menu as the app's own `ContextMenu`:
 * the same rows, with the app's icons and the keys in the app's notation.
 *
 * Excalidraw has no public call that runs one of its menu actions, so its
 * menu still opens, hidden (`drawing.css`), and this reads its rows: the
 * name (`data-testid`), the label in Excalidraw's language, the keys, the
 * check mark. A pick clicks Excalidraw's row, which runs the action and
 * closes its menu. Excalidraw closes its menu on any `pointerdown` that
 * reaches the document outside it, so a press inside the app's menu stops
 * at the body while it is open; otherwise the row would be gone before the
 * click. A lazy part beside the canvas, off the boot path.
 * Spec: docs/internal/specs/drawing.md (section 0)
 */
import { useEffect, useRef, type RefObject } from 'react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ContextMenu';
import {
  ArrowDown, ArrowLineDown, ArrowLineUp, ArrowUp, ArrowsHorizontal, BoundingBox, Clipboard, Copy, CopySimple, Crop,
  EXPORT_GLYPHS, FlipHorizontal, FlipVertical, GridFour, Link, LockSimple, LockSimpleOpen, Magnet, PaintBrush,
  PaintBrushBroad, Path, Scissors, SelectionAll, SelectionPlus, SelectionSlash, TextT, TextTSlash, Textbox, Trash,
  type Icon,
} from '../icons';
import { keysOf } from './DrawingTips';

/** Each row of Excalidraw 0.18.1's menu by its action name. A row this map
 *  does not know shows without an icon. */
const GLYPHS: Readonly<Record<string, Icon>> = {
  cut: Scissors,
  copy: Copy,
  paste: Clipboard,
  copyText: TextT,
  copyAsPng: EXPORT_GLYPHS.png,
  selectAll: SelectionAll,
  unlockAllElements: LockSimpleOpen,
  gridMode: GridFour,
  objectsSnapMode: Magnet,
  selectAllElementsInFrame: SelectionAll,
  removeAllElementsFromFrame: BoundingBox,
  wrapSelectionInFrame: BoundingBox,
  cropEditor: Crop,
  copyStyles: PaintBrush,
  pasteStyles: PaintBrushBroad,
  group: SelectionPlus,
  ungroup: SelectionSlash,
  autoResize: ArrowsHorizontal,
  unbindText: TextTSlash,
  bindText: TextT,
  wrapTextInContainer: Textbox,
  sendBackward: ArrowDown,
  bringForward: ArrowUp,
  sendToBack: ArrowLineDown,
  bringToFront: ArrowLineUp,
  flipHorizontal: FlipHorizontal,
  flipVertical: FlipVertical,
  toggleLinearEditor: Path,
  hyperlink: Link,
  duplicateSelection: CopySimple,
  toggleElementLock: LockSimple,
  deleteSelectedElements: Trash,
};

/** Rows left out, as the rest of the canvas leaves them out (spec section 3):
 *  the library, Excalidraw's zen mode, view mode and stats, Copy element
 *  link and Copy as SVG. */
const LEFT_OUT = new Set(['addToLibrary', 'zenMode', 'viewMode', 'stats', 'copyElementLink', 'copyAsSvg']);

/** Excalidraw's open menu as the app's rows: one rule between groups, none
 *  at either end. */
function rowsOf(list: Element, onPick: () => void): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  for (const row of Array.from(list.children)) {
    if (row.tagName === 'HR') {
      if (items.length && items[items.length - 1]?.type !== 'separator') items.push({ type: 'separator' });
      continue;
    }
    const name = row.getAttribute('data-testid');
    if (!name || LEFT_OUT.has(name) || !(row instanceof HTMLElement)) continue;
    const Glyph = GLYPHS[name];
    items.push({
      label: row.querySelector('.context-menu-item__label')?.textContent ?? '',
      icon: Glyph ? <Glyph /> : undefined,
      shortcut: keysOf(row.querySelector('.context-menu-item__shortcut')?.textContent ?? '') || undefined,
      checked: row.querySelector('.checkmark') ? true : undefined,
      destructive: name === 'deleteSelectedElements' || undefined,
      onSelect: () => {
        onPick();
        if (row.isConnected) row.click();
      },
    });
  }
  if (items[items.length - 1]?.type === 'separator') items.pop();
  return items;
}

/** The menu for the canvas inside `host`. `onDismiss` closes Excalidraw's
 *  hidden menu when the person closes the app's without a pick. */
export default function DrawingMenu({ host, onDismiss }: { host: RefObject<HTMLElement | null>; onDismiss?: () => void }) {
  const menu = useContextMenu();
  const picked = useRef(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const open = useRef(menu.open);
  open.current = menu.open;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // Excalidraw opens its menu from the same event (a touch long-press
    // fires it too) and draws it in that update, so the rows are there one
    // frame later. It can keep the same list element for the next menu.
    let frame = 0;
    const onCtx = (e: MouseEvent) => {
      const at = { clientX: e.clientX, clientY: e.clientY, preventDefault: () => {}, stopPropagation: () => {} };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const list = el.querySelector('.excalidraw .popover > .context-menu');
        if (!list) return;
        picked.current = false;
        open.current(at, rowsOf(list, () => { picked.current = true; }));
      });
    };
    el.addEventListener('contextmenu', onCtx);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('contextmenu', onCtx);
    };
  }, [host]);

  const isOpen = !!menu.state;
  useEffect(() => {
    if (!isOpen) return;
    const keep = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[role="menu"]')) e.stopPropagation();
    };
    document.body.addEventListener('pointerdown', keep);
    return () => document.body.removeEventListener('pointerdown', keep);
  }, [isOpen]);

  const close = () => {
    menu.close();
    if (!picked.current) dismiss.current?.();
  };
  return <ContextMenu state={menu.state} onClose={close} />;
}
