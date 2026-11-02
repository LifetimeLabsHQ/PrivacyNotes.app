/**
 * The card's stored body: the JSON blob a card-type note keeps, its parser,
 * its serializer and the network detection. Split from CardForm.tsx so a
 * module without a window (the extension copy writer, the exports) can read
 * a card without loading the form, its icons and the app's i18n.
 */
import { storedVaultKeys } from './vaultBody';

/* ────────────────────────────────────────────────────────────────
 * CardData - the JSON blob stored in the note body for card-type
 * notes. The note's `title` field serves as the display name
 * (e.g. "Visa ending in 4242") and is auto-derived from the card
 * number when empty.
 * ──────────────────────────────────────────────────────────────── */
export interface CardData {
  cardholderName: string;
  cardNumber: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  billingZip: string;
  notes: string;
}

export function parseCardBody(body: string): CardData {
  try {
    const p = JSON.parse(body);
    return {
      cardholderName: typeof p.cardholderName === 'string' ? p.cardholderName : '',
      cardNumber: typeof p.cardNumber === 'string' ? p.cardNumber : '',
      expMonth: typeof p.expMonth === 'string' ? p.expMonth : '',
      expYear: typeof p.expYear === 'string' ? p.expYear : '',
      cvv: typeof p.cvv === 'string' ? p.cvv : '',
      billingZip: typeof p.billingZip === 'string' ? p.billingZip : '',
      notes: typeof p.notes === 'string' ? p.notes : '',
    };
  } catch {
    return { cardholderName: '', cardNumber: '', expMonth: '', expYear: '', cvv: '', billingZip: '', notes: '' };
  }
}

/** `previous` is the stored body; keys a newer version wrote in it are kept. */
export function serializeCardBody(data: CardData, previous = ''): string {
  return JSON.stringify({ ...storedVaultKeys(previous), ...data });
}

/** Detect card network from the first digits (BIN). */
export function detectCardNetwork(num: string): string {
  const d = num.replace(/\D/g, '');
  if (!d) return '';
  const n2 = Number(d.slice(0, 2));
  const n4 = Number(d.slice(0, 4));
  const n6 = Number(d.slice(0, 6));
  if (d.startsWith('4')) return 'Visa';
  if ((n2 >= 51 && n2 <= 55) || (n6 >= 222100 && n6 <= 272099)) return 'Mastercard';
  if (n2 === 34 || n2 === 37) return 'Amex';
  if (n2 === 36 || (n2 >= 38 && n2 <= 39) || (n4 >= 3000 && n4 <= 3059) || (n4 >= 3095 && n4 <= 3095) || (n4 >= 3600 && n4 <= 3699)) return 'Diners';
  if (n4 >= 6011 || n2 === 65 || (n6 >= 644000 && n6 <= 649999)) return 'Discover';
  if (n4 >= 3528 && n4 <= 3589) return 'JCB';
  return '';
}
