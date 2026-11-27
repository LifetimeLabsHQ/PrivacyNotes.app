/**
 * Attachment store - upload, fetch, delete for encrypted file blobs.
 *
 * Local-first architecture:
 * - Upload: encrypt → cache in IndexedDB → return UUID instantly →
 *   background upload to Supabase Storage + quota adjustment.
 * - Fetch: check IndexedDB cache → fall back to Supabase download.
 * - On init: processPendingUploads() retries blobs that were cached
 *   locally but never made it to the server (app closed, network error).
 *
 * Blob format: [4-byte header length (LE)] [JSON header] [file bytes]
 * All of this is then encrypted as a single blob via encryptBlob().
 *
 * URI scheme: pn:file/<uuid> (vs pn:img/<uuid> for images)
 */

import { encryptBlob, decryptBlob } from '@notes/shared';
import { db } from './db';
import { openWithRing } from './keyRing';
import { isDemoMode } from './demo';
import { isUnsyncedLocalVault } from './localOnly';
import { recordSyncFault } from './syncFaults';
import { isServerWriteBlocked } from './syncPause';
import { uploadsHeldForWifi } from './wifiOnly';
import { claimRemoval, markIfPending } from './blobUploadRecovery';
import { PENDING_GC_WAIT_MS, settleWithin } from './pendingGcWait';
import { BlobStoreBase, UPLOAD_REFUSED, isBlobQuotaError, isPermanentUploadError } from './blobStoreBase';
import { BlobError } from './blobStore';
import { sha256Hex } from './sha256Hex';
import { BlobDamagedError } from './blobDamaged';
import { attachmentHeaderFits, isBoundBlobId, newBlobId } from './blobBind';

/** Metadata stored alongside the file, encrypted in the blob header. */
export interface AttachmentMeta {
  name: string;     // Original filename
  mime: string;     // MIME type
  size: number;     // Original file size in bytes
}

/** Decrypted attachment: metadata + raw file bytes. */
export interface DecryptedAttachment {
  meta: AttachmentMeta;
  data: Uint8Array;
}

/** Encode metadata + file data into a single Uint8Array for encryption. */
function packAttachment(meta: AttachmentMeta, data: Uint8Array): Uint8Array {
  const headerJson = JSON.stringify(meta);
  const headerBytes = new TextEncoder().encode(headerJson);
  const headerLen = headerBytes.length;

  const combined = new Uint8Array(4 + headerLen + data.length);
  combined[0] = headerLen & 0xff;
  combined[1] = (headerLen >> 8) & 0xff;
  combined[2] = (headerLen >> 16) & 0xff;
  combined[3] = (headerLen >> 24) & 0xff;
  combined.set(headerBytes, 4);
  combined.set(data, 4 + headerLen);

  return combined;
}

/** The header an object holds: the metadata, and its id when the id is a
 *  bound one. Spec: docs/internal/plans/payload-row-binding.md (section 6) */
function headerOf(meta: AttachmentMeta, uuid: string): AttachmentMeta & { id?: string } {
  const { name, mime, size } = meta;
  return isBoundBlobId(uuid) ? { name, mime, size, id: uuid.toLowerCase() } : { name, mime, size };
}

/** Unpack a decrypted blob into metadata + file data. */
function unpackAttachment(combined: Uint8Array): DecryptedAttachment {
  if (combined.length < 5) {
    throw new Error('Attachment blob too short');
  }

  const headerLen =
    combined[0]! |
    (combined[1]! << 8) |
    (combined[2]! << 16) |
    (combined[3]! << 24);

  if (headerLen < 2 || headerLen > 10000 || 4 + headerLen > combined.length) {
    throw new Error('Invalid attachment header length');
  }

  const headerBytes = combined.slice(4, 4 + headerLen);
  const headerJson = new TextDecoder().decode(headerBytes);
  const meta: AttachmentMeta = JSON.parse(headerJson);
  const data = combined.slice(4 + headerLen);

  return { meta, data };
}

export class AttachmentStore extends BlobStoreBase<DecryptedAttachment> {
  /** Called when a background upload fails permanently. UI should show a toast. */
  onBackgroundError?: (filename: string, error: string) => void;
  protected readonly logName = 'attachmentStore';
  protected readonly noun = 'Attachment';
  protected get dedup() {
    return db.attachmentDedup;
  }
  protected cached(uuid: string) {
    return db.attachmentCache.get(uuid);
  }
  /** An object holds the packed form, metadata header and bytes, not the
   *  cache row's bytes alone. */
  protected plaintextOf(cached: DecryptedAttachment, uuid: string): Uint8Array {
    return packAttachment(headerOf(cached.meta, uuid), cached.data);
  }
  protected retryUpload(uuid: string, cached: DecryptedAttachment, encrypted: Uint8Array): Promise<void> {
    return this._backgroundUpload(uuid, cached.meta.name, encrypted);
  }

  /**
   * Upload an attachment: pack + encrypt → cache locally → return UUID
   * immediately. Supabase upload + quota adjustment runs in background.
   */
  async uploadAttachment(file: File): Promise<{ uuid: string; meta: AttachmentMeta; uploaded: Promise<void> }> {
    const data = new Uint8Array(await file.arrayBuffer());

    // Content-hash dedup check.
    const hashHex = await sha256Hex(data);
    const existing = await db.attachmentDedup.get(hashHex);
    if (existing) {
      return {
        uuid: existing.uuid,
        meta: { name: file.name, mime: file.type || 'application/octet-stream', size: file.size },
        uploaded: Promise.resolve(),
      };
    }

    const meta: AttachmentMeta = {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
    };

    // The id first: a bound object carries it in its header (blobBind.ts).
    const uuid = newBlobId();
    const packed = packAttachment(headerOf(meta, uuid), data);
    // signOut can zero this.encryptionKey mid-upload. This is a
    // user-initiated path, not a background retry - throw rather than
    // silently encrypt with a dead key; callers already handle upload
    // errors.
    const passKey = this.keyCopy();
    if (!passKey) {
      throw new Error('Sign-out in progress');
    }
    const encrypted = encryptBlob(packed, passKey);
    passKey.fill(0);

    // --- Local-first: cache + dedup record, return immediately ---
    await db.attachmentCache.put({
      id: uuid,
      meta,
      data,
      cachedAt: new Date().toISOString(),
    });
    await db.attachmentDedup.put({
      hash: hashHex,
      uuid,
      encryptedSize: encrypted.length,
      pendingUpload: 1,
    });

    // --- Background: upload to Supabase + adjust quota ---
    const uploaded = this._backgroundUpload(uuid, meta.name, encrypted);

    return { uuid, meta, uploaded };
  }

  /**
   * Upload encrypted blob to Supabase and adjust quota.
   * On permanent failure: marks the row UPLOAD_REFUSED and keeps the
   * local cache, now the only copy, so restored attachments remain
   * viewable offline.
   * On transient failure: keeps pendingUpload for retry on next init.
   */
  private async _backgroundUpload(
    uuid: string,
    filename: string,
    encrypted: Uint8Array,
  ): Promise<void> {
    // Demo mode makes zero server calls - the blob lives only in the
    // throwaway local cache. Still do the bookkeeping the upload would
    // have done so the dedup row carries a real size for the Files view.
    if (isDemoMode()) {
      const cached = await db.attachmentDedup.where('uuid').equals(uuid).first();
      if (cached) {
        await db.attachmentDedup.update(cached.hash, { pendingUpload: 0, encryptedSize: encrypted.length });
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
    // post-sync retry hook can overlap with the initial upload from
    // uploadAttachment) - let the in-flight one own the pendingUpload
    // bookkeeping rather than racing it to the same Storage path.
    if (this.uploading.has(uuid)) {
      return;
    }
    this.uploading.add(uuid);
    try {
      // A removal claimed after this moment can be of the object a 409
      // below proves, so the settle compares against it.
      const attemptAt = Date.now();
      try {
        // Create-only, same as images: a taken name is an earlier attempt of
        // ours, settled by blobUploadRecovery.ts.
        await this.backend.put(uuid, encrypted);
      } catch (error) {
        if (!(error instanceof BlobError)) throw error;
        const msg = error.message;
        if (error.kind === 'exists') {
          await this._settleExistingObject(uuid, encrypted, attemptAt);
          return;
        }
        if (this.waitsForLater(error)) return;
        // By kind first, the message as before: the Worker's answers and
        // Storage's own text both reach the same branch.
        if (error.kind === 'too_large' || isPermanentUploadError(msg)) {
          // Keep local cache so restored attachments remain viewable offline,
          // and mark the row refused so the doomed upload is never retried.
          const dedup = await db.attachmentDedup.where('uuid').equals(uuid).first();
          if (dedup) {
            await db.attachmentDedup.update(dedup.hash, { pendingUpload: UPLOAD_REFUSED });
          }
          this.onBackgroundError?.(filename, msg);
          console.error('[attachmentStore] permanent upload failure, kept local cache:', uuid, msg);
          throw new Error(msg);
        }
        if (error.kind === 'quota' || isBlobQuotaError(msg)) {
          // Retryable - pendingUpload stays 1, but still toast the user now.
          // quotaBlocked keeps the retry sweep off the wire while the blob
          // cannot fit (backlog #143).
          await markIfPending(db.attachmentDedup, uuid, { quotaBlocked: 1 });
          this.onBackgroundError?.(filename, msg);
        }
        // Transient - leave pendingUpload=1 for retry on next init.
        console.warn('[attachmentStore] transient upload failure, will retry:', uuid, msg);
        throw new Error(msg);
      }

      if (this.ownershipLost()) return;
      const { error: rpcErr, status: rpcStatus } = await this.supabase.rpc('adjust_blob_bytes', {
        delta: encrypted.length,
      });
      if (rpcErr) {
        const msg = rpcErr.message || '';
        recordSyncFault({ step: 'file-up', status: rpcStatus, code: rpcErr.code || undefined, ref: uuid });
        if (isBlobQuotaError(msg)) {
          // Remove the remote blob we just uploaded (it must not sit in
          // Storage uncounted), but leave pendingUpload=1 so a later pass
          // retries the whole upload. quotaBlocked makes that later pass
          // wait for real headroom instead of re-uploading the full blob
          // just to land back here (backlog #143).
          if (await claimRemoval(db.attachmentDedup, uuid)) {
            await this.backend.remove([uuid]).catch(() => {});
          }
          await markIfPending(db.attachmentDedup, uuid, { quotaBlocked: 1 });
          this.onBackgroundError?.(filename, msg);
          console.error('[attachmentStore] quota exceeded, will retry:', uuid);
          throw new Error(msg);
        }
        if (isPermanentUploadError(msg)) {
          // Remove the remote blob we just uploaded; the local cache stays,
          // refused, as the only copy.
          if (await claimRemoval(db.attachmentDedup, uuid)) {
            await this.backend.remove([uuid]).catch(() => {});
          }
          await markIfPending(db.attachmentDedup, uuid, { pendingUpload: UPLOAD_REFUSED });
          this.onBackgroundError?.(filename, msg);
          console.error('[attachmentStore] permanent upload failure, kept local cache:', uuid, msg);
          throw new Error(msg);
        }
        // Transient failure: same contract as imageStore - the object is in
        // Storage but uncounted, so keep pendingUpload=1 for the retry sweep
        // instead of silently understating usage (backlog #131). That sweep
        // meets a 409 and settles the accounting with a server recount.
        console.warn('[attachmentStore] adjust_blob_bytes failed, will retry:', msg);
        throw new Error(msg);
      }

      // Clear pending flag and update encryptedSize (may have been 0 from
      // restoreBlobs - now we know the real size after encrypting).
      const dedup = await db.attachmentDedup.where('uuid').equals(uuid).first();
      if (dedup) {
        await db.attachmentDedup.update(dedup.hash, { pendingUpload: 0, quotaBlocked: 0, encryptedSize: encrypted.length });
      }
    } finally {
      this.uploading.delete(uuid);
    }
  }




  /**
   * Get a decrypted attachment by UUID. Checks cache first.
   */
  async getAttachment(uuid: string): Promise<DecryptedAttachment | null> {
    // Check cache.
    const cached = await db.attachmentCache.get(uuid);
    if (cached) {
      return { meta: cached.meta, data: cached.data };
    }
    if (isUnsyncedLocalVault()) return null;

    // Download from the store, with one retry on auth errors.
    const result = await this._downloadWithRetry(uuid);
    if (!result) return null;

    const encrypted = new Uint8Array(await result.arrayBuffer());
    // Bytes that do not open, or open to no readable header, are told apart
    // from a failed request; nothing is cached or deleted. See blobDamaged.ts.
    let attachment: DecryptedAttachment;
    try {
      attachment = unpackAttachment(openWithRing('sync', this.encryptionKey, (key) => decryptBlob(encrypted, key)));
    } catch {
      throw new BlobDamagedError(uuid);
    }
    // A header written for another object is not this file: damaged, the
    // same way. The cache keeps the header without its id.
    const { id: _id, ...meta } = attachment.meta as AttachmentMeta & { id?: unknown };
    if (!attachmentHeaderFits(uuid, attachment.meta as { id?: unknown })) throw new BlobDamagedError(uuid);
    attachment = { meta, data: attachment.data };

    // Cache for next time.
    await db.attachmentCache.put({
      id: uuid,
      meta: attachment.meta,
      data: attachment.data,
      cachedAt: new Date().toISOString(),
    });

    return attachment;
  }


  /**
   * Defer deletion of multiple attachments: remove local cache + dedup
   * rows immediately, but leave the Supabase Storage object in place (it
   * counts toward the quota until it leaves Storage). The uuid is
   * enqueued in db.blobGC so sweepBlobGC (imageGC.ts) can remove the remote object later, once
   * a clean sync pull has proven the local mirror is complete enough
   * to trust the reference re-check. See imageGC.ts for the full
   * two-phase design.
   *
   * A file whose upload is still pending, or was refused for good, keeps
   * its bytes and dedup row and is queued at size 0, for the reasons
   * ImageStore.deferDelete gives.
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
      const dedup = await db.attachmentDedup.where('uuid').equals(uuid).first();
      if (dedup?.pendingUpload === 1 || dedup?.pendingUpload === UPLOAD_REFUSED) {
        await db.blobGC.put({ uuid, kind: 'attachment', size: 0, enqueuedAt: now });
        continue;
      }
      const size = dedup?.encryptedSize ?? 0;
      totalSize += size;

      await db.attachmentCache.delete(uuid);
      await db.attachmentDedup.where('uuid').equals(uuid).delete();
      await db.blobGC.put({ uuid, kind: 'attachment', size, enqueuedAt: now });
    }

    // Below the release floor server writes pause (see sync.ts). The local
    // blobGC queue above survives, so the (also floor-gated) sweep deletes
    // the objects and settles quota once the user updates.
    if (isServerWriteBlocked()) return;

    // Server-side pending set (migration 0068) - same contract as
    // ImageStore.deferDelete, awaited for the same reason; see the comment
    // there.
    // Spec: packages/supabase/migrations/history/0068_pending_blob_gc_server_side.sql
    await settleWithin(
      Promise.resolve(
        this.supabase
          .from('pending_blob_gc')
          .upsert(
            uuids.map((uuid) => ({ user_pubkey: this.pubkey, uuid })),
            { onConflict: 'user_pubkey,uuid', ignoreDuplicates: true }
          )
      ).then(({ error: gcErr }) => {
        if (gcErr) console.warn('[attachmentStore] pending_blob_gc enqueue failed:', gcErr.message);
      }),
      PENDING_GC_WAIT_MS,
    );

    // Report the delete (best-effort). A server with migration 0136 counts
    // files itself and ignores a negative report: the blob counts until the
    // sweep removes it from Storage. An older server decrements here.
    if (!this.ownershipLost() && totalSize > 0) {
      this.supabase
        .rpc('adjust_blob_bytes', { delta: -totalSize })
        .then(({ error: rpcErr }) => {
          if (rpcErr) console.warn('[attachmentStore] adjust_blob_bytes failed:', rpcErr.message);
        });
    }
  }

  /**
   * Remove Storage objects only - no local row deletion and no quota
   * report (the server takes a file's bytes off when its object goes, and
   * sweepBlobGC drops any local rows it kept). Used by sweepBlobGC once
   * a queued uuid has cleared the grace period and the reference re-check.
   * The store answers for the batch as a whole (blobStore.ts), so a failure
   * fails every uuid and the sweep retries the whole batch next time.
   */
  removeRemoteOnly(uuids: string[]): Promise<{ removed: string[]; failed: string[] }> {
    return this.backend.remove(uuids);
  }
}
