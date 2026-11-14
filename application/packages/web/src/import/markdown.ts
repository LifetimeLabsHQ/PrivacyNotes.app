// Type-only: erased at build time. The runtime module is imported
// dynamically in parseZip so jszip stays out of the boot-path bundle
// (NotesView statically imports parseMarkdown for drag-and-drop).
import type JSZip from 'jszip';
import i18n from '../i18n';
import { mediaTooLargeWarning, zipEntryMedia, zipEntryText } from './zipEntry';
import type { FolderDef } from '../folders';
import { extractInlineTags, normalizeTag } from '../notesRepo';
import { oneLineTitle } from '../oneLineTitle';
import { FRONT_MATTER, SUPPORTED_EXT } from '../markdownFolder/adapter';
import { isUntitledStem } from '../exportNames';
import { parseTrackers, stripFrontMatterPadding, unescapeQuotes, unescapeSingleQuotes } from '../noteMarkdown';
import { ATTACHMENT_EXT, isBlobReferenced, mimeFromExt } from './blobImport';
import { buildFolderTree, commonRootPrefix, parseFolderPath } from './folderImport';
import { linkifyMarkdown } from './linkify';
import { detailsToFold } from './detailsFold';
import type { ImportedNote, ParsedImport } from './types';
import { FRONT_MATTER_LOCATION, FRONT_MATTER_LOCATION_NAME, LOCATION_KEY, parseFrontMatterLocation } from '../noteLocation';

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:markdown.${key}`, options);

/**
 * Markdown importer - handles:
 *   1. A .zip of .md files (bulk import, including PrivacyNotes exports)
 *   2. Individual .md files
 *
 * PrivacyNotes exports include YAML front-matter with title, created,
 * updated, and tags fields. Plain .md files use the filename as title
 * and the full content as body. The parser is intentionally lenient -
 * it accepts any file the Markdown folder adapter would open, with or
 * without front-matter: `.md`, `.markdown`, `.mdown`, `.mkd` and `.txt`.
 * `.txt` is in that list because Nextcloud Notes writes it by DEFAULT, so
 * rejecting it meant telling a whole app's users to rename their notes
 * first. On disk a `.txt` opens in the source editor rather than the rich
 * one; an import is a copy, not the file, so the distinction ends here.
 *
 * A zip also carries its STRUCTURE across: subfolders are rebuilt as real
 * folders and referenced images and attachments come with the notes.
 * Rebuilding folders here means a Typora, iA Writer, Zettlr or Nextcloud
 * user keeps their folder tree without having to guess that the "Obsidian"
 * row would do it. The two importers differ only where they should: this one
 * takes any pile of markdown as it finds it, obsidian.ts additionally
 * translates a dialect (embeds, callouts, comments, inline #tags).
 */

/** Minimal YAML front-matter parser - just the fields we care about. */
function parseFrontMatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const fmMatch = content.match(FRONT_MATTER);
  if (!fmMatch || !fmMatch[1]) {
    return { meta: {}, body: content };
  }

  // No prototype: a `__proto__:` line is then an ordinary key (#656).
  const meta: Record<string, string> = Object.create(null);
  for (const line of fmMatch[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    meta[key] = val;
  }

  return { meta, body: fmMatch[2] ?? '' };
}

/** Extract tags from YAML front-matter value like `[tag1, tag2]`. */
function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  // Strip brackets and split on comma.
  const stripped = raw.replace(/^\[/, '').replace(/\]$/, '');
  return stripped
    .split(',')
    .map((t) => normalizeTag(t))
    .filter(Boolean);
}

/** A YAML string value without its quotes. Only the outer pair goes, so a
 *  title written as `"'quoted'"` keeps its own single quotes, and a
 *  double-quoted value also loses the writer's escape (`unescapeQuotes`). */
function unquote(s: string | undefined): string {
  if (!s) return '';
  if (s.length < 2) return s;
  if (s.startsWith('"') && s.endsWith('"')) return unescapeQuotes(s.slice(1, -1));
  if (s.startsWith("'") && s.endsWith("'")) return unescapeSingleQuotes(s.slice(1, -1));
  return s;
}

/**
 * A front-matter date as the instant the app stores. A date-only value
 * (`created: 2024-05-12`) is that local day at noon, the app's reading of a
 * day (MonthGrid.tsx), so the note lands on the same day in every zone;
 * read as midnight UTC it was the evening before west of Greenwich. A
 * date-time without a zone is local time, as the editor that wrote it
 * meant it. Null when the value does not parse. Shared with obsidian.ts.
 */
export function parseFrontMatterDate(raw: string | undefined): string | null {
  const value = unquote(raw).trim();
  if (!value) return null;
  const local = value.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/);
  const at = Date.parse(local ? `${local[1]}T${local[2] ?? '12:00:00'}` : value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** Derive a title from a filename (strip extension, un-slugify). A default
 * name like "Untitled.md" or "untitled-2.md" is treated as "no title" -
 * see `isUntitledStem`. Returning "" lets the live first-body-line
 * derivation take over. */
function titleFromFilename(name: string): string {
  const stripped = name
    .replace(SUPPORTED_EXT, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return isUntitledStem(stripped) ? '' : stripped;
}

/** One file, plus what it turned out to carry - the transforms line has to
 *  say what actually happened, and "it has tags" does not imply "it had
 *  front matter": inline #tags are read here too. */
interface ParsedOne {
  note: ImportedNote;
  hadFrontMatter: boolean;
  hadInlineTags: boolean;
}

function parseOneMd(
  content: string,
  filename: string,
  fileDate: Date | null,
): ParsedOne {
  const { meta, body } = parseFrontMatter(content);
  // Plain markdown files often carry no front-matter dates. Fall back to
  // the file's modified time (from the zip entry, or the dropped file's
  // lastModified) before resorting to the import time.
  const fallback =
    fileDate && !Number.isNaN(fileDate.getTime())
      ? fileDate.toISOString()
      : new Date().toISOString();

  const title =
    unquote(meta['title']) ||
    titleFromFilename(filename);

  // Front-matter tags plus the ones written inline in the prose: the same
  // note must import with the same tags whichever importer row the user
  // clicks. The grammar lives in notesRepo so the two cannot drift.
  const tags = parseTags(meta['tags']);
  const inline = extractInlineTags(body);
  for (const t of inline) {
    if (!tags.includes(t)) tags.push(t);
  }

  // Dates - fall back to file/import time if not present or invalid.
  const createdAt = parseFrontMatterDate(meta['created']) ?? fallback;
  const updatedAt = parseFrontMatterDate(meta['updated']) ?? fallback;

  // Trackers ride in the front-matter as one JSON line (see noteMarkdown.ts).
  // Only `journal`, `task` and `event` are honoured as a type here, the types
  // whose body is real markdown: a plain .md exported from a VAULT item carries the readable `vaultToMarkdown` prose as its body, so
  // trusting a `type: login` line would restore that prose as a login and
  // hide every field. The backup importer, which reads bodies that really are
  // vault JSON, is the one allowed to rebuild those.
  const trackers = parseTrackers(meta['trackers']);
  // `folder: A/B` is the portable membership our own exports write. The zip
  // branch below sets folderPath from the DIRECTORY a file sat in, so this
  // only fills the gap for a single dropped .md, which has no directory.
  const declaredFolder = parseFolderPath(meta['folder']);
  const isJournal = meta['type'] === 'journal' || (trackers !== undefined && !meta['type']);
  // The place joins the trackers only after the journal test above: a note
  // that has a place and nothing else is still a note.
  // Spec: docs/internal/plans/note-location.md (section 6)
  const place = parseFrontMatterLocation(meta[FRONT_MATTER_LOCATION], unquote(meta[FRONT_MATTER_LOCATION_NAME]));
  const carried = place ? { ...trackers, [LOCATION_KEY]: place } : trackers;
  // A task list and an event name themselves; a note is the default.
  const isTask = meta['type'] === 'task';
  const isEvent = meta['type'] === 'event';

  const note: ImportedNote = {
    ...(declaredFolder.length ? { folderPath: declaredFolder } : {}),
    ...(carried ? { trackers: carried } : {}),
    ...(isJournal ? { type: 'journal' as const } : isTask ? { type: 'task' as const } : isEvent ? { type: 'event' as const } : {}),
    title,
    // Bare URLs and emails come in as plain text: tiptap-markdown only builds
    // link nodes from `<...>` autolinks and `[text](url)`, and the Link
    // extension's own autolink only fires while TYPING. Without this pass an
    // imported note's links are dead until you put the caret behind each one
    // and press space. The Apple Notes, Bitwarden, Google Keep and Standard
    // Notes importers run the same pass. Newline-only, not `.trim()`: trimming
    // eats the leading spaces of a note that opens with an indented code
    // block, demoting it to a paragraph (#148). See stripFrontMatterPadding.
    body: linkifyMarkdown(detailsToFold(stripFrontMatterPadding(body))),
    tags,
    createdAt,
    updatedAt,
  };
  return {
    note,
    hadFrontMatter: Object.keys(meta).length > 0,
    hadInlineTags: inline.length > 0,
  };
}

/** Directories, hidden files and the junk a Mac leaves in a zip. */
export function shouldSkip(path: string): boolean {
  if (path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return true;
  if (path.startsWith('.')) return true;
  const name = path.split('/').pop() ?? '';
  return name.startsWith('.');
}

async function parseZip(
  file: File,
  onProgress?: (msg: string) => void
): Promise<{
  notes: ImportedNote[];
  folders: FolderDef[];
  blobs: Map<string, { data: Uint8Array; mime: string; name: string }>;
  skippedAttachments: number;
  tooLarge: number;
  fmCount: number;
  inlineTagCount: number;
}> {
  onProgress?.(i18n.t('importLog:shared.readingZip'));
  const { openZip } = await import('./zipOpen');
  const buf = await file.arrayBuffer();
  const zip = await openZip(buf);

  const allPaths: string[] = [];
  zip.forEach((path, entry) => {
    if (!entry.dir && !shouldSkip(path)) allPaths.push(path);
  });
  const prefix = commonRootPrefix(allPaths);

  const mdFiles: [string, JSZip.JSZipObject][] = [];
  const attachments: [string, JSZip.JSZipObject][] = [];
  zip.forEach((path, entry) => {
    if (entry.dir || shouldSkip(path)) return;
    const rel = prefix ? path.slice(prefix.length) : path;
    if (SUPPORTED_EXT.test(rel)) mdFiles.push([rel, entry]);
    else if (ATTACHMENT_EXT.test(rel)) attachments.push([rel, entry]);
  });

  onProgress?.(msg('foundFiles', { count: mdFiles.length }));

  // Subfolders become real folders at any depth. The title still comes from
  // the BASENAME: a file's folder is where it lives, never part of its name.
  const dirOf = (rel: string) => rel.split('/').slice(0, -1).filter(Boolean).join('/');
  const { folders, dirToFolderId } = buildFolderTree(mdFiles.map(([rel]) => dirOf(rel)));

  const notes: ImportedNote[] = [];
  let fmCount = 0;
  let inlineTagCount = 0;
  for (let i = 0; i < mdFiles.length; i++) {
    const [rel, entry] = mdFiles[i]!;
    const text = await zipEntryText(entry);
    const parsed = parseOneMd(text, rel.split('/').pop() ?? rel, entry.date ?? null);
    const note = parsed.note;
    if (parsed.hadFrontMatter) fmCount++;
    if (parsed.hadInlineTags) inlineTagCount++;
    const dir = dirOf(rel);
    if (dir) {
      note.folderId = dirToFolderId.get(dir) ?? null;
      note.folderPath = dir.split('/').filter(Boolean);
    }
    notes.push(note);
    if ((i + 1) % 50 === 0) {
      onProgress?.(i18n.t('importLog:shared.parsed', { done: i + 1, total: mdFiles.length }));
    }
  }

  // Only files a note actually links to, on the same reasoning as obsidian.ts:
  // an unreferenced blob is storage quota spent to render nothing.
  const bodies = notes.map((n) => n.body).join('\n');
  const blobs = new Map<string, { data: Uint8Array; mime: string; name: string }>();
  let skippedAttachments = 0;
  let tooLarge = 0;
  for (const [rel, entry] of attachments) {
    if (!isBlobReferenced(rel, bodies)) {
      skippedAttachments++;
      continue;
    }
    if (blobs.size % 10 === 0) {
      onProgress?.(i18n.t('importLog:shared.readingAttachments', { done: blobs.size + 1, total: attachments.length }));
    }
    const data = await zipEntryMedia(entry);
    if (!data) {
      tooLarge++;
      continue;
    }
    blobs.set(rel, {
      data,
      mime: mimeFromExt(rel),
      name: rel.split('/').pop() ?? rel,
    });
  }

  return { notes, folders, blobs, skippedAttachments, tooLarge, fmCount, inlineTagCount };
}

function parseSingleMd(file: File, text: string): ParsedOne {
  const fileDate = file.lastModified ? new Date(file.lastModified) : null;
  return parseOneMd(text, file.name, fileDate);
}

/**
 * One markdown file, converted the way an IMPORT converts it: front matter
 * becomes title, tags, dates and trackers, and the body comes back without
 * the block.
 *
 * Exported for the Markdown pillar's "Save to notes" button, so the same file
 * arrives as the same note whichever door it comes through: dropped on the app
 * or saved from the folder view, one parser, one result. Passing the raw text
 * through instead keeps the YAML block, which renders as a horizontal rule
 * plus a setext heading at the top of the note.
 *
 * Note what this is NOT: the file on disk is never touched by either path, so
 * nothing the user owns loses its front matter. A copy is a copy.
 */
export function parseMarkdownFile(filename: string, content: string): ImportedNote {
  const note = parseOneMd(content, filename, null).note;
  // This door stores through createNote rather than applyImport, so it gives
  // the title the one-line rule applyImport gives every other import.
  return { ...note, title: oneLineTitle(note.title) };
}

export async function parseMarkdown(
  file: File,
  onProgress?: (msg: string) => void
): Promise<ParsedImport> {
  const isZip =
    file.name.toLowerCase().endsWith('.zip') ||
    file.type === 'application/zip';

  const { notes, folders, blobs, skippedAttachments, tooLarge, fmCount, inlineTagCount } = isZip
    ? await parseZip(file, onProgress)
    : await (async () => {
        const one = parseSingleMd(file, await file.text());
        return {
          notes: [one.note],
          folders: [] as FolderDef[],
          blobs: new Map<string, { data: Uint8Array; mime: string; name: string }>(),
          skippedAttachments: 0,
          tooLarge: 0,
          fmCount: one.hadFrontMatter ? 1 : 0,
          inlineTagCount: one.hadInlineTags ? 1 : 0,
        };
      })();

  const uniqueTags = new Set(notes.flatMap((n) => n.tags));
  const emptyNotes = notes.filter(
    (n) => !n.title.trim() && !n.body.trim()
  ).length;
  const untaggedNotes = notes.filter((n) => n.tags.length === 0).length;

  const transforms: string[] = [];
  if (fmCount > 0) {
    transforms.push(
      msg('restoredFrontMatter')
    );
  }
  if (inlineTagCount > 0) {
    transforms.push(
      msg('readHashtags', { count: inlineTagCount })
    );
  }
  if (folders.length > 0) {
    const filed = notes.filter((n) => n.folderId).length;
    transforms.push(
      msg('rebuiltFolders', { count: folders.length, filed: i18n.t('importLog:shared.filedNotes', { count: filed }) })
    );
  }
  if (blobs.size > 0) {
    const images = [...blobs.values()].filter((b) => b.mime.startsWith('image/')).length;
    const files = blobs.size - images;
    const parts: string[] = [];
    if (images > 0) parts.push(i18n.t('importLog:shared.imageCount', { count: images }));
    if (files > 0) parts.push(i18n.t('importExport:missing.files', { count: files }));
    transforms.push(msg('broughtAcross', { parts: parts.length === 2 ? i18n.t('importExport:missing.both', { pictures: parts[0], files: parts[1] }) : parts[0] }));
  }

  const warnings: string[] = [];
  if (skippedAttachments > 0) {
    warnings.push(
      i18n.t('importLog:shared.skippedUnlinked', { count: skippedAttachments })
    );
  }
  if (tooLarge > 0) warnings.push(mediaTooLargeWarning(tooLarge));

  return {
    notes,
    warnings,
    transforms,
    stats: {
      totalNotes: notes.length,
      emptyNotes,
      untaggedNotes,
      uniqueTags: uniqueTags.size,
    },
    source: 'markdown-folder',
    folders: folders.length > 0 ? folders : undefined,
    blobs: blobs.size > 0 ? blobs : undefined,
  };
}
