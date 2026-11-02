/**
 * The popup: Connect when this browser is not connected; then one window:
 * the search and the type pill on top, the page card, the vault in
 * Bitwarden's order, and the auto-lock choice in the footer. The generator
 * and Add login open over it with a back arrow. Disconnect sits under the
 * header as a two-step `DeleteButton`.
 * Spec: docs/internal/plans/browser-extension-build.md (sections 1 and 3, decision E13); picture mockups/browser-extension-popup-01nov2026.html
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { BookmarkSimple, CaretDown, CreditCard, GlobeSimple, Key, ListBullets, LockSimple, Password, SignOut } from '@web/icons';
import { Button, IconButton } from '@web/ui/Button';
import { DeleteButton } from '@web/ui/DeleteButton';
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
import { GeneratorView } from './GeneratorView';
import { SheetHeader } from './Sheet';
import { Unlock, VaultSections, useVault, type OpenMenu } from './VaultView';

type View = { kind: 'main' } | { kind: 'generator' } | { kind: 'addLogin' };

/** The popup opened as its own window (the browser refused the toolbar
 *  popup): Escape closes it, as it would close the popup. */
const WINDOW_MODE = new URLSearchParams(window.location.search).has('window');

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

  // Escape: the search first, then a sheet, then the window itself.
  useEscapeToClose(() => {
    if (query) return setQuery('');
    if (view.kind !== 'main') return setView({ kind: 'main' });
    if (WINDOW_MODE) window.close();
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

  const main = (
    <>
      <header className="flex items-center gap-2 px-3 py-2 border-b border-divider">
        <img src="/icon/32.png" alt="" className="w-5 h-5 rounded" />
        <span className="text-body font-semibold text-pn">{t('notes:settings.groupBrand')}</span>
        <span className="flex-1" />
        <IconButton label={t('menu.generatePassword')} position="below" onClick={() => setView({ kind: 'generator' })}>
          <Password aria-hidden="true" />
        </IconButton>
        {/* Disconnect asks once in place, the app's two-step confirm. */}
        <DeleteButton
          label={t('security:connectedAccounts.disconnect')}
          confirmLabel={t('account.confirmDisconnect')}
          icon={SignOut}
          position="below-end"
          onConfirm={() => void disconnect(connection).then(() => setConnection(null))}
        />
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
      <main className="flex-1">
        {connection.clips && !query.trim() && (
          <div className="p-3 border-b border-divider">
            <ClipView connection={connection} bookmark={unlocked && url ? bookmarkOfPage(vault.entries, url) : null} />
          </div>
        )}
        {notice && <div className="px-3 pt-3"><StatusLine tone="success">{notice}</StatusLine></div>}
        {connection.logins && vault.unlocked !== null && (
          !unlocked ? (
            <div className="p-3">
              <Unlock connection={connection} onUnlocked={vault.onUnlocked} focusNonce={focusNonce} />
            </div>
          ) : (
            <VaultSections vault={vault} url={url} query={query} typeFilter={typeFilter} onAdd={() => { setNotice(null); setView({ kind: 'addLogin' }); }} menu={openMenu} />
          )
        )}
      </main>
      {connection.logins && (
        <footer className="flex items-center justify-end px-3 py-2 border-t border-divider bg-surface-1">
          <Button icon={<LockSimple aria-hidden="true" />} onClick={(e) => openUnder(e.currentTarget, lockItems())} aria-haspopup="menu">
            {`${t('vault.autoLock')} · ${lockLabel(lockAfter)}`}
          </Button>
        </footer>
      )}
    </>
  );

  return (
    <div className="flex flex-col min-h-[200px]">
      {view.kind === 'generator' ? (
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
