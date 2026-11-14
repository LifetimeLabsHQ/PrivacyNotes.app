/**
 * The phrase change on the device that makes it: what the wizard reads,
 * prepares and sends, the local commit after the server took the change, and
 * the handover record that finishes a change a crash or a reload interrupted.
 *
 * The order (section 5, 6.5, 6.6):
 * 1. `readChangeState`: the account as the server holds it right now: the
 *    connected logins and 2FA factors the person may keep, the browsers and
 *    the CLI that will disconnect, and the settings row, opened (this
 *    device's unsynced settings go up first).
 * 2. `newChangePhrase`: the new phrase, 12 or 24 words, which the wizard
 *    shows and checks before anything else happens.
 * 3. `prepareChange`: every value the server needs, built in memory: the new
 *    keys, the key ring (every earlier epoch's sync, local and inbox key,
 *    sealed under the new sync key), the whole new settings blob built from
 *    the server row (the new PIN wrap in it, no browser keys), the new
 *    sign-in password; and every door of this device for the new phrase,
 *    proven to open (the PIN wrap with the PIN typed fresh, the biometric
 *    record). Nothing is stored.
 * 4. `sendChange`: a fresh 2FA code from a kept factor when 2FA is on, the
 *    nonce, the two signatures, the handover record (phase `sent`), the
 *    change. A refusal drops the record. No answer asks `resolve` for the new
 *    key: `current` means the change landed, `unknown` that it did not, and
 *    no answer keeps the record for the next try.
 * 5. `commitLocalDoors`: after the answer, the PIN wrap and the biometric
 *    record of the new phrase become this device's (record phase
 *    `committed`). auth.tsx runs it inside the sequence of 6.6 (end the live
 *    sign-in, commit, announce the sign-out to older tabs, sign in with the
 *    new phrase) and drops the record once that sign-in went live.
 *
 * The handover record lives where the phrase does (trust-aware storage),
 * demo-bucketed. It never holds a
 * phrase in the clear: without an armed app lock it holds the new phrase
 * under this device's wrap key (phraseAtRest.ts); under an armed lock only
 * inside the prepared PIN wrap and biometric record, so the phrase is not at
 * rest. `finishPendingPhraseChange` reads it at boot (with the envelope) and
 * at the lock screen (with the PIN).
 *
 * No screen reaches any of this before the wizard (step 7), and the server
 * refuses every account outside its allowlist (migration 0122).
 * Spec: docs/internal/plans/phrase-change.md (section 5, 6.1, 6.5, 6.6)
 */
import {
  bytesToBase64,
  bytesToHex,
  deriveAuthPassword,
  deriveEncryptionKey,
  deriveLocalDataKey,
  deriveSigningKey,
  encryptJson,
  generatePhrase,
  isValidPhrase,
  phraseToSeed,
  signRotatePhraseChallenge,
  type SupabaseClient,
} from '@notes/shared';
import { deriveInboxKeyPair } from '@notes/shared/extension';
import type { PinWrapBlob, PreparedBiometric } from './biometric';
import type { FnError } from './devices';
import { sealKeyRing, zeroKeyRing } from './keyRingStore';
import { LEGACY_PIN_WRAP_ITERATIONS } from './secretKind';
import { sha256Hex } from './sha256Hex';
import type { SignInStamp } from './liveSignIn';
import type { ChangeEnv } from './phraseChangeEnv';
import { isUuid } from './uuid';

// The boot modules this one uses, registered by auth.tsx before any call
// (phraseChangeEnv.ts says why they are not imported here).
// The binding record writer (identity.ts) rides beside the env: the boot
// passes it, and a stand-in env without it writes no record.
type Env = ChangeEnv & { writeIdentityBinding?: typeof import('./identity').writeIdentityBinding };
let env: Env | null = null;
export function registerChangeEnv(next: Env): void {
  env = next;
}
function E(): Env {
  if (!env) throw new PhraseChangeError('not_ready');
  return env;
}

/** Who changes the phrase: the open vault's session and keys. */
export type ChangeActor = {
  supabase: SupabaseClient;
  accessToken: string;
  authUid: string;
  sessionId: string;
  /** The account id; it never changes. */
  accountId: string;
  /** The epoch of this device's current keys (currentKeyEpoch). */
  epoch: number;
  phrase: string;
  signingPrivateKey: Uint8Array;
  /** The current sync key. */
  encryptionKey: Uint8Array;
};

export type ChangeLogin = { id: string; provider: 'google' | 'apple' | 'github'; email: string | null };
export type ChangeFactor = { id: string; name: string | null };
export type ChangeConnection = { id: string; label: string; client: 'browser' | 'cli' };

/** The account as the wizard shows it in step 1 (2.3). */
export type ChangeState = {
  custodial: boolean;
  logins: ChangeLogin[];
  factors: ChangeFactor[];
  /** Browsers and the CLI: these disconnect, with no choice. */
  connections: ChangeConnection[];
  settings: { nonce: string | null; keyEpoch: number; plain: Record<string, unknown> | null; localRev: number };
};

/** What the server needs, and this device's doors for the new phrase. */
export type PreparedChange = {
  accountId: string;
  fromEpoch: number;
  toEpoch: number;
  newPhrase: string;
  newSigningPubkey: string;
  newSigningPrivateKey: Uint8Array;
  authPassword: string;
  keyRing: string;
  settingsCiphertext: string;
  settingsNonce: string;
  observedSettingsNonce: string | null;
  custodial: boolean;
  /** The account's new PIN wrap, in the settings blob; null when it has none. */
  pinWrap: PinWrapBlob | null;
  /** Whether this device keeps its own copy of the wrap, to replace. */
  localPinWrap: boolean;
  /** The new biometric record; 'remove' when the prompt was declined and the
   *  PIN stays the door; null when this device has none. */
  biometric: PreparedBiometric | 'remove' | null;
};

export type KeepList = { logins: string[]; factors: string[] };

/** A refusal the server or this device gave, by code. */
export class PhraseChangeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PhraseChangeError';
  }
}


// ── 0. Whether this account may change its phrase ────────────────────

/**
 * Whether the server lets this account change its phrase now (the allowlist
 * until launch, migration 0122). The app shows the phrase change only on a
 * true answer: anything else, an older function that does not know the
 * action included, reads as false. The demo asks nothing and shows it.
 */
export async function phraseChangeAllowed(supabase: SupabaseClient): Promise<boolean> {
  if (E().isDemoMode()) return true;
  try {
    const { data, error } = await supabase.functions.invoke('rotate-phrase', { body: { action: 'allowed' } });
    return !error && (data as { allowed?: unknown } | null)?.allowed === true;
  } catch {
    return false;
  }
}

/** Whether the change must ask for the PIN or passcode: the account's
 *  settings row holds a PIN wrap, which the change builds again. */
export function changeNeedsPin(state: ChangeState): boolean {
  return wrapOf(state.settings.plain) !== null;
}

// ── 1. The account as it is now ──────────────────────────────────────

/** Read what the wizard shows before step 1. Throws PhraseChangeError
 *  `account_management_required` for an account that is not managed yet. */
export async function readChangeState(actor: ChangeActor): Promise<ChangeState> {
  if (E().isDemoMode()) throw new PhraseChangeError('demo');
  const { supabase } = actor;
  let status = await supabase.rpc('account_status');
  if (E().isMfaRefusal(status.error)) {
    await E().ensureLevel2(supabase, { allowLocalUse: true });
    status = await supabase.rpc('account_status');
  }
  if (status.error) throw new PhraseChangeError('account_unavailable');
  const account = E().parseAccountLoginStatus(status.data);
  if (!account.managed || account.deleted || account.canonical_uid !== actor.authUid) {
    throw new PhraseChangeError('account_management_required');
  }
  const factors = await supabase.auth.mfa.listFactors();
  if (factors.error) throw new PhraseChangeError('account_unavailable');
  const tokens = await supabase.from('extension_tokens').select('id, label, client').eq('user_pubkey', actor.accountId);
  if (tokens.error) throw new PhraseChangeError('account_unavailable');
  let settings: ChangeState['settings'];
  try {
    settings = await E().readSettingsRowForChange(supabase, actor.accountId, actor.encryptionKey);
  } catch (err) {
    throw new PhraseChangeError(err instanceof Error ? err.message : 'settings_unavailable');
  }
  return {
    custodial: account.custodial === true,
    logins: account.connections.filter((c) => c.active).map((c) => ({ id: c.id, provider: c.provider, email: c.email })),
    factors: (factors.data?.totp ?? []).filter((f) => f.status === 'verified')
      .map((f) => ({ id: f.id, name: typeof f.friendly_name === 'string' && f.friendly_name ? f.friendly_name : null })),
    connections: ((tokens.data ?? []) as Array<{ id: string; label: string; client: string }>)
      .map((t) => ({ id: t.id, label: t.label, client: t.client === 'cli' ? 'cli' as const : 'browser' as const })),
    settings,
  };
}

// ── 2. The new phrase ────────────────────────────────────────────────

export function newChangePhrase(words: 12 | 24): string {
  return generatePhrase(words);
}

// ── 3. Prepare ───────────────────────────────────────────────────────

const PIN_WRAP_FIELDS = ['pinWrapSalt', 'pinWrapIV', 'pinWrapCiphertext', 'pinWrapIterations'] as const;

/** The account's PIN wrap as the settings row holds it, or null. */
function wrapOf(plain: Record<string, unknown> | null): PinWrapBlob | null {
  if (!plain) return null;
  const { pinWrapSalt, pinWrapIV, pinWrapCiphertext, pinWrapIterations } = plain;
  if (typeof pinWrapSalt !== 'string' || typeof pinWrapIV !== 'string' || typeof pinWrapCiphertext !== 'string') return null;
  // A blob written before the count was recorded is a legacy one.
  const iterations = typeof pinWrapIterations === 'number' && Number.isSafeInteger(pinWrapIterations) && pinWrapIterations > 0 ? pinWrapIterations : LEGACY_PIN_WRAP_ITERATIONS;
  return { pinWrapSalt, pinWrapIV, pinWrapCiphertext, pinWrapIterations: iterations };
}

/**
 * Build the change in memory. `pin` is the PIN or passcode typed fresh in
 * this flow (never one a gate remembered), needed when the account holds a
 * PIN wrap. `biometric` carries the two strings the native prompt shows,
 * needed when this device holds a biometric record. Throws PhraseChangeError:
 * `phrase_invalid`, `pin_required`, `pin_wrong`, `biometric_required` (the
 * fingerprint is the only door, and its prompt was declined),
 * `key_ring_incomplete` (this device lacks an earlier epoch's keys, so the
 * next ring would lose them).
 */
export async function prepareChange(
  actor: ChangeActor,
  state: ChangeState,
  input: { phrase: string; pin?: string; biometric?: { reason: string; cancelLabel: string } },
): Promise<PreparedChange> {
  const newPhrase = input.phrase.trim().toLowerCase();
  if (!isValidPhrase(newPhrase) || newPhrase === actor.phrase.trim().toLowerCase()) throw new PhraseChangeError('phrase_invalid');
  const toEpoch = actor.epoch + 1;

  // The PIN first: it is the one thing the person can get wrong.
  const oldWrap = wrapOf(state.settings.plain);
  let pinWrap: PinWrapBlob | null = null;
  if (oldWrap) {
    if (!input.pin) throw new PhraseChangeError('pin_required');
    if ((await E().openPinWrapBlob(oldWrap, input.pin)) !== actor.phrase) throw new PhraseChangeError('pin_wrong');
    pinWrap = await E().buildPinWrap(newPhrase, input.pin);
    if ((await E().openPinWrapBlob(pinWrap, input.pin)) !== newPhrase) throw new PhraseChangeError('pin_wrap_failed');
  }

  const oldSeed = phraseToSeed(actor.phrase);
  const newSeed = phraseToSeed(newPhrase);
  const { privateKey: newSigningPrivateKey, publicKey } = await deriveSigningKey(newSeed);
  const newSigningPubkey = bytesToHex(publicKey);
  const newSyncKey = deriveEncryptionKey(newSeed);

  // The ring: every earlier epoch this device holds, and the current one.
  // An epoch missing here would be lost to every device for good.
  const entries = E().ringKeyCopies();
  let keyRing: string;
  try {
    for (let e = 1; e < actor.epoch; e++) if (!entries.has(e)) throw new PhraseChangeError('key_ring_incomplete');
    entries.set(actor.epoch, {
      sync: new Uint8Array(actor.encryptionKey),
      local: deriveLocalDataKey(oldSeed),
      inbox: deriveInboxKeyPair(oldSeed).secretKey,
    });
    keyRing = sealKeyRing(entries, newSyncKey, actor.accountId, toEpoch);
  } finally {
    zeroKeyRing(entries);
  }

  // The whole blob, from the server row as stored: unknown fields of newer
  // clients ride along. The new wrap, no browser keys (the logins key P may
  // be the thief's), and a counter above the server's and this device's.
  const plain: Record<string, unknown> = { ...(state.settings.plain ?? {}) };
  const serverRev = typeof plain.settingsRev === 'number' && Number.isFinite(plain.settingsRev) ? Math.floor(plain.settingsRev) : 0;
  if (pinWrap) for (const field of PIN_WRAP_FIELDS) plain[field] = pinWrap[field];
  plain.extensionKeys = {};
  plain.settingsRev = Math.max(serverRev, state.settings.localRev) + 1;
  const sealed = encryptJson(plain, newSyncKey);
  newSyncKey.fill(0);

  // The biometric record. With a PIN as well, a declined prompt only means
  // the old record goes after the change; with the fingerprint as the only
  // door, the change waits for it.
  let biometric: PreparedChange['biometric'] = null;
  if (E().hasBiometricCredential()) {
    const onlyDoor = E().appLockArmed() && !E().hasPinWrappedPhrase() && !pinWrap;
    const made = input.biometric
      ? await E().prepareBiometricForPhrase(newPhrase, input.biometric.reason, input.biometric.cancelLabel)
      : ({ ok: false, reason: 'user_cancelled', message: '' } as const);
    if (made.ok) biometric = made.prepared;
    else if (onlyDoor) throw new PhraseChangeError('biometric_required');
    else biometric = 'remove';
  }

  return {
    accountId: actor.accountId,
    fromEpoch: actor.epoch,
    toEpoch,
    newPhrase,
    newSigningPubkey,
    newSigningPrivateKey,
    authPassword: deriveAuthPassword(newSeed),
    keyRing,
    settingsCiphertext: bytesToBase64(sealed.ciphertext),
    settingsNonce: bytesToBase64(sealed.nonce),
    observedSettingsNonce: state.settings.nonce,
    custodial: state.custodial,
    pinWrap,
    localPinWrap: E().hasPinWrappedPhrase(),
    biometric,
  };
}

/** Throw away a change that will not be sent: a prepared hardware key goes. */
export function discardPreparedChange(prepared: PreparedChange): void {
  if (prepared.biometric && prepared.biometric !== 'remove') E().discardPreparedBiometric(prepared.biometric);
  prepared.newSigningPrivateKey.fill(0);
}

// ── 4. Send ──────────────────────────────────────────────────────────

/** The rotate-phrase payload. Field names are the edge function's. */
function payloadOf(prepared: PreparedChange, keep: KeepList) {
  const ids = (list: string[]) => [...new Set(list.map((id) => id.toLowerCase()))].sort();
  return {
    epoch: prepared.fromEpoch,
    newSigningPubkey: prepared.newSigningPubkey,
    keyRing: prepared.keyRing,
    authPassword: prepared.authPassword,
    settingsCiphertext: prepared.settingsCiphertext,
    settingsNonce: prepared.settingsNonce,
    observedSettingsNonce: prepared.observedSettingsNonce,
    keepConnections: ids(keep.logins),
    keepFactors: ids(keep.factors),
    phrase: prepared.custodial ? prepared.newPhrase : null,
  };
}

/**
 * The digest the nonce is bound to and both keys sign: the same array, in
 * the same order, as `bodyDigest` in the edge function. An array has no key
 * order to drift. Pinned by tests/rotatePhraseEdge.test.ts.
 */
export async function rotateBodyDigest(p: ReturnType<typeof payloadOf>): Promise<string> {
  const text = JSON.stringify([
    'rotate-phrase-v1', p.epoch, p.newSigningPubkey, p.keyRing, p.authPassword,
    p.settingsCiphertext, p.settingsNonce, p.observedSettingsNonce,
    p.keepConnections, p.keepFactors, p.phrase,
  ]);
  return sha256Hex(new TextEncoder().encode(text));
}

async function refusalOf(error: unknown): Promise<{ code: string | null; status: number | null }> {
  const fe = error as FnError & { context?: { status?: unknown } };
  const status = typeof fe?.context?.status === 'number' ? fe.context.status : null;
  const body = (await E().readFnErrorBody(fe)) as { error?: unknown } | null;
  const code = typeof body?.error === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(body.error) ? body.error : null;
  return { code, status };
}

/** A 4xx with a code: the transaction never ran or rolled back whole. */
function definitive(r: { code: string | null; status: number | null }): boolean {
  return r.code !== null && r.status !== null && r.status >= 400 && r.status < 500;
}

export type SendResult =
  | { status: 'landed'; epoch: number }
  /** The server answered nothing readable and `resolve` gave no answer: the
   *  record stays, and `confirmPendingChange` asks again. */
  | { status: 'unknown' };

/**
 * Send the change. Answers `landed` or `unknown`; throws PhraseChangeError
 * for a refusal (the record is dropped and the prepared doors discarded).
 */
export async function sendChange(
  actor: ChangeActor,
  prepared: PreparedChange,
  keep: KeepList,
  state: ChangeState,
  /** The fresh 2FA code for a kept factor. The app's MFA prompt by default;
   *  the sync simulator, which has no prompt, passes its own. */
  verifyFactor: (factorId: string) => Promise<void> = (factorId) =>
    E().ensureLevel2(actor.supabase, { force: true, allowLocalUse: true, factorId }),
): Promise<SendResult> {
  if (E().isDemoMode()) throw new PhraseChangeError('demo');
  if (prepared.accountId !== actor.accountId || prepared.fromEpoch !== actor.epoch) throw new PhraseChangeError('phrase_change_conflict');
  if ([...keep.logins, ...keep.factors].some((id) => !isUuid(id))) throw new PhraseChangeError('phrase_change_keep_invalid');
  const { supabase } = actor;
  let session = { accessToken: actor.accessToken, sessionId: actor.sessionId };
  // With 2FA on, a code from a kept factor, fresh: the server wants one
  // inside five minutes, and the factor that gave it must stay.
  if (state.factors.length > 0) {
    if (keep.factors.length === 0) throw new PhraseChangeError('phrase_change_keep_factor');
    await verifyFactor(keep.factors[0]!);
    // The verification can refresh the token; the session stays the same
    // one, and the server refuses a signature over any other.
    const { data } = await supabase.auth.getSession();
    const live = data.session;
    if (live?.user?.id && live.user.id !== actor.authUid) throw new PhraseChangeError('account_auth_required');
    if (typeof live?.access_token === 'string' && live.access_token) session = { accessToken: live.access_token, sessionId: actor.sessionId };
  }
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const payload = payloadOf(prepared, keep);
  const bodyDigest = await rotateBodyDigest(payload);

  const issued = await supabase.functions.invoke('rotate-phrase', { body: { action: 'nonce', bodyDigest }, headers });
  if (issued.error) {
    const r = await refusalOf(issued.error);
    throw new PhraseChangeError(r.code ?? 'phrase_change_unavailable_now');
  }
  const nonceId = (issued.data as { nonceId?: unknown } | null)?.nonceId;
  if (typeof nonceId !== 'string' || !isUuid(nonceId)) throw new PhraseChangeError('phrase_change_unavailable_now');
  const challenge = {
    nonceId, authUid: actor.authUid, sessionId: session.sessionId, account: actor.accountId,
    epoch: prepared.fromEpoch, newSigningPubkey: prepared.newSigningPubkey, bodyDigest,
  };
  const currentSignature = bytesToHex(await signRotatePhraseChallenge(actor.signingPrivateKey, challenge));
  const newSignature = bytesToHex(await signRotatePhraseChallenge(prepared.newSigningPrivateKey, challenge));

  // From here the change may land: the record goes first, and stays until
  // the result is known.
  await writeHandover(prepared);
  sentAt.set(prepared, performance.now());
  let answer: Awaited<ReturnType<typeof supabase.functions.invoke>>;
  try {
    answer = await supabase.functions.invoke('rotate-phrase', {
      body: { action: 'rotate', nonceId, payload, currentSignature, newSignature }, headers,
    });
  } catch {
    answer = { data: null, error: new Error('no answer') } as never;
  }
  if (!answer.error) {
    const epoch = (answer.data as { epoch?: unknown } | null)?.epoch;
    if (epoch === prepared.toEpoch) return { status: 'landed', epoch };
  } else {
    const r = await refusalOf(answer.error);
    if (definitive(r)) {
      // A POST delivered twice is answered by its second delivery: the first
      // landed the change and ended the session, and the second is refused.
      // The new key's own `resolve` says which; only a change it does not
      // find is a refusal.
      E().forgetResolveAnswers();
      const check = await E().resolveSigningKey(supabase, prepared.newSigningPubkey, prepared.newSigningPrivateKey);
      if (check?.status === 'current' && check.accountId === prepared.accountId) return { status: 'landed', epoch: check.epoch };
      dropHandover();
      discardPreparedChange(prepared);
      throw new PhraseChangeError(r.code!);
    }
  }
  // No answer this device can read: ask whether the new key signs now.
  return confirmChange(supabase, prepared, () => sinceSent(prepared));
}

// When each change of this tab went out, on the monotonic clock: a wall
// clock that jumps, or a record another tab removed, must not end the wait.
const sentAt = new WeakMap<PreparedChange, number>();
function sinceSent(prepared: PreparedChange): number | null {
  const at = sentAt.get(prepared);
  return at === undefined ? null : performance.now() - at;
}

/** Whether a sent change landed, by the new key's own `resolve`. */
async function confirmChange(
  supabase: SupabaseClient | null,
  prepared: Pick<PreparedChange, 'accountId' | 'newSigningPubkey' | 'newSigningPrivateKey' | 'toEpoch' | 'biometric'>,
  /** How long ago the change went out, or null when that is not known. */
  elapsed: () => number | null,
): Promise<SendResult> {
  // A remembered answer can predate the change.
  E().forgetResolveAnswers();
  const answer = supabase
    ? await E().resolveSigningKey(supabase, prepared.newSigningPubkey, prepared.newSigningPrivateKey)
    : await E().resolveRegistered(prepared.newSigningPubkey, prepared.newSigningPrivateKey);
  if (answer?.status === 'current' && answer.accountId === prepared.accountId) return { status: 'landed', epoch: answer.epoch };
  if (answer?.status === 'unknown') {
    // The transaction may still run: its nonce is valid for minutes. Only
    // after SETTLE_MS is "not landed" final, and only then do the record and
    // the prepared doors go. A send time this device does not know means wait.
    const ago = elapsed();
    if (ago === null || !Number.isFinite(ago) || ago < SETTLE_MS) return { status: 'unknown' };
    dropHandover();
    if (prepared.biometric && prepared.biometric !== 'remove') E().discardPreparedBiometric(prepared.biometric);
    throw new PhraseChangeError('phrase_change_not_sent');
  }
  // Retired or deleted: a later change or a deletion followed this one.
  if (answer !== null) {
    dropHandover();
    throw new PhraseChangeError('phrase_replaced');
  }
  return { status: 'unknown' };
}

/** Ask again about a change whose answer was lost (`sendChange` said `unknown`). */
export function confirmPendingChange(supabase: SupabaseClient, prepared: PreparedChange): Promise<SendResult> {
  return confirmChange(supabase, prepared, () => sinceSent(prepared));
}

// ── 5. This device's doors ───────────────────────────────────────────

/**
 * After the server took the change: the PIN wrap and the biometric record of
 * the new phrase become this device's. `since` is the stamp taken right after
 * the changing tab ended its live sign-in (6.6). A wrap or record that cannot
 * be stored leaves no door to the replaced phrase: the old one goes too.
 */
export function commitLocalDoors(
  prepared: Pick<PreparedChange, 'pinWrap' | 'localPinWrap' | 'biometric'>,
  since: SignInStamp,
  /** The new phrase's key: the biometric part runs only while the handover
   *  record is still this change's. Another tab that took the new phrase in
   *  meanwhile discarded the prepared hardware key with the record. */
  signingPubkey: string,
): void {
  if (prepared.pinWrap && prepared.localPinWrap) {
    try {
      E().storeBuiltPinWrap(prepared.pinWrap, since);
    } catch {
      E().removePinWrappedPhrase();
    }
  } else if (!prepared.pinWrap && E().hasPinWrappedPhrase()) {
    E().removePinWrappedPhrase();
  }
  const ours = readHandover()?.signingPubkey === signingPubkey;
  if (!ours) {
    // Nothing of the prepared record is ours to store or remove now.
  } else if (prepared.biometric === 'remove') {
    E().removeBiometricCredential();
  } else if (prepared.biometric) {
    let stands = false;
    try {
      stands = E().commitPreparedBiometric(prepared.biometric, since);
    } catch {
      stands = false;
    }
    if (!stands) E().removeBiometricCredential();
  }
  markHandoverCommitted();
}

// ── The handover record ──────────────────────────────────────────────

const handoverKey = () => E().PHRASE_CHANGE_KEY;

type Handover = {
  v: 1;
  account: string;
  toEpoch: number;
  signingPubkey: string;
  phase: 'sent' | 'committed';
  pinWrap: PinWrapBlob | null;
  localPinWrap: boolean;
  biometric: PreparedBiometric | 'remove' | null;
  /** The new phrase under this device's wrap key; null under an armed lock. */
  phrase: string | null;
  /** When the change went out (this device's clock): before SETTLE_MS has
   *  passed, `unknown` from `resolve` does not mean the change will not land. */
  sentAt: number;
};

// How long a change that was sent can still land. Its nonce lives five
// minutes from issue (account_nonces) and is spent only by the commit, and
// the transaction's lock waits are bounded (lock_timeout 10s, migration 0122),
// so ten minutes after the send a `resolve` of `unknown` is final.
// Spec: docs/internal/plans/phrase-change.md (6.6)
const SETTLE_MS = 10 * 60_000;

function readHandover(): Handover | null {
  try {
    const raw = E().trustAwareStorage.getItem(handoverKey());
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<Handover> | null;
    if (rec?.v !== 1 || typeof rec.account !== 'string' || typeof rec.signingPubkey !== 'string'
      || (rec.phase !== 'sent' && rec.phase !== 'committed') || typeof rec.toEpoch !== 'number') return null;
    return rec as Handover;
  } catch {
    return null;
  }
}

function putHandover(rec: Handover): void {
  E().trustAwareStorage.setItem(handoverKey(), JSON.stringify(rec));
}

/** Written before the change is sent. Throws when the store refuses it:
 *  a change whose result this device could lose is not sent. */
async function writeHandover(prepared: PreparedChange): Promise<void> {
  const phrase = E().appLockArmed() ? null : await E().sealPhraseForDevice(prepared.newPhrase);
  if (!E().appLockArmed() && phrase === null) throw new PhraseChangeError('handover_unavailable');
  try {
    putHandover({
      v: 1, account: prepared.accountId, toEpoch: prepared.toEpoch, signingPubkey: prepared.newSigningPubkey,
      phase: 'sent', pinWrap: prepared.pinWrap, localPinWrap: prepared.localPinWrap, biometric: prepared.biometric, phrase,
      sentAt: Date.now(),
    });
  } catch {
    throw new PhraseChangeError('handover_unavailable');
  }
  if (readHandover()?.signingPubkey !== prepared.newSigningPubkey) throw new PhraseChangeError('handover_unavailable');
}

function markHandoverCommitted(): void {
  const rec = readHandover();
  if (!rec) return;
  try {
    putHandover({ ...rec, phase: 'committed' });
  } catch {
    /* the boot asks again; a record still `sent` commits nothing twice that
       matters: the stamp of a biometric record has moved */
  }
}

/** Keep the binding record of a new phrase whose change landed. Best effort. */
export async function bindNewPhrase(phrase: string, identity: { accountId: string; signingPubkey: string; epoch: number }): Promise<void> {
  try {
    await E().writeIdentityBinding?.(phraseToSeed(phrase), identity);
  } catch {
    /* the next sign-in writes it */
  }
}

/** The change finished on this device, or never landed. */
function dropHandover(): void {
  E().removePendingPhraseChange();
}

/**
 * The new phrase came in another way (the screen of 2.4): the record goes,
 * and a hardware key it prepared and never stored goes with it. A record
 * already `committed` stored that key as this device's biometric record, so
 * it stays.
 */
export function discardPendingPhraseChange(): void {
  const rec = readHandover();
  if (rec?.phase === 'sent' && rec.biometric && rec.biometric !== 'remove') E().discardPreparedBiometric(rec.biometric);
  dropHandover();
}

/**
 * Finish a change this device sent and did not finish: a crash, a closed tab
 * or a reload between the server's answer and the new phrase's sign-in.
 * The new phrase comes from the record's envelope (no armed lock) or from
 * the record's PIN wrap opened with `pin` (the lock screen). A change that
 * landed gets its doors committed, once; at boot the stored phrase becomes
 * the new one. Answers the new phrase, or null: no record, a record of
 * another account or of a change that did not land (both dropped), or no
 * answer from the server (kept for the next start).
 */
export async function finishPendingPhraseChange(
  /** The app's client; null asks through the one auth.tsx registered (identity.ts). */
  supabase: SupabaseClient | null,
  opts: { pin?: string; writeStoredPhrase?: boolean } = {},
): Promise<string | null> {
  const rec = readHandover();
  if (!rec) return null;
  let owner: string | null = null;
  try { owner = localStorage.getItem(E().PUBKEY_OWNER_KEY); } catch { /* unread: kept */ }
  if (owner !== null && owner !== rec.account) {
    dropHandover();
    return null;
  }
  let phrase: string | null = null;
  if (rec.phrase) phrase = await E().unwrapStoredEnvelope(rec.phrase);
  if (!phrase && opts.pin && rec.pinWrap) phrase = await E().openPinWrapBlob(rec.pinWrap, opts.pin);
  if (!phrase || !isValidPhrase(phrase)) return null;
  const { privateKey, publicKey } = await deriveSigningKey(phraseToSeed(phrase));
  if (bytesToHex(publicKey) !== rec.signingPubkey) {
    dropHandover();
    return null;
  }
  if (rec.phase === 'sent') {
    let result: SendResult;
    try {
      result = await confirmChange(supabase, {
        accountId: rec.account, newSigningPubkey: rec.signingPubkey, newSigningPrivateKey: privateKey,
        toEpoch: rec.toEpoch, biometric: rec.biometric,
      }, () => (typeof rec.sentAt === 'number' && Number.isFinite(rec.sentAt) ? Date.now() - rec.sentAt : null));
    } catch {
      return null;
    }
    if (result.status === 'unknown') return null;
    commitLocalDoors(rec, E().signInStamp(), rec.signingPubkey);
  }
  privateKey.fill(0);
  // The change landed: the new phrase signs for the account, and this device
  // keeps that, so an armed lock knows it offline before any sign-in.
  // Spec: docs/internal/plans/phrase-change.md (4.6)
  await bindNewPhrase(phrase, { accountId: rec.account, signingPubkey: rec.signingPubkey, epoch: rec.toEpoch });
  if (opts.writeStoredPhrase && rec.phrase) {
    try {
      E().trustAwareStorage.setItem(E().PHRASE_STORAGE_KEY, rec.phrase);
    } catch {
      return null;
    }
  }
  dropHandover();
  return phrase;
}
