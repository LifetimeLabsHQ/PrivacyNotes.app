/**
 * The passkey relay: the extension's isolated world in the same pages as the
 * page script, top frame only. It carries a request from the page script to
 * the background and the popup's answer back. It answers nothing (so the
 * page script uses the browser) in a sandboxed document, in an insecure
 * context, on our own origins, for a `create` without a user action (review
 * 8), for a second request while one is open or one over 64 KB (beta #126:
 * a page cannot fill the background's one queue), and when the extension's
 * runtime is gone: after an update, a script left in an older tab has no
 * runtime, and it must not ack a request it cannot send. A page's abort
 * reaches the background only after the request's reply, so the door never
 * decides a request after its abort (beta #124). It takes an answer only
 * from the extension's own pages, by their address (a popup window and
 * Firefox both set `sender.tab`).
 * Spec: docs/contrib/passkeys.md (section 5.4)
 */
import { browser } from 'wxt/browser';
import { passkeysReleased } from '../src/passkeyRelease';
import {
  fromOwnPage,
  isOurOrigin,
  REQUEST_MAX_CHARS,
  REQUEST_MAX_MS,
  type DoorReply,
  type PageMessage,
  type PasskeyAnswerMessage,
  type PasskeyRequestMessage,
  type PasskeyResult,
} from '../src/passkeyWire';

export default defineContentScript({
  // The pages are the background's registration (`syncPasskeyScripts`,
  // PASSKEY_MATCHES): none here, so the manifest gains no host permission.
  matches: [],
  runAt: 'document_start',
  allFrames: false,
  // Registered by the background only while the switch is on (review 9).
  registration: 'runtime',
  // WXT's own "started" message would reach the page's listeners.
  noScriptStartedPostMessage: true,
  main() {
    if (!passkeysReleased()) return;
    if (window.top !== window || self.origin === 'null' || !isSecureContext || isOurOrigin(location.origin)) return;
    relay();
  },
});

/** Send to the background, or null when the runtime is gone (an orphaned
 *  script throws at once in Chrome and Edge). */
function trySend<T>(message: unknown): Promise<T> | null {
  try {
    if (!browser.runtime?.id) return null;
    return browser.runtime.sendMessage(message) as Promise<T>;
  } catch {
    return null;
  }
}

/** The options' length as JSON, as the door measures them; a value with no
 *  JSON form counts as too large. */
function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? Infinity;
  } catch {
    return Infinity;
  }
}

function relay(): void {
  const origin = location.origin;
  /** Requests in flight, each with the timer that ends it. */
  const open = new Map<string, ReturnType<typeof setTimeout>>();
  /** The background's reply to each open `passkey-request`; at most one. */
  const replies = new Map<string, Promise<unknown>>();
  const post = (msg: PageMessage) => window.postMessage(msg, origin);
  const answer = (id: string, result: PasskeyResult) => {
    const timer = open.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    open.delete(id);
    replies.delete(id);
    post({ pn: 'passkey-answer', id, result });
  };
  /** Ack only a request that went out; the time-out answers what the
   *  browser's own prompt says when it times out. */
  const start = (id: string, sent: Promise<unknown>, onReply: (reply: unknown) => PasskeyResult) => {
    open.set(id, setTimeout(() => answer(id, { kind: 'error', name: 'NotAllowedError' }), REQUEST_MAX_MS));
    post({ pn: 'passkey-ack', id });
    sent.then((reply) => answer(id, onReply(reply)), () => answer(id, { kind: 'fallback' }));
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== origin) return;
    const msg = event.data as PageMessage | null;
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || msg.id.length > 64) return;
    if (msg.pn === 'passkey-abort') {
      if (!open.has(msg.id)) return;
      clearTimeout(open.get(msg.id));
      open.delete(msg.id);
      // After the request's reply: an abort the door reads while it still
      // decides the request would find nothing and be lost (beta #124).
      const id = msg.id;
      const send = () => void trySend({ type: 'passkey-abort', id })?.catch(() => undefined);
      (replies.get(id) ?? Promise.resolve()).then(send, send);
      replies.delete(id);
      return;
    }
    if (open.has(msg.id)) return;
    if (msg.pn === 'passkey-uvpa') {
      const sent = trySend<{ available?: boolean }>({ type: 'passkey-uvpa' });
      if (sent) start(msg.id, sent, (r) => ((r as { available?: boolean } | undefined)?.available === true ? { kind: 'available' } : { kind: 'fallback' }));
      return;
    }
    if (msg.pn !== 'passkey-request' || (msg.kind !== 'create' && msg.kind !== 'get')) return;
    // A site may not open the save prompt on its own (review 8).
    const active = navigator.userActivation?.isActive === true;
    if (msg.kind === 'create' && !active) return;
    // One request at a time per document, and none the door would refuse for
    // its size, so a page cannot keep the background's queue busy (beta #126).
    if (replies.size > 0 || jsonSize(msg.options) > REQUEST_MAX_CHARS) return;
    const request: PasskeyRequestMessage = { type: 'passkey', id: msg.id, kind: msg.kind, options: msg.options, active };
    const sent = trySend<DoorReply | undefined>(request);
    // No runtime: no ack, so the page script calls the browser at once.
    if (!sent) return;
    // A refusal or no answer: the browser's prompt. A prompt: the popup answers.
    const id = msg.id;
    replies.set(id, sent);
    open.set(id, setTimeout(() => answer(id, { kind: 'error', name: 'NotAllowedError' }), REQUEST_MAX_MS));
    post({ pn: 'passkey-ack', id });
    sent.then(
      (reply) => {
        if (reply?.kind !== 'prompt') answer(id, { kind: 'fallback' });
      },
      () => answer(id, { kind: 'fallback' }),
    );
  });

  browser.runtime.onMessage.addListener((msg: PasskeyAnswerMessage, sender) => {
    if (msg?.type !== 'passkey-answer' || !fromOwnPage(sender, browser.runtime.id, browser.runtime.getURL('/'))) return;
    if (typeof msg.id === 'string' && msg.result && typeof msg.result === 'object') answer(msg.id, msg.result);
  });
}
