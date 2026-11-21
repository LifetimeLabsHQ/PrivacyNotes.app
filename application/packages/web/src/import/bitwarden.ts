import { normalizeTag } from '../notesRepo';
import { serializeLoginBody } from '../LoginForm';
import { base64urlToBytesStrict, bytesToBase64url, parseSitePasskey, SITE_PASSKEY_PRF_SECRET_BYTES, type SitePasskey } from '@notes/shared';
import { newLoginField, withLoginExtras, type LoginField } from '../loginExtras';
import { serializeCardBody } from '../CardForm';
import { serializeSshKeyBody } from '../SshKeyForm';
import { BW_EXPORTED_BY, BW_OWN_FIELDS } from '../export';
import { buildFolderTree } from './folderImport';
import type { Importer, ImportBlob, ImportedNote, ParsedImport } from './types';
import { mimeFromExt } from './blobImport';
import { mediaTooLargeWarning, zipEntryMedia, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';
import type JSZip from 'jszip';
import i18n from '../i18n';
import { withBareLinks } from './bareLinks';

/** A Bitwarden import log line; the KeePass importer reuses the ones it shares. */
export const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:bitwarden.${key}`, options);

/**
 * Bitwarden import adapter.
 *
 * Reads the unencrypted .json export from Bitwarden's vault export
 * (Tools > Export vault > File format: .json), and the ".zip (with
 * attachments)" export: `data.json` (the same .json) plus
 * `attachments/<folder>/<file>`. Bitwarden names each folder after its item,
 * not its id: the name with `/\><:"|?*` as `_` and runs of `_` as one, and
 * `_1`, `_2` on the second and later item of the same name, counted over the
 * items with attachments only (`getDecryptedExportZip` in
 * bitwarden/clients `individual-vault-export.service.ts`, read 2026-11-16).
 * data.json does not say which items have attachments, so a folder goes to
 * the one item whose name gives it (or whose id is the folder name). A folder
 * that fits no item, or several, becomes a note of its own named after the
 * folder, so no file is lost. A login's, card's or SSH key's files go to its
 * Files section, a note's become file links at the end of its body.
 *
 * Supported item types:
 *   1 = Login  -> PN 'login' vault item
 *   2 = Secure Note -> PN 'note'
 *   3 = Card   -> PN 'card' vault item
 *   4 = Identity -> PN 'note' (structured as readable text)
 *   5 = SSH Key -> PN 'ssh-key' vault item
 *
 * Folders map to tags, except in a file our own vault export wrote, where
 * they come back as folders. Favorites map to starred. Reprompt (1) maps to
 * pinProtected. TOTP authenticator keys are kept as-is on the login item.
 * The custom fields our vault export writes for what Bitwarden has no slot
 * for go back into their places. A login's other custom fields become its
 * custom fields and every website it lists is kept; on any other item type
 * they are appended to the notes field so nothing is lost.
 */

// Bitwarden export schema - intentionally loose, only the fields we use.
interface BwUri {
  match?: number | null;
  uri?: string;
}
interface BwLogin {
  uris?: BwUri[] | null;
  username?: string | null;
  password?: string | null;
  totp?: string | null;
  fido2Credentials?: unknown[] | null;
}
interface BwCard {
  cardholderName?: string | null;
  brand?: string | null;
  number?: string | null;
  expMonth?: string | null;
  expYear?: string | null;
  code?: string | null;
}
export interface BwIdentity {
  title?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  address1?: string | null;
  address2?: string | null;
  address3?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  ssn?: string | null;
  username?: string | null;
  passportNumber?: string | null;
  licenseNumber?: string | null;
}
interface BwSshKey {
  privateKey?: string | null;
  publicKey?: string | null;
  keyFingerprint?: string | null;
}
interface BwField {
  name?: string | null;
  value?: string | null;
  type?: number; // 0=Text, 1=Hidden, 2=Boolean, 3=Linked
}
interface BwItem {
  id?: string;
  organizationId?: string | null;
  folderId?: string | null;
  type: number;
  name?: string;
  notes?: string | null;
  favorite?: boolean;
  login?: BwLogin | null;
  card?: BwCard | null;
  identity?: BwIdentity | null;
  sshKey?: BwSshKey | null;
  fields?: BwField[] | null;
  reprompt?: number;
  creationDate?: string;
  revisionDate?: string;
}
interface BwFolder {
  id: string;
  name: string;
}
interface BwExport {
  encrypted?: boolean;
  exportedBy?: string;
  folders?: BwFolder[];
  items?: BwItem[];
}

// Bitwarden item type constants.
const BW_TYPE_LOGIN = 1;
const BW_TYPE_SECURE_NOTE = 2;
const BW_TYPE_CARD = 3;
const BW_TYPE_IDENTITY = 4;
const BW_TYPE_SSH_KEY = 5;

const bitwardenImporterBase: Importer = {
  id: 'bitwarden',
  label: 'Bitwarden',
  description:
    'Unencrypted vault export from Bitwarden (Tools > Export vault > .json, or .zip (with attachments)).',
  accept: '.json,application/json,.zip,application/zip',
  enabled: true,
  sourceTag: 'bitwarden',

  async parse(file, onProgress) {
    onProgress?.(i18n.t('importExport:status.readingFile'));
    const { text, folders: fileFolders } = await readExport(file);

    onProgress?.(i18n.t('importLog:shared.parsingJson'));
    let data: BwExport;
    try {
      data = JSON.parse(text) as BwExport;
    } catch {
      throw new Error(msg('invalidJson'));
    }

    if (data.encrypted === true) {
      throw new Error(msg('encryptedExport'));
    }

    if (!data.items || !Array.isArray(data.items)) {
      throw new Error(msg('missingItems'));
    }

    const ownExport = data.exportedBy === BW_EXPORTED_BY;
    const { byItem: filesByItem, unmatched } = matchAttachmentFolders(fileFolders, data.items);
    const blobs = new Map<string, ImportBlob>();
    const fileCounts = { tooLarge: 0 };

    // Build folder ID -> name map: tags for a Bitwarden file, folders for
    // our own.
    const folderMap = new Map<string, string>();
    if (Array.isArray(data.folders)) {
      for (const f of data.folders) {
        if (f.id && f.name) folderMap.set(f.id, f.name);
      }
    }

    onProgress?.(msg('convertingItems'));
    const notes: ImportedNote[] = [];
    const warnings: string[] = [];
    const transforms: string[] = [];

    let loginCount = 0;
    let cardCount = 0;
    let secureNoteCount = 0;
    let identityCount = 0;
    let sshKeyCount = 0;
    let totpCount = 0;
    let starredCount = 0;
    let pinProtectedCount = 0;
    let customFieldCount = 0;
    let loginFieldCount = 0;
    let extraUrlCount = 0;
    let skippedOrg = 0;
    let passkeyCount = 0;
    let skippedPasskeys = 0;
    let unmatchedFiles = 0;

    for (const item of data.items) {
      // Skip organization vault items - user exported an individual vault
      // but BW sometimes includes org items in the JSON anyway.
      if (item.organizationId) {
        skippedOrg++;
        continue;
      }

      const tags: string[] = [];
      // Bitwarden uses "/" for nested folders. Split into individual tags,
      // or keep the path to rebuild the folder when the file is our own.
      const folderPath = (item.folderId ? folderMap.get(item.folderId) ?? '' : '')
        .split('/').map((part) => part.trim()).filter(Boolean);
      if (!ownExport) {
        for (const part of folderPath) {
          const t = normalizeTag(part);
          if (t) tags.push(t);
        }
      }
      const { own, rest } = takeOwnFields(item.fields, item.type);
      // A set for the duplicate check: a crafted file can carry tens of
      // thousands of tags in one field, and a list scan per tag is quadratic.
      const seen = new Set(tags);
      for (const part of (own.tags ?? '').split(',')) {
        const t = normalizeTag(part);
        if (t && !seen.has(t)) {
          seen.add(t);
          tags.push(t);
        }
      }

      const starred = item.favorite === true;
      if (starred) starredCount++;

      const pinProtected = item.reprompt === 1;
      if (pinProtected) pinProtectedCount++;

      const createdAt = isoOrNow(item.creationDate);
      const updatedAt = isoOrNow(item.revisionDate ?? item.creationDate);

      const pushedAt = notes.length;
      switch (item.type) {
        case BW_TYPE_LOGIN: {
          loginCount++;
          const login = item.login ?? {};
          const uris = [...new Set((login.uris ?? []).map((u) => (typeof u?.uri === 'string' ? u.uri.trim() : '')).filter(Boolean))];
          const fields = loginFields(rest);
          loginFieldCount += fields.length;
          extraUrlCount += Math.max(0, uris.length - 1);
          const trackers = withLoginExtras(undefined, { extraUrls: uris.slice(1), fields });

          if (login.totp) totpCount++;
          const passkeys = sitePasskeysOf(login.fido2Credentials);
          passkeyCount += passkeys.length;
          skippedPasskeys += (Array.isArray(login.fido2Credentials) ? login.fido2Credentials.length : 0) - passkeys.length;
          // A passkey for a site none of the login's websites names (beta
          // #131) still comes in, since the file says it belongs here; the
          // summary names that site so the person can check it.
          for (const site of otherSites(passkeys, uris)) {
            warnings.push(msg('passkeyOtherSite', { name: item.name || uris[0], site }));
          }

          notes.push({
            title: item.name ?? '',
            body: serializeLoginBody({
              url: uris[0] ?? '',
              username: login.username ?? '',
              password: login.password ?? '',
              notes: item.notes ?? '',
              totp: login.totp ?? '',
              passkeys,
            }),
            ...(Object.keys(trackers).length > 0 ? { trackers } : {}),
            tags,
            createdAt,
            updatedAt,
            starred,
            pinProtected,
            type: 'login',
          });
          break;
        }

        case BW_TYPE_CARD: {
          cardCount++;
          const card = item.card ?? {};
          const itemNotes = appendCustomFields(item.notes ?? '', rest);
          customFieldCount += rest.length;

          notes.push({
            title: item.name ?? '',
            body: serializeCardBody({
              cardholderName: card.cardholderName ?? '',
              cardNumber: card.number ?? '',
              expMonth: card.expMonth ?? '',
              expYear: card.expYear ?? '',
              cvv: card.code ?? '',
              billingZip: own.billingZip ?? '',
              notes: itemNotes,
            }),
            tags,
            createdAt,
            updatedAt,
            starred,
            pinProtected,
            type: 'card',
          });
          break;
        }

        case BW_TYPE_SECURE_NOTE: {
          secureNoteCount++;
          const body = appendCustomFields(item.notes ?? '', rest);
          customFieldCount += rest.length;

          notes.push({
            title: item.name ?? '',
            body,
            tags,
            createdAt,
            updatedAt,
            starred,
            pinProtected,
            type: 'note',
          });
          break;
        }

        case BW_TYPE_IDENTITY: {
          identityCount++;
          const identityNotes = appendCustomFields(item.notes ?? '', rest);
          customFieldCount += rest.length;
          // Identity is bitwarden's SECOND markdown body producer and the only
          // one that is not a structured vault type: formatIdentity returns
          // plain `Label: value` lines pushed as type 'note', carrying both the
          // item's Email field and the user's free-text notes. A per-branch
          // link call missed it until v0.300.0; the bare-link pass after the
          // parse (withBareLinks) reads every 'note' body, so no branch can.
          const body = formatIdentity(item.identity ?? {}, identityNotes);

          notes.push({
            title: item.name ?? '',
            body,
            tags,
            createdAt,
            updatedAt,
            starred,
            pinProtected,
            type: 'note',
          });
          break;
        }

        case BW_TYPE_SSH_KEY: {
          sshKeyCount++;
          const ssh = item.sshKey ?? {};
          const itemNotes = appendCustomFields(item.notes ?? '', rest);
          customFieldCount += rest.length;

          notes.push({
            title: item.name ?? '',
            body: serializeSshKeyBody({
              label: own.label ?? ssh.keyFingerprint ?? '',
              privateKey: ssh.privateKey ?? '',
              publicKey: ssh.publicKey ?? '',
              passphrase: own.passphrase ?? '',
              notes: itemNotes,
            }),
            tags,
            createdAt,
            updatedAt,
            starred,
            pinProtected,
            type: 'ssh-key',
          });
          break;
        }

        default:
          warnings.push(
            msg('unknownType', { name: item.name ?? '(unnamed)', type: item.type })
          );
      }
      if (ownExport && folderPath.length > 0 && notes.length > pushedAt) {
        notes[pushedAt]!.folderPath = folderPath;
      }
      const entries = filesByItem.get(item);
      if (entries && notes.length > pushedAt) {
        notes[pushedAt] = withFiles(notes[pushedAt]!, await attachFiles(entries, blobs, fileCounts));
      }
    }

    // A folder that fits no item, or several, keeps its files on a note of its own.
    for (const [folder, entries] of unmatched) {
      const keys = await attachFiles(entries, blobs, fileCounts);
      if (keys.length === 0) continue;
      unmatchedFiles += keys.length;
      const now = new Date().toISOString();
      notes.push(withFiles({ title: folder, body: '', tags: [], createdAt: now, updatedAt: now, type: 'note' }, keys));
    }

    // Our own export's folders, rebuilt once across all paths so siblings
    // share their ancestors. The apply step reuses a folder the account
    // already has under the same path instead of making a second one.
    const rebuilt = ownExport
      ? buildFolderTree(notes.map((n) => (n.folderPath ?? []).join('/')).filter(Boolean))
      : null;
    if (rebuilt) {
      for (const n of notes) {
        const key = (n.folderPath ?? []).join('/');
        if (key) n.folderId = rebuilt.dirToFolderId.get(key) ?? null;
      }
    }

    // Build transform messages.
    if (loginCount > 0) {
      transforms.push(i18n.t('importLog:shared.importedLogins', { count: loginCount }));
    }
    if (cardCount > 0) {
      transforms.push(msg('importedCards', { count: cardCount }));
    }
    if (secureNoteCount > 0) {
      transforms.push(msg('importedSecureNotes', { count: secureNoteCount }));
    }
    if (sshKeyCount > 0) {
      transforms.push(msg('importedSshKeys', { count: sshKeyCount }));
    }
    if (identityCount > 0) {
      transforms.push(msg('convertedIdentities', { count: identityCount }));
    }
    if (loginFieldCount > 0) {
      transforms.push(msg('keptLoginFields', { count: loginFieldCount }));
    }
    if (extraUrlCount > 0) {
      transforms.push(msg('keptExtraUrls', { count: extraUrlCount }));
    }
    if (customFieldCount > 0) {
      transforms.push(msg('preservedCustomFields', { count: customFieldCount }));
    }
    if (starredCount > 0) {
      transforms.push(msg('keptStarred', { count: starredCount }));
    }
    if (pinProtectedCount > 0) {
      transforms.push(msg('markedPinProtected', { count: pinProtectedCount }));
    }
    if (totpCount > 0) {
      transforms.push(i18n.t('importLog:shared.keptTotp', { count: totpCount }));
    }
    if (passkeyCount > 0) {
      transforms.push(msg('keptPasskeys', { count: passkeyCount }));
    }
    if (blobs.size > 0) {
      transforms.push(i18n.t('importLog:shared.foundAttachments', { count: blobs.size }));
    }

    // Warnings.
    if (skippedOrg > 0) {
      warnings.push(msg('skippedOrg', { count: skippedOrg }));
    }
    if (skippedPasskeys > 0) {
      warnings.push(msg('skippedPasskeys', { count: skippedPasskeys }));
    }
    if (unmatchedFiles > 0) {
      warnings.push(msg('unmatchedAttachments', { count: unmatchedFiles }));
    }
    if (fileCounts.tooLarge > 0) {
      warnings.push(mediaTooLargeWarning(fileCounts.tooLarge));
    }

    return {
      notes,
      warnings,
      transforms,
      source: 'bitwarden',
      ...(rebuilt ? { folders: rebuilt.folders } : {}),
      ...(blobs.size > 0 ? { blobs } : {}),
    } satisfies ParsedImport;
  },
};

/** The importer with the bare-link pass after its parse (bareLinks.ts). */
export const bitwardenImporter: Importer = { ...bitwardenImporterBase, parse: withBareLinks(bitwardenImporterBase.parse) };

/**
 * The export's JSON text, and for a zip the files under `attachments/` by
 * folder name. A zip is known by its first two bytes, whatever the file name.
 */
async function readExport(file: File): Promise<{ text: string; folders: Map<string, JSZip.JSZipObject[]> }> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const folders = new Map<string, JSZip.JSZipObject[]>();
  if (head[0] !== 0x50 || head[1] !== 0x4b) return { text: await file.text(), folders };
  let zip: JSZip;
  try {
    zip = await openZip(file);
  } catch {
    throw new Error(msg('notZipExport'));
  }
  const data = Object.values(zip.files).find((e) => !e.dir && e.name === 'data.json');
  if (!data) throw new Error(msg('notZipExport'));
  for (const entry of Object.values(zip.files)) {
    const m = /^attachments\/([^/]+)\/([^/]+)$/.exec(entry.name);
    if (!m || entry.dir) continue;
    const list = folders.get(m[1]!) ?? [];
    list.push(entry);
    folders.set(m[1]!, list);
  }
  return { text: await zipEntryText(data), folders };
}

/** An item's name as Bitwarden writes it for its attachments folder. */
const folderNameOf = (name: string): string => name.replace(/[/\\><:"|?*]/g, '_').replace(/__+/g, '_');

/**
 * Each attachments folder to the one item it names, by id or by name; a
 * name that more than one item gives cannot be placed and stays unmatched.
 */
function matchAttachmentFolders(
  folders: Map<string, JSZip.JSZipObject[]>,
  items: BwItem[],
): { byItem: Map<BwItem, JSZip.JSZipObject[]>; unmatched: Map<string, JSZip.JSZipObject[]> } {
  const byItem = new Map<BwItem, JSZip.JSZipObject[]>();
  const unmatched = new Map<string, JSZip.JSZipObject[]>();
  if (folders.size === 0) return { byItem, unmatched };
  const byId = new Map<string, BwItem>();
  const byName = new Map<string, BwItem[]>();
  for (const item of items) {
    if (item.organizationId) continue;
    if (item.id) byId.set(item.id, item);
    // The file types `name`, and a name that is not text names no folder.
    const key = folderNameOf(typeof item.name === 'string' ? item.name : '');
    byName.set(key, [...(byName.get(key) ?? []), item]);
  }
  for (const [folder, entries] of folders) {
    const named = byName.get(folder);
    const item = byId.get(folder) ?? (named?.length === 1 ? named[0] : undefined);
    if (item) byItem.set(item, [...(byItem.get(item) ?? []), ...entries]);
    else unmatched.set(folder, entries);
  }
  return { byItem, unmatched };
}

/** Each file as a blob under a key only this import uses; returns the keys of the ones that came along. */
async function attachFiles(entries: JSZip.JSZipObject[], blobs: Map<string, ImportBlob>, counts: { tooLarge: number }): Promise<string[]> {
  const keys: string[] = [];
  for (const entry of entries) {
    const data = await zipEntryMedia(entry);
    if (data === null) { counts.tooLarge++; continue; }
    const name = entry.name.slice(entry.name.lastIndexOf('/') + 1) || 'Attachment';
    const key = `bitwardenfile:${blobs.size}`;
    blobs.set(key, { data, name, mime: mimeFromExt(name), file: true });
    keys.push(key);
  }
  return keys;
}

/**
 * The note with these blob keys: in a login's, card's or SSH key's `files`
 * list, or as file links at the end of a note's body. `importBlobs` swaps
 * each key for the stored file.
 */
function withFiles(note: ImportedNote, keys: string[]): ImportedNote {
  if (keys.length === 0) return note;
  const links = keys.map((key) => `[file](${key})`);
  if (note.type === 'note') return { ...note, body: [note.body, ...links].filter(Boolean).join('\n\n') };
  return { ...note, body: JSON.stringify({ ...JSON.parse(note.body), files: links }) };
}

/**
 * Split an item's custom fields into the ones our vault export writes for
 * what Bitwarden has no slot for, and the rest. A named field is taken only on
 * an item type that has its place, and only once; anything else stays with
 * the rest, which goes into the notes.
 */
function takeOwnFields(
  fields: BwField[] | null | undefined,
  type: number
): { own: Partial<Record<keyof typeof BW_OWN_FIELDS, string>>; rest: BwField[] } {
  const keys: (keyof typeof BW_OWN_FIELDS)[] =
    type === BW_TYPE_SSH_KEY ? ['tags', 'label', 'passphrase']
      : type === BW_TYPE_CARD ? ['tags', 'billingZip']
        : ['tags'];
  const own: Partial<Record<keyof typeof BW_OWN_FIELDS, string>> = {};
  const rest: BwField[] = [];
  for (const f of fields ?? []) {
    // Only a text value has a place to go back to; a hand-made file that
    // puts a number or a boolean under one of the names keeps it as a
    // custom field in the notes, the way every other field is kept.
    // Tags are public, so only a text field is read as tags: a hidden one
    // under the same name stays a secret.
    const key =
      typeof f.value === 'string'
        ? keys.find((k) => f.name === BW_OWN_FIELDS[k] && own[k] === undefined && (k !== 'tags' || (f.type ?? 0) === 0))
        : undefined;
    if (key) own[key] = f.value as string;
    else rest.push(f);
  }
  return { own, rest };
}

/** Standard or url-safe base64, padded or not, as unpadded base64url. */
const asBase64url = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9+/_-]+=*$/.test(v) ? v.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null);

/**
 * A login's `fido2Credentials` as site passkeys: ours and Bitwarden's, P-256
 * only, each checked by `parseSitePasskey`; any other entry is left out. A
 * credential id is a GUID (16 bytes) or `b64.` and base64url, as Bitwarden
 * writes it. A file without a 32-byte `prfSecret` (Bitwarden's own has none) gets a new one,
 * so a site that uses the PRF extension sees other outputs.
 * Spec: docs/contrib/passkeys.md (section 16, finding 11)
 */
function sitePasskeysOf(list: unknown): SitePasskey[] {
  if (!Array.isArray(list)) return [];
  const out: SitePasskey[] = [];
  for (const raw of list) {
    const c = raw as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || c.keyType !== 'public-key' || c.keyAlgorithm !== 'ECDSA' || c.keyCurve !== 'P-256') continue;
    const id = typeof c.credentialId !== 'string' ? null
      : c.credentialId.startsWith('b64.') ? asBase64url(c.credentialId.slice(4))
        : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.credentialId)
          ? bytesToBase64url(Uint8Array.from(c.credentialId.replace(/-/g, '').match(/../g)!, (h) => parseInt(h, 16)))
          : null;
    // A secret of another length (beta #131) is replaced too, so the passkey is kept.
    const given = asBase64url(c.prfSecret);
    const prf = given && base64urlToBytesStrict(given, 43)?.length === SITE_PASSKEY_PRF_SECRET_BYTES
      ? given
      : bytesToBase64url(crypto.getRandomValues(new Uint8Array(SITE_PASSKEY_PRF_SECRET_BYTES)));
    const passkey = parseSitePasskey({
      v: 1,
      credentialId: id,
      rpId: typeof c.rpId === 'string' ? c.rpId.toLowerCase() : null,
      userHandle: asBase64url(c.userHandle),
      userName: typeof c.userName === 'string' ? c.userName : '',
      displayName: typeof c.userDisplayName === 'string' ? c.userDisplayName : '',
      key: asBase64url(c.keyValue),
      prfSecret: prf,
      created: typeof c.creationDate === 'string' && Number.isFinite(Date.parse(c.creationDate)) ? new Date(c.creationDate).toISOString() : new Date().toISOString(),
    });
    if (passkey && !out.some((p) => p.credentialId === passkey.credentialId)) out.push(passkey);
  }
  return out;
}

/**
 * The RP IDs of these passkeys that are neither the host of one of the
 * login's web addresses nor a parent of it. A login with no web address
 * (none, or only an `androidapp://` one) names no site to compare with.
 */
function otherSites(passkeys: SitePasskey[], uris: string[]): string[] {
  const hosts = uris.flatMap((u) => {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
      return url.protocol === 'https:' || url.protocol === 'http:' ? [url.hostname] : [];
    } catch {
      return [];
    }
  });
  if (hosts.length === 0) return [];
  return [...new Set(passkeys.map((p) => p.rpId))].filter((rp) => !hosts.some((h) => h === rp || h.endsWith(`.${rp}`)));
}

/**
 * A login's Bitwarden custom fields as its own custom fields. Text stays
 * text, a boolean becomes its text value, and a linked field (type 3, a
 * pointer with no value of its own) is skipped. Hidden and any type this
 * build does not know import hidden: the safe side for a value we cannot
 * classify.
 */
function loginFields(fields: BwField[]): LoginField[] {
  const out: LoginField[] = [];
  for (const f of fields) {
    if (f.type === 3) continue;
    const value = f.value == null ? '' : String(f.value);
    const type = f.type === 0 || f.type === 2 || f.type === undefined ? 'text' : 'hidden';
    out.push(newLoginField(type, f.name ?? '', value));
  }
  return out;
}

/**
 * Append Bitwarden custom fields to a notes string. Custom fields are
 * stored as name/value pairs and have no PN equivalent, so we render
 * them as "Name: Value" lines at the end of the notes.
 */
function appendCustomFields(
  notes: string,
  fields: BwField[] | null | undefined
): string {
  if (!fields || fields.length === 0) return notes;
  const lines: string[] = [];
  for (const f of fields) {
    // Skip linked fields (type 3) - they're Bitwarden autofill metadata
    // with no actual value, just a pointer to another field on the item.
    if (f.type === 3) continue;
    const name = f.name ?? '';
    const value = f.value ?? '';
    lines.push(`${name}: ${value}`);
  }
  const suffix = lines.join('\n');
  if (!notes.trim()) return suffix;
  return notes + '\n\n' + suffix;
}

/**
 * Format a Bitwarden identity into readable plain text. Identities have
 * no PN equivalent, so we render them as a structured note the user can
 * reference or copy fields from.
 */
export function formatIdentity(id: BwIdentity, itemNotes: string): string {
  const lines: string[] = [];

  // Personal details (matches Bitwarden's grouping order)
  const nameParts = [id.title, id.firstName, id.middleName, id.lastName]
    .filter(Boolean)
    .join(' ');
  if (nameParts) lines.push(`Name: ${nameParts}`);
  if (id.username) lines.push(`Username: ${id.username}`);
  if (id.company) lines.push(`Company: ${id.company}`);

  // Identification
  if (id.ssn) lines.push(`SSN: ${id.ssn}`);
  if (id.passportNumber) lines.push(`Passport: ${id.passportNumber}`);
  if (id.licenseNumber) lines.push(`License: ${id.licenseNumber}`);

  // Contact information
  if (id.email) lines.push(`Email: ${id.email}`);
  if (id.phone) lines.push(`Phone: ${id.phone}`);
  const addrParts = [id.address1, id.address2, id.address3].filter(Boolean);
  if (addrParts.length > 0) lines.push(`Address: ${addrParts.join(', ')}`);
  const locParts = [id.city, id.state, id.postalCode, id.country].filter(Boolean);
  if (locParts.length > 0) lines.push(`Location: ${locParts.join(', ')}`);

  if (itemNotes) {
    if (lines.length > 0) lines.push('');
    lines.push(itemNotes);
  }

  return lines.join('\n');
}

function isoOrNow(s: string | undefined | null): string {
  if (!s) return new Date().toISOString();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}
