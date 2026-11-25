import { useEffect, useMemo, useRef, useState } from 'react';
import catalogIndex from './catalogIndex.json';
import {
  CATALOG_PARTS,
  PART_CATEGORIES,
  type CatalogPartDef,
  type PartCategory,
} from './catalog/catalogData';
import { renderActionOrInputDemo } from './catalog/demosActions';
import { renderSurfaceDemo } from './catalog/demosSurfaces';
import { renderDomainDemo } from './catalog/demosDomains';
import {
  AgentGuideView,
  AppMapView,
  InconsistenciesView,
  OverviewView,
  TokensView,
} from './catalog/CatalogViews';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  IconButton,
  ListSearchInput,
  SETTINGS_HELP,
  Select,
} from './index';
import { textMatcher } from '../textMatch';
import {
  DARK_THEMES,
  LIGHT_THEMES,
  THEME_DISPLAY_NAME,
  previewColorTheme,
  previewCustomTheme,
  type ColorTheme,
} from '../theme';
import { COMMUNITY_THEMES } from '../communityThemes';
import { parseThemeCode } from '../themeCode';
import { snapshotOf } from '../customThemeUI';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Folder,
  List,
  Moon,
  Sparkle,
  Sun,
  Warning,
  XCircle,
} from '../icons';

type MainTab = 'parts' | 'overview' | 'tokens' | 'inconsistencies' | 'app-map' | 'agent-guide';
type StageWidth = 'full' | 'pane' | 'phone';
type StatusFilter = 'all' | 'canonical' | 'shared' | 'drift';
type CatalogTheme = ColorTheme | 'note-boy';

const NOTE_BOY_SNAPSHOT = (() => {
  const entry = COMMUNITY_THEMES.find((t) => t.id === 'noteboy00000');
  const parsed = entry ? parseThemeCode(entry.code) : null;
  return entry && parsed ? snapshotOf(entry.id, parsed) : null;
})();

function catalogThemeLabel(ct: CatalogTheme): string {
  return ct === 'note-boy' ? 'Note Boy' : THEME_DISPLAY_NAME[ct];
}

function detectInitialTheme(): CatalogTheme {
  const cls = document.documentElement.classList;
  if (cls.contains('theme-custom-light')) return 'note-boy';
  for (const ct of [...LIGHT_THEMES, ...DARK_THEMES]) {
    if (ct !== 'default' && cls.contains(`theme-${ct}`)) return ct;
  }
  return 'default';
}

const STATUS_BADGE = {
  canonical: { label: 'Canonical (./ui)', tone: 'success' as const },
  direct: { label: 'Direct import', tone: 'info' as const },
  shared: { label: 'Shared app atom', tone: 'warning' as const },
  flow: { label: 'Product flow', tone: 'neutral' as const },
};

const STORAGE_KEY_PART = 'privacynotes.catalog.part';
const STORAGE_KEY_TAB = 'privacynotes.catalog.tab';

function readSession(key: string, fallback: string): string {
  try {
    return sessionStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Complete Interactive App UI Catalog (excluding homepage/marketing pages).
 * Opened at `?demo=1#ui-catalog` (demo and dev builds only, lazy-loaded by main.tsx).
 */
export default function Catalog() {
  const [tab, setTab] = useState<MainTab>(() => readSession(STORAGE_KEY_TAB, 'parts') as MainTab);
  const [selectedId, setSelectedId] = useState<string>(() => readSession(STORAGE_KEY_PART, 'button'));
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [colorTheme, setColorTheme] = useState<CatalogTheme>(detectInitialTheme);
  const [stageWidth, setStageWidth] = useState<StageWidth>('full');
  const [rtl, setRtl] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [appMapDomain, setAppMapDomain] = useState('all');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY_TAB, tab); } catch { /* ignore */ }
  }, [tab]);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY_PART, selectedId); } catch { /* ignore */ }
  }, [selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault();
        setTab('parts');
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const applyTheme = (nextDark: boolean, nextColor: CatalogTheme) => {
    const mode = nextDark ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', nextDark);
    if (!nextDark && nextColor === 'note-boy' && NOTE_BOY_SNAPSHOT) {
      previewCustomTheme('light', NOTE_BOY_SNAPSHOT);
    } else {
      previewCustomTheme(mode, null);
      previewColorTheme(mode, nextColor === 'note-boy' ? 'default' : nextColor);
    }
    setDark(nextDark);
    setColorTheme(nextColor);
  };

  const toggleDark = () => {
    const nextDark = !dark;
    applyTheme(nextDark, 'default');
  };

  const match = textMatcher(search);
  const filteredParts = useMemo(
    () =>
      CATALOG_PARTS.filter((p) => {
        if (statusFilter === 'canonical' && p.status !== 'canonical') return false;
        if (statusFilter === 'shared' && p.status !== 'shared' && p.status !== 'direct') return false;
        if (statusFilter === 'drift' && !(p.driftNotes?.length || p.internalNotes?.length)) return false;
        if (!search.trim()) return true;
        return match(`${p.name} ${p.category} ${p.summary} ${p.source} ${p.useFor} ${p.never} ${p.keywords ?? ''}`) !== null;
      }),
    [statusFilter, search, match],
  );

  const groupedParts = useMemo(() => {
    const groups: { category: PartCategory; items: CatalogPartDef[] }[] = [];
    for (const category of PART_CATEGORIES) {
      const items = filteredParts.filter((p) => p.category === category);
      if (items.length) groups.push({ category, items });
    }
    return groups;
  }, [filteredParts]);

  const activePart = useMemo(
    () => filteredParts.find((p) => p.id === selectedId) ?? filteredParts[0] ?? CATALOG_PARTS[0]!,
    [filteredParts, selectedId],
  );

  const activeIdx = filteredParts.findIndex((p) => p.id === activePart.id);
  const prevPart = activeIdx > 0 ? filteredParts[activeIdx - 1] : null;
  const nextPart = activeIdx >= 0 && activeIdx < filteredParts.length - 1 ? filteredParts[activeIdx + 1] : null;

  const consumers = useMemo(() => {
    const set = new Set<string>();
    const map = catalogIndex.symbols as Record<string, string[]>;
    for (const sym of activePart.consumerSymbols) {
      for (const f of map[sym] ?? []) set.add(f);
    }
    return [...set].sort();
  }, [activePart]);

  const liveDemo = renderActionOrInputDemo(activePart.id)
    ?? renderSurfaceDemo(activePart.id)
    ?? renderDomainDemo(activePart.id);

  const modeThemes = dark ? DARK_THEMES : LIGHT_THEMES;
  const stageWidthClass = stageWidth === 'phone'
    ? 'max-w-[375px]'
    : stageWidth === 'pane'
      ? 'max-w-[480px]'
      : 'w-full';

  const navItems: { id: MainTab; label: string; badge?: string }[] = [
    { id: 'parts', label: 'Parts', badge: String(CATALOG_PARTS.length) },
    { id: 'overview', label: 'Overview' },
    { id: 'tokens', label: 'Tokens' },
    { id: 'inconsistencies', label: 'Polish Queue', badge: String(catalogIndex.summary.totalLintFindings) },
    { id: 'app-map', label: 'App Map', badge: String(catalogIndex.summary.totalAppFiles) },
    { id: 'agent-guide', label: 'Agent Guide' },
  ];

  const railContent = (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-divider p-3">
        <ListSearchInput
          inputRef={searchRef}
          value={search}
          onChange={setSearch}
          placeholder="Filter parts (press /)"
        />
        <div className="flex flex-wrap gap-1">
          {([
            ['all', 'All'],
            ['canonical', 'ui/'],
            ['shared', 'Shared'],
            ['drift', 'Has drift'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              className={`rounded-md px-2 py-0.5 text-meta font-medium transition ${
                statusFilter === key
                  ? 'bg-accent-fill text-white'
                  : 'bg-track text-pn-soft hover:text-pn'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <nav aria-label="Catalog parts" className="flex-1 overflow-y-auto p-2 space-y-4">
        {groupedParts.map((g) => (
          <div key={g.category} className="space-y-0.5">
            <p className="px-2 pb-1 text-meta font-semibold uppercase tracking-wide text-pn-muted">
              {g.category} ({g.items.length})
            </p>
            {g.items.map((p) => {
              const selected = p.id === activePart.id;
              const hasDrift = Boolean(p.driftNotes?.length || p.internalNotes?.length);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setSelectedId(p.id); setMobileRailOpen(false); }}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-start text-compact transition ${
                    selected
                      ? 'bg-accent/15 font-semibold text-accent-strong'
                      : 'text-pn-soft hover:bg-pn/5 hover:text-pn'
                  }`}
                >
                  <span className="truncate">{p.name}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {p.status === 'shared' && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Shared app atom" />}
                    {hasDrift && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Has drift or notes" />}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {!groupedParts.length && <EmptyState compact>No parts match.</EmptyState>}
      </nav>
    </div>
  );

  return (
    <div className="flex h-dvh flex-col bg-surface-0 text-pn">
      {/* Compact Top Bar */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider bg-surface-1 px-3 py-2">
        {tab === 'parts' && (
          <div className="lg:hidden">
            <IconButton label="Toggle parts sidebar" onClick={() => setMobileRailOpen((v) => !v)}>
              <List aria-hidden="true" />
            </IconButton>
          </div>
        )}
        <div className="flex items-center gap-2 me-2">
          <Sparkle className="text-accent shrink-0" aria-hidden="true" />
          <h1 className="text-body font-semibold whitespace-nowrap">App UI Catalog</h1>
          <Badge tone="info">v{catalogIndex.version}</Badge>
        </div>

        {/* Mode Tabs */}
        <nav aria-label="Catalog sections" className="flex flex-wrap items-center gap-1">
          {navItems.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setTab(n.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-small font-medium transition ${
                tab === n.id
                  ? 'bg-surface-2 text-pn shadow-sm border border-divider'
                  : 'text-pn-soft hover:bg-pn/5 hover:text-pn'
              }`}
            >
              <span>{n.label}</span>
              {n.badge && <span className="text-meta text-pn-muted tabular-nums">{n.badge}</span>}
            </button>
          ))}
        </nav>

        {/* Live Stage Controls */}
        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          {tab === 'parts' && (
            <div className="hidden sm:inline-flex items-center rounded-md bg-track p-0.5 text-meta">
              {([['full', 'Full'], ['pane', '480px'], ['phone', '375px']] as const).map(([w, label]) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setStageWidth(w)}
                  className={`rounded px-2 py-1 font-medium transition ${
                    stageWidth === w ? 'bg-surface-2 text-pn shadow-sm' : 'text-pn-soft hover:text-pn'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setRtl((v) => !v)}
            className={`rounded-md border border-divider px-2 py-1 text-meta font-medium transition ${
              rtl ? 'bg-accent/15 text-accent-strong border-accent/40' : 'bg-surface-2 text-pn-soft hover:text-pn'
            }`}
          >
            {rtl ? 'RTL' : 'LTR'}
          </button>
          <div className="hidden md:inline-flex items-center rounded-md bg-track p-0.5 text-meta" role="group" aria-label="Quick themes">
            {([
              ['warm-cream', false, 'Cream'],
              ['note-boy', false, 'Note Boy'],
              ['default', true, 'Dark'],
            ] as const).map(([ct, isDark, label]) => {
              const active = dark === isDark && colorTheme === ct;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => applyTheme(isDark, ct)}
                  className={`rounded px-2 py-1 font-medium transition ${
                    active ? 'bg-surface-2 text-pn shadow-sm' : 'text-pn-soft hover:text-pn'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <Select
            size="sm"
            aria-label="Color theme"
            value={colorTheme}
            onChange={(e) => applyTheme(dark, e.target.value as CatalogTheme)}
            className="!py-1 text-small"
          >
            {modeThemes.map((ct) => (
              <option key={ct} value={ct}>{THEME_DISPLAY_NAME[ct]}</option>
            ))}
            {!dark && NOTE_BOY_SNAPSHOT && <option value="note-boy">Note Boy</option>}
          </Select>
          <IconButton label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleDark}>
            {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </IconButton>
        </div>
      </header>

      {/* Main Content Area */}
      {tab === 'parts' ? (
        <div className="relative flex min-h-0 flex-1">
          {/* Desktop Left Rail */}
          <aside className="hidden w-64 shrink-0 border-e border-divider bg-surface-1 lg:block">
            {railContent}
          </aside>

          {/* Mobile Drawer Rail */}
          {mobileRailOpen && (
            <div className="fixed inset-0 z-50 flex lg:hidden">
              <div className="w-72 max-w-[85vw] border-e border-divider bg-surface-1 shadow-xl">
                {railContent}
              </div>
              <button
                type="button"
                aria-label="Close sidebar"
                className="flex-1 bg-black/40"
                onClick={() => setMobileRailOpen(false)}
              />
            </div>
          )}

          {/* Focused Single-Item Right Inspector */}
          <main className="min-w-0 flex-1 overflow-y-auto bg-surface-0 p-4 sm:p-6">
            <div className="mx-auto max-w-4xl space-y-6">
              {/* Item Header */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-meta font-medium text-pn-muted">{activePart.category}</span>
                    <Badge tone={STATUS_BADGE[activePart.status].tone}>{STATUS_BADGE[activePart.status].label}</Badge>
                    <Badge tone="neutral">{consumers.length} consumer file{consumers.length === 1 ? '' : 's'}</Badge>
                  </div>
                  <h2 className="text-heading font-semibold">{activePart.name}</h2>
                  <p className={SETTINGS_HELP}>{activePart.summary}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    icon={<ArrowLeft aria-hidden="true" />}
                    disabled={!prevPart}
                    onClick={() => prevPart && setSelectedId(prevPart.id)}
                  >
                    Prev
                  </Button>
                  <Button
                    icon={<ArrowRight aria-hidden="true" />}
                    iconEnd
                    disabled={!nextPart}
                    onClick={() => nextPart && setSelectedId(nextPart.id)}
                  >
                    Next
                  </Button>
                </div>
              </div>

              {/* Import & Source Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-divider bg-surface-2 px-3 py-2">
                <div className="min-w-0 space-y-0.5">
                  <pre className="overflow-x-auto font-mono text-meta text-pn">{activePart.importCode}</pre>
                  <p className="text-meta text-pn-muted">Source: {activePart.source}</p>
                </div>
                <CopyButton value={activePart.importCode} label="Copy import" />
              </div>

              {/* Use For / Never Cards */}
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-divider bg-surface-2 p-3.5 space-y-1">
                  <p className="flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wide text-success">
                    <CheckCircle aria-hidden="true" /> Use for
                  </p>
                  <p className="text-compact text-pn-soft">{activePart.useFor}</p>
                </div>
                <div className="rounded-lg border border-divider bg-surface-2 p-3.5 space-y-1">
                  <p className="flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wide text-danger">
                    <XCircle aria-hidden="true" /> Never
                  </p>
                  <p className="text-compact text-pn-soft">{activePart.never}</p>
                </div>
              </div>

              {/* Live Interactive Preview Stage */}
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-meta font-semibold uppercase tracking-wide text-pn-muted">
                    Live Interactive Preview ({stageWidth === 'full' ? 'Full width' : stageWidth === 'pane' ? '480px pane' : '375px phone'} · {rtl ? 'RTL' : 'LTR'} · {catalogThemeLabel(colorTheme)} {dark ? 'Dark' : 'Light'})
                  </p>
                </div>
                <div className="overflow-x-auto rounded-xl border border-divider bg-surface-1 p-4 sm:p-6">
                  <div
                    dir={rtl ? 'rtl' : 'ltr'}
                    className={`${stageWidthClass} mx-auto rounded-lg border border-divider/70 bg-surface-2 p-4 sm:p-5`}
                  >
                    {liveDemo ?? <EmptyState compact>No interactive preview registered.</EmptyState>}
                  </div>
                </div>
              </section>

              {/* Drift & Internal Notes */}
              {(activePart.driftNotes?.length || activePart.internalNotes?.length) && (
                <section className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-4">
                  <p className="flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wide text-warning">
                    <Warning aria-hidden="true" /> Known Inconsistencies & Library Notes
                  </p>
                  {activePart.driftNotes && activePart.driftNotes.length > 0 && (
                    <ul className="list-disc space-y-1.5 ps-5 text-compact text-pn-soft">
                      {activePart.driftNotes.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  )}
                  {activePart.internalNotes && activePart.internalNotes.length > 0 && (
                    <div className="border-t border-divider/60 pt-2">
                      <p className="text-meta font-semibold text-pn-muted mb-1">Internal part rough edges:</p>
                      <ul className="list-disc space-y-1 ps-5 text-compact text-pn-soft">
                        {activePart.internalNotes.map((n, i) => <li key={i}>{n}</li>)}
                      </ul>
                    </div>
                  )}
                </section>
              )}

              {/* Real App Consumers */}
              <section className="rounded-lg border border-divider bg-surface-2 p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wide text-pn-muted">
                    <Folder aria-hidden="true" /> Real App Consumers ({consumers.length} files)
                  </p>
                  {activePart.lintRules && activePart.lintRules.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {activePart.lintRules.map((r) => <Badge key={r} tone="info">lint: {r}</Badge>)}
                    </div>
                  )}
                </div>
                {consumers.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {consumers.map((c) => (
                      <code key={c} className="rounded bg-surface-1 border border-divider px-2 py-0.5 font-mono text-meta text-pn-soft">
                        {c}
                      </code>
                    ))}
                  </div>
                ) : (
                  <p className={SETTINGS_HELP}>No direct product imports found (check wrappers or barrel re-exports).</p>
                )}
              </section>
            </div>
          </main>
        </div>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto bg-surface-0 p-4 sm:p-6">
          <div className="mx-auto max-w-6xl">
            {tab === 'overview' && (
              <OverviewView
                onJumpToDomain={(d) => { setAppMapDomain(d); setTab('app-map'); }}
                onOpenTab={setTab}
              />
            )}
            {tab === 'tokens' && (
              <TokensView onSelectTheme={(mode, ct) => applyTheme(mode === 'dark', ct)} />
            )}
            {tab === 'inconsistencies' && <InconsistenciesView />}
            {tab === 'app-map' && <AppMapView key={appMapDomain} initialDomain={appMapDomain} />}
            {tab === 'agent-guide' && <AgentGuideView />}
          </div>
        </main>
      )}
    </div>
  );
}
