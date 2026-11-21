/**
 * The server rows this device met and could not open (beta #203, owner card
 * C1, option A). A session of the account with no phrase can write bytes that
 * open under no key over a note, or insert such rows up to the note limit.
 * The pull keeps this device's own copy of such a note as it was (it never
 * overwrites or drops it), and records the row here, so a later screen can
 * list them: send this device's copy again (a write guarded on `nonce`), or
 * delete the row with a sealed tombstone (`unopenedNotes.ts`, listed in
 * Settings > ID & Sync). A forced sign-out keeps the notes it names
 * (`clearLocalDatabase`).
 *
 * In the local kv table, not sealed: ids and nonces are what the server
 * already holds. A full sign-out wipe removes it; a forced one keeps it with
 * the notes. A row leaves the list when a pull opens it, when it becomes a
 * tombstone, or when the server no longer has it.
 * Spec: docs/contrib/sync-protocol.md (section 3, rows this device cannot open)
 */
import { db } from './db';

/** The `db.kv` key of the list. */
export const UNOPENED_ROWS_KEY = 'unopenedRows';
/** The most kept: the note limit of an account, so every row that can exist
 *  fits (about 1 MB at the cap). The oldest go first. */
const MAX_ROWS = 10_000;

export type UnopenedRow = {
  /** The note id. */
  id: string;
  /** The server nonce of the row that did not open: a resend of this
   *  device's copy is guarded on it, so it never replaces a later write. */
  nonce: string;
  /** When this device first met the row in this state (ISO). */
  seenAt: string;
  /** This device holds a copy of the note it can show. */
  hasLocalCopy: boolean;
};

function parse(raw: unknown): UnopenedRow[] {
  try {
    const list: unknown = typeof raw === 'string' ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (r): r is UnopenedRow =>
        !!r && typeof r === 'object' &&
        typeof (r as UnopenedRow).id === 'string' &&
        typeof (r as UnopenedRow).nonce === 'string' &&
        typeof (r as UnopenedRow).seenAt === 'string' &&
        typeof (r as UnopenedRow).hasLocalCopy === 'boolean',
    );
  } catch {
    return [];
  }
}

/** Every row on the list, oldest first. */
export async function listUnopenedRows(): Promise<UnopenedRow[]> {
  return parse((await db.kv.get(UNOPENED_ROWS_KEY))?.value);
}

/** The note ids on the list. Reads no sealed value, so a forced sign-out can
 *  call it after the local key is gone. */
export async function unopenedRowIds(): Promise<string[]> {
  return (await listUnopenedRows()).map((r) => r.id);
}

async function writeList(list: UnopenedRow[]): Promise<void> {
  if (list.length === 0) await db.kv.delete(UNOPENED_ROWS_KEY);
  else await db.kv.put({ key: UNOPENED_ROWS_KEY, value: JSON.stringify(list) });
}

/** Take rows off the list once this device has answered them (a resend or a
 *  delete is queued). Call it inside a transaction that includes `db.kv`. */
export async function forgetUnopenedRows(ids: Iterable<string>): Promise<void> {
  const drop = new Set(ids);
  const list = await listUnopenedRows();
  if (!list.some((r) => drop.has(r.id))) return;
  await writeList(list.filter((r) => !drop.has(r.id)));
}

/**
 * One pull page: the rows that did not open join the list (a row already on
 * it keeps its first `seenAt` and takes the newer nonce), and the rows that
 * opened, became tombstones or are gone from the server leave it.
 */
export async function recordUnopenedRows(
  update: { failed: Array<{ id: string; nonce: string }>; settled: Iterable<string> },
  now: Date = new Date(),
): Promise<void> {
  const settled = new Set(update.settled);
  if (update.failed.length === 0 && settled.size === 0) return;
  const held = update.failed.length > 0 ? await db.notes.bulkGet(update.failed.map((r) => r.id)) : [];
  await db.transaction('rw', db.kv, async () => {
    const list = await listUnopenedRows();
    if (update.failed.length === 0 && !list.some((r) => settled.has(r.id))) return;
    const byId = new Map(list.filter((r) => !settled.has(r.id)).map((r) => [r.id, r]));
    update.failed.forEach((row, i) => {
      const local = held[i];
      const hasLocalCopy = local !== undefined && local.deleted !== 1;
      const before = byId.get(row.id);
      byId.delete(row.id);
      byId.set(row.id, { id: row.id, nonce: row.nonce, seenAt: before?.seenAt ?? now.toISOString(), hasLocalCopy });
    });
    await writeList([...byId.values()].sort((a, b) => a.seenAt.localeCompare(b.seenAt)).slice(-MAX_ROWS));
  });
}
