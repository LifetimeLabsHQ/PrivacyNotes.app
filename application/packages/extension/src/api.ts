/**
 * The three edge functions, as the extension calls them: a JSON POST, an
 * opaque code back. `status` 0 means no answer at all (offline), which a
 * caller treats as "try again later", never as a refusal.
 * Spec: docs/internal/plans/browser-extension-build.md (section 4)
 */
import { FUNCTIONS_URL } from './config';

export type Answer<T = Record<string, unknown>> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error: string; body: Record<string, unknown> };

export async function call<T = Record<string, unknown>>(fn: 'extension-pair' | 'clip-inbox' | 'extension-logins', body: unknown): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, error: 'offline', body: {} };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // An answer with no JSON body reads as the bare status.
  }
  if (res.ok) return { ok: true, status: res.status, body: parsed as T };
  return { ok: false, status: res.status, error: typeof parsed.error === 'string' ? parsed.error : 'internal', body: parsed };
}
