import type JSZip from 'jszip';
import i18n from '../i18n';
import type { BwIdentity } from './bitwarden';
import { ManagerItems, tagsOf, type Field, type ItemCommon } from './managerItems';
import { isoFromStamp, readCsvTable } from './passwordCsv';
import type { Importer } from './types';
import { zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';

/**
 * 1Password import, from the real exports the lab made in 1Password 8.12 for
 * Windows (2026-11-12, seeded through 1Password's own LastPass import):
 *
 *   .1pux   a zip with `export.attributes` (version 3) and `export.data`:
 *           accounts[].vaults[].items[]. An item has `categoryUuid` (001
 *           login, 002 card, 003 secure note, 004 identity, 005 password,
 *           others such as documents and licences), `state` ("active" or
 *           "archived"), `favIndex` (above 0 is a favorite), `createdAt` and
 *           `updatedAt` in epoch seconds, `overview` (title, url, urls[],
 *           tags with "/" for nesting) and `details` (loginFields with a
 *           `designation`, notesPlain, sections[].fields[]). A field's value
 *           is an object with one key that says its kind: string, concealed,
 *           url, email {email_address}, phone, totp, date, monthYear
 *           (YYYYMM), address {street, city, state, zip, country},
 *           creditCardType, creditCardNumber, menu. A 2FA key is a `totp`
 *           field in a section, the bare base32 key as it was imported.
 *           The trash is not in the export. Every account's own vault holds
 *           a "1Password Account" login and an identity from its Starter Kit.
 *   .csv    Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes:
 *           logins only; tags split by ";".
 *
 * Spec: docs/internal/plans/password-manager-importers.md (section 4)
 */

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:onePassword.${key}`, options);

type FieldValue = Record<string, unknown>;
type OpField = { title?: string; id?: string; value?: FieldValue };
type OpItem = {
  categoryUuid?: string;
  state?: string;
  favIndex?: number;
  createdAt?: number;
  updatedAt?: number;
  overview?: { title?: string; url?: string; urls?: { url?: string }[]; tags?: string[] };
  details?: {
    loginFields?: { value?: string; name?: string; fieldType?: string; designation?: string }[];
    notesPlain?: string;
    password?: string;
    sections?: { title?: string; fields?: OpField[] }[];
  };
};
type OpData = { accounts?: { vaults?: { attrs?: { name?: string }; items?: OpItem[] }[] }[] };

export const onePasswordImporter: Importer = {
  id: '1password',
  label: '1Password',
  description: 'In the 1Password app: File > Export, pick your account and the 1PUX format, then drop the .1pux file here. A CSV export works too, with logins only.',
  accept: '.1pux,.csv,text/csv',
  enabled: true,
  sourceTag: '1password',
  async parse(file, onProgress) {
    onProgress?.(i18n.t('importExport:status.readingFile'));
    const items = new ManagerItems();
    if (/\.csv$/i.test(file.name)) {
      await onePasswordCsv(file, items);
      return items.result('1password', msg('notOnePassword'));
    }
    let zip: JSZip;
    try {
      zip = await openZip(file);
    } catch {
      throw new Error(msg('notOnePassword'));
    }
    const entry = zip.file('export.data');
    if (!entry) throw new Error(msg('notOnePassword'));
    let data: OpData;
    try {
      data = JSON.parse(await zipEntryText(entry)) as OpData;
    } catch {
      throw new Error(msg('notOnePassword'));
    }
    const vaults = (data.accounts ?? []).flatMap((a) => a.vaults ?? []);
    for (const vault of vaults) {
      // One vault says nothing about an item; several become tags.
      const vaultTags = vaults.length > 1 && vault.attrs?.name ? [vault.attrs.name] : [];
      for (const item of vault.items ?? []) addItem(items, item, vaultTags);
    }
    // Files sit beside export.data; this importer does not read them yet.
    const files = Object.values(zip.files).filter((e) => !e.dir && e.name.startsWith('files/')).length;
    if (files) items.warnings.push(msg('leftFiles', { count: files }));
    return items.result('1password', msg('notOnePassword'));
  },
};

function addItem(items: ManagerItems, item: OpItem, vaultTags: string[]): void {
  const o = item.overview ?? {};
  const d = item.details ?? {};
  const common: ItemCommon = {
    title: o.title ?? '',
    notes: d.notesPlain ?? '',
    tags: tagsOf([...vaultTags, ...(o.tags ?? []).flatMap((t) => t.split('/'))]),
    created: isoFromStamp(String(item.createdAt ?? '')),
    changed: isoFromStamp(String(item.updatedAt ?? '')),
    starred: (item.favIndex ?? 0) > 0,
    archived: item.state === 'archived',
  };
  const fields = (d.sections ?? []).flatMap((s) => s.fields ?? []);
  const cat = item.categoryUuid;

  if (cat === '001' || cat === '005') {
    const designated = (name: string) => d.loginFields?.find((f) => f.designation === name)?.value ?? '';
    const urls = [o.url ?? '', ...(o.urls ?? []).map((u) => u.url ?? '')].map((u) => u.trim()).filter(Boolean);
    let totp = '';
    const custom: Field[] = [];
    for (const f of fields) {
      const v = valueOf(f.value);
      if (!v.text) continue;
      if (v.kind === 'totp' && !totp) totp = v.text;
      else custom.push({ label: f.title ?? '', value: v.text, hidden: v.hidden });
    }
    // Form fields 1Password saved beside the user name and password.
    for (const f of d.loginFields ?? []) {
      if (f.designation || !f.value) continue;
      custom.push({ label: f.name ?? '', value: f.value, hidden: f.fieldType === 'P' });
    }
    items.login({
      ...common,
      url: urls[0] ?? '',
      extraUrls: [...new Set(urls.slice(1))],
      username: designated('username').trim(),
      password: designated('password') || (d.password ?? ''),
      totp,
      fields: custom,
    });
  } else if (cat === '002') {
    const byId = (id: string) => valueOf(fields.find((f) => f.id === id)?.value).text;
    const expiry = byId('expiry');
    const rest = restOf(fields, new Set(['cardholder', 'ccnum', 'cvv', 'expiry']));
    items.card({
      ...common,
      holder: byId('cardholder'),
      number: byId('ccnum'),
      cvv: byId('cvv'),
      expMonth: expiry.slice(0, 2),
      expYear: expiry.slice(3),
      notes: [common.notes ?? '', rest.map((f) => `${f.label}: ${f.value}`).join('\n')].filter(Boolean).join('\n\n'),
    });
  } else if (cat === '004') {
    const raw = (id: string) => fields.find((f) => f.id === id)?.value;
    const text = (id: string) => valueOf(raw(id)).text;
    const address = raw('address')?.address as Record<string, unknown> | undefined;
    const part = (k: string) => (typeof address?.[k] === 'string' ? (address[k] as string) : '');
    const identity: BwIdentity = {
      firstName: text('firstname'),
      middleName: text('initial'),
      lastName: text('lastname'),
      company: text('company'),
      address1: part('street'),
      city: part('city'),
      state: part('state'),
      postalCode: part('zip'),
      country: part('country').toUpperCase(),
      phone: text('defphone') || text('cellphone') || text('homephone') || text('busphone'),
      email: text('email'),
      username: text('username'),
    };
    const placed = new Set(['firstname', 'initial', 'lastname', 'company', 'address', 'email', 'username', identity.phone ? phoneId(fields, identity.phone) : '']);
    items.identity({ ...common, identity, extra: restOf(fields, placed) });
  } else {
    // A secure note, or a type with no home here (a licence, a passport, a
    // router): its filled fields become lines under the note.
    items.note({ ...common, extra: restOf(fields, new Set()) });
  }
}

/** The id of the phone field that holds this number. */
function phoneId(fields: OpField[], phone: string): string {
  return fields.find((f) => valueOf(f.value).text === phone)?.id ?? '';
}

/** Every filled field not in `placed`, as "Label: value" fields. */
function restOf(fields: OpField[], placed: Set<string>): Field[] {
  return fields.flatMap((f) => {
    if (f.id && placed.has(f.id)) return [];
    const v = valueOf(f.value);
    return v.text ? [{ label: f.title ?? '', value: v.text, hidden: v.hidden }] : [];
  });
}

/** A 1Password field value as text: its one key says what it is. */
function valueOf(value: FieldValue | undefined): { text: string; hidden: boolean; kind: string } {
  const [kind, raw] = Object.entries(value ?? {})[0] ?? ['', null];
  const out = (text: string, hidden = false) => ({ text, hidden, kind });
  if (raw === null || raw === undefined) return out('');
  if (kind === 'concealed') return out(String(raw), true);
  if (kind === 'email' && typeof raw === 'object') return out(String((raw as { email_address?: unknown }).email_address ?? ''));
  if (kind === 'address' && typeof raw === 'object') {
    const a = raw as Record<string, unknown>;
    return out(['street', 'city', 'state', 'zip', 'country'].map((k) => (typeof a[k] === 'string' ? a[k] : '')).filter(Boolean).join(', '));
  }
  if (kind === 'monthYear' && typeof raw === 'number') {
    const s = String(raw);
    return out(s.length === 6 ? `${s.slice(4)}/${s.slice(0, 4)}` : '');
  }
  if (kind === 'date' && typeof raw === 'number') {
    const iso = isoFromStamp(String(raw));
    return out(iso ? iso.slice(0, 10) : '');
  }
  if (typeof raw === 'string' || typeof raw === 'number') return out(String(raw));
  return out('');
}

/** The 1Password CSV: logins only. */
async function onePasswordCsv(file: File, items: ManagerItems): Promise<void> {
  const { header, rows, col } = await readCsvTable(file);
  if (!['title', 'url', 'otpauth', 'archived'].every((h) => header.includes(h))) throw new Error(msg('notOnePassword'));
  const cell = (r: string[], name: string) => r[col(name)] ?? '';
  for (const r of rows) {
    items.login({
      title: cell(r, 'title'),
      url: cell(r, 'url').trim(),
      username: cell(r, 'username').trim(),
      password: cell(r, 'password'),
      totp: cell(r, 'otpauth').trim(),
      notes: cell(r, 'notes'),
      tags: tagsOf(cell(r, 'tags').split(';').flatMap((t) => t.split('/'))),
      starred: cell(r, 'favorite').trim() === 'true',
      archived: cell(r, 'archived').trim() === 'true',
    });
  }
}
