/**
 * The release switch for the crypto checkout (BlockBee). While it is false,
 * a release build offers no crypto payment: the Upgrade window has no "Pay
 * with crypto" link, `/crypto-checkout` opens the normal app, the payment
 * banner stays hidden, the landing page drops its pay-methods line, and the
 * help site leaves out the `pay-with-crypto` entry. A dev build (5173) still
 * shows all of it, so the live test can run before the switch goes on.
 * Off from 2026-11-13, on since 2026-11-14 (owner), after four live payments
 * passed. Turning it off again also needs the copy that names crypto taken
 * back, and the Worker's copy of this constant (worker.ts, which serves the
 * route and its robots line) flipped with it; the steps are in the spec.
 * Spec: docs/internal/plans/crypto-payments.md (section 11d, release switch)
 */
import { heldPasskeyFaqIds } from './passkeysRelease.ts';

const CRYPTO_CHECKOUT_RELEASED = true;

/** The switch itself, for the tests that ask whether the crypto checkout is
 *  released: `hiddenFaqIds()` also holds the passkey entries, so its length
 *  says nothing about crypto. Safe to read from Node.
 *  Spec: docs/contrib/passkeys.md (section 9) */
export const cryptoCheckoutReleasedConstant: boolean = CRYPTO_CHECKOUT_RELEASED;

/** True where the app may offer the crypto checkout. Never read from Node
 *  (the help-site build): it reads `import.meta.env`. */
export function cryptoCheckoutReleased(): boolean {
  return CRYPTO_CHECKOUT_RELEASED || import.meta.env.DEV;
}

/** The help entries held off the help site until their feature is
 *  released: the crypto checkout's, then the passkey ones
 *  (passkeysRelease.ts). The one list help-page.ts and tools/check-llms.mjs
 *  read. Safe to read from Node. */
export function hiddenFaqIds(): readonly string[] {
  return [...(CRYPTO_CHECKOUT_RELEASED ? [] : ['pay-with-crypto']), ...heldPasskeyFaqIds()];
}
