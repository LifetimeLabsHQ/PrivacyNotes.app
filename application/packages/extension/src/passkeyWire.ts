/**
 * The passkey request and its answer as they travel: page script, relay,
 * background, popup, and back. Every binary value is unpadded base64url, so
 * each hop is plain JSON. No import: the page script runs on every https
 * page and stays small.
 * Spec: docs/contrib/passkeys.md (section 5.4)
 */

export type PasskeyKind = 'create' | 'get';

export interface WirePrf {
  eval?: { first: string; second?: string };
  /** Credential id to its inputs; it wins over `eval` (review 21). */
  evalByCredential?: Record<string, { first: string; second?: string }>;
}

export interface WireCreateOptions {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: string; alg: number }[];
  excludeCredentials: { id: string; type: string }[];
  authenticatorSelection?: { residentKey?: string; requireResidentKey?: boolean; userVerification?: string; authenticatorAttachment?: string };
  timeout?: number;
  extensions?: { prf?: WirePrf; credProps?: boolean };
}

export interface WireGetOptions {
  rpId?: string;
  challenge: string;
  allowCredentials: { id: string; type: string }[];
  userVerification?: string;
  timeout?: number;
  extensions?: { prf?: WirePrf };
}

type WireOptions = WireCreateOptions | WireGetOptions;

/** The client extension results, binary values as base64url. */
interface WireExtensionResults {
  prf?: { enabled?: boolean; results?: { first: string; second?: string } };
  credProps?: { rk: boolean };
}

/** A credential the popup made or used, for the page script to dress as a
 *  `PublicKeyCredential`. */
export interface WireCredential {
  kind: PasskeyKind;
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  /** create */
  attestationObject?: string;
  /** create: SPKI of the public key */
  publicKey?: string;
  /** get: DER ECDSA signature */
  signature?: string;
  /** get */
  userHandle?: string;
  clientExtensionResults: WireExtensionResults;
}

/** What the page gets back: a credential, the browser's own prompt, or a
 *  DOMException name. */
export type PasskeyResult =
  | { kind: 'credential'; credential: WireCredential }
  | { kind: 'fallback' }
  | { kind: 'error'; name: string }
  /** To `isUserVerifyingPlatformAuthenticatorAvailable`: PrivacyNotes can answer. */
  | { kind: 'available' };

// ── Between the page script and the relay (window.postMessage) ───────

export type PageMessage =
  | { pn: 'passkey-request'; id: string; kind: PasskeyKind; options: WireOptions }
  /** `isUserVerifyingPlatformAuthenticatorAvailable()` (review 18). */
  | { pn: 'passkey-uvpa'; id: string }
  | { pn: 'passkey-abort'; id: string }
  | { pn: 'passkey-ack'; id: string }
  | { pn: 'passkey-answer'; id: string; result: PasskeyResult };

// ── Between the relay, the background and the popup (runtime) ────────

export interface PasskeyRequestMessage {
  type: 'passkey';
  id: string;
  kind: PasskeyKind;
  options: WireOptions;
  /** The page had a user action when it asked, as the relay read it. */
  active: boolean;
}
export interface PasskeyAbortMessage {
  type: 'passkey-abort';
  id: string;
}
/** The popup to the tab, with `tabs.sendMessage`. */
export interface PasskeyAnswerMessage {
  type: 'passkey-answer';
  id: string;
  result: PasskeyResult;
}
/** The background's reply to a request: the prompt opened, or not. */
export type DoorReply = { kind: 'prompt' } | { kind: 'fallback' };

// ── Shared constants ─────────────────────────────────────────────────

// The two scripts' pages. No port in a pattern: Firefox does not take one,
// so the scripts and the door leave the app's development ports out by
// `isOurOrigin` instead.
// Spec: docs/contrib/passkeys.md (section 5.4, two content scripts, P4)
export const PASSKEY_MATCHES = ['https://*/*', 'http://localhost/*'];
export const PASSKEY_EXCLUDES = ['https://privacynotes.app/*', 'https://*.privacynotes.app/*'];

/** A message or port from one of the extension's own pages (the popup, as
 *  a popup or as a small window), by its address: a popup window carries
 *  `sender.tab`, and Firefox sets it on `tabs.sendMessage` too (review 4). */
export function fromOwnPage(sender: { id?: string; url?: string } | undefined, extensionId: string | undefined, extensionUrl: string): boolean {
  return !!sender && !!extensionId && sender.id === extensionId && !!sender.url?.startsWith(extensionUrl);
}

/** The address families that never get a passkey prompt: our own app and
 *  site, and the app's two development ports. */
export function isOurOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:' && (u.hostname === 'privacynotes.app' || u.hostname.endsWith('.privacynotes.app'))) return true;
    return u.protocol === 'http:' && u.hostname === 'localhost' && (u.port === '5173' || u.port === '5174');
  } catch {
    return true;
  }
}

/** The ES256 COSE algorithm, the only one the provider makes. */
export const ES256 = -7;

/** The relay's ack must come this fast, or the page script calls the browser.
 *  Spec: docs/contrib/passkeys.md (section 5.4, review 7) */
export const ACK_MS = 250;
/** After a fallback the page script waits for its focus at most this long. */
export const FOCUS_WAIT_MS = 10_000;
/** A request is forgotten after this long. */
export const REQUEST_MAX_MS = 180_000;
/** The most a request's options may take as JSON, in characters: the door
 *  keeps them in session storage, which every request and the unlock share. */
export const REQUEST_MAX_CHARS = 65_536;
/** The page script's own deadline after the ack: the relay may be gone
 *  (Firefox removes it on unload) and never answer (review 12). */
export const ANSWER_MAX_MS = REQUEST_MAX_MS + 5_000;
/** No prompt for an origin this long after the person dismissed one. */
export const COOLDOWN_MS = 60_000;

// ── base64url, no padding ────────────────────────────────────────────

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Null for anything that is not strict unpadded base64url. */
export function fromB64url(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
