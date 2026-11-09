import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Read the DOM selection into the editor now, before a transaction or a
 * ProseMirror check can write the editor's older caret back over it. A click
 * moves the caret in the DOM first and the editor reads it on the next
 * selectionchange. `flush` is ProseMirror's own read of the DOM; it is not in
 * the public types.
 */
export function readDomSelection(view: EditorView): void {
  (view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
}

/** How recent a pointer press must be to count as the cause of a focus. */
const CLICK_FOCUS_MS = 500;

/**
 * A click back into the app from another window keeps the caret where it
 * landed. 20 ms after a focus, ProseMirror writes its own caret to the DOM if
 * the DOM caret differs from the last one it read. The focus work (TipTap's
 * focus transaction, the React render it starts) can keep the main thread
 * busy past those 20 ms; the click then runs first, as input does, and its
 * selectionchange waits behind the overdue check, which puts the old caret
 * back. This timer has the same delay and is set before ProseMirror's (custom
 * handlers run before the built-in one), so it runs first and reads the click.
 * A focus with no press (Tab, a script) keeps ProseMirror's own handling.
 * Fix: GitHub #600
 */
export const FocusClickCaret = Extension.create({
  name: 'focusClickCaret',
  priority: 1000,
  addProseMirrorPlugins() {
    let pressedAt = -Infinity;
    return [
      new Plugin({
        key: new PluginKey('focusClickCaret'),
        props: {
          handleDOMEvents: {
            pointerdown: () => {
              pressedAt = Date.now();
              return false;
            },
            focus: (view) => {
              setTimeout(() => {
                if (!view.isDestroyed && Date.now() - pressedAt < CLICK_FOCUS_MS) readDomSelection(view);
              }, 20);
              return false;
            },
          },
        },
      }),
    ];
  },
});
