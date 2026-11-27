/**
 * The background: the PrivacyNotes right-click submenu (with the logins of
 * the page under Copy login), the address-bar keyword, the queue's retry
 * alarm, the clipboard clear, the keyboard commands (fill, save as note,
 * bookmark, new note, lock, generate), the idle lock, and the saves the popup
 * hands over. It reads a page when the person clips it from the menu or the
 * keyboard, by injecting the capture script into that one tab (the popup
 * reads the page in front when it opens on the Clip tab, `ClipView.tsx`), and
 * writes into a page only when the person fills a login (`src/fillRun.ts`).
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.3, 3.4 and 5)
 */
import { browser, type Browser } from 'wxt/browser';
import { clipNoteBody } from '@notes/clipper';
import { BIP39_WORDS, generateTotpCode, parseTotpInput } from '@notes/shared';
import { generateFrom } from '@web/passwordGen';
import type { CopyEntry, LoginCopyEntry } from '@notes/shared/extension';
import { capturePage, type CapturedPage } from '../src/capture';
import { buildClip, clippable, escapeMarkup, type Built, type ClipMode } from '../src/clipping';
import { CLEAR_ALARM, clearIfStill, clearLater, copySecret, offscreen, writeClipboard } from '../src/clipboard';
import { PENDING_KEY } from '../src/pending';
import { FLUSH_ALARM, flashBadge, flush } from '../src/queue';
import { saveClip, saveLogin, saveLoginEdit, saveNote, type SaveResult } from '../src/save';
import { fetchLinkedPage } from '../src/publicFetch';
import { readPrefs } from '../src/prefs';
import { startI18n, t } from '../src/i18n';
import { readConnection } from '../src/connection';
import { allEntries, applyLockTime, copyLoginShortcut, isUnlocked, proHint, KEEP_ALARM, lastPullAt, lockLogins, locksOn, pull, ROWS_KEY, SESSION_KEY, shortcutUrl } from '../src/logins';
import { byLastFill, readLastFill } from '../src/lastFill';
import { loginsOf, matchLogins, searchEntries } from '../src/match';
import { fillLoginShortcut, onFillProbe, runFill } from '../src/fillRun';
import type { BackgroundMessage } from '../src/messages';
import { ROUTE_KEY, type PopupRoute } from '../src/route';
import { readShortcuts, withKeys } from '../src/shortcuts';
import { clearSiteCounts, onMarkEnd, showLocked, showSiteCount } from '../src/badge';
import { activeTab } from '../src/tabs';
import { passkeysReleased } from '../src/passkeyRelease';
import { closeStorageToPageScripts } from '../src/storageAccess';
import { dropTabRequests, markWindowFallback, onPasskeyAbort, onPasskeyRequest, onPromptGone, onUvpaQuery, passkeyScriptsWanted, PASSKEY_COUNT_KEY, PROMPT_PORT, readRequest, restorePopup, savePasskeyFor, syncPasskeyScripts, type DoorDeps, type StoredRequest } from '../src/passkeyDoor';
import { fromOwnPage, PASSKEY_EXCLUDES, PASSKEY_MATCHES, REQUEST_MAX_MS, type PasskeyAbortMessage, type PasskeyRequestMessage } from '../src/passkeyWire';

const MENU_ROOT = 'pn';
const COPY_MENU = 'login-copy';
const FILL_MENU = 'login-fill';
/** At most this many logins get a submenu of their own under Copy login. */
const COPY_MENU_MAX = 6;

type Context = 'page' | 'selection' | 'link' | 'editable';
const ALL_CONTEXTS: Context[] = ['page', 'selection', 'link', 'editable'];

/** The logins the Copy login submenu was built from, by their menu id. */
let copyMenuLogins = new Map<string, LoginCopyEntry>();
/** The logins the Fill login rows were built from, by their menu id. */
let fillMenuLogins = new Map<string, LoginCopyEntry>();
/** The vault was locked when the menu was built: a click on Fill opens the window. */
let fillMenuLocked = false;

function menuItem(id: string, title: string, contexts: Context[], parentId: string = MENU_ROOT): void {
  browser.contextMenus.create({ id, parentId, title, contexts: contexts as never }, readMenuError);
}

/** A create that finds its id taken leaves the item as it is. That happens
 *  when two builds overlap, which the queue below cannot stop: an update or
 *  a reload starts a new background while the old one may still build. Read
 *  the error so Chrome does not list it as unchecked. */
function readMenuError(): void {
  void browser.runtime.lastError;
}

/**
 * The whole submenu, built again for the page in front: the static rows,
 * then under Copy login the logins of that page (one match: its values; two
 * to six: a row per login). Locked, one row says so and opens the popup.
 * The copy is local, so this costs no request.
 */
async function buildMenus(): Promise<void> {
  await startI18n();
  await browser.contextMenus.removeAll();
  // A row that has a shortcut names it, so the menu teaches the key. Read
  // on every build: the person may have changed it since (section 3.5).
  const keys = await readShortcuts();
  void browser.action.setTitle({ title: withKeys(t('notes:settings.groupBrand'), keys._execute_action) });
  browser.contextMenus.create({ id: MENU_ROOT, title: t('notes:settings.groupBrand'), contexts: ALL_CONTEXTS as never }, readMenuError);
  menuItem('page-note', withKeys(t('menu.savePageNote'), keys['save-note']), ['page']);
  menuItem('page-bookmark', withKeys(t('menu.savePageBookmark'), keys['save-bookmark']), ['page']);
  menuItem('page-markdown', t('menu.copyPageMarkdown'), ['page']);
  // With text selected the page comes first, then the selection.
  menuItem('selection-page-note', t('menu.savePageNote'), ['selection']);
  menuItem('selection-note', t('menu.saveSelection'), ['selection']);
  menuItem('selection-new-note', withKeys(t('menu.newNoteFromSelection'), keys['new-note']), ['selection']);
  menuItem('link-bookmark', t('menu.saveLinkBookmark'), ['link']);
  menuItem('link-note', t('menu.saveLinkedPage'), ['link']);
  // The vault half: each opens the popup on its view, or copies at once.
  browser.contextMenus.create({ id: 'logins-sep', parentId: MENU_ROOT, type: 'separator', contexts: ALL_CONTEXTS as never }, readMenuError);
  // The login key fills, so the Fill row carries it.
  menuItem(FILL_MENU, withKeys(t('menu.fillLogin'), keys['copy-login']), ALL_CONTEXTS);
  menuItem(COPY_MENU, t('menu.copyLogin'), ALL_CONTEXTS);
  menuItem('login-add', t('menu.addLogin'), ALL_CONTEXTS);
  menuItem('login-generate', t('menu.generatePassword'), ALL_CONTEXTS);

  copyMenuLogins = new Map();
  fillMenuLogins = new Map();
  fillMenuLocked = false;
  // The Fill row shows only where it can do something: locked (it opens the
  // window), or a login for this site.
  const hideFill = () => void browser.contextMenus.update(FILL_MENU, { visible: false }).catch(() => undefined);
  const connection = await readConnection();
  if (!connection?.logins) {
    hideFill();
    void showLocked(false);
    return void clearSiteCounts();
  }
  if (!(await isUnlocked())) {
    void showLocked(true);
    void clearSiteCounts();
    fillMenuLocked = true;
    return menuItem(`${COPY_MENU}:unlock`, t('vault.unlockToCopy'), ALL_CONTEXTS, COPY_MENU);
  }
  void showLocked(false);
  const tab = await activeTab();
  const found = tab?.url ? await allEntries() : null;
  // The login filled last here comes first, as in the window and for the key.
  const all = found && tab?.url ? matchLogins(loginsOf(found.entries), tab.url).sort(byLastFill(await readLastFill())) : [];
  // The badge: how many logins this site has, like Bitwarden. The tab's
  // own text, so each tab keeps its number when the person switches.
  if (tab?.id != null) void showSiteCount(tab.id, all.length);
  const matches = all.slice(0, COPY_MENU_MAX);
  // Fill: one match is the row itself; two to six get a row each.
  const [only] = matches;
  if (!only) hideFill();
  else if (matches.length === 1) fillMenuLogins.set(FILL_MENU, only);
  else {
    for (const login of matches) {
      const id = `${FILL_MENU}:${login.item}`;
      fillMenuLogins.set(id, login);
      menuItem(id, login.username ? `${login.name} · ${login.username}` : login.name, ALL_CONTEXTS, FILL_MENU);
    }
  }
  const valueRows = (parent: string, login: LoginCopyEntry) => {
    copyMenuLogins.set(parent, login);
    if (login.username) menuItem(`${parent}:username`, t('auth:loginForm.copyUsername'), ALL_CONTEXTS, parent);
    if (login.password) menuItem(`${parent}:password`, t('auth:loginForm.copyPassword'), ALL_CONTEXTS, parent);
    if (login.totp && found?.pro && parseTotpInput(login.totp)) menuItem(`${parent}:code`, t('logins.copyCode'), ALL_CONTEXTS, parent);
  };
  if (matches.length === 1) return valueRows(COPY_MENU, matches[0]!);
  for (const login of matches) {
    const id = `${COPY_MENU}:${login.item}`;
    menuItem(id, login.username ? `${login.name} · ${login.username}` : login.name, ALL_CONTEXTS, COPY_MENU);
    valueRows(id, login);
  }
}

/** One build at a time: a tab switch during a build waits for it. */
let menuTask: Promise<void> = Promise.resolve();
function refreshMenus(): void {
  menuTask = menuTask.then(buildMenus).catch((err: unknown) => {
    console.warn('[privacynotes] menu build failed:', err instanceof Error ? err.message : 'unknown');
  });
}

/** A click on a Copy login row: the value, cleared after 30 seconds. */
async function copyFromMenu(menuId: string): Promise<boolean> {
  if (!menuId.startsWith(`${COPY_MENU}:`)) return false;
  if (menuId === `${COPY_MENU}:unlock`) {
    openPopupOn('search', '');
    return true;
  }
  const at = menuId.lastIndexOf(':');
  const field = menuId.slice(at + 1);
  const login = copyMenuLogins.get(menuId.slice(0, at));
  if (!login || !(await isUnlocked())) {
    await flashBadge('problem');
    return true;
  }
  const value = field === 'username' ? login.username
    : field === 'password' ? login.password
    : field === 'code' ? (() => { const totp = parseTotpInput(login.totp); return totp ? generateTotpCode(totp, Date.now()) : ''; })()
    : '';
  if (!value || !(await copySecret(value))) await flashBadge('problem');
  return true;
}

/** A click on a Fill login row: the login goes into the page of that tab.
 *  The badge says how it went: the tick, or the mark for a problem. */
async function fillFromMenu(menuId: string, tab?: Browser.tabs.Tab): Promise<void> {
  // Before any await: the click is what lets the window open.
  if (fillMenuLocked) return openPopupOn('search', '');
  const login = fillMenuLogins.get(menuId);
  if (!login || tab?.id == null) return flashBadge('problem');
  const outcome = await runFill(login.item, tab.id);
  if (outcome !== 'filled' && outcome !== 'waiting' && outcome !== 'usernameOnly') await flashBadge('problem');
}

/** Open the popup on one of its views. A context-menu click is a user
 *  action, so the popup may open; where the browser refuses, the same page
 *  opens in a small window at the top end of the browser window, which
 *  Escape closes. Called before any await, while the click counts. */
function openPopupOn(view: PopupRoute['view'], url: string, query?: string): void {
  void browser.storage.session.set({ [ROUTE_KEY]: { view, url, query, at: Date.now() } satisfies PopupRoute });
  const fallback = () => openPopupWindow('');
  try {
    const opened = browser.action.openPopup?.();
    if (opened) void opened.catch(() => void fallback());
    else void fallback();
  } catch {
    void fallback();
  }
}

/** The popup's page as a small window at the top end of the browser window,
 *  where the browser does not open the toolbar popup. `extra` adds URL
 *  parameters (`&passkey=<id>`). */
async function openPopupWindow(extra: string): Promise<void> {
  const width = 400;
  const height = 640;
  const url = browser.runtime.getURL(`/popup.html?window=1${extra}` as '/');
  const win = await browser.windows.getLastFocused().catch(() => null);
  const left = win?.left != null && win.width != null ? Math.round(win.left + win.width - width - 16) : undefined;
  const top = win?.top != null ? Math.round(win.top + 72) : undefined;
  try {
    await browser.windows.create({ url, type: 'popup', width, height, left, top, focused: true });
  } catch {
    // Chrome refuses `left`/`top` outside visible screen bounds (multi-monitor
    // or small screens): let the browser place the window itself.
    await browser.windows.create({ url, type: 'popup', width, height, focused: true });
  }
}

/** Prompts whose popup has already connected its port, prompts that have
 *  fallen back from the toolbar popup to a standalone window (id -> timestamp,
 *  kept until the window disconnects so even a toolbar popup arriving after
 *  the window connected is still recognized as superseded), and any watchdog
 *  waiting for one to mount before falling back to a popup window or browser. */
const connectedPrompts = new Set<string>();
const windowFallbackPrompts = new Map<string, number>();
const promptWaiters = new Map<string, () => void>();
const PROMPT_OPEN_WAIT_MS = 1_200;
const WINDOW_OPEN_WAIT_MS = 2_500;

function pruneWindowFallbackPrompts(now = Date.now()): void {
  for (const [id, at] of windowFallbackPrompts) {
    if (now - at >= REQUEST_MAX_MS) windowFallbackPrompts.delete(id);
  }
}

function waitForPromptPort(id: string, ms: number): Promise<boolean> {
  if (connectedPrompts.has(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (connected: boolean) => {
      clearTimeout(timer);
      if (promptWaiters.get(id) === onConnect) promptWaiters.delete(id);
      resolve(connected);
    };
    const onConnect = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    promptWaiters.set(id, onConnect);
  });
}

/** A passkey prompt: the toolbar popup of the asking tab opens on the
 *  request, by its id in the address (never the one-slot route, review 7),
 *  or the same page in a small window. A watchdog checks that the popup
 *  actually mounted and connected its port, so a browser that swallows
 *  `action.openPopup` never leaves the site hung for 3 minutes. */
function openPasskeyPrompt(req: StoredRequest, tab: Browser.tabs.Tab): void {
  void (async () => {
    let mounted = false;
    try {
      await browser.action.setPopup({ tabId: req.tabId, popup: `popup.html?passkey=${req.id}` });
      await browser.action.openPopup({ windowId: tab.windowId });
      mounted = await waitForPromptPort(req.id, PROMPT_OPEN_WAIT_MS);
    } catch {
      mounted = false;
    }
    if (mounted || connectedPrompts.has(req.id)) return;
    // Mark fallback before opening the standalone window so a late toolbar
    // popup closing when focus shifts never cancels the fallback or triggers
    // a 60s site cooldown.
    pruneWindowFallbackPrompts();
    windowFallbackPrompts.set(req.id, Date.now());
    if (!(await markWindowFallback(req.id))) {
      windowFallbackPrompts.delete(req.id);
      return;
    }
    if (connectedPrompts.has(req.id)) {
      windowFallbackPrompts.delete(req.id);
      return;
    }
    await restorePopup(req.tabId);
    try {
      await openPopupWindow(`&passkey=${req.id}`);
      mounted = await waitForPromptPort(req.id, WINDOW_OPEN_WAIT_MS);
    } catch {
      mounted = false;
    }
    if (!mounted) {
      windowFallbackPrompts.delete(req.id);
      if (await readRequest(req.id)) await onPromptGone(req.id, false);
    }
  })();
}

/** A bounded delta pull when an unlocked sign-in finds no cached passkey yet
 *  (e.g. one saved in another browser or device), throttled so rapid retries
 *  never hammer the server and capped so browser fallback keeps user activation. */
const PASSKEY_REFRESH_MIN_MS = 10_000;
const PASSKEY_REFRESH_WAIT_MS = 1_200;
let lastPasskeyRefresh = 0;

async function refreshPasskeys(): Promise<void> {
  const now = Date.now();
  if (now - lastPasskeyRefresh < PASSKEY_REFRESH_MIN_MS) return;
  const synced = await lastPullAt();
  if (synced && now - synced < PASSKEY_REFRESH_MIN_MS) return;
  lastPasskeyRefresh = now;
  await Promise.race([
    pull().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, PASSKEY_REFRESH_WAIT_MS)),
  ]);
}

const doorDeps: DoorDeps = {
  chrome: !import.meta.env.FIREFOX,
  logins: async () => (await readConnection())?.logins === true,
  offer: async () => (await readPrefs()).offerPasskeys,
  inFront: async (tab) => tab.active === true && (await browser.windows.get(tab.windowId).catch(() => null))?.focused === true,
  passkeys: async () => {
    if (!(await isUnlocked())) return null;
    const found = await allEntries();
    return found ? loginsOf(found.entries).flatMap((l) => l.passkeys ?? []) : null;
  },
  refresh: refreshPasskeys,
  count: async () => Number((await browser.storage.local.get(PASSKEY_COUNT_KEY))[PASSKEY_COUNT_KEY]) || 0,
  openPrompt: openPasskeyPrompt,
  now: () => Date.now(),
};

/** The clip engine needs a DOM: Firefox's background has one, Chrome's
 *  worker borrows the offscreen document. */
function build(page: CapturedPage, mode: ClipMode, anyway: boolean): Promise<Built> {
  if (typeof DOMParser === 'function') return Promise.resolve(buildClip(page, mode, anyway));
  return offscreen<Built>({ target: 'offscreen', type: 'clip', page, mode, anyway });
}

async function capture(tabId: number): Promise<CapturedPage | null> {
  try {
    const [res] = await browser.scripting.executeScript({ target: { tabId }, func: capturePage });
    return (res?.result as CapturedPage | undefined) ?? null;
  } catch {
    return null;
  }
}

/** A page the person never opened (a link): fetched without cookies, only
 *  from the public web, within 20 seconds and 5 MB (`fetchLinkedPage`). */
async function fetchPage(url: string): Promise<CapturedPage | null> {
  const page = await fetchLinkedPage(url);
  return page ? { ...page, title: '', selectionHtml: '' } : null;
}

function report(result: SaveResult): void {
  void flashBadge(result.state === 'sent' || result.state === 'queued' ? 'saved' : 'problem');
}

/** A right-click save: no popup, so a short page is saved anyway and a long
 *  one as a bookmark, and the icon says how it went. */
async function savePage(page: CapturedPage | null, mode: ClipMode): Promise<void> {
  if (!page || !clippable(page.url)) return void flashBadge('problem');
  const built = await build(page, mode, true);
  const { pictures } = await readPrefs();
  if (built.kind === 'clip') report(await saveClip({ mode, url: page.url, title: page.title || built.clip.title, clip: built.clip, pictures }));
  else report(await saveClip({ mode: 'bookmark', url: page.url, title: page.title }));
}

/** The Generate key: a new value from the generator's remembered settings,
 *  copied and cleared after 30 seconds like any secret. A passphrase is Pro,
 *  so a free account gets a password. The icon says how it went. */
async function generateAndCopy(): Promise<void> {
  const [{ pwGen }, pro] = await Promise.all([readPrefs(), proHint()]);
  const value = generateFrom(pwGen.mode === 'passphrase' && !pro ? { ...pwGen, mode: 'password' } : pwGen, BIP39_WORDS);
  await flashBadge((await copySecret(value)) ? 'saved' : 'problem');
}

/** The Bookmark key, and the menu row: the page in front as a bookmark; the icon
 *  says it is done. */
async function bookmarkTab(tab: Browser.tabs.Tab | undefined): Promise<void> {
  if (!clippable(tab?.url)) return void flashBadge('problem');
  const result = await saveClip({ mode: 'bookmark', url: tab!.url!, title: tab?.title ?? '' });
  if (result.state === 'sent' || result.state === 'queued') await flashBadge('saved');
  else report(result);
}

async function copyMarkdown(page: CapturedPage | null): Promise<void> {
  if (!page || !clippable(page.url)) return void flashBadge('problem');
  const built = await build(page, 'note', true);
  if (built.kind !== 'clip') return void flashBadge('problem');
  const { clip } = built;
  const markdown = clip.markdown.replace(/\(pn-clip:(\d+)\)/g, (_m, i: string) => `(${clip.images[Number(i)]?.src ?? ''})`);
  const body = clipNoteBody({ ...clip, markdown }, page.url, {
    sourceLabel: t('shell:clipper.sourceLabel'),
    formatDate: (d) => d.toLocaleDateString(),
  });
  if (await writeClipboard(body)) await flashBadge('saved');
  else await flashBadge('problem');
}

/** New note from selection: the selected text as a quote, the page under it.
 *  Spec: docs/internal/specs/quick-note-694.md (section 4.1) */
function quoteOf(text: string, url: string): string {
  const quote = text.trim().split(/\r?\n/).map((line) => (line.trim() ? `> ${line}` : '>')).join('\n');
  return /^https?:\/\//i.test(url) ? `${quote}\n\n${url}\n` : `${quote}\n`;
}

async function onMenu(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab): Promise<void> {
  const id = String(info.menuItemId);
  if (id === 'login-add') return openPopupOn('addLogin', tab?.url ?? '');
  if (id === 'login-generate') return openPopupOn('generator', tab?.url ?? '');
  if (id === 'selection-new-note') return openPopupOn('note', tab?.url ?? '', quoteOf(info.selectionText ?? '', tab?.url ?? ''));
  if (id === FILL_MENU || id.startsWith(`${FILL_MENU}:`)) return fillFromMenu(id, tab);
  if (id === COPY_MENU) return copyLoginShortcut();
  if (await copyFromMenu(id)) return;
  await startI18n();
  const tabId = tab?.id;
  switch (id) {
    case 'page-note':
    case 'selection-page-note':
      return tabId === undefined ? undefined : savePage(await capture(tabId), 'note');
    case 'selection-note':
      return tabId === undefined ? undefined : savePage(await capture(tabId), 'selection');
    case 'page-bookmark':
      return bookmarkTab(tab);
    case 'page-markdown':
      return tabId === undefined ? undefined : copyMarkdown(await capture(tabId));
    case 'link-bookmark':
      if (!clippable(info.linkUrl)) return void flashBadge('problem');
      return report(await saveClip({ mode: 'bookmark', url: info.linkUrl!, title: info.selectionText ?? '' }));
    case 'link-note':
      if (!clippable(info.linkUrl)) return void flashBadge('problem');
      return savePage(await fetchPage(info.linkUrl!), 'note');
  }
}

// ── The address bar: "pn <words>" ────────────────────────────────────

const UNLOCK_SUGGESTION = 'pn:unlock';

function secondLine(e: CopyEntry): string {
  switch (e.kind) {
    case 'login':
      return e.username || e.urls[0] || '';
    case 'card':
      return [e.network, e.number ? `•••• ${e.number.replace(/\D/g, '').slice(-4)}` : ''].filter(Boolean).join(' ');
    case 'ssh':
      return e.keyType;
    case 'bookmark':
      return e.url.replace(/^https?:\/\/(www\.)?/, '');
  }
}

/** What Enter opens: a bookmark's site, or the item in the app. */
function destination(e: CopyEntry): string {
  return e.kind === 'bookmark' ? e.url : shortcutUrl(e.item);
}

async function omniboxSuggestions(text: string): Promise<Browser.omnibox.SuggestResult[]> {
  await startI18n();
  if (!(await isUnlocked())) return [{ content: UNLOCK_SUGGESTION, description: escapeMarkup(t('vault.omniboxUnlock')) }];
  const found = await allEntries();
  if (!found) return [{ content: UNLOCK_SUGGESTION, description: escapeMarkup(t('vault.omniboxUnlock')) }];
  const seen = new Set<string>();
  const out: Browser.omnibox.SuggestResult[] = [];
  for (const e of searchEntries(found.entries, text, 12)) {
    const content = destination(e);
    if (seen.has(content)) continue;
    seen.add(content);
    out.push({ content, description: escapeMarkup([e.name, secondLine(e)].filter(Boolean).join(' · ')) });
    if (out.length === 6) break;
  }
  return out;
}

async function omniboxEntered(text: string, disposition: string): Promise<void> {
  if (/^https?:\/\//i.test(text) && text !== UNLOCK_SUGGESTION) {
    if (disposition === 'currentTab') await browser.tabs.update({ url: text });
    else await browser.tabs.create({ url: text, active: disposition === 'newForegroundTab' });
    return;
  }
  // Words with no pick, or the vault locked: the popup, on the search.
  openPopupOn('search', '', text === UNLOCK_SUGGESTION ? '' : text);
}

async function onMessage(msg: BackgroundMessage): Promise<unknown> {
  switch (msg.type) {
    case 'save':
      return saveClip(msg.request);
    case 'saveLogin':
      return saveLogin(msg.request);
    case 'saveLoginEdit':
      return passkeysReleased() ? saveLoginEdit({ ...msg.request, mustSend: false }) : null;
    case 'savePasskey':
      // The page gets the credential only once the row is on the server (P24).
      return passkeysReleased()
        ? savePasskeyFor(msg.id, { kind: 'credential', credential: msg.credential }, () => saveLoginEdit({ ...msg.request, mustSend: true }), { state: 'failed' as const })
        : null;
    case 'saveNote':
      return saveNote(msg.request);
    case 'flush':
      return flush();
    case 'fill':
      return runFill(msg.item, msg.tabId);
    case 'copy':
      if (msg.clearAfter) await clearLater(msg.text);
      return true;
  }
}

export default defineBackground(() => {
  // Before anything else: the stored connection and keys are for the
  // extension's own pages and this worker, not for its scripts in pages.
  closeStorageToPageScripts();
  // The passkey scripts exist on pages only while the switch is on (review 9),
  // this browser is connected with logins and "Offer passkeys" is on. A change
  // of the setting or of the connection applies at once, to pages loaded after it.
  const syncScripts = () =>
    void Promise.all([readConnection(), readPrefs()])
      .then(([connection, prefs]) => syncPasskeyScripts(passkeyScriptsWanted(passkeysReleased(), connection, prefs), PASSKEY_MATCHES, PASSKEY_EXCLUDES))
      .catch(() => undefined);
  syncScripts();
  // The chosen lock time drives the idle detection (the browser's default
  // is one minute); a change of the choice applies at once.
  void applyLockTime();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'prefs' in changes) void applyLockTime();
    if (area === 'local' && ('prefs' in changes || 'connection' in changes)) syncScripts();
    // The vault opened, closed, pulled, edited or disconnected: the Copy login rows follow.
    if ((area === 'session' && SESSION_KEY in changes) || (area === 'local' && (ROWS_KEY in changes || PENDING_KEY in changes || 'connection' in changes))) refreshMenus();
  });
  browser.runtime.onInstalled.addListener(() => refreshMenus());
  onMarkEnd(refreshMenus);
  browser.runtime.onStartup.addListener(() => {
    refreshMenus();
    void flush();
  });
  // The page in front changed: its logins go under Copy login.
  browser.tabs.onActivated.addListener(() => refreshMenus());
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.url && tab.active) refreshMenus();
    // A page that went away takes its passkey request with it. Firefox names
    // no document, so a new load of the tab stands in (Chrome: the door).
    if (import.meta.env.FIREFOX && change.status === 'loading' && passkeysReleased()) void dropTabRequests(id);
  });
  if (passkeysReleased()) {
    browser.tabs.onRemoved.addListener((id) => void dropTabRequests(id));
    // The popup holds a port for the request it shows: a window closed with
    // no answer is a dismissal, answered here (section 5.4).
    browser.runtime.onConnect.addListener((port) => {
      // An own page by its address: a popup window carries `sender.tab` too.
      const own = fromOwnPage(port.sender, browser.runtime.id, browser.runtime.getURL('/'));
      if (!own || !port.name.startsWith(PROMPT_PORT)) return;
      const id = port.name.slice(PROMPT_PORT.length);
      const isWindow = (() => {
        try { return !!port.sender?.url && new URL(port.sender.url).searchParams.get('window') === '1'; }
        catch { return false; }
      })();
      // A toolbar popup that finished booting after we already fell back to a
      // standalone window is superseded (even if the window already connected):
      // tell it to close quietly and ignore its disconnect so it cannot cancel
      // the live window or start cooldown.
      if (windowFallbackPrompts.has(id) && !isWindow) {
        try { port.postMessage({ superseded: true }); } catch { /* ignore */ }
        return;
      }
      connectedPrompts.add(id);
      promptWaiters.get(id)?.();
      promptWaiters.delete(id);
      port.onDisconnect.addListener(() => {
        connectedPrompts.delete(id);
        if (windowFallbackPrompts.has(id) && !isWindow) return;
        windowFallbackPrompts.delete(id);
        void onPromptGone(id);
      });
    });
  }
  browser.windows.onFocusChanged.addListener((id) => {
    if (id !== browser.windows.WINDOW_ID_NONE) refreshMenus();
  });
  browser.contextMenus.onClicked.addListener((info, tab) => void onMenu(info, tab));
  browser.runtime.onMessage.addListener((msg: BackgroundMessage & { target?: string }, sender, sendResponse) => {
    // Only the extension's own pages (a script injected into a site carries
    // the site's address), and never the offscreen document's mail.
    const own = sender.id === browser.runtime.id && !!sender.url?.startsWith(browser.runtime.getURL('/'));
    // The fill script's answer to a probe: it comes from inside a site, so
    // it has its own door, which checks it against the run that asked.
    if ((msg as { type?: string } | null)?.type === 'fillProbe') return void onFillProbe(msg, sender);
    // The passkey relay's request and abort come from inside a site too:
    // their door checks the sender as the browser reports it. Off until the
    // release switch is on, so the relay's call finds no answer.
    if (passkeysReleased() && (msg as { type?: string } | null)?.type === 'passkey') {
      void onPasskeyRequest(msg as unknown as PasskeyRequestMessage, sender, doorDeps).then(sendResponse, () => sendResponse({ kind: 'fallback' }));
      return true;
    }
    if (passkeysReleased() && (msg as { type?: string } | null)?.type === 'passkey-abort') return void onPasskeyAbort((msg as unknown as PasskeyAbortMessage).id, sender);
    if (passkeysReleased() && (msg as { type?: string } | null)?.type === 'passkey-uvpa') {
      void onUvpaQuery(sender, doorDeps).then(sendResponse, () => sendResponse({ available: false }));
      return true;
    }
    if (msg?.target === 'offscreen' || !own) return;
    void onMessage(msg).then(sendResponse, (err: unknown) => {
      console.warn('[privacynotes] message failed:', err instanceof Error ? err.message : 'unknown');
      sendResponse(null);
    });
    return true;
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FLUSH_ALARM) void flush();
    else if (alarm.name === CLEAR_ALARM) void clearIfStill();
    else if (alarm.name === KEEP_ALARM) {
      void isUnlocked().then(async (open) => {
        if (open) await pull();
        else await browser.alarms.clear(KEEP_ALARM);
      });
    }
  });
  browser.commands.onCommand.addListener((command) => {
    // Before any await: the key press is what lets the popup open.
    if (command === 'new-note') openPopupOn('note', '');
    else if (command === 'copy-login') void fillLoginShortcut();
    else if (command === 'save-bookmark') void activeTab().then(bookmarkTab);
    else if (command === 'save-note') void activeTab().then(async (tab) => (tab?.id === undefined ? flashBadge('problem') : savePage(await capture(tab.id), 'note')));
    else if (command === 'lock-vault') void lockLogins();
    else if (command === 'generate-password') void generateAndCopy();
  });
  browser.idle.onStateChanged.addListener((state) => {
    void locksOn(state).then((lock) => (lock ? lockLogins() : undefined));
  });
  // The address bar: "pn" then words. Only the local copy is searched.
  void startI18n().then(() => browser.omnibox.setDefaultSuggestion({ description: escapeMarkup(t('vault.omniboxDefault')) }));
  browser.omnibox.onInputChanged.addListener((text, suggest) => {
    void omniboxSuggestions(text).then(suggest, () => suggest([]));
  });
  browser.omnibox.onInputEntered.addListener((text, disposition) => void omniboxEntered(text, disposition));
});
