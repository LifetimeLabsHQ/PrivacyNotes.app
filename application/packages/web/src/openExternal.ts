/**
 * Open a URL in the user's browser - the programmatic sibling of the
 * anchor-click interceptor in App.tsx. Anchors are covered there (the
 * capture-phase listener hands external hrefs to the opener plugin on
 * desktop); this helper is for code paths with no anchor to click, like
 * a bookmark row's open action.
 *
 * Web: window.open with noopener, same guarantees as rel="noopener".
 * Tauri (desktop + mobile wrappers): the opener plugin, because the
 * WebView swallows window.open the same way it swallows target=_blank.
 * Spec: docs/internal/macos-ios-setup.md (native flows use the same opener plugin)
 *
 * Four schemes and nothing else: http(s) for the web, and tel:, sms: and
 * mailto: for a contact's rows, which the OS hands to the dialer, the
 * messages app and the mail client. A phone number never opens in the iOS
 * browser sheet; that sheet is for http(s) only. On the web a path of this
 * site is an http(s) link on this origin.
 * Spec: docs/internal/specs/contacts-pillar.md (section 9, tap to call)
 */

import { detectPlatform } from './devices';
import { openShortcutInApp } from './noteShortcut';

const OPENABLE = /^(https?|tel|sms|mailto):/i;

/**
 * True for a link the opener plugin's own script would hand to the browser as
 * an address of the app itself: one with no scheme (`?x`, `/a`, `notes.md`)
 * that opens a new window. The script resolves it against the page, which on
 * Windows and Android is `http://tauri.localhost/`, an address it opens; on
 * macOS and Linux the page is `tauri://localhost` and it opens nothing. The
 * anchor interceptor in App.tsx cancels such a click, so every platform does
 * the same: nothing (beta issue 169).
 */
export function isAppRelativeNewWindowLink(anchor: Element, href: string): boolean {
  return anchor.getAttribute('target') === '_blank' && !/^[a-z][a-z0-9+.-]*:/i.test(href.trim());
}

/**
 * True when the opener plugin's own click script would take this click and
 * hand the browser an address of the app itself. The script takes a click on
 * a `target="_blank"` link, or one with Ctrl or Shift held (never Cmd or Alt),
 * and resolves the address against the page as the browser does: leading
 * spaces dropped, so `" http:?x"` is `http://tauri.localhost/index.html?x` on
 * Windows. So the test is the resolved address on the page's own scheme and
 * host, not the text. A plain click on a `#` link (a footnote mark) is not one
 * the script takes, and keeps scrolling (beta issue 200, item 2).
 */
export function pluginOpensThisApp(anchor: Element, keys: Pick<MouseEvent, 'ctrlKey' | 'shiftKey' | 'metaKey' | 'altKey'>, base = document.baseURI): boolean {
  if (keys.metaKey || keys.altKey) return false;
  if (anchor.getAttribute('target') !== '_blank' && !keys.ctrlKey && !keys.shiftKey) return false;
  const href = anchor.getAttribute('href');
  if (href === null) return false;
  try {
    const to = new URL(href, base);
    const page = new URL(base);
    return to.protocol === page.protocol && to.host === page.host;
  } catch {
    return false;
  }
}

export function openExternal(url: string): void {
  // A site path ("/en/changelog", as `siteHref` gives one on a web host that
  // also serves the site: localhost, staging) opens on this origin.
  if (/^\/(?!\/)/.test(url) && detectPlatform() === 'web') url = new URL(url, window.location.origin).href;
  if (!OPENABLE.test(url)) return;
  // A shortcut to an item of this vault opens in place.
  // Spec: docs/internal/specs/note-shortcuts.md (5.4)
  if (openShortcutInApp(url)) return;
  const platform = detectPlatform();
  if (platform !== 'web') {
    // iOS: in-app SFSafariViewController sheet, mirroring the anchor
    // interceptor in App.tsx (guideline 4 - keep the user in the app).
    const openWith = platform === 'ios' && /^https?:/i.test(url) ? ('inAppBrowser' as const) : undefined;
    void import('@tauri-apps/plugin-opener').then(async ({ openUrl }) => {
      try {
        await openUrl(url, openWith);
      } catch (err) {
        // Same fallback as the anchor interceptor in App.tsx: `with` is
        // ACL-checked, so a scope gap must degrade to the system browser
        // rather than to a dead tap. See the comment there.
        if (openWith) {
          console.warn('[links] in-app sheet refused, using the browser', err);
          await openUrl(url);
          return;
        }
        console.error('[links] could not open', url, err);
      }
    });
    return;
  }
  if (/^https?:/i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  // A tel:, sms: or mailto: link is a handoff to another app, and a new
  // tab for it is a blank page left behind in the browser.
  window.location.href = url;
}
