import type JSZip from 'jszip';
import i18n from '../i18n';
import type { BwIdentity } from './bitwarden';
import { ManagerItems, tagsOf, type Field } from './managerItems';
import { readCsvTable } from './passwordCsv';
import type { Importer } from './types';
import { zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';

/**
 * Dashlane import, from the real export the lab made in Dashlane's web vault
 * (2026-11-12, a trial account seeded through Dashlane's Bitwarden CSV
 * import, then Settings > Export > CSV):
 *
 *   dashlane-credential-export.zip, five CSV files, CRLF rows, LF inside a
 *   quoted note:
 *     credentials.csv   username,username2,username3,title,password,note,url,
 *                       category,otpUrl   (category is the folder, "/" nests)
 *     securenotes.csv   title,note,category
 *     payments.csv      type,account_name,account_holder,cc_number,code,
 *                       expiration_month,expiration_year,routing_number,
 *                       account_number,country,issuing_bank,note,name
 *     ids.csv           type,number,name,issue_date,expiration_date,
 *                       place_of_issue,state
 *     personalInfo.csv  type,title,first_name,middle_name,last_name,login,
 *                       date_of_birth,place_of_birth,email,email_type,
 *                       item_name,phone_number,address,country,state,city,
 *                       zip,address_recipient,address_building,
 *                       address_apartment,address_floor,address_door_code,
 *                       job_title,url
 *   Only one website per login. Columns Dashlane did not know on import
 *   ("fields: ...", "favorite: 1") stay in the note as it wrote them.
 *   A card made in Dashlane (a second export, items added by hand): type
 *   "payment_card", the cardholder in `account_name` (not account_holder),
 *   `name` empty, `country` "UNIVERSAL". A personal-info row of type "name"
 *   is a person (title, first, middle and last name, login, birth date and
 *   place), `item_name` empty. An ID card is ids.csv type "card", dates as
 *   "2030-1-1". Other personal-info types (email, phone, address) and bank
 *   accounts are not seen on real rows yet: they become notes.
 *   A ".dash" export is encrypted and refused with a way out.
 *
 * Spec: docs/internal/plans/password-manager-importers.md (section 4)
 */

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:dashlane.${key}`, options);

type Table = Awaited<ReturnType<typeof readCsvTable>>;

export const dashlaneImporter: Importer = {
  id: 'dashlane',
  label: 'Dashlane',
  description: 'In Dashlane: Settings > Export data, choose the CSV format, then drop the .zip here.',
  accept: '.zip,.csv,text/csv,.dash',
  enabled: true,
  sourceTag: 'dashlane',
  async parse(file, onProgress) {
    onProgress?.(i18n.t('importExport:status.readingFile'));
    const head = await file.slice(0, 64).text();
    if (/\.dash$/i.test(file.name) || head.includes('Dashlane Secured Export')) throw new Error(msg('encrypted'));
    const tables = new Map<string, Table>();
    if (/\.csv$/i.test(file.name)) {
      tables.set(file.name.toLowerCase().replace(/^.*\//, ''), await readCsvTable(file));
    } else {
      let zip: JSZip;
      try {
        zip = await openZip(file);
      } catch {
        throw new Error(msg('notDashlane'));
      }
      for (const entry of Object.values(zip.files)) {
        const name = entry.name.toLowerCase().replace(/^.*\//, '');
        if (entry.dir || !name.endsWith('.csv')) continue;
        tables.set(name, await readCsvTable(new File([await zipEntryText(entry)], name)));
      }
    }
    const items = new ManagerItems();
    let known = false;
    for (const t of tables.values()) {
      const has = (...cols: string[]) => cols.every((c) => t.header.includes(c));
      if (has('username', 'password', 'otpurl')) credentials(items, t);
      else if (has('title', 'note', 'category') && t.header.length === 3) secureNotes(items, t);
      else if (has('cc_number', 'account_holder')) payments(items, t);
      else if (has('place_of_issue', 'issue_date')) rowsAsNotes(items, t, 'name', ['type', 'name']);
      else if (has('first_name', 'item_name', 'address')) personalInfo(items, t);
      else continue;
      known = true;
    }
    if (!known) throw new Error(msg('notDashlane'));
    return items.result('dashlane', msg('noItems'));
  },
};

const cellOf = (t: Table) => (r: string[], name: string) => r[t.col(name)] ?? '';
const folderTags = (category: string) => tagsOf(category.split('/'));

function credentials(items: ManagerItems, t: Table): void {
  const cell = cellOf(t);
  for (const r of t.rows) {
    // A second and third user name have no slot of their own: fields.
    const extra: Field[] = ['username2', 'username3']
      .map((c, i) => ({ label: `Username ${i + 2}`, value: cell(r, c).trim(), hidden: false }))
      .filter((f) => f.value);
    items.login({
      title: cell(r, 'title'),
      url: cell(r, 'url').trim(),
      username: cell(r, 'username').trim(),
      password: cell(r, 'password'),
      totp: cell(r, 'otpurl').trim() || cell(r, 'otpsecret').trim(),
      notes: cell(r, 'note'),
      tags: folderTags(cell(r, 'category')),
      fields: extra,
    });
  }
}

function secureNotes(items: ManagerItems, t: Table): void {
  const cell = cellOf(t);
  for (const r of t.rows) items.note({ title: cell(r, 'title'), notes: cell(r, 'note'), tags: folderTags(cell(r, 'category')) });
}

function payments(items: ManagerItems, t: Table): void {
  const cell = cellOf(t);
  for (const r of t.rows) {
    const title = cell(r, 'name') || cell(r, 'account_name');
    if (cell(r, 'cc_number').trim()) {
      const holder = cell(r, 'account_holder') || cell(r, 'account_name');
      const year = cell(r, 'expiration_year').trim();
      const bank = cell(r, 'issuing_bank').trim();
      items.card({
        title,
        holder,
        number: cell(r, 'cc_number').replace(/\s+/g, ''),
        cvv: cell(r, 'code'),
        expMonth: cell(r, 'expiration_month').trim().padStart(2, '0'),
        expYear: year.length === 2 ? `20${year}` : year,
        notes: [cell(r, 'note'), bank && `issuing_bank: ${bank}`].filter(Boolean).join('\n\n'),
      });
    } else {
      rowAsNote(items, t, r, title, ['name', 'account_name', 'note']);
    }
  }
}

/** A "name" row is a person and becomes an identity; any other piece of
 *  personal info becomes a note with its filled columns. */
function personalInfo(items: ManagerItems, t: Table): void {
  const cell = cellOf(t);
  const PLACED = ['type', 'item_name', 'title', 'first_name', 'middle_name', 'last_name', 'login', 'email', 'phone_number', 'address', 'city', 'state', 'zip', 'country'];
  for (const r of t.rows) {
    if (cell(r, 'type').trim() !== 'name') {
      rowAsNote(items, t, r, cell(r, 'item_name') || cell(r, 'type'), ['type', 'item_name']);
      continue;
    }
    const identity: BwIdentity = {
      title: cell(r, 'title'),
      firstName: cell(r, 'first_name'),
      middleName: cell(r, 'middle_name'),
      lastName: cell(r, 'last_name'),
      username: cell(r, 'login'),
      email: cell(r, 'email'),
      phone: cell(r, 'phone_number'),
      address1: cell(r, 'address'),
      city: cell(r, 'city'),
      state: cell(r, 'state'),
      postalCode: cell(r, 'zip'),
      country: cell(r, 'country'),
    };
    const name = [identity.firstName, identity.lastName].filter(Boolean).join(' ');
    const extra = t.header.filter((h) => !PLACED.includes(h) && cell(r, h).trim()).map((h) => ({ label: h, value: cell(r, h).trim(), hidden: false }));
    items.identity({ title: cell(r, 'item_name') || name, identity, extra });
  }
}

/** Rows with no home here (an ID, a piece of personal info) become notes
 *  with their filled columns as lines. */
function rowsAsNotes(items: ManagerItems, t: Table, titleCol: string, skip: string[]): void {
  const cell = cellOf(t);
  for (const r of t.rows) rowAsNote(items, t, r, cell(r, titleCol) || cell(r, 'type'), skip);
}

function rowAsNote(items: ManagerItems, t: Table, r: string[], title: string, skip: string[]): void {
  const cell = cellOf(t);
  const extra = t.header
    .filter((h) => !skip.includes(h) && cell(r, h).trim())
    .map((h) => ({ label: h, value: cell(r, h).trim(), hidden: h === 'number' || h === 'account_number' }));
  items.note({ title, notes: cell(r, 'note'), extra });
}
