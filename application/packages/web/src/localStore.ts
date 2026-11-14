/**
 * Small device values in localStorage. Every read and write survives storage
 * that throws (a private window, blocked site data): a read gives the
 * fallback, a write is dropped and the caller's memory copy holds for the page.
 */

/** A '1' / '0' switch; off when unset or unreadable. */
export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** A JSON value, or `fallback` when it is missing or unreadable. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage refused: the caller's copy holds for this page. */
  }
}

/** A stored list of strings, other members dropped; empty when unreadable. */
export function readStringList(key: string, area: 'local' | 'session' = 'local'): string[] {
  try {
    const raw = (area === 'session' ? sessionStorage : localStorage).getItem(key);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
