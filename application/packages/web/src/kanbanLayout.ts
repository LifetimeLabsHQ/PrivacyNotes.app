/**
 * The layout a new Kanban board starts with, and the empty body of a new
 * Kanban task. No editor code here: the New menus and the empty-draft check
 * read it without loading the editor.
 * Spec: docs/internal/issues/0270.md (Spec)
 */

import { readKanbanPref } from './editorPrefs';
import { isColumnColor } from './calloutKeywords';

type Translate = (key: string) => string;

/** The color each slot of a new board starts with. */
export const DEFAULT_COLORS: Record<3 | 4, string[]> = {
  3: ['purple', 'blue', 'green'],
  4: ['purple', 'blue', 'orange', 'green'],
};

function slotKey(count: number, slot: number): string {
  const keys = count === 4 ? ['todo', 'inProgress', 'review', 'done'] : ['todo', 'inProgress', 'done'];
  return keys[slot] ?? keys[keys.length - 1]!;
}

/** The default name of `slot` in a board of `count` columns. */
export function slotName(t: Translate, count: number, slot: number): string {
  return t(`editor:kanban.${slotKey(count, slot)}`);
}

/** The look icon each default slot starts with, before its name in the
 *  title (`:icon[eye] Review`). GitHub #752. */
const SLOT_ICONS: Record<string, string> = {
  todo: 'clipboard-text',
  inProgress: 'person-simple-run',
  review: 'eye',
  done: 'check-circle',
};

/** The icon of `slot` in a board of `count` columns. */
export function slotIcon(count: number, slot: number): string {
  return SLOT_ICONS[slotKey(count, slot)]!;
}

/** A new board: the count and colors of the last board on this device, the
 *  default names in the reader's language. */
export function startLayout(t: Translate): { names: string[]; colors: string[]; icons: string[] } {
  const pref = readKanbanPref();
  const count = pref?.count ?? 3;
  const colors = DEFAULT_COLORS[count].map((c, i) => (isColumnColor(pref?.colors[i]) ? pref!.colors[i]! : c));
  const slots = Array.from({ length: count }, (_, i) => i);
  return { names: slots.map((i) => slotName(t, count, i)), colors, icons: slots.map((i) => slotIcon(count, i)) };
}

/** The body a new Kanban task starts with, in the form the editor saves an
 *  untouched board, so the draft check below can tell it from content. */
export function kanbanEmptyBody(t: Translate): string {
  const { names, colors, icons } = startLayout(t);
  const columns = names.map((name, i) => `> > [!column|${colors[i]}]+ :icon[${icons[i]}] ${name}\n> > - [ ] &nbsp;`).join('\n>\n');
  return `> [!kanban]+\n${columns}\n\n&nbsp;`;
}

const UNTOUCHED_KANBAN = /^> \[!kanban\]\+\n(?:> > \[!column(?:\|[\w-]+)?\]\+[^\n]*\n> > - \[ \] &nbsp;(?:\n>\n|\n\n))+&nbsp;$/;

/** A board with only its column titles and one empty card line each: the
 *  body of a Kanban task nobody wrote in yet. */
export function isUntouchedKanbanBody(body: string): boolean {
  return UNTOUCHED_KANBAN.test(body);
}
