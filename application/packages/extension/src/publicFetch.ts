/**
 * A download the extension makes for a clip (a picture, or the page behind a
 * link for Save linked page) reaches only the public web. The page being
 * clipped names these addresses, and the extension's host permission lets
 * the request out where the page itself could not send it, so an address on
 * the person's own computer or network is refused at every hop, with the
 * address rule the app's /clip-fetch uses (`isPrivateHost`). Each redirect is
 * taken by hand so its target is checked first. Chrome and Edge hide the
 * target of a redirect (an opaque redirect): a picture, which the page names,
 * then gets no download. A link the person chose for Save linked page
 * (`followHidden`) is fetched again with the browser following, and kept only
 * when the final address is public. A public name is not looked up: the
 * extension has no lookup to ask.
 * Spec: docs/internal/specs/web-clipper-stage1.md (section 3.1)
 */
import { isPrivateHost } from '@notes/clipper';

const MAX_REDIRECTS = 5;

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
