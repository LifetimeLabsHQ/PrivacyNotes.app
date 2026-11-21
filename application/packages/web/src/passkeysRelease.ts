/**
 * The release switch for passkeys: sign-in with a passkey (Settings >
 * Security > Passkeys, and the button on the sign-in screen) and the Vault's
 * site passkeys. While it is false a release build shows none of it and the
 * help site leaves out the held entries; a dev build (5173) shows everything,
 * so the parts can be checked before the server parts are deployed. The
 * owner turns it on after the deploy, together with the extension's own
 * switch, the Passkeys tab's help chip and the held FAQ entries.
 * Spec: docs/contrib/passkeys.md (section 9, P11, P27)
 */
const PASSKEYS_RELEASED = true;

/** True where the app may offer passkeys. Never read from Node (the
 *  help-site build): it reads `import.meta.env`. */
export function passkeysReleased(): boolean {
  return PASSKEYS_RELEASED || import.meta.env.DEV;
}

/** The help entries about passkey sign-in and Vault passkeys, held off the
 *  help site until the switch is on. Safe to read from Node.
 *  Spec: docs/contrib/passkeys.md (section 11, held FAQ entries) */
export function heldPasskeyFaqIds(): readonly string[] {
  return PASSKEYS_RELEASED ? [] : ['passkey-sign-in', 'vault-passkeys'];
}
