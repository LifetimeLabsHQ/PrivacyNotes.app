/**
 * The app's side of a crypto payment: while an order is open on this device,
 * a banner says where the payment stands and Pro turns on when it confirms.
 *
 * The card checkout can rely on an 18-second poll of Pro itself, because a
 * card settles at once. A Bitcoin payment takes 10 to 60 minutes to confirm,
 * so this asks the server about the order instead: every 10 seconds for the
 * first 10 minutes, then every 30, while the app is visible, until an hour
 * after the link expires. The status read also grants Pro when BlockBee says
 * paid, so a webhook that never arrives still unlocks it.
 *
 * A new order is registered here first, with the session: the server then
 * lets the order pay for this account only (crypto-checkout `register`). The
 * page waits for that on its confirm step.
 *
 * Never in the demo: `pendingCryptoOrder` answers null there and nothing is
 * called (docs/internal/agent-rules.md, section 4).
 * Spec: docs/internal/plans/crypto-payments.md (section 11b, the app)
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';
import {
  CRYPTO_ORDER_EVENT,
  cryptoCheckoutPage,
  cryptoCheckoutStatus,
  cryptoWaitGoesOn,
  forgetCryptoOrder,
  noteCryptoOrder,
  pendingCryptoOrder,
  registerCryptoOrder,
  type CryptoState,
  type CryptoStatus,
} from '../cryptoCheckout';
import { cryptoCheckoutReleased } from '../cryptoRelease';
import { openExternal } from '../openExternal';
import { Banner, FeedbackButton } from '../ui';

const FAST_MS = 10_000;
const SLOW_MS = 30_000;
const FAST_FOR_MS = 10 * 60 * 1000;

// A registration the server refused for good; any other failure is retried
// on the next tick.
const FINAL_REFUSALS = new Set([
  'already_pro',
  'refused',
  'order_taken',
  'too_many_orders',
  'missing_token',
  'invalid_session',
  'pubkey_not_linked',
  'bad_request',
]);

type Shown = { order: string; state: CryptoState | 'ended'; paymentUrl: string | null };

export function CryptoPaymentBanner({
  pubkey,
  isPro,
  onPaid,
}: {
  pubkey: string | null | undefined;
  isPro: boolean;
  onPaid: () => void;
}) {
  const { t } = useTranslation('notes');
  const { supabase } = useAuth();
  const [shown, setShown] = useState<Shown | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  // A new order from the Upgrade window starts a new wait.
  useEffect(() => {
    const onOrder = () => setGeneration((g) => g + 1);
    window.addEventListener(CRYPTO_ORDER_EVENT, onOrder);
    return () => window.removeEventListener(CRYPTO_ORDER_EVENT, onOrder);
  }, []);

  useEffect(() => {
    // Release switch off: no order can start, so nothing to wait for.
    if (!cryptoCheckoutReleased()) return;
    const pending = pendingCryptoOrder(pubkey);
    if (!pending) return;
    // Pro from another route meanwhile: nothing left to wait for.
    if (isPro) {
      forgetCryptoOrder();
      return;
    }
    let timer: number | null = null;
    let stopped = false;

    const schedule = () => {
      if (stopped || document.hidden) return;
      const fast = Date.now() - pending.startedAt < FAST_FOR_MS;
      timer = window.setTimeout(() => void tick(), fast ? FAST_MS : SLOW_MS);
    };

    const tick = async () => {
      timer = null;
      if (!pending.registered) {
        const token = (await supabase.auth.getSession()).data.session?.access_token;
        const reg = token ? await registerCryptoOrder(pending.order, token) : ({ ok: false, code: 'missing_token' } as const);
        if (stopped) return;
        if (!reg.ok) {
          if (!FINAL_REFUSALS.has(reg.code)) return schedule();
          forgetCryptoOrder();
          // Pro already: let the app see it.
          if (reg.code === 'already_pro') onPaidRef.current();
          return;
        }
        noteCryptoOrder(pending.order, reg.data.expires_at);
        pending.registered = true;
      }
      const res = await cryptoCheckoutStatus(pending.order);
      if (stopped) return;
      if (!res.ok) return schedule();
      const status: CryptoStatus = res.data;
      noteCryptoOrder(pending.order, status.expires_at);
      if (status.state === 'paid') {
        forgetCryptoOrder();
        setShown({ order: pending.order, state: 'paid', paymentUrl: null });
        onPaidRef.current();
        return;
      }
      if (!cryptoWaitGoesOn(status)) {
        forgetCryptoOrder();
        setShown({ order: pending.order, state: 'ended', paymentUrl: null });
        return;
      }
      setShown({ order: pending.order, state: status.state, paymentUrl: status.payment_url ?? null });
      schedule();
    };

    const onVisibility = () => {
      if (!document.hidden && timer === null) void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pubkey, isPro, generation, supabase]);

  if (!shown) return null;
  const key = `${shown.order}:${shown.state}`;
  if (dismissed === key) return null;

  const tone = shown.state === 'paid' ? 'success' : shown.state === 'partial' || shown.state === 'ended' ? 'warning' : 'info';
  const text =
    shown.state === 'paid'
      ? t('banner.crypto.paid')
      : shown.state === 'seen'
        ? t('banner.crypto.seen')
        : shown.state === 'partial'
          ? t('banner.crypto.partial')
          : shown.state === 'ended' || shown.state === 'expired'
            ? t('banner.crypto.ended')
            : t('banner.crypto.waiting');

  const action =
    shown.state === 'paid' ? (
      <FeedbackButton
        action="open"
        onClick={() =>
          openExternal(cryptoCheckoutPage(`order=${encodeURIComponent(shown.order)}&pubkey=${encodeURIComponent(pubkey ?? '')}`))
        }
      >
        {t('billing:cryptoCheckout.receipt.heading')}
      </FeedbackButton>
    ) : shown.paymentUrl ? (
      <FeedbackButton action="open" onClick={() => openExternal(shown.paymentUrl!)}>
        {t('banner.crypto.openPayment')}
      </FeedbackButton>
    ) : undefined;

  return (
    <Banner tone={tone} action={action} onDismiss={() => setDismissed(key)} dismissLabel={t('common:updateToast.dismiss')}>
      {text}
    </Banner>
  );
}
