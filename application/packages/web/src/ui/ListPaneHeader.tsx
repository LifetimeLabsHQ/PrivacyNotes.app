import type { HTMLAttributes, ReactNode } from 'react';

/**
 * @catalog ListPaneHeader
 * use: the shared header bar for pillar list panes (`h-11 md:h-14`, matching `SelectionToolbar`), laying out `leading` and `trailing` slots or custom `children`, paired with `ListSearchRow` below it.
 * never: a list pane header or search strip with its own height, padding, or bottom border classes.
 */
export function ListPaneHeader({
  leading,
  trailing,
  children,
  className = '',
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      {...rest}
      className={`shrink-0 h-11 md:h-14 px-3 border-b border-divider flex items-center justify-between gap-2${className ? ` ${className}` : ''}`}
    >
      {children ?? (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">{leading}</div>
          {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
        </>
      )}
    </div>
  );
}

export function ListSearchRow({
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`shrink-0 px-3 py-2 border-b border-divider flex items-center gap-1.5${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
