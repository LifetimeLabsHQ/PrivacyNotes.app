/**
 * The toolbar badge. Two layers, the way the browser keeps them:
 * - for all tabs: the clips that wait to send (blue), or a short mark after
 *   an action, a tick (green) or "!" (red);
 * - for one tab: how many logins the vault has for that tab's site (grey),
 *   while the vault is unlocked, like Bitwarden.
 * The browser shows a tab's own text over the text for all tabs, so a mark
 * is written on the tab in front too, and that tab gets its count back after
 * the mark's three seconds. The browser keeps a tab's text when the
 * background restarts, so nothing here depends on memory.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, the badge)
 */
import { browser } from 'wxt/browser';
import { activeTab } from './tabs';

const QUEUE_COLOR = '#1E40AF';
const SAVED_COLOR = '#006045';
const PROBLEM_COLOR = '#C10007';
const SITE_COLOR = '#52525B';
const MARK_MS = 3000;

/** Sets the count of the tab in front again; the background registers it. */
let refreshFront: () => void = () => undefined;
export function onMarkEnd(fn: () => void): void {
  refreshFront = fn;
}

/** The number of clips that wait to send, for all tabs. */
export async function showQueueCount(n: number): Promise<void> {
  await browser.action.setBadgeText({ text: n > 0 ? String(n) : '' });
  if (n > 0) await browser.action.setBadgeBackgroundColor({ color: QUEUE_COLOR });
}

/** A tab's own count. 0 drops the tab's own text (null, not ''), so the
 *  text for all tabs, the queue count, shows on it again. */
export async function showSiteCount(tabId: number, n: number): Promise<void> {
  await browser.action.setBadgeText({ tabId, text: n > 0 ? String(n) : (null as unknown as string) }).catch(() => undefined);
  if (n > 0) await browser.action.setBadgeBackgroundColor({ tabId, color: SITE_COLOR }).catch(() => undefined);
}

/** Locked or disconnected: no tab shows a count. */
export async function clearSiteCounts(): Promise<void> {
  const tabs = await browser.tabs.query({}).catch(() => []);
  await Promise.all(tabs.map((tab) => (tab.id != null ? showSiteCount(tab.id, 0) : undefined)));
}

/** A tick or "!" for three seconds, on every tab and on the tab in front.
 *  `after` puts the text for all tabs back (the queue count); "!" stays
 *  there until the queue changes, as before. */
export async function showMark(mark: 'saved' | 'problem', after: () => Promise<void>): Promise<void> {
  const text = mark === 'saved' ? '✓' : '!';
  const color = mark === 'saved' ? SAVED_COLOR : PROBLEM_COLOR;
  await browser.action.setBadgeText({ text });
  await browser.action.setBadgeBackgroundColor({ color });
  const tab = await activeTab().catch(() => undefined);
  if (tab?.id != null) {
    await browser.action.setBadgeText({ tabId: tab.id, text }).catch(() => undefined);
    await browser.action.setBadgeBackgroundColor({ tabId: tab.id, color }).catch(() => undefined);
  }
  setTimeout(() => {
    if (mark === 'saved') void after();
    if (tab?.id != null) void showSiteCount(tab.id, 0).then(refreshFront);
  }, MARK_MS);
}
