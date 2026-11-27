/**
 * Raindrop.io importer: the CSV of a backup (All bookmarks > Export > Get
 * backup, then Settings > Backups) or of one collection (Export > CSV), bare
 * or inside a collection's export ZIP (which also holds `export.html` and
 * `export.txt`). The CSV is the only Raindrop
 * file that keeps the excerpt and the highlights; the HTML keeps only the
 * note and imports through the browser bookmarks row.
 *
 * Format facts from a real export made in the web app: columns `id,title,
 * note,excerpt,url,folder,tags,created,cover,highlights,favorite`. `folder` is the collection path joined with
 * " / ", `Unsorted` for Raindrop's inbox. `tags` joined with ", " (Raindrop
 * splits a tag at a comma when it saves, so the join is safe). `highlights`
 * is blocks split by a blank line, each `Highlight:<text>` and an optional
 * `\nSticky notes:<note>`; the color is not in the file.
 *
 * Mapping: one bookmark per row, under the same "Bookmarks" root the browser
 * importer uses. The note (Markdown, as typed), the excerpt and the
 * highlights become the bookmark's notes. A favorite is starred. Covers are
 * left out with a warning: the app shows each site's icon instead.
 * Spec: docs/internal/specs/bookmarks-pillar.md (section 10)
 */

import { buildLinkBody, linkDomain, updateLinkBody } from '../linkBody';
import { escapeMarkdownText, guardMarkdownLineStart } from '../markdownEscape';
import i18n from '../i18n';
import { buildFolderTree } from './folderImport';
import { cleanPath, isJunkEntry, normalizeTagList } from './importHelpers';
import { linkifyLiteralText, linkifyMarkdown } from './linkify';
import { readCsvTable } from './passwordCsv';
import { openZip } from './zipOpen';
import { zipEntryText } from './zipEntry';
import type { ImportedNote, ParsedImport } from './types';

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:raindrop.${key}`, options);

/** The root every imported bookmark lands under, as in browserBookmarks.ts. */
const ROOT_FOLDER = 'Bookmarks';
/** Raindrop's inbox. Its bookmarks go to the root, not a folder of that name. */
const UNSORTED = 'Unsorted';
const COLUMNS = ['title', 'url', 'folder'];

/** Plain text kept as the same characters in Markdown, bare URLs linked. */
function plainToMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => guardMarkdownLineStart(linkifyLiteralText(line, escapeMarkdownText).markdown))
    .join('\n');
}

/** `Highlight:<text>` blocks, each with its optional sticky note. */
export function parseHighlights(cell: string): Array<{ text: string; note: string }> {
  const out: Array<{ text: string; note: string }> = [];
  for (const block of cell.split(/\n\n(?=Highlight:)/)) {
    if (!block.startsWith('Highlight:')) continue;
    const rest = block.slice('Highlight:'.length);
    const at = rest.indexOf('\nSticky notes:');
    const text = (at < 0 ? rest : rest.slice(0, at)).trim();
    const note = at < 0 ? '' : rest.slice(at + '\nSticky notes:'.length).trim();
    if (text) out.push({ text, note });
  }
  return out;
}

/** The bookmark's notes: Raindrop's note, the excerpt, then the highlights. */
function raindropNotes(note: string, excerpt: string, highlights: Array<{ text: string; note: string }>): string {
  const parts: string[] = [];
  if (note.trim()) parts.push(linkifyMarkdown(note.trim()));
  if (excerpt.trim()) parts.push(plainToMarkdown(excerpt.trim()));
  if (highlights.length > 0) {
    parts.push(`## ${msg('highlightsHeading')}`);
    for (const h of highlights) {
      parts.push(plainToMarkdown(h.text).split('\n').map((l) => `> ${l}`).join('\n'));
      if (h.note) parts.push(plainToMarkdown(h.note));
    }
  }
  return parts.join('\n\n');
}

/** An ISO date the file gives, or null when it is missing or impossible. */
function isoOrNull(raw: string): string | null {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms) || ms <= 0 || ms > Date.now() + 86_400_000) return null;
  return new Date(ms).toISOString();
}

async function csvFile(file: File): Promise<File> {
  if (!/\.zip$/i.test(file.name)) return file;
  const zip = await openZip(file);
  const entry = Object.values(zip.files).find((e) => {
    if (e.dir || isJunkEntry(e.name)) return false;
    const path = cleanPath(e.name);
    return path !== null && !isJunkEntry(path) && /(^|\/)[^/]*\.csv$/i.test(path);
  });
  if (!entry) throw new Error(msg('noCsv'));
  return new File([await zipEntryText(entry)], 'export.csv', { type: 'text/csv' });
}

export async function parseRaindrop(file: File): Promise<ParsedImport> {
  const { rows, col } = await readCsvTable(await csvFile(file));
  if (COLUMNS.some((c) => col(c) < 0)) throw new Error(msg('notRaindrop'));
  const cell = (row: string[], name: string) => {
    const i = col(name);
    return i < 0 ? '' : (row[i] ?? '');
  };

  const now = new Date().toISOString();
  const notes: ImportedNote[] = [];
  let skipped = 0;
  let covers = 0;
  for (const row of rows) {
    const url = cell(row, 'url').trim();
    if (!/^https?:\/\//i.test(url)) {
      skipped++;
      continue;
    }
    try {
      void new URL(url);
    } catch {
      skipped++;
      continue;
    }
    // Raindrop stores the URL as the title of a bookmark with none.
    const rawTitle = cell(row, 'title').trim();
    const title = rawTitle === url || rawTitle === linkDomain(url) ? '' : rawTitle;
    const text = raindropNotes(cell(row, 'note'), cell(row, 'excerpt'), parseHighlights(cell(row, 'highlights')));
    const body = text ? updateLinkBody(buildLinkBody(url), { notes: text }) : buildLinkBody(url);
    const tags = normalizeTagList(cell(row, 'tags').split(','));
    const created = isoOrNull(cell(row, 'created')) ?? now;
    const folder = cell(row, 'folder').trim();
    const segments = folder && folder !== UNSORTED ? folder.split(' / ').map((s) => s.trim().replace(/\//g, '-')).filter(Boolean) : [];
    if (cell(row, 'cover').trim()) covers++;
    notes.push({
      title,
      body,
      tags,
      createdAt: created,
      updatedAt: created,
      type: 'link',
      folderPath: [ROOT_FOLDER, ...segments],
      ...(cell(row, 'favorite').trim().toLowerCase() === 'true' ? { starred: true } : {}),
    });
  }
  // The browser importer's wording: the same refusal.
  if (notes.length === 0) throw new Error(i18n.t('importLog:browserBookmarks.noBookmarks'));

  const warnings: string[] = [];
  if (skipped > 0) warnings.push(msg('skipped', { count: skipped }));
  if (covers > 0) warnings.push(msg('covers', { count: covers }));

  const dirPaths = [...new Set(notes.map((n) => (n.folderPath ?? []).join('/')))];
  const { folders, dirToFolderId } = buildFolderTree(dirPaths);
  for (const n of notes) n.folderId = dirToFolderId.get((n.folderPath ?? []).join('/')) ?? null;

  return {
    notes,
    warnings,
    transforms: [],
    source: 'raindrop',
    folders,
  };
}
