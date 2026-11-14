import {
  encryptNote,
  notePlaintext,
  decryptNote,
  bytesToBase64,
  base64ToBytes,
  type SupabaseClient,
} from '@notes/shared';
import { logAuthEvent } from './authDiag';
import { recordSyncFault } from './syncFaults';
import { ownsLocalData } from './authStorage';
import { db, notesWriteCount, type LocalNote } from './db';
import { heartbeat } from './devices';
import { isDemoMode } from './demo';
import { assertMfaAccess, isMfaRefusal, MfaRequiredError } from './mfaStep';
import { dmsGate, dropForeignDmsHold } from './dms';
import { readSideField } from './localSeal';
import { currentKeyEpoch, epochOf, keyEpochColumn, KeyEpochUnknown, openWithRing } from './keyRing';
import { isPhraseReplacedRefusal, PhraseReplacedError, phraseReplacedStop, reportPhraseReplaced } from './phraseReplaced';
import {
  buildSyncBase,
  compareStamps,
  fieldsEqual,
  editStampMoves,
  fieldsOfLocal,
  fieldsOfPayload,
  laterStamp,
  localPatchOf,
  mergedEditedAt,
  mergeNoteFields,
  resolveConflictFields,
  serverFieldsOf,
  trustedBase,
  type MergeSide,
  type NoteFields,
  type SyncBase,
} from './noteMerge';
import { nextStamp } from './notesRepo';
import { normalizeSchedule } from './schedule';
import { sameContent } from './editStamp';
import { isServerWriteBlocked } from './syncPause';
import { heldTombstones, holdTombstones, noteRefusedDelete, releaseTombstoneHold } from './massDelete';
import { keepReplacedCopies, type PullReplacement } from './replacedCopies';
import { isUuid } from './uuid';
import { checkTombstoneSeal, sealTombstone, type SealVerdict } from './tombstoneSeal';

/* ── Conflict types ─────────────────────────────────────────────── */

/** A note conflict that couldn't be auto-merged (both sides changed body). */
export interface NoteConflict {
  noteId: string;
  localNote: LocalNote;
  /** The server's version, decrypted: the generation the push met. */
  serverTitle: string;
  serverBody: string;
  serverTags: string[];
  serverTrackers?: Record<string, unknown>;
  serverStarred: boolean;
  serverTrashed: boolean;
  serverLocked: boolean;
  serverPinProtected: boolean;
  serverType: import('@notes/shared').NoteType;
  serverFolderId: string | null;
  serverArchived: boolean;
  /** True when the server's payload carried no `archived` (a writer before
   *  Archive): an answer from a device that does not know the flag either
   *  leaves it out (archiveUnknownOf). */
  serverArchiveAbsent?: boolean;
  serverUpdatedAt: string;
  /** The server version's "last edited" stamp, when its payload carries one. */
  serverEditedAt?: string;
  /** The encrypted row from the server (for re-push after resolution). */
  serverRow: { ciphertext: string; nonce: string; updated_at: string };
}

const LAST_SYNC_KEY = 'privacynotes.lastSync';
/** `db.kv` key of the rows a pull could not decrypt, as a JSON list of ids.
 *  In IndexedDB, so the sign-out wipe takes it with the notes (GitHub #655). */
const PULL_RETRY_KEY = 'pullRetryIds';
/** Ids per request when the failed rows are fetched again, and the most kept. */
const RETRY_CHUNK = 100;
const RETRY_MAX = 1000;

/**
 * `db.kv` key of the key epoch the cursor and the retry list were built
 * under. Absent is epoch 1, so an account that never changed its phrase
 * stores nothing new. A device whose current key epoch differs (it took a
 * new phrase) resets both and pulls everything again: an older pass may have
 * moved the cursor past rows it could not open, and the retry list holds at
 * most RETRY_MAX of them. Dirty rows stay, as on every pull.
 * Spec: docs/internal/plans/phrase-change.md (6.6, pull cursor)
 */
const CURSOR_EPOCH_KEY = 'pullCursorEpoch';

function readRetryIds(raw: unknown): string[] {
  try {
    const list: unknown = typeof raw === 'string' ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)).slice(0, RETRY_MAX);
  } catch {
    return [];
  }
}

/**
 * Set once per device after the one-time full pull that recovers notes
 * stranded behind the cursor by a backdated import. Presence means the
 * heal already ran; absence on an existing install means it has not.
 * Never cleared. Do not reuse this key for a future forced resync - add
 * a new one, or devices that already healed will skip it.
 * Spec: packages/supabase/migrations/history/0063_note_ingested_at.sql
 */
const INGESTED_HEAL_KEY = 'privacynotes.ingestedHeal';
/** One-time full re-pull after migration 0065. See the heal block below. */
const KEYSET_HEAL_KEY = 'privacynotes.keysetHeal';
/** One-time full re-pull that records every row's server generation and
 *  base. See the heal block below. */
const BASE_HEAL_KEY = 'privacynotes.baseHeal';

/**
 * The guard a push uses for a row that records no server generation (never
 * pushed, or last synced before generations were recorded). It matches no
 * nonce, so the conditional update always misses and the conflict read
 * decides: an insert when the server lacks the row, a merge with no base
 * when it holds one. Such a row never writes over a version it has not seen.
 */
const UNRECORDED_GENERATION = 'unrecorded';

/** Cursor at the very beginning of time, before any row exists. */
const EPOCH_CURSOR = '1970-01-01T00:00:00Z';

/**
 * The generation each note's last push sent, kept while its answer is not
 * known. A push whose reply was lost had landed, but this device never
 * recorded it, so the next pass read the server row as another device's
 * version and offered this device's own earlier text back as "the other
 * version" (external report, 2026-10-24, bug report 12). The conflict read
 * checks the server nonce against this map. Per tab: a reload forgets it,
 * and the conflict then reaches the dialog as before.
 *
 * Each entry also names the base an echo of it merges against. A plain push
 * sends this row's content, so the landed version itself is the base. A
 * merge write and a "use mine" answer send content the row may never get: an
 * edit made while one was in flight sits on the row as it was when the write
 * was computed, so that row is the base, and only the other side's part of
 * the landed version reads as theirs.
 */
const sentNonces = new Map<string, Array<{ nonce: string; base?: SyncBase }>>();

/** Remember a generation this tab is about to send for a note: the last few,
 *  because the next push sends a new one before it learns the old one landed.
 *  `grewFrom`: the row the write was computed from, when its content is not
 *  that row's (a merge write, a "use mine" answer). */
function rememberSent(noteId: string, nonce: string, grewFrom?: LocalNote): void {
  const base = grewFrom ? buildSyncBase(localSide(grewFrom).fields, nonce) : undefined;
  sentNonces.set(noteId, [...(sentNonces.get(noteId) ?? []).slice(-4), { nonce, base }]);
}


/**
 * The cursor is stored as `<changed_at>|<id>` so the sweep can resume
 * mid-tie. Values written before migration 0065 are a bare timestamp:
 * read those as "start of that instant, no id", which re-reads that one
 * instant and is harmless (re-applying a row is idempotent), where
 * guessing an id could skip one.
 */
function parseCursor(raw: string): [string, string | null] {
  const bar = raw.indexOf('|');
  if (bar === -1) return [raw, null];
  return [raw.slice(0, bar), raw.slice(bar + 1)];
}

function formatCursor(at: string, id: string | null): string {
  return id === null ? at : `${at}|${id}`;
}

/**
 * A row's sync base, when the conflict path may merge against it: the
 * base must describe the generation the row records as synced
 * (noteMerge.ts trustedBase). At rest the base sits sealed beside the row,
 * so this is the one way to read it.
 */
function noteBaseOf(note: LocalNote): SyncBase | undefined {
  return trustedBase(readSideField('notes', note), note.syncedNonce);
}

/**
 * The local row a tombstone is about to delete, kept as a new note when it
 * holds an edit that never reached the server: the server removed its content
 * at once, so this row is the last copy of that work. A fresh id, because the
 * resurrection guard drops every write to the tombstoned one; no sync record,
 * so the next push takes the first-insert path. A clean row, a row in the
 * trash and a local delete go with the tombstone.
 * Spec: docs/contrib/sync-protocol.md (section 3, an unsynced edit)
 */
function tombstoneCopy(local: LocalNote | undefined): LocalNote | null {
  if (!local || (local.dirty !== 1 && local.dirty !== 2) || local.deleted === 1 || local.trashed === 1) return null;
  return copyUnderNewId(local);
}

/**
 * The row on disk is still the copy a pass read: the same stamp and the same
 * fields. The stamp alone is not enough, because some writes keep it on
 * purpose (a date stamped on a new item at its birth stamp, a derived title),
 * and a pass that read the row before such a write would mark it clean unsent.
 * Spec: docs/contrib/sync-protocol.md (section 2, every accepted push)
 */
function unchangedSince(current: LocalNote, read: LocalNote): boolean {
  return current.updatedAt === read.updatedAt && fieldsEqual(fieldsOfLocal(current), fieldsOfLocal(read));
}

function copyUnderNewId(local: LocalNote): LocalNote {
  const { syncedNonce: _nonce, ...rest } = local;
  return { ...rest, id: crypto.randomUUID(), dirty: 1, syncBase: undefined };
}

/** A note this device still shows that a tombstone would remove with no copy
 *  kept: the only kind the mass delete guard counts (massDelete.ts). */
function removedByTombstone(local: LocalNote | undefined): boolean {
  return local !== undefined && local.deleted !== 1 && local.trashed !== 1 && tombstoneCopy(local) === null;
}

/** Delete tombstoned rows, keeping each unsynced edit as a new note. Call it
 *  inside a transaction on db.notes, so no autosave lands between the read
 *  and the delete. */
async function applyTombstones(ids: string[]): Promise<void> {
  const copies = (await db.notes.bulkGet(ids)).map(tombstoneCopy).filter((n): n is LocalNote => n !== null);
  if (copies.length > 0) await db.notes.bulkAdd(copies);
  await db.notes.bulkDelete(ids);
}

/**
 * The tombstones of one pull, by their seals (tombstoneSeal.ts). Only a
 * tombstone that would remove a note this device still shows is judged. A
 * valid seal goes. A bad seal was not made with this account's key: the note
 * stays and goes back to the server under keptId, and the person is told
 * once. No seal (an app before 0130, or a session alone) meets the mass
 * delete guard: past its limit those notes wait in the hold. Answers how
 * many rows changed. Call it inside a transaction on db.notes, like
 * applyTombstones.
 * Spec: docs/contrib/sync-protocol.md (section 3, sealed deletes)
 */
async function settleTombstones(pubkey: string, ids: string[], seals: ReadonlyMap<string, SealVerdict>): Promise<number> {
  const rows = await db.notes.bulkGet(ids);
  const removable = ids.filter((_, i) => removedByTombstone(rows[i]));
  const refused = new Set(removable.filter((id) => seals.get(id) === 'bad'));
  const unsealed = removable.filter((id) => (seals.get(id) ?? 'none') === 'none');
  const held = new Set(holdTombstones(pubkey, unsealed));
  if (refused.size > 0) {
    await keepUnderKeptIds([...refused]);
    noteRefusedDelete(pubkey, refused.size);
  }
  const now = ids.filter((id) => !held.has(id) && !refused.has(id));
  if (now.length > 0) await applyTombstones(now);
  return now.length + refused.size;
}

/**
 * The generation a kept note records until its first push: never a real
 * nonce, so its conditional update always misses and the conflict read
 * decides (pushOne). Its base is its own content.
 */
const KEPT_GENERATION = 'kept';

/**
 * The id a kept note takes: the old id with each hex digit moved up by one.
 * Every device that answers Keep for the same note computes the same id, so
 * two restores are one note, which the push merges as any other, never two.
 * Plain string work, so it runs inside the Dexie transaction.
 */
function keptId(id: string): string {
  return id.toLowerCase().replace(/[0-9a-f]/g, (d) => ((parseInt(d, 16) + 1) % 16).toString(16));
}

/** A held note restored under keptId, its base its own content. */
function keptCopy(n: LocalNote): LocalNote {
  return {
    ...copyUnderNewId(n),
    id: keptId(n.id),
    syncedNonce: KEPT_GENERATION,
    syncBase: buildSyncBase(fieldsOfLocal(n), KEPT_GENERATION),
  };
}

/**
 * "Keep my notes": each held note goes back to the server as a new note,
 * under keptId (the server refuses every write to a tombstoned id), and the
 * tombstoned id goes. Another device's restore of the same note can already
 * be here under that id: a held note with the same content then goes
 * without a second copy, and one that differs is kept beside it under a
 * fresh id. Two restores that first meet on the server are settled in the
 * push (KEPT_GENERATION): neither version is lost there either.
 */
export async function keepHeldNotes(pubkey: string): Promise<void> {
  const ids = heldTombstones(pubkey);
  if (ids.length > 0) await db.transaction('rw', db.notes, () => keepUnderKeptIds(ids));
  releaseTombstoneHold();
}

/** Put tombstoned notes back as new notes under keptId (keepHeldNotes) and
 *  remove the tombstoned ids. Call it inside a transaction on db.notes. */
async function keepUnderKeptIds(ids: string[]): Promise<void> {
  const held = (await db.notes.bulkGet(ids)).filter((n): n is LocalNote => n !== undefined && n.deleted !== 1);
  const there = await db.notes.bulkGet(held.map((n) => keptId(n.id)));
  const copies: LocalNote[] = [];
  held.forEach((n, i) => {
    const other = there[i];
    if (!other) copies.push(keptCopy(n));
    else if (other.deleted === 1 || !fieldsEqual(fieldsOfLocal(other), fieldsOfLocal(n))) copies.push(copyUnderNewId(n));
  });
  if (copies.length > 0) await db.notes.bulkAdd(copies);
  await db.notes.bulkDelete(ids);
}

/** "Delete them here too": the held tombstones go as any other does, an
 *  edit made while the question waited kept as a new note. */
export async function deleteHeldNotes(pubkey: string): Promise<void> {
  const ids = heldTombstones(pubkey);
  if (ids.length > 0) await db.transaction('rw', db.notes, () => applyTombstones(ids));
  releaseTombstoneHold();
}

/**
 * A queued conflict describes its row while the row keeps the generation it
 * was detected on. A row that moved on since (a later pass merged it, or it
 * is gone) is not the row the dialog asked about, and an answer writes
 * nothing to it.
 */
function stillOpen(conflict: NoteConflict, row: LocalNote | undefined): row is LocalNote {
  return row !== undefined && row.syncedNonce === conflict.localNote.syncedNonce;
}

/** A local row as one side of a merge. */
function localSide(row: LocalNote): MergeSide {
  return { fields: fieldsOfLocal(row), updatedAt: row.updatedAt, editedAt: row.editedAt };
}

/**
 * Every answer applies the chosen body over the rest of the note merged field
 * by field, exactly as a push merges it, over the row as it stands NOW: a
 * star or a folder set here while the dialog waited is merged, not
 * overwritten. The "last edited" date follows the body the answer keeps.
 */
function answerFields(
  row: LocalNote,
  server: MergeSide,
  choice: 'local' | 'server' | 'both',
) {
  const local = localSide(row);
  const answer = resolveConflictFields(noteBaseOf(row), local, server, choice);
  const editedAt = mergedEditedAt(local, server, answer.fields);
  return { ...answer, sameAsServer: answer.sameAsServer && !editStampMoves(editedAt, server.editedAt), editedAt };
}

/**
 * "Use mine": push this device's body over the merged rest, only over the
 * version the dialog showed, so a third version pushed while the dialog was
 * open is never replaced unseen. `seal` encrypts the payload with the
 * dialog's own key snapshot. A push that does not land leaves the row dirty
 * for the next pass.
 *
 * Below the release floor or under the user's pause, nothing goes to the
 * server. The answer is kept on this device instead: the row takes the
 * merged fields, dirty, over the generation the dialog showed, so the first
 * pass after the block lifts pushes it there, or merges it if the server
 * moved again. The question is not asked twice.
 */
export async function pushConflictAnswer(
  supabase: SupabaseClient,
  pubkey: string,
  conflict: NoteConflict,
  seal: (payload: Omit<NoteFields, 'archived'> & { archived?: boolean; editedAt?: string }) => { ciphertext: string; nonce: string },
): Promise<'stale' | 'pushed' | 'not-landed' | 'deferred'> {
  const { noteId } = conflict;
  const serverNonce = conflict.serverRow.nonce;
  const fresh = await db.notes.get(noteId);
  if (!stillOpen(conflict, fresh)) return 'stale';
  const server: MergeSide = {
    fields: serverFieldsOf(conflict),
    updatedAt: conflict.serverUpdatedAt,
    editedAt: conflict.serverEditedAt,
  };
  const { fields, editedAt } = answerFields(fresh, server, 'local');
  const stamp = nextStamp(laterStamp(fresh.updatedAt, conflict.serverUpdatedAt));
  if (isServerWriteBlocked()) {
    const kept = await db.transaction('rw', db.notes, async () => {
      const cur = await db.notes.get(noteId);
      if (!stillOpen(conflict, cur)) return false;
      // Merged over the row as it stands now, so an edit made while the
      // dialog waited is part of the kept answer.
      const now = answerFields(cur, server, 'local');
      await db.notes.update(noteId, {
        ...localPatchOf(now.fields),
        editedAt: now.editedAt,
        dirty: 1,
        updatedAt: nextStamp(laterStamp(cur.updatedAt, conflict.serverUpdatedAt)),
        syncedNonce: serverNonce,
        syncBase: buildSyncBase(server.fields, serverNonce),
      });
      return true;
    });
    return kept ? 'deferred' : 'stale';
  }
  const leaveOut = archiveUnknownOf(fresh) && conflict.serverArchiveAbsent === true && !fields.archived;
  const { ciphertext, nonce } = seal({ ...fields, ...(leaveOut ? { archived: undefined } : {}), editedAt });
  rememberSent(noteId, nonce, fresh);
  // `.select('id')` is how a write that did not land shows: supabase-js
  // reports network and HTTP failures through `error` without throwing, and
  // a write to a row tombstoned while the dialog was open is dropped by the
  // 0034 trigger with zero rows. Either one recorded as synced would strand
  // the kept version on this device under a green check.
  const { data: forced, error: forceErr } = await supabase
    .from('notes')
    .update({ ciphertext, nonce, updated_at: stamp, ...keyEpochColumn() })
    .eq('id', noteId)
    .eq('user_pubkey', pubkey)
    .eq('nonce', serverNonce)
    .select('id');
  if (isPhraseReplacedRefusal(forceErr)) reportPhraseReplaced('write');
  if (forceErr || !forced || forced.length === 0) {
    console.error('[conflict] keep-mine push did not land for', noteId, forceErr);
    return 'not-landed';
  }
  await db.transaction('rw', db.notes, async () => {
    const cur = await db.notes.get(noteId);
    // An edit that landed during the push stays unsynced, and the next pass
    // merges it against this generation.
    if (cur && unchangedSince(cur, fresh)) {
      await db.notes.update(noteId, {
        ...localPatchOf(fields),
        editedAt,
        dirty: 0,
        updatedAt: stamp,
        syncedNonce: nonce,
        syncBase: buildSyncBase(fields, nonce),
      });
    }
  });
  return 'pushed';
}

/**
 * "Use the other version", and the original note of "Keep both": the other
 * device's body over the merged rest, written locally. The server may have
 * moved while the dialog was open, and a pull skips an unsynced row, so its
 * cursor has already passed the newer version: the answer therefore applies
 * to the version the server holds when the person answers, read here, and
 * merges the rest against that. A result equal to the server's version is
 * that generation, recorded clean. Anything else is a change the server has
 * not seen, left dirty over that generation with the server version as its
 * base, so the next push goes out on it (or merges, if the server moved
 * again). When the server cannot be read, the version the dialog showed
 * stands in, never recorded clean, so the next push settles it.
 *
 * `keepCopy` writes the "Keep both" copy of this device's text in the same
 * transaction, before the answer replaces it: this device's text was never
 * sent, so a copy written after the answer left it in memory only, and a
 * closed tab or a failed write lost it. A copy that throws writes nothing,
 * the answer included, and the error reaches the caller.
 */
export async function writeConflictAnswer(
  supabase: SupabaseClient,
  pubkey: string,
  encryptionKey: Uint8Array,
  conflict: NoteConflict,
  choice: 'server' | 'both',
  keepCopy?: (cur: LocalNote) => Promise<void>,
): Promise<'stale' | 'written'> {
  const { noteId } = conflict;
  const shown = {
    fields: serverFieldsOf(conflict),
    updatedAt: conflict.serverUpdatedAt,
    editedAt: conflict.serverEditedAt,
    nonce: conflict.serverRow.nonce,
  };
  let current: typeof shown | null = null;
  try {
    const { data, error } = await supabase
      .from('notes')
      .select('ciphertext, nonce, updated_at, deleted_at')
      .eq('id', noteId)
      .eq('user_pubkey', pubkey)
      .maybeSingle();
    // A tombstone holds no content: the shown version stands in, as for an
    // unreadable row, and the next push drops the note and keeps any copy
    // "Keep both" made.
    if (!error && data && !data.deleted_at) {
      if (data.nonce === shown.nonce) {
        current = shown;
      } else {
        const ct = base64ToBytes(data.ciphertext);
        const nonce = base64ToBytes(data.nonce);
        const payload = openWithRing('sync', encryptionKey, (key) => decryptNote(ct, nonce, key));
        current = {
          fields: fieldsOfPayload(payload, shown.fields.archived),
          updatedAt: data.updated_at,
          editedAt: payload.editedAt,
          nonce: data.nonce,
        };
      }
    }
  } catch (err) {
    console.warn('[conflict] could not read the server version for', noteId, err);
  }
  const server = current ?? shown;
  const serverBase = buildSyncBase(server.fields, server.nonce);
  const written = await db.transaction('rw', db.notes, async () => {
    const cur = await db.notes.get(noteId);
    if (!stillOpen(conflict, cur)) return false;
    if (keepCopy) await keepCopy(cur);
    const { fields, sameAsServer, editedAt } = answerFields(cur, server, choice);
    await db.notes.update(noteId, {
      ...localPatchOf(fields),
      editedAt,
      syncedNonce: server.nonce,
      syncBase: serverBase,
      ...(sameAsServer && current
        ? { dirty: 0, updatedAt: server.updatedAt }
        : { dirty: 1, updatedAt: nextStamp(laterStamp(cur.updatedAt, server.updatedAt)) }),
    });
    return true;
  });
  return written ? 'written' : 'stale';
}

/** Whether this device writes the note without an archive flag: it took
 *  the row from a writer before Archive and has not learned the flag since. */
function archiveUnknownOf(note: Pick<LocalNote, 'archived' | 'archivedUnknown'>): boolean {
  return note.archivedUnknown === 1 && note.archived !== 1;
}

/** Mutex - prevents overlapping sync calls from racing on dirty-flag clears. */
let syncInFlight = false;

/** Bumped by suspendSync(). A pass captures the value at start and
 * refuses to persist its cursor or consume heal flags if it changed:
 * a pass that outlives sign-out used to re-create
 * `privacynotes.lastSync` AFTER the wipe removed it, leaving the
 * locally wiped rows behind the resurrected cursor - invisible forever
 * on the next same-user sign-in. */
let syncGeneration = 0;
/** While set, sync() refuses to start new passes. */
let syncSuspended = false;

/** Called by auth when the sign-out wipe begins (after its own rescue
 * flush). The in-flight pass, if any, finishes its writes but loses
 * the right to persist cursor/heal state; new passes no-op until
 * resumeSync(). Also called on the stale-tab bailout, where a pass
 * from the OLD account must not persist its cursor into storage that
 * now belongs to a different account. */
export function suspendSync(): void {
  syncGeneration++;
  syncSuspended = true;
}

/** Re-enables sync. Called at the end of sign-out and at the start of
 * authentication, so a failed sign-out can never leave sync dead. */
export function resumeSync(): void {
  syncSuspended = false;
  claimGateBrokenSince = 0;
}

/** How long the session claim may stay broken before it escalates to
 * SessionExpiredError. Measured in wall-clock time, never in passes:
 * `runSync()` is event-driven (mount, visibilitychange, online, and
 * ~25 user-action call sites) on top of the 30 s poll, and a
 * claim-mismatch pass returns after a single local storage read. A
 * strike budget was therefore spendable in milliseconds - alt-tabbing
 * twice during boot burned all three and popped the re-auth modal long
 * before a re-mint that legitimately takes seconds could finish.
 * Sized to match AUTH_TIMEOUT_MS in auth.tsx, the point at which the
 * blocking sign-in path gives up on the network. */
const CLAIM_GATE_GRACE_MS = 15_000;
/** When the current run of claim mismatches began; 0 when the claim is
 * healthy. Reset by a passing gate and by resumeSync(). */
let claimGateBrokenSince = 0;
/** One breadcrumb per broken episode, not one per failing pass - the
 * poll would otherwise flood the ring buffer while the modal is up. */
let claimGateExpiredLogged = false;

/** Set to true when account deletion starts. Subsequent `sync()` calls
 * become no-ops so an in-flight client can't repopulate notes seconds
 * after the server-side delete completes. Reset is implicit: the page
 * reloads at the end of deletion. See gap #3. */
let deletingAccount = false;

/** Flip the deletion flag. DangerZone calls this with `true` immediately
 * before invoking delete-account. */
export function setDeletingAccount(value: boolean): void {
  deletingAccount = value;
}

/** Phase 1: fetch the first page of the sweep and render immediately
 * so the user has something to work with within ~1-2 s of login. */
const PHASE1_SIZE = 100;

/** Phase 2: pull the rest in chunks of this size (keep it at or below
 * 1000, the PostgREST max rows per request).
 * No intermediate renders - the UI updates once when phase 2 finishes. */
const PHASE2_CHUNK = 500;

/** Error thrown when the server reports our device was revoked. The caller
 * (NotesView sync loop) catches this and invokes `forceSignOut`. */
export class DeviceRevokedError extends Error {
  constructor() {
    super('device_revoked');
    this.name = 'DeviceRevokedError';
  }
}

/** Error thrown when a push fails due to storage quota being exceeded.
 * The caller should show a user-facing notification. */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/** Error thrown when the Supabase session is expired or invalid.
 * The caller should show a re-auth prompt. */
export class SessionExpiredError extends Error {
  constructor() {
    super('session_expired');
    this.name = 'SessionExpiredError';
  }
}

/**
 * The server refused the sign-in for want of a CAPTCHA token.
 *
 * Extends SessionExpiredError on purpose: every existing `instanceof
 * SessionExpiredError` caller already does the right thing with it
 * (surface the re-auth path rather than treat it as offline), and the
 * sign-in screen narrows to this subtype when it needs to know that a
 * token specifically is what is missing.
 *
 * Every sign-in path attempts a tokenless handshake first and mounts
 * the Turnstile widget only when the server says a token is required
 * (the web-only gate in the link-pubkey edge function - natives are
 * never asked). That way the server's TURNSTILE_WEB_ENFORCE secret is
 * the single source of truth - flipping enforcement on does not
 * require a release.
 * Spec: docs/internal/design-decisions.md (Turnstile is web-only, enforced at link-pubkey)
 */
export class CaptchaRequiredError extends SessionExpiredError {
  constructor() {
    super();
    this.name = 'CaptchaRequiredError';
  }
}

/**
 * The server refused a session re-mint for want of QUOTA, not for want
 * of credentials: HTTP 429 / `over_request_rate_limit`.
 *
 * Deliberately NOT a SessionExpiredError subclass, unlike
 * CaptchaRequiredError above. Every `instanceof SessionExpiredError`
 * site routes to the re-auth prompt, and re-auth is the one thing that
 * cannot help here: signing out wipes the local session and the
 * sign-in that follows burns another anonymous sign-in against the
 * same cap. This is a third category - not "offline" (no verdict, stay
 * quiet), not "needs re-auth" (only the user can fix it), but "not
 * now" (nobody needs to do anything; it comes good on its own).
 *
 * Carries the server's own wording as its message because the
 * interactive sign-in path surfaces `err.message` verbatim.
 *
 * Anonymous sign-ins are capped per IP per hour and every re-mint
 * creates a brand new anonymous user, so a machine running several
 * browser profiles, or reloading through a session that has already
 * gone bad, exhausts the cap quickly.
 * Spec: docs/internal/design-decisions.md (rate-limited re-mint)
 */
export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/**
 * True when a sign-in refusal is a quota refusal rather than a
 * credential problem. Kept as a pure predicate (and unit-tested) so
 * the classification cannot drift: it is the single thing standing
 * between "back off and retry" and a re-auth prompt that makes the
 * problem worse.
 *
 * Matches on three signals because GoTrue has reworded this before:
 * the HTTP status, the stable error code, and the message as a last
 * resort.
 */
export function isRateLimitError(
  err: { status?: number; code?: string; message?: string } | null | undefined,
): boolean {
  if (!err) return false;
  return (
    err.status === 429 ||
    err.code === 'over_request_rate_limit' ||
    /rate limit/i.test(err.message ?? '')
  );
}

/** Set while a session re-mint is known to be refused on quota. See
 * RateLimitedError and the claim gate in syncInner. */
let remintBlockedUntil = 0;

/** Called by auth when a re-mint is refused on quota (`ms` > 0, the
 * length of the planned backoff) and again when one finally lands
 * (`ms` === 0). Keeps the claim gate from escalating a session that is
 * unminted rather than expired. */
export function setRemintBlocked(ms: number): void {
  remintBlockedUntil = ms > 0 ? Date.now() + ms : 0;
}

/** Check if a Supabase error indicates an expired/invalid JWT. */
function isAuthError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const msg = (err.message ?? '').toLowerCase();
  const code = err.code ?? '';
  return (
    code === '401' ||
    code === 'PGRST301' ||
    msg.includes('jwt expired') ||
    msg.includes('invalid jwt') ||
    msg.includes('jwt claim') ||
    msg.includes('token is expired') ||
    msg.includes('not authorized') ||
    msg.includes('invalid claim')
  );
}

/** A row-level-security refusal is an identity verdict, not a transient
 *  fault: the server is saying this session may not write these rows at
 *  all, so retrying the same rows - or walking the rest of the queue
 *  into the same wall, one console error per note - helps nobody. The
 *  live incident produced a thousand-error storm this way. Treated like
 *  an ownership loss: end the push quietly, rows stay dirty. */
function isRlsError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '42501' || (err.message ?? '').includes('row-level security');
}

/** A genuine account-level storage rejection of a note write. The quota
 * triggers RAISE with "Quota exceeded: ..."; the 90-day freeze RAISEs "Sync
 * frozen: ...". Both carry SQLSTATE 23514, so match on the message - this is
 * what drives the account-level "Storage full" banner. Also read by the
 * phrase change's re-encrypt pass (reencryptPass.ts). */
export function isQuotaError(err: { message?: string } | null): boolean {
  const msg = err?.message ?? '';
  return msg.includes('Quota exceeded') || msg.includes('Sync frozen');
}

/** A single note that breached the per-row size CHECK constraint
 * (notes_ciphertext_max_1mb). Shares SQLSTATE 23514 with the quota
 * triggers but is NOT an account-storage problem - this one note is too
 * big. Must route to the per-note retry banner, never the global
 * "Storage full" banner. */
function isNoteTooLargeError(err: { code?: string; message?: string } | null): boolean {
  return err?.code === '23514' && !!err.message?.includes('notes_ciphertext_max_1mb');
}

/** The server's per-row ceiling: `octet_length(ciphertext) <= 1048576`.
 * The column holds base64, which is ASCII, so a JavaScript string length
 * counts the same bytes the CHECK does. Measuring the row here keeps a
 * note the server can only refuse off the wire entirely.
 * Spec: packages/supabase/migrations/history/0009_abuse_limits.sql */
export const NOTE_MAX_STORED_BYTES = 1_048_576;

/** What a push encrypts for a note: the one place the row's payload is built. */
export function rowPayloadOf(note: LocalNote) {
  return { ...fieldsOfLocal(note), ...(archiveUnknownOf(note) ? { archived: undefined } : {}), editedAt: note.editedAt };
}

/** The exact length of the base64 ciphertext a push sends for the note, the
 *  number the server's CHECK compares, without encrypting it: the sealed JSON
 *  plus the 16-byte tag, then base64. */
export function storedNoteBytes(note: LocalNote): number {
  const sealed = notePlaintext(rowPayloadOf(note)).length + 16;
  return 4 * Math.ceil(sealed / 3);
}

/** Surfaced via onPushError when a note exceeds the 1 MB per-note size
 * limit. pushFailures.ts matches this exact string to mark the note
 * "not backed up" in the pill, the ID & Sync list and the editor. */
export const NOTE_TOO_LARGE_MSG = 'a note is over the 1 MB size limit';

type RemoteRow = {
  id: string;
  user_pubkey: string;
  ciphertext: string;
  nonce: string;
  created_at: string;
  updated_at: string;
  /** Tombstone timestamp. NULL = live row. Set by client on permanent delete. */
  deleted_at: string | null;
  /** Migration 0130: the seal of a tombstone (tombstoneSeal.ts). Absent on a
   *  server without 0130, NULL on a live row or an unsealed tombstone. */
  delete_seal?: string | null;
  /**
   * Server-assigned arrival time (DEFAULT now(), never sent by the client).
   * Distinct from updated_at, which is client-authoritative and can be
   * backdated by importers preserving the source app's dates.
   * Spec: packages/supabase/migrations/history/0063_note_ingested_at.sql
   */
  ingested_at: string;
  /**
   * Server-assigned change clock: set to now() by trigger on every
   * INSERT and UPDATE, never influenced by the client. The single key
   * the pull filters, sorts and keyset-pages on. Being pure server time
   * is what makes the ascending sweep safe: no client clock (skewed, or
   * an edit-time updated_at pushed hours later) can land a change
   * behind a cursor that already passed it.
   * Spec: packages/supabase/migrations/history/0066_notes_changed_at_server_assigned.sql
   */
  changed_at: string;
  /**
   * The key epoch the row's ciphertext was written under (keyRing.ts).
   * Absent before the column existed, which is epoch 1 like its default.
   * Spec: packages/supabase/migrations/history/0118_key_epoch.sql
   */
  key_epoch?: number;
};

/**
 * Pull-then-push sync.
 *
 * 1. Pull remote rows where `changed_at > cursor`, sweeping ascending
 *    and keyset-paging on `(changed_at, id)` (migration 0065). Rows
 *    with `deleted_at` set are tombstones - we bulkDelete them locally
 *    instead of upserting. For non-tombstones, if remote is newer than
 *    the local copy (or local doesn't exist), overwrite local. A row
 *    with an unsynced local change is left for its own push.
 * 2. Push all rows flagged dirty. Hard-deletes (`deleted=1` locally)
 *    become server-side `update({deleted_at: now()})` so other devices
 *    see the tombstone on their next pull. Every other row is written
 *    only over the server generation this device last synced (its
 *    `syncedNonce`); a row whose generation is behind goes to the
 *    conflict path, which merges field by field against that synced
 *    version (noteMerge.ts) and asks the user only when both sides
 *    changed the body.
 *
 * The `trashed`, `starred` and `archived` flags live inside the encrypted payload, so
 * they roundtrip the server without leaking any metadata.
 *
 * If an offline device pushes an edit for a row that was tombstoned
 * elsewhere, the server-side BEFORE UPDATE trigger (migration 0034)
 * silently drops the write and the row stays deleted. The next pull
 * brings the tombstone, and the unsynced edit is kept as a new note
 * under a fresh id (tombstoneCopy).
 */
export async function sync(
  supabase: SupabaseClient,
  pubkey: string,
  encryptionKey: Uint8Array,
  deviceId: string,
  /** Called after each pull batch is written to IndexedDB. The caller
   * typically triggers a UI refresh here so notes appear progressively. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onBatch?: () => any,
  /** Called once per note that failed to push for non-quota / non-auth
   * reasons. The note stays dirty=1 and retries next sync, but the
   * caller should surface a banner so silent stuck rows aren't invisible.
   * See gap #4. */
  onPushError?: (noteId: string, message: string) => void,
  /** Called when a body-vs-body conflict can't be auto-merged. The
   * caller should queue the conflict and show a resolution UI. */
  onConflict?: (conflict: NoteConflict) => void,
  /** flushOnly: push dirty rows and nothing else - no heartbeat, no
   * pull, no cursor advance. Used by sign-out to rescue unsynced notes
   * before the local wipe. Skipping the heartbeat is the point: a
   * revoked device fails the heartbeat gate (DeviceRevokedError) before
   * the push phase ever runs, but its JWT still authorizes note writes
   * (notes RLS keys off the pubkey claim only, not device registration),
   * so its unsynced rows can still be saved. */
  opts?: { flushOnly?: boolean },
): Promise<SyncResult> {
  // Demo mode never touches the server. No session, no pushes, no pulls.
  if (isDemoMode()) return { ran: false, pullOk: false, changed: false };
  // Below the release floor, or paused by the user, sync STOPS: the floor is
  // only raised for a sync/auth protocol change, a security fix, or a
  // data-corruption fix, and the pause is the user's explicit "this device
  // talks to no one" (syncPause.ts). The app stays fully usable locally; rows
  // stay dirty and push once the block lifts. Deliberately unconditional -
  // the sign-out rescue flush (flushOnly) is blocked too, because a bulk push
  // of old-protocol rows at sign-out is the worst-case write, and the
  // sign-out confirm already warns with the unsynced count. Heartbeat is NOT
  // gated (it is the revocation channel). Spec: docs/internal/android-update-check.md
  // (also the planned channel for a future server-side floor check)
  // A dead man's switch hold belongs to one account; another one's passes
  // must not stop at it (dms.ts).
  dropForeignDmsHold(pubkey);
  if (isServerWriteBlocked()) return { ran: false, pullOk: false, changed: false };
  // If account deletion is in flight, do nothing - we don't want to
  // upsert dirty rows that would land after the server-side wipe.
  if (deletingAccount) return { ran: false, pullOk: false, changed: false };
  // Sign-out wipe in progress - see suspendSync().
  if (syncSuspended) return { ran: false, pullOk: false, changed: false };
  // Mutex guard - if a sync is already running, skip silently.
  if (syncInFlight) return { ran: false, pullOk: false, changed: false };
  syncInFlight = true;
  // Private copy of the key for this pass: signOut zeroes the caller's
  // Uint8Array in place once its flush budget expires, and a pass still
  // in flight at that moment used to encrypt the remaining dirty notes
  // with the zeroed buffer - pushing permanently undecryptable
  // ciphertext over good server rows, then clearing the dirty flags.
  const passKey = new Uint8Array(encryptionKey);
  try {
    const inner = await syncInner(supabase, pubkey, passKey, deviceId, onBatch, onPushError, onConflict, opts);
    return {
      ran: true,
      pullOk: inner.pullOk,
      changed: inner.changed,
      pushed: inner.pushed ?? 0,
      pulled: inner.pulled ?? 0,
      ...(inner.halted ? { halted: inner.halted } : {}),
    };
  } finally {
    passKey.fill(0);
    syncInFlight = false;
  }
}

/**
 * What a `sync()` call actually did. Callers that make decisions based
 * on post-sync local state (e.g. the welcome-note seed gate) MUST check
 * `ran` and `pullOk`: a mutex-skipped or failed-pull pass leaves
 * IndexedDB unrepresentative of the server, and acting on it produced
 * a false "fresh vault" verdict while a concurrent first pull was still
 * in flight.
 */
export type SyncResult = {
  /** False when the call was a no-op (demo mode, below the release floor,
   *  deletion in flight, or another sync already running). */
  ran: boolean;
  /** True when the pull phase completed without errors. Only meaningful
   *  when `ran` is true. */
  pullOk: boolean;
  /** Rows the server accepted this pass (0 when skipped): inserts and
   *  updates it confirmed, merges that landed, deletes it confirmed. A row
   *  it refused, a conflict left for the dialog and a row never sent are
   *  not counted. */
  pushed?: number;
  /** Rows plus tombstones the pull phase applied locally this pass. */
  pulled?: number;
  /** True when the pass wrote this device's notes: rows pulled or applied,
   *  or a push that marked a row clean, deleted one or merged one. A poll
   *  tick that wrote nothing reports false, a dirty note that cannot push
   *  included, so callers can skip vault-sized post-pass work (#643). */
  changed: boolean;
  /** Set when the push stopped before it reached every dirty row. The stop
   *  raises no per-note error, so this is the only record the pass keeps
   *  of the rows it left behind. */
  halted?: PushHalt;
};

/** How a push phase stopped short of its queue. */
export type PushHalt = {
  /** 'refused': the server refused a write under row-level security, a
   *  verdict about this session that no retry of the same rows changes.
   *  'aborted': the account changed under the pass (the session claim,
   *  the owner marker or the sync generation), so the rows belong to
   *  whoever owns the storage at that point. 'blocked': the release floor
   *  or the user's pause arrived during the pass. */
  reason: 'refused' | 'aborted' | 'blocked';
  /** Dirty rows the stop left off the server: the rows of the refused
   *  write, and every row the pass had not sent yet. All stay dirty for
   *  the next pass. */
  unreached: number;
};

async function syncInner(
  supabase: SupabaseClient,
  pubkey: string,
  encryptionKey: Uint8Array,
  deviceId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onBatch?: () => any,
  onPushError?: (noteId: string, message: string) => void,
  onConflict?: (conflict: NoteConflict) => void,
  opts?: { flushOnly?: boolean },
): Promise<{ pullOk: boolean; changed: boolean; pushed?: number; pulled?: number; halted?: PushHalt }> {
  // Flush-only mode (sign-out rescue): no heartbeat, no pull, no cursor
  // advance - jump straight to the push phase. See sync() docs.
  const flushOnly = opts?.flushOnly === true;

  // Captured before any server work: if sign-out begins mid-pass
  // (suspendSync bumps the generation), this pass may finish its writes
  // but must not persist cursor or heal state afterwards.
  const generation = syncGeneration;

  // The session must prove it is THIS vault's session before any server
  // call. Under a missing or foreign pubkey claim, RLS does not error -
  // it silently filters every row to nothing - so a pass would pull an
  // empty vault, false-confirm tombstones against a blind confirming
  // SELECT (destroying the only record that a delete was pending), and
  // classify every dirty row as never-uploaded. Migration 0064 made the
  // heartbeat fail OPEN for exactly this broken-session state, so the
  // gate has to live here instead.
  //
  // The gate must never punish states that are not the session's fault:
  // - A refresh that failed because the server was UNREACHABLE (offline,
  //   captive portal, Supabase outage) is not a verdict. Skipping the
  //   pass quietly preserves the invariant that offline use never
  //   demotes the session (auth.tsx documents it for revalidation).
  // - A mismatched or missing claim can be the 1-3s window where the
  //   fast-boot path renders the app while authenticateWithPhrase is
  //   still re-minting the session (anon sign-in, then link-pubkey).
  //   Three quiet strikes ride out that transient; only a session that
  //   stays broken with the server REACHABLE escalates to the re-auth
  //   prompt. A skipped pass performs no reads and no writes, so the
  //   RLS blindness above cannot do damage in the meantime.
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
  if (sessionErr && sessionErr.name === 'AuthRetryableFetchError') {
    return { pullOk: false, changed: false };
  }
  const sessionPubkey = sessionData.session?.user?.app_metadata?.pubkey as
    | string
    | undefined;
  if (sessionPubkey !== pubkey) {
    if (claimGateBrokenSince === 0) {
      claimGateBrokenSince = Date.now();
      claimGateExpiredLogged = false;
      logAuthEvent('sync:claim-gate-broken', {
        hasSession: sessionData.session !== null,
        sessionPk: sessionPubkey?.slice(0, 8) ?? null,
        expectedPk: pubkey.slice(0, 8),
      });
    }
    // A re-mint refused on quota is not an expired session. Keep
    // skipping - a skipped pass reads nothing and writes nothing, so
    // the RLS blindness above still cannot do damage - until the
    // backoff window closes. Escalating here would show a re-auth
    // prompt whose only button burns another sign-in against the very
    // cap that is already exhausted. See RateLimitedError.
    if (Date.now() < remintBlockedUntil) return { pullOk: false, changed: false };
    if (flushOnly || Date.now() - claimGateBrokenSince < CLAIM_GATE_GRACE_MS) return { pullOk: false, changed: false };
    if (!claimGateExpiredLogged) {
      claimGateExpiredLogged = true;
      logAuthEvent('sync:claim-gate-expired', {
        brokenForMs: Date.now() - claimGateBrokenSince,
      });
    }
    throw new SessionExpiredError();
  }
  claimGateBrokenSince = 0;
  // Dead man's switch: before any pull, ask whether this account was wiped
  // since this device last looked. A tombstone pull would delete the local
  // notes without asking, so a wipe holds every server write until the
  // person answers (dms.ts). A flush pulls nothing and needs no answer.
  // Spec: docs/internal/specs/dead-mans-switch.md (section 6)
  if (!flushOnly) {
    const gate = await dmsGate(supabase, pubkey);
    // A refused token ends the pass as a skip does, and goes to the session
    // check instead of waiting for a next pass that would be refused too.
    if (gate === 'refused') throw new SessionExpiredError();
    if (gate !== 'run') return { pullOk: false, changed: false };
  }
  // The table gate raises mfa_required on the first row a request touches,
  // so a pass learns of a missing factor from its first real read or write,
  // and an empty answer means no matching row. The sign-out rescue flush
  // skips the pull and the heartbeat, so it asks before it writes.
  // tests/sync/scenarios-mfa.test.ts.
  if (flushOnly) await assertMfaAccess(supabase);

  let lastSync =
    localStorage.getItem(LAST_SYNC_KEY) || '1970-01-01T00:00:00Z';

  // The key epoch this pass reads under. A cursor built under another one is
  // reset with its retry list before the pull, and a pass whose epoch
  // changed before it ended keeps neither.
  const passEpoch = currentKeyEpoch();
  let cursorEpochMoved = false;
  if (!flushOnly) {
    const raw = (await db.kv.get(CURSOR_EPOCH_KEY))?.value;
    const stored = epochOf(typeof raw === 'string' ? Number(raw) : undefined);
    if (stored !== passEpoch) {
      console.warn('[sync] key epoch changed - resetting the cursor for a full pull');
      lastSync = EPOCH_CURSOR;
      localStorage.removeItem(LAST_SYNC_KEY);
      await db.kv.delete(PULL_RETRY_KEY);
      cursorEpochMoved = true;
    }
  }

  // Heal flags are only committed after a clean sweep (see the persist
  // block after the pull). Setting them up front consumed the one-time
  // full re-read even when the healing pull failed or was aborted.
  const healFlagsPending: string[] = [];

  // One-time heal for notes stranded behind the cursor by a backdated
  // import (see migration 0063). Adding ingested_at stops FUTURE imports
  // from hiding, but it cannot rescue rows already on the server with an
  // old updated_at: this device's cursor is already past them, so no
  // filter clause matches. The only way back is a single full pull.
  //
  // This is a client-side flag rather than a server backfill timestamp on
  // purpose. Backfilling ingested_at = now() and relying on
  // ingested_at.gt.lastSync looks like it heals, but it races: the cursor
  // advances to the max updated_at of any row pulled, so a user who edits
  // one note between the migration and their client upgrade moves their
  // cursor past the backfill and the stranded rows stay hidden forever.
  // A flag is deterministic and does not care when the device upgrades.
  //
  // Runs once per device. The full pull is safe: processBatch skips a row
  // whose local copy is dirty (1 or 2) or newer, and under an equal stamp
  // applies it only when it carries another device's nonce, so no pending
  // local edit is clobbered and no note is duplicated.
  if (!flushOnly && !localStorage.getItem(INGESTED_HEAL_KEY)) {
    if (lastSync > '1970-01-01T00:00:00Z') {
      console.warn('[sync] one-time full pull to recover backdated imported notes');
      lastSync = '1970-01-01T00:00:00Z';
      localStorage.removeItem(LAST_SYNC_KEY);
    }
    healFlagsPending.push(INGESTED_HEAL_KEY);
  }

  // One-time full re-pull for rows stranded by the offset-paging race
  // this cursor scheme replaced (migration 0065).
  //
  // Every device that ever ran a pull while another device was pushing
  // may hold silently stale rows: the old DESC+OFFSET pull could skip
  // them and then advance the cursor beyond them, after which no filter
  // could ever match them again. Measured on a live account at 503 of
  // 525 rows stale, reporting "Synced" throughout. Switching to the
  // keyset sweep stops NEW divergence but cannot rescue rows that are
  // already behind this device's cursor - only a full re-read can.
  //
  // Same shape as the 0063 heal above, and safe for the same reason:
  // processBatch skips a row whose local copy is dirty (1 or 2) or newer,
  // so no pending edit is clobbered and nothing is duplicated. Costs one
  // full pull, once per device, ever.
  if (!flushOnly && !localStorage.getItem(KEYSET_HEAL_KEY)) {
    if (lastSync > EPOCH_CURSOR) {
      console.warn('[sync] one-time full pull to recover rows stranded by offset paging');
      lastSync = EPOCH_CURSOR;
      localStorage.removeItem(LAST_SYNC_KEY);
    }
    healFlagsPending.push(KEYSET_HEAL_KEY);
  }

  // One-time full re-read that gives every row its recorded generation and
  // base. A row last synced before generations were recorded has neither,
  // so every conflict on it merges with no base: by stamps, with the text
  // going to the dialog. The re-read takes the server's version for every
  // clean row that lacks its record, whatever the stamps say, since a clean
  // row holds nothing the server lacks, and those rows then merge per field
  // against a base like any other. A row with an unsynced change keeps its
  // content. Same shape and same safety as the heals above; costs one full
  // pull, once per device.
  const healBases = !flushOnly && !localStorage.getItem(BASE_HEAL_KEY);
  if (healBases) {
    if (lastSync > EPOCH_CURSOR) {
      console.warn('[sync] one-time full pull to record every row\'s server generation');
      lastSync = EPOCH_CURSOR;
      localStorage.removeItem(LAST_SYNC_KEY);
    }
    healFlagsPending.push(BASE_HEAL_KEY);
  }

  // Guard: if IndexedDB is empty but lastSync claims we've synced
  // before, something wiped the local DB without resetting the cursor
  // (browser storage pressure, user clearing site data, session loss
  // without explicit sign-out). Reset to epoch so the pull fetches
  // everything instead of only the delta - otherwise all pre-existing
  // notes become permanently invisible. GitHub #73.
  if (!flushOnly && lastSync > '1970-01-01T00:00:00Z') {
    const localCount = await db.notes.count();
    if (localCount === 0) {
      console.warn('[sync] empty IndexedDB with stale lastSync - resetting cursor for full pull');
      lastSync = '1970-01-01T00:00:00Z';
      localStorage.removeItem(LAST_SYNC_KEY);
    }
  }

  // Track whether the pull succeeded so we only advance the lastSync
  // cursor when we're sure nothing was missed. Advancing after a failed
  // pull causes all skipped rows to become invisible until lastSync is
  // reset (the root cause of "empty app after sign-in").
  let pullOk = false;
  // True once this pass actually moved data in either direction. Callers
  // use it to skip the post-pass refresh() on no-op poll ticks, which at
  // a few thousand notes costs a few hundred ms of main-thread work
  // every 30 s while idle (backlog #130).
  let changed = false;
  // Pass counters for the sync activity log (syncLog.ts). Pushed counts the
  // rows the server accepted, added where each acceptance is recorded, so a
  // row refused, handed to the conflict dialog or never sent is never in
  // it; pulled counts rows plus tombstones actually applied.
  let pushedCount = 0;
  let pulledCount = 0;
  // Every tombstone this pull read, settled together once the sweep is
  // clean, so the mass delete guard sees the whole delete at once.
  const passTombstones: string[] = [];
  // What each pulled tombstone's seal says, read in processBatch.
  const passSeals = new Map<string, SealVerdict>();
  // Rows that did not decrypt in this pass. The cursor still moves past them
  // (a row that can never decrypt must not stall the sweep), so they are kept
  // by id and fetched again on the next pass (GitHub #655).
  const decryptFailed = new Set<string>();
  // Set when the pull met a row of a key epoch this device holds no key for,
  // in the sweep or on the retry list, so the pass reports no full pull. In
  // the sweep the cursor stops before that row and the sweep ends there, so
  // the row is read again until the keys arrive: such a row is not damaged,
  // and no retry list may be the only thing that remembers it.
  // Spec: docs/internal/plans/phrase-change.md (6.6, pull cursor)
  let sweepHeld = false;

  // ── 1. PULL (two-phase ascending sweep) ─────────────────────────
  // Phase 1: apply the first page (PHASE1_SIZE rows) and render it
  // immediately so the user sees content within ~1-2 s.  Phase 2:
  // sweep the rest in PHASE2_CHUNK-row pages with NO intermediate
  // renders - the UI updates exactly once when phase 2 finishes.
  // Result: two total re-renders regardless of vault size.

  let batchHadError = false;

  // The keyset cursor: the (changed_at, id) of the last row this device
  // has applied. Both halves are server-assigned, never the client
  // clock, which is what closes the skew gap where a client running
  // ahead of the server permanently skipped rows whose timestamp fell
  // in between. GitHub #127.
  let [cursorAt, cursorId] = parseCursor(lastSync);

  // Safety valve: a cursor sitting in the FUTURE can never be caught up
  // to - every server-stamped changed_at lands behind it, so the device
  // pulls nothing while reporting Synced. Since migration 0066 the
  // server cannot mint future values, but cursors persisted during the
  // 0065 window can carry a fast client clock's timestamp (the 0066
  // backfill stamps rows at migration time, which is BEHIND such a
  // cursor, so the fleet-wide re-read never reaches these devices).
  // Comparing against this device's clock is imperfect either way it
  // errs: a slow local clock triggers one redundant full re-read
  // (idempotent), a fast one just leaves the clamp idle - and the
  // device that IS fast never victimises itself, only its peers, whose
  // normal clocks catch this. 5 minutes of slack for ordinary skew.
  if (cursorAt > EPOCH_CURSOR) {
    const atMs = Date.parse(cursorAt);
    // A cursor that does not parse is reset too: the server could still
    // read it, so the device would pull nothing newer for good and keep
    // saying Synced (external report, 2026-10-24).
    if (!Number.isFinite(atMs) || atMs > Date.now() + 5 * 60 * 1000) {
      console.warn('[sync] cursor is unreadable or in the future - resetting for a full re-read');
      cursorAt = EPOCH_CURSOR;
      cursorId = null;
      lastSync = EPOCH_CURSOR;
      localStorage.removeItem(LAST_SYNC_KEY);
    }
  }

  /**
   * Process a batch of remote rows: split into upserts to write
   * locally and tombstone IDs to delete locally. Tombstones override
   * local dirty edits - the server says the note is gone, so the row
   * goes, and applyTombstones keeps an unsynced edit as a new note.
   */
  /** A pulled row as processBatch writes it. */
  type PulledRow = {
    id: string; title: string; body: string; tags: string[];
    createdAt: string; updatedAt: string;
    dirty: 0 | 1; deleted: 0 | 1; trashed: 0 | 1; starred: 0 | 1;
    locked: 0 | 1; pinProtected: 0 | 1;
    type: import('@notes/shared').NoteType;
    trackers?: Record<string, unknown>;
    folderId: string | null;
    archived: 0 | 1;
    editedAt?: string;
    syncedNonce: string;
    syncBase: SyncBase;
  };

  async function processBatch(rows: RemoteRow[]): Promise<{
    toPut: PulledRow[];
    tombstoneIds: string[];
    /** Rows the base heal takes whatever their stamps, while still clean. */
    healIds: Set<string>;
    /** Rows that did not decrypt: fetched again by id on a later pass. */
    failedIds: string[];
    /** Rows of a key epoch this device holds no key for. */
    heldIds: Set<string>;
  }> {
    const toPut: PulledRow[] = [];
    const tombstoneIds: string[] = [];
    const healIds = new Set<string>();
    const failedIds: string[] = [];
    const heldIds = new Set<string>();
    // Bulk-fetch local copies to avoid N sequential db.notes.get() calls.
    const ids = rows.map((r) => r.id);
    const locals = await db.notes.bulkGet(ids);
    const localMap = new Map(
      locals.filter(Boolean).map((n) => [n!.id, n!])
    );
    for (const row of rows) {
      // Tombstone wins over everything - including a local dirty edit.
      // The row goes: bringing it back under its id would be the
      // resurrection bug. An unsynced edit stays as a new note
      // (applyTombstones), because the server kept none of it.
      if (row.deleted_at) {
        tombstoneIds.push(row.id);
        passSeals.set(row.id, checkTombstoneSeal(row.delete_seal, pubkey, row.id, encryptionKey));
        continue;
      }
      const local = localMap.get(row.id);
      // Both dirty values win over a pull: 1 is a plaintext-era unsynced
      // edit, 2 is a sealed unsynced edit (the value old bundles cannot
      // see). Spec: docs/internal/specs/local-at-rest.md (5.2, the dirty fence)
      if (local && (local.dirty === 1 || local.dirty === 2)) continue;
      const heal = healBases && local !== undefined && noteBaseOf(local) === undefined;
      if (heal) healIds.add(row.id);
      else if (local && compareStamps(local.updatedAt, row.updated_at) > 0) continue;
      // Equal stamps: our own pushed generation echoing back carries the
      // nonce we recorded at push time - skip it, it is our own echo. A
      // DIFFERENT nonce under an equal stamp is another device's write
      // carrying the same stamp (#156), a write that kept its stamp (the
      // derived-title commit): apply it, or this device keeps its older
      // copy with dirty=0 and the two sides diverge silently until the
      // next edit. Rows with no recorded nonce (never synced from
      // this device, pre-upgrade rows) are still skipped outside the base
      // heal - their equal-stamp case is the harmless echo, and applying
      // would re-write the whole vault on every cursor heal.
      if (
        !heal &&
        local &&
        compareStamps(local.updatedAt, row.updated_at) === 0 &&
        (local.syncedNonce == null || local.syncedNonce === row.nonce)
      ) continue;
      try {
        const ct = base64ToBytes(row.ciphertext);
        const nonce = base64ToBytes(row.nonce);
        const decrypted = openWithRing('sync', encryptionKey, (key) => decryptNote(ct, nonce, key), epochOf(row.key_epoch));
        const pulled = fieldsOfPayload(decrypted, local?.archived === 1);
        // A writer that predates Archive dropped the flag this device holds.
        // Keeping it here is not enough: a device without the row, or one on
        // the first Archive release, would still read the server copy as
        // unarchived. The row goes back dirty, so this pass's push restates
        // the flag over the generation just pulled.
        const restate = decrypted.archived === undefined && pulled.archived;
        // Without a row of its own (or one already unsure), this device has
        // no flag to keep: it marks the flag unknown, and its writes leave it
        // out rather than state "not archived" over the device that holds it.
        const archiveUnknown = decrypted.archived === undefined && !pulled.archived && (!local || local.archivedUnknown === 1);
        // The "last edited" date is the payload's. A payload without one came
        // from a version before the field, which rebuilds the payload without
        // it: when that write left the content as this device holds it, the
        // date this device holds stands, and otherwise the row's stamp, the
        // time of that write, reads as the date (editedAtOf). Read, never
        // restated: a restate would push every pulled note again on a heal.
        const editedAt =
          decrypted.editedAt ??
          (local && sameContent(fieldsOfLocal(local), pulled) ? (local.editedAt ?? local.updatedAt) : undefined);
        toPut.push({
          id: row.id,
          title: decrypted.title,
          body: decrypted.body,
          tags: decrypted.tags,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          dirty: restate ? 1 : 0,
          deleted: 0,
          trashed: decrypted.trashed ? 1 : 0,
          starred: decrypted.starred ? 1 : 0,
          // locked / pinProtected / type are optional on DecryptedNote -
          // older encrypted blobs predate them. Missing = false / 'note'.
          locked: decrypted.locked ? 1 : 0,
          pinProtected: decrypted.pinProtected ? 1 : 0,
          type: decrypted.type ?? 'note',
          trackers: decrypted.trackers,
          folderId: decrypted.folderId ?? null,
          archived: pulled.archived ? 1 : 0,
          ...(archiveUnknown ? { archivedUnknown: 1 as const } : {}),
          ...(editedAt ? { editedAt } : {}),
          syncedNonce: row.nonce,
          // The version this device now holds is the server's: the base
          // any later conflict on this row merges against.
          syncBase: buildSyncBase(pulled, row.nonce),
        });
      } catch (err) {
        healIds.delete(row.id);
        if (err instanceof KeyEpochUnknown) {
          heldIds.add(row.id);
          console.warn('[sync] row of a key epoch this device does not hold yet:', row.id);
          continue;
        }
        failedIds.push(row.id);
        console.error('[sync] decrypt failed for', row.id, err);
        recordSyncFault({ step: 'pull', code: 'decrypt' });
      }
    }
    return { toPut, tombstoneIds, healIds, failedIds, heldIds };
  }

  if (!flushOnly) {
    // Heartbeat - if the server tells us our device row is gone, stop and
    // let the caller force a sign-out. Fired here but NOT awaited yet: it
    // runs in parallel with the phase-1 pull request below, saving a full
    // round-trip (~400 ms) on the first sync after boot. The verdict is
    // still awaited BEFORE any pulled row is processed or written, so a
    // revoked device never persists fresh server data; its in-flight pull
    // response is discarded when DeviceRevokedError unwinds the sync.
    const heartbeatPromise = heartbeat(supabase, deviceId);

    // Ascending keyset sweep over `changed_at` (migrations 0065 + 0066).
    //
    // `changed_at` is a server-assigned change clock - a trigger stamps
    // now() on every INSERT and UPDATE, and no client value can touch
    // it. One column replaces the three ORed clauses this filter used
    // to carry (edits, tombstones, and backdated imports per 0063).
    //
    // ASCENDING and keyset, not DESC and offset, and that is the whole
    // point. Offset paging assumes the result set holds still; a device
    // pushing concurrently rewrites updated_at to now(), which moves
    // that row to the front of a DESC ordering and pushes unread rows
    // past the window the reader has already gone by. Those rows are
    // never returned, and the cursor then advances beyond them, so no
    // later filter can match them - silent permanent divergence, with
    // the client still reporting "Synced" (measured 2026-08-03: a
    // second client at 503 of 525 rows stale). Sorting ascending
    // inverts the failure: a write can only move a row FORWARD, toward
    // rows the sweep has not reached yet, so it can never hide one.
    //
    // The keyset is compound because ties are guaranteed, not rare: a
    // bulk import or bulk trash commits in one transaction, so hundreds
    // of rows share a changed_at to the microsecond. Paging on
    // changed_at alone would skip a whole tie group at a page boundary
    // or spin on it forever.
    /**
     * One page of the sweep, oldest first.
     *
     * The owner equality is named here as well as enforced by row level
     * security, and it is not redundant. A policy expression is a constant
     * the planner cannot see until the statement runs, so even in its
     * uncorrelated form it gives an index condition with no row estimate
     * behind it. A literal gives the planner this account's real statistics,
     * and that is what lets `notes(user_pubkey, changed_at, id)` serve both
     * branches of the tie-group OR as index conditions instead of one broad
     * owner seek plus a filter and a sort. With it, the planner cost of a
     * page at a recent cursor drops by about two orders of magnitude.
     *
     * It never widens anything. The policy still decides what is visible, so
     * a pubkey that is not the session's returns nothing whatever this says;
     * the client already holds the vault pubkey and already validated its
     * session claim before the pass started. The equality is grouped ahead of
     * the cursor predicate so the OR pair stays one unit.
     */
    const pullPage = (afterAt: string, afterId: string | null, limit: number) => {
      const base = supabase.from('notes').select('*').eq('user_pubkey', pubkey);
      const filtered = afterId === null
        ? base.gt('changed_at', afterAt)
        : base.or(
            `changed_at.gt.${afterAt},and(changed_at.eq.${afterAt},id.gt.${afterId})`,
          );
      return filtered
        .order('changed_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit);
    };

    // ── Phase 1: first page, rendered as soon as it lands ─────────
    // Promise.resolve() subscribes to the PostgREST builder immediately so
    // the request goes out in parallel with the heartbeat above.
    const phase1Promise = Promise.resolve(
      pullPage(cursorAt, cursorId, PHASE1_SIZE),
    );

    // Await the heartbeat verdict before touching any pulled data.
    const stillRegistered = await heartbeatPromise;
    if (!stillRegistered) {
      throw new DeviceRevokedError();
    }
    // The account changed its phrase and this device holds an earlier one
    // (heartbeat() reported it): no pulled row is processed and nothing is
    // written. Every unsynced edit stays for the pass after the new phrase.
    // Spec: docs/internal/plans/phrase-change.md (section 7)
    if (stillRegistered === 'phrase_replaced') throw new PhraseReplacedError('retired');
    // The 2FA gate refused the heartbeat. A quiet pull touches no row and is
    // never refused, so the pass stops here, as on a refused read: the sync
    // catch asks whether the account replaced its phrase, then for a code.
    // Spec: docs/internal/plans/phrase-change.md (section 7)
    if (stillRegistered === 'mfa_required') throw new MfaRequiredError();

    const { data: phase1, error: p1Err, status: p1Status } = await phase1Promise;

    if (p1Err) {
      recordSyncFault({ step: 'pull', status: p1Status, code: p1Err.code || undefined });
      if (isMfaRefusal(p1Err)) throw new MfaRequiredError();
      if (isAuthError(p1Err)) throw new SessionExpiredError();
      console.error('[sync] phase 1 pull failed:', p1Err);
      batchHadError = true;
    } else {
      /**
       * Apply one page and step the keyset to its last row.
       *
       * The cursor only ever moves to a row this sweep has actually
       * written, which is what makes an interrupted pull safe. Note the
       * durability boundary: the in-memory advance is only persisted
       * after a CLEAN sweep (see the persist block after the pull), so
       * a failed page discards this pass's progress and the next pass
       * re-reads from the last persisted cursor - idempotent, and the
       * safe direction. Rows the sweep skips on purpose (a local dirty
       * edit, a local copy already newer) still count as applied - the
       * client has deliberately decided their fate and re-reading them
       * forever would strand the cursor.
       */
      const applyPage = async (rows: RemoteRow[], moveCursor = true) => {
        // Sign-out began mid-pass: stop writing. The wipe has run (or
        // is running), and repopulating the freshly cleared IndexedDB
        // with decrypted rows would leave this account's plaintext
        // sitting on a signed-out machine until the next sign-in. The
        // owner marker covers the cross-tab account switch the same
        // way: local storage that another account now owns must not
        // receive this account's decrypted rows.
        if (generation !== syncGeneration || !ownsLocalData(pubkey)) return;
        const { toPut, tombstoneIds, healIds, failedIds, heldIds } = await processBatch(rows);
        for (const row of rows) decryptFailed.delete(row.id);
        for (const id of failedIds) decryptFailed.add(id);
        // A held row fetched by id stays on the retry list; one met by the
        // sweep stops the cursor below.
        if (!moveCursor) for (const id of heldIds) decryptFailed.add(id);
        if (toPut.length > 0 || tombstoneIds.length > 0) {
          // Re-check inside one transaction before writing: an autosave
          // can land between processBatch's bulkGet snapshot and this
          // write, and blind-putting the server copy would erase the
          // fresh keystrokes AND mark the row clean, so the edit would
          // never push. The push side carries the equivalent guard
          // (recordPushed's timestamp check); this is the pull side of
          // the same hazard. Tombstones wait for the end of the sweep
          // (settleTombstones below).
          await db.transaction('rw', db.notes, db.replacedCopies, async () => {
            const current = await db.notes.bulkGet(toPut.map((n) => n.id));
            const safe = toPut.filter((n, i) => {
              const c = current[i];
              if (!c) return true;
              if (c.dirty === 1 || c.dirty === 2) return false;
              // A row the base heal re-reads is taken while it stays clean.
              if (healIds.has(n.id)) return true;
              // Same predicate processBatch applied, re-evaluated against
              // the live row: strictly newer, or the equal-stamp
              // foreign-nonce case (#156).
              return (
                compareStamps(c.updatedAt, n.updatedAt) < 0 ||
                (compareStamps(c.updatedAt, n.updatedAt) === 0 &&
                  c.syncedNonce != null &&
                  c.syncedNonce !== n.syncedNonce)
              );
            });
            // The clean text this write replaces stays on this device for 30
            // days: a pull cannot tell another device's edit from an older
            // ciphertext of the account replayed onto the row.
            const taken = new Set(safe);
            const replaced: PullReplacement[] = [];
            toPut.forEach((n, i) => {
              const c = current[i];
              if (c && taken.has(n)) replaced.push({ old: c, next: n });
            });
            await keepReplacedCopies(replaced);
            if (safe.length > 0) await db.notes.bulkPut(safe);
            passTombstones.push(...tombstoneIds);
            if (safe.length > 0) changed = true;
            pulledCount += safe.length;
          });
        }
        if (heldIds.size > 0) sweepHeld = true;
        // The cursor stops before the first held row, and the sweep ends.
        const firstHeld = moveCursor ? rows.findIndex((r) => heldIds.has(r.id)) : -1;
        const last = firstHeld >= 0 ? rows[firstHeld - 1] : rows[rows.length - 1];
        // A stamp this device cannot read never becomes the cursor.
        if (moveCursor && last && Number.isFinite(Date.parse(last.changed_at))) {
          cursorAt = last.changed_at;
          cursorId = last.id;
        }
      };

      const rows = (phase1 ?? []) as RemoteRow[];
      if (rows.length > 0) {
        await applyPage(rows);
        // Render immediately so the user has something to work with.
        if (onBatch) await onBatch();
      }

      // ── Phase 2: sweep to the end, no intermediate renders ──────
      // A short page means the server had nothing left AT THAT MOMENT.
      // Anything written afterwards carries a larger changed_at, so it
      // sits ahead of the cursor and the next pass picks it up. The one
      // residual window is commit visibility: a transaction that was
      // assigned now() before our read but commits after it can land
      // just behind the cursor. Documented as accepted in
      // sync-protocol.md section 7 - do not treat this comment as a
      // no-window guarantee.
      if (rows.length === PHASE1_SIZE && !sweepHeld) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // Sign-out began mid-sweep: applyPage above has stopped
          // writing AND stopped advancing the in-memory cursor, so
          // looping would refetch the same page forever. The persist
          // is generation-gated too, so nothing from this pass lands.
          if (generation !== syncGeneration || !ownsLocalData(pubkey)) {
            batchHadError = true;
            break;
          }
          const { data: chunk, error: chunkErr, status: chunkStatus } = await pullPage(
            cursorAt,
            cursorId,
            PHASE2_CHUNK,
          );

          if (chunkErr) {
            recordSyncFault({ step: 'pull', status: chunkStatus, code: chunkErr.code || undefined });
            if (isMfaRefusal(chunkErr)) throw new MfaRequiredError();
            if (isAuthError(chunkErr)) throw new SessionExpiredError();
            console.error('[sync] phase 2 pull failed after', cursorAt, chunkErr);
            batchHadError = true;
            break;
          }

          const chunkRows = (chunk ?? []) as RemoteRow[];
          if (chunkRows.length === 0) break;

          await applyPage(chunkRows);

          if (chunkRows.length < PHASE2_CHUNK || sweepHeld) break;
        }
      }

      // Rows an earlier pass could not decrypt, fetched again by id and
      // applied without moving the cursor. One that decrypts now leaves the
      // list, and so does one the server no longer has. A fetch that fails
      // keeps the ids it did not reach for the next pass.
      if (!batchHadError && generation === syncGeneration && ownsLocalData(pubkey)) {
        const earlier = readRetryIds((await db.kv.get(PULL_RETRY_KEY))?.value);
        for (let i = 0; i < earlier.length; i += RETRY_CHUNK) {
          const ids = earlier.slice(i, i + RETRY_CHUNK);
          const { data: again, error: againErr } = await supabase.from('notes').select('*').eq('user_pubkey', pubkey).in('id', ids);
          if (againErr) {
            for (const id of earlier.slice(i)) decryptFailed.add(id);
            break;
          }
          await applyPage((again ?? []) as RemoteRow[], false);
        }
      }
    }

    // The tombstones go once the sweep is clean, past the mass delete guard.
    // A sweep that failed applies none: its cursor is not kept, so the next
    // pass reads them again.
    if (!batchHadError && passTombstones.length > 0 && generation === syncGeneration && ownsLocalData(pubkey)) {
      await db.transaction('rw', db.notes, async () => {
        const settled = await settleTombstones(pubkey, passTombstones, passSeals);
        if (settled > 0) changed = true;
        pulledCount += settled;
      });
    }

    // A held pull keeps the cursor it reached, but it is not a full pull:
    // the rows it held are not on this device.
    pullOk = !batchHadError && !sweepHeld;

    // Persist pull progress NOW, before the push phase. A push that
    // throws (quota freeze, expired session) must not cost the pull its
    // cursor: the heal above may have just removed the stored value, and
    // losing the advance here made a quota-frozen account with one dirty
    // row re-pull its ENTIRE vault on every pass, forever. The cursor is
    // the (changed_at, id) of the last row the sweep applied - both
    // server-assigned (migration 0066), never the client clock, which is
    // what closes the skew gap from GitHub #127/#134. The generation
    // gate keeps a pass that outlived sign-out from re-creating the
    // cursor after the wipe removed it (see suspendSync).
    if (!batchHadError && generation === syncGeneration && ownsLocalData(pubkey) && currentKeyEpoch() === passEpoch) {
      const advanced = formatCursor(cursorAt, cursorId);
      if (advanced !== lastSync && cursorAt > EPOCH_CURSOR) {
        localStorage.setItem(LAST_SYNC_KEY, advanced);
      }
      // The rows this pass could not decrypt, kept beside the cursor that
      // moved past them.
      if (decryptFailed.size > 0) {
        await db.kv.put({ key: PULL_RETRY_KEY, value: JSON.stringify([...decryptFailed].slice(0, RETRY_MAX)) });
      } else {
        await db.kv.delete(PULL_RETRY_KEY);
      }
      // The cursor now belongs to this key epoch. Epoch 1 stores nothing.
      if (cursorEpochMoved) {
        if (passEpoch === 1) await db.kv.delete(CURSOR_EPOCH_KEY);
        else await db.kv.put({ key: CURSOR_EPOCH_KEY, value: String(passEpoch) });
      }
      // Heal flags commit only alongside a clean sweep - consuming them
      // on a failed or aborted heal would void the one-time full
      // re-read they exist to guarantee. A held sweep did not read it all.
      if (pullOk) {
        for (const flag of healFlagsPending) {
          localStorage.setItem(flag, '1');
        }
      }
    }
  }

  // ── 2. PUSH (batched) ───────────────────────────────────────────
  // The claim gate above ran ONCE, when this pass started. An account
  // switch can land mid-pass: a same-tab authenticate over a different
  // phrase swaps the supabase session and bumps the generation, and
  // another tab's authenticate flips the owner marker in the shared
  // localStorage. A push loop that keeps going after that writes one
  // account's rows against another account's token - server RLS refuses
  // each row, and that refusal is the ONLY backstop. So every write
  // boundary below re-checks all three ownership signals and ends the
  // push phase quietly: no error, rows stay dirty, and the storage's
  // rightful owner decides what happens to them (the switch wipe).
  // The release floor and the user's pause are checked at every boundary
  // too, not only when the pass started: a floor can arrive while the pull
  // is in flight, and every write after that moment must wait for the
  // update like the rest of this client's writes.
  let blockedMidPass = false;
  const pushOwnershipLost = async (): Promise<boolean> => {
    if (isServerWriteBlocked()) {
      blockedMidPass = true;
      return true;
    }
    if (generation !== syncGeneration) return true;
    if (!ownsLocalData(pubkey)) return true;
    const { data: liveSession } = await supabase.auth.getSession();
    const liveClaim = liveSession.session?.user?.app_metadata?.pubkey as
      | string
      | undefined;
    // A phrase change landed mid-pass: this pass's key is the earlier
    // epoch's, and buildRow would label its rows with the new one. Read
    // after the await, so nothing moves between this and the write.
    return liveClaim !== pubkey || currentKeyEpoch() !== passEpoch;
  };
  let pushEnded = false;
  // What the stop left behind, for SyncResult.halted: the first stop names
  // the reason, and every stop adds the rows it leaves unsent.
  let haltReason: PushHalt['reason'] = 'aborted';
  const unreachedIds = new Set<string>();
  const endPush = (stage: string, left: Iterable<string>): void => {
    for (const id of left) unreachedIds.add(id);
    if (pushEnded) return;
    pushEnded = true;
    haltReason = stage === 'rls-refused' ? 'refused' : blockedMidPass ? 'blocked' : 'aborted';
    if (haltReason === 'blocked') return;
    logAuthEvent('sync:push-aborted-ownership', {
      stage,
      expectedPk: pubkey.slice(0, 8),
    });
  };

  // The push changed this device only if it wrote a local row: a pushed row
  // marked clean, a delete, an applied tombstone, a merge. A dirty row that
  // cannot push (too large, or failing) writes nothing, and reporting it as a
  // change made the caller re-read the whole vault every pass (issue #643).
  const writesBeforePush = notesWriteCount();

  // anyOf, not equals(1): sealed unsynced rows carry dirty 2 so that
  // bundles without the seal reader cannot pick them up and push
  // gutted payloads. This bundle reads both and pushes both.
  const dirty = await db.notes.where('dirty').anyOf(1, 2).toArray();
  const toDelete = dirty.filter((n) => n.deleted === 1);
  const toUpsert = dirty.filter((n) => n.deleted !== 1);

  // 2a. Batch tombstone - set deleted_at on the server. Other devices
  // see the tombstone via the changed_at pull sweep and bulkDelete locally.
  // The server empties the row and keeps it as a marker for good (0098).
  // `.is('deleted_at', null)` makes the operation idempotent: rows
  // already tombstoned by another device are skipped without error.
  // Chunked in groups of 50 to keep the `.in()` URL under server limits.
  // On chunk failure, continue pushing remaining chunks so one bad note
  // doesn't block others. Failed chunks stay in Dexie for retry. (#91)
  // Each tombstone carries its seal (tombstoneSeal.ts), so the other
  // devices can tell this delete from one made with a session alone. A
  // server without migration 0130 answers PGRST202, and the rest of the
  // pass sends the plain update with no seal, as an older app does.
  // Spec: docs/contrib/sync-protocol.md (section 3, sealed deletes)
  let sealedDeletes = true;
  const sendTombstones = async (chunk: string[]) => {
    if (sealedDeletes) {
      const { data, error, status } = await supabase.rpc('tombstone_notes', {
        p_ids: chunk,
        p_seals: chunk.map((id) => sealTombstone(pubkey, id, encryptionKey)),
      });
      if (error?.code !== 'PGRST202') {
        return { data: Array.isArray(data) ? data.map((id) => ({ id: String(id) })) : null, error, status };
      }
      sealedDeletes = false;
    }
    const { data, error, status } = await supabase
      .from('notes')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', chunk)
      .is('deleted_at', null)
      .select('id');
    return { data: data as { id: string }[] | null, error, status };
  };

  if (toDelete.length > 0) {
    const deleteIds = toDelete.map((n) => n.id);
    const TOMBSTONE_CHUNK = 50;
    for (let i = 0; i < deleteIds.length; i += TOMBSTONE_CHUNK) {
      if (pushEnded || (await pushOwnershipLost())) {
        endPush('tombstones', deleteIds.slice(i));
        break;
      }
      const chunk = deleteIds.slice(i, i + TOMBSTONE_CHUNK);
      // `.select('id')` is load-bearing: without it PostgREST answers 204
      // with no body and no row count, so an UPDATE that matched NOTHING
      // is indistinguishable from one that tombstoned every row. This
      // code then bulkDeleted the local tombstones either way, which
      // destroyed the only record that the delete was still pending -
      // the note stayed alive on the server, kept counting against the
      // quota, and came back on the next device to pull from epoch.
      const { data: tombstoned, error, status: tombstoneStatus } = await sendTombstones(chunk);
      if (!error) {
        const confirmed = new Set((tombstoned ?? []).map((r) => r.id as string));
        // Rows the UPDATE did not touch are not automatically failures.
        // The `.is('deleted_at', null)` guard makes this idempotent, so a
        // row another device already tombstoned is legitimately skipped,
        // and a row that never reached the server has nothing to
        // tombstone. Both are done. What must NOT be dropped is a row
        // that is still alive and simply out of reach - an RLS rejection
        // under a session whose pubkey link is broken looks exactly like
        // a successful no-op from here.
        const unaccounted = chunk.filter((id) => !confirmed.has(id));
        if (unaccounted.length > 0) {
          const { data: survivors, error: checkErr, status: checkStatus } = await supabase
            .from('notes')
            .select('id')
            .in('id', unaccounted)
            .is('deleted_at', null);
          if (checkErr) {
            // Cannot prove they are gone, so keep them dirty and retry
            // on the next pass rather than guess.
            recordSyncFault({ step: 'push', status: checkStatus, code: checkErr.code || undefined });
            if (isMfaRefusal(checkErr)) throw new MfaRequiredError();
            if (isAuthError(checkErr)) throw new SessionExpiredError();
            console.error('[sync] tombstone confirmation failed', checkErr);
            if (onPushError) {
              for (const id of unaccounted) {
                onPushError(id, checkErr.message ?? 'tombstone confirmation failed');
              }
            }
          } else {
            const stillAlive = new Set((survivors ?? []).map((r) => r.id as string));
            for (const id of unaccounted) {
              if (!stillAlive.has(id)) confirmed.add(id);
            }
            if (stillAlive.size > 0) recordSyncFault({ step: 'push', code: 'delete-refused' });
            if (stillAlive.size > 0 && onPushError) {
              for (const id of stillAlive) {
                onPushError(id, 'delete not accepted by the server');
              }
            }
          }
        }
        if (confirmed.size > 0) {
          await db.notes.bulkDelete([...confirmed]);
          pushedCount += confirmed.size;
        }
      } else {
        recordSyncFault({ step: 'push', status: tombstoneStatus, code: error.code || undefined });
        if (isMfaRefusal(error)) throw new MfaRequiredError();
        if (isPhraseReplacedRefusal(error)) throw phraseReplacedStop('write');
        if (isAuthError(error)) throw new SessionExpiredError();
        console.error('[sync] batch tombstone failed', error);
        if (onPushError) {
          for (const id of chunk) {
            onPushError(id, error.message ?? 'tombstone failed');
          }
        }
        // continue - don't break; remaining chunks may succeed
      }
    }
  }

  /** Encrypt a note into the row shape the server stores. The payload is
   *  `fieldsOfLocal(note)`, the same fields a base recorded for this push
   *  describes, plus the "last edited" stamp when the row has one. */
  const buildRow = (note: LocalNote) => {
    const { ciphertext, nonce } = encryptNote(rowPayloadOf(note), encryptionKey);
    return {
      id: note.id,
      user_pubkey: pubkey,
      ciphertext: bytesToBase64(ciphertext),
      nonce: bytesToBase64(nonce),
      created_at: note.createdAt,
      updated_at: note.updatedAt,
      ...keyEpochColumn(),
    };
  };

  /** Record rows the server accepted: each takes the generation it was
   *  pushed as, its nonce and its base. That holds even for a row edited
   *  while the push was in flight, because the edit was made on the very
   *  copy that was pushed, so the next push goes out over this generation
   *  instead of meeting its own write as a conflict. Only a row with no
   *  such edit (unchangedSince) is marked clean. */
  const recordPushed = async (pushed: Array<{ note: LocalNote; nonce: string }>) => {
    const synced = pushed.map(({ note, nonce }) => ({
      note,
      patch: { syncedNonce: nonce, syncBase: buildSyncBase(fieldsOfLocal(note), nonce) },
    }));
    await db.transaction('rw', db.notes, async () => {
      for (const { note, patch } of synced) {
        const current = await db.notes.get(note.id);
        if (!current) continue;
        await db.notes.update(
          note.id,
          unchangedSince(current, note) ? { ...patch, dirty: 0 } : patch,
        );
      }
    });
    pushedCount += pushed.length;
  };

  // 2b-i. Bulk-insert first-time pushes.
  //
  // The conflict-aware path below costs up to THREE sequential round
  // trips per note that does not exist server-side yet: a conditional
  // update that matches nothing, a select to find out why, then the
  // insert. On a 500-note import that is ~1500 requests in strict
  // series - about ten minutes, during which the app reports each pass
  // as a successful sync while other devices watch the notes trickle in
  // twenty at a time.
  //
  // One batched probe tells us which ids the server already has. The
  // ones it does not can be inserted in bulk, with no conflict to
  // detect: there is nothing on the server to conflict with. Everything
  // else falls through to the per-note path completely unchanged, so
  // conflict detection for real edits is untouched.
  let pending = toUpsert;
  // A quota refusal of a new note does not stop the edits: the server
  // refuses only a write that grows the count or the bytes, so an account
  // at its limit can still save every note it holds. The refusal is
  // remembered, the per-note path runs for the rows the server already
  // has, and it is thrown once that pool drains.
  let bulkQuotaRefusal: QuotaExceededError | null = null;
  if (toUpsert.length > 1 && !pushEnded) {
    const PROBE_CHUNK = 200;
    const INSERT_CHUNK = 50;
    const known = new Set<string>();
    let probeOk = true;
    for (let i = 0; i < toUpsert.length && probeOk; i += PROBE_CHUNK) {
      const ids = toUpsert.slice(i, i + PROBE_CHUNK).map((n) => n.id);
      const { data, error, status: probeStatus } = await supabase
        .from('notes')
        .select('id')
        .in('id', ids);
      if (error) {
        recordSyncFault({ step: 'push', status: probeStatus, code: error.code || undefined });
        if (isMfaRefusal(error)) throw new MfaRequiredError();
        if (isAuthError(error)) throw new SessionExpiredError();
        // A malformed id 400s the whole chunk, and quietly treating a
        // failed probe as "none of these exist" would bulk-insert over
        // live rows. Fall back to the per-note path for everything.
        console.warn('[sync] existence probe failed, falling back to per-note push', error);
        probeOk = false;
        break;
      }
      for (const row of data ?? []) known.add(row.id as string);
    }

    if (probeOk) {
      const fresh = toUpsert.filter((n) => !known.has(n.id));
      const retry: LocalNote[] = [];
      for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
        if (pushEnded || (await pushOwnershipLost())) {
          endPush('bulk-insert', fresh.slice(i).map((n) => n.id));
          break;
        }
        const batch = fresh.slice(i, i + INSERT_CHUNK);
        // A row over the per-row ceiling fails the whole chunk and takes
        // its neighbours down to the slow path with it, every pass, for as
        // long as the note exists. Hold it back and report it here: that
        // report is what marks it "not backed up", and it is the only one
        // this pass makes, because the per-note path never sees it either.
        const rows: ReturnType<typeof buildRow>[] = [];
        const sendable: LocalNote[] = [];
        for (const note of batch) {
          const built = buildRow(note);
          if (built.ciphertext.length > NOTE_MAX_STORED_BYTES) {
            if (onPushError) onPushError(note.id, NOTE_TOO_LARGE_MSG);
            continue;
          }
          rows.push(built);
          sendable.push(note);
        }
        if (rows.length === 0) continue;
        const { error, status: insertStatus } = await supabase.from('notes').insert(rows);
        if (error) {
          recordSyncFault({ step: 'push', status: insertStatus, code: error.code || undefined });
          if (isMfaRefusal(error)) throw new MfaRequiredError();
          if (isPhraseReplacedRefusal(error)) throw phraseReplacedStop('write');
          if (isAuthError(error)) throw new SessionExpiredError();
          if (isQuotaError(error)) {
            bulkQuotaRefusal = new QuotaExceededError(error.message);
            break;
          }
          if (isRlsError(error)) {
            endPush('rls-refused', [...sendable, ...fresh.slice(i + INSERT_CHUNK)].map((n) => n.id));
            break;
          }
          // One bad row (oversized note, malformed id) fails the whole
          // batch, so hand this chunk to the per-note path where each
          // note gets its own verdict and its own error message.
          console.warn('[sync] batch insert failed, retrying these per note', error);
          retry.push(...sendable);
          continue;
        }
        await recordPushed(sendable.map((note, i) => ({ note, nonce: rows[i]!.nonce })));
      }
      // After a quota refusal the new notes wait, the ones retried per note
      // included: each insert would only meet the same refusal.
      pending = toUpsert.filter((n) => known.has(n.id)).concat(bulkQuotaRefusal ? [] : retry);
    }
  }

  // 2b-ii. Conflict-aware push - encrypt each dirty note and write it only
  // over the server generation this device last synced. A copy whose
  // generation is behind goes to the conflict path instead of overwriting.
  const pushOne = async (note: LocalNote) => {
    if (pushEnded || (await pushOwnershipLost())) {
      endPush('per-note', [note.id]);
      return;
    }
    const row = buildRow(note);

    // No retry can make this row fit, so it costs nothing but the report.
    // The note stays dirty and keeps its "not backed up" marking until an
    // edit brings it under the ceiling, when this check simply passes.
    if (row.ciphertext.length > NOTE_MAX_STORED_BYTES) {
      if (onPushError) onPushError(note.id, NOTE_TOO_LARGE_MSG);
      return;
    }

    // The update lands only while the server row still carries the nonce
    // this device recorded as synced. A stamp cannot say that: a copy that
    // missed another device's edit takes a fresh stamp the moment anyone
    // stars, retags or files it, and a stamp guard would let its old body
    // replace the newer one. A row with no recorded generation guards on
    // UNRECORDED_GENERATION, so its update always misses and the conflict
    // read below decides.
    rememberSent(note.id, row.nonce);
    const { data: updated, error: updateErr, status: updateStatus } = await supabase
      .from('notes')
      .update({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        updated_at: row.updated_at,
        ...keyEpochColumn(),
      })
      .eq('id', note.id)
      .eq('user_pubkey', pubkey)
      .eq('nonce', note.syncedNonce ?? UNRECORDED_GENERATION)
      .select('id');

    if (updateErr) {
      // The too-large refusal is the "Not backed up" list's to report.
      if (!isNoteTooLargeError(updateErr)) recordSyncFault({ step: 'push', status: updateStatus, code: updateErr.code || undefined, ref: note.id });
      if (isMfaRefusal(updateErr)) throw new MfaRequiredError();
      if (isPhraseReplacedRefusal(updateErr)) throw phraseReplacedStop('write');
      if (isAuthError(updateErr)) throw new SessionExpiredError();
      if (isQuotaError(updateErr)) throw new QuotaExceededError(updateErr.message);
      // One oversized note breaching the per-note 1 MB CHECK is not an
      // account-storage problem - surface the per-note retry banner, not
      // the global "Storage full" banner.
      if (isNoteTooLargeError(updateErr)) {
        if (onPushError) onPushError(note.id, NOTE_TOO_LARGE_MSG);
        return;
      }
      // Invalid UUID (e.g. old seed note with non-hex sentinel "we11") -
      // delete the local note so it stops retrying forever. Only when the id
      // really is not one: a server or proxy that sent this text for a valid
      // id deleted a note it never stored (report 9b).
      if (updateErr.message?.includes('invalid input syntax for type uuid') && !isUuid(note.id)) {
        console.warn('[sync] deleting note with invalid UUID:', note.id);
        await db.notes.delete(note.id);
        return;
      }
      console.error('[sync] push failed for', note.id, updateErr);
      if (onPushError) {
        onPushError(note.id, updateErr.message ?? 'unknown error');
      }
      return;
    }

    if (updated && updated.length > 0) {
      await recordPushed([{ note, nonce: row.nonce }]);
      return;
    }

    // 0 rows updated - either the server moved past this device's
    // generation, or the note does not exist there yet (first push).
    const { data: existing, error: fetchErr, status: fetchStatus } = await supabase
      .from('notes')
      .select('ciphertext, nonce, updated_at, deleted_at')
      .eq('id', note.id)
      .eq('user_pubkey', pubkey)
      .maybeSingle();

    if (fetchErr) {
      recordSyncFault({ step: 'push', status: fetchStatus, code: fetchErr.code || undefined, ref: note.id });
      if (isMfaRefusal(fetchErr)) throw new MfaRequiredError();
      if (isAuthError(fetchErr)) throw new SessionExpiredError();
      console.error('[sync] conflict check failed for', note.id, fetchErr);
      if (onPushError) onPushError(note.id, fetchErr.message ?? 'conflict check failed');
      return;
    }

    // A tombstone that landed after this pass pulled: it wins over the row
    // exactly as it does in the pull, the edit kept as a new note, and its
    // row holds no content to merge against.
    if (existing?.deleted_at) {
      await db.transaction('rw', db.notes, () => applyTombstones([note.id]));
      return;
    }

    if (!existing) {
      // No row on server - first-time insert.
      const { error: insertErr, status: insertStatus } = await supabase.from('notes').insert(row);
      if (insertErr) {
        if (!isNoteTooLargeError(insertErr)) recordSyncFault({ step: 'push', status: insertStatus, code: insertErr.code || undefined, ref: note.id });
        if (isMfaRefusal(insertErr)) throw new MfaRequiredError();
        if (isPhraseReplacedRefusal(insertErr)) throw phraseReplacedStop('write');
        if (isAuthError(insertErr)) throw new SessionExpiredError();
        if (isQuotaError(insertErr)) throw new QuotaExceededError(insertErr.message);
        if (isNoteTooLargeError(insertErr)) {
          if (onPushError) onPushError(note.id, NOTE_TOO_LARGE_MSG);
          return;
        }
        if (insertErr.message?.includes('invalid input syntax for type uuid') && !isUuid(note.id)) {
          console.warn('[sync] deleting note with invalid UUID:', note.id);
          await db.notes.delete(note.id);
          return;
        }
        if (isRlsError(insertErr)) {
          endPush('rls-refused', [note.id]);
          return;
        }
        console.error('[sync] insert failed for', note.id, insertErr);
        if (onPushError) onPushError(note.id, insertErr.message ?? 'insert failed');
      } else {
        await recordPushed([{ note, nonce: row.nonce }]);
      }
      return;
    }

    // ── Conflict: the server holds a generation this device never synced ──
    console.warn('[sync] conflict detected for note', note.id);
    try {
      const existingCt = base64ToBytes(existing.ciphertext);
      const existingNonce = base64ToBytes(existing.nonce);
      const serverPayload = openWithRing('sync', encryptionKey, (key) => decryptNote(existingCt, existingNonce, key));
      const serverFields = fieldsOfPayload(serverPayload, note.archived === 1);
      // A note the mass delete guard restored (keepHeldNotes) that meets
      // another device's restore of the same note. Either can be the newer
      // version, so neither overwrites the other: this device's, an edit
      // made since the answer included, is kept beside it as its own note,
      // and this id takes the server's, in one transaction, and only over
      // the row this pass read (a wipe or an edit since leaves it for the
      // next pass). Nothing is written to the server here.
      if (note.syncedNonce === KEPT_GENERATION && !fieldsEqual(fieldsOfLocal(note), serverFields)) {
        await db.transaction('rw', db.notes, async () => {
          const current = await db.notes.get(note.id);
          if (!current || !unchangedSince(current, note) || !ownsLocalData(pubkey)) return;
          await db.notes.add(copyUnderNewId(current));
          await db.notes.update(note.id, {
            ...localPatchOf(serverFields),
            editedAt: serverPayload.editedAt ?? existing.updated_at,
            dirty: 0,
            updatedAt: existing.updated_at,
            syncedNonce: existing.nonce,
            syncBase: buildSyncBase(serverFields, existing.nonce),
          });
        });
        return;
      }
      const local = localSide(note);
      const server: MergeSide = { fields: serverFields, updatedAt: existing.updated_at, editedAt: serverPayload.editedAt };
      // Our own earlier write, landed with its reply lost or with an edit
      // made while it was in flight: what it grew from is the base, so only
      // what was typed since counts as this device's.
      const echo = sentNonces.get(note.id)?.find((e) => e.nonce === existing.nonce);
      // Field by field against the version this device last synced: a
      // field only one side changed takes that side, whichever stamp is
      // newer, and only a body both sides changed is left to the user.
      const { rest, body } = mergeNoteFields(
        echo ? (echo.base ?? buildSyncBase(serverFields, existing.nonce)) : noteBaseOf(note),
        local,
        server,
      );

      if (body === null) {
        if (onConflict) {
          onConflict({
            noteId: note.id,
            localNote: note,
            serverTitle: serverFields.title,
            serverBody: serverFields.body,
            serverTags: serverFields.tags,
            serverTrackers: serverFields.trackers,
            serverStarred: serverFields.starred,
            serverTrashed: serverFields.trashed,
            serverLocked: serverFields.locked,
            serverPinProtected: serverFields.pinProtected,
            serverType: serverFields.type,
            serverFolderId: serverFields.folderId,
            serverArchived: serverFields.archived,
            ...(serverPayload.archived === undefined ? { serverArchiveAbsent: true } : {}),
            serverUpdatedAt: existing.updated_at,
            ...(serverPayload.editedAt ? { serverEditedAt: serverPayload.editedAt } : {}),
            serverRow: existing,
          });
        } else {
          // No conflict handler - the sign-out rescue flush. Do NOT fall
          // back to the server's body: overwriting the local one and
          // clearing dirty moments before the wipe destroyed the unsynced
          // edit on both sides (keepUnsyncedNotes can only rescue rows
          // still flagged dirty). Leave the row dirty; the next
          // authenticated pass re-detects the conflict with the modal wired.
          console.warn('[sync] conflict for', note.id, 'left dirty (no handler)');
        }
        return;
      }

      // Two sides can each leave a schedule that holds while their merge does
      // not (an end day kept from one side before a day moved on the other);
      // the merge keeps what holds. Spec: docs/internal/specs/calendar-pillar-spec.md (section 4.2)
      const merged: NoteFields = { ...rest, body, trackers: normalizeSchedule(rest.trackers, rest.type) };
      const editedAt = mergedEditedAt(local, server, merged);
      // A server copy that lost the flag to an older writer is not "the
      // same" as an archived merge: it is written, so the flag is restated.
      const serverLostArchive = serverPayload.archived === undefined && merged.archived;
      if (fieldsEqual(merged, serverFields) && !serverLostArchive && !editStampMoves(editedAt, serverPayload.editedAt)) {
        // Everything this device changed, its edit date included, is already
        // on the server, or yielded to a later change of the same field: the
        // server's generation is the result, so record it as synced without
        // a write.
        const base = buildSyncBase(serverFields, existing.nonce);
        await db.transaction('rw', db.notes, async () => {
          const current = await db.notes.get(note.id);
          if (current && unchangedSince(current, note)) {
            await db.notes.update(note.id, {
              ...localPatchOf(serverFields),
              editedAt,
              dirty: 0,
              updatedAt: existing.updated_at,
              syncedNonce: existing.nonce,
              syncBase: base,
            });
          }
        });
        return;
      }

      // Stamped past both sides it merges: a peer pull skips a row older
      // than the copy it holds, so a merge stamped by a clock running
      // behind would never reach the devices holding the version it
      // replaces.
      const mergedAt = nextStamp(laterStamp(note.updatedAt, existing.updated_at));
      const keepUnknown = archiveUnknownOf(note) && serverPayload.archived === undefined && !merged.archived;
      const { ciphertext: mergedCt, nonce: mergedNonceBytes } = encryptNote(
        { ...merged, ...(keepUnknown ? { archived: undefined } : {}), editedAt },
        encryptionKey,
      );
      const mergedNonce = bytesToBase64(mergedNonceBytes);
      rememberSent(note.id, mergedNonce, note);
      // Conditional on the generation the merge was computed against, plus
      // `.select('id')` to learn whether the write landed: a newer push
      // from another device in the window since the conflict read must not
      // be overwritten, and a trigger-dropped write to a tombstoned row
      // looks exactly like success without it.
      const { data: mergedRows, error: mergeErr, status: mergeStatus } = await supabase
        .from('notes')
        .update({
          ciphertext: bytesToBase64(mergedCt),
          nonce: mergedNonce,
          updated_at: mergedAt,
          ...keyEpochColumn(),
        })
        .eq('id', note.id)
        .eq('user_pubkey', pubkey)
        .eq('nonce', existing.nonce)
        .select('id');
      if (!mergeErr && mergedRows && mergedRows.length > 0) {
        const base = buildSyncBase(merged, mergedNonce);
        await db.transaction('rw', db.notes, async () => {
          const current = await db.notes.get(note.id);
          // Every merged field lands locally: the row is about to match the
          // server's stamp and nonce, so the next pull skips it as its own
          // echo, and a field left stale here would stay stale for good. An
          // edit made while the merge was in flight sits on a copy that
          // never held the other side's changes, so that row is left as it
          // is, and the next pass merges it against this generation.
          if (current && unchangedSince(current, note)) {
            await db.notes.update(note.id, {
              ...localPatchOf(merged),
              editedAt,
              dirty: 0,
              updatedAt: mergedAt,
              syncedNonce: mergedNonce,
              syncBase: base,
            });
          }
        });
        pushedCount += 1;
        console.log('[sync] merged note', note.id);
      } else if (mergeErr) {
        if (!isNoteTooLargeError(mergeErr)) recordSyncFault({ step: 'push', status: mergeStatus, code: mergeErr.code || undefined, ref: note.id });
        if (isMfaRefusal(mergeErr)) throw new MfaRequiredError();
        if (isPhraseReplacedRefusal(mergeErr)) throw phraseReplacedStop('write');
        console.error('[sync] auto-merge push failed for', note.id, mergeErr);
        if (onPushError) onPushError(note.id, mergeErr.message ?? 'auto-merge failed');
      } else {
        // 0 rows: the server moved again (or the row was tombstoned)
        // since the conflict read. Stay dirty; the next pass re-runs
        // conflict detection against the newer row.
        console.warn('[sync] auto-merge lost a second race for', note.id);
      }
    } catch (err) {
      if (err instanceof MfaRequiredError || err instanceof PhraseReplacedError) throw err;
      console.error('[sync] conflict resolution failed for', note.id, err);
      recordSyncFault({ step: 'push', code: 'merge', ref: note.id });
      if (onPushError) onPushError(note.id, 'conflict resolution failed');
    }
  };

  // Run the per-note pushes with bounded concurrency rather than one at
  // a time.
  //
  // Serially, every note the server ALREADY HAS costs one strictly
  // serialized round trip, and the 2b-i bulk path above never helps
  // them - it only batches first-time inserts. So any bulk action over
  // existing notes (trash 500, restore 500, star 500, retag 500, move
  // 500 to a folder) paid 500 sequential round trips with the sync
  // mutex held: about 40 s at an 80 ms RTT and 100 s at 200 ms, during
  // which the app reports itself as merely "syncing".
  //
  // Every iteration of pushOne is independent and order-free: the
  // generation guard, the zero-rows conflict probe and the recordPushed
  // timestamp check are all keyed on one note.id, and no cross-note ordering
  // exists server-side either - each write gets its own trigger-stamped
  // changed_at (migration 0066) and the pull applies rows one by one.
  // Concurrency therefore changes throughput only, never the outcome of
  // any single note. Deliberately modest: concurrent writes contend on
  // the same pubkey_quotas row through the notes_enforce_quota trigger,
  // so a high number buys little and just moves the queue into the
  // database.
  // Spec: docs/internal/design-decisions.md (sync push concurrency)
  const PUSH_CONCURRENCY = 8;

  // The first SessionExpiredError or QuotaExceededError wins and stops
  // the workers from picking up further notes, mirroring the sequential
  // loop's throw. Requests already in flight are allowed to settle
  // instead of being abandoned: each carries the same per-note guards
  // as any other pass, so letting them finish is safe, and it keeps
  // recordPushed from being skipped on a write the server did accept.
  let pushAbort: unknown = null;
  let pushCursor = 0;
  const pushWorker = async () => {
    while (pushAbort === null && !pushEnded) {
      const index = pushCursor++;
      if (index >= pending.length) return;
      const note = pending[index];
      if (!note) return;
      try {
        await pushOne(note);
      } catch (err) {
        if (pushAbort === null) pushAbort = err;
        return;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PUSH_CONCURRENCY, pending.length) },
      pushWorker,
    ),
  );
  if (pushAbort !== null) throw pushAbort;
  if (bulkQuotaRefusal !== null) throw bulkQuotaRefusal;
  // A stop also leaves every note no worker claimed: the whole per-note
  // queue when an earlier stage stopped, since no worker starts after it.
  if (pushEnded) {
    for (const note of pending.slice(pushCursor)) unreachedIds.add(note.id);
  }

  // The cursor was already persisted at the end of the pull phase (see
  // the block after `pullOk = !batchHadError`), so a push-phase throw
  // above never costs the pull its progress.
  return {
    pullOk,
    changed: changed || notesWriteCount() !== writesBeforePush,
    pushed: pushedCount,
    pulled: pulledCount,
    ...(pushEnded ? { halted: { reason: haltReason, unreached: unreachedIds.size } } : {}),
  };
}
