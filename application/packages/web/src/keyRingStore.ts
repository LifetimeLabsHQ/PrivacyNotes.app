/**
 * The key ring as it travels and as this device keeps it: sealed, fetched,
 * cached, opened and installed.
 *
 * The ring holds the content keys (sync, local at rest, inbox) of the
 * account's earlier epochs, encrypted under the CURRENT sync key with the AAD
 * `pn-keyring-v1:<account>:<epoch>`. A holder of the current phrase opens it;
 * a holder of an earlier phrase cannot. The server keeps it
 * (`account_keys.key_ring`) and gives it only to a session bound to the
 * current epoch (`account_key_ring`, migration 0121). This device keeps the
 * same ciphertext in db.kv, so a boot opens it with no request; that is no
 * new secret at rest, because it needs the phrase.
 *
 * `takeKeyRing` is the one way a device moves to an epoch above 1. It opens
 * the ring first and only then registers the new local key and installs the
 * ring, in one synchronous step, so no reader runs between them with the new
 * key and no ring (keyRing.ts). A ring that does not open swaps nothing: the
 * device keeps the keys it held, and with them every local row it can read
 * and export.
 * Spec: docs/internal/plans/phrase-change.md (6.1, 6.6)
 */
import {
  base64ToBytes,
  bytesToBase64,
  decryptJsonAad,
  encryptJsonAad,
  type SupabaseClient,
} from '@notes/shared';
import { db, KEY_RING_CACHE_KEY } from './db';
import { installKeyRing, type EpochKeys, type KeyKind } from './keyRing';
import { registerLocalDataKey } from './localKey';
import { isPhraseReplacedRefusal, PhraseReplacedError } from './phraseReplaced';

const KINDS: readonly KeyKind[] = ['sync', 'local', 'inbox'];
const aad = (account: string, epoch: number) => `pn-keyring-v1:${account}:${epoch}`;

function wholeEpoch(epoch: number): boolean {
  return Number.isSafeInteger(epoch) && epoch >= 1;
}

/**
 * The ring as the server stores it: the keys of each earlier epoch under the
 * sync key of `epoch`. The phrase change builds it (step 5); a test builds
 * one the same way.
 */
export function sealKeyRing(entries: ReadonlyMap<number, EpochKeys>, syncKey: Uint8Array, account: string, epoch: number): string {
  if (!wholeEpoch(epoch) || epoch < 2) throw new Error('a key ring belongs to an epoch from 2');
  const plain: Record<string, Record<KeyKind, string>> = {};
  for (const [e, keys] of entries) {
    if (!wholeEpoch(e) || e >= epoch) throw new Error('a key ring holds earlier epochs only');
    plain[String(e)] = { sync: bytesToBase64(keys.sync), local: bytesToBase64(keys.local), inbox: bytesToBase64(keys.inbox) };
  }
  const { ciphertext, nonce } = encryptJsonAad(plain, syncKey, aad(account, epoch));
  return JSON.stringify({ v: 1, n: bytesToBase64(nonce), ct: bytesToBase64(ciphertext) });
}

/** Open a ring under the sync key of `epoch`. Throws on anything that is not
 *  a ring of this account and epoch with 32-byte keys of earlier epochs. */
export function openKeyRing(text: string, syncKey: Uint8Array, account: string, epoch: number): Map<number, EpochKeys> {
  const outer = JSON.parse(text) as { v?: unknown; n?: unknown; ct?: unknown };
  if (outer?.v !== 1 || typeof outer.n !== 'string' || typeof outer.ct !== 'string') throw new Error('not a key ring');
  const plain = decryptJsonAad<Record<string, Record<string, unknown>>>(base64ToBytes(outer.ct), base64ToBytes(outer.n), syncKey, aad(account, epoch));
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) throw new Error('not a key ring');
  const out = new Map<number, EpochKeys>();
  for (const [label, keys] of Object.entries(plain)) {
    const e = /^[1-9][0-9]{0,8}$/.test(label) ? Number(label) : NaN;
    if (!wholeEpoch(e) || e >= epoch) throw new Error('a key ring holds earlier epochs only');
    const opened = {} as EpochKeys;
    for (const kind of KINDS) {
      const value = keys?.[kind];
      const bytes = typeof value === 'string' ? base64ToBytes(value) : null;
      if (!bytes || bytes.length !== 32) throw new Error('a key ring key is 32 bytes');
      opened[kind] = bytes;
    }
    out.set(e, opened);
  }
  return out;
}

/**
 * The account's epoch and ring, as the server holds them. `ring` is null for
 * an account that never changed its phrase. Throws PhraseReplacedError when
 * the session did not prove the current key, and a plain error when there is
 * no answer.
 */
export async function fetchKeyRing(supabase: SupabaseClient): Promise<{ epoch: number; ring: string | null }> {
  const { data, error } = await supabase.rpc('account_key_ring');
  if (isPhraseReplacedRefusal(error)) throw new PhraseReplacedError('retired');
  if (error) throw new Error('key ring unavailable');
  const answer = data as { epoch?: unknown; key_ring?: unknown } | null;
  const epoch = typeof answer?.epoch === 'number' ? answer.epoch : NaN;
  if (!wholeEpoch(epoch)) throw new Error('key ring unavailable');
  if (epoch === 1) return { epoch, ring: null };
  if (typeof answer?.key_ring !== 'string') throw new Error('key ring unavailable');
  return { epoch, ring: answer.key_ring };
}

/** The ring this device keeps for this account and epoch, or null. */
export async function readCachedKeyRing(account: string, epoch: number): Promise<string | null> {
  try {
    const raw = (await db.kv.get(KEY_RING_CACHE_KEY))?.value;
    if (typeof raw !== 'string') return null;
    const rec = JSON.parse(raw) as { account?: unknown; epoch?: unknown; ring?: unknown };
    return rec.account === account && rec.epoch === epoch && typeof rec.ring === 'string' ? rec.ring : null;
  } catch {
    return null;
  }
}

async function cacheKeyRing(account: string, epoch: number, ring: string): Promise<void> {
  try {
    await db.kv.put({ key: KEY_RING_CACHE_KEY, value: JSON.stringify({ account, epoch, ring }) });
  } catch {
    /* Best effort: the next sign-in asks the server again. */
  }
}

/** Overwrite every key of a ring that is no longer needed. */
export function zeroKeyRing(entries: Map<number, EpochKeys>): void {
  for (const keys of entries.values()) for (const key of Object.values(keys)) key.fill(0);
}

/** Register the new local key and install the ring, with nothing in between. */
function swapTo(epoch: number, entries: Map<number, EpochKeys>, localKey: Uint8Array): void {
  try {
    registerLocalDataKey(localKey);
    installKeyRing(epoch, entries);
  } finally {
    zeroKeyRing(entries);
  }
}

type Take = {
  account: string;
  /** The epoch the phrase signs for (the identity of identity.ts). */
  epoch: number;
  /** The sync key of that phrase: the ring is sealed under it. */
  syncKey: Uint8Array;
  /** The local key of that phrase, registered once the ring is open. */
  localKey: Uint8Array;
};

/**
 * Boot without the network: the cached ring, opened and installed. False,
 * with nothing swapped, when there is none or it does not open.
 */
export async function takeCachedKeyRing(opts: Take): Promise<boolean> {
  const text = await readCachedKeyRing(opts.account, opts.epoch);
  if (text === null) return false;
  let entries: Map<number, EpochKeys>;
  try {
    entries = openKeyRing(text, opts.syncKey, opts.account, opts.epoch);
  } catch {
    return false;
  }
  swapTo(opts.epoch, entries, opts.localKey);
  return true;
}

/**
 * Move this device to `epoch`: the cached ring when it opens, else the
 * server's, which must be of the same epoch. Throws, with nothing swapped,
 * when neither opens. Run after the session is bound (the server answers no
 * other session) and before anything reads local data with the new key.
 */
export async function takeKeyRing(opts: Take & { supabase: SupabaseClient }): Promise<void> {
  if (await takeCachedKeyRing(opts)) return;
  const fetched = await fetchKeyRing(opts.supabase);
  if (fetched.epoch !== opts.epoch || fetched.ring === null) throw new Error('key ring of another epoch');
  const entries = openKeyRing(fetched.ring, opts.syncKey, opts.account, opts.epoch);
  swapTo(opts.epoch, entries, opts.localKey);
  await cacheKeyRing(opts.account, opts.epoch, fetched.ring);
}
