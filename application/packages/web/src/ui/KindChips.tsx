import type { Icon } from '../icons';
import { activeLocale } from '../languages';
import { ExpandLabel } from './ExpandLabel';

/** One cell: the filter it sets, its name, the glyph the list's rows wear for it (none for All), and its count. */
export type KindChip<K extends string> = {
  key: K;
  label: string;
  Icon: Icon | null;
  count?: number;
};

/**
 * @catalog KindChips
 * use: the kind filter bar above a list (Vault kinds, Files types): one non-scrolling row where each cell shows its glyph and count and expands its label on hover; zero-count kinds hide unless active.
 * never: a horizontal-scrolling kind bar; a hand-drawn row of type filter pills.
 */
/**
 * The kind bar above a list (the Vault's kinds, the Files types): one row of
 * cells that share the pane's width, so it never scrolls and never wraps; a
 * hovered cell grows to fit its name and the others give up their spare room.
 * Each cell is its glyph and its count; the name slides open on hover, the
 * way the sidebar footer names its actions (`ExpandLabel`), and the glyph
 * fills. All has no glyph and always shows its name. A kind with no items
 * is left out, unless it is the filter in force, and a bar left with All
 * alone is not drawn. In a bar under 250px the other cells drop their count
 * (it stays in the `aria-label`). On a touch screen the
 * cells are glyphs and counts, named by `aria-label` ("Logins, 97").
 * `aria-pressed` marks the filter in force.
 * Spec: docs/internal/design/ui-patterns.md section 190
 */
export function KindChips<K extends string>({ kinds, value, onChange, tabIndex }: {
  kinds: readonly KindChip<K>[];
  value: K;
  onChange: (key: K) => void;
  tabIndex?: number;
}) {
  const shown = kinds.filter((k) => k.Icon === null || k.count !== 0 || k.key === value);
  // All alone filters nothing, so the bar goes away.
  if (shown.length < 2) return null;
  return (
    <div className="shrink-0 px-3 pt-2 pb-1 @container">
      <div className="flex gap-0.5 overflow-hidden rounded-lg bg-surface-1 p-0.5" data-kind-chips="">
        {shown.map((k) => {
          const on = value === k.key;
          return (
            <button
              key={k.key}
              type="button"
              onClick={() => onChange(k.key)}
              aria-pressed={on}
              aria-label={k.count == null ? k.label : new Intl.ListFormat(activeLocale(), { style: 'short', type: 'unit' }).format([k.label, String(k.count)])}
              tabIndex={tabIndex}
              className={`group flex-auto min-w-0 overflow-hidden hover:min-w-fit inline-flex items-center justify-center gap-1 h-7 px-1 rounded-md text-small font-medium whitespace-nowrap transition ${
                on ? 'bg-accent-fill text-white' : 'text-pn-muted hover:text-accent hover:bg-pn/5'
              }`}
            >
              {k.Icon ? (
                <>
                  <span className="inline-flex shrink-0">
                    <k.Icon aria-hidden="true" weight={on ? 'fill' : undefined} className={on ? undefined : 'group-hover:hidden'} />
                    {!on && <k.Icon aria-hidden="true" weight="fill" className="hidden group-hover:inline-flex" />}
                  </span>
                  <ExpandLabel>{k.label}</ExpandLabel>
                </>
              ) : (
                <span>{k.label}</span>
              )}
              {/* A bar too narrow for every count keeps it on All and on the filter in force. */}
              {k.count != null && (
                <span className={`tabular-nums opacity-80${on || k.Icon === null ? '' : ' hidden @min-[250px]:inline'}`}>{k.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
