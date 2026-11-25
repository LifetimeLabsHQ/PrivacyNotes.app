import type { ReactNode } from 'react';
import { IconUpgrade, ProMark } from '../proMark';
import { Button } from './Button';

/**
 * @catalog ProTeaserCard
 * use: a shared Pro gate or teaser card so no Pro-locked section is a dead end; `compact` renders the full-width dashed upgrade row used in Statistics tables and sub-tabs.
 * never: a non-interactive Pro notice when an upgrade path exists; a hand-drawn Pro teaser box or dashed Pro row.
 */
export function ProTeaserCard({
  children,
  actionLabel,
  onUpgrade,
  compact = false,
  className = '',
}: {
  children: ReactNode;
  actionLabel?: ReactNode;
  onUpgrade?: () => void;
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={onUpgrade}
        className={`w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-divider px-4 py-3 text-small text-pn-muted hover:text-pn hover:border-accent transition cursor-pointer${className ? ` ${className}` : ''}`}
      >
        <IconUpgrade size={14} />
        <span>{children}</span>
      </button>
    );
  }

  return (
    <div
      className={`flex flex-col items-center justify-center gap-2.5 rounded-lg border border-divider bg-surface-1 p-4 text-center${className ? ` ${className}` : ''}`}
    >
      <ProMark />
      <p className="text-small text-pn-muted max-w-sm">{children}</p>
      {onUpgrade && (
        <Button action="open" pro onClick={onUpgrade}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
