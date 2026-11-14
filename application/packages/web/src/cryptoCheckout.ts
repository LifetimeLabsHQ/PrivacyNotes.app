/**
 * The client side of the crypto checkout: the calls to the `crypto-checkout`
 * edge function, the order the app is waiting on, and how a coin is named.
 *
 * The app makes a random order id, registers it with its session (so the
 * order can only ever pay for this account), and opens /crypto-checkout on
 * the apex with it and the pubkey. The page asks the server to open a
 * BlockBee checkout for that order, and the app polls the same order until
 * the payment confirms. The order id travels to BlockBee in the return
 * address; nothing the server answers for an order id names the account, so
 * the page shows the Account ID it was opened with.
 *
 * Nothing here names Paddle: the crypto route stays separate from theirs.
 * In the demo no call is made at all (docs/internal/agent-rules.md, section 4).
 * Spec: docs/internal/plans/crypto-payments.md (section 11b)
 */
import { isDemoMode } from './demo';
import { detectPlatform } from './devices';
import { APEX_ORIGIN } from './hosts';

/** 'new': registered by the app, not confirmed on the page yet, so no checkout exists. */
export type CryptoState = 'none' | 'new' | 'open' | 'seen' | 'partial' | 'expired' | 'paid';

/** What the server says about one order. Every field but `state` is absent for 'none'. Never the pubkey. */
export type CryptoStatus = {
  state: CryptoState;
  amount_cents?: number;
  created_at?: string;
  expires_at?: string;
  paid_at?: string | null;
  payment_id?: string;
  payment_url?: string | null;
  paid_coin?: string | null;
  paid_amount?: string | null;
};

export type CryptoResult<T> = { ok: true; data: T } | { ok: false; code: string };

const STATES: readonly CryptoState[] = ['none', 'new', 'open', 'seen', 'partial', 'expired', 'paid'];

async function call<T>(body: Record<string, unknown>, accessToken?: string): Promise<CryptoResult<T>> {
  if (isDemoMode()) return { ok: false, code: 'demo' };
  try {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/crypto-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // No body: the code below says what happened.
    }
    if (!res.ok) {
      const code = (parsed as { error?: unknown } | null)?.error;
      return { ok: false, code: typeof code === 'string' ? code : `http_${res.status}` };
    }
    return { ok: true, data: parsed as T };
  } catch {
    return { ok: false, code: 'network' };
  }
}

/**
 * The /crypto-checkout page with this query. It lives on the apex, apart
 * from the app origin like the card checkout. A web dev build uses its own
 * origin, so the flow can be tried on localhost before the apex serves it.
 */
export function cryptoCheckoutPage(query: string): string {
  const origin = detectPlatform() === 'web' && import.meta.env.DEV ? window.location.origin : APEX_ORIGIN;
  return `${origin}/crypto-checkout?${query}`;
}

/** A fresh order id: 16 random bytes, base64url, 22 characters. */
export function newCryptoOrderId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Same rule as the server and the table. */
export const isCryptoOrderId = (s: string | null | undefined): s is string => !!s && /^[A-Za-z0-9_-]{22,64}$/.test(s);

export const quoteCryptoPrice = () => call<{ amount_cents: number; currency: string }>({ action: 'quote' });

/** The app, signed in: the order pays for the session's account and nobody else's. */
export const registerCryptoOrder = (order: string, accessToken: string) =>
  call<{ order: string; expires_at: string }>({ action: 'register', order }, accessToken);

/**
 * The page, after the confirm step. `order` in the answer can be another one
 * of this account's: the one whose checkout is already open, never a second.
 */
export const createCryptoCheckout = (order: string, pubkey: string) =>
  call<{ order: string; payment_url: string }>({ action: 'create', order, pubkey });

/** With `pubkey`, the server refuses (`order_taken`) an order that pays for another account. */
export async function cryptoCheckoutStatus(order: string, pubkey?: string | null): Promise<CryptoResult<CryptoStatus>> {
  const res = await call<CryptoStatus>(pubkey ? { action: 'status', order, pubkey } : { action: 'status', order });
  if (res.ok && !STATES.includes(res.data?.state)) return { ok: false, code: 'bad_answer' };
  return res;
}

// ── The order the app waits on ──────────────────────────────────────
//
// Kept in this device's storage so that closing and opening the app keeps
// the wait going. It holds the order id, the account it pays for, whether
// the server took the registration, and when its link closes as last heard;
// nothing about the payment. It goes when the order is paid or expired, on
// sign-out (authStorage.ts), or when another account is signed in.

const PENDING_KEY = 'privacynotes.cryptoOrder';

/** Sent on `window` when a new order is remembered, so the waiting banner picks it up at once. */
export const CRYPTO_ORDER_EVENT = 'privacynotes:crypto-order';

/** The wait ends this long after the link expires, so a payment seen at the last minute can still confirm. */
const WAIT_AFTER_EXPIRY_MS = 60 * 60 * 1000;
/**
 * The latest a link can close, from the click: the registration waits an
 * hour for the confirm (REGISTRATION_TTL_SECONDS in crypto-checkout), and the
 * link then lives 24 hours (CHECKOUT_TTL_SECONDS). Past that and the hour
 * after it, an order is dropped even with no server answer; before it, the
 * server's `expires_at` decides (`cryptoWaitGoesOn`).
 * Spec: docs/internal/plans/crypto-payments.md (section 11b)
 */
const MAX_WAIT_MS = 60 * 60 * 1000 + 24 * 60 * 60 * 1000 + WAIT_AFTER_EXPIRY_MS;

type PendingOrder = {
  order: string;
  pubkey: string;
  startedAt: number;
  /** The server took the registration. Until then the banner registers it. */
  registered: boolean;
  /** When the order (registration, then link) closes, as last heard from the server; null before. */
  expiresAt: number | null;
};

/** The order, when storage refused it. */
let sessionOrder: PendingOrder | null = null;

function store(pending: PendingOrder): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    sessionOrder = null;
  } catch {
    // Storage full or blocked: the banner still hears the event, so the wait
    // lasts this session.
    sessionOrder = pending;
  }
}

function readPending(): Partial<PendingOrder> | null {
  let parsed: Partial<PendingOrder> | null = null;
  try {
    parsed = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null');
  } catch {
    parsed = null;
  }
  return parsed ?? sessionOrder;
}

export function rememberCryptoOrder(order: string, pubkey: string): void {
  if (isDemoMode()) return;
  store({ order, pubkey, startedAt: Date.now(), registered: false, expiresAt: null });
  window.dispatchEvent(new Event(CRYPTO_ORDER_EVENT));
}

/** What the server said about the remembered order: registered, and when it closes. */
export function noteCryptoOrder(order: string, expiresAt: string | null | undefined): void {
  const current = readPending();
  if (!current || current.order !== order || typeof current.pubkey !== 'string' || typeof current.startedAt !== 'number') return;
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  store({
    order,
    pubkey: current.pubkey,
    startedAt: current.startedAt,
    registered: true,
    expiresAt: Number.isNaN(at) ? (current.expiresAt ?? null) : at,
  });
}

/** The order this account is waiting on, or null. Another account's order, or a stale one, is dropped. */
export function pendingCryptoOrder(pubkey: string | null | undefined): PendingOrder | null {
  if (isDemoMode() || !pubkey) return null;
  const parsed = readPending();
  if (!parsed || !isCryptoOrderId(parsed.order) || typeof parsed.startedAt !== 'number') return null;
  if (parsed.pubkey !== pubkey || Date.now() - parsed.startedAt > MAX_WAIT_MS) {
    forgetCryptoOrder();
    return null;
  }
  return {
    order: parsed.order,
    pubkey,
    startedAt: parsed.startedAt,
    registered: parsed.registered === true,
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
  };
}

/**
 * The remembered order a new click should reuse instead of making another:
 * one whose registration is still in flight, or whose link is still open as
 * last heard. The server gives an account one open checkout in any case; this
 * keeps the app watching that one.
 */
export function reusableCryptoOrder(pubkey: string): PendingOrder | null {
  const pending = pendingCryptoOrder(pubkey);
  if (!pending) return null;
  if (!pending.registered) return pending;
  return pending.expiresAt !== null && Date.now() < pending.expiresAt ? pending : null;
}

export function forgetCryptoOrder(): void {
  sessionOrder = null;
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to do.
  }
}

/** Whether the app should keep polling an order in this state. */
export function cryptoWaitGoesOn(status: CryptoStatus): boolean {
  // 'none' after a registration the server took: the order is gone.
  if (status.state === 'paid' || status.state === 'none') return false;
  const expires = status.expires_at ? Date.parse(status.expires_at) : NaN;
  if (Number.isNaN(expires)) return status.state !== 'expired';
  return Date.now() < expires + WAIT_AFTER_EXPIRY_MS;
}

/** The coins the BlockBee page takes, as the Pro window names them: tickers,
 *  the same in every language. Add a coin here when it is turned on in the
 *  BlockBee dashboard. Spec: docs/internal/plans/crypto-payments.md (11b) */
export const CRYPTO_TICKERS = ['BTC', 'ETH', 'LN', 'USDC', 'USDT'] as const;

// ── How a coin is named ─────────────────────────────────────────────
//
// BlockBee names a coin by its ticker: `btc`, or a network and a token such
// as `trc20_usdt`, `polygon/usdc` or `base_usdc`. Network names are proper
// nouns and stay as they are in every language.

const NETWORKS: Record<string, string> = {
  erc20: 'Ethereum',
  bep20: 'BNB Smart Chain',
  trc20: 'Tron',
  polygon: 'Polygon',
  base: 'Base',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  avaxc: 'Avalanche',
  sol: 'Solana',
};

/** The token and, for a token on a chain, the network. Unknown shapes come back as the ticker in capitals. */
export function describeCoin(coin: string): { token: string; network: string | null } {
  const [first, second] = coin.toLowerCase().split(/[_/]/);
  if (second && Object.hasOwn(NETWORKS, first!)) return { token: second.toUpperCase(), network: NETWORKS[first!]! };
  return { token: coin.toUpperCase(), network: null };
}
