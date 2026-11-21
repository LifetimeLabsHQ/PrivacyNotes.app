/**
 * The extension's release switch for passkeys. While it is false the page
 * script wraps nothing, the background takes no passkey request, and the
 * Edit button and the "Offer passkeys" setting are hidden. A development
 * build (`wxt` dev mode) shows everything, as the app's switch does.
 * The owner turns it on with the app's `PASSKEYS_RELEASED`, after the
 * server parts are deployed.
 * Spec: docs/contrib/passkeys.md (section 9, P27)
 */
const PASSKEYS_RELEASED = true;

export function passkeysReleased(): boolean {
  return PASSKEYS_RELEASED || import.meta.env.DEV === true;
}
