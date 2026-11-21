/**
 * What ImageStore and AttachmentStore share: the account and key they hold,
 * the in-flight guards, the download with its one session retry, the settle
 * of an object an earlier attempt stored (blobUploadRecovery.ts), and the
 * retry sweep of pending uploads. Each store supplies its own tables, the
 * plaintext an object holds, and its upload.
 */

import { decryptBlob, encryptBlob, type SupabaseClient } from '@notes/shared';
import { db } from './db';
import { currentKeyEpoch, isRingKey, openWithRingAt } from './keyRing';
import { isDemoMode } from './demo';
import { ownsLocalData } from './authStorage';
import { logAuthEvent } from './authDiag';
import { isServerWriteBlocked } from './syncPause';
import { uploadsHeldForWifi } from './wifiOnly';
import { fetchQuotaUsage, recalculateQuota } from './devices';
import { markIfPending, sameBytes, settleUnlessClaimed } from './blobUploadRecovery';
import { BlobError, blobBackend, uploadsHeldUntil, type BlobBackend } from './blobStore';

export { isBlobQuotaError, isPermanentUploadError } from './blobStore';

/**
 * pendingUpload value for a blob the server refused for good. The retry
 * sweep and every pending count look for 1, so the row is never retried
 * or shown as waiting. The local cache still holds the only copy, and the
 * row's encryptedSize was never charged, so deferDelete keeps it the way
 * it keeps a pending blob.
 */
export const UPLOAD_REFUSED = 2;

/** The dedup rows of both stores have this one shape (db.ts). */
type DedupTable = typeof db.imageDedup;

export abstract class BlobStoreBase<Cached extends { data: Uint8Array }> {
  protected supabase: SupabaseClient;
  /** The object store. Every read, write and removal of an object goes
   *  through it; `supabase` is for the account's tables and functions. */
  protected backend: BlobBackend;
  protected encryptionKey: Uint8Array;
  protected pubkey: string;
  /**
   * UUIDs with an upload or a settle in flight in this instance. The
   * post-sync retry sweep can reach a uuid whose first background upload is
   * still running and whose dedup row still says pendingUpload === 1; both
   * would send the same create-only upload, and the second would answer 409
   * and settle an object whose first upload has not finished its own
   * bookkeeping. The in-flight call owns the row, so a second caller for the
   * same uuid returns.
   */
  protected uploading = new Set<string>();
  /**
   * True while a processPendingUploads() sweep is running. The post-sync
   * retry hook fires on a timer, and a sweep can still be walking the pending
   * rows from the trigger before; a second sweep would only meet the guard
   * above row by row.
   */
  private sweepRunning = false;
  /** UUIDs whose object this instance already asked Storage about during a
   *  sweep, so a row that does not fit costs one probe per app start. */
  private probed = new Set<string>();
  private ownershipLogged = false;

  /** Called when the day's upload limit holds this account's new uploads,
   *  with the time the hold ends. The UI says so in one line. */
  onUploadsHeld?: (until: number) => void;

  /** The store's name in logs: `imageStore` or `attachmentStore`. */
  protected abstract readonly logName: string;
  /** The word that starts a download error: `Image` or `Attachment`. */
  protected abstract readonly noun: string;
  protected abstract readonly dedup: DedupTable;
  /** The cached row for a uuid. */
  protected abstract cached(uuid: string): Promise<Cached | undefined>;
  /** The plaintext an object holds for a cached row: what the upload encrypts. */
  /** The bytes an object holds for a cache row, with its row binding when
   *  `uuid` is a bound id (blobBind.ts). */
  protected abstract plaintextOf(cached: Cached, uuid: string): Uint8Array;
  /** Upload a pending row again, from its cached row and a fresh encryption. */
  protected abstract retryUpload(uuid: string, cached: Cached, encrypted: Uint8Array): Promise<void>;

  constructor(
    supabase: SupabaseClient,
    encryptionKey: Uint8Array,
    pubkey: string,
  ) {
    this.supabase = supabase;
    this.backend = blobBackend(supabase, pubkey);
    this.encryptionKey = encryptionKey;
    this.pubkey = pubkey;
  }

  /**
   * True when this browser's local storage no longer belongs to this
   * store's account. An account switch rebuilds the stores, but an
   * instance captured by an in-flight upload or a scheduled sweep
   * survives it holding the OLD pubkey beside a client whose JWT is
   * already the NEW account's. Storage RLS refuses its uploads, but
   * adjust_blob_bytes derives its target from the JWT alone, so a stale
   * instance would silently move the NEW account's quota. Every server
   * write checks this and skips; local rows need no care, the switch
   * wipe owns them.
   */
  protected ownershipLost(): boolean {
    if (ownsLocalData(this.pubkey)) return false;
    if (!this.ownershipLogged) {
      this.ownershipLogged = true;
      logAuthEvent(`${this.logName}:ownership-lost`, { expectedPk: this.pubkey.slice(0, 8) });
    }
    return true;
  }

  /**
   * Private copy of the key for one encrypt operation. signOut zeroes
   * `this.encryptionKey` in place (the shared buffer passed into the
   * constructor), so a copy that comes back all-zero means sign-out is
   * already in progress - callers must bail rather than encrypt with a
   * dead key. Same pattern as sync.ts.
   */
  protected keyCopy(): Uint8Array | null {
    const copy = new Uint8Array(this.encryptionKey);
    if (copy.every((b) => b === 0)) return null;
    return copy;
  }

  /**
   * An earlier attempt at this uuid already committed. Prove the object is
   * ours and our content, settle the byte accounting with a server recount,
   * and only then clear the pending flag.
   *
   * Every way out that is not a proven match leaves the row pending and the
   * local cache intact, so the blob stays viewable and nothing is charged or
   * overwritten. A plaintext mismatch is the one case that stops retrying:
   * the name is already taken by bytes that are not ours, no write of ours
   * can ever land there, and the local copy becomes the only copy - the same
   * standing as a blob the server refused on size.
   *
   * An object that is ours but sealed under a key of an earlier phrase is
   * written again under the current key before the row is cleared
   * (_rewriteUnderCurrentKey), and stays pending while that write fails.
   */
  protected async _settleExistingObject(uuid: string, encrypted: Uint8Array | null, attemptAt: number): Promise<void> {
    const cached = await this.cached(uuid);
    const remote = await this._downloadWithRetry(uuid);
    if (!remote) {
      // The object answered 409 and will not download. Nothing is proven, so
      // nothing is cleared; the next sweep asks again.
      console.warn(`[${this.logName}] existing blob could not be read back:`, uuid);
      return;
    }
    const remoteBytes = new Uint8Array(await remote.arrayBuffer());
    // A probe has no ciphertext of its own to compare, only the plaintext.
    let matches = encrypted !== null && sameBytes(remoteBytes, encrypted);
    // Ours, and opened by a key of an earlier phrase instead of the current one.
    let underEarlierKey = false;
    if (!matches && cached) {
      // The retry re-encrypted with a fresh nonce, so identical plaintext
      // produces different ciphertext. Compare what the bytes mean (for a
      // file, the packed header and bytes the upload sent), through a key
      // COPY like every other crypto call in this class: sign-out zeroes the
      // live key in place, and decrypting with zeros would call a blob that
      // is perfectly fine on the server a mismatch and refuse it for good.
      const passKey = this.keyCopy();
      if (!passKey) {
        console.warn(`[${this.logName}] sign-out in progress - blob settle deferred:`, uuid);
        return;
      }
      try {
        const opened = openWithRingAt('sync', passKey, (key) => decryptBlob(remoteBytes, key));
        matches = sameBytes(opened.value, this.plaintextOf(cached, uuid));
        // A store that still holds an earlier phrase's key reads its own
        // epoch as the current one, so its key is asked too.
        underEarlierKey = matches && (opened.epoch !== currentKeyEpoch() || isRingKey('sync', passKey));
      } catch {
        matches = false;
      } finally {
        passKey.fill(0);
      }
    }
    if (!matches) {
      // The download and the decrypt were awaits: an account switch inside
      // them would mark the next account's row.
      if (this.ownershipLost()) return;
      const dedup = await this.dedup.where('uuid').equals(uuid).first();
      if (dedup) await this.dedup.update(dedup.hash, { pendingUpload: UPLOAD_REFUSED });
      console.error(`[${this.logName}] blob name holds different content, kept local cache:`, uuid);
      return;
    }
    if (underEarlierKey && cached && !await this._rewriteUnderCurrentKey(uuid, cached)) {
      // The probe of a row with no headroom asks once per instance. This one
      // found the object and could not finish, so it must ask again.
      this.probed.delete(uuid);
      return;
    }
    // The object is right. Whether its bytes were ever counted is unknown, so
    // ask the server to recount rather than posting the same delta a second
    // time. A recount that did not run leaves the row pending.
    if (!await recalculateQuota(this.supabase)) {
      console.warn(`[${this.logName}] recovered blob not cleared - no server recount:`, uuid);
      return;
    }
    // Two awaits have passed since the ownership check at the top of the
    // upload, and an account switch inside that window would write this
    // account's hash-to-uuid row into the next account's database.
    if (this.ownershipLost()) return;
    // A removal claimed meanwhile by the instance that uploaded the object
    // leaves the row pending, and the next pass uploads again.
    if (!await settleUnlessClaimed(this.dedup, uuid, attemptAt, { pendingUpload: 0, quotaBlocked: 0, encryptedSize: remoteBytes.length })) {
      console.warn(`[${this.logName}] recovered blob not cleared - its uploader is removing it:`, uuid);
    }
  }

  /**
   * The stored object is ours and sealed under a key of an earlier phrase:
   * an attempt stored it before the phrase changed and lost its answer. The
   * phrase change pass rewrites a file a ring key opens (reencryptPass.ts),
   * but it can have finished before the object was on any listing, and it
   * never looks again. So the settle writes the object under the current
   * key itself: the same name and the same size, the cached plaintext
   * sealed now with the key this method checked. Never the ciphertext the
   * attempt brought: nothing here proves which key sealed that.
   * Two rewrites of one object, this one and the pass's, leave the bytes of
   * whichever landed last, both under the current key.
   *
   * False when nothing was written (a sign-out in progress, a store that
   * holds an earlier phrase's key, a refused or failed write): the caller
   * leaves the row pending, and the next sweep comes back here.
   * Spec: docs/internal/plans/phrase-change.md (6.4)
   */
  private async _rewriteUnderCurrentKey(uuid: string, cached: Cached): Promise<boolean> {
    if (this.ownershipLost()) return false;
    const passKey = this.keyCopy();
    if (!passKey) {
      console.warn(`[${this.logName}] sign-out in progress - blob rewrite deferred:`, uuid);
      return false;
    }
    let sealed: Uint8Array;
    try {
      if (isRingKey('sync', passKey)) return false;
      sealed = encryptBlob(this.plaintextOf(cached, uuid), passKey);
    } finally {
      passKey.fill(0);
    }
    try {
      await this.backend.overwrite(uuid, sealed);
      return true;
    } catch (err) {
      if (!(err instanceof BlobError)) throw err;
      console.warn(`[${this.logName}] blob under an earlier key not rewritten, will retry:`, uuid, err.message);
      return false;
    }
  }

  /**
   * A put the store must not count as failed: the day's upload limit
   * (`upload_limit`, held by the adapter until the limit ends) or the
   * Worker's rate limit after its waits (`rate_limited`). The row stays
   * pending for a later pass, and the caller returns without a throw, so
   * nothing that waits for the upload takes it for lost. The line about the
   * hold is said on the Worker's own answer, not on a put the hold refused
   * without a request.
   */
  protected waitsForLater(error: BlobError): boolean {
    if (error.kind === 'upload_limit') {
      const until = uploadsHeldUntil(this.pubkey);
      if (error.status !== undefined && until !== null) this.onUploadsHeld?.(until);
      console.warn(`[${this.logName}] upload held for the day's upload limit`);
      return true;
    }
    if (error.kind === 'rate_limited') {
      console.warn(`[${this.logName}] upload rate limited, will retry`);
      return true;
    }
    return false;
  }

  /**
   * Settle an object an earlier attempt stored, without uploading again.
   * True when the object is there, or when Storage did not answer, so the
   * caller leaves the row unmarked and the next sweep asks again; false only
   * when Storage says the object is not there.
   */
  private async _settleIfStored(uuid: string): Promise<boolean> {
    if (this.uploading.has(uuid)) return true;
    this.uploading.add(uuid);
    try {
      const attemptAt = Date.now();
      const stored = await this.backend.exists(uuid);
      if (stored === null) return true;
      this.probed.add(uuid);
      if (!stored) return false;
      if (this.ownershipLost()) return true;
      await this._settleExistingObject(uuid, null, attemptAt);
      return true;
    } finally {
      this.uploading.delete(uuid);
    }
  }

  /**
   * Retry uploads that were cached locally but never made it to the server.
   * Called once on store init. Re-encrypts from cached data (the nonce is
   * random per call; the server does not care about the ciphertext).
   */
  async processPendingUploads(): Promise<void> {
    // Blocked or held: pending rows survive and upload once the block lifts.
    // The day's upload limit holds them too, so no sweep asks before it ends.
    if (isDemoMode() || isServerWriteBlocked() || uploadsHeldForWifi() || uploadsHeldUntil(this.pubkey) !== null) return;
    if (this.ownershipLost()) return;
    // Single-flight: the post-sync retry hook can fire again before a
    // previous sweep has finished walking the pending rows. Let the
    // running sweep own the pass rather than starting a second one that
    // would just re-race the uploading guard below.
    if (this.sweepRunning) return;
    this.sweepRunning = true;
    try {
      const pending = await this.dedup
        .filter((r) => r.pendingUpload === 1)
        .toArray();

      // Quota preflight: a blob bigger than the free headroom can only be
      // re-uploaded, fail the accounting RPC and be deleted server-side -
      // a 45 MB blob was re-uploaded every boot and every retry tick that
      // way (backlog #143). One quota read gates the whole pass; rows that
      // cannot fit are marked quotaBlocked and cost zero wire traffic.
      // isPro=true only shapes the fallback ceiling when every quota RPC
      // fails - it must never underestimate a Pro cap into false blocks.
      let freeBytes: number | null = null;
      if (pending.length > 0) {
        try {
          const q = await fetchQuotaUsage(this.supabase, true);
          freeBytes = Math.max(0, q.maxTotalBytes - q.totalBytes - q.imageBytes);
        } catch {
          freeBytes = null; // unknown - behave like before the preflight
        }
      }

      // One key copy for the whole retry pass. If signOut zeroes
      // this.encryptionKey before we can take this copy, bail entirely -
      // rows keep pendingUpload=1 for the next authenticated pass to retry.
      const passKey = this.keyCopy();
      if (!passKey) {
        console.warn(`[${this.logName}] sign-out in progress - pending uploads deferred`);
        return;
      }
      try {
        for (const record of pending) {
          // The day's upload limit met mid-sweep holds every row left.
          if (uploadsHeldUntil(this.pubkey) !== null) break;
          try {
            // Already being uploaded by another in-flight call (e.g. the
            // initial upload) - skip the pointless re-encrypt.
            if (this.uploading.has(record.uuid)) continue;

            const cached = await this.cached(record.uuid);
            if (!cached) {
              // Cache lost - remove orphan dedup record.
              await this.dedup.delete(record.hash);
              continue;
            }

            if (freeBytes !== null) {
              if (cached.data.length > freeBytes) {
                // Headroom is a question for a new upload. An earlier attempt
                // can have stored this object and lost only its answer, so
                // each row asks Storage once per store instance and settles
                // what is there. Once per instance rather than once ever, so
                // a wrong "not there" heals on the next start.
                if (!this.probed.has(record.uuid) && await this._settleIfStored(record.uuid)) continue;
                if (record.quotaBlocked !== 1) {
                  await markIfPending(this.dedup, record.uuid, { quotaBlocked: 1 });
                }
                continue;
              }
              if (record.quotaBlocked === 1) {
                await this.dedup.update(record.hash, { quotaBlocked: 0 });
              }
              // Reserve the headroom for this attempt so one pass cannot
              // overshoot the cap with several large blobs.
              freeBytes -= cached.data.length;
            }

            const encrypted = encryptBlob(this.plaintextOf(cached, record.uuid), passKey);
            await this.retryUpload(record.uuid, cached, encrypted);
          } catch (err) {
            console.warn(`[${this.logName}] pending retry failed:`, record.uuid, err);
          }
        }
      } finally {
        passKey.fill(0);
      }
    } finally {
      this.sweepRunning = false;
    }
  }

  /**
   * Download a blob from the store, which refreshes the session once when
   * the store answers an expired one (blobStore.ts). Returns null only when
   * the object genuinely doesn't exist.
   */
  protected async _downloadWithRetry(uuid: string): Promise<Blob | null> {
    try {
      return await this.backend.get(uuid);
    } catch (err) {
      if (err instanceof BlobError) throw new Error(`${this.noun} download failed: ${err.message}`);
      throw err;
    }
  }
}
