/**
 * This device's phrase was replaced: the account changed its recovery phrase
 * elsewhere, and this device still holds an earlier one.
 *
 * Four server answers say so, and each one is read where it arrives:
 * - a write the key-epoch gate refused (`key_epoch_gate_ok` raises
 *   `phrase_replaced` with PT403): the notes push in sync.ts and the settings
 *   push in userSettings.ts;
 * - the heartbeat answering `'phrase_replaced'` (devices.ts);
 * - a settings row of a key epoch above this device's (userSettings.ts);
 * - link-pubkey `resolve` answering `retired` at sign-in (identity.ts, and
 *   the refused-password fallback in auth.tsx).
 * Each reports here. auth.tsx listens: it stops sync and shows the screen
 * that asks for the new phrase, and nothing is wiped. A sync pass that meets
 * one throws PhraseReplacedError, so it ends before its next write, and every
 * unsynced edit stays dirty for the pass after the new phrase.
 *
 * A tab that changes the phrase itself holds its reports while it does
 * (holdPhraseReplacedReports).
 *
 * Imports nothing, so devices.ts, sync.ts and userSettings.ts report without
 * a cycle.
 * Spec: docs/internal/plans/phrase-change.md (section 7)
 */

export type PhraseReplacedSource = 'write' | 'heartbeat' | 'settings' | 'sign-in';

/** A phrase the account replaced, or the phrase of an account deleted after a change. */
export class PhraseReplacedError extends Error {
  constructor(readonly status: 'retired' | 'deleted' = 'retired') {
    super(status === 'retired' ? 'phrase_replaced' : 'account_deleted');
    this.name = 'PhraseReplacedError';
  }
}

const listeners = new Set<(source: PhraseReplacedSource) => void>();

/** Calls `cb` on every report. Returns the unsubscribe. */
export function onPhraseReplaced(cb: (source: PhraseReplacedSource) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// While this tab changes the phrase itself, the server answers that change:
// its old session is revoked and its old phrase is retired. Those answers
// are this tab's own change, not news of another device's, so nobody hears
// them until the tab signed in with the new phrase. Other tabs still hear
// theirs: the count lives in this tab only.
// Spec: docs/internal/plans/phrase-change.md (6.6)
let holds = 0;

/** Hold every report in this tab until the answer is called. */
export function holdPhraseReplacedReports(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

export function reportPhraseReplaced(source: PhraseReplacedSource): void {
  if (holds > 0) return;
  for (const cb of [...listeners]) {
    try {
      cb(source);
    } catch {
      /* one listener cannot stop the others */
    }
  }
}

/** The key-epoch gate's refusal, as PostgREST hands it to supabase-js. Both
 *  fields must match: anything else is an ordinary failure. */
export function isPhraseReplacedRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { message?: unknown; code?: unknown };
  return e.message === 'phrase_replaced' && e.code === 'PT403';
}

/** Report the change and give the error a pass throws to stop. */
export function phraseReplacedStop(source: PhraseReplacedSource): PhraseReplacedError {
  reportPhraseReplaced(source);
  return new PhraseReplacedError('retired');
}
