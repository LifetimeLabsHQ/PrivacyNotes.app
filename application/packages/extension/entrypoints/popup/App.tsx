/**
 * The popup: Connect when this browser is not connected; then two tabs, Clip
 * and Vault, when both features are on (one of them alone needs no tabs).
 * It opens on the tab used last; a menu item, the address bar or a shortcut
 * opens the one its job needs. Clip holds the page card; Vault holds the
 * search with the type pill and the vault in Bitwarden's order. Each screen
 * sizes the popup to its content, up to 600 px; a menu that needs more room
 * grows it first (`useRoomyMenu`). The footer is for 4 seconds the message of a copy or a save. The generator, Add login and New note open over it with a
 * back arrow. The logo and name are only the name; every setting, Change PIN,
 * Keyboard shortcuts and Disconnect are on the one Settings page (the gear).
 * Spec: docs/internal/plans/browser-extension-build.md (sections 1 and 3, decisions E13 and E17); picture mockups/browser-extension-redesign-11nov2026.html
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { CaretDown, GearSix, GlobeSimple, LockSimple, NotePencil, Password, Question, Scissors } from '@web/icons';
import { Button, IconButton } from '@web/ui/Button';
import { Badge, Spinner } from '@web/ui/feedback';
import { ListSearchInput } from '@web/ListSearchInput';
import { ContextMenu, type ContextMenuItem } from '@web/ContextMenu';
import { useRoomyMenu } from './roomyMenu';
import { useEscapeToClose } from '@web/useEscapeToClose';
import { APP_KEYS, keyText, matchesKey } from '@web/shortcutMatch';
import { SETTINGS_TRACK, settingsSegClass } from '@web/settingsUI';
import { disconnect, readConnection, type Connection } from '../../src/connection';
import { LOCK_CHOICES, readPrefs, writePrefs, type LockAfter, type PopupTab, type TypeFilter } from '../../src/prefs';
import { takeRoute } from '../../src/route';
import { activeTab } from '../../src/tabs';
import { bookmarkOfPage, loginsOf, matchLogins } from '../../src/match';
import { ConnectView } from './ConnectView';
import { Brand } from '@web/Brand';
import { BiometricView } from './BiometricView';
import { biometricPossible, biometricReady, forgetBiometric } from '../../src/biometric';
import { HELP_URL } from '../../src/config';
import { ClipView } from './ClipView';
import { AddLoginView } from './AddLoginView';
import { ChangeSecretView } from './ChangeSecretView';
import { Footer, NotifyProvider, useNotices, type Notice } from './Footer';
import { GeneratorView } from './GeneratorView';
import { NoteView } from './NoteView';
import { SettingsView, ViewPrefsProvider, type ViewPrefs } from './SettingsView';
import { SheetHeader } from './Sheet';
import { ShortcutsView, useShortcuts } from './ShortcutsView';
import { KIND_ORDER, TYPE_ICONS, Unlock, VaultSections, typeLabel as kindLabel, useVault, type OpenMenu } from './VaultView';

type View = { kind: 'main' } | { kind: 'settings' } | { kind: 'biometric' } | { kind: 'generator' } | { kind: 'addLogin' } | { kind: 'note'; start?: string } | { kind: 'shortcuts' } | { kind: 'changeSecret' };


/** The logo and the app's two-tone wordmark, at the start of every header
 *  (owner, 2026-11-11): 28 px, near the Add button's height. Only the name:
 *  no menu, no link. */
function HeaderBrand() {
  return (
    <span className="flex min-w-0 items-center gap-2 py-1 text-body truncate">
      <img src="/icon/48.png" alt="" className="w-7 h-7 rounded" />
      <Brand />
    </span>
  );
}

export function App() {
  const { t } = useTranslation('extension');
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: 'main' });
  const [tab, setTab] = useState<PopupTab>('clip');
  const [url, setUrl] = useState('');
  /** The tab a fill goes to: the one this window was opened for. */
  const [tabId, setTabId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [viewPrefs, setViewPrefs] = useState<ViewPrefs>({ showTotp: true, totpBar: true, favicons: true });
  const changeView = (patch: Partial<ViewPrefs>) => {
    setViewPrefs((v) => ({ ...v, ...patch }));
    void writePrefs(patch);
  };
  const [lockAfter, setLockAfter] = useState<LockAfter>(900);
  const [focusNonce, setFocusNonce] = useState(0);
  const notices = useNotices();
  const searchRef = useRef<HTMLInputElement>(null);
  const menu = useRoomyMenu();
  const vault = useVault(!!connection?.logins);
  const keys = useShortcuts();
  // Fingerprint or face: whether this computer has it, and whether it is set
  // up here. Read again each time Settings opens.
  const [bio, setBio] = useState({ possible: false, on: false });
  useEffect(() => {
    if (view.kind !== 'settings') return;
    void Promise.all([biometricPossible(), biometricReady()]).then(([possible, on]) => setBio({ possible, on }));
  }, [view.kind]);
  // The popup's own keys, the app's (Settings, search): the handler reads
  // this render's state, so it is set after the early returns below.
  const onKey = useRef<((e: KeyboardEvent) => void) | null>(null);
  useEffect(() => {
    const listen = (e: KeyboardEvent) => onKey.current?.(e);
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, []);

  useEffect(() => {
    void Promise.all([readConnection(), takeRoute(), readPrefs(), activeTab()]).then(([c, r, prefs, active]) => {
      setTypeFilter(prefs.typeFilter);
      setViewPrefs({ showTotp: prefs.showTotp, totpBar: prefs.totpBar, favicons: prefs.favicons });
      setLockAfter(prefs.lockAfter);
      // A route opens the tab its job needs, once; the remembered tab stays.
      setTab(r?.view === 'search' || r?.view === 'addLogin' ? 'vault' : prefs.tab);
      const shown = r?.url || active?.url || '';
      setUrl(shown);
      // As a small window of its own (where the browser refuses a popup),
      // the last focused tab is this window: find the page's tab by its address.
      if (active?.id != null && active.url === shown) setTabId(active.id);
      else if (shown) void browser.tabs.query({ active: true }).then((tabs) => setTabId(tabs.find((x) => x.url === shown)?.id ?? null));
      if (r?.view === 'generator') setView({ kind: 'generator' });
      else if (r?.view === 'addLogin') setView({ kind: 'addLogin' });
      else if (r?.view === 'note') setView({ kind: 'note', start: r.query });
      else if (r?.view === 'search' && r.query) setQuery(r.query);
      setConnection(c);
    });
    // A revoke seen by the background forgets the connection: follow it. A
    // new connection is the Connect view's own, which shows its confirmation.
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && 'connection' in changes && !changes.connection?.newValue) setConnection(null);
    };
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, []);

  // Escape: the search first, then a sheet, then the popup or window itself.
  // The hook takes the key from the browser, so the last step closes it here.
  useEscapeToClose(() => {
    if (query) return setQuery('');
    // A page opened from Settings goes back to Settings (owner, 2026-11-11).
    if (view.kind === 'changeSecret' || view.kind === 'shortcuts' || view.kind === 'biometric') return setView({ kind: 'settings' });
    if (view.kind !== 'main') return setView({ kind: 'main' });
    window.close();
  }, connection != null);

  const openMenu: OpenMenu = (e, items) => menu.open({ clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} }, items);
  const openUnder = (el: HTMLElement | null, items: ContextMenuItem[]) => {
    const r = el?.getBoundingClientRect();
    if (!r) return;
    // The menu's end edge sits at the button's end edge: its left edge in a
    // right-to-left page.
    const end = document.documentElement.dir === 'rtl' ? r.left : r.right;
    menu.open({ clientX: end, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, items, true, undefined, true);
  };

  // The vault's search takes the keyboard whenever it shows: when the popup
  // opens on the Vault tab, after an unlock, after a sheet and on a switch to
  // the tab, so a person can type at once (Bitwarden; owner, 2026-11-12).
  // Locked, the PIN field has it instead.
  const searchShown = !!connection?.logins && view.kind === 'main' && vault.unlocked === true && (!connection.clips || tab === 'vault');
  useEffect(() => {
    if (searchShown) requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchShown]);

  if (connection === undefined) {
    return (
      <div className="p-6 flex justify-center">
        <Spinner />
      </div>
    );
  }
  // Not connected: the same header with the full logo, so the extension is
  // known at first sight; the question mark opens the help, the gear the
  // settings that need no account (owner, 2026-11-11).
  if (!connection) {
    const toMain = () => setView({ kind: 'main' });
    onKey.current = (e) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
      if (matchesKey(e, APP_KEYS.openSettings, typing)) {
        e.preventDefault();
        setView({ kind: 'settings' });
      }
    };
    return (
      <div className="flex flex-1 flex-col">
        {view.kind === 'settings' ? (
          <>
            <SheetHeader title={t('notes:footer.settings')} onBack={toMain} />
            <SettingsView prefs={viewPrefs} onChange={changeView} onShortcuts={() => setView({ kind: 'shortcuts' })} />
          </>
        ) : view.kind === 'shortcuts' ? (
          <>
            <SheetHeader title={t('common:palette.commands.help')} onBack={() => setView({ kind: 'settings' })} />
            <ShortcutsView />
          </>
        ) : (
          <>
            <header className="flex items-center gap-2 px-3 py-2 border-b border-divider">
              <HeaderBrand />
              <span className="flex-1" />
              <IconButton label={t('connect.help')} position="below" onClick={() => void browser.tabs.create({ url: HELP_URL })}>
                <Question aria-hidden="true" />
              </IconButton>
              <IconButton label={t('notes:footer.settings')} keys={keyText('openSettings')} position="below-end" onClick={() => setView({ kind: 'settings' })}>
                <GearSix aria-hidden="true" />
              </IconButton>
            </header>
            <ConnectView
              onConnected={(c, note) => {
                setConnection(c);
                notices.notify({ title: t('connect.connected'), detail: note ?? (c.logins && c.clips ? t('connect.connectedBoth') : c.logins ? t('notes:vaultFilter.logins') : t('connect.connectedClips')) });
              }}
            />
          </>
        )}
      </div>
    );
  }

  const unlocked = vault.unlocked === true;
  const bothTabs = !!connection.clips && !!connection.logins;
  const shownTab: PopupTab = bothTabs ? tab : connection.logins ? 'vault' : 'clip';
  const pickTab = (next: PopupTab) => {
    setTab(next);
    void writePrefs({ tab: next });
  };
  // The app's keys where the popup has the same command: Settings (Mod+,)
  // and search (/), shown in the tooltips as the app shows them (owner, 2026-11-11).
  onKey.current = (e) => {
    const el = e.target instanceof HTMLElement ? e.target : null;
    const typing = !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    if (matchesKey(e, APP_KEYS.openSettings, typing)) {
      e.preventDefault();
      setView({ kind: 'settings' });
    } else if (connection.logins && view.kind === 'main' && matchesKey(e, APP_KEYS.focusSearch, typing)) {
      e.preventDefault();
      pickTab('vault');
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  };
  // The site's logins, the same count as the toolbar badge; none while locked.
  const siteLogins = unlocked && url ? matchLogins(loginsOf(vault.entries), url).length : 0;
  const backFrom = (notice: Notice | null) => {
    if (notice) notices.notify(notice);
    setView({ kind: 'main' });
  };

  const typeLabel = (f: TypeFilter) => kindLabel(f, t);
  const typeItems = (): ContextMenuItem[] =>
    (['all', ...KIND_ORDER] as const).flatMap((f, i): ContextMenuItem[] => {
      const Glyph = TYPE_ICONS[f];
      const row: ContextMenuItem = {
        label: typeLabel(f),
        icon: <Glyph />,
        checked: typeFilter === f,
        onSelect: () => {
          setTypeFilter(f);
          void writePrefs({ typeFilter: f });
        },
      };
      return i === 1 ? [{ type: 'separator' }, row] : [row];
    });
  // The app's own timeout words, where it has them.
  const lockLabel = (c: LockAfter) =>
    c === 'system' ? t('logins.lockSystem') : c === 'restart' ? t('security:timeout.browserRestart') : t(`security:timeout.${c < 3600 ? `min${c / 60}` : `hour${c / 3600}`}`);
  const lockItems = (): ContextMenuItem[] => [
    { type: 'header', label: t('vault.lockHeader') },
    ...LOCK_CHOICES.flatMap((c, i): ContextMenuItem[] => {
      const row: ContextMenuItem = {
        label: lockLabel(c),
        checked: lockAfter === c,
        onSelect: () => {
          setLockAfter(c);
          void writePrefs({ lockAfter: c });
        },
      };
      return i === 6 ? [{ type: 'separator' }, row] : [row];
    }),
  ];
  const addItems = (): ContextMenuItem[] => [
    ...(connection.logins ? [{ label: t('notes:newMenu.login'), icon: <GlobeSimple />, onSelect: () => setView({ kind: 'addLogin' }) }] : []),
    ...(connection.clips ? [{ label: t('notes:newMenu.note'), icon: <NotePencil />, shortcut: keys['new-note'] || undefined, onSelect: () => setView({ kind: 'note' }) }] : []),
  ];

  const tabs = bothTabs && (
    <div className="px-3 py-2 border-b border-divider">
      <div role="group" aria-label={t('tabs.label')} className={`${SETTINGS_TRACK} w-full`}>
        <button type="button" aria-pressed={shownTab === 'clip'} onClick={() => pickTab('clip')} className={`${settingsSegClass(shownTab === 'clip', true)} inline-flex items-center justify-center gap-1.5`}>
          <Scissors aria-hidden="true" />
          {t('tabs.clip')}
        </button>
        <button type="button" aria-pressed={shownTab === 'vault'} onClick={() => pickTab('vault')} className={`${settingsSegClass(shownTab === 'vault', true)} inline-flex items-center justify-center gap-1.5`}>
          <LockSimple aria-hidden="true" />
          {t('shell:tagsRail.vault')}
          {siteLogins > 0 && <Badge tone="info">{siteLogins.toLocaleString()}</Badge>}
        </button>
      </div>
    </div>
  );

  const searchRow = (
    <div
      className="flex items-center gap-2 px-3 py-2 border-b border-divider"
      // Locked, the search is a door to the PIN.
      onFocusCapture={(e) => {
        if (!unlocked && e.target instanceof HTMLInputElement) {
          e.target.blur();
          setFocusNonce((n) => n + 1);
        }
      }}
    >
      <ListSearchInput
        value={query}
        onChange={setQuery}
        inputRef={searchRef}
        placeholder={!unlocked ? t('vault.unlockToSearch') : typeFilter === 'all' ? t('vault.search') : t('vault.searchKind', { kind: typeLabel(typeFilter).toLowerCase() })}
        ariaLabel={t('vault.search')}
      />
      <Button icon={<CaretDown aria-hidden="true" />} onClick={(e) => openUnder(e.currentTarget, typeItems())} aria-haspopup="menu" className="shrink-0">
        {typeLabel(typeFilter)}
      </Button>
    </div>
  );

  const main = (
    <>
      {/* The header, the tabs and the search stay put while the vault scrolls (Bitwarden). */}
      {/* z-[60]: over a row's tooltip (56, style.css) while the list scrolls under it, under a menu (z-[1000]). */}
      {/* Its height goes to --pn-head, where a vault group's heading sticks. */}
      <div ref={(el) => void (el && document.body.style.setProperty('--pn-head', `${el.offsetHeight}px`))} className="sticky top-0 z-[60] bg-surface-2">
        <header className="flex items-center gap-2 px-3 py-2 border-b border-divider">
          <HeaderBrand />
          <span className="flex-1" />
          {/* One Add with a menu of kinds, as Bitwarden's header has it. A card
              or an SSH key cannot travel through the inbox yet. */}
          {(connection.clips || connection.logins) && (
            <Button action="add" variant="accent" aria-haspopup="menu" onClick={(e) => openUnder(e.currentTarget, addItems())} />
          )}
          {/* Lock and Settings sit in the header with the generator; the
              footer is only the home of a message (owner, 2026-11-11). */}
          {connection.logins && unlocked && (
            <IconButton label={t('logins.lock')} keys={keys['lock-vault']} position="below" onClick={() => void vault.lock()}>
              <LockSimple aria-hidden="true" />
            </IconButton>
          )}
          <IconButton label={t('menu.generatePassword')} position="below" onClick={() => setView({ kind: 'generator' })}>
            <Password aria-hidden="true" />
          </IconButton>
          <IconButton label={t('notes:footer.settings')} keys={keyText('openSettings')} position="below-end" onClick={() => setView({ kind: 'settings' })}>
            <GearSix aria-hidden="true" />
          </IconButton>
        </header>
        {tabs}
        {shownTab === 'vault' && searchRow}
      </div>
      <main className="flex-1">
        {shownTab === 'clip' ? (
          <div className="p-3">
            <ClipView connection={connection} bookmarkKeys={keys['save-bookmark']} noteKeys={keys['save-note']} bookmark={unlocked && url ? bookmarkOfPage(vault.entries, url) : null} />
          </div>
        ) : vault.unlocked === null ? null : !unlocked ? (
          <div className="p-3">
            <Unlock connection={connection} onUnlocked={vault.onUnlocked} focusNonce={focusNonce} />
          </div>
        ) : (
          <VaultSections vault={vault} url={url} tabId={tabId} loginKeys={keys['copy-login']} query={query} typeFilter={typeFilter} menu={openMenu} />
        )}
      </main>
    </>
  );

  return (
    <NotifyProvider notify={notices.notify}>
      <ViewPrefsProvider value={viewPrefs}>
      <div className="flex flex-1 flex-col">
        {view.kind === 'changeSecret' ? (
          <ChangeSecretView
            connection={connection}
            onBack={() => setView({ kind: 'settings' })}
            onChanged={(c) => {
              setConnection(c);
              setView({ kind: 'settings' });
            }}
          />
        ) : view.kind === 'settings' ? (
          <>
            <SheetHeader title={t('notes:footer.settings')} onBack={() => setView({ kind: 'main' })} />
            <SettingsView
              prefs={viewPrefs}
              onChange={changeView}
              vault={connection.logins ? {
                lockLabel: lockLabel(lockAfter),
                openLock: (el) => openUnder(el, lockItems()),
                // A new PIN or passcode needs the open vault: the server checks its ticket.
                biometric: bio.possible ? {
                  on: bio.on,
                  set: (on) => {
                    if (on) return setView({ kind: 'biometric' });
                    void forgetBiometric().then(() => {
                      setBio((b) => ({ ...b, on: false }));
                      notices.notify({ title: t('settings.biometricOff') });
                    });
                  },
                } : undefined,
                changeSecret: unlocked ? {
                  label: connection.secretKind === 'passcode' ? t('changeSecret.titlePasscode') : t('changeSecret.titlePin'),
                  open: () => setView({ kind: 'changeSecret' }),
                } : undefined,
              } : undefined}
              onShortcuts={() => setView({ kind: 'shortcuts' })}
              onDisconnect={() => disconnect(connection).then(() => {
                setConnection(null);
                setView({ kind: 'main' });
              })}
            />
          </>
        ) : view.kind === 'biometric' ? (
          <>
            <SheetHeader title={t('settings.biometric')} onBack={() => setView({ kind: 'settings' })} />
            <BiometricView
              connection={connection}
              onDone={() => {
                setBio((b) => ({ ...b, on: true }));
                notices.notify({ title: t('biometric.enrolledHere') });
                setView({ kind: 'settings' });
              }}
            />
          </>
        ) : view.kind === 'shortcuts' ? (
          <>
            <SheetHeader title={t('common:palette.commands.help')} onBack={() => setView({ kind: 'settings' })} />
            <ShortcutsView />
          </>
        ) : view.kind === 'generator' ? (
          <>
            <SheetHeader title={t('menu.generatePassword')} onBack={() => setView({ kind: 'main' })} />
            <GeneratorView />
          </>
        ) : view.kind === 'note' ? (
          <NoteView start={view.start} onDone={backFrom} />
        ) : view.kind === 'addLogin' ? (
          <AddLoginView url={url} logins={loginsOf(vault.entries)} pro={vault.pro} onDone={backFrom} />
        ) : (
          main
        )}
        {/* The footer shows only a message, under the screen: the popup grows
            by its height while it shows. */}
        {notices.shown && <Footer notice={notices.shown} onGone={notices.clear} />}
        <ContextMenu state={menu.state} onClose={menu.close} />
      </div>
      </ViewPrefsProvider>
    </NotifyProvider>
  );
}
