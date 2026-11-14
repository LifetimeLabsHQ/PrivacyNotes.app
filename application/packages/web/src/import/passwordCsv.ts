import { serializeLoginBody } from '../LoginForm';
import { domainFromUrlString } from '../favicon';
import i18n from '../i18n';
import { normalizeTag } from '../notesRepo';
import { parseKeePassXml } from './keepassXml';
import { readArchiveEntry } from './safariArchive';
import type { Importer, ImporterId, ImportedNote, ParsedImport } from './types';

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:passwordCsv.${key}`, options);

/**
 * Browser password import adapter.
 *
 * Chrome, Edge, Brave, Opera, Vivaldi, Firefox and Safari all export
 * their saved passwords as a flat .csv with one row per login, so one
 * adapter reads all of them: the header row decides which columns to
 * take. Every row becomes a PN 'login' vault item.
 *
 * Two inputs, one parser: the bare .csv, or the .zip Safari's
 * "Export Browsing Data to File" writes around it. That archive can also
 * hold the bookmarks export, so `Passwords.csv` is picked by name.
 *
 * The three header shapes, verbatim:
 *   Chromium  name,url,username,password,note
 *             ("note" arrived in Chrome 108 - older exports have four
 *             columns and still parse)
 *   Firefox   url,username,password,httpRealm,formActionOrigin,guid,
 *             timeCreated,timeLastUsed,timePasswordChanged
 *   Safari    Title,URL,Username,Password,Notes,OTPAuth
 *
 * Firefox is the only one that carries dates (epoch milliseconds) and
 * the only one with no title column, so its titles are derived from the
 * site address. Safari is the only one that carries a TOTP key, as the
 * otpauth:// URI that `parseTotpInput` already reads.
 *
 *   KeePassXC Group,Title,Username,Password,URL,Notes,TOTP,Icon,
 *             Last Modified,Created
 *             (real export, keepassxc-cli 2.8.0, 2026-11-12: `Group` is the
 *             whole path from the database root, the Recycle Bin rows are in
 *             the file, the dates are ISO 8601, `TOTP` is an otpauth:// URI)
 *
 * Another password manager that exports CSV is one more alias in COLUMNS
 * and one more `csvImporter` row, not a new adapter: the same parser stands
 * behind every card, each with its own id and source tag.
 * Spec: docs/internal/plans/password-manager-importers.md (section 2)
 */

/** Header cell names each source writes, lowercased and trimmed. */
const COLUMNS = {
  // KeePass 2's CSV (1.x): Account, Login Name, Password, Web Site, Comments.
  title: ['name', 'title', 'account'],
  url: ['url', 'web site'],
  username: ['username', 'login name'],
  password: ['password'],
  notes: ['note', 'notes', 'comments'],
  totp: ['otpauth', 'totp'],
  created: ['timecreated', 'created'],
  changed: ['timepasswordchanged', 'last modified'],
  // KeePassXC's group path, root first. Its parts become tags, as a
  // foreign Bitwarden file's folders do.
  group: ['group'],
} as const;

type Field = keyof typeof COLUMNS;

/** Column index per field. -1 when this export has no such column. */
type ColumnMap = Record<Field, number>;

/** KeePassXC names its recycle bin this in English; a translated name
 *  imports as a tag, which is visible and harmless. */
const RECYCLE_BIN = 'recycle bin';

export const passwordCsvImporter: Importer = csvImporter({
  id: 'browser-passwords',
  label: 'Browser passwords',
  description:
    'The passwords .csv from Chrome, Edge, Brave, Opera, Vivaldi, Firefox, or Safari, or the .zip Safari writes. Each row becomes a login.',
  accept: '.csv,text/csv,.zip',
  sourceTag: 'browser',
});

// KeePass and KeePassXC write a CSV and a KeePass XML; the XML keeps
// everything (keepassXml.ts), so each card takes both and the extension picks.
export const keepassxcImporter: Importer = csvImporter({
  id: 'keepassxc',
  label: 'KeePassXC',
  description:
    'In KeePassXC: Database > Export > XML File (or CSV File), then drop the file here. Each entry becomes a login, its groups become tags, and the Recycle Bin stays behind.',
  accept: '.xml,text/xml,application/xml,.csv,text/csv',
  sourceTag: 'keepassxc',
  xml: 'keepassxc',
});

export const keepassImporter: Importer = csvImporter({
  id: 'keepass',
  label: 'KeePass',
  description:
    'In KeePass: File > Export > KeePass XML (2.x), then drop the .xml file here. Each entry becomes a login, its groups become tags, and the Recycle Bin stays behind.',
  accept: '.xml,text/xml,application/xml,.csv,text/csv',
  sourceTag: 'keepass',
  xml: 'keepass',
});

function csvImporter(meta: { id: ImporterId; label: string; description: string; accept: string; sourceTag: string; xml?: 'keepass' | 'keepassxc' }): Importer {
  const { xml, ...rest } = meta;
  return {
    ...rest,
    enabled: true,
    parse: (file, onProgress) =>
      xml && /\.xml$/i.test(file.name) ? parseKeePassXml(file, xml, onProgress) : parsePasswordCsv(file, meta.id, onProgress),
  };
}

async function parsePasswordCsv(file: File, source: ImporterId, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(i18n.t('importExport:status.readingFile'));
  const text = stripBom(
    /\.zip$/i.test(file.name)
      ? await readArchiveEntry(file, 'Passwords.csv', /\.csv$/i)
      : await file.text()
  );
  if (!text.trim()) {
    throw new Error(msg('emptyFile'));
  }

  onProgress?.(msg('readingColumns'));
  const rows = parseCsv(text, sniffDelimiter(firstLine(text)));
  const header = (rows.shift() ?? []).map((c) => c.trim().toLowerCase());
  const columns = resolveColumns(header);

  if (columns.password < 0 || (columns.url < 0 && columns.username < 0)) {
    throw new Error(msg('noPasswordColumn'));
  }

  onProgress?.(msg('convertingLogins'));
  const notes: ImportedNote[] = [];
  const warnings: string[] = [];
  const transforms: string[] = [];

  let derivedTitles = 0;
  let totpCount = 0;
  let datedCount = 0;
  let noPassword = 0;
  let recycled = 0;
  const allTags = new Set<string>();

  for (const row of rows) {
    // Trailing newlines and blank separator lines both land here.
    if (row.every((c) => !c.trim())) continue;

    // The first part is the database's root group, which every entry
    // shares, so it says nothing.
    const groups = cell(row, columns.group).split('/').map((g) => g.trim()).filter(Boolean).slice(1);
    if (groups[0]?.toLowerCase() === RECYCLE_BIN) {
      recycled++;
      continue;
    }
    const tags: string[] = [];
    for (const g of groups) {
      const tag = normalizeTag(g);
      if (tag && !tags.includes(tag)) tags.push(tag);
    }
    for (const tag of tags) allTags.add(tag);

    const url = cell(row, columns.url);
    const username = cell(row, columns.username);
    // A password and a TOTP secret are taken byte for byte: a space at
    // either end is part of the secret, and trimming it locked the user out.
    const password = rawCell(row, columns.password);
    const totp = rawCell(row, columns.totp);
    if (!password) noPassword++;
    if (totp) totpCount++;

    let title = cell(row, columns.title);
    if (!title) {
      title = domainFromUrlString(url) || username;
      if (title) derivedTitles++;
    }

    const created = isoFromStamp(cell(row, columns.created));
    const changed = isoFromStamp(cell(row, columns.changed));
    if (created || changed) datedCount++;
    const now = new Date().toISOString();

    notes.push({
      title,
      body: serializeLoginBody({
        url,
        username,
        password,
        // Windows apps (KeePassXC, Chrome) write CRLF inside a quoted note;
        // a stray \r would show in the note. A password is never touched.
        notes: cell(row, columns.notes).replace(/\r\n?/g, '\n'),
        totp,
      }),
      tags,
      createdAt: created ?? changed ?? now,
      updatedAt: changed ?? created ?? now,
      type: 'login',
    });
  }

  if (notes.length === 0) {
    throw new Error(msg('noLogins'));
  }

  const writer = detectSource(header);
  if (writer) transforms.push(msg('readAs', { source: writer }));
  transforms.push(i18n.t('importLog:shared.importedLogins', { count: notes.length }));
  if (derivedTitles > 0) {
    transforms.push(
      msg('namedAfterSite', { count: derivedTitles })
    );
  }
  if (datedCount > 0) {
    transforms.push(
      msg('keptDates', { count: datedCount })
    );
  }
  if (totpCount > 0) {
    transforms.push(
      i18n.t('importLog:shared.keptTotp', { count: totpCount })
    );
  }

  const tagged = notes.filter((n) => n.tags.length > 0).length;
  if (tagged > 0) {
    transforms.push(i18n.t('importLog:shared.tags', { count: tagged }));
  }
  if (recycled > 0) {
    transforms.push(msg('skippedRecycleBin', { count: recycled }));
  }

  if (noPassword > 0) {
    warnings.push(
      msg('noPassword', { count: noPassword })
    );
  }

  return {
    notes,
    warnings,
    transforms,
    stats: {
      totalNotes: notes.length,
      // A login body is always JSON, so no note is empty.
      emptyNotes: 0,
      untaggedNotes: notes.length - tagged,
      uniqueTags: allTags.size,
    },
    source,
  } satisfies ParsedImport;
}

/**
 * A password manager's CSV as a lowercased header and its non-blank rows,
 * through the same parser as the browser files (BOM, quotes, newlines inside
 * a field, the delimiter Excel may have swapped in).
 */
export async function readCsvTable(file: File): Promise<{ header: string[]; rows: string[][]; col: (name: string) => number }> {
  const text = stripBom(await file.text());
  const rows = text.trim() ? parseCsv(text, sniffDelimiter(firstLine(text))) : [];
  const header = (rows.shift() ?? []).map((c) => c.trim().toLowerCase());
  return {
    header,
    rows: rows.filter((r) => r.some((c) => c.trim())),
    col: (name) => header.indexOf(name),
  };
}

/** Split a CSV document into rows of fields, per RFC 4180: quoted
 *  fields, doubled quotes inside them, and delimiters or newlines
 *  inside them. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        // A doubled quote is one literal quote; a single one ends the field.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
        continue;
      }
      field += ch;
      continue;
    }

    // A quote only opens a field at its start, so an apostrophe inside
    // an unquoted password stays a plain character.
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Excel rewrites a .csv with the host locale's list separator, so a
 *  file that was opened and re-saved is not always comma-separated.
 *  Take whichever candidate splits the header into the most columns. */
function sniffDelimiter(headerLine: string): string {
  let best = ',';
  let bestCount = 1;
  for (const candidate of [',', ';', '\t']) {
    const count = headerLine.split(candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Which browser wrote this, from the columns only it has. Used for the
 *  transform message, so the user can see the file was read as intended. */
function detectSource(header: string[]): string | null {
  if (header.includes('group') && header.includes('last modified')) return 'KeePassXC';
  if (header.includes('login name') && header.includes('web site')) return 'KeePass';
  if (header.includes('timepasswordchanged')) return 'Firefox';
  if (header.includes('otpauth')) return 'Safari';
  if (header.includes('name') && header.includes('url')) return 'Chrome';
  return null;
}

function resolveColumns(header: string[]): ColumnMap {
  const map = {} as ColumnMap;
  for (const field of Object.keys(COLUMNS) as Field[]) {
    map[field] = header.findIndex((cell) => (COLUMNS[field] as readonly string[]).includes(cell));
  }
  return map;
}

function cell(row: string[], index: number): string {
  return rawCell(row, index).trim();
}

function rawCell(row: string[], index: number): string {
  if (index < 0) return '';
  return row[index] ?? '';
}

/** Firefox writes its timestamps as epoch milliseconds, KeePassXC as ISO
 *  8601 in UTC ("2024-03-01T10:00:00Z"). */
export function isoFromStamp(raw: string): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(raw.length <= 10 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Chrome on Windows writes a UTF-8 BOM, which would otherwise become
 *  part of the first header name and hide the "name" column. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function firstLine(text: string): string {
  const end = text.indexOf('\n');
  return end < 0 ? text : text.slice(0, end);
}
