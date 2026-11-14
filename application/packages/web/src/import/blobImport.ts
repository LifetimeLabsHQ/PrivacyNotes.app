import { db } from '../db';
import { sha256Hex } from '../sha256Hex';
import { formatFileSize } from '../attachmentValidation';
import { contactPhotoOptions, currentImageOptions, processImage } from '../imageProcessing';
import { withContactPhotoBytes } from '../contactBody';
import { sniffImageFormat } from '../imageMetadata';
import { cleanFileName } from '../fileNames';
import { hasVaultFiles, storedVaultKeys } from '../vaultBody';
import i18n from '../i18n';
import type { ImportBlob, ImportedNote, StagedBlob } from './types';

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:blobImport.${key}`, options);

/* ------------------------------------------------------------------ */
/* Shared MIME-from-extension lookup                                   */
/* ------------------------------------------------------------------ */

/** MIME from file extension. Sources attach arbitrary files, so the
 *  fallback is a generic binary rather than a skip. Shared by the
 *  Notesnook and UpNote importers. */
export function mimeFromExt(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
    heic: 'image/heic', tiff: 'image/tiff', ico: 'image/x-icon',
    pdf: 'application/pdf', zip: 'application/zip', json: 'application/json',
    txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
    opus: 'audio/opus', flac: 'audio/flac',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  };
  // An own-property test: an extension like `constructor` must not read a
  // value inherited from Object.prototype.
  return Object.hasOwn(map, ext) ? map[ext]! : 'application/octet-stream';
}

/** MIME from the extension, or from the image signature when the name has
 *  no known extension (Notesnook exports JPEGs with no extension, #642). */
export function mimeFromExtOrBytes(path: string, data: Uint8Array): string {
  const mime = mimeFromExt(path);
  if (mime !== 'application/octet-stream') return mime;
  const format = sniffImageFormat(data);
  return format === 'unknown' ? mime : `image/${format}`;
}

/* ------------------------------------------------------------------ */
/* Shared attachment allow-list                                        */
/* ------------------------------------------------------------------ */

/**
 * Non-markdown files a folder-shaped import carries across as an image or
 * an attachment.
 *
 * Deliberately an allow-list rather than "everything that is not .md": a
 * real notes folder also holds editor state, lock files, sync databases and
 * whatever the user happened to leave there, and importing those would burn
 * the account's storage quota on junk the app can never render. Shared by
 * obsidian.ts and markdown.ts so the two agree on what an attachment is.
 */
export const ATTACHMENT_EXT =
  /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff?|ico|pdf|mp3|m4a|wav|ogg|opus|flac|mp4|webm|mov|docx?|xlsx?|pptx?|csv)$/i;

/* ------------------------------------------------------------------ */
/* Shared blob import + body-rewrite                                   */
/* ------------------------------------------------------------------ */

/**
 * A path plus its percent-encoded and percent-decoded spellings, deduped.
 * `decodeURI` throws on a malformed escape (a literal `%` in a filename),
 * which is a normal thing for a user to have, so it degrades to no variant
 * rather than failing the whole import.
 */
function encodingVariants(path: string): string[] {
  const out = [path];
  const encoded = encodeURI(path);
  if (encoded !== path) out.push(encoded);
  try {
    const decoded = decodeURI(path);
    if (decoded !== path) out.push(decoded);
  } catch {
    /* malformed escape sequence - the raw path is the only spelling */
  }
  return out;
}

/**
 * Every spelling of a blob key that `importBlobs` will look for in a note
 * body: the full key, its last two path segments, and its basename, each
 * percent-encoded and decoded. Filesystem-style keys (Apple Notes, a zipped
 * notes folder) are longer than the reference the note itself carries.
 */
function blobKeyCandidates(key: string): string[] {
  const segments = key.split('/');
  const paths = [key];
  if (segments.length >= 2) paths.push(segments.slice(-2).join('/'));
  if (segments.length >= 1) paths.push(segments[segments.length - 1]!);
  return [...new Set(paths.flatMap(encodingVariants))];
}

/** A markdown image or link whose target is `search`, angle brackets
 *  tolerated (`mdLinkTarget` in export.ts wraps a target holding a space),
 *  and so is any run of `./` and `../` before it: a note in a folder
 *  directory reaches the zip's images/ through `../` (the Notes only
 *  export, #682). */
function blobRefPattern(search: string, keepAlt: boolean): RegExp {
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const target = `<?(?:\\.{1,2}/)*${escaped}>?`;
  return new RegExp(
    keepAlt ? `!\\[([^\\]]*)\\]\\(${target}\\)` : `!?\\[[^\\]]*\\]\\(${target}\\)`,
    'g',
  );
}

/**
 * Would `importBlobs` rewrite a reference to this key inside `text`?
 *
 * The question an importer has to answer BEFORE shipping a blob: a notes
 * folder holds images nothing links to any more, and an unreferenced blob is
 * pure quota burn (notesnook.ts learned this first). Sharing the predicate
 * with the rewrite is the point - a looser test here ships blobs that then
 * never get rewritten, which is the same waste with an extra step.
 */
export function isBlobReferenced(key: string, text: string): boolean {
  return blobKeyCandidates(key).some((c) => blobRefPattern(c, false).test(text));
}

/**
 * Generic blob import for any importer that populates `ParsedImport.blobs`.
 *
 * 1. Returns the notes with every blob key inside a markdown image
 *    `![...](KEY)` or link `[...](KEY)` swapped for the matching
 *    `pn:img/UUID` or `pn:file/UUID` URI.
 * 2. Returns each new blob a rewritten body names as a `StagedBlob`, and
 *    stores none of them: `applyImport` writes them to imageCache/imageDedup
 *    (images) or attachmentCache/attachmentDedup (non-images) with
 *    pendingUpload=1, in the same transaction as the notes. A failed notes
 *    write then keeps no file either, and no upload can start on a file
 *    whose note never landed. A blob no body names is never staged. A blob
 *    the vault already holds (same hash) is reused and never staged, so a
 *    failed import cannot touch it.
 *
 * RUNS BEFORE THE NOTES ARE WRITTEN, and that ordering is load-bearing. A
 * note row must never exist holding a placeholder key, because sync reads
 * the row the moment it is written: it takes a snapshot of every unsent
 * row, sends the bodies in that snapshot, and then clears the unsent flag
 * on any row whose `updatedAt` still matches. A body swapped after that
 * snapshot moves no timestamp, so the guard cannot see it, the row is
 * marked sent, and the placeholder is what every other device receives.
 * The picture bytes upload with nothing pointing at them, and the orphan
 * reclaimer deletes them a day later.
 *
 * Blob map keys are opaque strings that must appear literally in the
 * markdown bodies produced by the importer's parse step. Examples:
 *   - Apple Notes: `"SomeFolder/Attachments/UUID.jpeg"`
 *   - Google Keep: `"keepimg:photo.jpg"`
 *   - Samsung Notes: `"samsungimg:rId2"`
 *
 * Returns the rewritten notes, the staged blobs, and counts of the images
 * and attachments the notes name.
 */
export async function importBlobs(
  blobs: Map<string, ImportBlob>,
  notes: ImportedNote[],
  onProgress?: (msg: string) => void,
): Promise<{ images: number; attachments: number; notes: ImportedNote[]; staged: StagedBlob[] }> {
  // Build the key -> pn: URI mapping first and store nothing yet: a blob is
  // stored only once a rewritten body names it (see the end of this
  // function). New blobs wait here, keyed by uuid; `newByHash` lets
  // identical bytes under two keys share one uuid within this import.
  const keyToUri = new Map<string, string>();
  const fresh = new Map<string, StagedBlob>();
  const newByHash = new Map<string, string>();
  // The stored bytes per URI: a contact records its photo's size in its body.
  const uriToBytes = new Map<string, number>();
  const entries = [...blobs.entries()];
  const imageOptions = currentImageOptions();

  for (let i = 0; i < entries.length; i++) {
    const [key, blob] = entries[i]!;
    const { mime, name } = blob;
    let data = blob.data;
    const isImage = !blob.file && mime.startsWith('image/');
    // Every importer's pictures obey the image switches here, in one place.
    // A picture the module cannot read is stored as it arrived.
    if (isImage && !blob.processed) {
      const opts = blob.ceiling === 'contact' ? contactPhotoOptions() : imageOptions;
      const result = await processImage(new File([data as BlobPart], name, { type: mime }), opts);
      if (result.ok) data = result.image.data;
    }
    const hash = await sha256Hex(data);
    const existing = isImage
      ? await db.imageDedup.get(hash)
      : await db.attachmentDedup.get(hash);
    let uuid = existing?.uuid ?? newByHash.get(hash);
    if (!uuid) {
      uuid = crypto.randomUUID();
      newByHash.set(hash, uuid);
      fresh.set(uuid, { uuid, hash, data, image: isImage, meta: { name, mime, size: data.length } });
    }
    keyToUri.set(key, `${isImage ? 'pn:img' : 'pn:file'}/${uuid}`);
    // Same hash, same bytes: the length holds for a deduplicated picture too.
    if (isImage) uriToBytes.set(keyToUri.get(key)!, data.length);

    // A processed picture is a decode per blob, so the line follows every
    // image rather than every tenth entry.
    if (isImage || (i + 1) % 10 === 0) {
      onProgress?.(msg('importingAttachments', { done: i + 1, total: entries.length }));
    }
  }

  if (keyToUri.size === 0) {
    return { images: 0, attachments: 0, notes, staged: [] };
  }

  onProgress?.(msg('updatingRefs'));
  const rewritten = notes.map((note) => {
    // A login, card or SSH key body is JSON: its files are rewritten one
    // entry at a time, never by the markdown patterns, whose `[` would match
    // the array's own bracket or one in a password.
    const body = hasVaultFiles(note.type)
      ? rewriteVaultFiles(note.body, keyToUri, blobs)
      : rewriteBlobRefs(note.body, keyToUri, blobs);
    if (body === null) return note;
    // A contact records its photo's stored size beside the reference.
    return {
      ...note,
      body:
        note.type === 'contact'
          ? withContactPhotoBytes(body, (uri) => uriToBytes.get(uri))
          : body,
    };
  });

  // Stage only the blobs a rewritten body names. An importer picks its blobs
  // from the source markup, and its conversion can still drop a reference
  // (UpNote flattens media inside a table cell to text). A blob stored with
  // no note naming it uploads anyway, and no delete ever queues it, so it
  // counts against the account's storage after every note is gone.
  const named = new Set<string>();
  for (const note of rewritten) {
    for (const m of note.body.matchAll(/pn:(?:img|file)\/([0-9a-f-]{36})/g)) named.add(m[1]!);
  }
  const staged = [...fresh.values()].filter((blob) => named.has(blob.uuid));

  let images = 0;
  let attachments = 0;
  for (const uri of keyToUri.values()) {
    if (!named.has(uri.slice(uri.indexOf('/') + 1))) continue;
    if (uri.startsWith('pn:img/')) images++;
    else attachments++;
  }
  return { images, attachments, notes: rewritten, staged };
}

/** One entry of a vault body's `files` list, `[name](KEY)` with nothing around it. */
const VAULT_FILE_ENTRY = /^\[[^\]]*\]\(([^()\s]+)\)$/;

/**
 * Swap the blob keys in a login's, card's or SSH key's `files` list for the
 * `[name|size|mime](pn:file/<uuid>)` link the Files section reads
 * (`vaultFiles` in vaultBody.ts). An importer writes each file as
 * `[name](KEY)`; only an exact key is swapped, and only for a file, never a
 * picture, because the Files section holds files. Returns null when no
 * entry changed.
 * Spec: docs/internal/issues/0563.md
 */
function rewriteVaultFiles(
  body: string,
  keyToUri: Map<string, string>,
  blobs: Map<string, ImportBlob>,
): string | null {
  const keys = storedVaultKeys(body);
  if (!Array.isArray(keys.files)) return null;
  let changed = false;
  const files = keys.files.map((entry: unknown) => {
    const key = typeof entry === 'string' ? VAULT_FILE_ENTRY.exec(entry)?.[1] : undefined;
    const uri = key ? keyToUri.get(key) : undefined;
    const blob = key ? blobs.get(key) : undefined;
    if (!uri?.startsWith('pn:file/') || !blob) return entry;
    changed = true;
    return `[${cleanFileName(blob.name, 'Attachment')}|${formatFileSize(blob.data.length)}|${blob.mime}](${uri})`;
  });
  return changed ? JSON.stringify({ ...keys, files }) : null;
}

/**
 * Swap every stored blob key inside `body` for the `pn:` URI it landed
 * under. Returns null when the body names none of them, so the caller can
 * keep the note object it already has.
 */
function rewriteBlobRefs(
  body: string,
  keyToUri: Map<string, string>,
  blobs: Map<string, ImportBlob>,
): string | null {
  let out = body;
  let changed = false;

  for (const [key, uri] of keyToUri) {
    const isImage = uri.startsWith('pn:img/');
    const candidates = blobKeyCandidates(key);

    if (isImage) {
      // Images: pn:img/<uuid> carries only the uuid, so a literal swap of
      // the key inside ![alt](key) preserves the alt text. Covers keepimg:
      // style placeholders and any scheme where the key appears literally.
      if (out.includes(key)) {
        out = out.split(key).join(uri);
        changed = true;
        continue;
      }
      for (const search of candidates) {
        const replaced = out.replace(blobRefPattern(search, true), `![$1](${uri})`);
        if (replaced !== out) { out = replaced; changed = true; }
      }
      continue;
    }

    // Attachments: the editor recovers filename, size, and MIME from the
    // link TEXT as `name|size|mime` (see EncryptedAttachment parseHTML).
    // Rebuild the full link from the blob's real metadata so imported
    // audio/files keep their extension, MIME, and play back. The source
    // link text (e.g. Apple's "New Recording") is discarded in favour of
    // the real attachment name.
    const blob = blobs.get(key);
    const linkText = blob
      ? `${blob.name}|${formatFileSize(blob.data.length)}|${blob.mime}`
      : 'Attachment||';
    const replacement = `[${linkText}](${uri})`;
    for (const search of candidates) {
      // `keepAlt: false` tolerates a leading `!` so a mislabelled
      // ![text](path) audio ref still becomes a clean attachment link, not
      // a broken image.
      const replaced = out.replace(blobRefPattern(search, false), replacement);
      if (replaced !== out) { out = replaced; changed = true; }
    }
  }

  return changed ? out : null;
}
