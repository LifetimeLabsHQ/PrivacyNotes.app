import { useId, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useEscapeToClose } from './useEscapeToClose';
import { ArrowsOutSimple, ClockCounterClockwise, CreditCard, CurrencyBtc, Columns, Database, Folder, Lock, Monitor, Palette } from './icons';
import { isPaddleConfigured, isBetaPricing } from './paddle';
import { startProCheckout, startCryptoProCheckout, cryptoCheckoutOffered, PRO_PRODUCT_ID, isNativeStoreBuild } from './billing';
import { CRYPTO_TICKERS } from './cryptoCheckout';
import { PRO_PRICE, EARLY_PRICE } from './pricing';
import { useStorePrices } from './storePrices';
import { isDemoMode, DEMO_APP_URL } from './demo';
import { withSource } from './campaignSource';
import { Callout } from './ui';
import { CloseButton } from './ui/Button';

type Props = {
  onClose: () => void;
  /** The user's hex pubkey - forwarded to Paddle as customData. */
  pubkey: string;
  /** Called after a successful checkout to refresh pro status. `silent` skips
   *  the "payment received, activation pending" banner (desktop return path,
   *  which fires whether or not the user actually paid). */
  onCheckoutComplete: (opts?: { silent?: boolean }) => void;
};

/** What Pro adds, in the order of the pass. Every Pro gate opens the same
 *  window, so the list is the whole offer. A label another screen already
 *  says is that screen's key (rule AD). */
const FEATURES: Array<{ icon: ReactNode; labelKey: string }> = [
  { icon: <Monitor aria-hidden="true" />, labelKey: 'checkout.benefitDevices' },
  { icon: <Folder aria-hidden="true" />, labelKey: 'upgrade.features.folders' },
  { icon: <Columns aria-hidden="true" />, labelKey: 'settings:appearance.spacesTitle' },
  { icon: <Lock aria-hidden="true" />, labelKey: 'upgrade.features.lock' },
  { icon: <ClockCounterClockwise aria-hidden="true" />, labelKey: 'upgrade.features.history' },
  { icon: <Palette aria-hidden="true" />, labelKey: 'upgrade.features.themes' },
  { icon: <ArrowsOutSimple aria-hidden="true" />, labelKey: 'common:palette.commands.zen' },
  { icon: <Database aria-hidden="true" />, labelKey: 'checkout.benefitStorage' },
];

/** The facts on the stub of the pass. */
const PASS_FACTS = [
  { labelKey: 'upgrade.pass.valid', valueKey: 'upgrade.pass.forever' },
  { labelKey: 'upgrade.pass.renews', valueKey: 'upgrade.pass.never' },
  { labelKey: 'upgrade.pass.devices', valueKey: 'upgrade.pass.unlimited' },
] as const;

/** The pay buttons: a two-line row with the method and what it takes. */
const PAY_ROW = 'w-full grid grid-cols-[auto_1fr] items-center gap-x-3 rounded-lg border px-4 py-3 text-start transition disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * The Pro window: a lifetime pass. One window for every Pro gate, with no
 * line about the feature that opened it. The headline carries the price,
 * the stub carries what a subscription cannot claim, and each way to pay is
 * one click. On a phone it is a sheet at the bottom of the screen.
 * Spec: docs/internal/design/patterns/181-190.md section 189
 */
export function UpgradeModal({ onClose, pubkey, onCheckoutComplete }: Props) {
  const { t } = useTranslation('billing');
  useEscapeToClose(onClose);
  const titleId = useId();
  const [loading, setLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const configured = isPaddleConfigured();

  const nativeStore = isNativeStoreBuild();
  const storePrices = useStorePrices();
  const storePro = storePrices?.[PRO_PRODUCT_ID]?.formatted ?? null;

  const demo = isDemoMode();
  // The price the person pays today: the store's own figure on a store build,
  // else the Paddle price. No "was" price: the window names one number.
  const price = storePro ?? (nativeStore ? '…' : `$${isBetaPricing() ? EARLY_PRICE : PRO_PRICE}`);
  // A second way to pay only where it exists: never in the demo or a store build.
  // Spec: docs/internal/plans/crypto-payments.md (11b)
  const showCrypto = !demo && cryptoCheckoutOffered();
  // The card line names the methods Paddle shows; a store and the demo have their own.
  const showCardMethods = !demo && !nativeStore;

  async function handleUpgrade() {
    // Demo has no account to attach a purchase to - send the user to
    // sign up on the real app instead of opening checkout.
    if (demo) {
      window.location.href = withSource(DEMO_APP_URL);
      return;
    }
    if (!configured) return;
    setLoading(true);
    setPurchaseError(null);
    try {
      await startProCheckout(
        pubkey,
        () => {
          onCheckoutComplete();
          onClose();
        },
        () => {
          // Desktop return from the browser checkout: re-check Pro silently
          // (the user may have cancelled), then close. No payment banner.
          onCheckoutComplete({ silent: true });
          onClose();
        },
        // Native IAP failure: keep the modal open and say what happened. A
        // silent failure makes the buy button look dead (Play internal test).
        (reason) => setPurchaseError(t(`purchaseError.${reason}`)),
      );
    } catch (err) {
      console.error('Paddle checkout error:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      /* Stacked overlay, not the standard one: a Pro gate can sit inside
         another modal, and the pitch is always the thing to read on top.
         Spec: docs/internal/design/ui-patterns.md (z-index tier system) */
      className="fixed inset-0 bg-black/40 dark:bg-black/40 flex items-end sm:items-center justify-center sm:p-6 z-[55]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full sm:max-w-3xl max-h-[92vh] overflow-y-auto bg-surface-2 border border-divider text-pn rounded-t-2xl sm:rounded-xl grid sm:grid-cols-[1fr_12.5rem] pb-[env(safe-area-inset-bottom)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute top-3 end-3 z-10">
          <CloseButton onClick={onClose} />
        </div>

        {/* The stub: a strip on top on a phone, the right end of the ticket
            on a wider window. The dashed edge is the tear line. */}
        <div className="relative bg-amber-50 dark:bg-amber-950/50 border-b-2 sm:border-b-0 sm:border-s-2 border-dashed border-amber-900/15 dark:border-amber-100/15 px-4 pt-5 pb-4 sm:px-5 sm:py-7 grid gap-3.5 sm:content-center sm:justify-items-center sm:text-center sm:order-2 rounded-t-2xl sm:rounded-none">
          <div className="flex sm:flex-col items-center gap-2 pe-10 sm:pe-0">
            <span className="text-meta font-bold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">{t('upgrade.pass.label')}</span>
            <span className="rounded px-1.5 py-0.5 text-meta font-extrabold uppercase tracking-wider bg-amber-700 text-white sm:bg-transparent sm:p-0 sm:text-display-3 sm:tracking-tight sm:text-amber-950 sm:dark:text-amber-50">{t('checkout.stepPro')}</span>
          </div>
          <dl className="grid grid-cols-3 sm:grid-cols-1 sm:w-full sm:mt-2 sm:gap-1.5">
            {PASS_FACTS.map((f, i) => (
              <div
                key={f.labelKey}
                className={`grid gap-0.5 sm:flex sm:justify-between sm:gap-3 sm:pb-1.5 sm:last:pb-0 sm:border-b sm:last:border-b-0 sm:border-amber-900/15 sm:dark:border-amber-100/15 ${i > 0 ? 'ps-3 border-s border-amber-900/15 dark:border-amber-100/15 sm:ps-0 sm:border-s-0' : ''}`}
              >
                <dt className="text-meta font-bold uppercase tracking-wider sm:normal-case sm:tracking-normal sm:font-normal text-amber-700 dark:text-amber-300">{t(f.labelKey)}</dt>
                <dd className="m-0 text-body font-bold text-amber-950 dark:text-amber-50">{t(f.valueKey)}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="px-4 pt-5 pb-4 sm:p-7 grid gap-4 sm:gap-5 content-start">
          <h2 id={titleId} className="m-0 text-display-5 font-black tracking-tighter text-pn">
            <span className="block">
              <Trans t={t} i18nKey="upgrade.headlinePrice" values={{ price }} components={{ price: <span className="text-pro" /> }} />
            </span>
            <span className="block">{t('upgrade.headlineLife')}</span>
          </h2>

          <ul className="grid grid-cols-2 gap-x-3 gap-y-2">
            {FEATURES.map((f) => (
              <li key={f.labelKey} className="flex items-center gap-2 text-compact">
                <span className="shrink-0 text-pro">{f.icon}</span>
                <span>{t(f.labelKey)}</span>
              </li>
            ))}
          </ul>

          {purchaseError && <Callout tone="danger">{purchaseError}</Callout>}

          <div className="grid gap-2">
            <button
              type="button"
              disabled={(!configured && !demo) || loading}
              onClick={handleUpgrade}
              className={`${PAY_ROW} border-transparent bg-amber-700 text-white hover:bg-amber-800`}
            >
              {demo ? <IconUpgrade size={18} onFill /> : <CreditCard size={20} aria-hidden="true" className={showCardMethods ? 'row-span-2' : ''} />}
              <span className="text-body font-bold">
                {demo
                  ? t('upgrade.ctaSignUp')
                  : loading
                    ? t('upgrade.ctaOpening')
                    : t('upgrade.ctaUnlockPrice', { price })}
              </span>
              {showCardMethods && <span className="col-start-2 text-meta text-white/80">{t('upgrade.cardMethods')}</span>}
            </button>
            {showCrypto && (
              <button
                type="button"
                onClick={() => {
                  startCryptoProCheckout(pubkey);
                  onClose();
                }}
                className={`${PAY_ROW} border-divider bg-surface-1 text-pn hover:bg-amber-50 dark:hover:bg-amber-950/30`}
              >
                <CurrencyBtc size={20} aria-hidden="true" className="row-span-2 text-pro" />
                <span className="text-body font-bold">{t('upgrade.payWithCrypto')}</span>
                {/* Tickers, not names: a new coin is one more word on this line. */}
                <span className="col-start-2 text-meta text-pn-muted tabular-nums">{CRYPTO_TICKERS.join(' · ')}</span>
              </button>
            )}
          </div>

          {/* Legal links on the purchase surface. Pro is a one-time
              non-consumable, so App Review 3.1.2 does not demand them here,
              but the two purchase surfaces should not disagree about where
              the terms are. The refund line is Paddle's and BlockBee's;
              a store build has its own. */}
          <p className="text-meta text-pn-muted text-center leading-relaxed">
            {showCardMethods && <>{showCrypto ? t('upgrade.refundNoteBoth') : t('upgrade.refundNoteCard')}{' · '}</>}
            <a href="https://lifetimelabs.dev/terms/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              {t('landing:about.termsOfService')}
            </a>
            {' · '}
            <a href="https://lifetimelabs.dev/privacy/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              {t('landing:about.privacyPolicy')}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

/** Which Pro gate opened the window. The window itself shows the same pass
 *  for every gate; NotesView keeps the value for what happens around it: the
 *  zen preview behind the window and the theme builder's return after it. */
export type UpgradeTrigger =
  | 'lock' | 'protect' | 'history' | 'devices' | 'zen' | 'theme' | 'storage'
  | 'fileSize' | 'folders' | 'looks' | 'noteIcon' | 'spaces' | 'formatBar' | 'totp' | 'replace' | 'passphrase' | 'alerts' | 'vaultFiles' | 'cli' | 'browsers' | 'smartConnections' | null;

// The Pro mark lives in proMark.tsx, a leaf the UI parts import without this
// window and its billing code.
export { IconUpgrade, ProGlyph, ProMark } from './proMark';
import { IconUpgrade } from './proMark';
