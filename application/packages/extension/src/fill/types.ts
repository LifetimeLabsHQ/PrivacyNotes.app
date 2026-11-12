/**
 * What travels between the background and the fill script in a page. A
 * report and a result carry codes and counts, never a value of the page or
 * of the login.
 * Spec: docs/internal/plans/click-to-fill.md (sections 3.2, 3.3 and 5)
 */

/** What a frame can do for a login right now. */
export type FillStep = 'login' | 'code' | 'username' | 'none';

/** A frame's answer to the probe. No secret is in it, and the frame's
 *  address is not: the background reads that from the browser. */
export interface FrameReport {
  step: FillStep;
  /** Found by `autocomplete` or a clear word, not by a weak word or position. */
  sure: boolean;
  /** The focused field is one the fill would write, or sits in its group. */
  focused: boolean;
  /** The frame also has a field for the 2FA code. */
  code: boolean;
  reason?: 'signup' | 'readonly';
}

export interface FillRequest {
  runId: string;
  username: string;
  password: string;
  /** The digits of the 2FA code, or empty. Never the key. */
  code: string;
  /** Wait in this page for the password step after a username-only fill. */
  wait: boolean;
}

export type FillPart = 'username' | 'password' | 'code';

export type FillReason = 'signup' | 'otherAccount' | 'readonly' | 'tooLong' | 'refused';

export interface FrameResult {
  filled: FillPart[];
  waiting: boolean;
  reason?: FillReason;
}

/** What the window and the key learn about a run. */
export type FillOutcome =
  | 'filled'
  | 'waiting'
  | 'usernameOnly'
  | 'nothing'
  | 'insecure'
  | 'blockedPage'
  | 'noMatch'
  | 'locked'
  | FillReason;

/** The probe message a frame sends to the background. */
export interface FillProbeMessage {
  type: 'fillProbe';
  runId: string;
  /** Null from a frame the script does not work in. */
  report: FrameReport | null;
}

/** What the script puts on the isolated world's global for the background's calls. */
export interface FillApi {
  probe(runId: string): void;
  fill(request: FillRequest): Promise<FrameResult>;
}
