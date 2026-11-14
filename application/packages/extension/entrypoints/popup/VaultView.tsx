/**
 * The vault in the popup: unlock with this browser's PIN or passcode (or a
 * fingerprint where it was set up), then the copy in Bitwarden's order: the
 * items for this site (the page's logins and bookmarks; the cards when no
 * login matches), the pinned ones, then everything. A search replaces the
 * sections with results from the whole copy; the type pill narrows both.
 * A login for this site has a Fill tool: the background writes it into the
 * page the window was opened for, and a full fill closes the window (nothing
 * is ever filled when a page loads). A copied secret is cleared
 * after 30 seconds if the clipboard still holds it; the copy icon turns into
 * a check and the footer says what was copied (pattern 177). Every row opens its item
 * in the app through the app's note shortcut; a right-click copies that
 * shortcut. Add a login sends it to the Vault through the sealed inbox.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, decisions E4, E8 and E13); docs/internal/plans/click-to-fill.md (section 6)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { generateTotpCode, parseTotpInput, totpSecondsRemaining } from '@notes/shared';
import type { BookmarkCopyEntry, CardCopyEntry, CopyEntry, CopyKind, LoginCopyEntry, SshKeyCopyEntry } from '@notes/shared/extension';
import { ArrowSquareOut, BookmarkSimple, Check, Copy, CreditCard, DotsThreeOutlineVertical, Fingerprint, GlobeSimple, Key, LinkSimple, ListBullets, NotePencil, PushPin, Textbox, User } from '@web/icons';
import { Button, IconButton } from '@web/ui/Button';
import { Badge, Callout, StatusLine } from '@web/ui/feedback';
import { Kbd } from '@web/ui/misc';
import { groupTotpCode } from '@web/TotpRing';
import { SecretInput } from '@web/PasscodeInput';
import { useProgressiveReveal } from '@web/useProgressiveReveal';
import { SectionEyebrow, SETTINGS_HELP } from '@web/settingsUI';
import { ProMark } from '@web/proMark';
import type { ContextMenuItem } from '@web/ContextMenu';
import { forgetLocal, type Connection } from '../../src/connection';
import { allEntries, isUnlocked, lockLogins, pull, pullInFlight, ROWS_KEY, SESSION_KEY, shortcutUrl, unlock } from '../../src/logins';
import { biometricReady, unlockWithBiometric } from '../../src/biometric';
import { copyAndClear, copyPlain } from '../../src/copy';
import { CLEAR_AFTER_MS } from '../../src/clipboard';
import { clippable } from '../../src/clipping';
import type { FillOutcome } from '../../src/fill/types';
import type { BackgroundMessage } from '../../src/messages';
import { useNotify, type Notice } from './Footer';
import { TOTP_RED_S, TotpBar, useSecondTick } from './TotpBar';
import { useViewPrefs } from './SettingsView';
import { byName, forSite, searchEntries } from '../../src/match';
import { byLastFill, readLastFill, type LastFill } from '../../src/lastFill';
import { displayHost, faviconOf } from '../../src/favicon';
import type { TypeFilter } from '../../src/prefs';



export type OpenMenu = (e: { clientX: number; clientY: number }, items: ContextMenuItem[]) => void;

// ── The data ─────────────────────────────────────────────────────────

export interface Vault {
  /** null until the session storage was read. */
  unlocked: boolean | null;
  entries: CopyEntry[];
  pro: boolean;
  /** The copy was read at least once since the unlock. */
  loaded: boolean;
  /** A delta pull runs behind the list. */
  pulling: boolean;
  onUnlocked: () => void;
  lock: () => Promise<void>;
}

/** The copy, kept in step with the session (the idle lock runs in the
 *  background) and with the rows a pull writes. */
export function useVault(enabled: boolean): Vault {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [data, setData] = useState<{ entries: CopyEntry[]; pro: boolean } | null>(null);
  const [pulling, setPulling] = useState(false);

  const load = useCallback(async () => {
    const got = await allEntries();
    if (!got) {
      setUnlocked(false);
      setData(null);
      return;
    }
    setData(got);
  }, []);

  const refresh = useCallback(() => {
    setPulling(true);
    void pull()
      .then((r) => {
        if (r === 'locked' || r === 'disconnected') {
          setUnlocked(false);
          setData(null);
        }
      })
      .finally(() => setPulling(false));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void isUnlocked().then((u) => {
      setUnlocked(u);
      if (u) {
        void load();
        refresh();
      }
    });
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && SESSION_KEY in changes && !changes[SESSION_KEY]?.newValue) {
        setUnlocked(false);
        setData(null);
      }
      if (area === 'local' && ROWS_KEY in changes) void load();
    };
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, [enabled, load, refresh]);

  return {
    unlocked,
    entries: data?.entries ?? [],
    pro: data?.pro ?? false,
    loaded: data !== null,
    pulling: pulling || pullInFlight(),
    onUnlocked: () => {
      setUnlocked(true);
      void load();
      // The unlock started the pull: join it, so the status line shows.
      refresh();
    },
    lock: async () => {
      await lockLogins();
      setUnlocked(false);
      setData(null);
    },
  };
}

export function filterByType(entries: readonly CopyEntry[], filter: TypeFilter): CopyEntry[] {
  return filter === 'all' ? [...entries] : entries.filter((e) => e.kind === filter);
}

// ── Unlock ───────────────────────────────────────────────────────────

export function Unlock({ connection, onUnlocked, focusNonce }: { connection: Connection; onUnlocked: () => void; focusNonce: number }) {
  const { t } = useTranslation('extension');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ tone: 'warning' | 'danger'; text: string } | null>(null);
  const [fingerprint, setFingerprint] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const kind = connection.secretKind ?? 'pin';

  useEffect(() => {
    void biometricReady().then(setFingerprint);
  }, []);
  // A click on the locked search lands here.
  useEffect(() => {
    if (focusNonce > 0) box.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [focusNonce]);

  const answer = async (run: () => ReturnType<typeof unlock>) => {
    setBusy(true);
    setError(null);
    const result = await run();
    setBusy(false);
    setValue('');
    if (result.kind === 'ok') return onUnlocked();
    if (result.kind === 'wrong') return setError({ tone: 'warning', text: t('logins.wrong', { count: result.left }) });
    if (result.kind === 'offline') return setError({ tone: 'danger', text: t('logins.unreachable') });
    if (result.kind === 'disconnected') {
      await forgetLocal();
      return setError({ tone: 'danger', text: t('account.revokedBody') });
    }
    setError({ tone: 'danger', text: t('logins.unreachable') });
  };

  // The PIN boxes fill the width at the lock screen's height, the same on
  // every PIN screen; fingerprint or face is a button with words, and the cost
  // of wrong tries shows before the first one.
  return (
    <div className="space-y-3 py-2" ref={box}>
      <div className="text-center text-body font-semibold text-pn">{kind === 'pin' ? t('logins.unlockPin') : t('logins.unlockPasscode')}</div>
      <div className={busy ? 'opacity-50' : undefined}>
        <SecretInput kind={kind} value={value} onChange={setValue} onComplete={(v) => void answer(() => unlock({ secret: v }))} autoFocus disabled={busy} fill />
      </div>
      {kind === 'passcode' && (
        <Button action="next" onClick={() => void answer(() => unlock({ secret: value }))} disabled={busy || !value} className="w-full" />
      )}
      {fingerprint && (
        <Button icon={<Fingerprint aria-hidden="true" />} onClick={() => void answer(unlockWithBiometric)} disabled={busy} className="w-full">
          {t('logins.useBiometric')}
        </Button>
      )}
      {/* The tries left show only after a wrong PIN, in its message (owner, 2026-11-11). */}
      {busy && <StatusLine busy>{t('vault.unlocking')}</StatusLine>}
      {error && <Callout look="card" tone={error.tone}>{error.text}</Callout>}
    </div>
  );
}

// ── The rows ─────────────────────────────────────────────────────────

type Copy = (value: string, done: string, secret?: boolean) => Promise<boolean>;

function openUrl(url: string): void {
  void browser.tabs.create({ url });
}

/** The row menu (More options and right-click) is hidden for now: the owner
 *  was not sure it is useful (2026-11-12). True brings both back. */
const ROW_MENU = false;

/** The row's right-click: the item in the app, its shortcut, its site. */
function rowMenu(entry: CopyEntry, t: (k: string) => string, copy: Copy, code?: string | null): ContextMenuItem[] {
  // The site has its own button on the row, so the menu does not repeat it.
  const items: ContextMenuItem[] = [
    ...(code ? [{ label: t('logins.copyCode'), icon: <Copy />, onSelect: () => void copy(code, t('logins.codeCopied')) }] : []),
    { label: t('vault.copyShortcut'), icon: <LinkSimple />, onSelect: () => void copy(shortcutUrl(entry.item), t('vault.shortcutCopied'), false) },
    { label: t('vault.openInApp'), icon: <ArrowSquareOut />, onSelect: () => openUrl(shortcutUrl(entry.item)) },
  ];
  if (entry.kind === 'bookmark' && entry.note) items.push({ label: t('editor:noteLink.open'), icon: <NotePencil />, onSelect: () => openUrl(shortcutUrl(entry.note!)) });
  return items;
}

/** The site a row opens: a login's first web address, a bookmark's page. */
function siteOf(entry: CopyEntry): string | undefined {
  return entry.kind === 'login' ? entry.urls.find((u) => /^https?:\/\//i.test(u)) : entry.kind === 'bookmark' ? entry.url : undefined;
}

/** A copy tool on a row: the glyph turns into a check for two seconds. */
function CopyTool({ label, done, value, copy, children }: { label: string; done: string; value: string; copy: Copy; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton label={label} disabled={!value} className={copied ? 'text-success hover:text-success' : ''} onClick={() => void copy(value, done).then((ok) => setCopied(ok))}>
      {copied ? <Check aria-hidden="true" className="pn-pop" /> : children}
    </IconButton>
  );
}

/** Fill on a row of this site: the background writes the login into the
 *  page. The tool rests while a fill runs, so a second click starts nothing. */
function FillTool({ onFill, keys }: { onFill: () => Promise<void>; keys?: string }) {
  const { t } = useTranslation('extension');
  const [busy, setBusy] = useState(false);
  return (
    <IconButton
      label={t('logins.fill')}
      keys={keys}
      tone="accent"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onFill().finally(() => setBusy(false));
      }}
    >
      <Textbox aria-hidden="true" />
    </IconButton>
  );
}

/** What the footer says when a fill wrote nothing, or not all of the login. */
function fillNotice(outcome: FillOutcome, t: (k: string) => string): Notice {
  switch (outcome) {
    case 'usernameOnly':
      return { title: t('fill.usernameOnly'), detail: t('fill.usernameOnlyNext') };
    case 'signup':
      return { tone: 'danger', title: t('fill.notFilled'), detail: t('fill.signup') };
    case 'insecure':
      return { tone: 'danger', title: t('fill.notFilled'), detail: t('fill.insecure') };
    case 'otherAccount':
      return { tone: 'danger', title: t('fill.notFilled'), detail: t('fill.otherAccount') };
    case 'tooLong':
      return { tone: 'danger', title: t('fill.notFilled'), detail: t('fill.tooLong') };
    case 'readonly':
    case 'refused':
      return { tone: 'danger', title: t('fill.couldNot'), detail: t('fill.copyInstead') };
    default:
      return { tone: 'danger', title: t('fill.notFilled'), detail: t('fill.nothing') };
  }
}

/** A row's tile: the site's favicon, or a letter or glyph. The Clip tab's page card uses it too. */
export function Tile({ url, letter, glyph }: { url?: string; letter: string; glyph?: ReactNode }) {
  const { favicons } = useViewPrefs();
  const icon = url && favicons ? faviconOf(url) : null;
  const [broken, setBroken] = useState(false);
  if (icon && !broken) return <img src={icon} alt="" className="w-7 h-7 shrink-0 rounded-md" onError={() => setBroken(true)} />;
  return (
    <span aria-hidden="true" className="w-7 h-7 shrink-0 rounded-md bg-surface-0 text-pn-muted inline-flex items-center justify-center text-small font-semibold">
      {glyph ?? (letter || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

// A row is a grid of three columns: the tile, the words, the tools. A login
// adds a second line under them: its site under the username, and the 2FA
// block under the tools, as wide as the tools or as its own one line,
// whichever is wider; the words give way (owner, 2026-11-12, option A).
function Row({ entry, tile, title, meta, tools, sub, side, copy, menu, code }: {
  entry: CopyEntry;
  tile: ReactNode;
  title: string;
  meta: string;
  tools: ReactNode;
  /** A second line under the words: a login's site. */
  sub?: ReactNode;
  /** Under the tools: a login's 2FA block. */
  side?: ReactNode;
  copy: Copy;
  menu: OpenMenu;
  /** A 2FA code the row does not show: its menu copies it. */
  code?: string | null;
}) {
  const { t } = useTranslation('extension');
  const site = siteOf(entry);
  const items = () => rowMenu(entry, t, copy, code);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 py-2" onContextMenu={ROW_MENU ? (e) => { e.preventDefault(); menu(e, items()); } : undefined}>
      {/* The icon opens the site too, as the open button does (owner,
          2026-11-12). Out of the tab order: the open button is the stop. */}
      {site ? (
        <button type="button" tabIndex={-1} aria-label={t('logins.openSite')} onClick={() => openUrl(site)} className="shrink-0 rounded-md cursor-pointer hover:opacity-80">
          {tile}
        </button>
      ) : tile}
      <div className="min-w-0">
        <div className="text-body font-medium text-pn truncate" dir="auto">
          {entry.pinned && <PushPin aria-hidden="true" className="inline-block me-1 text-pn-muted align-[-2px]" weight="fill" />}
          {title}
        </div>
        <div className="text-meta text-pn-muted truncate" dir="auto">{meta}</div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {tools}
        {site && (
          <IconButton label={t('logins.openSite')} onClick={() => openUrl(site)}>
            <ArrowSquareOut aria-hidden="true" />
          </IconButton>
        )}
        {ROW_MENU && (
          <IconButton
            label={t('vault.moreOptions')}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              menu({ clientX: r.left, clientY: r.bottom + 4 }, items());
            }}
          >
            <DotsThreeOutlineVertical aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {(sub || side) && (
        <>
          <div className="col-start-2 min-w-0 self-start">{sub}</div>
          <div className="col-start-3 min-w-0 self-start">{side}</div>
        </>
      )}
    </li>
  );
}

function LoginRow({ login, pro, copy, menu, onFill, fillKeys }: { login: LoginCopyEntry; pro: boolean; copy: Copy; menu: OpenMenu; onFill?: () => Promise<void>; fillKeys?: string }) {
  const { t } = useTranslation('extension');
  const { showTotp, totpBar } = useViewPrefs();
  const totp = login.totp ? parseTotpInput(login.totp) : null;
  const now = useSecondTick(!!totp && pro);
  const code = totp && pro ? generateTotpCode(totp, now) : null;
  const left = totp ? totpSecondsRemaining(totp.period, now) : 0;
  const site = login.urls[0] ? displayHost(login.urls[0]) : '';
  return (
    <Row
      entry={login}
      tile={<Tile url={login.urls[0]} letter={login.name || login.username} glyph={login.urls[0] ? undefined : <GlobeSimple />} />}
      title={login.name || login.username}
      // The username; the site on the line under it only beside a 2FA block,
      // where it fills the line's empty start (alone it looked orphaned,
      // owner 2026-11-12).
      meta={login.username || site}
      sub={login.username && site && totp && showTotp ? (
        <div className="flex h-8 items-center text-meta text-pn-muted" dir="auto">
          <span className="truncate">{site}</span>
        </div>
      ) : undefined}
      copy={copy}
      menu={menu}
      code={showTotp ? null : code}
      tools={
        <>
          {onFill && <FillTool onFill={onFill} keys={fillKeys} />}
          <CopyTool label={t('auth:loginForm.copyUsername')} done={t('logins.usernameCopied')} value={login.username} copy={copy}><User aria-hidden="true" /></CopyTool>
          <CopyTool label={t('auth:loginForm.copyPassword')} done={t('logins.passwordCopied')} value={login.password} copy={copy}><Key aria-hidden="true" /></CopyTool>
        </>
      }
      // The 2FA block under the tools: a "2FA" tag so the number says what
      // it is, the code on one line, and Copy under the open button. Under
      // it a 2px bar drains over the code's period, red in the last 5
      // seconds (owner, 2026-11-06, mockups/extension-2fa-countdown-06nov2026.html,
      // variant 2; moved under the tools 2026-11-12).
      side={totp && showTotp ? (
        <div>
          <div className="flex h-8 items-center gap-2 whitespace-nowrap text-small">
            <Badge tone="info">{t('security:modal.tabTwoFactor')}</Badge>
            {code ? (
              <>
                {/* The code takes the room between the tag and Copy and sits
                    in its middle, however wide the tools make the block. */}
                <span className={`flex-1 text-center font-mono font-medium tabular-nums ${left <= TOTP_RED_S ? 'text-danger' : 'text-pn'}`} dir="ltr">{groupTotpCode(code)}</span>
                <span>
                  <CopyTool label={t('logins.copyCode')} done={t('logins.codeCopied')} value={code} copy={copy}><Copy aria-hidden="true" /></CopyTool>
                </span>
              </>
            ) : (
              // The live code is Pro, as in the app: the mark stays clickable
              // and opens the item in the app, where the upgrade is.
              <button type="button" onClick={() => openUrl(shortcutUrl(login.item))} className="inline-flex">
                <ProMark />
              </button>
            )}
          </div>
          {code && totpBar && <TotpBar period={totp.period} now={now} className="mt-0.5" />}
        </div>
      ) : undefined}
    />
  );
}

function CardRow({ card, copy, menu }: { card: CardCopyEntry; copy: Copy; menu: OpenMenu }) {
  const { t } = useTranslation('extension');
  const last4 = card.number.replace(/\D/g, '').slice(-4);
  const expiry = card.expMonth && card.expYear ? `${card.expMonth}/${card.expYear.slice(-2)}` : '';
  return (
    <Row
      entry={card}
      tile={<Tile letter={card.name} glyph={<CreditCard />} />}
      title={card.name || card.holder}
      meta={[card.network, last4 ? `•••• ${last4}` : '', expiry].filter(Boolean).join(' · ')}
      copy={copy}
      menu={menu}
      tools={
        <>
          <CopyTool label={t('common:cardForm.copyCardNumber')} done={t('vault.numberCopied')} value={card.number} copy={copy}><CreditCard aria-hidden="true" /></CopyTool>
          <CopyTool label={t('vault.copyExpiry')} done={t('vault.expiryCopied')} value={expiry} copy={copy}><Copy aria-hidden="true" /></CopyTool>
          <CopyTool label={t('vault.copyCvv')} done={t('vault.cvvCopied')} value={card.cvv} copy={copy}><Key aria-hidden="true" /></CopyTool>
        </>
      }
    />
  );
}

function SshKeyRow({ sshKey, copy, menu }: { sshKey: SshKeyCopyEntry; copy: Copy; menu: OpenMenu }) {
  const { t } = useTranslation('extension');
  return (
    <Row
      entry={sshKey}
      tile={<Tile letter={sshKey.name} glyph={<Key />} />}
      title={sshKey.name}
      meta={[sshKey.keyType, sshKey.fingerprint].filter(Boolean).join(' · ')}
      copy={copy}
      menu={menu}
      tools={<CopyTool label={t('common:sshKeyForm.copyPublicKey')} done={t('vault.publicKeyCopied')} value={sshKey.publicKey} copy={copy}><Copy aria-hidden="true" /></CopyTool>}
    />
  );
}

function BookmarkRow({ bookmark, copy, menu }: { bookmark: BookmarkCopyEntry; copy: Copy; menu: OpenMenu }) {
  const { t } = useTranslation('extension');
  return (
    <Row
      entry={bookmark}
      tile={<Tile url={bookmark.url} letter={bookmark.name || displayHost(bookmark.url)} />}
      title={bookmark.name || displayHost(bookmark.url)}
      meta={[displayHost(bookmark.url), bookmark.savedAt ? new Date(bookmark.savedAt).toLocaleDateString() : ''].filter(Boolean).join(' · ')}
      copy={copy}
      menu={menu}
      tools={
        <>
          {bookmark.note && (
            <IconButton label={t('editor:noteLink.open')} onClick={() => openUrl(shortcutUrl(bookmark.note!))}>
              <NotePencil aria-hidden="true" />
            </IconButton>
          )}
        </>
      }
    />
  );
}

function EntryRow({ entry, pro, copy, menu, fill, fillKeys }: { entry: CopyEntry; pro: boolean; copy: Copy; menu: OpenMenu; fill?: (item: string) => Promise<void>; fillKeys?: string }) {
  switch (entry.kind) {
    case 'login':
      return <LoginRow login={entry} pro={pro} copy={copy} menu={menu} onFill={fill && (() => fill(entry.item))} fillKeys={fillKeys} />;
    case 'card':
      return <CardRow card={entry} copy={copy} menu={menu} />;
    case 'ssh':
      return <SshKeyRow sshKey={entry} copy={copy} menu={menu} />;
    case 'bookmark':
      return <BookmarkRow bookmark={entry} copy={copy} menu={menu} />;
  }
}

// ── The sections ─────────────────────────────────────────────────────

/** The kinds in the type menu's order; the vault lists them in the same
 *  order, each under its own heading (owner, 2026-11-11). */
export const KIND_ORDER: readonly CopyKind[] = ['login', 'card', 'ssh', 'bookmark'];
export const TYPE_ICONS = { all: ListBullets, login: GlobeSimple, card: CreditCard, ssh: Key, bookmark: BookmarkSimple } as const;

/** The type menu's words for a kind, and the heading of its group. */
export function typeLabel(f: TypeFilter, t: (key: string) => string): string {
  return f === 'all' ? t('notes:vaultFilter.all') : f === 'login' ? t('notes:vaultFilter.logins') : f === 'card' ? t('notes:vaultFilter.cards') : f === 'ssh' ? t('notes:vaultFilter.keys') : t('shell:tagsRail.bookmarks');
}

/** By kind in the menu's order. */
function byKind(a: CopyEntry, b: CopyEntry): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
}

/** By kind in the menu's order, then by name. */
function byKindThenName(a: CopyEntry, b: CopyEntry): number {
  return byKind(a, b) || byName(a, b);
}

// Each heading sticks under the header while its group scrolls, on a band
// with a line under it, so the kind in view is always named and the change
// to the next kind is plain (owner, 2026-11-11). z-[55]: over the rows,
// under their tooltips (56, style.css) and the header (z-[60]).
function Section({ icon, title, count, tools, children }: { icon: typeof GlobeSimple; title: string; count?: number; tools?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="sticky top-[var(--pn-head,0px)] z-[55] -mx-3 flex items-center gap-2 border-b border-divider bg-surface-1 px-3 py-2">
        <SectionEyebrow icon={icon} className="flex-1 min-w-0">{title}</SectionEyebrow>
        {count !== undefined && <span className="text-meta text-pn-muted tabular-nums">{count.toLocaleString()}</span>}
        {tools}
      </div>
      <div className="space-y-1 pt-1">{children}</div>
    </section>
  );
}

export function VaultSections({ vault, url, tabId, query, typeFilter, menu, loginKeys }: {
  vault: Vault;
  url: string;
  /** The tab the window was opened for; without it no row offers Fill. */
  tabId: number | null;
  query: string;
  typeFilter: TypeFilter;
  menu: OpenMenu;
  /** The browser's key for Copy login, for the hint under one match. */
  loginKeys?: string;
}) {
  const { t } = useTranslation('extension');
  const notify = useNotify();
  // The login filled last comes first under For this site, the one the key
  // fills. Read once: a fill closes the window, so the order never changes
  // under the pointer.
  const [lastFill, setLastFill] = useState<LastFill>({});
  useEffect(() => void readLastFill().then(setLastFill), []);
  // All items draws 100 rows, and 100 more as the window nears the end:
  // the app's list reveal. Every item is already open in memory; the steps
  // only keep the popup fast to open with a large vault. The popup scrolls
  // its body (style.css), so the body's scroll drives it.
  const reveal = useProgressiveReveal();
  const total = useRef(0);
  const { onScroll, reset } = reveal;
  // Another type is another list: it starts at the top again.
  useEffect(() => reset(), [typeFilter, reset]);
  useEffect(() => {
    const el = document.body;
    const grow = () => onScroll(el, total.current);
    el.addEventListener('scroll', grow, { passive: true });
    return () => el.removeEventListener('scroll', grow);
  }, [onScroll]);

  const copy: Copy = async (value, done, secret = true) => {
    if (!(await isUnlocked())) {
      await vault.lock();
      return false;
    }
    const ok = secret ? await copyAndClear(value) : await copyPlain(value);
    // The words go to the footer, so the list never moves under the pointer.
    notify(ok
      ? { title: done, clearsAt: secret ? Date.now() + CLEAR_AFTER_MS : undefined }
      : { tone: 'danger', title: t('notice.copyFailed'), detail: t('auth:signIn.tryAgain') });
    return ok;
  };

  // Fill is for the logins of this site only, so there is no doubt which
  // page it means. The background checks the match again before it writes.
  const fill = tabId != null && clippable(url)
    ? async (item: string): Promise<void> => {
        const message: BackgroundMessage = { type: 'fill', item, tabId };
        const outcome = (await browser.runtime.sendMessage(message).catch(() => 'nothing')) as FillOutcome | null;
        // A full fill: the window goes, and the cursor is in the page's field.
        if (outcome === 'filled' || outcome === 'waiting') return window.close();
        if (outcome === 'locked') return void (await vault.lock());
        notify(fillNotice(outcome ?? 'nothing', t));
      }
    : undefined;

  const entries = filterByType(vault.entries, typeFilter);
  const rows = (list: CopyEntry[], canFill = false) => (
    <ul className="divide-y divide-divider">
      {list.map((e) => <EntryRow key={e.item} entry={e} pro={vault.pro} copy={copy} menu={menu} fill={canFill ? fill : undefined} fillKeys={loginKeys} />)}
    </ul>
  );
  const checking = vault.pulling && <StatusLine busy>{t('vault.checking')}</StatusLine>;

  if (query.trim()) {
    const found = searchEntries(entries, query);
    return (
      <div className="px-3 pb-3 space-y-3">
        <Section icon={ListBullets} title={t('settingsSearch:resultCount', { count: found.length })}>
          {found.length ? rows(found) : <p className={SETTINGS_HELP}>{t('logins.noMatch')}</p>}
        </Section>
        {checking}
      </div>
    );
  }

  const here = url ? forSite(entries, url).sort((a, b) => byKind(a, b) || byLastFill(lastFill)(a, b) || byName(a, b)) : [];
  const cards = typeFilter === 'all' && here.length === 0 ? entries.filter((e) => e.kind === 'card').sort(byName).slice(0, 10) : [];
  const pinned = entries.filter((e) => e.pinned).sort(byKindThenName);
  const all = entries.sort(byKindThenName);
  total.current = all.length;
  // All items, one group a kind. The reveal counts rows across the groups,
  // so a group shows once its first row is revealed.
  let budget = reveal.visible;
  const groups = KIND_ORDER.map((kind) => {
    const list = all.filter((e) => e.kind === kind);
    const shown = list.slice(0, Math.max(0, budget));
    budget -= shown.length;
    return { kind, count: list.length, shown };
  }).filter((g) => g.shown.length > 0);
  const site = displayHost(url);
  const showHere = !!site && typeFilter !== 'card' && typeFilter !== 'ssh';
  return (
    <div className="px-3 pb-3 space-y-3">
      {showHere && (
        <Section icon={GlobeSimple} title={t('logins.forSite', { site })}>
          {here.length ? rows(here, true)
            : cards.length ? <><p className={SETTINGS_HELP}>{t('vault.cardsHere')}</p>{rows(cards)}</>
            : <p className={SETTINGS_HELP}>{typeFilter === 'bookmark' ? t('vault.noBookmarkHere') : t('logins.none')}</p>}
          {/* One login: the key fills it, or copies it. Two or more: it fills
              the top row, and a second press the next (fillRun.ts). */}
          {loginKeys && here.some((e) => e.kind === 'login') && (
            <p className={SETTINGS_HELP}>
              <Trans t={t} i18nKey={here.filter((e) => e.kind === 'login').length === 1 ? 'shortcuts.loginHint' : 'shortcuts.loginHintMany'} components={{ key: <Kbd>{loginKeys}</Kbd>, br: <br /> }} />
            </p>
          )}
        </Section>
      )}
      {pinned.length > 0 && (
        <Section icon={PushPin} title={t('shell:tagsRail.pinned')} count={pinned.length}>
          {rows(pinned)}
        </Section>
      )}
      {all.length === 0 && vault.loaded && !vault.pulling ? (
        <Section icon={ListBullets} title={t('vault.all')} count={0}>
          <p className={SETTINGS_HELP}>{t('vault.noneAtAll')}</p>
        </Section>
      ) : (
        groups.map((g) => (
          <Section key={g.kind} icon={TYPE_ICONS[g.kind]} title={typeLabel(g.kind, t)} count={g.count}>
            {rows(g.shown)}
          </Section>
        ))
      )}
      {checking}
    </div>
  );
}
