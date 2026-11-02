/**
 * Save a clip or a login: seal it in the background, queue it, send it. The
 * popup hands the clip over at once and may close; nothing is lost. Save is
 * answered only after the sealed rows are stored.
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.3 and 3.4, step 6)
 */
import { browser } from 'wxt/browser';
import { base64ToBytes } from '@notes/shared';
import {
  hashHex,
  packInboxPicture,
  padInboxJson,
  sealInbox,
  type InboxClip,
  type InboxKind,
  type InboxLogin,
} from '@notes/shared/extension';
import type { Clip } from '@notes/clipper';
import { readConnection, type Connection } from './connection';
import { enqueue, flashBadge, flush, type Queued } from './queue';
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
    payload: sealInbox(plain, base64ToBytes(connection.inboxPublic), { account: connection.account, id, kind }),
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
