/**
 * The background: the PrivacyNotes right-click submenu (with the logins of
 * the page under Copy login), the address-bar keyword, the queue's retry
 * alarm, the clipboard clear, the two keyboard shortcuts, the idle lock, and
 * the saves the popup hands over. It reads a page only when the person clips
 * it, by injecting the capture script into that one tab, and writes into a
 * page only when the person fills a login (`src/fillRun.ts`).
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.3, 3.4 and 5)
 */
import { browser, type Browser } from 'wxt/browser';
import { clipNoteBody } from '@notes/clipper';
import { BIP39_WORDS, generateTotpCode, parseTotpInput } from '@notes/shared';
import { generateFrom } from '@web/passwordGen';
import type { CopyEntry, LoginCopyEntry } from '@notes/shared/extension';
import { capturePage, type CapturedPage } from '../src/capture';
import { buildClip, clippable, type Built, type ClipMode } from '../src/clipping';
import { CLEAR_ALARM, clearIfStill, clearLater, copySecret, offscreen, writeClipboard } from '../src/clipboard';
import { FLUSH_ALARM, flashBadge, flush } from '../src/queue';
import { saveClip, saveLogin, saveNote, type SaveResult } from '../src/save';
import { readPrefs } from '../src/prefs';
import { startI18n, t } from '../src/i18n';
import { readConnection } from '../src/connection';
import { allEntries, applyLockTime, copyLoginShortcut, isUnlocked, proHint, KEEP_ALARM, lockLogins, locksOn, pull, ROWS_KEY, SESSION_KEY, shortcutUrl } from '../src/logins';
import { byLastFill, readLastFill } from '../src/lastFill';
import { loginsOf, matchLogins, searchEntries } from '../src/match';
import { fillLoginShortcut, onFillProbe, runFill } from '../src/fillRun';
import type { BackgroundMessage } from '../src/messages';
import { ROUTE_KEY, type PopupRoute } from '../src/route';
import { readShortcuts, withKeys } from '../src/shortcuts';
import { clearSiteCounts, onMarkEnd, showSiteCount } from '../src/badge';

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
    return void clearSiteCounts();
  }
  if (!(await isUnlocked())) {
    void clearSiteCounts();
    fillMenuLocked = true;
    return menuItem(`${COPY_MENU}:unlock`, t('vault.unlockToCopy'), ALL_CONTEXTS, COPY_MENU);
  }
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
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
  const fallback = async () => {
    const width = 400;
    const height = 640;
    const win = await browser.windows.getLastFocused().catch(() => null);
    const left = win?.left != null && win.width != null ? Math.max(0, win.left + win.width - width - 16) : undefined;
    const top = win?.top != null ? win.top + 72 : undefined;
    await browser.windows.create({ url: browser.runtime.getURL('/popup.html?window=1' as '/'), type: 'popup', width, height, left, top, focused: true });
  };
  try {
    const opened = browser.action.openPopup?.();
    if (opened) void opened.catch(() => void fallback());
    else void fallback();
  } catch {
    void fallback();
  }
}

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

/** A page the person never opened (a link): fetched without cookies. */
async function fetchPage(url: string): Promise<CapturedPage | null> {
  try {
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/text\/html|application\/xhtml/.test(type)) return null;
    const html = (await res.text()).slice(0, 5_000_000);
    return { url: res.url || url, title: '', html, selectionHtml: '' };
  } catch {
    return null;
  }
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

function activeTab(): Promise<Browser.tabs.Tab | undefined> {
  return browser.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab);
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
 *  Spec: docs/internal/plans/quick-note-694.md (section 4.1) */
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

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
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
  if (!(await isUnlocked())) return [{ content: UNLOCK_SUGGESTION, description: xml(t('vault.omniboxUnlock')) }];
  const found = await allEntries();
  if (!found) return [{ content: UNLOCK_SUGGESTION, description: xml(t('vault.omniboxUnlock')) }];
  const seen = new Set<string>();
  const out: Browser.omnibox.SuggestResult[] = [];
  for (const e of searchEntries(found.entries, text, 12)) {
    const content = destination(e);
    if (seen.has(content)) continue;
    seen.add(content);
    out.push({ content, description: xml([e.name, secondLine(e)].filter(Boolean).join(' · ')) });
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
  // The chosen lock time drives the idle detection (the browser's default
  // is one minute); a change of the choice applies at once.
  void applyLockTime();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'prefs' in changes) void applyLockTime();
    // The vault opened, closed, pulled or disconnected: the Copy login rows follow.
    if ((area === 'session' && SESSION_KEY in changes) || (area === 'local' && (ROWS_KEY in changes || 'connection' in changes))) refreshMenus();
  });
  browser.runtime.onInstalled.addListener(() => refreshMenus());
  onMarkEnd(refreshMenus);
  browser.runtime.onStartup.addListener(() => {
    refreshMenus();
    void flush();
  });
  // The page in front changed: its logins go under Copy login.
  browser.tabs.onActivated.addListener(() => refreshMenus());
  browser.tabs.onUpdated.addListener((_id, change, tab) => {
    if (change.url && tab.active) refreshMenus();
  });
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
  void startI18n().then(() => browser.omnibox.setDefaultSuggestion({ description: xml(t('vault.omniboxDefault')) }));
  browser.omnibox.onInputChanged.addListener((text, suggest) => {
    void omniboxSuggestions(text).then(suggest, () => suggest([]));
  });
  browser.omnibox.onInputEntered.addListener((text, disposition) => void omniboxEntered(text, disposition));
});
