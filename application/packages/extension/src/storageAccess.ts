/**
 * Who may read what the extension stores.
 *
 * `storage.local` holds the connection (the token and the inbox key), the
 * browser's half of the logins key and the sealed logins. Chrome opens it by
 * default to every script of the extension, the two that run inside pages
 * included (the passkey relay and the fill script), and keeps only
 * `storage.session` to the extension's own pages and its worker. Neither
 * page script reads storage, so `local` gets the level `session` has. The
 * level is asked for at every start of the background, because nothing here
 * says it outlasts a restart of the browser. A browser without the call
 * (Firefox) keeps its default (beta #217 item 5).
 */
import { browser } from 'wxt/browser';

type Closable = { setAccessLevel?: (options: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void> | void };

export function closeStorageToPageScripts(): void {
  const local = browser.storage.local as Closable;
  try {
    void Promise.resolve(local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })).catch(() => undefined);
  } catch {
    // The name is there and the call is refused: the default stays.
  }
}
