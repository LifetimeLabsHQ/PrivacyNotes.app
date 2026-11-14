import { useId, type ReactNode } from 'react';
import { Check, Minus, Warning } from '../icons';
import { SETTINGS_HELP } from '../settingsUI';
import { Badge } from './feedback';

/** How a row of a tile reads against the same row of the other tiles. */
type CompareMark = 'yes' | 'no' | 'meh';

export type CompareTile<K extends string> = {
  value: K;
  title: string;
  badge?: { label: string; tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral' };
  /** One entry per row, in the same order in every tile: the subgrid keeps
   *  row N level across tiles, so a row that wraps in one tile moves the
   *  next row down in all of them. */
  rows: { label: string; mark?: CompareMark; text: string }[];
};

/**
 * @catalog CompareTiles
 * use: one choice between two or three options that compares them row by row (PIN or passcode, 12 or 24 words): a tile per option with its title and a Badge, then the same labeled rows in every tile, each with a check, a minus or a warning. Native radios, so arrow keys move the choice: when acting on it costs something, a selection only stages it and `footer` draws the strip under the tiles with what it costs and the one button that acts. Where nothing is committed yet (a new phrase in onboarding), a selection may act at once.
 * never: choice cards of your own with a hand-drawn radio dot; a tile whose selection starts work that costs something (arrow keys fire it); rows that differ in order between tiles; an action button of its own beside the tiles.
 * Spec: docs/internal/design/patterns/171-180.md (section 180)
 */
export function CompareTiles<K extends string>({
  label,
  value,
  tiles,
  onChange,
  disabled = false,
  footer,
}: {
  /** The group's name for screen readers. */
  label: string;
  value: K;
  tiles: CompareTile<K>[];
  onChange: (value: K) => void;
  disabled?: boolean;
  /** The strip under the tiles while a staged choice waits: what acting on
   *  it costs, and the one button that acts. */
  footer?: { note: ReactNode; button: ReactNode };
}) {
  const name = useId();
  // The header row plus the longest row list: every tile spans as many rows.
  const span = 1 + Math.max(0, ...tiles.map((tile) => tile.rows.length));
  return (
    <div className="@container">
      <div role="radiogroup" aria-label={label} className="grid grid-cols-1 @lg:grid-cols-2 gap-2.5">
        {tiles.map((tile) => {
          const on = value === tile.value;
          return (
            <label
              key={tile.value}
              style={{ gridRow: `span ${span} / span ${span}` }}
              className={`relative grid grid-rows-subgrid gap-y-2.5 rounded-lg border bg-surface-1 px-3.5 py-3 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
                on ? 'border-accent ring-1 ring-accent' : 'border-divider hover:border-pn-soft'
              } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <input
                type="radio"
                name={name}
                value={tile.value}
                checked={on}
                disabled={disabled}
                onChange={() => onChange(tile.value)}
                className="sr-only"
              />
              <span className="flex items-center justify-between gap-2 mb-0.5">
                <span className="flex items-center gap-2 text-body font-medium text-pn">
                  <span
                    aria-hidden="true"
                    className={`grid place-items-center size-4 rounded-full border ${on ? 'border-accent' : 'border-pn-soft'}`}
                  >
                    {on && <span className="size-2 rounded-full bg-accent-fill" />}
                  </span>
                  {tile.title}
                </span>
                {tile.badge && <Badge tone={tile.badge.tone ?? 'info'}>{tile.badge.label}</Badge>}
              </span>
              {tile.rows.map((row) => (
                <span key={row.label} className="block">
                  <span className="block text-meta text-pn-soft">{row.label}</span>
                  <span className="flex items-start gap-1.5 text-small leading-relaxed text-pn">
                    {row.mark === 'yes' && <Check aria-hidden="true" className="shrink-0 mt-0.5 text-success" />}
                    {row.mark === 'no' && <Warning aria-hidden="true" className="shrink-0 mt-0.5 text-warning" />}
                    {row.mark === 'meh' && <Minus aria-hidden="true" className="shrink-0 mt-0.5 text-pn-soft" />}
                    <span>{row.text}</span>
                  </span>
                </span>
              ))}
            </label>
          );
        })}
      </div>
      {footer && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-divider bg-surface-1 px-3.5 py-2.5">
          <p className={`${SETTINGS_HELP} leading-relaxed min-w-0 flex-1 basis-56`}>{footer.note}</p>
          <div className="shrink-0">{footer.button}</div>
        </div>
      )}
    </div>
  );
}
