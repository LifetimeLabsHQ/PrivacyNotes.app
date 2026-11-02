/**
 * The browser extension's logins key P, as the apps keep it: entries of the
 * synced settings field `extensionKeys`, each one wrapped under an HKDF branch
 * of the content key, so P and the extensions' halves are never plain fields
 * of the settings or of their local cache.
 *
 * Two kinds of entry, one register each (registers.ts), merged per entry at
 * every sync point like the device labels:
 *   p:<tag>      P itself, for the key tag the server holds.
 *   k:<tokenId>  the browser half Kext of one connected extension, so a new
 *                P can be split for every extension that stays.
 * An entry is never edited in place: a new P has a new tag and a new entry,
 * and Kext never changes for an extension. This module
 * only merges and clears entries, so the settings code loads no crypto at
 * boot; opening and writing them is extensionKeyring.ts.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.1)
 */
import {
  mergeRegisterMaps,
  registerMapsEqual,
  stampAfter,
  validateRegisterMap,
  type RegisterMap,
} from './registers';

export type ExtensionKeys = RegisterMap;

const KEY_PATTERN = /^(p:[0-9a-f]{32}|k:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
// A wrapped entry is a nonce, a tag and at most a hundred bytes, in base64.
const ENTRY_MAX = 256;

export function validateExtensionKeys(raw: unknown, now = Date.now()): ExtensionKeys {
  return validateRegisterMap(raw, (k) => KEY_PATTERN.test(k), ENTRY_MAX, now);
}

export function mergeExtensionKeys(local: ExtensionKeys, remote: ExtensionKeys, now = Date.now()): ExtensionKeys {
  return mergeRegisterMaps(local, remote, now);
}

export const extensionKeysEqual = registerMapsEqual;

/** The map with entries cleared. A cleared entry stays as a tombstone, so a
 *  device that still holds it cannot merge it back. */
export function withoutEntries(keys: ExtensionKeys, names: readonly string[]): ExtensionKeys {
  const out = { ...keys };
  for (const name of names) {
    if (out[name]?.v === null || !out[name]) continue;
    out[name] = { v: null, at: stampAfter(out[name]?.at) };
  }
  return out;
}
