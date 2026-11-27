/**
 * Inline `#tag` decorations and click-to-filter inside the TipTap editor.
 *
 * Nothing here touches the document: `#tag` stays plain Markdown text, so
 * copy/paste, undo, find/replace, source mode and older app versions work with
 * zero serialization changes.
 *
 * Clicking follows the inline-code / link-modifier convention:
 * - While editing: Cmd-click (Ctrl-click off a Mac) filters by that tag, so a
 *   plain click still places the caret to fix typos.
 * - Read-only: a plain click filters by that tag.
 *
 * Hover carries `data-pn-tip` and is rendered by `LinkAddressPill.tsx` via
 * `placeFixedTip` (fixed portal clamped inside `visibleBox`), so the tooltip
 * never clips at the editor margin or sticky bars and adds zero DOM text inside
 * contenteditable.
 */
import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import i18n from './i18n';
import { isMac, isOpenLinkModifier } from './devices';
import { findInlineTagSpansInText } from './inlineTags';
import { isLookColor, tagLookKey, type ItemStyles } from './itemStyles';

const inlineTagsKey = new PluginKey<{
  editable: boolean;
  styles: ItemStyles | undefined;
  decorations: DecorationSet;
}>('inlineTags');

const STYLES_KEY = '__inlineTagStyles';
const ON_SELECT_KEY = '__inlineTagOnSelect';
const REFRESH_META = 'inlineTagsRefresh';

function inlineTagStore(editor: { storage: unknown }): Record<string, unknown> | undefined {
  return (editor.storage as Record<string, Record<string, unknown>>).inlineTags;
}

/** Sync tag look styles, click callback, and editable-dependent tooltips into
 *  the editor's InlineTags plugin. Dispatches a lightweight metadata-only
 *  transaction only when something actually changed. */
export function syncInlineTagState(
  editor: Editor | null,
  opts: {
    styles?: ItemStyles;
    onSelect?: ((tag: string) => void) | undefined;
  },
): void {
  if (!editor || editor.isDestroyed) return;
  const store = inlineTagStore(editor);
  if (!store) return;
  const prevStyles = store[STYLES_KEY] as ItemStyles | undefined;
  const prevClickable = typeof store[ON_SELECT_KEY] === 'function';
  const nextClickable = typeof opts.onSelect === 'function';
  store[STYLES_KEY] = opts.styles;
  store[ON_SELECT_KEY] = opts.onSelect;
  const pluginState = inlineTagsKey.getState(editor.state);
  const editableChanged = pluginState ? pluginState.editable !== editor.isEditable : false;
  if (prevStyles !== opts.styles || prevClickable !== nextClickable || editableChanged) {
    editor.view.dispatch(editor.state.tr.setMeta(REFRESH_META, true));
  }
}

/** Hover tooltip label and optional hotkey for an inline `#tag` pill.
 *  Matches `HoverLabel` / `EncryptedImage` (`⌘-click` on Mac, `Ctrl-click` elsewhere). */
export function inlineTagHint(editable: boolean): { label: string; keys?: string } {
  const label = i18n.t('editor:inlineTag.filter');
  return editable ? { label, keys: isMac() ? '⌘-click' : 'Ctrl-click' } : { label };
}

/** Walk every valid inline `#tag` span in a ProseMirror document (skipping code
 *  blocks, headings, inline code and links) with exact document positions. */
export function forEachInlineTagInDoc(
  doc: ProseMirrorNode,
  visit: (span: { tag: string; from: number; to: number }) => void,
): void {
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock' || node.type.name === 'heading') {
      return false;
    }
    if (!node.isText || !node.text || !node.text.includes('#')) return;
    if (node.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) {
      return;
    }
    // Inspect the character immediately before this text node in the same
    // textblock so `**foo**#tag` does not falsely match while `**foo **#tag`
    // does.
    const text = node.text;
    const $pos = doc.resolve(pos);
    const blockStart = $pos.start();
    const prefix = pos === blockStart
      ? ''
      : (doc.textBetween(pos - 1, pos, '\0', '\0') || '\0');
    const spans = findInlineTagSpansInText(prefix + text);
    const offset = -prefix.length;
    for (const span of spans) {
      const from = pos + span.from + offset;
      const to = pos + span.to + offset;
      if (from < pos || to > pos + text.length) continue;
      visit({ tag: span.tag, from, to });
    }
  });
}

function buildDecorations(
  doc: ProseMirrorNode,
  editable: boolean,
  styles: ItemStyles | undefined,
  clickable: boolean,
): DecorationSet {
  const decos: Decoration[] = [];
  const tip = clickable ? inlineTagHint(editable) : null;

  forEachInlineTagInDoc(doc, ({ tag, from, to }) => {
    const color = styles?.[tagLookKey(tag)]?.color?.v;
    const attrs: Record<string, string> = {
      class: 'pn-inline-tag',
      'data-inline-tag': tag,
    };
    if (tip) {
      attrs['data-pn-tip'] = tip.label;
      if (tip.keys) attrs['data-pn-tip-keys'] = tip.keys;
    }
    if (isLookColor(color)) attrs['data-pn-tag-color'] = color;
    decos.push(Decoration.inline(from, to, attrs));
  });

  return DecorationSet.create(doc, decos);
}

/** Find the inline `#tag` at `pos`, or null if `pos` is outside one. */
export function inlineTagAt(doc: ProseMirrorNode, pos: number): string | null {
  const $pos = doc.resolve(pos);
  // Skip code blocks and headings.
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'codeBlock' || name === 'heading') return null;
  }
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const blockStart = $pos.start();
  let found: string | null = null;
  parent.forEach((child, offset) => {
    if (found !== null || !child.isText || !child.text || !child.text.includes('#')) return;
    if (child.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) return;
    const nodeStart = blockStart + offset;
    const nodeEnd = nodeStart + child.text.length;
    if (pos < nodeStart || pos > nodeEnd) return;
    const prefix = offset === 0
      ? ''
      : (doc.textBetween(nodeStart - 1, nodeStart, '\0', '\0') || '\0');
    const spans = findInlineTagSpansInText(prefix + child.text);
    const shift = -prefix.length;
    for (const span of spans) {
      const from = nodeStart + span.from + shift;
      const to = nodeStart + span.to + shift;
      if (pos >= from && pos <= to) {
        found = span.tag;
        return;
      }
    }
  });
  return found;
}

export const InlineTags = Extension.create({
  name: 'inlineTags',

  addStorage() {
    return {
      [STYLES_KEY]: undefined as ItemStyles | undefined,
      [ON_SELECT_KEY]: undefined as ((tag: string) => void) | undefined,
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: inlineTagsKey,
        state: {
          init(_config, state) {
            const store = inlineTagStore(editor);
            const styles = store?.[STYLES_KEY] as ItemStyles | undefined;
            const clickable = typeof store?.[ON_SELECT_KEY] === 'function';
            const editable = editor.isEditable;
            return {
              editable,
              styles,
              decorations: buildDecorations(state.doc, editable, styles, clickable),
            };
          },
          apply(tr, prev, _oldState, newState) {
            const store = inlineTagStore(editor);
            const styles = store?.[STYLES_KEY] as ItemStyles | undefined;
            const clickable = typeof store?.[ON_SELECT_KEY] === 'function';
            const editable = editor.isEditable;
            const needsRebuild =
              tr.docChanged
              || Boolean(tr.getMeta(REFRESH_META))
              || editable !== prev.editable
              || styles !== prev.styles;
            if (!needsRebuild) return prev;
            return {
              editable,
              styles,
              decorations: buildDecorations(newState.doc, editable, styles, clickable),
            };
          },
        },
        props: {
          decorations(state) {
            return inlineTagsKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
          handleClick(view, pos, event) {
            if (event.button !== 0) return false;
            const onSelect = inlineTagStore(editor)?.[ON_SELECT_KEY] as ((tag: string) => void) | undefined;
            if (!onSelect) return false;
            if (view.editable && !isOpenLinkModifier(event)) return false;
            const tag = inlineTagAt(view.state.doc, pos);
            if (!tag) return false;
            event.preventDefault();
            onSelect(tag);
            return true;
          },
        },
      }),
    ];
  },
});
