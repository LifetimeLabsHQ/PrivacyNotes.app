/**
 * One fill, from the background: check the login against the tab, put the
 * fill script into the tab's frames, hear what each could fill, and send the
 * login to one frame. The secret stays here until that last step.
 *
 * The frames answer the probe with a message, not a return value, because a
 * message carries the frame's address from the browser. That message is the
 * only one the background takes from a script inside a site, and it can do
 * one thing: help choose a frame of a run that is open for its own tab.
 * Spec: docs/internal/plans/click-to-fill.md (sections 3.2, 3.8 and 8)
 */
import { browser, type Browser } from 'wxt/browser';
import { generateTotpCode, parseTotpInput, totpSecondsRemaining } from '@notes/shared';
import { clippable } from './clipping';
import { chooseFrame, type ProbedFrame } from './fill/choose';
import type { FillApi, FillOutcome, FillPart, FillReason, FillRequest, FrameReport, FrameResult } from './fill/types';
import { allEntries, copyLoginShortcut, isUnlocked } from './logins';
import { byLastFill, markFilled, nextFill, readLastFill, type Cycle } from './lastFill';
import { loginsOf, matchLogins } from './match';
import { flashBadge } from './queue';

// Spec: docs/internal/plans/click-to-fill.md (section 3.2, steps 4 and 8)
const COLLECT_MS = 400;
const RUN_LIMIT_MS = 4000;
// Spec: docs/internal/plans/click-to-fill.md (section 4.4)
const CODE_MIN_LEFT_S = 3;
// Spec: docs/internal/plans/click-to-fill.md (section 3.8)
const CYCLE_MS = 3000;
const CYCLE_KEY = 'fillCycle';

const STEPS = ['login', 'code', 'username', 'none'];
const PARTS = ['username', 'password', 'code'];
const REASONS = ['signup', 'otherAccount', 'readonly', 'tooLong', 'refused'];

interface Run {
  tabId: number;
  frames: ProbedFrame[];
  /** The frames that answered, with or without something to fill. */
  answered: Set<number>;
  onAnswer?: () => void;
}

const runs = new Map<string, Run>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const within = <T>(work: Promise<T>, ms: number, late: T): Promise<T> => Promise.race([work, sleep(ms).then(() => late)]);

/** A report is hostile until it has exactly the known shape. */
function parseReport(value: unknown): FrameReport | null {
  const r = value as Partial<Record<keyof FrameReport, unknown>> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.step !== 'string' || !STEPS.includes(r.step)) return null;
  if (typeof r.sure !== 'boolean' || typeof r.focused !== 'boolean' || typeof r.code !== 'boolean') return null;
  if (r.reason !== undefined && r.reason !== 'signup' && r.reason !== 'readonly') return null;
  return { step: r.step as FrameReport['step'], sure: r.sure, focused: r.focused, code: r.code, reason: r.reason };
}

function parseResult(value: unknown): FrameResult {
  const r = value as { filled?: unknown; waiting?: unknown; reason?: unknown } | null;
  const filled = Array.isArray(r?.filled) ? r.filled.filter((p): p is FillPart => typeof p === 'string' && PARTS.includes(p)) : [];
  const reason = typeof r?.reason === 'string' && REASONS.includes(r.reason) ? (r.reason as FillReason) : undefined;
  return { filled, waiting: r?.waiting === true, reason };
}

/**
 * A frame's answer to the probe. Taken only from this extension's own script,
 * in the tab of a run that is open, once for each frame. The frame's address
 * is the sender's, which the browser sets.
 */
export function onFillProbe(msg: unknown, sender: Browser.runtime.MessageSender): void {
  const m = msg as { runId?: unknown; report?: unknown } | null;
  const run = typeof m?.runId === 'string' ? runs.get(m.runId) : undefined;
  const frameId = sender.frameId;
  if (!run || sender.id !== browser.runtime.id || sender.tab?.id !== run.tabId || typeof frameId !== 'number' || !sender.url) return;
  if (run.answered.has(frameId)) return;
  run.answered.add(frameId);
  const report = parseReport(m?.report);
  if (report) run.frames.push({ frameId, documentId: (sender as { documentId?: string }).documentId, url: sender.url, report });
  run.onAnswer?.();
}

type Target = Parameters<typeof browser.scripting.executeScript>[0]['target'];

/** Put the script into the tab and ask every frame. Returns how many frames
 *  were asked. Some browsers refuse the whole call when one frame cannot be
 *  entered: then the top frame alone is asked. */
async function ask(tabId: number, runId: string): Promise<number> {
  const call = async (target: Target): Promise<number> => {
    await browser.scripting.executeScript({ target, files: ['/fill.js' as never] });
    const asked = await browser.scripting.executeScript({
      target,
      func: (id: string) => {
        (globalThis as { __pnFill?: FillApi }).__pnFill?.probe(id);
        return true;
      },
      args: [runId],
    });
    return asked.length;
  };
  try {
    return await call({ tabId, allFrames: true });
  } catch {
    try {
      return await call({ tabId, frameIds: [0] });
    } catch {
      return 0;
    }
  }
}

/** Wait until every asked frame answered, at most a moment. */
function collected(run: Run, asked: number): Promise<void> {
  if (run.answered.size >= asked) return Promise.resolve();
  const all = new Promise<void>((resolve) => {
    run.onAnswer = () => {
      if (run.answered.size >= asked) resolve();
    };
  });
  return within(all, COLLECT_MS, undefined);
}

/** The digits, made now. A code about to run out would be old by the time
 *  the person presses Enter, so the next one is waited for. */
async function freshCode(totp: NonNullable<ReturnType<typeof parseTotpInput>>): Promise<string> {
  const left = totpSecondsRemaining(totp.period, Date.now());
  if (left < CODE_MIN_LEFT_S) await sleep(left * 1000 + 200);
  return generateTotpCode(totp, Date.now());
}

function outcomeOf(result: FrameResult): FillOutcome {
  if (result.filled.includes('password') || result.filled.includes('code')) return 'filled';
  if (result.waiting) return 'waiting';
  if (result.reason) return result.reason;
  return result.filled.includes('username') ? 'usernameOnly' : 'nothing';
}

/** Fill the login `item` into the tab `tabId`. */
export async function runFill(item: string, tabId: number): Promise<FillOutcome> {
  if (!(await isUnlocked())) return 'locked';
  const found = await allEntries();
  const login = found ? loginsOf(found.entries).find((e) => e.item === item) : undefined;
  if (!found || !login) return 'nothing';
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !clippable(tab.url)) return 'blockedPage';
  if (!matchLogins([login], tab.url).length) return 'noMatch';

  const runId = crypto.randomUUID();
  const run: Run = { tabId, frames: [], answered: new Set() };
  runs.set(runId, run);
  try {
    const asked = await within(ask(tabId, runId), RUN_LIMIT_MS, 0);
    if (!asked) return 'nothing';
    await collected(run, asked);

    // The top frame's address is the tab's, as the browser has it.
    const frames = run.frames.filter((f) => f.frameId !== 0 || f.url === tab.url);
    const totp = found.pro && login.totp ? parseTotpInput(login.totp) : null;
    const { frame, insecure } = chooseFrame(frames, login, !!totp);
    if (!frame) return insecure ? 'insecure' : (frames.find((f) => f.frameId === 0)?.report.reason ?? 'nothing');

    const code = totp && frame.report.code ? await freshCode(totp) : '';
    const now = await browser.tabs.get(tabId).catch(() => null);
    if (now?.url !== tab.url) return 'nothing';

    const request: FillRequest = { runId, username: login.username, password: login.password, code, wait: true };
    const target: Target = frame.documentId ? { tabId, documentIds: [frame.documentId] } : { tabId, frameIds: [frame.frameId] };
    const fillCall = browser.scripting
      .executeScript({
        target,
        func: (r: FillRequest) => (globalThis as { __pnFill?: FillApi }).__pnFill?.fill(r),
        args: [request],
      })
      .then((res) => res[0]?.result)
      .catch(() => null);
    const outcome = outcomeOf(parseResult(await within(fillCall, RUN_LIMIT_MS, null)));
    if (outcome === 'filled' || outcome === 'waiting' || outcome === 'usernameOnly') {
      void flashBadge('saved');
      await markFilled(login.item);
    }
    return outcome;
  } finally {
    runs.delete(runId);
  }
}

/**
 * The login key: fill a login of this page. The first press fills the login
 * filled last here (else the first match); a press within `CYCLE_MS` of a
 * fill fills the next one, and the list wraps. Where the page has no field
 * for it, copy as the key always did (the username, then the password); with
 * no match, or several and nothing to fill, the window opens.
 */
export async function fillLoginShortcut(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  const found = tab?.url && (await isUnlocked()) ? await allEntries() : null;
  const matches = found && tab?.url ? matchLogins(loginsOf(found.entries), tab.url) : [];
  if (matches.length && tab?.url && tab.id != null) {
    const order = matches.sort(byLastFill(await readLastFill())).map((e) => e.item);
    const prev = (await browser.storage.session.get(CYCLE_KEY))[CYCLE_KEY] as Cycle | undefined;
    const press = nextFill(order, tab.url, prev, Date.now(), CYCLE_MS);
    const outcome = await runFill(press.order[press.index]!, tab.id);
    if (outcome === 'filled' || outcome === 'waiting') {
      await browser.storage.session.set({ [CYCLE_KEY]: { ...press, at: Date.now() } satisfies Cycle });
      return;
    }
  }
  await copyLoginShortcut();
}
