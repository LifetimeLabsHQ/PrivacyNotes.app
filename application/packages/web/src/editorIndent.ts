import type { Editor as TipTapEditor } from '@tiptap/react';
import { Extension } from '@tiptap/core';

/**
 * Indent (dir 1) or outdent (dir -1) the list item the cursor sits in,
 * whatever kind of list it is.
 *
 * `sinkListItem` and `liftListItem` take the item's node TYPE, and the Tab
 * handler in Editor.tsx passed a hard-coded 'listItem' - the bullet and
 * numbered item type. Inside a CHECKLIST both commands therefore failed and
 * Tab was a swallowed no-op. Nothing else was missing: TaskItem is
 * configured `nested: true`, TaskListWithMarkdown's serializer already
 * writes the two-space child indent, markdown-it parses it back, and the
 * taskList CSS already renders the levels. There was just no key that
 * reached it, so nested checklists could only be made in the markdown pane.
 *
 * The type is read from the innermost list-item ancestor rather than from
 * `editor.isActive`, because both types can be active at once - a bullet
 * list nested inside a checklist item, or the reverse - and `isActive`
 * cannot say which one the cursor is actually in. Walking out from the
 * cursor always finds the item Tab should move.
 */
export function indentListItem(editor: TipTapEditor, dir: number): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name !== 'listItem' && name !== 'taskItem') continue;
    return dir < 0
      ? editor.chain().focus().liftListItem(name).run()
      : editor.chain().focus().sinkListItem(name).run();
  }
  return false;
}

/** What one Tab press adds outside a list or a table. */
const TAB_INDENT = '    ';

/**
 * Tab in a paragraph or a code block adds TAB_INDENT at the caret, and
 * Shift+Tab removes up to that many spaces before it. Markdown keeps no
 * leading spaces in a heading, so a heading is left alone, and so is a list,
 * where Tab moves the item instead. A range selection is left alone too, so
 * a stray Tab never replaces selected text.
 */
export function indentText(editor: TipTapEditor, dir: number): boolean {
  const { selection } = editor.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  const parent = $from.parent.type.name;
  if (parent !== 'paragraph' && parent !== 'codeBlock') return false;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === 'listItem' || name === 'taskItem') return false;
  }
  if (dir > 0) {
    return editor.chain().focus().command(({ tr }) => {
      tr.insertText(TAB_INDENT);
      return true;
    }).run();
  }
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const run = /[ \u00a0]{1,4}$/.exec(before)?.[0].length ?? 0;
  if (run === 0) return false;
  return editor.chain().focus().deleteRange({ from: $from.pos - run, to: $from.pos }).run();
}

/**
 * Enter on the empty first line of a list item that still holds more, such
 * as a sub-list, lifts the item one level (#709). Enter at the end of an item
 * with a sub-list makes a new empty item, and the sub-list moves into it.
 * TipTap's `splitListItem` lifts an empty item only when the empty line is
 * the item's LAST child, so it split again on every Enter and the list never
 * ended. Word ends it here: the line leaves the list, and the sub-list stays
 * below it. Any other Enter falls through to the stock rule.
 */
function liftEmptyListItem(editor: TipTapEditor): boolean {
  const { selection } = editor.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if ($from.depth < 2 || !$from.parent.isTextblock || $from.parent.content.size > 0) return false;
  const item = $from.node(-1);
  const name = item.type.name;
  if (name !== 'listItem' && name !== 'taskItem') return false;
  if ($from.index(-1) !== 0 || item.childCount < 2) return false;
  return editor.commands.liftListItem(name);
}

/** Runs `liftEmptyListItem` before the list items' own Enter. */
export const EmptyListItemEnter = Extension.create({
  name: 'emptyListItemEnter',
  priority: 1000,
  addKeyboardShortcuts() {
    return { Enter: () => liftEmptyListItem(this.editor) };
  },
});
