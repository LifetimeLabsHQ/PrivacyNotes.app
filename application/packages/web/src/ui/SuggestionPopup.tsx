import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

/**
 * @catalog SuggestionPopup
 * use: the floating menu shell for editor suggestion popups (slash commands, note-links, mentions), paired with `SuggestionItem` rows for keyboard and pointer selection without stealing editor focus.
 * never: a hand-styled floating suggestion menu or row with custom highlight or text classes.
 */
export const SuggestionPopup = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function SuggestionPopup({ className = '', children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        {...rest}
        className={`rounded-lg border border-divider bg-surface-2 py-1 shadow-lg max-h-64 overflow-y-auto text-pn${className ? ` ${className}` : ''}`}
      >
        {children}
      </div>
    );
  },
);

export function SuggestionItem({
  active,
  icon,
  label,
  hint,
  shortcut,
  onSelect,
  onMouseEnter,
  style,
  className = '',
}: {
  active: boolean;
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  shortcut?: ReactNode;
  onSelect: () => void;
  onMouseEnter?: () => void;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-selected={active}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-body text-start transition ${
        active ? 'bg-accent/10 text-accent-strong dark:bg-accent/20' : 'text-pn hover:bg-pn/5'
      }${className ? ` ${className}` : ''}`}
    >
      {icon && (
        <span className="shrink-0 text-accent" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">
        {label}
        {hint && <span className="ms-1.5 text-small text-pn-muted">{hint}</span>}
      </span>
      {shortcut && <span className="shrink-0 text-meta text-pn-muted">{shortcut}</span>}
    </button>
  );
}
