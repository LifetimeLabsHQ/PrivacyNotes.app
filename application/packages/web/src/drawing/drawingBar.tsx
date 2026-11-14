/**
 * The drawing canvas's toolbar as an arrangeable bar: the same rules as the
 * format bar (`createBarModel` in formatBar.ts), over its own items. It has
 * no menus, so an item lives on the bar, at its end (which always stays
 * visible), or hidden; a hidden tool still works by its key. The style
 * button of Excalidraw's phone layout is no item: it shows only while a
 * style applies, first in the end zone.
 *
 * Each item names its icon and label for the Settings board, and for the
 * toolbar the key Excalidraw reads for it, the tool it lights up and its row
 * in the drawing hotkey list.
 * Spec: docs/internal/specs/drawing.md (section 0)
 */
import type { Icon } from '../icons';
import {
  ArrowUpRight, ArrowUUpLeft, ArrowUUpRight, BoundingBox, Circle, Crosshair, Diamond, Eraser, FolderOpen, Hand, Image,
  Gear, Hash, Keyboard, LineSegment, LineVertical, LockSimpleOpen, MagnifyingGlass, MagnifyingGlassMinus, MagnifyingGlassPlus,
  NavigationArrow, PencilSimple, Square, TextT, Trash,
} from '../icons';
import { createBarModel, separator as hiddenSeparator, type FormatBarItem } from '../formatBar';

const bar = (key: string): FormatBarItem => ({ key, home: 'bar', group: 'format', menuAllowed: false, attachAllowed: false });
const end = (key: string): FormatBarItem => ({ key, home: 'end', group: 'format', menuAllowed: false, attachAllowed: false });

/** Stock order: the row, the end of the bar, hidden. */
export const DRAWING_BAR_ITEMS: readonly FormatBarItem[] = [
  bar('keepTool'), bar('separator1'),
  bar('hand'), bar('selection'), bar('rectangle'), bar('diamond'), bar('ellipse'), bar('arrow'), bar('line'),
  bar('freedraw'), bar('text'), bar('steps'), bar('image'), bar('eraser'), bar('frame'), bar('laser'),
  bar('separator2'), bar('undo'), bar('redo'),
  bar('separator3'), bar('zoomOut'), bar('zoomReset'), bar('zoomIn'),
  end('open'), end('reset'), end('hotkeys'), end('customize'),
  hiddenSeparator('separator4'),
];

/** Not a button that keeps the bar usable: a line, the hotkeys button,
 *  which a touch-only screen leaves out, and the gear, which only a wide
 *  screen shows (as the format bar's). */
const SOMETIMES_ABSENT = new Set(['separator1', 'separator2', 'separator3', 'separator4', 'hotkeys', 'customize']);

export const DRAWING_BAR = createBarModel(DRAWING_BAR_ITEMS, ['format'], SOMETIMES_ABSENT);

/** A key press as Excalidraw reads it: the key, its code, Cmd or Ctrl. */
export type DrawingPress = { key: string; code: string; mod?: boolean; shift?: boolean };

export type DrawingBarLook = {
  Icon: Icon;
  /** A label key with its namespace. */
  label: string;
  /** The key the button sends Excalidraw. */
  press?: DrawingPress;
  /** The Excalidraw tool the button lights up. */
  tool?: string;
  /** Its row in DRAWING_HOTKEY_GROUPS, for the tooltip's keys, and which of
   *  the row's alternatives ("A / B") it is. */
  hotkey?: string;
  alt?: 0 | 1;
};

const separator: DrawingBarLook = { Icon: LineVertical, label: 'editor:formatBar.items.separator' };
const tool = (name: string, label: string, hotkey: string, key: string, code: string, Icon: Icon): DrawingBarLook =>
  ({ Icon, label, hotkey, tool: name, press: { key, code } });

export const DRAWING_BAR_LOOK: Readonly<Record<string, DrawingBarLook>> = {
  keepTool: { Icon: LockSimpleOpen, label: 'notes:drawing.tools.keepTool', hotkey: 'drawKeepTool', press: { key: 'q', code: 'KeyQ' } },
  hand: tool('hand', 'notes:drawing.tools.hand', 'drawHand', 'h', 'KeyH', Hand),
  selection: tool('selection', 'shell:contextMenu.select', 'drawSelect', 'v', 'KeyV', NavigationArrow),
  rectangle: tool('rectangle', 'notes:drawing.tools.rectangle', 'drawRectangle', 'r', 'KeyR', Square),
  diamond: tool('diamond', 'notes:drawing.tools.diamond', 'drawDiamond', 'd', 'KeyD', Diamond),
  ellipse: tool('ellipse', 'notes:drawing.tools.ellipse', 'drawEllipse', 'o', 'KeyO', Circle),
  arrow: tool('arrow', 'notes:drawing.tools.arrow', 'drawArrow', 'a', 'KeyA', ArrowUpRight),
  line: tool('line', 'notes:drawing.tools.line', 'drawLine', 'l', 'KeyL', LineSegment),
  freedraw: tool('freedraw', 'notes:drawing.tools.pen', 'drawPen', 'p', 'KeyP', PencilSimple),
  text: tool('text', 'notes:drawing.tools.text', 'drawText', 't', 'KeyT', TextT),
  // No key and no hotkey row: a custom tool of the canvas (steps.ts).
  steps: { Icon: Hash, label: 'notes:drawing.tools.steps', tool: 'steps' },
  image: tool('image', 'editor:toolbar.image', 'drawPicture', '9', 'Digit9', Image),
  eraser: tool('eraser', 'notes:drawing.tools.eraser', 'drawEraser', 'e', 'KeyE', Eraser),
  frame: tool('frame', 'notes:drawing.frame', 'drawFrame', 'f', 'KeyF', BoundingBox),
  laser: tool('laser', 'notes:drawing.laser', 'drawLaser', 'k', 'KeyK', Crosshair),
  undo: { Icon: ArrowUUpLeft, label: 'notes:editor.undo', hotkey: 'drawUndo', alt: 0, press: { key: 'z', code: 'KeyZ', mod: true } },
  redo: { Icon: ArrowUUpRight, label: 'notes:editor.redo', hotkey: 'drawUndo', alt: 1, press: { key: 'z', code: 'KeyZ', mod: true, shift: true } },
  zoomOut: { Icon: MagnifyingGlassMinus, label: 'media:viewer.zoomOut', hotkey: 'drawZoom', alt: 1, press: { key: '-', code: 'Minus', mod: true } },
  zoomReset: { Icon: MagnifyingGlass, label: 'notes:drawing.tools.resetZoom', hotkey: 'drawZoomReset', alt: 0, press: { key: '0', code: 'Digit0', mod: true } },
  zoomIn: { Icon: MagnifyingGlassPlus, label: 'media:viewer.zoomIn', hotkey: 'drawZoom', alt: 0, press: { key: '=', code: 'Equal', mod: true } },
  open: { Icon: FolderOpen, label: 'notes:drawing.tools.open', press: { key: 'o', code: 'KeyO', mod: true } },
  reset: { Icon: Trash, label: 'notes:drawing.tools.reset' },
  hotkeys: { Icon: Keyboard, label: 'notes:drawing.hotkeysTitle' },
  customize: { Icon: Gear, label: 'editor:toolbar.customize' },
  separator1: separator, separator2: separator, separator3: separator, separator4: separator,
};
