/**
 * Copy from the popup: the clipboard now, and the background clears it after
 * 30 seconds if it still holds the value. A shortcut is not a secret and
 * stays.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, step 5)
 */
import { browser } from 'wxt/browser';

export async function copyAndClear(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    await browser.runtime.sendMessage({ type: 'copy', text: value, clearAfter: true });
    return true;
  } catch {
    return false;
  }
}

export async function copyPlain(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
