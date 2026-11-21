import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** What the helper needs of an editor: a node view's narrow view of one is enough. */
export type TextTarget = {
  state: { doc: ProseMirrorNode };
  commands: { insertContentAt: (pos: number, content: { type: string; content?: unknown[] }[]) => boolean };
};

/**
 * A plugin's text into the note, as plain paragraphs right after the node at
 * `pos` (the picture or the file chip it came from), one paragraph per line.
 * Plain text nodes, never parsed as HTML or Markdown: the text came from a
 * picture or a recording, not from the person.
 * Spec: docs/internal/plans/plugins.md (sections 6.4 and 6.6)
 */
export function insertTextAfter(editor: TextTarget, pos: number, text: string): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) throw new Error('gone');
  const paragraphs = toParagraphs(text);
  if (paragraphs.length) editor.commands.insertContentAt(pos + node.nodeSize, paragraphs);
}

/** The same paragraphs at a cursor position, for a scan kept as text only. */
export function insertTextAt(editor: TextTarget, pos: number, text: string): void {
  const paragraphs = toParagraphs(text);
  if (paragraphs.length) editor.commands.insertContentAt(Math.min(pos, editor.state.doc.content.size), paragraphs);
}

function toParagraphs(text: string) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] }));
}
