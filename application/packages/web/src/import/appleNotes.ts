import type JSZip from 'jszip';
import i18n from '../i18n';
import { mediaTooLargeWarning, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';
import { normalizeTag } from '../notesRepo';
import { withBareLinks } from './bareLinks';
import { mapOutsideCode } from './codeSegments';
import { importBlobs } from './blobImport';
import { FileKeys, fileResolver, keyFileRefs, readKeyedFiles } from './fileRefs';
import { isUntitledStem } from '../exportNames';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';
import { isJunkEntry } from './importHelpers';

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:appleNotes.${key}`, options);

/**
 * Apple Notes importer.
 *
 * Supports two export formats:
 *
 * 1. macOS "Exporter" app - single zip with account/folder nesting:
 *      account/Folder/Note Title.md
 *      account/Folder/images/image-file.jpg
 *
 * 2. iOS share-sheet - per-note zip:
 *      Note Title/Note Title.md
 *      Note Title/Attachments/UUID.jpeg
 *      Note Title/Attachments/UUID.m4a
 *
 * Each .md file has a `# Title` heading followed by the note body.
 * Tables are GFM pipe tables. Checklists use `- [ ]` / `- [x]`.
 * Images and attachments are imported into encrypted storage and
 * references rewritten to pn:img/ and pn:file/ URIs.
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Account labels the Exporter app writes as the top folder. */
function looksLikeAccount(segment: string): boolean {
  return segment.includes('@') || /^(icloud|on my mac|on my iphone|on my ipad)$/i.test(segment);
}

/**
 * How many leading segments of the post-prefix paths are the ACCOUNT rather
 * than a folder. Decided once per zip, never per path, because the answer
 * depends on what the user selected when zipping:
 *
 *  - the prefix strip in `parseZip` already ate one shared level, so if THAT
 *    level was the account there is nothing left here to drop;
 *  - otherwise the account, if the export has one, is the level every note
 *    shares, since the Exporter app nests everything under it;
 *  - a level the notes do NOT share is a folder, and so is the single level
 *    of an iOS share-sheet zip.
 *
 * One shape structure alone cannot answer: an account root holding exactly
 * one folder, where `Recipes/Cake.md` and `iCloud/Cake.md` are the same
 * shape. The name test above breaks that tie.
 */
function accountSegmentsToDrop(prefix: string, relPaths: string[]): number {
  if (looksLikeAccount(prefix.replace(/\/$/, ''))) return 0;
  if (relPaths.length === 0) return 0;
  const firsts = relPaths
    .map((p) => p.split('/'))
    .filter((parts) => parts.length >= 2)
    .map((parts) => parts[0]!);
  // A note sitting at the root has no leading level, so no level is shared.
  if (firsts.length !== relPaths.length) return 0;
  return firsts.every((f) => f === firsts[0]) ? 1 : 0;
}

/**
 * Convert folder segments to tags. `dropLeading` comes from
 * `accountSegmentsToDrop` and this function never re-derives it - that split
 * is the whole point. The account used to be dropped BOTH here and, whenever
 * it happened to be the zip root, again by the prefix strip in `parseZip`, so
 * the same export imported with or without its folder tags depending only on
 * how many levels the user happened to select when zipping.
 *
 * Example: "user@example.com/Recipes/Cake.md", dropLeading 1 -> ["Recipes"]
 *          "Recipes/Cake.md",                  dropLeading 0 -> ["Recipes"]
 *          "Weekend plan.md",                  dropLeading 0 -> []
 *
 * Case is preserved: `normalizeTag` strips delimiters and collapses
 * whitespace but does not lower-case. (This comment claimed it did until
 * `tests/importAppleNotes.test.ts` asserted the real output.)
 */
function tagsFromPath(relativePath: string, dropLeading: number): string[] {
  const parts = relativePath.split('/');
  // Everything between the account and the filename is a folder.
  return parts
    .slice(dropLeading, -1)
    .map((p) => normalizeTag(p))
    .filter((t): t is string => !!t);
}

/**
 * The Exporter app duplicates the title: the first line is `# Title`
 * and the body often starts with the same text as a plain paragraph.
 * Strip that duplicate so imported notes aren't redundant.
 */
function stripDuplicateTitle(title: string, body: string): string {
  if (!title) return body;
  const lines = body.split('\n');
  // Check if the first non-empty line matches the title exactly
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx >= 0 && lines[firstIdx]!.trim() === title) {
    lines.splice(firstIdx, 1);
    // Also remove a blank line right after if present
    if (firstIdx < lines.length && lines[firstIdx]!.trim() === '') {
      lines.splice(firstIdx, 1);
    }
    return lines.join('\n').trim();
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* Single file parser                                                 */
/* ------------------------------------------------------------------ */

function parseOneNote(
  content: string,
  relativePath: string,
  dropLeading: number,
  zipDate: Date | null,
): ImportedNote & { hadUnderline: boolean } {
  // The entry's own modified time, the way obsidian.ts, markdown.ts and
  // samsungNotes.ts all read it. Import time is the last resort: stamping
  // every note with it destroys the library's real history, and the export
  // is usually deleted before anyone notices.
  const stamp = (zipDate ?? new Date()).toISOString();

  // Title: a `# ` heading that is the first line with text, else the
  // filename. A heading further down is the note's own; taking it would
  // drop the text above it.
  let title = '';
  let body = content;

  // From the top only, never the `m` flag: `^\s*` tried at every line of a
  // run of blank lines is quadratic. A first heading with blank text above
  // it is the same match either way.
  const headingMatch = content.match(/^\s*# ([^\n\r\u2028\u2029]+)/);
  if (headingMatch && !content.slice(0, headingMatch.index!).trim()) {
    title = headingMatch[1]!.trim();
    // Remove the heading line from body
    body = content.slice(headingMatch.index! + headingMatch[0].length).trim();
  } else {
    // The Exporter names each file after the note, so the filename is the
    // title - unless it is the default name Apple Notes gives a note that has
    // none, which is a stand-in and must not be stored. See `isUntitledStem`.
    const stem = (relativePath.split('/').pop() ?? '').replace(/\.md$/i, '').trim();
    title = isUntitledStem(stem) ? '' : stem;
  }

  // Strip duplicate title line
  body = stripDuplicateTitle(title, body);

  // Convert ++underline++ to HTML <u> tags (TipTap Underline extension),
  // outside code and only as a mark around text: `i++ and j++` stays.
  // ==highlight== stays as it is: the editor reads it as a highlight.
  let hadUnderline = false;
  body = mapOutsideCode(body, (prose) => prose.replace(/(?<![\w+])\+\+(?=\S)(.+?)(?<=\S)\+\+(?![\w+])/g, (_, inner: string) => {
    hadUnderline = true;
    return `<u>${inner}</u>`;
  }));

  // NOTE: image/attachment references (images/... and Attachments/...)
  // are left intact here; parseZip resolves each against the note's own
  // folder and gives it a fixed-width key (fileRefs.ts) that the blob
  // import step rewrites to a pn:img/ or pn:file/ URI.

  // Tags from folder path
  const tags = tagsFromPath(relativePath, dropLeading);

  // Bare URLs become links after the parse (withBareLinks).
  body = body.trim();

  return {
    title,
    body,
    tags,
    createdAt: stamp,
    updatedAt: stamp,
    hadUnderline,
  };
}

/* ------------------------------------------------------------------ */
/* Zip parser                                                         */
/* ------------------------------------------------------------------ */

const MD_EXT = /\.md$/i;
const ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|pdf|mp3|mp4|webm|ogg|wav|m4a)$/i;

interface ParseZipResult {
  notes: ImportedNote[];
  strippedUnderline: number;
  blobs: Map<string, ImportBlob>;
  blobBytes: number;
  tooLarge: number;
}

async function parseZip(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<ParseZipResult> {
  onProgress?.(i18n.t('importLog:shared.readingZip'));
  const buf = await file.arrayBuffer();
  const zip = await openZip(buf);

  // Collect all file paths, skipping hidden/system files
  const allPaths: string[] = [];
  zip.forEach((path, entry) => {
    if (!entry.dir && !isJunkEntry(path)) allPaths.push(path);
  });

  // Detect common root prefix (the zip often wraps everything in one folder)
  let prefix = '';
  if (allPaths.length > 0) {
    const firstSlash = allPaths[0]!.indexOf('/');
    if (firstSlash > 0) {
      const candidate = allPaths[0]!.slice(0, firstSlash + 1);
      if (allPaths.every((p) => p.startsWith(candidate))) {
        prefix = candidate;
      }
    }
  }

  const mdFiles: [string, JSZip.JSZipObject][] = [];
  const blobFiles: [string, JSZip.JSZipObject][] = [];

  zip.forEach((path, entry) => {
    if (entry.dir || isJunkEntry(path)) return;
    const rel = prefix ? path.slice(prefix.length) : path;
    if (MD_EXT.test(rel)) {
      mdFiles.push([rel, entry]);
    } else if (ATTACHMENT_EXT.test(rel)) {
      blobFiles.push([rel, entry]);
    }
  });

  onProgress?.(i18n.t('importLog:shared.foundNotes', { count: mdFiles.length }));

  // Decide the account level ONCE, from every note path at once. Doing it per
  // path is what let the answer depend on how deep the zip was taken.
  const dropLeading = accountSegmentsToDrop(prefix, mdFiles.map(([rel]) => rel));

  // Parse markdown notes
  const notes: ImportedNote[] = [];
  let strippedUnderline = 0;
  for (let i = 0; i < mdFiles.length; i++) {
    const [rel, entry] = mdFiles[i]!;
    const text = await zipEntryText(entry);
    const parsed = parseOneNote(text, rel, dropLeading, entry.date ?? null);
    if (parsed.hadUnderline) strippedUnderline++;
    notes.push(parsed);
    if ((i + 1) % 50 === 0) {
      onProgress?.(i18n.t('importLog:shared.parsed', { done: i + 1, total: mdFiles.length }));
    }
  }

  // Only the files a note names, each resolved from the note's own folder
  // under a fixed-width key: `Recipes/images/a.jpg` and `iCloud/images/a.jpg`
  // stay two pictures (beta #152).
  const files = new Map(blobFiles);
  const resolve = fileResolver(files.keys());
  const keys = new FileKeys('anfile');
  for (const [i, [rel]] of mdFiles.entries()) {
    notes[i]!.body = keyFileRefs(notes[i]!.body, rel.slice(0, Math.max(0, rel.lastIndexOf('/'))), resolve, keys);
  }
  if (keys.size > 0) {
    onProgress?.(i18n.t('importLog:shared.extracting', { count: keys.size }));
  }
  const { blobs, tooLarge } = await readKeyedFiles(keys, files, notes, (done, total) =>
    onProgress?.(i18n.t('importLog:shared.extracted', { done, total })),
  );
  const blobBytes = [...blobs.values()].reduce((sum, b) => sum + b.data.length, 0);

  return { notes, strippedUnderline, blobs, blobBytes, tooLarge };
}

/* ------------------------------------------------------------------ */
/* Public importer                                                    */
/* ------------------------------------------------------------------ */

export const parseAppleNotes = withBareLinks(readAppleNotes);

async function readAppleNotes(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<ParsedImport> {
  const { notes, strippedUnderline, blobs, blobBytes, tooLarge } = await parseZip(file, onProgress);

  // Count images vs non-image attachments
  let imageCount = 0;
  let attachmentCount = 0;
  for (const [, blob] of blobs) {
    if (blob.mime.startsWith('image/')) imageCount++;
    else attachmentCount++;
  }

  const warnings: string[] = [];
  if (tooLarge > 0) warnings.push(mediaTooLargeWarning(tooLarge));

  const transforms: string[] = [];
  const withTags = notes.filter((n) => n.tags.length > 0).length;
  if (withTags > 0) {
    transforms.push(
      msg('foldersToTags', { count: withTags })
    );
  }
  const withTables = notes.filter((n) => /\|.*\|/.test(n.body)).length;
  if (withTables > 0) {
    transforms.push(
      msg('preservedTables', { count: withTables })
    );
  }
  const withTasks = notes.filter((n) => /- \[[ x]\]/.test(n.body)).length;
  if (withTasks > 0) {
    transforms.push(
      msg('preservedChecklists', { count: withTasks })
    );
  }
  if (strippedUnderline > 0) {
    transforms.push(
      msg('convertedUnderline', { count: strippedUnderline })
    );
  }
  if (imageCount > 0) {
    transforms.push(
      i18n.t('importLog:shared.foundImages', { count: imageCount })
    );
  }
  if (attachmentCount > 0) {
    transforms.push(
      i18n.t('importLog:shared.foundAttachments', { count: attachmentCount })
    );
  }

  return {
    notes,
    warnings,
    transforms,
    source: 'apple-notes',
    blobBytes,
    blobs: blobs.size > 0 ? blobs : undefined,
  };
}
