/**
 * Passkey sign-in on a new device: a signed-in device adds a passkey whose
 * WebAuthn PRF output encrypts the recovery phrase, and the server keeps the
 * ciphertext in a passkey slot (edge function `passkey-slot`). On a new
 * device the passkey asks the server for that ciphertext, the PRF output
 * opens it, and the phrase signs in as if it had been typed: the same
 * sign-in step, captcha and 2FA prompt (P8). The phrase stays the root key.
 *
 * The cryptography (4.1): one fixed PRF input for every sign-in passkey (a
 * discoverable `get` does not know the credential before the person picks
 * it, P18); HKDF-SHA256 over the 32-byte output gives a non-extractable
 * AES-GCM-256 key; the phrase is padded with spaces to 256 bytes so the
 * length does not tell 12 from 24 words; the additional data names the
 * credential, so the server cannot swap two slots. The PRF output and the
 * key are never stored. The slot's name is sealed under the account's sync
 * key (P30). Adding and removing a slot is signed with the phrase's signing
 * key over a server nonce, the session and a digest of the body (P19).
 *
 * Every server call has a demo guard: the demo sends nothing.
 * Spec: docs/contrib/passkeys.md (4.1, 4.3)
 */
import {
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  decryptJsonAad,
  encryptJsonAad,
  hexToBytes,
  isValidPhrase,
  signPasskeySlotChallenge,
  type SupabaseClient,
} from '@notes/shared';
import { isDemoMode } from './demo';
import { detectPlatform, readFnErrorBody, type FnError } from './devices';
import { ensureLevel2 } from './mfaStep';
import { passkeysReleased } from './passkeysRelease';
import { sha256Hex } from './sha256Hex';
import { isUuid } from './uuid';
import { buf, keyFromPrf, prfOutput, prfResultsOf, signalUnknownCredential } from './webauthn';

// ── Constants ─────────────────────────────────────────────────────────

/**
 * The origins that offer passkey sign-in, and the RP ID of each (P15): each
 * host its own RP ID, the app and the public beta in production, never the
 * apex (script on any subdomain could then ask for the PRF output), and
 * localhost in development. A beta passkey answers only on beta. The
 * server holds the same table (`_shared/passkeySignIn.ts`).
 * `APP_ORIGINS` is never used for this.
 * Spec: docs/contrib/passkeys.md (4.1, P15)
 */
export const PASSKEY_SIGNIN_ORIGINS: Readonly<Record<string, string>> = Object.freeze({
  'https://use.privacynotes.app': 'use.privacynotes.app',
  'https://beta.privacynotes.app': 'beta.privacynotes.app',
  'http://localhost:5173': 'localhost',
  'http://localhost:5174': 'localhost',
});

/** The RP ID of an origin that offers passkey sign-in, or null. */
export function passkeySignInRpId(origin: string): string | null {
  return Object.prototype.hasOwnProperty.call(PASSKEY_SIGNIN_ORIGINS, origin) ? PASSKEY_SIGNIN_ORIGINS[origin]! : null;
}

const SIGNIN_INFO = 'privacynotes-passkey-signin-v1';

/** The user name and display name a sign-in passkey carries in the passkey
 *  app, apart from the unlock passkeys ("PrivacyNotes User") on the same RP
 *  ID. A product name plus a word, as the unlock passkey's name is.
 *  Spec: docs/contrib/passkeys.md (4.3) */
const SIGNIN_PASSKEY_NAME = 'PrivacyNotes sign-in';

/** SHA-256(utf8("privacynotes-passkey-signin-v1")), pinned by
 *  tests/passkeySignIn.test.ts. Spec: docs/contrib/passkeys.md (4.1, P18) */
export const PASSKEY_SIGNIN_PRF_INPUT: Uint8Array = hexToBytes('188337c0cd951e121c4bf47940668887f56315304b87c748953da441c7ff9ad0');

/** Spec: docs/contrib/passkeys.md (P20) */
export const MAX_PASSKEY_SLOTS = 10;

/** The padded plaintext length. Spec: docs/contrib/passkeys.md (4.1) */
const PHRASE_PAD_BYTES = 256;
const AES_GCM_IV_BYTES = 12;
const FUNCTION = 'passkey-slot';

// ── Where it is offered ───────────────────────────────────────────────

/** Whether this device offers passkey sign-in: a browser (not an app's
 *  webview), WebAuthn present, an origin of the table, not the demo, and
 *  the release switch on. */
export function passkeySignInAvailable(): boolean {
  if (isDemoMode() || !passkeysReleased()) return false;
  if (detectPlatform() !== 'web') return false;
  if (typeof window === 'undefined' || typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return false;
  return passkeySignInRpId(window.location.origin) !== null;
}

// ── The slot's ciphertext ─────────────────────────────────────────────

function slotAad(credentialId: string): Uint8Array {
  return new TextEncoder().encode(`privacynotes-passkey-slot-v1:${credentialId}`);
}

function labelAad(credentialId: string): string {
  return `privacynotes-passkey-label-v1:${credentialId}`;
}

/** The phrase, UTF-8, right-padded with spaces to 256 bytes. */
export function padPhrase(phrase: string): Uint8Array {
  const bytes = new TextEncoder().encode(phrase);
  if (bytes.length > PHRASE_PAD_BYTES) throw new Error('phrase too long');
  const out = new Uint8Array(PHRASE_PAD_BYTES).fill(0x20);
  out.set(bytes);
  return out;
}

/** Encrypt the phrase under the passkey's PRF output, bound to its credential id. */
export async function sealPhraseForSlot(phrase: string, output: Uint8Array, credentialId: string): Promise<{ ciphertext: string; nonce: string }> {
  const key = await keyFromPrf(output, SIGNIN_INFO);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(slotAad(credentialId)) }, key, buf(padPhrase(phrase)),
  ));
  return { ciphertext: bytesToBase64url(ciphertext), nonce: bytesToBase64url(iv) };
}

/** Open a slot's ciphertext; null when it does not open. The reader trims. */
export async function openSlotPhrase(ciphertext: string, nonce: string, output: Uint8Array, credentialId: string): Promise<string | null> {
  try {
    const key = await keyFromPrf(output, SIGNIN_INFO);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(base64urlToBytes(nonce)), additionalData: buf(slotAad(credentialId)) },
      key, buf(base64urlToBytes(ciphertext)),
    );
    const phrase = new TextDecoder().decode(plain).trim().toLowerCase();
    return isValidPhrase(phrase) ? phrase : null;
  } catch {
    return null;
  }
}

/**
 * The digest add and remove sign: lowercase SHA-256 hex over the JSON of
 * every body field but `action`, `nonceId` and `signature`, keys sorted.
 * The edge function computes the same (`passkey-slot`, P19).
 */
export async function slotBodyDigest(fields: Record<string, string | number>): Promise<string> {
  const sorted: Record<string, string | number> = {};
  for (const key of Object.keys(fields).sort()) sorted[key] = fields[key]!;
  return sha256Hex(new TextEncoder().encode(JSON.stringify(sorted)));
}

// ── Server calls ──────────────────────────────────────────────────────

type Refusal = { code: string | null; status: number | null };

async function refusalOf(error: unknown): Promise<Refusal> {
  const fe = error as FnError & { context?: { status?: unknown } };
  const status = typeof fe?.context?.status === 'number' ? fe.context.status : null;
  let body: { error?: unknown } | null = null;
  try {
    body = (await readFnErrorBody(fe)) as { error?: unknown } | null;
  } catch {
    body = null;
  }
  const code = typeof body?.error === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(body.error) ? body.error : null;
  return { code, status };
}

type Invoked = { data: unknown; refusal: Refusal | null };

async function call(supabase: SupabaseClient, bearer: string, body: Record<string, unknown>): Promise<Invoked> {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION, { body, headers: { Authorization: `Bearer ${bearer}` } });
    if (!error) return { data, refusal: null };
    return { data: null, refusal: await refusalOf(error) };
  } catch {
    return { data: null, refusal: { code: null, status: null } };
  }
}

/** The open vault's session and keys (auth.tsx `phraseChangeActor`). */
export type SlotActor = {
  supabase: SupabaseClient;
  accessToken: string;
  authUid: string;
  sessionId: string;
  accountId: string;
  phrase: string;
  signingPrivateKey: Uint8Array;
  /** The current sync key: it seals the slot's name. */
  encryptionKey: Uint8Array;
};

/**
 * The bearer for add and remove, after a 2FA code from the last five minutes
 * where the account has 2FA (the server's `account_assert_actor` wants one
 * for both). The check can refresh the token, never the session the
 * signature names. Null when the person cancelled or the session changed.
 */
async function freshBearer(actor: SlotActor): Promise<string | null | 'cancelled'> {
  try {
    await ensureLevel2(actor.supabase, { force: true, allowLocalUse: true });
    const { data } = await actor.supabase.auth.getSession();
    const live = data.session;
    if (live?.user?.id && live.user.id !== actor.authUid) return null;
    return typeof live?.access_token === 'string' && live.access_token ? live.access_token : actor.accessToken;
  } catch (err) {
    return isCancel(err) || (err as Error)?.name === 'MfaCancelledError' ? 'cancelled' : null;
  }
}

/** A fresh nonce bound to the body's digest, then the signature over the
 *  nonce, the session and that digest. */
async function signedFields(
  actor: SlotActor,
  bearer: string,
  operation: 'passkey-add' | 'passkey-remove',
  fields: Record<string, string | number>,
): Promise<{ nonceId: string; signature: string } | { refusal: Refusal }> {
  const bodyDigest = await slotBodyDigest(fields);
  const issued = await call(actor.supabase, bearer, { action: 'nonce', operation, bodyDigest });
  if (issued.refusal) return { refusal: issued.refusal };
  const nonceId = (issued.data as { nonceId?: unknown } | null)?.nonceId;
  if (typeof nonceId !== 'string' || !isUuid(nonceId)) return { refusal: { code: null, status: null } };
  try {
    // The signer refuses a part of the wrong shape: a refusal, never a throw.
    const signature = bytesToHex(await signPasskeySlotChallenge(actor.signingPrivateKey, {
      nonceId, authUid: actor.authUid, sessionId: actor.sessionId, account: actor.accountId, operation, bodyDigest,
    }));
    return { nonceId, signature };
  } catch {
    return { refusal: { code: null, status: null } };
  }
}

// ── Add ───────────────────────────────────────────────────────────────

export type AddPasskeyResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'cancelled' | 'no_prf' | 'too_many' | 'failed' };

function isCancel(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/**
 * Make a sign-in passkey and store its slot. The passkey is discoverable,
 * with user verification and the fixed PRF input; a provider that enables
 * PRF at creation and evaluates it only on an assertion gets one `get` for
 * the new credential. No PRF: nothing reaches the server. The caller runs
 * the PIN gate first (4.4); this asks for a recent 2FA check where 2FA is
 * on, because the server's `add` wants one.
 */
export async function addSignInPasskey(actor: SlotActor, label: string): Promise<AddPasskeyResult> {
  if (isDemoMode() || !passkeySignInAvailable()) return { ok: false, reason: 'unavailable' };
  const rpId = passkeySignInRpId(window.location.origin);
  if (!rpId) return { ok: false, reason: 'unavailable' };

  // The 2FA step first, before any passkey exists: a cancel here leaves
  // nothing behind in the person's passkey app. (The nonce must wait: its
  // digest covers the ciphertext, which needs the new passkey's PRF output.)
  const bearer = await freshBearer(actor);
  if (bearer === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (!bearer) return { ok: false, reason: 'failed' };

  const createOptions: PublicKeyCredentialCreationOptions = {
    rp: { id: rpId, name: 'PrivacyNotes' },
    // A name of its own: in production the biometric unlock passkeys share
    // this RP ID, and the provider's list must tell the two apart.
    user: { id: buf(crypto.getRandomValues(new Uint8Array(16))), name: SIGNIN_PASSKEY_NAME, displayName: SIGNIN_PASSKEY_NAME },
    challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' }, // ES256
      { alg: -257, type: 'public-key' }, // RS256
    ],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  };
  // prf is not yet in every TS type definition.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (createOptions as any).extensions = { prf: { eval: { first: buf(PASSKEY_SIGNIN_PRF_INPUT) } } };

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({ publicKey: createOptions })) as PublicKeyCredential | null;
  } catch (err) {
    return { ok: false, reason: isCancel(err) ? 'cancelled' : 'failed' };
  }
  if (!credential) return { ok: false, reason: 'cancelled' };
  const rawId = new Uint8Array(credential.rawId);
  const credentialId = bytesToBase64url(rawId);
  // From here a passkey exists in the person's passkey app. A stop before
  // the add went out, or an add the server refused with its own code, tells
  // the provider this new credential is unused; never another credential,
  // and never after an add whose answer was lost (the slot may be stored).
  const drop = (reason: 'cancelled' | 'no_prf' | 'too_many' | 'failed'): AddPasskeyResult => {
    signalUnknownCredential(rpId, credentialId);
    return { ok: false, reason };
  };

  const prf = prfResultsOf(credential);
  if (prf?.enabled !== true) return drop('no_prf');
  let output = prfOutput(prf.results?.first);
  if (!output) {
    const getOptions: PublicKeyCredentialRequestOptions = {
      rpId,
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      allowCredentials: [{ id: buf(rawId), type: 'public-key' }],
      userVerification: 'required',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getOptions as any).extensions = { prf: { eval: { first: buf(PASSKEY_SIGNIN_PRF_INPUT) } } };
    let assertion: PublicKeyCredential | null;
    try {
      assertion = (await navigator.credentials.get({ publicKey: getOptions })) as PublicKeyCredential | null;
    } catch (err) {
      return drop(isCancel(err) ? 'cancelled' : 'failed');
    }
    if (!assertion) return drop('cancelled');
    output = prfOutput(prfResultsOf(assertion)?.results?.first);
    if (!output) return drop('no_prf');
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  let spki: ArrayBuffer | null = null;
  let alg: number | null = null;
  try {
    spki = response.getPublicKey?.() ?? null;
    alg = response.getPublicKeyAlgorithm?.() ?? null;
  } catch {
    spki = null;
  }
  if (!spki || (alg !== -7 && alg !== -257)) return drop('failed');

  let fields: Record<string, string | number>;
  try {
    const sealed = await sealPhraseForSlot(actor.phrase, output, credentialId);
    const name = encryptJsonAad(label, actor.encryptionKey, labelAad(credentialId));
    fields = {
      credentialId,
      publicKey: bytesToBase64url(new Uint8Array(spki)),
      alg,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      labelCiphertext: bytesToBase64url(name.ciphertext),
      labelNonce: bytesToBase64url(name.nonce),
    };
  } catch {
    return drop('failed');
  }

  const signed = await signedFields(actor, bearer, 'passkey-add', fields);
  if ('refusal' in signed) return drop('failed');
  const added = await call(actor.supabase, bearer, { action: 'add', ...fields, ...signed });
  if (added.refusal) {
    const { code, status } = added.refusal;
    const refused = code !== null && status !== null && status >= 400 && status < 500;
    if (!refused) return { ok: false, reason: 'failed' };
    return drop(code === 'too_many' ? 'too_many' : 'failed');
  }
  if ((added.data as { ok?: unknown } | null)?.ok !== true) return { ok: false, reason: 'failed' };
  return { ok: true };
}

// ── Sign in ───────────────────────────────────────────────────────────

export type SignInPasskeyResult =
  | { ok: true; phrase: string }
  | { ok: false; reason: 'unavailable' | 'cancelled' | 'no_prf' | 'not_found' | 'retired' | 'rate_limited' | 'network' };

/** The anon key every signed-out call goes out with, never a session. */
function anonKey(): string | null {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return key || null;
}

/**
 * Sign in with a passkey: a one-time challenge, a discoverable `get` with
 * the PRF input, the server's `release` of the slot, the phrase opened and
 * trimmed. The caller hands the phrase to the ordinary phrase sign-in.
 * `signalUnknownCredential` goes out only for the function's own `retired`
 * answer. An unknown credential is never signalled: the biometric unlock
 * passkeys share the RP ID (localhost in development, use.privacynotes.app
 * in production), and the person may have picked one.
 */
export async function signInPasskeyPhrase(supabase: SupabaseClient): Promise<SignInPasskeyResult> {
  if (isDemoMode() || !passkeySignInAvailable()) return { ok: false, reason: 'unavailable' };
  const rpId = passkeySignInRpId(window.location.origin);
  const bearer = anonKey();
  if (!rpId || !bearer) return { ok: false, reason: 'unavailable' };

  const issued = await call(supabase, bearer, { action: 'challenge' });
  if (issued.refusal) return { ok: false, reason: issued.refusal.code === 'rate_limited' || issued.refusal.status === 429 ? 'rate_limited' : 'network' };
  const challenge = (issued.data as { challenge?: unknown } | null)?.challenge;
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)) return { ok: false, reason: 'network' };

  const getOptions: PublicKeyCredentialRequestOptions = {
    rpId,
    challenge: buf(base64urlToBytes(challenge)),
    userVerification: 'required',
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (getOptions as any).extensions = { prf: { eval: { first: buf(PASSKEY_SIGNIN_PRF_INPUT) } } };
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({ publicKey: getOptions })) as PublicKeyCredential | null;
  } catch (err) {
    return { ok: false, reason: isCancel(err) ? 'cancelled' : 'network' };
  }
  if (!assertion) return { ok: false, reason: 'cancelled' };
  const credentialId = bytesToBase64url(new Uint8Array(assertion.rawId));
  const output = prfOutput(prfResultsOf(assertion)?.results?.first);
  if (!output) return { ok: false, reason: 'no_prf' };

  const response = assertion.response as AuthenticatorAssertionResponse;
  const released = await call(supabase, bearer, {
    action: 'release',
    credentialId,
    clientDataJSON: bytesToBase64url(new Uint8Array(response.clientDataJSON)),
    authenticatorData: bytesToBase64url(new Uint8Array(response.authenticatorData)),
    signature: bytesToBase64url(new Uint8Array(response.signature)),
  });
  if (released.refusal) {
    const { code, status } = released.refusal;
    // Only the function's own codes count: a bare 404 or 410 from a gateway
    // says nothing about the slot.
    if (code === 'retired') {
      signalUnknownCredential(rpId, credentialId);
      return { ok: false, reason: 'retired' };
    }
    // Never signalled: the person may have picked a biometric unlock
    // passkey, which shares the RP ID and which the server does not know.
    if (code === 'not_found') return { ok: false, reason: 'not_found' };
    if (code === 'rate_limited' || status === 429) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: 'network' };
  }
  const slot = released.data as { ciphertext?: unknown; nonce?: unknown } | null;
  if (typeof slot?.ciphertext !== 'string' || typeof slot.nonce !== 'string') return { ok: false, reason: 'network' };
  const phrase = await openSlotPhrase(slot.ciphertext, slot.nonce, output, credentialId);
  // A ciphertext the PRF output does not open: this passkey app gave
  // another output than at the add, so it cannot unlock the notes.
  if (!phrase) return { ok: false, reason: 'no_prf' };
  return { ok: true, phrase };
}

// ── List and remove ───────────────────────────────────────────────────

export type SignInPasskeySlot = {
  credentialId: string;
  /** The name, opened with the sync key; null when it does not open (a slot
   *  added under an earlier phrase). */
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** False for a slot added before the phrase changed (retired, P16). */
  current: boolean;
};

export type ListPasskeysResult = { ok: true; slots: SignInPasskeySlot[] } | { ok: false };

function openLabel(row: { credentialId: string; labelCiphertext?: unknown; labelNonce?: unknown }, key: Uint8Array): string | null {
  if (typeof row.labelCiphertext !== 'string' || typeof row.labelNonce !== 'string' || !row.labelCiphertext) return null;
  try {
    const value = decryptJsonAad<unknown>(base64urlToBytes(row.labelCiphertext), base64urlToBytes(row.labelNonce), key, labelAad(row.credentialId));
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** The account's sign-in passkeys. The demo has none and asks nothing. */
export async function listSignInPasskeys(actor: SlotActor): Promise<ListPasskeysResult> {
  if (isDemoMode()) return { ok: true, slots: [] };
  const listed = await call(actor.supabase, actor.accessToken, { action: 'list' });
  if (listed.refusal) return { ok: false };
  const rows = (listed.data as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(rows)) return { ok: false };
  const slots: SignInPasskeySlot[] = [];
  for (const raw of rows as Array<Record<string, unknown>>) {
    if (!raw || typeof raw.credentialId !== 'string' || typeof raw.createdAt !== 'string') continue;
    slots.push({
      credentialId: raw.credentialId,
      label: openLabel({ ...raw, credentialId: raw.credentialId }, actor.encryptionKey),
      createdAt: raw.createdAt,
      lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
      current: raw.current !== false,
    });
  }
  return { ok: true, slots };
}

/** Remove one slot, after the same 2FA check as an add. The passkey itself
 *  stays in the person's passkey app. */
export async function removeSignInPasskey(actor: SlotActor, credentialId: string): Promise<{ ok: true } | { ok: false; reason: 'cancelled' | 'not_found' | 'failed' }> {
  if (isDemoMode()) return { ok: false, reason: 'failed' };
  const bearer = await freshBearer(actor);
  if (bearer === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (!bearer) return { ok: false, reason: 'failed' };
  const fields = { credentialId };
  const signed = await signedFields(actor, bearer, 'passkey-remove', fields);
  if ('refusal' in signed) return { ok: false, reason: 'failed' };
  const removed = await call(actor.supabase, bearer, { action: 'remove', ...fields, ...signed });
  if (removed.refusal) return { ok: false, reason: removed.refusal.code === 'not_found' ? 'not_found' : 'failed' };
  return { ok: true };
}

/** How many sign-in passkeys still sign in, for the phrase change's
 *  summary (P16): a change retires them. Null when the server gave no answer. */
export async function countSignInPasskeys(actor: SlotActor): Promise<number | null> {
  if (!passkeysReleased()) return 0;
  const listed = await listSignInPasskeys(actor);
  return listed.ok ? listed.slots.filter((slot) => slot.current).length : null;
}
