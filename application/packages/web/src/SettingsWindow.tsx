import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ensureSettingsSearchLoaded } from './i18n';
import { isImeComposing } from './imeComposing';
import { APP_KEYS, keyText, matchesKey } from './shortcutMatch';
import { useEdgeSwipe, EDGE_START_PX } from './useEdgeSwipe';
import { ArrowLeft, ArrowSquareOut, CaretRight, X } from './icons';
import { HoverLabel } from './HoverLabel';
import { AccentBar, HeadlineRule, SETTINGS_EYEBROW } from './settingsUI';
import { PaneTabMemory } from './settingsPaneTab';
import type { SettingsShellProps as Props } from './SettingsShell';
import { Button, CloseButton, FIELD_CLASS, Kbd } from './ui';
import { NO_TEXT_ASSIST } from './formFields';
import {
  ANDROID_LIKE,
  NATIVE_PHONE,
  WindowSizeButtons,
  dockBackdropClass,
  dockPanelClass,
  useWindowDock,
} from './ui/DockableWindow';
import { UpdateDot } from './UpdateDot';

/** The pane open when Settings last closed, for this visit only: a plain
 *  open (the gear, the shortcut) lands there again, so a setting being tried
 *  out is one click away (#741). A deep link still lands where it points. */
let lastPane: string | null = null;

type SearchModule = typeof import('./settingsSearch/SettingsSearchResults');
type Hit = import('./settingsSearch/SettingsSearchResults').SettingHit;

/** A search result that has been opened: its row, and the tab it lives on. */
type Landing = { id: string; tab?: string; flash: boolean };

/** Open a link the way a click on it would, so the desktop opener sees it. */
function openLink(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Master-detail settings container.
 *
 * One persistent modal. On desktop (>= lg) a category rail sits beside a
 * detail pane; selecting a category swaps only the pane, so siblings are
 * one click apart and nothing closes until the top-level X / Escape.
 *
 * Below lg it collapses to a push stack: a full-width category list, and
 * tapping a category slides in its detail with a back arrow. Back returns
 * to the list; from the list, close dismisses the shell.
 *
 * The search field sits in the header on desktop and on top of the list on
 * a phone. Its code and strings load on the field's first focus, so this
 * window carries only the field. Results fill the pane; the rail dims a
 * section with no hit and counts the hits of the others. A result opens its
 * section on the result's tab and flashes the row; "Back to results" keeps
 * the query. Escape clears the query before it closes anything.
 * Spec: docs/internal/design/ui-patterns.md (section 114, settings search)
 *
 * The frame is intentionally dumb - it knows nothing about individual
 * panes. Callers pass a `categories` array whose `render()` returns the
 * embedded pane, keeping all prop wiring at the call site.
 */
export function SettingsWindow({ categories, initialCategory, initialSetting, defaultCategory, footer, onClose, solo = false }: Props) {
  const { t } = useTranslation('settings');
  const [alone, setAlone] = useState(solo);
  const onEscapeRef = useRef<() => void>(onClose);
  const {
    edge,
    wide,
    docked,
    isMobile,
    insets,
    mountReady,
    dockRef,
    onTop,
    pickSize,
    flipEdge,
    onDockedKey,
  } = useWindowDock({
    storagePrefix: 'privacynotes.settings',
    legacyWideKey: 'privacynotes.settings.wide',
    onEscape: () => onEscapeRef.current(),
  });
  // The docked panel is one pane wide, so it uses the phone's list-then-page stack.
  const stacked = isMobile || docked;
  // Desktop landing: deep-link wins, else the pane open at the last close,
  // else the configured default, else the first real pane (link rows have
  // no pane to land on).
  const desktopLanding =
    initialCategory ?? lastPane ?? defaultCategory ?? categories.find((c) => !c.href)?.id ?? null;
  // null = the mobile list view. Desktop always has a selection.
  const [activeId, setActiveId] = useState<string | null>(
    isMobile ? (initialCategory ?? null) : desktopLanding,
  );
  useEffect(() => {
    if (activeId && !isMobile) lastPane = activeId;
  }, [activeId, isMobile]);

  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchModule | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [landing, setLanding] = useState<Landing | null>(initialSetting ? { ...initialSetting, flash: initialSetting.flash ?? true } : null);
  // Bumped on every landing, so the pane remounts on the result's tab.
  const [paneKey, setPaneKey] = useState(0);
  // Each pane's open tab, so a resize that swaps the phone and desktop
  // layouts (and remounts the pane) keeps it. A navigation starts fresh.
  const [paneTabs] = useState(() => new Map<string, string>());
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  function loadSearch() {
    if (search) return;
    void Promise.all([import('./settingsSearch/SettingsSearchResults'), ensureSettingsSearchLoaded()])
      .then(([mod]) => setSearch(mod))
      .catch((err) => console.warn('[settings] search failed to load:', err));
  }

  const hits: Hit[] | null = useMemo(
    () => (search && query.trim() ? search.runSettingsSearch(query, new Map(categories.map((c) => [c.id, c.label]))) : null),
    [search, query, categories],
  );
  const searching = query.trim() !== '' && landing === null;

  function changeQuery(next: string) {
    // Focus loads the search; a value that arrives without one (a paste
    // from the context menu, an autofill) loads it too.
    if (next) loadSearch();
    setQuery(next);
    setActiveIndex(0);
    setLanding(null);
  }

  function clearSearch() {
    changeQuery('');
  }

  function openCategory(id: string, tab?: string) {
    if (query) clearSearch();
    paneTabs.clear();
    setLanding(tab ? { id, tab, flash: false } : null);
    setActiveId(id);
    // A landing on a tab remounts the pane, which opens on it.
    if (tab) setPaneKey((k) => k + 1);
  }

  function pick(hit: Hit) {
    const category = categories.find((c) => c.id === hit.entry.section);
    if (!category) return;
    if (category.href) {
      openLink(category.href);
      return;
    }
    paneTabs.clear();
    setActiveId(category.id);
    setLanding({ id: hit.entry.id, ...(hit.entry.tab ? { tab: hit.entry.tab } : {}), flash: !hit.entry.isSection });
    setPaneKey((k) => k + 1);
  }

  // Scroll to the opened row once its pane has mounted. A row opened from
  // outside (the quick switcher) waits for the search module first.
  useEffect(() => {
    if (!landing?.flash || !paneRef.current) return;
    if (!search) {
      loadSearch();
      return;
    }
    return search.jumpToSetting(paneRef.current, landing.id);
  }, [landing, paneKey, search]);

  // The quick switcher's key reaches this field while the window is open:
  // the field finds settings, as the switcher does. Capture phase, so the
  // app's own shortcut never sees it. Docked, only while the focus is in the
  // panel: from the app beside it, the key opens the app's own switcher.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (docked && !dockRef.current?.contains(document.activeElement)) return;
      if (matchesKey(e, APP_KEYS.quickSwitcher, true)) {
        e.preventDefault();
        e.stopPropagation();
        if (stacked && activeId) {
          setActiveId(null);
          setLanding(null);
        }
        requestAnimationFrame(() => {
          fieldRef.current?.focus();
          fieldRef.current?.select();
        });
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stacked, activeId, docked]);

  // Escape: a query clears first. Then, if a detail is open on mobile or
  // docked, back to the list; else close.
  onEscapeRef.current = () => {
    if (query) clearSearch();
    else if (stacked && activeId) setActiveId(null);
    else onClose();
  };

  // Resize across the breakpoint while open: desktop must never show an
  // empty detail, so adopt the default when crossing up from the list.
  useEffect(() => {
    if (!stacked && activeId === null) setActiveId(desktopLanding);
  }, [stacked, activeId, desktopLanding]);

  const active = categories.find((c) => c.id === activeId && !c.href) ?? null;

  // Phone: a swipe from the left edge goes back from a page to the list, as
  // the arrow does (#839) and as Android Back does through `onEscape`. Only
  // while Settings is the topmost overlay, and never from a field or a slider.
  useEdgeSwipe(
    () => {
      if (!onTop()) return;
      setLanding(null);
      setActiveId(null);
    },
    isMobile && !docked && !!active,
    (t) => {
      if (t.clientX > EDGE_START_PX) return false;
      const el = t.target instanceof Element ? t.target : null;
      return !el?.closest('input, textarea, select, [contenteditable="true"], [role="slider"]');
    }
  );

  function onFieldKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (isImeComposing(e) || !hits || !searching) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => (i + step + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      const hit = hits[activeIndex];
      if (!hit) return;
      e.preventDefault();
      pick(hit);
    }
  }

  const sectionLabel = (id: string) => categories.find((c) => c.id === id)?.label ?? id;
  const sectionIcon = (id: string) => categories.find((c) => c.id === id)?.icon ?? null;
  const counts = new Map<string, number>();
  if (searching && hits) for (const hit of hits) counts.set(hit.entry.section, (counts.get(hit.entry.section) ?? 0) + 1);

  const field = (
    <div className="relative flex-1 min-w-0">
      {/* Drawn inline: the icon set's glyph would pull its own chunk into the boot path. */}
      <svg
        viewBox="0 0 16 16"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        className="absolute start-2.5 top-1/2 -translate-y-1/2 text-pn-muted pointer-events-none"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="4.75" />
        <path d="M10.5 10.5 14 14" />
      </svg>
      <input
        ref={fieldRef}
        type="search"
        dir="auto"
        value={query}
        onChange={(e) => changeQuery(e.target.value)}
        onFocus={loadSearch}
        onKeyDown={onFieldKey}
        placeholder={t('common:actions.search')}
        aria-label={t('common:actions.search')}
        role="combobox"
        aria-expanded={searching && !!hits && hits.length > 0}
        aria-controls="settings-search-results"
        aria-activedescendant={searching && hits && hits.length > 0 && search ? search.resultOptionId(activeIndex) : undefined}
        autoComplete="off"
        {...NO_TEXT_ASSIST}
        enterKeyHint="search"
        className={`${FIELD_CLASS} pn-search-well !h-8 !bg-surface-1 !ps-8 !pe-8 !py-0 [&::-webkit-search-cancel-button]:appearance-none`}
      />
      {query ? (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clearSearch}
          aria-label={t('common:actions.clearSearch')}
          className="absolute end-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-6 h-6 rounded text-pn-muted hover:text-pn transition"
        >
          <X />
        </button>
      ) : (
        !isMobile && (
          <span
            dir="ltr"
            aria-hidden="true"
            className="absolute end-2 top-1/2 -translate-y-1/2 pointer-events-none inline-flex"
          >
            <Kbd>{keyText('quickSwitcher')}</Kbd>
          </span>
        )
      )}
    </div>
  );

  const results =
    searching && search && hits ? (
      <search.SettingsSearchResults
        query={query}
        hits={hits}
        activeIndex={activeIndex}
        onPick={pick}
        onHover={setActiveIndex}
        onClear={() => {
          clearSearch();
          fieldRef.current?.focus();
        }}
        sectionLabel={sectionLabel}
        sectionIcon={sectionIcon}
      />
    ) : null;

  const paneBody = (
    <div key={paneKey} ref={paneRef} className="flex-1 flex flex-col min-h-0 min-w-0">
      <PaneTabMemory value={paneTabs}>
        {active?.render?.({ navigate: openCategory, ...(landing?.tab ? { initialTab: landing.tab } : {}) })}
      </PaneTabMemory>
    </div>
  );

  function backdrop(children: ReactNode) {
    return (
      <div
        // Settings is prose, not app chrome: the global right-click menu
        // only gets in the way of selecting text here. Spec: issue #208.
        data-no-app-menu
        // Docked (#741): a panel beside a live app, not a modal. No tint, so
        // the app shows each change in its own colors; the layer lets clicks
        // through to the app, and sits under its windows and menus (z-50).
        // The app's Escape stands down while a `role="dialog"` is open.
        role={docked ? 'region' : 'dialog'}
        aria-modal={docked ? undefined : 'true'}
        aria-label={t('shell:contextMenu.settings')}
        style={docked ? { top: insets.top, bottom: insets.bottom } : undefined}
        className={dockBackdropClass({ docked, wide, edge, isMobile, backdropTone: 'subtle' })}
        onPointerDown={(e) => {
          if (mountReady && e.target === e.currentTarget) onClose();
        }}
      >
        {children}
      </div>
    );
  }

  const closeButton = (
    <CloseButton onClick={onClose} />
  );

  const sizeButtons = (
    <WindowSizeButtons
      docked={docked}
      wide={wide}
      isMobile={isMobile}
      pickSize={pickSize}
      flipEdge={flipEdge}
    />
  );

  // ---- Mobile: push stack ------------------------------------------------
  // A phone gets the whole screen, inside the safe areas, pinned to the top.
  // Below lg but from sm (a tablet, or a desktop window made narrower) only
  // the rail goes: the card keeps the desktop window's height and the width
  // of one pane, and the list and a page share that size, so nothing jumps. On iOS the keyboard covers the
  // page without resizing it, so the panel takes the height above the
  // keyboard (`--pn-app-h`) and the focused field scrolls into view inside it;
  // otherwise iOS scrolls the whole page to the field at each PIN digit. On
  // Android the page itself shrinks for the keyboard, and a panel that also
  // took `--pn-app-h` made the keyboard close after every digit, so it fills
  // the overlay there.
  const phoneHeight = ANDROID_LIKE ? 'h-full' : 'h-[var(--pn-app-h,100%)]';
  const phoneFill = docked
    ? dockPanelClass(edge)
    : `w-full flex flex-col text-pn bg-surface-2 ${phoneHeight} pt-[var(--pn-safe-top)] pb-[var(--pn-safe-bottom)] sm:pt-0 sm:pb-0 sm:max-w-2xl sm:h-[92vh] sm:max-h-[960px] sm:rounded-lg sm:border sm:border-divider`;
  // The docked panel takes the focus and its own Escape (see `onDockedKey`).
  const dockProps = docked ? { ref: dockRef, tabIndex: -1, onKeyDown: onDockedKey } : {};
  if (stacked) {
    if (active) {
      return backdrop(
        <div className={phoneFill} {...dockProps}>
          <div className="flex items-center gap-2 px-4 py-3 border-b border-divider">
            <button
              onClick={() => {
                // Back from a result returns to the results.
                setLanding(null);
                setActiveId(null);
              }}
              aria-label={t('common:actions.back')}
              className="text-pn-muted hover:text-pn transition p-1 -m-1"
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="min-w-0 text-title font-semibold leading-tight">{active.title ?? active.label}</h2>
            <div className="ms-auto flex items-center gap-1">{sizeButtons}{closeButton}</div>
          </div>
          {paneBody}
        </div>,
      );
    }
    return backdrop(
      <div className={phoneFill} {...dockProps}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
          <h2 className="text-heading font-semibold">{t('shell:contextMenu.settings')}</h2>
          <div className="flex items-center gap-1">{sizeButtons}{closeButton}</div>
        </div>
        <div className="px-4 pt-3 pb-1 flex">{field}</div>
        {searching ? (
          <div className="flex-1 min-h-0 flex flex-col">{results}</div>
        ) : (
          <nav className="flex-1 overflow-y-auto py-1">
            {categories.map((c, i) => (
              <Fragment key={c.id}>
                {c.group && c.group !== categories[i - 1]?.group && (
                  <div className={`px-4 pt-3 pb-1 ${SETTINGS_EYEBROW}`}>
                    {c.group}
                  </div>
                )}
                {c.href ? (
                  <a
                    href={c.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full flex items-center gap-3 px-4 py-3 text-body text-start text-pn hover:bg-surface-1 transition"
                  >
                    <span className="shrink-0 text-accent">{c.icon}</span>
                    <span className="flex-1 inline-flex items-center gap-1.5">
                      {c.label}
                      <ArrowSquareOut className="text-accent shrink-0" />
                    </span>
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => openCategory(c.id)}
                    aria-label={c.badgeTip ? `${c.label} - ${c.badgeTip}` : undefined}
                    className="w-full flex items-center gap-3 px-4 py-3 text-body text-start text-pn hover:bg-surface-1 transition"
                  >
                    <span className="relative inline-flex shrink-0 text-accent">
                      {c.icon}
                      {c.badgeTip && <UpdateDot ring="ring-surface-2" />}
                    </span>
                    <span className="flex-1">{c.label}</span>
                    <CaretRight className="text-pn-muted shrink-0" />
                  </button>
                )}
              </Fragment>
            ))}
          </nav>
        )}
        {footer && !searching && (
          <div className="border-t border-divider p-3">
            {footer}
          </div>
        )}
      </div>,
    );
  }

  // ---- Desktop: two-pane -------------------------------------------------
  // The window is 92% of the screen's height, at most 960px: "Use the full
  // window" takes about 95%, so this stays a window. The category rail holds
  // 20 rows and 5 group headers (2026-11-11, Backup added): about 770px at
  // 32px a row from a 1000px screen, about 670px at 28px under it, and the
  // window's header, footer and padding take 126px more. So the whole rail
  // shows from a screen about 870px tall; a shorter screen scrolls it.
  // Adding a category means re-measuring the rail's list (the last row's
  // bottom against the list's height). The search field lives in the header
  // for the same reason: the rail has no row to spare. Wide panes (the format
  // bar board, the theme galleries) get 1024px of width from a 1280px window.
  return backdrop(
    <div className={`bg-surface-2 w-full flex flex-col text-pn ${
      // "Use the full window" fills the app edge to edge: no margin, no frame.
      wide && !NATIVE_PHONE
        ? 'h-full max-h-full'
      // Alone, the window fits its one pane: as tall as the pane and narrower,
      // except the format bar board, which needs the width and keeps the full
      // window's height: its Typing and Drawing sides differ in height, and a
      // window that followed them would jump on a tab switch and when a hover
      // label shows. A pane taller than the screen scrolls inside the cap, so
      // the header stays on screen.
      : alone && activeId !== 'formatBar'
        ? 'border border-divider rounded-lg max-w-2xl max-h-[85vh]'
        : 'border border-divider rounded-lg max-w-4xl xl:max-w-5xl h-[92vh] max-h-[960px]'
    }`}>
      <div className="flex items-center gap-4 px-5 py-3 border-b border-divider">
        {alone ? (
          <button
            type="button"
            onClick={() => setAlone(false)}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 -mx-2 text-body font-medium text-pn-soft hover:text-pn hover:bg-surface-1 transition"
          >
            <ArrowLeft aria-hidden="true" />
            {t('shell.allSettings')}
          </button>
        ) : (
          <>
            <h2 className="text-heading font-semibold whitespace-nowrap">{t('shell:contextMenu.settings')}</h2>
            <div className="flex flex-1 max-w-xs">{field}</div>
          </>
        )}
        <div className="ms-auto flex items-center gap-1">
          {sizeButtons}
          {closeButton}
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <nav className={`${alone ? 'hidden' : 'flex'} w-56 shrink-0 border-e border-divider flex-col p-2`}>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {categories.map((c, i) => {
              const on = !searching && c.id === activeId;
              const count = counts.get(c.id) ?? 0;
              // A rail is not a result set: a section with no hit dims and
              // stays. Spec: docs/internal/design/ui-patterns.md section 52
              const dim = searching && hits !== null && count === 0;
              const showHeader = c.group && c.group !== categories[i - 1]?.group;
              const badge = searching && count > 0 && (
                <span className="shrink-0 rounded-full bg-accent/10 px-1.5 text-meta leading-4 text-accent-strong">{count}</span>
              );
              return (
                <Fragment key={c.id}>
                  {showHeader && (
                    <div className={`px-3 pt-2 pb-0.5 first:pt-1 [@media(max-height:999px)]:pt-1.5 [@media(max-height:999px)]:pb-0 ${SETTINGS_EYEBROW}`}>
                      {c.group}
                    </div>
                  )}
                  {c.href ? (
                    <a
                      href={c.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`w-full flex items-center gap-2.5 px-3 py-1.5 [@media(max-height:999px)]:py-1 rounded-md text-body text-start transition text-pn-soft hover:bg-surface-1 ${dim ? 'opacity-45' : ''}`}
                    >
                      <span className="shrink-0 text-accent">{c.icon}</span>
                      <span className="flex-1 inline-flex items-center gap-1.5">
                        {c.label}
                        <ArrowSquareOut className="text-accent shrink-0" />
                      </span>
                      {badge}
                    </a>
                  ) : (() => {
                    const rowBtn = (
                      <button
                        type="button"
                        onClick={() => openCategory(c.id)}
                        aria-current={on}
                        aria-label={c.badgeTip ? `${c.label} - ${c.badgeTip}` : undefined}
                        className={`w-full flex items-center gap-2.5 px-3 py-1.5 [@media(max-height:999px)]:py-1 rounded-md text-body text-start transition ${
                          on
                            ? 'bg-accent/10 text-accent-strong font-medium'
                            : 'text-pn-soft hover:bg-surface-1'
                        } ${dim ? 'opacity-45' : ''}`}
                      >
                        {/* Category icons are always accent, active or not, so the
                            rail reads as one family and matches the sidebar.
                            Spec: docs/internal/design/ui-patterns.md section 36 */}
                        <span className="relative inline-flex shrink-0 text-accent">
                          {c.icon}
                          {c.badgeTip && <UpdateDot ring="ring-surface-2" />}
                        </span>
                        <span className="flex-1">{c.label}</span>
                        {badge}
                      </button>
                    );
                    return c.badgeTip ? (
                      <HoverLabel label={c.badgeTip} position="above-start" className="w-full">
                        {rowBtn}
                      </HoverLabel>
                    ) : rowBtn;
                  })()}
                </Fragment>
              );
            })}
          </div>
          {footer && (
            <div className="border-t border-divider mt-2 pt-2">{footer}</div>
          )}
        </nav>
        <section className="flex-1 flex flex-col min-h-0 min-w-0">
          {searching ? (
            results
          ) : (
            <>
              {active && (
                <div className="px-6 pt-4 pb-1 shrink-0">
                  {landing && query && (
                    <Button
                      action="back"
                      onClick={() => setLanding(null)}
                      className="mb-2 !rounded-full !px-2.5 !py-0.5 !text-small"
                    >
                      {t('settingsSearch:backToResults')}
                    </Button>
                  )}
                  <div className="flex items-center gap-2.5">
                    <AccentBar />
                    <h3 className="text-title font-semibold">{active.title ?? active.label}</h3>
                    <HeadlineRule />
                  </div>
                </div>
              )}
              {paneBody}
            </>
          )}
        </section>
      </div>
    </div>,
  );
}
