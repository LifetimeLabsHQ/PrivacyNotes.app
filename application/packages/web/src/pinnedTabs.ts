/**
 * Pinned tabs: the ordered list of item ids pinned to the start of the tab
 * strip, kept in the encrypted settings blob as `pinnedTabs`, one stamped
 * register (`list`).
 *
 * Unpinned open tabs and the side-by-side pair stay per device in
 * `useOpenTabs.ts`, because they describe one screen and change on every note
 * click. Pinned tabs are deliberate and change rarely, so syncing them as one
 * stamped register (the rule of `formatBar.ts` and `dashboardLayout.ts`) lets
 * every desktop/web install share them while older apps and phones pass the
 * field through untouched.
 * Spec: docs/internal/specs/note-tabs.md (section 7)
 */
import {
  mergeRegisterMaps,
  registerMapsEqual,
  stampAfter,
  validateRegisterMap,
  type RegisterMap,
} from './registers';

export type PinnedTabsSetting = RegisterMap;

const LIST_KEY = 'list';
/** Most pinned tabs the synced register keeps. */
export const MAX_PINNED_TABS = 50;
const ID_MAX = 64;
// 50 UUIDs plus JSON punctuation fit well inside 4 KiB.
const JSON_MAX = 4096;
/**
 * Stamp used when migrating pre-sync local pinned tabs into the account
 * register for the first time. Older than any real edit, so an install that
 * upgrades later can never overwrite pinned tabs another device already edited.
 */
const LEGACY_PINNED_AT = '1970-01-01T00:00:01.000Z';

function cleanIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.length < 1 || item.length > ID_MAX || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_PINNED_TABS) break;
  }
  return out;
}

export function validatePinnedTabs(raw: unknown, now = Date.now()): PinnedTabsSetting {
  return validateRegisterMap(raw, (k) => k === LIST_KEY, JSON_MAX, now);
}

export function mergePinnedTabs(local: PinnedTabsSetting, remote: PinnedTabsSetting, now = Date.now()): PinnedTabsSetting {
  return mergeRegisterMaps(local, remote, now);
}

export const pinnedTabsEqual = registerMapsEqual;

/** Whether the account has a synced pinned-tabs register (empty reset included). */
export function hasPinnedTabsRegister(setting: PinnedTabsSetting | undefined): boolean {
  return setting?.[LIST_KEY] !== undefined;
}

/** Ordered pinned item ids from the synced register, or `[]` when unset/empty/bad. */
export function readPinnedTabs(setting: PinnedTabsSetting | undefined): string[] {
  const v = setting?.[LIST_KEY]?.v;
  if (typeof v !== 'string') return [];
  try {
    return cleanIds(JSON.parse(v));
  } catch {
    return [];
  }
}

/**
 * Write the ordered pinned ids; an empty list is stored as a stamped null so
 * unpinning the last tab travels to other devices. Unchanged comes back as the
 * same object.
 */
export function writePinnedTabs(setting: PinnedTabsSetting, nextIds: readonly string[]): PinnedTabsSetting {
  const clean = cleanIds(nextIds);
  const v = clean.length === 0 ? null : JSON.stringify(clean);
  const prev = setting[LIST_KEY];
  if (prev ? prev.v === v : v === null) return setting;
  return { ...setting, [LIST_KEY]: { v, at: stampAfter(prev?.at) } };
}

/**
 * One-time migration of legacy local pinned tabs into an account that has no
 * synced register yet. Stamped at `LEGACY_PINNED_AT` so any real edit from
 * another upgraded device wins the merge.
 */
export function migratePinnedTabs(setting: PinnedTabsSetting, legacyIds: readonly string[]): PinnedTabsSetting {
  if (hasPinnedTabsRegister(setting)) return setting;
  const clean = cleanIds(legacyIds);
  if (clean.length === 0) return setting;
  return { ...setting, [LIST_KEY]: { v: JSON.stringify(clean), at: LEGACY_PINNED_AT } };
}
