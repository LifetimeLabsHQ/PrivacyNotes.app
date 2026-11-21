import { bytesToHex, entropyToPhrase, hexToBytes, isValidPhrase, phraseToEntropy } from '@notes/shared';
import { APP_ORIGIN, isApexHost } from './hosts';

/**
 * The sign-in QR.
 *
 * 1. PhraseView (Settings > Security > Phrase, the phrase change) and the
 *    new phrase screen draw a QR of `buildSignInCode(phrase)`: `PNQR1-`
 *    and the phrase's BIP-39 entropy in upper-case hex. It is no link, so a
 *    phone's camera app has nothing to open, and no scheme, so no installed
 *    app can claim it. The browser keeps every address it opens in its
 *    history, which can sync; a link QR put the phrase there.
 *
 * 2. The new device reads it with "Scan QR with camera" or an uploaded
 *    image (`extractPhraseFromScan`), which also reads every older QR: a
 *    link with `#phrase=` on any host, and the bare words.
 *
 * 3. A page that opens with a `#phrase=` fragment (an old QR through a
 *    camera app) no longer signs in. `dropPhraseFragment` clears it and
 *    App.tsx tells the person what the browser kept. The phrase is in the
 *    browser history before any of this code runs, so accepting the link
 *    undoes nothing, and a link from a stranger could sign a device in.
 *
 * Spec: docs/internal/plans/qr-signin-content.md
 */

const CODE_PREFIX = 'PNQR1-';
// 12, 15, 18, 21 or 24 words: 16 to 32 bytes of entropy in 4-byte steps.
const CODE_RE = /^PNQR1-((?:[0-9A-F]{8}){4,8})$/;

/** The content of the sign-in QR for a valid phrase. */
export function buildSignInCode(phrase: string): string {
  const words = phrase.trim().replace(/\s+/g, ' ');
  return CODE_PREFIX + bytesToHex(phraseToEntropy(words)).toUpperCase();
}

/** True when a fragment carries a phrase the way the old prompt read one. */
function hasPhraseFragment(hash: string): boolean {
  return hash.includes('phrase=');
}

/** The phrase a `#phrase=` fragment holds, or null. */
function phraseOfFragment(hash: string): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('phrase');
  if (!raw) return null;
  // Tolerate `+`, `%20` and double spaces.
  const phrase = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return isValidPhrase(phrase) ? phrase : null;
}

/**
 * Clears a `#phrase=` fragment from the address bar and answers true when it
 * held a valid phrase, so App.tsx can say what the browser history kept. It
 * never returns the phrase: the link does not sign in. A fragment without a
 * valid phrase is cleared too and answers false, so a `#phrase=x` link from
 * anyone shows nothing. Safe to call on every mount.
 */
export function dropPhraseFragment(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash;
  if (!hasPhraseFragment(hash)) return false;
  // Some sandboxed web views block replaceState. Leaving the phrase in the
  // address bar (and the Referer of a link click) is worse than a reload.
  const cleanUrl = window.location.pathname + window.location.search;
  try {
    history.replaceState(null, '', cleanUrl || '/');
  } catch {
    window.location.replace(cleanUrl || '/');
    return false;
  }
  return phraseOfFragment(hash) !== null;
}

/**
 * The apex never signs in from a phrase fragment and never passes one on:
 * sessions live on the app host, and the browser keeps any URL it visits,
 * so a forwarded phrase would be written into its history a second time.
 * The fragment is cleared and the page leaves for the app host's sign-in
 * screen with no fragment. Returns true when it is leaving, so the caller
 * renders nothing.
 */
export function dropApexPhraseFragment(): boolean {
  if (typeof window === 'undefined' || !isApexHost()) return false;
  if (!hasPhraseFragment(window.location.hash)) return false;
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    /* the navigation below replaces this entry anyway */
  }
  window.location.replace(`${APP_ORIGIN}/`);
  return true;
}

/**
 * The phrase in what the in-app scanner decoded, or null. Reads, in order:
 *   - `PNQR1-<hex entropy>`, the QR of `buildSignInCode`.
 *   - An http(s) link with a `#phrase=` fragment, on any host: every QR
 *     saved before the new code. People keep paper QRs for years.
 *   - The bare words, the oldest QRs.
 */
export function extractPhraseFromScan(decoded: string): string | null {
  if (!decoded) return null;
  const trimmed = decoded.trim();

  const code = CODE_RE.exec(trimmed);
  if (code?.[1]) return entropyToPhrase(hexToBytes(code[1]));

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const hash = new URL(trimmed).hash;
      if (hasPhraseFragment(hash)) {
        const phrase = phraseOfFragment(hash);
        if (phrase) return phrase;
      }
    } catch {
      /* not a parseable URL - fall through to the bare words */
    }
  }

  const phrase = trimmed.toLowerCase().replace(/\s+/g, ' ');
  return isValidPhrase(phrase) ? phrase : null;
}
