import { getDomain, getHostname } from 'tldts';
import type { BookmarkCopyEntry, CopyEntry, LoginCopyEntry } from '@notes/shared/extension';

/**
 * The items for a page: those for the exact host first; only when there is
 * none, those for the registrable domain, with private suffixes on, so
 * one github.io site never sees another's. Logins and bookmarks match a
 * page; cards and keys never do.
 */
function hostOf(u: string): string | null {
  return getHostname(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
}

function matchByHost<T>(items: readonly T[], hostsOf: (item: T) => string[], pageUrl: string): T[] {
  const host = getHostname(pageUrl);
  if (!host) return [];
  const exact = items.filter((i) => hostsOf(i).includes(host));
  if (exact.length) return exact;
  const domain = getDomain(pageUrl, { allowPrivateDomains: true });
  if (!domain) return [];
  return items.filter((i) => hostsOf(i).some((h) => getDomain(h, { allowPrivateDomains: true }) === domain));
}

const loginHosts = (l: LoginCopyEntry) => l.urls.map(hostOf).filter(Boolean) as string[];
const bookmarkHosts = (b: BookmarkCopyEntry) => [hostOf(b.url)].filter(Boolean) as string[];

export function matchLogins(logins: readonly LoginCopyEntry[], pageUrl: string): LoginCopyEntry[] {
  return matchByHost(logins, loginHosts, pageUrl);
}

export function matchBookmarks(bookmarks: readonly BookmarkCopyEntry[], pageUrl: string): BookmarkCopyEntry[] {
  return matchByHost(bookmarks, bookmarkHosts, pageUrl);
}

export const loginsOf = (entries: readonly CopyEntry[]): LoginCopyEntry[] => entries.filter((e): e is LoginCopyEntry => e.kind === 'login');
const bookmarksOf = (entries: readonly CopyEntry[]): BookmarkCopyEntry[] => entries.filter((e): e is BookmarkCopyEntry => e.kind === 'bookmark');

/** The first section of the popup: the page's logins and bookmarks. */
export function forSite(entries: readonly CopyEntry[], pageUrl: string): CopyEntry[] {
  return [...matchLogins(loginsOf(entries), pageUrl), ...matchBookmarks(bookmarksOf(entries), pageUrl)];
}

/** One address, as the app's bookmark dedupe sees it: no scheme, no www,
 *  no hash, no trailing slash, case-folded host. */
export function addressKey(url: string): string {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${u.search}`;
  } catch {
    return url;
  }
}

/** The bookmark of this very page, or null. */
export function bookmarkOfPage(entries: readonly CopyEntry[], pageUrl: string): BookmarkCopyEntry | null {
  const key = addressKey(pageUrl);
  return bookmarksOf(entries).find((b) => addressKey(b.url) === key) ?? null;
}

/** A free-text search over every entry: the name, the username, the sites,
 *  the holder, the key type. Never a password, a number or a code. */
export function searchEntries(entries: readonly CopyEntry[], query: string, limit = 50): CopyEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const texts = (e: CopyEntry): string[] => {
    switch (e.kind) {
      case 'login':
        return [e.name, e.username, ...e.urls];
      case 'card':
        return [e.name, e.holder, e.network, e.number.slice(-4)];
      case 'ssh':
        return [e.name, e.keyType, e.fingerprint];
      case 'bookmark':
        return [e.name, e.url];
    }
  };
  return entries.filter((e) => texts(e).some((v) => v.toLowerCase().includes(q))).slice(0, limit);
}

/** The list's order: pinned first, then by name, the way the app sorts. */
export function byName(a: CopyEntry, b: CopyEntry): number {
  return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
}
