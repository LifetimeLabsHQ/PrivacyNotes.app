import { browser, type Browser } from 'wxt/browser';

/** The tab in front in the window the person used last. */
export function activeTab(): Promise<Browser.tabs.Tab | undefined> {
  return browser.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab);
}
