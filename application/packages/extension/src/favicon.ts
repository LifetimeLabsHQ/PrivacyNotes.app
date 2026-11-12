/**
 * The site's icon from our own favicon proxy, the one the app's vault uses
 * (`/favicon?domain=`): our server fetches it from DuckDuckGo or Google, so
 * neither sees the browser, and it sees only the domain. Chrome's own icon
 * store held only the sites this browser had visited, so most rows showed a
 * globe (owner, 2026-11-11). The app's helper decides when there is nothing
 * to ask (a private host, the demo); a row then shows its letter.
 * Spec: docs/internal/plans/browser-extension-build.md (decision E17); docs/public/VERIFY.md (the /favicon request)
 */
import { faviconUrl } from '@web/favicon';
import { APEX_ORIGIN } from '@web/hosts';

export function faviconOf(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  const path = faviconUrl(hostOf(url));
  if (!path) return null;
  // The app on the web asks its own origin; the extension has none.
  return path.startsWith('/') ? `${APEX_ORIGIN}${path}` : path;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
