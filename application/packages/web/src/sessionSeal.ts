/**
 * The stored sign-in session, sealed while the app lock is armed (GitHub
 * #795 point 9).
 *
 * A copy of a locked device's storage held the Supabase session in plain
 * JSON, which can delete or overwrite the account's notes on the server, and
 * on a custodial account without two-factor fetch the phrase. With the lock
 * armed the session is stored sealed (XChaCha20-Poly1305) under a key from
 * the phrase (`deriveSessionSealKey`), so a copy opens it exactly when it
 * opens the phrase. Every door of the lock gives the phrase; nothing else
 * gives the key, which lives in this page's memory only.
 *
 * The sealed copy has its own storage name, `<session name>-sealed`, beside
 * the plain name auth-js reads. trustStorage.ts routes the session name
 * through here: a plain copy is read first (what an older version wrote, and
 * the fail-safe), else the sealed copy opened with a key this page holds,
 * else nothing. Nothing that cannot be opened is ever removed.
 *
 * Writes seal only while `SESSION_SEAL_RELEASED` (dev builds on): a tab of
 * an older bundle reads the plain name only, and would meet "Session
 * expired" once a newer tab seals. This release reads sealed copies and
 * writes none; a later one turns the writes on.
 * Spec: docs/internal/plans/session-under-app-lock.md
 */
import { base64ToBytes, bytesToBase64, decryptBytesAad, deriveSessionSealKey, encryptBytesAad } from '@notes/shared';
import { isDemoMode } from './demo';
import { logAuthEvent } from './authDiag';

// Spec: docs/internal/plans/session-under-app-lock.md (section 2.6, the release switch)
const SESSION_SEAL_RELEASED = false;
const PREFIX = 'pnsess1:';
// A settle or a reseal rewrites a session only when its access token has
// longer than this to live: auth-js refreshes within the last 90 seconds,
// and a rewrite during another tab's refresh would make that tab discard
// its rotated token (its commit check sees the stored copy change).
const SETTLE_MARGIN_S = 300;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

let sessionName: string | null = null;
let armedNow: () => boolean = () => false;
/** The key that seals: the live sign-in's. */
let sealKey: Uint8Array | null = null;
/** Every key this page holds, the sealing one first: a key held for a sign-in
 *  that is not live yet opens, and seals nothing. */
const openers: Uint8Array[] = [];
let unopenedLogged = false;

/** Whether writes seal at all: the release switch, or a dev build. */
export function sessionSealReleased(): boolean {
  return SESSION_SEAL_RELEASED || import.meta.env.DEV === true;
}

/** auth.tsx names the auth library's session key once, at module load. */
export function setSessionStorageName(name: string): void {
  sessionName = name;
}

/** phraseAtRest.ts says whether the app lock is armed (`appLockArmed`). */
export function setSessionSealArmed(armed: () => boolean): void {
  armedNow = armed;
}

export function isSessionName(key: string): boolean {
  return sessionName !== null && key === sessionName;
}

export function sealedName(key: string): string {
  return `${key}-sealed`;
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function aad(key: string): string {
  return `privacynotes-session-v1|${key}`;
}

/** The key of a phrase, or null for a value that is not one. */
export function sessionSealKeyFor(phrase: string): Uint8Array | null {
  try {
    return deriveSessionSealKey(phrase);
  } catch {
    return null;
  }
}

/**
 * A door gave this phrase: its key now opens a sealed session in this page.
 * It seals only once its sign-in goes live (`adoptSessionSeal`), or at once
 * when this page holds no sealing key yet (the unlock, whose phrase the lock
 * screen proved belongs here).
 */
export function holdSessionSeal(phrase: string): void {
  if (isDemoMode()) return;
  const key = sessionSealKeyFor(phrase);
  if (!key) return;
  if (!openers.some((k) => sameKey(k, key))) openers.push(key);
  if (!sealKey) {
    sealKey = key;
    settleStoredSession();
  }
}

/**
 * The sign-in of this phrase went live: its key seals from now on, and a
 * session sealed under the key before it is sealed again under this one.
 */
export function adoptSessionSeal(phrase: string): void {
  if (isDemoMode()) return;
  const key = sessionSealKeyFor(phrase);
  if (!key) return;
  if (!openers.some((k) => sameKey(k, key))) openers.push(key);
  if (sealKey && sameKey(sealKey, key)) return;
  sealKey = key;
  openers.sort((a, b) => (sameKey(a, key) ? -1 : sameKey(b, key) ? 1 : 0));
  settleStoredSession(true);
}

/** The live sign-in ended: no key stays in this page. */
export function dropSessionSeal(): void {
  for (const k of openers) k.fill(0);
  openers.length = 0;
  sealKey = null;
}

/** A copy of the key that seals now, or null: a pass keeps it to find the
 *  copy it wrote, after the page's key may have changed. */
export function sealKeyCopy(): Uint8Array | null {
  return sealKey ? new Uint8Array(sealKey) : null;
}

/** Whether a write of the session should be sealed now. */
export function sealsNow(): boolean {
  return sessionSealReleased() && !isDemoMode() && armedNow();
}

export function hasSealKey(): boolean {
  return sealKey !== null;
}

/** `pnsess1:<nonce>:<ciphertext>` under the sealing key, or null without one. */
export function sealSession(key: string, value: string): string | null {
  if (!sealKey) return null;
  const { ciphertext, nonce } = encryptBytesAad(utf8.encode(value), sealKey, aad(key));
  return `${PREFIX}${bytesToBase64(nonce)}:${bytesToBase64(ciphertext)}`;
}

/** A sealed copy opened with one key, or null. */
export function openSessionWith(key: string, raw: string, with_: Uint8Array): string | null {
  if (!raw.startsWith(PREFIX)) return null;
  const parts = raw.slice(PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  try {
    return fromUtf8.decode(decryptBytesAad(base64ToBytes(parts[1]!), base64ToBytes(parts[0]!), with_, aad(key)));
  } catch {
    return null;
  }
}

/** A sealed copy opened with a key this page holds, or null. */
export function openSession(key: string, raw: string): string | null {
  for (const k of openers) {
    const opened = openSessionWith(key, raw, k);
    if (opened !== null) return opened;
  }
  if (openers.length > 0 && !unopenedLogged) {
    unopenedLogged = true;
    logAuthEvent('storage:session-unseal-failed');
  }
  return null;
}

function farFromExpiry(json: string): boolean {
  try {
    const at = (JSON.parse(json) as { expires_at?: unknown }).expires_at;
    return typeof at === 'number' && at - Date.now() / 1000 > SETTLE_MARGIN_S;
  } catch {
    return false;
  }
}

/** The raw reads and writes the settle needs, set by trustStorage.ts. */
type SessionStore = {
  /** This tab is trusted: only then does the settle touch the shared copy. */
  trusted(): boolean;
  readPlain(key: string): string | null;
  readSealed(key: string): string | null;
  writePlain(key: string, value: string): boolean;
  writeSealed(key: string, value: string): boolean;
  removePlain(key: string): void;
  removeSealed(key: string): void;
};
let store: SessionStore | null = null;

export function setSessionStore(s: SessionStore): void {
  store = s;
}

/**
 * Write the stored session again in the form the rules call for: sealed
 * while the lock is armed and a key is held, plain otherwise. Only when the
 * form differs (or `reseal`, a new sealing key), only far from a refresh, in
 * one synchronous read and write, and never through the MFA write guard (the
 * value is the one already stored). The new copy is written before the old
 * one goes: the two hold the same tokens, so neither is stale. `pageEnds`
 * (the lock reload): the key goes with the page, so a reseal waives the
 * margin (a tab without the key reads the sealed copy as nothing and does
 * not refresh it); the seal of a plain copy keeps it.
 */
export function settleStoredSession(reseal = false, pageEnds = false): void {
  if (!store || !sessionName || !sessionSealReleased() || isDemoMode()) return;
  // A tab that is not trusted keeps its own session in memory; the shared
  // copy is a trusted tab's, and its lock rule reads as off here.
  if (!store.trusted()) return;
  const name = sessionName;
  const plain = store.readPlain(name);
  const sealedRaw = store.readSealed(name);
  if (sealsNow()) {
    if (!sealKey) return;
    if (plain !== null) {
      // The margin holds at the page's end too: a tab without the key that
      // read this plain copy may be refreshing it in the last 90 seconds.
      if (!farFromExpiry(plain)) return;
      const sealed = sealSession(name, plain);
      if (sealed && store.writeSealed(name, sealed)) store.removePlain(name);
      return;
    }
    if (reseal && sealedRaw !== null) {
      const opened = openSession(name, sealedRaw);
      if (opened === null || (!pageEnds && !farFromExpiry(opened))) return;
      const sealed = sealSession(name, opened);
      if (sealed && openSessionWith(name, sealedRaw, sealKey) === null) store.writeSealed(name, sealed);
    }
    return;
  }
  if (plain === null && sealedRaw !== null) {
    const opened = openSession(name, sealedRaw);
    if (opened === null || !farFromExpiry(opened)) return;
    if (store.writePlain(name, opened)) store.removeSealed(name);
  }
}
