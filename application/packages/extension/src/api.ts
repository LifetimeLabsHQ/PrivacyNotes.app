/**
 * The three edge functions, as the extension calls them: a JSON POST, an
 * opaque code back. `status` 0 means no answer at all (offline), which a
 * caller treats as "try again later", never as a refusal.
 * Spec: docs/internal/plans/browser-extension-build.md (section 4)
 */
import { browser } from 'wxt/browser';
import { FUNCTIONS_URL } from './config';

export type Answer<T = Record<string, unknown>> =
  /** `serverTime`: the answer's `Date` header (ms), the server's clock, for
   *  a comparison with its `changed_at` times (passkeys.md section 6). */
  | { ok: true; status: number; body: T; serverTime?: number }
  | { ok: false; status: number; error: string; body: Record<string, unknown> };

/** `signal`: the caller gives up on the request; an aborted one reads as offline. */
export async function call<T = Record<string, unknown>>(fn: 'extension-pair' | 'clip-inbox' | 'extension-logins', body: unknown, signal?: AbortSignal): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { ok: false, status: 0, error: 'offline', body: {} };
  }
  let parsed: Record<string, unknown> = {};
  try {
    // Only an object is an answer. JSON `null`, a list or a bare value (from a
    // network in front of the server) reads as the bare status too.
    const got: unknown = await res.json();
    if (got && typeof got === 'object' && !Array.isArray(got)) parsed = got as Record<string, unknown>;
  } catch {
    // An answer with no JSON body reads as the bare status.
  }
  const date = Date.parse(res.headers.get('date') ?? '');
  if (res.ok && Number.isFinite(date)) await keepServerTime(date);
  if (res.ok) return { ok: true, status: res.status, body: parsed as T, ...(Number.isFinite(date) ? { serverTime: date } : {}) };
  return { ok: false, status: res.status, error: typeof parsed.error === 'string' ? parsed.error : 'internal', body: parsed };
}

const SERVER_CLOCK_KEY = 'serverClock';

/** The newest server time of any answer, kept across restarts. */
async function keepServerTime(at: number): Promise<void> {
  try {
    const kept = (await browser.storage.local.get(SERVER_CLOCK_KEY))[SERVER_CLOCK_KEY];
    if (typeof kept !== 'number' || at > kept) await browser.storage.local.set({ [SERVER_CLOCK_KEY]: at });
  } catch {
    // No storage: the next answer tries again.
  }
}

/** The newest time the server answered with, on its clock: a time it had
 *  passed before anything queued after it (queue.ts `since`). Any answer
 *  counts (unlock, pull, a post), so it is fresh even when the last
 *  completed pull is old (passkeys.md section 6). */
export async function serverClock(): Promise<number | undefined> {
  try {
    const kept = (await browser.storage.local.get(SERVER_CLOCK_KEY))[SERVER_CLOCK_KEY];
    return typeof kept === 'number' ? kept : undefined;
  } catch {
    return undefined;
  }
}
