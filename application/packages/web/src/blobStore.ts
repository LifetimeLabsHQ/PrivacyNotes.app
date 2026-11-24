/**
 * The one door to the object store that holds encrypted pictures and files.
 *
 * Every module that stores, reads, lists or removes a sealed blob calls a
 * BlobBackend, and only this file reaches the store behind it. An object is
 * named by its uuid alone: the backend adds the account's prefix, so no
 * caller builds a path.
 *
 * Two backends: `workerBackend`, the files Worker, for every call of an
 * official build from Phase A1 on, and `supabaseBackend`, Storage itself, for
 * a build that syncs with another server and as the emergency path
 * (STORAGE_DIRECT). `blobBackend` picks one; it is the only place that does.
 *
 * A refusal is a BlobError. Its `kind` is what a caller decides by; it keeps
 * the store's own message, and the store's error as `cause` for the callers
 * that read its code. `tools/sinks.mjs` (`storage.from`, `filesWorkerFetch`)
 * keeps this the only caller of either store.
 * Spec: docs/contrib/own-storage.md (section 7, PR 1)
 * Spec: docs/internal/plans/r2-migration-spec.md (section 6)
 */

import type { SupabaseClient } from '@notes/shared';
import { isDemoMode } from './demo';
import { isLocalOnly, LocalOnlyNetworkBlockedError } from './localOnly';
import { FILES_ORIGIN, usesOfficialServer } from './hosts';
import { isAlreadyExists } from './blobUploadRecovery';
import { isMfaRefusal } from './mfaStep';
import { isPhraseReplacedRefusal } from './phraseReplaced';
import { recordStorageFault } from './syncFaults';
import { sha256Hex } from './sha256Hex';
import { isUuid } from './uuid';

/** One bucket for every encrypted blob, pictures and files alike. */
const BUCKET = 'encrypted-images';

/** Errors that will never succeed on retry - mark the row refused. */
export function isPermanentUploadError(msg: string): boolean {
  return (
    msg.includes('exceeded the maximum allowed size') ||
    msg.includes('Payload too large') ||
    msg.includes('413')
  );
}

/** A blob refused for storage quota: retryable once the user frees space or
 *  upgrades. Only "Quota exceeded": the 90-day freeze ("Sync frozen", see
 *  isQuotaError in sync.ts) covers the notes table, not blobs. */
export function isBlobQuotaError(msg: string): boolean {
  return msg.includes('Quota exceeded');
}

export type BlobErrorKind = 'exists' | 'not_found' | 'quota' | 'too_large' | 'mfa' | 'phrase_replaced' | 'banned' | 'upload_limit' | 'rate_limited' | 'transient';

export class BlobError extends Error {
  constructor(
    readonly kind: BlobErrorKind,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export interface BlobEntry {
  uuid: string;
  /** The sealed size, or 0 when the store did not say. */
  size: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BlobBackend {
  /** Create-only: BlobError('exists') when the name is taken. */
  put(uuid: string, sealed: Uint8Array): Promise<void>;
  /** Over an object of the same name and the same size, never a delete and a put. */
  overwrite(uuid: string, sealed: Uint8Array): Promise<void>;
  /** Null when the store has no such object. */
  get(uuid: string): Promise<Blob | null>;
  /** The store answers for the batch as a whole: every uuid is in one list. */
  remove(uuids: string[]): Promise<{ removed: string[]; failed: string[] }>;
  /** Null when the store did not answer. */
  exists(uuid: string): Promise<boolean | null>;
  /** One page in name order after `after` (null for the first), full unless
   *  it is the last. Null when the page failed. */
  list(after: string | null, limit: number): Promise<BlobEntry[] | null>;
}

type StoreError = { message?: string; status?: unknown; statusCode?: string | number; name?: string; code?: unknown };

/** The answers `get` and `remove` read as "no such object". */
const isNotFound = (msg: string): boolean => msg.includes('not found') || msg.includes('404');

function kindOf(error: StoreError): BlobErrorKind {
  const msg = error.message ?? '';
  if (isAlreadyExists(error)) return 'exists';
  if (isMfaRefusal(error)) return 'mfa';
  if (isPhraseReplacedRefusal(error)) return 'phrase_replaced';
  if (isBlobQuotaError(msg)) return 'quota';
  if (isPermanentUploadError(msg)) return 'too_large';
  // Wider than isNotFound: any spelling. `get` answers null only for the
  // spellings above and throws the others with this kind, so each caller
  // keeps its own reading of them.
  if (/not.?found|404/i.test(msg)) return 'not_found';
  return 'transient';
}

const refusal = (error: StoreError): BlobError =>
  new BlobError(kindOf(error), error.message || '', typeof error.status === 'number' ? error.status : undefined, error);

type Listed = { id?: string | null; name: string; created_at?: string | null; updated_at?: string | null; metadata?: Record<string, unknown> | null };

function supabaseBackend(supabase: SupabaseClient, pubkey: string): BlobBackend {
  const path = (uuid: string) => `${pubkey}/${uuid}`;
  // Storage pages by offset, not by name. A listing is read in order from its
  // first page, so the offset behind the last row of each page is what
  // `after` means here. A name this instance never returned has no page.
  const offsetAfter = new Map<string, number>();

  return {
    async put(uuid, sealed) {
      if (isDemoMode()) return;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      const name = path(uuid);
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(name, sealed, { contentType: 'application/octet-stream', upsert: false });
      if (!error) return;
      // A taken name is an earlier attempt that landed, not a fault.
      if (!isAlreadyExists(error)) recordStorageFault('file-up', error, uuid);
      throw refusal(error);
    },

    async overwrite(uuid, sealed) {
      if (isDemoMode()) return;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      // The one upload that may overwrite; tests/reencryptMigration.test.ts
      // reads the source for any other.
      const name = path(uuid);
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(name, sealed, { upsert: true, contentType: 'application/octet-stream' });
      if (error) throw refusal(error);
    },

    async get(uuid) {
      if (isDemoMode()) return null;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      const { data, error } = await supabase.storage.from(BUCKET).download(path(uuid));
      if (!error) return data ?? null;

      // "Bucket not found" is what Storage answers for a private bucket when
      // the session is expired or invalid: an auth error, not a missing
      // file. Refresh the session once and ask again.
      if (error.message?.includes('Bucket not found')) {
        const { error: refreshErr } = await supabase.auth.refreshSession();
        if (refreshErr) {
          recordStorageFault('file-down', refreshErr, uuid);
          throw new BlobError('transient', `session refresh failed: ${refreshErr.message}`, undefined, refreshErr);
        }
        const retry = await supabase.storage.from(BUCKET).download(path(uuid));
        if (!retry.error) return retry.data ?? null;
        recordStorageFault('file-down', retry.error, uuid);
        if (isNotFound(retry.error.message ?? '')) return null;
        throw refusal(retry.error);
      }

      recordStorageFault('file-down', error, uuid);
      if (isNotFound(error.message ?? '')) return null;
      throw refusal(error);
    },

    async remove(uuids) {
      if (uuids.length === 0 || isDemoMode()) return { removed: [], failed: [] };
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      const { error } = await supabase.storage.from(BUCKET).remove(uuids.map(path));
      // Storage reports one error for the batch, not one per name. A "not
      // found" answer means the objects are gone already, which is the wanted
      // end state; any other error fails every uuid, so the caller retries
      // the batch.
      if (!error || isNotFound(error.message ?? '')) return { removed: uuids, failed: [] };
      recordStorageFault('file-delete', error);
      console.warn('[blobStore] remote removal failed:', error.message);
      return { removed: [], failed: uuids };
    },

    async exists(uuid) {
      if (isDemoMode()) return null;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      try {
        const { data } = await supabase.storage.from(BUCKET).exists(path(uuid));
        return data === true;
      } catch {
        return null;
      }
    },

    async list(after, limit) {
      if (isDemoMode()) return null;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      let offset = after === null ? 0 : offsetAfter.get(after);
      if (offset === undefined) return null;
      const out: BlobEntry[] = [];
      for (;;) {
        const want = limit - out.length;
        const { data, error } = await supabase.storage.from(BUCKET).list(pubkey, { limit: want, offset });
        if (error) {
          console.warn('[blobStore] listing failed:', error.message);
          return null;
        }
        const rows = (data ?? []) as Listed[];
        offset += rows.length;
        for (const o of rows) {
          // A folder has no object id: an object stored one level down,
          // before the bucket's policies refused that. It is no blob.
          if (o.id === null) continue;
          const size = o.metadata?.size;
          out.push({
            uuid: o.name,
            size: typeof size === 'number' && size > 0 ? size : 0,
            createdAt: o.created_at ?? null,
            updatedAt: o.updated_at ?? null,
          });
        }
        // A page is full unless it is the last, which is how a caller knows
        // the last one: rows that a folder took are asked for again.
        if (rows.length < want || out.length === limit) break;
      }
      const last = out[out.length - 1];
      if (last) offsetAfter.set(last.uuid, offset);
      return out;
    },
  };
}

// ---- The files Worker ------------------------------------------------------

/** The Worker's answer codes and the kind each one is (spec 4.2, the answers
 *  table). Any other code, `unavailable` and `unauthorized` among them, is
 *  transient. `account_deleted` is transient too: Storage's own refusal of a
 *  deleted account was, and the sync path handles the deletion itself. */
const WORKER_KINDS: Readonly<Record<string, BlobErrorKind>> = {
  exists: 'exists',
  not_found: 'not_found',
  quota: 'quota',
  too_large: 'too_large',
  mfa_required: 'mfa',
  mfa_wrong_login: 'mfa',
  phrase_replaced: 'phrase_replaced',
  banned: 'banned',
  upload_limit: 'upload_limit',
  rate_limited: 'rate_limited',
};

/** What the adapter reads of a Worker answer: its status, its fixed code
 *  and message, and the key-epoch refusal's PostgREST code. */
type WorkerRefusal = { status: number; error: string; message: string; code?: string };

/** One request to the files Worker, the only one of the app
 *  (tools/sinks.mjs, `filesWorkerFetch`): no cookie, nothing cached. */
function filesWorkerFetch(path: string, init: RequestInit): Promise<Response> {
  if (isLocalOnly()) return Promise.reject(new LocalOnlyNetworkBlockedError());
  // A redirect fails: the body and the token go to the files host or nowhere.
  return fetch(`${FILES_ORIGIN}${path}`, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error' });
}

/** How the Worker backend reaches the network and the clock; a test or the
 *  sync simulator passes its own. */
export interface WorkerIo {
  send(path: string, init: RequestInit): Promise<Response>;
  wait(ms: number): Promise<void>;
  now(): number;
}

const WORKER_IO: WorkerIo = {
  send: (path, init) => filesWorkerFetch(path, init),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** `rate_limited`: the Worker counts 600 requests a minute per account. A
 *  refused call waits this long, every call of the account waits with it,
 *  and after RATE_TRIES refusals (a whole minute of the Worker's window) the
 *  call ends as `rate_limited`, which the stores take for transient: the next
 *  pass asks again. Never a loop.
 *  Spec: docs/internal/plans/r2-migration-spec.md (section 4.2, the answers table) */
const RATE_WAIT_MS = 30_000;
const RATE_TRIES = 3;

/** Per account: until when its calls wait for the rate limit, and until when
 *  its new uploads are held for the day's upload limit. */
const ratePausedUntil = new Map<string, number>();
const uploadsHeld = new Map<string, number>();
/** Per account: the session refresh in flight, which every refused call waits for. */
const refreshing = new Map<string, Promise<{ error: { message: string } | null }>>();

/** The next 00:00 UTC after `now`, when the day's upload limit starts again. */
const nextUtcDay = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

/**
 * Until when this account's new uploads are held (Unix milliseconds), or
 * null. An `upload_limit` refusal holds every new upload until the next UTC
 * day: a put in that time ends as `upload_limit` with no request. A refusal
 * by the account's live charges ends 24 hours after them instead, and the
 * answer does not tell the two apart (spec 4.2), so a put after the hold can
 * meet one more refusal and one more hold. At most a few requests a day.
 */
export function uploadsHeldUntil(pubkey: string, now = Date.now()): number | null {
  const until = uploadsHeld.get(pubkey);
  if (until === undefined || until <= now) return null;
  return until;
}

/** The refusal in a Worker answer that is not a success. A body the Worker
 *  did not write (a proxy's page, a cut answer) reads as `unavailable`. */
async function workerRefusal(res: Response): Promise<WorkerRefusal> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not the Worker's JSON */
  }
  const row = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return {
    status: res.status,
    error: typeof row.error === 'string' ? row.error : 'unavailable',
    message: typeof row.message === 'string' ? row.message : `files ${res.status}`,
    ...(typeof row.code === 'string' ? { code: row.code } : {}),
  };
}

/** A refusal as the stores read it. The refusal rides as `cause`, so
 *  isPhraseReplacedRefusal finds the key-epoch answer's code on it. */
const workerError = (refusal: WorkerRefusal): BlobError =>
  new BlobError(Object.hasOwn(WORKER_KINDS, refusal.error) ? WORKER_KINDS[refusal.error]! : 'transient', refusal.message, refusal.status, refusal);

/** A request that never got an answer. */
const NO_ANSWER = (err: unknown): WorkerRefusal => ({ status: 0, error: 'unavailable', message: err instanceof Error ? err.message : 'Failed to fetch' });

/**
 * The files Worker at FILES_ORIGIN (spec 4.2): put, overwrite, get and
 * remove go to its routes with the person's own access token, and exists and
 * list ask the database (`blob_exists`, `blob_list`), which answer for both
 * stores. The Worker decides the store; the app sends the same request
 * whether the file ends up in Storage or in R2.
 * Spec: docs/internal/plans/r2-migration-spec.md (section 6)
 */
export function workerBackend(supabase: SupabaseClient, pubkey: string, io: WorkerIo = WORKER_IO): BlobBackend {
  /**
   * One Worker request: the token of the session at each call, one session
   * refresh on a 401 and the request once more, and the account's rate
   * limit waited out. Answers the response of a success, or the refusal.
   */
  async function call(path: string, init: RequestInit): Promise<Response | WorkerRefusal> {
    let refreshed = false;
    for (let tries = 1; ; tries++) {
      // Clamped: a device clock set back during a pause must not stretch it.
      const paused = Math.min((ratePausedUntil.get(pubkey) ?? 0) - io.now(), RATE_WAIT_MS);
      if (paused > 0) await io.wait(paused);
      let res: Response;
      let token: string | undefined;
      try {
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token;
        if (!token) return { status: 0, error: 'unauthorized', message: 'no session' };
        // The Worker names the file from the token alone. A store of another
        // account, kept past a switch, must not write or read in this one.
        if (data.session?.user?.app_metadata?.pubkey !== pubkey) return { status: 0, error: 'unauthorized', message: 'session of another account' };
        res = await io.send(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } });
      } catch (err) {
        return NO_ANSWER(err);
      }
      if (res.ok) return res;
      const refusal = await workerRefusal(res);
      if (refusal.error === 'unauthorized' && !refreshed) {
        // An expired token, as Storage's "Bucket not found" was: refresh
        // once and ask again. Never a sign-out from here.
        refreshed = true;
        // One refresh for every call of the account that met the same
        // token, and none when the session moved on meanwhile.
        const { data } = await supabase.auth.getSession();
        if (data.session?.access_token === token) {
          let running = refreshing.get(pubkey);
          if (!running) {
            running = supabase.auth.refreshSession().then(({ error }) => ({ error }), (err: unknown) => ({ error: { message: err instanceof Error ? err.message : 'failed' } }));
            refreshing.set(pubkey, running);
            void running.finally(() => refreshing.delete(pubkey));
          }
          const { error } = await running;
          if (error) return { status: 0, error: 'unauthorized', message: `session refresh failed: ${error.message}` };
        }
        continue;
      }
      if (refusal.error === 'rate_limited') {
        ratePausedUntil.set(pubkey, io.now() + RATE_WAIT_MS);
        if (tries < RATE_TRIES) continue;
      }
      return refusal;
    }
  }

  const fault = (refusal: WorkerRefusal) => ({ status: refusal.status || undefined, code: refusal.error });

  async function write(uuid: string, sealed: Uint8Array, overwrite: boolean): Promise<WorkerRefusal | null> {
    const res = await call(`/o/${uuid}${overwrite ? '?overwrite=1' : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-PN-SHA256': await sha256Hex(sealed) },
      body: sealed as Uint8Array<ArrayBuffer>,
    });
    if (res instanceof Response) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return res;
  }

  return {
    async put(uuid, sealed) {
      if (isDemoMode()) return;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      const held = uploadsHeldUntil(pubkey, io.now());
      if (held !== null) throw new BlobError('upload_limit', 'upload limit');
      const refusal = await write(uuid, sealed, false);
      if (!refusal) return;
      if (refusal.error === 'upload_limit') uploadsHeld.set(pubkey, nextUtcDay(io.now()));
      // A taken name is an earlier attempt that landed, not a fault.
      if (refusal.error !== 'exists') recordStorageFault('file-up', fault(refusal), uuid);
      throw workerError(refusal);
    },

    async overwrite(uuid, sealed) {
      if (isDemoMode()) return;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      const refusal = await write(uuid, sealed, true);
      if (refusal) throw workerError(refusal);
    },

    async get(uuid) {
      if (isDemoMode()) return null;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      let res = await call(`/o/${uuid}`, { method: 'GET' });
      if (res instanceof Response) {
        try {
          return await res.blob();
        } catch (err) {
          // The answer broke off part way.
          res = NO_ANSWER(err);
        }
      }
      recordStorageFault('file-down', fault(res), uuid);
      // Only the Worker's own "not found": a ledger row whose object is
      // missing answers 503, never this, so a null is a file that is gone.
      if (res.error === 'not_found') return null;
      throw workerError(res);
    },

    async remove(uuids) {
      if (uuids.length === 0 || isDemoMode()) return { removed: [], failed: [] };
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      const removed: string[] = [];
      const failed: string[] = [];
      // One request a name, and the Worker answers each: 204 also when
      // nothing was there.
      for (const uuid of uuids) {
        const res = await call(`/o/${uuid}`, { method: 'DELETE' });
        if (res instanceof Response || res.error === 'not_found') {
          removed.push(uuid);
          continue;
        }
        recordStorageFault('file-delete', fault(res));
        failed.push(uuid);
      }
      if (failed.length > 0) console.warn('[blobStore] remote removal failed for', failed.length, 'of', uuids.length);
      return { removed, failed };
    },

    async exists(uuid) {
      if (isDemoMode()) return null;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      try {
        const { data, error } = await supabase.rpc('blob_exists', { p_uuid: uuid });
        if (error || !data || typeof data !== 'object') return null;
        const row = data as { in_r2?: unknown; in_supabase?: unknown };
        return row.in_r2 === true || row.in_supabase === true;
      } catch {
        return null;
      }
    },

    async list(after, limit) {
      if (isDemoMode()) return null;
      if (isLocalOnly()) throw new LocalOnlyNetworkBlockedError();
      const out: BlobEntry[] = [];
      let from = after;
      // blob_list pages by uuid, at most 1000 rows a call. A page ends only
      // on an empty answer or the limit, so a server that caps rows lower
      // never cuts a listing short.
      for (;;) {
        const want = Math.min(limit - out.length, 1000);
        const { data, error } = await supabase.rpc('blob_list', { p_after: from, p_limit: want });
        if (error || !Array.isArray(data)) {
          if (error) console.warn('[blobStore] listing failed:', error.message);
          return null;
        }
        const rows = data as Array<{ uuid: string; size: number | null; created_at: string | null; updated_at: string | null }>;
        if (rows.length === 0) return out;
        for (const r of rows) {
          // blob_list splits a Storage name at its first slash, so an object
          // stored one level deeper (none exist) reads as its folder's name.
          if (!isUuid(r.uuid)) continue;
          out.push({ uuid: r.uuid, size: typeof r.size === 'number' && r.size > 0 ? r.size : 0, createdAt: r.created_at ?? null, updatedAt: r.updated_at ?? null });
        }
        from = rows[rows.length - 1]!.uuid;
        if (out.length >= limit) return out;
      }
    },
  };
}

/**
 * The emergency path of Phase A1 (plan section 8): true sends every file call
 * of this build straight to Supabase Storage again, as every build before A1
 * did. It is turned in a release, never at runtime: set it, build, publish.
 * It works while the database still takes uploads into Storage
 * (`blob_rollout.supabase_insert`) and Storage holds the files, so until
 * Phase C. Removed with `supabaseBackend` in Phase E.
 * Spec: docs/internal/plans/r2-migration-spec.md (section 6)
 */
const STORAGE_DIRECT = false;

/** The store this account's blobs live in. A build for another sync server
 *  keeps that server's Storage: the Worker serves the official project only,
 *  and a token of another server never goes to our host. */
export function blobBackend(supabase: SupabaseClient, pubkey: string): BlobBackend {
  if (STORAGE_DIRECT || !usesOfficialServer()) return supabaseBackend(supabase, pubkey);
  return workerBackend(supabase, pubkey);
}
