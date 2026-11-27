/**
 * Local vault storage breakdown - what the user actually keeps on this device,
 * summed across every Space, Archive, hidden section and Trash.
 *
 * The server's `pubkey_quotas` row stays the strict anti-abuse guard (migration
 * 0136: Base64 ciphertext overhead, 24h delete queue, and Note History blobs).
 * This module produces the user-facing figure: plain item text + deduplicated
 * file/image bytes, so deletes drop the meter immediately and every row in
 * Settings > Storage > Usage adds up to the ring to the byte.
 */

import type { NoteType } from '@notes/shared';
import type { LocalNote } from './db';
import { extractAttachmentIds, IMAGE_REF_RE } from './mediaRefs';
import { unescapeMarkdownText } from './fileNames';
import { parseSizeToBytes } from './formatBytes';
import { contactPhotoBytes } from './contactBody';
import { noteFileLinks } from './vaultBody';

type VaultItemLocation = 'active' | 'archive' | 'trash';

const STRUCTURED_TYPES: ReadonlySet<string> = new Set([
  'drawing',
  'contact',
  'login',
  'card',
  'ssh-key',
  'link',
]);

export interface VaultStorageItem {
  /** Stable list key: blob uuid for files/images, `note:<id>` for text notes. */
  key: string;
  kind: 'image' | 'file' | 'note';
  /** Owning note type (lets UI label drawings, contacts, vault items cleanly). */
  noteType?: NoteType;
  /** Display name (guarded notes show only the safe gated title, never file names). */
  title: string;
  /** Parent note id to open on click. */
  noteId: string;
  /** Parent note title for context on embedded files/images. */
  noteTitle: string;
  /** MIME type for files/images, empty for notes. */
  mime: string;
  /** Plain byte size counted toward the vault total. */
  bytes: number;
  /** Character count for plain note rows (0 for files, images, structured or gated notes). */
  chars: number;
  location: VaultItemLocation;
  /** Space name when Spaces are enabled and the item belongs to a named space. */
  spaceLabel: string | null;
  /** True when the owning note is currently behind the PIN gate. */
  gated: boolean;
}

export interface VaultStorageBreakdown {
  /** Files and images referenced by live or archived notes (deduplicated by uuid). */
  filesBytes: number;
  filesCount: number;
  archivedFilesCount: number;
  /** Live and archived note/item text (UTF-8 bytes). */
  notesBytes: number;
  notesCount: number;
  /** Trashed notes plus blobs referenced ONLY by trashed notes. */
  trashBytes: number;
  trashCount: number;
  /** Exact sum: filesBytes + notesBytes + trashBytes. */
  totalBytes: number;
  /** Top items sorted largest first across all open Spaces, Archive and Trash. */
  largest: VaultStorageItem[];
}

const utf8Encoder = new TextEncoder();

/** Plain UTF-8 byte length of a string. */
function utf8Bytes(text: string): number {
  if (!text) return 0;
  return utf8Encoder.encode(text).byteLength;
}

/** Plain UTF-8 size of a note's own content (title, body, tags). */
function notePlainBytes(note: LocalNote): number {
  let bytes = utf8Bytes(note.title) + utf8Bytes(note.body);
  if (note.tags && note.tags.length > 0) {
    for (const tag of note.tags) bytes += utf8Bytes(tag);
  }
  return bytes;
}

/**
 * Collect every unique blob uuid (`pn:img/<uuid>` and `pn:file/<uuid>`) across
 * all non-deleted notes so size resolution covers images, standalone files, and
 * "Picture from Files" (`![alt](pn:file/<uuid>)`) alike.
 */
export function collectAllBlobUuids(notes: readonly LocalNote[]): {
  imageUuids: string[];
  fileUuids: string[];
  /** `pn:file/<uuid>` refs that carry no markdown size string (e.g. Picture from Files). */
  unsizedFileUuids: string[];
} {
  const imageSet = new Set<string>();
  const fileSet = new Set<string>();
  const sizedFileSet = new Set<string>();
  for (const note of notes) {
    if (note.deleted === 1 || !note.body) continue;
    const isStructured = STRUCTURED_TYPES.has(note.type ?? '');
    let m: RegExpExecArray | null;
    IMAGE_REF_RE.lastIndex = 0;
    while ((m = IMAGE_REF_RE.exec(note.body)) !== null) {
      if (m[1]) imageSet.add(m[1]);
    }
    for (const link of noteFileLinks(note)) {
      fileSet.add(link.uuid);
      if (parseSizeToBytes(link.size) > 0) sizedFileSet.add(link.uuid);
    }
    if (!isStructured) {
      for (const id of extractAttachmentIds(note.body)) {
        fileSet.add(id);
      }
    }
  }
  const unsizedFileUuids = [...fileSet].filter((id) => !sizedFileSet.has(id));
  return { imageUuids: [...imageSet], fileUuids: [...fileSet], unsizedFileUuids };
}

interface BlobRecord {
  uuid: string;
  kind: 'image' | 'file';
  noteType?: NoteType;
  title: string;
  mime: string;
  bytes: number;
  noteId: string;
  noteTitle: string;
  location: VaultItemLocation;
  spaceLabel: string | null;
  gated: boolean;
  /** True while every reference seen so far belongs to a section-locked (shut) item. */
  absent: boolean;
}

const LOCATION_PRIORITY: Record<VaultItemLocation, number> = {
  active: 0,
  archive: 1,
  trash: 2,
};

/** Whether candidate reference should replace `existing` as the display owner. */
function isBetterBlobOwner(
  existing: BlobRecord,
  cand: { location: VaultItemLocation; absent: boolean; gated: boolean },
): boolean {
  const locDiff = LOCATION_PRIORITY[cand.location] - LOCATION_PRIORITY[existing.location];
  if (locDiff !== 0) return locDiff < 0;
  // On equal location: visible beats shut-section, and unlocked beats PIN-gated.
  if (existing.absent !== cand.absent) return !cand.absent;
  if (existing.gated !== cand.gated) return !cand.gated;
  return false;
}

/**
 * Compute the user-facing storage breakdown from all local non-deleted notes
 * and known blob sizes. Every unique file blob is counted once: live and
 * archived notes win over Trash when a blob is shared across both.
 *
 * Items in shut (section-locked) views still count toward the totals so the
 * storage ring stays honest, but are omitted from `largest` ("absent, not
 * gated" per section-lock.md).
 */
export function computeVaultStorage(
  allNotes: readonly LocalNote[],
  blobSizes: ReadonlyMap<string, number>,
  options: {
    gatedNoteIds?: ReadonlySet<string>;
    isAbsent?: (note: LocalNote) => boolean;
    spaceLabelOf?: (note: LocalNote) => string | null;
    titleOf?: (note: LocalNote, gated: boolean) => string;
    largestLimit?: number;
  } = {},
): VaultStorageBreakdown {
  const gated = options.gatedNoteIds ?? new Set<string>();
  const isAbsent = options.isAbsent ?? (() => false);
  const spaceLabelOf = options.spaceLabelOf ?? (() => null);
  const titleOf = options.titleOf ?? ((n: LocalNote) => n.title?.trim() || 'Untitled');
  const largestLimit = options.largestLimit ?? 12;

  let notesBytes = 0;
  let notesCount = 0;
  let trashBytes = 0;
  let trashCount = 0;

  const blobs = new Map<string, BlobRecord>();
  const noteItems: VaultStorageItem[] = [];

  for (const note of allNotes) {
    if (note.deleted === 1) continue;
    const location: VaultItemLocation =
      note.trashed === 1 ? 'trash' : note.archived === 1 ? 'archive' : 'active';
    const absent = isAbsent(note);
    const isGated = absent || gated.has(note.id);
    const noteTitle = titleOf(note, isGated);
    const spaceLabel = absent ? null : spaceLabelOf(note);
    const textBytes = notePlainBytes(note);

    if (location === 'trash') {
      trashBytes += textBytes;
      trashCount += 1;
    } else {
      notesBytes += textBytes;
      notesCount += 1;
    }

    // Standalone file items (`type === 'file'`) are represented by their file
    // row below rather than duplicating a tiny ~60 B wrapper note row.
    const isStructured = STRUCTURED_TYPES.has(note.type ?? '');
    if (textBytes > 0 && !absent && note.type !== 'file') {
      noteItems.push({
        key: `note:${note.id}`,
        kind: 'note',
        noteType: note.type,
        title: noteTitle,
        noteId: note.id,
        noteTitle,
        mime: '',
        bytes: textBytes,
        chars: isGated || isStructured ? 0 : (note.body?.length ?? 0),
        location,
        spaceLabel,
        gated: isGated,
      });
    }

    if (!note.body) continue;

    // 1. Embedded images (`pn:img/<uuid>`) - includes contact photos when stored as pn:img/.
    let m: RegExpExecArray | null;
    let imgIdx = 0;
    IMAGE_REF_RE.lastIndex = 0;
    while ((m = IMAGE_REF_RE.exec(note.body)) !== null) {
      const uuid = m[1];
      if (!uuid) continue;
      imgIdx++;
      const fallbackContact = note.type === 'contact' ? contactPhotoBytes(note.body) : 0;
      const bytes = blobSizes.get(uuid) ?? fallbackContact;
      const title = isGated
        ? noteTitle
        : imgIdx === 1
          ? `Image, ${noteTitle}`
          : `Image ${imgIdx}, ${noteTitle}`;
      const existing = blobs.get(uuid);
      if (!existing) {
        blobs.set(uuid, {
          uuid,
          kind: 'image',
          noteType: note.type,
          title,
          mime: isGated ? '' : 'image/*',
          bytes,
          noteId: note.id,
          noteTitle,
          location,
          spaceLabel,
          gated: isGated,
          absent,
        });
      } else {
        if (bytes > existing.bytes) existing.bytes = bytes;
        if (isBetterBlobOwner(existing, { location, absent, gated: isGated })) {
          existing.location = location;
          existing.noteId = note.id;
          existing.noteType = note.type;
          existing.noteTitle = noteTitle;
          existing.title = title;
          existing.mime = isGated ? '' : 'image/*';
          existing.spaceLabel = spaceLabel;
          existing.gated = isGated;
          existing.absent = absent;
        }
      }
    }

    // 2. File attachments - uses `noteFileLinks` so JSON vault items (`login`,
    //    `card`, `ssh-key`) read their `files` array and never regex-scan passwords.
    const links = noteFileLinks(note);
    const seenFileUuids = new Set<string>();
    const soleFile = note.type === 'file' && links.length === 1 && imgIdx === 0 && !!note.title;
    for (const link of links) {
      const uuid = link.uuid;
      seenFileUuids.add(uuid);
      const parsedSize = parseSizeToBytes(link.size);
      const bytes = blobSizes.get(uuid) || parsedSize;
      const cleanName = unescapeMarkdownText(link.name) || 'Attachment';
      const title = isGated ? noteTitle : soleFile ? noteTitle : cleanName;
      const mime = isGated ? '' : (link.mime || 'application/octet-stream');
      const existing = blobs.get(uuid);
      if (!existing) {
        blobs.set(uuid, {
          uuid,
          kind: 'file',
          noteType: note.type,
          title,
          mime,
          bytes,
          noteId: note.id,
          noteTitle,
          location,
          spaceLabel,
          gated: isGated,
          absent,
        });
      } else {
        if (bytes > existing.bytes) existing.bytes = bytes;
        if (isBetterBlobOwner(existing, { location, absent, gated: isGated })) {
          existing.kind = 'file';
          existing.location = location;
          existing.noteId = note.id;
          existing.noteType = note.type;
          existing.noteTitle = noteTitle;
          existing.title = title;
          existing.mime = mime;
          existing.spaceLabel = spaceLabel;
          existing.gated = isGated;
          existing.absent = absent;
        }
      }
    }

    // 3. Pictures placed from Files (`![alt](pn:file/<uuid>)`): referenced by
    //    `pn:file/` without a `[name|size|mime]` attachment chip. Skipped for
    //    structured JSON items so vault passwords are never regex-scanned.
    if (!isStructured) {
      for (const uuid of extractAttachmentIds(note.body)) {
        if (seenFileUuids.has(uuid)) continue;
        const bytes = blobSizes.get(uuid) ?? 0;
        const title = isGated ? noteTitle : `Image, ${noteTitle}`;
        const existing = blobs.get(uuid);
        if (!existing) {
          blobs.set(uuid, {
            uuid,
            kind: 'image',
            noteType: note.type,
            title,
            mime: isGated ? '' : 'image/*',
            bytes,
            noteId: note.id,
            noteTitle,
            location,
            spaceLabel,
            gated: isGated,
            absent,
          });
        } else {
          if (bytes > existing.bytes) existing.bytes = bytes;
          if (isBetterBlobOwner(existing, { location, absent, gated: isGated })) {
            // Only an unlocked, visible file attachment keeps its filename across a Picture-from-Files reference.
            const keepFile = existing.kind === 'file' && !existing.gated && !existing.absent && !isGated;
            existing.kind = keepFile ? 'file' : 'image';
            existing.location = location;
            existing.noteId = note.id;
            existing.noteType = note.type;
            existing.noteTitle = noteTitle;
            existing.title = keepFile ? existing.title : title;
            existing.mime = isGated ? '' : keepFile ? (existing.mime || 'image/*') : 'image/*';
            existing.spaceLabel = spaceLabel;
            existing.gated = isGated;
            existing.absent = absent;
          }
        }
      }
    }
  }

  let filesBytes = 0;
  let filesCount = 0;
  let archivedFilesCount = 0;
  const allItems: VaultStorageItem[] = [...noteItems];

  for (const blob of blobs.values()) {
    if (blob.location === 'trash') {
      trashBytes += blob.bytes;
    } else {
      filesBytes += blob.bytes;
      filesCount += 1;
      if (blob.location === 'archive') archivedFilesCount += 1;
    }
    if (blob.bytes > 0 && !blob.absent) {
      allItems.push({
        key: blob.uuid,
        kind: blob.kind,
        noteType: blob.noteType,
        title: blob.title,
        noteId: blob.noteId,
        noteTitle: blob.noteTitle,
        mime: blob.mime,
        bytes: blob.bytes,
        chars: 0,
        location: blob.location,
        spaceLabel: blob.spaceLabel,
        gated: blob.gated,
      });
    }
  }

  allItems.sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title));

  return {
    filesBytes,
    filesCount,
    archivedFilesCount,
    notesBytes,
    notesCount,
    trashBytes,
    trashCount,
    totalBytes: filesBytes + notesBytes + trashBytes,
    largest: allItems.slice(0, largestLimit),
  };
}
