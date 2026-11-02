import { VaultFieldAction } from './ui/VaultFieldAction';
import { VaultFormActions } from './ui/VaultFormActions';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasPin } from './pin';
import { PinInfoModal } from './PinInfoModal';
import { Calendar, CreditCard, Info, Lock, MapPin, NotePencil, User } from './icons';
import { useCopyToClipboard } from './clipboard';
import { FIELD_CLASS, FieldLabel } from './formFields';

export { parseCardBody, serializeCardBody, detectCardNetwork, type CardData } from './cardBody';
import { parseCardBody, serializeCardBody, detectCardNetwork, type CardData } from './cardBody';

/** Max digit length by network: 15 for Amex, 16 for all others. */
function maxDigitsForNetwork(digits: string): number {
  const n2 = Number(digits.slice(0, 2));
  return (n2 === 34 || n2 === 37) ? 15 : 16;
}

/** Format card number with spaces every 4 digits. */
function formatCardNumber(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.replace(/(.{4})/g, '$1 ').trim();
}

/** Derive a display title like "Visa ending in 4242". */
function deriveCardTitle(data: CardData): string {
  const digits = data.cardNumber.replace(/\D/g, '');
  if (digits.length < 4) return '';
  const last4 = digits.slice(-4);
  const network = detectCardNetwork(digits);
  return network ? `${network} ending in ${last4}` : `Card ending in ${last4}`;
}

/* ────────────────────────────────────────────────────────────────
 * CardForm - the editor replacement for card-type notes.
 * ──────────────────────────────────────────────────────────────── */
interface CardFormProps {
  noteId: string;
  title: string;
  body: string;
  locked: boolean;
  pinProtected: boolean;
  onTitleChange: (id: string, title: string) => void;
  onBodyChange: (id: string, body: string) => void;
  onPinProtectedChange: (id: string, value: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
  isNew: boolean;
  saveError?: string;
}

export function CardForm({
  noteId,
  title,
  body,
  locked,
  pinProtected,
  onTitleChange,
  onBodyChange,
  onPinProtectedChange,
  onSave,
  onCancel,
  isNew,
  saveError,
}: CardFormProps) {
  const { t } = useTranslation('common');
  const data = parseCardBody(body);
  const { copy, copied } = useCopyToClipboard();
  // Never memoize this. Settings opens over a mounted form, so a PIN
  // can appear or vanish while the toggle below is on screen, and
  // localStorage fires nothing that would refresh a frozen value.
  const pinConfigured = hasPin();
  const [showPinInfo, setShowPinInfo] = useState(false);
  const [showNumber, setShowNumber] = useState(false);
  const [numberFocused, setNumberFocused] = useState(false);
  const [showCvv, setShowCvv] = useState(false);

  const updateBody = useCallback(
    (patch: Partial<CardData>) => {
      const next = { ...data, ...patch };
      onBodyChange(noteId, serializeCardBody(next, body));
    },
    [noteId, data, body, onBodyChange]
  );

  /** Auto-derive title from card number on blur. */
  const handleNumberBlur = useCallback(() => {
    if (!title.trim()) {
      const derived = deriveCardTitle(data);
      if (derived) onTitleChange(noteId, derived);
    }
  }, [noteId, title, data, onTitleChange]);

  /** Soft expired-card hint - informational, not blocking. */
  const isExpired = (() => {
    if (!data.expMonth || !data.expYear) return false;
    const now = new Date();
    const expYearFull = 2000 + Number(data.expYear);
    const expMonth = Number(data.expMonth);
    // Card expires at end of its expiry month.
    if (expYearFull < now.getFullYear()) return true;
    if (expYearFull === now.getFullYear() && expMonth < now.getMonth() + 1) return true;
    return false;
  })();

  const fieldClass = FIELD_CLASS;

  const maskedNumber = data.cardNumber.replace(/\D/g, '').length > 4
    ? '•••• '.repeat(Math.floor((data.cardNumber.replace(/\D/g, '').length - 4) / 4)) +
      (data.cardNumber.replace(/\D/g, '').length % 4 > 0 && data.cardNumber.replace(/\D/g, '').length > 4
        ? '•'.repeat((data.cardNumber.replace(/\D/g, '').length - 4) % 4) + ' '
        : '') +
      data.cardNumber.replace(/\D/g, '').slice(-4)
    : data.cardNumber;

  return (
    /* Width comes from VAULT_COLUMN on the VaultItem wrapper. */
    <div className="flex-1 overflow-y-auto p-6">
      <div className="space-y-4">
        {/* Cardholder Name */}
        <div>
          <FieldLabel icon={<User />}>{t('cardForm.cardholderName')}</FieldLabel>
          <input
            type="text"
            value={data.cardholderName}
            onChange={(e) => updateBody({ cardholderName: e.target.value.replace(/[0-9]/g, '') })}
            placeholder={t('cardForm.cardholderPlaceholder')}
            disabled={locked}
            autoComplete="off"
            className={fieldClass}
          />
        </div>

        {/* Card Number */}
        <div>
          <FieldLabel icon={<CreditCard />}>{t('cardForm.cardNumber')}</FieldLabel>
          <div className="flex gap-1.5">
              <input
                type="text"
                value={showNumber || numberFocused ? formatCardNumber(data.cardNumber) : maskedNumber}
                onChange={(e) => {
                  const raw = e.target.value.replace(/\D/g, '');
                  const max = maxDigitsForNetwork(raw);
                  updateBody({ cardNumber: raw.slice(0, max) });
                }}
                onFocus={() => setNumberFocused(true)}
                onBlur={() => { setNumberFocused(false); handleNumberBlur(); }}
                placeholder={t('cardForm.cardNumberPlaceholder')}
                disabled={locked}
                autoComplete="off"
                inputMode="numeric"
                className={`${fieldClass} font-mono`}
              />
              <VaultFieldAction kind="reveal" active={showNumber} title={showNumber ? t('cardForm.hideNumber') : t('cardForm.showNumber')} onClick={() => setShowNumber(!showNumber)} />
            <VaultFieldAction kind="copy"
              onClick={() => copy(data.cardNumber, 'number')}
              active={copied === 'number'}
              title={t('cardForm.copyCardNumber')}
            />
          </div>
          {data.cardNumber && (() => {
            const digits = data.cardNumber.replace(/\D/g, '');
            const network = detectCardNetwork(data.cardNumber);
            const tooShort = digits.length > 0 && digits.length < 13;
            return (
              <>
                <div className="mt-1 text-small text-pn-muted">
                  {network || t('cardForm.unknownNetwork')}
                </div>
                {tooShort && (
                  <div className="mt-0.5 text-meta text-warning">
                    {t('cardForm.numberTooShort', { count: digits.length, expected: maxDigitsForNetwork(digits) })}
                  </div>
                )}
              </>
            );
          })()}
        </div>

        {/* Expiry + CVV row */}
        <div className="flex gap-3">
          <div className="flex-1">
            <FieldLabel icon={<Calendar />}>{t('cardForm.expiry')}</FieldLabel>
            <div className="flex gap-1.5">
              <select
                value={data.expMonth}
                onChange={(e) => updateBody({ expMonth: e.target.value })}
                disabled={locked}
                className={`${fieldClass} appearance-none`}
              >
                <option value="">{t('cardForm.monthPlaceholder')}</option>
                {Array.from({ length: 12 }, (_, i) => {
                  const m = String(i + 1).padStart(2, '0');
                  return <option key={m} value={m}>{m}</option>;
                })}
              </select>
              <select
                value={data.expYear}
                onChange={(e) => updateBody({ expYear: e.target.value })}
                disabled={locked}
                className={`${fieldClass} appearance-none`}
              >
                <option value="">{t('cardForm.yearPlaceholder')}</option>
                {Array.from({ length: 12 }, (_, i) => {
                  const y = String(new Date().getFullYear() + i).slice(-2);
                  return <option key={y} value={y}>{y}</option>;
                })}
              </select>
            </div>
          </div>
          <div className="w-28">
            <FieldLabel icon={<Lock />}>{t('cardForm.cvv')}</FieldLabel>
            <div className="flex gap-1.5">
              <input
                type={showCvv ? 'text' : 'password'}
                value={data.cvv}
                onChange={(e) => updateBody({ cvv: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                placeholder={t('cardForm.cvvPlaceholder')}
                disabled={locked}
                autoComplete="off"
                inputMode="numeric"
                maxLength={4}
                className={`${fieldClass} font-mono`}
              />
              <VaultFieldAction kind="reveal" active={showCvv} title={showCvv ? t('cardForm.hideCvv') : t('cardForm.showCvv')} onClick={() => setShowCvv(!showCvv)} />
            </div>
          </div>
        </div>

        {isExpired && (
          <p className="text-meta text-warning -mt-2">{t('cardForm.expiredHint')}</p>
        )}

        {/* Billing Zip */}
        <div>
          <FieldLabel icon={<MapPin />}>{t('cardForm.billingZip')}</FieldLabel>
          <input
            type="text"
            value={data.billingZip}
            onChange={(e) => updateBody({ billingZip: e.target.value })}
            placeholder={t('cardForm.billingZipPlaceholder')}
            disabled={locked}
            autoComplete="off"
            className={fieldClass}
          />
        </div>

        {/* Notes */}
        <div>
          <FieldLabel icon={<NotePencil />}>{t('cardForm.notes')}</FieldLabel>
          <textarea
            value={data.notes}
            onChange={(e) => updateBody({ notes: e.target.value })}
            placeholder={t('cardForm.notesPlaceholder')}
            disabled={locked}
            rows={3}
            className={`${fieldClass} resize-y`}
          />
        </div>

        {/* PIN-protect toggle */}
        <label className={`flex items-center gap-2 pt-2 border-t border-divider ${!pinConfigured && !pinProtected ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
          <input
            type="checkbox"
            checked={pinProtected}
            onChange={(e) => onPinProtectedChange(noteId, e.target.checked)}
            // Read-only locks CONTENT, not protection: toggling the PIN gate
            // changes no data, so it stays available on a locked item.
            disabled={!pinConfigured && !pinProtected}
            className="rounded accent-accent"
          />
          <span className="text-body text-pn-muted">
            {t('cardForm.requirePin')}
          </span>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); setShowPinInfo(true); }}
            className="text-accent/60 hover:text-accent transition p-1 -m-1"
            aria-label={t('cardForm.whatDoesThisDo')}
          >
            <Info />
          </button>
        </label>

        {showPinInfo && <PinInfoModal onClose={() => setShowPinInfo(false)} />}
        {!pinConfigured && !pinProtected && (
          <p className="text-meta text-pn-muted -mt-2">
            {t('cardForm.setUpPinFirst')}
          </p>
        )}

        <VaultFormActions locked={locked} isNew={isNew} saveError={saveError} onSave={onSave} onCancel={onCancel} />
      </div>
    </div>
  );
}
