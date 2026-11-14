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
 * the one reading the cutoff, so no other device's clock can shorten it. The
 * record keeps the row's stamp beside the time and starts the count again when
 * the stamp differs: a note restored and trashed again elsewhere while no
 * purge ran here is a new stay in the Trash, not the one this device saw. A
 * sign-out wipe deletes the record (notesRepo.ts clearLocalDatabase).
 */
import { db, type LocalNote } from './db';
import { nextStamp } from './notesRepo';

const DAY_MS = 86_400_000;

/** When this device first saw each trashed note, by its own clock, and the
 *  row's stamp then: note id -> `{ at: epoch ms, stamp: updatedAt }`, as JSON
 *  in `db.kv`. An entry of the older shape (a bare number) has no stamp and
 *  starts again. */
const TRASH_SEEN_KEY = 'trashSeenAt';

type Seen = { at: number; stamp: string };

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

function readSeenAt(raw: unknown): Record<string, Seen> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, Seen> = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const { at, stamp } = (entry ?? {}) as { at?: unknown; stamp?: unknown };
      if (typeof at === 'number' && Number.isFinite(at) && typeof stamp === 'string') out[id] = { at, stamp };
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
    // Rows that left the Trash drop out; a row seen for the first time, or
    // with another stamp than the one seen, starts its count now.
    const seen: Record<string, Seen> = {};
    for (const n of trashed) {
      if (n.deleted !== 0) continue;
      const was = before[n.id];
      seen[n.id] = was && was.stamp === n.updatedAt ? was : { at: now, stamp: n.updatedAt };
    }
    const seenAt = Object.fromEntries(Object.entries(seen).map(([id, e]) => [id, e.at]));
    const expired = selectExpiredTrash(trashed, days, now, demo, seenAt);
    for (const n of expired) {
      await db.notes.update(n.id, { deleted: 1, updatedAt: nextStamp(n.updatedAt), dirty: 1 });
      delete seen[n.id];
    }
    await db.kv.put({ key: TRASH_SEEN_KEY, value: JSON.stringify(seen) });
    return expired.map((n) => ({ id: n.id, body: n.body }));
  });
  // Parsed-doc cache rows are disposable, so they go outside the transaction.
  await db.editorDocCache.bulkDelete(purged.map((n) => n.id)).catch(() => { /* best-effort */ });
  return purged;
}
