/**
 * The answers to a row this device cannot open (beta #203, owner card C1,
 * option A). The list itself is `unopenedRows.ts`, fed by the pull; this is
 * what the list in Settings > ID & Sync (`UnopenedNotesList.tsx`) and the
 * sign-out confirm read and do.
 *
 * - Send my copy again: this device's copy goes up through the normal push,
 *   guarded on the nonce of the row that did not open. While the server still
 *   holds that row, the write lands; once anything newer is there, the update
 *   misses and the conflict read decides, so a newer good copy is never
 *   overwritten. Offered only when this device holds a copy.
 * - Delete: a tombstone through the normal push, which seals it
 *   (`tombstoneSeal.ts`), so every other device takes it. A row this device
 *   holds no copy of gets an empty local tombstone for the push to send.
 *
 * Either answer takes the row off the list at once. A resend that the server
 * then refuses shows in the "not backed up" list (pushFailures.ts), as any
 * unsent note does; the next pull puts a row that still does not open back.
 * Spec: docs/contrib/sync-protocol.md (section 3, rows this device cannot open)
 */
import { db, type LocalNote } from './db';
import { nextStamp } from './notesRepo';
import { forgetUnopenedRows, listUnopenedRows, type UnopenedRow } from './unopenedRows';

export type UnopenedNote = UnopenedRow & {
  /** This device's copy, or null when it holds none (or only a delete). */
  local: LocalNote | null;
};

/** The rows the list shows, the ones with a copy here first, and how many
 *  rows there are in all: a session can insert up to the note limit, so only
 *  the first `limit` rows read their local copy. */
export async function listUnopenedNotes(limit: number): Promise<{ total: number; rows: UnopenedNote[] }> {
  const list = await listUnopenedRows();
  if (list.length === 0) return { total: 0, rows: [] };
  const shown = [...list]
    .sort((a, b) => Number(b.hasLocalCopy) - Number(a.hasLocalCopy) || a.seenAt.localeCompare(b.seenAt))
    .slice(0, limit);
  const locals = await db.notes.bulkGet(shown.map((r) => r.id));
  return {
    total: list.length,
    rows: shown.map((r, i) => {
      const local = locals[i];
      return { ...r, local: local && local.deleted !== 1 ? local : null };
    }),
  };
}

/**
 * The notes on the list whose copy here a sign-out that wipes the notes
 * would delete, beyond the unsent ones `countUnsyncedNotes` already counts.
 * Index reads only, so no sealed value is opened.
 */
export async function countUnopenedCopiesHere(): Promise<number> {
  const ids = (await listUnopenedRows()).map((r) => r.id);
  if (ids.length === 0) return 0;
  const held = await db.notes.where('id').anyOf(ids).primaryKeys();
  const gone = new Set(await db.notes.where('deleted').equals(1).primaryKeys());
  const unsent = new Set(await db.notes.where('dirty').anyOf(1, 2).primaryKeys());
  return held.filter((id) => !gone.has(id) && !unsent.has(id)).length;
}

/**
 * Send this device's copy again, guarded on the nonce that did not open.
 * Answers false when the row is no longer on the list or this device holds
 * no copy. The caller starts a sync pass.
 */
export async function resendUnopenedNote(id: string): Promise<boolean> {
  return db.transaction('rw', db.notes, db.kv, async () => {
    const row = (await listUnopenedRows()).find((r) => r.id === id);
    const local = await db.notes.get(id);
    if (!row || !local || local.deleted === 1) return false;
    // The push guards its update on `syncedNonce`: naming the row that did
    // not open makes the write land over that row and over nothing newer.
    // A new stamp, so the copy that goes back is the row's newest
    // generation on every device, never one a peer skips as older.
    // Spec: docs/internal/plans/payload-row-binding.md (section 4.1)
    await db.notes.update(id, { syncedNonce: row.nonce, updatedAt: nextStamp(local.updatedAt), dirty: 1 });
    await forgetUnopenedRows([id]);
    return true;
  });
}

/**
 * Delete the note on every device with a sealed tombstone. Answers false when
 * the row is no longer on the list. The caller starts a sync pass.
 */
export async function deleteUnopenedNote(id: string): Promise<boolean> {
  const done = await db.transaction('rw', db.notes, db.kv, async () => {
    if (!(await listUnopenedRows()).some((r) => r.id === id)) return false;
    const local = await db.notes.get(id);
    if (local) {
      await db.notes.update(id, { deleted: 1, dirty: 1, updatedAt: nextStamp(local.updatedAt) });
    } else {
      const now = new Date().toISOString();
      await db.notes.add({
        id, title: '', body: '', tags: [], createdAt: now, updatedAt: now,
        dirty: 1, deleted: 1, trashed: 0, starred: 0, locked: 0, pinProtected: 0, type: 'note', folderId: null,
      });
    }
    await forgetUnopenedRows([id]);
    return true;
  });
  // The parsed-doc cache, as permanentlyDelete drops it.
  if (done) await db.editorDocCache.delete(id).catch(() => { /* best-effort */ });
  return done;
}
