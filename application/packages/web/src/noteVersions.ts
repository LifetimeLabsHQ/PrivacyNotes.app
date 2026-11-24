/**
 * Client helpers for Pro note-history (server-backed snapshots).
 *
 * Each saved version is an encrypted snapshot of the note's
 * title/body/tags at the moment of save, plus a login's custom fields
 * and extra websites, and a journal entry's tracker values. The server never sees
 * plaintext. Versions live in the `note_versions` table with a
 * BEFORE INSERT trigger that caps each note at 50 rows and trims the
 * account's oldest versions once their bytes pass its storage quota.
 *
 * When a version is made is decided at the call site: the state before
 * an edit, once per editing session (versionSchedule.ts, wired in
 * useNoteEditing.ts), and the state a restore replaces (NotesView.tsx).
 */

import {
  encryptBlob,
  decryptBlob,
  encryptNote,
  decryptNote,
  checkNoteBind,
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  type SupabaseClient,
} from '@notes/shared';
import { db, type LocalNote } from './db';
import { currentKeyEpoch, epochOf, keyEpochColumn, KeyEpochUnknown, openWithRing } from './keyRing';
import { isPhraseReplacedRefusal, reportPhraseReplaced } from './phraseReplaced';
import { computeSnapshotTotalSize } from './notesViewUtils';
import { isServerWriteBlocked } from './syncPause';
import { isDemoMode } from './demo';
import { isLocalTruthOnly } from './localOnly';
import { localDataKeyCopy } from './localKey';
import { trackerContent } from './editStamp';

const TABLE = 'note_versions';

/**
 * Rows the server's BEFORE INSERT trigger keeps per note. The demo path
 * below enforces the same number itself, so the two behave alike.
 * Spec: docs/internal/pro-features.md (Note history row)
 */
const MAX_VERSIONS = 50;

/** Compact shape the UI panel renders. `bodyBytes` drives the
 *  "how much changed" hint without exposing the plaintext body. */
export type NoteVersion = {
  id: string;
  noteId: string;
  /** When the version was made (ISO): the time sealed inside it, which a
   *  version that waited in the queue carries from the moment it was queued,
   *  never later than `serverAt`. The server's date for a version from before
   *  the sealed time. History lists and shows versions by it (beta #197
   *  item 4); the server prunes by `serverAt`. */
  createdAt: string;
  /** When the server stored it (ISO). */
  serverAt?: string;
  title: string;
  body: string;
  tags: string[];
  /** A login's custom fields and extra websites as recorded: undefined when
   *  the version did not record them (an older client, or not a login), null
   *  when it recorded none. */
  login?: unknown;
  /** A journal entry's tracker values as recorded, bookkeeping keys left
   *  out: undefined when the version did not record them (an older client,
   *  or not a journal entry). */
  trackers?: Record<string, unknown>;
  bodyBytes: number;
};

/** What a snapshot records beside the title, body and tags: for a login,
 *  its extras, with null standing for "recorded, and there were none". */
function loginOf(note: LocalNote): { login?: unknown } {
  return note.type === 'login' ? { login: note.trackers?.login ?? null } : {};
}

/** A journal entry's tracker values, which a version records beside its text. */
function journalOf(note: LocalNote): { trackers?: Record<string, unknown> } {
  return note.type === 'journal' ? { trackers: trackerContent(note.trackers) } : {};
}

function loginFromTrackers(trackers: Record<string, unknown> | undefined): { login?: unknown } {
  return trackers && Object.prototype.hasOwnProperty.call(trackers, 'login') ? { login: trackers.login } : {};
}

type RemoteRow = {
  id: string;
  note_id: string;
  user_pubkey: string;
  ciphertext: string;
  nonce: string;
  created_at: string;
  /** The key epoch of the ciphertext; absent before the column existed (1).
   *  Spec: packages/supabase/migrations/history/0118_key_epoch.sql */
  key_epoch?: number;
};

/**
 * Result of a snapshot attempt. Callers can ignore `ok=true` and
 * surface a UI hint when `code === '42501'` (RLS rejection - Pro
 * lapsed). Other errors stay silent.
 */
export type CreateNoteVersionResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Private copy of the key for one seal, or null once sign-out has zeroed the
 * shared buffer in place. A version sealed under the zeroed buffer is
 * readable by anyone who reads the table. Same pattern as imageStore.ts and
 * sync.ts.
 */
function liveKey(encryptionKey: Uint8Array): Uint8Array | null {
  const copy = new Uint8Array(encryptionKey);
  return copy.every((b) => b === 0) ? null : copy;
}

/**
 * A version's payload, encrypted with the account key as the server row holds
 * it. `madeAt` is the moment the version was made, sealed in the payload's
 * `editedAt` (a version payload carries no other use for it): a version that
 * waits in the queue keeps the time it was made, which the server's insert
 * time is not.
 */
function sealVersion(note: LocalNote, encryptionKey: Uint8Array, madeAt: string): { ciphertext: string; nonce: string } {
  const { ciphertext, nonce } = encryptNote(
    {
      editedAt: madeAt,
      title: note.title,
      body: note.body,
      tags: note.tags,
      trashed: note.trashed === 1,
      starred: note.starred === 1,
      locked: note.locked === 1,
      pinProtected: note.pinProtected === 1,
      type: note.type,
      ...(note.type === 'login' ? { trackers: loginOf(note) } : journalOf(note)),
    },
    encryptionKey,
    // A version is bound to its note and to the history table, never to a
    // stamp. Spec: docs/internal/plans/payload-row-binding.md (section 2)
    { id: note.id, kind: 'version' },
  );
  return { ciphertext: bytesToBase64(ciphertext), nonce: bytesToBase64(nonce) };
}

/** The most versions the queue keeps; past it the oldest go. */
const QUEUE_MAX = 200;

/**
 * The queue's lookup key for a content hash: an HMAC under the local data
 * key, never the bare hash. The table is outside the at-rest seal (its
 * ciphertext is under the account key), and a bare SHA-256 of a title, body
 * and tags lets a copy of the device's files test guessed texts, a four-digit
 * code in seconds (RFS #226). Null with no key registered. A key that
 * changes (a phrase change) only stops the lookup from finding older rows,
 * which the drain still sends and removes by id.
 * Spec: docs/public/THREAT_MODEL.md (Local storage at rest)
 */
async function queueHash(hash: string): Promise<string | null> {
  const key = localDataKeyCopy();
  if (!key) return null;
  try {
    const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`pn-version-queue-v1:${hash}`));
    return bytesToHex(new Uint8Array(mac));
  } finally {
    key.fill(0);
  }
}

/**
 * Keep a version the server could not take yet: the device was offline, or
 * the note has not reached the server (a version row needs its note). The
 * in-session retry held one such state in memory, and a reload lost even that,
 * so most of what was written offline had no History (external report,
 * 2026-10-24, bug report 2). `drainVersionQueue` sends them after a sync pass.
 */
export async function queueNoteVersion(note: LocalNote, encryptionKey: Uint8Array, hash: string): Promise<void> {
  if (isDemoMode() || isLocalTruthOnly()) return;
  const key = liveKey(encryptionKey);
  if (!key) return;
  try {
    const keyed = await queueHash(hash);
    if (!keyed) return;
    if (await db.versionQueue.where('hash').equals(keyed).count()) return;
    const queuedAt = new Date().toISOString();
    await db.versionQueue.add({ noteId: note.id, hash: keyed, ...sealVersion(note, key, queuedAt), queuedAt, ...keyEpochColumn() });
    const ids = await db.versionQueue.toCollection().primaryKeys();
    if (ids.length > QUEUE_MAX) await db.versionQueue.bulkDelete(ids.slice(0, ids.length - QUEUE_MAX));
  } catch (err) {
    console.warn('[note_versions] queue failed:', err);
  }
}

/** A state that reached the server leaves the queue. */
export async function unqueueNoteVersion(hash: string): Promise<void> {
  const keyed = await queueHash(hash).catch(() => null);
  if (!keyed) return;
  await db.versionQueue.where('hash').equals(keyed).delete().catch(() => 0);
}

/** Whether a version is waiting: the orphan reconcile deletes nothing then,
 *  because a waiting version may name a picture no saved one names. */
export async function hasQueuedVersions(): Promise<boolean> {
  return (await db.versionQueue.count()) > 0;
}

/**
 * A queued version sealed under an earlier phrase, sealed again under the
 * current key: the same plaintext bytes with a fresh nonce. Null when no key
 * is given or none opens it; the version then waits. The background pass of
 * a phrase change may have finished already and would not come back for it.
 * Spec: docs/internal/plans/phrase-change.md (6.4)
 */
function resealQueued(v: { ciphertext: string; nonce: string; key_epoch?: number }, encryptionKey: Uint8Array | undefined): { ciphertext: string; nonce: string; key_epoch?: number } | null {
  const key = encryptionKey ? liveKey(encryptionKey) : null;
  if (!key) return null;
  try {
    const n = base64ToBytes(v.nonce);
    const ct = base64ToBytes(v.ciphertext);
    const combined = new Uint8Array(n.length + ct.length);
    combined.set(n, 0);
    combined.set(ct, n.length);
    const plain = openWithRing('sync', key, (k) => decryptBlob(combined, k), epochOf(v.key_epoch));
    const sealed = encryptBlob(plain, key);
    plain.fill(0);
    return { nonce: bytesToBase64(sealed.slice(0, 24)), ciphertext: bytesToBase64(sealed.slice(24)), ...keyEpochColumn() };
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

/**
 * Send the queued versions, oldest first, whose note the server holds. Stops
 * at the first request that fails for the network, to try again after the next
 * pass. A refusal for good (Pro lapsed, the note gone) drops that version.
 * A version queued under an earlier phrase goes up sealed again under
 * `encryptionKey`, never under the key it was queued with.
 */
export async function drainVersionQueue(supabase: SupabaseClient, pubkey: string, encryptionKey?: Uint8Array): Promise<void> {
  if (isDemoMode() || isServerWriteBlocked()) return;
  const queued = await db.versionQueue.orderBy('id').toArray();
  for (const v of queued) {
    const note = await db.notes.get(v.noteId);
    if (!note) {
      await db.versionQueue.delete(v.id!);
      continue;
    }
    if (note.syncedNonce == null) continue;
    const sealed = epochOf(v.key_epoch) < currentKeyEpoch() ? resealQueued(v, encryptionKey) : v;
    if (!sealed) continue;
    const { error } = await supabase.from(TABLE).insert({
      note_id: v.noteId,
      user_pubkey: pubkey,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      ...(typeof sealed.key_epoch === 'number' ? { key_epoch: sealed.key_epoch } : {}),
    });
    // The account changed its phrase: the version waits for the new one.
    if (isPhraseReplacedRefusal(error)) reportPhraseReplaced('write');
    // 42501: Pro lapsed. 23503: the note left the server. 23514: over the
    // size cap. None of them passes on a retry.
    if (!error || ['42501', '23503', '23514'].includes(error.code ?? '')) {
      await db.versionQueue.delete(v.id!);
      continue;
    }
    console.warn('[note_versions] queued send failed, kept for the next pass:', error.message);
    return;
  }
}

/**
 * Write a new version snapshot for `note`. Returns a structured
 * result so the caller can detect the Pro-lapsed RLS rejection
 * (code 42501) and surface a one-time toast. Other errors are
 * logged. The caller decides when, and dedupes, before calling this.
 */
export async function createNoteVersion(
  supabase: SupabaseClient,
  pubkey: string,
  encryptionKey: Uint8Array,
  note: LocalNote
): Promise<CreateNoteVersionResult> {
  // Below the release floor server writes pause (see sync.ts). This one is
  // per-edit and would otherwise ship every keystroke batch to the server
  // while note sync itself is paused, defeating the pause. Guarded here so
  // both call sites (edit snapshots, pre-restore snapshots) are covered.
  if (isLocalTruthOnly()) {
    return { ok: false, code: 'local_only', message: 'note history requires sync' };
  }
  if (isServerWriteBlocked()) {
    return { ok: false, code: 'below_version_floor', message: 'client below release floor' };
  }
  // The demo has no session and makes no server calls, so it keeps its own
  // snapshots in the throwaway demo database. Same cap, same order, no
  // encryption: the demo database already holds the notes in plaintext, and
  // nothing in it leaves the tab.
  if (isDemoMode()) {
    try {
      await db.demoVersions.add({
        id: crypto.randomUUID(),
        noteId: note.id,
        createdAt: new Date().toISOString(),
        title: note.title,
        body: note.body,
        tags: note.tags,
        ...loginOf(note),
        ...journalOf(note),
      });
      const ids = await db.demoVersions.where('noteId').equals(note.id).sortBy('createdAt');
      if (ids.length > MAX_VERSIONS) {
        await db.demoVersions.bulkDelete(ids.slice(0, ids.length - MAX_VERSIONS).map((v) => v.id));
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, code: '', message: (err as Error).message };
    }
  }
  const key = liveKey(encryptionKey);
  if (!key) return { ok: false, code: 'signed_out', message: 'encryption key cleared' };
  try {
    const { ciphertext, nonce } = sealVersion(note, key, new Date().toISOString());
    const { error } = await supabase.from(TABLE).insert({
      note_id: note.id,
      user_pubkey: pubkey,
      ciphertext,
      nonce,
      ...keyEpochColumn(),
    });
    if (isPhraseReplacedRefusal(error)) reportPhraseReplaced('write');
    if (error) {
      console.error('[note_versions] insert failed:', error);
      return { ok: false, code: error.code ?? '', message: error.message };
    }
    return { ok: true };
  } catch (err) {
    console.error('[note_versions] encrypt failed:', err);
    return { ok: false, code: '', message: (err as Error).message };
  }
}

/**
 * List all versions for a note, newest first. Decrypted in memory
 * so the caller can render previews without a second round trip.
 *
 * A read that fails throws; an empty list means the note has no
 * versions. The blob GC depends on that difference: it skips when the
 * read throws, because history it could not read may still hold a blob.
 * postgrest-js reports a failed fetch, offline included, as an error
 * object rather than a rejection, so the check below is what turns it
 * into a throw.
 */
export async function listNoteVersions(
  supabase: SupabaseClient,
  encryptionKey: Uint8Array,
  noteId: string
): Promise<NoteVersion[]> {
  if (isLocalTruthOnly()) return [];
  if (isDemoMode()) {
    const rows = await db.demoVersions.where('noteId').equals(noteId).sortBy('createdAt');
    return rows.reverse().map((v) => ({
      id: v.id,
      noteId: v.noteId,
      createdAt: v.createdAt,
      title: v.title,
      body: v.body,
      tags: v.tags,
      ...(v.login !== undefined ? { login: v.login } : {}),
      ...(v.trackers !== undefined ? { trackers: v.trackers } : {}),
      bodyBytes: computeSnapshotTotalSize(v.title, v.body, v.tags),
    }));
  }
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('note_id', noteId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[note_versions] list failed:', error);
    throw new Error(error.message || 'note_versions list failed');
  }
  const rows = (data ?? []) as RemoteRow[];
  const out: NoteVersion[] = [];
  for (const row of rows) {
    try {
      const ct = base64ToBytes(row.ciphertext);
      const nonce = base64ToBytes(row.nonce);
      const decrypted = openWithRing('sync', encryptionKey, (key) => decryptNote(ct, nonce, key), epochOf(row.key_epoch));
      // A payload written for another note, or for a live row, is not a
      // version of this note: left out, as one that does not open. No switch
      // here: a version row has no server change clock (section 8, item 5).
      // Spec: docs/internal/plans/payload-row-binding.md (section 4.2)
      if (checkNoteBind(decrypted.bind, { id: row.note_id, kind: 'version' }, undefined, null) === 'moved') {
        console.error('[note_versions] payload bound to another row for', row.id);
        continue;
      }
      out.push({
        id: row.id,
        noteId: row.note_id,
        createdAt: madeAtOf(decrypted.editedAt, row.created_at),
        serverAt: row.created_at,
        title: decrypted.title,
        body: decrypted.body,
        tags: decrypted.tags,
        ...loginFromTrackers(decrypted.trackers),
        ...(decrypted.type === 'journal' && decrypted.trackers ? { trackers: decrypted.trackers as Record<string, unknown> } : {}),
        bodyBytes: computeSnapshotTotalSize(
          decrypted.title ?? '', decrypted.body ?? '', decrypted.tags ?? [],
        ),
      });
    } catch (err) {
      // A version under a key epoch this device holds no key for is not
      // damaged, and leaving it out would hand the blob clean-up a history
      // without its references (imageGC.ts): the whole read fails instead.
      // Spec: docs/internal/plans/phrase-change.md (6.2, 6.6)
      if (err instanceof KeyEpochUnknown) throw err;
      console.error('[note_versions] decrypt failed for', row.id, err);
    }
  }
  // Newest first by when each was made: a version queued offline on Monday
  // and sent on Thursday sits with Monday's.
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The sealed time a version was made, never later than the server stored
 *  it (a clock that ran ahead cannot lift a version above later ones). */
function madeAtOf(sealed: string | undefined, serverAt: string): string {
  const made = sealed ? Date.parse(sealed) : NaN;
  const stored = Date.parse(serverAt);
  if (!Number.isFinite(made) || !Number.isFinite(stored) || made >= stored) return serverAt;
  return new Date(made).toISOString();
}
