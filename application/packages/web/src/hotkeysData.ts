/**
 * The help rows: which commands each row of the keyboard help shows, in
 * which group, with what English label. One list feeds the in-app Hotkeys
 * tab and the printable cheat sheet, and the keys
 * come from commandKeys.ts, so a key and its row cannot drift apart.
 *
 * help-page.ts evaluates this file together with commandKeys.ts (the import
 * below is its only one), so it MUST stay free of other imports.
 *
 * `label` and `title` hold the English text. Settings > Hotkeys and the
 * cheat sheet show them as they are, in English on purpose, so both keep one
 * layout. `i18nKey` is a stable name for a row or a group.
 *
 * Spec: docs/internal/specs/keyboard-shortcuts.md (sections 4.5 and 4.6)
 */

import { bindingApplies, bindingCaps, visibleBindings, type CommandId, type KeyBinding, type KeyOs } from './commandKeys';

export type HotkeyRow = {
  /** The commands the row shows, joined by " / " (J / K). */
  commands: CommandId[];
  /** Keys another component owns (the drawing canvas, the editor's `[!`
   *  menu), shown as they are after the keys of `commands`: they never run
   *  through the app's handler. */
  bindings?: readonly KeyBinding[];
  /** Show the first and the last key of the one command as a range (⌥⌘1 – ⌥⌘6). */
  range?: boolean;
  label: string;
  i18nKey: string;
};
export type HotkeyGroup = { title: string; i18nKey: string; rows: HotkeyRow[] };

/** The help rows. Order by how often they are reached for, not strictly by category. */
export const HOTKEY_GROUPS: HotkeyGroup[] = [
  {
    title: 'Navigation',
    i18nKey: 'navigation',
    rows: [
      { commands: ['quickSwitcher'], label: 'Open Ninja: find, add or run anything', i18nKey: 'quickSwitcher' },
      // The default global key (ninjaShortcut.ts). The person can change it
      // or turn it off in Settings > System; a longer label wraps and pushes
      // the printed desktop sheet onto a second page.
      { commands: [], bindings: [{ alt: true, shift: true, key: 'Space', desktop: true }], label: 'Open Ninja from any app', i18nKey: 'ninjaGlobal' },
      { commands: ['focusSearch'], label: 'Focus search', i18nKey: 'focusSearch' },
      { commands: ['commandMode'], label: 'Commands (or type > in the search)', i18nKey: 'commandMode' },
      { commands: ['listDown', 'listUp'], label: 'Move down / up in the list', i18nKey: 'moveInList' },
      // The same step as J and K, but with a modifier, so it runs while typing.
      { commands: ['previousInList', 'nextInList'], label: 'Previous / next in the list', i18nKey: 'listStep' },
      { commands: ['historyBack', 'historyForward'], label: 'Back / forward in history', i18nKey: 'history' },
      { commands: ['goToSection'], range: true, label: 'Sidebar section 1 to 9', i18nKey: 'goToSection' },
      { commands: ['switchSpace'], label: 'Switch space: Personal / Work (Pro)', i18nKey: 'switchSpace' },
      { commands: ['nextPane', 'previousPane'], label: 'Next / previous pane', i18nKey: 'movePanes' },
      // Esc does five things, in this order: clear the list search, exit
      // zen, exit multi-select, clear the folder and tag filter, close the
      // open note. "Close note" must stay in the label: it is the one people
      // notice - it deselects and the editor remounts, which reads as the
      // note jumping to the top.
      { commands: ['escape'], label: 'Clear search / filters / close note', i18nKey: 'clearSearch' },
    ],
  },
  {
    title: 'Notes',
    i18nKey: 'notes',
    rows: [
      { commands: ['newNote'], label: 'New note', i18nKey: 'newNote' },
      // Inside the Ninja box the app's New note key opens its note mode (NinjaWindow.tsx).
      { commands: [], bindings: [{ mod: true, key: 'n', desktop: true }], label: 'Quick note in the Ninja box', i18nKey: 'ninjaQuickNote' },
      { commands: ['newMenu'], label: 'New item, then its letter', i18nKey: 'newMenu' },
      { commands: ['quickAdd'], label: 'Quick add: a title with a day and a time', i18nKey: 'quickAdd' },
      // One row, so the printed sheet stays on one page.
      { commands: ['calendarToday', 'calendarDay', 'calendarWeek', 'calendarMonth', 'calendarNew'], label: 'Calendar: today / day / week / month / new', i18nKey: 'calendarKeys' },
      // One row, so the printed sheet stays on one page.
      { commands: ['moveToTrash', 'deleteAsk'], label: 'Delete / ask', i18nKey: 'moveToTrash' },
    ],
  },
  {
    // Mouse gestures on a list row or grid tile. Cmd-click is the platform's
    // multi-select, so opening a tab takes Option-click, the one modifier a
    // row leaves free. Spec: docs/internal/specs/note-tabs.md (section 2)
    title: 'Lists',
    i18nKey: 'lists',
    rows: [
      { commands: ['selectSeveral'], label: 'Select several items', i18nKey: 'selectSeveral' },
      { commands: ['selectRange'], label: 'Select a range (while selecting)', i18nKey: 'selectRange' },
      { commands: ['openInTab'], label: 'Open in a tab (or middle-click)', i18nKey: 'openInTab' },
      { commands: ['closeTab'], label: 'Close the tab', i18nKey: 'closeTab' },
      { commands: ['nextTab', 'previousTab'], label: 'Next / previous tab', i18nKey: 'nextTab' },
    ],
  },
  {
    title: 'Editor',
    i18nKey: 'editor',
    rows: [
      // Toggles. Esc deliberately does NOT close it - Esc closes the note.
      { commands: ['find'], label: 'Find in note (press again to close)', i18nKey: 'findInNote' },
      // Never ⌘H on a Mac: macOS takes it for Hide before a page sees it.
      { commands: ['findReplace'], label: 'Find and replace', i18nKey: 'findReplace' },
      { commands: ['outline'], label: 'Toggle outline', i18nKey: 'toggleOutline' },
      { commands: ['connections'], label: 'Toggle connections', i18nKey: 'toggleConnections' },
      // ⌘⇧K, not ⌘K: plain ⌘K opens the quick switcher everywhere.
      { commands: ['insertLink'], label: 'Insert link (while editing)', i18nKey: 'insertLink' },
      { commands: ['markdownView'], label: 'Markdown view on / off', i18nKey: 'markdownView' },
      { commands: ['invisibles'], label: 'Invisible characters on / off', i18nKey: 'invisibles' },
      { commands: ['insertDate', 'insertDateTime'], label: 'Insert date / date and time', i18nKey: 'insertDate' },
      { commands: ['undo', 'redo'], label: 'Undo / redo', i18nKey: 'undoRedo' },
    ],
  },
  {
    title: 'Formatting',
    i18nKey: 'formatting',
    rows: [
      { commands: ['bold'], label: 'Bold', i18nKey: 'bold' },
      { commands: ['italic'], label: 'Italic', i18nKey: 'italic' },
      { commands: ['underline'], label: 'Underline', i18nKey: 'underline' },
      { commands: ['strikethrough'], label: 'Strikethrough', i18nKey: 'strikethrough' },
      { commands: ['highlight'], label: 'Highlight', i18nKey: 'highlight' },
      { commands: ['inlineCode'], label: 'Inline code', i18nKey: 'inlineCode' },
      { commands: ['superscript'], label: 'Superscript', i18nKey: 'superscript' },
      // Short on purpose: the keys show the range, and a longer label wraps the
      // Ctrl+Shift range onto a second line of the printed sheet.
      { commands: ['headings'], range: true, label: 'Headings', i18nKey: 'headings' },
      { commands: ['normalText'], label: 'Normal text', i18nKey: 'normalText' },
      { commands: ['numberedList'], label: 'Numbered list', i18nKey: 'numberedList' },
      { commands: ['bulletedList'], label: 'Bulleted list', i18nKey: 'bulletedList' },
      { commands: ['taskList'], label: 'Task list', i18nKey: 'taskList' },
      // Tab/Shift+Tab reach every list kind, checklists included.
      { commands: ['indentList', 'outdentList'], label: 'Indent / outdent a list', i18nKey: 'indentOutdent' },
      { commands: ['blockquote'], label: 'Blockquote', i18nKey: 'blockquote' },
      { commands: ['codeBlock'], label: 'Code block', i18nKey: 'codeBlock' },
      // Mod+Shift+C is the desktop apps' only: a browser keeps it for its
      // developer tools. `[!` is typed text the editor's callout menu reads
      // (CalloutSuggestion.tsx), shown on every key set as the way in.
      { commands: ['insertCallout'], bindings: [{ key: '[!' }], label: 'Callout ([! on an empty line)', i18nKey: 'insertCallout' },
    ],
  },
  {
    // Left is deliberately absent: it is not a stored state (see
    // ALIGNMENT_VALUES in Editor.tsx), and its upstream ⌘⇧L binding is
    // removed because ⌘⇧L is our light/dark toggle.
    title: 'Alignment',
    i18nKey: 'alignment',
    rows: [
      { commands: ['alignCenter'], label: 'Center', i18nKey: 'alignCenter' },
      { commands: ['alignRight'], label: 'Align right', i18nKey: 'alignRight' },
      { commands: ['alignJustify'], label: 'Justify', i18nKey: 'alignJustify' },
    ],
  },
  {
    title: 'View',
    i18nKey: 'view',
    rows: [
      { commands: ['openSettings'], label: 'Open settings', i18nKey: 'openSettings' },
      { commands: ['toggleSidebar'], label: 'Toggle sidebar', i18nKey: 'toggleSidebar' },
      { commands: ['toggleTheme'], label: 'Toggle light / dark mode', i18nKey: 'toggleTheme' },
      // In a browser the same keys are the browser's own zoom, which does
      // the same thing without passing through the page.
      { commands: ['zoomIn', 'zoomOut'], label: 'App bigger / smaller', i18nKey: 'appZoom' },
      { commands: ['zoomReset'], label: 'App back to normal size', i18nKey: 'appZoomReset' },
      // ⌘⇧F ("focus"), not ⌘⇧Z: Z is the editor's redo, and zen must be
      // reachable WHILE writing. Plain ⌘F stays find-in-note.
      { commands: ['zen'], label: 'Zen / Focus mode (Pro)', i18nKey: 'zenMode' },
      { commands: ['help'], label: 'Toggle this help', i18nKey: 'toggleHelp' },
    ],
  },
];

/**
 * The drawing canvas's own keys (Excalidraw 0.18.1), in a window of their
 * own (drawing/DrawingHotkeys.tsx): they work while the canvas has the
 * focus, where a single letter is the canvas's. Never on the printed sheet.
 * Checked against Excalidraw's code; tests/excalidrawContract.test.ts pins
 * the version. Spec: docs/internal/specs/drawing.md (section 0, Keys)
 */
export const DRAWING_HOTKEY_GROUPS: HotkeyGroup[] = [
  {
    title: 'Tools',
    i18nKey: 'drawTools',
    rows: [
      { commands: [], bindings: [{ key: 'v' }, { key: '1' }], label: 'Select', i18nKey: 'drawSelect' },
      { commands: [], bindings: [{ key: 'h' }], label: 'Move the canvas (hand)', i18nKey: 'drawHand' },
      { commands: [], bindings: [{ key: 'r' }, { key: '2' }], label: 'Rectangle', i18nKey: 'drawRectangle' },
      { commands: [], bindings: [{ key: 'd' }, { key: '3' }], label: 'Diamond', i18nKey: 'drawDiamond' },
      { commands: [], bindings: [{ key: 'o' }, { key: '4' }], label: 'Ellipse', i18nKey: 'drawEllipse' },
      { commands: [], bindings: [{ key: 'a' }, { key: '5' }], label: 'Arrow', i18nKey: 'drawArrow' },
      { commands: [], bindings: [{ key: 'l' }, { key: '6' }], label: 'Line', i18nKey: 'drawLine' },
      { commands: [], bindings: [{ key: 'p' }, { key: '7' }], label: 'Pen', i18nKey: 'drawPen' },
      { commands: [], bindings: [{ key: 't' }, { key: '8' }], label: 'Text', i18nKey: 'drawText' },
      { commands: [], bindings: [{ key: '9' }], label: 'Picture', i18nKey: 'drawPicture' },
      { commands: [], bindings: [{ key: 'e' }, { key: '0' }], label: 'Eraser', i18nKey: 'drawEraser' },
      { commands: [], bindings: [{ key: 'f' }], label: 'Frame', i18nKey: 'drawFrame' },
      { commands: [], bindings: [{ key: 'k' }], label: 'Laser pointer', i18nKey: 'drawLaser' },
      { commands: [], bindings: [{ key: 'q' }], label: 'Keep the tool after drawing', i18nKey: 'drawKeepTool' },
    ],
  },
  {
    title: 'Editing',
    i18nKey: 'drawEditing',
    rows: [
      { commands: [], bindings: [{ key: 'Enter' }, { key: 'Escape' }], label: 'Edit text / finish editing', i18nKey: 'drawEditText' },
      { commands: [], bindings: [{ mod: true, key: 'd' }], label: 'Duplicate', i18nKey: 'drawDuplicate' },
      { commands: [], bindings: [{ mod: true, key: 'g' }, { mod: true, shift: true, key: 'g' }], label: 'Group / ungroup', i18nKey: 'drawGroup' },
      { commands: [], bindings: [{ mod: true, key: '=' }, { mod: true, key: '-' }], label: 'Zoom in / out', i18nKey: 'drawZoom' },
      { commands: [], bindings: [{ mod: true, key: '0' }, { shift: true, key: '1' }], label: 'Reset zoom / zoom to fit', i18nKey: 'drawZoomReset' },
      { commands: [], bindings: [{ mod: true, key: 'f' }], label: 'Search the drawing', i18nKey: 'drawSearch' },
      { commands: ['undo', 'redo'], label: 'Undo / redo', i18nKey: 'drawUndo' },
      { commands: [], bindings: [{ key: '?' }], label: 'Show this list', i18nKey: 'drawHelp' },
    ],
  },
];

/** The last line of the in-app list in a browser, which shows no desktop-only key. */
export const DESKTOP_MORE_NOTE = 'The desktop app has more shortcuts: tabs, sections and new items.';

/**
 * The keys of a help row as runs of caps, with '/' between alternatives and
 * '–' inside a range. Empty when no key of the row applies (a desktop-only
 * row in a browser).
 */
export function rowCaps(
  row: HotkeyRow,
  os: KeyOs,
  desktop: boolean,
  /** The first key of each command only, for the printed sheet. */
  firstOnly = false,
): (string[] | '/' | '–')[] {
  if (row.range) {
    const keys = visibleBindings(row.commands[0]!, os, desktop);
    if (!keys.length) return [];
    return [bindingCaps(keys[0]!, os), '–', bindingCaps(keys[keys.length - 1]!, os)];
  }
  const out: (string[] | '/' | '–')[] = [];
  const lists = row.commands.map((id) => visibleBindings(id, os, desktop));
  if (row.bindings) lists.push(row.bindings.filter((b) => bindingApplies(b, os, desktop)));
  for (const keys of lists) {
    for (const b of firstOnly ? keys.slice(0, 1) : keys) {
      if (out.length) out.push('/');
      out.push(bindingCaps(b, os));
    }
  }
  return out;
}

/** A help row as one line of text: "J / K", "⌥⌘1 – ⌥⌘6", "Ctrl+H". */
export function rowText(row: HotkeyRow, os: KeyOs, desktop: boolean): string {
  return rowCaps(row, os, desktop)
    .map((part) => (typeof part === 'string' ? part : part.join(os === 'mac' ? '' : '+')))
    .join(' ');
}

