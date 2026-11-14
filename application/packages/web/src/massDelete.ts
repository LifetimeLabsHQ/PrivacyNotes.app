/**
 * The mass delete guard, its state and its count.
 *
 * A tombstone needs a live session and no key, so a stolen session can mark
 * every row deleted, and each device deleted its own copy on its next pull.
 * The pull now asks here first. Only tombstones that would remove a note this
 * device still shows count: a note in the Trash or deleted here already goes
 * as before, and an unsynced edit is kept as a new note anyway (sync.ts,
 * applyTombstones). The normal permanent delete, which empties the Trash,
 * never reaches the count on a device that saw the notes go to the Trash.
 * The Trash flag is inside the encrypted payload, so a session without the
 * key cannot set it, but it can copy an older payload that carries it onto
 * other rows: the pull then moves those notes to the Trash, and their later
 * delete is not counted. The pull keeps the text it replaced instead
 * (replacedCopies.ts).
 *
 * Past the limit the notes stay, and the hold names them until the person
 * answers (keepHeldNotes or deleteHeldNotes in sync.ts, MassDeleteModal).
 * The count spans a day, not a pass, so a delete spread over many passes
 * cannot slip under it. Ids and counts only, per account.
 *
 * Since migration 0130 a delete carries a seal made with the key
 * (tombstoneSeal.ts). A valid seal never reaches the count. Only a delete
 * with no seal does: one from an app before 0130, or from a session without
 * the key. A bad seal is never asked about: the pull puts the notes back on
 * every device, and the refused count below tells the person once
 * (RefusedDeleteModal).
 * Spec: docs/contrib/sync-protocol.md (section 3, the mass delete guard)
 */
import { createListeners } from './listeners';
// A refused write leaves the hold in memory for this run (`current` below).
import { readJson, writeJson } from './localStore';

// Spec: docs/contrib/sync-protocol.md (section 3, the mass delete guard)
const MASS_DELETE_LIMIT = 10;
const MASS_DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

const HOLD_KEY = 'privacynotes.tombstoneHold';
const LOG_KEY = 'privacynotes.tombstoneLog';
const REFUSED_KEY = 'privacynotes.tombstoneRefused';

type Hold = { pubkey: string; ids: string[] };
type Refused = { pubkey: string; count: number };
type DeleteLog = { pubkey: string; deletes: Array<{ at: number; n: number }> };

function readHold(pubkey: string): string[] {
  const h = readJson<Partial<Hold> | null>(HOLD_KEY, null);
  if (!h || h.pubkey !== pubkey || !Array.isArray(h.ids)) return [];
  return h.ids.filter((id): id is string => typeof id === 'string');
}

function recentDeletes(pubkey: string, now: number): DeleteLog['deletes'] {
  const log = readJson<Partial<DeleteLog> | null>(LOG_KEY, null);
  if (!log || log.pubkey !== pubkey || !Array.isArray(log.deletes)) return [];
  return log.deletes.filter(
    (d) => d && typeof d.at === 'number' && typeof d.n === 'number' && now - d.at < MASS_DELETE_WINDOW_MS && d.at <= now,
  );
}

let current: Hold | null = null;
const { subscribe, notify } = createListeners();

// The listeners run on a later task: the pull sets a hold inside its Dexie
// transaction, and a render that reads the database must not run in it.
function publish(hold: Hold | null): void {
  current = hold;
  setTimeout(notify, 0);
}

/**
 * Which of these tombstones must wait. `removable` are the ids whose local
 * copy would go with no copy kept. Under the limit they are counted and
 * answered empty; past it, or while an earlier hold waits, they join the hold.
 */
export function holdTombstones(pubkey: string, removable: string[]): string[] {
  if (removable.length === 0) return [];
  const held = readHold(pubkey);
  const now = Date.now();
  const recent = recentDeletes(pubkey, now);
  const counted = recent.reduce((sum, d) => sum + d.n, 0);
  if (held.length === 0 && counted + removable.length <= MASS_DELETE_LIMIT) {
    writeJson(LOG_KEY, { pubkey, deletes: [...recent, { at: now, n: removable.length }] } satisfies DeleteLog);
    return [];
  }
  const hold: Hold = { pubkey, ids: [...new Set([...held, ...removable])] };
  writeJson(HOLD_KEY, hold);
  publish(hold);
  return removable;
}

/** The ids this account's hold names. */
export function heldTombstones(pubkey: string): string[] {
  const held = readHold(pubkey);
  if (held.length > 0) return held;
  return current?.pubkey === pubkey ? current.ids : [];
}

/** The answer is given: the hold goes. */
export function releaseTombstoneHold(): void {
  try {
    localStorage.removeItem(HOLD_KEY);
  } catch {
    /* ignore */
  }
  publish(null);
}

/** The ids any hold names, whatever the account: the notes a forced sign-out
 *  keeps, like an unsynced edit, because the server holds them no more. */
export function storedHoldIds(): string[] {
  const h = readJson<Partial<Hold> | null>(HOLD_KEY, null);
  return h && Array.isArray(h.ids) ? h.ids.filter((id): id is string => typeof id === 'string') : [];
}

/** A sign-out that wipes the notes, or another account: the hold and the
 *  count go with the notes they name. A forced sign-out keeps both. */
export function clearMassDeleteState(): void {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    /* ignore */
  }
  dismissRefusedDelete();
  releaseTombstoneHold();
}

/** For the dialog: the hold found at the start of this run, or since. */
export function getTombstoneHold(): Hold | null {
  if (current) return current;
  const h = readJson<Partial<Hold> | null>(HOLD_KEY, null);
  if (h && typeof h.pubkey === 'string' && Array.isArray(h.ids) && h.ids.length > 0) {
    current = { pubkey: h.pubkey, ids: h.ids.filter((id): id is string => typeof id === 'string') };
  }
  return current;
}

export const subscribeTombstoneHold = subscribe;

let refused: Refused | null = null;

/** A pull refused `n` deletes with a bad seal and put the notes back: the
 *  notice counts them until the person closes it. */
export function noteRefusedDelete(pubkey: string, n: number): void {
  const before = getRefusedDelete();
  const count = (before?.pubkey === pubkey ? before.count : 0) + n;
  refused = { pubkey, count };
  writeJson(REFUSED_KEY, refused);
  setTimeout(notify, 0);
}

/** For the notice: the refused deletes not yet seen, or null. */
export function getRefusedDelete(): Refused | null {
  if (refused) return refused;
  const r = readJson<Partial<Refused> | null>(REFUSED_KEY, null);
  if (r && typeof r.pubkey === 'string' && typeof r.count === 'number' && r.count > 0) {
    refused = { pubkey: r.pubkey, count: r.count };
  }
  return refused;
}

/** The notice is closed, or the notes it named left with a sign-out. */
export function dismissRefusedDelete(): void {
  try {
    localStorage.removeItem(REFUSED_KEY);
  } catch {
    /* ignore */
  }
  refused = null;
  setTimeout(notify, 0);
}
