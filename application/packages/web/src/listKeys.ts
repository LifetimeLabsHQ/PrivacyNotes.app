import { useEffect, useRef, type RefObject } from 'react';
import { isImeComposing } from './imeComposing';

const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !isImeComposing(e);

/**
 * The keyboard way from the list search into the list and back (GitHub #395
 * thread). Down in the search field moves the focus to the first row and
 * opens it. On a row, Up and Down open the row above or below, Enter moves
 * into the open item, and Escape goes back to the search field with the
 * query kept.
 *
 * A row is any direct child of the list with `data-item-id`. A row takes
 * the focus only while it is the keyboard's place, so a click never leaves
 * a focus ring behind. `canOpen` is false in multi-select, where a click on
 * a row picks it instead of opening it.
 *
 * A row that has the keyboard and then leaves the list (moved to the trash)
 * hands the focus to the row now in its place, so the arrows keep working.
 *
 * Spec: docs/internal/specs/keyboard-shortcuts.md (section 6)
 */
export function useListKeys(
  inputRef: RefObject<HTMLInputElement | null>,
  listRef: RefObject<HTMLElement | null>,
  canOpen: () => boolean,
) {
  /** The row the keyboard is on, kept while a window or a menu over it has the focus. */
  const held = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => {
    const input = inputRef.current;
    const list = listRef.current;
    if (!input || !list) return;
    const rows = () => Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-item-id]'));
    const now = rows();
    const gone = held.current;
    if (gone && document.activeElement === document.body && !now.some((el) => el.dataset.itemId === gone.id)) {
      const next = now[Math.min(gone.index, now.length - 1)];
      held.current = null;
      if (next) {
        next.tabIndex = -1;
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: 'nearest' });
      }
    }
    function onFocusIn(e: FocusEvent) {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-item-id]');
      if (row?.parentElement === list) held.current = { id: row.dataset.itemId!, index: rows().indexOf(row) };
    }
    function onFocusOut(e: FocusEvent) {
      const to = e.relatedTarget as HTMLElement | null;
      if (to && !list!.contains(to) && !to.closest('[role="dialog"], [role="menu"]')) held.current = null;
    }
    const go = (row: HTMLElement | undefined) => {
      if (!row) return;
      row.tabIndex = -1;
      row.focus();
      // Focusing a window placeholder mounts the real row in its place.
      const live = rows().find((el) => el.dataset.itemId === row.dataset.itemId) ?? row;
      live.scrollIntoView({ block: 'nearest' });
      if (canOpen()) live.click();
    };
    function onInputKey(e: KeyboardEvent) {
      // Command mode owns the arrows of the field (commandPalette.ts).
      if (e.key !== 'ArrowDown' || !plain(e) || input!.value.startsWith('>')) return;
      e.preventDefault();
      go(rows()[0]);
    }
    function onListKey(e: KeyboardEvent) {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-item-id]');
      if (!row || row.parentElement !== list || !plain(e)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const all = rows();
        go(all[all.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]);
      } else if (e.key === 'Enter') {
        const editor = document.querySelector<HTMLElement>(
          '[data-pane="editor"] [contenteditable="true"], [data-pane="editor"] textarea',
        );
        if (!editor) return;
        e.preventDefault();
        editor.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input!.focus();
      }
    }
    input.addEventListener('keydown', onInputKey);
    list.addEventListener('keydown', onListKey);
    list.addEventListener('focusin', onFocusIn);
    list.addEventListener('focusout', onFocusOut);
    return () => {
      input.removeEventListener('keydown', onInputKey);
      list.removeEventListener('keydown', onListKey);
      list.removeEventListener('focusin', onFocusIn);
      list.removeEventListener('focusout', onFocusOut);
    };
    // No dependency list: the field and the list can mount after the first
    // render (multi-select swaps the header), so this re-attaches each render.
  });
}
