/**
 * When the recovery phrase of a custodial account went to another sign-in:
 * the server answers the first release of each other session newer than what
 * this device already showed (`custodial_release_notices`, migration 0174),
 * oldest first, and its own clock. The mark of what was shown is per account
 * and per device and always a time of the server, never of this device: a
 * device with no mark starts it at the server's time, so it does not show the
 * account's past sign-ins as news, and an empty answer moves it up to a minute
 * before the server's time, so this device's own earlier sign-ins are behind
 * it while a release still being written is not.
 * Spec: docs/internal/plans/custodial-release-hardening.md (section 13.1)
 */
import { bytesToHex, signCustodialDecideChallenge, type SupabaseClient } from '@notes/shared';
import { jwtPayloadSessionId } from './authStorage';

const seenKey = (pubkey: string) => `privacynotes.releaseNoticeSeen.${pubkey}`;
const SETTLE_MS = 60_000;

function readMark(pubkey: string): string | null {
  try {
    const stored = localStorage.getItem(seenKey(pubkey));
    return stored && !Number.isNaN(Date.parse(stored)) ? stored : null;
  } catch {
    return null;
  }
}

function raiseMark(pubkey: string, at: string): void {
  const now = readMark(pubkey);
  if (now && Date.parse(now) >= Date.parse(at)) return;
  try {
    localStorage.setItem(seenKey(pubkey), at);
  } catch {
    // A storage that refuses keeps the notice up until it is dismissed again.
  }
}

/** The mark key, for a tab that listens to another tab's dismiss. */
export const releaseSeenKey = seenKey;

/** True when this device's mark is at or past `at`. */
export function releaseSeen(pubkey: string, at: string): boolean {
  const mark = readMark(pubkey);
  return mark !== null && Date.parse(mark) >= Date.parse(at);
}

/**
 * The oldest release this device has not shown; null when there is none,
 * and undefined when the server gave no answer, so the caller asks again
 * soon. Never throws.
 */
export async function nextRelease(supabase: SupabaseClient, pubkey: string): Promise<string | null | undefined> {
  try {
    const mark = readMark(pubkey);
    const { data, error } = await supabase.rpc('custodial_release_notices', { p_since: mark });
    const answer = data as { now?: unknown; times?: unknown } | null;
    if (error || typeof answer?.now !== 'string' || Number.isNaN(Date.parse(answer.now)) || !Array.isArray(answer.times)) return undefined;
    if (mark === null) {
      raiseMark(pubkey, answer.now);
      return null;
    }
    const first = answer.times[0];
    if (typeof first === 'string' && !Number.isNaN(Date.parse(first))) return first;
    raiseMark(pubkey, new Date(Date.parse(answer.now) - SETTLE_MS).toISOString());
    return null;
  } catch {
    return undefined;
  }
}

/** The person saw the notice for this release and every older one. */
export function markReleaseSeen(pubkey: string, at: string): void {
  raiseMark(pubkey, at);
}

/** The short code both screens show for one request, so the person allows
 *  the sign-in they see in front of them and not another one. */
export function requestCode(id: string): string {
  return id.replace(/-/g, '').slice(0, 6).toUpperCase();
}

/** A new sign-in of the account that waits for this device's answer. */
export type ReleaseRequest = { id: string; at: string; until: string | null };

/**
 * The account's new sign-ins that ask for the phrase and wait for an answer
 * (`custodial_release_pending`, migration 0175), oldest first; null when the
 * server gave no answer. Never throws.
 * Spec: docs/internal/plans/custodial-release-hardening.md (section 13.2)
 */
export async function pendingReleaseRequests(supabase: SupabaseClient): Promise<ReleaseRequest[] | null> {
  try {
    const { data, error } = await supabase.rpc('custodial_release_pending');
    if (error || !Array.isArray(data)) return null;
    return data.filter((r): r is ReleaseRequest => typeof r?.id === 'string' && typeof r?.at === 'string'
      && (r.until === null || typeof r.until === 'string'));
  } catch {
    return null;
  }
}

/**
 * Allow or deny one request, signed with the account's current key over the
 * request, the answer, this login and this session (custodial-release-decide).
 * True when the server took the answer; false otherwise, the request stays.
 */
export async function decideReleaseRequest(supabase: SupabaseClient, request: string, allow: boolean, account: string, signingPrivateKey: Uint8Array): Promise<boolean> {
  try {
    const session = (await supabase.auth.getSession()).data.session;
    const sessionId = session?.access_token ? jwtPayloadSessionId(session.access_token) : null;
    if (!session?.user?.id || !sessionId) return false;
    const signature = await signCustodialDecideChallenge(signingPrivateKey, { requestId: request, allow, authUid: session.user.id, sessionId, account });
    const { error } = await supabase.functions.invoke('custodial-release-decide', { body: { requestId: request, allow, signature: bytesToHex(signature) } });
    return !error;
  } catch {
    return false;
  }
}
