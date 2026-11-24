import type JSZip from 'jszip';
import i18n from '../i18n';
import { LOCATION_KEY, importedLocation } from '../noteLocation';
import { withBareLinks } from './bareLinks';
import { mimeFromExtOrBytes } from './blobImport';
import { mapOutsideCode, stripHtmlComments } from './codeSegments';
import { detailsToFold } from './detailsFold';
import { buildFolderTree } from './folderImport';
import { cleanPath, escapeScriptTags, isJunkEntry, normalizeTagList, noteLink, num, str } from './importHelpers';
import { blobKey, isoDay, untitledEntryTitle } from './journalImport';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';
import { mediaTooLargeWarning, zipEntryMedia, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:dayOne.${key}`, options);

/**
 * Day One importer.
 *
 * Reads Day One's JSON export (.zip with `<Journal>.json` plus `photos/`,
 * `videos/`, `audios/`, `pdfs/` folders, or a single bare `.json` file).
 * Multi-journal archives (Mac/iOS "Export All Journals", holding multiple
 * `.json` files) rebuild one folder per journal; a single-journal export
 * stays flat.
 *
 * Format facts come from real exports made in the importer lab (Day One Web
 * 2026.22.2 at dayone.me; `skills/importer-lab/apps/day-one.md`):
 *
 *   creationDate + timeZone -> local calendar day (`trackers.journalDate`)
 *   leading `# Heading`     -> entry title (else `untitledEntryTitle`)
 *   text (Markdown)         -> body; unwraps `[t](<url>)`, unescapes Day One's
 *                              backslash-escaped bare URLs (`\_` -> `_`),
 *                              converts `<details>` to fold callouts
 *   dayone-moment://<id>    -> embedded photo/video/audio/PDF matched by
 *                              `identifier` to `<folder>/<md5>.<type>` in zip
 *   dayone://view?entryId=  -> note-link `[[Title|label]]` across entries
 *   starred / isPinned      -> `starred: true`
 *   tags                    -> normalized note tags
 *   location                -> `trackers.location` with place label
 *   weather, userActivity,
 *   music                   -> compact info line at the top of the body
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];

type MediaKind = 'photo' | 'video' | 'audio' | 'pdf';

interface DayOneAsset {
  kind: MediaKind;
  identifier: string;
  md5: string;
  ext: string;
  name: string;
}

const FOLDER_FOR_KIND = new Map<MediaKind, string>([
  ['photo', 'photos'],
  ['video', 'videos'],
  ['audio', 'audios'],
  ['pdf', 'pdfs'],
]);

// Bounded patterns to avoid quadratic backtracking on hostile input.
const MOMENT_RE = /!\[([^\]]{0,500})\]\(<?dayone-moment:\/\/(?:(photo|video|audio|pdfAttachment)\/)?([A-Za-z0-9-]{1,128})>?\)/gi;
const ENTRY_LINK_RE = /\[([^\]]{0,500})\]\(<?dayone:\/\/view\?entryId=([A-Za-z0-9-]{1,128})>?\)/gi;
const ANGLE_LINK_RE = /\[([^\]]{0,500})\]\(<(https?:\/\/[^\s<>]{1,2000})>\)/gi;
const ESCAPED_URL_RE = /https?:\/\/[^\s<>()[\]]{1,2000}/gi;

interface ValidStamp {
  iso: string;
  day: string;
  wall: Date;
}

/** Validate an ISO timestamp and compute the entry's local calendar day in its IANA timeZone. */
function readCreationDate(raw: string, timeZone: string): ValidStamp | null {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms) || ms < Date.UTC(1900, 0, 1) || ms > Date.now() + 2 * 86_400_000) return null;
  const date = new Date(ms);
  const iso = date.toISOString();
  let y = date.getUTCFullYear();
  let mo = date.getUTCMonth() + 1;
  let d = date.getUTCDate();
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { // date-ok: IANA zone calendar day extraction (YYYY-MM-DD), not user display
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const py = Number(parts.find((p) => p.type === 'year')?.value);
      const pm = Number(parts.find((p) => p.type === 'month')?.value);
      const pd = Number(parts.find((p) => p.type === 'day')?.value);
      if (isoDay(py, pm, pd)) {
        y = py;
        mo = pm;
        d = pd;
      }
    } catch {
      /* unknown timeZone: keep UTC day */
    }
  }
  const day = isoDay(y, mo, d);
  if (!day) return null;
  return { iso, day, wall: new Date(y, mo - 1, d, 12, 0, 0) };
}

function validIsoOr(raw: string, fallback: string): string {
  if (!raw) return fallback;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms) || ms < Date.UTC(1900, 0, 1) || ms > Date.now() + 2 * 86_400_000) return fallback;
  return new Date(ms).toISOString();
}

/** Extract leading H1 (`# Title`) when it is the first non-empty line. */
function splitHeadingTitle(text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first++;
  const line = lines[first];
  if (line !== undefined) {
    const m = /^#\s+(.+?)\s*#*$/.exec(line);
    if (m && m[1]!.trim()) {
      const rest = lines.slice(first + 1);
      while (rest.length > 0 && rest[0]!.trim() === '') rest.shift();
      return { title: m[1]!.trim(), body: rest.join('\n') };
    }
  }
  return { title: '', body: lines.slice(first).join('\n') };
}

function readAssets(e: Json): DayOneAsset[] {
  const out: DayOneAsset[] = [];
  const pushList = (raw: unknown, kind: MediaKind, defaultExt: string) => {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!isObj(item)) continue;
      const identifier = str(item.identifier).trim();
      const md5 = str(item.md5).trim();
      if (!identifier && !md5) continue;
      const rawType = str(item.type).trim().toLowerCase().replace(/^\./, '');
      const ext = rawType || defaultExt;
      const pdfName = kind === 'pdf' ? str(item.pdfName).trim() : '';
      const base = pdfName || `${md5 || identifier}.${ext}`;
      const name = base.toLowerCase().endsWith(`.${ext}`) || !ext ? base : `${base}.${ext}`;
      out.push({ kind, identifier, md5, ext, name });
    }
  };
  pushList(e.photos, 'photo', 'jpeg');
  pushList(e.videos, 'video', 'mp4');
  pushList(e.audios, 'audio', 'm4a');
  pushList(e.pdfAttachments, 'pdf', 'pdf');
  return out;
}

function buildInfoLine(e: Json): string {
  const parts: string[] = [];
  if (isObj(e.weather)) {
    const w = e.weather;
    const desc = str(w.conditionsDescription).trim();
    const temp = num(w.temperatureCelsius) ?? num(w.tempCelsius);
    const wParts: string[] = [];
    if (desc) wParts.push(desc);
    if (temp !== null) wParts.push(`${Math.round(temp * 10) / 10} °C`);
    if (wParts.length > 0) parts.push(wParts.join(', '));
  }
  if (isObj(e.userActivity)) {
    const a = e.userActivity;
    const name = str(a.activityName).trim();
    const steps = num(a.stepCount);
    if (name && steps && steps > 0) parts.push(`${name} (${Math.round(steps).toLocaleString('en-US')} steps)`);
    else if (name) parts.push(name);
    else if (steps && steps > 0) parts.push(`${Math.round(steps).toLocaleString('en-US')} steps`);
  }
  if (isObj(e.music)) {
    const m = e.music;
    const track = str(m.track).trim();
    const artist = str(m.artist).trim();
    if (track && artist) parts.push(`${track} - ${artist}`);
    else if (track) parts.push(track);
  }
  return parts.join(' · ');
}

function buildLocationLabel(loc: Json): string {
  const raw = [
    str(loc.placeName),
    str(loc.localityName) || str(loc.locality),
    str(loc.administrativeArea),
    str(loc.country),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of raw) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }
  return unique.join(', ');
}

interface MediaIndex {
  byPath: Map<string, JSZip.JSZipObject>;
  byStem: Map<string, JSZip.JSZipObject>;
}

function findMediaEntry(index: MediaIndex | null, asset: DayOneAsset): JSZip.JSZipObject | undefined {
  if (!index) return undefined;
  const folder = FOLDER_FOR_KIND.get(asset.kind) ?? 'photos';
  const md5 = asset.md5.toLowerCase();
  const id = asset.identifier.toLowerCase();
  const ext = asset.ext.toLowerCase();
  const candidates = [
    md5 && ext ? `${folder}/${md5}.${ext}` : '',
    md5 && ext === 'jpeg' ? `${folder}/${md5}.jpg` : '',
    md5 && ext === 'jpg' ? `${folder}/${md5}.jpeg` : '',
    id && ext ? `${folder}/${id}.${ext}` : '',
  ].filter(Boolean);
  for (const p of candidates) {
    const hit = index.byPath.get(p);
    if (hit) return hit;
  }
  if (md5) {
    const stemHit = index.byStem.get(`${folder}/${md5}`);
    if (stemHit) return stemHit;
  }
  if (id) {
    const idHit = index.byStem.get(`${folder}/${id}`);
    if (idHit) return idHit;
  }
  return undefined;
}

interface JournalSource {
  journalName: string;
  entries: Json[];
}

async function readJournals(file: File): Promise<{ journals: JournalSource[]; media: MediaIndex | null }> {
  const parseDoc = (text: string): Json[] => {
    let doc: unknown;
    try {
      doc = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      throw new Error(msg('notDayOne'));
    }
    if (!isObj(doc) || !Array.isArray(doc.entries)) throw new Error(msg('notDayOne'));
    return doc.entries.filter(isObj);
  };

  if (/\.json$/i.test(file.name)) {
    if (file.size > 256 * 1024 * 1024) throw new Error(msg('notDayOne'));
    const stem = file.name.replace(/\.json$/i, '').trim() || 'Journal';
    return { journals: [{ journalName: stem, entries: parseDoc(await file.text()) }], media: null };
  }

  let zip: JSZip;
  try {
    zip = await openZip(await file.arrayBuffer());
  } catch {
    throw new Error(msg('notDayOne'));
  }

  const jsonEntries: Array<{ name: string; entry: JSZip.JSZipObject }> = [];
  const byPath = new Map<string, JSZip.JSZipObject>();
  const byStem = new Map<string, JSZip.JSZipObject>();

  zip.forEach((rawPath, entry) => {
    if (entry.dir || isJunkEntry(rawPath)) return;
    const clean = cleanPath(rawPath);
    if (!clean) return;
    const lower = clean.toLowerCase();
    const mediaMatch = /(?:^|\/)(photos|videos|audios|pdfs)\/([^/]+)$/.exec(lower);
    if (mediaMatch) {
      const folder = mediaMatch[1]!;
      const fname = mediaMatch[2]!;
      const rel = `${folder}/${fname}`;
      byPath.set(rel, entry);
      const dot = fname.lastIndexOf('.');
      const stem = dot > 0 ? fname.slice(0, dot) : fname;
      if (!byStem.has(`${folder}/${stem}`)) byStem.set(`${folder}/${stem}`, entry);
      return;
    }
    if (/(?:^|\/)debug\//.test(lower)) return;
    if (/\.json$/i.test(lower)) {
      const base = clean.split('/').pop() ?? 'Journal.json';
      jsonEntries.push({ name: base.replace(/\.json$/i, '').trim() || 'Journal', entry });
    }
  });

  if (jsonEntries.length === 0) throw new Error(msg('noJson'));

  const journals: JournalSource[] = [];
  for (const j of jsonEntries) {
    journals.push({ journalName: j.name, entries: parseDoc(await zipEntryText(j.entry)) });
  }
  return { journals, media: { byPath, byStem } };
}

function cleanDayOneMarkdown(raw: string): string {
  const folded = detailsToFold(raw);
  return mapOutsideCode(folded, (prose) => {
    let out = stripHtmlComments(prose);
    // Unwrap Day One's `<url>` inside `[label](<url>)` when no whitespace or unbalanced parens.
    out = out.replace(ANGLE_LINK_RE, (whole, label: string, url: string) => {
      const unescaped = url.replace(/\\([_\-.~!()])/g, '$1');
      if (/\s/.test(unescaped)) return whole;
      return `[${label}](${unescaped})`;
    });
    // Unescape Day One's backslash-escaped characters inside bare URLs (`https://example.org/dayone\_test`).
    out = out.replace(ESCAPED_URL_RE, (url) => url.replace(/\\([_\-.~!])/g, '$1'));
    // Escape raw `<script` tags so literal typed script tags never reach HTML parsing raw.
    out = escapeScriptTags(out);
    return out;
  });
}

export const parseDayOne = withBareLinks(readDayOne);

async function readDayOne(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(msg('reading'));
  const { journals, media } = await readJournals(file);
  const multiJournal = journals.length > 1;

  interface FlatEntry {
    journalName: string;
    e: Json;
    when: ValidStamp;
    title: string;
    bodyWithoutTitle: string;
    untitled: boolean;
  }

  const valid: FlatEntry[] = [];
  let totalRaw = 0;

  for (const j of journals) {
    for (const e of j.entries) {
      totalRaw++;
      const creationRaw = str(e.creationDate);
      const when = readCreationDate(creationRaw, str(e.timeZone));
      if (!when) continue;
      if (!('text' in e) && !('richText' in e) && !('uuid' in e)) continue;
      const { title, body } = splitHeadingTitle(str(e.text));
      const untitled = !title;
      valid.push({
        journalName: j.journalName,
        e,
        when,
        title: title || untitledEntryTitle(when.wall),
        bodyWithoutTitle: body,
        untitled,
      });
    }
  }

  if (valid.length === 0) throw new Error(totalRaw > 0 ? msg('notDayOne') : msg('noEntries'));

  const byUuid = new Map<string, string>();
  for (const item of valid) {
    const id = str(item.e.uuid).trim().toLowerCase();
    if (id && !byUuid.has(id)) byUuid.set(id, item.title);
  }

  const blobs = new Map<string, ImportBlob>();
  let photos = 0;
  let files = 0;
  let missing = 0;
  let tooLarge = 0;
  let places = 0;
  let starredCount = 0;
  let links = 0;
  let brokenLinks = 0;
  let untitledCount = 0;
  const skipped = totalRaw - valid.length;

  const notes: ImportedNote[] = [];

  for (let i = 0; i < valid.length; i++) {
    const item = valid[i]!;
    const { e, when } = item;
    if (i % 25 === 0) onProgress?.(i18n.t('importLog:appleJournal.readingEntry', { current: i + 1, total: valid.length }));
    if (item.untitled) untitledCount++;

    const assets = readAssets(e);
    const assetById = new Map<string, DayOneAsset>();
    for (const a of assets) {
      if (a.identifier) assetById.set(a.identifier.toLowerCase(), a);
      if (a.md5 && !assetById.has(a.md5.toLowerCase())) assetById.set(a.md5.toLowerCase(), a);
    }

    const referenced = new Set<string>();
    const resolvedCache = new Map<string, { key: string; isImage: boolean; name: string } | 'missing' | 'tooLarge'>();

    const resolveAsset = async (asset: DayOneAsset): Promise<{ key: string; isImage: boolean; name: string } | 'missing' | 'tooLarge'> => {
      const cacheKey = `${asset.kind}:${asset.identifier || asset.md5}`.toLowerCase();
      const cached = resolvedCache.get(cacheKey);
      if (cached) return cached;
      const entry = findMediaEntry(media, asset);
      if (!entry) {
        missing++;
        resolvedCache.set(cacheKey, 'missing');
        return 'missing';
      }
      const data = await zipEntryMedia(entry);
      if (!data) {
        tooLarge++;
        resolvedCache.set(cacheKey, 'tooLarge');
        return 'tooLarge';
      }
      const mime = mimeFromExtOrBytes(asset.name, data);
      const key = blobKey('doblob', blobs.size);
      blobs.set(key, { data, mime, name: asset.name });
      const isImage = asset.kind === 'photo' && mime.startsWith('image/');
      if (isImage) photos++;
      else files++;
      const res = { key, isImage, name: asset.name };
      resolvedCache.set(cacheKey, res);
      return res;
    };

    // Pass 1: find every `dayone-moment://` placeholder outside code and resolve its blob asynchronously.
    let body = cleanDayOneMarkdown(item.bodyWithoutTitle);
    const momentTokens: Array<{ placeholder: string; replacement: string }> = [];
    const seenPlaceholders = new Map<string, string>();
    const matches = [...body.matchAll(MOMENT_RE)];
    for (const m of matches) {
      const full = m[0];
      if (seenPlaceholders.has(full)) continue;
      const alt = (m[1] ?? '').trim();
      const rawKind = (m[2] ?? '').toLowerCase();
      const id = (m[3] ?? '').toLowerCase();
      const kind: MediaKind =
        rawKind === 'video' ? 'video' : rawKind === 'audio' ? 'audio' : rawKind === 'pdfattachment' ? 'pdf' : 'photo';
      const asset = assetById.get(id) ?? { kind, identifier: id, md5: id, ext: '', name: `${id}.${kind === 'pdf' ? 'pdf' : 'bin'}` };
      referenced.add(id);
      if (asset.identifier) referenced.add(asset.identifier.toLowerCase());
      if (asset.md5) referenced.add(asset.md5.toLowerCase());

      const res = await resolveAsset(asset);
      let replacement = '';
      if (res !== 'missing' && res !== 'tooLarge') {
        replacement = res.isImage
          ? `![${alt}](${res.key})`
          : `[${(alt || res.name).replace(/[[\]]/g, '')}](${res.key})`;
      }
      seenPlaceholders.set(full, replacement);
      momentTokens.push({ placeholder: full, replacement });
    }

    if (momentTokens.length > 0) {
      body = mapOutsideCode(body, (prose) =>
        prose.replace(MOMENT_RE, (full) => seenPlaceholders.get(full) ?? ''),
      );
    }

    // Pass 2: append any entry media not referenced inline in `text`.
    const extraMedia: string[] = [];
    for (const asset of assets) {
      const idKey = asset.identifier.toLowerCase();
      const md5Key = asset.md5.toLowerCase();
      if ((idKey && referenced.has(idKey)) || (md5Key && referenced.has(md5Key))) continue;
      const res = await resolveAsset(asset);
      if (res === 'missing' || res === 'tooLarge') continue;
      extraMedia.push(res.isImage ? `![](${res.key})` : `[${res.name.replace(/[[\]]/g, '')}](${res.key})`);
    }

    // Pass 3: resolve `dayone://view?entryId=<UUID>` links into note-links.
    body = mapOutsideCode(body, (prose) =>
      prose.replace(ENTRY_LINK_RE, (_all, label: string, targetUuid: string) => {
        const target = byUuid.get(targetUuid.toLowerCase());
        if (!target) {
          brokenLinks++;
          return label;
        }
        links++;
        return noteLink(target, label);
      }),
    );

    const blocks: string[] = [];
    const info = buildInfoLine(e);
    if (info) blocks.push(info);
    if (body.trim()) blocks.push(body.trim());
    if (extraMedia.length > 0) blocks.push(extraMedia.join('\n\n'));

    const loc = isObj(e.location)
      ? importedLocation(e.location.latitude, e.location.longitude, buildLocationLabel(e.location))
      : undefined;
    if (loc) places++;

    const isStarred = e.starred === true || e.isPinned === true;
    if (isStarred) starredCount++;

    const tags = normalizeTagList(strings(e.tags));
    const folderPath = multiJournal ? [item.journalName.replace(/\//g, '-')] : undefined;

    notes.push({
      title: item.title,
      body: blocks.join('\n\n'),
      tags,
      createdAt: when.iso,
      updatedAt: validIsoOr(str(e.modifiedDate), when.iso),
      type: 'journal',
      ...(isStarred ? { starred: true } : {}),
      ...(folderPath ? { folderPath } : {}),
      trackers: {
        journalDate: when.day,
        ...(loc ? { [LOCATION_KEY]: loc } : {}),
      },
    });
  }

  let folders: ParsedImport['folders'];
  if (multiJournal) {
    const dirPaths = [...new Set(notes.map((n) => (n.folderPath ?? []).join('/')).filter(Boolean))];
    const built = buildFolderTree(dirPaths);
    folders = built.folders;
    for (const n of notes) n.folderId = built.dirToFolderId.get((n.folderPath ?? []).join('/')) ?? null;
  }

  const warnings: string[] = [];
  if (missing > 0) warnings.push(msg(media ? 'missingAttachments' : 'noAttachmentsInJson', { count: missing }));
  if (tooLarge > 0) warnings.push(mediaTooLargeWarning(tooLarge));
  if (skipped > 0) warnings.push(msg('skipped', { count: skipped }));
  if (brokenLinks > 0) warnings.push(msg('brokenLinks', { count: brokenLinks }));

  const transforms = [i18n.t('importLog:shared.importedJournalEntries', { count: notes.length })];
  if (folders && folders.length > 0) transforms.push(msg('journalsAsFolders', { count: folders.length }));
  if (starredCount > 0) transforms.push(i18n.t('importLog:shared.keptStarred', { count: starredCount }));
  if (places > 0) transforms.push(i18n.t('importLog:shared.places', { count: places }));
  if (photos > 0) transforms.push(i18n.t('importLog:shared.foundPhotos', { count: photos }));
  if (files > 0) transforms.push(msg('foundFiles', { count: files }));
  if (links > 0) transforms.push(msg('entryLinks', { count: links }));
  if (untitledCount > 0) transforms.push(msg('untitled', { count: untitledCount }));

  let blobBytes = 0;
  for (const b of blobs.values()) blobBytes += b.data.length;

  return {
    notes,
    warnings,
    transforms,
    source: 'day-one',
    ...(blobs.size > 0 ? { blobs, blobBytes } : {}),
    ...(folders && folders.length > 0 ? { folders } : {}),
  };
}
