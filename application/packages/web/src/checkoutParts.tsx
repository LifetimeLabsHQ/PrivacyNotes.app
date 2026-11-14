/**
 * The parts both checkout pages draw: the card checkout (`CheckoutLauncher`,
 * Paddle) and the crypto checkout (`CryptoCheckoutLauncher`, BlockBee). They
 * live here so the crypto page shares the look without importing anything
 * that names Paddle: Paddle approved the crypto route on the condition that
 * it stays separate from theirs.
 *
 * Both pages are always the cream paper of the homepage, whatever the system
 * theme: a purchase should read as a welcome, and the dark neutral of the
 * app shell read as a warning. The values are the washi light set, which is
 * why these parts carry their own colors instead of the app's theme tokens.
 * Spec: docs/internal/design-decisions.md (washi landing palette),
 * docs/internal/plans/crypto-payments.md (sections 3d and 11b)
 */
import { Children, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ArrowRight, CheckFat, Confetti, Sparkle } from './icons';

/**
 * The page: cream paper in every theme, and plain white on paper when printed.
 * It sets the app's theme tokens to the washi values, so a standard part from
 * `ui/` (the consent Checkbox, a Button) draws in the checkout colors here.
 */
export function CheckoutPaper({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F7F1E1] text-[#1C1917] [--brand-ink:#1C1917] [--color-accent:#1E40AF] [--color-accent-fill:#1E40AF] [--color-accent-fill-hover:#1E3A8A] [--color-pn:#1C1917] [--color-pn-soft:#3F3A33] [--color-pn-muted:#6A6152] [--color-divider:#E0D7BD] [--color-surface-1:#FCF8EC] p-6 print:min-h-0 print:bg-white print:p-0">
      {children}
    </div>
  );
}

/** The card the confirm step sits in. */
export function CheckoutCard({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-sm w-full overflow-hidden rounded-2xl border border-[#E0D7BD] bg-[#F7F1E1] text-center">
      {children}
    </div>
  );
}

/** The blue header with the confetti. */
export function CheckoutHeader({ title }: { title: ReactNode }) {
  return (
    <div className="relative bg-[#1E40AF] px-4 pt-5 pb-4 text-white">
      <Sprinkles />
      <div className="flex items-start justify-center gap-1" aria-hidden="true">
        <Confetti size={34} weight="fill" className="text-[#5DCAA5]" />
        <Sparkle size={20} weight="fill" className="text-[#ED93B1]" />
      </div>
      <h1 className="mt-1.5 text-display font-semibold">{title}</h1>
    </div>
  );
}

/** What Pro adds, as the card checkout lists it. */
export function ProBenefits() {
  const { t } = useTranslation('billing');
  return (
    <>
      <Benefit title={t('checkout.benefitDevices')} sub={t('checkout.benefitDevicesSub')} />
      <Benefit title={t('checkout.benefitStorage')} sub={t('checkout.benefitStorageSub')} />
      <Benefit title={t('checkout.benefitMore')} sub={t('checkout.benefitMoreSub')} />
    </>
  );
}

/**
 * The account the purchase lands on: the short id, where to compare it, and
 * the full id on request. The pubkey arrives as a URL parameter, so a link
 * somebody else wrote could name somebody else's account; this block is how
 * the reader checks it before paying.
 */
export function AccountBlock({ pubkey }: { pubkey: string }) {
  const { t } = useTranslation('billing');
  return (
    <div className="mt-4 border-t border-[#E0D7BD] pt-3 text-start text-small leading-relaxed text-[#3F3A33]">
      <p className="flex items-center gap-2">
        {t('checkout.yourAccount')}
        <span className="rounded-md bg-[#E8EAF2] px-2 py-0.5 font-mono text-body text-[#1E40AF]">
          {pubkey.slice(0, 8)}
        </span>
      </p>
      <p className="mt-1.5">
        <Trans t={t} i18nKey="checkout.matchAccount" components={{ b: <MenuPath /> }} />
      </p>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[#1E40AF]">{t('checkout.showFullId')}</summary>
        <code className="mt-1.5 block break-all rounded-md bg-[#FCF8EC] px-2 py-1.5 font-mono text-[#1C1917]">
          {pubkey}
        </code>
      </details>
    </div>
  );
}

/** The white button on the blue footer, with the arrow that nudges on hover. */
export function CheckoutButton({ onClick, disabled = false, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-center justify-center gap-2.5 rounded-xl bg-white px-4 py-3 text-row font-semibold text-[#1E40AF] transition duration-200 hover:-translate-y-0.5 hover:ring-[3px] hover:ring-[#5DCAA5] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#5DCAA5] active:translate-y-0 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:ring-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      {children}
      <span className={ARROW_NUDGE}>
        <ArrowRight weight="bold" aria-hidden="true" />
      </span>
    </button>
  );
}

/** Check, pay, Pro: where the reader is. */
export function CheckoutSteps() {
  const { t } = useTranslation('billing');
  return (
    <ol aria-label={t('checkout.stepsLabel')} className="mt-2.5 flex items-center justify-center gap-1.5 text-small text-[#B5D4F4]">
      <li className="text-white" aria-current="step">1 {t('checkout.stepCheck')}</li>
      <li aria-hidden="true">›</li>
      <li>2 {t('checkout.stepPay')}</li>
      <li aria-hidden="true">›</li>
      <li>3 {t('checkout.stepPro')}</li>
    </ol>
  );
}

// The arrow nudges toward the reading direction on hover; the rtl variant
// flips it, so the physical axis is deliberate.
const ARROW_NUDGE =
  'flex size-6 items-center justify-center rounded-full bg-[#1E40AF] text-white transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] ' +
  'group-hover:translate-x-1 rtl:group-hover:-translate-x-1 motion-reduce:group-hover:translate-x-0'; // rtl-ok: flipped by the rtl variant

/**
 * A menu path in bold, drawn with the chevron the settings breadcrumbs use.
 * The catalog keeps the plain " > " form, because that is the form the
 * menu-path check reads in every locale.
 */
function MenuPath({ children }: { children?: ReactNode }) {
  return (
    <strong className="font-semibold text-[#1C1917]">
      {Children.map(children, (c) => (typeof c === 'string' ? c.replaceAll(' > ', ' › ') : c))}
    </strong>
  );
}

export function Benefit({ title, sub }: { title: string; sub: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[#10B981] text-white" aria-hidden="true">
        <CheckFat size={11} weight="fill" />
      </span>
      <span className="text-body leading-snug">
        <span className="block font-semibold">{title}</span>
        <span className="block text-small text-[#6A6152]">{sub}</span>
      </span>
    </li>
  );
}

/** A few pieces of confetti in the header. Decoration only. */
const SPRINKLES = [
  'top-3 start-4 h-2.5 w-1.5 rotate-[25deg] bg-[#5DCAA5]',
  'top-11 start-11 size-1.5 rounded-full bg-[#ED93B1]',
  'top-4 end-5 h-2.5 w-1.5 -rotate-[30deg] bg-white',
  'top-12 end-11 size-1.5 rounded-full bg-[#5DCAA5]',
  'top-16 start-6 h-2 w-1 rotate-[60deg] bg-white/70',
  'top-16 end-6 h-2 w-1 rotate-[15deg] bg-[#ED93B1]',
];

function Sprinkles() {
  return (
    <>
      {SPRINKLES.map((c) => (
        <span key={c} aria-hidden="true" className={`absolute rounded-[2px] ${c}`} />
      ))}
    </>
  );
}
