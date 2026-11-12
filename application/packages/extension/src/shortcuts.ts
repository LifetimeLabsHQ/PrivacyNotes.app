/**
 * The extension's keyboard shortcuts as this browser has them now.
 * The manifest suggests a key for four commands in Chrome and Edge (their
 * limit) and for each in Firefox: a person can set, change or clear each one
 * in the browser's shortcut settings, and a key another
 * extension took first stays empty. So every hint reads the browser's own
 * list, in the browser's own spelling ("⌥⇧S" in Chrome on a Mac), and shows
 * nothing for a command with no key.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.5)
 */
import { browser } from 'wxt/browser';

export type ShortcutCommand = '_execute_action' | 'copy-login' | 'save-note' | 'lock-vault' | 'generate-password' | 'save-bookmark' | 'new-note';
export type Shortcuts = Partial<Record<ShortcutCommand, string>>;

export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = ['_execute_action', 'copy-login', 'save-note', 'save-bookmark', 'new-note', 'generate-password', 'lock-vault'];

/** Each command's key, or no entry when it has none. Firefox names the
 *  toolbar command `_execute_action` like Chrome under Manifest V3. */
export async function readShortcuts(): Promise<Shortcuts> {
  const list = await browser.commands.getAll().catch(() => []);
  const out: Shortcuts = {};
  for (const c of list) {
    if (c.shortcut && SHORTCUT_COMMANDS.includes(c.name as ShortcutCommand)) out[c.name as ShortcutCommand] = c.shortcut;
  }
  return out;
}

/** A label for a place that draws only text (the right-click menu, the
 *  toolbar button's tooltip): the key in parentheses after it. */
export function withKeys(label: string, keys: string | undefined): string {
  return keys ? `${label} (${keys})` : label;
}

/** The browser's page where a person changes the keys. Chrome and Edge open
 *  their own extensions page; Firefox has a call for it. */
export async function openShortcutSettings(): Promise<void> {
  if (import.meta.env.FIREFOX) {
    const open = (browser.commands as { openShortcutSettings?: () => Promise<void> }).openShortcutSettings;
    if (open) return open();
    await browser.tabs.create({ url: 'about:addons' });
    return;
  }
  const edge = /Edg\//.test(navigator.userAgent);
  await browser.tabs.create({ url: edge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts' });
}
