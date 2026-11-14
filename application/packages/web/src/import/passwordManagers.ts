import type JSZip from 'jszip';
import i18n from '../i18n';
import type { BwIdentity } from './bitwarden';
import { ManagerItems, jsonCell, tagsOf, type Field } from './managerItems';
import { isoFromStamp, readCsvTable } from './passwordCsv';
import type { Importer } from './types';
import { zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';

/**
 * Importers for the password managers whose exports the lab made for real in
 * their own apps (2026-11-12, seeded with the same PNLAB items through each
 * app's importer, then exported in the app):
 *
 *   LastPass    lastpass_vault_export.csv
 *               url,username,password,totp,extra,name,grouping,fav
 *               A secure note is url "http://sn" with its text in `extra`;
 *               a typed note starts "NoteType:<type>" and holds Key:Value
 *               lines. Folders nest with "\". `totp` is a bare base32 key.
 *               No dates. LF line ends.
 *   NordPass    nordpass_<date>.csv: name,url,additional_urls,username,
 *               password,note,cardholdername,cardnumber,cvc,pin,expirydate,
 *               zipcode,folder,shared_folder,full_name,phone_number,email,
 *               address1,address2,city,country,state,type,custom_fields
 *               `type` is password, credit_card, note, identity or folder
 *               (a folder row is only a name). `folder` is the LAST folder
 *               name, not the path. `additional_urls` and `custom_fields` are
 *               JSON arrays in the cell. Expiry "MM/YY". No dates. CRLF. The
 *               free plan keeps no 2FA key, so the file has none.
 *   Proton Pass .zip: "Proton Pass/data.json", vaults with items; or .csv:
 *               type,name,url,autofillUrls,email,username,password,note,totp,
 *               createTime,modifyTime,vault (a card or identity is JSON in
 *               `note`; no custom fields). A login has an email AND a
 *               username; times are epoch seconds; `state` 2 is the trash.
 *               A hide-my-email alias is `type: "alias"` with its address in
 *               the item's own `aliasEmail` and an empty `content`; the
 *               mailbox it forwards to is not in the file.
 *               A .pgp export is encrypted and refused with a way out.
 *
 * Spec: docs/internal/plans/password-manager-importers.md (section 2)
 */

const msg = (ns: string, key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:${ns}.${key}`, options);
const reading = () => i18n.t('importExport:status.readingFile');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export const lastpassImporter: Importer = {
  id: 'lastpass',
  label: 'LastPass',
  description: 'In LastPass: Advanced options > Export > Export data for use anywhere, then drop the .csv here.',
  accept: '.csv,text/csv',
  enabled: true,
  sourceTag: 'lastpass',
  async parse(file, onProgress) {
    onProgress?.(reading());
    const { header, rows, col } = await readCsvTable(file);
    if (!['url', 'extra', 'grouping'].every((h) => header.includes(h))) throw new Error(msg('lastpass', 'notLastPass'));
    const cell = (r: string[], name: string) => r[col(name)] ?? '';
    const items = new ManagerItems();
    for (const r of rows) {
      const common = {
        title: cell(r, 'name'),
        tags: tagsOf(cell(r, 'grouping').split('\\')),
        starred: cell(r, 'fav').trim() === '1',
      };
      const extra = cell(r, 'extra');
      if (cell(r, 'url').trim() !== 'http://sn') {
        items.login({ ...common, url: cell(r, 'url').trim(), username: cell(r, 'username').trim(), password: cell(r, 'password'), totp: cell(r, 'totp'), notes: extra });
        continue;
      }
      const typed = lastpassNoteFields(extra);
      if (typed?.type === 'Credit Card') {
        const exp = typed.fields.get('Expiration Date') ?? '';
        const [month = '', year = ''] = exp.split(',');
        const m = MONTHS.indexOf(month.trim().toLowerCase());
        items.card({
          ...common,
          holder: typed.fields.get('Name on Card') ?? '',
          number: typed.fields.get('Number') ?? '',
          cvv: typed.fields.get('Security Code') ?? '',
          expMonth: m >= 0 ? String(m + 1).padStart(2, '0') : '',
          expYear: year.trim(),
          notes: typed.fields.get('Notes') ?? '',
        });
      } else {
        items.note({ ...common, notes: extra });
      }
    }
    return items.result('lastpass', msg('lastpass', 'notLastPass'));
  },
};

/** A LastPass typed note ("NoteType:Credit Card" then Key:Value lines). */
function lastpassNoteFields(extra: string): { type: string; fields: Map<string, string> } | null {
  const lines = extra.replace(/\r\n?/g, '\n').split('\n');
  if (!lines[0]?.startsWith('NoteType:')) return null;
  const fields = new Map<string, string>();
  let last = '';
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    // A line with no key continues the field before it (a multi-line Notes).
    if (at <= 0 && last) fields.set(last, `${fields.get(last)}\n${line}`);
    else if (at > 0) fields.set((last = line.slice(0, at)), line.slice(at + 1));
  }
  return { type: lines[0].slice('NoteType:'.length).trim(), fields };
}

export const nordpassImporter: Importer = {
  id: 'nordpass',
  label: 'NordPass',
  description: 'In NordPass: Settings > Export Items, then drop the .csv here.',
  accept: '.csv,text/csv',
  enabled: true,
  sourceTag: 'nordpass',
  async parse(file, onProgress) {
    onProgress?.(reading());
    const { header, rows, col } = await readCsvTable(file);
    if (!['name', 'type', 'cardholdername'].every((h) => header.includes(h))) throw new Error(msg('nordpass', 'notNordPass'));
    const cell = (r: string[], name: string) => r[col(name)] ?? '';
    const items = new ManagerItems();
    for (const r of rows) {
      const type = cell(r, 'type').trim();
      if (type === 'folder') continue;
      const fields = jsonCell<{ type?: string; label?: string; value?: string }>(cell(r, 'custom_fields')).map(
        (f): Field => ({ label: String(f.label ?? ''), value: String(f.value ?? ''), hidden: f.type === 'hidden' }),
      );
      const common = { title: cell(r, 'name'), tags: tagsOf([cell(r, 'folder')]), notes: cell(r, 'note') };
      if (type === 'password') {
        items.login({
          ...common,
          url: cell(r, 'url').trim(),
          extraUrls: jsonCell<unknown>(cell(r, 'additional_urls')).filter((u): u is string => typeof u === 'string').map((u) => u.trim()),
          username: cell(r, 'username').trim() || cell(r, 'email').trim(),
          password: cell(r, 'password'),
          fields,
        });
      } else if (type === 'credit_card') {
        const [month = '', year = ''] = cell(r, 'expirydate').split('/');
        const pin = cell(r, 'pin');
        items.card({
          ...common,
          holder: cell(r, 'cardholdername'),
          number: cell(r, 'cardnumber'),
          cvv: cell(r, 'cvc'),
          expMonth: month.trim().padStart(2, '0'),
          expYear: year.trim().length === 2 ? `20${year.trim()}` : year.trim(),
          zip: cell(r, 'zipcode'),
          notes: [common.notes, pin && `PIN: ${pin}`].filter(Boolean).join('\n\n'),
        });
      } else if (type === 'identity') {
        items.identity({
          ...common,
          identity: { firstName: cell(r, 'full_name'), email: cell(r, 'email'), phone: cell(r, 'phone_number'), address1: cell(r, 'address1'), address2: cell(r, 'address2'), city: cell(r, 'city'), state: cell(r, 'state'), postalCode: cell(r, 'zipcode'), country: cell(r, 'country') },
          extra: fields,
        });
      } else {
        items.note({ ...common, extra: fields });
      }
    }
    return items.result('nordpass', msg('nordpass', 'notNordPass'));
  },
};

type ProtonItem = {
  state?: number;
  aliasEmail?: string | null;
  folderId?: string | null;
  pinned?: boolean;
  createTime?: number;
  modifyTime?: number;
  data?: {
    type?: string;
    metadata?: { name?: string; note?: string };
    extraFields?: { fieldName?: string; type?: string; data?: { content?: string } }[];
    content?: Record<string, unknown>;
  };
};

export const protonPassImporter: Importer = {
  id: 'proton-pass',
  label: 'Proton Pass',
  description: 'In Proton Pass: Settings > Export, choose ZIP, then drop the .zip here. A CSV export works too, with less in it.',
  accept: '.zip,.csv,text/csv,.pgp',
  enabled: true,
  sourceTag: 'proton-pass',
  async parse(file, onProgress) {
    onProgress?.(reading());
    if (/\.pgp$/i.test(file.name)) throw new Error(msg('protonPass', 'encrypted'));
    const items = new ManagerItems();
    const fail = msg('protonPass', 'notProton');
    if (/\.csv$/i.test(file.name)) {
      await protonCsv(file, items);
      return items.result('proton-pass', fail);
    }
    let zip: JSZip;
    try {
      zip = await openZip(file);
    } catch {
      throw new Error(fail);
    }
    const entry = Object.values(zip.files).find((e) => !e.dir && /(^|\/)data\.json$/.test(e.name));
    if (!entry) throw new Error(fail);
    let data: { vaults?: Record<string, { name?: string; items?: ProtonItem[]; folders?: { folderId?: string; name?: string }[] }> };
    try {
      data = JSON.parse(await zipEntryText(entry));
    } catch {
      throw new Error(fail);
    }
    const vaults = Object.values(data.vaults ?? {});
    let trashed = 0;
    let aliases = 0;
    for (const vault of vaults) {
      // One vault is every item's vault and says nothing; several become tags.
      const vaultTags = vaults.length > 1 && vault.name ? [vault.name] : [];
      const folders = new Map((vault.folders ?? []).map((f) => [f.folderId, f.name ?? '']));
      for (const item of vault.items ?? []) {
        if (item.state === 2) {
          trashed++;
          continue;
        }
        const d = item.data ?? {};
        const c = d.content ?? {};
        const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
        const folder = item.folderId ? folders.get(item.folderId) : undefined;
        const common = {
          title: d.metadata?.name ?? '',
          notes: d.metadata?.note ?? '',
          tags: tagsOf([...vaultTags, ...(folder ? [folder] : [])]),
          created: isoFromStamp(String(item.createTime ?? '')),
          changed: isoFromStamp(String(item.modifyTime ?? '')),
          starred: item.pinned === true,
        };
        const fields: Field[] = (d.extraFields ?? []).map((f) => ({ label: f.fieldName ?? '', value: f.data?.content ?? '', hidden: f.type !== 'text' }));
        if (d.type === 'login') {
          const urls = Array.isArray(c.urls) ? c.urls.filter((u): u is string => typeof u === 'string') : [];
          const { username, extra } = protonUser(str('itemUsername'), str('itemEmail'));
          items.login({ ...common, url: urls[0] ?? '', extraUrls: urls.slice(1), username, password: str('password'), totp: str('totpUri'), fields: [...extra, ...fields] });
        } else if (d.type === 'creditCard') {
          protonCard(items, common, c, fields);
        } else if (d.type === 'identity') {
          items.identity({ ...common, identity: protonIdentity(c), extra: [...identityRest(c), ...fields] });
        } else if (d.type === 'alias') {
          // Not a login: Proton forwards its mail. The record of which
          // address went to which site is what a person needs, so it
          // becomes a note with the address.
          aliases++;
          items.note({ ...common, extra: [{ label: msg('protonPass', 'aliasAddress'), value: item.aliasEmail ?? '', hidden: false }, ...fields] });
        } else {
          // A note, or a type this build does not know (custom, SSH key,
          // Wi-Fi): its text values become lines under the note.
          const extra: Field[] = Object.entries(c).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => ({ label: k, value: v as string, hidden: false }));
          items.note({ ...common, extra: [...extra, ...fields] });
        }
      }
    }
    if (trashed) items.transforms.push(msg('protonPass', 'leftTrash', { count: trashed }));
    if (aliases) items.transforms.push(msg('protonPass', 'keptAliases', { count: aliases }));
    return items.result('proton-pass', fail);
  },
};

/** The Proton CSV: less than the zip (no custom fields), same items. */
async function protonCsv(file: File, items: ManagerItems): Promise<void> {
  const { header, rows, col } = await readCsvTable(file);
  if (!['type', 'name', 'vault', 'createtime'].every((h) => header.includes(h))) throw new Error(msg('protonPass', 'notProton'));
  const cell = (r: string[], name: string) => r[col(name)] ?? '';
  for (const r of rows) {
    const type = cell(r, 'type').trim();
    const common = { title: cell(r, 'name'), created: isoFromStamp(cell(r, 'createtime').trim()), changed: isoFromStamp(cell(r, 'modifytime').trim()) };
    const json = (() => {
      try {
        const v: unknown = JSON.parse(cell(r, 'note'));
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })();
    if (type === 'login') {
      const urls = cell(r, 'url').split(',').map((u) => u.trim()).filter(Boolean);
      const { username, extra } = protonUser(cell(r, 'username').trim(), cell(r, 'email').trim());
      items.login({ ...common, notes: cell(r, 'note'), url: urls[0] ?? '', extraUrls: urls.slice(1), username, password: cell(r, 'password'), totp: cell(r, 'totp'), fields: extra });
    } else if (type === 'creditCard' && json) {
      protonCard(items, { ...common, notes: typeof json.note === 'string' ? json.note : '' }, json, []);
    } else if (type === 'identity' && json) {
      items.identity({ ...common, notes: typeof json.note === 'string' ? json.note : '', identity: protonIdentity(json), extra: identityRest(json) });
    } else if (type === 'alias') {
      // Not seen in a real CSV yet: the address is taken from `email`.
      items.note({ ...common, notes: cell(r, 'note'), extra: [{ label: msg('protonPass', 'aliasAddress'), value: cell(r, 'email').trim(), hidden: false }] });
    } else {
      items.note({ ...common, notes: cell(r, 'note') });
    }
  }
}

/** Proton keeps an email and a username apart; the username wins the login's
 *  one slot, and a different email stays as a field. */
function protonUser(username: string, email: string): { username: string; extra: Field[] } {
  if (!username) return { username: email, extra: [] };
  return { username, extra: email && email !== username ? [{ label: 'Email', value: email, hidden: false }] : [] };
}

function protonCard(items: ManagerItems, common: { title: string; notes?: string }, c: Record<string, unknown>, fields: Field[]): void {
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
  const [year = '', month = ''] = str('expirationDate').split('-');
  const pin = str('pin');
  const extra = [...(pin ? [`PIN: ${pin}`] : []), ...fields.map((f) => `${f.label}: ${f.value}`)];
  items.card({
    ...common,
    holder: str('cardholderName'),
    number: str('number'),
    cvv: str('verificationNumber'),
    expMonth: month,
    expYear: year,
    notes: [common.notes ?? '', extra.join('\n')].filter(Boolean).join('\n\n'),
  });
}

/** The Proton identity keys `protonIdentity` places; the rest stay as lines. */
const IDENTITY_KEYS = new Set(['firstName', 'fullName', 'middleName', 'lastName', 'email', 'phoneNumber', 'streetAddress', 'city', 'stateOrProvince', 'zipOrPostalCode', 'countryOrRegion', 'company', 'organization', 'socialSecurityNumber', 'passportNumber', 'licenseNumber', 'note']);

function identityRest(c: Record<string, unknown>): Field[] {
  return Object.entries(c)
    .filter(([k, v]) => !IDENTITY_KEYS.has(k) && typeof v === 'string' && v)
    .map(([k, v]) => ({ label: k, value: v as string, hidden: false }));
}

function protonIdentity(c: Record<string, unknown>): BwIdentity {
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
  return {
    firstName: str('firstName') || str('fullName'),
    middleName: str('middleName'),
    lastName: str('lastName'),
    email: str('email'),
    phone: str('phoneNumber'),
    address1: str('streetAddress'),
    city: str('city'),
    state: str('stateOrProvince'),
    postalCode: str('zipOrPostalCode'),
    country: str('countryOrRegion'),
    company: str('company') || str('organization'),
    ssn: str('socialSecurityNumber'),
    passportNumber: str('passportNumber'),
    licenseNumber: str('licenseNumber'),
  };
}
