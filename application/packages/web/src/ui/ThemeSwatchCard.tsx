import type { ReactNode } from 'react';
import { Star, UsersThree } from '../icons';
import { IconUpgrade } from '../proMark';

/**
 * @catalog ThemeSwatchCard
 * use: the three-band palette swatch card in `AppearanceSheet` and `ThemeBuilder`, supporting `compact` height, `pro` corner rocket, `quick` star indicator, `community` author mark, and hover `actions`.
 * never: a hand-drawn three-color theme swatch button with custom border or ring classes.
 */
export function ThemeSwatchCard({
  name,
  colors,
  active,
  compact = false,
  pro = false,
  proLabel,
  quick = false,
  quickLabel,
  community = false,
  communityLabel,
  onClick,
  actions,
  className = '',
}: {
  name: string;
  colors: readonly [string, string, string];
  active: boolean;
  compact?: boolean;
  pro?: boolean;
  proLabel?: string;
  quick?: boolean;
  quickLabel?: string;
  community?: boolean;
  communityLabel?: string;
  onClick: () => void;
  actions?: ReactNode;
  className?: string;
}) {
  const [c1, c2, c3] = colors;
  const card = (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`w-full min-w-0 flex flex-col items-center ${compact ? 'p-1.5 gap-1' : 'p-2 gap-1.5'} rounded-lg border transition ${
        active
          ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
          : 'border-divider bg-surface-1 hover:border-pn-muted'
      }${className ? ` ${className}` : ''}`}
    >
      <span className={`relative w-full ${compact ? 'h-6' : 'h-9'} rounded overflow-hidden flex`}>
        <span className="flex-1" style={{ backgroundColor: c1 }} />
        <span className="flex-1" style={{ backgroundColor: c2 }} />
        <span className="flex-1" style={{ backgroundColor: c3 }} />
        {pro && (
          <span
            role={proLabel ? 'img' : undefined}
            aria-label={proLabel}
            aria-hidden={proLabel ? undefined : true}
            className="absolute top-0.5 start-0.5 flex rounded bg-surface-2/90 p-0.5"
          >
            <IconUpgrade size={10} />
          </span>
        )}
        {community && (
          <span
            role={communityLabel ? 'img' : undefined}
            aria-label={communityLabel}
            aria-hidden={communityLabel ? undefined : true}
            className="absolute bottom-0.5 end-0.5 flex rounded bg-surface-2/90 p-0.5 text-pn-soft"
          >
            <UsersThree size={10} weight="bold" aria-hidden="true" />
          </span>
        )}
        {quick && (
          <span
            role={quickLabel ? 'img' : undefined}
            aria-label={quickLabel}
            aria-hidden={quickLabel ? undefined : true}
            className={`absolute bottom-0.5 ${community ? 'start-0.5' : 'end-0.5'} flex rounded bg-surface-2/90 p-0.5 text-pro`}
          >
            <Star size={10} weight="fill" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="text-meta font-medium text-pn-muted line-clamp-2 text-center break-words max-w-full" dir="auto">
        {name}
      </span>
    </button>
  );

  if (!actions) return card;

  return (
    <div className="group/card relative min-w-0">
      {card}
      {actions}
    </div>
  );
}
