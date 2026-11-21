/**
 * The app lock secret, a 4-digit PIN or a longer passcode, gating phrase
 * display and PIN-protected notes.
 *
 * Hash (PBKDF2-SHA256, 600k iterations) stored in UserSettings and synced
 * across devices. The salt is 16 bytes for a PIN and 24 for a passcode, which
 * is how every reader tells the two apart (secretKind.ts). A local cache
 * keeps `hasPin()` synchronous. A legacy hash (100k iterations) still
 * verifies; a check that proves the secret against one holds a hash at
 * today's count in memory, and the next settings pass saves it
 * (`saveHeldPinRehash` in pinRecovery.ts).
 * Spec: docs/internal/plans/pin-wrap-hardening.md (section 3)
 */

import { bytesToBase64, base64ToBytes } from '@notes/shared';
import type { UserSettings } from './userSettings';
import { credentialKey } from './demo';
import { readStringList } from './localStore';
import { normalizeSecret, saltBytesFor, saltIsPasscode } from './secretKind';
import { trustAwareStorage } from './trustStorage';

// Spec: THREAT_MODEL.md (PBKDF2-SHA256 600k iterations per OWASP 2024)
const ITERATIONS = 600_000;
const LEGACY_ITERATIONS = 100_000;
const KEY_BITS = 256;

// The cache mirrors settings so `hasPin()` can be synchronous.
// Demo-bucketed (credentialKey in demo.ts) so a demo session's PIN
// never touches a real account's cache. Trust-aware like the phrase: on a
// device the user did not mark trusted it lives in the tab's memory and goes
// with the page, because the salt and hash of a four-digit PIN
// fall to an offline search in minutes.
// Spec: docs/public/THREAT_MODEL.md (Devices not marked as trusted)
const pinCache = trustAwareStorage;
const CACHE_SALT = credentialKey('privacynotes.pinSalt');
const CACHE_HASH = credentialKey('privacynotes.pinHash');
const CACHE_ITERATIONS = credentialKey('privacynotes.pinIterations');
/** Set when a PIN change made on this device lost to another device's
 *  (userSettings.ts); one account's notice, so bucketed and cleared with the
 *  PIN cache at every account boundary. */
export const PIN_CHANGE_LOST_KEY = credentialKey('privacynotes.pinChangeLost');
/** The cache's keys, for the start purge of what an older version kept in a
 *  tab's sessionStorage (trustStorage.ts). */
export const PIN_CACHE_KEYS: readonly string[] = [CACHE_SALT, CACHE_HASH, CACHE_ITERATIONS];
/** A rehash a check holds until a settings pass saves it (`holdRehash`). */
let heldRehash: HeldPinRehash | null = null;
/** Moves at every change of the cached secret and at every account boundary.
 *  A rehash started under another generation holds nothing, also when an
 *  equal secret was cached again since (`holdRehash`). */
let pinGeneration = 0;
/** A wrap upgrade held the same way (`holdPinWrapUpgrade`). */
let heldWrapUpgrade: HeldPinWrapUpgrade | null = null;
/** Open PIN screens holding a proof (`holdPinSurface`). */
let pinSurfaces = 0;
/** Hashes and wrap ciphertexts this tab saved as upgrades (`recordOwnPinUpgrade`). */
const ownUpgrades = new Set<string>();

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('PIN requires a secure connection (HTTPS). Please access the app over HTTPS.');
  }
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw',
    enc.encode(normalizeSecret(pin)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    material,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

// ── Local cache helpers ──────────────────────────────────────────

function cacheWrite(salt: string | null, hash: string | null, iterations: number | null): void {
  const before = pinCredentialStamp();
  try {
    if (salt && hash) {
      pinCache.setItem(CACHE_SALT, salt);
      pinCache.setItem(CACHE_HASH, hash);
      pinCache.setItem(CACHE_ITERATIONS, String(iterations ?? LEGACY_ITERATIONS));
    } else {
      pinCache.removeItem(CACHE_SALT);
      pinCache.removeItem(CACHE_HASH);
      pinCache.removeItem(CACHE_ITERATIONS);
    }
  } catch { /* storage disabled */ }
  if (pinCredentialStamp() !== before) pinGeneration += 1;
}

/**
 * Sync the local cache from UserSettings. Call after every settings sync.
 * A hash that replaces another one here (the PIN changed on another device)
 * ends this tab's windows, as a change made here does: a window opened with
 * the old PIN does not outlive it. A first fill, onto an empty cache, ends
 * nothing.
 */
export function syncPinCache(settings: UserSettings): void {
  const before = cachedPinCredential();
  cacheWrite(settings.pinSalt, settings.pinHash, settings.pinIterations);
  if (before.pinHash !== null && credentialStamp(before) !== credentialStamp(cachedPinCredential())) {
    clearPinUnlock();
  }
}

/**
 * Wipe every account-scoped PIN artifact on this device: the hash/salt
 * cache, the lockout counters, and the session unlock marker. Called on
 * sign-out and on the pubkey-owner mismatch wipe so PIN state can never
 * survive an account switch.
 *
 * History: a "legacy PIN migration" used to live here. It read the same
 * localStorage keys the cache above writes (they predate synced PINs)
 * and adopted whatever it found into settings whenever settings carried
 * no PIN - which on a shared browser meant a brand-new account inherited
 * the PREVIOUS account's PIN and pushed it into its own synced settings
 * (a cross-account PIN hash leak). The migration is gone; these keys are
 * now cleared at every account boundary instead.
 */
export function clearPinCache(): void {
  pinGeneration += 1;
  heldRehash = null;
  heldWrapUpgrade = null;
  ownUpgrades.clear();
  cacheWrite(null, null, null);
  clearPinFailures();
  clearPinUnlock();
  try {
    localStorage.removeItem(PIN_CHANGE_LOST_KEY);
  } catch {
    /* nothing to clear */
  }
}

// ── Public API ───────────────────────────────────────────────────

/** Synchronous check via the local cache (kept in sync by syncPinCache/stagePinHash). */
export function hasPin(): boolean {
  try {
    return (
      pinCache.getItem(CACHE_HASH) !== null &&
      pinCache.getItem(CACHE_SALT) !== null
    );
  } catch {
    return false;
  }
}

/**
 * True when the account's secret, as this device caches its hash, is a
 * passcode. The PIN tab, the note gate, the phrase gate and the app-lock
 * confirm draw their field from it; the lock screen reads the wrap instead
 * (`pinWrapIsPasscode` in biometric.ts), because that is what it opens.
 */
export function pinIsPasscode(): boolean {
  try {
    return saltIsPasscode(pinCache.getItem(CACHE_SALT));
  } catch {
    return false;
  }
}

/** The salt and hash a check was made against, as the synced settings carry them. */
export type PinCredential = Pick<UserSettings, 'pinSalt' | 'pinHash'>;

/** The cached salt and hash, null when this device caches none. */
export function cachedPinCredential(): PinCredential {
  try {
    return { pinSalt: pinCache.getItem(CACHE_SALT), pinHash: pinCache.getItem(CACHE_HASH) };
  } catch {
    return { pinSalt: null, pinHash: null };
  }
}

/** A credential as one comparable value. */
export function credentialStamp(c: PinCredential): string {
  return `${c.pinSalt ?? ''}:${c.pinHash ?? ''}`;
}

/**
 * The cached hash and salt as one value. A check that starts under one stamp
 * and ends under another answered for a secret the account no longer holds
 * (a sync pass replaced it during the derivation), so its answer opens
 * nothing. Pinned by tests/secretSurfaces.test.ts.
 */
export function pinCredentialStamp(): string {
  return credentialStamp(cachedPinCredential());
}

/** A hash of the secret, as the synced settings carry it. */
export type PinHash = { pinSalt: string; pinHash: string; pinIterations: number };

/**
 * Hash a new secret at today's count, in memory, writing nothing. The salt
 * takes the length the secret's kind records (secretKind.ts).
 */
export async function hashPin(pin: string): Promise<PinHash> {
  const salt = crypto.getRandomValues(new Uint8Array(saltBytesFor(pin)));
  const hash = await derive(pin, salt, ITERATIONS);
  return { pinSalt: bytesToBase64(salt), pinHash: bytesToBase64(hash), pinIterations: ITERATIONS };
}

/**
 * Put a new hash into this device's cache before the settings that carry it
 * are saved, and read it back. Answers null, with the hash it had still in
 * place, when the store refuses it; otherwise a function that puts back the
 * hash it replaced, for a settings save that then does not land (saveCredential
 * in userSettings.ts). The put-back does nothing once another hash was cached
 * here. It writes the keys itself, not through cacheWrite, which swallows a
 * refusal.
 */
export function stagePinHash(h: PinHash): (() => void) | null {
  const keys = [CACHE_SALT, CACHE_HASH, CACHE_ITERATIONS];
  let previous: (string | null)[];
  try {
    previous = keys.map((k) => pinCache.getItem(k));
  } catch {
    return null;
  }
  // Putting the old values back returns the store to a size it already held.
  const putBack = () => { pinGeneration += 1; keys.forEach((k, i) => {
    try {
      const v = previous[i];
      if (v === null || v === undefined) pinCache.removeItem(k);
      else pinCache.setItem(k, v);
    } catch { /* */ }
  }); };
  pinGeneration += 1;
  try {
    pinCache.setItem(CACHE_SALT, h.pinSalt);
    pinCache.setItem(CACHE_HASH, h.pinHash);
    pinCache.setItem(CACHE_ITERATIONS, String(h.pinIterations));
    if (pinCache.getItem(CACHE_SALT) !== h.pinSalt || pinCache.getItem(CACHE_HASH) !== h.pinHash) {
      throw new Error('read-back');
    }
  } catch {
    putBack();
    return null;
  }
  return () => {
    try {
      if (pinCache.getItem(CACHE_HASH) === h.pinHash) putBack();
    } catch { /* */ }
  };
}

/** Remove the PIN from settings and clear unlock state. Caller must persist + sync. */
export function clearPinFromSettings(settings: UserSettings): UserSettings {
  heldRehash = null;
  heldWrapUpgrade = null;
  cacheWrite(null, null, null);
  clearPinUnlock();
  return { ...settings, pinSalt: null, pinHash: null, pinIterations: null };
}

/** A wrap is salt, IV and ciphertext together, the triple syncPinWrap tests. */
export function hasPinWrap(
  s: Pick<UserSettings, 'pinWrapSalt' | 'pinWrapIV' | 'pinWrapCiphertext'>,
): boolean {
  return (
    typeof s.pinWrapSalt === 'string' &&
    typeof s.pinWrapIV === 'string' &&
    typeof s.pinWrapCiphertext === 'string'
  );
}

/**
 * Whether a PIN change must carry a new wrap of the phrase in the same
 * write. The wrap follows the hash: both live in the synced settings and
 * must describe the same PIN, so whenever the account holds a wrap, or the
 * app lock is on and will need one, the device that changes the PIN re-wraps
 * under the new PIN. A PIN-only account, with no lock and no wrap, never
 * gains one: a wrap is a durable copy of the phrase under four digits, and
 * only a lock to open justifies it. Pinned by tests/pinChange.test.ts.
 */
export function pinChangeNeedsWrap(
  settings: Pick<UserSettings, 'appLockEnabled' | 'pinWrapSalt' | 'pinWrapIV' | 'pinWrapCiphertext'>,
): boolean {
  return settings.appLockEnabled || hasPinWrap(settings);
}

/**
 * A hash of the secret at today's count, made after a check proved the secret
 * against a legacy hash, and the legacy hash it replaces. Held in memory, never
 * written here: a rehash saved before the device has read the server row
 * would go out as a change made here, beside a newer secret another device set
 * (QA-47). The next settings pass that read the row saves it, and only over
 * the exact hash it was proven against (`saveHeldPinRehash` in pinRecovery.ts).
 */
export type HeldPinRehash = { from: PinCredential; to: PinHash };

async function holdRehash(pin: string, from: PinCredential, generation: number): Promise<void> {
  // The salt follows the secret's kind (`saltBytesFor`), the derivation is
  // the one verifyPin runs, so the new hash opens with the same secret.
  const to = await hashPin(pin);
  // A secret replaced during the derivation answers for nothing.
  if (generation !== pinGeneration || pinCredentialStamp() !== credentialStamp(from)) return;
  heldRehash = { from, to };
}

/** The held rehash, once: whoever takes it saves it or drops it. */
export function takeHeldPinRehash(): HeldPinRehash | null {
  const held = heldRehash;
  heldRehash = null;
  return held;
}

/**
 * A legacy wrap the lock screen re-wrapped at today's count, and the wrap it
 * replaced. Held like the hash, and saved with it, for the same reason: a
 * write before the first pull went out as a change made here, and a cache
 * with no merge base pushed it over a newer secret.
 */
export type HeldPinWrapUpgrade = {
  blob: { pinWrapSalt: string; pinWrapIV: string; pinWrapCiphertext: string; pinWrapIterations: number };
  replaced: { pinWrapSalt: string; pinWrapCiphertext: string };
};
export function holdPinWrapUpgrade(upgrade: HeldPinWrapUpgrade): void {
  heldWrapUpgrade = upgrade;
}

export function takeHeldPinWrapUpgrade(): HeldPinWrapUpgrade | null {
  const held = heldWrapUpgrade;
  heldWrapUpgrade = null;
  return held;
}

/**
 * The PIN screens that hold a proof of the secret (the PIN tab, the phrase
 * gate, the app-lock confirm) read a new hash as a secret changed elsewhere
 * and ask again. While one is open a held rehash waits for a later pass.
 */
/** Called when such a screen mounts; the answer is called when it goes. */
export function holdPinSurface(): () => void {
  pinSurfaces += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pinSurfaces -= 1;
  };
}

export function pinSurfaceOpen(): boolean {
  return pinSurfaces > 0;
}

/**
 * The PIN group this tab saved as an upgrade of the same secret, by hash and
 * by wrap. The push tells it apart from a PIN change made here: when it loses
 * to another device's group it is not a change the person made, and no
 * "change not saved" notice follows (`perKeyMerge` in userSettings.ts).
 */
export function recordOwnPinUpgrade(value: string): void {
  ownUpgrades.add(value);
}

export function isOwnPinUpgrade(group: { pinHash?: string | null; pinWrapCiphertext?: string | null }): boolean {
  return (!!group.pinHash && ownUpgrades.has(group.pinHash)) || (!!group.pinWrapCiphertext && ownUpgrades.has(group.pinWrapCiphertext));
}

/** Whether this device's cached hash is at the older count. */
export function pinHashIsLegacy(): boolean {
  try {
    if (pinCache.getItem(CACHE_HASH) === null) return false;
    const iterations = pinCache.getItem(CACHE_ITERATIONS);
    return (iterations ? Number(iterations) : LEGACY_ITERATIONS) < ITERATIONS;
  } catch {
    return false;
  }
}

/**
 * Verify a candidate PIN. Returns `{ valid, needsRehash }`. `needsRehash` is
 * true for a valid PIN under a hash at the older count; the check then holds a
 * new hash in the background (`holdRehash`), so every caller upgrades it.
 * Spec: docs/internal/plans/pin-wrap-hardening.md (section 3)
 */
export async function verifyPin(pin: string): Promise<{ valid: boolean; needsRehash: boolean }> {
  let saltB64: string | null;
  let hashB64: string | null;
  let iterStr: string | null;
  const generation = pinGeneration;
  try {
    saltB64 = pinCache.getItem(CACHE_SALT);
    hashB64 = pinCache.getItem(CACHE_HASH);
    iterStr = pinCache.getItem(CACHE_ITERATIONS);
  } catch {
    return { valid: false, needsRehash: false };
  }
  if (!saltB64 || !hashB64) return { valid: false, needsRehash: false };

  const storedIterations = iterStr ? Number(iterStr) : LEGACY_ITERATIONS;
  const salt = base64ToBytes(saltB64);
  const expected = base64ToBytes(hashB64);

  const proven: PinCredential = { pinSalt: saltB64, pinHash: hashB64 };
  // Try the stored iteration count first.
  if (constantTimeEqual(await derive(pin, salt, storedIterations), expected)) {
    if (storedIterations < ITERATIONS) void holdRehash(pin, proven, generation).catch(() => { /* the next check tries again */ });
    return { valid: true, needsRehash: storedIterations < ITERATIONS };
  }

  // Auto-recovery: if the cache has the wrong iteration count (e.g.
  // syncPinCache wrote the legacy fallback because pinIterations was
  // null in the synced settings blob), retry with the other known
  // count. Fixes the cache on success so subsequent verifies are fast.
  const altIterations = storedIterations === ITERATIONS ? LEGACY_ITERATIONS : ITERATIONS;
  if (constantTimeEqual(await derive(pin, salt, altIterations), expected)) {
    // Fix the stale cache so this only costs one extra derive once.
    try { pinCache.setItem(CACHE_ITERATIONS, String(altIterations)); } catch { /* */ }
    if (altIterations < ITERATIONS) void holdRehash(pin, proven, generation).catch(() => { /* the next check tries again */ });
    return { valid: true, needsRehash: altIterations < ITERATIONS };
  }

  return { valid: false, needsRehash: false };
}

/** Constant-time comparison of two equal-length byte arrays. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

// Brute-force protection - exponential backoff on failed attempts.
// localStorage-backed (not sessionStorage) so tab close doesn't reset it.
// UX gate only: offline PBKDF2 brute-force bypasses this entirely.

const MAX_ATTEMPTS = 5;
const BASE_LOCKOUT_SECONDS = 30;
// The wait stops doubling at one hour. Anyone at the device can run the count
// up, and a person who cannot get past the wait may have no other way in; at
// one try an hour the 10,000 PINs still take more than a year.
// Spec: docs/public/THREAT_MODEL.md (PIN lockout)
const MAX_LOCKOUT_SECONDS = 3600;
const LOCKOUT_ATTEMPTS_KEY = credentialKey('privacynotes.pinFailCount');
const LOCKOUT_UNTIL_KEY = credentialKey('privacynotes.pinLockedUntil');

/** Record a failed PIN attempt. Returns the lockout state. */
export function recordPinFailure(): { locked: boolean; secondsLeft: number; attempts: number } {
  try {
    const count = Number(localStorage.getItem(LOCKOUT_ATTEMPTS_KEY) || '0') + 1;
    localStorage.setItem(LOCKOUT_ATTEMPTS_KEY, String(count));
    if (count >= MAX_ATTEMPTS) {
      // Exponential backoff: 30s, 60s, 120s, 240s... up to one hour.
      const lockoutMs = Math.min(BASE_LOCKOUT_SECONDS * Math.pow(2, count - MAX_ATTEMPTS), MAX_LOCKOUT_SECONDS) * 1000;
      const until = Date.now() + lockoutMs;
      localStorage.setItem(LOCKOUT_UNTIL_KEY, String(until));
      return { locked: true, secondsLeft: Math.ceil(lockoutMs / 1000), attempts: count };
    }
    return { locked: false, secondsLeft: 0, attempts: count };
  } catch {
    return { locked: false, secondsLeft: 0, attempts: 0 };
  }
}

/** Clear failure count on successful verify. */
export function clearPinFailures(): void {
  try {
    localStorage.removeItem(LOCKOUT_ATTEMPTS_KEY);
    localStorage.removeItem(LOCKOUT_UNTIL_KEY);
  } catch { /* ignore */ }
}

/** Returns current lockout state `{ locked, secondsLeft, attempts }`. */
export function getPinLockoutState(): { locked: boolean; secondsLeft: number; attempts: number } {
  try {
    const attempts = Number(localStorage.getItem(LOCKOUT_ATTEMPTS_KEY) || '0');
    const until = Number(localStorage.getItem(LOCKOUT_UNTIL_KEY) || '0');
    if (until > Date.now()) {
      // A wait stored before the cap, or a clock set back, still ends within the cap.
      const secondsLeft = Math.min(Math.ceil((until - Date.now()) / 1000), MAX_LOCKOUT_SECONDS);
      return { locked: true, secondsLeft, attempts };
    }
    // Lockout expired - keep the attempt count so the next failure
    // escalates the backoff further.
    return { locked: false, secondsLeft: 0, attempts };
  } catch {
    return { locked: false, secondsLeft: 0, attempts: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────
// Session-level unlock memory
// ─────────────────────────────────────────────────────────────────

// sessionStorage-backed: closed tab always re-locks, never synced.
//
// Two stamps, because the app lock and the PIN gate guard different things.
// The app lock keeps a stranger out of the device; the PIN gate keeps a
// protected note shut while somebody else can see the screen. An app unlock
// therefore opens the app and nothing behind the PIN gate (issue #538). A PIN
// entered at the gate proves the person is at the device, so it refreshes
// both.
const UNLOCKED_KEY = credentialKey('privacynotes.pinUnlockedAt');
const APP_UNLOCKED_KEY = credentialKey('privacynotes.appUnlockedAt');
// The time to ask again that this tab last measured its PIN window with. The
// stamp of an unlock is this tab's alone, while the setting is shared by
// every tab of the browser and can change with no call in this one (another
// tab, a sync pass). Kept beside the stamp so the tab knows which time its
// window was running on when it meets a new one. See `settlePinWindow`.
const WINDOW_MINUTES_KEY = credentialKey('privacynotes.pinWindowMinutes');

function stamp(keys: string[]): void {
  try {
    const now = String(Date.now());
    for (const key of keys) sessionStorage.setItem(key, now);
  } catch {
    /* private mode / storage off - user will be re-prompted, which is
       the safe default */
  }
}

/** The PIN gate opened: protected notes, the phrase view and the app lock. */
export function markPinUnlocked(): void {
  stamp([UNLOCKED_KEY, APP_UNLOCKED_KEY]);
}

/** The app lock screen opened. Protected notes stay shut. */
export function markAppUnlocked(): void {
  stamp([APP_UNLOCKED_KEY]);
}

/**
 * "Lock" on one protected note (#723). The PIN window stays open for every
 * other protected note and the phrase view; this note alone asks again,
 * until the PIN opens it. Kept in sessionStorage beside the window's stamp,
 * so a reload keeps it shut and closing the tab forgets it.
 */
const RELOCKED_KEY = credentialKey('privacynotes.relockedNotes');

const readRelocked = () => readStringList(RELOCKED_KEY, 'session');

function writeRelocked(ids: string[]): void {
  try {
    if (ids.length) sessionStorage.setItem(RELOCKED_KEY, JSON.stringify(ids));
    else sessionStorage.removeItem(RELOCKED_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The notes of that list shut by a fresh protect or as the copy of a guarded
 * note (`gateUntilUnlock`), not by Lock. Any unlock opens these
 * (`openFreshGates`), where a note shut with Lock waits for its own gate.
 * Kept in sessionStorage like the list, so a reload keeps them shut (RFS #215).
 */
const FRESH_GATES_KEY = credentialKey('privacynotes.freshGatedNotes');

const readFreshGates = () => readStringList(FRESH_GATES_KEY, 'session');

function writeFreshGates(ids: string[]): void {
  try {
    if (ids.length) sessionStorage.setItem(FRESH_GATES_KEY, JSON.stringify(ids));
    else sessionStorage.removeItem(FRESH_GATES_KEY);
  } catch {
    /* ignore */
  }
}

function addRelocked(id: string): void {
  const ids = readRelocked();
  if (!ids.includes(id)) writeRelocked([...ids, id]);
}

/** Shut this one note now, whatever the window says. */
export function relockNote(id: string): void {
  addRelocked(id);
  // Lock wins over a fresh gate: only this note's own gate opens it now.
  const fresh = readFreshGates();
  if (fresh.includes(id)) writeFreshGates(fresh.filter((x) => x !== id));
}

/**
 * Shut a note until the next unlock, whatever the window says: a note just
 * protected, or the copy of a note the PIN guards right now.
 */
export function gateUntilUnlock(id: string): void {
  const wasLocked = readRelocked().includes(id) && !readFreshGates().includes(id);
  addRelocked(id);
  if (wasLocked) return;
  const fresh = readFreshGates();
  if (!fresh.includes(id)) writeFreshGates([...fresh, id]);
}

/** An unlock: the notes `gateUntilUnlock` shut follow the window again. */
export function openFreshGates(): void {
  const fresh = readFreshGates();
  if (!fresh.length) return;
  writeRelocked(readRelocked().filter((x) => !fresh.includes(x)));
  writeFreshGates([]);
}

/** The note was shut with Lock and the PIN has not opened it since. */
export function isNoteRelocked(id: string): boolean {
  return readRelocked().includes(id);
}

/** The PIN opened this note: it follows the shared window again. */
export function clearNoteRelock(id: string): void {
  writeRelocked(readRelocked().filter((x) => x !== id));
  const fresh = readFreshGates();
  if (fresh.includes(id)) writeFreshGates(fresh.filter((x) => x !== id));
}

/**
 * "Lock now" on a protected section: the twin of `relockNote` for a whole
 * section. A fresh protect also lands here, so the switch shuts the section
 * at once. Spec: docs/internal/specs/section-lock.md (decision S9)
 */
const RELOCKED_VIEWS_KEY = credentialKey('privacynotes.relockedViews');

const readRelockedViews = () => readStringList(RELOCKED_VIEWS_KEY, 'session');

export function relockView(view: string): void {
  const views = readRelockedViews();
  if (views.includes(view)) return;
  try {
    sessionStorage.setItem(RELOCKED_VIEWS_KEY, JSON.stringify([...views, view]));
  } catch {
    /* ignore */
  }
}

export function isViewRelocked(view: string): boolean {
  return readRelockedViews().includes(view);
}

/** The section's own gate opened it: it follows the shared window again. */
export function clearViewRelock(view: string): void {
  const views = readRelockedViews().filter((v) => v !== view);
  try {
    if (views.length) sessionStorage.setItem(RELOCKED_VIEWS_KEY, JSON.stringify(views));
    else sessionStorage.removeItem(RELOCKED_VIEWS_KEY);
  } catch {
    /* ignore */
  }
}

/** End both windows: the app locked, or the PIN changed hands. */
export function clearPinUnlock(): void {
  try {
    sessionStorage.removeItem(UNLOCKED_KEY);
    sessionStorage.removeItem(APP_UNLOCKED_KEY);
    sessionStorage.removeItem(WINDOW_MINUTES_KEY);
    sessionStorage.removeItem(RELOCKED_KEY);
    sessionStorage.removeItem(FRESH_GATES_KEY);
    sessionStorage.removeItem(RELOCKED_VIEWS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Whether the window on this stamp has run out. A window found run out loses
 * its stamp, so a clock set back afterwards opens nothing, and a stamp later
 * than now (the clock was set back since the unlock) counts as run out.
 */
function windowExpired(key: string, timeoutMinutes: number): boolean {
  if (timeoutMinutes === 0) return true;
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(key);
  } catch {
    return true;
  }
  if (!raw) return true;
  const last = Number(raw);
  const now = Date.now();
  const open = Number.isFinite(last) && last <= now && (timeoutMinutes < 0 || now - last <= timeoutMinutes * 60_000);
  if (open) return false;
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * The first time this tab is asked with another time than the one its window
 * was running on, a window that had run out on that time is ended: its stamp
 * is removed, so no time chosen later opens it again, only the PIN does. A
 * window that is still open stays open and runs on the new time. This is the
 * rule of `endExpiredPinWindow`, applied where the time is read, because the
 * time can change without this tab writing it.
 */
function settlePinWindow(timeoutMinutes: number): void {
  const next = String(timeoutMinutes);
  try {
    const seen = sessionStorage.getItem(WINDOW_MINUTES_KEY);
    if (seen === next) return;
    if (seen !== null) {
      const before = Number(seen);
      if (!Number.isFinite(before) || windowExpired(UNLOCKED_KEY, before)) sessionStorage.removeItem(UNLOCKED_KEY);
    }
    sessionStorage.setItem(WINDOW_MINUTES_KEY, next);
  } catch {
    /* storage off: windowExpired answers true, which is the safe side */
  }
}

/**
 * Returns true if the user should be re-prompted for PIN.
 * `timeoutMinutes`: 0 = always ask, -1 = never (this session), >0 = the window.
 *
 * The window is measured from the stamp `markPinUnlocked` writes. An unlock
 * writes it; so does input inside an open protected note, which is what makes
 * the window an idle one rather than a countdown (see `pinKeepAlive.ts`).
 *
 * Every reader of the window comes through here, so a change of the time is
 * settled here too, in whichever tab reads it (`settlePinWindow`).
 */
export function shouldPromptForPin(timeoutMinutes: number): boolean {
  settlePinWindow(timeoutMinutes);
  return windowExpired(UNLOCKED_KEY, timeoutMinutes);
}

/**
 * Called before the time to ask again changes, with the present time. A
 * window that has run out stays run out whatever time is chosen next: its
 * stamp is removed, since the stamp of an unlock outlives its window. A
 * window that is still open stays open and runs on the new time.
 */
export function endExpiredPinWindow(timeoutMinutes: number): void {
  if (!shouldPromptForPin(timeoutMinutes)) return;
  try {
    sessionStorage.removeItem(UNLOCKED_KEY);
  } catch {
    /* ignore */
  }
}

/** The same rule for the app lock screen, over its own stamp. */
export function shouldPromptForAppLock(timeoutMinutes: number): boolean {
  return windowExpired(APP_UNLOCKED_KEY, timeoutMinutes);
}
