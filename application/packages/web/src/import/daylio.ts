import type JSZip from 'jszip';
import i18n from '../i18n';
import { linkifyMarkdown } from './linkify';
import { mediaTooLargeWarning, zipEntryMedia, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';
import { mimeFromExtOrBytes } from './blobImport';
import { htmlNoteToMarkdown } from './notesnook';
import { readCsvTable } from './passwordCsv';
import { ImportedFactors, blobKey, isoDay, untitledEntryTitle } from './journalImport';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';
import { cleanPath, num, str } from './importHelpers';

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:daylio.${key}`, options);

/**
 * Daylio importer.
 *
 * The primary input is the backup file (More > Backup & Restore > Advanced
 * Options > Export): a zip holding `backup.daylio`, which is the base64 of one
 * JSON document, and the photos and voice memos under `assets/`. The entry
 * names in that zip start with a slash. The fallback is the CSV of More >
 * Export Entries, which has no ids, no mood groups and no attachments.
 *
 * Format facts come from a real export made in the importer lab (the
 * app file of the importer-lab skill); Daylio is closed source.
 *
 *   dayEntries[]       -> one journal entry each, several on a day allowed
 *   mood -> customMoods[].mood_group_id 1..5 (1 best) -> mood 10, 7, 5, 3, 1;
 *                         a mood the person named or renamed opens the body
 *   tags[] (activities) -> factors, the activity group kept on new factors
 *   scaleValues[]      -> a list at the end of the body (text, number, time)
 *   note_title, note   -> title and body; the note is HTML
 *   assets[]           -> photos as pictures, voice memos as files
 *   isFavorite         -> starred
 *   goals, milestones  -> not imported, counted in a warning
 *
 * Daylio does not escape a quick note: typed `<b>` is stored as markup and
 * imports as bold. The converter drops script and unsafe markup.
 * Spec: docs/internal/issues/0494.md (Spec)
 */

/** Daylio's five mood groups, best first, on our 1-10 mood scale. */
const GROUP_MOOD: Record<number, number> = { 1: 10, 2: 7, 3: 5, 4: 3, 5: 1 };

/** The default English mood names of the CSV, which carries no group. */
const CSV_MOOD: Record<string, number> = { rad: 10, good: 7, meh: 5, bad: 3, awful: 1 };

/** Biggest backup document we decode: the shared text cap, in base64 characters. */
const BASE64_MAX = 256 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function decodeBase64Json(text: string): unknown {
  const b64 = text.replace(/\s+/g, '');
  if (b64.length > BASE64_MAX) throw new Error(msg('tooLarge'));
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error(msg('notBackup'));
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch {
    throw new Error(msg('notBackup'));
  }
}

interface Counters {
  photos: number;
  audio: number;
  missing: number;
  tooLarge: number;
  moods: number;
  namedMoods: number;
  factors: number;
  scales: number;
  untitled: number;
  skippedEntries: number;
}

function newCounters(): Counters {
  return { photos: 0, audio: 0, missing: 0, tooLarge: 0, moods: 0, namedMoods: 0, factors: 0, scales: 0, untitled: 0, skippedEntries: 0 };
}

/** The body: a named mood first, then the note, the scales and the media. */
function assemble(moodName: string, note: string, scales: string[], media: string[]): string {
  const blocks: string[] = [];
  if (moodName) blocks.push(moodName);
  if (note.trim()) blocks.push(note.trim());
  if (scales.length > 0) blocks.push(scales.map((s) => `- ${s}`).join('\n'));
  if (media.length > 0) blocks.push(media.join('\n\n'));
  return linkifyMarkdown(blocks.join('\n\n'));
}

const MARK_TAGS = 'b,strong,i,em,u,s,strike,del';
const BLOCK_TAGS = 'div,p,ul,ol,li,blockquote,pre,table,h1,h2,h3,h4,h5,h6';

/** Wrap every run of inline children of `parent` in a copy of `mark`, and go
 *  into each block child to do the same there. */
function wrapRuns(parent: Node, mark: Element): void {
  let run: Node[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const wrap = mark.cloneNode(false);
    run[0]!.parentNode!.insertBefore(wrap, run[0]!);
    for (const n of run) wrap.appendChild(n);
    run = [];
  };
  for (const child of Array.from(parent.childNodes)) {
    if (child instanceof Element && child.matches(BLOCK_TAGS)) {
      flush();
      wrapRuns(child, mark);
    } else if (child instanceof Element && child.tagName === 'BR') {
      // A line break ends a run, so each line carries its own mark.
      flush();
    } else {
      run.push(child);
    }
  }
  flush();
}

/**
 * Daylio's editor can leave a mark open across lists and lines
 * (`<u>text<ul>...</ul><div>...</div></u>`), which no Markdown can say. The
 * mark moves down into each block it covers, so every line keeps it.
 */
function liftMarks(html: string): string {
  if (!/<(b|strong|i|em|u|s|strike|del)\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const spanning = Array.from(doc.body.querySelectorAll(MARK_TAGS)).filter((el) => el.querySelector(BLOCK_TAGS));
  for (const el of spanning.reverse()) {
    const template = el.cloneNode(false) as Element;
    wrapRuns(el, template);
    el.replaceWith(...Array.from(el.childNodes));
  }
  return doc.body.innerHTML;
}

function noteToMarkdown(html: string): string {
  return html.trim() ? htmlNoteToMarkdown(liftMarks(html)) : '';
}

function minutesText(total: number): string {
  const m = Math.max(0, Math.round(total));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** One scale value as a line, in Daylio's own words: "Energy: High (4/5)". */
function scaleLine(scale: Json, value: Json): string | null {
  const name = str(scale.name).trim();
  if (!name) return null;
  const textId = num(value.id_text_scale_value);
  if (textId !== null && isObj(scale.text_scale)) {
    const points = arr(scale.text_scale.values).filter(isObj);
    const at = points.findIndex((p) => num(p.id) === textId);
    if (at >= 0) return `${name}: ${str(points[at]!.name)} (${at + 1}/${points.length})`;
  }
  const n = num(value.number_value);
  if (n !== null) {
    const max = isObj(scale.number_scale) ? num(scale.number_scale.max) : null;
    return max !== null ? `${name}: ${n}/${max}` : `${name}: ${n}`;
  }
  const t = num(value.time_value);
  if (t !== null) return `${name}: ${minutesText(t)}`;
  return null;
}

async function parseBackup(zip: JSZip, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  const files = new Map<string, JSZip.JSZipObject>();
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const clean = cleanPath(path);
    if (clean) files.set(clean, entry);
  });
  const backupEntry = [...files.entries()].find(([p]) => p.split('/').pop() === 'backup.daylio')?.[1];
  if (!backupEntry) throw new Error(msg('notBackup'));

  onProgress?.(msg('readingBackup'));
  const doc = decodeBase64Json(await zipEntryText(backupEntry));
  if (!isObj(doc) || !Array.isArray(doc.dayEntries)) throw new Error(msg('notBackup'));

  // The asset files, by the checksum Daylio names them with.
  const assetFiles = new Map<string, JSZip.JSZipObject>();
  for (const [p, entry] of files) {
    if (p.startsWith('assets/')) assetFiles.set(p.split('/').pop() ?? '', entry);
  }
  const assets = new Map<number, Json>();
  for (const a of arr(doc.assets).filter(isObj)) {
    const id = num(a.id);
    if (id !== null) assets.set(id, a);
  }
  const moods = new Map<number, Json>();
  for (const m of arr(doc.customMoods).filter(isObj)) {
    const id = num(m.id);
    if (id !== null) moods.set(id, m);
  }
  const groups = new Map<number, string>();
  for (const g of arr(doc.tag_groups).filter(isObj)) {
    const id = num(g.id);
    if (id !== null) groups.set(id, str(g.name));
  }
  const tags = new Map<number, { name: string; group: string }>();
  for (const t of arr(doc.tags).filter(isObj)) {
    const id = num(t.id);
    const gid = num(t.id_tag_group);
    if (id !== null) tags.set(id, { name: str(t.name), group: gid !== null ? groups.get(gid) ?? '' : '' });
  }
  const scales = new Map<number, Json>();
  for (const s of arr(doc.scales).filter(isObj)) {
    const id = num(s.id);
    if (id !== null) scales.set(id, s);
  }

  const counters = newCounters();
  const factors = new ImportedFactors();
  const blobs = new Map<string, ImportBlob>();
  const notes: ImportedNote[] = [];
  const entries = doc.dayEntries.filter(isObj);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (i % 25 === 0) onProgress?.(i18n.t('importLog:appleJournal.readingEntry', { current: i + 1, total: entries.length }));
    const y = num(e.year), mo = num(e.month), d = num(e.day);
    const day = y !== null && mo !== null && d !== null ? isoDay(y, mo + 1, d) : null;
    if (!day) {
      counters.skippedEntries++;
      continue;
    }
    const hour = num(e.hour) ?? 12;
    const minute = num(e.minute) ?? 0;
    const wall = new Date(y!, mo!, d!, hour, minute);
    const stamp = num(e.datetime);
    const when = stamp !== null && Math.abs(stamp) < 8.64e15 ? new Date(stamp) : wall;

    // The mood: its group is the score; a name the person gave it opens the body.
    let mood: number | undefined;
    let moodName = '';
    const moodDef = moods.get(num(e.mood) ?? -1);
    if (moodDef) {
      const group = num(moodDef.mood_group_id) ?? 0;
      mood = Object.hasOwn(GROUP_MOOD, group) ? GROUP_MOOD[group] : undefined;
      moodName = str(moodDef.custom_name).trim();
      if (mood !== undefined) counters.moods++;
      if (moodName) counters.namedMoods++;
    }

    const factorIds: string[] = [];
    for (const tid of arr(e.tags)) {
      const tag = typeof tid === 'number' ? tags.get(tid) : undefined;
      if (!tag) continue;
      const fid = factors.id(tag.name, tag.group);
      if (fid && !factorIds.includes(fid)) factorIds.push(fid);
    }
    if (factorIds.length > 0) counters.factors++;

    const scaleLines: string[] = [];
    for (const v of arr(e.scaleValues).filter(isObj)) {
      const s = scales.get(num(v.id_scale) ?? -1);
      const line = s ? scaleLine(s, v) : null;
      if (line) scaleLines.push(line);
    }
    if (scaleLines.length > 0) counters.scales++;

    const media: string[] = [];
    for (const aid of arr(e.assets)) {
      const a = typeof aid === 'number' ? assets.get(aid) : undefined;
      const entry = a ? assetFiles.get(str(a.checksum)) : undefined;
      if (!a || !entry) {
        counters.missing++;
        continue;
      }
      let meta: Json = {};
      try {
        const parsed: unknown = JSON.parse(str(a.android_metadata) || '{}');
        if (isObj(parsed)) meta = parsed;
      } catch {
        // A broken name costs the original file name, not the file.
      }
      const audio = num(a.type) === 2;
      const name = str(meta.Name).replace(/[/\\]/g, '_') || (audio ? 'voice-memo.mp4' : 'photo.jpg');
      const data = await zipEntryMedia(entry);
      if (!data) {
        counters.tooLarge++;
        continue;
      }
      const key = blobKey('dlblob', blobs.size);
      if (audio) {
        blobs.set(key, { data, mime: 'audio/mp4', name });
        media.push(`[${name}](${key})`);
        counters.audio++;
      } else {
        blobs.set(key, { data, mime: mimeFromExtOrBytes(name, data), name });
        media.push(`![](${key})`);
        counters.photos++;
      }
    }

    let title = str(e.note_title).replace(/\s+/g, ' ').trim();
    if (!title) {
      title = untitledEntryTitle(wall);
      counters.untitled++;
    }

    notes.push({
      title,
      body: assemble(moodName, noteToMarkdown(str(e.note)), scaleLines, media),
      tags: [],
      createdAt: when.toISOString(),
      updatedAt: when.toISOString(),
      type: 'journal',
      ...(e.isFavorite === true ? { starred: true } : {}),
      trackers: {
        journalDate: day,
        ...(mood !== undefined ? { mood } : {}),
        ...(factorIds.length > 0 ? { factors: factorIds } : {}),
      },
    });
  }

  if (notes.length === 0) throw new Error(msg('noEntries'));

  const warnings: string[] = [];
  if (counters.missing > 0) warnings.push(msg('missingAssets', { count: counters.missing }));
  if (counters.tooLarge > 0) warnings.push(mediaTooLargeWarning(counters.tooLarge));
  if (counters.skippedEntries > 0) warnings.push(msg('badDates', { count: counters.skippedEntries }));
  const goals = arr(doc.goals).length;
  if (goals > 0) warnings.push(msg('skippedGoals', { count: goals }));
  const days = arr(doc.milestones).length;
  if (days > 0) warnings.push(msg('skippedImportantDays', { count: days }));

  const added = factors.added();
  const transforms = summary(notes.length, counters, added.length);
  return result(notes, warnings, transforms, blobs, added);
}

function summary(entries: number, c: Counters, newFactors: number): string[] {
  const out = [i18n.t('importLog:shared.importedJournalEntries', { count: entries })];
  if (c.moods > 0) out.push(msg('filledMoods', { count: c.moods }));
  if (c.namedMoods > 0) out.push(msg('namedMoods', { count: c.namedMoods }));
  if (c.factors > 0) out.push(msg('filledFactors', { count: c.factors }));
  if (newFactors > 0) out.push(msg('newFactors', { count: newFactors }));
  if (c.scales > 0) out.push(msg('keptScales', { count: c.scales }));
  if (c.photos > 0) out.push(i18n.t('importLog:shared.foundPhotos', { count: c.photos }));
  if (c.audio > 0) out.push(msg('foundAudio', { count: c.audio }));
  if (c.untitled > 0) out.push(msg('untitled', { count: c.untitled }));
  return out;
}

function result(notes: ImportedNote[], warnings: string[], transforms: string[], blobs: Map<string, ImportBlob>, added: ReturnType<ImportedFactors['added']>): ParsedImport {
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
    source: 'daylio',
    ...(blobs.size > 0 ? { blobs, blobBytes } : {}),
    ...(added.length > 0 ? { settings: { factors: added } } : {}),
  };
}

/** "1:31 PM" or "13:31" as hours and minutes, or null. */
function csvTime(raw: string): [number, number] | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([ap]\.?\s*m\.?)?\s*$/i.exec(raw);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toLowerCase().replace(/[.\s]/g, '');
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return h < 24 && min < 60 ? [h, min] : null;
}

async function parseCsvExport(file: File): Promise<ParsedImport> {
  const { header, rows, col } = await readCsvTable(file);
  if (!header.includes('full_date') || !header.includes('mood')) throw new Error(msg('notCsv'));
  const at = (row: string[], name: string) => {
    const i = col(name);
    return i >= 0 ? row[i] ?? '' : '';
  };

  const counters = newCounters();
  const factors = new ImportedFactors();
  const notes: ImportedNote[] = [];
  for (const row of rows) {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(at(row, 'full_date').trim());
    const day = dm ? isoDay(Number(dm[1]), Number(dm[2]), Number(dm[3])) : null;
    if (!dm || !day) {
      counters.skippedEntries++;
      continue;
    }
    const [h, min] = csvTime(at(row, 'time')) ?? [12, 0];
    const wall = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), h, min);

    // The CSV names the mood and drops its group: only the default names score.
    const moodName = at(row, 'mood').trim();
    const key = moodName.toLowerCase();
    const mood = Object.hasOwn(CSV_MOOD, key) ? CSV_MOOD[key] : undefined;
    if (mood !== undefined) counters.moods++;
    else if (moodName) counters.namedMoods++;

    const factorIds: string[] = [];
    for (const name of at(row, 'activities').split(' | ')) {
      const fid = name.replace(/ /g, ' ').trim() ? factors.id(name.replace(/ /g, ' ')) : null;
      if (fid && !factorIds.includes(fid)) factorIds.push(fid);
    }
    if (factorIds.length > 0) counters.factors++;

    const scaleLines = at(row, 'scales').split(' | ').map((s) => s.trim()).filter(Boolean);
    if (scaleLines.length > 0) counters.scales++;

    let title = at(row, 'note_title').replace(/\s+/g, ' ').trim();
    if (!title) {
      title = untitledEntryTitle(wall);
      counters.untitled++;
    }
    notes.push({
      title,
      body: assemble(mood === undefined ? moodName : '', noteToMarkdown(at(row, 'note')), scaleLines, []),
      tags: [],
      createdAt: wall.toISOString(),
      updatedAt: wall.toISOString(),
      type: 'journal',
      trackers: {
        journalDate: day,
        ...(mood !== undefined ? { mood } : {}),
        ...(factorIds.length > 0 ? { factors: factorIds } : {}),
      },
    });
  }
  if (notes.length === 0) throw new Error(msg('noEntries'));
  // The file is newest first; the import reads oldest first, as the backup does.
  notes.reverse();

  const warnings = [msg('csvLimits')];
  if (counters.skippedEntries > 0) warnings.push(msg('badDates', { count: counters.skippedEntries }));
  const added = factors.added();
  return result(notes, warnings, summary(notes.length, counters, added.length), new Map(), added);
}

export async function parseDaylio(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  if (/\.csv$/i.test(file.name)) return parseCsvExport(file);
  onProgress?.(i18n.t('importLog:shared.readingZip'));
  let zip: JSZip;
  try {
    zip = await openZip(await file.arrayBuffer());
  } catch {
    throw new Error(msg('notBackup'));
  }
  return parseBackup(zip, onProgress);
}
