/**
 * The popup: Connect when this browser is not connected; then one window:
 * the search and the type pill on top, the page card, the vault in
 * Bitwarden's order, and the auto-lock choice in the footer. The generator
 * and Add login open over it with a back arrow. The logo and name open the
 * brand menu: Change PIN (while unlocked), Keyboard shortcuts, Disconnect
 * (asked once more in the same menu).
 * Spec: docs/internal/plans/browser-extension-build.md (sections 1 and 3, decision E13); picture mockups/browser-extension-popup-01nov2026.html
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { BookmarkSimple, CaretDown, CreditCard, GlobeSimple, Key, Keyboard, ListBullets, LockKey, LockSimple, Password, SignOut } from '@web/icons';
import { Button, IconButton } from '@web/ui/Button';
import { Spinner, StatusLine } from '@web/ui/feedback';
import { ListSearchInput } from '@web/ListSearchInput';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@web/ContextMenu';
import { useEscapeToClose } from '@web/useEscapeToClose';
import { disconnect, readConnection, type Connection } from '../../src/connection';
import { LOCK_CHOICES, readPrefs, writePrefs, type LockAfter, type TypeFilter } from '../../src/prefs';
import { takeRoute } from '../../src/route';
import { bookmarkOfPage, loginsOf } from '../../src/match';
import { ConnectView } from './ConnectView';
import { ClipView } from './ClipView';
import { AddLoginView } from './AddLoginView';
import { ChangeSecretView } from './ChangeSecretView';
import { GeneratorView } from './GeneratorView';
import { SheetHeader } from './Sheet';
import { ShortcutsView, useShortcuts } from './ShortcutsView';
import { Unlock, VaultSections, useVault, type OpenMenu } from './VaultView';

type View = { kind: 'main' } | { kind: 'generator' } | { kind: 'addLogin' } | { kind: 'shortcuts' } | { kind: 'changeSecret' };

const TYPE_ICONS = { all: ListBullets, login: GlobeSimple, card: CreditCard, ssh: Key, bookmark: BookmarkSimple } as const;

export function App() {
  const { t } = useTranslation('extension');
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined);
  const [view, setView] = useState<View>({ kind: 'main' });
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [lockAfter, setLockAfter] = useState<LockAfter>(900);
  const [focusNonce, setFocusNonce] = useState(0);
  // What a sheet left behind on its way out ("Saved. It shows in your Vault").
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menu = useContextMenu();
  const vault = useVault(!!connection?.logins);
  const keys = useShortcuts();

  useEffect(() => {
    void Promise.all([readConnection(), takeRoute(), readPrefs(), browser.tabs.query({ active: true, lastFocusedWindow: true })]).then(([c, r, prefs, [tab]]) => {
      setTypeFilter(prefs.typeFilter);
      setLockAfter(prefs.lockAfter);
      setUrl(r?.url || tab?.url || '');
      if (r?.view === 'generator') setView({ kind: 'generator' });
      else if (r?.view === 'addLogin') setView({ kind: 'addLogin' });
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
    if (view.kind !== 'main') return setView({ kind: 'main' });
    window.close();
  }, connection != null);

  const openMenu: OpenMenu = (e, items) => menu.open({ clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} }, items);
  const openUnder = (el: HTMLElement | null, items: ContextMenuItem[]) => {
    const r = el?.getBoundingClientRect();
    if (!r) return;
    menu.open({ clientX: r.right, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, items, true, undefined, true);
  };

  if (connection === undefined) {
    return (
      <div className="p-6 flex justify-center">
        <Spinner />
      </div>
    );
  }
  if (!connection) return <ConnectView onConnected={setConnection} />;

  const unlocked = vault.unlocked === true;
  const typeLabel = (f: TypeFilter) =>
    f === 'all' ? t('notes:vaultFilter.all') : f === 'login' ? t('notes:vaultFilter.logins') : f === 'card' ? t('notes:vaultFilter.cards') : f === 'ssh' ? t('notes:vaultFilter.keys') : t('shell:tagsRail.bookmarks');
  const typeItems = (): ContextMenuItem[] =>
    (['all', 'login', 'card', 'ssh', 'bookmark'] as const).flatMap((f, i): ContextMenuItem[] => {
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
  // The brand menu holds what concerns this browser's connection, as
  // Bitwarden's account menu does. Disconnect asks once more in the same
  // place: the menu opens again with the question and the red answer.
  const openBrand = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} };
    const confirm: ContextMenuItem[] = [
      { type: 'header', label: t('account.confirmDisconnect') },
      { label: t('security:connectedAccounts.disconnect'), icon: <SignOut />, destructive: true, onSelect: () => void disconnect(connection).then(() => setConnection(null)) },
    ];
    menu.open(at, [
      // A new PIN or passcode needs the open vault: the server checks its ticket.
      ...(connection.logins && unlocked ? [{
        label: connection.secretKind === 'passcode' ? t('changeSecret.titlePasscode') : t('changeSecret.titlePin'),
        icon: <LockKey />,
        onSelect: () => setView({ kind: 'changeSecret' }),
      }] : []),
      { label: t('common:palette.commands.help'), icon: <Keyboard />, onSelect: () => setView({ kind: 'shortcuts' }) },
      { type: 'separator' },
      { label: t('security:connectedAccounts.disconnect'), icon: <SignOut />, destructive: true, onSelect: () => requestAnimationFrame(() => menu.open(at, confirm)) },
    ]);
  };

  const main = (
    <>
      {/* The header and the search stay put while the vault scrolls (Bitwarden). */}
      <div className="sticky top-0 z-10 bg-surface-2">
        <header className="flex items-center gap-2 px-3 py-2 border-b border-divider">
          <button
            type="button"
            aria-haspopup="menu"
            onClick={(e) => openBrand(e.currentTarget)}
            className="-ms-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-pn transition hover:bg-pn/10"
          >
            <img src="/icon/32.png" alt="" className="w-5 h-5 rounded" />
            <span className="text-body font-semibold truncate">{t('notes:settings.groupBrand')}</span>
            <CaretDown className="text-pn-muted shrink-0" aria-hidden="true" />
          </button>
          <span className="flex-1" />
          {/* Lock sits in the header, in one place on every page; a page the
              extension cannot clip left it alone on a row of its own. */}
          {connection.logins && unlocked && (
            <IconButton label={t('logins.lock')} position="below" onClick={() => void vault.lock()}>
              <LockSimple aria-hidden="true" />
            </IconButton>
          )}
          <IconButton label={t('menu.generatePassword')} position="below" onClick={() => setView({ kind: 'generator' })}>
            <Password aria-hidden="true" />
          </IconButton>
        </header>
        {connection.logins && (
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
        )}
      </div>
      <main className="flex-1">
        {connection.clips && !query.trim() && (
          <div className="p-3 border-b border-divider">
            <ClipView connection={connection} bookmarkKeys={keys['save-bookmark']} bookmark={unlocked && url ? bookmarkOfPage(vault.entries, url) : null} />
          </div>
        )}
        {notice && <div className="px-3 pt-3"><StatusLine tone="success">{notice}</StatusLine></div>}
        {connection.logins && vault.unlocked !== null && (
          !unlocked ? (
            <div className="p-3">
              <Unlock connection={connection} onUnlocked={vault.onUnlocked} focusNonce={focusNonce} />
            </div>
          ) : (
            <VaultSections vault={vault} url={url} loginKeys={keys['copy-login']} query={query} typeFilter={typeFilter} onAdd={() => { setNotice(null); setView({ kind: 'addLogin' }); }} menu={openMenu} />
          )
        )}
      </main>
      {connection.logins && (
        <footer className="sticky bottom-0 z-10 flex items-center justify-end px-3 py-2 border-t border-divider bg-surface-1">
          <Button icon={<LockSimple aria-hidden="true" />} onClick={(e) => openUnder(e.currentTarget, lockItems())} aria-haspopup="menu">
            {`${t('vault.autoLock')} · ${lockLabel(lockAfter)}`}
          </Button>
        </footer>
      )}
    </>
  );

  return (
    <div className="flex flex-col min-h-[200px]">
      {view.kind === 'changeSecret' ? (
        <ChangeSecretView
          connection={connection}
          onBack={() => setView({ kind: 'main' })}
          onChanged={(c) => {
            setConnection(c);
            setView({ kind: 'main' });
          }}
        />
      ) : view.kind === 'shortcuts' ? (
        <>
          <SheetHeader title={t('common:palette.commands.help')} onBack={() => setView({ kind: 'main' })} />
          <ShortcutsView />
        </>
      ) : view.kind === 'generator' ? (
        <>
          <SheetHeader title={t('menu.generatePassword')} onBack={() => setView({ kind: 'main' })} />
          <GeneratorView />
        </>
      ) : view.kind === 'addLogin' ? (
        <AddLoginView
          url={url}
          logins={loginsOf(vault.entries)}
          pro={vault.pro}
          onDone={(text) => {
            setNotice(text);
            setView({ kind: 'main' });
          }}
        />
      ) : (
        main
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  );
}
