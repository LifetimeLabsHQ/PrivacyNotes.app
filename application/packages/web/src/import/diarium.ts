import type JSZip from 'jszip';
import i18n from '../i18n';
import { normalizeTag } from '../notesRepo';
import { noteLinkTarget } from '../noteLinks';
import { LOCATION_KEY, importedLocation } from '../noteLocation';
import { linkifyMarkdown } from './linkify';
import { mediaTooLargeWarning, zipEntryMedia, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';
import { mimeFromExtOrBytes } from './blobImport';
import { htmlNoteToMarkdown } from './notesnook';
import { ImportedFactors, blobKey, isoDay, untitledEntryTitle } from './journalImport';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';
import { cleanPath } from './importHelpers';

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:diarium.${key}`, options);

/**
 * Diarium importer.
 *
 * Reads the JSON export (menu > Export > JSON): one array of entries, as a
 * bare .json, or in a .zip with the attachments under
 * `media/<date stamp>/<file>` when "Attachments" was ticked. "Create separate
 * file for each entry" writes one JSON per entry into the zip; all are read.
 * The .diary backup is SQLite and is not read here.
 *
 * Format facts come from a real export made in the importer lab (the
 * app file of the importer-lab skill); Diarium is closed source.
 *
 *   date (local, no zone)  -> the entry's day and time
 *   heading, html          -> title and body; the body is HTML
 *   rating 1..5            -> mood 1, 3, 5, 7, 10
 *   tags                   -> note tags and factors
 *   people                 -> factors, grouped as people
 *   tracker "Name: value"  -> a list at the end of the body
 *   location [lat, lon]    -> the entry's place
 *   weather, sun, lunar    -> one line at the top of the body
 *   attachments            -> pictures and files
 *   diarium://view?entryId=N links -> note-links; N is the entry date in .NET ticks
 *
 * Spec: docs/internal/issues/0494.md (Spec)
 */

/** Diarium's stars on our 1-10 mood scale. */
const STAR_MOOD: Record<number, number> = { 1: 1, 2: 3, 3: 5, 4: 7, 5: 10 };

/** .NET ticks at the Unix epoch. */
const EPOCH_TICKS = 621355968000000000n;

const ENTRY_LINK_RE = /<a\b[^>]*\bhref\s*=\s*["']diarium:\/\/view\?entryId=(\d{1,20})["'][^>]*>([\s\S]*?)<\/a>/gi;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);

interface Stamp {
  day: string;
  wall: Date;
  ticks: string;
}

/** "2026-11-12T14:13:23.8028977": the writer's local day, a local Date and the .NET ticks Diarium names the entry by. */
function readDate(raw: string): Stamp | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  const day = isoDay(y, mo, d);
  if (!day || h > 23 || mi > 59 || s > 59) return null;
  const frac = (m[7] ?? '').padEnd(7, '0');
  const ms = Number(frac.slice(0, 3));
  const ticks = BigInt(Date.UTC(y, mo - 1, d, h, mi, s)) * 10000n + BigInt(frac) + EPOCH_TICKS;
  return { day, wall: new Date(y, mo - 1, d, h, mi, s, ms), ticks: ticks.toString() };
}

interface Counters {
  moods: number;
  factors: number;
  trackers: number;
  places: number;
  photos: number;
  files: number;
  missing: number;
  tooLarge: number;
  links: number;
  brokenLinks: number;
  untitled: number;
  skipped: number;
}

async function readEntries(file: File): Promise<{ entries: Json[]; media: Map<string, JSZip.JSZipObject> | null }> {
  const media = new Map<string, JSZip.JSZipObject>();
  const parse = (text: string): Json[] => {
    let doc: unknown;
    try {
      doc = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      throw new Error(msg('notDiarium'));
    }
    return (Array.isArray(doc) ? doc : [doc]).filter(isObj);
  };
  if (/\.json$/i.test(file.name)) {
    if (file.size > 256 * 1024 * 1024) throw new Error(msg('notDiarium'));
    return { entries: parse(await file.text()), media: null };
  }
  let zip: JSZip;
  try {
    zip = await openZip(await file.arrayBuffer());
  } catch {
    throw new Error(msg('notDiarium'));
  }
  const entries: Json[] = [];
  const jsonFiles: JSZip.JSZipObject[] = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const clean = cleanPath(path);
    if (!clean) return;
    if (/\.json$/i.test(clean) && !clean.includes('/media/') && !clean.startsWith('media/')) jsonFiles.push(entry);
    else if (/(^|\/)media\//.test(clean)) media.set(clean.slice(clean.indexOf('media/')), entry);
  });
  if (jsonFiles.length === 0) throw new Error(msg('noJson'));
  for (const entry of jsonFiles) entries.push(...parse(await zipEntryText(entry)));
  return { entries, media };
}

export async function parseDiarium(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(msg('reading'));
  const { entries, media } = await readEntries(file);
  const valid = entries
    .map((e) => ({ e, when: readDate(str(e.date)) }))
    .filter((x): x is { e: Json; when: Stamp } => x.when !== null && 'date' in x.e && ('html' in x.e || 'heading' in x.e));
  if (valid.length === 0) throw new Error(entries.length > 0 ? msg('notDiarium') : msg('noEntries'));

  const c: Counters = { moods: 0, factors: 0, trackers: 0, places: 0, photos: 0, files: 0, missing: 0, tooLarge: 0, links: 0, brokenLinks: 0, untitled: 0, skipped: entries.length - valid.length };
  const factors = new ImportedFactors();
  const blobs = new Map<string, ImportBlob>();
  const allTags = new Set<string>();

  // Titles first: an entry link names the entry it points at by its ticks.
  const titles = valid.map(({ e, when }) => {
    const heading = str(e.heading).replace(/\s+/g, ' ').trim();
    if (heading) return heading;
    c.untitled++;
    return untitledEntryTitle(when.wall);
  });
  const byTicks = new Map<string, string>();
  valid.forEach(({ when }, i) => {
    if (!byTicks.has(when.ticks)) byTicks.set(when.ticks, titles[i]!);
  });

  const notes: ImportedNote[] = [];
  for (let i = 0; i < valid.length; i++) {
    const { e, when } = valid[i]!;
    if (i % 25 === 0) onProgress?.(i18n.t('importLog:appleJournal.readingEntry', { current: i + 1, total: valid.length }));

    // Entry links become placeholders the converter keeps, then note-links.
    const links: string[] = [];
    const html = str(e.html).replace(ENTRY_LINK_RE, (_all, ticks: string, label: string) => {
      links.push(`${ticks}\u0000${label.replace(/<[^>]*>/g, '').trim()}`);
      return `zzdiariumlink${links.length - 1}zz`;
    });
    let body = html.trim() ? htmlNoteToMarkdown(html) : '';
    body = body.replace(/zzdiariumlink(\d+)zz/g, (_m, n: string) => {
      const [ticks = '', label = ''] = (links[Number(n)] ?? '').split('\u0000');
      const target = byTicks.get(ticks);
      if (!target) {
        c.brokenLinks++;
        return label;
      }
      c.links++;
      const t = noteLinkTarget(target);
      const l = label.replace(/[[\]|]/g, ' ').trim();
      return !l || l === t ? `[[${t}]]` : `[[${t}|${l}]]`;
    });

    const info = [str(e.weather), str(e.sun), str(e.lunar)].map((s) => s.trim()).filter(Boolean);
    const trackerLines = strings(e.tracker).map((s) => s.trim());
    if (trackerLines.length > 0) c.trackers++;

    const mediaLines: string[] = [];
    for (const raw of strings(e.attachments)) {
      const path = cleanPath(raw);
      const entry = path && media ? media.get(path) : undefined;
      if (!entry) {
        c.missing++;
        continue;
      }
      const data = await zipEntryMedia(entry);
      if (!data) {
        c.tooLarge++;
        continue;
      }
      const name = path!.split('/').pop() ?? 'file';
      const mime = mimeFromExtOrBytes(name, data);
      const key = blobKey('diblob', blobs.size);
      blobs.set(key, { data, mime, name });
      if (mime.startsWith('image/')) {
        mediaLines.push(`![](${key})`);
        c.photos++;
      } else {
        mediaLines.push(`[${name}](${key})`);
        c.files++;
      }
    }

    const blocks: string[] = [];
    if (info.length > 0) blocks.push(info.join(' · '));
    if (body.trim()) blocks.push(body.trim());
    if (trackerLines.length > 0) blocks.push(trackerLines.map((t) => `- ${t}`).join('\n'));
    if (mediaLines.length > 0) blocks.push(mediaLines.join('\n\n'));

    const rating = typeof e.rating === 'number' ? e.rating : NaN;
    const mood = Object.hasOwn(STAR_MOOD, rating) ? STAR_MOOD[rating] : undefined;
    if (mood !== undefined) c.moods++;

    const tags = strings(e.tags).map((t) => normalizeTag(t)).filter(Boolean);
    for (const t of tags) allTags.add(t);
    const factorIds: string[] = [];
    for (const name of strings(e.tags)) {
      const id = factors.id(name);
      if (id && !factorIds.includes(id)) factorIds.push(id);
    }
    for (const name of strings(e.people)) {
      const id = factors.id(name, msg('peopleGroup'));
      if (id && !factorIds.includes(id)) factorIds.push(id);
    }
    if (factorIds.length > 0) c.factors++;

    const loc = Array.isArray(e.location) ? importedLocation(e.location[0], e.location[1]) : undefined;
    if (loc) c.places++;

    notes.push({
      title: titles[i]!,
      body: linkifyMarkdown(blocks.join('\n\n')),
      tags: [...new Set(tags)],
      createdAt: when.wall.toISOString(),
      updatedAt: when.wall.toISOString(),
      type: 'journal',
      trackers: {
        journalDate: when.day,
        ...(mood !== undefined ? { mood } : {}),
        ...(factorIds.length > 0 ? { factors: factorIds } : {}),
        ...(loc ? { [LOCATION_KEY]: loc } : {}),
      },
    });
  }

  const warnings: string[] = [];
  if (c.missing > 0) warnings.push(msg(media ? 'missingAttachments' : 'noAttachmentsInJson', { count: c.missing }));
  if (c.tooLarge > 0) warnings.push(mediaTooLargeWarning(c.tooLarge));
  if (c.skipped > 0) warnings.push(msg('skipped', { count: c.skipped }));
  if (c.brokenLinks > 0) warnings.push(msg('brokenLinks', { count: c.brokenLinks }));

  const added = factors.added();
  const transforms = [i18n.t('importLog:shared.importedJournalEntries', { count: notes.length })];
  if (c.moods > 0) transforms.push(msg('filledMoods', { count: c.moods }));
  if (c.factors > 0) transforms.push(msg('filledFactors', { count: c.factors }));
  if (added.length > 0) transforms.push(msg('newFactors', { count: added.length }));
  if (c.trackers > 0) transforms.push(msg('keptTrackers', { count: c.trackers }));
  if (c.places > 0) transforms.push(i18n.t('importLog:shared.places', { count: c.places }));
  if (c.photos > 0) transforms.push(i18n.t('importLog:shared.foundPhotos', { count: c.photos }));
  if (c.files > 0) transforms.push(msg('foundFiles', { count: c.files }));
  if (c.links > 0) transforms.push(msg('entryLinks', { count: c.links }));
  if (c.untitled > 0) transforms.push(msg('untitled', { count: c.untitled }));

  let blobBytes = 0;
  for (const b of blobs.values()) blobBytes += b.data.length;
  const tagged = notes.filter((n) => n.tags.length > 0).length;
  return {
    notes,
    warnings,
    transforms,
    stats: {
      totalNotes: notes.length,
      emptyNotes: notes.filter((n) => !n.body.trim()).length,
      untaggedNotes: notes.length - tagged,
      uniqueTags: allTags.size,
    },
    source: 'diarium',
    ...(blobs.size > 0 ? { blobs, blobBytes } : {}),
    ...(added.length > 0 ? { settings: { factors: added } } : {}),
  };
}
