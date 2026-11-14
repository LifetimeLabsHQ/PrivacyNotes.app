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
const CRYPTO_CHECKOUT_RELEASED = true;

/** True where the app may offer the crypto checkout. Never read from Node
 *  (the help-site build): it reads `import.meta.env`. */
export function cryptoCheckoutReleased(): boolean {
  return CRYPTO_CHECKOUT_RELEASED || import.meta.env.DEV;
}

/** The help entries about the crypto checkout, left out of the help site
 *  until it is released. Safe to read from Node. */
export function hiddenFaqIds(): readonly string[] {
  return CRYPTO_CHECKOUT_RELEASED ? [] : ['pay-with-crypto'];
}
