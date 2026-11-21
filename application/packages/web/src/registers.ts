/**
 * Registers: the merge unit of the per-entry maps in the settings blob.
 *
 * A register is one value with the time it was written, `{ v, at }`. A map of
 * them merges key by key: the later stamp wins, and nothing that one device
 * merely lacks is ever taken away. That is what makes a map safe in a row
 * every device writes whole. A device holding an older copy can push it, and
 * the next device to merge puts the newer values back. A null value is a
 * reset, stamped like any write, so a reset travels and ages out after the
 * folder tombstone window.
 *
 * `itemStyles.ts` keeps one of these maps per folder, tag or note;
 * `deviceLabels.ts` keeps one map for the whole account.
 */
import { TOMBSTONE_RETENTION_MS } from './folders';
import { randomIndex } from './passwordGen';

interface Register {
  /** The value; null is "back to the default". */
  v: string | null;
  /** When it was written, ISO. */
  at: string;
}
export type RegisterMap = Record<string, Register>;

/** A reset old enough that every device has seen it. */
function registerAgedOut(reg: Register, now: number): boolean {
  return reg.v === null && now - Date.parse(reg.at) > TOMBSTONE_RETENTION_MS;
}

function readRegister(raw: unknown, maxLength: number): Register | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Register>;
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return null;
  if (r.v === null) return { v: null, at: r.at };
  if (typeof r.v === 'string' && r.v.length >= 1 && r.v.length <= maxLength) {
    return { v: r.v, at: r.at };
  }
  return null;
}

/** Sanitize a raw map. Drops malformed keys and registers and aged-out
 *  resets, and nothing else. */
export function validateRegisterMap(
  raw: unknown,
  keyOk: (key: string) => boolean,
  maxLength: number,
  now: number,
): RegisterMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: RegisterMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!keyOk(key)) continue;
    const reg = readRegister(value, maxLength);
    if (reg && !registerAgedOut(reg, now)) out[key] = reg;
  }
  return out;
}

/** The later write. On an equal stamp both sides of a merge must choose the
 *  same register, so the value decides: null lowest, then string order. */
function later(a: Register, b: Register): Register {
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  if (ta !== tb) return ta > tb ? a : b;
  if (a.v === b.v) return a.at >= b.at ? a : b;
  // At the last time a stamp can hold, a removal cannot be stamped later
  // than the value it removes, so there it wins the tie; else Remove of a
  // calendar stamped there was undone by the next merge (beta #199 item 9).
  const removalWins = ta === LAST_TIME;
  if (a.v === null) return removalWins ? a : b;
  if (b.v === null) return removalWins ? b : a;
  return a.v > b.v ? a : b;
}

/** Merge two copies, neither of which is authoritative: union by key, the
 *  later stamp per key. */
export function mergeRegisterMaps(local: RegisterMap, remote: RegisterMap, now: number): RegisterMap {
  const out: RegisterMap = {};
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    const a = local[key];
    const b = remote[key];
    const pick = a && b ? later(a, b) : (a ?? b)!;
    if (!registerAgedOut(pick, now)) out[key] = pick;
  }
  return out;
}

/** Whether two maps hold the same registers. Decides whether a merge made
 *  a repair that has to be pushed back. */
export function registerMapsEqual(a: RegisterMap, b: RegisterMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    const ra = a[key]!;
    const rb = b[key];
    if (!rb || ra.v !== rb.v || ra.at !== rb.at) return false;
  }
  return true;
}

/** The shape of a key `newRegisterId` makes. */
export const REGISTER_ID = /^[a-z0-9]{12}$/;

/** A fresh key for a map of registers: twelve lower-case letters and
 *  digits. */
export function newRegisterId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 12 }, () => alphabet[randomIndex(alphabet.length)]).join('');
}

/** A stamp later than `prev` and never earlier than now: the rule of
 *  `nextStamp` in notesRepo.ts. A new write then outranks the value it
 *  replaces even when another device's clock runs ahead. */
export function stampAfter(prev: string | undefined): string {
  const now = Date.now();
  const cur = prev ? Date.parse(prev) : Number.NaN;
  // The last time a Date can hold: one past it is an Invalid Date, and
  // toISOString throws on that.
  return new Date(Number.isFinite(cur) && cur >= now ? Math.min(cur + 1, LAST_TIME) : now).toISOString();
}

const LAST_TIME = 8.64e15;

/** `raw` with every `at` stamp later than `now` set to now. A register read
 *  from a file (a backup) has not been written yet, so it cannot be later
 *  than now; one stamped in the far future would win every merge after it,
 *  the person's own changes included. Notes from a file get the same rule
 *  in import/apply.ts. */
export function clampFutureStamps(raw: unknown, now: number, depth = 0): unknown {
  // A register is a few levels deep. Below this the value is kept as it is:
  // a stranger's file nested a million levels would run out of stack, after
  // the notes were applied and before the settings were.
  if (depth >= STAMP_DEPTH) return raw;
  if (Array.isArray(raw)) return raw.map((x) => clampFutureStamps(x, now, depth + 1));
  if (!raw || typeof raw !== 'object') return raw;
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [
    key,
    key === 'at' && typeof value === 'string' && Date.parse(value) > now
      ? new Date(now).toISOString()
      : clampFutureStamps(value, now, depth + 1),
  ]));
}

const STAMP_DEPTH = 64;
