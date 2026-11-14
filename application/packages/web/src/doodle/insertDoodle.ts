/**
 * Insert > Doodle (issue #736): a new, empty doodle block at the caret, on
 * the paper and with the pen settings last used. A touch screen with no
 * pointer that hovers opens it full screen at once, where it is drawn.
 * Loaded on the first insert, with the rest of the doodle code.
 */
import type { Editor } from '@tiptap/core';
import { doodleState, setFullDoodle } from './doodleStore';
import { newDoodleId, serializeDoodle } from './doodleFormat';

export function insertDoodle(editor: Editor): void {
  const { pen } = doodleState();
  const id = newDoodleId();
  const text = serializeDoodle({ id, paper: pen.paper, style: pen.style, strokes: [] });
  editor.chain().focus().insertContent({ type: 'doodle', attrs: { text } }).run();
  if (typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches) setFullDoodle(id);
}
