import type { LocalNote } from './db';
import { getFolderGroupLabels } from './folderNames';
import { toLocalIso } from './intlFormat';
import { orderNotesForGroup } from './ListGroupHeader';
import type { ListPrefs } from './listPrefs';
import { parseDay } from './localDate';
import { getViewOrder } from './viewRows';
import { compareNotes, deriveDisplayTitle, editedAtOf } from './notesViewUtils';
import { nextFence, type Fence } from './markdownFence';
import { createNote, getNote, updateNoteFrom } from './notesRepo';
import { textMatcher } from './textMatch';
import { escapeMarkdownText, guardMarkdownLineStart } from './markdownEscape';
import { activeLocale } from './languages';
import {
  extractTaskReminder,
  nextTaskReminder,
  replaceTaskReminderInText,
  type TaskReminder,
} from './taskReminderSyntax';

/**
 * Tasks as a derived view over existing notes.
 *
 * We don't store tasks as their own entity. Every `- [ ] …` / `- [x] …`
 * line in any note's markdown body is a task; this module parses those
 * lines out of the live notes list and lets the UI render them as a
 * grouped checklist.
 *
 * Flipping a task re-writes the note's body (replacing `[ ]` with `[x]`
 * or vice versa on the same line index, while that line still holds the
 * task) and routes through the normal note write (updateNoteFrom) so sync /
 * dirty flags just work.
 *
 * Matches TipTap's markdown serialization: one leading list marker
 * (`-`, `*`, `+`) + space + `[ ]` or `[x]` + space + content. Ordered
 * task lines (`1. [ ] …`) are intentionally NOT matched - TipTap's
 * tiptap-markdown doesn't emit those and treating them as tasks would
 * capture a numbered-list-with-brackets-in-the-text by accident.
 */

const TASK_LINE = /^(\s*)([-*+])\s+\[([ xX])\]\s?(.*)$/;

/** The quote markers a line starts with: a task inside a quote, a callout or
 *  a Kanban board is written `> > - [ ] ...`, and it is a task all the same. */
const QUOTE_PREFIX = /^(?:>[ \t]?)*/;

/** A task line with its quote markers split off, or null for any other line.
 *  Groups as TASK_LINE: indent, marker, box, text; `quote` is the prefix. */
function matchTask(line: string): (RegExpMatchArray & { quote: string }) | null {
  const quote = line.match(QUOTE_PREFIX)![0];
  const m = line.slice(quote.length).match(TASK_LINE);
  return m ? Object.assign(m, { quote }) : null;
}

export type TaskItem = {
  noteId: string;
  noteTitle: string;
  lineIdx: number; // 0-based line index inside the note's body
  text: string; // task content, no marker, no checkbox
  checked: boolean;
  /** The parent note's "last edited" date, for sorting. */
  editedAt: string;
  /** Parsed inline `:remind[...]` reminder on this task line, if any. */
  reminder?: TaskReminder;
};

/**
 * Extract every task line from a single note body.
 */
function extractTasksFromNote(note: LocalNote): TaskItem[] {
  if (!note.body) return [];
  const out: TaskItem[] = [];
  const lines = note.body.split(/\r?\n/);
  // The notes list's own derivation, so a titleless note is called the same
  // thing in both places - and so the group header cannot print raw markdown
  // or HTML, which the hand-rolled first-line copy that used to live here did.
  const title = deriveDisplayTitle(note);
  const prose = outsideFences(lines);
  for (let i = 0; i < lines.length; i++) {
    const m = prose[i] ? matchTask(lines[i]!) : null;
    if (!m) continue;
    const text = taskText(m[4]);
    const reminder = extractTaskReminder(text) ?? undefined;
    out.push({
      noteId: note.id,
      noteTitle: title,
      lineIdx: i,
      text,
      checked: m[3] === 'x' || m[3] === 'X',
      editedAt: editedAtOf(note),
      ...(reminder ? { reminder } : {}),
    });
  }
  return out;
}

/**
 * Extract tasks across a set of notes. Caller is expected to pass the
 * active (non-trashed) notes. Trashed notes' tasks don't show up in the
 * Tasks view - if you trashed the note, you trashed its tasks too.
 */
const parsedTasks = new WeakMap<LocalNote, { body: string; title: string | null | undefined; editedAt: string; locale: string; tasks: TaskItem[] }>();

export function extractAllTasks(notes: LocalNote[]): TaskItem[] {
  const all: TaskItem[] = [];
  const locale = activeLocale();
  for (const n of notes) {
    const editedAt = editedAtOf(n);
    let parsed = parsedTasks.get(n);
    if (!parsed || parsed.body !== n.body || parsed.title !== n.title || parsed.editedAt !== editedAt || parsed.locale !== locale) {
      parsed = { body: n.body, title: n.title, editedAt, locale, tasks: extractTasksFromNote(n) };
      parsedTasks.set(n, parsed);
    }
    for (const t of parsed.tasks) all.push(t);
  }
  return all;
}

/**
 * The Tasks pillar's note list: notes that carry task lines, plus notes
 * typed 'task' (so a task note stays visible once its last checkbox is
 * removed rather than becoming a ghost). Narrowed by the search box, the
 * "tasks from notes" switch and the read-only / PIN-protected toggles,
 * ordered by the shared notes comparator.
 *
 * Lives here rather than inside TasksList because NotesView derives the
 * same list to drive multi-select (shift-range, select-all). The two
 * hand-rolled copies had drifted apart on filtering, folder scope and
 * order, so multi-select could address rows the user could not see; one
 * selector makes them identical by construction.
 *
 * `isGated` is the view's lock predicate. A note the PIN guards right now
 * matches the search by its title alone, because its body is past the gate.
 */
export function selectTaskNotes(
  activeNotes: LocalNote[],
  allTasks: TaskItem[],
  search: string,
  listPrefs: ListPrefs,
  isGated: (n: LocalNote) => boolean,
): LocalNote[] {
  const q = search.trim();
  const withTasks = new Set<string>();
  for (const t of allTasks) withTasks.add(t.noteId);
  let matching = activeNotes.filter(
    (n) => withTasks.has(n.id) || n.type === 'task'
  );
  // A note typed 'task' is a list the user made in this pillar; anything else
  // in here is an ordinary note that happens to carry a checkbox. The switch
  // keeps the second kind out, so a recipe does not sit among the to-dos.
  if (!listPrefs.showNoteTasks) matching = matching.filter((n) => n.type === 'task');
  if (!listPrefs.showLocked) matching = matching.filter((n) => n.locked !== 1);
  if (!listPrefs.showProtected)
    matching = matching.filter((n) => n.pinProtected !== 1);
  if (q) {
    const match = textMatcher(q);
    matching = matching.filter((n) => match(n.title ?? '') || (!isGated(n) && match(n.body)));
  }
  const sorted = matching.slice().sort((a, b) => compareNotes(a, b, listPrefs));
  if (!q) {
    return orderNotesForGroup(sorted, {
      view: 'tasks',
      listPrefs,
      now: parseDay(toLocalIso(new Date())),
      isGated,
      viewOrder: getViewOrder(),
      folderNames: getFolderGroupLabels(),
    });
  }
  return sorted;
}

/** A task line's text the way the Tasks view shows it. */
const taskText = (rest: string | undefined) => (rest ?? '').replace(/&nbsp;/g, ' ').trim();

/**
 * Flip the checked state on a single task line. Returns the new body,
 * or null if the target line doesn't hold the task `text` anymore (e.g.
 * the user, or another device, edited the note between render and click).
 */
function setTaskCheckedInBody(
  body: string,
  lineIdx: number,
  checked: boolean,
  text: string,
): string | null {
  const lines = body.split(/\r?\n/);
  const line = lines[lineIdx];
  if (line == null || !outsideFences(lines)[lineIdx]) return null;
  const m = matchTask(line);
  if (!m || taskText(m[4]) !== text) return null;
  const [, indent, marker, , rest] = m;
  lines[lineIdx] = `${m.quote}${indent}${marker} [${checked ? 'x' : ' '}] ${rest ?? ''}`.replace(/\s+$/, '');
  return lines.join('\n');
}

/**
 * The task in `note` that `task` was drawn from: the line with the same text
 * and state nearest to its old line, or null when none is left. A list drawn
 * from an older copy of the note (Home's widget reads the notes array, which
 * takes the editor's typing only on a flush) can point at a line that moved.
 */
export function relocateTask(task: TaskItem, note: LocalNote): TaskItem | null {
  let best: TaskItem | null = null;
  for (const t of extractAllTasks([note])) {
    if (t.text !== task.text || t.checked !== task.checked) continue;
    if (!best || Math.abs(t.lineIdx - task.lineIdx) < Math.abs(best.lineIdx - task.lineIdx)) best = t;
  }
  return best;
}

/**
 * Whether "Uncheck all items" has work to do in this body: more than one task
 * line, and at least one of them checked. A note with a single task gets no
 * row, because its own checkbox already does the job.
 */
export function canUncheckAllTasks(body: string): boolean {
  let tasks = 0;
  let checked = false;
  const lines = body.split(/\r?\n/);
  const prose = outsideFences(lines);
  for (const [i, line] of lines.entries()) {
    const m = prose[i] ? matchTask(line) : null;
    if (!m) continue;
    tasks++;
    if (m[3] !== ' ') checked = true;
  }
  return tasks > 1 && checked;
}

/** The body with every task line unchecked; other lines are left as they are. */
function uncheckAllTasksInBody(body: string): string {
  const lines = body.split(/\r?\n/);
  const prose = outsideFences(lines);
  return lines
    .map((line, i) => {
      const m = prose[i] ? matchTask(line) : null;
      if (!m || m[3] === ' ') return line;
      const [, indent, marker, , rest] = m;
      return `${m.quote}${indent}${marker} [ ] ${rest ?? ''}`.replace(/\s+$/, '');
    })
    .join('\n');
}

/**
 * Uncheck every task in a note, starting from `body`, which the caller takes
 * from the open editor so that text still in its save delay is kept. Returns
 * the body written, or null when nothing was: the note is gone, takes no
 * edits (see `takesTaskEdit`), or no longer holds `body` (see writeFromBody).
 */
export async function uncheckAllTasksInNote(
  noteId: string,
  body: string,
  isGated: (n: LocalNote) => boolean,
): Promise<string | null> {
  const note = await getNote(noteId);
  if (!note || !takesTaskEdit(note, isGated)) return null;
  return writeFromBody(note.id, body, uncheckAllTasksInBody(body));
}

/**
 * Write `next`, made from `body`, only while the row still holds `body`. The
 * caller read `body` from the editor or the notes array, and a pull that
 * stored another device's version since then must not be overwritten by a
 * rewrite of the version before it (#497). The editor's own pending save is
 * queued ahead of this write, so a body still in its save delay is the row's
 * body by the time this runs.
 */
async function writeFromBody(id: string, body: string, next: string): Promise<string | null> {
  const written = await updateNoteFrom(id, (current) => (current.body === body ? { body: next } : null));
  return written ? next : null;
}

/**
 * One item of a markdown task list: its own line, and every line below it that
 * belongs to it (sub-tasks, a wrapped paragraph, blank lines in a loose list).
 * `line` is the head's index in the body as written, so a caller can name an
 * item it found with `extractAllTasks`.
 */
type TaskNode = { head: string; rest: string[]; checked: boolean; line: number };

/**
 * For each line of a body, whether it is outside every code fence and not a
 * fence line itself, so it can be a task. Every reader of task lines asks
 * this, so the Tasks pane, the footer count and the rewrites agree. Fences
 * inside a list item are indented, so any indent opens one here.
 */
function outsideFences(lines: readonly string[]): boolean[] {
  let fence: Fence | null = null;
  return lines.map((quoted) => {
    // A fence inside a quote or a callout is a fence too.
    const line = quoted.slice(quoted.match(QUOTE_PREFIX)![0].length);
    const step = nextFence(fence, line, Infinity);
    fence = step.fence;
    return !step.isFence && fence === null;
  });
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Rewrite every task list in a body, at every depth, through `fn`. A list is a
 * run of task lines at one indent; the lines indented deeper than the run
 * travel with the item above them, so a sub-task never leaves its parent and
 * two lists split by other text are two lists. Lines inside a code fence are
 * never read as tasks. Delete, sort and the Tasks pane's move all go through
 * here, so the three agree on what a list is.
 */
function mapTaskLists(body: string, fn: (items: TaskNode[]) => TaskNode[]): string {
  return mapBlock(body.split(/\r?\n/), 0, fn).join('\n');
}

function mapBlock(lines: string[], offset: number, fn: (items: TaskNode[]) => TaskNode[]): string[] {
  const out: string[] = [];
  const prose = outsideFences(lines);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // A quote, a callout or a Kanban board: its lines without one level of
    // `>` are a body of their own, with their own task lists. Line numbers
    // stay one to one, so `offset` still names each line.
    if (line.startsWith('>')) {
      let j = i;
      while (j < lines.length && lines[j]!.startsWith('>')) j++;
      const inner = lines.slice(i, j).map((l) => l.replace(/^>[ \t]?/, ''));
      for (const l of mapBlock(inner, offset + i, fn)) out.push(l === '' ? '>' : `> ${l}`);
      i = j;
      continue;
    }
    if (!prose[i] || !TASK_LINE.test(line)) {
      out.push(line);
      i++;
      continue;
    }
    const base = indentOf(line);
    const items: TaskNode[] = [];
    // The blank lines between two items of a loose list, by position, so a
    // reorder keeps the list exactly as loose as it was.
    const gaps: string[][] = [];
    while (i < lines.length) {
      const head = lines[i]!;
      if (!TASK_LINE.test(head) || indentOf(head) !== base) break;
      const m = head.match(TASK_LINE)!;
      const item: TaskNode = { head, rest: [], checked: m[3] !== ' ', line: offset + i };
      i++;
      while (i < lines.length) {
        const next = lines[i]!;
        if (next.trim() === '') {
          // A blank line stays inside the list only when the list goes on
          // after it; otherwise it is the gap after the list.
          let j = i + 1;
          while (j < lines.length && lines[j]!.trim() === '') j++;
          const after = lines[j];
          const continues =
            after != null &&
            (indentOf(after) > base || (TASK_LINE.test(after) && indentOf(after) === base));
          if (!continues) break;
          item.rest.push(...lines.slice(i, j));
          i = j;
          continue;
        }
        if (indentOf(next) <= base) break;
        item.rest.push(next);
        i++;
      }
      items.push(item);
    }
    const mapped = fn(
      items.map((it) => {
        let end = it.rest.length;
        while (end > 0 && it.rest[end - 1]!.trim() === '') end--;
        gaps.push(it.rest.slice(end));
        return { ...it, rest: mapBlock(it.rest.slice(0, end), it.line + 1, fn) };
      }),
    );
    mapped.forEach((it, k) => {
      out.push(it.head, ...it.rest);
      if (k < mapped.length - 1) out.push(...(gaps[k] ?? []));
    });
  }
  return out;
}

/** How many task lines a body holds, and how many of them are checked. */
export function countTasks(body: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const lines = body.split(/\r?\n/);
  const prose = outsideFences(lines);
  for (const [i, line] of lines.entries()) {
    if (!prose[i]) continue;
    const m = matchTask(line);
    if (!m) continue;
    total++;
    if (m[3] !== ' ') done++;
  }
  return { done, total };
}

/**
 * The body with every checked task removed, together with what hangs under it:
 * a checked parent takes its sub-tasks along, so nothing is left behind one
 * level up. Unchecked tasks keep their order.
 */
export function deleteCheckedTasksInBody(body: string): string {
  return mapTaskLists(body, (items) => items.filter((it) => !it.checked));
}

/** The body with each task list in the order open first, checked after, and
 *  otherwise unchanged. */
export function sortTasksByStatusInBody(body: string): string {
  return mapTaskLists(body, (items) => [
    ...items.filter((it) => !it.checked),
    ...items.filter((it) => it.checked),
  ]);
}

/** Whether "Delete checked items" has work to do: one checked task is enough. */
export function canDeleteCheckedTasks(body: string): boolean {
  return countTasks(body).done > 0;
}

/** Whether "Sort items by status" would change anything: some list holds an
 *  open task below a checked one. */
export function canSortTasksByStatus(body: string): boolean {
  let unsorted = false;
  mapTaskLists(body, (items) => {
    let seenChecked = false;
    for (const it of items) {
      if (it.checked) seenChecked = true;
      else if (seenChecked) unsorted = true;
    }
    return items;
  });
  return unsorted;
}

/**
 * The item whose head is `lineIdx`, moved to the edge of its list's open group:
 * just after the last unchecked sibling. A task just checked lands at the top
 * of the checked ones and a task just unchecked at the end of the open ones,
 * which is the move the editor makes (moveTaskToGroupEdge in
 * editorTasks.ts).
 */
export function moveTaskToGroupEdgeInBody(body: string, lineIdx: number): string {
  return mapTaskLists(body, (items) => {
    const self = items.findIndex((it) => it.line === lineIdx);
    if (self < 0) return items;
    const others = items.filter((_, k) => k !== self);
    let lastOpen = -1;
    others.forEach((it, k) => { if (!it.checked) lastOpen = k; });
    others.splice(lastOpen + 1, 0, items[self]!);
    return others;
  });
}

/**
 * Run a whole-note task transform on the open note, starting from `body`,
 * which the caller takes from the open editor so text still in its save delay
 * is kept. Returns the body written, or null when nothing was: the note is
 * gone, takes no edits (see `takesTaskEdit`), or the transform changed nothing.
 */
async function rewriteTasksInNote(
  noteId: string,
  body: string,
  isGated: (n: LocalNote) => boolean,
  transform: (body: string) => string,
): Promise<string | null> {
  const note = await getNote(noteId);
  if (!note || !takesTaskEdit(note, isGated)) return null;
  const next = transform(body);
  if (next === body) return null;
  return writeFromBody(note.id, body, next);
}

export const deleteCheckedTasksInNote = (noteId: string, body: string, isGated: (n: LocalNote) => boolean) =>
  rewriteTasksInNote(noteId, body, isGated, deleteCheckedTasksInBody);

export const sortTasksByStatusInNote = (noteId: string, body: string, isGated: (n: LocalNote) => boolean) =>
  rewriteTasksInNote(noteId, body, isGated, sortTasksByStatusInBody);

/**
 * Append a new unchecked task line to the end of a body. If the body
 * doesn't already end with a blank line, one is inserted so the task
 * doesn't fuse with the previous paragraph.
 */
function appendTaskToBody(body: string, text: string): string {
  const clean = text.trim();
  if (!clean) return body;
  const line = `- [ ] ${clean}`;
  if (!body) return line;
  // If the last non-empty line is already a task, just append another
  // task line directly - keeps the list contiguous.
  const trimmed = body.replace(/\s+$/, '');
  const lastNewline = trimmed.lastIndexOf('\n');
  const lastLine = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1);
  if (TASK_LINE.test(lastLine)) {
    return `${trimmed}\n${line}\n`;
  }
  return `${trimmed}\n\n${line}\n`;
}

/** The empty first task a new task list holds in the formatted editor. */
const EMPTY_TASK = /^(\s*)[-*+]\s+\[ \]\s*(?:&nbsp;)?\s*$/;
/** The empty paragraphs the formatted editor keeps at the end of a body. */
const TRAILING_BLANKS = /(?:\n+&nbsp;)+\s*$/;

/**
 * Add lines to the end of a body: as tasks after the last task line, or as
 * one paragraph. The empty task of a new list takes the first line, and
 * the empty paragraphs at the end stay at the end. Pure, for the switcher's
 * ">>" (Spec: docs/internal/specs/quick-add-prefix.md). Tested in
 * tests/switcherQuery.test.ts.
 */
export function appendLinesToBody(body: string, lines: string[], asTasks: boolean): string {
  // Typed text, so it shows as typed: "5*3*2" stays a sum, "[[x]]" text, as
  // the editor escapes what is typed in it.
  const clean = lines.map((l) => l.trim()).filter(Boolean).map((l) => guardMarkdownLineStart(escapeMarkdownText(l)));
  if (!clean.length) return body;
  const tail = body.match(TRAILING_BLANKS)?.[0] ?? '';
  let out = body.slice(0, body.length - tail.length).replace(/\s+$/, '');
  if (!asTasks) {
    const para = clean.join(' ');
    out = out ? `${out}\n\n${para}` : para;
  } else {
    let todo = clean;
    if (EMPTY_TASK.test(out) && !out.includes('\n')) {
      out = `- [ ] ${todo[0]}`;
      todo = todo.slice(1);
    }
    for (const line of todo) out = appendTaskToBody(out, line).replace(/\s+$/, '');
  }
  return tail ? `${out}${tail.replace(/\s+$/, '')}` : `${out}\n`;
}

/**
 * Append lines to an item that exists, made from `body` (the editor's text
 * for the open note, so typing still in its save delay is kept) and written
 * only while the row still holds it, as the "..." menu's task rewrites are.
 * An item that takes no edits (read-only or behind the PIN) is never
 * written. Returns the body written, or null when nothing was.
 */
export async function appendToNote(
  id: string,
  body: string,
  lines: string[],
  asTasks: boolean,
  isGated: (n: LocalNote) => boolean,
): Promise<string | null> {
  const note = await getNote(id);
  if (!note || !takesTaskEdit(note, isGated)) return null;
  return writeFromBody(id, body, appendLinesToBody(body, lines, asTasks));
}

/**
 * The dedicated "Inbox" note used by quick-add flows. Looked up by an
 * exact title match first (user-facing - they can see and rename it);
 * created on demand if missing.
 */
const INBOX_TITLE = 'Quick Tasks';

/**
 * Whether a task edit may write into this note. A read-only note takes no
 * edits until its switch is turned off, and a note the PIN guards right now
 * (`isGated`, the view's lock predicate) takes none without the PIN.
 */
function takesTaskEdit(n: LocalNote, isGated: (n: LocalNote) => boolean): boolean {
  return n.locked !== 1 && !isGated(n);
}

/**
 * Rewrite one task line's reminder token in a Markdown body. Returns the new
 * body, or null if `lineIdx` no longer holds the task `text`.
 */
export function setTaskReminderInBody(
  body: string,
  lineIdx: number,
  expectedText: string,
  reminder: TaskReminder | null,
): string | null {
  const lines = body.split(/\r?\n/);
  const line = lines[lineIdx];
  if (line == null || !outsideFences(lines)[lineIdx]) return null;
  const m = matchTask(line);
  if (!m || taskText(m[4]) !== expectedText) return null;
  const [, indent, marker, box, rest] = m;
  const nextRest = replaceTaskReminderInText(rest ?? '', reminder);
  lines[lineIdx] = `${m.quote}${indent}${marker} [${box}] ${nextRest}`.replace(/\s+$/, '');
  return lines.join('\n');
}

/**
 * Rewrite a repeating task when ticked off in a Markdown body:
 *   1. The ticked item becomes `[x]` with its `:remind[...]` stripped (so the
 *      completed history entry no longer rings or duplicates the series).
 *   2. A fresh unchecked `[ ]` copy is created with its `:remind[...]` advanced
 *      to the next occurrence and any nested sub-checkboxes reset to `[ ]`.
 *   3. With `sinkChecked`, the completed copy sinks to the top of the done
 *      group while the fresh copy stays in place; otherwise the fresh copy
 *      sits right before the completed one.
 */
export function completeRepeatingTaskInBody(
  body: string,
  lineIdx: number,
  expectedText: string,
  todayIso: string,
  sinkChecked = false,
): string | null {
  const lines = body.split(/\r?\n/);
  const line = lines[lineIdx];
  if (line == null || !outsideFences(lines)[lineIdx]) return null;
  const m = matchTask(line);
  if (!m || taskText(m[4]) !== expectedText) return null;
  const current = extractTaskReminder(m[4] ?? '');
  if (!current?.repeat) return null;
  const next = nextTaskReminder(current, todayIso);
  if (!next) return null;

  let changed = false;
  const out = mapTaskLists(body, (items) => {
    const self = items.findIndex((it) => it.line === lineIdx);
    if (self < 0) return items;
    const orig = items[self]!;
    const headMatch = matchTask(orig.head);
    if (!headMatch) return items;
    const [, indent, marker, , rest] = headMatch;
    const doneHead = `${headMatch.quote}${indent}${marker} [x] ${replaceTaskReminderInText(rest ?? '', null)}`.replace(/\s+$/, '');
    const nextHead = `${headMatch.quote}${indent}${marker} [ ] ${replaceTaskReminderInText(rest ?? '', next)}`.replace(/\s+$/, '');
    const doneNode: TaskNode = { ...orig, head: doneHead, checked: true };
    const nextRest = orig.rest.length ? uncheckAllTasksInBody(orig.rest.join('\n')).split('\n') : [];
    const nextNode: TaskNode = { ...orig, head: nextHead, rest: nextRest, checked: false };
    changed = true;

    const others = items.slice();
    if (!sinkChecked) {
      others.splice(self, 1, nextNode, doneNode);
      return others;
    }
    // Keep the new open occurrence in place and sink the completed copy to the
    // edge of the open group (matching moveTaskToGroupEdgeInBody).
    others.splice(self, 1, nextNode);
    let lastOpen = -1;
    others.forEach((it, k) => { if (!it.checked) lastOpen = k; });
    others.splice(lastOpen + 1, 0, doneNode);
    return others;
  });
  return changed ? out : null;
}

/**
 * Tick or untick one task line inside the note that holds it, through the
 * normal note write. When ticking a repeating task, spawns the next unchecked
 * occurrence with the advanced reminder date. With `sinkChecked`, the ticked
 * task moves to the edge of its list's open group, as it does when ticked in
 * the editor. Returns the body written, or null when nothing was: the note is
 * gone, it takes no edits (see `takesTaskEdit`), or the line no longer holds
 * the task the list was drawn from because the note changed.
 * Tested in tests/lockGateWrites.test.ts and tests/taskWriteRace.test.ts.
 */
export async function toggleTaskInNote(
  task: TaskItem,
  checked: boolean,
  isGated: (n: LocalNote) => boolean,
  sinkChecked = false,
): Promise<string | null> {
  const todayIso = toLocalIso(new Date());
  const written = await updateNoteFrom(task.noteId, (current) => {
    if (!takesTaskEdit(current, isGated)) return null;
    if (checked && task.reminder?.repeat) {
      const advanced = completeRepeatingTaskInBody(current.body, task.lineIdx, task.text, todayIso, sinkChecked);
      if (advanced != null) return { body: advanced };
    }
    const flipped = setTaskCheckedInBody(current.body, task.lineIdx, checked, task.text);
    if (flipped == null) return null;
    // The same move a tick makes in the editor, when the setting asks for it.
    return { body: sinkChecked ? moveTaskToGroupEdgeInBody(flipped, task.lineIdx) : flipped };
  });
  return written?.body ?? null;
}

/**
 * Set, update, or remove a reminder on one task line inside its parent note.
 * Refuses read-only and PIN-gated notes, and guards against concurrent edits.
 */
export async function setTaskReminderInNote(
  task: TaskItem,
  reminder: TaskReminder | null,
  isGated: (n: LocalNote) => boolean,
): Promise<string | null> {
  const written = await updateNoteFrom(task.noteId, (current) => {
    if (!takesTaskEdit(current, isGated)) return null;
    const next = setTaskReminderInBody(current.body, task.lineIdx, task.text, reminder);
    if (next == null) return null;
    return { body: next };
  });
  return written?.body ?? null;
}

/**
 * Format a shared URL, title, and/or text into one safe Markdown task-line
 * body (without the leading `- [ ] `). Valid http(s) links become clickable
 * Markdown links with their label escaped; plain text is escaped like
 * `appendLinesToBody` so characters such as `*`, `[`, or `#` stay literal.
 */
export function formatSharedTaskLine(input: {
  url?: string;
  title?: string;
  text?: string;
}): string {
  const url = input.url?.trim() ?? '';
  const title = (input.title ?? '').replace(/\s+/g, ' ').trim();
  const text = (input.text ?? '').replace(/\s+/g, ' ').trim();
  if (url && /^https?:\/\/\S+$/i.test(url)) {
    const safeUrl = url.replace(/[()]/g, (ch) => (ch === '(' ? '%28' : '%29'));
    const link = title && title !== url
      ? `[${title.replace(/[\\[\]]/g, '\\$&')}](${safeUrl})`
      : safeUrl;
    if (text && text !== title && text !== url) {
      return `${link} - ${escapeMarkdownText(text)}`;
    }
    return link;
  }
  const combined = title && text && text !== title ? `${title} - ${text}` : (text || title);
  if (!combined) return '';
  return guardMarkdownLineStart(escapeMarkdownText(combined));
}

/**
 * Append a task line (already formatted via `formatSharedTaskLine`, or plain
 * text when `preformatted` is false) into a chosen task list note if it still
 * exists, is active (`type === 'task'`), and accepts edits (`takesTaskEdit`).
 * Falls back to the dedicated Quick Tasks list otherwise. Returns the id of
 * the task list note written, or null when empty.
 */
export async function appendTaskToListOrQuickTasks(
  line: string,
  taskListId: string | undefined,
  activeNotes: LocalNote[],
  isGated: (n: LocalNote) => boolean,
  folderForNew: () => string | null = () => null,
): Promise<string | null> {
  const clean = line.trim();
  if (!clean) return null;
  if (taskListId) {
    const target = await getNote(taskListId);
    if (
      target &&
      target.trashed !== 1 &&
      target.archived !== 1 &&
      target.deleted !== 1 &&
      target.type === 'task' &&
      takesTaskEdit(target, isGated)
    ) {
      const written = await updateNoteFrom(target.id, (current) =>
        current.trashed !== 1 && current.archived !== 1 && current.deleted !== 1 && takesTaskEdit(current, isGated)
          ? { body: appendTaskToBody(current.body, clean) }
          : null,
      );
      if (written) return target.id;
    }
  }
  return appendQuickTask(clean, activeNotes, isGated, folderForNew);
}

/**
 * Append a quick task to the Quick Tasks note. A Quick Tasks note that takes
 * no edits is passed over the way a renamed or trashed one is, and a new one
 * is made, so the line is written somewhere it may go and never into a note
 * that refuses it. Returns the id of the note written, or null for an empty
 * task. Tested in tests/lockGateWrites.test.ts.
 */
export async function appendQuickTask(
  text: string,
  activeNotes: LocalNote[],
  isGated: (n: LocalNote) => boolean,
  /** The folder a new Quick Tasks note files into, asked only when one is made. */
  folderForNew: () => string | null = () => null,
): Promise<string | null> {
  const clean = text.trim();
  if (!clean) return null;
  const inbox = activeNotes.find(
    (n) => (n.title ?? '').trim() === INBOX_TITLE && takesTaskEdit(n, isGated),
  );
  const id = inbox?.id ?? (await createNote(INBOX_TITLE, '', [], false, 'task', folderForNew())).id;
  // Appended to the row as it stands inside the write, so a body a pull
  // stored a moment ago is kept.
  const written = await updateNoteFrom(id, (current) =>
    takesTaskEdit(current, isGated) ? { body: appendTaskToBody(current.body, clean) } : null,
  );
  return written ? id : null;
}
