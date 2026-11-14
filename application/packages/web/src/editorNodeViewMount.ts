import { Extension } from '@tiptap/core';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** What `ReactNodeViewRenderer` draws while `EditorContent` is not mounted:
 *  an empty span. Its attributes say nothing: ProseMirror puts its own on
 *  it, and so does every node decoration (the `dir` of a callout, see
 *  editorDirection). A React node view that can render is told apart by the
 *  class its element has from the start. */
function isPlaceholder(dom: Node | null): boolean {
  return dom instanceof HTMLSpanElement && !dom.firstChild && !dom.classList.contains('react-renderer');
}

/**
 * Keeps TipTap from drawing the whole note a second time when the editor
 * mounts.
 *
 * The view is built with every node view in place, except that a React node
 * view (a picture, a file, a note-link, a callout) cannot render before
 * `EditorContent` exists and draws an empty placeholder instead. When
 * `EditorContent` mounts, TipTap calls `createNodeViews()`, which hands the
 * view a new `nodeViews` object, and ProseMirror answers a changed object by
 * rebuilding every block: in a long checklist, every item rebuilt for the
 * sake of a few placeholders.
 *
 * Here only the placeholders are redrawn. A passing node decoration on each
 * makes ProseMirror visit that node, the placeholder's `update()` refuses,
 * and the node is drawn again through the same node view, which can now
 * render. Nothing else is touched, and no step enters the document, so the
 * note is not marked edited.
 *
 * When the view holds no node views (StrictMode's unmount in development
 * clears them), or anything here fails, TipTap's own rebuild runs.
 */
export const NodeViewMount = Extension.create({
  name: 'pnNodeViewMount',

  onBeforeCreate() {
    const editor = this.editor;
    const rebuild = editor.createNodeViews.bind(editor);
    editor.createNodeViews = () => {
      const view = editor.view;
      const held = view.props.nodeViews;
      if (!held || Object.keys(held).length === 0) {
        rebuild();
        return;
      }
      try {
        const marks: Decoration[] = [];
        view.state.doc.descendants((node, pos) => {
          if (held[node.type.name] && isPlaceholder(view.nodeDOM(pos))) {
            marks.push(Decoration.node(pos, pos + node.nodeSize, { 'data-pn-mount': '' }));
          }
          return true;
        });
        if (marks.length === 0) return;
        const own = view.props.decorations;
        const set = DecorationSet.create(view.state.doc, marks);
        view.setProps({ decorations: () => set });
        view.setProps({ decorations: own });
      } catch {
        rebuild();
      }
    };
  },
});
