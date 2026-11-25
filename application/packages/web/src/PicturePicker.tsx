/**
 * Pick a picture that is already in Files and show it in the note (issue
 * #330). Nothing is uploaded or copied: the note points at the stored file,
 * so the picture costs no extra storage however many notes show it.
 *
 * The list is the Files pillar's pictures, newest note first, one entry per
 * stored file, and never a picture from a PIN-protected note that is still
 * locked (NotesView builds it).
 *
 * Spec: docs/internal/design/ui-patterns.md (section 107, the file card and the picker)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { LazyPicture } from './LazyPicture';
import { isSoftKeyboardDevice } from './softKeyboard';
import { textMatcher } from './textMatch';
import type { MediaRef } from './mediaRefs';
import { PickerModal } from './ui';

export function PicturePicker({ items, onPick, onClose }: {
  items: MediaRef[];
  onPick: (ref: MediaRef) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('media');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Straight into the search box where a keyboard is already out; a phone
  // would otherwise raise its keyboard over the pictures on open.
  useEffect(() => {
    if (!isSoftKeyboardDevice()) searchRef.current?.focus({ preventScroll: true });
  }, []);

  const shown = useMemo(() => {
    const q = query.trim();
    if (!q) return items;
    const match = textMatcher(q);
    return items.filter((it) => match(it.name));
  }, [items, query]);

  return createPortal(
    <PickerModal
      title={t('picker.title')}
      onClose={onClose}
      maxWidth="max-w-lg"
      maxHeight="max-h-[calc(100dvh-2rem)]"
      bodyClassName={`flex-1 min-h-0 overflow-y-auto px-5 pb-3${items.length === 0 ? ' pt-3' : ''}`}
      search={
        items.length > 0
          ? { value: query, onChange: setQuery, placeholder: t('picker.search'), inputRef: searchRef }
          : undefined
      }
      footer={
        items.length > 0 ? (
          <p className="w-full text-small text-pn-muted">{t('picker.noCopy')}</p>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <p className="py-10 text-body text-center text-pn-muted">{t('picker.empty')}</p>
      ) : shown.length === 0 ? (
        <p className="py-10 text-body text-center text-pn-muted">{t('picker.noMatch')}</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {shown.map((it) => (
            <button
              key={it.src}
              type="button"
              onClick={() => onPick(it)}
              aria-label={it.name}
              className="relative block aspect-square rounded-lg overflow-hidden border border-divider hover:border-accent focus-visible:outline-2 focus-visible:outline-accent transition"
            >
              <LazyPicture src={it.src} />
              <span
                className="absolute inset-x-0 bottom-0 block px-1.5 pb-1 pt-4 bg-gradient-to-t from-black/80 to-transparent text-meta text-white text-start truncate"
                dir="auto"
              >
                {it.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </PickerModal>,
    document.body,
  );
}
