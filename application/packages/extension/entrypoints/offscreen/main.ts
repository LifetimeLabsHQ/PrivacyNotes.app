/**
 * Chrome's offscreen document: a DOM for the clip engine when the popup is
 * closed (a right-click save), and the clipboard for Copy page as Markdown
 * and for clearing a copied password. Firefox's background page has both
 * itself and never opens this.
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.3 and 3.4, step 5)
 */
import { browser } from 'wxt/browser';
import { buildClip } from '../../src/clipping';
import type { OffscreenMessage } from '../../src/messages';

const area = document.getElementById('clip') as HTMLTextAreaElement;

// A copy sets its own text through the copy event, so it works with nothing
// selected, the empty text that clears a password included.
let pending = '';
document.addEventListener('copy', (e) => {
  e.clipboardData?.setData('text/plain', pending);
  e.preventDefault();
});

function copy(text: string): boolean {
  pending = text;
  const ok = document.execCommand('copy');
  pending = '';
  return ok;
}

function read(): string {
  area.value = '';
  area.focus();
  document.execCommand('paste');
  const text = area.value;
  area.value = '';
  return text;
}

browser.runtime.onMessage.addListener((msg: OffscreenMessage, sender, sendResponse) => {
  // Only the background (an extension page), never a script in a site.
  if (msg?.target !== 'offscreen' || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL('/'))) return;
  if (msg.type === 'clip') sendResponse(buildClip(msg.page, msg.mode, msg.anyway));
  else if (msg.type === 'copy') sendResponse(copy(msg.text));
  else if (msg.type === 'read') sendResponse(read());
});
