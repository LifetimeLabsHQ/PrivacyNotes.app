/**
 * The key ring on this device: the content keys of the account's earlier
 * phrases (sync, local at rest, inbox), by key epoch, opened in memory.
 *
 * Epoch 1 is the account's first phrase. A phrase change gives the account a
 * new phrase and the next epoch, and keeps the keys of every earlier epoch in
 * a ring encrypted under the new sync key, so older server rows, local data,
 * inbox saves and backups still open. This module holds only the opened ring
 * and the epoch of this device's current keys. The current keys stay where
 * they always were: the auth state, localKey.ts and the inbox secret cache.
 *
 * Until something installs a ring, the current epoch is 1 and the ring is
 * empty, so every reader tries the current key alone, exactly as it did
 * before the ring existed.
 *
 * Reading order: the key of the record's own epoch when the record names one
 * this device holds, then the current key, then the ring from the newest
 * epoch to the oldest. A record that names an epoch this device does not
 * hold, and that no key opens, is never treated as damaged: its keys have
 * not arrived yet, so the reader keeps it.
 *
 * Every key leaves memory with the local data key (sign-out zeroes both),
 * and a local key that registers in place of a different one starts with no
 * ring and epoch 1: a sign-out whose flush timed out keeps its key, and the
 * next sign-in must not inherit its ring. The same key again (an unlock)
 * keeps the ring. So whoever installs a ring registers the local key first,
 * and installs it before any reader runs, because until then this device
 * reads as epoch 1 with every key held.
 * Spec: docs/internal/plans/phrase-change.md (6.1, 6.2, 6.6)
 */
import { onLocalDataKeyCleared, onLocalDataKeyReplaced } from './localKey';

export type KeyKind = 'sync' | 'local' | 'inbox';
export type EpochKeys = Record<KeyKind, Uint8Array>;

let current = 1;
const ring = new Map<number, EpochKeys>();
// The highest epoch a record showed this device: a server row, or a local
// record another tab wrote. Above `current`, the account changed its phrase
// after this device took its keys (section 7).
let seenEpoch = 1;
const epochListeners = new Set<() => void>();

/** A record names an epoch this device holds no key for, and no key it
 *  holds opened it. The record is kept, never deleted. */
export class KeyEpochUnknown extends Error {
  constructor(readonly epoch: number) {
    super(`no key of epoch ${epoch} on this device`);
    this.name = 'KeyEpochUnknown';
  }
}

/** A record's epoch marker as a number. No marker is epoch 1, the first
 *  phrase. A marker that is not a whole number from 1 names no epoch this
 *  device can hold (NaN). */
export function epochOf(marker: unknown): number {
  if (marker === undefined || marker === null) return 1;
  return typeof marker === 'number' && Number.isSafeInteger(marker) && marker >= 1 ? marker : NaN;
}

/** The epoch of this device's current keys. */
export function currentKeyEpoch(): number {
  return current;
}

/** The marker a writer puts on a record sealed under the current keys: none
 *  for epoch 1, so every record of an unchanged account is written as before. */
export function epochMarker(): { e?: number } {
  return current === 1 ? {} : { e: current };
}

/** The `key_epoch` column a server write under the current keys carries:
 *  none for epoch 1, so every row of an unchanged account is written as
 *  before and the column keeps its default. Spec: docs/internal/plans/phrase-change.md (6.3) */
export function keyEpochColumn(): { key_epoch?: number } {
  return current === 1 ? {} : { key_epoch: current };
}

/** Whether this device holds the keys of an epoch. */
export function holdsEpoch(epoch: number): boolean {
  return epoch === current || ring.has(epoch);
}

/** A record named this epoch. */
export function noteAccountEpoch(epoch: number): void {
  if (Number.isSafeInteger(epoch) && epoch > seenEpoch) seenEpoch = epoch;
}

/** The account's epoch as far as this device knows. */
export function accountKeyEpoch(): number {
  return Math.max(current, seenEpoch);
}

/**
 * True when this device holds a key for every epoch the account has had, as
 * far as it knows. Only then can a record that carries no marker and opens
 * under none of them be called damaged. Otherwise it can be sealed to a key
 * this device has not received yet, and it waits.
 */
export function holdsEveryEpoch(): boolean {
  if (seenEpoch > current) return false;
  for (let e = 1; e < current; e++) if (!ring.has(e)) return false;
  return true;
}

/**
 * Copies of every earlier epoch's keys this device holds, for the phrase
 * change, which seals them with the current epoch's into the next ring. The
 * caller zeroes them. Spec: docs/internal/plans/phrase-change.md (6.1)
 */
export function ringKeyCopies(): Map<number, EpochKeys> {
  const out = new Map<number, EpochKeys>();
  for (const [e, keys] of ring) out.set(e, { sync: new Uint8Array(keys.sync), local: new Uint8Array(keys.local), inbox: new Uint8Array(keys.inbox) });
  return out;
}

/** True when `key` is a key of an earlier epoch this device holds. The
 *  background pass refuses to treat such a key as the current one.
 *  Spec: docs/internal/plans/phrase-change.md (6.4) */
export function isRingKey(kind: KeyKind, key: Uint8Array): boolean {
  for (const keys of ring.values()) {
    const k = keys[kind];
    if (k.length === key.length && k.every((b, i) => b === key[i])) return true;
  }
  return false;
}

/** Runs when the epoch of the current keys changes: a cache keyed by the
 *  account id alone holds a key of the old epoch then. */
export function onKeyEpochChange(cb: () => void): void {
  epochListeners.add(cb);
}

function zeroRing(): void {
  for (const keys of ring.values()) for (const key of Object.values(keys)) key.fill(0);
  ring.clear();
}

function setEpoch(epoch: number): void {
  const changed = epoch !== current;
  current = epoch;
  if (changed) for (const cb of epochListeners) cb();
}

/**
 * Install the opened ring and the epoch of the current keys. The ring holds
 * earlier epochs only; each key is copied in, and every key held before is
 * zeroed.
 */
export function installKeyRing(epoch: number, entries: ReadonlyMap<number, EpochKeys>): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('a key epoch is a whole number from 1');
  for (const e of entries.keys()) {
    if (!Number.isSafeInteger(e) || e < 1 || e >= epoch) throw new Error('a key ring holds earlier epochs only');
  }
  zeroRing();
  for (const [e, keys] of entries) {
    ring.set(e, { sync: new Uint8Array(keys.sync), local: new Uint8Array(keys.local), inbox: new Uint8Array(keys.inbox) });
  }
  setEpoch(epoch);
}

/** Forget the ring and every epoch this device has seen. */
export function clearKeyRing(): void {
  zeroRing();
  seenEpoch = 1;
  setEpoch(1);
}
onLocalDataKeyCleared(clearKeyRing);
onLocalDataKeyReplaced(clearKeyRing);

/** The epochs to try, in reading order. */
function readingOrder(declared: number | undefined): number[] {
  const out: number[] = [];
  if (declared !== undefined && holdsEpoch(declared)) out.push(declared);
  if (!out.includes(current)) out.push(current);
  for (const e of [...ring.keys()].sort((a, b) => b - a)) if (!out.includes(e)) out.push(e);
  return out;
}

/**
 * Open a record with the keys this device holds, in reading order, and
 * answer what `open` returned for the first key that worked. `currentKey` is
 * the key of the current epoch as the caller holds it; a ring key reaches
 * `open` as a copy that is zeroed afterwards, so `open` must finish its work
 * with the key before it returns. `declared` is the epoch the record names
 * (epochOf of its marker): undefined for a record that carries none (a blob,
 * an inbox row, a server row read without its epoch column), and then the
 * current key goes first.
 *
 * Throws KeyEpochUnknown when the record names an epoch this device does not
 * hold and no key opened it; otherwise the current key's own error, as
 * before the ring.
 */
export function openWithRing<T>(kind: KeyKind, currentKey: Uint8Array, open: (key: Uint8Array) => T, declared?: number): T {
  return openWithRingAt(kind, currentKey, open, declared).value;
}

/**
 * openWithRing, and the epoch whose key opened the record. The background
 * pass reads it for a record that names no epoch (a blob): opened by the
 * current key, it is already current; by a ring key, it is rewritten.
 * Spec: docs/internal/plans/phrase-change.md (6.4)
 */
export function openWithRingAt<T>(kind: KeyKind, currentKey: Uint8Array, open: (key: Uint8Array) => T, declared?: number): { value: T; epoch: number } {
  if (declared !== undefined && declared > current) noteAccountEpoch(declared);
  let currentErr: unknown;
  for (const e of readingOrder(declared)) {
    if (e === current) {
      try {
        return { value: open(currentKey), epoch: e };
      } catch (err) {
        currentErr = err;
      }
      continue;
    }
    const copy = new Uint8Array(ring.get(e)![kind]);
    try {
      return { value: open(copy), epoch: e };
    } catch {
      /* the next key */
    } finally {
      copy.fill(0);
    }
  }
  if (declared !== undefined && !holdsEpoch(declared)) throw new KeyEpochUnknown(declared);
  throw currentErr;
}
