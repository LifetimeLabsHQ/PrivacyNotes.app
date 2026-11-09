/**
 * `pn mcp`: the same `pn`, as a Model Context Protocol server over stdio, so
 * an AI app with no terminal can call it as a tool. One JSON-RPC 2.0 message a
 * line on stdin, one answer a line on stdout; nothing else may reach stdout.
 * One tool, `save_note`, which does what `pn save` does through the same
 * token: it can only add a note to the Agent folder.
 * Spec: docs/internal/plans/agent-cli.md (section 3.9)
 */
import { CliError, type Connection } from './core';

/** The protocol versions this server speaks, newest first. */
export const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface McpDeps {
  version: string;
  /** The saved connection, or null when `pn login` has not run. */
  connection: () => Connection | null;
  /** Build, seal and send one note; resolves to its title. Throws a CliError. */
  save: (c: Connection, input: { markdown: string; title?: string; tags: string[] }) => Promise<string>;
}

type Id = string | number | null;
interface Request {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

const SAVE_TOOL = {
  name: 'save_note',
  title: 'Save a note to PrivacyNotes',
  description:
    'Save Markdown as a new note in the PrivacyNotes Agent folder of the person who connected pn. The note is encrypted on this computer and shows in their apps after the next sync. Use it when they ask to save, keep or store something in their notes. It can only add notes: it cannot read, change or delete them.',
  inputSchema: {
    type: 'object',
    properties: {
      markdown: { type: 'string', description: 'The note body, in Markdown. Up to 700 KB.' },
      title: { type: 'string', description: 'The title. Default: the first # heading, else the first line.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags without the #, up to 20.' },
    },
    required: ['markdown'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
} as const;

const ok = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** One incoming line; the answer to write, or null for a notification. */
export async function handleMcpLine(line: string, deps: McpDeps): Promise<object | null> {
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') return fail(req?.id ?? null, -32600, 'Invalid request');
  const notification = req.id === undefined;
  const id: Id = req.id ?? null;

  switch (req.method) {
    case 'initialize': {
      const asked = req.params?.protocolVersion;
      const version = MCP_VERSIONS.find((v) => v === asked) ?? MCP_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'privacynotes', title: 'PrivacyNotes', version: deps.version },
        instructions: 'Use save_note to add a note to the PrivacyNotes Agent folder. This server cannot read notes.',
      });
    }
    case 'ping':
      return notification ? null : ok(id, {});
    case 'tools/list':
      return ok(id, { tools: [SAVE_TOOL] });
    case 'tools/call': {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      if (name !== SAVE_TOOL.name) return fail(id, -32602, `Unknown tool: ${String(name)}`);
      if (typeof args.markdown !== 'string') return ok(id, text('markdown must be a string.', true));
      if (args.title !== undefined && typeof args.title !== 'string') return ok(id, text('title must be a string.', true));
      const tags = args.tags === undefined ? [] : args.tags;
      if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) return ok(id, text('tags must be a list of strings.', true));
      const c = deps.connection();
      if (!c) return ok(id, text('pn is not connected. The person must run pn login in a terminal first, with a code from Settings > CLI.', true));
      try {
        const title = await deps.save(c, { markdown: args.markdown, ...(args.title !== undefined ? { title: args.title } : {}), tags: tags as string[] });
        return ok(id, text(`Saved "${title || 'Untitled'}" to the Agent folder. It shows in the PrivacyNotes apps after the next sync.`));
      } catch (e) {
        const msg = e instanceof CliError ? `${e.detail}${e.fix ? ` Fix: ${e.fix}.` : ''}` : 'The note was not saved.';
        return ok(id, text(msg, true));
      }
    }
    default:
      // A notification we do not know (notifications/initialized and the
      // like) needs no answer; an unknown request gets the standard error.
      return notification ? null : fail(id, -32601, `Method not found: ${req.method}`);
  }
}
