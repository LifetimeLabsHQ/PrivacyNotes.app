import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import type { Icon } from '../icons';
import { SectionEyebrow } from '../settingsUI';

/**
 * @catalog GridCard
 * use: a Home widget, in the calendar tile's look. `title` and `icon` draw the head; `link` is the accent word at its end that opens where the detail lives. `style` is its place in the grid (Dashboard packs it); the content fills the box and is clipped at its edge, so a widget sizes what it shows to the box. `controls` holds the card's arranging tools (the grip tab on its top edge, the resize corner), drawn over the content and outside its clip.
 * never: an `li` of your own with `rounded-xl border bg-surface-2` in a grid; a second card look for a grid tile; a heading of your own inside a grid card.
 */
export function GridCard({
  title,
  icon,
  link,
  controls,
  style,
  children,
  className,
  ...rest
}: {
  title?: ReactNode;
  icon?: Icon;
  link?: { label: string; onClick: () => void };
  controls?: ReactNode;
  style?: CSSProperties;
  children?: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLLIElement>, 'title' | 'children' | 'className' | 'style'>) {
  return (
    <li
      {...rest}
      style={style}
      className={`relative flex min-h-0 min-w-0 flex-col rounded-xl border border-divider bg-surface-2 p-3 ${className ?? ''}`}
    >
      {title && (
        <div className="mb-2 flex min-h-7 min-w-0 items-center gap-2">
          <SectionEyebrow icon={icon} className="min-w-0 flex-1 [&>span]:truncate">
            <span>{title}</span>
          </SectionEyebrow>
          {link && (
            <button type="button" onClick={link.onClick} className="shrink-0 text-small text-accent hover:underline">
              {link.label}
            </button>
          )}
        </div>
      )}
      <div data-card-body="" className="@container min-h-0 min-w-0 flex-1 overflow-y-clip">
        {children}
      </div>
      {controls}
    </li>
  );
}
