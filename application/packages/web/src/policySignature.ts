import { POLICY_PUBLIC_KEY } from './policyKey';

/**
 * Reads an update policy file and says whether the release signed it.
 *
 * A policy file can carry a release floor, and a floor above the build pauses
 * every server write (versionFloor.ts). So a floor counts only when the file
 * names the channel of this build, carries its `issued` time (seconds), and
 * `<file>.minisig` holds a valid minisign signature over its exact bytes, by
 * the key in policyKey.ts. The channel is inside the signed bytes because a
 * signed policy of one channel must not count on another: each channel has
 * its own floor. `issued` lets versionFloor.ts refuse an older signed file
 * served again.
 *
 * `signed` is false for a missing signature, one that does not fit, a
 * network error on it, another channel, or no `issued`. The callers then
 * report nothing: the floor they hold stays, and the app keeps working.
 *
 * Spec: docs/internal/android-update-check.md (The policy signature)
 */
export type PolicyChannel = 'linux' | 'android' | 'ios' | 'play';

const POLICY_TIMEOUT_MS = 30_000;

function policyAbortSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(POLICY_TIMEOUT_MS)
    : undefined;
}

export type FetchedPolicy =
  | { policy: Record<string, unknown>; signed: false }
  | { policy: Record<string, unknown>; signed: true; issued: number };

/** The policy at `url`, or null when it is missing or not a JSON object.
 *  Throws when the host cannot be reached, as `fetch` does. */
export async function fetchPolicy(url: string, channel: PolicyChannel): Promise<FetchedPolicy | null> {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store', signal: policyAbortSignal() });
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  let policy: unknown;
  try {
    policy = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) return null;
  const fields = policy as Record<string, unknown>;
  const { issued } = fields;
  if (fields.channel !== channel || typeof issued !== 'number' || !Number.isSafeInteger(issued) || issued < 0) {
    return { policy: fields, signed: false };
  }
  return (await hasSignature(url, bytes)) ? { policy: fields, signed: true, issued } : { policy: fields, signed: false };
}

async function hasSignature(url: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const res = await fetch(`${url}.minisig?t=${Date.now()}`, { cache: 'no-store', signal: policyAbortSignal() });
    if (!res.ok) return false;
    const signature = await res.text();
    // Loaded here, not at the top: the check and its hash stay off the boot path.
    const { verifyMinisign } = await import('@notes/shared/minisign');
    return await verifyMinisign(bytes, signature, POLICY_PUBLIC_KEY);
  } catch {
    return false;
  }
}
