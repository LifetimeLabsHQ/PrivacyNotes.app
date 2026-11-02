/**
 * A captured page into a clip, with the app's clip engine (packages/clipper):
 * Readability and Turndown, the same rules and limits as Save as note in the
 * app. Needs a DOMParser, so it runs in the popup, in Chrome's offscreen
 * document, or in Firefox's background page.
 * Spec: docs/internal/plans/browser-extension-build.md (decision E10)
 */
import { clipFits, clipHtml, isShortText, type Clip } from '@notes/clipper';
import type { CapturedPage } from './capture';

export type ClipMode = 'note' | 'selection';

export type Built =
  | { kind: 'clip'; clip: Clip; short: boolean }
  /** No main text was found, or very little: the person decides. */
  | { kind: 'short'; page: Clip | null }
  /** Too long for one note: the bookmark stands in. */
  | { kind: 'tooLong' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** The clip of a captured page. `anyway` takes the whole page when the main
 *  text is short, the app's Save anyway. */
export function buildClip(page: CapturedPage, mode: ClipMode, anyway = false): Built {
  let clip: Clip | null;
  if (mode === 'selection') {
    const html = `<!doctype html><html><head><title>${escapeHtml(page.title)}</title></head><body>${page.selectionHtml}</body></html>`;
    clip = clipHtml(html, page.url, 'page');
  } else {
    clip = clipHtml(page.html, page.url, 'main');
    if (anyway && (!clip || isShortText(clip.markdown))) clip = clipHtml(page.html, page.url, 'page') ?? clip;
    else if (!clip || isShortText(clip.markdown)) return { kind: 'short', page: clip };
  }
  if (!clip) return { kind: 'short', page: null };
  if (!clipFits(clip.markdown, clip.images)) return { kind: 'tooLong' };
  return { kind: 'clip', clip, short: isShortText(clip.markdown) };
}

/** A page's address the extension may clip: the web, nothing of the browser's own. */
export function clippable(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // The stores refuse every extension.
    return !/^(chrome\.google\.com|chromewebstore\.google\.com|addons\.mozilla\.org|microsoftedge\.microsoft\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}
