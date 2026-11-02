/**
 * The release switch for the browser extension in the app. While the stores
 * still review the extension, every place that offers it (Settings >
 * Extension, its settings search rows, the Web clipper window's tip) shows
 * in a dev build only, and the help site leaves out its entries and every
 * paragraph that links to them, so a release ships without it. Set to true once
 * Chrome, Edge and Firefox list it. The sync side stays on: it only acts
 * for a browser that is already connected.
 * Spec: docs/internal/plans/browser-extension-build.md (section 6, release switch)
 */
const EXTENSION_RELEASED = false;

/** True where the app may offer the browser extension. */
export function extensionOffered(): boolean {
  return EXTENSION_RELEASED || import.meta.env.DEV;
}

/** The help entries about the extension, left out of the help site until it
 *  is released. help-page.ts also drops each paragraph that links to one. */
export function hiddenFaqIds(): readonly string[] {
  return EXTENSION_RELEASED ? [] : ['browser-extension', 'browser-extension-security'];
}
