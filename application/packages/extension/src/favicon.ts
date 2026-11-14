/**
 * The site's icon from our own favicon proxy, the one the app's vault uses
 * (`/favicon?domain=`): our server fetches it from DuckDuckGo or Google, so
 * neither sees the browser, and it sees only the domain. Chrome's own icon
 * store held only the sites this browser had visited, so most rows showed a
 * globe (owner, 2026-11-11). The app's helper decides when there is nothing
 * to ask (a private host, the demo); a row then shows its letter. A build
 * for another server (WXT_FUNCTIONS_URL) asks nothing, as the app does: the
 * person who runs it chose not to send us the domains of their logins.
 * Spec: docs/internal/plans/browser-extension-build.md (decision E17); docs/public/VERIFY.md (the /favicon request)
 */
import { faviconUrl } from '@web/favicon';
import { APEX_ORIGIN, isOfficialSyncUrl } from '@web/hosts';
import { FUNCTIONS_URL } from './config';

export function faviconOf(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (!isOfficialSyncUrl(FUNCTIONS_URL)) return null;
  const path = faviconUrl(displayHost(url));
  if (!path) return null;
  // The app on the web asks its own origin; the extension has none.
  return path.startsWith('/') ? `${APEX_ORIGIN}${path}` : path;
}

/** The host as a row shows it, without `www.`; the text itself when it is not an address. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
