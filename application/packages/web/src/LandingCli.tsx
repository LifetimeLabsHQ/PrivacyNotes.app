/**
 * The homepage section for the command line `privacynotes` (owner, 2026-11-09): three
 * tabs (a script, an AI coding agent, an AI app over MCP), a dark terminal
 * that types the command and shows the command's card, and a phone whose Agent folder
 * takes the new note once the card is shown. With reduced motion the command
 * and the note show at once. privacynotes prints English cards in every language, so
 * the terminal's command and card lines are constants (rule AB's reason);
 * the person's words, the agent's and the chat's are catalog copy.
 * Spec: docs/internal/plans/agent-cli.md (section 3.10)
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BracketsCurly, LockSimple, Plugs, Robot, ShieldCheck, TerminalWindow, ArrowUpRight, FolderSimple } from './icons';
import { CmdBlock } from './LandingCmdBlock';
import { CLI_EXAMPLES, cliExampleBody, cliExampleTitle } from './cliExamples';
import { helpPath } from './localeRoutes';
import { activeLocale } from './i18n';

type Tab = 'script' | 'agent' | 'app';

/** What privacynotes itself prints, the same in every language. */
const COMMAND: Record<Tab, string> = {
  script: 'git log -15 | privacynotes save --title "Recent commits" --tag dev',
  agent: 'privacynotes save --tag project,plan plan.md',
  app: '',
};
const CARD: Record<Tab, { title: string; tags: string[]; size: string }> = {
  script: { title: 'Recent commits', tags: ['dev'], size: '2 KB' },
  agent: { title: 'Refactor plan', tags: ['project', 'plan'], size: '4 KB' },
  app: { title: 'Meeting: launch plan', tags: ['meeting'], size: '1 KB' },
};
const TOOL_CALL = 'privacynotes · save_note';


const SAVED = ' ✓ SAVED ';
const LABEL = { folder: 'folder', tags: 'tags', size: 'size' };

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function LandingCli({ kicker }: { kicker: ReactNode }) {
  const { t } = useTranslation('landing');
  const [tab, setTab] = useState<Tab>('script');
  // How much of the command is typed; past its length the card and the note show.
  const [typed, setTyped] = useState(0);
  const command = COMMAND[tab];
  const done = typed >= command.length;

  useEffect(() => {
    if (reducedMotion() || !command) {
      setTyped(command.length);
      return;
    }
    setTyped(0);
    const id = window.setInterval(() => setTyped((n) => (n >= command.length ? n : n + 2)), 30);
    return () => window.clearInterval(id);
  }, [command]);

  const card = CARD[tab];
  const tabs: [Tab, ReactNode, string][] = [
    ['script', <TerminalWindow key="s" />, t('cli.tabScript')],
    ['agent', <Robot key="a" />, t('cli.tabAgent')],
    ['app', <Plugs key="p" />, t('cli.tabApp')],
  ];
  const facts: [ReactNode, string][] = [
    [<LockSimple key="l" />, t('shell:cli.factAddTitle')],
    [<ShieldCheck key="e" />, t('shell:cli.factEncTitle')],
    [<FolderSimple key="f" />, t('cli.factFolder')],
    [<BracketsCurly key="j" />, t('cli.factJson')],
  ];

  return (
    <div className="mx-auto mb-14">
      {kicker}
      <h2 className="text-display-3 sm:text-display-5 font-black tracking-tight text-[var(--wl-ink)]">{t('cli.heading')}</h2>
      <p className="mt-4 text-title text-[var(--wl-sub)] leading-relaxed">{t('cli.intro')}</p>

      <div role="tablist" aria-label={t('cli.tabsLabel')} className="mt-7 flex flex-wrap gap-2">
        {tabs.map(([key, icon, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`inline-flex cursor-pointer items-center gap-2 rounded-full border-[1.5px] px-3.5 py-1.5 text-small font-semibold transition ${tab === key ? 'border-[var(--wl-ink)] bg-[var(--wl-ink)] text-[var(--wl-bg)]' : 'border-[var(--wl-line)] text-[var(--wl-ink)] hover:border-[var(--wl-ink)]'}`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[1.4fr_1fr]">
        {/* The terminal: the command typed, then the command's card. */}
        <div role="tabpanel" dir="ltr" className="overflow-hidden rounded-2xl md:min-h-72 border border-[var(--wl-ink-line)] bg-[var(--wl-ink-card)] p-5 font-mono text-small leading-relaxed text-[var(--wl-ink-text)]"> {/* rtl-ok: a terminal runs left to right */}
          <div aria-hidden="true" className="mb-4 flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--wl-ink-line)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--wl-ink-line)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--wl-ink-line)]" />
          </div>
          {tab === 'agent' && <p className="mb-3 font-sans text-[var(--wl-ink-sub)]">{t('cli.agentAsk')}</p>}
          {tab === 'app' ? (
            <div className="space-y-2 font-sans">
              <p className="ms-auto w-fit max-w-[85%] rounded-xl bg-white/10 px-3 py-2 text-white">{t('cli.appAsk')}</p>
              <p className="w-fit rounded-lg border border-dashed border-violet-400/50 px-2.5 py-1 font-mono text-meta text-violet-300">{TOOL_CALL}</p>
              <p className="w-fit max-w-[85%] rounded-xl bg-emerald-400/10 px-3 py-2 text-emerald-100">{t('cli.appDone', { title: card.title })}</p>
            </div>
          ) : (
            <>
              <p className="[overflow-wrap:anywhere]">
                <span className="text-[var(--wl-ink-sub)]">$ </span>
                {command.slice(0, typed)}
                {!done && <span aria-hidden="true" className="ms-px inline-block h-4 w-2 translate-y-0.5 bg-[var(--wl-ink-text)]" />}
              </p>
              <div className={`mt-4 space-y-0.5 transition duration-300 ${done ? 'opacity-100' : 'opacity-0'}`}>
                <p>
                  <span className="rounded-sm bg-emerald-700 px-1 font-bold text-white">{SAVED}</span>
                  <span className="ms-2 font-bold text-white">{card.title}</span>
                </p>
                <p><span className="inline-block w-16 text-[var(--wl-ink-sub)]">{LABEL.folder}</span>Agent</p>
                <p>
                  <span className="inline-block w-16 text-[var(--wl-ink-sub)]">{LABEL.tags}</span>
                  {card.tags.map((tag) => <span key={tag} className="me-1.5 rounded-sm bg-amber-300/15 px-1 text-amber-200">{tag}</span>)}
                </p>
                <p><span className="inline-block w-16 text-[var(--wl-ink-sub)]">{LABEL.size}</span>{card.size}</p>
              </div>
              {tab === 'agent' && done && <p className="mt-3 font-sans text-violet-300">{t('cli.agentDone', { title: card.title })}</p>}
            </>
          )}
        </div>

        {/* The phone: the Agent folder, with the new note on top. */}
        <div aria-hidden="true" className="rounded-[2rem] border-[6px] border-[var(--wl-ink)] bg-[var(--wl-card)] p-3">
          <div className="mb-3 flex items-center gap-2 px-1 pt-1 font-extrabold text-[var(--wl-ink)]">
            <Robot className="text-[var(--wl-emerald)]" />
            Agent
          </div>
          <div className="space-y-2">
            <div className={`rounded-xl border-2 p-3 transition duration-500 ${done ? 'translate-y-0 border-[var(--wl-emerald)] bg-[var(--wl-tint-green)] opacity-100' : '-translate-y-2 border-transparent opacity-0'}`}>
              <div className="font-bold text-[var(--wl-ink)]">{card.title}</div>
              <div className="text-meta text-[var(--wl-sub)]">{card.tags.map((x) => `#${x}`).join(' ')} · {t('cli.justNow')}</div>
            </div>
            {[t('cli.sampleNote1'), t('cli.sampleNote2')].map((title) => (
              <div key={title} className="rounded-xl border-2 border-[var(--wl-line)] p-3">
                <div className="font-bold text-[var(--wl-ink)]">{title}</div>
                <div className="text-meta text-[var(--wl-sub)]">{t('cli.earlier')}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* What it is for, in six moments people know (the seventh, JSON for your own tools, is the fact chip below): three cards a row on the
          slab lift, like the medication section. */}
      <h3 className="mt-10 text-title font-extrabold text-[var(--wl-ink)]">{t('cli.useHeading')}</h3>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CLI_EXAMPLES.map(({ key, icon: Glyph, command }) => (
          <div key={key} className="pn-fx-slab space-y-2 rounded-2xl border-2 border-[var(--wl-edge)] bg-[var(--wl-card)] p-5">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--wl-tint-green)] text-[var(--wl-emerald)]"><Glyph size={20} weight="duotone" /></div>
            <div className="font-extrabold text-[var(--wl-ink)]">{t(cliExampleTitle(key))}</div>
            <p className="text-body leading-relaxed text-[var(--wl-sub)]">{t(cliExampleBody(key))}</p>
            <CmdBlock tone="dark" cmd={command} />
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
        {facts.map(([icon, label]) => (
          <span key={label} className="inline-flex items-center gap-2 font-mono text-meta font-semibold uppercase tracking-widest text-[var(--wl-sub)]">
            <span className="text-[var(--wl-emerald)]">{icon}</span>
            {label}
          </span>
        ))}
        <a
          href={`${helpPath(activeLocale())}/command-line/`}
          className="ms-auto inline-flex items-center gap-1.5 font-semibold text-[var(--wl-ink)] underline-offset-4 hover:underline"
        >
          {t('cli.howLink')}
          <ArrowUpRight aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
