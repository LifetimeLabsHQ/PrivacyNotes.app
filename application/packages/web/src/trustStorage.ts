/**
 * Trust-aware storage wrapper.
 *
 * Trusted devices store secrets in localStorage (persisted across restarts).
 * A tab that is not trusted keeps them in this page's memory (`tabSecrets`):
 * never sessionStorage, which a browser can write to its session-restore
 * files, so a reload or a closed tab asks for the phrase again.
 * Shaped like the browser Storage interface for supabase-js auth.storage.
 * Spec: docs/internal/plans/untrusted-device-memory.md (section 2.1)
 */

import { logAuthEvent } from './authDiag';
import { isDemoMode } from './demo';
import { assertSessionWrite } from './sessionWriteGuard';
import {
  hasSealKey,
  isSessionName,
  openSession,
  sealedName,
  sealSession,
  sealsNow,
  setSessionStore,
} from './sessionSeal';

const TRUST_KEY = 'privacynotes.trusted';
// This tab's own answer (beta #210). The shared flag is one key for the whole
// browser, so a click in a second tab moved the first tab's PIN wrap and
// session to disk. A tab takes its answer once, at its first read or from its
// own sign-in, and keeps it in its own sessionStorage, which a reload keeps.
const TAB_TRUST_KEY = 'privacynotes.tabTrusted';

/** Defaults to untrusted when unset (safe for shared/public machines). */
export function isTrustedDevice(): boolean {
  try {
    const own = sessionStorage.getItem(TAB_TRUST_KEY);
    if (own === '1' || own === '0') return own === '1';
  } catch {
    /* no sessionStorage: the shared flag alone */
  }
  let shared = false;
  try {
    shared = localStorage.getItem(TRUST_KEY) === '1';
  } catch {
    return false;
  }
  setTabTrust(shared);
  return shared;
}

/**
 * The browser's flag for a sign-in that keeps its secrets in memory, and
 * whose database the next start may remove (untrustedLeftover.ts). An older
 * version writes '0' for an untrusted sign-in and keeps its secrets in
 * sessionStorage, where the wipe cannot see them, so '0' never wipes. Any
 * value but '1' reads as untrusted, in every version.
 */
export const UNTRUSTED_IN_MEMORY = '0m';

/** The trust answer of this tab and of the browser: a sign-in this tab made. */
export function setTrustedDevice(trusted: boolean): void {
  setTabTrust(trusted);
  try {
    localStorage.setItem(TRUST_KEY, trusted ? '1' : UNTRUSTED_IN_MEMORY);
  } catch {
    /* storage unavailable - nothing to persist, caller still gets in-memory session */
  }
}

/**
 * The trust answer of this tab alone. A provider sign-in sets it at the click
 * (its code verifier must outlive the redirect), and the browser's flag only
 * once its return is accepted (`hydrateFromOAuthSession`).
 */
export function setTabTrust(trusted: boolean): void {
  try {
    sessionStorage.setItem(TAB_TRUST_KEY, trusted ? '1' : '0');
  } catch {
    /* no sessionStorage */
  }
}


// The secrets of a tab that is not trusted, in this page's memory.
const tabMemory = new Map<string, string>();

function dropOlderTabCopy(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* no sessionStorage */
  }
}

/**
 * This tab's own copy of a secret. Outside the demo it is the page's memory
 * only; a copy an older version left in sessionStorage is never read (it
 * would sign a restored tab back in) and goes at the next write or removal
 * of its key, and at start (`purgeOlderTabCopies`). The demo keeps
 * sessionStorage: it runs untrusted on purpose and keeps its PIN and lock
 * across a refresh, with no real secret.
 */
export const tabSecrets: Storage = {
  get length(): number {
    if (isDemoMode()) {
      try { return sessionStorage.length; } catch { return 0; }
    }
    return tabMemory.size;
  },
  clear(): void {
    if (isDemoMode()) {
      try { sessionStorage.clear(); } catch { /* no sessionStorage */ }
      return;
    }
    tabMemory.clear();
  },
  key(index: number): string | null {
    if (isDemoMode()) {
      try { return sessionStorage.key(index); } catch { return null; }
    }
    return [...tabMemory.keys()][index] ?? null;
  },
  getItem(key: string): string | null {
    if (isDemoMode()) {
      try { return sessionStorage.getItem(key); } catch { return null; }
    }
    return tabMemory.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    if (isDemoMode()) {
      sessionStorage.setItem(key, value);
      return;
    }
    tabMemory.set(key, String(value));
    dropOlderTabCopy(key);
  },
  removeItem(key: string): void {
    if (!isDemoMode()) tabMemory.delete(key);
    dropOlderTabCopy(key);
  },
};

/**
 * At start: remove from sessionStorage the secrets an older version kept
 * there for a tab that was not trusted (the auth library's `sb-` keys and
 * the keys named), so the browser's next session-restore files no longer
 * hold them. Nothing reads them any more; this is for the disk.
 */
export function purgeOlderTabCopies(keys: readonly string[]): void {
  if (isDemoMode()) return;
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith('sb-') || keys.includes(k))) sessionStorage.removeItem(k);
    }
  } catch {
    /* no sessionStorage */
  }
}

/** Test seam: empty this page's tab secrets. */
export function forgetTabSecrets(): void {
  tabMemory.clear();
}

// The auth library's own keys (the `sb-` prefix) while the demo runs.
// `?demo=1` runs on the same origin as a real install, and the demo holds
// no server session, so a client reading the shared stores would adopt the
// real account's session and refresh it over the network. In the demo those
// keys live here instead: the client starts with nothing, and the real
// session is never read, rotated or removed from a demo tab.
const demoAuthKeys = new Map<string, string>();

function isDemoAuthKey(key: string): boolean {
  return key.startsWith('sb-') && isDemoMode();
}

/** Storage-API-compatible object that supabase-js can consume directly. */
export const trustAwareStorage: Storage = {
  get length(): number {
    try {
      return tabSecrets.length + localStorage.length;
    } catch {
      return 0;
    }
  },
  clear(): void {
    if (isDemoMode()) {
      demoAuthKeys.clear();
      return;
    }
    // Scoped to the auth library's own keys (sb-*) on purpose. This
    // object is handed to supabase-js as its Storage backing; a literal
    // clear() would also destroy the phrase, the wrapped-phrase blobs
    // and the device secret - a total credential wipe from one future
    // library-internal call. Nothing calls this today (it exists to
    // satisfy the Storage interface), which is exactly when to defuse
    // it. sessionStorage is swept too, for a copy an older version left.
    for (const store of [tabSecrets, sessionStorage, localStorage]) {
      try {
        for (let i = store.length - 1; i >= 0; i--) {
          const k = store.key(i);
          if (k && k.startsWith('sb-')) store.removeItem(k);
        }
      } catch {
        /* ignore */
      }
    }
  },
  key(index: number): string | null {
    try {
      if (index < tabSecrets.length) return tabSecrets.key(index);
      return localStorage.key(index - tabSecrets.length);
    } catch {
      return null;
    }
  },
  getItem(key: string): string | null {
    if (isDemoAuthKey(key)) return demoAuthKeys.get(key) ?? null;
    const plain = readEither(key);
    if (plain !== null || !isSessionName(key)) return plain;
    // The session sealed under the app lock (sessionSeal.ts): opened with a
    // key this page holds, else nothing, and nothing is removed.
    const sealed = readEither(sealedName(key));
    return sealed === null ? null : openSession(key, sealed);
  },
  setItem(key: string, value: string): void {
    // MFA verification may finish after sign-out or an account switch. The
    // SDK saves its result before notifying the app, so reject stale writes
    // here, outside the quota-error catch and before removing either copy.
    if (key.startsWith('sb-')) {
      const current = trustAwareStorage.getItem(key);
      assertSessionWrite(key, current, value);
    }
    if (isDemoAuthKey(key)) {
      demoAuthKeys.set(key, value);
      return;
    }
    const trusted = isTrustedDevice();
    if (isSessionName(key)) {
      // Spec: docs/internal/plans/session-under-app-lock.md (section 2.2)
      // A tab that is not trusted keeps its session in memory and never seals.
      const sealing = trusted && sealsNow();
      const sealed = sealing ? sealSession(key, value) : null;
      if (sealed !== null) {
        // Both older copies die first, in every store: a sealed write that
        // then fails leaves no copy, never a stale one beside a fresh one.
        removeEverywhere(key);
        removeEverywhere(sealedName(key));
        if (writeOne(trusted, sealedName(key), sealed)) return;
        logAuthEvent('storage:session-seal-failed');
      } else {
        if (sealing && !hasSealKey()) logAuthEvent('storage:session-seal-no-key');
        removeEverywhere(sealedName(key));
      }
    }
    // The sibling-store copy dies FIRST, in its own try. The old shape
    // (set, then remove, one try) had a poisonous failure mode: when
    // the set threw on quota, the remove never ran, the STALE copy
    // survived in the other store, and getItem - which prefers the
    // tab's copy - kept serving an already-rotated refresh token
    // until GoTrue's reuse detection revoked the whole session family.
    // A dropped write now leaves NO copy (recoverable: the phrase
    // re-mints a session) instead of a stale one (a manufactured
    // server-side revocation).
    const sibling = trusted ? tabSecrets : localStorage;
    try {
      sibling.removeItem(key);
    } catch {
      /* ignore */
    }
    try {
      (trusted ? localStorage : tabSecrets).setItem(key, value);
    } catch {
      // Quota exceeded or storage disabled. The write is lost and the
      // caller cannot tell - leave the one trace that makes this
      // debuggable when a session or phrase later comes up missing.
      logAuthEvent('storage:setItem-dropped', { key });
    }
  },
  removeItem(key: string): void {
    if (isDemoAuthKey(key)) {
      demoAuthKeys.delete(key);
      return;
    }
    removeEverywhere(key);
    if (isSessionName(key)) removeEverywhere(sealedName(key));
  },
};

function readEither(key: string): string | null {
  try {
    const s = tabSecrets.getItem(key);
    if (s != null) return s;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeEverywhere(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    tabSecrets.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** One write to the store this tab's trust picks; false when it is refused. */
function writeOne(trusted: boolean, key: string, value: string): boolean {
  try {
    (trusted ? localStorage : tabSecrets).setItem(key, value);
    return true;
  } catch {
    logAuthEvent('storage:setItem-dropped', { key });
    return false;
  }
}

// The settle of sessionSeal.ts writes in the same stores, and never through
// the MFA write guard: it writes the value already stored.
setSessionStore({
  trusted: isTrustedDevice,
  readPlain: readEither,
  readSealed: (key) => readEither(sealedName(key)),
  writePlain: (key, value) => writeOne(isTrustedDevice(), key, value),
  writeSealed: (key, value) => {
    // The other store's sealed copy goes first: a read prefers the tab's.
    const trusted = isTrustedDevice();
    try {
      (trusted ? tabSecrets : localStorage).removeItem(sealedName(key));
    } catch {
      /* ignore */
    }
    return writeOne(trusted, sealedName(key), value);
  },
  removePlain: removeEverywhere,
  removeSealed: (key) => removeEverywhere(sealedName(key)),
});
