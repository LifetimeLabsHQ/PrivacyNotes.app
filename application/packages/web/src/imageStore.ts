/**
 * Image store - upload, fetch, cache for encrypted image blobs.
 *
 * Local-first architecture:
 * - Upload: encrypt → cache in IndexedDB → return UUID instantly →
 *   background upload to Supabase Storage + quota adjustment.
 * - Fetch: check IndexedDB cache → fall back to Supabase download.
 * - On init: processPendingUploads() retries blobs that were cached
 *   locally but never made it to the server (app closed, network error).
 *
 * Blob naming: `<pubkey>/<uuid>` - RLS on the bucket restricts access
 * to rows where the path prefix matches the user's pubkey.
 */

import { encryptBlob, decryptBlob, type SupabaseClient } from '@notes/shared';
import { db } from './db';
import { openWithRing } from './keyRing';
import { isDemoMode } from './demo';
import { recordStorageFault, recordSyncFault } from './syncFaults';
import { isServerWriteBlocked } from './syncPause';
import { uploadsHeldForWifi } from './wifiOnly';
import { recalculateQuota } from './devices';
import { claimRemoval, isAlreadyExists, markIfPending } from './blobUploadRecovery';
import { PENDING_GC_WAIT_MS, settleWithin } from './pendingGcWait';
import { BlobStoreBase, BUCKET, UPLOAD_REFUSED, isBlobQuotaError, isPermanentUploadError } from './blobStoreBase';
import { sha256Hex } from './sha256Hex';
import { BlobDamagedError } from './blobDamaged';

/**
 * Encrypted blob sizes learned from a Storage listing, keyed by uuid.
 *
 * imageDedup carries the same number, but it is keyed by the SHA-256 of the
 * pre-encryption bytes, which only the device that uploaded the image holds.
 * A new phone, a fresh browser or a cleared cache has no row to update, so a
 * size read off Storage lives here instead. A blob is immutable, so a uuid
 * keeps its size for good and this never needs invalidating.
 *
 * The listing that fills this scans the whole bucket, so the cache is what
 * holds it to once per device rather than once per render.
 */
const IMAGE_SIZES_KEY = 'imageSizesByUuid';

export async function readImageSizes(): Promise<Record<string, number>> {
  const entry = await db.kv.get(IMAGE_SIZES_KEY);
  if (typeof entry?.value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(entry.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}

export async function rememberImageSizes(sizes: Record<string, number>): Promise<void> {
  if (Object.keys(sizes).length === 0) return;
  const merged = { ...(await readImageSizes()), ...sizes };
  await db.kv.put({ key: IMAGE_SIZES_KEY, value: JSON.stringify(merged) });
}

/** Storage returns at most this many names per listing call. */
const LIST_PAGE = 1000;

/** Pending-GC ids per request. Every id rides the `.in()` filter in the URL,
 *  about 39 bytes each, and a proxy refuses a URL past about 8 KB (200 ids):
 *  one cancel for a large batch failed on every pass, and the server purge
 *  then deleted files that notes use. Same chunk as the tombstone push in
 *  sync.ts. A cancel that fails part way answers null, and the retry treats
 *  the ids an earlier chunk took as gone and uploads them again: safe. */
const GC_CHUNK = 50;

function gcChunks(uuids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < uuids.length; i += GC_CHUNK) out.push(uuids.slice(i, i + GC_CHUNK));
  return out;
}

/**
 * Look up blob sizes in Storage and remember what the listing resolves.
 *
 * The listing pages, because an account can hold more blobs than one call
 * returns and Storage answers with the first page only: a blob past that page
 * has no size any single call can reach. Paging stops the moment every wanted
 * uuid is accounted for, so a full scan is the worst case rather than the norm,
 * and one call already costs a scan of the whole bucket.
 *
 * `sizes` holds the wanted uuids only. The bucket also holds attachments, whose
 * stored size is the encrypted one; a caller that maps sizes onto items by uuid
 * would otherwise show that size in place of the real one. The remembered
 * cache keeps every size the scan paid for, because it is read by uuid.
 *
 * `absent` names the uuids the listing walked past without finding, which is
 * what a note referencing a removed blob leaves behind. Nothing here remembers
 * them: the same blob can still arrive from another device, so how long to stop
 * asking belongs to the caller.
 */
export async function listImageSizes(
  supabase: SupabaseClient,
  pubkey: string,
  wanted: string[],
): Promise<{ sizes: Map<string, number>; absent: string[] }> {
  const sizes = new Map<string, number>();
  const wantedSet = new Set(wanted);
  const outstanding = new Set(wanted);
  if (outstanding.size === 0) return { sizes, absent: [] };

  const learned: Record<string, number> = {};
  for (let offset = 0; outstanding.size > 0; offset += LIST_PAGE) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(pubkey, { limit: LIST_PAGE, offset });
    // A failed page leaves the rest outstanding rather than absent: the
    // caller must not read a network error as "this blob is gone".
    if (error) return { sizes, absent: [] };
    const page = data ?? [];
    for (const obj of page) {
      const size = (obj.metadata as Record<string, unknown> | null)?.size;
      if (typeof size === 'number' && size > 0) {
        if (wantedSet.has(obj.name)) sizes.set(obj.name, size);
        learned[obj.name] = size;
      }
      outstanding.delete(obj.name);
    }
    if (page.length < LIST_PAGE) break;
  }
  await rememberImageSizes(learned);
  return { sizes, absent: [...outstanding] };
}

export class ImageStore extends BlobStoreBase<{ data: Uint8Array }> {
  /** Called when a background upload fails permanently. UI should show a toast. */
  onBackgroundError?: (error: string) => void;
  protected readonly logName = 'imageStore';
  protected readonly noun = 'Image';
  protected get dedup() {
    return db.imageDedup;
  }
  protected cached(uuid: string) {
    return db.imageCache.get(uuid);
  }
  protected plaintextOf(cached: { data: Uint8Array }): Uint8Array {
    return cached.data;
  }
  protected retryUpload(uuid: string, _cached: { data: Uint8Array }, encrypted: Uint8Array): Promise<void> {
    return this._backgroundUpload(uuid, encrypted);
  }

  /**
   * Upload an image: encrypt → cache locally → return UUID instantly.
   * Supabase upload + quota adjustment runs in background.
   *
   * Deduplication: hashes the processed bytes with SHA-256. If the same
   * content was uploaded before, returns the existing UUID without
   * hitting the server again.
   */
  async uploadImage(data: Uint8Array): Promise<string> {
    // Content-hash dedup check.
    const hashHex = await sha256Hex(data);
    const existing = await db.imageDedup.get(hashHex);
    if (existing) {
      return existing.uuid;
    }

    const uuid = crypto.randomUUID();
    // signOut can zero this.encryptionKey mid-upload. This is a
    // user-initiated path, not a background retry - throw rather than
    // silently encrypt with a dead key; callers already handle upload
    // errors.
    const passKey = this.keyCopy();
    if (!passKey) {
      throw new Error('Sign-out in progress');
    }
    const encrypted = encryptBlob(data, passKey);
    passKey.fill(0);

    // --- Local-first: cache + dedup record, return immediately ---
    await db.imageCache.put({ id: uuid, data, cachedAt: new Date().toISOString() });
    await db.imageDedup.put({
      hash: hashHex,
      uuid,
      encryptedSize: encrypted.length,
      pendingUpload: 1,
    });

    // --- Background: upload to Supabase + adjust quota ---
    this._backgroundUpload(uuid, encrypted).catch(() => {
      // Already handled inside _backgroundUpload.
    });

    return uuid;
  }

  /**
   * Upload encrypted blob to Supabase and adjust quota.
   * On permanent failure: marks the row UPLOAD_REFUSED and keeps the
   * local cache, now the only copy, so restored/pasted images remain
   * viewable offline.
   * On transient failure: keeps pendingUpload for retry on next init.
   */
  private async _backgroundUpload(uuid: string, encrypted: Uint8Array): Promise<void> {
    // Demo mode makes zero server calls - the blob lives only in the
    // throwaway local cache. Still do the bookkeeping the upload would
    // have done so the dedup row carries a real size for the Files view.
    if (isDemoMode()) {
      const cached = await db.imageDedup.where('uuid').equals(uuid).first();
      if (cached) {
        await db.imageDedup.update(cached.hash, { pendingUpload: 0, encryptedSize: encrypted.length });
      }
      return;
    }

    // Server writes blocked (release floor or user pause - see syncPause.ts).
    // Unlike the demo branch, do NOT clear pendingUpload: the blob must
    // upload once the block lifts, and the retry sweep (also gated) handles
    // that. Same hold while "Files on wifi only" waits for wifi.
    if (isServerWriteBlocked() || uploadsHeldForWifi()) return;
    if (this.ownershipLost()) return;

    // A concurrent upload of this same uuid is already running (the
    // post-sync retry hook can now overlap with the initial upload from
    // uploadImage) - let the in-flight one own the pendingUpload bookkeeping
    // rather than racing it to the same Storage path.
    if (this.uploading.has(uuid)) {
      return;
    }
    this.uploading.add(uuid);
    try {
      const path = `${this.pubkey}/${uuid}`;

      // A removal claimed after this moment can be of the object a 409
      // below proves, so the settle compares against it.
      const attemptAt = Date.now();
      const { error } = await this.supabase.storage
        .from(BUCKET)
        .upload(path, encrypted, {
          contentType: 'application/octet-stream',
          // Create-only. A 409 says an earlier attempt of ours landed, which
          // blobUploadRecovery.ts settles and counts once. The bucket's one
          // UPDATE is the phrase change's same-size overwrite (reencryptPass.ts).
          upsert: false,
        });

      if (error) {
        const msg = error.message || '';
        if (isAlreadyExists(error)) {
          await this._settleExistingObject(uuid, path, encrypted, attemptAt);
          return;
        }
        recordStorageFault('file-up', error, uuid);
        if (isPermanentUploadError(msg)) {
          // Keep local cache so restored/pasted images remain viewable offline,
          // and mark the row refused so the doomed upload is never retried.
          const dedup = await db.imageDedup.where('uuid').equals(uuid).first();
          if (dedup) {
            await db.imageDedup.update(dedup.hash, { pendingUpload: UPLOAD_REFUSED });
          }
          this.onBackgroundError?.(msg);
          console.error('[imageStore] permanent upload failure, kept local cache:', uuid, msg);
          return;
        }
        if (isBlobQuotaError(msg)) {
          // Retryable - pendingUpload stays 1, but still toast the user now.
          // Mark the row so the retry sweep skips it while it cannot fit
          // and the status surfaces say "doesn't fit" (backlog #143).
          await markIfPending(db.imageDedup, uuid, { quotaBlocked: 1 });
          this.onBackgroundError?.(msg);
        }
        console.warn('[imageStore] transient upload failure, will retry:', uuid, msg);
        throw new Error(msg);
      }

      if (this.ownershipLost()) return;
      const { error: rpcErr, status: rpcStatus } = await this.supabase.rpc('adjust_blob_bytes', { delta: encrypted.length });
      if (rpcErr) {
        const msg = rpcErr.message || '';
        recordSyncFault({ step: 'file-up', status: rpcStatus, code: rpcErr.code || undefined, ref: uuid });
        if (isBlobQuotaError(msg)) {
          // Remove the remote blob we just uploaded (it must not sit in
          // Storage uncounted), but leave pendingUpload=1 so a later pass
          // retries the whole upload. quotaBlocked makes that later pass
          // wait for real headroom instead of re-uploading the full blob
          // just to land back here (backlog #143).
          if (await claimRemoval(db.imageDedup, uuid)) {
            await this.supabase.storage.from(BUCKET).remove([path]).catch(() => {});
          }
          await markIfPending(db.imageDedup, uuid, { quotaBlocked: 1 });
          this.onBackgroundError?.(msg);
          console.error('[imageStore] quota exceeded, will retry:', uuid);
          return;
        }
        if (isPermanentUploadError(msg)) {
          // Remove the remote blob we just uploaded; the local cache stays,
          // refused, as the only copy.
          if (await claimRemoval(db.imageDedup, uuid)) {
            await this.supabase.storage.from(BUCKET).remove([path]).catch(() => {});
          }
          await markIfPending(db.imageDedup, uuid, { pendingUpload: UPLOAD_REFUSED });
          this.onBackgroundError?.(msg);
          console.error('[imageStore] permanent upload failure, kept local cache:', uuid, msg);
          return;
        }
        // Transient failure (network blip, 5xx, timeout): the object IS in
        // Storage, counted or not. Keep pendingUpload=1 so the retry sweep
        // meets it: its create-only upload answers 409 and the settle asks
        // the server to recount, which counts the bytes exactly once (backlog
        // #131). Clearing the flag here would understate usage until the
        // next recount, permanently if none ran.
        console.warn('[imageStore] adjust_blob_bytes failed, will retry:', msg);
        return;
      }

      // Clear pending flag and update encryptedSize (may have been 0 from
      // restoreBlobs - now we know the real size after encrypting).
      const dedup = await db.imageDedup.where('uuid').equals(uuid).first();
      if (dedup) {
        await db.imageDedup.update(dedup.hash, { pendingUpload: 0, quotaBlocked: 0, encryptedSize: encrypted.length });
      }
    } finally {
      this.uploading.delete(uuid);
    }
  }




  /**
   * Get a decrypted image by UUID. Checks IndexedDB cache first,
   * then falls back to downloading + decrypting from Supabase Storage.
   * Returns null if the image doesn't exist.
   */
  async getImage(uuid: string): Promise<Uint8Array | null> {
    // Check cache first.
    const cached = await db.imageCache.get(uuid);
    if (cached) return cached.data;

    // Download from Supabase Storage, with one retry on auth errors.
    const path = `${this.pubkey}/${uuid}`;
    const result = await this._downloadWithRetry(path);
    if (!result) return null;

    const encrypted = new Uint8Array(await result.arrayBuffer());
    // Bytes that do not open are told apart from a failed request; nothing
    // is cached or deleted for them. See blobDamaged.ts.
    let decrypted: Uint8Array;
    try {
      decrypted = openWithRing('sync', this.encryptionKey, (key) => decryptBlob(encrypted, key));
    } catch {
      throw new BlobDamagedError(uuid);
    }

    // Cache for next time.
    await db.imageCache.put({ id: uuid, data: decrypted, cachedAt: new Date().toISOString() });

    return decrypted;
  }


  /**
   * Defer deletion of multiple images: remove local cache + dedup rows
   * and decrement quota immediately, but leave the Supabase Storage
   * object in place. The uuid is enqueued in db.blobGC so sweepBlobGC
   * (imageGC.ts) can remove the remote object later, once a clean sync
   * pull has proven the local mirror is complete enough to trust the
   * reference re-check. See imageGC.ts for the full two-phase design.
   *
   * A blob whose upload is still pending, or was refused for good,
   * exists nowhere but this cache, and a cut and paste or an undo brings
   * its reference back a moment later, so its bytes and dedup row stay:
   * processPendingUploads needs both. It is queued at size 0, since no
   * upload was ever charged for it, and the sweep drops its local rows
   * once the re-check finds it unreferenced.
   */
  async deferDelete(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    // The demo never uploads and never sweeps, so its cache holds the only
    // copy of every blob. Nothing is deleted: the demo database is
    // discarded with the tab session.
    if (isDemoMode()) return;

    let totalSize = 0;
    const now = new Date().toISOString();
    for (const uuid of uuids) {
      const dedup = await db.imageDedup.where('uuid').equals(uuid).first();
      if (dedup?.pendingUpload === 1 || dedup?.pendingUpload === UPLOAD_REFUSED) {
        await db.blobGC.put({ uuid, kind: 'image', size: 0, enqueuedAt: now });
        continue;
      }
      const size = dedup?.encryptedSize ?? 0;
      totalSize += size;

      await db.imageCache.delete(uuid);
      await db.imageDedup.where('uuid').equals(uuid).delete();
      await db.blobGC.put({ uuid, kind: 'image', size, enqueuedAt: now });
    }

    // Below the release floor server writes pause (see sync.ts). The local
    // blobGC queue above survives, so the (also floor-gated) sweep deletes
    // the objects and settles quota once the user updates.
    if (isServerWriteBlocked()) return;

    // Server-side pending set (migration 0068): the recalc exclusion must
    // not depend on which device asks - db.blobGC is device-local, and a
    // peer recalculating would re-inflate the quota row (backlog #131).
    // Awaited, up to PENDING_GC_WAIT_MS, so a recount the caller runs next
    // already leaves these out; a failure or a stall is still only logged or
    // outwaited, because the local queue drives the sweep, which re-asserts
    // these rows on every pass, so a lost enqueue converges at the next clean
    // pull.
    // Spec: packages/supabase/migrations/history/0068_pending_blob_gc_server_side.sql
    await settleWithin(this.ensurePendingGC(uuids), PENDING_GC_WAIT_MS);

    // Decrement image_bytes quota (best-effort) - the blob still counts
    // against Storage until the sweep removes it, but the user's quota
    // must reflect the delete now.
    if (!this.ownershipLost() && totalSize > 0) {
      this.supabase.rpc('adjust_blob_bytes', { delta: -totalSize })
        .then(({ error: rpcErr }) => {
          if (rpcErr) console.warn('[imageStore] adjust_blob_bytes failed:', rpcErr.message);
        });
    }
  }

  /**
   * Idempotently (re-)assert server-side pending rows for queued
   * deletions. deferDelete fires it best-effort at delete time; the sweep
   * re-asserts the whole surviving queue on every pass, so an enqueue
   * lost to a network blip converges at the next clean pull instead of
   * waiting out the orphan reconcile. The table is per-account, so one
   * store's client covers image and attachment entries alike.
   * Spec: packages/supabase/migrations/history/0068_pending_blob_gc_server_side.sql
   */
  async ensurePendingGC(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;
    const { error } = await this.supabase
      .from('pending_blob_gc')
      .upsert(
        uuids.map((uuid) => ({ user_pubkey: this.pubkey, uuid })),
        { onConflict: 'user_pubkey,uuid', ignoreDuplicates: true }
      );
    if (error) console.warn('[imageStore] pending_blob_gc enqueue failed:', error.message);
  }

  /**
   * Removal of server-side pending-GC rows once their objects are actually
   * gone, or once the deletion was cancelled. Answers whether the server
   * took it. For a settled object a row left behind costs only quota
   * accuracy until the 7-day expiry. For a cancelled deletion it is the
   * deletion itself: the scheduled purge-pending-blobs job removes the
   * object of every row past its threshold with no reference check, so a
   * cancel that did not land must be tried again.
   */
  async clearPendingGC(uuids: string[]): Promise<boolean> {
    let ok = true;
    for (const chunk of gcChunks(uuids)) {
      const { error } = await this.supabase
        .from('pending_blob_gc')
        .delete()
        .eq('user_pubkey', this.pubkey)
        .in('uuid', chunk);
      if (error) {
        console.warn('[imageStore] pending_blob_gc clear failed:', error.message);
        ok = false;
      }
    }
    return ok;
  }

  /**
   * Cancel pending deletions, and answer which of them this call took: the
   * uuids whose row it deleted, or null when the request failed. A row it
   * did not find was taken by the purge (or by another device's cancel), and
   * after the purge its object is gone or going; the caller restores it.
   */
  async cancelPendingGC(uuids: string[]): Promise<Set<string> | null> {
    const taken = new Set<string>();
    for (const chunk of gcChunks(uuids)) {
      const { data, error } = await this.supabase
        .from('pending_blob_gc')
        .delete()
        .eq('user_pubkey', this.pubkey)
        .in('uuid', chunk)
        .select('uuid');
      if (error) {
        console.warn('[imageStore] pending_blob_gc cancel failed:', error.message);
        return null;
      }
      for (const r of (data ?? []) as { uuid: string }[]) taken.add(r.uuid);
    }
    return taken;
  }

  /** The uuids of this account's server-side pending-GC rows, or null when
   *  a read failed. Read in pages keyed on the uuid, because the server
   *  answers at most 1,000 rows, and a row past that is one the purge then
   *  deletes unchecked. */
  async listPendingGC(): Promise<string[] | null> {
    const PAGE = 1000;
    const out: string[] = [];
    let after = '';
    for (;;) {
      let query = this.supabase.from('pending_blob_gc').select('uuid').eq('user_pubkey', this.pubkey);
      if (after) query = query.gt('uuid', after);
      const { data, error } = await query.order('uuid').limit(PAGE);
      if (error) {
        console.warn('[imageStore] pending_blob_gc read failed:', error.message);
        return null;
      }
      const page = ((data ?? []) as Array<{ uuid: string }>).map((r) => r.uuid);
      out.push(...page);
      if (page.length < PAGE) return out;
      after = page[page.length - 1]!;
    }
  }

  /** A server recount of this account's usage, from Storage ground truth;
   *  answers whether it ran. */
  async recountQuota(): Promise<boolean> {
    if (this.ownershipLost()) return false;
    return recalculateQuota(this.supabase);
  }

  /**
   * Remove Storage objects only - no local row deletion, no quota
   * adjustment (deferDelete settled quota when it queued the uuid, and
   * sweepBlobGC drops any local rows it kept). Used by sweepBlobGC once
   * a queued uuid has cleared the grace period and the reference re-check.
   *
   * The Supabase JS client's storage.remove() reports one aggregate
   * error for the whole batch, not per-path, so on error we can't tell
   * which paths actually failed. Treat a "not found" style aggregate
   * error as success (the blobs are already gone, which is the desired
   * end state); treat any other error as every uuid failing, so the
   * sweep retries the whole batch next time.
   */
  async removeRemoteOnly(uuids: string[]): Promise<{ removed: string[]; failed: string[] }> {
    if (uuids.length === 0) return { removed: [], failed: [] };

    const paths = uuids.map((uuid) => `${this.pubkey}/${uuid}`);
    const { error } = await this.supabase.storage.from(BUCKET).remove(paths);

    if (!error) return { removed: uuids, failed: [] };

    if (error.message?.includes('not found') || error.message?.includes('404')) {
      return { removed: uuids, failed: [] };
    }

    recordStorageFault('file-delete', error);
    console.warn('[imageStore] sweepBlobGC remote removal failed:', error.message);
    return { removed: [], failed: uuids };
  }
}
