import type { HTMLAttributes } from 'react';

/**
 * @catalog CanvasControlBar
 * use: the floating translucent control bar over Graph and Map canvases, horizontal or vertical, paired with `CanvasControlDivider` between groups.
 * never: a hand-styled floating toolbar shell over a graph or map canvas.
 */
export function CanvasControlBar({
  orientation = 'horizontal',
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  orientation?: 'horizontal' | 'vertical';
}) {
  return (
    <div
      {...rest}
      className={`inline-flex ${orientation === 'vertical' ? 'flex-col' : 'flex-row items-center'} gap-0.5 rounded-lg border border-divider bg-surface-2/90 p-1 shadow-sm backdrop-blur-sm${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}

export function CanvasControlDivider({
  orientation = 'horizontal',
  className = '',
}: {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  const verticalBar = orientation === 'vertical';
  return (
    <div
      role="separator"
      aria-orientation={verticalBar ? 'horizontal' : 'vertical'}
      className={`shrink-0 bg-divider ${verticalBar ? 'h-px w-5 my-0.5' : 'w-px h-4 mx-0.5'}${className ? ` ${className}` : ''}`}
    />
  );
}
