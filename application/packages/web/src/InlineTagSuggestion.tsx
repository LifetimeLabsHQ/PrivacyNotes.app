/**
 * In-editor `#` inline-tag autocomplete popup.
 *
 * Typing `#` at block start or after whitespace opens the same tag dropdown
 * used by the top tag bar (`TagSuggestionMenu`), positioned at the caret via
 * `placeAtCaret`. Choosing a tag inserts `#tag ` as plain text.
 *
 * Stays out of the way of Markdown headings (`# `, `## `), code blocks, inline
 * code, links, unclosed `[[` note-links, and numeric tokens (`#1`, `#2026`).
 */
import { Extension, type Editor } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps,
} from '@tiptap/suggestion';
import { PluginKey, TextSelection } from '@tiptap/pm/state';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { isValidInlineTag } from './inlineTags';
import { TagSuggestionMenu } from './TagSuggestionMenu';
import { textMatcher } from './textMatch';
import { placeAtCaret } from './usePopoverPosition';
import { useIsMobile } from './useIsMobile';

const ALL_TAGS_KEY = '__inlineTagAllTags';
const MAX_SUGGESTIONS = 5;

function inlineTagSuggestionStore(editor: { storage: unknown }): Record<string, unknown> | undefined {
  return (editor.storage as Record<string, Record<string, unknown>>).inlineTagSuggestion;
}

/** Feed the vault's `[tag, count]` list into the editor's `#` autocomplete. */
export function setInlineTagSuggestions(
  editor: { storage: unknown } | null,
  allTags: [string, number][],
): void {
  if (!editor) return;
  const store = inlineTagSuggestionStore(editor);
  if (!store || store[ALL_TAGS_KEY] === allTags) return;
  store[ALL_TAGS_KEY] = allTags;
}

function getAllTags(editor: { storage: unknown }): [string, number][] {
  return (inlineTagSuggestionStore(editor)?.[ALL_TAGS_KEY] as [string, number][] | undefined) ?? [];
}

/** Allowed characters inside an inline tag query while typing after `#`. */
const QUERY_CHARS_RE = /^[\p{L}\p{N}_/-]*$/u;
const INLINE_TAG_CHAR_RE = /^[\p{L}\p{N}_/-]/u;

type TagItem = { tag: string; count: number; create?: boolean };

type ListProps = {
  items: TagItem[];
  query: string;
  command: (props: TagItem) => void;
};

type ListRef = { onKeyDown: (props: SuggestionKeyDownProps) => boolean };

const InlineTagList = forwardRef<ListRef, ListProps>(({ items, query, command }, ref) => {
  const isMobile = useIsMobile();
  const suggestions = useMemo(
    () => items.filter((i) => !i.create).map((i) => [i.tag, i.count] as [string, number]),
    [items],
  );
  const createItem = useMemo(() => items.find((i) => i.create) ?? null, [items]);
  const totalRows = suggestions.length + (createItem ? 1 : 0);

  // When query is empty (bare `#`), start with nothing highlighted (-1) so
  // pressing Enter/Space immediately stays natural; once the user types letters,
  // highlight the top match (0) for fast Enter/Tab completion.
  const [highlightIndex, setHighlightIndex] = useState(() => (query.length > 0 ? 0 : -1));

  useEffect(() => {
    setHighlightIndex(query.length > 0 && totalRows > 0 ? 0 : -1);
  }, [query, totalRows]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      if (totalRows === 0) return false;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightIndex((i) => (i + 1) % totalRows);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightIndex((i) => (i <= 0 ? totalRows - 1 : i - 1));
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (highlightIndex < 0) return false;
        const chosen = highlightIndex < suggestions.length
          ? { tag: suggestions[highlightIndex]![0], count: suggestions[highlightIndex]![1] }
          : createItem;
        if (!chosen) return false;
        event.preventDefault();
        command(chosen);
        return true;
      }
      return event.key === 'Escape';
    },
  }), [totalRows, highlightIndex, suggestions, createItem, command]);

  if (totalRows === 0) return null;

  return (
    <TagSuggestionMenu
      suggestions={suggestions}
      query={query}
      showCreate={Boolean(createItem)}
      highlightIndex={highlightIndex}
      onSelect={(tag) => {
        const hit = suggestions.find(([t]) => t === tag);
        if (hit) command({ tag: hit[0], count: hit[1] });
      }}
      onCreate={() => {
        if (createItem) command(createItem);
      }}
      onHover={setHighlightIndex}
      isMobile={isMobile}
    />
  );
});
InlineTagList.displayName = 'InlineTagList';

/** Build the inline `#tag` suggestion list for `query` from `allTags`. */
export function buildInlineTagItems(
  allTags: readonly [string, number][],
  query: string,
): TagItem[] {
  const inlineTags = allTags.filter(([t]) => isValidInlineTag(t));
  let matched: [string, number][];
  if (!query) {
    matched = [...inlineTags]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_SUGGESTIONS);
  } else {
    const match = textMatcher(query);
    matched = inlineTags
      .map((entry) => ({ entry, hit: match(entry[0]) }))
      .filter((x) => x.hit !== null)
      .sort((a, b) => (b.hit!.rank - a.hit!.rank) || (b.entry[1] - a.entry[1]) || a.entry[0].localeCompare(b.entry[0]))
      .slice(0, MAX_SUGGESTIONS)
      .map((x) => x.entry);
  }

  const items: TagItem[] = matched.map(([tag, count]) => ({ tag, count }));
  const lower = query.toLowerCase();
  const exactExists = inlineTags.some(([t]) => t.toLowerCase() === lower);
  if (query && isValidInlineTag(query) && !exactExists) {
    items.push({ tag: query, count: 0, create: true });
  }
  return items;
}

/** Check whether the caret range is a valid `#` inline-tag trigger context. */
export function allowInlineTagSuggestion(
  state: Editor['state'],
  range: { from: number; to: number },
): boolean {
  const $from = state.doc.resolve(range.from);
  // Skip code blocks and headings.
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'codeBlock' || name === 'heading') return false;
  }
  // Skip inline code and link marks.
  if ($from.marks().some((m) => m.type.name === 'code' || m.type.name === 'link')) {
    return false;
  }
  const blockStart = $from.start();
  const before = state.doc.textBetween(blockStart, range.from, '\0', '\0');
  // Must sit at start of block or right after whitespace, `(` or `[`.
  if (before.length > 0 && !/[\s(\[]$/.test(before)) return false;
  // Never trigger inside an unclosed `[[` note-link (where `[[#` lists headings).
  const lastOpen = before.lastIndexOf('[[');
  if (lastOpen !== -1 && before.indexOf(']]', lastOpen + 2) === -1) return false;
  // Query after `#`: reject double `##`, spaces, digits at start, or non-tag punctuation.
  const typed = state.doc.textBetween(range.from, range.to, '\0', '\0');
  if (!typed.startsWith('#')) return false;
  const query = typed.slice(1);
  if (!QUERY_CHARS_RE.test(query)) return false;
  if (query.length > 0 && !/^[\p{L}_]/u.test(query)) return false;
  // Don't pop open mid-word when clicking inside an already-typed `#tag`.
  const blockEnd = $from.end();
  if (range.to < blockEnd) {
    const nextChar = state.doc.textBetween(range.to, Math.min(range.to + 1, blockEnd), '\0', '\0');
    if (INLINE_TAG_CHAR_RE.test(nextChar)) return false;
  }
  return true;
}

function createInlineTagSuggestion(editor: Editor) {
  const options: SuggestionOptions<TagItem, TagItem> = {
    pluginKey: new PluginKey('inlineTagSuggestion'),
    editor,
    char: '#',
    allowedPrefixes: null,
    allowSpaces: false,

    allow: ({ state, range }) => allowInlineTagSuggestion(state, range),

    items: ({ query, editor: ed }) => buildInlineTagItems(getAllTags(ed), query),

    command: ({ editor: ed, range, props }) => {
      const insert = `#${props.tag} `;
      const tr = ed.state.tr.insertText(insert, range.from, range.to);
      const pos = Math.min(range.from + insert.length, tr.doc.content.size);
      tr.setSelection(TextSelection.create(tr.doc, pos));
      ed.view.dispatch(tr);
    },

    render: () => {
      let component: ReactRenderer<ListRef, ListProps> | null = null;
      let popup: HTMLDivElement | null = null;
      let dismissed = false;

      const destroyPopup = () => {
        popup?.remove();
        popup = null;
        component?.destroy();
        component = null;
      };

      const mountPopup = (props: SuggestionProps<TagItem, TagItem>) => {
        if (props.items.length === 0) {
          destroyPopup();
          return;
        }
        if (!component || !popup) {
          component = new ReactRenderer(InlineTagList, {
            props: {
              items: props.items,
              query: props.query,
              command: props.command,
            },
            editor: props.editor,
          });
          popup = document.createElement('div');
          popup.style.position = 'fixed';
          popup.style.zIndex = '50';
          popup.appendChild(component.element);
          document.body.appendChild(popup);
        } else {
          component.updateProps({
            items: props.items,
            query: props.query,
            command: props.command,
          });
        }
        const rect = props.clientRect?.();
        if (rect && popup) {
          placeAtCaret(popup, rect);
        }
      };

      return {
        onStart: (props) => {
          dismissed = false;
          mountPopup(props);
        },
        onUpdate: (props) => {
          if (dismissed) return;
          mountPopup(props);
        },
        onKeyDown: (props) => {
          if (props.event.key === 'Escape') {
            dismissed = true;
            destroyPopup();
            return true;
          }
          if (dismissed || !component) return false;
          return component.ref?.onKeyDown(props) ?? false;
        },
        onExit: () => {
          dismissed = false;
          destroyPopup();
        },
      };
    },
  };

  return Suggestion(options);
}

export const InlineTagSuggestion = Extension.create({
  name: 'inlineTagSuggestion',

  addStorage() {
    return {
      [ALL_TAGS_KEY]: [] as [string, number][],
    };
  },

  addProseMirrorPlugins() {
    return [createInlineTagSuggestion(this.editor)];
  },
});
