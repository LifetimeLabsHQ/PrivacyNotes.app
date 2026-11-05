/**
 * The browser extension's store listings, by browser name as the Add button
 * shows it. Null until the store has published the listing; Settings >
 * Extension shows Coming soon for those.
 * Spec: docs/internal/plans/browser-extension-build.md (section 9.5, store listing)
 */
export type ExtensionBrowser = 'Chrome' | 'Firefox' | 'Edge';

export const EXTENSION_STORES: Record<ExtensionBrowser, string | null> = {
  Chrome: 'https://chromewebstore.google.com/detail/privacynotes/bloonbldcmkoebhiihhmocolilhaemmd',
  Firefox: null,
  Edge: 'https://microsoftedge.microsoft.com/addons/detail/privacynotes/fkffeinaneapmidinjnoibadpcoknjdg',
};

/** Each store's own name, shown under the browser once its link is set. */
export const STORE_NAME: Record<ExtensionBrowser, string> = {
  Chrome: 'Chrome Web Store',
  Firefox: 'Firefox Add-ons',
  Edge: 'Edge Add-ons',
};
