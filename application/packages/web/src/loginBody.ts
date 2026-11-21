/**
 * The body of a login item: one JSON object in the note body.
 */
import { parseSitePasskey, type SitePasskey } from '@notes/shared';
import { storedVaultKeys } from './vaultBody';
import type { VaultFilter } from './views';

/* ────────────────────────────────────────────────────────────────
 * LoginData - the JSON blob stored in the note body for login-type
 * notes. Fields: url (the website), username, password, freeform notes,
 * totp (the raw authenticator key/URI as pasted - never canonicalized),
 * and the site passkeys the browser extension saved into the login.
 * The note's `title` field serves as the display name (e.g. "GitHub")
 * and is auto-derived from the URL domain when empty.
 * ──────────────────────────────────────────────────────────────── */
export interface LoginData {
  url: string;
  username: string;
  password: string;
  totp: string;
  notes: string;
  /** Site passkeys, each checked by `parseSitePasskey`; a malformed entry is
   *  left out. Spec: docs/contrib/passkeys.md (section 5.1) */
  passkeys: SitePasskey[];
}

/** What a writer hands `serializeLoginBody`. A writer that leaves `passkeys`
 *  out (an importer, the extension's v1 login) keeps the stored ones. */
export type LoginInput = Omit<LoginData, 'passkeys'> & { passkeys?: SitePasskey[] };

/** The passkeys of a parsed body: the valid ones, and the raw entries that
 *  are not (a newer version's shape), which a save carries back unchanged. */
function passkeyEntries(raw: unknown): { valid: SitePasskey[]; other: unknown[] } {
  const out = { valid: [] as SitePasskey[], other: [] as unknown[] };
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const p = parseSitePasskey(entry);
    if (p) out.valid.push(p);
    else out.other.push(entry);
  }
  return out;
}

export function parseLoginBody(body: string): LoginData {
  try {
    const parsed = JSON.parse(body);
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      password: typeof parsed.password === 'string' ? parsed.password : '',
      totp: typeof parsed.totp === 'string' ? parsed.totp : '',
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      passkeys: passkeyEntries(parsed?.passkeys).valid,
    };
  } catch {
    return { url: '', username: '', password: '', totp: '', notes: '', passkeys: [] };
  }
}

/**
 * `previous` is the stored body; keys a newer version wrote in it are kept.
 * The `passkeys` key is written only when the login holds one, so a login
 * without passkeys keeps its exact body. An entry this version cannot read
 * stays as it is. Spec: docs/contrib/passkeys.md (section 5.1)
 */
export function serializeLoginBody(data: LoginInput, previous = ''): string {
  const { passkeys: stored, ...rest } = storedVaultKeys(previous);
  const kept = passkeyEntries(stored);
  const passkeys: unknown[] = [...(data.passkeys ?? kept.valid), ...kept.other];
  return JSON.stringify({
    ...rest,
    url: data.url,
    username: data.username,
    password: data.password,
    totp: data.totp,
    notes: data.notes,
    ...(passkeys.length ? { passkeys } : {}),
  });
}

/**
 * Whether a login holds a site passkey. The text check first, so the list
 * parses only the bodies that name the key. Spec: docs/contrib/passkeys.md (section 5.1, Kinds)
 */
export function loginHasPasskey(note: { type?: string; body: string }): boolean {
  if (note.type !== 'login' || !note.body.includes('"passkeys"')) return false;
  return parseLoginBody(note.body).passkeys.length > 0;
}

/** The note types the Vault lists. */
const VAULT_TYPES = new Set(['login', 'card', 'ssh-key']);

/**
 * Whether a vault item passes the kind filter. `passkey` is a login that
 * holds one, so every place that compares the filter with a note asks here
 * and the filter never resets to All for a login with a passkey.
 * Spec: docs/contrib/passkeys.md (section 5.1, Kinds)
 */
export function matchesVaultFilter(filter: VaultFilter, note: { type?: string; body: string }, gated = false): boolean {
  if (!VAULT_TYPES.has(note.type ?? '')) return false;
  if (filter === 'all') return true;
  // A login behind the PIN keeps its body to itself, the passkey included.
  if (filter === 'passkey') return !gated && loginHasPasskey(note);
  return note.type === filter;
}

/** The count of each kind chip, from the list the Vault filters; `gated` names
 *  the items behind the PIN right now. Spec: docs/contrib/passkeys.md (section 7) */
export function vaultKindCounts<N extends { type?: string; body: string }>(
  notes: readonly N[],
  gated: (n: N) => boolean = () => false,
): Record<VaultFilter, number> {
  const out: Record<VaultFilter, number> = { all: 0, login: 0, passkey: 0, card: 0, 'ssh-key': 0 };
  for (const n of notes) {
    if (!VAULT_TYPES.has(n.type ?? '')) continue;
    out.all += 1;
    out[n.type as 'login' | 'card' | 'ssh-key'] += 1;
    if (matchesVaultFilter('passkey', n, gated(n))) out.passkey += 1;
  }
  return out;
}
