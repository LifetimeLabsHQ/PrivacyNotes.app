/**
 * The pending store: the login edits and site passkeys this browser sent to
 * the Vault that the copy does not show yet, so they show at once. It is a
 * cache, never the only copy: a passkey is written here only after its inbox
 * row is on the server (P24), so `forgetLocal()` clearing it loses nothing.
 *
 * Encrypted with the logins key P under additional data bound to the
 * account; re-encrypted while unlocked when the apps move to a new key; a
 * store that does not open is dropped. `allEntries` lays it over the copy.
 * A pending passkey leaves when a pulled copy row holds its credential id. A
 * pending edit leaves when a copy row for its item arrives that the server
 * changed after the post.
 * Spec: docs/contrib/passkeys.md (section 6, Pending store, review 16)
 */
import { browser } from 'wxt/browser';
import { base64ToBytes, bytesToBase64, decryptJsonAad, encryptJsonAad, parseSitePasskey } from '@notes/shared';
import { COPY_VERSION, type CopyEntry, type LoginCopyEntry, type SitePasskey } from '@notes/shared/extension';

export const PENDING_KEY = 'pendingLogins';

/** The five fields the extension edits (P31). */
export type LoginEditSet = Partial<Record<'name' | 'url' | 'username' | 'password' | 'totp', string>>;
const SET_FIELDS = ['name', 'url', 'username', 'password', 'totp'] as const;

export interface PendingEdit {
  /** The inbox row id. */
  row: string;
  /** The login it changes; null for a new login. */
  item: string | null;
  /** When the post was accepted (ms). */
  at: number;
  set: LoginEditSet;
  addPasskeys: SitePasskey[];
  /** The copy entry as the extension saw it, for a login the edit makes. */
  base: { name: string; username: string; url: string };
  /** The queue refused the row for good, so the Vault never got it. Laid
   *  over nothing, and kept until the person dismisses it (beta #130). */
  notSaved?: true;
}

/** An edit without a passkey that never shows up in the copy (a clock far
 *  off, an app that never syncs) stops covering the copy after this long,
 *  counted only once its row has left the queue: while the row waits there,
 *  the edit really has not been sent, and the queue's drop must still find
 *  it to show the not-saved notice (beta #198 item 5). A passkey never
 *  expires here (P24). */
export const PENDING_EDIT_MAX_MS = 7 * 24 * 3600_000;

interface StoredPending {
  tag: string;
  ciphertext: string;
  nonce: string;
  /** Whether it holds a passkey, readable while locked: Disconnect warns,
   *  since the server drops the connection's rows the app has not adopted. */
  passkeys?: boolean;
}

/** Row ids the queue dropped for good, readable while locked; the next
 *  read under P marks their edits not saved (review finding 8, beta #130). */
export const DROPPED_KEY = 'pendingDropped';

const pendingAad = (account: string) => `privacynotes-ext-pending-v1:${account}`;

/** The store under P, or empty: one that does not open is dropped. */
export async function readPending(p: Uint8Array, tag: string, account: string): Promise<PendingEdit[]> {
  const stored = await browser.storage.local.get([PENDING_KEY, DROPPED_KEY]);
  const got = stored[PENDING_KEY] as StoredPending | undefined;
  const dropped = new Set((stored[DROPPED_KEY] as string[] | undefined) ?? []);
  if (!got) return [];
  if (got.tag === tag) {
    let list: PendingEdit[] | null = null;
    try {
      const raw = decryptJsonAad<unknown>(base64ToBytes(got.ciphertext), base64ToBytes(got.nonce), p, pendingAad(account));
      if (Array.isArray(raw)) list = raw.map(parseEdit).filter((e): e is PendingEdit => e !== null);
    } catch {
      // Not under this key.
    }
    if (list) {
      if (!dropped.size) return list;
      const kept = list.map((e): PendingEdit => (dropped.has(e.row) ? { ...e, notSaved: true } : e));
      await writePending(kept, p, tag, account);
      await browser.storage.local.remove(DROPPED_KEY);
      return kept;
    }
  }
  await browser.storage.local.remove([PENDING_KEY, DROPPED_KEY]);
  return [];
}

/** The queue dropped a row for good: the next read marks its edit not saved. */
export async function markPendingDropped(row: string): Promise<void> {
  const list = ((await browser.storage.local.get(DROPPED_KEY))[DROPPED_KEY] as string[] | undefined) ?? [];
  await browser.storage.local.set({ [DROPPED_KEY]: [...list.filter((r) => r !== row), row].slice(-200) });
}

/** Whether the store holds a passkey the copy does not show yet. */
export async function pendingHoldsPasskey(): Promise<boolean> {
  const got = (await browser.storage.local.get(PENDING_KEY))[PENDING_KEY] as StoredPending | undefined;
  return got?.passkeys === true;
}

export async function writePending(list: PendingEdit[], p: Uint8Array, tag: string, account: string): Promise<void> {
  if (!list.length) return void (await browser.storage.local.remove(PENDING_KEY));
  const { ciphertext, nonce } = encryptJsonAad(list, p, pendingAad(account));
  const passkeys = list.some((e) => !e.notSaved && e.addPasskeys.length > 0);
  await browser.storage.local.set({ [PENDING_KEY]: { tag, ciphertext: bytesToBase64(ciphertext), nonce: bytesToBase64(nonce), passkeys } satisfies StoredPending });
}

/** The apps moved to a new key while this browser is unlocked: the store
 *  moves with it. Called with both keys before the old one is forgotten. */
export async function rekeyPending(oldP: Uint8Array, oldTag: string, newP: Uint8Array, newTag: string, account: string): Promise<void> {
  const list = await readPending(oldP, oldTag, account);
  await writePending(list, newP, newTag, account);
}

/** Add one accepted post. */
export async function addPending(edit: PendingEdit, p: Uint8Array, tag: string, account: string): Promise<void> {
  const list = await readPending(p, tag, account);
  await writePending([...list.filter((e) => e.row !== edit.row), edit], p, tag, account);
}

function parseEdit(x: unknown): PendingEdit | null {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.row !== 'string' || !(r.item === null || typeof r.item === 'string') || typeof r.at !== 'number') return null;
  const set: LoginEditSet = {};
  const s = (r.set ?? {}) as Record<string, unknown>;
  for (const f of SET_FIELDS) if (typeof s[f] === 'string') set[f] = s[f] as string;
  const b = (r.base ?? {}) as Record<string, unknown>;
  const base = { name: String(b.name ?? ''), username: String(b.username ?? ''), url: String(b.url ?? '') };
  const addPasskeys = Array.isArray(r.addPasskeys) ? r.addPasskeys.map(parseSitePasskey).filter((p): p is SitePasskey => p !== null) : [];
  return { row: r.row, item: r.item, at: r.at, set, addPasskeys, base, ...(r.notSaved === true ? { notSaved: true as const } : {}) };
}

const passkeysOf = (e: LoginCopyEntry): SitePasskey[] => e.passkeys ?? [];

function withPasskeys(e: LoginCopyEntry, add: SitePasskey[]): LoginCopyEntry {
  if (!add.length) return e;
  const have = new Set(passkeysOf(e).map((p) => p.credentialId));
  return { ...e, passkeys: [...passkeysOf(e), ...add.filter((p) => !have.has(p.credentialId))] };
}

function applySet(e: LoginCopyEntry, set: LoginEditSet): LoginCopyEntry {
  const next = { ...e };
  if (set.name !== undefined) next.name = set.name;
  if (set.username !== undefined) next.username = set.username;
  if (set.password !== undefined) next.password = set.password;
  if (set.totp !== undefined) next.totp = set.totp;
  if (set.url !== undefined) next.urls = set.url ? [set.url, ...e.urls.slice(1)] : e.urls.slice(1);
  return next;
}

/** An edit the Vault never got, as the popup's notice names it. */
export interface NotSavedEdit {
  row: string;
  name: string;
}

/** The not-saved edits, each named by its login in the copy, else by the
 *  name the edit carried. */
export function notSavedEdits(pending: readonly PendingEdit[], entries: readonly CopyEntry[]): NotSavedEdit[] {
  const names = new Map(entries.map((e) => [e.item, e.name]));
  return pending.filter((e) => e.notSaved).map((e) => ({ row: e.row, name: (e.item !== null ? names.get(e.item) : '') || e.set.name || e.base.name }));
}

/** The id a login the extension made shows under until the copy has it. */
export const pendingItemId = (row: string) => `pending:${row}`;
/** A login only this browser shows yet: nothing to edit or add to. */
export const isPendingItem = (item: string) => item.startsWith(pendingItemId(''));

/** A copy login as an edit row's `base` carries it: its first web address
 *  only, since the row takes no other kind. */
export function loginEditBase(login: LoginCopyEntry): { name: string; username: string; url: string } {
  const url = login.urls.find((u) => /^https?:\/\//i.test(u)) ?? '';
  return { name: login.name.slice(0, 1000), username: login.username.slice(0, 1000), url };
}

/**
 * The copy with the pending store laid over it, and the edits that still
 * wait. `changedAt` gives, per item, when the server last changed its copy
 * row (ms; absent for a row pulled before the times were kept); `syncedAt`
 * when the last pull ended, on the server's clock. An edit whose login is
 * gone from a copy pulled after the post leaves, passkeys and all.
 * `queued`: the row ids still in this browser's queue, unsent.
 */
export function overlayPending(entries: CopyEntry[], pending: readonly PendingEdit[], changedAt: ReadonlyMap<string, number>, now: number, syncedAt = 0, queued: ReadonlySet<string> = new Set()): { entries: CopyEntry[]; kept: PendingEdit[] } {
  const inCopy = new Set<string>();
  for (const e of entries) if (e.kind === 'login') for (const p of passkeysOf(e)) inCopy.add(p.credentialId);
  const kept: PendingEdit[] = [];
  const byItem = new Map(entries.map((e, i) => [e.item, i]));
  const out = [...entries];
  for (const edit of pending) {
    // Never reached the Vault: the copy keeps its values, the notice stays.
    if (edit.notSaved) {
      kept.push(edit);
      continue;
    }
    if (edit.item !== null && !byItem.has(edit.item) && syncedAt > edit.at) continue;
    const addPasskeys = edit.addPasskeys.filter((p) => !inCopy.has(p.credentialId));
    const arrived = edit.item !== null && (changedAt.get(edit.item) ?? 0) > edit.at;
    const expired = edit.item !== null && !addPasskeys.length && !queued.has(edit.row) && now - edit.at > PENDING_EDIT_MAX_MS;
    const set = arrived || expired ? {} : edit.set;
    // A new login waits only for its passkeys; an edit for its fields and passkeys.
    if (!addPasskeys.length && (edit.item === null || !Object.keys(set).length)) continue;
    const left = { ...edit, set, addPasskeys };
    kept.push(left);
    const at = edit.item !== null ? byItem.get(edit.item) : undefined;
    const target = at !== undefined ? out[at] : undefined;
    if (target && target.kind === 'login') {
      out[at!] = withPasskeys(applySet(target, set), addPasskeys);
    } else {
      // A new login, or an edit whose login is gone: the app makes a new one.
      const made: LoginCopyEntry = {
        v: COPY_VERSION,
        kind: 'login',
        item: pendingItemId(edit.row),
        name: edit.base.name,
        pinned: false,
        username: edit.base.username,
        password: '',
        totp: '',
        urls: edit.base.url ? [edit.base.url] : [],
      };
      out.push(withPasskeys(applySet(made, edit.set), addPasskeys));
    }
  }
  return { entries: out, kept };
}
