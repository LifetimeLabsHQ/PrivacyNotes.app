/**
 * The command line `privacynotes`, without its terminal: arguments, the note row, the
 * seal, the server calls and the config file. `pn.ts` wires it to the process.
 * `privacynotes` never holds the content key or the inbox private key: it holds the
 * account's inbox public key and a token that can only add notes.
 * Spec: docs/internal/plans/agent-cli.md (sections 3.2 to 3.5)
 */
import {
  decodePairingCode,
  hashHex,
  INBOX_NOTE_LIMITS,
  padInboxJson,
  inboxNoteTitle,
  parseInboxNote,
  sealInbox,
  type InboxNote,
} from '@notes/shared/extension';

const base64ToBytes = (b64: string): Uint8Array => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new Error('not base64');
  return new Uint8Array(Buffer.from(b64, 'base64'));
};
const bytesToBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Exit codes. Spec: docs/internal/plans/agent-cli.md (section 3.5) */
export const EXIT = { ok: 0, refused: 1, input: 2, notConnected: 3, network: 4 } as const;

/** A refusal `privacynotes` can explain: an exit code, a stable id for `--json`, the
 *  badge, one line of detail and, where there is one, the fix. */
export class CliError extends Error {
  constructor(
    readonly code: number,
    readonly id: string,
    readonly title: string,
    readonly detail: string,
    readonly fix?: string,
  ) {
    super(detail);
  }
}

export interface Connection {
  v: 1;
  token: string;
  tokenId: string;
  account: string;
  inboxPublic: string;
  label: string;
  /** The last note this computer saved, for `privacynotes status`. */
  lastSave?: { title: string; at: string };
}

export function parseConnection(value: unknown): Connection | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (c.v !== 1) return null;
  if (typeof c.token !== 'string' || !/^[0-9a-f]{64}$/.test(c.token)) return null;
  if (typeof c.account !== 'string' || !/^[0-9a-f]{64}$/.test(c.account)) return null;
  if (typeof c.tokenId !== 'string' || typeof c.label !== 'string' || typeof c.inboxPublic !== 'string') return null;
  try {
    if (base64ToBytes(c.inboxPublic).length !== 32) return null;
  } catch {
    return null;
  }
  const last = c.lastSave as Record<string, unknown> | undefined;
  const lastSave = last && typeof last.title === 'string' && typeof last.at === 'string' ? { title: last.title, at: last.at } : undefined;
  return { v: 1, token: c.token, tokenId: c.tokenId, account: c.account, inboxPublic: c.inboxPublic, label: c.label, ...(lastSave ? { lastSave } : {}) };
}

// ── Arguments ───────────────────────────────────────────────────────

export interface Args {
  command: string | null;
  positional: string[];
  title?: string;
  tags: string[];
  json: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { command: null, positional: [], tags: [], json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (name: string): string => {
      const eq = a.indexOf('=');
      if (eq > 0) return a.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined) throw new CliError(EXIT.input, 'bad_option', 'MISSING VALUE', `${name} needs a value.`, `privacynotes save ${name} ...`);
      return next;
    };
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--title' || a.startsWith('--title=')) out.title = value('--title');
    else if (a === '--tag' || a.startsWith('--tag=') || a === '--tags' || a.startsWith('--tags=')) {
      out.tags.push(...value('--tag').split(',').map((t) => t.trim()).filter(Boolean));
    } else if (a.startsWith('--')) throw new CliError(EXIT.input, 'bad_option', 'UNKNOWN OPTION', `privacynotes does not know ${a}.`, 'privacynotes --help');
    else if (out.command === null) out.command = a;
    else out.positional.push(a);
  }
  return out;
}

// ── The note row ────────────────────────────────────────────────────

/** The title rule is shared with the extension's New note. */
export const titleOf = inboxNoteTitle;

/** The note `privacynotes save` sends. Throws a CliError with EXIT.input when the app
 *  would refuse it. */
export function buildNote(markdown: string, opts: { title?: string; tags: string[]; id: string; now: Date }): InboxNote {
  if (!markdown.trim()) throw new CliError(EXIT.input, 'empty', 'EMPTY NOTE', 'There is no text to save.', 'privacynotes save note.md, or pipe Markdown in');
  const bytes = new TextEncoder().encode(markdown).length;
  if (bytes > INBOX_NOTE_LIMITS.bodyBytes) {
    throw new CliError(EXIT.input, 'too_large', 'TOO LARGE', `${Math.ceil(bytes / 1024)} KB is over the ${INBOX_NOTE_LIMITS.bodyBytes / 1024} KB a note holds.`, 'split it into two notes');
  }
  const title = opts.title !== undefined ? opts.title.trim() : titleOf(markdown);
  if ([...title].length > INBOX_NOTE_LIMITS.title) {
    throw new CliError(EXIT.input, 'title_too_long', 'TITLE TOO LONG', `A title holds ${INBOX_NOTE_LIMITS.title} characters at most.`, 'use a shorter --title');
  }
  const tags = [...new Set(opts.tags)];
  if (tags.length > INBOX_NOTE_LIMITS.tags) throw new CliError(EXIT.input, 'too_many_tags', 'TOO MANY TAGS', `A note carries ${INBOX_NOTE_LIMITS.tags} tags at most.`);
  const note: InboxNote = { v: 1, id: opts.id, title, markdown, tags, savedAt: opts.now.toISOString() };
  // The app runs the same check; a note it would refuse is never sent.
  if (!parseInboxNote(note, opts.id)) throw new CliError(EXIT.input, 'bad_note', 'CANNOT SAVE', 'The app would refuse this note.');
  return note;
}

function sealNote(note: InboxNote, connection: Connection): string {
  return sealInbox(padInboxJson(note), base64ToBytes(connection.inboxPublic), {
    account: connection.account,
    id: note.id,
    kind: 'note',
  });
}

// ── The server ──────────────────────────────────────────────────────

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

async function call(
  fetchFn: Fetch,
  base: string,
  fn: 'extension-pair' | 'clip-inbox',
  body: unknown,
): Promise<Record<string, unknown>> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchFn(`${base}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new CliError(EXIT.network, 'offline', 'OFFLINE', 'No answer from the server.', 'check the connection, then try again');
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // An answer with no JSON body reads as the bare status.
  }
  if (res.ok) return parsed;
  const code = typeof parsed.error === 'string' ? parsed.error : 'internal';
  if (code === 'not_connected') throw notConnected();
  const known = REFUSALS[code];
  if (known) throw new CliError(EXIT.refused, code, ...known);
  throw new CliError(EXIT.refused, code, 'REFUSED', `The server refused (${code}).`);
}

export const notConnected = () =>
  new CliError(EXIT.notConnected, 'not_connected', 'NOT CONNECTED', 'This computer is not connected.', 'run privacynotes login with a new code');

const REFUSALS: Record<string, [title: string, detail: string, fix?: string]> = {
  invalid_code: ['CODE USED', 'This code is used or expired.', 'make a new one in Settings › CLI'],
  too_many_extensions: ['TOO MANY', 'This account has 5 computers connected.', 'remove one in Settings › CLI'],
  rate_limited: ['SLOW DOWN', 'Too many notes in a short time.', 'wait a minute, then try again'],
  inbox_full: ['INBOX FULL', 'Too many notes wait for an app to open.', 'open PrivacyNotes on any device'],
  too_large: ['TOO LARGE', 'The note is too large.', 'split it into two notes'],
};

/** Redeem a code from Settings > CLI: a fresh token, sent as its hash. */
export async function login(
  fetchFn: Fetch,
  base: string,
  codeText: string,
  label: string,
  version: string,
  random: (n: number) => Uint8Array,
): Promise<Connection> {
  const code = decodePairingCode(codeText.trim());
  if (!code) throw new CliError(EXIT.input, 'bad_code', 'NOT A CODE', 'That is not a code from Settings › CLI.', 'copy the code again');
  if (code.kext) throw new CliError(EXIT.input, 'bad_code', 'WRONG CODE', 'That code is for a browser extension.', 'make a code in Settings › CLI');
  const token = random(32);
  const answer = await call(fetchFn, base, 'extension-pair', {
    action: 'redeem',
    secret: bytesToHex(code.secret),
    tokenHash: hashHex(token),
    label: [...label].slice(0, 80).join(''),
    version,
  });
  const { account, id } = answer;
  if (typeof account !== 'string' || !/^[0-9a-f]{64}$/.test(account) || typeof id !== 'string') {
    throw new CliError(EXIT.refused, 'unknown_answer', 'UNKNOWN ANSWER', 'The server gave an answer privacynotes does not know.', 'update the PrivacyNotes app');
  }
  return { v: 1, token: bytesToHex(token), tokenId: id, account, inboxPublic: bytesToBase64(code.inboxPublic), label };
}

/** Send one note. The row id is printed; the note id is the app's to make. */
export async function save(fetchFn: Fetch, base: string, connection: Connection, note: InboxNote): Promise<void> {
  await call(fetchFn, base, 'clip-inbox', { token: connection.token, id: note.id, kind: 'note', payload: sealNote(note, connection) });
}

/** Forget the token on the server too. A failure leaves the row in Settings,
 *  where Remove ends it. */
export async function forget(fetchFn: Fetch, base: string, connection: Connection): Promise<boolean> {
  try {
    await call(fetchFn, base, 'extension-pair', { action: 'forget', token: connection.token });
    return true;
  } catch {
    return false;
  }
}

export const HELP = `privacynotes - add notes to PrivacyNotes from a terminal or an AI agent

Usage:
  privacynotes login        Connect this computer. Make a code in
                            Settings > CLI, then paste it here (or pipe
                            it in: privacynotes login < code.txt).
  privacynotes save [FILE] [options]
                            Add a note from FILE, or from stdin.
      --title TEXT          The title. Default: the first # heading,
                            else the first line.
      --tag a,b             Tags (repeat or comma-separate).
  privacynotes mcp          Run as an MCP server, so an AI app with no
                            terminal can save notes. In the app's MCP
                            settings:
                            "command": "privacynotes", "args": ["mcp"]
  privacynotes status       Show whether this computer is connected.
  privacynotes logout       Disconnect this computer.

Options for every command:
  --json                    Print the result as JSON.
  --help, --version

Each note goes to your Agent folder. It shows in your apps after one of
them opens and syncs. A note that no app picks up within 90 days is
deleted from the server. privacynotes can only add notes: it cannot open, change
or delete the notes you have.

Exit codes: 0 done, 1 refused by the server, 2 bad input,
3 not connected, 4 no network.`;
