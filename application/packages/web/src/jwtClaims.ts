/**
 * The claims of a JWT (its base64url JSON payload), or null when the token is
 * unreadable. No verification: every claim read from it is a hint, and every
 * action it gates is authorized again server-side. Import-free, so the
 * settings sync reads the server-signed `iat` without the sign-in modules.
 */
export function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  try {
    const raw = token.split('.')[1];
    if (!raw) return null;
    const value: unknown = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
