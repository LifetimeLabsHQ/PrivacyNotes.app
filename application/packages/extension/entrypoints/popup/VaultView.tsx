/**
 * The vault in the popup: unlock with this browser's PIN or passcode (or a
 * fingerprint where it was set up), then the copy in Bitwarden's order: the
 * items for this site (the page's logins and bookmarks; the cards when no
 * login matches), the pinned ones, then everything. A search replaces the
 * sections with results from the whole copy; the type pill narrows both.
 * Copy only: nothing is ever filled into a page. A copied secret is cleared
 * after 30 seconds if the clipboard still holds it. Every row opens its item
 * in the app through the app's note shortcut; a right-click copies that
 * shortcut. Add a login sends it to the Vault through the sealed inbox.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, decisions E4, E8 and E13)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { generateTotpCode, parseTotpInput, totpSecondsRemaining } from '@notes/shared';
import type { BookmarkCopyEntry, CardCopyEntry, CopyEntry, LoginCopyEntry, SshKeyCopyEntry } from '@notes/shared/extension';
import { ArrowSquareOut, Check, Copy, CreditCard, Fingerprint, GlobeSimple, Key, LinkSimple, ListBullets, LockSimple, NotePencil, Plus, PushPin, User } from '@web/icons';
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
import { byName, forSite, searchEntries } from '../../src/match';
import { faviconOf, hostOf } from '../../src/favicon';
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

  return (
    <div className="space-y-3" ref={box}>
      <SectionEyebrow icon={LockSimple}>{t('shell:tagsRail.vault')}</SectionEyebrow>
      <div className="text-body font-semibold text-pn">{kind === 'pin' ? t('logins.unlockPin') : t('logins.unlockPasscode')}</div>
      <div className={`flex items-center gap-3 ${busy ? 'opacity-50' : ''}`}>
        <SecretInput kind={kind} value={value} onChange={setValue} onComplete={(v) => void answer(() => unlock({ secret: v }))} autoFocus disabled={busy} compact />
        {fingerprint && kind === 'pin' && (
          <IconButton label={t('logins.useBiometric')} onClick={() => void answer(unlockWithBiometric)} disabled={busy}>
            <Fingerprint aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {kind === 'passcode' && (
        <div className="flex gap-2">
          <Button action="next" onClick={() => void answer(() => unlock({ secret: value }))} disabled={busy || !value} />
          {fingerprint && (
            <Button icon={<Fingerprint aria-hidden="true" />} onClick={() => void answer(unlockWithBiometric)} disabled={busy}>
              {t('logins.useBiometric')}
            </Button>
          )}
        </div>
      )}
      {busy && <StatusLine busy>{t('vault.unlocking')}</StatusLine>}
      {error && <Callout tone={error.tone}>{error.text}</Callout>}
    </div>
  );
}

// ── The rows ─────────────────────────────────────────────────────────

type Copy = (value: string, done: string, secret?: boolean) => Promise<boolean>;

function openUrl(url: string): void {
  void browser.tabs.create({ url });
}

/** The row's right-click: the item in the app, its shortcut, its site. */
function rowMenu(entry: CopyEntry, t: (k: string) => string, copy: Copy): ContextMenuItem[] {
  const site = entry.kind === 'login' ? entry.urls.find((u) => /^https?:\/\//i.test(u)) : entry.kind === 'bookmark' ? entry.url : undefined;
  const items: ContextMenuItem[] = [
    { label: t('vault.openInApp'), icon: <ArrowSquareOut />, onSelect: () => openUrl(shortcutUrl(entry.item)) },
    { label: t('vault.copyShortcut'), icon: <LinkSimple />, onSelect: () => void copy(shortcutUrl(entry.item), t('vault.shortcutCopied'), false) },
  ];
  if (site) items.push({ label: t('logins.openSite'), icon: <GlobeSimple />, onSelect: () => openUrl(site) });
  if (entry.kind === 'bookmark' && entry.note) items.push({ label: t('editor:noteLink.open'), icon: <NotePencil />, onSelect: () => openUrl(shortcutUrl(entry.note!)) });
  return items;
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
      {copied ? <Check aria-hidden="true" /> : children}
    </IconButton>
  );
}

function Tile({ url, letter, glyph }: { url?: string; letter: string; glyph?: ReactNode }) {
  const icon = url ? faviconOf(url) : null;
  const [broken, setBroken] = useState(false);
  if (icon && !broken) return <img src={icon} alt="" className="w-7 h-7 shrink-0 rounded-md" onError={() => setBroken(true)} />;
  return (
    <span aria-hidden="true" className="w-7 h-7 shrink-0 rounded-md bg-surface-0 text-pn-muted inline-flex items-center justify-center text-small font-semibold">
      {glyph ?? (letter || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

function Row({ entry, tile, title, meta, tools, children, copy, menu }: {
  entry: CopyEntry;
  tile: ReactNode;
  title: string;
  meta: string;
  tools: ReactNode;
  children?: ReactNode;
  copy: Copy;
  menu: OpenMenu;
}) {
  const { t } = useTranslation('extension');
  return (
    <li className="py-2 space-y-1.5" onContextMenu={(e) => { e.preventDefault(); menu(e, rowMenu(entry, t, copy)); }}>
      <div className="flex items-center gap-2">
        {tile}
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-pn truncate" dir="auto">
            {entry.pinned && <PushPin aria-hidden="true" className="inline-block me-1 text-pn-muted align-[-2px]" weight="fill" />}
            {title}
          </div>
          <div className="text-meta text-pn-muted truncate" dir="auto">{meta}</div>
        </div>
        {tools}
        <IconButton label={t('vault.openInApp')} onClick={() => openUrl(shortcutUrl(entry.item))}>
          <ArrowSquareOut aria-hidden="true" />
        </IconButton>
      </div>
      {children}
    </li>
  );
}

function LoginRow({ login, pro, copy, menu, showSite }: { login: LoginCopyEntry; pro: boolean; copy: Copy; menu: OpenMenu; showSite: boolean }) {
  const { t } = useTranslation('extension');
  const totp = login.totp ? parseTotpInput(login.totp) : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!totp || !pro) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [totp, pro]);
  const code = totp && pro ? generateTotpCode(totp, now) : null;
  const left = totp ? totpSecondsRemaining(totp.period, now) : 0;
  const site = login.urls[0] ? hostOf(login.urls[0]) : '';
  return (
    <Row
      entry={login}
      tile={<Tile url={login.urls[0]} letter={login.name || login.username} glyph={login.urls[0] ? undefined : <GlobeSimple />} />}
      title={login.name || login.username}
      meta={showSite && site ? [login.username, site].filter(Boolean).join(' · ') : login.username}
      copy={copy}
      menu={menu}
      tools={
        <>
          <CopyTool label={t('auth:loginForm.copyUsername')} done={t('logins.usernameCopied')} value={login.username} copy={copy}><User aria-hidden="true" /></CopyTool>
          <CopyTool label={t('auth:loginForm.copyPassword')} done={t('logins.passwordCopied')} value={login.password} copy={copy}><Key aria-hidden="true" /></CopyTool>
        </>
      }
    >
      {/* The code line: under the name (ps-9 is the tile and its gap), a
          "2FA" tag so the number says what it is, and the copy button at the
          end, in the column of the row's other tools. Under it a 2px bar from
          the name to the copy button drains over the code's period, red in
          the last 5 seconds: it ties the code to its copy action (owner,
          2026-11-06, mockups/extension-2fa-countdown-06nov2026.html, 2). */}
      {totp && (
        <div className="-mt-0.5 ps-9">
          <div className="flex items-center gap-2 text-small">
            <Badge tone="info">{t('security:modal.tabTwoFactor')}</Badge>
            {code ? (
              <>
                <span className={`font-mono font-medium tabular-nums ${left <= 5 ? 'text-danger' : 'text-pn'}`} dir="ltr">{groupTotpCode(code)}</span>
                <span className="ms-auto">
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
          {code && (
            <div aria-hidden="true" className="mt-1 h-0.5 overflow-hidden rounded-full bg-divider">
              <div
                // A new code starts a new bar, so the refill does not animate.
                key={Math.floor(now / 1000 / totp.period)}
                className={`h-full rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none ${left <= 5 ? 'bg-danger' : 'bg-accent'}`}
                style={{ width: `${(left / totp.period) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}
    </Row>
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
      tile={<Tile url={bookmark.url} letter={bookmark.name || hostOf(bookmark.url)} />}
      title={bookmark.name || hostOf(bookmark.url)}
      meta={[hostOf(bookmark.url), bookmark.savedAt ? new Date(bookmark.savedAt).toLocaleDateString() : ''].filter(Boolean).join(' · ')}
      copy={copy}
      menu={menu}
      tools={
        <>
          <IconButton label={t('logins.openSite')} onClick={() => openUrl(bookmark.url)}>
            <GlobeSimple aria-hidden="true" />
          </IconButton>
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

function EntryRow({ entry, pro, copy, menu, showSite }: { entry: CopyEntry; pro: boolean; copy: Copy; menu: OpenMenu; showSite: boolean }) {
  switch (entry.kind) {
    case 'login':
      return <LoginRow login={entry} pro={pro} copy={copy} menu={menu} showSite={showSite} />;
    case 'card':
      return <CardRow card={entry} copy={copy} menu={menu} />;
    case 'ssh':
      return <SshKeyRow sshKey={entry} copy={copy} menu={menu} />;
    case 'bookmark':
      return <BookmarkRow bookmark={entry} copy={copy} menu={menu} />;
  }
}

// ── The sections ─────────────────────────────────────────────────────

function Section({ icon, title, count, tools, children }: { icon: typeof GlobeSimple; title: string; count?: number; tools?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="flex items-center gap-2">
        <SectionEyebrow icon={icon} className="flex-1 min-w-0">{title}</SectionEyebrow>
        {count !== undefined && <span className="text-meta text-pn-muted tabular-nums">{count.toLocaleString()}</span>}
        {tools}
      </div>
      {children}
    </section>
  );
}

export function VaultSections({ vault, url, query, typeFilter, onAdd, menu, loginKeys }: {
  vault: Vault;
  url: string;
  query: string;
  typeFilter: TypeFilter;
  onAdd: () => void;
  menu: OpenMenu;
  /** The browser's key for Copy login, for the hint under one match. */
  loginKeys?: string;
}) {
  const { t } = useTranslation('extension');
  const [status, setStatus] = useState<{ tone?: 'danger' | 'success'; text: string } | null>(null);
  // All items draws 100 rows, and 100 more as the window nears the end:
  // the app's list reveal. Every item is already open in memory; the steps
  // only keep the popup fast to open with a large vault. The popup scrolls
  // the document, so the window's scroll drives it.
  const reveal = useProgressiveReveal();
  const total = useRef(0);
  const { onScroll, reset } = reveal;
  // Another type is another list: it starts at the top again.
  useEffect(() => reset(), [typeFilter, reset]);
  useEffect(() => {
    const el = document.scrollingElement as HTMLElement | null;
    if (!el) return;
    const grow = () => onScroll(el, total.current);
    window.addEventListener('scroll', grow, { passive: true });
    return () => window.removeEventListener('scroll', grow);
  }, [onScroll]);

  const copy: Copy = async (value, done, secret = true) => {
    if (!(await isUnlocked())) {
      await vault.lock();
      return false;
    }
    const ok = secret ? await copyAndClear(value) : await copyPlain(value);
    setStatus(ok ? { tone: 'success', text: secret ? `${done}. ${t('logins.clears')}` : done } : { tone: 'danger', text: t('clip.failed') });
    return ok;
  };

  const entries = filterByType(vault.entries, typeFilter);
  const rows = (list: CopyEntry[], showSite = false) => (
    <ul className="divide-y divide-divider">
      {list.map((e) => <EntryRow key={e.item} entry={e} pro={vault.pro} copy={copy} menu={menu} showSite={showSite} />)}
    </ul>
  );
  const checking = vault.pulling && <StatusLine busy>{t('vault.checking')}</StatusLine>;
  const feedback = status && <StatusLine tone={status.tone}>{status.text}</StatusLine>;

  if (query.trim()) {
    const found = searchEntries(entries, query);
    return (
      <div className="p-3 space-y-3">
        <Section icon={ListBullets} title={t('settingsSearch:resultCount', { count: found.length })}>
          {found.length ? rows(found, true) : <p className={SETTINGS_HELP}>{t('logins.noMatch')}</p>}
        </Section>
        {feedback}
        {checking}
      </div>
    );
  }

  const here = url ? forSite(entries, url) : [];
  const cards = typeFilter === 'all' && here.length === 0 ? entries.filter((e) => e.kind === 'card').sort(byName).slice(0, 10) : [];
  const pinned = entries.filter((e) => e.pinned).sort(byName);
  const all = entries.sort(byName);
  total.current = all.length;
  const site = hostOf(url);
  const tools = (
    <>
      {site && typeFilter !== 'card' && typeFilter !== 'ssh' && (
        <IconButton label={t('menu.addLogin')} onClick={onAdd}>
          <Plus aria-hidden="true" />
        </IconButton>
      )}
    </>
  );
  const showHere = !!site && typeFilter !== 'card' && typeFilter !== 'ssh';
  return (
    <div className="p-3 space-y-4">
      {showHere && (
        <Section icon={GlobeSimple} title={t('logins.forSite', { site })} tools={tools}>
          {here.length ? rows(here)
            : cards.length ? <><p className={SETTINGS_HELP}>{t('vault.cardsHere')}</p>{rows(cards)}</>
            : <p className={SETTINGS_HELP}>{typeFilter === 'bookmark' ? t('vault.noBookmarkHere') : t('logins.none')}</p>}
          {/* The key copies only when one login matches; two or more open
              this window, so the hint shows for exactly one. */}
          {loginKeys && here.filter((e) => e.kind === 'login').length === 1 && (
            <p className={SETTINGS_HELP}>
              <Trans t={t} i18nKey="shortcuts.loginHint" components={{ key: <Kbd>{loginKeys}</Kbd> }} />
            </p>
          )}
          {here.length === 0 && typeFilter !== 'bookmark' && (
            <Button action="add" onClick={onAdd}>{t('menu.addLogin')}</Button>
          )}
        </Section>
      )}
      {feedback}
      {pinned.length > 0 && (
        <Section icon={PushPin} title={t('shell:tagsRail.pinned')} count={pinned.length}>
          {rows(pinned, true)}
        </Section>
      )}
      <Section icon={ListBullets} title={t('vault.all')} count={all.length}>
        {all.length === 0 && vault.loaded && !vault.pulling ? (
          <p className={SETTINGS_HELP}>{t('vault.noneAtAll')}</p>
        ) : (
          <>
            {rows(all.slice(0, reveal.visible), true)}
          </>
        )}
        {checking}
      </Section>
    </div>
  );
}
