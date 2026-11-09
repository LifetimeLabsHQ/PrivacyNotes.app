/**
 * `privacynotes`: the process side. Reads stdin, files and the config file, draws each
 * result as a card (ui.ts), and exits with the codes of `core.ts`. The code
 * for `privacynotes login` is read from a prompt or a pipe, never from the arguments,
 * so it stays out of the shell history. The config file holds a token that
 * can only add notes; it is written with mode 0600.
 * Spec: docs/internal/plans/agent-cli.md (section 3.5)
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { INBOX_NOTE_LIMITS } from '@notes/shared/extension';
import { buildNote, CliError, EXIT, forget, HELP, login, notConnected, parseArgs, parseConnection, save, type Connection, type Fetch } from './core';
import { handleMcpLine } from './mcp';
import { ago, chips, kilobytes, kv, renderCard, sizeBar, wantsColor, type Card, type Style } from './ui';

declare const __PN_VERSION__: string;

const FUNCTIONS_URL = process.env.PN_FUNCTIONS_URL || 'https://sync.privacynotes.app/functions/v1';

function configPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'PrivacyNotes', 'cli.json');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'privacynotes', 'cli.json');
}

function readConnection(): Connection | null {
  try {
    return parseConnection(JSON.parse(readFileSync(configPath(), 'utf8')));
  } catch {
    return null;
  }
}

function writeConnection(c: Connection): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const style = (stream: NodeJS.WriteStream, json: boolean): Style => ({
  color: !json && wantsColor(stream.isTTY, process.env),
  columns: stream.columns || 60,
});

async function readCode(): Promise<string> {
  if (!process.stdin.isTTY) return (await readStdin()).trim();
  const prompt: Card = {
    tone: 'brand',
    badge: '◆ PrivacyNotes',
    rows: [[['Connect this computer', 'bold']], [['Paste the code from Settings › CLI', 'dim']]],
  };
  process.stderr.write(`\n${renderCard(prompt, style(process.stderr, false))}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(wantsColor(process.stderr.isTTY, process.env) ? '  \u001b[38;5;141m›\u001b[0m ' : '> ')).trim();
  } catch {
    // The input ended before a line came (Ctrl+D, or a closed pipe).
    throw new CliError(EXIT.input, 'no_code', 'NO CODE', 'No code was typed.', 'run privacynotes login again and paste the code');
  } finally {
    rl.close();
  }
}

const fetchFn: Fetch = (url, init) => fetch(url, init);

/** One result: a card for a person, JSON for a script. */
function show(json: boolean, value: Record<string, unknown>, card: Card): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  const s = style(process.stdout, false);
  process.stdout.write(s.color ? `\n${renderCard(card, s)}\n\n` : `${renderCard(card, s)}\n`);
}

async function main(argv: string[], json: { on: boolean }): Promise<number> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    throw new CliError(EXIT.input, 'old_node', 'NODE TOO OLD', `privacynotes needs Node.js 20 or newer. This is ${process.versions.node}.`, 'update Node.js');
  }
  const args = parseArgs(argv);
  json.on = args.json;
  if (args.version) {
    process.stdout.write(`${__PN_VERSION__}\n`);
    return EXIT.ok;
  }
  if (args.help || args.command === null || args.command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }

  if (args.command === 'login') {
    const code = await readCode();
    const label = `Command line on ${hostname() || 'this computer'}`;
    const c = await login(fetchFn, FUNCTIONS_URL, code, label, __PN_VERSION__, (n) => new Uint8Array(randomBytes(n)));
    writeConnection(c);
    show(args.json, { connected: true, label: c.label }, {
      tone: 'ok',
      badge: '✓ CONNECTED',
      rows: [kv('computer', [c.label]), kv('folder', ['Agent']), kv('account', [shortId(c.account), 'dim'])],
      footer: [['Try it: ', 'dim'], ['echo "# Hello" | privacynotes save', 'accent']],
    });
    return EXIT.ok;
  }

  if (args.command === 'status') {
    const c = readConnection();
    if (!c) throw notConnected();
    show(args.json, { connected: true, label: c.label, account: c.account.slice(0, 8), lastSave: c.lastSave ?? null }, {
      tone: 'brand',
      badge: '● STATUS',
      rows: [
        kv('state', ['connected', 'ok']),
        kv('computer', [c.label]),
        c.lastSave ? kv('last save', [c.lastSave.title || 'Untitled'], [`, ${ago(c.lastSave.at, new Date())}`, 'dim']) : kv('last save', ['none yet', 'dim']),
      ],
    });
    return EXIT.ok;
  }

  if (args.command === 'logout') {
    const c = readConnection();
    if (!c) {
      show(args.json, { connected: false }, { tone: 'brand', badge: '● STATUS', rows: [kv('state', ['not connected', 'dim'])] });
      return EXIT.ok;
    }
    const forgotten = await forget(fetchFn, FUNCTIONS_URL, c);
    rmSync(configPath(), { force: true });
    show(args.json, { connected: false, serverForgot: forgotten }, {
      tone: 'ok',
      badge: '✓ DISCONNECTED',
      rows: [kv('computer', [c.label])],
      footer: forgotten
        ? [['The token is gone from the server too.', 'dim']]
        : [['No answer from the server: ', 'dim'], ['remove it in Settings › CLI', 'warn']],
    });
    return EXIT.ok;
  }

  if (args.command === 'save') {
    const c = readConnection();
    if (!c) throw notConnected();
    const file = args.positional[0];
    let markdown: string;
    if (file && file !== '-') {
      try {
        markdown = readFileSync(file, 'utf8');
      } catch {
        throw new CliError(EXIT.input, 'cannot_read', 'CANNOT READ', `privacynotes cannot read ${file}.`, 'check the path');
      }
    } else if (!process.stdin.isTTY) {
      markdown = await readStdin();
    } else {
      throw new CliError(EXIT.input, 'no_input', 'NOTHING TO SAVE', 'Name a file, or pipe Markdown in.', 'privacynotes save note.md');
    }
    const note = await saveNote(c, { markdown, title: args.title, tags: args.tags });
    const bytes = new TextEncoder().encode(note.markdown).length;
    const size = bytes > INBOX_NOTE_LIMITS.bodyBytes * 0.05
      ? kv('size', ...sizeBar(bytes, INBOX_NOTE_LIMITS.bodyBytes), [`  ${kilobytes(bytes)} of ${kilobytes(INBOX_NOTE_LIMITS.bodyBytes)}`, 'dim'])
      : kv('size', [kilobytes(bytes)]);
    show(args.json, { id: note.id, title: note.title, tags: note.tags, bytes }, {
      tone: 'ok',
      badge: '✓ SAVED',
      rows: [
        [[note.title || 'Untitled', 'bold']],
        [['']],
        kv('folder', ['Agent']),
        ...(note.tags.length ? [kv('tags', ...chips(note.tags))] : []),
        size,
      ],
      footer: [['Encrypted on this computer', 'dim'], [' · ', 'dim'], ['shows after the next sync', 'ok']],
    });
    return EXIT.ok;
  }

  if (args.command === 'mcp') {
    await serveMcp();
    return EXIT.ok;
  }

  throw new CliError(EXIT.input, 'unknown_command', 'UNKNOWN COMMAND', `privacynotes does not know "${args.command}".`, 'privacynotes --help');
}

/** Build, seal and send one note, then remember it for `privacynotes status`. Shared
 *  by `privacynotes save` and the `save_note` tool of `privacynotes mcp`. */
async function saveNote(c: Connection, input: { markdown: string; title?: string; tags: string[] }) {
  const note = buildNote(input.markdown, { title: input.title, tags: input.tags, id: randomUUID(), now: new Date() });
  await save(fetchFn, FUNCTIONS_URL, c, note);
  writeConnection({ ...c, lastSave: { title: note.title, at: note.savedAt } });
  return note;
}

/** `privacynotes mcp`: one JSON-RPC message a line, answered in order, until stdin
 *  closes. Only answers reach stdout.
 *  Spec: docs/internal/plans/agent-cli.md (section 3.9) */
async function serveMcp(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const deps = {
    version: __PN_VERSION__,
    connection: readConnection,
    save: async (c: Connection, input: { markdown: string; title?: string; tags: string[] }) => (await saveNote(c, input)).title,
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    const answer = await handleMcpLine(line, deps);
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  }
}

const shortId = (account: string) => `${account.slice(0, 4)} ${account.slice(4, 8)}`;

const json = { on: process.argv.includes('--json') };
main(process.argv.slice(2), json).then(
  (code) => process.exit(code),
  (err: unknown) => {
    // PN_DEBUG=1 prints the cause of an error privacynotes did not expect, on stderr only.
    if (process.env.PN_DEBUG && !(err instanceof CliError)) process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    const e = err instanceof CliError ? err : new CliError(EXIT.refused, 'internal', 'SOMETHING WENT WRONG', 'privacynotes stopped on an error it did not expect.');
    if (json.on) {
      process.stderr.write(`${JSON.stringify({ error: e.id, message: e.detail, ...(e.fix ? { fix: e.fix } : {}) })}\n`);
    } else {
      const s = style(process.stderr, false);
      const card: Card = {
        tone: 'error',
        badge: `✗ ${e.title}`,
        rows: [[[e.detail]]],
        ...(e.fix ? { footer: [['Fix: ', 'dim'], [e.fix, 'warn']] as const } : {}),
      };
      process.stderr.write(s.color ? `\n${renderCard(card, s)}\n\n` : `${renderCard(card, s)}\n`);
    }
    process.exit(e.code);
  },
);
