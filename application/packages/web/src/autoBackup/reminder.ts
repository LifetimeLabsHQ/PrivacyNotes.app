/**
 * The "backup is overdue" notification, as one item of the device's reminder
 * plan (notesView/useReminders.tsx). The plan owns every system notification
 * of this app and sweeps what it did not plan, so the backup's rides in it,
 * like the daily check-in. It is set for the moment the backup becomes two
 * periods late and moves each time a backup succeeds, so it needs no server
 * and no run in the background. Its text names no folder and no item.
 * Spec: docs/internal/plans/auto-backup.md (section 10)
 */
import { toLocalIso } from '../intlFormat';
import type { ReminderItem } from '../reminders';
import { overdueAt, type BackupPeriod } from './plan';

export const BACKUP_REMINDER_ID = 'backup-overdue';

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

export function backupReminderItem(config: { on: boolean; notify: boolean; lastGood?: number; period: BackupPeriod }): ReminderItem | null {
  if (!config.on || !config.notify || config.lastGood === undefined) return null;
  const at = new Date(overdueAt(config.lastGood, config.period));
  return {
    id: BACKUP_REMINDER_ID,
    schedule: { day: toLocalIso(at), time: `${pad(at.getHours())}:${pad(at.getMinutes())}`, alerts: [{ before: 0 }] },
    title: '',
    gated: false,
  };
}
