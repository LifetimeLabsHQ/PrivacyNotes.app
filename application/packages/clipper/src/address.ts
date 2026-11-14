/**
 * Which addresses a download must never reach: a private, loopback,
 * link-local or reserved IP address, and a name only a local network
 * answers. One rule for the three download paths that run in JavaScript:
 * the Worker's /clip-fetch (packages/web/clipFetchRoute.ts, which also looks
 * a name up), and the extension's picture and linked-page downloads
 * (packages/extension/src/publicFetch.ts, which cannot). It imports nothing,
 * so the Worker bundles it without the clip engine. The desktop's
 * `clip_fetch` (clip_fetch.rs `is_blocked`) refuses the same ranges.
 * Spec: docs/internal/specs/web-clipper-stage1.md (section 3.1)
 */

const LOCAL_NAMES = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa|localdomain)$/i;

/** A URL's host as an address or a name: no brackets, lower case. */
export function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Whether a URL names, by literal or by a local name, a host outside the
 *  public web. A public name is not looked up here. */
export function isPrivateHost(url: URL): boolean {
  const host = bareHost(url);
  const literal = parseIp(host);
  if (literal) return isBlockedIp(literal);
  return !host.includes('.') || LOCAL_NAMES.test(host);
}

export type Ip = { v: 4; parts: number[] } | { v: 6; parts: number[] };

/** Parse a dotted IPv4 or a colon IPv6 address, or null. `URL` has already
 *  normalised every IPv4 spelling (octal, hex, short) to dotted decimal. */
export function parseIp(text: string): Ip | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    return parts.every((p) => p <= 255) ? { v: 4, parts } : null;
  }
  if (!text.includes(':')) return null;
  let s = text;
  const tailV4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tailV4) {
    const t = parseIp(tailV4[1]!);
    if (!t || t.v !== 4) return null;
    const [a, b, c, d] = t.parts as [number, number, number, number];
    s = `${s.slice(0, -tailV4[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { v: 6, parts: groups.map((g) => parseInt(g, 16)) };
}

/** The same ranges `clip_fetch` refuses (clip_fetch.rs `is_blocked`). */
export function isBlockedIp(ip: Ip): boolean {
  if (ip.v === 4) {
    const [a, b, c] = ip.parts as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const p = ip.parts as [number, number, number, number, number, number, number, number];
  const embedded = (hi: number, lo: number): Ip => ({ v: 4, parts: [hi >> 8, hi & 255, lo >> 8, lo & 255] });
  if (p.slice(0, 5).every((x) => x === 0) && p[5] === 0xffff) return isBlockedIp(embedded(p[6], p[7]));
  if (p.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and the IPv4-compatible form
  if (p.slice(0, 4).every((x) => x === 0) && p[4] === 0xffff && p[5] === 0) return isBlockedIp(embedded(p[6], p[7]));
  if (p[0] === 0x64 && p[1] === 0xff9b && p[2] === 1) return true; // local NAT64 64:ff9b:1::/48, any layout
  if (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0)) return isBlockedIp(embedded(p[6], p[7]));
  if (p[0] === 0x2001 && p[1] === 0) return isBlockedIp(embedded(~p[6] & 0xffff, ~p[7] & 0xffff));
  if (p[0] === 0x2002) return isBlockedIp(embedded(p[1], p[2]));
  return (
    (p[0] & 0xfe00) === 0xfc00 ||
    (p[0] & 0xffc0) === 0xfe80 ||
    (p[0] & 0xffc0) === 0xfec0 ||
    (p[0] & 0xff00) === 0xff00 ||
    (p[0] === 0x2001 && p[1] === 0x0db8) ||
    (p[0] === 0x0100 && p[1] === 0 && p[2] === 0 && p[3] === 0)
  );
}
