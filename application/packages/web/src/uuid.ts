/** A hyphenated uuid in either case, as text for a larger pattern. The one
 *  uuid pattern of the web app. */
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const UUID = new RegExp(`^${UUID_PATTERN}$`, 'i');

/** True for a hyphenated uuid string, either case: a note id the server can
 *  store, a server row id, and the id a note shortcut accepts. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
