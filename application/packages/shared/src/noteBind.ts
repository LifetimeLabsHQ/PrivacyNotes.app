/**
 * The binding inside a note payload: which row the ciphertext was written
 * for, which table, and the `updated_at` stamp the write sent. The cipher
 * carries no associated data, so a party who can write the account's rows
 * could move a ciphertext onto another row, or put an older one back. The
 * binding lets a reader see both. It is in the payload, not in the cipher,
 * so an app version before it still opens every new row (it drops the key).
 * Spec: docs/internal/plans/payload-row-binding.md (sections 2 and 4)
 */

export type NoteBindKind = 'note' | 'version';

/** What a writer seals: the row id (for a version, its note id), the table,
 *  and for a live note the stamp the row sends. */
export interface NoteBind {
  id: string;
  kind: NoteBindKind;
  at?: string;
}

/** `ok`: the payload names this row. `legacy`: no binding (an app before it,
 *  or an old writer). `moved`: a binding that names another row, table or
 *  stamp, or a binding that is not one. */
export type NoteBindVerdict = 'ok' | 'legacy' | 'moved';

/**
 * From this instant on, a payload with no binding on a row whose server
 * `changed_at` is at or after it counts as `moved`. Null while app versions
 * that write no binding may still write notes. Set it on the day the floor
 * of every store channel and the server version gate pass the first version
 * that writes `bind`; a row nothing has written since that day is still taken.
 * Spec: docs/internal/plans/payload-row-binding.md (section 5)
 */
export const NOTE_BIND_REQUIRED_FROM: string | null = null;

const HAS_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * The one form of a stamp a binding seals and the row sends: an ISO instant
 * in UTC with milliseconds. A date-time with no zone is read as UTC, as the
 * server reads it; the device would read it as local time, so the two sides
 * would differ by the device's offset. Text that does not parse is returned
 * as it is (the server refuses it, as before).
 */
export function bindStamp(stamp: string): string {
  // Spellings Postgres reads and JavaScript does not: a zone of hours alone
  // (`+01`) and a trailing `UTC`.
  const trimmed = stamp.trim();
  const spelled = /T\d{2}:\d{2}/.test(trimmed) ? trimmed.replace(/\s*UTC$/i, 'Z').replace(/([+-]\d{2})$/, '$1:00') : trimmed;
  const text = /^\d{4}-\d{2}-\d{2}T/.test(spelled) && !HAS_ZONE.test(spelled) ? `${spelled}Z` : spelled;
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : stamp;
}

/** Two stamps name the same millisecond. */
function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(bindStamp(a));
  const tb = Date.parse(bindStamp(b));
  return Number.isFinite(ta) && Number.isFinite(tb) ? ta === tb : a === b;
}

/** The binding a payload carries, as the payload JSON holds it. */
export function readBind(parsed: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(parsed, 'bind') ? parsed.bind : undefined;
}

/**
 * Whether a payload's binding names the row it was read from. `expected.id`
 * is the row id (a version row: its note id), `expected.updatedAt` the row's
 * `updated_at` for a live note. `changedAt` is the row's server `changed_at`,
 * read only for a payload with no binding once NOTE_BIND_REQUIRED_FROM is set.
 */
export function checkNoteBind(
  bind: unknown,
  expected: { id: string; kind: NoteBindKind; updatedAt?: string },
  changedAt?: string,
  requiredFrom: string | null = NOTE_BIND_REQUIRED_FROM,
): NoteBindVerdict {
  if (bind === undefined) {
    if (requiredFrom === null) return 'legacy';
    const from = Date.parse(requiredFrom);
    const at = changedAt === undefined ? NaN : Date.parse(changedAt);
    // A row whose change time cannot be read is not taken past the switch.
    return Number.isFinite(at) && at < from ? 'legacy' : 'moved';
  }
  if (bind === null || typeof bind !== 'object' || Array.isArray(bind)) return 'moved';
  const b = bind as Record<string, unknown>;
  if (typeof b.id !== 'string' || b.id.toLowerCase() !== expected.id.toLowerCase()) return 'moved';
  if (b.kind !== expected.kind) return 'moved';
  if (expected.kind === 'note') {
    if (typeof b.at !== 'string' || expected.updatedAt === undefined) return 'moved';
    if (!sameInstant(b.at, expected.updatedAt)) return 'moved';
  }
  return 'ok';
}
