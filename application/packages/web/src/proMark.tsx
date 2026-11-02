import type { ReactNode } from 'react';
import { RocketLaunch } from './icons';

/* ────────────────────────────────────────────────────────────────
 * Icons
 * The shared upgrade icon is a simple rocket - reads as "ascend",
 * works at 16px in a button or 28px in a header.
 * ──────────────────────────────────────────────────────────────── */

export function IconUpgrade({ size = 18, onFill = false }: { size?: number; onFill?: boolean }) {
  // The rocket is the Pro mark and must read as "upgrade" whatever text
  // it sits next to, so its colour comes from the theme's own `--pn-pro`
  // token and NEVER from the surrounding text: `text-pro` is a fixed
  // per-theme value, not `currentColor`. Bronze on every LIGHT theme and
  // gold on every DARK one - the token is keyed to mode, because gold is
  // a light colour and measured 1.63:1 on plain white.
  //
  // The one exception is `onFill`: on a solid button or a hovered menu band
  // no Pro colour carries against the fill, so the rocket is white like the
  // button's own text.
  //
  // FILLED, not outline. A hairline of a light colour has almost no ink
  // in it at 11px; the solid body is what makes the mark legible.
  // Spec: docs/internal/design-decisions.md (Pro mark colour)
  return <RocketLaunch size={size} weight="fill" className={onFill ? 'text-white' : 'text-pro'} aria-hidden="true" data-type-exempt="" />;
}

/** An icon-only Pro door's glyph with the rocket on its top-end corner (the
 *  collapsed rail's Folders button, the Work icon of the space switch). The
 *  rocket is anchored to the glyph, not the button, so it sits on the icon's
 *  own corner at every button size, and the glyph never moves. */
export function ProGlyph({ pro, children }: { pro: boolean; children: ReactNode }) {
  if (!pro) return <>{children}</>;
  return (
    <span className="relative flex">
      {children}
      <span className="pointer-events-none absolute -top-1.5 -end-1.5 flex" aria-hidden="true">
        <IconUpgrade size={9} />
      </span>
    </span>
  );
}

/** The rocket and the word, at the end of a menu row that opens a Pro
 *  feature: the mark `ContextMenu` draws for an item with `pro`. It keys off
 *  `!isPro`, never `proUnlocked`, so the demo still labels what it unlocks. */
export function ProMark() {
  return (
    <span className="shrink-0 inline-flex items-center gap-1 text-meta font-semibold normal-case tracking-normal text-accent">
      <IconUpgrade size={12} /> Pro
    </span>
  );
}
