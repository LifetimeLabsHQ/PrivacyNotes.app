import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { textMatcher } from './textMatch';

export interface TagSuggestionMenuProps {
  /** Existing matching tags as `[tag, count]` pairs. */
  suggestions: [string, number][];
  /** The normalized query being typed (without leading `#`), used for match
   *  bolding and the "+ Create" row. */
  query: string;
  /** Whether to show the "+ Create \"#...\"" row below the matches. */
  showCreate: boolean;
  /** Currently keyboard-highlighted row index (`-1` when none). */
  highlightIndex: number;
  /** Called when an existing tag row is chosen. */
  onSelect: (tag: string) => void;
  /** Called when the "+ Create" row is chosen. */
  onCreate: () => void;
  /** Optional hover callback so pointer hover moves the active highlight. */
  onHover?: (index: number) => void;
  /** Touch-friendly taller rows on mobile. */
  isMobile?: boolean;
  /** Extra classes on the outer surface (e.g. `fixed` for portal positioning). */
  className?: string;
  /** Inline positioning styles (used by TagInput's portal). */
  style?: CSSProperties;
}

/**
 * Shared tag autocomplete menu used by both the top tag bar (`TagInput.tsx`)
 * and the in-editor `#` caret popup (`InlineTagSuggestion.tsx`). One look, one
 * set of rows: `# name  count` with bold match prefix, and `+ Create "#..."`.
 */
export function TagSuggestionMenu({
  suggestions,
  query,
  showCreate,
  highlightIndex,
  onSelect,
  onCreate,
  onHover,
  isMobile = false,
  className = '',
  style,
}: TagSuggestionMenuProps) {
  const { t } = useTranslation('common');
  const cleanQuery = query.replace(/^#/, '');
  const prefixMatch = cleanQuery ? textMatcher(cleanQuery) : null;

  function boldMatch(tag: string) {
    if (!prefixMatch) return tag;
    const match = prefixMatch(tag);
    if (!match) return tag;
    return (
      <>
        {tag.slice(0, match.start)}
        <span className="font-semibold">{tag.slice(match.start, match.end)}</span>
        {tag.slice(match.end)}
      </>
    );
  }

  return (
    <div
      className={`bg-surface-2 border border-divider rounded-lg overflow-hidden shadow-lg ${className}`.trim()}
      style={{ minWidth: 160, maxWidth: 260, ...style }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {suggestions.map(([tag, count], i) => (
        <button
          key={tag}
          type="button"
          data-selected={i === highlightIndex ? 'true' : undefined}
          onClick={() => onSelect(tag)}
          onMouseEnter={onHover ? () => onHover(i) : undefined}
          className={`w-full flex items-center gap-2 px-3 text-body cursor-pointer transition-colors ${
            i === highlightIndex
              ? 'bg-track'
              : 'hover:bg-pn/5'
          } ${isMobile ? 'min-h-[44px] py-2.5' : 'py-2'}`}
        >
          <span className="text-pn-muted text-small">#</span>
          <span className="text-pn truncate">{boldMatch(tag)}</span>
          <span className="ms-auto text-small text-pn-muted tabular-nums shrink-0">
            {count}
          </span>
        </button>
      ))}
      {showCreate && (
        <>
          {suggestions.length > 0 && (
            <div className="border-t border-divider" />
          )}
          <button
            type="button"
            data-selected={highlightIndex === suggestions.length ? 'true' : undefined}
            onClick={onCreate}
            onMouseEnter={onHover ? () => onHover(suggestions.length) : undefined}
            className={`w-full flex items-center gap-2 px-3 text-body cursor-pointer transition-colors text-pn-muted ${
              highlightIndex === suggestions.length
                ? 'bg-track'
                : 'hover:bg-pn/5'
            } ${isMobile ? 'min-h-[44px] py-2.5' : 'py-2'}`}
          >
            <span className="text-small">+</span>
            <span className="truncate">{t('tagInput.create', { tag: cleanQuery })}</span>
          </button>
        </>
      )}
    </div>
  );
}
