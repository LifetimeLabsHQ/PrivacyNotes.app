import { useEffect, useRef } from 'react';
import { isImeComposing } from './imeComposing';

/**
 * Global Escape-to-close hook for modals.
 *
 * Attaches a capture-phase keydown listener so modals close before any
 * other Escape handler (selection-mode exit, etc.) can claim the event.
 * The one exception is a shared search field with text, which clears first. Capture phase also means the hook works even when
 * focus is inside an input/textarea within the modal.
 *
 * Nested modals: handlers are tracked in a LIFO stack and only the
 * most-recently-opened (topmost) one acts on Escape. So a sub-dialog
 * opened on top of a modal closes by itself first, without the modal
 * behind it also closing. (Registration order alone can't do this -
 * the outer modal registers first and would otherwise win.)
 *
 * Pass `enabled={false}` to disable the hook temporarily without
 * unmounting it.
 */
/** `inline`: the overlay sits in the page flow (the calendar's day list),
 *  so a pane drag has nothing to reposition and leaves it open. */
type EscEntry = { id: symbol; close: () => void; inline: boolean };

const escStack: EscEntry[] = [];

/**
 * Close the topmost open overlay (modal, popover, sheet, drawer, ...)
 * exactly as Escape would. Returns true when one was open. Lets the
 * Android back button walk the same LIFO stack without synthesizing
 * keyboard events. See androidBack.ts.
 */
export function closeTopOverlay(): boolean {
  const top = escStack[escStack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

/** Close the topmost overlay when it is anchored to the page (a popover, a
 *  menu), which a pane drag would leave floating; an inline one stays. */
export function closeTopAnchoredOverlay(): void {
  const top = escStack[escStack.length - 1];
  if (top && !top.inline) top.close();
}

/** True while an Escape-dismissible overlay is open in front of the page: a
 *  modal, a popover, a menu, a sheet. An inline entry (the calendar card's
 *  open day) is part of the page: Escape folds it and the Android back button
 *  walks it, but it blocks no shortcut and takes no focus from a new item. */
export function hasOpenOverlay(): boolean {
  return escStack.some((entry) => !entry.inline);
}

/**
 * Puts an overlay on the Escape stack and returns the call that takes it
 * off. The hook below is built on it; an overlay made of plain DOM, outside
 * React, calls it directly so it stops Escape the same way (codeLanguages.ts).
 * `key: false` puts it on the stack for the Android back button only: the
 * overlay keeps the Escape key itself (the drawing canvas, whose Escape also
 * finishes a text box or a line).
 */
export function pushEscapeHandler(onEscape: () => void, inline = false, key = true): () => void {
  const id = Symbol('esc');
  escStack.push({ id, close: onEscape, inline });
  if (!key) {
    return () => {
      const i = escStack.findIndex((entry) => entry.id === id);
      if (i !== -1) escStack.splice(i, 1);
    };
  }
  function handler(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    // An Escape that cancels a conversion belongs to the input method.
    if (isImeComposing(e)) return;
    if (e.defaultPrevented) return;
    // A search field with text takes its own Escape: it clears, and the next
    // Escape closes the overlay. The overlay listens in the capture phase, so
    // the field can never claim the key first (tests/escapeStack.test.ts).
    if (e.target instanceof HTMLInputElement && e.target.hasAttribute('data-search-field') && e.target.value) return;
    // Only the topmost open handler responds.
    if (escStack[escStack.length - 1]?.id !== id) return;
    e.stopPropagation();
    e.preventDefault();
    onEscape();
  }
  window.addEventListener('keydown', handler, true);
  return () => {
    window.removeEventListener('keydown', handler, true);
    const i = escStack.findIndex((entry) => entry.id === id);
    if (i !== -1) escStack.splice(i, 1);
  };
}

export function useEscapeToClose(onClose: () => void, enabled = true, inline = false) {
  // Keep the latest callback in a ref so the effect only re-runs (and
  // re-orders the stack) when `enabled` flips, not on every render.
  const cbRef = useRef(onClose);
  cbRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    return pushEscapeHandler(() => cbRef.current(), inline);
  }, [enabled, inline]);
}
