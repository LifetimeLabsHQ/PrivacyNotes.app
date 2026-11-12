/**
 * When each login was last filled in this browser, so the login key and the
 * window's For this site put the one used last first. Kept per item id with
 * a time and nothing else: the item already names its site, so no address is
 * stored. Local only, never synced; Disconnect clears it with the rest of
 * `storage.local`.
 * Spec: docs/internal/plans/click-to-fill.md (section 3.8)
 */
import { browser } from 'wxt/browser';

const LAST_FILL_KEY = 'lastFill';
// Spec: docs/internal/plans/click-to-fill.md (section 3.8)
const KEEP = 500;

export type LastFill = Record<string, number>;

export async function readLastFill(): Promise<LastFill> {
  const v = (await browser.storage.local.get(LAST_FILL_KEY))[LAST_FILL_KEY];
  return v && typeof v === 'object' ? (v as LastFill) : {};
}

export async function markFilled(item: string): Promise<void> {
  const map = { ...(await readLastFill()), [item]: Date.now() };
  const kept = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, KEEP);
  await browser.storage.local.set({ [LAST_FILL_KEY]: Object.fromEntries(kept) });
}

/** Filled most recently first; logins never filled keep their order after
 *  them (the sort is stable). */
export function byLastFill(map: LastFill): (a: { item: string }, b: { item: string }) => number {
  return (a, b) => (map[b.item] ?? 0) - (map[a.item] ?? 0);
}

/** The last press of the login key: the page, the logins in the order that
 *  press saw them, and which one it filled. */
export interface Cycle { url: string; order: string[]; index: number; at: number }

/**
 * Which login a press of the login key fills, Bitwarden's way: a press
 * within `windowMs` of a fill on the same page, with the same logins, takes
 * the next one in the order that press saw (the list wraps); any other press
 * starts again at the top of `order`, the login filled last.
 */
export function nextFill(order: string[], url: string, prev: Cycle | undefined, now: number, windowMs: number): Cycle {
  const again = !!prev && prev.url === url && now - prev.at < windowMs
    && prev.order.length === order.length && prev.order.every((i) => order.includes(i));
  return again ? { url, order: prev.order, index: (prev.index + 1) % prev.order.length, at: now } : { url, order, index: 0, at: now };
}
