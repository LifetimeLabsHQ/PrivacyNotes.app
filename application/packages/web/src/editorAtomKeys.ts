import type { Editor } from '@tiptap/core';
import type { NodeType } from '@tiptap/pm/model';

/**
 * Backspace and Delete for an inline atom (a note-link pill, an icon): one
 * plain transaction that removes the atom next to the caret.
 *
 * With no handler, the browser decides what deleting next to an uneditable
 * atom does. prosemirror-view carries a workaround for that deletion failing
 * on Chrome and Firefox for Android, and the workaround only runs when the
 * browser left the DOM untouched, so the outcome there is a race: the atom
 * goes, or it stays, or the text around it moves.
 */
export function atomDeleteKeys(editor: Editor, type: NodeType) {
  const removeAdjacent = (before: boolean) => () =>
    editor.commands.command(({ tr, state }) => {
      const { empty, $anchor } = state.selection;
      if (!empty) return false;
      const node = before ? $anchor.nodeBefore : $anchor.nodeAfter;
      if (!node || node.type !== type) return false;
      const from = before ? $anchor.pos - node.nodeSize : $anchor.pos;
      tr.delete(from, from + node.nodeSize);
      return true;
    });
  return { Backspace: removeAdjacent(true), Delete: removeAdjacent(false) };
}
