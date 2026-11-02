/**
 * The popup's remembered choices, in this browser only: Include pictures,
 * when the vault locks, the type filter, and the generator's options.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, lock time)
 */
import { browser } from 'wxt/browser';
import { readPwGen, type PwGen } from '@web/passwordGen';
import { COPY_KINDS, type CopyKind } from '@notes/shared/extension';

/** When the vault locks: after that many seconds with no input, when the
 *  computer locks, or when the browser closes. Every choice also locks when
 *  the browser closes, since the key lives in session storage. Bitwarden's
 *  list; "when the popup closes" went on 2026-11-01, nobody could use it. */
export type LockAfter = 60 | 300 | 900 | 1800 | 3600 | 14400 | 'system' | 'restart';

export const LOCK_CHOICES: readonly LockAfter[] = [60, 300, 900, 1800, 3600, 14400, 'system', 'restart'];
const LOCK_DEFAULT: LockAfter = 900;

/** The type pill: every kind, or one of them. */
export type TypeFilter = 'all' | CopyKind;

export interface Prefs {
  pictures: boolean;
  lockAfter: LockAfter;
  typeFilter: TypeFilter;
  pwGen: PwGen;
}

const KEY = 'prefs';

export async function readPrefs(): Promise<Prefs> {
  const got = (await browser.storage.local.get(KEY))[KEY] as Partial<Prefs> | undefined;
  const lock = got?.lockAfter as LockAfter | 'popup' | undefined;
  return {
    pictures: got?.pictures !== false,
    // The retired "when the popup closes" becomes the shortest time left.
    lockAfter: lock === 'popup' ? 60 : LOCK_CHOICES.includes(lock as LockAfter) ? (lock as LockAfter) : LOCK_DEFAULT,
    typeFilter: (COPY_KINDS as readonly string[]).includes(got?.typeFilter as string) ? (got!.typeFilter as TypeFilter) : 'all',
    pwGen: readPwGen(got?.pwGen),
  };
}

export async function writePrefs(patch: Partial<Prefs>): Promise<void> {
  await browser.storage.local.set({ [KEY]: { ...(await readPrefs()), ...patch } });
}
