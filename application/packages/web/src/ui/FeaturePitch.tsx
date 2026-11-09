import type { ReactNode } from 'react';

/**
 * @catalog FeaturePitch
 * use: the pitch of a feature someone has not set up yet, in its empty state or its explainer: a toned banner (icon, title, subtitle, a badge such as Free or the Pro mark), one centred intro line, feature chips, three use-case tiles (optional: leave them out when richer examples follow), a strip of two facts, and a last row with a tagline and optional actions. The Markdown folder and Settings > CLI use it; each passes its own words.
 * never: a banner, chip row, use-case grid or fact strip of your own for a feature pitch; fixed amber, red or green colors in a pitch.
 */

export interface PitchItem {
  icon: ReactNode;
  label: string;
}

export interface PitchFact {
  /** The icon carries its own tone class (`text-success`, `text-danger`). */
  icon: ReactNode;
  title: string;
  sub: string;
}

// `amber` is the Markdown folder's banner as it was drawn before this part
// existed (owner, 2026-11-09: its look stays); the theme's warning token runs
// to orange-red in the light themes, so it cannot stand in.
const BANNER = {
  amber: {
    box: 'border-amber-400/40 bg-amber-50 dark:border-amber-600/30 dark:bg-amber-950/20',
    icon: 'text-warning',
    title: 'text-amber-900 dark:text-amber-300',
    sub: 'text-amber-700 dark:text-amber-400/80',
  },
  info: { box: 'border-accent/30 bg-accent/10', icon: 'text-accent', title: 'text-accent', sub: 'text-accent opacity-90' },
} as const;

/** The round label at the end of an amber banner ("Free"). */
export function PitchBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-amber-200 px-2 py-0.5 text-meta font-semibold uppercase tracking-wide text-amber-900 dark:bg-amber-800 dark:text-amber-100">
      {children}
    </span>
  );
}

export function FeaturePitch({ banner, intro, chips, uses, facts, tagline, actions, footer }: {
  banner: { tone: keyof typeof BANNER; icon: ReactNode; title: string; sub: string; badge?: ReactNode };
  intro: ReactNode;
  chips: readonly PitchItem[];
  /** Three short use tiles; leave them out when richer examples follow the pitch. */
  uses?: readonly PitchItem[];
  facts: readonly [PitchFact, PitchFact];
  tagline: PitchItem;
  /** Rides the tagline row; without it the tagline is centred. */
  actions?: ReactNode;
  /** A row under the pitch that does something rather than describes it. */
  footer?: ReactNode;
}) {
  const tone = BANNER[banner.tone];
  return (
    <>
      <div className={`flex items-center gap-2.5 rounded-md border px-3 py-2.5 mb-3 ${tone.box}`}>
        <span className={`shrink-0 ${tone.icon}`}>{banner.icon}</span>
        <div className="flex-1 min-w-0">
          <p className={`text-compact font-semibold leading-snug ${tone.title}`}>{banner.title}</p>
          <p className={`text-small leading-snug ${tone.sub}`}>{banner.sub}</p>
        </div>
        {banner.badge}
      </div>

      <p className="text-small text-pn-muted text-center mb-3">{intro}</p>

      <div className="flex flex-wrap justify-center gap-1.5 mb-4">
        {chips.map(({ icon, label }) => (
          <span key={label} className="inline-flex items-center gap-1.5 rounded-full border border-divider px-2.5 py-1 text-small text-pn-soft">
            <span className="text-pn-muted">{icon}</span>
            {label}
          </span>
        ))}
      </div>

      {uses && <div className="grid grid-cols-3 gap-2 mb-3">
        {uses.map(({ icon, label }) => (
          <div key={label} className="rounded-md bg-surface-1 px-2 py-2.5 text-center">
            <span className="flex justify-center text-pn-muted">{icon}</span>
            <p className="mt-1.5 text-meta leading-snug text-pn-soft">{label}</p>
          </div>
        ))}
      </div>}

      <div className="flex items-stretch gap-3 rounded-md border border-divider bg-surface-1 px-3 py-2.5 mb-4">
        {facts.map((f, i) => (
          <div key={f.title} className={`flex flex-1 items-center gap-2 ${i ? 'border-s border-divider ps-3' : ''}`}>
            <span className="shrink-0">{f.icon}</span>
            <div className="min-w-0">
              <p className="text-small font-medium text-pn leading-snug">{f.title}</p>
              <p className="text-meta text-pn-muted leading-snug">{f.sub}</p>
            </div>
          </div>
        ))}
      </div>

      <div className={`flex items-center gap-2 ${actions ? '' : 'justify-center'}`}>
        <span className="shrink-0 text-pn-muted">{tagline.icon}</span>
        <p className={`min-w-0 text-small text-pn-muted leading-snug ${actions ? 'flex-1' : 'text-center'}`}>{tagline.label}</p>
        {actions}
      </div>

      {footer}
    </>
  );
}
