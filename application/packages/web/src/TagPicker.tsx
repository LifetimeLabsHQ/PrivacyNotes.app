import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeTag } from './notesRepo';
import { isSoftKeyboardDevice } from './softKeyboard';
import { textMatcher } from './textMatch';
import { isImeComposing } from './imeComposing';
import { Plus } from './icons';
import { TagMark } from './looks/LookGlyph';
import { PickerModal } from './ui';

/**
 * Pick a tag for one item or for a selection: filter the existing tags,
 * or type a new one and create it.
 *
 * It is the same centred window the folder picker uses, and deliberately
 * so. The two sit next to each other in the note menu and do the same job
 * (search a list, take one, or make a new one), so one shape serves both.
 * It was an anchored popover once, which meant the window's position had
 * to be solved against whatever opened it, and a trigger far from the
 * right edge threw it backwards across the pane.
 * Spec: docs/internal/design/ui-patterns.md
 */
export function TagPicker({
  allTags,
  onSelect,
  onClose,
}: {
  allTags: [string, number][];
  onSelect: (tag: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('shell');
  const [filter, setFilter] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isSoftKeyboardDevice()) searchRef.current?.focus({ preventScroll: true });
  }, []);

  const sortedTags = useMemo(() => [...allTags].sort((a, b) => a[0].localeCompare(b[0])), [allTags]);
  const needle = filter.replace(/^#/, '').trim();
  const filtered = useMemo(() => {
    if (!needle) return sortedTags;
    const match = textMatcher(needle);
    return sortedTags.filter(([tag]) => match(tag));
  }, [sortedTags, needle]);

  // The create row appears when what was typed is not already a tag.
  const normalizedFilter = normalizeTag(filter);
  const showCreate =
    normalizedFilter &&
    !allTags.some(([tag]) => tag.toLowerCase() === normalizedFilter.toLowerCase());

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || isImeComposing(e)) return;
    e.preventDefault();
    const raw = e.currentTarget.value;
    const curNormalized = normalizeTag(raw);
    const curShowCreate =
      curNormalized &&
      !allTags.some(([tag]) => tag.toLowerCase() === curNormalized.toLowerCase());
    if (curShowCreate) {
      onSelect(curNormalized);
      return;
    }
    const curNeedle = raw.replace(/^#/, '').trim();
    const curMatch = curNeedle ? textMatcher(curNeedle) : null;
    const curFiltered = curMatch ? sortedTags.filter(([tag]) => curMatch(tag)) : sortedTags;
    if (curFiltered.length === 1 && curFiltered[0]) onSelect(curFiltered[0][0]);
  }

  return (
    <PickerModal
      title={t('selectionToolbar.tag')}
      onClose={onClose}
      maxWidth="max-w-sm"
      maxHeight="max-h-[70vh]"
      search={{
        value: filter,
        onChange: setFilter,
        placeholder: t('selectionToolbar.addTagPlaceholder'),
        onKeyDown: handleKeyDown,
        inputRef: searchRef,
      }}
    >
      {filtered.map(([tag, count]) => (
        <button
          key={tag}
          type="button"
          onClick={() => onSelect(tag)}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-body cursor-pointer hover:bg-pn/5 transition min-h-[36px]"
        >
          <span className="text-pn-muted text-small shrink-0 inline-flex">
            <TagMark tag={tag} size={16} />
          </span>
          <span className="truncate text-start">{tag}</span>
          <span className="ms-auto shrink-0 text-small text-pn-muted tabular-nums">{count}</span>
        </button>
      ))}

      {filtered.length === 0 && !showCreate && (
        <div className="px-2.5 py-2 text-body text-pn-muted">
          {t('selectionToolbar.noTagsFound')}
        </div>
      )}

      {showCreate && (
        <button
          type="button"
          onClick={() => onSelect(normalizedFilter)}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-body cursor-pointer hover:bg-pn/5 transition text-pn-muted min-h-[36px]"
        >
          <Plus size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate text-start">{t('selectionToolbar.createTag', { tag: normalizedFilter })}</span>
        </button>
      )}
    </PickerModal>
  );
}
