/**
 * Capacities importer.
 *
 * Reads the zip from Capacities > Settings > Full Export > Manual Full
 * Export (or an automated full export). Format facts from a lab run
 * (Capacities 1.73.8, 2026-11-19, the importer lab app file for capacities):
 *
 * - `<Space>/<Object type folder>/<Title>.md`, media in `<type>/Media/`.
 *   Folders are the plural type names (`Pages`, `DailyNotes`, `Books`, ...).
 * - Every file opens with flat YAML front matter: `type`, `title`,
 *   `description`, `tags: [a, b]`, `createdAt`, `lastUpdated` (a daily note
 *   has `date`), then the object type's own properties, `null` when empty.
 *   A property whose key clashes with a built-in one gets a trailing `_`.
 * - Links are relative Markdown links to the target's file, or `[[Title]]`
 *   and `[[Title|label]]` with "Links as wikilinks". "Include title as
 *   heading 1" adds `# Title` as the first line.
 * - An embedded image is three lines: `![name](../Images/Media/x.png)`, a
 *   bold caption line, and a link to the image object's own file.
 * - Every list item is followed by a blank line, sublists are indented by
 *   four spaces.
 * - A table formula is written as its RESULT, never its text: a cell that
 *   holds `=SUM(C2:C3)` in Capacities is `3.5` in the export, and an error is
 *   its name (`Expression`, `Circular`). The formula itself is not in the zip.
 *   Text a person typed as `=B2*C2` on the free plan, where formulas are off,
 *   stays that text, and our table formulas compute it.
 * - The trash is not exported. Media objects (Image, PDF, ...) and queries
 *   are objects of their own; they become notes only when they hold text.
 */

import type JSZip from 'jszip';
import { openZip } from './zipOpen';
import { mediaTooLargeWarning, zipEntryText } from './zipEntry';
import { buildFolderTree } from './folderImport';
import { withBareLinks } from './bareLinks';
import { FileKeys, fileResolver, keyFileRefs, readKeyedFiles } from './fileRefs';
import { isBlobReferenced } from './blobImport';
import { mapOutsideCode } from './codeSegments';
import { cleanPath, isJunkEntry, isUnsafeUrl, normalizeTagList, noteLink, splitFrontMatter } from './importHelpers';
import { parseFrontMatterDate } from './markdown';
import { refusePrivacyNotesBackupZip } from './privacynotes';
import { escapeMarkdownText, guardMarkdownLineStart } from '../markdownEscape';
import type { ImportedNote, ParsedImport } from './types';
import i18n from '../i18n';

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:capacities.${key}`, options);

/** Front matter keys every object has; the rest are the type's own properties. */
const BUILT_IN = new Set([
  'type', 'title', 'aliases', 'description', 'icon', 'createdAt', 'lastUpdated', 'tags', 'coverImage', 'date', 'reviewed',
  'previewImage', 'source', 'url', 'numberOfPages', 'fileSize', 'tableOfContents', 'collections',
]);

/** Object types that are a file with a wrapper page, not a note. */
const MEDIA_TYPES = new Set(['Image', 'PDF', 'File', 'Audio', 'Video', 'MediaFile', 'MediaImage', 'MediaPDF', 'MediaAudio', 'MediaVideo']);

/** `[a, b]` or a single value, as tag names. */
function listValue(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  if (raw.length > 1) return raw;
  const v = raw[0]!.trim();
  if (v === 'null' || v === '') return [];
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return [v];
}

function scalar(raw: string[] | undefined): string {
  const v = (raw ?? []).join(', ').trim();
  return v === 'null' ? '' : v;
}

function formatFrontMatterUrl(raw: string): string {
  const clean = raw.replace(/[\r\n]+/g, ' ').trim();
  if (!clean || isUnsafeUrl(clean)) return '';
  if (/^https?:\/\/[^\s<>`\x00-\x1f\x7f]+$/i.test(clean)) return `<${clean}>`;
  return guardMarkdownLineStart(escapeMarkdownText(clean));
}

/** `readingTimeline` -> `Reading timeline`, `type_` -> `Type`. */
function propertyLabel(key: string): string {
  const words = key.replace(/_+$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * Capacities writes a blank line after every list item. Between two items
 * of one list it is dropped, so the list reads as one tight list.
 */
function tightenLists(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,}|\$\$)/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0]) fence = null;
      out.push(line);
      continue;
    }
    if (f) fence = f;
    if (line.trim() === '' && out.length && LIST_LINE.test(out[out.length - 1]!)) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === '') j++;
      // A bullet list right after a numbered one (or the reverse) is a new list: keep the gap.
      const kind = (l: string) => (/^\s*\d/.test(l) ? 'ol' : 'ul');
      let top = out.length - 1;
      while (top > 0 && /^\s/.test(out[top]!) && LIST_LINE.test(out[top - 1]!)) top--;
      const sameList = j < lines.length && LIST_LINE.test(lines[j]!) && (/^\s/.test(lines[j]!) || kind(lines[j]!) === kind(out[top]!));
      if (sameList) {
        i = j - 1;
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

interface Doc {
  path: string;
  dir: string;
  space: string;
  folder: string;
  type: string;
  title: string;
  values: Map<string, string[]>;
  body: string;
}

export const parseCapacities = withBareLinks(readCapacities);

async function readCapacities(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(i18n.t('importLog:shared.readingZip'));
  const zip = await openZip(file);
  await refusePrivacyNotesBackupZip(zip);
  const entries = new Map<string, JSZip.JSZipObject>();
  for (const e of Object.values(zip.files)) {
    if (e.dir) continue;
    const path = cleanPath(e.name);
    if (!path || isJunkEntry(path)) continue;
    entries.set(path, e);
  }
  const mdPaths = [...entries.keys()].filter((p) => /\.md$/i.test(p) && p.split('/').length >= 3).sort();

  const docs: Doc[] = [];
  for (const path of mdPaths) {
    const text = await zipEntryText(entries.get(path)!);
    const fm = splitFrontMatter(text);
    const type = scalar(fm.values.get('type'));
    if (!type) continue;
    const parts = path.split('/');
    docs.push({
      path,
      dir: parts.slice(0, -1).join('/'),
      space: parts[0]!,
      folder: parts[parts.length - 2]!,
      type,
      title: scalar(fm.values.get('title')),
      values: fm.values,
      body: fm.body,
    });
  }
  if (docs.length === 0) throw new Error(msg('notCapacities'));

  const nowMs = Date.now();
  const fileTime = file.lastModified && file.lastModified <= nowMs ? new Date(file.lastModified).toISOString() : new Date(nowMs).toISOString();
  const resolve = fileResolver(entries.keys());
  const titleByPath = new Map(docs.map((d) => [d.path, d.title]));
  const keys = new FileKeys('capfile');

  const counts = { queries: 0, media: 0, noteLinks: 0, deadLinks: 0, properties: 0, images: 0, collections: 0 };
  const spaces = new Set(docs.map((d) => d.space));
  const dirOf = (d: Doc): string => (spaces.size > 1 ? `${d.space}/${d.folder}` : d.folder);

  const kept: { doc: Doc; note: ImportedNote }[] = [];
  onProgress?.(i18n.t('importLog:shared.buildingNotes'));
  for (const d of docs) {
    if (d.type === 'Query') {
      counts.queries++;
      continue;
    }
    let body = d.body.replace(/^\n+/, '');
    // "Include title as heading 1".
    const h1 = /^# (.*)\n?/.exec(body);
    if (h1 && h1[1]!.trim() === d.title.trim()) body = body.slice(h1[0].length).replace(/^\n+/, '');

    if (MEDIA_TYPES.has(d.type)) {
      // The wrapper page of a picture or file: only its own text makes it a note.
      const rest = body.replace(/^Media: .*$/m, '').trim();
      if (!rest) {
        counts.media++;
        continue;
      }
    }

    body = mapOutsideCode(body, (prose) => {
      // An embedded image: the picture, its caption in bold, a link to the image object.
      let p = prose.replace(
        /^(!\[[^\]\n]*\]\([^)\n]+\))\n\*\*([^*\n]+)\*\*\n(?:\[[^\]\n]* - Notes\]\([^)\n]+\)|\[\[[^\]\n]*\| ?[^\]\n]* - Notes\]\])$/gm,
        (_w, img: string, caption: string) => {
          counts.images++;
          return img.replace(/^!\[[^\]\n]*\]/, `![${caption.replace(/[[\]]/g, '')}]`);
        },
      );
      p = p.replace(/^(!\[[^\]\n]*\]\([^)\n]+\))\n(?:\[[^\]\n]* - Notes\]\([^)\n]+\)|\[\[[^\]\n]*\| ?[^\]\n]* - Notes\]\])$/gm, (_w, img: string) => {
        counts.images++;
        return img;
      });
      // A link to another object's file becomes a note-link to its title.
      p = p.replace(/(?<!!)\[([^\]\n]*)\]\(([^)\s]+\.md)\)/g, (whole, label: string, target: string) => {
        const path = resolve(target, d.dir);
        if (path && titleByPath.has(path)) {
          const nl = noteLink(titleByPath.get(path)!, label);
          if (!nl.startsWith('[[')) return label;
          counts.noteLinks++;
          return nl;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
        counts.deadLinks++;
        return label;
      });
      // Wikilinks are already note-links; count them.
      counts.noteLinks += (p.match(/\[\[[^\]\n]+\]\]/g) ?? []).length;
      return p;
    });
    body = keyFileRefs(body, d.dir, resolve, keys);
    body = tightenLists(body).replace(/\n{3,}/g, '\n\n').trim();

    // The type's own properties, as a list above the text.
    const props: string[] = [];
    for (const [key, raw] of d.values) {
      if (BUILT_IN.has(key)) continue;
      const value = scalar(raw);
      if (!value || value === 'false') continue;
      props.push(value === 'true' ? `- [x] ${escapeMarkdownText(propertyLabel(key))}` : `- ${escapeMarkdownText(propertyLabel(key))}: ${escapeMarkdownText(value.replace(/\s+/g, ' '))}`);
    }
    if (props.length) counts.properties++;
    const description = scalar(d.values.get('description')).replace(/[\r\n]+/g, ' ').trim();
    const url = formatFrontMatterUrl(scalar(d.values.get('url')));
    const top = [props.join('\n'), description ? guardMarkdownLineStart(escapeMarkdownText(description)) : '', url].filter(Boolean);
    if (top.length) body = [...top, body].filter(Boolean).join('\n\n');

    const tags = normalizeTagList(listValue(d.values.get('tags')));
    const created = parseFrontMatterDate(scalar(d.values.get('createdAt'))) ?? parseFrontMatterDate(scalar(d.values.get('date'))) ?? fileTime;
    const updated = parseFrontMatterDate(scalar(d.values.get('lastUpdated'))) ?? created;
    const sane = (iso: string) => (Date.parse(iso) > nowMs + 86_400_000 ? fileTime : iso);
    kept.push({
      doc: d,
      note: {
        title: d.title,
        body,
        tags,
        createdAt: sane(created),
        updatedAt: sane(updated < created ? created : updated),
      },
    });
  }
  if (kept.length === 0) throw new Error(msg('noObjects'));

  const { folders, dirToFolderId } = buildFolderTree(kept.map((k) => dirOf(k.doc)));
  for (const { doc, note } of kept) {
    const dir = dirOf(doc);
    const folderId = dirToFolderId.get(dir);
    if (folderId) {
      note.folderId = folderId;
      note.folderPath = dir.split('/');
    }
  }
  const notes = kept.map((k) => k.note);

  const { blobs, tooLarge } = await readKeyedFiles(keys, entries, notes);
  for (const key of [...blobs.keys()]) if (!notes.some((n) => isBlobReferenced(key, n.body))) blobs.delete(key);
  counts.collections = [...entries.keys()].filter((p) => /\.csv$/i.test(p)).length;

  const transforms: string[] = [];
  const warnings: string[] = [];
  if (folders.length) transforms.push(msg('typeFolders', { count: folders.length }));
  if (counts.noteLinks) transforms.push(i18n.t('importLog:shared.noteLinks', { count: counts.noteLinks }));
  if (blobs.size) transforms.push(i18n.t('importLog:shared.attachments', { count: blobs.size }));
  if (counts.properties) transforms.push(msg('properties', { count: counts.properties }));
  const tagged = notes.filter((n) => n.tags.length).length;
  if (tagged) transforms.push(i18n.t('importLog:shared.tags', { count: tagged }));
  if (counts.media) transforms.push(msg('mediaObjects', { count: counts.media }));
  if (counts.queries) warnings.push(msg('queries', { count: counts.queries }));
  if (counts.collections) warnings.push(msg('collections', { count: counts.collections }));
  if (counts.deadLinks) warnings.push(msg('deadLinks', { count: counts.deadLinks }));
  if (tooLarge) warnings.push(mediaTooLargeWarning(tooLarge));

  const parsed: ParsedImport = {
    notes,
    warnings,
    transforms,
    source: 'capacities',
  };
  if (folders.length) parsed.folders = folders;
  if (blobs.size) {
    parsed.blobs = blobs;
    parsed.blobBytes = [...blobs.values()].reduce((sum, b) => sum + b.data.length, 0);
  }
  return parsed;
}
