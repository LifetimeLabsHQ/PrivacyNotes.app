import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decryptJsonAad,
  deriveLocalDataKey,
  deriveSigningKey,
  encryptJsonAad,
  HEX32_KEY,
  phraseToSeed,
  signBindSessionChallenge,
  signResolveChallenge,
  type SupabaseClient,
} from '@notes/shared';
import { db, IDENTITY_BINDING_KEY } from './db';
import { isDemoMode } from './demo';
import { readFnErrorBody, type FnError } from './devices';
import { localAad } from './localSeal';
import { hash53 } from './noteMerge';
import { PhraseReplacedError, reportPhraseReplaced, type PhraseReplacedSource } from './phraseReplaced';

/**
 * The identity a phrase signs in as: the account id, the signing key and
 * the key epoch.
 *
 * A phrase change keeps the account id (the public key of the account's
 * first phrase) and gives the account a new signing key. So "the key this
 * phrase derives" and "the account" are two values, and every place that
 * compared them as one asks here instead. Three sources, in order:
 * - the local binding record: `{accountId, signingPubkey, epoch}`, sealed
 *   under the local key OF THIS PHRASE with its own AAD, so only a holder of
 *   the phrase can write a record that opens. A device writes it once a
 *   sign-in proved the binding: bind-session verified this phrase's
 *   signature under the account's current key (auth.tsx);
 * - the server: link-pubkey `resolve`, signed by the phrase's key over a
 *   server nonce;
 * - neither: the phrase is its own account at epoch 1, which is every
 *   account that never changed its phrase.
 * A record is written by a sign-in the server resolved (auth.tsx) and by
 * the device that changed the phrase, once the change landed (bindNewPhrase
 * in phraseChange.ts).
 * Spec: docs/internal/plans/phrase-change.md (4.3, 4.6)
 */
export type Identity = { accountId: string; signingPubkey: string; epoch: number };

/** What the server says about a signing key (link-pubkey `resolve`). */
export type ResolveAnswer =
  | { status: 'current'; accountId: string; epoch: number }
  | { status: 'retired' }
  | { status: 'deleted' }
  | { status: 'unknown' };

// One class for "this phrase was replaced", whichever answer said so.
export { PhraseReplacedError } from './phraseReplaced';

/** The identity of a phrase that is its own account. */
export function ownIdentity(signingPubkey: string): Identity {
  return { accountId: signingPubkey, signingPubkey, epoch: 1 };
}

// ── The local binding record ─────────────────────────────────────────

// db.kv `IDENTITY_BINDING_KEY` holds the record. One slot: the phrase this
// device holds. clearLocalDatabase takes it with every wipe.
const aad = (signingPubkey: string) => localAad('identity', signingPubkey);

/**
 * The record for this phrase, or null: none, another phrase's (it does not
 * open under this phrase's key), or not a binding to another account.
 * The demo keeps none.
 */
export async function readIdentityBinding(seed: Uint8Array, signingPubkey: string): Promise<Identity | null> {
  if (isDemoMode()) return null;
  let raw: unknown;
  try {
    raw = (await db.kv.get(IDENTITY_BINDING_KEY))?.value;
  } catch {
    return null;
  }
  if (typeof raw !== 'string') return null;
  const key = deriveLocalDataKey(seed);
  try {
    const { n, ct } = JSON.parse(raw) as { n?: unknown; ct?: unknown };
    if (typeof n !== 'string' || typeof ct !== 'string') return null;
    const rec = decryptJsonAad<Partial<Identity>>(base64ToBytes(ct), base64ToBytes(n), key, aad(signingPubkey));
    if (rec.signingPubkey !== signingPubkey || typeof rec.accountId !== 'string' || !HEX32_KEY.test(rec.accountId)
      || rec.accountId === signingPubkey || !Number.isInteger(rec.epoch) || (rec.epoch as number) < 2) return null;
    return { accountId: rec.accountId, signingPubkey, epoch: rec.epoch as number };
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

/** Keep the record for a phrase that signs for another account; an own identity keeps none. */
export async function writeIdentityBinding(seed: Uint8Array, identity: Identity): Promise<void> {
  if (isDemoMode()) return;
  if (identity.accountId === identity.signingPubkey) {
    await clearIdentityBinding();
    return;
  }
  const key = deriveLocalDataKey(seed);
  try {
    const { ciphertext, nonce } = encryptJsonAad(identity, key, aad(identity.signingPubkey));
    await db.kv.put({ key: IDENTITY_BINDING_KEY, value: JSON.stringify({ n: bytesToBase64(nonce), ct: bytesToBase64(ciphertext) }) });
  } catch {
    /* Best effort: without it the next sign-in asks the server again. */
  } finally {
    key.fill(0);
  }
}

export async function clearIdentityBinding(): Promise<void> {
  try {
    await db.kv.delete(IDENTITY_BINDING_KEY);
  } catch {
    /* ignore */
  }
}

// ── The server: link-pubkey resolve ──────────────────────────────────

// One answer per key for a minute, so the account-switch question and the
// sign-in right after it ask once.
const MEMO_MS = 60_000;
const memo = new Map<string, { at: number; answer: ResolveAnswer }>();

/** Forget every remembered answer (sign-out, tests). */
export function forgetResolveAnswers(): void {
  memo.clear();
}

/**
 * Ask the server which account `signingPubkey` belongs to. Null when it gave
 * no answer (offline, a refusal, an answer it cannot read). A function that
 * predates the op answers 400 to it, and that is `unknown`: no account can
 * have changed its phrase before the server knows how.
 *
 * The question goes out with the anon key, never with the session this
 * device holds: asked at the account-switch question, the session would tell
 * the server which account was asking about which phrase, a pair this
 * question never sent before. No anon key registered, no question.
 */
export async function resolveSigningKey(
  supabase: SupabaseClient,
  signingPubkey: string,
  signingPrivateKey: Uint8Array,
): Promise<ResolveAnswer | null> {
  const kept = memo.get(signingPubkey);
  if (kept && Date.now() - kept.at < MEMO_MS) return kept.answer;
  if (!anonBearer) return null;
  const headers = { Authorization: `Bearer ${anonBearer}` };
  try {
    const first = await supabase.functions.invoke('link-pubkey', { body: { op: 'resolve-nonce', pubkey: signingPubkey }, headers });
    if (first.error && (first.error as FnError).context?.status === 400) return { status: 'unknown' };
    const nonce = (first.data as { nonce?: unknown } | null)?.nonce;
    if (first.error || typeof nonce !== 'string') return null;
    const signature = bytesToHex(await signResolveChallenge(signingPrivateKey, signingPubkey, nonce));
    const second = await supabase.functions.invoke('link-pubkey', { body: { op: 'resolve', pubkey: signingPubkey, nonce, signature }, headers });
    if (second.error) return null;
    const answer = readAnswer(second.data, signingPubkey);
    if (answer) memo.set(signingPubkey, { at: Date.now(), answer });
    return answer;
  } catch {
    return null;
  }
}

function readAnswer(data: unknown, signingPubkey: string): ResolveAnswer | null {
  const d = data as { status?: unknown; account?: unknown; epoch?: unknown } | null;
  if (d?.status === 'retired' || d?.status === 'deleted' || d?.status === 'unknown') return { status: d.status };
  if (d?.status !== 'current') return null;
  // A key that is current is never its own account id after a change.
  if (typeof d.account !== 'string' || !HEX32_KEY.test(d.account) || d.account === signingPubkey) return null;
  if (typeof d.epoch !== 'number' || !Number.isInteger(d.epoch) || d.epoch < 2) return null;
  return { status: 'current', accountId: d.account, epoch: d.epoch };
}

// The app's client, for callers that hold none (the account-switch
// question). auth.tsx registers it once, beside the client it builds.
let registered: SupabaseClient | null = null;
// The anon key every resolve goes out with (resolveSigningKey says why).
let anonBearer: string | null = null;
export function registerIdentityClient(client: SupabaseClient | null, anonKey: string | null): void {
  registered = client;
  anonBearer = anonKey || null;
}

/** `resolveSigningKey` through the registered client; null without one or in the demo. */
export async function resolveRegistered(signingPubkey: string, signingPrivateKey: Uint8Array): Promise<ResolveAnswer | null> {
  if (!registered || isDemoMode()) return null;
  return resolveSigningKey(registered, signingPubkey, signingPrivateKey);
}

/**
 * Whether the account replaced this phrase: `resolve` answers `retired`.
 * For a device whose session the change revoked, where sync meets a refusal
 * that says nothing about the phrase (a missing second factor on a managed
 * account whose session is gone, a dead session): the answer turns it into
 * the change it is (phraseReplaced.ts). Through the registered client and
 * its anon key, at most once per phrase in ten minutes, keyed by a mark of
 * the phrase rather than a copy; no answer is no.
 * Spec: docs/internal/plans/phrase-change.md (section 7)
 */
const REPLACED_CHECK_MS = 10 * 60_000;
const replacedChecks = new Map<string, number>();
export async function phraseWasReplaced(phrase: string): Promise<boolean> {
  const mark = hash53(53, phrase);
  const at = replacedChecks.get(mark);
  if (at !== undefined && Date.now() - at < REPLACED_CHECK_MS) return false;
  replacedChecks.set(mark, Date.now());
  try {
    const { privateKey, publicKey } = await deriveSigningKey(phraseToSeed(phrase));
    return (await resolveRegistered(bytesToHex(publicKey), privateKey))?.status === 'retired';
  } catch {
    return false;
  }
}

/** A refusal that says nothing about the phrase, met by a session of
 *  `phrase` (phraseWasReplaced): when the account replaced the phrase, the
 *  refusal is the change, and it is reported. Answers whether it was. */
export async function reportIfPhraseReplaced(phrase: string, source: PhraseReplacedSource): Promise<boolean> {
  if (!(await phraseWasReplaced(phrase))) return false;
  reportPhraseReplaced(source);
  return true;
}

// ── The resolver ─────────────────────────────────────────────────────

/**
 * Does `phrase` sign for the account `accountId`? The phrase's own key, then
 * the local record, then (only when `online`) the server. Anything that
 * derives nothing answers false.
 */
export async function phraseSignsFor(phrase: string, accountId: string, online = false): Promise<boolean> {
  try {
    const seed = phraseToSeed(phrase);
    const { privateKey, publicKey } = await deriveSigningKey(seed);
    const signingPubkey = bytesToHex(publicKey);
    if (signingPubkey === accountId) return true;
    if ((await readIdentityBinding(seed, signingPubkey))?.accountId === accountId) return true;
    if (!online) return false;
    const answer = await resolveRegistered(signingPubkey, privateKey);
    return answer?.status === 'current' && answer.accountId === accountId;
  } catch {
    return false;
  }
}

export type SignInIdentity = Identity & { source: 'record' | 'own' | 'server' };

/**
 * The identity a sign-in goes on with.
 * - A record of this phrase wins: the device proved it before.
 * - A phrase generated this second, or one whose key is the account this
 *   device already holds, is its own account, and nothing is asked: every
 *   returning device of an account that never changed its phrase signs in
 *   exactly as before.
 * - Otherwise the server is asked once. `retired` and `deleted` throw, so
 *   the caller never makes an account for a replaced phrase; no answer is
 *   the phrase's own account, as today.
 */
export async function identityForSignIn(opts: {
  supabase: SupabaseClient;
  seed: Uint8Array;
  signingPubkey: string;
  signingPrivateKey: Uint8Array;
  /** The account the device holds (the owner marker), when known. */
  owner: string | null;
  freshVault: boolean;
}): Promise<SignInIdentity> {
  const { supabase, seed, signingPubkey, signingPrivateKey, owner, freshVault } = opts;
  const record = await readIdentityBinding(seed, signingPubkey);
  if (record) return { ...record, source: 'record' };
  if (freshVault || owner === signingPubkey || isDemoMode()) return { ...ownIdentity(signingPubkey), source: 'own' };
  const answer = await resolveSigningKey(supabase, signingPubkey, signingPrivateKey);
  if (answer?.status === 'retired' || answer?.status === 'deleted') throw new PhraseReplacedError(answer.status);
  if (answer?.status === 'current') return { accountId: answer.accountId, signingPubkey, epoch: answer.epoch, source: 'server' };
  return { ...ownIdentity(signingPubkey), source: 'own' };
}

// ── bind-session ─────────────────────────────────────────────────────

/** The server said no to the binding, as opposed to giving no answer. */
export class BindRefusedError extends Error {
  constructor(readonly code: string) {
    super(`bind-session failed: ${code}`);
    this.name = 'BindRefusedError';
  }
}

async function refusalCode(error: unknown): Promise<string | null> {
  const code = ((await readFnErrorBody(error as FnError)) as { error?: unknown } | null)?.error;
  return code === 'phrase_replaced' || code === 'phrase_refused' || code === 'signature_invalid' || code === 'bind_refused' ? code : null;
}

/**
 * Prove the account's current signing key for the session behind
 * `accessToken`, so the key-epoch write gate lets it write. An account that
 * never changed its phrase has nothing to bind and the server says so in
 * one call. Answers the epoch the session is bound to, or throws.
 * Spec: docs/internal/plans/phrase-change.md (4.4)
 */
export async function bindSessionEpoch(
  supabase: SupabaseClient,
  session: { accessToken: string; authUid: string; sessionId: string; accountId: string },
  signingPrivateKey: Uint8Array,
  /** The epoch this device holds the keys of; any other answer is refused. */
  expectedEpoch: number,
): Promise<number> {
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const first = await supabase.functions.invoke('link-pubkey', { body: { op: 'bind-nonce' }, headers });
  if (first.error) {
    const code = await refusalCode(first.error);
    throw code ? new BindRefusedError(code) : new Error('bind-session failed: no nonce');
  }
  const issued = first.data as { epoch?: unknown; nonceId?: unknown } | null;
  if (typeof issued?.epoch !== 'number') throw new Error('bind-session failed: no nonce');
  // The account is at another epoch than this device knows: a change it has
  // not seen, or a record that no longer holds. Never go on unbound.
  if (issued.epoch !== expectedEpoch) throw new BindRefusedError('epoch_mismatch');
  if (expectedEpoch === 1) return 1;
  if (typeof issued.nonceId !== 'string') throw new Error('bind-session failed: no nonce');
  const signature = bytesToHex(await signBindSessionChallenge(signingPrivateKey, {
    nonceId: issued.nonceId, authUid: session.authUid, sessionId: session.sessionId, account: session.accountId,
  }));
  const second = await supabase.functions.invoke('link-pubkey', { body: { op: 'bind-session', nonceId: issued.nonceId, signature }, headers });
  if (second.error) {
    const code = await refusalCode(second.error);
    throw code ? new BindRefusedError(code) : new Error('bind-session failed');
  }
  const bound = (second.data as { epoch?: unknown } | null)?.epoch;
  if (bound !== expectedEpoch) throw new BindRefusedError('epoch_mismatch');
  return bound;
}
