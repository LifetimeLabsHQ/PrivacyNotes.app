import type { LocalNote } from './db';
import { notificationId, type ReminderItem } from './reminders';
import { inSection } from './sectionLock';
import { extractAllTasks } from './tasks';
import { stripTaskReminders } from './taskReminderSyntax';
import { hasStructuredBody, stripToPlainText } from './notesViewUtils';
import type { View } from './views';

/**
 * Per-checkbox reminders fed into `useReminders.tsx`.
 *
 * Each unchecked `- [ ] ... :remind[YYYY-MM-DD HH:MM ...]` line in any active,
 * non-trashed, non-archived Markdown note produces one `ReminderItem` with
 * id `task:<noteId>:<stableKey>`.
 *
 * Checking off the box, deleting the line, removing `:remind[...]`, trashing
 * or archiving the note removes it from the list, which cancels its OS
 * notification and clears its toast/bell on the next plan pass.
 *
 * Security: PIN-protected notes and notes in locked sections pass `gated: true`
 * and empty title/folder, so the lock screen only ever shows "Reminder" and the
 * time - identical to note-level reminders.
 */

export const TASK_REMINDER_PREFIX = 'task:';

/** Extract the parent note id from a `task:<noteId>:<hash>` reminder id, or null. */
export function noteIdFromTaskReminderId(id: string): string | null {
  if (!id.startsWith(TASK_REMINDER_PREFIX)) return null;
  const rest = id.slice(TASK_REMINDER_PREFIX.length);
  const sep = rest.indexOf(':');
  return sep > 0 ? rest.slice(0, sep) : null;
}

/**
 * Build `ReminderItem`s for every unchecked checkbox that carries a valid
 * `:remind[...]` token across the user's live notes.
 */
export function taskReminderItems(
  notes: readonly LocalNote[],
  opts: {
    protectedViews: readonly View[];
    titleOf: (n: LocalNote) => string;
  },
): ReminderItem[] {
  const liveNotes: LocalNote[] = [];
  const noteById = new Map<string, LocalNote>();
  for (const n of notes) {
    if (n.deleted !== 0 || n.trashed !== 0 || n.archived === 1) continue;
    if (hasStructuredBody(n.type)) continue;
    if (!n.body || !n.body.includes(':remind[')) continue;
    liveNotes.push(n);
    noteById.set(n.id, n);
  }
  if (liveNotes.length === 0) return [];

  const tasks = extractAllTasks(liveNotes);
  const seenCounts = new Map<string, number>();
  const out: ReminderItem[] = [];

  for (const t of tasks) {
    if (t.checked || !t.reminder) continue;
    const note = noteById.get(t.noteId);
    if (!note) continue;
    const gated = note.pinProtected === 1 || inSection(note, opts.protectedViews);
    const cleanText = stripToPlainText(stripTaskReminders(t.text)).trim();
    // Key by normalized text + per-note occurrence index so edits above this
    // line don't churn OS notification ids or drop an active snooze.
    const countKey = `${t.noteId}|${cleanText}`;
    const occ = seenCounts.get(countKey) ?? 0;
    seenCounts.set(countKey, occ + 1);
    const stableHash = notificationId(`${cleanText}|${occ}`).toString(36);

    out.push({
      id: `${TASK_REMINDER_PREFIX}${t.noteId}:${stableHash}`,
      schedule: {
        day: t.reminder.day,
        time: t.reminder.time,
        alerts: [{ before: 0 }],
      },
      title: gated ? '' : cleanText,
      folder: gated ? undefined : opts.titleOf(note),
      gated,
    });
  }

  return out;
}
