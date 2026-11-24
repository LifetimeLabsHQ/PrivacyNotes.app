/**
 * Notion "Markdown & CSV" importer.
 *
 * Reads the `.zip` from Notion > Settings > General > Export > Workspace
 * content (or a single page's ... > More > Export) in "Markdown & CSV"
 * format. Format facts verified against a real Notion Web export (2026-11-24,
 * importer-lab app file `notion.md`):
 *
 * - Workspace exports may wrap one or more `ExportBlock-<uuid>-Part-N.zip`
 *   archives inside an outer `.zip`; inner zips are expanded one level.
 * - Exports typically wrap content under `Private & Shared/` (stripped when
 *   it is the single common root directory).
 * - Every exported `.md` file (and in older exports, folders too) carries a
 *   trailing 32-character hex ID (`Trip plan 1a2b3c4d...md`), which is
 *   stripped from note titles and folder names.
 * - Every `.md` file opens with `# <Title>`, holding the full untruncated
 *   title; stripped when it matches the file's clean title.
 * - Sub-pages live in a folder named after their parent page; that tree
 *   rebuilds into PrivacyNotes folders.
 * - Internal links are relative URL-encoded `.md` paths (Notion encodes
 *   spaces as `%20` while leaving `(1)`, `&` and `#` unencoded) or Notion
 *   web URLs carrying the 32-char hex ID. Both become `[[Title]]` note-links.
 * - Callouts export as `<aside>...</aside>` blocks; mapped to PrivacyNotes
 *   `> [!type]+` callouts. `<details><summary>` folds go through `detailsToFold`.
 * - Task items export with two spaces after `[ ]` / `[x]`; normalized to one.
 * - Underline exports as `<u>...</u>`, while typed `<script>` / `<b>` arrives
 *   unescaped; `<u>` pairs are preserved and all other raw tags go through
 *   `escapeTypedTags`.
 * - Databases export as `<Name> <id>.csv` (and `<Name> <id>_all.csv`) next to
 *   a folder of row `.md` pages. Row pages import into the database's folder
 *   (with leading `Tags:` properties added to `note.tags`), while the CSV
 *   table files are skipped with a warning.
 */

import type JSZip from 'jszip';
import { openZip } from './zipOpen';
import { mediaTooLargeWarning, zipEntryBytes, zipEntryText } from './zipEntry';
import { buildFolderTree, commonRootPrefix } from './folderImport';
import { withBareLinks } from './bareLinks';
import { FileKeys, fileResolver, keyFileRefs, readKeyedFiles } from './fileRefs';
import { isBlobReferenced } from './blobImport';
import { mapOutsideCode, mapOutsideFences } from './codeSegments';
import { detailsToFold } from './detailsFold';
import { cleanPath, escapeTypedTags, isJunkEntry, normalizeTagList, noteLink } from './importHelpers';
import { refusePrivacyNotesBackupZip } from './privacynotes';
import { isUntitledStem } from '../exportNames';
import type { ImportedNote, ParsedImport } from './types';
import i18n from '../i18n';

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:notion.${key}`, options);

const MAX_INNER_ZIPS = 20;
const NOTION_ID_SUFFIX = /[ _]([0-9a-f]{32})$/i;
const BARE_NOTION_ID = /^([0-9a-f]{32})$/i;
const NOTION_URL_ID = /^https?:\/\/(?:www\.|app\.)?notion\.(?:so|com|site)\/.*?(?:[/-]|^)([0-9a-f]{32})(?:[?#].*)?$/i;

/** Markdown link (not image); bare targets allow one level of paired parens (`(1)`). */
const MD_LINK = /(?<!!)\[([^\]\n]{0,1000})\]\((?:<([^>\n]{1,2048})>|((?:[^()\n]|\([^()\n]{0,512}\)){1,2048}))\)/g;

const ASIDE_BLOCK = /^[ \t]*<aside>[ \t]*\n([\s\S]*?)^[ \t]*<\/aside>[ \t]*$/gm;

/** Leading callout emoji -> PrivacyNotes callout keyword (`docs/contrib/callouts.md`). */
const CALLOUT_EMOJI: readonly [string, string][] = [
  ['💡', 'tip'],
  ['⚠️', 'warning'],
  ['⚠', 'warning'],
  ['ℹ️', 'info'],
  ['ℹ', 'info'],
  ['❗', 'important'],
  ['‼️', 'important'],
  ['⭐', 'important'],
  ['🌟', 'important'],
  ['🚨', 'danger'],
  ['🛑', 'danger'],
  ['🔥', 'danger'],
  ['✅', 'success'],
  ['✔️', 'success'],
  ['✔', 'success'],
  ['❌', 'failure'],
  ['✖️', 'failure'],
  ['🚫', 'failure'],
  ['🐛', 'bug'],
  ['❓', 'question'],
  ['❔', 'question'],
  ['📝', 'note'],
  ['📌', 'note'],
];

/** Strip Notion's trailing 32-char hex ID from a filename stem or folder name. */
export function stripNotionId(raw: string): { clean: string; id: string | null } {
  const m = NOTION_ID_SUFFIX.exec(raw);
  if (m) return { clean: raw.slice(0, m.index).trim(), id: m[1]!.toLowerCase() };
  const bare = BARE_NOTION_ID.exec(raw.trim());
  if (bare) return { clean: '', id: bare[1]!.toLowerCase() };
  return { clean: raw.trim(), id: null };
}

/** Normalize a Notion CSV filename (`Name <id>.csv` or `Name <id>_all.csv`). */
function parseCsvName(filename: string): { clean: string; id: string | null } {
  let stem = filename.replace(/\.csv$/i, '');
  if (/_all$/i.test(stem)) stem = stem.slice(0, -4);
  return stripNotionId(stem);
}

/** True when a leading `# h1` matches the filename stem (including Notion's ~50-char truncation or illegal-char replacement). */
function h1MatchesStem(h1: string, cleanStem: string): boolean {
  const a = h1.trim();
  const b = cleanStem.trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const sanitized = a.replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  if (sanitized === b) return true;
  if (b.length >= 16 && (a.startsWith(b) || sanitized.startsWith(b))) return true;
  return false;
}

/** Convert `<aside>...</aside>` Notion callouts outside fenced code into `> [!type]+` callouts. */
function convertAsides(md: string): { text: string; count: number } {
  if (!md.includes('<aside>')) return { text: md, count: 0 };
  let count = 0;
  const text = mapOutsideFences(md, (chunk) =>
    chunk.replace(ASIDE_BLOCK, (_whole, inner: string) => {
      count++;
      const trimmed = inner.replace(/^\n+|\n+$/g, '');
      if (!trimmed) return '> [!note]+';
      let keyword = 'note';
      let content = trimmed;
      for (const [emoji, type] of CALLOUT_EMOJI) {
        if (content.startsWith(emoji)) {
          keyword = type;
          content = content.slice(emoji.length).replace(/^[ \t]+/, '');
          break;
        }
      }
      const lines = content.split('\n').map((l) => (l.trim() ? `> ${l}` : '>'));
      return [`> [!${keyword}]+`, ...lines].join('\n');
    }),
  );
  return { text, count };
}

/** Preserve exact `<u>` / `</u>` underline tags while escaping all other raw HTML tags via `escapeTypedTags`. */
function escapeNonUnderlineHtml(md: string): string {
  if (!md.includes('<')) return md;
  const U_OPEN = '\uE000U_OPEN\uE001';
  const U_CLOSE = '\uE000U_CLOSE\uE001';
  const protectedMd = mapOutsideCode(md, (prose) =>
    prose.replace(/<u>([\s\S]*?)<\/u>/g, (_w, inner: string) => `${U_OPEN}${inner}${U_CLOSE}`),
  );
  const escaped = escapeTypedTags(protectedMd);
  return escaped.split(U_OPEN).join('<u>').split(U_CLOSE).join('</u>');
}

/** Extract comma-separated tags from a database row page's leading `Key: Value` property block. */
function extractDbRowTags(body: string): string[] {
  const lines = body.split('\n');
  const rawTags: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') break;
    const kv = /^([A-Za-z][A-Za-z0-9 _-]{0,40}):\s*(.+)$/.exec(line);
    if (!kv) break;
    if (/^tags?$/i.test(kv[1]!.trim())) {
      for (const part of kv[2]!.split(',')) {
        const t = part.trim();
        if (t) rawTags.push(t);
      }
    }
  }
  return normalizeTagList(rawTags);
}

/** Collect all cleaned non-junk file entries from a zip (expanding one level of nested Notion export zips). */
async function collectZipEntries(file: File): Promise<Map<string, JSZip.JSZipObject>> {
  const outer = await openZip(file);
  await refusePrivacyNotesBackupZip(outer);

  const readInto = (zip: JSZip, target: Map<string, JSZip.JSZipObject>) => {
    for (const e of Object.values(zip.files)) {
      if (e.dir) continue;
      const path = cleanPath(e.name);
      if (!path || isJunkEntry(path)) continue;
      if (!target.has(path)) target.set(path, e);
    }
  };

  const entries = new Map<string, JSZip.JSZipObject>();
  readInto(outer, entries);

  const hasMd = [...entries.keys()].some((p) => /\.md$/i.test(p));
  if (!hasMd) {
    const innerZips = [...entries.entries()].filter(([p]) => /\.zip$/i.test(p)).slice(0, MAX_INNER_ZIPS);
    if (innerZips.length > 0) {
      const merged = new Map<string, JSZip.JSZipObject>();
      for (const [path, entry] of innerZips) {
        const bytes = await zipEntryBytes(entry);
        const name = path.slice(path.lastIndexOf('/') + 1);
        const inner = await openZip(new File([bytes], name, { type: 'application/zip' }));
        await refusePrivacyNotesBackupZip(inner);
        readInto(inner, merged);
      }
      if (merged.size > 0) return merged;
    }
  }
  return entries;
}

interface NotionDoc {
  rawPath: string;
  rawDir: string;
  relDir: string;
  cleanFolderDir: string;
  notionId: string | null;
  title: string;
  body: string;
  isDbRow: boolean;
  entryDate: Date | null;
}

export const parseNotion = withBareLinks(readNotion);

async function readNotion(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(i18n.t('importLog:shared.readingZip'));
  const entries = await collectZipEntries(file);

  const mdPaths = [...entries.keys()].filter((p) => /\.md$/i.test(p)).sort();
  if (mdPaths.length === 0) throw new Error(msg('notNotion'));

  // Strip one top-level wrapper folder when every .md file sits inside it (e.g. `Private & Shared/`).
  const rootPrefix = commonRootPrefix(mdPaths);
  const stripRoot = (p: string) => (rootPrefix && p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p);

  // Identify database CSV files and their matching row-page folders.
  const csvPaths = new Set<string>();
  const uniqueDbs = new Set<string>();
  const dbFolderDirs = new Set<string>();
  for (const path of entries.keys()) {
    if (!/\.csv$/i.test(path)) continue;
    csvPaths.add(path);
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : '';
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const { clean, id } = parseCsvName(name);
    uniqueDbs.add(`${dir}/${id ?? clean.toLowerCase()}`);
    if (clean) {
      const cleanRelDir = stripRoot(dir ? `${dir}/${clean}` : clean)
        .split('/')
        .map((seg) => stripNotionId(seg).clean || seg)
        .filter(Boolean)
        .join('/');
      if (cleanRelDir) dbFolderDirs.add(cleanRelDir);
    }
  }

  const nowMs = Date.now();
  const fileTimeMs = file.lastModified && file.lastModified <= nowMs ? file.lastModified : nowMs;
  const fallbackIso = new Date(fileTimeMs).toISOString();

  const docs: NotionDoc[] = [];
  onProgress?.(i18n.t('importLog:shared.foundNotes', { count: mdPaths.length }));

  for (const rawPath of mdPaths) {
    const entry = entries.get(rawPath)!;
    const rawText = (await zipEntryText(entry)).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const slash = rawPath.lastIndexOf('/');
    const rawDir = slash >= 0 ? rawPath.slice(0, slash) : '';
    const filename = slash >= 0 ? rawPath.slice(slash + 1) : rawPath;
    const stem = filename.replace(/\.md$/i, '');
    const { clean: cleanStem, id: notionId } = stripNotionId(stem);

    const relPath = stripRoot(rawPath);
    const relSlash = relPath.lastIndexOf('/');
    const relDir = relSlash >= 0 ? relPath.slice(0, relSlash) : '';
    const cleanFolderDir = relDir
      ? relDir
          .split('/')
          .map((seg) => stripNotionId(seg).clean || seg)
          .filter(Boolean)
          .join('/')
      : '';

    let body = rawText.replace(/^\n+/, '');
    let title = isUntitledStem(cleanStem) ? '' : cleanStem;
    const h1 = /^# ([^\n]+)(?:\n|$)/.exec(body);
    if (h1) {
      const h1Text = h1[1]!.trim();
      if (isUntitledStem(cleanStem) && isUntitledStem(h1Text)) {
        title = '';
        body = body.slice(h1[0].length).replace(/^\n+/, '');
      } else if (h1MatchesStem(h1Text, cleanStem)) {
        title = h1Text;
        body = body.slice(h1[0].length).replace(/^\n+/, '');
      }
    }

    const entryDate = entry.date instanceof Date && !Number.isNaN(entry.date.getTime()) && entry.date.getTime() <= nowMs + 86_400_000
      ? entry.date
      : null;

    docs.push({
      rawPath,
      rawDir,
      relDir,
      cleanFolderDir,
      notionId,
      title,
      body,
      isDbRow: Boolean(cleanFolderDir) && dbFolderDirs.has(cleanFolderDir),
      entryDate,
    });
  }

  const docByPath = new Map(docs.map((d) => [d.rawPath, d]));
  const docById = new Map<string, NotionDoc>();
  for (const d of docs) {
    if (d.notionId && !docById.has(d.notionId)) docById.set(d.notionId, d);
  }
  const mdResolve = fileResolver(mdPaths);
  const csvResolve = fileResolver(csvPaths);
  const mediaPaths = [...entries.keys()].filter((p) => !/\.(?:md|csv)$/i.test(p));
  const mediaResolve = fileResolver(mediaPaths);
  const keys = new FileKeys('ntfile');

  const counts = { noteLinks: 0, deadLinks: 0, callouts: 0, untitled: 0 };
  const kept: { doc: NotionDoc; note: ImportedNote }[] = [];

  onProgress?.(i18n.t('importLog:shared.buildingNotes'));

  for (const d of docs) {
    if (!d.title) counts.untitled++;

    const tags = d.isDbRow ? extractDbRowTags(d.body) : [];

    // 1. Convert <aside> callouts and <details> folds.
    const asides = convertAsides(d.body);
    counts.callouts += asides.count;
    let body = detailsToFold(asides.text);

    // 2. Normalize Notion's double-spaced task checkboxes (`- [ ]  text` -> `- [ ] text`) outside code fences.
    body = mapOutsideFences(body, (chunk) =>
      chunk.replace(/^([ \t]*- \[[ xX]\]) {2,}/gm, '$1 '),
    );

    // 3. Escape raw typed HTML tags (`<script>`, `<b>`) while keeping Notion's `<u>...</u>` underline.
    body = escapeNonUnderlineHtml(body);

    // 4. Rewrite internal page links (relative `.md` paths and Notion web URLs with known 32-char IDs) to note-links.
    body = mapOutsideCode(body, (prose) =>
      prose.replace(MD_LINK, (whole, label: string, angled?: string, bare?: string) => {
        const target = (angled ?? bare!.replace(/\s+"[^"\n]*"\s*$/, '')).trim();
        if (!target) return whole;

        // First try resolving as a .md path in the export (try full target before stripping #fragment so `#` in titles like `#2` works).
        let mdHit = mdResolve(target, d.rawDir);
        if (!mdHit && target.includes('#') && !target.startsWith('#')) {
          const base = target.slice(0, target.lastIndexOf('#'));
          if (/\.md$/i.test(base)) mdHit = mdResolve(base, d.rawDir);
        }
        if (mdHit) {
          const dest = docByPath.get(mdHit);
          if (dest) {
            if (!dest.title) return label.trim();
            counts.noteLinks++;
            return noteLink(dest.title, label);
          }
        }

        // Database `.csv` link inside a parent page: keep its readable label instead of a broken `.csv` link.
        if (/\.csv$/i.test(target) && csvResolve(target, d.rawDir)) {
          return label.trim();
        }

        // Notion web URL pointing to a page that IS in this export (matched by 32-char hex ID).
        const urlId = NOTION_URL_ID.exec(target)?.[1]?.toLowerCase();
        if (urlId) {
          const dest = docById.get(urlId);
          if (dest && dest.title) {
            counts.noteLinks++;
            return noteLink(dest.title, label);
          }
          return whole;
        }

        // Unresolved relative `.md` link (outside exported subtree or missing): keep text, count warning.
        if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#') && /\.md(?:$|\?|#)/i.test(target)) {
          counts.deadLinks++;
          return label.trim() || target;
        }

        return whole;
      }),
    );

    // 5. Key referenced images and attachments under fixed-width `ntfile:` keys.
    body = keyFileRefs(body, d.rawDir, mediaResolve, keys);
    body = body.replace(/\n{3,}/g, '\n\n').trim();

    const stamp = d.entryDate ? d.entryDate.toISOString() : fallbackIso;
    kept.push({
      doc: d,
      note: {
        title: d.title,
        body,
        tags,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  }

  const { folders, dirToFolderId } = buildFolderTree(kept.map((k) => k.doc.cleanFolderDir));
  for (const { doc, note } of kept) {
    if (!doc.cleanFolderDir) continue;
    const folderId = dirToFolderId.get(doc.cleanFolderDir);
    if (folderId) {
      note.folderId = folderId;
      note.folderPath = doc.cleanFolderDir.split('/');
    }
  }
  const notes = kept.map((k) => k.note);

  const { blobs, tooLarge } = await readKeyedFiles(keys, entries, notes);
  for (const key of [...blobs.keys()]) {
    if (!notes.some((n) => isBlobReferenced(key, n.body))) blobs.delete(key);
  }

  const transforms: string[] = [];
  const warnings: string[] = [];
  if (folders.length) transforms.push(msg('subpageFolders', { count: folders.length }));
  if (counts.noteLinks) transforms.push(i18n.t('importLog:shared.noteLinks', { count: counts.noteLinks }));
  if (counts.callouts) transforms.push(msg('callouts', { count: counts.callouts }));
  if (blobs.size) transforms.push(i18n.t('importLog:shared.attachments', { count: blobs.size }));
  const tagged = notes.filter((n) => n.tags.length).length;
  if (tagged) transforms.push(i18n.t('importLog:shared.tags', { count: tagged }));
  if (uniqueDbs.size) warnings.push(msg('databases', { count: uniqueDbs.size }));
  if (counts.deadLinks) warnings.push(msg('deadLinks', { count: counts.deadLinks }));
  if (counts.untitled) warnings.push(i18n.t('importLog:shared.missingTitle', { count: counts.untitled }));
  if (tooLarge) warnings.push(mediaTooLargeWarning(tooLarge));

  const parsed: ParsedImport = {
    notes,
    warnings,
    transforms,
    source: 'notion',
  };
  if (folders.length) parsed.folders = folders;
  if (blobs.size) {
    parsed.blobs = blobs;
    parsed.blobBytes = [...blobs.values()].reduce((sum, b) => sum + b.data.length, 0);
  }
  return parsed;
}
