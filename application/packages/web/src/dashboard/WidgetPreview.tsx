/**
 * Theme-aware miniature previews for the redesigned Add a widget gallery.
 * Uses only semantic theme tokens (bg-surface-2, bg-track, border-divider,
 * accent, success, danger, warning) and type roles, so every preview adapts
 * cleanly across Warm Cream, Note Boy, Default Dark, and custom themes.
 * Spec: docs/internal/specs/dashboard.md (section 6)
 */
import type { WidgetKind } from './dashboardLayout';

function Bar({ pct, tone = 'accent' }: { pct: number; tone?: 'accent' | 'success' | 'danger' | 'warning' }) {
  const fill = tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-accent';
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <span className={`block h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function Lines({ rows }: { rows: readonly { w: string; accent?: boolean }[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-sm ${r.accent ? 'bg-accent/70' : 'bg-pn-muted/35'}`} />
          <span className={`h-1.5 rounded-full bg-pn-muted/30 ${r.w}`} />
        </div>
      ))}
    </div>
  );
}

export function WidgetPreview({ kind }: { kind: WidgetKind }) {
  return (
    <div aria-hidden="true" className="flex h-20 w-full flex-col justify-center overflow-hidden rounded-lg border border-divider bg-track px-2.5 py-2">
      <PreviewInner kind={kind} />
    </div>
  );
}

function PreviewInner({ kind }: { kind: WidgetKind }) {
  switch (kind) {
    case 'checkIn':
      return (
        <div className="flex flex-col gap-2">
          <span className="h-1.5 w-24 rounded-full bg-pn-muted/35" />
          <div className="grid grid-cols-5 gap-1">
            {['bg-danger/60', 'bg-warning/70', 'bg-accent/65', 'bg-success/65', 'bg-success'].map((c, i) => (
              <span key={i} className={`h-5 rounded ${c}`} />
            ))}
          </div>
        </div>
      );

    case 'medication':
      return (
        <div className="flex flex-col gap-1.5">
          <Bar pct={65} tone="success" />
          <div className="flex items-center justify-between gap-2">
            <span className="h-1.5 w-20 rounded-full bg-pn-muted/40" />
            <span className="h-3.5 w-10 rounded-full bg-success/20" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="h-1.5 w-16 rounded-full bg-pn-muted/40" />
            <span className="flex gap-1">
              <span className="h-3.5 w-8 rounded-full bg-accent/25" />
              <span className="h-3.5 w-7 rounded-full bg-surface-2" />
            </span>
          </div>
        </div>
      );

    case 'quickCapture':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <span className="h-6 flex-1 rounded-md border border-divider bg-surface-2" />
            <span className="h-6 w-6 rounded-md bg-accent/20" />
            <span className="h-6 w-6 rounded-md bg-accent/80" />
          </div>
          <div className="flex gap-1">
            <span className="h-3.5 w-12 rounded-full bg-accent/20" />
            <span className="h-3.5 w-10 rounded-full bg-surface-2" />
            <span className="h-3.5 w-9 rounded-full bg-surface-2" />
          </div>
        </div>
      );

    case 'calendar':
      return (
        <div className="grid grid-cols-7 gap-1 px-1">
          {Array.from({ length: 21 }, (_, i) => (
            <span
              key={i}
              className={`h-2.5 rounded-sm ${
                i === 10 ? 'bg-accent' : i === 4 || i === 13 || i === 17 ? 'bg-success/55' : 'bg-surface-2'
              }`}
            />
          ))}
        </div>
      );

    case 'upcoming':
      return (
        <div className="flex flex-col gap-1.5">
          <span className="h-1.5 w-10 rounded-full bg-accent/55" />
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="h-1.5 w-8 rounded-full bg-pn-muted/30" />
            <span className="h-1.5 w-20 rounded-full bg-pn-muted/45" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-success" />
            <span className="h-1.5 w-8 rounded-full bg-pn-muted/30" />
            <span className="h-1.5 w-16 rounded-full bg-pn-muted/45" />
          </div>
        </div>
      );

    case 'today':
      return (
        <div className="flex flex-col gap-1.5">
          <span className="h-2 w-24 rounded-full bg-pn-muted/45" />
          <span className="h-1.5 w-full rounded-full bg-pn-muted/25" />
          <span className="h-1.5 w-4/5 rounded-full bg-pn-muted/25" />
        </div>
      );

    case 'tasks':
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-danger" />
            <span className="h-1.5 flex-1 rounded-full bg-pn-muted/45" />
            <span className="h-3 w-9 rounded-full bg-danger/20" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-accent" />
            <span className="h-1.5 flex-1 rounded-full bg-pn-muted/40" />
            <span className="h-3 w-8 rounded-full bg-accent/20" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-pn-muted/45" />
            <span className="h-1.5 w-20 rounded-full bg-pn-muted/30" />
          </div>
        </div>
      );

    case 'recent':
    case 'pinned':
    case 'tag':
    case 'folder':
    case 'onThisDay':
    case 'bookmarks':
    case 'birthdays':
      return (
        <Lines
          rows={[
            { w: 'w-28', accent: true },
            { w: 'w-24' },
            { w: 'w-20', accent: kind === 'pinned' || kind === 'birthdays' },
          ]}
        />
      );

    case 'types':
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1">
            <span className="h-3 w-9 rounded-full bg-accent/20" />
            <span className="h-3 w-11 rounded-full bg-success/20" />
          </div>
          <Lines rows={[{ w: 'w-28', accent: true }, { w: 'w-20' }]} />
        </div>
      );

    case 'note':
      return (
        <div className="flex flex-col gap-1.5 rounded border border-divider bg-surface-2 p-2">
          <span className="h-2 w-20 rounded-full bg-pn-muted/50" />
          <span className="h-1.5 w-full rounded-full bg-pn-muted/25" />
          <span className="h-1.5 w-3/4 rounded-full bg-pn-muted/25" />
        </div>
      );

    case 'files':
      return (
        <div className="grid grid-cols-3 gap-1.5">
          <span className="h-11 rounded-md bg-accent/20" />
          <span className="h-11 rounded-md bg-success/20" />
          <span className="h-11 rounded-md bg-surface-2 border border-divider" />
        </div>
      );

    case 'graph':
      return (
        <svg viewBox="0 0 180 64" className="h-full w-full">
          <g className="stroke-pn-muted/35" strokeWidth="1.5">
            <line x1="34" y1="20" x2="88" y2="34" />
            <line x1="88" y1="34" x2="146" y2="18" />
            <line x1="88" y1="34" x2="138" y2="50" />
            <line x1="88" y1="34" x2="46" y2="50" />
            <line x1="34" y1="20" x2="46" y2="50" />
          </g>
          <circle cx="88" cy="34" r="6" className="fill-accent" />
          <circle cx="34" cy="20" r="4.5" className="fill-success" />
          <circle cx="146" cy="18" r="4.5" className="fill-warning" />
          <circle cx="138" cy="50" r="4" className="fill-accent/65" />
          <circle cx="46" cy="50" r="4" className="fill-pn-muted/60" />
        </svg>
      );

    case 'places':
      return (
        <svg viewBox="0 0 180 64" className="h-full w-full">
          <path d="M0 44 Q55 32 108 48 T180 38" fill="none" className="stroke-accent/25" strokeWidth="5" />
          <path d="M24 0 L58 64 M130 0 L114 64" className="stroke-surface-2" strokeWidth="2.5" />
          <circle cx="52" cy="24" r="5" className="fill-accent" />
          <circle cx="114" cy="36" r="6.5" className="fill-warning" />
          <circle cx="148" cy="20" r="4.5" className="fill-success" />
        </svg>
      );

    case 'week':
      return (
        <div className="grid grid-cols-4 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-1 rounded bg-surface-2 p-1.5">
              <span className="h-1 w-5 rounded-full bg-pn-muted/35" />
              <span className="h-2.5 w-7 rounded bg-accent/65" />
            </div>
          ))}
        </div>
      );

    case 'streak':
    case 'checkInStreak':
      return (
        <div className="flex flex-col gap-2">
          <span className="h-4 w-12 rounded bg-accent/70" />
          <div className="flex gap-1">
            {[1, 1, 1, 0, 1, 1, 1].map((on, i) => (
              <span key={i} className={`h-2.5 w-2.5 rounded-full ${on ? 'bg-success' : 'bg-surface-2'}`} />
            ))}
          </div>
        </div>
      );

    case 'rhythm':
      return (
        <div className="grid grid-cols-12 gap-1">
          {[1, 2, 0, 3, 2, 1, 0, 2, 3, 1, 2, 3, 0, 1, 2, 2, 3, 1, 2, 0, 1, 3, 2, 1, 2, 3, 1, 0, 2, 1, 3, 2, 1, 2, 0, 2].map((lvl, i) => (
            <span
              key={i}
              className={`h-2.5 rounded-sm ${
                lvl === 0 ? 'bg-surface-2' : lvl === 1 ? 'bg-success/30' : lvl === 2 ? 'bg-success/60' : 'bg-success'
              }`}
            />
          ))}
        </div>
      );

    case 'yearPixels':
      return (
        <div className="grid grid-cols-12 gap-1">
          {['bg-success', 'bg-success/65', 'bg-accent/75', 'bg-warning/75', 'bg-success', 'bg-danger/65', 'bg-success/75', 'bg-accent/60', 'bg-success', 'bg-warning/70', 'bg-success/65', 'bg-success',
            'bg-success/65', 'bg-accent/70', 'bg-success', 'bg-success', 'bg-warning/70', 'bg-success/65', 'bg-accent/75', 'bg-danger/60', 'bg-success/75', 'bg-success', 'bg-surface-2', 'bg-surface-2',
            'bg-warning/70', 'bg-success', 'bg-success/75', 'bg-accent/75', 'bg-success', 'bg-success/65', 'bg-warning/75', 'bg-success', 'bg-accent/65', 'bg-surface-2', 'bg-surface-2', 'bg-surface-2'].map((c, i) => (
            <span key={i} className={`h-2.5 rounded-sm ${c}`} />
          ))}
        </div>
      );

    case 'patterns':
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2"><span className="h-1.5 w-12 rounded-full bg-pn-muted/40" /><Bar pct={82} tone="success" /></div>
          <div className="flex items-center gap-2"><span className="h-1.5 w-12 rounded-full bg-pn-muted/40" /><Bar pct={58} tone="success" /></div>
          <div className="flex items-center gap-2"><span className="h-1.5 w-12 rounded-full bg-pn-muted/40" /><Bar pct={44} tone="danger" /></div>
        </div>
      );

    case 'milestone':
      return (
        <div className="flex flex-col gap-2">
          <span className="h-2.5 w-20 rounded bg-pn-muted/45" />
          <Bar pct={72} tone="accent" />
        </div>
      );

    case 'tracker':
      return (
        <div className="flex items-end gap-3">
          <span className="h-5 w-10 rounded bg-accent/75" />
          <div className="flex flex-1 items-end gap-1">
            {[40, 75, 55, 90, 65, 85, 70].map((h, i) => (
              <span key={i} className="flex-1 rounded-t-sm bg-accent/55" style={{ height: `${Math.round(h * 0.4)}px` }} />
            ))}
          </div>
        </div>
      );

    case 'counter':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="h-5 w-12 rounded bg-accent/75" />
            <div className="flex gap-1">
              <span className="h-5 w-5 rounded border border-divider bg-surface-2" />
              <span className="h-5 w-5 rounded bg-accent" />
            </div>
          </div>
          <Bar pct={62} tone="accent" />
        </div>
      );

    case 'weekRecap':
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="h-3.5 w-10 rounded-full bg-success/25" />
            <span className="h-3.5 w-12 rounded-full bg-accent/20" />
          </div>
          <span className="h-1.5 w-full rounded-full bg-pn-muted/30" />
          <span className="h-1.5 w-4/5 rounded-full bg-pn-muted/25" />
        </div>
      );

    case 'storage':
      return (
        <div className="flex items-center gap-3 px-1">
          <svg viewBox="0 0 40 40" className="h-10 w-10 shrink-0">
            <circle cx="20" cy="20" r="15" fill="none" strokeWidth="5" className="stroke-surface-2" />
            <circle cx="20" cy="20" r="15" fill="none" strokeWidth="5" strokeDasharray="94" strokeDashoffset="58" strokeLinecap="round" transform="rotate(-90 20 20)" className="stroke-accent" />
          </svg>
          <div className="flex flex-1 flex-col gap-1.5">
            <span className="h-2 w-20 rounded-full bg-pn-muted/45" />
            <span className="h-1.5 w-16 rounded-full bg-pn-muted/25" />
          </div>
        </div>
      );
  }
}
