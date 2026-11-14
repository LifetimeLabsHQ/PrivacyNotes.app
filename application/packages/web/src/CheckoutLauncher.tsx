/**
 * Standalone /checkout page. The native (desktop) app can't run the Paddle
 * overlay in its webview (CSP blocks Paddle's CDN script - see billing.ts), so
 * it opens this page in the system browser, where Paddle works normally.
 *
 * Reads the purchase from the URL: `?product=pro&pubkey=...` or
 * `?product=storage&gb=2&pubkey=...`. The pubkey is forwarded to Paddle as
 * customData so the webhook attaches the purchase to the right account. We take
 * GB (not a price ID) for storage and resolve it to this build's live price ID,
 * so a sandbox-built desktop app can't push a sandbox ID into live Paddle.
 *
 * Rendered outside AuthProvider (main.tsx pathname routing) - it needs no
 * session, only the pubkey from the URL.
 *
 * Also Paddle's default-payment-link target: Paddle-sent emails (update
 * payment method, dunning for the storage subs) append `?_ptxn=<txn>`,
 * and Paddle.js auto-opens that transaction's checkout once initialized.
 * Spec: docs/internal/domain-split.md (Paddle default payment link -> /checkout)
 */

import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Brand } from './Brand';
import {
  AccountBlock,
  Benefit,
  CheckoutButton,
  CheckoutCard,
  CheckoutHeader,
  CheckoutPaper,
  CheckoutSteps,
  ProBenefits,
} from './checkoutParts';
import {
  openProCheckout,
  openStorageCheckout,
  getStoragePackages,
  initPaddleForTransaction,
  isBetaPricing,
} from './paddle';
import { EARLY_PRICE, PRO_PRICE } from './pricing';

type State = 'confirm' | 'opening' | 'done' | 'error';

/** Query parameters an auth server's answer can carry. The page reads none of them. */
const AUTH_RESPONSE_PARAMS = [
  'code',
  'access_token',
  'refresh_token',
  'expires_in',
  'expires_at',
  'token_type',
  'provider_token',
  'provider_refresh_token',
  'type',
  'error',
  'error_code',
  'error_description',
  'state',
];

/**
 * The address this page may hold while Paddle's script runs, or null when
 * `href` already is that address. This is the one page that loads a payment
 * script, and that script never runs while the address holds a fragment or
 * the query parameters of a sign-in response, which is where an auth server
 * puts tokens and codes. Everything else in the query stays: `_ptxn` is how
 * Paddle.js finds its transaction, and the purchase parameters are read below.
 */
export function scrubbedCheckoutUrl(href: string): string | null {
  const url = new URL(href);
  const present = AUTH_RESPONSE_PARAMS.filter((name) => url.searchParams.has(name));
  if (present.length === 0 && !href.includes('#')) return null;
  for (const name of present) url.searchParams.delete(name);
  url.hash = '';
  return url.href;
}

/** What the link asks to buy, once the URL has been read and checked. */
type Purchase =
  | { kind: 'pro'; pubkey: string; price: number }
  | { kind: 'storage'; pubkey: string; gb: number; price: number; priceId: string };

export default function CheckoutLauncher() {
  const { t } = useTranslation('billing');
  const [state, setState] = useState<State>('opening');
  const [purchase, setPurchase] = useState<Purchase | null>(null);

  const onDone = () => setState('done');

  useEffect(() => {
    // First, before any branch below can load Paddle.
    const scrubbed = scrubbedCheckoutUrl(window.location.href);
    if (scrubbed) window.history.replaceState(null, '', scrubbed);

    const params = new URLSearchParams(window.location.search);
    const product = params.get('product');
    const pubkey = params.get('pubkey') ?? '';

    // Paddle-sent payment links land here with `?_ptxn=<transaction id>`
    // - no product, no pubkey, no session. Paddle.js auto-opens the
    // checkout for that transaction once initialized, so initialize and
    // get out of the way. Until the Paddle dashboard's default payment
    // link points at /checkout, these emails dead-ended on the homepage.
    // No confirm step here: the person is answering their own dunning
    // email about a subscription they already hold, and the transaction
    // names the account rather than the URL.
    // Spec: docs/internal/domain-split.md (Paddle default payment link -> /checkout)
    if (params.get('_ptxn')) {
      initPaddleForTransaction(onDone).catch(() => setState('error'));
      return;
    }

    if (!pubkey || (product !== 'pro' && product !== 'storage')) {
      setState('error');
      return;
    }

    // Nothing here proves the link came from the reader's own app: the
    // pubkey is a URL parameter, so a link somebody else wrote pays for
    // somebody else's account with this card. So the page names what is
    // being bought, at what price, and which account it lands on, and
    // waits for a click before any payment window opens.
    if (product === 'pro') {
      setPurchase({ kind: 'pro', pubkey, price: isBetaPricing() ? EARLY_PRICE : PRO_PRICE });
      setState('confirm');
      return;
    }

    const gb = Number(params.get('gb'));
    const pkg = getStoragePackages().find((p) => p.gb === gb);
    if (!pkg) {
      setState('error');
      return;
    }
    setPurchase({
      kind: 'storage',
      pubkey,
      gb: pkg.gb,
      price: pkg.pricePerYear,
      priceId: pkg.priceId,
    });
    setState('confirm');
  }, []);

  function start(): void {
    if (!purchase) return;
    setState('opening');
    const opened =
      purchase.kind === 'pro'
        ? openProCheckout(purchase.pubkey, onDone)
        : openStorageCheckout(purchase.pubkey, purchase.priceId, onDone);
    opened.catch(() => setState('error'));
  }

  // The page and its parts are the cream paper of the homepage in every
  // theme; they live in checkoutParts.tsx, shared with the crypto checkout.
  return (
    <CheckoutPaper>
      {state === 'confirm' && purchase ? (
        <CheckoutCard>
          <CheckoutHeader title={t('checkout.title')} />

          <div className="px-4 py-4">
            <p className="text-body">
              <Trans
                t={t}
                i18nKey={purchase.kind === 'pro' ? 'checkout.proLine' : 'checkout.storageLine'}
                values={
                  purchase.kind === 'pro'
                    ? { price: purchase.price }
                    : { gb: purchase.gb, price: purchase.price.toFixed(2) }
                }
                components={{ brand: <Brand /> }}
              />
            </p>

            <ul className="mt-3 inline-flex flex-col gap-2 text-start">
              {purchase.kind === 'pro' ? (
                <ProBenefits />
              ) : (
                <>
                  <Benefit title={t('checkout.benefitRoom', { gb: purchase.gb })} sub={t('checkout.benefitRoomSub')} />
                  <Benefit title={t('checkout.benefitFileSize')} sub={t('checkout.benefitFileSizeSub')} />
                  <Benefit title={t('checkout.benefitCancel')} sub={t('checkout.benefitCancelSub')} />
                </>
              )}
            </ul>

            <AccountBlock pubkey={purchase.pubkey} />
          </div>

          <div className="bg-[#1E40AF] px-4 pt-4 pb-3">
            <CheckoutButton onClick={start}>{t('checkout.confirmButton')}</CheckoutButton>
            <CheckoutSteps />
          </div>
        </CheckoutCard>
      ) : (
        <div className="max-w-sm w-full text-center space-y-3">
          {state === 'error' ? (
            <>
              <h1 className="text-heading font-semibold">{t('checkout.invalidTitle')}</h1>
              <p className="text-body text-[#6A6152]">{t('checkout.invalidBody')}</p>
            </>
          ) : state === 'done' ? (
            <>
              <h1 className="text-heading font-semibold">{t('checkout.completeTitle')}</h1>
              <p className="text-body text-[#6A6152]">{t('checkout.completeBody')}</p>
            </>
          ) : (
            <>
              <h1 className="text-heading font-semibold">{t('checkout.openingTitle')}</h1>
              <p className="text-body text-[#6A6152]">{t('checkout.openingBody')}</p>
            </>
          )}
        </div>
      )}
    </CheckoutPaper>
  );
}
