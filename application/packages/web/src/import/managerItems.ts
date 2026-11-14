import { serializeLoginBody } from '../LoginForm';
import { domainFromUrlString } from '../favicon';
import { serializeCardBody } from '../CardForm';
import { newLoginField, withLoginExtras } from '../loginExtras';
import { normalizeTag } from '../notesRepo';
import i18n from '../i18n';
import { formatIdentity, type BwIdentity } from './bitwarden';
import { linkifyMarkdown } from './linkify';
import type { ImportedNote, ImporterId, ParsedImport } from './types';

/**
 * The vault items of a password manager import, built the same way for every
 * manager (LastPass, NordPass, Proton Pass): each parser reads its own file and
 * hands the fields here, and the log lines come out the same as Bitwarden's.
 * A login keeps its password and 2FA key byte for byte; a note's CRLF becomes
 * LF; an identity becomes a note through Bitwarden's `formatIdentity`.
 * Spec: docs/internal/plans/password-manager-importers.md (section 2)
 */

export type ItemCommon = { title: string; tags?: string[]; notes?: string; created?: string | null; changed?: string | null; starred?: boolean; archived?: boolean };
export type Field = { label: string; value: string; hidden: boolean };

const t = (key: string, count: number) => i18n.t(`importLog:${key}`, { count });

export class ManagerItems {
  readonly notes: ImportedNote[] = [];
  private readonly n = { logins: 0, cards: 0, secureNotes: 0, identities: 0, totp: 0, fields: 0, extraUrls: 0, starred: 0, archived: 0, noPassword: 0, dated: 0, named: 0 };
  readonly warnings: string[] = [];
  readonly transforms: string[] = [];

  login(it: ItemCommon & { url: string; extraUrls?: string[]; username: string; password: string; totp?: string; fields?: Field[] }): void {
    this.n.logins++;
    if (it.totp) this.n.totp++;
    if (!it.password) this.n.noPassword++;
    const extraUrls = (it.extraUrls ?? []).filter((u) => u && u !== it.url);
    this.n.extraUrls += extraUrls.length;
    const fields = (it.fields ?? []).map((f) => newLoginField(f.hidden ? 'hidden' : 'text', f.label, f.value));
    this.n.fields += fields.length;
    let title = it.title.trim();
    if (!title) {
      title = domainFromUrlString(it.url) || it.username;
      if (title) this.n.named++;
    }
    const trackers = withLoginExtras(undefined, { extraUrls, fields });
    this.push({ ...it, title }, 'login', serializeLoginBody({ url: it.url, username: it.username, password: it.password, totp: it.totp ?? '', notes: lf(it.notes) }), trackers);
  }

  card(it: ItemCommon & { holder: string; number: string; expMonth: string; expYear: string; cvv: string; zip?: string }): void {
    this.n.cards++;
    this.push(it, 'card', serializeCardBody({ cardholderName: it.holder, cardNumber: it.number, expMonth: it.expMonth, expYear: it.expYear, cvv: it.cvv, billingZip: it.zip ?? '', notes: lf(it.notes) }));
  }

  note(it: ItemCommon & { extra?: Field[] }): void {
    this.n.secureNotes++;
    this.push(it, 'note', linkifyMarkdown(withFields(lf(it.notes), it.extra)));
  }

  identity(it: ItemCommon & { identity: BwIdentity; extra?: Field[] }): void {
    this.n.identities++;
    this.push(it, 'note', linkifyMarkdown(formatIdentity(it.identity, withFields(lf(it.notes), it.extra))));
  }

  /** The finished import, or the source's "nothing here" message. */
  result(source: ImporterId, empty: string): ParsedImport {
    if (this.notes.length === 0) throw new Error(empty);
    const n = this.n;
    const line = (count: number, key: string) => {
      if (count > 0) this.transforms.push(t(key, count));
    };
    line(n.logins, 'shared.importedLogins');
    line(n.cards, 'bitwarden.importedCards');
    line(n.secureNotes, 'bitwarden.importedSecureNotes');
    line(n.identities, 'bitwarden.convertedIdentities');
    line(n.totp, 'shared.keptTotp');
    line(n.fields, 'bitwarden.keptLoginFields');
    line(n.extraUrls, 'bitwarden.keptExtraUrls');
    const tagged = this.notes.filter((x) => x.tags.length > 0).length;
    line(tagged, 'shared.tags');
    line(n.starred, 'bitwarden.keptStarred');
    line(n.archived, 'shared.keptArchived');
    line(n.dated, 'passwordCsv.keptDates');
    line(n.named, 'passwordCsv.namedAfterSite');
    if (n.noPassword > 0) this.warnings.push(t('passwordCsv.noPassword', n.noPassword));
    return {
      notes: this.notes,
      warnings: this.warnings,
      transforms: this.transforms,
      stats: {
        totalNotes: this.notes.length,
        emptyNotes: 0,
        untaggedNotes: this.notes.length - tagged,
        uniqueTags: new Set(this.notes.flatMap((x) => x.tags)).size,
      },
      source,
    };
  }

  private push(it: ItemCommon, type: 'login' | 'card' | 'note', body: string, trackers?: Record<string, unknown>): void {
    const now = new Date().toISOString();
    if (it.created || it.changed) this.n.dated++;
    if (it.starred) this.n.starred++;
    if (it.archived) this.n.archived++;
    this.notes.push({
      title: it.title.trim(),
      body,
      ...(trackers && Object.keys(trackers).length > 0 ? { trackers } : {}),
      tags: it.tags ?? [],
      createdAt: it.created ?? it.changed ?? now,
      updatedAt: it.changed ?? it.created ?? now,
      ...(it.starred ? { starred: true } : {}),
      ...(it.archived ? { archived: true } : {}),
      type,
    });
  }
}

/** Folder parts as tags, in order, without repeats. */
export function tagsOf(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const tag = normalizeTag(p.trim());
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** A JSON array in a CSV cell (NordPass, Proton), or [] when it is not one. */
export function jsonCell<T>(raw: string): T[] {
  if (!raw.trim().startsWith('[')) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function lf(text: string | undefined): string {
  return (text ?? '').replace(/\r\n?/g, '\n');
}

/** A note's extra fields as "Label: value" lines under its text. */
function withFields(text: string, extra: Field[] | undefined): string {
  const lines = (extra ?? []).filter((f) => f.value).map((f) => `${f.label}: ${f.value}`);
  return [text, lines.join('\n')].filter(Boolean).join('\n\n');
}
