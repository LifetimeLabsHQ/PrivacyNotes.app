import i18n from '../i18n';
import type { BwIdentity } from './bitwarden';
import { ManagerItems, tagsOf, type Field, type ItemCommon } from './managerItems';
import { isoFromStamp } from './passwordCsv';
import type { Importer } from './types';

/**
 * Enpass import, from the real export the lab made in Enpass 6.12 for Windows
 * (2026-11-12, seeded through Enpass's own Bitwarden JSON import), File >
 * Export > .json:
 *
 *   { folders: [{uuid, title, parent_uuid}], items: [...] }
 *   An item has `category` (login, password, creditcard, note, identity,
 *   finance, license, travel, computer, misc), `title`, `note`, `favorite`,
 *   `archived` and `trashed` (0 or 1), `createdAt` and `updated_at` in epoch
 *   seconds, `folders` (uuids) and `fields`. A field has `type` (username,
 *   email, password, url, totp, text, phone, date, numeric, section, and
 *   cc* on a card), `label` (in the app's language), `value`, `sensitive`,
 *   `deleted` and a `uid` that names the field of its template. Empty
 *   template fields are in the file; a `section` field is a heading. An
 *   import into Enpass also makes a folder named after the import.
 *
 * The identity reads its fields by `uid`, never by label, because the labels
 * are translated.
 * Spec: docs/internal/plans/password-manager-importers.md (section 4)
 */

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:enpass.${key}`, options);

type EnField = { type?: string; label?: string; value?: string; sensitive?: number; deleted?: number; uid?: number };
type EnItem = {
  category?: string;
  title?: string;
  note?: string;
  favorite?: number;
  archived?: number;
  trashed?: number;
  createdAt?: number;
  updated_at?: number;
  folders?: string[];
  fields?: EnField[];
  attachments?: unknown[];
};
type EnData = { folders?: { uuid?: string; title?: string; parent_uuid?: string }[]; items?: EnItem[] };

/** The identity template's field uids (Enpass 6). */
const ID = { title: 129, first: 130, middle: 131, last: 132, ssn: 212, street: 143, city: 144, state: 145, country: 146, zip: 147, company: 137, username: 164, email: 165 };
const PHONES = [149, 151, 140];
/** A crafted file can loop its folder parents. */
const MAX_FOLDER_DEPTH = 32;

export const enpassImporter: Importer = {
  id: 'enpass',
  label: 'Enpass',
  description: 'In Enpass: File > Export, pick the vault and the .json format, then drop the .json file here.',
  accept: '.json,application/json',
  enabled: true,
  sourceTag: 'enpass',
  async parse(file, onProgress) {
    onProgress?.(i18n.t('importExport:status.readingFile'));
    let data: EnData;
    try {
      data = JSON.parse(await file.text()) as EnData;
    } catch {
      throw new Error(msg('notEnpass'));
    }
    if (!data || !Array.isArray(data.items)) throw new Error(msg('notEnpass'));
    const folders = new Map((data.folders ?? []).map((f) => [f.uuid ?? '', f]));
    const pathOf = (uuid: string): string[] => {
      const out: string[] = [];
      for (let f = folders.get(uuid), n = 0; f && n < MAX_FOLDER_DEPTH; f = folders.get(f.parent_uuid ?? ''), n++) out.unshift(f.title ?? '');
      return out;
    };
    const items = new ManagerItems();
    let trashed = 0;
    let attachments = 0;
    for (const item of data.items) {
      if (item.trashed) {
        trashed++;
        continue;
      }
      attachments += Array.isArray(item.attachments) ? item.attachments.length : 0;
      const fields = (item.fields ?? []).filter((f) => !f.deleted && f.type !== 'section');
      const common: ItemCommon = {
        title: item.title ?? '',
        notes: item.note ?? '',
        tags: tagsOf((item.folders ?? []).flatMap(pathOf)),
        created: isoFromStamp(String(item.createdAt ?? '')),
        changed: isoFromStamp(String(item.updated_at ?? '')),
        starred: item.favorite === 1,
        archived: item.archived === 1,
      };
      if (item.category === 'login' || item.category === 'password') addLogin(items, common, fields);
      else if (item.category === 'creditcard') addCard(items, common, fields);
      else if (item.category === 'identity') addIdentity(items, common, fields);
      else items.note({ ...common, extra: rest(fields, new Set()) });
    }
    // Proton's line says the same (rule AD).
    if (trashed) items.transforms.push(i18n.t('importLog:protonPass.leftTrash', { count: trashed }));
    if (attachments) items.warnings.push(msg('leftFiles', { count: attachments }));
    return items.result('enpass', msg('notEnpass'));
  },
};

function addLogin(items: ManagerItems, common: ItemCommon, fields: EnField[]): void {
  const first = (type: string) => fields.find((f) => f.type === type && f.value);
  const user = first('username');
  const email = first('email');
  const password = first('password');
  const totp = first('totp');
  const urls = fields.filter((f) => f.type === 'url' && f.value);
  const placed = new Set<EnField>([user, password, totp, ...urls].filter((f): f is EnField => !!f));
  // The user name wins the login's one slot; an email beside it stays a field.
  if (!user && email) placed.add(email);
  items.login({
    ...common,
    url: (urls[0]?.value ?? '').trim(),
    extraUrls: urls.slice(1).map((f) => (f.value ?? '').trim()),
    username: (user ?? email)?.value?.trim() ?? '',
    password: password?.value ?? '',
    totp: totp?.value?.trim() ?? '',
    fields: rest(fields, placed),
  });
}

function addCard(items: ManagerItems, common: ItemCommon, fields: EnField[]): void {
  const byType = (type: string) => fields.find((f) => f.type === type);
  const [month = '', year = ''] = (byType('ccExpiry')?.value ?? '').split('/');
  const placed = new Set([byType('ccName'), byType('ccNumber'), byType('ccCvc'), byType('ccExpiry')].filter((f): f is EnField => !!f));
  const lines = rest(fields, placed).map((f) => `${f.label}: ${f.value}`);
  items.card({
    ...common,
    holder: byType('ccName')?.value ?? '',
    number: (byType('ccNumber')?.value ?? '').replace(/\s+/g, ''),
    cvv: byType('ccCvc')?.value ?? '',
    expMonth: month.trim().padStart(2, '0'),
    expYear: year.trim().length === 2 ? `20${year.trim()}` : year.trim(),
    notes: [common.notes ?? '', lines.join('\n')].filter(Boolean).join('\n\n'),
  });
}

function addIdentity(items: ManagerItems, common: ItemCommon, fields: EnField[]): void {
  const byUid = (uid: number) => fields.find((f) => f.uid === uid);
  const text = (uid: number) => byUid(uid)?.value ?? '';
  const phone = PHONES.map(byUid).find((f) => f?.value);
  const identity: BwIdentity = {
    title: text(ID.title),
    firstName: text(ID.first),
    middleName: text(ID.middle),
    lastName: text(ID.last),
    ssn: text(ID.ssn),
    address1: text(ID.street),
    city: text(ID.city),
    state: text(ID.state),
    country: text(ID.country),
    postalCode: text(ID.zip),
    company: text(ID.company),
    username: text(ID.username),
    email: text(ID.email),
    phone: phone?.value ?? '',
  };
  const placed = new Set([...Object.values(ID).map(byUid), phone].filter((f): f is EnField => !!f));
  items.identity({ ...common, identity, extra: rest(fields, placed) });
}

/** Every filled field not placed elsewhere, a sensitive one hidden. */
function rest(fields: EnField[], placed: Set<EnField>): Field[] {
  return fields.filter((f) => f.value && !placed.has(f)).map((f) => ({ label: f.label ?? '', value: f.value ?? '', hidden: f.sensitive === 1 }));
}
