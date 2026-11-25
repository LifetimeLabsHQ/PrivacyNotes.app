import type { ComponentType } from 'react';
import type { Editor } from '@tiptap/core';
import type { IconProps } from './icons';
import { formatInstant } from './intlFormat';

/**
 * The editor's own commands, for command mode and the keys: find, replace,
 * the outline, the connections, the Markdown view and the date inserts live inside the open
 * note's components, so the open note registers them here while it is on
 * screen, and the command list in the search field runs them. A command whose
 * entry is absent is not offered; the date inserts are absent while the note
 * cannot be edited.
 *
 * Spec: docs/internal/specs/keyboard-shortcuts.md (decision D5, command mode),
 * docs/internal/specs/dates.md (section 3.6)
 */
export const EDITOR_COMMAND_IDS = [
  'find', 'findReplace', 'outline', 'connections', 'markdownView', 'insertDate', 'insertDateTime',
] as const;
export type EditorCommand = (typeof EDITOR_COMMAND_IDS)[number];

export const editorCommands: Partial<Record<EditorCommand, () => void>> = {};

/** Registers a toggle and returns the call that removes it, unless a newer one replaced it. */
export function registerEditorCommand(id: EditorCommand, run: () => void): () => void {
  editorCommands[id] = run;
  return () => {
    if (editorCommands[id] === run) delete editorCommands[id];
  };
}

/** One live toolbar action published by the mounted editor for Ninja. */
export interface LiveEditorAction {
  key: string;
  label: string;
  icon: ComponentType<IconProps>;
  run: () => void;
}

let liveActionsGetter: (() => readonly LiveEditorAction[]) | null = null;

/** Registers the active editor toolbar's live Ninja actions getter (zero churn on transactions). */
export function registerEditorActions(getter: () => readonly LiveEditorAction[]): () => void {
  liveActionsGetter = getter;
  return () => {
    if (liveActionsGetter === getter) liveActionsGetter = null;
  };
}

/** Live editor actions offered in Ninja while an editable note toolbar is mounted. */
export function getLiveEditorActions(): readonly LiveEditorAction[] {
  return liveActionsGetter ? liveActionsGetter() : [];
}

/**
 * The date, or the date and time, in this device's date settings, at the caret
 * as plain text. A text node, not a string: the editor reads a string as
 * Markdown, and "6. Okt. 2026" is a numbered list there.
 */
export function insertDateText(editor: Editor, style: 'date' | 'dateTime'): void {
  editor.chain().focus().insertContent({ type: 'text', text: formatInstant(new Date(), style) }).run();
}
