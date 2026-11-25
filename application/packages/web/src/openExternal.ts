/**
 * Single chokepoint for opening URLs outside the app's WebView - shared by
 * programmatic callers (bookmarks, editor clicks, vault/contact links, Ninja
 * doors, OAuth, billing, update toasts, About window) and the capture-phase
 * anchor interceptor in App.tsx.
 *
 * Web: window.open with noopener, same guarantees as rel="noopener".
 * Tauri (desktop + mobile wrappers): the opener plugin, because the
 * WebView swallows window.open the same way it swallows target=_blank.
 * Spec: docs/internal/macos-ios-setup.md (native flows use the same opener plugin)
 * Spec: docs/contrib/gotchas.md (AppImage external links do nothing)
 *
 * iOS target split (GitHub #898):
 * - Default (`browser: false`): http(s) opens in the in-app SFSafariViewController
 *   sheet (`inAppBrowser`), keeping app links (Privacy Policy, Terms of Service,
 *   Settings, Help, About) inside the app per App Review guideline 4.
 * - `browser: true`: opens in the user's default system browser via `openUrl(url)`
 *   so links from user content (notes, bookmarks, contacts, vault items, drawings)
 *   stay open in the browser while the user switches back and forth.
 *
 * Four schemes for ordinary links: http(s) for the web, and tel:, sms: and
 * mailto: for a contact's rows, which the OS hands to the dialer, the
 * messages app and the mail client. `itms-apps://` is accepted only when
 * `allowStoreScheme: true` is passed by the App Store subscription manager.
 * A phone number never opens in the iOS browser sheet; that sheet is for
 * http(s) only. On the web a path of this site is an http(s) link on this
 * origin.
 * Spec: docs/internal/specs/contacts-pillar.md (section 9, tap to call)
 */

import { detectPlatform } from './devices';
import { openShortcutInApp } from './noteShortcut';

/** Schemes any link in the app may open; verified against capabilities/*.json in tests/desktopCapabilities.test.ts. */
const OPEN_EXTERNAL_SCHEMES = ['http:', 'https:', 'tel:', 'sms:', 'mailto:'] as const;

const OPENABLE = new RegExp(`^(${OPEN_EXTERNAL_SCHEMES.map((s) => s.slice(0, -1)).join('|')}):`, 'i');
const STORE_OPENABLE = /^itms-apps:\/\//i;

export interface OpenExternalOptions {
  /**
   * iOS only: open http(s) in the user's default browser instead of the
   * in-app SFSafariViewController sheet. Use for user-content links (note
   * editor, bookmarks, vault/contact links, drawings) and OS/OAuth handoffs;
   * leave false for app-chrome links (Settings, Terms, Privacy Policy, Help, About).
   */
  browser?: boolean;
  /**
   * Permit the iOS App Store scheme (`itms-apps://`). Used only by Apple
   * subscription management in billing.ts; never enabled for user content.
   */
  allowStoreScheme?: boolean;
}

/**
 * True when a clicked anchor belongs to user content and should open in the
 * default browser on iOS rather than the in-app SFSafariViewController sheet:
 * - `.ProseMirror`: note editor, read-only notes, Markdown preview, history, Home note widget
 * - `.pn-detail-notes`: rendered Markdown notes inside vault items and bookmarks
 * - `[data-open-browser]`: explicit user-content anchors such as DetailLink
 */
export function anchorOpensInDefaultBrowser(anchor: Element): boolean {
  return anchor.closest('.ProseMirror, .pn-detail-notes, [data-open-browser]') !== null;
}

/**
 * True when an anchor sits inside an editable region where `LinkModifierOpen`
 * owns desktop mouse clicks, and false inside a `contenteditable="false"` atom
 * island (such as `PlaceMapNode`) nested within `.ProseMirror`.
 */
export function isEditableAnchor(anchor: Element): boolean {
  return anchor.closest('[contenteditable]')?.getAttribute('contenteditable') === 'true';
}

/**
 * True for a link the opener plugin's own script would hand to the browser as
 * an address of the app itself: one with no scheme (`?x`, `/a`, `notes.md`)
 * that opens a new window. Kept as defense-in-depth alongside
 * `open_js_links_on_click(false)` in `lib.rs` (beta issue 169).
 */
export function isAppRelativeNewWindowLink(anchor: Element, href: string): boolean {
  return anchor.getAttribute('target') === '_blank' && !/^[a-z][a-z0-9+.-]*:/i.test(href.trim());
}

/**
 * True when an anchor click would resolve against the app's own scheme and
 * host (`http://tauri.localhost/` on Windows/Android, `tauri://localhost` on
 * macOS/Linux/iOS). Kept as defense-in-depth alongside
 * `open_js_links_on_click(false)` in `lib.rs` (beta issue 200, item 2).
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

export interface NativeAnchorClickContext {
  isTouch: boolean;
  linkModifier: boolean;
  isModifier: boolean;
}

/**
 * Capture-phase click handler installed by App.tsx on native builds. Owns
 * every `<a href>` click outside editable desktop notes (where
 * `LinkModifierOpen` handles mouse clicks on mouseup). Exported so the
 * cross-platform click-matrix test exercises the exact production routing.
 */
export function handleNativeAnchorClick(e: MouseEvent, ctx: NativeAnchorClickContext): void {
  if (e.defaultPrevented || e.button !== 0) return;
  const anchor = (e.target as Element | null)?.closest('a');
  // Trimmed, as the cleaner reads it (beta #200).
  const href = anchor?.getAttribute('href')?.trim();
  // Cancel clicks that resolve to the app's own origin (beta issues 169, 200).
  if (anchor && (pluginOpensThisApp(anchor, e) || (href && isAppRelativeNewWindowLink(anchor, href)))) {
    e.preventDefault();
    return;
  }
  // tel: and sms: ride along with mailto:: a contact's number is a handoff to
  // the dialer, which the WebView cannot make on its own.
  // Spec: docs/internal/specs/contacts-pillar.md (section 9, tap to call)
  if (!href || !OPENABLE.test(href)) return;
  // A mouse click on a link inside a note being written is opened by
  // `editorLinks.ts` (on mouseup, before this click), which also knows a
  // file link from an address. A finger keeps this route. Cancel the click
  // so the WebView never follows the anchor in place (GitHub #701).
  if (!ctx.isTouch && anchor && isEditableAnchor(anchor)) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  // "Open links with Cmd-click" covers a read-only note too (GitHub #633).
  if (ctx.linkModifier && !ctx.isTouch && !ctx.isModifier && anchor?.closest('.ProseMirror')) return;
  // Delegate to openExternal so shortcut handling and the iOS split
  // (default browser for user content, in-app SFSafariViewController sheet
  // for Settings/legal/help/app chrome) live in one place (GitHub #898).
  openExternal(href, { browser: anchor ? anchorOpensInDefaultBrowser(anchor) : false });
}

function resolveOpenableUrl(raw: string, opts?: OpenExternalOptions): string | null {
  let url = raw;
  // A site path ("/en/changelog", as `siteHref` gives one on a web host that
  // also serves the site: localhost, staging) opens on this origin.
  if (/^\/(?!\/)/.test(url) && detectPlatform() === 'web') url = new URL(url, window.location.origin).href;
  const allowed = OPENABLE.test(url) || (!!opts?.allowStoreScheme && STORE_OPENABLE.test(url));
  return allowed ? url : null;
}

/**
 * Open an external URL and return a promise that resolves when the OS opener
 * accepts it or rejects on failure. On web, `window.open` runs synchronously
 * before returning a resolved promise so popup blockers preserve the click
 * gesture. Callers that must surface or handle errors (OAuth, billing, update
 * toasts) await this; fire-and-forget UI links use `openExternal`.
 */
export function openExternalAsync(raw: string, opts?: OpenExternalOptions): Promise<void> {
  const url = resolveOpenableUrl(raw, opts);
  if (!url) return Promise.resolve();
  // A shortcut to an item of this vault opens in place.
  // Spec: docs/internal/specs/note-shortcuts.md (5.4)
  if (openShortcutInApp(url)) return Promise.resolve();
  const platform = detectPlatform();
  if (platform !== 'web') {
    // iOS: app-chrome web links stay in the in-app SFSafariViewController sheet
    // (guideline 4), while user-content links (`browser: true`) open in the
    // user's default browser (GitHub #898). Non-http schemes (tel/sms/mailto/itms-apps)
    // and Android/desktop always use the plain OS handoff.
    const openWith =
      platform === 'ios' && !opts?.browser && /^https?:/i.test(url)
        ? ('inAppBrowser' as const)
        : undefined;
    return import('@tauri-apps/plugin-opener').then(async ({ openUrl }) => {
      try {
        await (openWith ? openUrl(url, openWith) : openUrl(url));
      } catch (err) {
        // Never let a link do nothing. `with` is part of the opener's ACL
        // check - a scope that does not grant an explicit application
        // rejects with ForbiddenUrl - and this call had no catch when the
        // sheet first shipped, so a capability gap silently killed EVERY
        // external link in the app (2026-08-26). Retry without the sheet:
        // the system browser is far better than a dead tap.
        if (openWith) {
          console.warn('[links] in-app sheet refused, using the browser', err);
          await openUrl(url);
          return;
        }
        throw err;
      }
    });
  }
  if (/^https?:/i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  }
  // A tel:, sms: or mailto: link is a handoff to another app, and a new
  // tab for it is a blank page left behind in the browser.
  window.location.href = url;
  return Promise.resolve();
}

export function openExternal(url: string, opts?: OpenExternalOptions): void {
  void openExternalAsync(url, opts).catch((err) => {
    console.error('[links] could not open', url, err);
  });
}
