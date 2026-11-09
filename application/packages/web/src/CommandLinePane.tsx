/**
 * Settings > CLI: the `privacynotes` command for scripts and AI agents. Off, it shows
 * the pitch (`FeaturePitch`, the Markdown folder's shape) with Turn on (Pro),
 * which makes the Agent folder with the robot icon, and a link to the help
 * page. On, a banner, then three numbered steps (install, connect, save a
 * first note; a step turns green once it is done), the Agent folder, the
 * connected computers with Remove, and Turn off, which disconnects every
 * computer and leaves the folder as a normal folder. A folder that no longer
 * exists reads as off.
 * Spec: docs/internal/plans/agent-cli.md (sections 3.2 and 3.6)
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { BookOpen, BracketsCurly, Check, Download, Plugs, Laptop, Link, LockSimple, MarkdownLogo, Power, Robot, ShieldCheck, Sparkle, Tag, TerminalWindow, UserPlus } from './icons';
import { Badge, Button, Callout, DeleteButton, FeaturePitch, IconTile, ProMark, SETTINGS_BTN, SETTINGS_BTN_PRIMARY, SETTINGS_HELP, Spinner, Switch, TerminalBlock } from './ui';
import { ConfirmModal } from './ConfirmModal';
import { useProGate } from './ui/proGate';
import { SectionEyebrow } from './settingsUI';
import { useAuth } from './auth';
import { isDemoMode, DEMO_APP_URL, proUnlocked } from './demo';
import { ExtensionCallError, loadExtensionState, removeExtension, type ExtensionRow } from './extensionApi';
import { PairingCodeBox, useCodeWatch, type ExtensionAccess } from './BrowserPane';
import { formatRelative } from './intlFormat';
import { CLI_EXAMPLES, cliExampleBody, cliExampleTitle } from './cliExamples';
import { folderLookKey, setItemLook } from './itemStyles';
import { activeLocale } from './i18n';
import { helpPath } from './localeRoutes';
import { siteHref } from './siteLinks';
import { useCliInstall } from './cliInstall';
import type { UserSettings } from './userSettingsShape';

const ERROR_KEY: Record<string, string> = {
  too_many_codes: 'extensionConnect.tooManyCodes',
  too_many_extensions: 'cli.tooMany',
};

/** The first note the help page and the pane both suggest. */
const TRY_IT = 'echo "# Hello" | privacynotes save';
/** Where the one requirement of `privacynotes` comes from (agent-cli.md, C5). */
const NODE_DOWNLOAD = 'https://nodejs.org/en/download';
/** What an AI app's MCP settings take to start `privacynotes mcp` (agent-cli.md section 3.9). */
const MCP_ENTRY = '"privacynotes": { "command": "privacynotes", "args": ["mcp"] }';

export interface CommandLinePaneProps {
  extensionKeys: Pick<ExtensionAccess, 'readKeys' | 'saveKeys'>;
  settings: Pick<UserSettings, 'agentFolder' | 'folders'>;
  mutateSettings: (updater: (prev: UserSettings) => UserSettings) => void;
  /** A root folder in the open space; an existing one of that name is reused. */
  createFolder: (name: string) => { id: string; created: boolean } | null;
  isPro: boolean | null | undefined;
  onUpgrade: () => void;
}

/** The examples from the homepage, one list (cliExamples.ts) in the app's
 *  look: a tile, the title, one line, the command with Copy. Shown in the
 *  pitch while off and at the end once on (owner, 2026-11-09). */
function CliExampleCards() {
  const { t } = useTranslation('shell');
  return (
    <div className="grid gap-2.5 @lg:grid-cols-2">
      {CLI_EXAMPLES.map(({ key, icon: Glyph, command }) => (
        <div key={key} className="space-y-2 rounded-xl border border-divider bg-surface-1 p-3 text-start">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent" aria-hidden="true"><Glyph /></span>
            <p className="text-body font-medium text-pn">{t(cliExampleTitle(key))}</p>
          </div>
          <p className={SETTINGS_HELP}>{t(cliExampleBody(key))}</p>
          <TerminalBlock value={command} prompt={command.startsWith('privacynotes ') || command.includes(' | ')} copyLabel={t('common:actions.copy')} />
        </div>
      ))}
    </div>
  );
}

/** One numbered setup step on a line that joins the steps: a ringed number,
 *  a solid green tick once done, and the line under a done step green too. */
function Step({ n, done, last = false, title, hint, children }: { n: number; done: boolean; last?: boolean; title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <li className={`relative flex gap-3.5 ${last ? '' : 'pb-5'}`}>
      {!last && <span aria-hidden="true" className={`absolute start-[13px] top-8 bottom-1 w-0.5 rounded-full ${done ? 'bg-success/50' : 'bg-divider'}`} />}
      <span
        aria-hidden="true"
        className={`relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full border-[1.5px] text-small font-semibold ${done ? 'border-success bg-success text-surface-2' : 'border-accent/50 bg-surface-2 text-accent'}`}
      >
        {done ? <Check weight="bold" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
        <p className="text-body font-medium text-pn">{title}</p>
        {hint && <p className={SETTINGS_HELP}>{hint}</p>}
        {children}
      </div>
    </li>
  );
}

export function CommandLinePane({ extensionKeys, settings, mutateSettings, createFolder, isPro, onUpgrade }: CommandLinePaneProps) {
  const { t } = useTranslation('shell');
  const { auth, supabase } = useAuth();
  const access: ExtensionAccess | null = isDemoMode() || auth.status !== 'authenticated'
    ? null
    : { supabase, pubkey: auth.pubkey, phrase: auth.phrase, contentKey: auth.encryptionKey, ...extensionKeys };
  const pubkey = access?.pubkey ?? '';
  const unlocked = proUnlocked(isPro);
  const gate = useProGate(unlocked, onUpgrade);
  const folder = settings.folders.find((f) => f.id === settings.agentFolder) ?? null;
  const helpHref = siteHref(`${helpPath(activeLocale())}/command-line/`);
  const mcpHref = siteHref(`${helpPath(activeLocale())}/mcp/`);
  const cli = useCliInstall();

  const [rows, setRows] = useState<ExtensionRow[]>([]);
  const load = useCallback(() => {
    if (!pubkey) return;
    loadExtensionState(supabase, pubkey).then((s) => setRows(s.extensions.filter((r) => r.client === 'cli'))).catch(() => {});
  }, [supabase, pubkey]);
  useEffect(load, [load]);
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const { code, usedBy, show, forget } = useCodeWatch(rows, load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askOff, setAskOff] = useState(false);

  const turnOn = () => {
    const made = createFolder(t('cli.folderName'));
    if (!made) return;
    mutateSettings((prev) => ({
      ...prev,
      agentFolder: made.id,
      itemStyles: setItemLook(prev.itemStyles, folderLookKey(made.id), { icon: 'robot' }),
    }));
  };

  const make = async () => {
    if (!access) return;
    setBusy(true);
    setError(null);
    forget();
    try {
      const { makePairingCode } = await import('./extensionPairing');
      show(await makePairingCode({ ...access, clips: true, logins: false, client: 'cli', pushKeys: async () => true }));
    } catch (err) {
      const reason = err instanceof ExtensionCallError ? ERROR_KEY[err.code] : undefined;
      setError(t(reason ?? 'extensionConnect.failed'));
    } finally {
      setBusy(false);
    }
  };

  const removeOne = async (id: string) => {
    setError(null);
    try {
      await removeExtension(supabase, pubkey, id);
      setRows((all) => all.filter((r) => r.id !== id));
    } catch {
      setError(t('settings:devices.removeFailed'));
    }
  };

  // Every computer goes first, then the setting: a failed Remove leaves the
  // pane on, with the list that is still connected.
  const turnOff = async () => {
    if (!access) return;
    setError(null);
    try {
      for (const r of rows) await removeExtension(supabase, pubkey, r.id);
    } catch {
      load();
      setError(t('settings:devices.removeFailed'));
      return;
    }
    setRows([]);
    mutateSettings((prev) => ({ ...prev, agentFolder: null }));
  };

  const pitch = (
    <FeaturePitch
      banner={{
        tone: 'info',
        icon: <TerminalWindow />,
        title: t('cli.pitchTitle'),
        sub: t('cli.pitchSub'),
        badge: isPro ? undefined : <ProMark />,
      }}
      intro={t('cli.pitchIntro')}
      chips={[
        { icon: <MarkdownLogo />, label: t('cli.chipMarkdown') },
        { icon: <Tag />, label: t('tagsRail.tags') },
        { icon: <BracketsCurly />, label: t('cli.chipJson') },
        { icon: <Plugs />, label: t('cli.chipMcp') },
        { icon: <Robot />, label: t('cli.folderHeading') },
      ]}
      facts={[
        { icon: <LockSimple className="text-success" />, title: t('cli.factAddTitle'), sub: t('cli.factAddSub') },
        { icon: <ShieldCheck className="text-success" />, title: t('cli.factEncTitle'), sub: t('cli.factEncSub') },
      ]}
      tagline={{ icon: <Sparkle />, label: t('cli.tagline') }}
    />
  );

  return (
    <div className="@container flex-1 min-h-0 overflow-y-auto p-6 space-y-6 text-pn">
      {!access || !folder ? (
        <section className="mx-auto max-w-3xl space-y-4">
          {pitch}
          <div className="grid gap-2 @md:grid-cols-2">
            {access ? (
              // A free account gets the Pro door every other Pro button uses:
              // secondary, so the rocket keeps its Pro color (a filled button
              // turns it white).
              <Button variant={isPro ? 'primary' : 'secondary'} pro={!isPro} icon={<Power aria-hidden="true" />} onClick={gate(turnOn)}>
                {t('alerts.turnOn')}
              </Button>
            ) : (
              <a href={DEMO_APP_URL} className={`${SETTINGS_BTN_PRIMARY} inline-flex justify-center`}>
                <UserPlus aria-hidden="true" />
                {t('cli.demoSignUp')}
              </a>
            )}
            <a href={helpHref} target="_blank" rel="noopener noreferrer" className={`${SETTINGS_BTN} inline-flex justify-center`}>
              <BookOpen aria-hidden="true" />
              {t('cli.howItWorks')}
            </a>
          </div>
          <div className="space-y-2 pt-2">
            <SectionEyebrow icon={Sparkle}>{t('landing:cli.useHeading')}</SectionEyebrow>
            <CliExampleCards />
          </div>
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3.5 rounded-xl border border-accent/30 bg-accent/10 p-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-accent-fill text-surface-2 [&>svg]:size-6" aria-hidden="true">
              <TerminalWindow />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-title font-semibold leading-snug text-pn">{t('cli.pitchTitle')}</p>
              <p className="text-small leading-snug text-pn-muted">{t('cli.pitchSub')}</p>
              <Badge tone={rows.length ? 'success' : 'neutral'} icon={<span className="size-1.5 rounded-full bg-current" />}>
                {rows.length ? t('cli.statusConnected', { count: rows.length }) : t('cli.statusNone')}
              </Badge>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              {/* The state in plain sight: a switch, never an icon that could
                  read as either. Off asks first (pattern 169). */}
              <Switch label={t('cli.railLabel')} checked onChange={(on) => { if (!on) setAskOff(true); }} />
              <a href={helpHref} target="_blank" rel="noopener noreferrer" className={`${SETTINGS_BTN} inline-flex bg-surface-2`}>
                <BookOpen aria-hidden="true" />
                {t('cli.howItWorks')}
              </a>
            </div>
          </div>

          <ol className="rounded-xl border border-divider p-4">
            <Step
              n={1}
              done={!!cli.status?.installed || rows.length > 0}
              title={t('cli.stepInstall')}
              hint={<Trans i18nKey="shell:cli.needsNode" components={{ download: <a href={NODE_DOWNLOAD} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline" /> }} />}
            >
              {cli.available && (
                <div className="space-y-2">
                  {cli.status?.installed ? (
                    <Callout tone="success">{t('cli.installed')}</Callout>
                  ) : (
                    <Button variant="primary" icon={cli.busy ? <Spinner size={15} /> : <Download aria-hidden="true" />} onClick={cli.install} disabled={cli.busy}>
                      {t('cli.install')}
                    </Button>
                  )}
                  {cli.error && (
                    <Callout tone="danger">
                      {cli.error === 'not_ours' ? t('cli.installNotOurs', { path: cli.status?.command ?? '~/.local/bin/pn' }) : t('cli.installFailed')}
                    </Callout>
                  )}
                  {cli.status?.installed && !cli.status.onPath && cli.status.pathLine && (
                    <>
                      <p className={SETTINGS_HELP}>{t('cli.pathHint')}</p>
                      <TerminalBlock value={cli.status.pathLine} prompt copyLabel={t('common:actions.copy')} />
                    </>
                  )}
                </div>
              )}
            </Step>
            <Step n={2} done={rows.length > 0} title={t('cli.stepConnect')} hint={unlocked ? t('cli.connectHint') : undefined}>
              {unlocked && (code ? (
                <PairingCodeBox code={code} label={t('cli.codeLabel')} busy={busy} onNew={make} />
              ) : (
                <>
                  {usedBy && <Callout tone="success">{t('extensionConnect.usedBy', { name: usedBy })}</Callout>}
                  <Button variant="primary" icon={busy ? <Spinner size={15} /> : <Link aria-hidden="true" />} onClick={make} disabled={busy}>
                    {t('apps.makeCode')}
                  </Button>
                </>
              ))}
            </Step>
            <Step n={3} last done={rows.some((r) => r.last_clip_at)} title={t('cli.stepSave')}>
              <TerminalBlock value={TRY_IT} prompt copyLabel={t('common:actions.copy')} />
            </Step>
          </ol>

          <section className="space-y-2.5 rounded-xl border border-divider p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Plugs aria-hidden="true" className="text-accent" />
              <p className="text-body font-medium text-pn">{t('cli.mcpTitle')}</p>
              <Badge tone="info">MCP</Badge>
              <a href={mcpHref} target="_blank" rel="noopener noreferrer" className="ms-auto text-small text-accent hover:underline">
                {t('cli.mcpGuide')}
              </a>
            </div>
            <p className={SETTINGS_HELP}>{t('cli.mcpHint')}</p>
            <TerminalBlock value={MCP_ENTRY} copyLabel={t('common:actions.copy')} />
          </section>

          {/* The limit in plain sight: one folder, add only (owner 2026-11-09). */}
          <section className="space-y-2">
            <SectionEyebrow icon={Robot}>{t('cli.whereHeading')}</SectionEyebrow>
            <div className="flex items-start gap-3 rounded-xl border border-divider p-4">
              <IconTile><Robot /></IconTile>
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-body font-medium text-pn">{folder.name}</span>
                  <Badge tone="success" icon={<LockSimple />}>{t('cli.factAddTitle')}</Badge>
                </p>
                <p className={SETTINGS_HELP}>{t('cli.folderLimit')}</p>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <SectionEyebrow icon={Laptop}>{t('cli.connectedHeading')}</SectionEyebrow>
            <p className={SETTINGS_HELP}>{rows.length ? t('cli.connectedHelp') : t('cli.connectedNone')}</p>
            <div className="grid gap-2.5 @lg:grid-cols-2">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-xl border border-divider p-3">
                  <IconTile><Laptop /></IconTile>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium text-pn">{r.label}</p>
                    <p className="truncate text-small text-pn-muted">
                      {r.last_clip_at ? t('cli.lastSave', { time: formatRelative(r.last_clip_at) }) : t('cli.noSaveYet')}
                    </p>
                  </div>
                  <DeleteButton kind="remove" label={`${t('common:actions.remove')} ${r.label}`} onConfirm={() => void removeOne(r.id)} />
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <SectionEyebrow icon={Sparkle}>{t('landing:cli.useHeading')}</SectionEyebrow>
            <CliExampleCards />
          </section>

          {askOff && (
            <ConfirmModal
              title={t('cli.turnOffTitle')}
              confirmLabel={t('cli.turnOff')}
              variant="danger"
              onConfirm={() => void turnOff()}
              onClose={() => setAskOff(false)}
            >
              {t('cli.turnOffHint')}
            </ConfirmModal>
          )}
        </>
      )}

      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  );
}
