/**
 * The fill script's two doors. `probe` says what this frame could fill, with
 * no secret in the question or the answer. `fill` gets one login and writes
 * it. After a username-only fill it can wait in this page for the password
 * field of the same sign-in and write that once.
 * Spec: docs/internal/plans/click-to-fill.md (sections 3.2, 3.6 and 3.7)
 */
import { activeElement, readPage } from './read';
import { analyze, type Plan } from './rules';
import type { FillPart, FillReason, FillRequest, FrameReport, FrameResult } from './types';
import { focusField, writeBoxes, writeField, type WriteResult } from './write';

// Spec: docs/internal/plans/click-to-fill.md (section 3.7)
const FILL_WAIT_MS = 120_000;
const WATCH_EVERY_MS = 150;
const WATCH_POLL_MS = 1000;
// Spec: docs/internal/plans/click-to-fill.md (section 3.6)
const MIN_FRAME_WIDTH = 40;
const MIN_FRAME_HEIGHT = 15;

const WATCHED = ['type', 'class', 'style', 'hidden', 'disabled', 'readonly', 'aria-hidden'];

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A frame the script never works in: sandboxed, or too small to be a form. */
function refusedFrame(view: Window): boolean {
  if ((view as { origin?: string }).origin === 'null') return true;
  try {
    const sandbox = view.frameElement?.getAttribute('sandbox');
    if (sandbox != null && !(sandbox.includes('allow-scripts') && sandbox.includes('allow-same-origin'))) return true;
  } catch {
    // A frame of another site cannot see its own frame element.
  }
  return view !== view.top && (view.innerWidth < MIN_FRAME_WIDTH || view.innerHeight < MIN_FRAME_HEIGHT);
}

function planOf(doc: Document): { plan: Plan; active: Element | null } {
  const active = activeElement(doc);
  return { plan: analyze(readPage(doc), active), active };
}

/** The page shows an account, and it is not this login's. Compared only
 *  when both are an email or neither is: a site can show the email of an
 *  account whose login is saved under a short name. */
function otherAccount(identities: readonly string[], username: string): boolean {
  if (!username.trim()) return false;
  const kind = username.includes('@');
  const comparable = identities.filter((v) => v.includes('@') === kind);
  return comparable.length > 0 && !comparable.some((v) => same(v, username));
}

export function probe(doc: Document): FrameReport | null {
  const view = doc.defaultView;
  if (!view || refusedFrame(view)) return null;
  const { plan, active } = planOf(doc);
  const targets = [plan.username, plan.password, ...(plan.code ?? [])].filter((f) => !!f);
  const focused = !!active && targets.some((f) => f.el === active || f.group.fields.some((g) => g.el === active));
  return { step: plan.step, sure: plan.sure, focused, code: !!plan.code, reason: plan.reason };
}

let stopWatch: (() => void) | null = null;

/** Wait for the password step of the sign-in the username was written for. */
function watch(doc: Document, username: string, password: string): void {
  stopWatch?.();
  const view = doc.defaultView;
  if (!view) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  const stop = (): void => {
    observer.disconnect();
    clearInterval(poll);
    clearTimeout(limit);
    clearTimeout(timer);
    view.removeEventListener('pagehide', stop);
    stopWatch = null;
  };
  const look = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const { plan } = planOf(doc);
      if (plan.step !== 'login' || !plan.password) return;
      // The page moved to another account, or shows a fresh form: not ours to finish.
      if (otherAccount(plan.identities, username) || (plan.username && !same(plan.username.el.value, username))) return stop();
      stop();
      const result = await writeField(plan.password.el, password);
      if (result === 'written' || result === 'same') focusField(plan.password.el);
    } finally {
      busy = false;
    }
  };
  const schedule = (): void => {
    timer ??= setTimeout(() => {
      timer = undefined;
      void look();
    }, WATCH_EVERY_MS);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: WATCHED });
  // A field inside a shadow root changes without a word to the document.
  const poll = setInterval(schedule, WATCH_POLL_MS);
  const limit = setTimeout(stop, FILL_WAIT_MS);
  view.addEventListener('pagehide', stop);
  stopWatch = stop;
}

export async function fill(doc: Document, request: FillRequest): Promise<FrameResult> {
  const view = doc.defaultView;
  if (!view || refusedFrame(view)) return { filled: [], waiting: false };
  stopWatch?.();
  const { plan } = planOf(doc);
  if (plan.step === 'none') return { filled: [], waiting: false, reason: plan.reason };
  if (plan.step === 'login' && otherAccount(plan.identities, request.username)) return { filled: [], waiting: false, reason: 'otherAccount' };

  const filled: FillPart[] = [];
  const written: HTMLInputElement[] = [];
  let reason: FillReason | undefined;
  const note = (part: FillPart, result: WriteResult, els: readonly HTMLInputElement[]): void => {
    if (result === 'written' || result === 'same') {
      filled.push(part);
      written.push(...els);
    } else reason ??= result;
  };

  if (plan.username && request.username) {
    note('username', await writeField(plan.username.el, request.username), [plan.username.el]);
    await turn();
  }
  // A page can swap a field for a copy when the username lands: look again.
  const stale = (plan.password && !plan.password.el.isConnected) || plan.code?.some((f) => !f.el.isConnected);
  const next = stale ? planOf(doc).plan : plan;
  if (next.password && request.password) {
    note('password', await writeField(next.password.el, request.password), [next.password.el]);
    await turn();
  }
  if (next.code?.length && request.code) {
    const els = next.code.map((f) => f.el);
    const one = els[0];
    note('code', els.length === 1 && one ? await writeField(one, request.code, true) : await writeBoxes(els, request.code), els);
  }

  // The cursor ends where the person goes on: the password, so Enter signs in.
  const target = (filled.includes('password') ? next.password?.el : undefined) ?? written[written.length - 1];
  if (target) {
    for (const el of written) {
      if (el === target) continue;
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
      el.dispatchEvent(new FocusEvent('blur', { composed: true }));
    }
    focusField(target);
  }

  const waiting = request.wait && plan.step === 'username' && filled.includes('username') && !!request.password;
  if (waiting) watch(doc, request.username, request.password);
  return { filled, waiting, reason };
}
