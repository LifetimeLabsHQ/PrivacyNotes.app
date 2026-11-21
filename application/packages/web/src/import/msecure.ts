import i18n from '../i18n';
import { ManagerItems, tagsOf, type Field, type ItemCommon } from './managerItems';
import { readCsvTable } from './passwordCsv';
import type { Importer } from './types';
import { withBareLinks } from './bareLinks';

/**
 * mSecure import, from the real export the lab made in mSecure 7.0.22 for
 * Windows (2026-11-18, seeded through mSecure's own 1Password .1pux import),
 * Settings > Backups > Export records to CSV file:
 *
 *   The first line is `mSecure6 CSV export file`, then one record per row:
 *   `title|id`, the record type (Login, Credit Card, Secure Note, Identity,
 *   Bank Account, Email Account, ...), the tags in one cell joined by commas,
 *   the note with a line break written as `\n` and a backslash as `\\`, then
 *   one cell per field as `label|type|value`. A `|` inside a label or a value
 *   is doubled. The type is the place of the field kind in mSecure's Add
 *   Field menu: 0 text, 1 text without auto-correct, 2 web address, 3
 *   alphanumeric, 4 phone, 5 email, 6 number, 7 user name, 8 password, 9
 *   sensitive number, 10 date, 11 month and year, 12 card number, 13 one-time
 *   password. A second website is a type 2 field with no label. Favorites,
 *   dates and Deleted Items are not in the file.
 *
 *   With "Only export field data" on, the first line is `mSecure CSV export
 *   file` and every field label is gone, so a user name cannot be told from a
 *   custom field. That file is refused with a message that asks for the
 *   other one.
 *
 * Every field the importer does not place stays: a login keeps it as a custom
 * field (a secret one hidden), any other record lists it under its note.
 * Spec: docs/internal/plans/password-manager-importers.md (section 4)
 */

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:msecure.${key}`, options);

const HEADER = /^msecure\d+ csv export file$/;
const PLAIN_HEADER = 'msecure csv export file';
const T = { url: '2', username: '7', secret: '8', sensitiveNumber: '9', monthYear: '11', totp: '13' };

type MsField = { label: string; type: string; value: string };

const msecureImporterBase: Importer = {
  id: 'msecure',
  label: 'mSecure',
  description: 'In mSecure: Settings > Backups > Export records to CSV file, then drop the .csv file here.',
  accept: '.csv,text/csv',
  enabled: true,
  sourceTag: 'msecure',
  async parse(file, onProgress) {
    onProgress?.(i18n.t('importExport:status.readingFile'));
    const { header, rows } = await readCsvTable(file);
    if (header[0] === PLAIN_HEADER) throw new Error(msg('fieldDataOnly'));
    if (!HEADER.test(header[0] ?? '')) throw new Error(msg('notMSecure'));
    const items = new ManagerItems();
    for (const row of rows) {
      if (row.length < 2) continue;
      const kind = (row[1] ?? '').trim();
      const fields = row.slice(4).map(splitField).filter((f) => f.value !== '');
      const common: ItemCommon = {
        title: unpipe((row[0] ?? '').replace(/\|\d+$/, '')),
        notes: unescapeNote(row[3] ?? ''),
        tags: tagsOf([...(row[2] ?? '').split(',').filter((t) => t.trim().toLowerCase() !== 'unassigned'), ...(PLAIN_KINDS.has(kind) ? [] : [kind])]),
      };
      if (kind === 'Credit Card') addCard(items, common, fields);
      else if (kind === 'Login' || kind === 'Web Logins' || fields.some((f) => f.type === T.username)) addLogin(items, common, fields);
      else items.note({ ...common, extra: fields.map(asField) });
    }
    return items.result('msecure', msg('notMSecure'));
  },
};

/** The importer with the bare-link pass after its parse (bareLinks.ts). */
export const msecureImporter: Importer = { ...msecureImporterBase, parse: withBareLinks(msecureImporterBase.parse) };

/** Record types whose kind is plain from the item itself, so they get no tag. */
const PLAIN_KINDS = new Set(['Login', 'Web Logins', 'Credit Card', 'Secure Note']);

function addLogin(items: ManagerItems, common: ItemCommon, fields: MsField[]): void {
  const user = fields.find((f) => f.type === T.username);
  const password = fields.find((f) => f.type === T.secret && /^password$/i.test(f.label)) ?? fields.find((f) => f.type === T.secret);
  const totp = fields.find((f) => f.type === T.totp);
  // The login's websites: the one labeled Website and the unlabeled ones
  // after it. A labeled web address ("Support site") stays a custom field.
  const urls = fields.filter((f) => f.type === T.url && (f.label === '' || /^(website|url)$/i.test(f.label)));
  const placed = new Set([user, password, totp, ...urls].filter((f): f is MsField => !!f));
  items.login({
    ...common,
    url: urls[0]?.value.trim() ?? '',
    extraUrls: urls.slice(1).map((f) => f.value.trim()),
    username: user?.value.trim() ?? '',
    password: password?.value ?? '',
    totp: totp?.value.trim() ?? '',
    fields: fields.filter((f) => !placed.has(f)).map(asField),
  });
}

function addCard(items: ManagerItems, common: ItemCommon, fields: MsField[]): void {
  const byLabel = (re: RegExp) => fields.find((f) => re.test(f.label));
  const holder = byLabel(/^(name on card|cardholder( name)?)$/i);
  const number = byLabel(/^(card )?number$/i);
  const cvv = byLabel(/^(security code|verification number|cvv|cvc)$/i);
  const expiry = fields.find((f) => f.type === T.monthYear) ?? byLabel(/^expir/i);
  const [month = '', year = ''] = (expiry?.value ?? '').split('/');
  const placed = new Set([holder, number, cvv, expiry].filter((f): f is MsField => !!f));
  const lines = fields.filter((f) => !placed.has(f)).map((f) => `${f.label}: ${f.value}`);
  items.card({
    ...common,
    holder: holder?.value ?? '',
    number: (number?.value ?? '').replace(/\s+/g, ''),
    cvv: cvv?.value ?? '',
    expMonth: month,
    expYear: year.trim().length === 2 ? `20${year.trim()}` : year.trim(),
    notes: [common.notes ?? '', lines.join('\n')].filter(Boolean).join('\n\n'),
  });
}

function asField(f: MsField): Field {
  return { label: f.label, value: f.value, hidden: f.type === T.secret || f.type === T.sensitiveNumber };
}

/** `label|type|value`, where a `|` inside the label or the value is `||`. */
function splitField(cell: string): MsField {
  const parts: string[] = [];
  let part = '';
  for (let i = 0; i < cell.length; i++) {
    if (cell[i] !== '|') part += cell[i];
    else if (cell[i + 1] === '|') {
      part += '|';
      i++;
    } else {
      parts.push(part);
      part = '';
    }
  }
  const [label, type, value] = [...parts, part];
  if (parts.length !== 2 || label === undefined || type === undefined || value === undefined || !/^\d+$/.test(type)) return { label: '', type: '0', value: cell };
  return { label: label.trim(), type, value };
}

function unpipe(text: string): string {
  return text.replace(/\|\|/g, '|');
}

/** `\n` is a line break and `\\` one backslash. */
function unescapeNote(text: string): string {
  return text.replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\'));
}
