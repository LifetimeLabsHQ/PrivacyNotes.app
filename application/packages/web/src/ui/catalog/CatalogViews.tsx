import { useMemo, useState } from 'react';
import catalogIndex from '../catalogIndex.json';
import {
  AGENT_GUIDE,
  CATALOG_PARTS,
  HIDDEN_STATES,
  INCONSISTENCIES,
  UNPROMOTED_PATTERNS,
} from './catalogData';
import { ACTIONS, type ActionName } from '../actions';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ListSearchInput,
  SectionEyebrow,
  Select,
  SETTINGS_HELP,
  SettingsSegmented,
  StatTile,
} from '../index';
import { textMatcher } from '../../textMatch';
import {
  DARK_THEMES,
  LIGHT_THEMES,
  THEME_DISPLAY_NAME,
  themeSwatch,
  type ColorTheme,
} from '../../theme';
import {
  CheckCircle,
  Code,
  Folder,
  Gear,
  Info,
  ListBullets,
  Palette,
  Sparkle,
  Warning,
} from '../../icons';

const SEVERITY_TONE = {
  critical: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
} as const;

export function OverviewView({
  onJumpToDomain,
  onOpenTab,
}: {
  onJumpToDomain: (domain: string) => void;
  onOpenTab: (tab: 'parts' | 'tokens' | 'inconsistencies' | 'app-map' | 'agent-guide') => void;
}) {
  const s = catalogIndex.summary;
  const waves = useMemo(() => {
    const map = new Map<number, { wave: number; name: string; items: typeof INCONSISTENCIES[number][] }>();
    for (const item of INCONSISTENCIES) {
      const entry = map.get(item.wave) ?? { wave: item.wave, name: item.waveName, items: [] };
      entry.items.push(item);
      map.set(item.wave, entry);
    }
    return [...map.values()].sort((a, b) => a.wave - b.wave);
  }, []);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-heading font-semibold">App UI Coverage & Health (v{catalogIndex.version})</h2>
          <p className={SETTINGS_HELP}>
            100% of non-marketing app source mapped ({s.totalAppFiles} .tsx files, {s.totalSettingsRoutes} live settings routes, {s.excludedMarketingFiles} marketing pages excluded).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={<Sparkle aria-hidden="true" />} variant="primary" onClick={() => onOpenTab('parts')}>Browse {CATALOG_PARTS.length} Parts</Button>
          <Button icon={<Warning aria-hidden="true" />} onClick={() => onOpenTab('inconsistencies')}>Polish Queue ({INCONSISTENCIES.length})</Button>
          <Button icon={<Code aria-hidden="true" />} onClick={() => onOpenTab('agent-guide')}>Agent Selector</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="App .tsx files" value={String(s.totalAppFiles)} sub="100% mapped" />
        <StatTile label="Cataloged parts" value={String(CATALOG_PARTS.length)} sub={`${UNPROMOTED_PATTERNS.length} unpromoted`} />
        <StatTile label="Settings routes" value={String(s.totalSettingsRoutes)} sub="Live registry" />
        <StatTile label="UI lint findings" value={String(s.totalLintFindings)} sub={`${s.filesWithLint} files`} />
        <StatTile label="Hand-rolled modals" value={String(s.handRolledOverlays)} sub={`${s.modalFilesUsingModal + s.modalFilesUsingDockable} canonical`} />
        <StatTile label="Hand-rolled banners" value={`${s.handRolledBanners} / ${s.handRolledBanners + s.bannersUsingUi}`} sub={`${s.filesWithFixedColors} fixed-color files`} />
      </div>

      <section className="space-y-3">
        <SectionEyebrow icon={Folder}>Coverage by App Domain (click any domain to inspect in App Map)</SectionEyebrow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {catalogIndex.domains.map((d) => {
            const cleanPct = Math.round(((d.files - d.filesWithLint) / Math.max(d.files, 1)) * 100);
            return (
              <button
                key={d.name}
                type="button"
                onClick={() => onJumpToDomain(d.name)}
                className="rounded-lg border border-divider bg-surface-2 p-4 text-start transition hover:border-accent/50 hover:bg-surface-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body font-semibold truncate">{d.name}</span>
                  <Badge tone={d.lintFindings === 0 ? 'success' : d.lintFindings > 40 ? 'danger' : 'warning'}>
                    {d.files} files
                  </Badge>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-track">
                  <div className="h-full rounded-full bg-accent-fill" style={{ width: `${cleanPct}%` }} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-meta text-pn-muted">
                  <span>{d.lintFindings} lint ({d.filesWithLint} files)</span>
                  {d.handRolledOverlays > 0 && <span className="text-warning">{d.handRolledOverlays} raw overlays</span>}
                  {d.handRolledBanners > 0 && <span className="text-warning">{d.handRolledBanners} raw banners</span>}
                  {d.filesWithFixedColors > 0 && <span>{d.filesWithFixedColors} fixed-color</span>}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <SectionEyebrow icon={Warning}>Recommended Polish Waves (Next Step)</SectionEyebrow>
        <div className="grid gap-3 md:grid-cols-2">
          {waves.map((w) => (
            <div key={w.wave} className="rounded-lg border border-divider bg-surface-2 p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-body font-semibold">{w.name}</h3>
                <Badge tone="info">{w.items.length} groups</Badge>
              </div>
              <ul className="space-y-1 text-compact text-pn-soft">
                {w.items.map((item) => (
                  <li key={item.id} className="flex items-start gap-2">
                    <Badge tone={SEVERITY_TONE[item.severity]}>{item.id}</Badge>
                    <span>{item.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const COLOR_TOKENS = [
  { name: 'surface-0', css: '--pn-surface-0', role: 'App shell / sidebar rail', bg: 'bg-surface-0' },
  { name: 'surface-1', css: '--pn-surface-1', role: 'List pane / recessed panel / popover', bg: 'bg-surface-1' },
  { name: 'surface-2', css: '--pn-surface-2', role: 'Editor / cards / modals', bg: 'bg-surface-2' },
  { name: 'track', css: '--pn-track', role: 'Segmented tracks / field wells / plates', bg: 'bg-track' },
  { name: 'divider', css: '--pn-divider', role: 'Hairline borders and rules', bg: 'bg-divider' },
  { name: 'accent', css: '--pn-accent', role: 'Structure, links, active glyphs', bg: 'bg-accent' },
  { name: 'accent-fill', css: '--pn-accent-fill', role: 'Solid primary fills & badges', bg: 'bg-accent-fill' },
  { name: 'label', css: '--pn-label', role: 'Folder & tag ink', bg: 'bg-label' },
  { name: 'pro', css: '--pn-pro', role: 'Pro rocket (amber light, gold dark)', bg: 'bg-pro' },
  { name: 'success', css: '--pn-success', role: 'Confirmed results & logged pills', bg: 'bg-success' },
  { name: 'warning', css: '--pn-warning', role: 'Risks, alerts & active filters', bg: 'bg-warning' },
  { name: 'danger', css: '--pn-danger', role: 'Destructive actions & errors', bg: 'bg-danger' },
];

const TYPE_ROLES = [
  { role: 'meta', cls: 'text-meta', css: '--fs-meta / --ic-meta', use: 'Dates, counts, badges, keyboard hints, eyebrows (never a sentence)' },
  { role: 'small', cls: 'text-small', css: '--fs-small / --ic-small', use: 'Segmented controls, chips, secondary labels, captions' },
  { role: 'help', cls: 'text-help', css: '--fs-help / --ic-help', use: 'Helper lines (SETTINGS_HELP), help links (HelpChip)' },
  { role: 'compact', cls: 'text-compact', css: '--fs-compact / --ic-compact', use: 'Menu items, compact cards, sidebar sub-rows, banners' },
  { role: 'body', cls: 'text-body', css: '--fs-body / --ic-body', use: 'Body copy, buttons, fields, settings rows (ROW_TITLE)' },
  { role: 'row', cls: 'text-row', css: '--fs-row / --ic-row', use: 'Main rows of the sidebar and item lists' },
  { role: 'title', cls: 'text-title', css: '--fs-title / --ic-title', use: 'Pane titles, card titles' },
  { role: 'heading', cls: 'text-heading', css: '--fs-heading / --ic-heading', use: 'Window titles, section headings' },
  { role: 'display', cls: 'text-display', css: '--fs-display / --ic-display', use: 'StatTile numbers, calendar date tiles' },
  { role: 'display-2', cls: 'text-display-2', css: '--fs-display-2 / --ic-display-2', use: 'Large summary counters and hero numbers' },
];

export function TokensView({
  onSelectTheme,
}: {
  onSelectTheme: (mode: 'light' | 'dark', theme: ColorTheme) => void;
}) {
  const allActions = Object.keys(ACTIONS) as ActionName[];
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionEyebrow icon={Palette}>Semantic Color Tokens (live in active theme)</SectionEyebrow>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {COLOR_TOKENS.map((t) => (
            <div key={t.name} className="flex items-center gap-3 rounded-lg border border-divider bg-surface-2 p-3">
              <span className={`h-9 w-9 shrink-0 rounded-md border border-divider ${t.bg}`} />
              <div className="min-w-0">
                <p className="text-body font-medium truncate">{t.name}</p>
                <p className="text-meta text-pn-muted font-mono truncate">{t.css}</p>
                <p className="text-meta text-pn-soft truncate">{t.role}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-divider bg-surface-2 p-4 space-y-2">
          <p className="text-meta font-semibold uppercase tracking-wide text-pn-muted">Text ladder</p>
          <p className="text-body text-pn">text-pn - Primary text (--pn-text)</p>
          <p className="text-body text-pn-soft">text-pn-soft - Supporting prose, descriptions, helpers (--pn-text-soft)</p>
          <p className="text-body text-pn-muted">text-pn-muted - Metadata, timestamps, counts (--pn-text-muted)</p>
        </div>
      </section>

      <section className="space-y-3">
        <SectionEyebrow icon={Sparkle}>Built-in Themes (click to preview live)</SectionEyebrow>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {LIGHT_THEMES.map((ct) => {
            const [s0, acc, txt] = themeSwatch(ct, false);
            return (
              <button key={`l-${ct}`} type="button" onClick={() => onSelectTheme('light', ct)} className="flex items-center gap-3 rounded-lg border border-divider bg-surface-2 p-3 text-start hover:border-accent">
                <span className="flex h-8 w-12 overflow-hidden rounded border border-divider shrink-0">
                  <span className="flex-1" style={{ background: s0 }} />
                  <span className="flex-1" style={{ background: acc }} />
                  <span className="flex-1" style={{ background: txt }} />
                </span>
                <div>
                  <p className="text-body font-medium">{THEME_DISPLAY_NAME[ct]}</p>
                  <p className="text-meta text-pn-muted">Light</p>
                </div>
              </button>
            );
          })}
          {DARK_THEMES.map((ct) => {
            const [s0, acc, txt] = themeSwatch(ct, true);
            return (
              <button key={`d-${ct}`} type="button" onClick={() => onSelectTheme('dark', ct)} className="flex items-center gap-3 rounded-lg border border-divider bg-surface-2 p-3 text-start hover:border-accent">
                <span className="flex h-8 w-12 overflow-hidden rounded border border-divider shrink-0">
                  <span className="flex-1" style={{ background: s0 }} />
                  <span className="flex-1" style={{ background: acc }} />
                  <span className="flex-1" style={{ background: txt }} />
                </span>
                <div>
                  <p className="text-body font-medium">{THEME_DISPLAY_NAME[ct]}</p>
                  <p className="text-meta text-pn-muted">Dark</p>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <SectionEyebrow icon={ListBullets}>Type Scale & Auto-Sized Icons (typeScale.css)</SectionEyebrow>
        <div className="divide-y divide-divider rounded-lg border border-divider bg-surface-2">
          {TYPE_ROLES.map((r) => (
            <div key={r.role} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className={`flex items-center gap-2 ${r.cls} font-medium`}>
                <Sparkle className="text-accent shrink-0" aria-hidden="true" />
                <span>text-{r.role}</span>
              </div>
              <div className="sm:text-end">
                <p className="text-meta font-mono text-pn-muted">{r.css}</p>
                <p className="text-meta text-pn-soft">{r.use}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <SectionEyebrow icon={Gear}>Canonical Action Map ({allActions.length} actions in ui/actions.ts)</SectionEyebrow>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {allActions.map((name) => {
            const spec = ACTIONS[name];
            return (
              <div key={name} className="flex items-center justify-between gap-2 rounded-lg border border-divider bg-surface-2 px-3 py-2">
                <Button action={name}>{spec.label ? undefined : name[0]!.toUpperCase() + name.slice(1)}</Button>
                <div className="text-end">
                  <p className="text-meta font-mono text-pn">action="{name}"</p>
                  <p className="text-meta text-pn-muted">{spec.variant}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function InconsistenciesView() {
  const [view, setView] = useState<'waves' | 'unpromoted'>('waves');
  const [severity, setSeverity] = useState<'all' | 'critical' | 'high' | 'medium' | 'low'>('all');
  const [query, setQuery] = useState('');
  const match = textMatcher(query);

  const filteredWaves = useMemo(
    () =>
      INCONSISTENCIES.filter((i) => {
        if (severity !== 'all' && i.severity !== severity) return false;
        if (!query.trim()) return true;
        return match(`${i.id} ${i.waveName} ${i.category} ${i.title} ${i.detail} ${i.canonicalTarget} ${i.locations.join(' ')}`) !== null;
      }),
    [severity, query, match],
  );

  const filteredUnpromoted = useMemo(
    () =>
      UNPROMOTED_PATTERNS.filter((u) => {
        if (!query.trim()) return true;
        return match(`${u.id} ${u.name} ${u.proposedPart} ${u.whyPromote} ${u.driftToday} ${u.currentFiles.join(' ')}`) !== null;
      }),
    [query, match],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SettingsSegmented
          label="Queue view"
          value={view}
          onChange={setView}
          options={[
            { value: 'waves', label: `Polish Waves (${INCONSISTENCIES.length})` },
            { value: 'unpromoted', label: `Unpromoted Patterns (${UNPROMOTED_PATTERNS.length})` },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          {view === 'waves' && (
            <Select size="sm" aria-label="Filter severity" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
              <option value="all">All severities</option>
              <option value="critical">Critical / Bugs</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </Select>
          )}
          <div className="w-64">
            <ListSearchInput value={query} onChange={setQuery} placeholder="Search file, rule, or pattern..." />
          </div>
        </div>
      </div>

      {view === 'waves' ? (
        <div className="space-y-3">
          {filteredWaves.map((item) => (
            <div key={item.id} className="rounded-lg border border-divider bg-surface-2 p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONE[item.severity]}>{item.severity.toUpperCase()}</Badge>
                <Badge tone="info">{item.id}</Badge>
                <span className="text-meta text-pn-muted">{item.waveName}</span>
                <span className="ms-auto text-meta text-pn-muted">{item.category}</span>
              </div>
              <h3 className="text-body font-semibold">{item.title}</h3>
              <p className={SETTINGS_HELP}>{item.detail}</p>
              <p className="text-compact text-pn">
                <span className="font-semibold text-accent">Canonical target:</span> {item.canonicalTarget}
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {item.locations.map((loc) => (
                  <code key={loc} className="rounded bg-surface-1 border border-divider px-2 py-0.5 font-mono text-meta text-pn-soft">
                    {loc}
                  </code>
                ))}
              </div>
            </div>
          ))}
          {!filteredWaves.length && <EmptyState compact>No matching inconsistency groups.</EmptyState>}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filteredUnpromoted.map((u) => (
            <div key={u.id} className="rounded-lg border border-divider bg-surface-2 p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-body font-semibold">{u.name}</h3>
                <Badge tone="info">{u.id}</Badge>
              </div>
              <p className="text-compact font-mono text-accent">{u.proposedPart}</p>
              <p className={SETTINGS_HELP}>{u.whyPromote}</p>
              <p className="text-compact text-warning">Drift today: {u.driftToday}</p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {u.currentFiles.map((f) => (
                  <code key={f} className="rounded bg-surface-1 border border-divider px-2 py-0.5 font-mono text-meta text-pn-soft">
                    {f}
                  </code>
                ))}
              </div>
            </div>
          ))}
          {!filteredUnpromoted.length && <EmptyState compact>No matching unpromoted patterns.</EmptyState>}
        </div>
      )}
    </div>
  );
}

export function AppMapView({ initialDomain }: { initialDomain: string }) {
  const [subView, setSubView] = useState<'files' | 'settings' | 'hidden'>('files');
  const [domain, setDomain] = useState(initialDomain);
  const [kind, setKind] = useState('all');
  const [onlyDrift, setOnlyDrift] = useState(false);
  const [query, setQuery] = useState('');
  const match = textMatcher(query);

  const filteredFiles = useMemo(
    () =>
      catalogIndex.files.filter((f) => {
        if (domain !== 'all' && f.domain !== domain) return false;
        if (kind !== 'all' && f.kind !== kind) return false;
        if (onlyDrift && f.driftCount === 0 && f.fixedColorCount === 0) return false;
        if (!query.trim()) return true;
        return match(`${f.file} ${f.domain} ${f.kind} ${f.uiImports.join(' ')} ${f.lintRules.join(' ')} ${f.modalKind ?? ''} ${f.bannerKind ?? ''}`) !== null;
      }),
    [domain, kind, onlyDrift, query, match],
  );

  const filteredSettings = useMemo(
    () =>
      catalogIndex.settings.filter((s) => {
        if (!query.trim()) return true;
        return match(`${s.id} ${s.name} ${s.path} ${s.gate} ${s.anchors.join(' ')}`) !== null;
      }),
    [query, match],
  );

  const filteredHidden = useMemo(
    () =>
      HIDDEN_STATES.filter((h) => {
        if (onlyDrift && !h.driftNote) return false;
        if (!query.trim()) return true;
        return match(`${h.area} ${h.file} ${h.trigger} ${h.reveals} ${h.availability} ${h.driftNote ?? ''}`) !== null;
      }),
    [onlyDrift, query, match],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SettingsSegmented
          label="App map mode"
          value={subView}
          onChange={setSubView}
          options={[
            { value: 'files', label: `All App Files (${catalogIndex.files.length})` },
            { value: 'settings', label: `Settings Routes (${catalogIndex.settings.length})` },
            { value: 'hidden', label: `Toggle & Hidden States (${HIDDEN_STATES.length})` },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          {subView === 'files' && (
            <>
              <Select size="sm" aria-label="Filter domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
                <option value="all">All domains ({catalogIndex.files.length})</option>
                {catalogIndex.domains.map((d) => (
                  <option key={d.name} value={d.name}>{d.name} ({d.files})</option>
                ))}
              </Select>
              <Select size="sm" aria-label="Filter surface kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="all">All surface kinds</option>
                <option value="ui-primitive">UI primitive</option>
                <option value="shared-atom">Shared atom</option>
                <option value="overlay">Modal / Overlay</option>
                <option value="banner">Banner</option>
                <option value="toast">Toast</option>
                <option value="popover-menu">Popover / Menu</option>
                <option value="list-card">List / Card</option>
                <option value="editor-chrome">Editor / Drawing</option>
                <option value="form-detail">Form / Detail</option>
                <option value="settings-pane">Settings Pane</option>
                <option value="domain-widget">Tracker / Stats / Widget</option>
                <option value="screen">Screen</option>
                <option value="hook-helper">Hook / Helper</option>
              </Select>
              <Button
                variant={onlyDrift ? 'primary' : 'secondary'}
                icon={<Warning aria-hidden="true" />}
                onClick={() => setOnlyDrift((v) => !v)}
              >
                Drift only
              </Button>
            </>
          )}
          <div className="w-64">
            <ListSearchInput value={query} onChange={setQuery} placeholder="Search file, symbol, setting..." />
          </div>
        </div>
      </div>

      {subView === 'files' && (
        <div className="space-y-2">
          <p className={SETTINGS_HELP}>
            Showing {filteredFiles.length} of {catalogIndex.files.length} app files (11 marketing pages excluded).
          </p>
          <div className="space-y-1.5">
            {filteredFiles.map((f) => (
              <details key={f.file} className="rounded-lg border border-divider bg-surface-2 px-3 py-2">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-body">
                  <code className="font-mono text-compact font-medium">{f.file}</code>
                  <Badge>{f.kind}</Badge>
                  <span className="text-meta text-pn-muted">{f.domain}</span>
                  <span className="ms-auto flex flex-wrap items-center gap-1.5">
                    {f.modalKind && (
                      <Badge tone={f.modalKind === 'hand-rolled-overlay' ? 'danger' : 'info'}>{f.modalKind}</Badge>
                    )}
                    {f.bannerKind && (
                      <Badge tone={f.bannerKind === 'hand-rolled-banner' ? 'danger' : 'success'}>{f.bannerKind}</Badge>
                    )}
                    {f.lintCount > 0 && <Badge tone="warning">{f.lintCount} lint</Badge>}
                    {f.fixedColorCount > 0 && <Badge tone="warning">{f.fixedColorCount} colors</Badge>}
                    {f.driftCount === 0 && f.fixedColorCount === 0 && <Badge tone="success">Clean</Badge>}
                  </span>
                </summary>
                <div className="mt-2.5 space-y-2 border-t border-divider pt-2.5 text-compact">
                  <div>
                    <span className="font-semibold text-pn">Canonical ui/ imports: </span>
                    <span className="text-pn-soft">{f.uiImports.length ? f.uiImports.join(', ') : 'None'}</span>
                  </div>
                  {f.directImports.length > 0 && (
                    <div>
                      <span className="font-semibold text-pn">Direct atom imports: </span>
                      <span className="text-pn-soft">{f.directImports.join(', ')}</span>
                    </div>
                  )}
                  {f.lintSamples.length > 0 && (
                    <div>
                      <span className="font-semibold text-warning">ui-lint findings: </span>
                      <span className="font-mono text-meta text-pn-soft">
                        {f.lintSamples.map((l) => `${l.rule}:L${l.line}`).join(', ')}
                        {f.lintCount > f.lintSamples.length ? ` (+${f.lintCount - f.lintSamples.length} more)` : ''}
                      </span>
                    </div>
                  )}
                  {f.fixedColors.length > 0 && (
                    <div>
                      <span className="font-semibold text-warning">Fixed Tailwind colors: </span>
                      <span className="font-mono text-meta text-pn-soft">{f.fixedColors.join(', ')}</span>
                    </div>
                  )}
                </div>
              </details>
            ))}
            {!filteredFiles.length && <EmptyState compact>No matching files.</EmptyState>}
          </div>
        </div>
      )}
      {subView === 'settings' && (
        <div className="space-y-2">
          <p className={SETTINGS_HELP}>
            Showing {filteredSettings.length} of {catalogIndex.settings.length} live settings routes from settingsSearch/registry.ts.
          </p>
          <div className="divide-y divide-divider rounded-lg border border-divider bg-surface-2">
            {filteredSettings.map((s) => (
              <div key={s.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-body font-medium">{s.path}</p>
                  <p className="text-meta font-mono text-pn-muted">{s.id} · gate: {s.gate}</p>
                </div>
                <div className="flex flex-wrap gap-1 sm:justify-end">
                  {s.anchors.length ? s.anchors.map((a) => (
                    <code key={a} className="rounded bg-surface-1 border border-divider px-1.5 py-0.5 font-mono text-meta text-pn-soft">{a}</code>
                  )) : <span className="text-meta text-pn-muted">Section / registry entry</span>}
                </div>
              </div>
            ))}
            {!filteredSettings.length && <EmptyState compact>No matching settings routes.</EmptyState>}
          </div>
        </div>
      )}
      {subView === 'hidden' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className={SETTINGS_HELP}>
              Showing {filteredHidden.length} of {HIDDEN_STATES.length} toggle-revealed, select-conditional, gated, and confirm-modal UI states across Settings and the app.
            </p>
            <Button
              variant={onlyDrift ? 'primary' : 'secondary'}
              icon={<Warning aria-hidden="true" />}
              onClick={() => setOnlyDrift((v) => !v)}
            >
              With drift only
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {filteredHidden.map((h) => (
              <div key={h.id} className="rounded-lg border border-divider bg-surface-2 p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="info">{h.triggerKind}</Badge>
                  <Badge tone={h.availability === 'demo' ? 'success' : 'neutral'}>{h.availability}</Badge>
                  <span className="ms-auto font-mono text-meta text-pn-muted">{h.file}</span>
                </div>
                <h3 className="text-body font-semibold">{h.area}</h3>
                <p className="text-compact text-pn">
                  <span className="font-semibold text-accent">Trigger:</span> {h.trigger}
                </p>
                <p className={SETTINGS_HELP}>{h.reveals}</p>
                {h.driftNote && (
                  <p className="text-meta text-warning flex items-start gap-1.5 pt-1 border-t border-divider">
                    <Warning className="shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{h.driftNote}</span>
                  </p>
                )}
              </div>
            ))}
            {!filteredHidden.length && <EmptyState compact>No matching hidden states.</EmptyState>}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentGuideView() {
  const [query, setQuery] = useState('');
  const match = textMatcher(query);
  const rows = useMemo(
    () =>
      AGENT_GUIDE.filter((r) => !query.trim() || match(`${r.need} ${r.usePart} ${r.importCode} ${r.recipe} ${r.avoidCopying}`) !== null),
    [query, match],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-heading font-semibold">Agent UI Quick-Pick Guide</h2>
          <p className={SETTINGS_HELP}>
            Search what you need to build, copy the canonical import and recipe, and never copy the drifted files listed on the right.
          </p>
        </div>
        <div className="w-72">
          <ListSearchInput value={query} onChange={setQuery} placeholder="Need a modal, banner, checkbox..." />
        </div>
      </div>

      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.need} className="rounded-lg border border-divider bg-surface-2 p-4 space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-body font-semibold flex items-center gap-2">
                  <CheckCircle className="text-success shrink-0" aria-hidden="true" />
                  <span>{r.need}</span>
                </p>
                <p className="text-compact font-medium text-accent mt-0.5">Use: {r.usePart}</p>
              </div>
              <CopyButton value={`${r.importCode}\n${r.recipe}`} label="Copy import and recipe" />
            </div>
            <div className="rounded-md bg-surface-1 border border-divider p-2.5 font-mono text-meta text-pn overflow-x-auto space-y-1">
              <div className="text-pn-muted">{r.importCode}</div>
              <div>{r.recipe}</div>
            </div>
            <p className="text-meta text-warning flex items-center gap-1.5">
              <Info className="shrink-0" aria-hidden="true" />
              <span>Do NOT copy drift in: {r.avoidCopying}</span>
            </p>
          </div>
        ))}
        {!rows.length && <EmptyState compact>No matching recipes. Propose a new part via promote-pattern.</EmptyState>}
      </div>
    </div>
  );
}
