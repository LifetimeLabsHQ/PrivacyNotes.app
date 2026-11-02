/**
 * The site's icon from Chrome's own favicon store: no request leaves the
 * browser for it, and our server never learns the site. Firefox has no such
 * store, so it shows none and the rows fall back to a letter.
 */
import { browser } from 'wxt/browser';

export function faviconOf(url: string): string | null {
  if (import.meta.env.FIREFOX || !/^https?:\/\//i.test(url)) return null;
  return browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32` as '/');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
