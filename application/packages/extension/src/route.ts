/**
 * A view the popup should open on, left by a context-menu item, the address
 * bar or a shortcut: Add login, the generator, or the search with a query.
 * Session storage only, and read once.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.3, menu)
 */
import { browser } from 'wxt/browser';

export const ROUTE_KEY = 'popupRoute';

export interface PopupRoute {
  view: 'addLogin' | 'generator' | 'search';
  /** The page the menu was opened on: a popup that falls back to a window
   *  has no active tab of its own. */
  url: string;
  /** The words to search for, with `search`. */
  query?: string;
  at: number;
}

/** The route left in the last few seconds, cleared as it is read. */
export async function takeRoute(): Promise<PopupRoute | null> {
  const got = (await browser.storage.session.get(ROUTE_KEY))[ROUTE_KEY] as PopupRoute | undefined;
  if (!got) return null;
  await browser.storage.session.remove(ROUTE_KEY);
  return Date.now() - got.at < 15_000 ? got : null;
}
