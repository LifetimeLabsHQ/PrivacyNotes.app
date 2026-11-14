import { base64ToBytes, bytesToBase64, decryptJsonAad, encryptJsonAad } from '@notes/shared';
import { isDemoMode } from './demo';
import { localDataKeyCopy, onLocalDataKeyCleared } from './localKey';
import { currentKeyEpoch, epochMarker, epochOf, holdsEpoch, KeyEpochUnknown, openWithRing } from './keyRing';
import { localAad, sealedWritesOn } from './localSeal';
import { defaultSettings, type UserSettings } from './userSettingsShape';

/**
 * The sealed part of the settings cache (local at rest, release C).
 *
 * The settings that hold what a person typed - folder, tag and device names,
 * custom trackers and themes, the journal title text, the medication list -
 * leave the readable cache in localStorage and live here, sealed under the
 * local data key. Everything the lock screen and the boot read before any
 * key exists stays in the readable cache (userSettings.ts writes both).
 * Demo mode stays plaintext, as the Dexie seal does: the demo phrase is a
 * public constant.
 *
 * The envelope carries the key epoch `e` of the local key that sealed it
 * (keyRing.ts), none for epoch 1. It opens with the key of that epoch, and an
 * epoch this device holds no key for reads as `locked`, never `unreadable`:
 * locked keeps the cache as it is, while unreadable resets it and loses an
 * unpushed change.
 * Spec: docs/internal/specs/local-at-rest.md (section 3.4);
 * docs/internal/plans/phrase-change.md (6.2, sealed settings cache)
 */

const SEALED_SETTINGS = [
  'favoriteTags',
  'folders',
  'foldersDeleted',
  'itemStyles',
  'deviceLabels',
  'extensionKeys',
  'customThemes',
  // A private calendar address is a secret. Spec: docs/internal/specs/calendar-pillar-spec.md (section 14)
  'calendarFeeds',
  // Home's layout names tags. Spec: docs/internal/specs/dashboard.md (section 7)
  'dashboard',
  'factors',
  'customHabits',
  'trackerSettings',
  'medications',
  'journalTitlePattern',
  'journalTitleSuffix',
] as const satisfies ReadonlyArray<keyof UserSettings>;

type SealedSettings = Pick<UserSettings, typeof SEALED_SETTINGS[number]>;

const SEALED_KEY = 'privacynotes.settings.sealed';
// Pinned: a sealed part written under another tag never opens.
const AAD = localAad('settings', 'cache');

/** Whether the settings cache splits on this device. */
export function settingsSealOn(): boolean {
  return !isDemoMode() && sealedWritesOn();
}

export type SealedRead =
  | { state: 'open'; fields: Record<string, unknown>; base: Record<string, string>; dirty: boolean }
  | { state: 'absent' }
  | { state: 'locked' }
  | { state: 'unreadable' };

// One slot, matched on nonce AND ciphertext like the Dexie memo: the cache is
// read on every settings read, and only a changed blob pays the crypto.
let memo: { n: string; ct: string; fields: Record<string, unknown>; base: Record<string, string>; dirty: boolean } | null = null;
onLocalDataKeyCleared(() => {
  memo = null;
});

/** The sealed part as it is on the disk now. */
export function readSealedSettings(): SealedRead {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SEALED_KEY);
  } catch {
    return { state: 'absent' };
  }
  if (raw === null) return { state: 'absent' };
  let n: unknown;
  let ct: unknown;
  let e: unknown;
  try {
    ({ n, ct, e } = JSON.parse(raw) as { n?: unknown; ct?: unknown; e?: unknown });
  } catch {
    return { state: 'unreadable' };
  }
  if (typeof n !== 'string' || typeof ct !== 'string') return { state: 'unreadable' };
  if (memo && memo.n === n && memo.ct === ct) return { state: 'open', fields: memo.fields, base: memo.base, dirty: memo.dirty };
  const key = localDataKeyCopy();
  if (!key) return { state: 'locked' };
  const nonce = n;
  const sealed = ct;
  try {
    const fields = openWithRing('local', key, (k) => decryptJsonAad<unknown>(base64ToBytes(sealed), base64ToBytes(nonce), k, AAD), epochOf(e));
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { state: 'unreadable' };
    const own: Record<string, unknown> = {};
    for (const k of SEALED_SETTINGS) {
      if (k in fields) own[k] = (fields as Record<string, unknown>)[k];
    }
    const base = readBase((fields as Record<string, unknown>)[BASE_FIELD]);
    const dirty = (fields as Record<string, unknown>)[DIRTY_FIELD] !== false;
    memo = { n, ct, fields: own, base, dirty };
    return { state: 'open', fields: own, base, dirty };
  } catch (err) {
    return err instanceof KeyEpochUnknown ? { state: 'locked' } : { state: 'unreadable' };
  } finally {
    key.fill(0);
  }
}

// The per-key base (userSettings.ts, syncedKeys) of the sealed settings as
// this bundle last synced them, sealed with them. An older bundle rewrites
// the readable base, so this copy is what still tells a change made here,
// not yet pushed, from a value the older bundle changed since.
const BASE_FIELD = '#base';
// Whether the cache held a change the server had not seen when this was
// sealed. A clean sealed part holds nothing the server lacks.
const DIRTY_FIELD = '#dirty';

function readBase(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of SEALED_SETTINGS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Seal these settings over the sealed part, with their synced base. False
 *  when no key is registered or the write failed: the sealed part is then as
 *  it was. */
export function writeSealedSettings(settings: UserSettings, syncedKeys: Record<string, string> | undefined, dirty: boolean): boolean {
  const key = localDataKeyCopy();
  if (!key) return false;
  try {
    const fields = pickSealed(settings) as Record<string, unknown>;
    const base = readBase(syncedKeys);
    const { ciphertext, nonce } = encryptJsonAad({ ...fields, [BASE_FIELD]: base, [DIRTY_FIELD]: dirty }, key, AAD);
    const n = bytesToBase64(nonce);
    const ct = bytesToBase64(ciphertext);
    localStorage.setItem(SEALED_KEY, JSON.stringify({ n, ct, ...epochMarker() }));
    memo = { n, ct, fields, base, dirty };
    return true;
  } catch {
    return false;
  } finally {
    key.fill(0);
  }
}

/**
 * The sealed part sealed again under the current local key after a phrase
 * change, the plaintext as it was, and written only over the text this read.
 * False when it needs nothing (absent, already current, or of an epoch this
 * device holds no key for, which reads as locked until its key arrives) or
 * did not open. Spec: docs/internal/plans/phrase-change.md (6.4, item 1)
 */
export function resealSealedSettings(): boolean {
  if (!settingsSealOn()) return false;
  let raw: string | null;
  try {
    raw = localStorage.getItem(SEALED_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;
  let parsed: { n?: unknown; ct?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return false;
  }
  const { n, ct } = parsed;
  if (typeof n !== 'string' || typeof ct !== 'string') return false;
  const epoch = epochOf(parsed.e);
  if (epoch === currentKeyEpoch() || !holdsEpoch(epoch)) return false;
  const key = localDataKeyCopy();
  if (!key) return false;
  try {
    const fields = openWithRing('local', key, (k) => decryptJsonAad<unknown>(base64ToBytes(ct), base64ToBytes(n), k, AAD), epoch);
    const { ciphertext, nonce } = encryptJsonAad(fields, key, AAD);
    const next = JSON.stringify({ n: bytesToBase64(nonce), ct: bytesToBase64(ciphertext), ...epochMarker() });
    if (localStorage.getItem(SEALED_KEY) !== raw) return false;
    localStorage.setItem(SEALED_KEY, next);
    memo = null;
    return true;
  } catch {
    return false;
  } finally {
    key.fill(0);
  }
}

/** A demo session clears only its own bucket: the sealed part is the real
 *  account's, which the demo never writes. */
export function removeSealedSettings(): void {
  if (isDemoMode()) return;
  memo = null;
  try {
    localStorage.removeItem(SEALED_KEY);
  } catch {
    /* ignore */
  }
}

export function pickSealed(settings: UserSettings): SealedSettings {
  const out = {} as Record<string, unknown>;
  for (const k of SEALED_SETTINGS) out[k] = settings[k];
  return out as SealedSettings;
}

/** The readable part: the same object without the sealed settings. */
export function stripSealed(settings: UserSettings): Partial<UserSettings> {
  const out: Record<string, unknown> = { ...settings };
  for (const k of SEALED_SETTINGS) delete out[k];
  return out as Partial<UserSettings>;
}

// The lists a read hands out while the sealed part is locked. Never values:
// a save that carries one of them was built from such a read (the boot, the
// lock screen, a PIN recovery), so its sealed settings are not the person's
// and the device keeps the ones it holds (userSettings.ts, saveLocalSettings).
// The journal strings cannot carry the mark; the lists beside them always do.
const placeholders = new WeakSet<object>();

/** These settings with every sealed one replaced by a marked default. */
export function withPlaceholders(settings: UserSettings): UserSettings {
  const defaults = defaultSettings();
  const out = { ...settings } as Record<string, unknown>;
  for (const k of SEALED_SETTINGS) {
    // A copy, so no default another object shares can ever carry the mark.
    const v: unknown = structuredClone(defaults[k]);
    if (v !== null && typeof v === 'object') placeholders.add(v);
    out[k] = v;
  }
  return out as UserSettings;
}

/** Whether a settings object came from a read with the sealed part locked. */
export function fromLockedRead(settings: UserSettings): boolean {
  return SEALED_SETTINGS.some((k) => {
    const v = settings[k];
    return v !== null && typeof v === 'object' && placeholders.has(v);
  });
}
