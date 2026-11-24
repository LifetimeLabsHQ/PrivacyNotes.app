import type JSZip from 'jszip';
import i18n from '../i18n';
import { escapeMarkdownText, guardMarkdownLineStart } from '../markdownEscape';
import { LOCATION_KEY, importedLocation } from '../noteLocation';
import { mimeFromExtOrBytes } from './blobImport';
import { buildFolderTree } from './folderImport';
import { cleanPath, isJunkEntry, normalizeTagList } from './importHelpers';
import { blobKey, isoDay, untitledEntryTitle } from './journalImport';
import { linkifyLiteralText } from './linkify';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';
import { mediaTooLargeWarning, zipEntryMedia, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:diaro.${key}`, options);

/**
 * Diaro importer.
 *
 * Reads Diaro's unencrypted backup archive (.zip from Settings > Data >
 * Backup & restore > + > Create backup file, containing `DiaroBackup.xml` and
 * `media/photo/<filename>`) or a bare `DiaroBackup.xml` / `.drxml` file.
 * Encrypted backups (`DiaroBackup.denc` inside a .zip or a bare `.denc` file)
 * are detected and refused with instructions to export unencrypted.
 *
 * Format facts come from real backups made in the importer lab on Diaro
 * Android 4.30.1 (`skills/importer-lab/apps/diaro.md`):
 *
 *   <data version="2"> holding <table name="..."> with <r> rows:
 *     diaro_entries     -> uid, date (epoch ms), tz_offset (±HH:MM), title,
 *                          text (plain text), folder_uid, location_uid,
 *                          tags (",uid1,uid2,"), primary_photo_uid,
 *                          weather_temperature ("null" when unset, "0" valid),
 *                          weather_icon, weather_description, mood ("0" unset)
 *     diaro_folders     -> uid, title (flat folders -> PrivacyNotes folders)
 *     diaro_tags        -> uid, title (normalized note tags)
 *     diaro_moods       -> uid, title, weight (5 Awesome .. 1 Awful -> 10,7,5,3,1)
 *     diaro_locations   -> uid, title, address, lat, lng -> trackers.location
 *                          (name-only or 0,0 locations stay in the top info line)
 *     diaro_attachments -> uid, entry_uid, type, filename, position (1-based)
 *                          resolved under media/<type>/<filename>
 */

const MAX_XML_BYTES = 64 * 1024 * 1024;
const DOCTYPE_OR_ENTITY_RE = /<!(?:DOCTYPE|ENTITY)\b/i;

/** Diaro mood weight (1 Awful .. 5 Awesome) mapped onto our 1-10 mood scale. */
const WEIGHT_MOOD = new Map<number, number>([
  [1, 1],
  [2, 3],
  [3, 5],
  [4, 7],
  [5, 10],
]);

/** Default titles for Diaro's five built-in moods, used to detect custom/renamed moods. */
const DEFAULT_MOOD_TITLES = new Map<string, string>([
  ['1', 'awesome'],
  ['2', 'happy'],
  ['3', 'neutral'],
  ['4', 'bad'],
  ['5', 'awful'],
]);

type Row = Map<string, string>;

/** Clean an XML field value, treating Diaro's literal `"null"` string as empty. */
function cleanField(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  return trimmed.toLowerCase() === 'null' ? '' : trimmed;
}

interface Stamp {
  iso: string;
  day: string;
  wall: Date;
}

/** Parse Diaro's epoch milliseconds and `±HH:MM` tz_offset into UTC ISO and entry-local calendar day. */
function readStamp(rawDate: string, rawOffset: string): Stamp | null {
  const s = rawDate.trim();
  if (!/^-?\d{1,16}$/.test(s)) return null;
  const ms = Number(s);
  if (!Number.isSafeInteger(ms)) return null;
  const instant = new Date(ms);
  const utcYear = instant.getUTCFullYear();
  if (Number.isNaN(utcYear) || utcYear < 1900 || utcYear > 2200) return null;

  let y = utcYear;
  let mo = instant.getUTCMonth() + 1;
  let d = instant.getUTCDate();

  const m = /^([+-])(\d{2}):(\d{2})$/.exec(rawOffset.trim());
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    if (hh <= 23 && mm <= 59) {
      const shifted = new Date(ms + sign * (hh * 60 + mm) * 60_000);
      y = shifted.getUTCFullYear();
      mo = shifted.getUTCMonth() + 1;
      d = shifted.getUTCDate();
    }
  }

  const day = isoDay(y, mo, d);
  if (!day) return null;
  return { iso: instant.toISOString(), day, wall: new Date(y, mo - 1, d, 12, 0, 0) };
}

/** Convert Diaro plain text into Markdown that renders the exact same characters, with bare URLs linked. */
function plainToMarkdown(text: string): { markdown: string; linkified: boolean } {
  let linkified = false;
  const markdown = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const res = linkifyLiteralText(line, escapeMarkdownText);
      if (res.links > 0) linkified = true;
      return guardMarkdownLineStart(res.markdown);
    })
    .join('\n')
    .trim();
  return { markdown, linkified };
}

function buildLocationLabel(title: string, address: string): string {
  const parts = [title, address].map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }
  return unique.join(', ');
}

function buildWeatherText(row: Row): string {
  const desc = cleanField(row.get('weather_description'));
  const rawTemp = cleanField(row.get('weather_temperature'));
  const temp = rawTemp !== '' ? Number(rawTemp) : NaN;
  const parts: string[] = [];
  if (desc) parts.push(desc);
  if (Number.isFinite(temp)) {
    const rounded = Math.round(temp * 10) / 10;
    parts.push(`${rounded === 0 ? 0 : rounded} °C`);
  }
  return parts.join(', ');
}

function resolveMood(
  rawMood: string,
  moods: Map<string, Row>,
): { score?: number; customLabel?: string } {
  const uid = cleanField(rawMood);
  if (!uid || uid === '0') return {};

  const row = moods.get(uid);
  let score: number | undefined;
  const rawWeight = cleanField(row?.get('weight'));
  const weight = rawWeight ? Number(rawWeight) : NaN;
  const weightScore = Number.isInteger(weight) ? WEIGHT_MOOD.get(weight) : undefined;
  if (weightScore !== undefined) {
    score = weightScore;
  } else {
    const numId = Number(uid);
    const fallbackWeight = Number.isInteger(numId) ? 6 - numId : NaN;
    score = WEIGHT_MOOD.get(fallbackWeight);
  }

  const title = cleanField(row?.get('title'));
  const defaultTitle = DEFAULT_MOOD_TITLES.get(uid);
  const customLabel = title && title.toLowerCase() !== defaultTitle ? title : undefined;
  return { ...(score !== undefined ? { score } : {}), ...(customLabel ? { customLabel } : {}) };
}

interface MediaIndex {
  byPath: Map<string, JSZip.JSZipObject>;
  byName: Map<string, JSZip.JSZipObject>;
}

function findMediaEntry(index: MediaIndex | null, type: string, filename: string): JSZip.JSZipObject | undefined {
  if (!index) return undefined;
  const safeName = cleanPath(filename);
  if (!safeName) return undefined;
  const safeType = cleanPath(type || 'photo') ?? 'photo';
  const primary = `media/${safeType}/${safeName}`.toLowerCase();
  const hit = index.byPath.get(primary);
  if (hit) return hit;
  const alt = `media/photo/${safeName}`.toLowerCase();
  const hitPhoto = index.byPath.get(alt);
  if (hitPhoto) return hitPhoto;
  const base = safeName.split('/').pop()?.toLowerCase();
  return base ? index.byName.get(base) : undefined;
}

async function readSource(file: File): Promise<{ xml: string; media: MediaIndex | null }> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.denc')) {
    throw new Error(msg('encrypted'));
  }

  if (lowerName.endsWith('.xml') || lowerName.endsWith('.drxml')) {
    if (file.size > MAX_XML_BYTES) throw new Error(msg('tooLarge'));
    return { xml: await file.text(), media: null };
  }

  let zip: JSZip;
  try {
    zip = await openZip(await file.arrayBuffer());
  } catch {
    throw new Error(msg('notDiaro'));
  }

  let xmlEntry: JSZip.JSZipObject | null = null;
  let hasEncrypted = false;
  const byPath = new Map<string, JSZip.JSZipObject>();
  const byName = new Map<string, JSZip.JSZipObject>();

  zip.forEach((rawPath, entry) => {
    if (entry.dir || isJunkEntry(rawPath)) return;
    const clean = cleanPath(rawPath);
    if (!clean) return;
    const lower = clean.toLowerCase();
    const base = lower.split('/').pop() ?? '';

    if (base === 'diarobackup.denc' || base.endsWith('.denc')) {
      hasEncrypted = true;
      return;
    }
    if (base === 'diarobackup.xml' || (!xmlEntry && (base.endsWith('.xml') || base.endsWith('.drxml')))) {
      if (base === 'diarobackup.xml' || !xmlEntry) xmlEntry = entry;
      return;
    }
    const mediaIdx = lower.indexOf('media/');
    if (mediaIdx >= 0) {
      const rel = lower.slice(mediaIdx);
      byPath.set(rel, entry);
    }
    if (base && !byName.has(base)) byName.set(base, entry);
  });

  if (!xmlEntry) {
    if (hasEncrypted) throw new Error(msg('encrypted'));
    throw new Error(msg('noXml'));
  }

  const xml = await zipEntryText(xmlEntry);
  return { xml, media: { byPath, byName } };
}

function parseTables(xml: string): Map<string, Row[]> {
  const cleaned = xml.replace(/^\uFEFF/, '');
  if (!cleaned.trim()) throw new Error(msg('notDiaro'));
  if (DOCTYPE_OR_ENTITY_RE.test(cleaned)) throw new Error(msg('notDiaro'));

  const doc = new DOMParser().parseFromString(cleaned, 'application/xml');
  if (doc.querySelector('parsererror') || !doc.documentElement) {
    throw new Error(msg('notDiaro'));
  }

  const root = doc.documentElement;
  const tables = new Map<string, Row[]>();
  for (const child of Array.from(root.children)) {
    if (child.tagName !== 'table') continue;
    const name = (child.getAttribute('name') ?? '').trim();
    if (!name) continue;
    const rows = tables.get(name) ?? [];
    for (const item of Array.from(child.children)) {
      if (item.tagName !== 'r') continue;
      const fields: Row = new Map();
      for (const field of Array.from(item.children)) {
        fields.set(field.tagName, field.textContent ?? '');
      }
      rows.push(fields);
    }
    tables.set(name, rows);
  }
  return tables;
}

function indexByUid(rows: Row[] | undefined): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const row of rows ?? []) {
    const uid = cleanField(row.get('uid'));
    if (uid && !out.has(uid)) out.set(uid, row);
  }
  return out;
}

export async function parseDiaro(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(msg('reading'));
  const { xml, media } = await readSource(file);
  const tables = parseTables(xml);

  const rawEntries = tables.get('diaro_entries');
  if (!rawEntries) throw new Error(msg('notDiaro'));
  if (rawEntries.length === 0) throw new Error(msg('noEntries'));

  const foldersByUid = indexByUid(tables.get('diaro_folders'));
  const tagsByUid = indexByUid(tables.get('diaro_tags'));
  const moodsByUid = indexByUid(tables.get('diaro_moods'));
  const locationsByUid = indexByUid(tables.get('diaro_locations'));

  const attachmentsByEntry = new Map<string, Array<{ row: Row; order: number }>>();
  let attachOrder = 0;
  for (const row of tables.get('diaro_attachments') ?? []) {
    const entryUid = cleanField(row.get('entry_uid'));
    if (!entryUid) continue;
    const list = attachmentsByEntry.get(entryUid) ?? [];
    list.push({ row, order: attachOrder++ });
    attachmentsByEntry.set(entryUid, list);
  }

  const blobs = new Map<string, ImportBlob>();
  const notes: ImportedNote[] = [];

  let moods = 0;
  let places = 0;
  let photos = 0;
  let files = 0;
  let missing = 0;
  let tooLarge = 0;
  let untitled = 0;
  let skipped = 0;
  let linkifiedNotes = 0;

  for (let i = 0; i < rawEntries.length; i++) {
    const row = rawEntries[i]!;
    if (i % 25 === 0) {
      onProgress?.(i18n.t('importLog:appleJournal.readingEntry', { current: i + 1, total: rawEntries.length }));
    }

    const when = readStamp(row.get('date') ?? '', row.get('tz_offset') ?? '');
    if (!when) {
      skipped++;
      continue;
    }

    const uid = cleanField(row.get('uid'));
    const rawTitle = (row.get('title') ?? '').replace(/\s+/g, ' ').trim();
    const title = rawTitle || untitledEntryTitle(when.wall);
    if (!rawTitle) untitled++;

    const rawText = row.get('text') ?? '';
    const { markdown: bodyText, linkified } = rawText ? plainToMarkdown(rawText) : { markdown: '', linkified: false };
    if (linkified) linkifiedNotes++;

    const moodInfo = resolveMood(row.get('mood') ?? '', moodsByUid);
    if (moodInfo.score !== undefined) moods++;

    const locRow = locationsByUid.get(cleanField(row.get('location_uid')));
    const locLabel = locRow ? buildLocationLabel(cleanField(locRow.get('title')), cleanField(locRow.get('address'))) : '';
    const loc = locRow ? importedLocation(cleanField(locRow.get('lat')), cleanField(locRow.get('lng')), locLabel) : undefined;
    if (loc) places++;

    const infoParts: string[] = [];
    if (moodInfo.customLabel) infoParts.push(escapeMarkdownText(moodInfo.customLabel));
    const weather = buildWeatherText(row);
    if (weather) infoParts.push(escapeMarkdownText(weather));
    if (!loc && locLabel) infoParts.push(escapeMarkdownText(locLabel));

    const mediaLines: string[] = [];
    const entryAtts = [...(attachmentsByEntry.get(uid) ?? [])].sort((a, b) => {
      const pa = Number(cleanField(a.row.get('position')));
      const pb = Number(cleanField(b.row.get('position')));
      const na = Number.isFinite(pa) ? pa : Number.MAX_SAFE_INTEGER;
      const nb = Number.isFinite(pb) ? pb : Number.MAX_SAFE_INTEGER;
      return na !== nb ? na - nb : a.order - b.order;
    });

    for (const { row: att } of entryAtts) {
      const filename = cleanField(att.get('filename'));
      const type = cleanField(att.get('type')) || 'photo';
      if (!filename) {
        missing++;
        continue;
      }
      const entry = findMediaEntry(media, type, filename);
      if (!entry) {
        missing++;
        continue;
      }
      const data = await zipEntryMedia(entry);
      if (!data) {
        tooLarge++;
        continue;
      }
      const name = (cleanPath(filename)?.split('/').pop() ?? filename).trim() || 'file';
      const mime = mimeFromExtOrBytes(name, data);
      const key = blobKey('diaroblob', blobs.size);
      blobs.set(key, { data, mime, name });
      if (mime.startsWith('image/')) {
        mediaLines.push(`![](${key})`);
        photos++;
      } else {
        mediaLines.push(`[${name.replace(/[[\]]/g, '')}](${key})`);
        files++;
      }
    }

    const blocks: string[] = [];
    if (infoParts.length > 0) blocks.push(infoParts.join(' · '));
    if (bodyText) blocks.push(bodyText);
    if (mediaLines.length > 0) blocks.push(mediaLines.join('\n\n'));

    const rawTags = (row.get('tags') ?? '')
      .split(',')
      .map((t) => cleanField(t))
      .filter(Boolean)
      .map((tagUid) => cleanField(tagsByUid.get(tagUid)?.get('title')))
      .filter(Boolean);
    const tags = normalizeTagList(rawTags);

    const folderRow = foldersByUid.get(cleanField(row.get('folder_uid')));
    const folderTitle = cleanField(folderRow?.get('title')).replace(/\//g, '-').trim();
    const folderPath = folderTitle ? [folderTitle] : undefined;

    notes.push({
      title,
      body: blocks.join('\n\n'),
      tags,
      createdAt: when.iso,
      updatedAt: when.iso,
      type: 'journal',
      ...(folderPath ? { folderPath } : {}),
      trackers: {
        journalDate: when.day,
        ...(moodInfo.score !== undefined ? { mood: moodInfo.score } : {}),
        ...(loc ? { [LOCATION_KEY]: loc } : {}),
      },
    });
  }

  if (notes.length === 0) throw new Error(msg('noEntries'));

  let folders: ParsedImport['folders'];
  const dirPaths = [...new Set(notes.map((n) => (n.folderPath ?? []).join('/')).filter(Boolean))];
  if (dirPaths.length > 0) {
    const built = buildFolderTree(dirPaths);
    folders = built.folders;
    for (const n of notes) n.folderId = built.dirToFolderId.get((n.folderPath ?? []).join('/')) ?? null;
  }

  const warnings: string[] = [];
  if (missing > 0) warnings.push(msg(media ? 'missingAttachments' : 'noAttachmentsInXml', { count: missing }));
  if (tooLarge > 0) warnings.push(mediaTooLargeWarning(tooLarge));
  if (skipped > 0) warnings.push(msg('skipped', { count: skipped }));

  const transforms = [i18n.t('importLog:shared.importedJournalEntries', { count: notes.length })];
  if (folders && folders.length > 0) transforms.push(msg('rebuiltFolders', { count: folders.length }));
  if (moods > 0) transforms.push(i18n.t('importLog:daylio.filledMoods', { count: moods }));
  if (places > 0) transforms.push(i18n.t('importLog:shared.places', { count: places }));
  if (photos > 0) transforms.push(i18n.t('importLog:shared.foundPhotos', { count: photos }));
  if (files > 0) transforms.push(msg('foundFiles', { count: files }));
  if (untitled > 0) transforms.push(i18n.t('importLog:daylio.untitled', { count: untitled }));
  if (linkifiedNotes > 0) transforms.push(i18n.t('importLog:shared.linkifiedNotes', { count: linkifiedNotes }));

  let blobBytes = 0;
  for (const b of blobs.values()) blobBytes += b.data.length;

  return {
    notes,
    warnings,
    transforms,
    source: 'diaro',
    ...(blobs.size > 0 ? { blobs, blobBytes } : {}),
    ...(folders && folders.length > 0 ? { folders } : {}),
  };
}
