/**
 * Local calendar days and clock times, with no imports, so the write path
 * (dayLedger.ts via notesRepo) and the medication math stay free of the i18n
 * chain that intlFormat.ts carries.
 */

/** Local calendar date as `YYYY-MM-DD`. Never UTC: an entry belongs to
 *  the day the writer is living, not to the day in Greenwich. */
export function toLocalIso(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A `YYYY-MM-DD` day as its local midnight. */
export function parseDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

/** `HH:MM` of an instant, local. */
export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
