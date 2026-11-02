/**
 * The trash auto-purge ("Auto-delete after 30 days" in the Trash view).
 *
 * Each device purges its own copy, because the trashed flag and the day count
 * both live inside encrypted data. A purge tombstone is final on every device:
 * the tombstone push carries no stamp guard and a pulled tombstone overrides
 * any local edit. So the purge decides only on state that has pulled:
 *  - It waits for a sync pass in this app session that ran, finished its pull,
 *    and read the settings from the server in that same pass, so the settings
 *    cache has read the server's row in this pass. Before that, the local copy
 *    can still hold a note another device restored, and the cached day count
 *    can be a fresh device's default or an old value another device has changed.
 *  - It reads the rows inside the transaction that writes the tombstones.
 *  - It skips a row with an unpushed change: the pull never replaces a dirty
 *    row, so that copy is not what the server holds.
 * Demo mode has no sync, so its local state is the whole truth: there the
 * purge neither waits nor skips dirty rows.
 *
 * updatedAt is the age signal, which relies on every writer of trashed=1
 * stamping it at trash time (trashNote, trashNotesWithTag, applyImport).
 * Anything that sets trashed=1 while keeping an older updatedAt is purged by
 * the next run, with no undo. The other way round is safe and happens: a
 * write that stamps a row already in the trash restarts its countdown. A tag
 * rename or delete does that to the trashed notes carrying the tag, and a
 * folder delete to the trashed notes it moves out of the removed folders.
 *
 * updatedAt is written by whichever device trashed the note, on its clock, and
 * the cutoff is read on this device's clock, so one wrong clock emptied the
 * Trash on every device: a device 45 days fast purged a note trashed a minute
 * earlier, and a note trashed on a device 40 days slow was purged by the next
 * correct one (external report, 2026-10-24). So a row must also have sat in
 * this device's Trash for the day count, by this device's own clock, from the
 * first purge run that saw it there (`db.kv`, TRASH_SEEN_KEY). That clock is
 * the one reading the cutoff, so no other device's clock can shorten it.
 */
import { db, type LocalNote } from './db';
import { nextStamp } from './notesRepo';

const DAY_MS = 86_400_000;

/** When this device first saw each trashed note, by its own clock: note id ->
 *  epoch ms, as JSON in `db.kv`. */
const TRASH_SEEN_KEY = 'trashSeenAt';

/** The rows a purge with this day count takes at `now`. `seenAt`, when given,
 *  also holds each row back until this device has seen it in the Trash for
 *  the day count. */
export function selectExpiredTrash<
  T extends Pick<LocalNote, 'id' | 'trashed' | 'deleted' | 'dirty' | 'updatedAt'>,
>(rows: readonly T[], days: number, now: number, demo: boolean, seenAt?: Readonly<Record<string, number>>): T[] {
  if (!(days > 0)) return [];
  const cutoff = now - days * DAY_MS;
  return rows.filter(
    (n) =>
      n.trashed === 1 &&
      n.deleted === 0 &&
      // A demo row never syncs, so it never stops being dirty.
      (demo || n.dirty === 0) &&
      Date.parse(n.updatedAt) < cutoff &&
      (seenAt === undefined || (seenAt[n.id] ?? now) < cutoff),
  );
}

function readSeenAt(raw: unknown): Record<string, number> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** Whether a finished sync pass opens the purge: it ran, its notes pull
 *  completed, and it read the settings from the server (syncUserSettings'
 *  report.readServer for this pass). */
export function pullOpensTrashPurge(
  pass: { ran: boolean; pullOk: boolean },
  settingsRead: boolean,
): boolean {
  return pass.ran && pass.pullOk && settingsRead;
}

/** Whether the purge may run: a pass has opened it, or this is the demo. */
export function trashPurgeMayRun(opened: boolean, demo: boolean): boolean {
  return opened || demo;
}

/**
 * Tombstone every expired trashed row, reading and writing in one
 * transaction. Returns the rows it tombstoned, for the blob GC.
 */
export async function purgeExpiredTrash(
  days: number,
  demo: boolean,
  now: number = Date.now(),
): Promise<Array<{ id: string; body: string }>> {
  if (!(days > 0)) return [];
  const purged = await db.transaction('rw', db.notes, db.kv, async () => {
    const trashed = await db.notes.where('trashed').equals(1).toArray();
    const before = readSeenAt((await db.kv.get(TRASH_SEEN_KEY))?.value);
    // Rows that left the Trash drop out; a row seen for the first time starts
    // its count now.
    const seenAt: Record<string, number> = {};
    for (const n of trashed) if (n.deleted === 0) seenAt[n.id] = before[n.id] ?? now;
    const expired = selectExpiredTrash(trashed, days, now, demo, seenAt);
    for (const n of expired) {
      await db.notes.update(n.id, { deleted: 1, updatedAt: nextStamp(n.updatedAt), dirty: 1 });
      delete seenAt[n.id];
    }
    await db.kv.put({ key: TRASH_SEEN_KEY, value: JSON.stringify(seenAt) });
    return expired.map((n) => ({ id: n.id, body: n.body }));
  });
  // Parsed-doc cache rows are disposable, so they go outside the transaction.
  await db.editorDocCache.bulkDelete(purged.map((n) => n.id)).catch(() => { /* best-effort */ });
  return purged;
}
