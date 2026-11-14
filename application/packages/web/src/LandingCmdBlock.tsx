import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from './icons';

/**
 * Rounded mono command block with a copy button glued to its right edge. The single way
 * the homepage presents a shell command: /download (DebCmd, PkgCmd, the Obtainium source)
 * and the command-line examples in LandingCli.tsx all render through it, so a styling or
 * behaviour change lands on every command at once. The command wraps between words,
 * never truncates.
 * The button copies the unwrapped one-line command, and flips to a check for a moment as
 * feedback. `tone="dark"` is the terminal look of the command-line cards.
 */
export function CmdBlock({ cmd, className, tone = 'light' }: { cmd: string; className?: string; tone?: 'light' | 'dark' }) {
  const { t } = useTranslation('landing');
  const [copied, setCopied] = useState(false);
  const dark = tone === 'dark';
  return (
    <div dir="ltr" className={`flex items-center justify-between gap-2 py-1 ps-2.5 pe-1 ${dark ? 'rounded-md bg-[var(--wl-ink-card)]' : 'rounded-lg bg-[var(--wl-ink)]/8'} ${className ?? ''}`}> {/* rtl-ok: a command runs left to right */}
      <code className={`min-w-0 whitespace-pre-wrap py-0.5 font-mono [overflow-wrap:anywhere] ${dark ? 'text-meta text-[var(--wl-ink-text)]' : 'text-small text-[var(--wl-ink)]'}`}>
        {/* A line breaks between words only, so "--tag" never splits after its
            dashes; a word longer than the line still wraps inside itself. */}
        {cmd.split(' ').map((word, i) => (
          <span key={i}>{i > 0 && ' '}<span className="inline-block max-w-full">{word}</span></span>
        ))}
      </code>
      <button
        type="button"
        aria-label={t('common:actions.copy')}
        title={t('common:actions.copy')}
        onClick={() => {
          navigator.clipboard.writeText(cmd).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
        className={`shrink-0 cursor-pointer rounded-md p-1.5 transition ${dark ? 'text-[var(--wl-ink-text)]/70 hover:bg-white/10 hover:text-[var(--wl-ink-text)]' : 'text-[var(--wl-sub)] hover:bg-[var(--wl-ink)]/8 hover:text-[var(--wl-ink)]'}`}
      >
        {copied ? <Check weight="bold" /> : <Copy weight="bold" />}
      </button>
    </div>
  );
}
