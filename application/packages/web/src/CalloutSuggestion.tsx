/**
 * The callout menu at the caret (#680).
 *
 * Typing `[!` at the start of an empty line opens the toolbar's callout grid
 * there, filtered as the person keeps typing: `[!wa` leaves Warning first.
 * Enter or a click turns the line into that callout. Typing the whole
 * `[!warning] ` still works as before (the input rule in Callout.tsx): the
 * menu goes away at the `]`.
 *
 * The desktop apps' Mod+Shift+C (`insertCallout`) types the `[!` for the
 * person. One menu, two ways in, as the table formula menu does with `=`.
 *
 * A near-twin of NoteLinkSuggestion.tsx and FormulaSuggestion.tsx on purpose:
 * see the note at the top of FormulaSuggestion.tsx for why the shape is
 * copied rather than rediscovered.
 *
 * Spec: docs/contrib/callouts.md
 */

import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionOptions, type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/core';
import { PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import i18n from './i18n';
import { textMatcher } from './textMatch';
import { CALLOUT_PICKER_TYPES, type CalloutType, type CalloutTypeDef } from './calloutTypes';
import { CalloutGrid } from './CalloutGrid';
import { visibleBottom } from './usePopoverPosition';

const TRIGGER = '[!';
const COLUMNS = 3;

type CalloutItem = { type: CalloutType };

type GridProps = {
  items: CalloutItem[];
  command: (props: CalloutItem) => void;
};

type GridRef = { onKeyDown: (props: SuggestionKeyDownProps) => boolean };

const CalloutMenu = forwardRef<GridRef, GridProps>(({ items, command }, ref) => {
  const { t } = useTranslation('editor');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const types = items.map((i) => BY_TYPE.get(i.type)!);

  useEffect(() => setSelectedIndex(0), [items]);

  useEffect(() => {
    boxRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const last = items.length - 1;
      const move = (to: number) => {
        event.preventDefault();
        setSelectedIndex(Math.max(0, Math.min(last, to)));
        return true;
      };
      // The grid reads right to left in a right-to-left language, so the
      // arrow that points at the next cell does too.
      const rtl = boxRef.current ? getComputedStyle(boxRef.current).direction === 'rtl' : false;
      const step = rtl ? -1 : 1;
      if (event.key === 'ArrowRight') return move(selectedIndex + step);
      if (event.key === 'ArrowLeft') return move(selectedIndex - step);
      if (event.key === 'ArrowDown') return move(selectedIndex + COLUMNS);
      if (event.key === 'ArrowUp') return move(selectedIndex - COLUMNS);
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[selectedIndex];
        // Nothing matches: the person is typing a keyword of their own, and
        // the menu is not in the way.
        if (!item) return false;
        event.preventDefault();
        command(item);
        return true;
      }
      // Escape is the suggestion plugin's to handle.
      return event.key === 'Escape';
    },
  }));

  // No match draws nothing: `[!` followed by a keyword the picker does not
  // list is still a callout once the `]` and the space are typed.
  if (items.length === 0) return null;

  return (
    <div
      ref={boxRef}
      role="menu"
      aria-label={t('callout.pickerLabel')}
      className="bg-surface-1 border border-divider rounded-lg shadow-lg p-2 w-[240px] max-h-[min(420px,var(--room,calc(100dvh-16px)))] overflow-y-auto"
    >
      <CalloutGrid
        types={types}
        selected={selectedIndex}
        onHover={setSelectedIndex}
        onPick={(type) => command({ type })}
      />
    </div>
  );
});
CalloutMenu.displayName = 'CalloutMenu';

const BY_TYPE = new Map<CalloutType, CalloutTypeDef>(CALLOUT_PICKER_TYPES.map((c) => [c.type, c]));

/**
 * The picker's types that match what follows `[!`, the best match first, by
 * the name in the person's language or by the keyword itself (`seealso`).
 * An empty query lists them all, in the picker's order.
 */
export function calloutMatches(query: string): CalloutType[] {
  if (!query) return CALLOUT_PICKER_TYPES.map((c) => c.type);
  const match = textMatcher(query);
  return CALLOUT_PICKER_TYPES
    .map((c) => {
      const name = i18n.t(`editor:callout.types.${c.type}`);
      return { type: c.type, rank: Math.max(match(name)?.rank ?? 0, match(c.type)?.rank ?? 0) };
    })
    .filter((r) => r.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .map((r) => r.type);
}

/**
 * The menu opens only while the paragraph holds nothing but `[!` and letters:
 * the line the input rule would turn into a callout. A `[!` inside a sentence
 * stays text, and the `]` of a typed `[!warning]` closes the menu.
 */
export function allowCalloutSuggestion(state: EditorState, from: number): boolean {
  const $from = state.doc.resolve(from);
  if ($from.parent.type.name !== 'paragraph') return false;
  if (from !== $from.start()) return false;
  return /^\[![\w-]*$/.test($from.parent.textContent);
}

/**
 * Types `[!` where the menu can open: in the caret's paragraph when it is
 * empty, else in a new paragraph after the caret's block. Returns false when
 * the note is read only or no paragraph fits there.
 */
export function typeCalloutTrigger(editor: Editor): boolean {
  if (!editor.isEditable) return false;
  const { state, view } = editor;
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return false;
  const { $from } = state.selection;
  const tr = state.tr;
  let at: number;
  if ($from.parent.type === paragraph && $from.parent.content.size === 0) {
    at = $from.start();
  } else {
    const after = $from.after();
    const $after = state.doc.resolve(after);
    if (!$after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) return false;
    tr.insert(after, paragraph.create());
    at = after + 1;
  }
  tr.insertText(TRIGGER, at);
  tr.setSelection(TextSelection.create(tr.doc, at + TRIGGER.length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Build the suggestion options. Called from the Callout extension. */
export function calloutSuggestion(editor: Editor): ReturnType<typeof Suggestion> {
  const options: SuggestionOptions<CalloutItem, CalloutItem> = {
    pluginKey: new PluginKey('calloutSuggestion'),
    editor,
    char: TRIGGER,
    allowedPrefixes: null,
    allow: ({ state, range }) => allowCalloutSuggestion(state, range.from),

    items: ({ query }) => calloutMatches(query).map((type) => ({ type })),

    // The same steps as the `[!type] ` input rule in Callout.tsx.
    command: ({ editor: ed, range, props }) => {
      ed.chain().focus().deleteRange(range).insertCallout(props.type).run();
    },

    render: () => {
      let component: ReactRenderer<GridRef> | null = null;
      let popup: HTMLDivElement | null = null;
      let blurHandler: (() => void) | null = null;
      let dismissed = false;

      return {
        onStart(props: SuggestionProps<CalloutItem, CalloutItem>) {
          dismissed = false;
          mount(props);
        },

        onUpdate(props: SuggestionProps<CalloutItem, CalloutItem>) {
          if (!component && !dismissed) {
            mount(props);
            return;
          }
          component?.updateProps({ items: props.items, command: props.command });
          if (popup) updatePosition(popup, props.clientRect);
        },

        onKeyDown(props: SuggestionKeyDownProps) {
          if (props.event.key === 'Escape') {
            dismissed = true;
            cleanup();
            return true;
          }
          return component?.ref?.onKeyDown(props) ?? false;
        },

        onExit() {
          dismissed = false;
          cleanup();
        },
      };

      function mount(props: SuggestionProps<CalloutItem, CalloutItem>) {
        component = new ReactRenderer(CalloutMenu, {
          props: { items: props.items, command: props.command },
          editor: props.editor,
        });
        popup = document.createElement('div');
        popup.style.zIndex = '9999';
        // A mousedown inside the popup would blur the editor, and focusout
        // tears the popup down before the click handler can run.
        popup.addEventListener('mousedown', (e) => e.preventDefault());
        popup.appendChild(component.element);
        document.body.appendChild(popup);
        updatePosition(popup, props.clientRect);
        blurHandler = () => cleanup();
        props.editor.view.dom.addEventListener('focusout', blurHandler);
      }

      function cleanup() {
        if (blurHandler) {
          editor.view.dom.removeEventListener('focusout', blurHandler);
          blurHandler = null;
        }
        component?.destroy();
        component = null;
        popup?.remove();
        popup = null;
      }
    },
  };

  return Suggestion(options);
}

/** The grid's full height (CalloutMenu's max-h), which picks the side. */
const GRID_MAX = 420;

/**
 * Below the caret when the whole grid fits there, else on the side with more
 * room. Above the caret, the popup hangs from its bottom edge: the grid
 * shrinks as the filter narrows it, and a top edge measured before React drew
 * the smaller grid left it over the line being typed. `--room` caps the
 * grid's height to the space on its side.
 */
function updatePosition(popup: HTMLDivElement, clientRect?: (() => DOMRect | null) | null) {
  if (!clientRect) return;
  const rect = clientRect();
  if (!rect) return;
  // The keyboard counts: iOS does not shrink `innerHeight` for it.
  const below = visibleBottom() - rect.bottom - 12;
  const above = rect.top - 12;
  const under = below >= GRID_MAX || below >= above;
  popup.style.position = 'fixed';
  popup.style.top = under ? `${rect.bottom + 4}px` : '';
  popup.style.bottom = under ? '' : `${window.innerHeight - rect.top + 4}px`;
  popup.style.setProperty('--room', `${Math.max(under ? below : above, 120)}px`);
  popup.style.left = `${rect.left}px`;
  requestAnimationFrame(() => {
    const popupRect = popup.getBoundingClientRect();
    if (popupRect.right > window.innerWidth - 8) {
      popup.style.left = `${window.innerWidth - popupRect.width - 8}px`;
    }
  });
}
