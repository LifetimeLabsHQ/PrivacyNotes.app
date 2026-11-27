/**
 * The background's passkey door: the one entry for a passkey request from a
 * page. ("Door" is the extension's word for a page-facing entry, as the fill
 * probe's.) It checks the sender as the browser describes it, never as the
 * page does, and answers `fallback` at once, with no prompt, whenever the
 * extension cannot or should not offer a passkey. Otherwise it stores the
 * request in session storage and opens the popup on it; the popup signs and
 * answers the tab itself, so the worker's idle stop cannot lose the answer.
 * Spec: docs/contrib/passkeys.md (section 5.4, reviews 3, 7, 8 and 21)
 */
import { browser, type Browser } from 'wxt/browser';
import { getDomain, parse } from 'tldts';
import type { SitePasskey } from '@notes/shared/extension';
import {
  COOLDOWN_MS,
  ES256,
  fromB64url,
  isOurOrigin,
  REQUEST_MAX_CHARS,
  REQUEST_MAX_MS,
  type DoorReply,
  type PasskeyAnswerMessage,
  type PasskeyKind,
  type PasskeyRequestMessage,
  type PasskeyResult,
  type WireCreateOptions,
  type WireGetOptions,
} from './passkeyWire';

export const REQUESTS_KEY = 'passkeyRequests';
const COOLDOWN_KEY = 'passkeyCooldown';
/** The sites whose page ended a prompt itself, each until a time. */
const ABORTED_KEY = 'passkeyAborted';
/** The sites whose sign-in found no passkey of theirs, each until a time.
 *  It holds sign-ins only: a create there can still help. */
const NO_MATCH_KEY = 'passkeyNoMatch';
/** The sites a sign-in prompt opened for, each until a time: held when the
 *  prompt opens, not when it ends, so a page that loads again after each
 *  matched prompt (and so never dismisses or aborts it) still gets one
 *  answer a minute (beta #198 item 6). */
const SIGN_IN_KEY = 'passkeySignIn';
/** The number of site passkeys in the copy, written at each pull and when a passkey is saved, so a
 *  locked extension knows whether a sign-in prompt can help. Not a secret. */
export const PASSKEY_COUNT_KEY = 'passkeyCount';

export interface StoredRequest {
  id: string;
  tabId: number;
  /** Chrome's id of the asking document; the answer goes to it alone. */
  documentId?: string;
  origin: string;
  rpId: string;
  kind: PasskeyKind;
  options: WireCreateOptions | WireGetOptions;
  at: number;
  /** The background is saving its passkey and answers the tab itself. */
  saving?: boolean;
  /** The background fell back from the toolbar popup to a standalone window. */
  windowFallback?: boolean;
}

// ── The pure rules ───────────────────────────────────────────────────

export { isOurOrigin };

/**
 * The asking document's origin, as the browser reports it: it must exist,
 * not be opaque (a sandboxed document's URL still looks normal, review 3),
 * equal the origin of `sender.url`, and be https or http://localhost. Only
 * the top frame of a tab, of this extension, and on Chrome a document that
 * is active (not prerendered, not in the back/forward cache).
 */
export function senderOrigin(sender: Browser.runtime.MessageSender, chrome: boolean): string | null {
  const s = sender as Browser.runtime.MessageSender & { documentLifecycle?: string };
  if (!s.tab || s.tab.id == null || s.frameId !== 0 || s.id !== browser.runtime.id || !s.url) return null;
  if (chrome && s.documentLifecycle !== 'active') return null;
  const origin = s.origin;
  if (!origin || origin === 'null') return null;
  let u: URL;
  try {
    u = new URL(s.url);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) return null;
  return isOurOrigin(origin) ? null : origin;
}

/**
 * The RP ID rule (review 21): the RP ID is the page's host, or a parent of it
 * that is still at or below the registrable domain, with private suffixes on
 * as `match.ts` reads them, so `github.io` is never an RP ID for
 * `me.github.io`. An IP address is never one.
 */
export function rpIdAllowed(rpId: string, host: string): boolean {
  if (!rpId || rpId !== rpId.toLowerCase() || rpId.endsWith('.')) return false;
  if (parse(rpId).isIp || parse(host).isIp || /^\[.*\]$/.test(host)) return false;
  if (rpId === host) return true;
  if (!host.endsWith(`.${rpId}`)) return false;
  const domain = getDomain(rpId, { allowPrivateDomains: true });
  return domain !== null && domain === getDomain(host, { allowPrivateDomains: true }) && rpId.endsWith(domain);
}

/** The RP ID a request asks for: its own, or the page's host. An empty
 *  string stands for omitted; domain matching is case-insensitive. */
export function requestRpId(kind: PasskeyKind, options: WireCreateOptions | WireGetOptions, origin: string): string | null {
  const host = new URL(origin).hostname.toLowerCase();
  const asked = kind === 'create' ? (options as WireCreateOptions).rp?.id : (options as WireGetOptions).rpId;
  const rpId = typeof asked === 'string' && asked.length > 0 ? asked.toLowerCase() : asked === undefined || asked === '' ? host : null;
  return typeof rpId === 'string' && rpIdAllowed(rpId, host) ? rpId : null;
}

/** The stored passkeys a sign-in may use: the RP ID's, narrowed by
 *  `allowCredentials` when the site lists any. */
export function candidates<T extends Pick<SitePasskey, 'rpId' | 'credentialId'>>(stored: readonly T[], rpId: string, allow: readonly { id: string }[]): T[] {
  const ids = new Set(allow.map((a) => a.id));
  return stored.filter((p) => p.rpId === rpId && (ids.size === 0 || ids.has(p.credentialId)));
}

/** The stored passkey ids a create excludes: the site has one already. */
export function excluded(stored: readonly Pick<SitePasskey, 'rpId' | 'credentialId'>[], rpId: string, exclude: readonly { id: string }[]): boolean {
  const ids = new Set(exclude.map((e) => e.id));
  return stored.some((p) => p.rpId === rpId && ids.has(p.credentialId));
}

function wellFormed(msg: PasskeyRequestMessage): boolean {
  if (typeof msg.id !== 'string' || !/^[0-9a-f-]{36}$/.test(msg.id)) return false;
  const o = msg.options as Partial<WireCreateOptions & WireGetOptions> | null;
  if (!o || typeof o !== 'object' || typeof o.challenge !== 'string' || o.challenge.length > 2048) return false;
  // The options go into session storage as they came: a page cannot fill it.
  if (JSON.stringify(o).length > REQUEST_MAX_CHARS) return false;
  if (msg.kind === 'get') return Array.isArray(o.allowCredentials);
  // A user id the authenticator cannot hold (WebAuthn: 1 to 64 bytes) goes to the browser before any prompt.
  const userId = fromB64url(o.user?.id);
  return msg.kind === 'create' && !!o.rp && !!userId && userId.length >= 1 && userId.length <= 64 && Array.isArray(o.pubKeyCredParams) && Array.isArray(o.excludeCredentials);
}

// ── Session storage ──────────────────────────────────────────────────

async function readRequests(now: number): Promise<Record<string, StoredRequest>> {
  const all = ((await browser.storage.session.get(REQUESTS_KEY))[REQUESTS_KEY] as Record<string, StoredRequest> | undefined) ?? {};
  // A request lives 3 minutes at most.
  return Object.fromEntries(Object.entries(all).filter(([, r]) => now - r.at < REQUEST_MAX_MS));
}

async function writeRequests(all: Record<string, StoredRequest>): Promise<void> {
  await browser.storage.session.set({ [REQUESTS_KEY]: all });
}

/** The names a hold is kept under: the origin, and the RP ID it asked for
 *  (an origin always has a scheme, an RP ID never), so another host or port
 *  of the same site shares one budget (beta #123). */
function siteNames(req: Pick<StoredRequest, 'origin' | 'rpId'>): string[] {
  return [req.origin, req.rpId];
}

/** The names under `key` whose time has not passed. */
async function readHeld(key: string, now: number): Promise<Record<string, number>> {
  const all = ((await browser.storage.session.get(key))[key] as Record<string, number> | undefined) ?? {};
  return Object.fromEntries(Object.entries(all).filter(([, until]) => until > now));
}

async function isHeld(key: string, names: readonly string[], now: number): Promise<boolean> {
  const held = await readHeld(key, now);
  return names.some((n) => held[n] !== undefined);
}

async function hold(key: string, names: readonly string[], now: number): Promise<void> {
  const held = await readHeld(key, now);
  for (const n of names) held[n] = now + COOLDOWN_MS;
  await browser.storage.session.set({ [key]: held });
}

/** One abort is free; a second within the cooldown time holds the site as a
 *  dismissal does. Spec: docs/contrib/passkeys.md (section 16, findings 3 and 4) */
async function strike(key: string, names: readonly string[], now: number): Promise<void> {
  await hold((await isHeld(key, names, now)) ? COOLDOWN_KEY : key, names, now);
}

/** Remove `names` from each hold map: after the person approves a save or
 *  sign-in in our own popup, they are never locked out of that site on their
 *  next try. */
async function clearHolds(keys: readonly string[], names: readonly string[], now: number): Promise<void> {
  const patch: Record<string, Record<string, number>> = {};
  for (const key of keys) {
    const held = await readHeld(key, now);
    let changed = false;
    for (const n of names) {
      if (n in held) {
        delete held[n];
        changed = true;
      }
    }
    if (changed) patch[key] = held;
  }
  if (Object.keys(patch).length) await browser.storage.session.set(patch);
}

/** Drop every no-match hold after a fresh unlock so newly pulled passkeys
 *  are offered at once. */
export function clearNoMatchHolds(): Promise<void> {
  return serial(async () => {
    await browser.storage.session.set({ [NO_MATCH_KEY]: {} });
  });
}

/** One change to the stored requests at a time, in this context. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task);
  chain = next.catch(() => undefined);
  return next;
}

/** The request the popup was opened for, or null when it is gone or old. */
export async function readRequest(id: string, now = Date.now()): Promise<StoredRequest | null> {
  return (await readRequests(now))[id] ?? null;
}

/** Mark a request as having fallen back to a standalone popup window so any
 *  late-mounting toolbar popup closes silently instead of cancelling it. */
export function markWindowFallback(id: string, now = Date.now()): Promise<boolean> {
  return serial(async () => {
    const all = await readRequests(now);
    const req = all[id];
    if (!req) return false;
    all[id] = { ...req, windowFallback: true };
    await writeRequests(all);
    return true;
  });
}

async function finishRequestInner(id: string, dismissed: boolean, now: number, approved: boolean): Promise<StoredRequest | null> {
  const all = await readRequests(now);
  const req = all[id] ?? null;
  if (!req || (dismissed && req.saving)) return null;
  delete all[id];
  await restorePopup(req.tabId);
  await writeRequests(all);
  if (dismissed) await hold(COOLDOWN_KEY, siteNames(req), now);
  else if (approved) await clearHolds([COOLDOWN_KEY, ABORTED_KEY, NO_MATCH_KEY, SIGN_IN_KEY], siteNames(req), now);
  return req;
}

/** Forget a request; a dismissal also starts the origin's cooldown. A
 *  dismissal leaves a request alone while its passkey is being saved: the
 *  save answers it. An approved save or sign-in clears that site's holds, so
 *  the person can immediately sign in after registering or sign in again. The
 *  tab's toolbar popup goes back to the plain one. */
export function finishRequest(id: string, dismissed: boolean, now = Date.now(), approved = false): Promise<StoredRequest | null> {
  return serial(() => finishRequestInner(id, dismissed, now, approved));
}

/** Forget every request of a tab: its page went away. */
export function dropTabRequests(tabId: number): Promise<void> {
  return serial(async () => {
    const all = await readRequests(Date.now());
    const kept = Object.fromEntries(Object.entries(all).filter(([, r]) => r.tabId !== tabId));
    if (Object.keys(kept).length === Object.keys(all).length) return;
    await writeRequests(kept);
    await restorePopup(tabId);
  });
}

/** The answer to the asking document, sent by whoever holds it (the popup,
 *  or the background when the popup went away without one). */
export async function answerTab(req: StoredRequest, result: PasskeyResult): Promise<void> {
  const msg: PasskeyAnswerMessage = { type: 'passkey-answer', id: req.id, result };
  const target = req.documentId ? { documentId: req.documentId } : { frameId: 0 };
  await browser.tabs.sendMessage(req.tabId, msg, target as never).catch(() => undefined);
}

// ── The door ─────────────────────────────────────────────────────────

export interface DoorDeps {
  /** Chrome or Edge: the sender carries `documentLifecycle` and `documentId`. */
  chrome: boolean;
  /** The connection's logins scope; false when not connected. */
  logins: () => Promise<boolean>;
  /** The "Offer passkeys" setting (P29). */
  offer: () => Promise<boolean>;
  /** The tab is the active one of a focused window. */
  inFront: (tab: Browser.tabs.Tab) => Promise<boolean>;
  /** Every site passkey the extension holds (copy and pending store), or
   *  null while locked. */
  passkeys: () => Promise<Pick<SitePasskey, 'rpId' | 'credentialId'>[] | null>;
  /** Optional bounded refresh when an unlocked sign-in finds no cached match
   *  yet (a passkey saved in another browser or device). */
  refresh?: () => Promise<void>;
  /** The count written at the last pull, for a locked extension. */
  count: () => Promise<number>;
  openPrompt: (req: StoredRequest, tab: Browser.tabs.Tab) => void;
  now: () => number;
}

/** Aborts that arrived while `onPasskeyRequest` was still awaiting (for
 *  example during an unlocked miss refresh), so the request never opens a
 *  prompt after the page already ended its call. */
const abortedInFlight = new Map<string, { tabId: number; at: number }>();

function pruneAbortedInFlight(now: number): void {
  for (const [key, entry] of abortedInFlight) {
    if (now - entry.at >= REQUEST_MAX_MS) abortedInFlight.delete(key);
  }
}

function consumeAbortedInFlight(id: string, tabId: number, now: number): boolean {
  pruneAbortedInFlight(now);
  const entry = abortedInFlight.get(id);
  if (!entry || entry.tabId !== tabId) return false;
  abortedInFlight.delete(id);
  return true;
}

/**
 * A request from the relay. `fallback` sends the page to the browser's own
 * prompt at once; `prompt` means the popup will answer.
 */
export function onPasskeyRequest(msg: PasskeyRequestMessage, sender: Browser.runtime.MessageSender, deps: DoorDeps): Promise<DoorReply> {
  const fallback: DoorReply = { kind: 'fallback' };
  const origin = senderOrigin(sender, deps.chrome);
  const tab = sender.tab;
  if (!origin || !tab || tab.id == null || !wellFormed(msg)) return Promise.resolve(fallback);
  // Before the queue: a sign-in no click started never waits behind others,
  // so a background tab cannot fill the one queue (beta #126).
  if (msg.kind === 'get' && msg.active !== true) return Promise.resolve(fallback);
  const tabId = tab.id;
  return serial(async () => {
    const now = deps.now();
    if (consumeAbortedInFlight(msg.id, tabId, now)) return fallback;
    if (!(await deps.logins()) || !(await deps.offer())) return fallback;
    if (!(await deps.inFront(tab))) return fallback;
    const documentId = deps.chrome ? (sender as { documentId?: string }).documentId : undefined;
    const requests = await readRequests(now);
    // One request per tab. One of another document of the tab is stale:
    // that page went away (Chrome names each document).
    for (const [key, r] of Object.entries(requests)) if (r.tabId === tabId && documentId && r.documentId && r.documentId !== documentId) delete requests[key];
    if (Object.values(requests).some((r) => r.tabId === tabId)) return fallback;
    const rpId = requestRpId(msg.kind, msg.options, origin);
    if (!rpId) return fallback;
    const names = siteNames({ origin, rpId });
    if (await isHeld(COOLDOWN_KEY, names, now)) return fallback;
    if (msg.kind === 'create') {
      // WebAuthn Level 3: an empty pubKeyCredParams defaults to ES256 and RS256.
      const params = (msg.options as WireCreateOptions).pubKeyCredParams;
      if (params.length > 0 && !params.some((p) => p?.type === 'public-key' && p.alg === ES256)) return fallback;
    }
    if (msg.kind === 'get') {
      // Only a sign-in the person started reaches the Vault: without user
      // activation, the answer would tell the page in silence whether the
      // Vault holds one of its credentials (finding 4). Locked, the unlock
      // prompt also opens only then.
      if (msg.active !== true) return fallback;
      // A page can post to the relay without calling the browser, and reads
      // a prompt it then aborts as a match. So a site gets one answer a
      // minute of either kind: after a "none of these" or an abort, a
      // sign-in there answers the same for a match, before the Vault is read
      // (finding 4, beta #123).
      if ((await isHeld(NO_MATCH_KEY, names, now)) || (await isHeld(ABORTED_KEY, names, now)) || (await isHeld(SIGN_IN_KEY, names, now))) return fallback;
      const allow = (msg.options as WireGetOptions).allowCredentials;
      let stored = await deps.passkeys();
      if (stored === null) {
        if ((await deps.count()) === 0) return fallback;
      } else if (candidates(stored, rpId, allow).length === 0) {
        if (deps.refresh) {
          await deps.refresh().catch(() => undefined);
          if (consumeAbortedInFlight(msg.id, tabId, deps.now())) {
            await strike(ABORTED_KEY, names, deps.now());
            return fallback;
          }
          stored = await deps.passkeys();
        }
        if (stored === null || candidates(stored, rpId, allow).length === 0) {
          await hold(NO_MATCH_KEY, names, now);
          return fallback;
        }
      }
    }
    if (consumeAbortedInFlight(msg.id, tabId, deps.now())) {
      await strike(ABORTED_KEY, names, deps.now());
      return fallback;
    }
    // Re-read requests after any async refresh so we never overwrite a
    // concurrent finishRequest from another popup.
    const latest = await readRequests(deps.now());
    for (const [key, r] of Object.entries(latest)) if (r.tabId === tabId && documentId && r.documentId && r.documentId !== documentId) delete latest[key];
    if (Object.values(latest).some((r) => r.tabId === tabId)) return fallback;
    const req: StoredRequest = { id: msg.id, tabId, ...(documentId ? { documentId } : {}), origin, rpId, kind: msg.kind, options: msg.options, at: now };
    await writeRequests({ ...latest, [req.id]: req });
    // The answer of a sign-in is given here, however the prompt ends: the
    // site's next sign-in within the minute goes to the browser's prompt.
    if (msg.kind === 'get') await hold(SIGN_IN_KEY, names, now);
    deps.openPrompt(req, tab);
    return { kind: 'prompt' } satisfies DoorReply;
  });
}

/**
 * The page aborted its call: the request goes, and the popup on it closes.
 * The site's sign-ins are held for the cooldown time (one answer a minute).
 * A create stays free after one abort, since a page ends a call for its own
 * good reasons; a second abort from the same site within the cooldown time
 * holds it as a dismissal does, so a page cannot open the prompt again and
 * again.
 */
const ABORT_ID_RE = /^[0-9a-f-]{36}$/i;

export async function onPasskeyAbort(id: unknown, sender: Browser.runtime.MessageSender, now = Date.now()): Promise<void> {
  if (typeof id !== 'string' || !ABORT_ID_RE.test(id) || sender.id !== browser.runtime.id || sender.tab?.id == null) return;
  const tabId = sender.tab.id;
  pruneAbortedInFlight(now);
  abortedInFlight.set(id, { tabId, at: now });
  await serial(async () => {
    // Runs strictly after any in-flight onPasskeyRequest (including writeRequests):
    // either onPasskeyRequest already consumed the abort and returned fallback,
    // or the request was stored and we remove it and record the strike here.
    abortedInFlight.delete(id);
    const all = await readRequests(now);
    const req = all[id] ?? null;
    if (!req || req.tabId !== tabId) return;
    if (!(await finishRequestInner(id, false, now, false))) return;
    await strike(ABORTED_KEY, siteNames(req), now);
  });
}

/** The page asks whether a platform passkey can be made: yes while this
 *  extension would offer one there (review 18). */
export async function onUvpaQuery(sender: Browser.runtime.MessageSender, deps: Pick<DoorDeps, 'chrome' | 'logins' | 'offer'>): Promise<{ available: boolean }> {
  if (!senderOrigin(sender, deps.chrome)) return { available: false };
  return { available: (await deps.logins()) && (await deps.offer()) };
}

/** The popup's port for one request closed: a window closed with no answer
 *  is a dismissal, so the page gets the browser's prompt and the origin its
 *  cooldown. When the popup never mounted (`dismissed = false`), no cooldown
 *  is started so the user can try again once the browser recovers. */
export async function onPromptGone(id: string, dismissed = true, now = Date.now()): Promise<void> {
  const req = await finishRequest(id, dismissed, now);
  if (req) await answerTab(req, { kind: 'fallback' });
}

/** The toolbar popup opens on a request through a per-tab popup page; it
 *  goes back to the plain popup as soon as that page has read it, and when
 *  the request ends any other way. */
export async function restorePopup(tabId: number): Promise<void> {
  try {
    const popup = browser.runtime.getManifest().action?.default_popup ?? 'popup.html';
    await browser.action.setPopup({ tabId, popup });
  } catch {
    // A tab that is gone, or no action API: nothing to restore.
  }
}

// ── Saving a passkey (P24, review finding 5) ─────────────────────────

/** Take a request for its save: from now on a closed popup is no
 *  dismissal. Null when it is gone (answered, aborted, or dismissed first). */
function claimForSave(id: string, now = Date.now()): Promise<StoredRequest | null> {
  return serial(async () => {
    const all = await readRequests(now);
    const req = all[id];
    if (!req || req.saving || req.kind !== 'create') return null;
    all[id] = { ...req, saving: true };
    await writeRequests(all);
    return all[id]!;
  });
}

/**
 * The popup's Save, run in the background so a popup that closes (a toolbar
 * popup closes when it loses focus) changes nothing: the row is posted, and
 * the tab gets the credential only once the row is on the server, else the
 * browser's own prompt. A request that is gone is not saved at all.
 */
export async function savePasskeyFor<R extends { state: string }>(id: string, credential: PasskeyResult, save: () => Promise<R>, failed: R): Promise<R> {
  const req = await claimForSave(id);
  if (!req) return failed;
  let result = failed;
  try {
    result = await save();
  } finally {
    const sent = result.state === 'sent';
    // Clear the request and site holds before answering the page so a site
    // that immediately authenticates or navigates never races with cleanup.
    await finishRequest(id, false, Date.now(), sent).catch(() => undefined);
    await answerTab(req, sent ? credential : { kind: 'fallback' });
  }
  return result;
}

/** The port name the popup opens for a request. */
export const PROMPT_PORT = 'passkey-prompt:';

// ── The two content scripts (review finding 9) ───────────────────────

const SCRIPT_IDS = ['pn-passkey-page', 'pn-passkey-relay'];

/**
 * Whether the two scripts belong on pages: the release switch is on, this
 * browser is connected with logins, and "Offer passkeys" is on. They are the
 * three things the door asks before it offers a passkey, so a browser where
 * it would never offer one has no script on any page.
 */
export function passkeyScriptsWanted(released: boolean, connection: { logins?: boolean } | null, prefs: { offerPasskeys: boolean }): boolean {
  return released && connection?.logins === true && prefs.offerPasskeys;
}

/** One change to the registration at a time: the setting can change twice
 *  before the browser has answered the first. */
let scriptsChain: Promise<unknown> = Promise.resolve();

/**
 * The page script and the relay are registered at run time, and only while
 * they are wanted (`passkeyScriptsWanted`), so a build with the switch off
 * declares no script on any page. Not wanted, any earlier registration is
 * removed. A browser that refuses the main world for a registered script
 * gets neither.
 */
export function syncPasskeyScripts(wanted: boolean, matches: string[], excludeMatches: string[]): Promise<void> {
  const next = scriptsChain.then(async () => {
    const scripting = browser.scripting;
    if (!scripting?.getRegisteredContentScripts) return;
    const have = (await scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS }).catch(() => [])).map((s) => s.id);
    if (!wanted) {
      if (have.length) await scripting.unregisterContentScripts({ ids: have }).catch(() => undefined);
      return;
    }
    if (have.length === SCRIPT_IDS.length) return;
    if (have.length) await scripting.unregisterContentScripts({ ids: have }).catch(() => undefined);
    const common = { matches, excludeMatches, runAt: 'document_start' as const, allFrames: false, persistAcrossSessions: true };
    try {
      await scripting.registerContentScripts([
        { ...common, id: SCRIPT_IDS[0]!, js: ['content-scripts/passkey-page.js'], world: 'MAIN' },
        { ...common, id: SCRIPT_IDS[1]!, js: ['content-scripts/passkey-relay.js'] },
      ] as never);
    } catch (err) {
      console.warn('[privacynotes] passkey scripts not registered:', err instanceof Error ? err.message : 'unknown');
    }
  });
  scriptsChain = next.catch(() => undefined);
  return next;
}
