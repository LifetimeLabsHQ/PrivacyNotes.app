/**
 * The command line `privacynotes`, without its terminal: arguments, the note row, the
 * seal, the server calls and the config file. `pn.ts` wires it to the process.
 * `privacynotes` never holds the content key or the inbox private key: its config file
 * holds the account's inbox public key and a token that can only add notes, with the
 * account id, the token id, the label and, after a save, the title and time of the
 * last note, all in the clear (`Connection`). A connection made with a version 2 code also
 * holds its own sender seed and the account's ML-KEM public key, and seals signed rows.
 * Spec: docs/internal/plans/agent-cli.md (sections 3.2 to 3.5); docs/internal/plans/inbox-signed-hybrid.md (section 5.3)
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
import { checkedInboxKemPublic, deriveInboxSender, sealInboxSigned } from '@notes/shared/inbox-signed';
// The clip engine's size rule only: the file imports nothing, so the bundle
// stays free of the engine. Not a workspace dependency, so the path is relative.
import { inboxNoteFits } from '../../clipper/src/noteBody';

const base64ToBytes = (b64: string): Uint8Array => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new Error('not base64');
  return new Uint8Array(Buffer.from(b64, 'base64'));
};
const bytesToBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const hexToBytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));

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
  /** 2 for a version 2 code's connection, which holds `signSeed` and
   *  `kemPublic`: an older `privacynotes` reads that file as not connected,
   *  never as a connection it would save back without them (spec review H4). */
  v: 1 | 2;
  token: string;
  tokenId: string;
  account: string;
  inboxPublic: string;
  label: string;
  /** The last note this computer saved, for `privacynotes status`. */
  lastSave?: { title: string; at: string };
  /** A version 2 code's sender seed and the account's ML-KEM public key, base64:
   *  every note is then a signed row. Absent for a version 1 code. */
  signSeed?: string;
  kemPublic?: string;
}

export function parseConnection(value: unknown): Connection | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (c.v !== 1 && c.v !== 2) return null;
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
  // Both or neither: a file with one of them is not one this tool wrote, and a
  // version 2 connection never falls back to unsigned rows.
  if ((c.signSeed === undefined) !== (c.kemPublic === undefined) || (c.v === 2) !== (c.signSeed !== undefined)) return null;
  let signed: { signSeed: string; kemPublic: string } | undefined;
  if (c.signSeed !== undefined) {
    try {
      if (typeof c.signSeed !== 'string' || typeof c.kemPublic !== 'string' || base64ToBytes(c.signSeed).length !== 32 || base64ToBytes(c.kemPublic).length !== 1184) return null;
    } catch {
      return null;
    }
    signed = { signSeed: c.signSeed, kemPublic: c.kemPublic };
  }
  return { v: signed ? 2 : 1, token: c.token, tokenId: c.tokenId, account: c.account, inboxPublic: c.inboxPublic, label: c.label, ...(lastSave ? { lastSave } : {}), ...signed };
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
  // The app's rule, which can keep a note as one code block: a note that
  // passes it is never refused when the app adopts it.
  if (bytes > INBOX_NOTE_LIMITS.bodyBytes || !inboxNoteFits(markdown)) {
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

export function sealNote(note: InboxNote, connection: Connection): string {
  const ctx = { account: connection.account, id: note.id, kind: 'note' as const };
  if (connection.signSeed && connection.kemPublic) {
    const sender = deriveInboxSender(base64ToBytes(connection.signSeed));
    const to = { inboxPublic: base64ToBytes(connection.inboxPublic), kemPublic: base64ToBytes(connection.kemPublic) };
    return sealInboxSigned(padInboxJson(note), to, sender, ctx);
  }
  return sealInbox(padInboxJson(note), base64ToBytes(connection.inboxPublic), ctx);
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
    // Only a JSON object is an answer of ours: `null`, a list or a bare value
    // reads as the bare status, like an answer with no JSON body.
    const got: unknown = await res.json();
    if (got && typeof got === 'object' && !Array.isArray(got)) parsed = got as Record<string, unknown>;
  } catch {
    // An answer with no JSON body reads as the bare status.
  }
  if (res.ok) return parsed;
  const code = typeof parsed.error === 'string' ? parsed.error : 'internal';
  if (code === 'not_connected') throw notConnected();
  // The word comes from the server, and `constructor` is an inherited member (rule S6).
  const known = Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined;
  if (known) throw new CliError(EXIT.refused, code, ...known);
  throw new CliError(EXIT.refused, code, 'REFUSED', `The server refused (${code}).`);
}

export const notConnected = () =>
  new CliError(EXIT.notConnected, 'not_connected', 'NOT CONNECTED', 'This computer is not connected.', 'run privacynotes login with a new code');

const REFUSALS: Record<string, [title: string, detail: string, fix?: string]> = {
  invalid_code: ['CODE USED', 'This code is used or expired.', 'make a new one in Settings › CLI'],
  too_many_extensions: ['TOO MANY', 'This account has 5 computers connected.', 'remove one in Settings › CLI'],
  rate_limited: ['SLOW DOWN', 'Too many notes in a short time.', 'wait a minute, then try again'],
  inbox_full: ['INBOX FULL', 'Too many notes wait for an app to open, or the account has no room left.', 'open PrivacyNotes on any device, or make room in it'],
  too_large: ['TOO LARGE', 'The note is too large.', 'split it into two notes'],
  // The server's word for a browser code: the same refusal as the check in `login`.
  wrong_client: ['WRONG CODE', 'That code is for a browser extension.', 'make a code in Settings › CLI'],
};

/** The token of a login whose answer may have been lost: the hash of its
 *  code and the token, hex. */
export interface PendingLogin {
  code: string;
  token: string;
}

/** Where `login` keeps its token until the server answers. */
export interface PendingStore {
  read: () => PendingLogin | null;
  write: (pending: PendingLogin | null) => void;
}

/**
 * Redeem a code from Settings > CLI: a fresh token, sent as its hash. A
 * login tried again with the same code sends the same token: the server
 * answers a repeat of a redeem whose answer was lost as it did the first
 * time (beta #184, item 6), where a fresh token would find the code used.
 */
export async function login(
  fetchFn: Fetch,
  base: string,
  codeText: string,
  label: string,
  version: string,
  random: (n: number) => Uint8Array,
  pending?: PendingStore,
): Promise<Connection> {
  const code = decodePairingCode(codeText.trim());
  if (!code) throw new CliError(EXIT.input, 'bad_code', 'NOT A CODE', 'That is not a code from Settings › CLI.', 'copy the code again');
  if (code.kext) throw new CliError(EXIT.input, 'bad_code', 'WRONG CODE', 'That code is for a browser extension.', 'make a code in Settings › CLI');
  const codeHash = hashHex(code.secret);
  const before = pending?.read();
  const token = before?.code === codeHash && /^[0-9a-f]{64}$/.test(before.token) ? hexToBytes(before.token) : random(32);
  pending?.write({ code: codeHash, token: bytesToHex(token) });
  const answer = await call(fetchFn, base, 'extension-pair', {
    action: 'redeem',
    secret: bytesToHex(code.secret),
    tokenHash: hashHex(token),
    label: [...label].slice(0, 80).join(''),
    version,
    // The server refuses a browser code to a command line (beta #184, item 3):
    // a browser code with logins off carries no key half for the check above.
    client: 'cli',
    ...(code.signed ? { kem: true } : {}),
  }).catch((e: unknown) => {
    // A used code never connects: the token goes. Kept for any other end.
    if (e instanceof CliError && e.id === 'invalid_code') pending?.write(null);
    throw e;
  });
  pending?.write(null);
  const { account, id } = answer;
  if (typeof account !== 'string' || !/^[0-9a-f]{64}$/.test(account) || typeof id !== 'string') {
    throw new CliError(EXIT.refused, 'unknown_answer', 'UNKNOWN ANSWER', 'The server gave an answer privacynotes does not know.', 'update the PrivacyNotes app');
  }
  const connection: Connection = { v: 1, token: bytesToHex(token), tokenId: id, account, inboxPublic: bytesToBase64(code.inboxPublic), label };
  if (!code.signed) return connection;
  // A version 2 code connects only with the ML-KEM key its hash names: never
  // as an unsigned connection. Spec: docs/internal/plans/inbox-signed-hybrid.md (section 5.5)
  const kemPublic = checkedInboxKemPublic(answer.kem, code.signed.kemHash);
  if (!kemPublic) throw new CliError(EXIT.refused, 'unknown_answer', 'UNKNOWN ANSWER', 'The server gave an answer privacynotes does not know.', 'make a new code and try again');
  return { ...connection, v: 2, signSeed: bytesToBase64(code.signed.seed), kemPublic: bytesToBase64(kemPublic) };
}

/** Send one note. The row id is printed; the note id is the app's to make.
 *  A `not_connected` answer means the server no longer knows the token (the
 *  computer was removed in Settings > CLI), so `forgetLocal` drops the saved
 *  connection, as the browser extension does (`forgetLocal` in its queue.ts):
 *  `privacynotes status` reads only that file. */
export async function save(fetchFn: Fetch, base: string, connection: Connection, note: InboxNote, forgetLocal: () => void): Promise<void> {
  let answer: Record<string, unknown>;
  try {
    answer = await call(fetchFn, base, 'clip-inbox', { token: connection.token, id: note.id, kind: 'note', payload: sealNote(note, connection) });
  } catch (e) {
    if (e instanceof CliError && e.id === 'not_connected') forgetLocal();
    throw e;
  }
  // `clip-inbox` says `{ ok: true }` for a row it stored, and nothing else
  // does. A 2xx without it came from something in between (the sign-in page
  // of a network, a proxy's block page), and no row exists. The network exit
  // code, so a script tries again.
  if (answer.ok !== true) {
    throw new CliError(EXIT.network, 'no_answer', 'NOT SAVED', 'The answer did not come from PrivacyNotes.', 'check the connection, then try again');
  }
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
                            On Windows, pipe the note in (type note.md |
                            privacynotes save): cmd can change % signs
                            and quotes in words typed on the line.
  privacynotes mcp          Run as an MCP server, so an AI app with no
                            terminal can save notes. In the app's MCP
                            settings:
                            "command": "privacynotes", "args": ["mcp"]
  privacynotes status       Show the connection saved on this computer.
                            It does not ask the server: a computer
                            removed in Settings > CLI shows as connected
                            until a save is refused.
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
