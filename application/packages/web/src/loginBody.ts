/**
 * The body of a login item: one JSON object in the note body.
 */
import { storedVaultKeys } from './vaultBody';

/* ────────────────────────────────────────────────────────────────
 * LoginData - the JSON blob stored in the note body for login-type
 * notes. Fields: url (the website), username, password, freeform notes,
 * totp (the raw authenticator key/URI as pasted - never canonicalized).
 * The note's `title` field serves as the display name (e.g. "GitHub")
 * and is auto-derived from the URL domain when empty.
 * ──────────────────────────────────────────────────────────────── */
export interface LoginData {
  url: string;
  username: string;
  password: string;
  totp: string;
  notes: string;
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
    };
  } catch {
    return { url: '', username: '', password: '', totp: '', notes: '' };
  }
}

/** `previous` is the stored body; keys a newer version wrote in it are kept. */
export function serializeLoginBody(data: LoginData, previous = ''): string {
  return JSON.stringify({
    ...storedVaultKeys(previous),
    url: data.url,
    username: data.username,
    password: data.password,
    totp: data.totp,
    notes: data.notes,
  });
}
