import { serializeLoginBody } from '../LoginForm';
import { domainFromUrlString } from '../favicon';
import { newLoginField, withLoginExtras, type LoginField } from '../loginExtras';
import { normalizeTag } from '../notesRepo';
import { base64ToBytes } from '@notes/shared';
import i18n from '../i18n';
import { mimeFromExt } from './blobImport';
import { linkifyMarkdown } from './linkify';
import { gunzipMedia, mediaTooLarge, mediaTooLargeWarning } from './zipEntry';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';
// The log lines Bitwarden already has for the same outcome (rule AD).
import { msg as bw } from './bitwarden';

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importLog:keepass.${key}`, options);

/**
 * KeePass XML import: the "KeePass XML (2.x)" file that KeePass 2 writes
 * (File > Export) and that KeePassXC writes (Database > Export > XML File).
 * One parser for both; the two real exports in the tests differ only in the
 * tag separator (KeePass 2 ";", KeePassXC ",").
 *
 * Facts from the real files (KeePass 2.61.1 through KPScript, KeePassXC
 * 2.8.0, 2026-11-12): every value is plain text, `ProtectInMemory="True"`
 * marks the secret ones; times are ISO 8601 in UTC; attachments sit in
 * `Meta/Binaries`, gzip and base64; old versions of an entry sit in its
 * `History`, and an entry names an attachment by `<Binary><Key>name</Key>
 * <Value Ref="0"/></Binary>`; the Recycle Bin is the group whose UUID is `Meta/RecycleBinUUID`
 * (its name is translated, so the UUID is the only safe test).
 *
 * The map: an entry with a username, password, URL or 2FA key is a login,
 * any other entry is a secure note. Groups below the root and the entry's
 * own tags become tags, as a foreign Bitwarden file's folders do. Extra URLs
 * (`KP2A_URL*`, `URL_*`) and custom strings become the login's extra URLs
 * and custom fields, a protected one hidden. The 2FA key comes from `otp`
 * or KeePass 2's own `TimeOtp-*` fields. An expiry date becomes a custom
 * field. Attachments become files: a login's in its Files section (the
 * `files` key `importBlobs` rewrites), a secure note's as file links at the
 * end of its body. One past the largest upload, or one whose `Ref` names no
 * binary, stays behind with a line in the log; history stays behind too.
 * Spec: docs/internal/plans/password-manager-importers.md (section 3)
 */

/** The KeePass standard strings, which have their own place. */
const STANDARD = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes', 'otp']);
/** KeePass 2's own 2FA fields, turned into one otpauth:// URI. */
const TIME_OTP = /^TimeOtp-/;
/** KeePass2Android's and KeePassXC's extra URL fields. */
const EXTRA_URL = /^(KP2A_URL|URL)_\d+$/;
/** A crafted file can nest groups without end. */
const MAX_GROUP_DEPTH = 64;
/** A KDBX database starts with these four bytes (signature 1, little end). */
const KDBX_MAGIC = [0x03, 0xd9, 0xa2, 0x9a];

type Item = { title: string; strings: Map<string, { value: string; secret: boolean }>; tags: string[]; created: string | null; changed: string | null; expires: string | null; files: { name: string; ref: string }[]; history: number };

export async function parseKeePassXml(file: File, source: 'keepass' | 'keepassxc', onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(i18n.t('importExport:status.readingFile'));
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (KDBX_MAGIC.every((b, i) => bytes[i] === b)) throw new Error(msg('kdbxFile'));

  const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'KeePassFile' || doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error(msg('notKeePass'));
  }
  const meta = child(root, 'Meta');
  const recycleBin = text(child(meta, 'RecycleBinEnabled')) === 'False' ? '' : text(child(meta, 'RecycleBinUUID'));
  const top = child(child(root, 'Root'), 'Group');
  if (!top) throw new Error(msg('notKeePass'));

  const binaries = readBinaries(meta);

  onProgress?.(msg('readingEntries'));
  const items: Item[] = [];
  let recycled = 0;
  // The top group is the database itself: its name says nothing, so the
  // path starts below it.
  const walk = (group: Element, path: string[], depth: number) => {
    if (depth > MAX_GROUP_DEPTH) return;
    for (const el of children(group)) {
      if (el.nodeName === 'Entry') items.push(readEntry(el, path));
      else if (el.nodeName === 'Group') {
        if (recycleBin && text(child(el, 'UUID')) === recycleBin) {
          recycled += el.getElementsByTagName('Entry').length - historyCount(el);
          continue;
        }
        walk(el, [...path, text(child(el, 'Name')).trim()].filter(Boolean), depth + 1);
      }
    }
  };
  walk(top, [], 0);

  const notes: ImportedNote[] = [];
  let logins = 0, secureNotes = 0, totp = 0, fields = 0, extraUrls = 0, history = 0, derived = 0, noPassword = 0;
  const blobs = new Map<string, ImportBlob>();
  const files = { missing: 0, tooLarge: 0 };
  for (const it of items) {
    history += it.history;
    const keys = await attachFiles(it.files, binaries, blobs, files);
    const s = (k: string) => it.strings.get(k)?.value ?? '';
    const otp = s('otp') || timeOtpUri(it.strings, it.title);
    const urls = [s('URL').trim(), ...[...it.strings.keys()].filter((k) => EXTRA_URL.test(k)).sort().map((k) => s(k).trim())].filter(Boolean);
    const custom: LoginField[] = [];
    for (const [key, v] of it.strings) {
      if (STANDARD.has(key) || EXTRA_URL.test(key) || (TIME_OTP.test(key) && otp)) continue;
      custom.push(newLoginField(v.secret ? 'hidden' : 'text', key, v.value));
    }
    if (it.expires) custom.push(newLoginField('text', i18n.t('shell:vaultItem.fieldExpires'), it.expires.slice(0, 10)));
    const now = new Date().toISOString();
    const dates = { createdAt: it.created ?? it.changed ?? now, updatedAt: it.changed ?? it.created ?? now };

    const isLogin = !!(s('UserName') || s('Password') || urls.length || otp);
    if (!isLogin) {
      secureNotes++;
      const extra = custom.map((f) => `${f.label}: ${f.value}`).join('\n');
      const body = [s('Notes'), extra].filter(Boolean).join('\n\n');
      fields += custom.length;
      // `importBlobs` swaps each `[file](KEY)` for the file's own link.
      const links = keys.map((key) => `[file](${key})`);
      notes.push({ title: it.title, body: [linkifyMarkdown(body), ...links].filter(Boolean).join('\n\n'), tags: it.tags, ...dates, type: 'note' });
      continue;
    }
    logins++;
    if (otp) totp++;
    if (!s('Password')) noPassword++;
    fields += custom.length;
    extraUrls += Math.max(0, urls.length - 1);
    let title = it.title;
    if (!title) {
      title = domainFromUrlString(urls[0] ?? '') || s('UserName');
      if (title) derived++;
    }
    const trackers = withLoginExtras(undefined, { extraUrls: urls.slice(1), fields: custom });
    const body = serializeLoginBody({ url: urls[0] ?? '', username: s('UserName'), password: s('Password'), totp: otp, notes: s('Notes') });
    notes.push({
      title,
      // The Files section's list; `importBlobs` swaps each key for the file.
      body: keys.length > 0 ? JSON.stringify({ ...JSON.parse(body), files: keys.map((key) => `[file](${key})`) }) : body,
      ...(Object.keys(trackers).length > 0 ? { trackers } : {}),
      tags: it.tags,
      ...dates,
      type: 'login',
    });
  }
  if (notes.length === 0) throw new Error(msg('noEntries'));

  const transforms: string[] = [];
  const warnings: string[] = [];
  if (logins) transforms.push(i18n.t('importLog:shared.importedLogins', { count: logins }));
  if (secureNotes) transforms.push(bw('importedSecureNotes', { count: secureNotes }));
  if (totp) transforms.push(i18n.t('importLog:shared.keptTotp', { count: totp }));
  if (fields) transforms.push(bw('keptLoginFields', { count: fields }));
  if (extraUrls) transforms.push(bw('keptExtraUrls', { count: extraUrls }));
  const tagged = notes.filter((n) => n.tags.length > 0).length;
  if (tagged) transforms.push(i18n.t('importLog:shared.tags', { count: tagged }));
  if (derived) transforms.push(i18n.t('importLog:passwordCsv.namedAfterSite', { count: derived }));
  if (recycled) transforms.push(i18n.t('importLog:passwordCsv.skippedRecycleBin', { count: recycled }));
  if (history) transforms.push(msg('leftHistory', { count: history }));
  if (blobs.size) transforms.push(i18n.t('importLog:shared.foundAttachments', { count: blobs.size }));
  if (files.missing) warnings.push(msg('missingFiles', { count: files.missing }));
  if (files.tooLarge) warnings.push(mediaTooLargeWarning(files.tooLarge));
  if (noPassword) warnings.push(i18n.t('importLog:passwordCsv.noPassword', { count: noPassword }));

  return {
    notes,
    warnings,
    transforms,
    stats: {
      totalNotes: notes.length,
      emptyNotes: 0,
      untaggedNotes: notes.length - tagged,
      uniqueTags: new Set(notes.flatMap((n) => n.tags)).size,
    },
    source,
    ...(blobs.size > 0 ? { blobs } : {}),
  } satisfies ParsedImport;
}

function readEntry(el: Element, path: string[]): Item {
  const strings = new Map<string, { value: string; secret: boolean }>();
  for (const s of children(el)) {
    if (s.nodeName !== 'String') continue;
    const key = text(child(s, 'Key'));
    const value = child(s, 'Value');
    // A password is taken byte for byte, as in the CSV importer.
    if (key) strings.set(key, { value: value?.textContent ?? '', secret: value?.getAttribute('ProtectInMemory') === 'True' || value?.getAttribute('Protected') === 'True' });
  }
  const tags: string[] = [];
  for (const raw of [...path, ...text(child(el, 'Tags')).split(/[;,]/)]) {
    const tag = normalizeTag(raw);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  const times = child(el, 'Times');
  return {
    title: (strings.get('Title')?.value ?? '').trim(),
    strings,
    tags,
    created: iso(text(child(times, 'CreationTime'))),
    changed: iso(text(child(times, 'LastModificationTime'))),
    expires: text(child(times, 'Expires')) === 'True' ? iso(text(child(times, 'ExpiryTime'))) : null,
    files: children(el).flatMap((c) => {
      if (c.nodeName !== 'Binary') return [];
      return [{ name: text(child(c, 'Key')).trim(), ref: child(c, 'Value')?.getAttribute('Ref') ?? '' }];
    }),
    history: children(child(el, 'History')).filter((c) => c.nodeName === 'Entry').length,
  };
}

type Binary = { data: string; compressed: boolean };

/** `Meta/Binaries`: each attachment once, by its `ID`, as base64. */
function readBinaries(meta: Element | null): Map<string, Binary> {
  const out = new Map<string, Binary>();
  for (const b of children(child(meta, 'Binaries'))) {
    const id = b.getAttribute('ID');
    if (b.nodeName === 'Binary' && id !== null) out.set(id, { data: text(b).replace(/\s+/g, ''), compressed: b.getAttribute('Compressed') === 'True' });
  }
  return out;
}

/** Decoded once per binary: two entries can name the same one. */
const decoded = new WeakMap<Binary, Promise<Uint8Array<ArrayBuffer> | null | 'bad'>>();

function decode(bin: Binary): Promise<Uint8Array<ArrayBuffer> | null | 'bad'> {
  let p = decoded.get(bin);
  if (!p) {
    p = (async () => {
      // Base64 holds three bytes in four characters: a file past the largest
      // upload is refused before any decode.
      if (!bin.compressed && mediaTooLarge(Math.floor(bin.data.length * 3 / 4))) return null;
      try {
        const raw = base64ToBytes(bin.data) as Uint8Array<ArrayBuffer>;
        return bin.compressed ? await gunzipMedia(raw, 'attachment') : raw;
      } catch {
        return 'bad';
      }
    })();
    decoded.set(bin, p);
  }
  return p;
}

/** Each of an entry's attachments as a blob, under a key only this import
 *  uses; returns the keys of the ones that came along. */
async function attachFiles(
  list: { name: string; ref: string }[],
  binaries: Map<string, Binary>,
  blobs: Map<string, ImportBlob>,
  counts: { missing: number; tooLarge: number },
): Promise<string[]> {
  const keys: string[] = [];
  for (const { name, ref } of list) {
    const bin = binaries.get(ref);
    const data = bin ? await decode(bin) : 'bad';
    if (data === 'bad') { counts.missing++; continue; }
    if (data === null) { counts.tooLarge++; continue; }
    const key = `keepassfile:${blobs.size}`;
    const fileName = name || 'Attachment';
    blobs.set(key, { data, name: fileName, mime: mimeFromExt(fileName), file: true });
    keys.push(key);
  }
  return keys;
}

/** KeePass 2.47+ keeps a 2FA key in `TimeOtp-*` strings; one URI holds it. */
function timeOtpUri(strings: Map<string, { value: string }>, title: string): string {
  const secret = strings.get('TimeOtp-Secret-Base32')?.value.replace(/\s+/g, '');
  if (!secret) return '';
  const q = new URLSearchParams({ secret });
  const period = strings.get('TimeOtp-Period')?.value;
  const digits = strings.get('TimeOtp-Length')?.value;
  const algorithm = strings.get('TimeOtp-Algorithm')?.value.replace(/^HMAC-/i, '');
  if (period) q.set('period', period);
  if (digits) q.set('digits', digits);
  if (algorithm) q.set('algorithm', algorithm.toUpperCase());
  return `otpauth://totp/${encodeURIComponent(title || 'KeePass')}?${q.toString()}`;
}

/** Entries inside History elements are old versions, not entries. */
function historyCount(group: Element): number {
  let n = 0;
  for (const h of Array.from(group.getElementsByTagName('History'))) n += h.getElementsByTagName('Entry').length;
  return n;
}

/** Only an ISO 8601 time in a sane range; KeePass 2's KDBX 4 base64 time and
 *  anything else is left out, and the item takes its arrival time. */
function iso(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(raw)) return null;
  const d = new Date(raw);
  const y = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || y < 1971 || y > 9998 ? null : d.toISOString();
}

function children(el: Element | null | undefined): Element[] {
  return el ? Array.from(el.children) : [];
}

function child(el: Element | null | undefined, name: string): Element | null {
  return children(el).find((c) => c.nodeName === name) ?? null;
}

function text(el: Element | null | undefined): string {
  return el?.textContent ?? '';
}
