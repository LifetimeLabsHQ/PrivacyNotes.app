/**
 * Automatic backups, the rules with no I/O: when a backup is due, what its
 * file is called, which old copies go, and when nothing may go. Everything
 * here is a pure function of its arguments, so tests/autoBackupPlan.test.ts
 * can state each rule as a table.
 * Spec: docs/internal/plans/auto-backup.md (sections 5, 6 and 8)
 */
export type BackupType = 'full' | 'text';
export type BackupPeriod = 'day' | 'week' | 'month';
/** How many copies stay; 0 keeps every one. */
export type BackupKeep = 0 | 3 | 7 | 14 | 30;

// Spec: docs/internal/plans/auto-backup.md (section 8, Keep)
export const KEEP_CHOICES: readonly BackupKeep[] = [3, 7, 14, 30, 0];
export const PERIOD_CHOICES: readonly BackupPeriod[] = ['day', 'week', 'month'];

const HOUR = 3_600_000;
// Spec: docs/internal/plans/auto-backup.md (section 6, condition 4: a month is a fixed 30 days)
const PERIOD_MS: Record<BackupPeriod, number> = { day: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR };
// Spec: docs/internal/plans/auto-backup.md (section 6, condition 4)
const DUE_SLACK_MS = HOUR;
// Spec: docs/internal/plans/auto-backup.md (section 6, After a failure)
const RETRY_AFTER_MS = 6 * HOUR;
// Spec: docs/internal/plans/auto-backup.md (section 10, Tier 3 "Not today")
export const SNOOZE_MS = 20 * HOUR;
// Spec: docs/internal/plans/auto-backup.md (section 8, Shrink guard)
const SHRINK_FLOOR = 20;

const EXTENSION: Record<BackupType, string> = { full: 'pnbackupz', text: 'pnbackup' };

/** One file this device placed, kept until that file is pruned. `ref` is what
 *  the destination deletes by: the name, or a document address on Android. */
export interface PlacedFile {
  ref: string;
  name: string;
  /** When it was placed, ms. */
  at: number;
  bytes: number;
  /** Live rows in it: not trashed, not deleted. */
  items: number;
}

/** A backup is due when the last good run is one period old, less an hour so
 *  a daily run does not drift later each day. No good run yet, or one stamped
 *  in the future (a clock that moved back), counts as due. */
export function isDue(lastGood: number | undefined, period: BackupPeriod, now: number): boolean {
  if (lastGood === undefined || lastGood > now) return true;
  return now - lastGood >= PERIOD_MS[period] - DUE_SLACK_MS;
}

/** Two periods late: the point where the app says so outside the tab. */
export function isOverdue(lastGood: number | undefined, period: BackupPeriod, now: number): boolean {
  if (lastGood === undefined) return false;
  return now - lastGood >= 2 * PERIOD_MS[period];
}

/** When the next backup comes due, for the "overdue" notification a phone
 *  schedules ahead of time. */
export function overdueAt(lastGood: number, period: BackupPeriod): number {
  return lastGood + 2 * PERIOD_MS[period];
}

/** After a failed run the next try waits: a new app start, or six hours. */
export function mayRetry(lastFailure: number | undefined, startedAt: number, now: number): boolean {
  if (lastFailure === undefined || lastFailure > now) return true;
  return lastFailure < startedAt || now - lastFailure >= RETRY_AFTER_MS;
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** The device part of a file name: lower-case letters, digits and hyphens,
 *  at most 40, never empty. The native side checks the same shape. */
export function deviceSlug(deviceName: string, fallback: string): string {
  // Not `slugify` (exportNames.ts): that one answers 'untitled' for a name
  // with no letter in it, and here the platform name is the better fallback.
  const clean = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return clean(deviceName) || clean(fallback) || 'device';
}

/** `privacynotes-backup-2026-11-11-0902-macbook.pnbackupz`, in local time. */
export function backupName(at: Date, device: string, type: BackupType): string {
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `privacynotes-backup-${day}-${pad(at.getHours())}${pad(at.getMinutes())}-${device}.${EXTENSION[type]}`;
}

/** What makes two vault states the same for a backup. A run whose
 *  fingerprint equals the last good one writes nothing. */
export function fingerprint(v: {
  type: BackupType;
  destination: string;
  live: number;
  trashed: number;
  newest: string;
  /** A hash of what the backup carries of the settings (backupSettingsKey). */
  settings: string;
}): string {
  return [v.type, v.destination, v.live, v.trashed, v.newest, v.settings].join('|');
}

/** A backup with far fewer items than the one before it: fewer than half,
 *  when the earlier one held 20 or more. While this holds and the person
 *  has not confirmed it, nothing is pruned. */
export function isShrunk(items: number, previous: number | undefined): boolean {
  if (previous === undefined || previous < SHRINK_FLOOR) return false;
  return items * 2 < previous;
}

/** The item count a new backup is measured against: the newest copy in the
 *  list, or, while a warning waits for its answer, the count that warning
 *  named. By the run after a shrunk backup the newest copy is the shrunk one,
 *  and measured against it that run would look normal and prune. */
export function shrinkBaseline(newest: number | undefined, pending: number | undefined): number | undefined {
  return pending ?? newest;
}

/** The listed files that are still there. A copy the person deleted by hand
 *  no longer counts toward Keep, so Keep the last 3 leaves 3 real copies.
 *  Each listed file is asked about by its own name; the folder is never listed. */
export async function stillThere(files: readonly PlacedFile[], exists: (ref: string) => Promise<boolean>): Promise<PlacedFile[]> {
  const there = await Promise.all(files.map((f) => exists(f.ref)));
  return files.filter((_, i) => there[i]);
}

/** The files that go so that `keep` stay, oldest first. Only files from this
 *  device's own list; the folder is never read to choose. */
export function pruneList(files: readonly PlacedFile[], keep: BackupKeep): PlacedFile[] {
  if (keep === 0 || files.length <= keep) return [];
  const oldestFirst = [...files].sort((a, b) => a.at - b.at);
  return oldestFirst.slice(0, files.length - keep);
}
