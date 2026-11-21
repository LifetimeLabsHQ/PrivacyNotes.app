import { base64ToBytes, bytesToBase64, decryptJsonAad, encryptJsonAad } from '@notes/shared';
import { isDemoMode } from './demo';
import { localDataKeyCopy, onLocalDataKeyCleared } from './localKey';
import { currentKeyEpoch, epochMarker, epochOf, holdsEpoch, KeyEpochUnknown, openWithRing } from './keyRing';
import { localAad, sealedWritesOn } from './localSeal';
import { defaultSettings, type UserSettings } from './userSettingsShape';

/**
 * The sealed part of the settings cache (local at rest, release C).
 *
 * Every setting leaves the readable cache in localStorage and lives here,
 * sealed under the local data key, except the few the lock screen, the boot
 * and the raw note counter read before any key exists (READABLE_SETTINGS).
 * A key this bundle does not know is sealed too: a blob that is not settings
 * at all (a note's ciphertext copied over the settings row, RFS #226) or a
 * setting a newer bundle added never lands on the disk in the clear
 * (userSettings.ts writes both parts). Demo mode stays plaintext, as the
 * Dexie seal does: the demo phrase is a public constant.
 *
 * The envelope carries the key epoch `e` of the local key that sealed it
 * (keyRing.ts), none for epoch 1. It opens with the key of that epoch, and an
 * epoch this device holds no key for reads as `locked`, never `unreadable`:
 * locked keeps the cache as it is, while unreadable resets it and loses an
 * unpushed change.
 * Spec: docs/internal/specs/local-at-rest.md (section 3.4);
 * docs/internal/plans/phrase-change.md (6.2, sealed settings cache)
 */

// Spec: docs/internal/specs/local-at-rest.md (section 3.4, the readable list)
const READABLE_SETTINGS = new Set<string>([
  // The freshness counter and the note counter: notesCreated.ts bumps both
  // in the raw envelope, and every save compares the counter.
  'settingsRev',
  'notesCreated',
  // The app lock and its windows (DEVICE_SETTINGS), read by the boot, the
  // lock screen and the re-lock watch before any key exists.
  'appLockEnabled',
  'appLockTimeoutMinutes',
  'pinTimeoutMinutes',
  'biometricEnabled',
  // The PIN hash: the lock screen's PIN recovery, and the withholding of
  // an untrusted device, which works on the readable envelope. The PIN
  // wrap is sealed (PIN_WRAP_SETTINGS).
  'pinSalt',
  'pinHash',
  'pinIterations',
] satisfies ReadonlyArray<keyof UserSettings>);

/**
 * The account's PIN wrap, sealed on every device. The lock's own copy stays
 * only where this device's lock is on, or where it keeps no phrase at rest
 * (syncPinWrap in pinRecovery.ts), so on a device whose lock is off this
 * sealed copy is the only one, and a copy of its files holds no wrap. In the
 * apps the lock's copy is sealed under the device key as well
 * (pinWrapSeal.ts). No reader needs this copy before a key exists: the lock
 * screen opens the lock's own copy, and a locked read is no settings pass.
 * Spec: docs/internal/plans/pin-wrap-hardening.md (section 5.4, C2-2);
 * docs/internal/plans/derived-keys-design.md (section 5.4, stage 2)
 */
const PIN_WRAP_SETTINGS = new Set<string>(['pinWrapSalt', 'pinWrapIV', 'pinWrapCiphertext', 'pinWrapIterations']);


/** Whether a setting goes into the sealed part: every key but the readable
 *  list. A `#` key is sync machinery, never a setting. */
function isSealedSetting(key: string): boolean {
  if (key.startsWith('#')) return false;
  return !READABLE_SETTINGS.has(key);
}

/**
 * The split version this device writes: 3, where the PIN wrap is sealed, so a
 * bundle that knows only 1 and 2 reads the envelope as one from before the
 * split and takes the server copy, never four missing fields as a PIN
 * removed. A browser wrote 2 before stage 2; its readable wrap stands until
 * the next write moves it (userSettings.ts).
 */
export function splitVersionHere(): 3 {
  return 3;
}

type SealedSettings = Record<string, unknown>;

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
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      if (isSealedSetting(k)) own[k] = v;
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
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isSealedSetting(k) && typeof v === 'string') out[k] = v;
  }
  return out;
}

/** The per-key base the readable envelope keeps: none of a sealed setting,
 *  whose fingerprint (a short value's, a guess away from the value) is
 *  sealed with it. */
export function readableBase(base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (!isSealedSetting(k)) out[k] = v;
  return out;
}

/** Seal these settings over the sealed part, with their synced base. False
 *  when no key is registered or the write failed: the sealed part is then as
 *  it was. */
export function writeSealedSettings(
  settings: UserSettings,
  syncedKeys: Record<string, string> | undefined,
  dirty: boolean,
  /** The PIN wrap is unknown here: its fields stay missing, never null. */
  wrapUnknown = false,
): boolean {
  const key = localDataKeyCopy();
  if (!key) return false;
  try {
    const fields = pickSealed(settings);
    if (wrapUnknown) for (const k of PIN_WRAP_SETTINGS) delete fields[k];
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
  const out: SealedSettings = {};
  for (const [k, v] of Object.entries(settings)) if (isSealedSetting(k)) out[k] = v;
  return out;
}

/** The readable part: the readable list alone. */
export function stripSealed(settings: UserSettings): Partial<UserSettings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) if (READABLE_SETTINGS.has(k)) out[k] = v;
  return out as Partial<UserSettings>;
}

// The lists a read hands out while the sealed part is locked. Never values:
// a save that carries one of them was built from such a read (the boot, the
// lock screen, a PIN recovery), so its sealed settings are not the person's
// and the device keeps the ones it holds (userSettings.ts, saveLocalSettings).
// A string or a number cannot carry the mark; the lists beside it always do.
const placeholders = new WeakSet<object>();

/** These settings with every sealed one replaced by a marked default. */
export function withPlaceholders(settings: UserSettings): UserSettings {
  const defaults = defaultSettings() as unknown as Record<string, unknown>;
  const out = { ...settings } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (isSealedSetting(k) && !(k in defaults)) delete out[k];
  for (const k of Object.keys(defaults)) {
    if (!isSealedSetting(k)) continue;
    // A copy, so no default another object shares can ever carry the mark.
    const v: unknown = structuredClone(defaults[k]);
    if (v !== null && typeof v === 'object') placeholders.add(v);
    out[k] = v;
  }
  return out as unknown as UserSettings;
}

/** Whether a settings object came from a read with the sealed part locked. */
export function fromLockedRead(settings: UserSettings): boolean {
  return Object.entries(settings).some(([k, v]) => isSealedSetting(k) && v !== null && typeof v === 'object' && placeholders.has(v));
}
