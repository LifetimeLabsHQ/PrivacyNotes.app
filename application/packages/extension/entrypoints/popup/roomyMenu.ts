/**
 * The app's `useContextMenu`, for a popup that is only as high as its screen
 * (at most 600 px). A menu cannot make the popup grow, so a menu that needs
 * more room than the popup has grows it first, waits for the browser to
 * resize the window, then opens. Closing the menu gives the room back.
 * Spec: docs/internal/plans/browser-extension-build.md (decision E17)
 */
import { useEffect } from 'react';
import { useContextMenu, type ContextMenuItem } from '@web/ContextMenu';

// Spec: packages/extension/entrypoints/popup/style.css (the popup's max-height)
const MAX_HEIGHT = 600;
// The menu's rows as `ContextMenu` draws them (text-compact, py-1.5), a
// little high, so the estimate never comes up short.
const ROW = 34;
const HEADER = 30;
const SEPARATOR = 10;
const FRAME = 12;
const MARGIN = 8;
// The browser resizes the popup a moment later; the menu opens anyway after this.
const WAIT_MS = 150;

function menuHeight(items: ContextMenuItem[]): number {
  return items.reduce((h, it) => h + ('type' in it && it.type === 'separator' ? SEPARATOR : 'type' in it && it.type === 'header' ? HEADER : ROW), FRAME);
}

export function useRoomyMenu() {
  const menu = useContextMenu();
  const shown = !!menu.state;

  useEffect(() => {
    if (!shown) document.body.style.removeProperty('min-height');
  }, [shown]);

  const open: typeof menu.open = (e, items, ...rest) => {
    const need = Math.min(MAX_HEIGHT, Math.ceil(e.clientY + menuHeight(items) + MARGIN));
    if (need <= window.innerHeight) return menu.open(e, items, ...rest);
    document.body.style.minHeight = `${need}px`;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      window.removeEventListener('resize', go);
      menu.open(e, items, ...rest);
    };
    window.addEventListener('resize', go);
    window.setTimeout(go, WAIT_MS);
  };

  return { ...menu, open };
}
