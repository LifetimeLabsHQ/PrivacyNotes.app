import { useTranslation } from 'react-i18next';
import type { CalloutType, CalloutTypeDef } from './calloutTypes';

/**
 * The grid of callout types: three columns, the icon over the name. The
 * toolbar's callout panel and the `[!` menu (CalloutSuggestion.tsx) both draw
 * it, so a callout is picked from the same grid however the picker opens.
 * `selected` is the keyboard cell of the `[!` menu; the toolbar has none.
 */
export function CalloutGrid({ types, selected, onPick, onHover }: {
  types: readonly CalloutTypeDef[];
  selected?: number;
  onPick: (type: CalloutType) => void;
  onHover?: (index: number) => void;
}) {
  const { t } = useTranslation('editor');
  return (
    <div className="grid grid-cols-3 gap-1">
      {types.map((c, index) => {
        const CalloutIcon = c.icon;
        const isSelected = index === selected;
        return (
          <button
            key={c.type}
            type="button"
            data-selected={isSelected || undefined}
            onPointerDown={(e) => {
              e.preventDefault();
              onPick(c.type);
            }}
            onMouseEnter={onHover ? () => onHover(index) : undefined}
            className={`relative flex flex-col items-center gap-1 rounded-md px-1 py-2 text-pn-soft transition ${
              isSelected ? 'bg-accent/10 dark:bg-accent/20' : '[@media(hover:hover)]:hover:bg-pn/5'
            }`}
          >
            <CalloutIcon weight="bold" color={c.color || undefined} />
            <span className="max-w-full text-center text-meta leading-tight hyphens-auto break-words">{t(`callout.types.${c.type}`)}</span>
          </button>
        );
      })}
    </div>
  );
}
