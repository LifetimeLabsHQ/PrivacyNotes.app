/**
 * The background pass of a phrase change: data written before the change,
 * encrypted again under the current keys.
 *
 * After a change, data written under an earlier phrase stays under its keys
 * until something rewrites it, and until then it is protected by access
 * only. Any device that holds the current phrase runs this pass after a
 * clean sync pull, in pages, in the background:
 *
 * 1. Local data. The at-rest sweep re-seals every local row, stash slot and
 *    the sealed settings cache of an earlier epoch (localSweep.ts), and a
 *    read that needed a ring key starts it (lazy on read).
 * 2. Notes. Raw server rows of the account below the current epoch, read
 *    from the server and not from the local cache, live rows only: a
 *    tombstone holds no ciphertext and the server drops every write to it.
 *    Each row's plaintext bytes go under the current key with a fresh nonce,
 *    so the content and its length stay the same, and the row is written
 *    back only over the nonce and epoch this pass read (a compare-and-swap).
 *    A miss means another device wrote the row first: it is skipped, never
 *    overwritten. `updated_at` is not sent, so it stays; the server's
 *    `changed_at` trigger brings the row to every device's pull, where a
 *    clean copy takes the new generation like any other write (sync.ts,
 *    processBatch: an equal stamp under another nonce).
 * 3. History. The same rewrite through `reencrypt_note_version` (migration
 *    0124), because note_versions has no UPDATE grant.
 * 4. Files. Storage objects last written before the change (its time plus a
 *    margin) and not overwritten since are downloaded and opened by trial,
 *    because a blob names no
 *    epoch. One that an earlier key opens is overwritten at the same path by
 *    an upsert of the same size, which the owner UPDATE policy of 0124
 *    allows. Never a delete and an insert: a crash between the two would
 *    lose the file. The pass deletes nothing: an upsert of a file deleted
 *    meanwhile creates it again, and the orphan reconcile (imageGC.ts), which
 *    checks every reference first, takes it; a removal here could take a
 *    file another device had just restored at that path. The files this
 *    device found current or rewrote are remembered for the epoch, so a
 *    later pass downloads none of them again.
 *
 * Inbox rows are not rewritten; the apps adopt and delete them through the
 * ring. The server holds the progress: a rewritten row leaves the query, so
 * a pass cut short anywhere resumes where it stopped. A miss (another
 * device edited the row) is skipped; the row is current already or comes
 * back in the next pass. The pass yields to every sync pass, stops when the
 * sign-in ends, the epoch moves or server writes pause, and waits on a
 * data-saver or low-battery hint. A server without migration 0124 (its
 * history function answers a probe as missing) gets the notes only, and the
 * account waits an hour before the next try. Once a recount finds nothing
 * left the pass records that for the account and epoch and asks no more.
 * Spec: docs/internal/plans/phrase-change.md (6.4)
 */
import { base64ToBytes, bytesToBase64, decryptBlob, encryptBlob, type SupabaseClient } from '@notes/shared';
import { db } from './db';
import { isDemoMode } from './demo';
import { currentKeyEpoch, epochOf, holdsEpoch, holdsEveryEpoch, isRingKey, openWithRingAt } from './keyRing';
import { runAtRestSweep } from './localSweep';
import { isPhraseReplacedRefusal, reportPhraseReplaced } from './phraseReplaced';
import { setReencryptProgress } from './reencryptProgress';
import { isQuotaError } from './sync';
import { isSyncing } from './syncingStore';
import { isServerWriteBlocked } from './syncPause';
import { uploadsHeldForWifi } from './wifiOnly';

// Images and attachments share one bucket (imageStore.ts, attachmentStore.ts).
const BUCKET = 'encrypted-images';
const PAGE = 100;
// What one Storage listing returns at most (imageStore.ts LIST_PAGE).
const LIST_PAGE = 1000;
const WRITERS = 4;
/** A file first written up to this long after the change can still be
 *  under an earlier key: an upload whose transaction began before the
 *  change committed carries the earlier time. So the pass opens those too.
 *  A file overwritten at or after the change is current: an overwrite is
 *  allowed to a session bound to the current epoch only. */
const FILE_MARGIN_MS = 10 * 60_000;
/** A pass that left something starts again at most this often. */
const RETRY_MS = 10 * 60_000;
/** The account and epoch a pass finished: `{ account, epoch }`. */
const DONE_KEY = 'reencryptPassDone';
/** The files this device found current or rewrote, for an account and
 *  epoch: `{ account, epoch, names }`. */
const FILES_KEY = 'reencryptFilesDone';
/** The remembered files are saved at most this often while a pass runs,
 *  and once at its end. */
const FILES_SAVE_MS = 30_000;
/** A server without 0124 is asked again after this long. */
const DOORS_RETRY_MS = 60 * 60_000;

export type ReencryptOptions = {
  supabase: SupabaseClient;
  /** The account id. */
  pubkey: string;
  /** The current sync key as the auth state holds it. Sign-out zeroes it in
   *  place, and the pass stops then. */
  syncKey: Uint8Array;
  /** False once the sign-in this pass started under has ended. */
  isCurrent: () => boolean;
};

export type ReencryptOutcome = {
  /** Why the pass ended: `done` when nothing of an earlier epoch is left
   *  that this device can rewrite. */
  state: 'done' | 'left' | 'stopped' | 'skipped';
  notes: number;
  versions: number;
  files: number;
  /** Rows and files left for a later pass: another write came first, a key
   *  of their epoch has not arrived, or a part of the server is missing. */
  left: number;
};

class Stop extends Error {}

type Tally = {
  /** Overwrites sent, and how many Storage refused. */
  tried: number;
  refused: number;
  notes: number;
  versions: number;
  files: number;
  left: number;
  seen: number;
  total: number;
  /** The server refused a note write for quota (an account over its quota,
   *  or frozen after 90 days over): the notes wait, history and files go on. */
  quota: boolean;
  /** Rows no key opens while this device holds every epoch's: nothing can
   *  rewrite them, so the recount does not wait on them. */
  damaged: { notes: number; note_versions: number };
};

/** A server without 0124, for an account and epoch: no new pass until `until`. */
let doorsMissing: { account: string; epoch: number; until: number } | null = null;

/** A copy of the key for one step, or null once sign-out zeroed it. */
function liveKey(key: Uint8Array): Uint8Array | null {
  const copy = new Uint8Array(key);
  if (copy.every((b) => b === 0)) return null;
  return copy;
}

function report(t: Tally): void {
  if (t.total > 0) setReencryptProgress((t.seen / t.total) * 100);
}

/** A server answer that ends the pass. A key-epoch refusal is the account
 *  changing its phrase again, which the app hears like any refused write. */
function stopOn(error: unknown): Stop {
  if (isPhraseReplacedRefusal(error)) reportPhraseReplaced('write');
  return new Stop();
}

/** The function of migration 0124 is not on the server yet. */
function missingFunction(error: { code?: string } | null, status?: number): boolean {
  return status === 404 || error?.code === 'PGRST202';
}

/**
 * Whether the server has migration 0124, asked once per pass: the history
 * function answers a row that does not exist with false, and a server
 * without it answers 404. Nothing is written.
 */
async function has0124(opts: ReencryptOptions, epoch: number): Promise<boolean> {
  const { error, status } = await opts.supabase.rpc('reencrypt_note_version', {
    p_id: '00000000-0000-4000-8000-000000000000',
    p_expected_nonce: 'probe',
    p_expected_epoch: epoch - 1,
    p_ciphertext: 'probe',
    p_nonce: 'probe-new',
    p_key_epoch: epoch,
  });
  if (error && missingFunction(error, status)) return false;
  if (error) throw stopOn(error);
  return true;
}

type Hints = Navigator & { connection?: { saveData?: boolean }; getBattery?: () => Promise<{ level: number; charging: boolean }> };

function savingData(): boolean {
  return typeof navigator !== 'undefined' && (navigator as Hints).connection?.saveData === true;
}

async function lowBattery(): Promise<boolean> {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Hints);
  if (typeof nav?.getBattery !== 'function') return false;
  try {
    const battery = await nav.getBattery();
    return !battery.charging && battery.level < 0.2;
  } catch {
    return false;
  }
}

/** Wait while a sync pass runs; stop when the pass may not go on. */
async function waitTurn(opts: ReencryptOptions, epoch: number): Promise<void> {
  for (;;) {
    if (!opts.isCurrent() || currentKeyEpoch() !== epoch || isServerWriteBlocked() || savingData()) throw new Stop();
    if (!isSyncing()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Run `work` over the items, a few at once, and stop all on the first Stop. */
async function inTurns<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let stop: unknown = null;
  const worker = async () => {
    while (stop === null && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (err) {
        stop = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITERS, items.length) }, worker));
  if (stop !== null) throw stop;
}

/** The plaintext bytes of a server ciphertext (no associated data, as
 *  encryptNote and encryptJson write it), and the epoch whose key opened
 *  them. The same bytes under the current key have the same length. */
function reopenRow(ciphertext: string, nonce: string, key: Uint8Array, declared: number): { value: Uint8Array; epoch: number } {
  const n = base64ToBytes(nonce);
  const ct = base64ToBytes(ciphertext);
  const combined = new Uint8Array(n.length + ct.length);
  combined.set(n, 0);
  combined.set(ct, n.length);
  return openWithRingAt('sync', key, (k) => decryptBlob(combined, k), declared);
}

function sealRow(plain: Uint8Array, key: Uint8Array): { ciphertext: string; nonce: string } {
  const combined = encryptBlob(plain, key);
  return { nonce: bytesToBase64(combined.slice(0, 24)), ciphertext: bytesToBase64(combined.slice(24)) };
}

type Table = 'notes' | 'note_versions';
type ServerRow = { id: string; ciphertext: string; nonce: string; key_epoch?: number };

/**
 * One row, encrypted again, or why not: 'left' (its epoch's key has not
 * arrived, or no key opens it while one may still arrive) or 'damaged' (no
 * key opens it and this device holds every epoch's, so nothing can).
 */
function rewrite(row: ServerRow, key: Uint8Array): { ciphertext: string; nonce: string } | 'left' | 'damaged' {
  const declared = epochOf(row.key_epoch);
  if (!holdsEpoch(declared)) return 'left';
  try {
    return sealRow(reopenRow(row.ciphertext, row.nonce, key, declared).value, key);
  } catch {
    return holdsEveryEpoch() ? 'damaged' : 'left';
  }
}

async function countBelow(opts: ReencryptOptions, table: Table, epoch: number): Promise<number> {
  let q = opts.supabase.from(table).select('id', { count: 'exact', head: true }).eq('user_pubkey', opts.pubkey).lt('key_epoch', epoch);
  if (table === 'notes') q = q.is('deleted_at', null);
  const { count, error } = await q;
  if (error || typeof count !== 'number') throw stopOn(error);
  return count;
}

async function pageBelow(opts: ReencryptOptions, table: Table, epoch: number, after: string | null): Promise<ServerRow[]> {
  let q = opts.supabase.from(table).select('id, ciphertext, nonce, key_epoch').eq('user_pubkey', opts.pubkey).lt('key_epoch', epoch);
  if (table === 'notes') q = q.is('deleted_at', null);
  if (after !== null) q = q.gt('id', after);
  const { data, error } = await q.order('id', { ascending: true }).limit(PAGE);
  if (error) throw stopOn(error);
  return (data ?? []) as ServerRow[];
}

/** Count a row that needs no write: damaged, or left for a later pass. */
function notWritten(t: Tally, table: Table, why: 'left' | 'damaged'): void {
  if (why === 'left') t.left++;
  else t.damaged[table]++;
}

async function rewriteNotes(opts: ReencryptOptions, epoch: number, t: Tally): Promise<void> {
  let after: string | null = null;
  for (;;) {
    await waitTurn(opts, epoch);
    const rows = await pageBelow(opts, 'notes', epoch, after);
    if (rows.length === 0) return;
    after = rows[rows.length - 1]!.id;
    await inTurns(rows, async (row) => {
      if (t.quota) return;
      const key = liveKey(opts.syncKey);
      if (!key) throw new Stop();
      try {
        const next = rewrite(row, key);
        if (next === 'left' || next === 'damaged') return notWritten(t, 'notes', next);
        const { data, error } = await opts.supabase
          .from('notes')
          .update({ ...next, key_epoch: epoch })
          .eq('id', row.id)
          .eq('user_pubkey', opts.pubkey)
          .eq('nonce', row.nonce)
          .eq('key_epoch', epochOf(row.key_epoch))
          .is('deleted_at', null)
          .select('id');
        if (error && isQuotaError(error)) {
          t.quota = true;
          t.left++;
          return;
        }
        if (error) throw stopOn(error);
        if (Array.isArray(data) && data.length > 0) t.notes++;
        else t.left++;
      } finally {
        key.fill(0);
        t.seen++;
        report(t);
      }
    });
    if (t.quota) return;
  }
}

/** False when the server has no `reencrypt_note_version` yet. */
async function rewriteVersions(opts: ReencryptOptions, epoch: number, t: Tally): Promise<boolean> {
  let after: string | null = null;
  for (;;) {
    await waitTurn(opts, epoch);
    const rows = await pageBelow(opts, 'note_versions', epoch, after);
    if (rows.length === 0) return true;
    after = rows[rows.length - 1]!.id;
    let missing = false;
    await inTurns(rows, async (row) => {
      if (missing) return;
      const key = liveKey(opts.syncKey);
      if (!key) throw new Stop();
      try {
        const next = rewrite(row, key);
        if (next === 'left' || next === 'damaged') return notWritten(t, 'note_versions', next);
        const { data, error, status } = await opts.supabase.rpc('reencrypt_note_version', {
          p_id: row.id,
          p_expected_nonce: row.nonce,
          p_expected_epoch: epochOf(row.key_epoch),
          p_ciphertext: next.ciphertext,
          p_nonce: next.nonce,
          p_key_epoch: epoch,
        });
        if (error && missingFunction(error, status)) {
          missing = true;
          return;
        }
        if (error) throw stopOn(error);
        if (data === true) t.versions++;
        else t.left++;
      } finally {
        key.fill(0);
        t.seen++;
        report(t);
      }
    });
    if (missing) return false;
  }
}

type Listed = { id?: string | null; name: string; created_at?: string; updated_at?: string };
type Candidate = { name: string };

/** The files that may be under an earlier key and that this device has not
 *  found current or rewritten yet. */
async function fileCandidates(opts: ReencryptOptions, epoch: number, rotatedAt: number | null, done: Set<string>): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    await waitTurn(opts, epoch);
    const { data, error } = await opts.supabase.storage.from(BUCKET).list(opts.pubkey, { limit: LIST_PAGE, offset });
    if (error) throw stopOn(error);
    const page = (data ?? []) as Listed[];
    for (const o of page) {
      // A folder entry has no object id.
      if (o.id === null || done.has(o.name)) continue;
      const created = Date.parse(o.created_at ?? '');
      const at = Date.parse(o.updated_at ?? o.created_at ?? '');
      if (rotatedAt !== null && Number.isFinite(at) && Number.isFinite(created) && at > created && at >= rotatedAt) continue;
      if (rotatedAt === null || !Number.isFinite(at) || at < rotatedAt + FILE_MARGIN_MS) out.push({ name: o.name });
    }
    if (page.length < LIST_PAGE) return out;
  }
}

async function readFilesDone(account: string, epoch: number): Promise<Set<string>> {
  try {
    const raw = (await db.kv.get(FILES_KEY))?.value;
    if (typeof raw !== 'string') return new Set();
    const rec = JSON.parse(raw) as { account?: unknown; epoch?: unknown; names?: unknown };
    if (rec.account !== account || rec.epoch !== epoch || !Array.isArray(rec.names)) return new Set();
    return new Set(rec.names.filter((n): n is string => typeof n === 'string'));
  } catch {
    return new Set();
  }
}

async function saveFilesDone(account: string, epoch: number, names: Set<string>): Promise<void> {
  try {
    await db.kv.put({ key: FILES_KEY, value: JSON.stringify({ account, epoch, names: [...names] }) });
  } catch {
    /* Best effort: a later pass opens those files once more. */
  }
}

async function rewriteFiles(opts: ReencryptOptions, epoch: number, files: Candidate[], done: Set<string>, t: Tally): Promise<void> {
  let savedAt = Date.now();
  const remember = async (name: string) => {
    done.add(name);
    if (Date.now() - savedAt >= FILES_SAVE_MS) {
      savedAt = Date.now();
      await saveFilesDone(opts.pubkey, epoch, done);
    }
  };
  try {
    for (const file of files) {
      await waitTurn(opts, epoch);
      const path = `${opts.pubkey}/${file.name}`;
      const key = liveKey(opts.syncKey);
      if (!key) throw new Stop();
      try {
        const { data, error } = await opts.supabase.storage.from(BUCKET).download(path);
        if (error || !data) {
          // A file deleted since the listing needs nothing.
          if (/not.?found|404/i.test(error?.message ?? '')) await remember(file.name);
          else t.left++;
          continue;
        }
        const bytes = new Uint8Array(await data.arrayBuffer());
        let opened: { value: Uint8Array; epoch: number };
        try {
          opened = openWithRingAt('sync', key, (k) => decryptBlob(bytes, k));
        } catch {
          if (holdsEveryEpoch()) await remember(file.name);
          else t.left++;
          continue;
        }
        if (opened.epoch === epoch) {
          await remember(file.name);
          continue;
        }
        const next = encryptBlob(opened.value, key);
        opened.value.fill(0);
        t.tried++;
        const { error: upErr } = await opts.supabase.storage
          .from(BUCKET)
          .upload(path, next, { upsert: true, contentType: 'application/octet-stream' });
        if (upErr) {
          if (isPhraseReplacedRefusal(upErr)) throw stopOn(upErr);
          // This file is left for a later pass; the next one may go through.
          t.left++;
          t.refused++;
          continue;
        }
        t.files++;
        await remember(file.name);
      } finally {
        key.fill(0);
        t.seen++;
        report(t);
      }
    }
  } finally {
    await saveFilesDone(opts.pubkey, epoch, done);
  }
}

async function readDone(account: string, epoch: number): Promise<boolean> {
  try {
    const raw = (await db.kv.get(DONE_KEY))?.value;
    if (typeof raw !== 'string') return false;
    const rec = JSON.parse(raw) as { account?: unknown; epoch?: unknown };
    return rec.account === account && rec.epoch === epoch;
  } catch {
    return false;
  }
}

/**
 * One pass, now. Tests and the scheduler below call it; it does nothing for
 * an account that never changed its phrase, in demo mode, or while another
 * tab of this device runs it.
 */
export async function runReencryptPass(opts: ReencryptOptions): Promise<ReencryptOutcome> {
  const t: Tally = { tried: 0, refused: 0, notes: 0, versions: 0, files: 0, left: 0, seen: 0, total: 0, quota: false, damaged: { notes: 0, note_versions: 0 } };
  const outcome = (state: ReencryptOutcome['state']): ReencryptOutcome => ({ state, notes: t.notes, versions: t.versions, files: t.files, left: t.left });
  const epoch = currentKeyEpoch();
  if (isDemoMode() || epoch < 2) return outcome('skipped');
  if (await readDone(opts.pubkey, epoch)) return outcome('skipped');
  // The key the pass writes under must be the current epoch's. A key of an
  // earlier epoch would open old data as "current" and label it so.
  const probe = liveKey(opts.syncKey);
  if (!probe) return outcome('skipped');
  const stale = isRingKey('sync', probe);
  probe.fill(0);
  if (stale) return outcome('skipped');

  const run = async (): Promise<ReencryptOutcome> => {
    try {
      await runAtRestSweep();
      await waitTurn(opts, epoch);
      if (await lowBattery()) return outcome('stopped');
      // The server's epoch, and the time of its last change, which tells the
      // files written since (under the current key) from older ones.
      const { data, error } = await opts.supabase.rpc('account_key_ring');
      if (error) throw stopOn(error);
      const answer = data as { epoch?: unknown; rotated_at?: unknown } | null;
      if (answer?.epoch !== epoch) return outcome('skipped');
      const parsed = typeof answer.rotated_at === 'string' ? Date.parse(answer.rotated_at) : NaN;
      const rotatedAt = Number.isFinite(parsed) ? parsed : null;

      // Without 0124 only the notes have a door: history and files wait.
      const doors = await has0124(opts, epoch);
      const notes = await countBelow(opts, 'notes', epoch);
      const versions = doors ? await countBelow(opts, 'note_versions', epoch) : 0;
      const heldForWifi = uploadsHeldForWifi();
      const done = await readFilesDone(opts.pubkey, epoch);
      const files = !doors || heldForWifi ? [] : await fileCandidates(opts, epoch, rotatedAt, done);
      t.total = notes + versions + files.length;
      report(t);

      await rewriteNotes(opts, epoch, t);
      if (!doors) {
        doorsMissing = { account: opts.pubkey, epoch, until: Date.now() + DOORS_RETRY_MS };
        return outcome('left');
      }
      if (!(await rewriteVersions(opts, epoch, t))) {
        doorsMissing = { account: opts.pubkey, epoch, until: Date.now() + DOORS_RETRY_MS };
        return outcome('left');
      }
      await rewriteFiles(opts, epoch, files, done, t);
      // Every overwrite refused, several times over: something refuses them
      // all, and downloading every file again in ten minutes would not help.
      // A quota refusal does not clear in ten minutes either.
      if (t.quota || (t.tried >= 3 && t.refused === t.tried)) {
        doorsMissing = { account: opts.pubkey, epoch, until: Date.now() + DOORS_RETRY_MS };
      }
      if (t.left > 0 || heldForWifi) return outcome('left');
      // A recount before "done": a history row a queue sent under an earlier
      // epoch meanwhile, or a file a listing passed over, keeps the pass going.
      if ((await countBelow(opts, 'notes', epoch)) > t.damaged.notes) return outcome('left');
      if ((await countBelow(opts, 'note_versions', epoch)) > t.damaged.note_versions) return outcome('left');
      if ((await fileCandidates(opts, epoch, rotatedAt, done)).length > 0) return outcome('left');
      await db.kv.put({ key: DONE_KEY, value: JSON.stringify({ account: opts.pubkey, epoch }) });
      await db.kv.delete(FILES_KEY);
      return outcome('done');
    } catch (err) {
      if (err instanceof Stop) return outcome('stopped');
      throw err;
    } finally {
      setReencryptProgress(null);
    }
  };

  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    let result: ReencryptOutcome = outcome('skipped');
    await navigator.locks.request('pn-reencrypt-pass', { ifAvailable: true }, async (lock) => {
      if (lock) result = await run();
    });
    return result;
  }
  return run();
}

let running = false;
let lastStart = 0;

/**
 * Start a pass in the background, at most once in RETRY_MS, never two at
 * once, and for an account whose server lacked 0124 not again for an hour.
 * The sync orchestrator calls it after each clean pull of an account past
 * epoch 1; the first call of a session starts at once.
 */
export function startReencryptPass(opts: ReencryptOptions): void {
  if (running || currentKeyEpoch() < 2) return;
  const now = Date.now();
  if (doorsMissing && doorsMissing.account === opts.pubkey && doorsMissing.epoch === currentKeyEpoch() && now < doorsMissing.until) return;
  if (now - lastStart < RETRY_MS) return;
  lastStart = now;
  running = true;
  void runReencryptPass(opts)
    .catch((err) => console.warn('[reencrypt] pass failed:', err))
    .finally(() => {
      running = false;
    });
}
