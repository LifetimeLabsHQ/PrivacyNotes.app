/**
 * The at-rest sweep: every session verifies that stored rows are
 * sealed, and converts the ones that are not. A RESCAN, deliberately
 * not a one-shot with a completion flag: a rollback window or a stale
 * tab can write plaintext at any time, and a flag would hide those
 * rows forever, while a cheap scan self-heals them next session.
 *
 * What one pass does, in order:
 *  1. notes - keyset pages over the RAW connection (sv checks cost IO
 *     only), converting unsealed rows in per-page transactions with an
 *     in-transaction re-read (the sync pull's race guard). A conversion
 *     preserves every plain field: updatedAt and syncedNonce stay
 *     byte-identical (no sync storm, #156 intact); dirty 1 becomes 2
 *     via the seal itself (the stale-bundle fence).
 *  2. editorDocCache - unsealed rows are DELETED, not converted: the
 *     cache is derived, rebuildable, and capped at 12 rows.
 *  3. imageCache and attachmentCache - unsealed rows seal one row per
 *     transaction (a single blob can be tens of MB).
 *  4. After a phrase change only (key epoch above 1): every sealed row,
 *     the kept stash slots and the sealed settings cache whose envelope a
 *     key of an earlier epoch sealed are sealed again under the current
 *     key, plain fields untouched. A read that opens such an envelope
 *     starts a pass soon (lazy on read, localSeal.ts onStaleSealRead).
 *     Spec: docs/internal/plans/phrase-change.md (6.4, item 1)
 *
 * Failure policy: ANY page failure ends the pass - one raw-connection
 * reopen absorbs the iOS severed-IndexedDB case, then stop with a
 * breadcrumb. The next session's pass is the retry; no hot loops. A
 * zeroed key (sign-out) aborts between pages. Demo never sweeps. A Web
 * Lock lets one tab do the work; without lock support the pass runs
 * anyway - conversions are idempotent and transactional.
 *
 * Module-scoped on purpose: a re-lock unmounts the UI but keys stay in
 * memory by the existing app-lock design, and the sweep keeps going.
 *
 * Spec: docs/internal/specs/local-at-rest.md (section 5.3)
 */
import { db, openRawDb } from './db';
import type { LocalNote } from './db';
import { isSealedRow, LocalSealKeyMissing, onStaleSealRead, resealPending, resealRow, sealedTableNames, sealRow } from './localSeal';
import { localDataKeyCopy } from './localKey';
import { currentKeyEpoch } from './keyRing';
import { resealStashSlots } from './flushStash';
import { resealSealedSettings } from './settingsSeal';
import { PUBKEY_OWNER_KEY } from './authStorage';
import { isDemoMode } from './demo';
import { logAuthEvent } from './authDiag';

const PAGE_ROWS = 200;
const PAGE_BYTES = 2_000_000;

let running = false;
let rawDb: ReturnType<typeof openRawDb> | null = null;

function raw(): ReturnType<typeof openRawDb> {
  rawDb ??= openRawDb();
  return rawDb;
}

function keyGone(): boolean {
  const copy = localDataKeyCopy();
  if (!copy) return true;
  copy.fill(0);
  return false;
}

async function sweepNotes(): Promise<void> {
  let last: string | null = null;
  for (;;) {
    if (keyGone()) throw new Error('key cleared mid-sweep');
    const page = (await (last === null
      ? raw().notes.orderBy(':id').limit(PAGE_ROWS).toArray()
      : raw().notes.where(':id').above(last).limit(PAGE_ROWS).toArray())) as LocalNote[];
    if (page.length === 0) return;
    last = page[page.length - 1]!.id;
    // Byte-capped chunks: 200 unbounded rows could be 100+ MB of
    // synchronous crypto inside one transaction.
    let chunk: string[] = [];
    let bytes = 0;
    const chunks: string[][] = [];
    for (const row of page) {
      if (isSealedRow(row)) continue;
      chunk.push(row.id);
      bytes += (row.body?.length ?? 0) + (row.title?.length ?? 0);
      if (chunk.length >= PAGE_ROWS || bytes >= PAGE_BYTES) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
    }
    if (chunk.length) chunks.push(chunk);
    for (const ids of chunks) {
      await raw().transaction('rw', raw().notes, async () => {
        // Re-read inside the transaction: an autosave or a pull can
        // land between the page read and this write; the fresh row
        // wins and an already-sealed row is skipped.
        const fresh = await raw().notes.bulkGet(ids);
        const updates: LocalNote[] = [];
        for (const row of fresh) {
          if (!row || isSealedRow(row)) continue;
          updates.push(sealRow('notes', row as never) as unknown as LocalNote);
        }
        if (updates.length) await raw().notes.bulkPut(updates);
      });
    }
  }
}

async function sweepDocCache(): Promise<void> {
  // Derived data, max 12 rows: deleting the unsealed backlog is free
  // and a converted stale row would be worthless.
  await raw().editorDocCache.filter((r) => !isSealedRow(r)).delete();
}

async function sweepBlobTable(table: 'imageCache' | 'attachmentCache'): Promise<void> {
  const ids = (await raw()[table].toCollection().primaryKeys()) as string[];
  for (const id of ids) {
    if (keyGone()) throw new Error('key cleared mid-sweep');
    await raw().transaction('rw', raw()[table], async () => {
      const row = await raw()[table].get(id);
      if (!row || isSealedRow(row)) return;
      await raw()[table].put(sealRow(table, row as never) as never);
    });
  }
}

/** Bytes of sealed payload a row holds, for the per-transaction cap. */
function sealedBytes(row: Record<string, unknown>): number {
  const ct = (row.sealed as { ct?: unknown } | undefined)?.ct;
  return typeof ct === 'string' ? ct.length : ct instanceof Uint8Array ? ct.length : 0;
}

/** The blob tables: one row per read, as in step 3, because a row can be
 *  tens of MB and IndexedDB cannot read its marker without its bytes. */
const ONE_ROW_TABLES = new Set(['imageCache', 'attachmentCache']);
/** The account and epoch a re-seal last finished at: `{ account, epoch }`. */
const RESEALED_EPOCH_KEY = 'atRestResealedEpoch';

/**
 * Seal again, under the current local key, every row a key of an earlier
 * epoch sealed. Pages over the primary keys read the markers (no crypto) to
 * find those rows; a blob table is read one row at a time. The rows are then
 * sealed in chunks capped like step 1 (200 rows or about 2 MB), each read
 * again inside its own transaction, so an edit or a pull in between wins. A
 * row that does not open is left as it is, with a breadcrumb, and the sweep
 * goes on: no key will ever open it, so it does not hold the sweep either.
 */
async function resealOlderEpochs(): Promise<void> {
  const db0 = raw();
  for (const table of db0.tables) {
    if (!sealedTableNames().includes(table.name)) continue;
    const ids = await table.toCollection().primaryKeys();
    const pageRows = ONE_ROW_TABLES.has(table.name) ? 1 : PAGE_ROWS;
    for (let i = 0; i < ids.length; i += pageRows) {
      if (keyGone()) throw new Error('key cleared mid-sweep');
      const page = (await table.bulkGet(ids.slice(i, i + pageRows))) as (Record<string, unknown> | undefined)[];
      const chunks: unknown[][] = [];
      let chunk: unknown[] = [];
      let bytes = 0;
      page.forEach((row, j) => {
        if (!row || !resealPending(table.name, row as never)) return;
        chunk.push(ids[i + j]);
        bytes += sealedBytes(row);
        if (chunk.length >= PAGE_ROWS || bytes >= PAGE_BYTES) {
          chunks.push(chunk);
          chunk = [];
          bytes = 0;
        }
      });
      page.length = 0;
      if (chunk.length) chunks.push(chunk);
      for (const keys of chunks) {
        if (keyGone()) throw new Error('key cleared mid-sweep');
        await db0.transaction('rw', table, async () => {
          const rows = await table.bulkGet(keys);
          const updates: unknown[] = [];
          for (const row of rows) {
            if (!row) continue;
            try {
              const next = resealRow(table.name, row as never);
              if (next) updates.push(next);
            } catch (err) {
              if (err instanceof LocalSealKeyMissing) throw err;
              logAuthEvent('seal:reseal-skipped', { message: table.name });
            }
          }
          if (updates.length) await table.bulkPut(updates);
        });
      }
    }
  }
  resealStashSlots();
  resealSealedSettings();
}

async function sweepOnce(): Promise<void> {
  await sweepNotes();
  await sweepDocCache();
  await sweepBlobTable('imageCache');
  await sweepBlobTable('attachmentCache');
  // An account that never changed its phrase has nothing of an earlier
  // epoch, and this step reads nothing for it. After a re-seal finished at
  // this epoch, only a read that met an earlier key asks for another one:
  // every write since seals under the current key.
  const epoch = currentKeyEpoch();
  if (epoch > 1) {
    let account: string | null = null;
    try {
      account = localStorage.getItem(PUBKEY_OWNER_KEY);
    } catch {
      /* no owner known: the step runs */
    }
    const record = JSON.stringify({ account, epoch });
    const asked = lazyAsked;
    lazyAsked = false;
    if (asked || account === null || (await db.kv.get(RESEALED_EPOCH_KEY))?.value !== record) {
      try {
        await resealOlderEpochs();
      } catch (err) {
        // The retry of runAtRestSweep must still see the request.
        lazyAsked ||= asked;
        throw err;
      }
      if (account !== null) await db.kv.put({ key: RESEALED_EPOCH_KEY, value: record });
    }
  }
  // Telemetry only - nothing keys off this. The rescan next session is
  // what makes reappearing plaintext self-healing.
  await db.kv.put({ key: 'atRestSweepCleanAt', value: new Date().toISOString() });
}

// Lazy on read: a read that needed a ring key asks for a pass, at most one a
// minute, never from the sweep's own reads.
const LAZY_DELAY_MS = 3000;
const LAZY_GAP_MS = 60_000;
let lazyAt = 0;
let lazyTimer: ReturnType<typeof setTimeout> | null = null;
/** A read met an earlier key since the last sweep began. */
let lazyAsked = false;
onStaleSealRead(() => {
  if (running) return;
  lazyAsked = true;
  if (lazyTimer !== null || Date.now() - lazyAt < LAZY_GAP_MS) return;
  lazyTimer = setTimeout(() => {
    lazyTimer = null;
    lazyAt = Date.now();
    void runAtRestSweep();
  }, LAZY_DELAY_MS);
});

/**
 * Run one sweep pass. Idempotent and re-entrant-safe; the UI calls it
 * on an idle delay after mount and never needs to await it.
 */
export async function runAtRestSweep(): Promise<void> {
  if (running || isDemoMode() || keyGone()) return;
  running = true;
  try {
    const doPass = async () => {
      try {
        await sweepOnce();
      } catch (err) {
        // One reopen absorbs a severed IndexedDB connection (the iOS
        // background-kill class); any second failure ends the pass.
        try {
          rawDb?.close();
        } catch {
          /* already closed */
        }
        rawDb = null;
        try {
          await sweepOnce();
        } catch (err2) {
          logAuthEvent('seal:sweep-stopped', {
            message: (err2 as Error | null)?.message ?? String(err),
          });
        }
      }
    };
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      await navigator.locks.request('pn-at-rest-sweep', { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        await doPass();
      });
    } else {
      await doPass();
    }
  } finally {
    running = false;
  }
}
