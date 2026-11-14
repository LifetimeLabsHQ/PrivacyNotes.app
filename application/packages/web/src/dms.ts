import type { SupabaseClient } from '@notes/shared';
import { isDemoMode } from './demo';
import { db } from './db';
import { isMfaRefusal, MfaRequiredError } from './mfaStep';
import { recordSyncFault } from './syncFaults';
import { setDmsHold } from './syncPause';
import { createListeners } from './listeners';

/**
 * The dead man's switch, client side: the device gate that runs before a
 * pull, the hold it sets, and the two account calls (dms_check, dms_set).
 *
 * The server tombstones an inactive armed account's notes. A tombstone makes
 * a device delete its local copy on the next pull without asking, so before
 * a pull this device asks the server whether a wipe happened since it last
 * looked (wipe_gen). If one did, every server write stops (setDmsHold, read
 * by isServerWriteBlocked) and the person chooses: download a backup, or
 * delete the notes on this device.
 *
 * An account that never armed the switch makes one cheap call a day here and
 * nothing else changes.
 * Spec: docs/internal/specs/dead-mans-switch.md (section 6)
 */

/** The periods the server accepts. Spec: docs/internal/specs/dead-mans-switch.md (3.2) */
export const DMS_PERIODS = [1, 2, 3, 6, 9, 12, 24, 36, 48, 60] as const;
export type DmsPeriod = typeof DMS_PERIODS[number];

/** What dms_check answers. */
export type DmsStatus = {
  months: DmsPeriod | null;
  wipeGen: number;
  wipedAt: string | null;
  deletesOn: string | null;
};

/** The wipe a held device is waiting to answer, for the dialog. Bound to the
 *  account it was found for: a hold never carries over to another account. */
export type DmsWipe = { pubkey: string; wipeGen: number; wipedAt: string | null };

const STORAGE_KEY = 'privacynotes.dms';
// Spec: docs/internal/specs/dead-mans-switch.md (section 6, once a day when not armed)
const UNARMED_CHECK_MS = 24 * 60 * 60 * 1000;
// A wipe needs at least 1 month (the shortest period, 28 days at the least)
// without activity. A device whose last answer is younger than this cannot
// have missed one, so a failed check may let its pass run; an older or absent
// answer may not. Two weeks under the shortest month, for clock skew.
// Spec: docs/internal/specs/dead-mans-switch.md (section 13, a failed check)
const RECENT_ANSWER_MS = 14 * 24 * 60 * 60 * 1000;

type LocalState = { pubkey: string; armed: boolean; dmsGen: number; checkedAt: number };

/** An absent or foreign key reads as never checked, so a long-dormant device
 *  asks at once and cannot accept a wipe silently. */
function readLocal(pubkey: string): LocalState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<LocalState>) : null;
    if (
      parsed && parsed.pubkey === pubkey && typeof parsed.armed === 'boolean'
      && Number.isInteger(parsed.dmsGen) && typeof parsed.checkedAt === 'number'
    ) {
      return parsed as LocalState;
    }
  } catch { /* unreadable: treat as never checked */ }
  return { pubkey, armed: false, dmsGen: 0, checkedAt: 0 };
}

function writeLocal(state: LocalState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* the next pass asks again */ }
}

let pendingWipe: DmsWipe | null = null;
const { subscribe, notify } = createListeners();

function hold(wipe: DmsWipe | null): void {
  pendingWipe = wipe;
  setDmsHold(wipe !== null);
  notify();
}

/** Drops a hold found for another account. Asked first by every sync and
 *  settings pass, before the write gate it would otherwise close for the
 *  wrong account. */
export function dropForeignDmsHold(pubkey: string): void {
  if (pendingWipe && pendingWipe.pubkey !== pubkey) hold(null);
}

export const subscribeDmsWipe = subscribe;

export function getDmsWipe(): DmsWipe | null {
  return pendingWipe;
}

function parseStatus(data: unknown): DmsStatus | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.wipe_gen !== 'number' || !Number.isInteger(d.wipe_gen)) return null;
  const months = DMS_PERIODS.includes(d.months as DmsPeriod) ? (d.months as DmsPeriod) : null;
  return {
    months,
    wipeGen: d.wipe_gen,
    wipedAt: typeof d.wiped_at === 'string' ? d.wiped_at : null,
    deletesOn: typeof d.deletes_on === 'string' ? d.deletes_on : null,
  };
}

/**
 * The one place an answer from the server is taken in: a newer wipe than this
 * device has seen either holds every write or, on a device with nothing to
 * lose, is accepted. Every caller of dms_check goes through it, so no path
 * (the settings tab, a toggle while sync is paused) can store a fresh answer
 * over a wipe that was never asked about.
 */
async function takeAnswer(pubkey: string, answer: DmsStatus): Promise<'run' | 'held'> {
  const local = readLocal(pubkey);
  if (answer.wipeGen > local.dmsGen) {
    if (!(await nothingToLose())) {
      hold({ pubkey, wipeGen: answer.wipeGen, wipedAt: answer.wipedAt });
      return 'held';
    }
  }
  writeLocal({ pubkey, armed: answer.months !== null, dmsGen: Math.max(local.dmsGen, answer.wipeGen), checkedAt: Date.now() });
  return 'run';
}

/** dms_check, for the settings tab. Throws on any failure. */
export async function fetchDmsStatus(supabase: SupabaseClient, pubkey: string): Promise<DmsStatus> {
  const { data, error } = await supabase.rpc('dms_check');
  if (error) throw error;
  const status = parseStatus(data);
  if (!status) throw new Error('dms_check: unexpected answer');
  await takeAnswer(pubkey, status);
  return status;
}

/** dms_set: a period turns the switch on (and restarts the timer), null
 *  turns it off. Answers the new status. */
export async function setDms(supabase: SupabaseClient, pubkey: string, months: DmsPeriod | null): Promise<DmsStatus> {
  const { error } = await supabase.rpc('dms_set', { p_months: months });
  if (error) throw error;
  return fetchDmsStatus(supabase, pubkey);
}

/** PostgREST's answer for a function the database does not have: before
 *  migration 0107 there is no switch, so no wipe either. */
function isMissingFunction(error: { code?: string } | null, status: number): boolean {
  return status === 404 || error?.code === 'PGRST202';
}

/**
 * The gate, awaited in a sync pass after the session claim is proven and
 * before any pull. 'run' lets the pass go on; 'skip' ends this pass quietly
 * (the next pass asks again); 'held' means a wipe waits for the person;
 * 'refused' means the server refused the token (401), which ends the pass
 * like 'skip' and sends it to the session check, whose forced refresh is
 * the only thing that can repair it. A quiet skip on every pass never got
 * there.
 */
export async function dmsGate(supabase: SupabaseClient, pubkey: string): Promise<'run' | 'skip' | 'held' | 'refused'> {
  if (isDemoMode()) return 'run';
  dropForeignDmsHold(pubkey);
  if (pendingWipe) return 'held';
  const local = readLocal(pubkey);
  if (!local.armed && Date.now() - local.checkedAt < UNARMED_CHECK_MS) return 'run';

  const { data, error, status } = await supabase.rpc('dms_check');
  const answer = error ? null : parseStatus(data);
  if (!answer) {
    if (error && isMfaRefusal(error)) throw new MfaRequiredError();
    recordSyncFault({ step: 'device', status, code: 'dms_check' });
    if (status === 401) return 'refused';
    if (isMissingFunction(error, status)) {
      // No switch on this server, so no wipe: an answer like any other, kept
      // for the day instead of asked again on every pass.
      writeLocal({ ...local, armed: false, checkedAt: Date.now() });
      return 'run';
    }
    // An unknown answer lets a pass pull only on a device that cannot have
    // missed a wipe: one that knows of no switch and asked recently.
    return local.armed || Date.now() - local.checkedAt > RECENT_ANSWER_MS ? 'skip' : 'run';
  }
  return takeAnswer(pubkey, answer);
}

/** No live note and no file that exists only here: a fresh device, or one
 *  that already answered. */
async function nothingToLose(): Promise<boolean> {
  const live = await db.notes.filter((n) => n.deleted !== 1).count();
  if (live > 0) return false;
  // At call time: the counter's module carries UI, and sync.ts imports this one.
  const { countOnlyOnThisDevice } = await import('./neverBackedUp');
  return (await countOnlyOnThisDevice()).files === 0;
}

/** How many notes the held device still has, for the dialog. */
export async function countLocalNotes(): Promise<number> {
  return db.notes.filter((n) => n.deleted !== 1).count();
}
