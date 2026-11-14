/**
 * The notes this device deleted that the server never held: the push found
 * no row to tombstone, so no other record of the delete exists. An inbox row
 * of the browser extension that such a note was built from would build it
 * again at the next pass (issue 769); the inbox pass reads this list and
 * settles the row instead. Kept in the local kv table, which a sign-out
 * clears (ACCOUNT_KV_KEYS).
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.3 step 5)
 */
import { db } from './db';

const UNSYNCED_DELETES_KEY = 'unsyncedDeletes';
// Spec: docs/internal/plans/browser-extension-build.md (section 3.3 step 5, the 500-row inbox cap and the 90-day purge)
const MAX_IDS = 500;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

async function readList(): Promise<Record<string, number>> {
  try {
    const raw = (await db.kv.get(UNSYNCED_DELETES_KEY))?.value;
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Add ids to the list, newest kept. Call it inside a transaction on
 *  db.kv when the delete it records is written in the same one. */
export async function rememberUnsyncedDeletes(ids: string[], now: number = Date.now()): Promise<void> {
  if (!ids.length) return;
  const list = await readList();
  for (const id of ids) list[id] = now;
  const kept = Object.entries(list)
    .filter(([, at]) => typeof at === 'number' && now - at < KEEP_MS)
    .sort((x, y) => y[1] - x[1])
    .slice(0, MAX_IDS);
  await db.kv.put({ key: UNSYNCED_DELETES_KEY, value: JSON.stringify(Object.fromEntries(kept)) });
}

/** The ids of the list that are still in date. */
export async function unsyncedDeletes(now: number = Date.now()): Promise<Set<string>> {
  return new Set(Object.entries(await readList()).filter(([, at]) => now - at < KEEP_MS).map(([id]) => id));
}
