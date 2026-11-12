/**
 * The clipboard, from the background: Chrome's offscreen document or
 * Firefox's background page. A copied secret is cleared after 30 seconds,
 * only when the clipboard still holds it; the check keeps a hash of the value
 * in session storage, never the value.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, step 5)
 */
import { browser } from 'wxt/browser';
import { hashHex } from '@notes/shared/extension';
import type { OffscreenMessage } from './messages';

export const CLEAR_ALARM = 'clear-clipboard';
const CLEAR_KEY = 'clipboardHash';
// Spec: docs/internal/plans/browser-extension-build.md (section 3.4, 30 seconds)
export const CLEAR_AFTER_MS = 30_000;

const hasDom = () => typeof document !== 'undefined' && typeof DOMParser === 'function';

async function ensureOffscreen(): Promise<void> {
  const chromeApi = (globalThis as { chrome?: typeof browser & { offscreen?: { createDocument: (o: unknown) => Promise<void> }; runtime: { getContexts?: (f: unknown) => Promise<unknown[]> } } }).chrome;
  if (!chromeApi?.offscreen) return;
  const url = browser.runtime.getURL('/offscreen.html');
  const open = (await chromeApi.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })) ?? [];
  if (open.length) return;
  await chromeApi.offscreen.createDocument({
    url,
    reasons: ['DOM_PARSER', 'CLIPBOARD'],
    justification: 'Turn a page the person clips into a note, and copy or clear a value they asked to copy.',
  }).catch(() => undefined);
}

export function offscreen<T>(msg: OffscreenMessage): Promise<T> {
  return ensureOffscreen().then(() => browser.runtime.sendMessage(msg) as Promise<T>);
}

export async function writeClipboard(text: string): Promise<boolean> {
  if (hasDom()) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return offscreen<boolean>({ target: 'offscreen', type: 'copy', text });
}

async function readClipboard(): Promise<string | null> {
  try {
    if (hasDom()) return await navigator.clipboard.readText();
    return await offscreen<string>({ target: 'offscreen', type: 'read' });
  } catch {
    return null;
  }
}

const valueHash = (text: string) => hashHex(new TextEncoder().encode(`pn-clipboard:${text}`));

/** Remember a copied secret, so the alarm can clear it if it is still there. */
export async function clearLater(text: string): Promise<void> {
  await browser.storage.session.set({ [CLEAR_KEY]: valueHash(text) });
  browser.alarms.create(CLEAR_ALARM, { when: Date.now() + CLEAR_AFTER_MS });
}

export async function copySecret(text: string): Promise<boolean> {
  const ok = await writeClipboard(text);
  if (ok) await clearLater(text);
  return ok;
}

export async function clearIfStill(): Promise<void> {
  const want = (await browser.storage.session.get(CLEAR_KEY))[CLEAR_KEY] as string | undefined;
  await browser.storage.session.remove(CLEAR_KEY);
  if (!want) return;
  const now = await readClipboard();
  if (now !== null && valueHash(now) === want) await writeClipboard('');
}
