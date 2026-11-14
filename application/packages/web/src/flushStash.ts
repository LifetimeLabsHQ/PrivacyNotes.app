import { getNote, updateNoteFrom } from './notesRepo';
import type { LocalNote } from './db';
import { sealedWritesOn } from './localSeal';
import { localDataKeyCopy } from './localKey';
import { currentKeyEpoch, epochMarker, epochOf, holdsEpoch, KeyEpochUnknown, openWithRing } from './keyRing';
import {
  encryptJsonAad,
  decryptJsonAad,
  bytesToBase64,
  bytesToHex,
  base64ToBytes,
} from '@notes/shared';
import { logAuthEvent } from './authDiag';
import { credentialKey, isDemoMode } from './demo';
import { readStringList } from './localStore';

/**
 * Last-chance durable copy of an in-flight body edit.
 *
 * The editor's beforeunload/pagehide flush hands the serialized markdown
 * to the async save pipeline, but a tab closed within the debounce
 * window (~300 ms after the last keystroke) dies before the IndexedDB
 * write commits and the edit is lost. localStorage writes are
 * synchronous and survive page death, so the flush stashes the body
 * here and the next boot folds it back in.
 *
 * Two slots, so a fresh stash and a kept text never compete. Only the
 * flush writes the fresh slot. A stash its note refuses at boot (the note
 * is read-only) moves to the kept slot, and the fresh slot is free again
 * for the next close. A refused text left in the fresh slot, protected
 * from being overwritten, would instead let one note that stays read-only
 * switch the last-chance copy off for every other note on the device,
 * with nothing to show it. The kept slot holds ONE text: when a second
 * note refuses its stash, the newer refusal replaces the text kept before
 * it, and a breadcrumb says so. A kept text that cannot be saved (storage
 * is full) is dropped with a breadcrumb, never kept in a weaker form.
 *
 * Three shapes coexist, and the versioning is load-bearing for rollback
 * safety:
 *  - legacy: { noteId, body, at } - plaintext, what reader-mode builds
 *    write and every already-shipped reader validates via
 *    `typeof body === 'string'`.
 *  - v2:     { v: 2, noteId, sealed: "<b64 nonce>:<b64 ct>", at } - what
 *    sealed-writer builds write. It deliberately has NO `body` field,
 *    so every older reader discards it instead of folding base64 in as
 *    note content. This reader accepts both: the legacy shape is
 *    honored once (the last pre-writer session's in-flight edit must
 *    not be dropped on upgrade day).
 *  - v3:     the same envelope, written only to the kept slot by a boot
 *    whose note refused the text. Its sealed payload is [text,
 *    fingerprint of the body the refusal saw], under its own AAD, and it
 *    has no `body` field either, so every older reader discards it too.
 *  - v4:     the fresh slot's envelope when the open editor said what body
 *    it was showing. Its sealed payload is [text, mark of that body], under
 *    its own AAD, with no `body` field, and older readers know v2 and v3
 *    only, so they discard it rather than misread the pair as text.
 * The seal runs synchronously (noble), which is what makes sealing
 * possible inside pagehide at all.
 *
 * Every sealed shape carries the key epoch `e` of the local key that sealed
 * it (keyRing.ts), none for epoch 1, so an account that never changed its
 * phrase writes the slots as before. A stash opens with the key of its own
 * epoch. A stash of an epoch this device holds no key for is not damaged,
 * and dropping it would lose the typing it holds: it moves to a third slot,
 * the waiting list, which no close writes, and stays there until a boot
 * holds its key or its note is gone from this device.
 * Spec: docs/internal/plans/phrase-change.md (6.2, flush stash; 6.6)
 *
 * Which rule decides. A stash is written while the page is being torn
 * down, when the stored row cannot be read. What the page still knows is
 * the body the editor was showing before the typing it stashes, so a v4
 * stash applies while the row still holds that body, decided inside the
 * replay write. The save a stash covers removes it once it commits, so a
 * stash still there at boot holds typing that never reached the row, and a
 * later revert to the body before it cannot bring it back. A row that holds
 * another body was either written again after the stash (it is newer, and
 * the stash is dropped) or rewritten under the editor by a pull of another
 * device's version, which carries that device's older stamp (#497): there
 * the typed text is kept as a "(conflict)" copy and the pulled version
 * stays. A v2 stash, written with no editor behind it, applies only when it
 * is newer than the stored note. A read-only note refuses the text, and
 * turning read-only off moves the note's stamp past the stash, so a refusal
 * seals the fingerprint in and the stamps stop deciding: the text applies
 * while the note still holds the body the refusal saw, and is dropped once
 * anybody has changed it, because applying it then would overwrite that
 * change. Reader mode seals nothing, so there a refused stash is kept as it
 * was written, under the stamp rule.
 *
 * Spec: docs/internal/specs/local-at-rest.md (section 3.4, flushStash)
 */

// Demo-bucketed like the credential keys: `?demo=1` runs on the same
// origin as a real install, and the demo must never fold in, overwrite
// or drop the real account's pending edit or kept text.
export const STASH_KEY = credentialKey('privacynotes.flushStash');
export const KEPT_STASH_KEY = credentialKey('privacynotes.flushStash.kept');
/** Stashes sealed under a key epoch this device holds no key for yet: a JSON
 *  list of the stashes as they were stored, oldest first. Only a boot writes
 *  it. Spec: docs/internal/plans/phrase-change.md (6.2, flush stash) */
const WAITING_STASH_KEY = credentialKey('privacynotes.flushStash.waiting');
/** The waiting list keeps this many stashes; a longer one loses its oldest. */
const WAITING_MAX = 8;
const STASH_AAD_PREFIX = 'pn-local-v1:stash:';
const KEPT_AAD_PREFIX = 'pn-local-v1:stash-kept:';
const BASED_AAD_PREFIX = 'pn-local-v1:stash-based:';

/** Refuse to stash absurdly large bodies rather than risk a quota throw
 *  during page teardown. Matches the adaptive-debounce ceiling. */
const MAX_STASH_BYTES = 2_000_000;

type Stash = { v?: number; noteId?: string; body?: string; sealed?: string; at?: string; tab?: string; seq?: number; e?: unknown };

/** `"<b64 nonce>:<b64 ct>"` under the local key, or null when none is registered. */
function seal(value: unknown, aad: string): string | null {
  const key = localDataKeyCopy();
  if (!key) return null;
  try {
    const { ciphertext, nonce } = encryptJsonAad(value, key, aad);
    return `${bytesToBase64(nonce)}:${bytesToBase64(ciphertext)}`;
  } finally {
    key.fill(0);
  }
}

/** First 16 bytes of the body's SHA-256, as hex. It only ever travels inside
 *  a sealed stash, never beside one, so a reader of this device's storage
 *  learns nothing about the note from it. */
async function fingerprint(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return bytesToHex(new Uint8Array(digest, 0, 16));
}

/**
 * A mark of a body, to tell at boot whether a row still holds the body the
 * editor was showing. Synchronous, because it runs inside pagehide; it only
 * ever travels inside a sealed stash, and two different bodies of one note
 * sharing a mark is a 1 in 2^53 chance with nobody to aim for it.
 */
function bodyMark(body: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < body.length; i++) {
    const ch = body.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${body.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** The body the open editor of a note shows before its pending typing, as
 *  useNoteEditing knows it; undefined when no editor of the note is known. */
let editorBaseOf: (noteId: string) => string | undefined = () => undefined;

/** useNoteEditing tells the stash where to read the editor's body, and takes
 *  that back (null) when it unmounts. */
export function setEditorBaseLookup(lookup: ((noteId: string) => string | undefined) | null): void {
  editorBaseOf = lookup ?? (() => undefined);
}

/** The body the open editor of a note last loaded or wrote, or undefined
 *  when no editor of the note is known. A sync pass reads it to tell a pull
 *  that rewrote the row from the editor's own save (useSyncOrchestrator). */
export function openEditorBody(noteId: string): string | undefined {
  return editorBaseOf(noteId);
}

/** This tab, and the number of the newest stash it wrote. A save reads the
 *  number before its write (stashGeneration), and once that write commits it
 *  settles only a stash of this tab numbered at or below it: a stash written
 *  after the save started holds typing the save does not. */
const TAB_ID = Math.random().toString(36).slice(2);
let stashCount = 0;

export function stashGeneration(): number {
  return stashCount;
}

export function stashPendingEdit(noteId: string, body: string): void {
  // The demo keeps nothing once its tab closes, so it has nothing to stash.
  if (isDemoMode()) return;
  if (body.length > MAX_STASH_BYTES) return;
  const stamp = { at: new Date().toISOString(), tab: TAB_ID, seq: ++stashCount };
  try {
    if (sealedWritesOn()) {
      const base = editorBaseOf(noteId);
      const sealed = base === undefined
        ? seal(body, `${STASH_AAD_PREFIX}${noteId}`)
        : seal([body, bodyMark(base)], `${BASED_AAD_PREFIX}${noteId}`);
      if (!sealed) {
        // Teardown after sign-out zeroed the key: skip rather than
        // write plaintext. Losing one in-flight edit on that edge is
        // the pre-stash world; writing plaintext would defeat the seal.
        logAuthEvent('seal:stash-skipped-no-key');
        return;
      }
      localStorage.setItem(
        STASH_KEY,
        JSON.stringify({ v: base === undefined ? 2 : 4, noteId, sealed, ...stamp, ...epochMarker() }),
      );
      return;
    }
    localStorage.setItem(
      STASH_KEY,
      JSON.stringify({ noteId, body, ...stamp })
    );
  } catch {
    /* quota or private-mode failure - the async save path may still win */
  }
}

/**
 * Forget the fresh stash when it holds this note: the editor that wrote it
 * was found behind its row (a save of another device's version arrived), so
 * replaying it at the next boot would put the old text back over that
 * version (#497). The note id sits beside the sealed text, so no key is
 * needed to tell.
 */
export function dropPendingEdit(noteId: string): void {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (raw && (JSON.parse(raw) as { noteId?: string }).noteId === noteId) localStorage.removeItem(STASH_KEY);
  } catch {
    /* unreadable slot: the boot settle drops it on its own */
  }
}

/**
 * A save of this note committed, one that started when this tab's stash
 * count stood at `upTo`. A stash of this tab numbered at or below it holds
 * typing that save carries, so it has done its job and goes, and can never
 * replay later over a body the note reached after it (a revert to the text
 * before it reads as the row the stash expects). A stash written after the
 * save started, or by another tab, stays.
 */
export function settlePendingEdit(noteId: string, upTo: number): void {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (!raw) return;
    const stash = JSON.parse(raw) as Stash;
    if (stash.noteId === noteId && stash.tab === TAB_ID && typeof stash.seq === 'number' && stash.seq <= upTo) {
      localStorage.removeItem(STASH_KEY);
    }
  } catch {
    /* unreadable slot: the boot settle drops it on its own */
  }
}

/** Read one slot, clearing it first when asked: the fresh slot is cleared
 *  before anything opens what it held, so a stash that fails on every boot
 *  cannot come back on every boot. */
function readSlot(slot: string, clear: boolean): string | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(slot);
  } catch {
    return null;
  }
  if (raw && clear) {
    try {
      localStorage.removeItem(slot);
    } catch {
      /* ignore */
    }
  }
  return raw;
}

/** The waiting list as stored; an unreadable list reads as empty. */
function readWaiting(): string[] {
  return readStringList(WAITING_STASH_KEY);
}

/** Store the waiting list when it changed; false when the storage refused
 *  the write, which leaves the list as it was. */
function writeWaiting(before: string[], next: string[]): boolean {
  const list = [...new Set(next)];
  if (list.length > WAITING_MAX) {
    list.splice(0, list.length - WAITING_MAX);
    logAuthEvent('seal:stash-wait-dropped');
  }
  if (list.length === before.length && list.every((s, i) => s === before[i])) return true;
  try {
    if (list.length === 0) localStorage.removeItem(WAITING_STASH_KEY);
    else localStorage.setItem(WAITING_STASH_KEY, JSON.stringify(list));
    return true;
  } catch {
    logAuthEvent('seal:stash-wait-lost');
    return false;
  }
}

/** Keeps a stashed text as a copy of the note it was typed into, beside the
 *  version the note holds now. Resolves true once the copy exists. */
type KeepCopy = (note: LocalNote, text: string) => Promise<boolean>;

/** The text a stash holds and what is sealed beside it (the mark of v4, the
 *  fingerprint of v3), or null when it cannot be opened: a shape this build
 *  does not know, no key, or a seal that does not open (wrong account's key,
 *  or corruption, which leaves a breadcrumb). `waits`: sealed under a key
 *  epoch this device holds no key for yet, so the stash keeps its slot. */
function openStash(stash: Stash): [string, string?] | null | 'waits' {
  if (typeof stash.body === 'string') {
    // Legacy plaintext shape - written by reader-mode builds, and
    // honored exactly once so the last pre-writer session's in-flight
    // edit survives the upgrade boot.
    return [stash.body];
  }
  if (!((stash.v === 2 || stash.v === 3 || stash.v === 4) && stash.sealed && stash.noteId)) return null;
  const key = localDataKeyCopy();
  if (!key) return null;
  try {
    const [n = '', ct = ''] = stash.sealed.split(':');
    const prefix = stash.v === 3 ? KEPT_AAD_PREFIX : stash.v === 4 ? BASED_AAD_PREFIX : STASH_AAD_PREFIX;
    const aad = `${prefix}${stash.noteId}`;
    const payload = openWithRing('local', key, (k) => decryptJsonAad<string | [string, string]>(base64ToBytes(ct), base64ToBytes(n), k, aad), epochOf(stash.e));
    return stash.v === 2 ? [payload as string] : (payload as [string, string]);
  } catch (err) {
    if (err instanceof KeyEpochUnknown) {
      logAuthEvent('seal:stash-waits-epoch');
      return 'waits';
    }
    logAuthEvent('seal:stash-open-failed');
    return null;
  } finally {
    key.fill(0);
  }
}

/** A stored stash sealed again under the current local key, or null when it
 *  needs nothing: plain, already current, of an epoch this device holds no
 *  key for, or a shape this build does not know. */
function resealStash(raw: string): string | null {
  let stash: Stash;
  try {
    stash = JSON.parse(raw) as Stash;
  } catch {
    return null;
  }
  if (!((stash.v === 2 || stash.v === 3 || stash.v === 4) && stash.sealed && stash.noteId)) return null;
  const epoch = epochOf(stash.e);
  if (epoch === currentKeyEpoch() || !holdsEpoch(epoch)) return null;
  const key = localDataKeyCopy();
  if (!key) return null;
  try {
    const [n = '', ct = ''] = stash.sealed.split(':');
    const prefix = stash.v === 3 ? KEPT_AAD_PREFIX : stash.v === 4 ? BASED_AAD_PREFIX : STASH_AAD_PREFIX;
    const aad = `${prefix}${stash.noteId}`;
    const payload = openWithRing('local', key, (k) => decryptJsonAad<unknown>(base64ToBytes(ct), base64ToBytes(n), k, aad), epoch);
    const sealed = seal(payload, aad);
    if (!sealed) return null;
    const rest: Stash = { ...stash };
    delete rest.e;
    return JSON.stringify({ ...rest, sealed, ...epochMarker() });
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

/**
 * The kept slot and the waiting list, sealed again under the current local
 * key after a phrase change. Each is written only over the text this read,
 * so a boot that settled a slot meanwhile is not undone. The fresh slot is
 * left alone: only a closing page writes it, and the next boot settles it
 * through the ring. Spec: docs/internal/plans/phrase-change.md (6.4, item 1)
 */
export function resealStashSlots(): void {
  if (isDemoMode() || !sealedWritesOn()) return;
  try {
    const kept = localStorage.getItem(KEPT_STASH_KEY);
    const next = kept ? resealStash(kept) : null;
    if (next && localStorage.getItem(KEPT_STASH_KEY) === kept) localStorage.setItem(KEPT_STASH_KEY, next);
  } catch {
    /* the slot stays as it was, and opens through the ring */
  }
  const waiting = readWaiting();
  const resealed = waiting.map((raw) => resealStash(raw) ?? raw);
  if (resealed.every((raw, i) => raw === waiting[i])) return;
  try {
    if (localStorage.getItem(WAITING_STASH_KEY) === JSON.stringify(waiting)) writeWaiting(waiting, resealed);
  } catch {
    /* as above */
  }
}

/** A v4 stash against its note, decided on the row inside the replay write,
 *  so a pull that lands while this boot reads cannot be written over. */
async function settleBased(raw: string, noteId: string, at: string, body: string, mark: string | undefined, keepCopy?: KeepCopy): Promise<'applied' | 'dropped' | { keep: string }> {
  const seen: { row?: LocalNote; verdict: 'same' | 'newer' | 'moved' | 'write' } = { verdict: 'same' };
  // Typed before the crash, so the edit's time is the stash's, not the time
  // this boot replays it.
  const written = await updateNoteFrom(noteId, (current) => {
    seen.row = current;
    // The save it covers landed, or the note is gone.
    if (current.deleted === 1 || current.body === body) return null;
    if (bodyMark(current.body) !== mark) {
      // Written again after the stash, or rewritten under the editor with an
      // older stamp: a pull stored another device's version.
      seen.verdict = current.updatedAt >= at ? 'newer' : 'moved';
      return null;
    }
    seen.verdict = 'write';
    return { body };
  }, { editedAt: at });
  if (written) return 'applied';
  const { row, verdict } = seen;
  if (!row || verdict === 'same' || verdict === 'newer') return 'dropped';
  if (verdict === 'moved') {
    // The pulled version stays, and the typing is kept beside it rather than
    // written over it. A copy that fails keeps the text for the next boot.
    logAuthEvent('seal:stash-kept-as-copy');
    const kept = keepCopy ? await keepCopy(row, body).catch(() => false) : false;
    return kept ? 'dropped' : { keep: raw };
  }
  // Refused: the note is read-only. The text moves to the kept slot,
  // fingerprinted against the body this refusal saw.
  if (sealedWritesOn()) {
    const sealed = seal([body, await fingerprint(row.body)], `${KEPT_AAD_PREFIX}${noteId}`);
    if (sealed) return { keep: JSON.stringify({ v: 3, noteId, sealed, at, ...epochMarker() }) };
  }
  return { keep: raw };
}

/** One stash against its note: written in, dropped, the form to keep, or
 *  `waits` for the key of its epoch. */
async function settle(raw: string, keepCopy?: KeepCopy): Promise<'applied' | 'dropped' | 'waits' | { keep: string }> {
  try {
    const stash = JSON.parse(raw) as Stash;
    if (!stash.noteId || !stash.at) return 'dropped';
    const opened = openStash(stash);
    if (opened === 'waits') {
      // A note gone from this device takes nothing, as below: a waiting
      // stash of an account this device no longer holds does not wait forever.
      try {
        const note = await getNote(stash.noteId);
        if (!note || note.deleted === 1) return 'dropped';
      } catch {
        /* the note is there and does not open yet: it waits with it */
      }
      return 'waits';
    }
    if (!opened) return 'dropped';
    const [body, base] = opened;
    if (stash.v === 4) return await settleBased(raw, stash.noteId, stash.at, body, base, keepCopy);
    const note = await getNote(stash.noteId);
    // The normal case is that the async save DID land (same content),
    // and this is a no-op. A deleted note takes nothing.
    if (!note || note.deleted === 1 || note.body === body) return 'dropped';
    if (base === undefined) {
      if (note.updatedAt >= stash.at) return 'dropped';
    } else if ((await fingerprint(note.body)) !== base) {
      logAuthEvent('seal:stash-superseded');
      return 'dropped';
    }
    // Typed before the crash, so the edit's time is the stash's, not the
    // time this boot replays it. Written only over the row as it was judged
    // above: a pull that landed since is not written over, and the text
    // waits for the next boot, which judges it against that pull.
    const judged = { unchanged: false };
    const written = await updateNoteFrom(stash.noteId, (row) => {
      if (row.body !== note.body || row.updatedAt !== note.updatedAt) return null;
      judged.unchanged = true;
      return { body };
    }, { editedAt: stash.at });
    if (written) return 'applied';
    if (!judged.unchanged) return { keep: raw };
    // Refused: the note is read-only, a flag that can arrive by sync
    // mid-edit. The typed text is kept, fingerprinted against the body
    // this refusal saw the first time and byte for byte after that.
    if (base === undefined && sealedWritesOn()) {
      const sealed = seal([body, await fingerprint(note.body)], `${KEPT_AAD_PREFIX}${stash.noteId}`);
      if (sealed) return { keep: JSON.stringify({ v: 3, noteId: stash.noteId, sealed, at: stash.at, ...epochMarker() }) };
    }
    return { keep: raw };
  } catch {
    return 'dropped';
  }
}

/**
 * Fold stashed edits back into the notes they belong to: the fresh slot
 * first, then the kept one, each by its own rule. Called once at boot,
 * before or alongside the first refresh. Returns true when a note was
 * updated so the caller can refresh the list. `keepCopy` keeps the text of
 * a v4 stash whose note a pull rewrote. Tested in
 * tests/flushStashRefused.test.ts, tests/flushStashBase.test.ts and
 * tests/lockGateWrites.test.ts.
 */
export async function reconcileFlushStash(keepCopy?: KeepCopy): Promise<boolean> {
  // The demo's own buckets are always empty, and the real account's
  // stashes are not the demo's to read.
  if (isDemoMode()) return false;
  const fresh = readSlot(STASH_KEY, true);
  // The kept text stays on disk until this boot knows what becomes of it:
  // it waits across boots by design, and a tab closed mid-boot must not
  // lose it.
  const kept = readSlot(KEPT_STASH_KEY, false);
  // The waiting list, like the kept slot, stays on disk until this boot
  // knows what becomes of each stash in it.
  const waiting = readWaiting();
  let applied = false;
  let keep: string | null = null;
  let displaced = false;
  // The stashes that wait for the key of their epoch, by where they were.
  const waits: string[][] = [[], [], []];
  for (const [slot, raw] of [fresh, kept, ...waiting].entries()) {
    if (!raw) continue;
    const outcome = await settle(raw, keepCopy);
    if (outcome === 'applied') applied = true;
    else if (outcome === 'dropped') continue;
    else if (outcome === 'waits') waits[Math.min(slot, 2)]!.push(raw);
    else if (keep === null) keep = outcome.keep;
    else displaced = true;
  }
  // Oldest first: the list as it was, then the kept text, then the fresh one.
  const listed = writeWaiting(waiting, [...waits[2]!, ...waits[1]!, ...waits[0]!]);
  if (keep === kept) return applied;
  // A kept text that waits leaves its slot only once the list holds it.
  if (!listed && waits[1]!.length > 0) {
    if (keep !== null) logAuthEvent('seal:stash-kept-lost');
    return applied;
  }
  if (keep === null) {
    try {
      localStorage.removeItem(KEPT_STASH_KEY);
    } catch {
      /* ignore */
    }
    return applied;
  }
  try {
    localStorage.setItem(KEPT_STASH_KEY, keep);
    // One text is all the kept slot holds, and the fresh refusal, the
    // newer one, is the text it keeps.
    if (displaced) logAuthEvent('seal:stash-kept-replaced');
  } catch {
    // Storage is full. The new text is dropped rather than kept in a
    // weaker form, and the slot keeps what it held, for the next boot.
    logAuthEvent('seal:stash-kept-lost');
  }
  return applied;
}
