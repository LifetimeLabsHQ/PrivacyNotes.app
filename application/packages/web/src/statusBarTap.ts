import { scrollParentOf } from './scrollParent';

/**
 * Tap the iOS status bar to go to the top (GitHub #617), the system gesture
 * of every iPhone app. The app scrolls inside its own columns, never the
 * page, so the scroll the web view gets moves nothing. The iOS wrapper
 * (`status_bar_tap.rs`) catches the tap and sends this event instead. The
 * column under the middle of the screen goes to its top, the way UIKit picks
 * the scroll view under the status bar: the open note, or the list.
 * Inert everywhere else, because nothing else sends the event.
 */
export function installStatusBarTap(): void {
  window.addEventListener('pn-status-bar-tap', () => {
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    if (hit) scrollParentOf(hit).scrollTo({ top: 0, behavior: 'smooth' });
  });
}
