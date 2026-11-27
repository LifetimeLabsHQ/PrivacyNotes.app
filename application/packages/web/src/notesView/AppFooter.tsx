import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCircleDown, ArrowCircleUp, ArrowsOutSimple, ChartBar, Gear, Graph, LockKey, MapTrifold, Sun } from '../icons';
import { JournalCalendarButton, type JournalCalendarHandlers } from '../JournalCalendar';
import type { LocalNote } from '../db';
import { detectPlatform } from '../devices';
import { HoverLabel } from '../HoverLabel';
import { SyncStatus } from '../SyncStatus';
import { QuotaRingButton } from '../QuotaRing';
import { IconUpgrade, Kbd } from '../ui';
import { hotkeyKeys, hotkeyLabel, isMacPlatform } from '../notesViewUtils';
import { DESKTOP_APP, keyText } from '../shortcutMatch';
import { intlLocale } from '../languages';
import { useIsTouchDevice } from '../useIsMobile';

// Desktop wrapper only (not web, not iOS/Android): the mini footer's lifted
// bottom padding exists for phone home-indicator/gesture areas, which the
// desktop webview never has - a narrow desktop window keeps the normal pad.
const IS_DESKTOP_APP = detectPlatform() === 'desktop';

/** What the status bar says about the open view: its row count under the
 *  view's own name, then at most one of a word total, a size total or a second
 *  count. */
export type FooterStats = {
  count: number;
  label: string;
  words?: number;
  size?: string;
  second?: { count: number; label: string };
};

/** The readout inside the stats button. `labels: 'wide'` hides the names
 *  below xl, where the desktop row is too tight for them. */
function StatsReadout({ stats, labels }: { stats: FooterStats; labels: 'wide' | 'always' }) {
  const { t } = useTranslation('notes');
  const num = (n: number) => <span className="tabular-nums font-medium">{n.toLocaleString(intlLocale())}</span>;
  const name = (text: string) =>
    labels === 'wide' ? <span className="hidden @[16rem]/stats:inline">{' '}{text}</span> : <>{' '}{text}</>;
  return (
    <span>
      {num(stats.count)}{name(stats.label)}
      {stats.words !== undefined && <>{' · '}{num(stats.words)}{name(t('footer.words', { count: stats.words }))}</>}
      {stats.size && <>{' · '}<span className="tabular-nums font-medium">{stats.size}</span></>}
      {stats.second && <>{' · '}{num(stats.second.count)}{name(stats.second.label)}</>}
    </span>
  );
}

/** The one jump a long open note offers: to its end while it is read, to its
 *  top once the reader is near the end. `scrolling` and `keepShown` drive the
 *  desktop pill, which only shows while the note moves. */
export type NoteJump = {
  toTop: boolean;
  go: (where: 'top' | 'end') => void;
  scrolling: boolean;
  keepShown: (on: boolean) => void;
};

/** What the footer's journal calendar opens and creates. */
export type FooterCalendar = JournalCalendarHandlers;

/** What the storage ring needs; absent until the quota has loaded (or in demo). */
export type FooterStorage = { usedBytes: number; maxBytes: number; onOpen: () => void };

/**
 * The status pair of every footer: the storage ring (#791) and the sync
 * icon, icons only, each with its tip and its own place to open.
 * Spec: docs/internal/design/ui-patterns.md section 205
 */
function FooterStatus({ ready, onOpenSync, storage, size = 20, tipPosition, tipHostClassName }: {
  ready: boolean;
  onOpenSync: () => void;
  storage?: FooterStorage;
  size?: number;
  tipPosition?: 'above-start' | 'above';
  tipHostClassName?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {storage && <QuotaRingButton usedBytes={storage.usedBytes} maxBytes={storage.maxBytes} onOpen={storage.onOpen} size={size} tipPosition={tipPosition} tipHostClassName={tipHostClassName} />}
      <SyncStatus ready={ready} onOpen={onOpenSync} size={size} tipPosition={tipPosition} tipHostClassName={tipHostClassName} />
    </span>
  );
}

export function FullFooter({
  zenMode,
  setZenMode,
  zenUnlocked,
  onOpenGraph,
  placesUnlocked,
  onOpenPlaces,
  sidebarCollapsed,
  gridMode,
  selected,
  openSyncVerify,
  localReadDone,
  storage,
  footerStats,
  calendar,
  auth,
  setShowSettings,
  setShowStats,
  openHotkeys,
  setShowAppearance,
  setShowUpgrade,
  lockReady,
  handleLockClick,
}: {
  zenMode: boolean;
  setZenMode: Dispatch<SetStateAction<boolean>>;
  zenUnlocked: boolean;
  onOpenGraph: () => void;
  /** Pro (or demo): show the direct Places map shortcut beside Graph. */
  placesUnlocked: boolean;
  onOpenPlaces: () => void;
  sidebarCollapsed: boolean;
  gridMode: boolean;
  selected: LocalNote | null;
  openSyncVerify: () => void;
  /** The first read of this device's vault has finished (see SyncStatus's ready). */
  localReadDone: boolean;
  storage?: FooterStorage;
  footerStats: FooterStats;
  calendar: FooterCalendar;
  auth: { isPro: boolean };
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  setShowStats: Dispatch<SetStateAction<boolean>>;
  openHotkeys: () => void;
  setShowAppearance: Dispatch<SetStateAction<boolean>>;
  setShowUpgrade: (next: { trigger: 'zen' }) => void;
  /** The device has a PIN, a passcode or biometric unlock, so Lock app
   *  locks at once. */
  lockReady: boolean;
  handleLockClick: () => void;
}) {
  const { t } = useTranslation('notes');
  // A tablet is wide enough for this footer but has no keyboard to press
  // the new-note keys on, so it shows the word alone (GitHub #743).
  const touch = useIsTouchDevice();
  return (
      // data-pn-dock-footer: the docked Settings panel ends above it (#741).
      // Desktop footer actions keep text-compact labels with --ic-row (18px)
      // icons so the 20px left anchors (Gear, Storage, Sync) stay subtly
      // larger without a harsh size jump across the bar.
      <footer data-pn-dock-footer className="hidden [@media(min-width:768px)_and_(min-height:501px)]:flex shrink-0 select-none items-center border-t border-divider text-compact [--icon-size:var(--ic-row)] text-pn-muted">
        {/* Settings + Sync zone - matches sidebar width. It is a sidebar
            size container too (pn-sidebar in index.css), so a sidebar
            narrower than 230px drops the Settings word for a tip, the way
            the sidebar's own footer actions do, and the sync label keeps
            its room. The padding sits on the inner row: a container
            measures its content box, and padding on it would hide the
            word at 240px too. */}
        {!zenMode && (
          <div className={`pn-sidebar shrink-0 self-stretch hidden lg:flex ${sidebarCollapsed ? 'w-[52px]' : `w-[var(--pn-sidebar-render)] ${gridMode && selected ? 'min-[1400px]:w-[var(--pn-sidebar-render-dock)]' : ''}`}`}>
            {/* px-4 (16px) plus the p-1 (4px) button padding puts the Gear and
                Sync glyphs 20px from the sidebar edges - dead-aligned with the
                sidebar rows and the Help/Rate footer row directly above. */}
            <div className={`flex flex-1 min-w-0 items-center gap-2 py-1 ${sidebarCollapsed ? 'justify-center px-0' : 'justify-between px-4'}`}>
              <HoverLabel label={t('footer.settings')} keys={keyText('openSettings')} position="above-start" className="flex">
                <button
                  onClick={() => setShowSettings(true)}
                  aria-label={t('footer.settings')}
                  className="inline-flex items-center justify-center rounded-md p-1 text-accent hover:bg-pn/5 transition"
                >
                  <Gear size={20} />
                </button>
              </HoverLabel>
              {!sidebarCollapsed && <FooterStatus ready={localReadDone} onOpenSync={openSyncVerify} storage={storage} />}
            </div>
          </div>
        )}
        {/* Main footer content. The divider is a border-s HERE (not a
            border-e on the zone) so it occupies the same pixel column
            as the sidebar collapse-handle's border-s above it. */}
        <div className={`flex-1 self-stretch flex items-center justify-between gap-4 px-5 py-1 ${!zenMode ? 'lg:border-s border-divider' : ''}`}>
          <div className="flex items-center gap-4 min-w-0">
            {/* md band: no sidebar, so Settings + Sync live inline here.
                At lg+ the sidebar-width zone above takes over. */}
            {!zenMode && (
              <span className="flex lg:hidden items-center gap-4">
                <HoverLabel label={t('footer.settings')} keys={keyText('openSettings')} position="above-start" className="flex">
                  <button
                    onClick={() => setShowSettings(true)}
                    aria-label={t('footer.settings')}
                    className="inline-flex items-center justify-center rounded-md p-1 text-accent hover:bg-pn/5 transition"
                  >
                    <Gear size={20} />
                  </button>
                </HoverLabel>
                <FooterStatus ready={localReadDone} onOpenSync={openSyncVerify} storage={storage} />
              </span>
            )}
            {(zenMode || sidebarCollapsed) && (
              <span className={zenMode ? 'flex' : 'hidden lg:flex'}><FooterStatus ready={localReadDone} onOpenSync={openSyncVerify} storage={storage} /></span>
            )}
            {/* The shortcut list: "New" and its keys. A touch screen has no
                keys, so the button is not there (GitHub #743, #777). */}
            {!touch && (
            <HoverLabel label={t('footer.viewShortcuts')} keys={keyText('help')} position="above">
              <button
                onClick={openHotkeys}
                aria-label={t('footer.viewShortcuts')}
                className="inline-flex items-center gap-2 whitespace-nowrap text-body font-medium text-pn hover:text-accent transition cursor-pointer"
              >
              <span>{t('footer.newNote')}</span>
              <span dir="ltr" className="hidden xl:inline-flex items-center gap-1"> {/* rtl-ok: modifier-key sequence never reorders */}
                {hotkeyKeys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
              <span dir="ltr" className="xl:hidden inline-flex"> {/* rtl-ok: modifier-key sequence never reorders */}
                <Kbd>{hotkeyLabel}</Kbd>
              </span>
              <span className="text-compact font-normal text-pn-muted hidden min-[1400px]:inline">
                ({DESKTOP_APP
                  ? t(isMacPlatform ? 'footer.newNoteHintMacDesktop' : 'footer.newNoteHintOtherDesktop')
                  : t(isMacPlatform ? 'footer.newNoteHintMac' : 'footer.newNoteHintOther')})
              </span>
              </button>
            </HoverLabel>
            )}
          </div>
          {/* The free space between the two groups, not the window width,
              decides what shows: a size container that takes that space and
              centers the stats in it, as justify-between did. Numbers from
              12rem, their labels from 16rem, nothing below. */}
          <div className="@container/stats flex flex-1 min-w-0 justify-center">
          <div className="hidden @[12rem]/stats:flex items-center gap-1.5">
          <HoverLabel label={t('footer.openStats')} position="above">
            <button
              onClick={() => setShowStats(true)}
              aria-label={t('footer.openStats')}
              className="inline-flex items-center gap-2 text-pn-muted hover:text-accent transition whitespace-nowrap"
            >
              <ChartBar />
              <StatsReadout stats={footerStats} labels="wide" />
            </button>
          </HoverLabel>
          <JournalCalendarButton {...calendar} />
          </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Borderless text-style controls (the boxes read as a toolbar
                and fight the compact row); the rounded hover bg carries the
                affordance. Below xl the labels drop and the buttons
                are icon-only, so the HoverLabels carry the words there and
                only there - `hiddenAtXl` drops the tip at the width the
                label itself appears, where it would just repeat it. Zen's
                tip stays at every width, because it carries the key. */}
            {!zenMode && (
              <HoverLabel label={t('footer.graphHover')} keys={keyText('graph')} position="above-end">
                <button
                  type="button"
                  onClick={onOpenGraph}
                  aria-label={t('footer.graphHover')}
                  className="rounded-md inline-flex items-center gap-1.5 px-2 py-1 font-medium text-pn hover:bg-pn/5 transition"
                >
                  <Graph className="text-accent" />
                  <span className="hidden xl:inline">{t('footer.graph')}</span>
                </button>
              </HoverLabel>
            )}
            {!zenMode && placesUnlocked && (
              <HoverLabel hiddenAtXl label={t('common:ninja.features.placesMap.label')} position="above-end">
                <button
                  type="button"
                  onClick={onOpenPlaces}
                  aria-label={t('common:ninja.features.placesMap.label')}
                  className="rounded-md inline-flex items-center gap-1.5 px-2 py-1 font-medium text-pn hover:bg-pn/5 transition"
                >
                  <MapTrifold className="text-accent" />
                  <span className="hidden xl:inline">{t('graph.lensPlaces')}</span>
                </button>
              </HoverLabel>
            )}
            <HoverLabel label={zenMode ? t('zen.exitHover') : zenUnlocked ? t('zen.enterHover') : t('zen.proHover')} keys={zenMode || zenUnlocked ? keyText('zen') : ''} position="above-end">
              <button
                onClick={() => {
                  if (!zenUnlocked) { setShowUpgrade({ trigger: 'zen' }); return; }
                  setZenMode((z) => !z);
                }}
                aria-label={zenMode ? t('zen.exitHover') : t('zen.enterAriaShortcut', { keys: keyText('zen') })}
                aria-pressed={zenMode}
                className={`rounded-md inline-flex items-center gap-1.5 px-2 py-1 font-medium transition ${
                  zenMode
                    ? 'text-accent-strong bg-accent/10 hover:bg-accent/20'
                    : 'text-pn hover:bg-pn/5'
                }`}
              >
                <ArrowsOutSimple className={zenMode ? '' : 'text-accent'} />
                <span className="hidden xl:inline">{t('footer.zen')}</span>
                {!auth.isPro && <IconUpgrade size={10} />}
              </button>
            </HoverLabel>
            {/* Opens the Appearance sheet, nothing else. It used to flip
                light/dark on the way in, which quietly cancelled Auto for
                anyone who just wanted to look at the pane. ⌘⇧L is still
                the one-key flip. Same Sun glyph the Settings rail uses for
                this category, so the button reads as "open", not "toggle". */}
            <HoverLabel hiddenAtXl label={t('notes:settings.appearanceLabel')} position="above-end">
              <button
                onClick={() => setShowAppearance((open) => !open)}
                data-appearance-trigger
                aria-label={t('notes:settings.appearanceLabel')}
                className="rounded-md inline-flex items-center gap-1.5 px-2 py-1 font-medium text-pn hover:bg-pn/5 transition"
              >
                <Sun className="text-accent" />
                <span className="hidden xl:inline">{t('notes:settings.appearanceLabel')}</span>
              </button>
            </HoverLabel>
            {/* Locks at once instead of after the re-lock window (GitHub
                #594). Until the lock is set up it opens Security, and its
                tip says what to set up there at every width. It took the
                place of Sign out, which lives at the foot of Settings. */}
            <HoverLabel hiddenAtXl={lockReady} label={lockReady ? t('footer.lockApp') : t('footer.lockAppSetUp')} position="above-end">
              <button
                onClick={handleLockClick}
                aria-label={lockReady ? t('footer.lockApp') : t('footer.lockAppSetUp')}
                className="rounded-md inline-flex items-center gap-1.5 px-2 py-1 font-medium text-pn hover:bg-pn/5 transition"
              >
                <LockKey className="text-accent" />
                <span className="hidden xl:inline">{t('footer.lockApp')}</span>
              </button>
            </HoverLabel>
          </div>
        </div>
      </footer>
  );
}

/** One square touch target in the phone bar: 44px, the smallest either phone
 *  platform recommends, with a tip on devices that hover. */
function BarButton({
  label,
  keys,
  position,
  onClick,
  pressed,
  appearanceTrigger,
  children,
}: {
  label: string;
  keys?: string;
  position: 'above' | 'above-end';
  onClick: () => void;
  pressed?: boolean;
  appearanceTrigger?: boolean;
  children: ReactNode;
}) {
  return (
    <HoverLabel label={label} keys={keys} position={position}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
        data-appearance-trigger={appearanceTrigger || undefined}
        className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-accent hover:bg-pn/5 active:bg-pn/10 transition"
      >
        {children}
      </button>
    </HoverLabel>
  );
}

export function MiniFooter({
  setZenMode,
  zenUnlocked,
  onOpenGraph,
  selected,
  openSyncVerify,
  localReadDone,
  storage,
  footerStats,
  calendar,
  auth,
  newSlotRef,
  noteJump,
  setShowSettings,
  setShowStats,
  setShowAppearance,
  setShowUpgrade,
  lockReady,
  handleLockClick,
}: {
  setZenMode: Dispatch<SetStateAction<boolean>>;
  zenUnlocked: boolean;
  onOpenGraph: () => void;
  selected: LocalNote | null;
  openSyncVerify: () => void;
  /** The first read of this device's vault has finished (see SyncStatus's ready). */
  localReadDone: boolean;
  storage?: FooterStorage;
  footerStats: FooterStats;
  calendar: FooterCalendar;
  auth: { isPro: boolean };
  /** The box a list's New button moves into on a phone (see NewButton). */
  newSlotRef: (node: HTMLDivElement | null) => void;
  /** The one jump a long open note offers: to its end while it is read, to
   *  its top once the reader is near the end. Absent for a short note. */
  noteJump?: NoteJump;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  setShowStats: Dispatch<SetStateAction<boolean>>;
  setShowAppearance: Dispatch<SetStateAction<boolean>>;
  setShowUpgrade: (next: { trigger: 'zen' }) => void;
  lockReady: boolean;
  handleLockClick: () => void;
}) {
  const { t } = useTranslation('notes');
  const settingsLabel = t('footer.settings');
  return (
      <footer className={`[@media(min-width:768px)_and_(min-height:501px)]:hidden shrink-0 select-none flex items-center justify-between gap-2 px-2 py-0.5 ${IS_DESKTOP_APP ? 'pb-0.5' : 'pb-[max(0.125rem,var(--pn-safe-bottom))]'} md:pb-0.5 border-t border-divider text-compact text-pn-muted [@media(max-height:320px)]:hidden`}>
        {/* Settings, Design and Lock app hold the start of the bar on every screen, so
            they never move under the thumb. The end holds the one action of
            the screen on show: New on a list, Zen in an open item, where New
            would act on a list nobody can see. The two end boxes are equal
            flex boxes, so the sync status sits on the true centre of the bar
            whatever they hold (GitHub #205). At md+ (a short window) the
            stats readout joins the row and justify-between spreads it. */}
        <div className="flex flex-1 md:flex-none items-center gap-1">
          <BarButton label={settingsLabel} keys={keyText('openSettings')} position="above" onClick={() => setShowSettings(true)}>
            <Gear size={22} />
          </BarButton>
          {/* Opens the sheet rather than flipping light and dark: a straight
              flip silently cancels Auto. */}
          <BarButton label={t('notes:settings.appearanceLabel')} position="above" onClick={() => setShowAppearance((open) => !open)} appearanceTrigger>
            <Sun size={22} />
          </BarButton>
          {/* Lock app (GitHub #594). Below 360px a long open note shows two
              end buttons too, and the row runs 16px past the screen, so the
              lock leaves the bar there. */}
          <span className="contents max-[359px]:hidden">
            <BarButton label={lockReady ? t('footer.lockApp') : t('footer.lockAppSetUp')} position="above" onClick={handleLockClick}>
              <LockKey size={22} />
            </BarButton>
          </span>
        </div>
        <span className="shrink-0 inline-flex items-center gap-1">
          <FooterStatus ready={localReadDone} onOpenSync={openSyncVerify} storage={storage} size={22} tipPosition="above" tipHostClassName="flex h-11 items-center" />
          <HoverLabel label={t('footer.graphHover')} keys={keyText('graph')} position="above" className="flex h-11 items-center">
            <button
              type="button"
              onClick={onOpenGraph}
              aria-label={t('footer.graphHover')}
              className="inline-flex items-center justify-center rounded-md p-1 text-accent hover:bg-pn/5 active:bg-pn/10 transition"
            >
              <Graph size={22} />
            </button>
          </HoverLabel>
        </span>
        {/* Stats readout - md+ only. Below md the phone row is too tight;
            at md-lg the same three phone controls span a tablet-width row,
            so fill the middle like the desktop footer does. */}
        <span className="hidden md:flex items-center gap-1.5 [--icon-size:var(--ic-row)]">
        <button
          onClick={() => setShowStats(true)}
          aria-label={t('footer.openStats')}
          className="inline-flex items-center gap-2 text-pn-muted hover:text-accent transition whitespace-nowrap"
        >
          <ChartBar />
          <StatsReadout stats={footerStats} labels="always" />
        </button>
        <JournalCalendarButton {...calendar} />
        </span>
        {/* No min-w-0 on either side box: when the row runs short, a box keeps
            its buttons and the sync status gives up exact centre instead of
            sliding under them. */}
        <div className="flex flex-1 md:flex-none md:shrink-0 items-center justify-end gap-1">
          {selected && noteJump && (
            noteJump.toTop ? (
              <BarButton label={t('footer.goToTop')} position="above" onClick={() => noteJump.go('top')}>
                <ArrowCircleUp size={22} />
              </BarButton>
            ) : (
              <BarButton label={t('footer.goToEnd')} position="above" onClick={() => noteJump.go('end')}>
                <ArrowCircleDown size={22} />
              </BarButton>
            )
          )}
          {selected ? (
            <BarButton
              label={t('zen.enterHover')}
              keys={zenUnlocked ? keyText('zen') : ''}
              position="above-end"
              onClick={() => {
                if (!zenUnlocked) { setShowUpgrade({ trigger: 'zen' }); return; }
                setZenMode((z) => !z);
              }}
            >
              <ArrowsOutSimple size={22} />
              {/* The corner the arrow leaves empty. The glyph does not mirror,
                  so neither does the corner. */}
              {!auth.isPro && (
                <span className="absolute bottom-1.5 right-1.5 inline-flex"> {/* rtl-ok: follows the unmirrored glyph */}
                  <IconUpgrade size={10} />
                </span>
              )}
            </BarButton>
          ) : (
            <div ref={newSlotRef} className="flex md:hidden me-1" />
          )}
        </div>
      </footer>
  );
}
