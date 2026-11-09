import { Fragment } from 'react';
import { CopyButton } from './misc';

/**
 * @catalog TerminalBlock
 * use: a command or a settings line a person copies into a terminal or an app (`echo "# Hello" | privacynotes save`, an MCP entry): a dark block in every theme, a `$` prompt for a command, monospace text with its quoted strings in green, Copy at the end.
 * never: a beige or bordered code box of your own with a CopyButton beside it; commands in a <pre> or a body paragraph.
 */
export function TerminalBlock({ value, prompt = false, copyLabel }: {
  value: string;
  /** Show `$` before a command; leave it off for a settings line. */
  prompt?: boolean;
  copyLabel: string;
}) {
  // Fixed colors on purpose: a terminal is dark in every theme, and the
  // ui/ folder is the one place a fixed color may live (ui-rules.json exempt).
  const parts = value.split(/("[^"]*")/);
  return (
    // theme-ok: a terminal is dark in every theme
    <div dir="ltr" className="flex items-center gap-2.5 rounded-lg border border-white/5 bg-[#17171b] py-1.5 ps-3 pe-1.5">
      {/* theme-ok: a terminal is dark in every theme */}
      <code className="min-w-0 flex-1 truncate font-mono text-small text-zinc-100">
        {/* theme-ok: the prompt of a dark terminal */}
        {prompt && <span className="me-2 select-none text-zinc-500">$</span>}
        {parts.map((p, i) => (p.startsWith('"') ? <span key={i} className="text-emerald-300">{p}</span> : <Fragment key={i}>{p}</Fragment>))}
      </code>
      {/* theme-ok: Copy on a dark terminal */}
      <CopyButton value={value} label={copyLabel} className="!text-zinc-400 hover:!bg-white/10 hover:!text-zinc-100" />
    </div>
  );
}
