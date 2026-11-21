/**
 * What a lock's reload hands the next page of this tab (lockReload.ts), in
 * sessionStorage. A module of its own, with no import but the demo bucket:
 * the reminders module reads it, and windows without the notes (About) load
 * that module, so it must not pull the lock's settings chain in.
 * Spec: docs/internal/plans/phrase-lock-hardening.md (section 3.2, section 4 Q2)
 */
import { credentialKey } from './demo';

/** The open note: an id, no content (appReLock.ts). */
export const REOPEN_NOTE_KEY = credentialKey('privacynotes.lockReopenNote');

/** The times-only reminder plan (`keepLockedPlan` in notesView/useReminders.tsx). */
export const LOCKED_REMINDERS_KEY = credentialKey('privacynotes.lockReminders');
