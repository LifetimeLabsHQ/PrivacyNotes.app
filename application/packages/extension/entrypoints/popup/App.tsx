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
import { CaretDown, GearSix, LockSimple, NotePencil, Password, Question, Scissors, ShieldPlus } from '@web/icons';
import { Button, IconButton } from '@web/ui/Button';
import { Badge, Spinner } from '@web/ui/feedback';
import { ListSearchInput } from '@web/ListSearchInput';
import { ContextMenu, type ContextMenuItem } from '@web/ContextMenu';
import { useRoomyMenu } from './roomyMenu';
import { useEscapeToClose } from '@web/useEscapeToClose';
import { APP_KEYS, bindingKeyText, keyText, matchesKey, type KeyBinding } from '@web/shortcutMatch';
import { SETTINGS_TRACK, settingsSegClass } from '@web/settingsUI';
import { disconnect, readConnection, type Connection } from '../../src/connection';
import { knownPro } from '../../src/logins';
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
import { PasskeyPrompt } from './PasskeyView';
import { passkeysReleased } from '../../src/passkeyRelease';
import { pendingHoldsPasskey } from '../../src/pending';
import type { LoginCopyEntry } from '@notes/shared/extension';

/** The passkey request this popup was opened for (passkeys.md section 5.4):
 *  by its id in the address, never through the one-slot route. */
const PASSKEY_REQUEST = passkeysReleased() ? new URLSearchParams(location.search).get('passkey') : null;

/** In-popup shortcut for Add login, matching the extension's Alt+Shift+<letter> family. */
const ADD_LOGIN_KEY: readonly KeyBinding[] = [{ alt: true, shift: true, key: 'a', optionWhileTyping: true }];

type View = { kind: 'main' } | { kind: 'settings' } | { kind: 'biometric' } | { kind: 'generator' } | { kind: 'addLogin' } | { kind: 'editLogin'; login: LoginCopyEntry } | { kind: 'note'; start?: string } | { kind: 'shortcuts' } | { kind: 'changeSecret' };


/** The logo and the app's two-tone wordmark, at the start of every header
 *  (owner, 2026-11-11): 28 px, near the Add button's height. Only the name:
 *  no menu, no link. */
function HeaderBrand() {
  return (
    <span className="flex min-w-0 items-center gap-2 py-1 text-body truncate">
      <img src="/icon/48.png" alt="" className="w-7 h-7 rounded shrink-0" />
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
  const [offerPasskeys, setOfferPasskeys] = useState(true);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [proKnown, setProKnown] = useState<boolean | null>(null);
  const [unlockingFromOrganize, setUnlockingFromOrganize] = useState(false);
  const [pendingPasskey, setPendingPasskey] = useState(false);
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
    if (passkeysReleased()) void pendingHoldsPasskey().then(setPendingPasskey);
  }, [view.kind]);
  // A lock while the Edit login sheet is open takes the sheet and the login
  // it holds away; the main view then shows the unlock screen (beta #217 item 2).
  const editLocked = view.kind === 'editLogin' && vault.unlocked !== true;
  useEffect(() => {
    if (editLocked) setView({ kind: 'main' });
  }, [editLocked]);
  useEffect(() => {
    if (vault.unlocked === true && unlockingFromOrganize) setUnlockingFromOrganize(false);
  }, [vault.unlocked, unlockingFromOrganize]);
  // The popup's own keys, the app's (Settings, search): the handler reads
  // this render's state, so it is set after the early returns below.
  const onKey = useRef<((e: KeyboardEvent) => void) | null>(null);
  useEffect(() => {
    const listen = (e: KeyboardEvent) => onKey.current?.(e);
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, []);

  useEffect(() => {
    // A passkey prompt leaves a route for the next popup.
    void Promise.all([readConnection(), PASSKEY_REQUEST ? null : takeRoute(), readPrefs(), activeTab(), knownPro()]).then(([c, r, prefs, active, pro]) => {
      setTypeFilter(prefs.typeFilter);
      setOfferPasskeys(prefs.offerPasskeys);
      setOrganizeOpen(prefs.organizeOpen);
      setProKnown(pro);
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
      if (area === 'local' && 'connection' in changes && !changes.connection?.newValue) {
        setConnection(null);
        setUnlockingFromOrganize(false);
        setProKnown(null);
        setOrganizeOpen(false);
        setView({ kind: 'main' });
      }
    };
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, []);

  // Escape: inline unlock overlay first, then search, then a sheet, then the popup itself.
  // The hook takes the key from the browser, so the last step closes it here.
  useEscapeToClose(() => {
    if (unlockingFromOrganize) return setUnlockingFromOrganize(false);
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
            <header className="flex items-center gap-2 px-3 py-2 border-b border-divider bg-surface-0">
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
                setUnlockingFromOrganize(false);
                void knownPro().then(setProKnown);
                notices.notify({ title: t('connect.connected'), detail: note ?? (c.logins && c.clips ? t('connect.connectedBoth') : c.logins ? t('notes:vaultFilter.logins') : t('connect.connectedClips')) });
              }}
            />
          </>
        )}
      </div>
    );
  }

  if (PASSKEY_REQUEST) {
    return (
      <NotifyProvider notify={notices.notify}>
        <ViewPrefsProvider value={viewPrefs}>
          <PasskeyPrompt id={PASSKEY_REQUEST} connection={connection} />
        </ViewPrefsProvider>
      </NotifyProvider>
    );
  }

  const unlocked = vault.unlocked === true;
  const hydrated = vault.unlocked !== null && (!unlocked || vault.loaded);
  const pro = unlocked && vault.loaded ? vault.pro : proKnown !== false;
  const bothTabs = !!connection.clips && !!connection.logins;
  const shownTab: PopupTab = bothTabs ? tab : connection.logins ? 'vault' : 'clip';
  const pickTab = (next: PopupTab) => {
    setUnlockingFromOrganize(false);
    setTab(next);
    void writePrefs({ tab: next });
  };
  const handleUnlocked = () => {
    vault.onUnlocked();
    void knownPro().then(setProKnown);
    setUnlockingFromOrganize(false);
  };
  const organize = {
    canFolder: !!connection.logins,
    hydrated,
    unlocked,
    // Known-free accounts see the Pro gate immediately, even while locked;
    // before the first unlock (`proKnown === null`) offer Unlock first.
    pro,
    folders: unlocked && vault.loaded && vault.pro ? (vault.organizer?.folders ?? []) : [],
    knownTags: unlocked && vault.loaded ? (vault.organizer?.tags ?? []) : [],
    open: organizeOpen,
    onOpenChange: (next: boolean) => {
      setOrganizeOpen(next);
      void writePrefs({ organizeOpen: next });
    },
    onUnlock: () => setUnlockingFromOrganize(true),
  };
  // The app's keys where the popup has the same command: Settings (Mod+,)
  // and search (/), shown in the tooltips as the app shows them (owner, 2026-11-11).
  onKey.current = (e) => {
    if (unlockingFromOrganize) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    const typing = !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    if (matchesKey(e, APP_KEYS.openSettings, typing)) {
      e.preventDefault();
      setView({ kind: 'settings' });
    } else if (connection.logins && view.kind === 'main' && matchesKey(e, ADD_LOGIN_KEY, typing)) {
      e.preventDefault();
      setView({ kind: 'addLogin' });
    } else if (connection.clips && view.kind === 'main' && matchesKey(e, APP_KEYS.newNote, typing)) {
      e.preventDefault();
      setView({ kind: 'note' });
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

  const inlineTabs = bothTabs && (
    <div role="group" aria-label={t('tabs.label')} className={`${SETTINGS_TRACK} !p-0.5 !gap-0.5 border border-divider/70 shrink-0`}>
      <button
        type="button"
        aria-pressed={shownTab === 'clip'}
        onClick={() => pickTab('clip')}
        className={`${settingsSegClass(shownTab === 'clip')} !px-2.5 !py-1 inline-flex items-center justify-center gap-1.5 whitespace-nowrap`}
      >
        <Scissors aria-hidden="true" />
        {t('tabs.clip')}
      </button>
      <button
        type="button"
        aria-pressed={shownTab === 'vault'}
        onClick={() => pickTab('vault')}
        className={`${settingsSegClass(shownTab === 'vault')} !px-2.5 !py-1 inline-flex items-center justify-center gap-1.5 whitespace-nowrap`}
      >
        <LockSimple aria-hidden="true" />
        {t('shell:tagsRail.vault')}
        {siteLogins > 0 && <Badge tone="info">{siteLogins.toLocaleString()}</Badge>}
      </button>
    </div>
  );

  const searchRow = (
    <div
      className="flex items-center gap-2 px-3 py-2.5 border-b border-divider bg-surface-0"
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
      <Button icon={<CaretDown aria-hidden="true" />} onClick={(e) => openUnder(e.currentTarget, typeItems())} aria-haspopup="menu" className="shrink-0 bg-surface-2 shadow-xs">
        {typeLabel(typeFilter)}
      </Button>
    </div>
  );

  const main = (
    <>
      {/* The header, the tabs and the search stay put while the vault scrolls (Bitwarden). */}
      {/* z-[60]: over a row's tooltip (56, style.css) while the list scrolls under it, under a menu (z-[1000]). */}
      {/* Its height goes to --pn-head, where a vault group's heading sticks. */}
      <div ref={(el) => void (el && document.body.style.setProperty('--pn-head', `${el.offsetHeight}px`))} className="sticky top-0 z-[60] bg-surface-0">
        <header className="flex items-center gap-1.5 px-3 py-2 border-b border-divider bg-surface-0">
          {bothTabs ? (
            <>
              <img src="/icon/48.png" alt={t('notes:settings.groupBrand')} className="w-6 h-6 rounded shrink-0 me-2" />
              {inlineTabs}
            </>
          ) : (
            <HeaderBrand />
          )}
          <span className="flex-1" />
          {/* Two direct Add icon buttons (Login, Note) separated by a hairline
              from Lock, Generate and Settings; tooltips carry their hotkeys. */}
          {connection.logins && (
            <IconButton
              label={t('menu.addLogin')}
              keys={bindingKeyText(ADD_LOGIN_KEY[0]!)}
              tone="accent"
              position="below"
              className="bg-accent/12 border border-accent/30 hover:border-accent/55 hover:bg-accent/18"
              onClick={() => setView({ kind: 'addLogin' })}
            >
              <ShieldPlus aria-hidden="true" />
            </IconButton>
          )}
          {connection.clips && (
            <IconButton
              label={t('notes:header.newNote')}
              keys={keys['new-note'] || keyText('newNote')}
              tone="accent"
              position="below"
              className="bg-accent/12 border border-accent/30 hover:border-accent/55 hover:bg-accent/18"
              onClick={() => setView({ kind: 'note' })}
            >
              <NotePencil aria-hidden="true" />
            </IconButton>
          )}
          {(connection.clips || connection.logins) && (
            <span aria-hidden="true" className="h-4 w-px bg-divider mx-0.5 shrink-0" />
          )}
          {/* Lock and Settings sit in the header with the generator; the
              footer is only the home of a message (owner, 2026-11-11). */}
          {connection.logins && unlocked && (
            <IconButton label={t('logins.lock')} keys={keys['lock-vault']} position="below" onClick={() => void vault.lock()}>
              <LockSimple aria-hidden="true" />
            </IconButton>
          )}
          <IconButton label={t('menu.generatePassword')} keys={keys['generate-password']} position="below" onClick={() => setView({ kind: 'generator' })}>
            <Password aria-hidden="true" />
          </IconButton>
          <IconButton label={t('notes:footer.settings')} keys={keyText('openSettings')} position="below-end" onClick={() => setView({ kind: 'settings' })}>
            <GearSix aria-hidden="true" />
          </IconButton>
        </header>
        {shownTab === 'vault' && searchRow}
      </div>
      <main className="flex-1">
        {shownTab === 'clip' ? (
          <div className="p-3">
            <ClipView connection={connection} bookmarkKeys={keys['save-bookmark']} noteKeys={keys['save-note']} bookmark={unlocked && url ? bookmarkOfPage(vault.entries, url) : null} organize={organize} />
          </div>
        ) : vault.unlocked === null ? null : !unlocked ? (
          <div className="p-3">
            <Unlock connection={connection} onUnlocked={handleUnlocked} focusNonce={focusNonce} />
          </div>
        ) : (
          <VaultSections vault={vault} url={url} tabId={tabId} loginKeys={keys['copy-login']} query={query} typeFilter={typeFilter} menu={openMenu} onEdit={(login) => setView({ kind: 'editLogin', login })} />
        )}
      </main>
    </>
  );

  const showOrganizeUnlock = unlockingFromOrganize && !!connection.logins;
  return (
    <NotifyProvider notify={notices.notify}>
      <ViewPrefsProvider value={viewPrefs}>
      <div className="flex flex-1 flex-col">
        {showOrganizeUnlock && (
          <>
            <SheetHeader title={t('security:lockScreen.unlock')} onBack={() => setUnlockingFromOrganize(false)} />
            <div className="p-3">
              <Unlock connection={connection} onUnlocked={handleUnlocked} focusNonce={focusNonce} />
            </div>
          </>
        )}
        {/* Keep Clip/New note/Add login mounted underneath the unlock overlay so in-progress form state survives unlock. */}
        <div className={showOrganizeUnlock ? 'hidden' : 'contents'}>
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
                // "Offer passkeys" (P29), under biometric unlock, while the switch is on.
                passkeys: passkeysReleased() ? {
                  on: offerPasskeys,
                  set: (on) => {
                    setOfferPasskeys(on);
                    void writePrefs({ offerPasskeys: on });
                  },
                } : undefined,
                changeSecret: unlocked ? {
                  label: connection.secretKind === 'passcode' ? t('changeSecret.titlePasscode') : t('changeSecret.titlePin'),
                  open: () => setView({ kind: 'changeSecret' }),
                } : undefined,
              } : undefined}
              onShortcuts={() => setView({ kind: 'shortcuts' })}
              disconnectLoses={pendingPasskey}
              onDisconnect={() => disconnect(connection).then(() => {
                setConnection(null);
                setUnlockingFromOrganize(false);
                setProKnown(null);
                setOrganizeOpen(false);
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
          <NoteView start={view.start} organize={organize} onDone={backFrom} />
        ) : view.kind === 'addLogin' ? (
          <AddLoginView url={url} logins={loginsOf(vault.entries)} pro={pro} organize={organize} onDone={backFrom} />
        ) : view.kind === 'editLogin' && !editLocked ? (
          <AddLoginView url={url} logins={loginsOf(vault.entries)} pro={vault.pro} onDone={backFrom} edit={view.login} />
        ) : (
          main
        )}
        </div>
        {/* The footer shows only a message, under the screen: the popup grows
            by its height while it shows. */}
        {notices.shown && <Footer notice={notices.shown} onGone={notices.clear} />}
        <ContextMenu state={menu.state} onClose={menu.close} />
      </div>
      </ViewPrefsProvider>
    </NotifyProvider>
  );
}
