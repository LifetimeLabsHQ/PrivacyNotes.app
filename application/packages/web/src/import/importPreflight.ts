/**
 * Import preflight: loads the importer message catalog, runs the selected
 * importer's `parse`, samples contact photos to estimate their compressed cost,
 * and checks server storage quota + per-file attachment caps behind a
 * `QuotaPort` seam. Kept off the boot path (imported only from `ImportModal`).
 */

import type { SupabaseClient } from '@notes/shared';
import { perFileLimit } from '../attachmentValidation';
import { proUnlocked } from '../demo';
import { fetchQuotaUsage, recalculateQuota } from '../devices';
import { formatBytes } from '../formatBytes';
import i18n, { ensureImportLogLoaded } from '../i18n';
import { contactPhotoOptions, processImage } from '../imageProcessing';
import { isUnsyncedLocalVault } from '../localOnly';
import { estimateBlobBytes, estimateNoteStoredBytes } from '../notesViewUtils';
import type { ImportedNote, ImporterEntry, ParsedImport } from './types';

export interface QuotaCheck {
  estimatedBytes: number;
  availableBytes: number;
  exceeds: boolean;
}

/**
 * What an address book's photos will cost once the app sizes them down.
 * `bytes` is measured from a sample of the actual file, never taken from a
 * table: contact photo sizes vary by two orders of magnitude between an
 * OEM contacts app and an iPhone. `fits` is decided BEFORE anything is
 * written, so the contacts land and the photos are declined as one whole,
 * never half of them followed by a quota error.
 * Spec: docs/internal/specs/contacts-pillar.md (section 7.4)
 */
export interface PhotoEstimate {
  count: number;
  bytes: number;
  /** `null` when the quota could not be read (offline, demo, unsynced local vault). */
  available: number | null;
  fits: boolean;
}

export interface QuotaUsageSnapshot {
  maxTotalBytes: number;
  totalBytes: number;
  imageBytes: number;
}

export interface QuotaPort {
  /** Read fresh server storage usage, or return `null` when no server quota applies. */
  readUsage(): Promise<QuotaUsageSnapshot | null>;
  /** Optional override for counting only the notes and blob bytes a PrivacyNotes backup restore adds. */
  restoreAdds?(parsed: ParsedImport): Promise<{ notes: ImportedNote[]; blobBytes: number }>;
}

export interface PreparedImportPreview {
  parsed: ParsedImport;
  quotaCheck: QuotaCheck | null;
  photoEstimate: PhotoEstimate | null;
  importPhotos: boolean;
}

/** Live Supabase quota adapter: skips network calls for unsynced local vaults,
 *  and refreshes quota server-side (best-effort) before reading usage. */
export function createSupabaseQuotaPort(supabase: SupabaseClient, isPro: boolean): QuotaPort {
  return {
    async readUsage() {
      if (isUnsyncedLocalVault()) return null;
      await recalculateQuota(supabase).catch(() => {});
      return fetchQuotaUsage(supabase, isPro);
    },
  };
}

/** In-memory quota adapter for unit tests (returns a fixed snapshot, `null`, or throws an error). */
export function createMemoryQuotaPort(
  usage: QuotaUsageSnapshot | null | Error,
  restoreAdds?: QuotaPort['restoreAdds'],
): QuotaPort {
  return {
    async readUsage() {
      if (usage instanceof Error) throw usage;
      return usage;
    },
    ...(restoreAdds ? { restoreAdds } : {}),
  };
}

/** Per-note stored-bytes estimate via the shared server-cost estimator
 *  (UTF-8 measured, base64-expanded: estimating from UTF-16 length x1.4
 *  undercounts CJK imports by ~3x, so the "will not fit" gate would never
 *  fire for exactly the imports most likely to blow the quota). */
function estimateImportBytes(notes: readonly ImportedNote[]): number {
  let total = 0;
  for (const n of notes) {
    total += estimateNoteStoredBytes(n.title ?? '', n.body ?? '', n.tags ?? []);
  }
  return total;
}

/** How many photos the estimate compresses to find the median. */
const PHOTO_SAMPLE = 20;

async function sampleContactPhotos(
  parsed: ParsedImport,
): Promise<{ count: number; bytes: number } | null> {
  const photos = [...(parsed.blobs?.values() ?? [])].filter((b) => b.ceiling === 'contact');
  if (photos.length === 0) return null;
  const step = Math.max(1, Math.floor(photos.length / PHOTO_SAMPLE));
  const sizes: number[] = [];
  for (let i = 0; i < photos.length && sizes.length < PHOTO_SAMPLE; i += step) {
    const b = photos[i]!;
    const result = await processImage(
      new File([b.data as BlobPart], b.name, { type: b.mime }),
      contactPhotoOptions(),
    );
    sizes.push(result.ok ? result.image.sizeBytes : b.data.length);
  }
  sizes.sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  return { count: photos.length, bytes: estimateBlobBytes(median) * photos.length };
}

/**
 * Parse one file through an importer, sample contact photos, and run the
 * best-effort storage quota + per-file attachment limit preflight.
 */
export async function prepareImportPreview({
  importer,
  file,
  quota,
  isPro,
  onProgress,
}: {
  importer: Pick<ImporterEntry, 'parse'>;
  file: File;
  quota: QuotaPort;
  isPro: boolean;
  onProgress?: (status: string) => void;
}): Promise<PreparedImportPreview> {
  await ensureImportLogLoaded();
  const parsed = await importer.parse(file, onProgress);

  // Sample contact photos before reading quota so count and size still show when quota is unavailable.
  const photos = await sampleContactPhotos(parsed);
  let photoEstimate: PhotoEstimate | null = photos ? { ...photos, available: null, fits: true } : null;
  let importPhotos = true;
  let quotaCheck: QuotaCheck | null = null;
  let oversize = 0;
  let capLabel = '';

  try {
    const usage = await quota.readUsage();
    if (usage !== null) {
      const available = Math.max(
        0,
        usage.maxTotalBytes - usage.totalBytes - usage.imageBytes,
      );
      const photosFit = photos ? photos.bytes <= available : true;
      if (photos) {
        photoEstimate = { ...photos, available, fits: photosFit };
        importPhotos = photosFit;
      }

      let blobBytes = photos && photosFit ? photos.bytes : 0;
      if (parsed.blobs && parsed.blobs.size > 0) {
        for (const blob of parsed.blobs.values()) {
          if (blob.ceiling === 'contact') continue;
          blobBytes += estimateBlobBytes(blob.data.length);
        }
      } else {
        blobBytes = parsed.blobBytes ?? 0;
      }

      let countedNotes = parsed.notes;
      // Our own backup adds only what the vault lacks.
      if (parsed.source === 'privacynotes' && parsed.blobSizes) {
        const readAdds =
          quota.restoreAdds ??
          (async (p: ParsedImport) => (await import('./privacynotes')).restoreAdds(p));
        const adds = await readAdds(parsed);
        countedNotes = adds.notes;
        blobBytes = adds.blobBytes;
      }

      const estimatedBytes = estimateImportBytes(countedNotes) + blobBytes;
      quotaCheck = {
        estimatedBytes,
        availableBytes: available,
        exceeds: estimatedBytes > available,
      };

      const cap = perFileLimit(
        proUnlocked(isPro),
        usage.maxTotalBytes > 500 * 1000 * 1000,
      );
      for (const blob of parsed.blobs?.values() ?? []) {
        if (blob.ceiling === 'contact') continue;
        if (blob.data.length > cap) oversize++;
      }
      capLabel = formatBytes(cap);
    }
  } catch {
    quotaCheck = null;
  }

  return {
    parsed:
      oversize > 0
        ? {
            ...parsed,
            warnings: [
              ...parsed.warnings,
              i18n.t('importExport:preview.oversizeAttachments', {
                count: oversize,
                limit: capLabel,
              }),
            ],
          }
        : parsed,
    quotaCheck,
    photoEstimate,
    importPhotos,
  };
}
