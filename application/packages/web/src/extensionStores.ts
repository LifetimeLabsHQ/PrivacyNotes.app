/**
 * The browser extension's store listings, by browser name as the Add button
 * shows it. Null until the store has published the listing; Settings >
 * Extension shows Coming soon for those.
 * Spec: docs/internal/plans/browser-extension-build.md (section 9.5, store listing)
 */
type ExtensionBrowser = 'Chrome' | 'Firefox' | 'Edge';

const EXTENSION_STORES: Record<ExtensionBrowser, string | null> = {
  Chrome: 'https://chromewebstore.google.com/detail/privacynotes/bloonbldcmkoebhiihhmocolilhaemmd',
  Firefox: 'https://addons.mozilla.org/firefox/addon/privacynotes/',
  Edge: 'https://microsoftedge.microsoft.com/addons/detail/privacynotes/fkffeinaneapmidinjnoibadpcoknjdg',
};

/** Each store's own name, shown under the browser once its link is set. */
const STORE_NAME: Record<ExtensionBrowser, string> = {
  Chrome: 'Chrome Web Store',
  Firefox: 'Firefox Add-ons',
  Edge: 'Edge Add-ons',
};

/** Browsers with no store of their own that install the extension from the
 *  Chrome Web Store or Firefox Add-ons. Shown as their own install buttons,
 *  after the three stores, to show how far the extension reaches. */
const CHROME_STORE_BROWSERS = ['Brave', 'Vivaldi', 'Opera', 'Arc'] as const;
const FIREFOX_STORE_BROWSERS = ['LibreWolf', 'Zen'] as const;
export type InstallBrowser =
  | ExtensionBrowser
  | (typeof CHROME_STORE_BROWSERS)[number]
  | (typeof FIREFOX_STORE_BROWSERS)[number];

/** Every install button, in order: the three stores, then Chromium browsers
 *  on the Chrome Web Store, then Firefox-based browsers on Firefox Add-ons.
 *  `store` names where the link leads. */
export function installLinks(): { browser: InstallBrowser; url: string | null; store: string }[] {
  return [
    ...(Object.entries(EXTENSION_STORES) as [ExtensionBrowser, string | null][]).map(([browser, url]) => ({ browser, url, store: STORE_NAME[browser] })),
    ...CHROME_STORE_BROWSERS.map((browser) => ({ browser, url: EXTENSION_STORES.Chrome, store: STORE_NAME.Chrome })),
    ...FIREFOX_STORE_BROWSERS.map((browser) => ({ browser, url: EXTENSION_STORES.Firefox, store: STORE_NAME.Firefox })),
  ];
}
