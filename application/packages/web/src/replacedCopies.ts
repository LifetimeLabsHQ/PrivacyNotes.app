/**
 * The copies a sync pull replaced, and the login as it was before each
 * applied extension edit (`extensionSync.ts`, through `keepCurrentText`).
 *
 * A pull cannot tell another device's edit from an older ciphertext of the
 * same account replayed onto the row by a session that holds no key: both open under the account key and carry a newer stamp. So
 * when a pull replaces the title or the body of a clean note, this device
 * keeps the text it showed for 30 days, and the note's History window offers
 * it back. A restore is an ordinary edit that syncs.
 *
 * Local only, for every plan: nothing here reaches the server. Sealed at rest
 * like the notes (localSeal.ts, table tag `replaced`). The demo never pulls,
 * so it never keeps a copy.
 *
 * Bounds: a copy older than 30 days goes, a text already kept for the note is
 * not kept twice, and a note keeps 10. At 10, a new copy replaces the newest
 * one when that is less than a day old, and the oldest one otherwise: a run
 * of replays, or of another device's saves, cannot push out the text from
 * before the run.
 * Spec: docs/contrib/sync-protocol.md (section 3, replaced copies)
 */
import { db, type LocalNote, type ReplacedCopy } from './db';
import { isDemoMode } from './demo';
import { createNote } from './notesRepo';

/** How long a copy stays. Spec: docs/contrib/sync-protocol.md (section 3) */
export const REPLACED_COPY_DAYS = 30;
const KEEP_MS = REPLACED_COPY_DAYS * 24 * 60 * 60 * 1000;
/** The copies one note keeps; the oldest go first. */
const MAX_COPIES_PER_NOTE = 10;
/** A note at its cap whose newest copy is younger than this is in a run. */
const RUN_MS = 24 * 60 * 60 * 1000;

/** One pull write: the clean row it replaces and what it writes. */
export type PullReplacement = {
  old: LocalNote;
  next: { title: string; body: string };
};

const cutoff = (nowMs: number) => new Date(nowMs - KEEP_MS).toISOString();

/** The copies past 30 days, by key: no sealed value is read. */
async function dropExpired(nowMs: number): Promise<void> {
  const expired = await db.replacedCopies.where('at').below(cutoff(nowMs)).primaryKeys();
  if (expired.length > 0) await db.replacedCopies.bulkDelete(expired);
}

/** The copies that make room for one more, from a list newest first. */
function makeRoom(list: ReplacedCopy[], nowMs: number): string[] {
  if (list.length < MAX_COPIES_PER_NOTE) return [];
  const inRun = nowMs - Date.parse(list[0]!.at) < RUN_MS;
  const out = inRun ? [list[0]!, ...list.slice(MAX_COPIES_PER_NOTE)] : list.slice(MAX_COPIES_PER_NOTE - 1);
  return out.map((c) => c.id);
}

function copyOf(old: LocalNote, nowMs: number): ReplacedCopy {
  return {
    id: crypto.randomUUID(),
    noteId: old.id,
    at: new Date(nowMs).toISOString(),
    was: old.updatedAt,
    title: old.title,
    body: old.body,
    tags: [...old.tags],
    ...(old.trackers ? { trackers: old.trackers } : {}),
    type: old.type,
  };
}

/**
 * Keep the text each replacement takes away. Runs inside the pull's write
 * transaction, which must include `db.replacedCopies`, so a copy exists
 * exactly when its replacement commits. A change to the tags or the flags
 * alone keeps nothing.
 */
export async function keepReplacedCopies(pairs: PullReplacement[], nowMs = Date.now()): Promise<void> {
  if (isDemoMode()) return;
  const changed = pairs.filter((p) => p.old.title !== p.next.title || p.old.body !== p.next.body);
  if (changed.length === 0) return;
  await dropExpired(nowMs);
  const kept = await db.replacedCopies.where('noteId').anyOf(changed.map((p) => p.old.id)).toArray();
  const byNote = new Map<string, ReplacedCopy[]>();
  for (const c of kept) byNote.set(c.noteId, [...(byNote.get(c.noteId) ?? []), c]);
  const add: ReplacedCopy[] = [];
  const drop: string[] = [];
  for (const { old, next } of changed) {
    const list = (byNote.get(old.id) ?? []).sort((a, b) => b.at.localeCompare(a.at));
    if (list.some((c) => c.title === old.title && c.body === old.body)) continue;
    add.push(copyOf(old, nowMs));
    drop.push(...makeRoom(list, nowMs));
  }
  if (drop.length > 0) await db.replacedCopies.bulkDelete(drop);
  if (add.length > 0) await db.replacedCopies.bulkAdd(add);
}

/**
 * Keep the note's text as it is now, before something replaces it: a
 * restore of a copy on an account with no server History, or an applied
 * extension edit of a login. The change is then never the only copy of
 * what it replaces. No second copy of the same text.
 */
export async function keepCurrentText(note: LocalNote, nowMs = Date.now()): Promise<void> {
  if (isDemoMode()) return;
  await db.transaction('rw', db.replacedCopies, async () => {
    await dropExpired(nowMs);
    const list = (await db.replacedCopies.where('noteId').equals(note.id).toArray()).sort((a, b) => b.at.localeCompare(a.at));
    if (list.some((c) => c.title === note.title && c.body === note.body)) return;
    const drop = makeRoom(list, nowMs);
    if (drop.length > 0) await db.replacedCopies.bulkDelete(drop);
    await db.replacedCopies.add(copyOf(note, nowMs));
  });
}

/** A note's copies within 30 days, newest first. */
export async function listReplacedCopies(noteId: string, nowMs = Date.now()): Promise<ReplacedCopy[]> {
  if (isDemoMode()) return [];
  const since = cutoff(nowMs);
  const list = await db.replacedCopies.where('noteId').equals(noteId).toArray();
  return list.filter((c) => c.at >= since).sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The copies within 30 days whose note no longer exists on this device,
 * newest first: the Trash lists them, because the History window that shows
 * a copy opens only from its note. A tombstone deletes a note's server
 * History with it, so after a delete these can be the last text left
 * (beta #203 item 2).
 */
export async function listCopiesOfGoneNotes(nowMs = Date.now()): Promise<ReplacedCopy[]> {
  if (isDemoMode()) return [];
  const since = cutoff(nowMs);
  const recent = await db.replacedCopies.where('at').aboveOrEqual(since).toArray();
  if (recent.length === 0) return [];
  const noteIds = [...new Set(recent.map((c) => c.noteId))];
  const notes = await db.notes.bulkGet(noteIds);
  const gone = new Set(noteIds.filter((_, i) => !notes[i] || notes[i]!.deleted === 1));
  return recent.filter((c) => gone.has(c.noteId)).sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Bring a copy of a gone note back as a new note, under a new id (the old
 * one is a tombstone on the server). The copy stays, so a second restore
 * still works; it goes after 30 days like every copy. Answers the new note.
 */
export async function restoreCopyAsNote(copy: ReplacedCopy): Promise<LocalNote> {
  const note = await createNote(copy.title, copy.body, copy.tags, false, copy.type ?? 'note', null, { counted: false });
  if (!copy.trackers) return note;
  await db.notes.update(note.id, { trackers: copy.trackers });
  return { ...note, trackers: copy.trackers };
}
