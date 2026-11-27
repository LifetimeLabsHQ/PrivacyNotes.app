/**
 * Netscape bookmark file writer - the format every browser imports.
 *
 * The reader lives in `import/browserBookmarks.ts`; this is the same
 * format going the other way, so the two are a round trip and the test
 * asserts exactly that (`tests/importBrowserBookmarks.test.ts`).
 *
 * It lives outside `export.ts` on purpose, the way `noteMarkdown.ts` does:
 * the test drives the string directly, with no browser download in the
 * way. `export.ts` owns the file-saving half.
 *
 * Shape rules, all of them chosen so Chrome, Firefox and Safari read the
 * result without complaint:
 *   - The `<!DOCTYPE NETSCAPE-Bookmark-file-1>` line is the format's only
 *     identity. Browsers refuse a file without it.
 *   - `<DT>` and `<p>` stay unclosed. That is the format, not a bug, and
 *     a well-formed variant is what browsers actually reject.
 *   - ADD_DATE is unix SECONDS, matching what every browser writes.
 *   - Firefox reads TAGS back into its own tag store; every other browser
 *     ignores the attribute. So we always emit it and lose nothing.
 *   - SHORTCUTURL is Firefox's address-bar keyword, carried in the link
 *     body. The import can also turn the keyword into a tag, so a tag equal
 *     to the keyword is left out of TAGS: Firefox kept the two apart, and a
 *     round trip must not add a tag the user never had there. The body's
 *     `keywordTag` says Firefox had that tag too, and then it is written.
 *   - A nameless bookmark is written with its domain as the name, because
 *     an empty <A> is a blank row in every browser's list.
 *   - Only http and https addresses are written (beta #157 part 3). The
 *     editor saves nothing else, but a backup restore carries an address as
 *     the backup wrote it, and the browser that imports this file has no
 *     scheme check of its own. The rest are counted in `report.skipped`.
 *   - The import's own "Bookmarks" root is NOT re-emitted (decided
 *     2026-08-22): re-importing elsewhere would nest everything one level
 *     deeper on every round trip.
 *
 * Spec: docs/internal/specs/bookmarks-pillar.md (section 9)
 */

import type { FolderDef } from './folders';
import { linkDomain, parseLinkBody } from './linkBody';
import { normalizeTag } from './notesRepo';
import { escapeHtml } from './escapeHtml';

/** The minimum a bookmark row needs to be written out. */
export interface ExportableBookmark {
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  folderId?: string | null;
}

/** The addresses a browser may be handed. */
const WEB_ADDRESS = /^https?:\/\//i;

/** Root folder name the importer creates. Mirrors ROOT_FOLDER there. */
const IMPORT_ROOT = 'Bookmarks';

/** ISO 8601 to unix seconds. '' when the date is missing or unparseable. */
function unixSeconds(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : String(Math.floor(ms / 1000));
}

function attrs(pairs: Array<[string, string]>): string {
  return pairs
    .filter(([, v]) => v !== '')
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('');
}

/**
 * Build the file. `folders` is the user's whole tree; only the folders
 * that actually hold an exported bookmark are written, so an account with
 * two hundred note folders does not ship two hundred empty bookmark
 * folders to the browser. A bookmark whose address is not http or https
 * is left out and counted in `report.skipped`.
 */
export function buildBookmarksHtml(
  all: ExportableBookmark[],
  folders: FolderDef[],
  report?: { skipped: number },
): string {
  const bookmarks = all.filter((b) => {
    const { url } = parseLinkBody(b.body);
    if (!url || WEB_ADDRESS.test(url)) return true;
    if (report) report.skipped += 1;
    return false;
  });
  const byId = new Map(folders.map((f) => [f.id, f]));
  const childrenOf = new Map<string | null, FolderDef[]>();
  for (const f of folders) {
    // A folder whose parent is missing becomes a root rather than stranding
    // every bookmark filed inside it.
    const parentId = f.parentId && byId.has(f.parentId) ? f.parentId : null;
    const list = childrenOf.get(parentId) ?? [];
    list.push(f);
    childrenOf.set(parentId, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.order - b.order);

  // Bucket the bookmarks by folder, treating a dangling folderId as loose.
  const loose: ExportableBookmark[] = [];
  const inFolder = new Map<string, ExportableBookmark[]>();
  for (const b of bookmarks) {
    const id = b.folderId && byId.has(b.folderId) ? b.folderId : null;
    if (id === null) {
      loose.push(b);
      continue;
    }
    const list = inFolder.get(id) ?? [];
    list.push(b);
    inFolder.set(id, list);
  }

  // A folder is written only when it, or something below it, holds one.
  const occupied = new Set<string>();
  const visiting = new Set<string>();
  const fill = (f: FolderDef): boolean => {
    if (visiting.has(f.id)) return false;
    visiting.add(f.id);
    let used = (inFolder.get(f.id)?.length ?? 0) > 0;
    for (const child of childrenOf.get(f.id) ?? []) if (fill(child)) used = true;
    visiting.delete(f.id);
    if (used) occupied.add(f.id);
    return used;
  };
  for (const f of childrenOf.get(null) ?? []) fill(f);

  const out: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '',
    '<DL><p>',
  ];

  const writeBookmark = (b: ExportableBookmark, indent: string) => {
    const { url, keyword = '', keywordTag: alsoTag, notes } = parseLinkBody(b.body);
    if (!url) return;
    const name = b.title.trim() || linkDomain(url) || url;
    const keywordTag = alsoTag ? '' : normalizeTag(keyword);
    const a = attrs([
      ['HREF', url],
      ['ADD_DATE', unixSeconds(b.createdAt)],
      ['SHORTCUTURL', keyword],
      ['TAGS', b.tags.filter((t) => !keywordTag || t !== keywordTag).join(',')],
    ]);
    out.push(`${indent}<DT><A${a}>${escapeHtml(name)}</A>`);
    // The notes as the description line browsers and Raindrop write.
    if (notes) out.push(`${indent}<DD>${escapeHtml(notes)}`);
  };

  const written = new Set<string>();
  const writeFolder = (f: FolderDef, depth: number) => {
    if (!occupied.has(f.id) || written.has(f.id)) return;
    written.add(f.id);
    const indent = '    '.repeat(depth);
    out.push(`${indent}<DT><H3>${escapeHtml(f.name)}</H3>`);
    out.push(`${indent}<DL><p>`);
    for (const b of inFolder.get(f.id) ?? []) writeBookmark(b, indent + '    ');
    for (const child of childrenOf.get(f.id) ?? []) writeFolder(child, depth + 1);
    out.push(`${indent}</DL><p>`);
  };

  // The importer's own "Bookmarks" root is transparent on the way out:
  // its children are written at top level so a round trip cannot nest.
  const roots = childrenOf.get(null) ?? [];
  for (const b of loose) writeBookmark(b, '    ');
  for (const f of roots) {
    if (f.name === IMPORT_ROOT) {
      for (const b of inFolder.get(f.id) ?? []) writeBookmark(b, '    ');
      for (const child of childrenOf.get(f.id) ?? []) writeFolder(child, 1);
      continue;
    }
    writeFolder(f, 1);
  }

  out.push('</DL><p>');
  return out.join('\n') + '\n';
}
