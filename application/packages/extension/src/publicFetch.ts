/**
 * A download the extension makes for a clip (a picture, or the page behind a
 * link for Save linked page) reaches only the public web. The page being
 * clipped names these addresses, and the extension's host permission lets
 * the request out where the page itself could not send it, so an address on
 * the person's own computer or network is refused at every hop the
 * extension can see, with the address rule the app's /clip-fetch uses
 * (`isPrivateHost`). Each redirect is taken by hand so its target is checked
 * first. Chrome and Edge hide the target of a redirect (an opaque redirect):
 * a picture, which the page names, then gets no download. A link the person
 * chose for Save linked page (`followHidden`) is fetched again with the
 * browser following, so the hops after the hidden one are not checked: a
 * link that redirects to an address on the person's network gets one request
 * there, with no cookies, and its answer is dropped, since only an answer
 * whose final address is public is kept (a chain that passes a private
 * address and ends on a public one is kept). A linked page gets 20 seconds
 * and is read up to 5 MB (`fetchLinkedPage`). A public name is not looked up:
 * the extension has no lookup to ask.
 * Spec: docs/internal/specs/web-clipper-stage1.md (section 3.1)
 */
import { isPrivateHost } from '@notes/clipper';

const MAX_REDIRECTS = 5;
// A linked page, as a picture download (pictures.ts): 20 seconds, and the
// first 5 MB of it (beta #217 item 6).
const PAGE_MS = 20_000;
const PAGE_MAX_BYTES = 5_000_000;

function publicUrl(raw: string, base?: URL): URL | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || isPrivateHost(url)) return null;
    return url;
  } catch {
    return null;
  }
}

/** The answer of the last hop, or null when an address is refused, a
 *  redirect cannot be read, or the chain is too long. Throws as `fetch` does
 *  when there is no answer. */
export async function fetchPublic(raw: string, init: RequestInit, followHidden = false): Promise<Response | null> {
  let url = publicUrl(raw);
  for (let hop = 0; url; hop++) {
    const res = await fetch(url.href, { ...init, redirect: 'manual' });
    if (res.type === 'opaqueredirect') {
      if (!followHidden) return null;
      const followed = await fetch(url.href, { ...init, redirect: 'follow' });
      return publicUrl(followed.url || url.href) ? followed : null;
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    await res.body?.cancel();
    if (hop === MAX_REDIRECTS) return null;
    const next = publicUrl(location, url);
    // A chain that reached https stays on it, as in /clip-fetch.
    url = next && !(url.protocol === 'https:' && next.protocol === 'http:') ? next : null;
  }
  return null;
}

/** The first `max` bytes of a body, as text; the rest is never read. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let read = 0;
  while (read < max) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    const part = value.subarray(0, max - read);
    read += part.length;
    text += decoder.decode(part, { stream: true });
  }
  await reader.cancel();
  return text + decoder.decode();
}

/** The page behind a link for Save linked page: HTML only, without cookies,
 *  within 20 seconds and its first 5 MB; null otherwise. */
export async function fetchLinkedPage(url: string): Promise<{ url: string; html: string } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PAGE_MS);
  try {
    const res = await fetchPublic(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal }, true);
    const type = res?.headers.get('content-type') ?? '';
    if (!res?.ok || !/text\/html|application\/xhtml/.test(type)) {
      await res?.body?.cancel();
      return null;
    }
    return { url: res.url || url, html: await readCapped(res, PAGE_MAX_BYTES) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
