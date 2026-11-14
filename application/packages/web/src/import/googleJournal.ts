import type JSZip from 'jszip';
import i18n from '../i18n';
import { escapeMarkdownText, guardMarkdownLineStart } from '../markdownEscape';
import { toLocalIso } from '../notesViewUtils';
import { linkifyLiteralText } from './linkify';
import { mediaTooLargeWarning, zipEntryMedia, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';
import { mimeFromExtOrBytes } from './blobImport';
import { blobKey, untitledEntryTitle } from './journalImport';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:googleJournal.${key}`, options);

/**
 * Google Journal importer.
 *
 * Reads the Google Takeout archive. Takeout lists Journal only after
 * "Back up your journal" is on in the app. Each entry is a folder
 * `Takeout/Journal/<UTC yyyyMMdd_HHmmss>[_<title>]/` holding one JSON file and
 * the entry's pictures and videos, which the JSON does not name:
 *
 *   { journal_content: { journalContentEntity: {
 *       title, content (plain text), createdTime, modifiedTime } } }
 *
 * `createdTime` is the day the entry is for, as seconds and nanos. A map comes
 * as a picture, and Takeout leaves out the place name, the writing prompt,
 * the bookmark and the AI reflection, which the summary says.
 *
 * Format facts come from a real export made in the importer lab (the app
 * file of the importer-lab skill); Journal is closed source.
 * Spec: docs/internal/issues/0494.md
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** A Takeout timestamp `{ seconds, nanos }` as a Date, or null. */
function stamp(v: unknown): Date | null {
  if (!isObj(v) || typeof v.seconds !== 'number' || !Number.isFinite(v.seconds)) return null;
  const ms = v.seconds * 1000 + (typeof v.nanos === 'number' ? Math.floor(v.nanos / 1e6) : 0);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return y >= 1900 && y <= 2200 ? d : null;
}

/** Typed plain text as Markdown that shows exactly that text. */
function plainToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => guardMarkdownLineStart(linkifyLiteralText(line, escapeMarkdownText).markdown))
    .join('\n')
    .trim();
}

interface Folder {
  json: JSZip.JSZipObject | null;
  media: [string, JSZip.JSZipObject][];
}

export async function parseGoogleJournal(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(i18n.t('importLog:shared.readingZip'));
  let zip: JSZip;
  try {
    zip = await openZip(await file.arrayBuffer());
  } catch {
    throw new Error(msg('notTakeout'));
  }

  // Entry folders, wherever the archive nests the Journal folder.
  const folders = new Map<string, Folder>();
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.some((p) => p === '..')) return;
    const at = parts.lastIndexOf('Journal');
    if (at < 0 || parts.length !== at + 3) return;
    const key = parts.slice(0, at + 2).join('/');
    const name = parts[at + 2]!;
    const folder = folders.get(key) ?? { json: null, media: [] };
    if (/\.json$/i.test(name)) folder.json = folder.json ?? entry;
    else folder.media.push([name, entry]);
    folders.set(key, folder);
  });
  if (folders.size === 0) throw new Error(msg('noJournal'));

  const notes: ImportedNote[] = [];
  const blobs = new Map<string, ImportBlob>();
  let photos = 0, videos = 0, tooLarge = 0, skipped = 0, untitled = 0;
  const keys = [...folders.keys()].sort();

  for (let i = 0; i < keys.length; i++) {
    const folder = folders.get(keys[i]!)!;
    if (i % 25 === 0) onProgress?.(i18n.t('importLog:appleJournal.readingEntry', { current: i + 1, total: keys.length }));
    if (!folder.json) {
      skipped++;
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(await zipEntryText(folder.json));
    } catch {
      skipped++;
      continue;
    }
    const content = isObj(doc) && isObj(doc.journal_content) ? doc.journal_content.journalContentEntity : null;
    const created = isObj(content) ? stamp(content.createdTime) : null;
    if (!isObj(content) || !created) {
      skipped++;
      continue;
    }
    const modified = stamp(content.modifiedTime) ?? created;

    const media: string[] = [];
    for (const [name, entry] of folder.media.sort((a, b) => a[0].localeCompare(b[0]))) {
      const data = await zipEntryMedia(entry);
      if (!data) {
        tooLarge++;
        continue;
      }
      const mime = mimeFromExtOrBytes(name, data);
      const key = blobKey('gjblob', blobs.size);
      blobs.set(key, { data, mime, name });
      if (mime.startsWith('image/')) {
        media.push(`![](${key})`);
        photos++;
      } else {
        media.push(`[${name}](${key})`);
        videos++;
      }
    }

    let title = (typeof content.title === 'string' ? content.title : '').replace(/\s+/g, ' ').trim();
    if (!title) {
      title = untitledEntryTitle(created);
      untitled++;
    }
    const text = plainToMarkdown(typeof content.content === 'string' ? content.content : '');
    notes.push({
      title,
      body: [text, ...(media.length > 0 ? [media.join('\n\n')] : [])].filter(Boolean).join('\n\n'),
      tags: [],
      createdAt: created.toISOString(),
      updatedAt: modified.toISOString(),
      type: 'journal',
      trackers: { journalDate: toLocalIso(created) },
    });
  }

  if (notes.length === 0) throw new Error(msg('noJournal'));
  notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const warnings = [msg('leftOut')];
  if (tooLarge > 0) warnings.push(mediaTooLargeWarning(tooLarge));
  if (skipped > 0) warnings.push(msg('skipped', { count: skipped }));

  const transforms = [i18n.t('importLog:shared.importedJournalEntries', { count: notes.length })];
  if (photos > 0) transforms.push(i18n.t('importLog:shared.foundPhotos', { count: photos }));
  if (videos > 0) transforms.push(i18n.t('importLog:appleJournal.foundVideos', { count: videos }));
  if (untitled > 0) transforms.push(i18n.t('importLog:daylio.untitled', { count: untitled }));

  let blobBytes = 0;
  for (const b of blobs.values()) blobBytes += b.data.length;
  return {
    notes,
    warnings,
    transforms,
    stats: {
      totalNotes: notes.length,
      emptyNotes: notes.filter((n) => !n.body.trim()).length,
      untaggedNotes: notes.length,
      uniqueTags: 0,
    },
    source: 'google-journal',
    ...(blobs.size > 0 ? { blobs, blobBytes } : {}),
  };
}
