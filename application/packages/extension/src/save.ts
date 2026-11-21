/**
 * Save a clip or a login: seal it in the background, queue it, send it. The
 * popup hands the clip over at once and may close; nothing is lost. Save is
 * answered only after the sealed rows are stored.
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.3 and 3.4, step 6)
 */
import { browser } from 'wxt/browser';
import {
  hashHex,
  inboxNoteTitle,
  loginEditProof,
  packInboxPicture,
  parseInboxNote,
  padInboxJson,
  type InboxClip,
  parseInboxLoginEdit,
  type InboxKind,
  type InboxLogin,
  type InboxLoginEdit,
  type InboxNote,
} from '@notes/shared/extension';
import { inboxNoteFits, type Clip } from '@notes/clipper';
import { serverClock } from './api';
import { readConnection, sealRow, type Connection } from './connection';
import { acceptedAt, enqueue, flashBadge, flush, postNow, type Queued } from './queue';
import { countPasskeys, lastPullAt, loginsKey } from './logins';
import { addPending } from './pending';
import { fetchPictures } from './pictures';

export type SaveRequest =
  | { mode: 'note' | 'selection'; url: string; title: string; clip: Clip; pictures: boolean }
  | { mode: 'bookmark'; url: string; title: string };

export type SaveResult =
  /** `tooLong`: the page did not fit one row and was saved as a bookmark. */
  | { state: 'sent' | 'queued'; failedPictures: number; tooLong?: boolean }
  | { state: 'full' | 'notConnected' | 'notAllowed' | 'revoked' | 'failed' };

function seal(connection: Connection, kind: InboxKind, id: string, plain: Uint8Array): Queued {
  return {
    id, kind, group: id,
    payload: sealRow(connection, kind, id, plain),
  };
}

// Spec: docs/internal/plans/browser-extension-build.md (section 4, 1.5 MiB a row)
const ROW_MAX = 1572864;

async function sendRows(rows: Queued[], group: string): Promise<'sent' | 'queued' | 'full' | 'revoked' | 'failed'> {
  if (!(await enqueue(rows))) return 'full';
  const result = await flush();
  if (result.revoked) return 'revoked';
  if (result.dropped.includes(group)) return 'failed';
  return result.sent.includes(group) ? 'sent' : 'queued';
}

export async function saveClip(req: SaveRequest): Promise<SaveResult> {
  const connection = await readConnection();
  if (!connection) return { state: 'notConnected' };
  if (!connection.clips) return { state: 'notAllowed' };
  const clipId = crypto.randomUUID();
  const rows: Queued[] = [];
  let pictureIds: (string | null)[] = [];
  let failedPictures = 0;
  if (req.mode !== 'bookmark' && req.pictures && req.clip.images.length) {
    const pictures = await fetchPictures(req.clip.images.map((i) => i.src));
    pictureIds = pictures.map((pic) => {
      if (!pic) {
        failedPictures += 1;
        return null;
      }
      const id = crypto.randomUUID();
      const row = seal(connection, 'picture', id, packInboxPicture({ v: 1, id, clip: clipId, type: pic.type, size: pic.bytes.length }, pic.bytes));
      if (row.payload.length > ROW_MAX) {
        failedPictures += 1;
        return null;
      }
      rows.push({ ...row, group: clipId });
      return id;
    });
  }
  const payload: InboxClip = {
    v: 1,
    id: clipId,
    mode: req.mode,
    url: req.url,
    title: req.title.slice(0, 1000),
    ...(req.mode === 'bookmark' ? {} : { clip: req.clip, pictures: pictureIds }),
    clippedAt: new Date().toISOString(),
  };
  const clipRow = seal(connection, 'clip', clipId, padInboxJson(payload));
  // A clip that fits a note can still outgrow a row once it is JSON and
  // sealed (quotes and line breaks escape): the bookmark stands in.
  if (clipRow.payload.length > ROW_MAX) {
    const bookmark = await saveClip({ mode: 'bookmark', url: req.url, title: req.title });
    return bookmark.state === 'sent' || bookmark.state === 'queued' ? { ...bookmark, tooLong: true } : bookmark;
  }
  rows.push(clipRow);
  try {
    const state = await sendRows(rows, clipId);
    if (state === 'sent' || state === 'queued') {
      await markSaved(req.url);
      if (state === 'sent') await flashBadge('saved');
      return { state, failedPictures };
    }
    return { state };
  } catch (err) {
    console.warn('[privacynotes] save failed:', err instanceof Error ? err.message : 'unknown');
    return { state: 'failed' };
  }
}

export type LoginRequest = Omit<InboxLogin, 'v' | 'id'>;

export async function saveLogin(req: LoginRequest): Promise<SaveResult> {
  const connection = await readConnection();
  if (!connection) return { state: 'notConnected' };
  if (!connection.logins) return { state: 'notAllowed' };
  const id = crypto.randomUUID();
  const payload: InboxLogin = { v: 1, id, ...req };
  try {
    const state = await sendRows([seal(connection, 'login', id, padInboxJson(payload))], id);
    return state === 'sent' || state === 'queued' ? { state, failedPictures: 0 } : { state };
  } catch {
    return { state: 'failed' };
  }
}

export type LoginEditRequest = Omit<InboxLoginEdit, 'v' | 'id' | 'queuedAt'> & {
  /** A site passkey: the row must reach the server now, or nothing is made
   *  (P24); never left in the queue. */
  mustSend?: boolean;
};

/** `unknown`: a row that must reach the server now got no answer in its
 *  time, so the server may have taken it (`postNow`, beta #125). */
export type LoginEditResult = { state: 'sent' | 'queued' } | { state: 'invalid' | 'full' | 'notConnected' | 'notAllowed' | 'revoked' | 'failed' | 'unknown' };

/**
 * A change to a login, or a new login with a site passkey: the inbox kind
 * `loginedit`, with the logins permission. Checked with the app's own shape
 * check before it is sealed. Once the row is sent (or, for an edit without
 * a passkey, queued) it goes into the pending store, so the popup shows it
 * before the next pull.
 * Spec: docs/contrib/passkeys.md (sections 5.4 Saving and 6)
 */
export async function saveLoginEdit(req: LoginEditRequest): Promise<LoginEditResult> {
  const connection = await readConnection();
  if (!connection) return { state: 'notConnected' };
  if (!connection.logins) return { state: 'notAllowed' };
  const id = crypto.randomUUID();
  const { mustSend, ...fields } = req;
  // The queue time, sealed in the row and kept as the queue's `at`
  // (beta #140 item 1).
  const queuedAt = Date.now();
  const edit = parseInboxLoginEdit({ v: 1, id, ...fields, queuedAt }, id);
  if (!edit) return { state: 'invalid' };
  const key = await loginsKey();
  // A change to a login that exists carries the proof that this extension
  // was unlocked; without it the app makes a new login (section 16, finding 1).
  if (edit.item) {
    if (!key) return { state: 'failed' };
    edit.proof = { tag: key.tag, mac: loginEditProof(key.p, key.account, id, edit.item) };
  }
  const row = seal(connection, 'loginedit', id, padInboxJson(edit));
  if (row.payload.length > ROW_MAX) return { state: 'invalid' };
  // A row that may wait in the queue carries the server's time from before
  // it, so its age is counted on the server's clock (queue.ts, beta #129).
  // The newest server answer, not the last completed pull: an old pull with
  // a fresh unlock would date the row past the 80 days (410 too_old).
  const since = mustSend ? undefined : Math.max((await serverClock()) ?? 0, (await lastPullAt()) ?? 0) || undefined;
  if (since !== undefined) row.since = since;
  row.at = queuedAt;
  try {
    const state = mustSend ? await postNow(row) : await sendRows([row], id);
    if (state !== 'sent' && state !== 'queued') return { state };
    if (key) {
      await addPending({
        row: id,
        item: edit.item ?? null,
        // The server's clock where it answered; a queued row's own time
        // otherwise, which a later change of its login still passes.
        at: acceptedAt(id) ?? Date.now(),
        set: edit.set,
        addPasskeys: edit.addPasskeys,
        base: edit.base ?? { name: edit.set.name ?? '', username: edit.set.username ?? '', url: edit.set.url ?? '' },
      }, key.p, key.tag, key.account).catch(() => undefined);
      // A locked door reads the count: the passkey just saved must be in it
      // before the next pull.
      if (edit.addPasskeys.length) await countPasskeys().catch(() => undefined);
    }
    return { state };
  } catch {
    return { state: 'failed' };
  }
}

export interface NoteRequest {
  /** Empty: the first heading or line of the text, as `privacynotes save`. */
  title: string;
  markdown: string;
  tags: string[];
}

export type NoteResult = { state: 'sent' | 'queued' } | { state: 'tooLong' | 'full' | 'notConnected' | 'notAllowed' | 'revoked' | 'failed' };

/**
 * A note typed in the popup: sealed as the inbox kind `note`, with `from`
 * set so the app puts it at the root, not in the Agent folder. It needs the
 * clips permission, not the vault unlock, and waits in the queue offline.
 * Spec: docs/internal/plans/quick-note-694.md (section 4.2)
 */
export async function saveNote(req: NoteRequest): Promise<NoteResult> {
  const connection = await readConnection();
  if (!connection) return { state: 'notConnected' };
  if (!connection.clips) return { state: 'notAllowed' };
  const id = crypto.randomUUID();
  const title = req.title.trim() || inboxNoteTitle(req.markdown);
  const note: InboxNote = { v: 1, id, title, markdown: req.markdown, tags: [...new Set(req.tags)], savedAt: new Date().toISOString(), from: 'browser' };
  // The app runs the same check: a note it would refuse is never sent.
  if (!parseInboxNote(note, id) || !inboxNoteFits(note.markdown)) return { state: 'tooLong' };
  const row = seal(connection, 'note', id, padInboxJson(note));
  if (row.payload.length > ROW_MAX) return { state: 'tooLong' };
  try {
    const state = await sendRows([row], id);
    if (state === 'sent') await flashBadge('saved');
    return { state };
  } catch {
    return { state: 'failed' };
  }
}

// ── Saved pages ────────────────────────────────────────────────────

const SAVED_KEY = 'saved';
const SAVED_MAX = 2000;

/** A page address as one key: no fragment. Stored as a hash, never in the clear. */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return hashHex(new TextEncoder().encode(u.href));
  } catch {
    return hashHex(new TextEncoder().encode(url));
  }
}

async function markSaved(url: string): Promise<void> {
  const saved = ((await browser.storage.local.get(SAVED_KEY))[SAVED_KEY] as Record<string, string> | undefined) ?? {};
  saved[pageKey(url)] = new Date().toISOString();
  const keys = Object.keys(saved);
  if (keys.length > SAVED_MAX) {
    for (const k of keys.sort((a, b) => saved[a]!.localeCompare(saved[b]!)).slice(0, keys.length - SAVED_MAX)) delete saved[k];
  }
  await browser.storage.local.set({ [SAVED_KEY]: saved });
}

/** When this browser last saved the page, or null. */
export async function savedOn(url: string): Promise<string | null> {
  const saved = ((await browser.storage.local.get(SAVED_KEY))[SAVED_KEY] as Record<string, string> | undefined) ?? {};
  return saved[pageKey(url)] ?? null;
}
