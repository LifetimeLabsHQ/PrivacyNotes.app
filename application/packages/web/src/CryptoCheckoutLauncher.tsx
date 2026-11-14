/**
 * Standalone /crypto-checkout page: Pro paid in crypto through BlockBee's
 * hosted checkout. The app opens it in a new tab (web) or the system browser
 * (desktop), with `?order=<id>&pubkey=<hex>`; BlockBee sends the buyer back
 * with `?order=<id>` and its own parameters, which the page ignores.
 *
 *   1. confirm  - product, the server's price, the full Account ID, and a
 *                 required consent: Pro starts at once, crypto payments are
 *                 final, an EU or UK buyer gives up the withdrawal right.
 *   2. BlockBee - the page leaves for pay.blockbee.io as a navigation. No
 *                 BlockBee script runs here, and this page loads none of
 *                 Paddle's: its own route, its own CSP (worker.ts).
 *   3. back     - the order's state, polled until it is paid; then the
 *                 purchase confirmation, which the buyer saves as a PDF.
 *
 * Rendered outside AuthProvider (main.tsx pathname routing): it needs no
 * session, only the order (which the signed-in app registered) and the
 * pubkey. The server never answers the pubkey, and refuses an order that
 * pays for another one, so every view that names an account or offers a
 * payment link names the one in the address. In the demo it calls nothing.
 * Spec: docs/internal/plans/crypto-payments.md (section 11b)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Brand } from './Brand';
import { AccountBlock, CheckoutButton, CheckoutCard, CheckoutHeader, CheckoutPaper } from './checkoutParts';
import {
  createCryptoCheckout,
  cryptoCheckoutStatus,
  describeCoin,
  isCryptoOrderId,
  quoteCryptoPrice,
  type CryptoStatus,
} from './cryptoCheckout';
import { HEX32_KEY } from '@notes/shared';
import { DEMO_APP_URL, isDemoMode } from './demo';
import { activeLocale } from './i18n';
import { dateLocale, formatInstant } from './intlFormat';
import { Printer } from './icons';
import { Button, Checkbox } from './ui';

// The seller and the processor as the confirmation names them (owner,
// 2026-11-12). Names and an address, so they stay as they are in every
// language. Spec: docs/internal/plans/crypto-payments.md (section 11b)
const SELLER = 'Lifetime Labs LLC, 30 N Gould St, Ste N, Sheridan, WY 82801, United States';
const PROCESSOR = 'Blockbee Inc, Panama';
const TERMS_URL = 'https://lifetimelabs.dev/terms/';

/** How often the page asks about an order it is waiting on. */
const POLL_MS = 10_000;

type View =
  | { kind: 'loading' }
  | { kind: 'confirm'; order: string; pubkey: string; priceCents: number | null }
  | { kind: 'opening' }
  | { kind: 'waiting'; order: string; status: CryptoStatus; pubkey: string | null }
  | { kind: 'paid'; status: CryptoStatus; pubkey: string | null }
  | { kind: 'expired' }
  | { kind: 'alreadyPro' }
  | { kind: 'demo' }
  | { kind: 'invalid' }
  | { kind: 'error'; retry: () => void };

export default function CryptoCheckoutLauncher() {
  const { t } = useTranslation('billing');
  const [view, setView] = useState<View>({ kind: 'loading' });
  const poll = useRef<number | null>(null);

  const stopPolling = () => {
    if (poll.current !== null) window.clearTimeout(poll.current);
    poll.current = null;
  };

  // One status read, and the view it leads to. `pubkey` is the Account ID
  // the page was opened with (or kept across the visit to BlockBee): the
  // server answers no pubkey, and refuses an order that pays for another
  // account, so the page never shows or offers one it cannot vouch for.
  const follow = useCallback(async (order: string, pubkey: string | null) => {
    stopPolling();
    const res = await cryptoCheckoutStatus(order, pubkey);
    if (!res.ok) {
      if (res.code === 'demo') return setView({ kind: 'demo' });
      if (res.code === 'order_taken') return setView({ kind: 'invalid' });
      return setView({ kind: 'error', retry: () => void follow(order, pubkey) });
    }
    if (pubkey) keepAccount(order, pubkey);
    const status = res.data;
    // 'none': the app's registration may still be on its way; the server
    // refuses the create step until it has landed.
    if (status.state === 'none' || status.state === 'new') {
      if (!pubkey) return setView({ kind: 'invalid' });
      setView({ kind: 'confirm', order, pubkey, priceCents: null });
      const quote = await quoteCryptoPrice();
      if (quote.ok) setView({ kind: 'confirm', order, pubkey, priceCents: quote.data.amount_cents });
      else setView({ kind: 'error', retry: () => void follow(order, pubkey) });
      return;
    }
    if (status.state === 'paid') return setView({ kind: 'paid', status, pubkey });
    if (status.state === 'expired') return setView({ kind: 'expired' });
    setView({ kind: 'waiting', order, status, pubkey });
    poll.current = window.setTimeout(() => void follow(order, pubkey), POLL_MS);
  }, []);

  useEffect(() => {
    if (isDemoMode()) {
      setView({ kind: 'demo' });
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const order = params.get('order');
    const pubkey = params.get('pubkey');
    if (!isCryptoOrderId(order) || (pubkey !== null && !HEX32_KEY.test(pubkey))) {
      setView({ kind: 'invalid' });
      return;
    }
    void follow(order, pubkey ?? keptAccount(order));
    return stopPolling;
  }, [follow]);

  async function pay(order: string, pubkey: string): Promise<void> {
    setView({ kind: 'opening' });
    const res = await createCryptoCheckout(order, pubkey);
    if (res.ok) {
      // Leaves for BlockBee's page. The answer can name this account's other
      // order, the one whose checkout is open; BlockBee returns to that one.
      // Back on this page, the status read shows where the payment stands.
      keepAccount(res.data.order, pubkey);
      window.location.assign(res.data.payment_url);
      return;
    }
    if (res.code === 'already_pro') return setView({ kind: 'alreadyPro' });
    if (res.code === 'expired') return setView({ kind: 'expired' });
    if (res.code === 'order_taken') return setView({ kind: 'invalid' });
    if (res.code === 'demo') return setView({ kind: 'demo' });
    setView({ kind: 'error', retry: () => void follow(order, pubkey) });
  }

  return (
    <CheckoutPaper>
      {view.kind === 'confirm' ? (
        <ConfirmStep view={view} onPay={() => void pay(view.order, view.pubkey)} />
      ) : view.kind === 'paid' ? (
        <Confirmation status={view.status} pubkey={view.pubkey} />
      ) : view.kind === 'waiting' ? (
        <Waiting status={view.status} pubkey={view.pubkey} />
      ) : (
        <div className="max-w-sm w-full text-center space-y-3">
          {view.kind === 'loading' && <Message title={t('cryptoCheckout.loadingTitle')} />}
          {view.kind === 'opening' && <Message title={t('cryptoCheckout.openingTitle')} body={t('cryptoCheckout.openingBody')} />}
          {view.kind === 'expired' && <Message title={t('cryptoCheckout.expiredTitle')} body={t('cryptoCheckout.expiredBody')} />}
          {view.kind === 'alreadyPro' && <Message title={t('cryptoCheckout.alreadyProTitle')} body={t('cryptoCheckout.alreadyProBody')} />}
          {view.kind === 'invalid' && <Message title={t('checkout.invalidTitle')} body={t('checkout.invalidBody')} />}
          {view.kind === 'demo' && (
            <>
              <Message title={t('cryptoCheckout.demoTitle')} body={t('cryptoCheckout.demoBody')} />
              <a href={DEMO_APP_URL} className="inline-block text-body font-semibold text-[#1E40AF] underline">
                {t('cryptoCheckout.demoLink')}
              </a>
            </>
          )}
          {view.kind === 'error' && (
            <>
              <Message title={t('cryptoCheckout.errorTitle')} body={t('cryptoCheckout.errorBody')} />
              <Button action="retry" onClick={view.retry}>
                {t('auth:signIn.tryAgain')}
              </Button>
            </>
          )}
        </div>
      )}
    </CheckoutPaper>
  );
}

function Message({ title, body }: { title: string; body?: string }) {
  return (
    <>
      <h1 className="text-heading font-semibold">{title}</h1>
      {body && <p className="text-body text-[#6A6152]">{body}</p>}
    </>
  );
}

function ConfirmStep({ view, onPay }: { view: Extract<View, { kind: 'confirm' }>; onPay: () => void }) {
  const { t } = useTranslation('billing');
  const [agreed, setAgreed] = useState(false);
  const price = view.priceCents === null ? null : (view.priceCents / 100).toFixed(view.priceCents % 100 === 0 ? 0 : 2);
  return (
    <CheckoutCard>
      <CheckoutHeader title={t('upgrade.payWithCrypto')} />
      <div className="px-4 py-4">
        <p className="text-body">
          {price === null ? (
            t('cryptoCheckout.loadingTitle')
          ) : (
            <Trans t={t} i18nKey="checkout.proLine" values={{ price }} components={{ brand: <Brand /> }} />
          )}
        </p>
        {/* No feature list here: the buyer comes from the Upgrade window,
            which just showed it. "Final" is said once, in the consent below. */}
        <p className="mt-3 text-start text-small leading-relaxed text-[#3F3A33]">{t('cryptoCheckout.coins')}</p>
        <AccountBlock pubkey={view.pubkey} />
        {/* The consent EU law asks for before a digital good starts at once.
            Spec: docs/internal/plans/crypto-payments.md (section 8, refunds) */}
        <div className="mt-4 border-t border-[#E0D7BD] pt-3 text-start">
          <Checkbox
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            label={<span className="text-small leading-relaxed">{t('cryptoCheckout.consent')}</span>}
          />
        </div>
      </div>
      <div className="bg-[#1E40AF] px-4 pt-4 pb-3">
        <CheckoutButton onClick={onPay} disabled={!agreed || price === null}>
          {t('checkout.confirmButton')}
        </CheckoutButton>
        {!agreed && <p className="mt-2.5 text-small text-[#B5D4F4]">{t('cryptoCheckout.consentNeeded')}</p>}
      </div>
    </CheckoutCard>
  );
}

// The receipt names one instant for every reader, in UTC; the waiting page
// shows when the link closes in the reader's own time, as the app writes it.
const format = {
  utc: (iso: string | null | undefined) =>
    iso
      ? `${new Intl.DateTimeFormat(dateLocale(), { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))} UTC` // date-ok: a purchase confirmation states one UTC instant, and this page runs without the account's date settings
      : '',
  local: (iso: string | null | undefined) => (iso ? formatInstant(iso, 'dateTime') : ''),
  usd: (cents: number | undefined) =>
    cents === undefined ? '' : new Intl.NumberFormat(activeLocale(), { style: 'currency', currency: 'USD' }).format(cents / 100),
};

/**
 * The Account ID this tab opened an order with, kept across the visit to
 * BlockBee, whose return address names the order only. Per tab, and only the
 * last order. Storage blocked: the page shows the state without the account.
 */
const ACCOUNT_KEY = 'privacynotes.cryptoCheckoutAccount';

function keepAccount(order: string, pubkey: string): void {
  try {
    sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify({ order, pubkey }));
  } catch {
    // See above.
  }
}

function keptAccount(order: string): string | null {
  try {
    const kept = JSON.parse(sessionStorage.getItem(ACCOUNT_KEY) ?? 'null') as { order?: unknown; pubkey?: unknown } | null;
    return kept?.order === order && typeof kept.pubkey === 'string' && HEX32_KEY.test(kept.pubkey) ? kept.pubkey : null;
  } catch {
    return null;
  }
}

/**
 * Where the payment stands, for the account the page vouches for. With no
 * Account ID (a bare link to an order), it offers no payment link: a link
 * whose account the page cannot name is not one to pay into.
 */
function Waiting({ status, pubkey }: { status: CryptoStatus; pubkey: string | null }) {
  const { t } = useTranslation('billing');
  const f = format;
  const time = f.local(status.expires_at);
  const [title, body] =
    status.state === 'seen'
      ? [t('cryptoCheckout.seenTitle'), t('cryptoCheckout.seenBody')]
      : status.state === 'partial'
        ? [t('cryptoCheckout.partialTitle'), t('cryptoCheckout.partialBody', { time })]
        : [t('cryptoCheckout.waitingTitle'), t('cryptoCheckout.waitingBody', { time })];
  return (
    <div className="max-w-sm w-full text-center space-y-3">
      <Message title={title} body={body} />
      {pubkey && <AccountBlock pubkey={pubkey} />}
      {pubkey && status.payment_url && (
        <a href={status.payment_url} className="inline-block text-body font-semibold text-[#1E40AF] underline">
          {t('cryptoCheckout.openPaymentPage')}
        </a>
      )}
      <p className="text-small text-[#6A6152]">{t('cryptoCheckout.updatesItself')}</p>
    </div>
  );
}

/**
 * The record the buyer keeps. We store no email address, so this page, saved
 * as a PDF, is the only copy they get. No transaction hash and no paying
 * address: a lost file then ties no wallet to the account.
 * Spec: docs/internal/plans/crypto-payments.md (section 11b, the return step)
 */
function Confirmation({ status, pubkey }: { status: CryptoStatus; pubkey: string | null }) {
  const { t } = useTranslation('billing');
  const f = format;
  const coin = status.paid_coin ? describeCoin(status.paid_coin) : null;
  const paidWith =
    coin && status.paid_amount
      ? coin.network
        ? t('cryptoCheckout.receipt.paidWithValue', { amount: status.paid_amount, token: coin.token, network: coin.network })
        : `${status.paid_amount} ${coin.token}`
      : null;
  const rows: Array<[string, string, boolean]> = [
    [t('cryptoCheckout.receipt.product'), t('cryptoCheckout.receipt.productValue'), false],
    [t('landing:header.price'), `${f.usd(status.amount_cents)} USD`, false],
    ...(paidWith ? ([[t('cryptoCheckout.receipt.paidWith'), paidWith, false]] as Array<[string, string, boolean]>) : []),
    ...(pubkey ? ([[t('settings:accountId.heading'), pubkey, true]] as Array<[string, string, boolean]>) : []),
    [t('cryptoCheckout.receipt.blockbeePayment'), status.payment_id ?? '', true],
  ];
  return (
    <div className="w-full max-w-lg rounded-2xl border border-[#E0D7BD] bg-white px-6 py-6 text-start text-body leading-relaxed print:max-w-none print:rounded-none print:border-0 print:px-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-row font-semibold">
          <Brand />
        </span>
        <span className="text-small text-[#6A6152]">{f.utc(status.paid_at ?? status.created_at)}</span>
      </div>
      <h1 className="mt-3 text-heading font-semibold">{t('cryptoCheckout.receipt.heading')}</h1>
      <p className="mt-1 text-small text-[#6A6152]">{t('cryptoCheckout.receipt.keep')}</p>
      <dl className="mt-4 divide-y divide-[#E0D7BD] border-y border-[#E0D7BD] text-small">
        {rows.map(([label, value, mono]) => (
          <div key={label} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 py-2">
            <dt className="text-[#6A6152]">{label}</dt>
            <dd className={mono ? 'break-all font-mono' : ''}>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 space-y-1.5 text-small">
        <p>{t('cryptoCheckout.receipt.proOn')}</p>
        <p>{t('cryptoCheckout.receipt.final')}</p>
        <p>{t('cryptoCheckout.receipt.withdrawal')}</p>
        <p className="text-[#6A6152]">
          <Trans
            t={t}
            i18nKey="cryptoCheckout.receipt.terms"
            values={{ url: 'lifetimelabs.dev/terms' }}
            components={{ a: <a href={TERMS_URL} className="underline" /> }}
          />
        </p>
      </div>
      <div className="mt-5 space-y-0.5 border-t border-[#E0D7BD] pt-3 text-small text-[#6A6152]">
        <p>{t('cryptoCheckout.receipt.seller', { seller: SELLER })}</p>
        <p>{t('cryptoCheckout.receipt.processor', { processor: PROCESSOR })}</p>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3 print:hidden">
        <Button variant="primary" icon={<Printer aria-hidden="true" />} onClick={() => window.print()}>
          {t('cryptoCheckout.receipt.savePdf')}
        </Button>
        <span className="text-small text-[#6A6152]">{t('cryptoCheckout.receipt.closeNote')}</span>
      </div>
    </div>
  );
}
