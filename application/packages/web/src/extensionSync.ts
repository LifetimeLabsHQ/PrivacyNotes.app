/**
 * The browser extension, as every app keeps up with it after a sync pass
 * that pulled cleanly: adopt the sealed inbox, and keep the vault copy.
 *
 * Adoption. Each inbox row is hostile until it opens under the inbox key and
 * passes the shape check here. A clip becomes the note, or the bookmark, the
 * in-app clipper makes, through the same `finishClip`; a login becomes a
 * vault login. The item id is derived from the row id (`inboxItemId`), so
 * two apps adopting one row make one item, and a row is deleted only once its
 * item is on the server: pushed, or deleted after a push. A row of an unknown
 * version or kind stays for a newer app.
 *
 * The vault copy. While an extension shows logins, each vault item the
 * extension may show (a login, a credit card, the public half of an SSH key)
 * and each bookmark has a second row in `extension_logins`, sealed under the
 * logins key P: one of the four kinds of `CopyEntry`, with only the fields
 * the extension shows. The pass diffs the vault against what it last wrote,
 * writes what changed, marks what is gone, and rotates P when an extension
 * that held it was removed. It runs only after a completed pull, so a partial
 * view never deletes a row.
 *
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.3 step 5, 3.4)
 */
import {
  base64ToBytes,
  bytesToBase64,
  decryptJsonAad,
  encryptJsonAad,
  phraseToSeed,
  type SupabaseClient,
} from '@notes/shared';
import {
  COPY_VERSION,
  deriveInboxKeyPair,
  deriveLoginsIdKey,
  inboxItemId,
  inboxRowVersion,
  INBOX_VERSION,
  loginsCopyAad,
  loginsFingerprint,
  loginsRowId,
  newLoginsKey,
  openInbox,
  parseCopyEntry,
  parseInboxNote,
  serverHalf,
  unpackInboxPicture,
  type CopyEntry,
  type InboxKind,
  type InboxNote,
} from '@notes/shared/extension';
import { db, notesWriteCount, type LocalNote } from './db';
import { createNote, normalizeTag, updateNote } from './notesRepo';
import { buildLinkBody, buildLinkKeyMap, linkDedupeKey, parseLinkBody } from './linkBody';
import { buildClipNoteMap, clipTrackers } from './clipLink';
import { parseLoginBody, serializeLoginBody } from './loginBody';
import { loginExtrasOf } from './loginExtras';
import { detectCardNetwork, parseCardBody } from './cardBody';
import { parseSshKeyBody, sshKeyFingerprint, sshKeyType } from './sshKeyBody';
import { withoutEntries, type ExtensionKeys } from './extensionKeys';
import { browserHalves, loginsKeyFor, withLoginsKey } from './extensionKeyring';
import { loadExtensionState, rekeyLogins, ExtensionCallError, type ExtensionState } from './extensionApi';
import type { StorePicture } from './clipPage';
import { isDemoMode } from './demo';

// ── The server, as this module needs it ─────────────────────────────

export interface InboxRow {
  id: string;
  kind: string;
  payload: string;
  created_at: string;
}

export interface CopyRow {
  id: string;
  key_tag: string;
  deleted: boolean;
}

export interface CopyWrite {
  id: string;
  key_tag: string;
  ciphertext: string;
  nonce: string;
  deleted: boolean;
}

/** The server calls of one pass, so the sync simulator can run the real pass. */
export interface ExtensionStore {
  /** One page of the inbox, oldest first; `after` continues past the last row of the page before. */
  listInbox(after?: Pick<InboxRow, 'id' | 'created_at'>): Promise<InboxRow[]>;
  deleteInbox(ids: string[]): Promise<void>;
  state(): Promise<ExtensionState>;
  listCopy(): Promise<CopyRow[]>;
  writeCopy(rows: CopyWrite[]): Promise<void>;
  dropCopy(ids: string[]): Promise<void>;
  rekey(oldTag: string, newTag: string | null, ksrv: Record<string, string>): Promise<void>;
  /** Claim rows for this device; returns the ids it may adopt now. */
  claimInbox(ids: string[], deviceId: string): Promise<string[]>;
}

// Spec: docs/internal/plans/browser-extension-build.md (section 4, inbox and copy caps)
const INBOX_PAGE = 100;
// The inbox holds 500 rows at most (extension_inbox_post), so five pages read it all.
const INBOX_PAGES = 5;
const COPY_PAGE = 1000;

export function supabaseExtensionStore(supabase: SupabaseClient, pubkey: string): ExtensionStore {
  const fail = (code: string, error: unknown): void => {
    if (error) throw new ExtensionCallError(code);
  };
  return {
    async listInbox(after) {
      let query = supabase
        .from('extension_inbox')
        .select('id, kind, payload, created_at')
        .eq('user_pubkey', pubkey);
      if (after) query = query.or(`created_at.gt."${after.created_at}",and(created_at.eq."${after.created_at}",id.gt.${after.id})`);
      const { data, error } = await query
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(INBOX_PAGE);
      fail('inbox_read', error);
      return (data ?? []) as InboxRow[];
    },
    async deleteInbox(ids) {
      if (!ids.length) return;
      const { error } = await supabase.from('extension_inbox').delete().eq('user_pubkey', pubkey).in('id', ids);
      fail('inbox_delete', error);
    },
    state: () => loadExtensionState(supabase, pubkey),
    async listCopy() {
      const out: CopyRow[] = [];
      for (let from = 0; ; from += COPY_PAGE) {
        const { data, error } = await supabase
          .from('extension_logins')
          .select('id, key_tag, deleted')
          .eq('user_pubkey', pubkey)
          .order('id', { ascending: true })
          .range(from, from + COPY_PAGE - 1);
        fail('copy_read', error);
        out.push(...((data ?? []) as CopyRow[]));
        if ((data ?? []).length < COPY_PAGE) return out;
      }
    },
    async writeCopy(rows) {
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200).map((r) => ({ ...r, user_pubkey: pubkey }));
        const { error } = await supabase.from('extension_logins').upsert(batch, { onConflict: 'id' });
        fail('copy_write', error);
      }
    },
    async dropCopy(ids) {
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await supabase.from('extension_logins').delete().eq('user_pubkey', pubkey).in('id', ids.slice(i, i + 200));
        fail('copy_delete', error);
      }
    },
    rekey: (oldTag, newTag, ksrv) => rekeyLogins(supabase, oldTag, newTag, ksrv),
    async claimInbox(ids, deviceId) {
      if (!ids.length) return [];
      const { data, error } = await supabase.rpc('extension_inbox_claim', { p_ids: ids, p_device: deviceId });
      fail('inbox_claim', error);
      return Array.isArray(data) ? (data as string[]) : [];
    },
  };
}

export interface ExtensionSyncDeps {
  store: ExtensionStore;
  /** The account's signing public key, hex. */
  pubkey: string;
  inboxSecret: Uint8Array;
  contentKey: Uint8Array;
  readKeys: () => ExtensionKeys;
  saveKeys: (update: (keys: ExtensionKeys) => ExtensionKeys) => void;
  /** Push the settings now; true once the server holds them. */
  pushKeys: () => Promise<boolean>;
  /** This device's id, for the inbox claim. */
  deviceId: string;
  /** False once the sign-in this pass started under has ended: a pass that
   *  outlives a sign-out writes nothing into the next account's data. */
  isCurrent: () => boolean;
  /** How a clip's pictures are stored; the app's own store by default. */
  storePicture?: StorePicture;
  /** The folder a note from the command line goes into: the Agent folder
   *  while it exists, else null (the root). Spec: docs/internal/plans/agent-cli.md (section 3.4) */
  agentFolder?: () => string | null;
  /** Whether a folder id is in the tree: a quick note's folder may be gone
   *  by the time the app opens it. Spec: docs/internal/plans/quick-note-694.md (Q3) */
  hasFolder?: (id: string) => boolean;
  now?: () => number;
}

export interface ExtensionSyncResult {
  /** Items this pass created. */
  adopted: number;
  /** Inbox rows this pass deleted. */
  settled: number;
  /** Copy rows this pass wrote. */
  copied: number;
}

// Most accounts never connect an extension, so the pass asks the server
// whether any is connected at most every 10 minutes, and every pass only
// while one is (or a logins key is still to clean up).
// Spec: docs/internal/plans/browser-extension-build.md (section 3.3 step 5)
const IDLE_CHECK_MS = 10 * 60 * 1000;
let known: { pubkey: string; at: number; state: ExtensionState } | null = null;
let running = false;
let inboxKey: { pubkey: string; secret: Uint8Array } | null = null;

/** The account's inbox secret, derived from the phrase once per sign-in. */
export function inboxSecretOf(pubkey: string, phrase: string): Uint8Array {
  if (inboxKey?.pubkey !== pubkey) inboxKey = { pubkey, secret: deriveInboxKeyPair(phraseToSeed(phrase)).secretKey };
  return inboxKey.secret;
}

/** One pass, never two at once. The demo has no extension and never adopts. */
export async function runExtensionSync(deps: ExtensionSyncDeps): Promise<ExtensionSyncResult> {
  if (isDemoMode() || running) return { adopted: 0, settled: 0, copied: 0 };
  running = true;
  try {
    return await extensionPass(deps);
  } finally {
    running = false;
  }
}

async function extensionPass(deps: ExtensionSyncDeps): Promise<ExtensionSyncResult> {
  const now = deps.now?.() ?? Date.now();
  const active = (st: ExtensionState) => st.extensions.length > 0 || st.keyTag !== null;
  let checked = false;
  if (!known || known.pubkey !== deps.pubkey || active(known.state) || now - known.at > IDLE_CHECK_MS) {
    known = { pubkey: deps.pubkey, at: now, state: await deps.store.state() };
    checked = true;
  }
  // The inbox is read on the 10-minute check even with no extension left:
  // clips posted before the last one was removed still become notes.
  if (!active(known.state) && !checked) return { adopted: 0, settled: 0, copied: 0 };
  const inbox = await adoptInbox(deps);
  const copied = active(known.state) ? await keepLoginsCopy(deps, known.state) : 0;
  return { ...inbox, copied };
}

/** Forget what the last pass learnt, so the next one asks at once (after a
 *  pairing, a Remove, or a sign-out). */
export function resetExtensionSync(): void {
  known = null;
  inboxKey = null;
  lastCopy = null;
}

// ── Adoption ───────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PICTURE_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;
// Spec: docs/internal/specs/web-clipper-stage1.md (section 3.3, 20 pictures and 10 MB a clip)
const MAX_PICTURES = 20;
const MAX_PICTURE_BYTES = 10_000_000;
const MAX_TITLE = 1000;
const MAX_LOGIN_NOTES = 10_000;
const MAX_URL = 4096;
const MAX_MARKDOWN = 700 * 1024;
/** A clip whose pictures have not all arrived waits this long, then saves
 *  without the missing ones. */
const PICTURE_WAIT_MS = 10 * 60 * 1000;

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

function webUrl(v: unknown): string | null {
  if (!isStr(v, MAX_URL)) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

interface ParsedClip {
  mode: 'note' | 'selection' | 'bookmark';
  url: string;
  title: string;
  clip: {
    title: string; byline: string; siteName: string; published: string; description: string;
    markdown: string; images: { src: string; alt: string }[];
  } | null;
  pictures: (string | null)[];
}

/** The shape check of a clip payload. Null refuses it. A note or selection
 *  whose page part fails the check keeps its address: it becomes a bookmark,
 *  so a save the popup confirmed is never lost without a trace. */
export function parseClip(value: unknown, rowId: string): ParsedClip | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.v !== 1 || v.id !== rowId) return null;
  if (v.mode !== 'note' && v.mode !== 'selection' && v.mode !== 'bookmark') return null;
  const url = webUrl(v.url);
  if (!url || !isStr(v.title, MAX_TITLE)) return null;
  const page = v.mode === 'bookmark' ? null : parseClipPage(v);
  if (v.mode === 'bookmark' || !page) return { mode: 'bookmark', url, title: v.title, clip: null, pictures: [] };
  return { mode: v.mode, url, title: v.title, ...page };
}

function parseClipPage(v: Record<string, unknown>): Pick<ParsedClip, 'clip' | 'pictures'> | null {
  const c = v.clip as Record<string, unknown> | null;
  if (!c || typeof c !== 'object') return null;
  for (const k of ['title', 'byline', 'siteName', 'published', 'description']) if (!isStr(c[k], MAX_TITLE)) return null;
  if (!isStr(c.markdown, MAX_MARKDOWN) || !c.markdown.trim()) return null;
  // Only picture tokens may name a picture: a stored one is the app's to place.
  if (c.markdown.includes('pn:img/')) return null;
  // No count limit: the row size (1.5 MiB) bounds the list, and every picture
  // past the first 20 becomes a text link, as in the app.
  if (!Array.isArray(c.images)) return null;
  const images: { src: string; alt: string }[] = [];
  for (const im of c.images as unknown[]) {
    const i = im as { src?: unknown; alt?: unknown } | null;
    const src = webUrl(i?.src);
    if (!src || !isStr(i?.alt, MAX_TITLE)) return null;
    images.push({ src, alt: i!.alt as string });
  }
  const pictures = Array.isArray(v.pictures) ? (v.pictures as unknown[]) : [];
  if (pictures.length > images.length) return null;
  if (pictures.filter((p) => p !== null).length > MAX_PICTURES) return null;
  if (pictures.some((p) => p !== null && !(typeof p === 'string' && UUID.test(p)))) return null;
  return {
    clip: {
      title: c.title as string, byline: c.byline as string, siteName: c.siteName as string,
      published: c.published as string, description: c.description as string, markdown: c.markdown, images,
    },
    pictures: images.map((_, i) => (pictures[i] as string | null | undefined) ?? null),
  };
}

/** The shape check of a picture payload, against the clip that names it. */
export function parsePicture(plain: Uint8Array, rowId: string): { clip: string; type: string; bytes: Uint8Array } | null {
  const got = unpackInboxPicture(plain);
  const h = got?.header as Record<string, unknown> | undefined;
  if (!got || !h || h.v !== 1 || h.id !== rowId || typeof h.clip !== 'string' || !UUID.test(h.clip)) return null;
  if (typeof h.type !== 'string' || !PICTURE_TYPES.test(h.type)) return null;
  return { clip: h.clip, type: h.type, bytes: got.bytes };
}

/** The shape check of a login payload. */
export function parseLogin(
  value: unknown,
  rowId: string,
): { name: string; url: string; username: string; password: string; totp: string; notes: string } | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.v !== 1 || v.id !== rowId) return null;
  if (!isStr(v.name, MAX_TITLE) || !isStr(v.username, MAX_TITLE) || !isStr(v.password, MAX_TITLE)) return null;
  // The 2FA key and the notes came later: absent is empty, anything else must hold.
  const totp = v.totp === undefined ? '' : v.totp;
  const notes = v.notes === undefined ? '' : v.notes;
  if (!isStr(totp, MAX_TITLE) || !isStr(notes, MAX_LOGIN_NOTES)) return null;
  const url = v.url === '' ? '' : webUrl(v.url);
  if (url === null) return null;
  if (!v.username && !v.password) return null;
  return { name: v.name, url, username: v.username, password: v.password, totp, notes };
}

const KNOWN_KINDS = new Set<string>(['clip', 'picture', 'login', 'note']);

/** Whether the item of a row is on the server: pushed, or deleted and the
 *  delete pushed. Only then may the row go. */
function onServer(n: LocalNote | undefined): boolean {
  return !!n && n.dirty === 0 && (n.deleted === 1 || !!n.syncedNonce);
}

/** Every page of the inbox, not only the first: a row that waits (a newer
 *  app's version, another app's claim, a clip's missing picture) must never
 *  hide the rows behind it. The pictures of a clip may sit on the page before. */
async function adoptInbox(deps: ExtensionSyncDeps): Promise<{ adopted: number; settled: number }> {
  const out = { adopted: 0, settled: 0 };
  const pictures = new Map<string, { clip: string; type: string; bytes: Uint8Array }>();
  let after: InboxRow | undefined;
  for (let page = 0; page < INBOX_PAGES; page++) {
    const rows = await deps.store.listInbox(after);
    if (!rows.length) break;
    const got = await adoptPage(deps, rows, pictures);
    out.adopted += got.adopted;
    out.settled += got.settled;
    if (got.stopped || rows.length < INBOX_PAGE || !deps.isCurrent()) break;
    after = rows[rows.length - 1];
  }
  return out;
}

async function adoptPage(
  deps: ExtensionSyncDeps,
  rows: InboxRow[],
  pictures: Map<string, { clip: string; type: string; bytes: Uint8Array }>,
): Promise<{ adopted: number; settled: number; stopped: boolean }> {
  const now = deps.now?.() ?? Date.now();
  const opened = new Map<string, { row: InboxRow; plain: Uint8Array }>();
  const refuse: string[] = [];
  let stopped = false;
  for (const row of rows) {
    // A newer app's row waits for that app.
    if (!KNOWN_KINDS.has(row.kind) || inboxRowVersion(row.payload) !== INBOX_VERSION) continue;
    try {
      const plain = openInbox(row.payload, deps.inboxSecret, { account: deps.pubkey, id: row.id, kind: row.kind as InboxKind });
      opened.set(row.id, { row, plain });
    } catch {
      // A row of a known version that does not open under this account's
      // key is damaged or not ours: it can never become anything.
      refuse.push(row.id);
    }
  }

  for (const [id, { row, plain }] of opened) {
    if (row.kind !== 'picture') continue;
    const p = parsePicture(plain, id);
    if (p) pictures.set(id, p);
    else refuse.push(id);
  }

  // Claim the rows whose item does not exist here yet, so one app builds it;
  // another app's claim lasts 10 minutes.
  const unbuilt: string[] = [];
  for (const [id, { row }] of opened) {
    if (row.kind !== 'picture' && !(await db.notes.get(inboxItemId(deps.inboxSecret, id)))) unbuilt.push(id);
  }
  const mine = new Set(await deps.store.claimInbox(unbuilt, deps.deviceId));

  let adopted = 0;
  const settled: string[] = [];
  const decode = (plain: Uint8Array): unknown => {
    try {
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return null;
    }
  };
  for (const [id, { row, plain }] of opened) {
    if (row.kind === 'picture') continue;
    const itemId = inboxItemId(deps.inboxSecret, id);
    const existing = await db.notes.get(itemId);
    if (row.kind === 'note') {
      const note = parseInboxNote(decode(plain), id);
      if (!note) {
        refuse.push(id);
        continue;
      }
      if (existing) {
        if (onServer(existing)) settled.push(id);
        continue;
      }
      if (!mine.has(id) || !deps.isCurrent()) continue;
      const made = await createInboxNote(note, itemId, deps);
      if (made === 'refused') refuse.push(id);
      else if (made === 'created') adopted += 1;
      continue;
    }
    if (row.kind === 'login') {
      const login = parseLogin(decode(plain), id);
      if (!login) {
        refuse.push(id);
        continue;
      }
      if (existing) {
        if (onServer(existing)) settled.push(id);
        continue;
      }
      if (!mine.has(id) || !deps.isCurrent()) continue;
      const body = serializeLoginBody({ url: login.url, username: login.username, password: login.password, totp: login.totp, notes: login.notes });
      await createNote(login.name || login.url || login.username, body, [], false, 'login', null, { id: itemId, counted: false });
      adopted += 1;
      continue;
    }
    // A picture row names its clip; one that names another clip is not this
    // one's. The rows that name this clip go with it, used or not.
    const rowsOf = [...pictures].filter(([, p]) => p.clip === id).map(([pid]) => pid);
    const clip = parseClip(decode(plain), id);
    if (!clip) {
      refuse.push(id, ...rowsOf);
      continue;
    }
    const own = clip.pictures.filter((p): p is string => p !== null);
    const held = own.map((p) => (pictures.get(p)?.clip === id ? pictures.get(p) : undefined));
    if (existing) {
      if (onServer(existing)) settled.push(id, ...rowsOf);
      continue;
    }
    const waiting = held.some((p) => !p) && now - Date.parse(row.created_at) < PICTURE_WAIT_MS;
    if (waiting || !mine.has(id) || !deps.isCurrent()) continue;
    const outcome = await adoptClip(deps, clip, itemId, held);
    if (outcome === 'stopped') {
      stopped = true;
      break;
    }
    if (outcome === 'created') adopted += 1;
    // Nothing to create: the address is bookmarked already.
    else settled.push(id, ...rowsOf);
  }

  const done = [...new Set([...settled, ...refuse])];
  if (done.length && deps.isCurrent()) await deps.store.deleteInbox(done);
  for (const id of done) pictures.delete(id);
  return { adopted, settled: done.length, stopped };
}

/**
 * Where an inbox note goes. From the command line: the Agent folder. From the
 * extension's New note or the Ninja box: the root, as New note with no folder
 * open, or the folder the box read from the title line while it still exists.
 * Spec: docs/internal/plans/quick-note-694.md (Q3)
 */
function inboxNoteFolder(note: InboxNote, deps: Pick<ExtensionSyncDeps, 'agentFolder' | 'hasFolder'>): string | null {
  if (!note.from) return deps.agentFolder?.() ?? null;
  return note.folder && deps.hasFolder?.(note.folder) ? note.folder : null;
}

/**
 * Make the item of an opened `note` row, or of a quick note the Ninja box
 * queued while the app was locked (quickNoteQueue.ts). `refused`: the body
 * is too long; `stopped`: the sign-in ended first.
 */
export async function createInboxNote(
  note: InboxNote,
  itemId: string,
  deps: Pick<ExtensionSyncDeps, 'agentFolder' | 'hasFolder' | 'isCurrent'>,
): Promise<'created' | 'refused' | 'stopped'> {
  const body = await inboxNoteBody(note.markdown);
  if (body === null) return 'refused';
  const tags = [...new Set(note.tags.map(normalizeTag).filter(Boolean))];
  if (!deps.isCurrent()) return 'stopped';
  await createNote(note.title.trim(), body, tags, false, 'note', inboxNoteFolder(note, deps), { id: itemId, counted: false });
  return 'created';
}

/**
 * The body of a note from the command line, or null when it is too long. The
 * Markdown stands when it is only text and web links; a picture reference,
 * raw HTML or another link scheme makes the whole note plain text, because
 * only the app places a stored picture (the clip's rule in parseClipPage).
 * Spec: docs/internal/plans/agent-cli.md (section 3.4)
 */
async function inboxNoteBody(markdown: string): Promise<string | null> {
  const { bodyFits, isSafeMarkdown, plainMarkdown } = await import('@notes/clipper');
  const safe = !/pn:img\/|pn-clip:/i.test(markdown) && isSafeMarkdown(markdown);
  const body = safe ? markdown : plainMarkdown(markdown);
  return bodyFits(body) ? body : null;
}

/**
 * The clip as the in-app clipper saves it: a bookmark row makes the bookmark,
 * a note row makes only the note, which names its page in `clipSource`
 * (issue 703: a second bookmark item doubled every clip); when the note
 * checks refuse it, the bookmark stands in. `none`: there was nothing to
 * create. `stopped`: the sign-in changed during the build; nothing more is
 * written, nothing settles.
 */
async function adoptClip(
  deps: ExtensionSyncDeps,
  clip: ParsedClip,
  itemId: string,
  held: ({ type: string; bytes: Uint8Array } | undefined)[],
): Promise<'created' | 'none' | 'stopped'> {
  const saveBookmark = async (): Promise<'created' | 'none' | 'stopped'> => {
    const links = await db.notes.where('type').equals('link').toArray();
    const bookmarked = buildLinkKeyMap(links.filter((n) => n.deleted !== 1)).has(linkDedupeKey(clip.url));
    if (!deps.isCurrent()) return 'stopped';
    if (bookmarked) return 'none';
    await createNote(clip.title, buildLinkBody(clip.url), [], false, 'link', null, { id: itemId, counted: false });
    return 'created';
  };
  if (clip.mode === 'bookmark' || !clip.clip) return saveBookmark();
  const { finishClip } = await import('./clipPage');
  // Each picture is stored only while the sign-in is the one that opened the
  // clip; after a change the rest fail and the note is not written.
  const store = deps.storePicture ?? (await import('./EncryptedImage')).storePictureQuietly;
  const storePicture: StorePicture = (file, reserved) =>
    deps.isCurrent() ? store(file, reserved) : Promise.resolve({ failure: 'failed' as const });
  const { clipLabels } = await import('./clipMessages');
  type Held = { bytes: Uint8Array; contentType: string } | { failure: 'skipped' | 'failed' | 'limit' };
  let wanted = 0;
  // The per-clip limits hold whatever the extension sent.
  let bytes = 0;
  const limited = clip.pictures.map((p): Held => {
    if (p === null) return { failure: 'skipped' };
    const got = held[wanted++];
    if (!got) return { failure: 'failed' };
    bytes += got.bytes.length;
    return bytes > MAX_PICTURE_BYTES ? { failure: 'limit' } : { bytes: got.bytes, contentType: got.type };
  });
  try {
    const saved = await finishClip(
      { clip: clip.clip, source: { html: '', url: clip.url }, held: limited, pictureBytes: bytes },
      clipLabels(),
      undefined,
      storePicture,
    );
    if (!deps.isCurrent()) return 'stopped';
    const note = await createNote(saved.title || clip.title, saved.body, [], false, 'note', null, { id: itemId, counted: false });
    if (deps.isCurrent()) await updateNote(note.id, { trackers: clipTrackers(clip.url) }, undefined, { edit: false });
    return 'created';
  } catch {
    // Too long for a note, or unsafe once placed: the bookmark stands in.
    return saveBookmark();
  }
}

// ── The vault copy ─────────────────────────────────────────────────

const FP_KEY = 'privacynotes.extensionLoginsCopy';
/** A browser half younger than this may belong to a code nobody pasted yet. */
const PENDING_HALF_MS = 15 * 60 * 1000;

interface CopyMemo {
  pubkey: string;
  tag: string;
  /** Row id -> a keyed fingerprint of the plaintext last written. */
  fps: Record<string, string>;
}

function readMemo(pubkey: string, tag: string): CopyMemo {
  try {
    const raw = JSON.parse(localStorage.getItem(FP_KEY) ?? 'null') as CopyMemo | null;
    if (raw && raw.pubkey === pubkey && raw.tag === tag && raw.fps && typeof raw.fps === 'object') return raw;
  } catch {
    // A damaged memo rewrites the copy once.
  }
  return { pubkey, tag, fps: {} };
}

function writeMemo(memo: CopyMemo): void {
  try {
    localStorage.setItem(FP_KEY, JSON.stringify(memo));
  } catch {
    // Without the memo the next pass writes again; nothing is lost.
  }
}

/** The vault types the extension shows, and the bookmarks. */
const COPY_TYPES: LocalNote['type'][] = ['login', 'card', 'ssh-key', 'link'];

/**
 * The items the extension may show, as copy entries: not trashed, not
 * deleted, and not behind the app's PIN, which the extension's own PIN does
 * not replace. Each carries only what the extension shows: never an item's
 * notes, a card's billing address, a private key or its passphrase.
 */
async function vaultCopy(): Promise<CopyEntry[]> {
  const rows = (await db.notes.where('type').anyOf(COPY_TYPES).toArray()).filter(
    (n) => n.deleted !== 1 && n.trashed !== 1 && n.pinProtected !== 1,
  );
  // A bookmark names the note its page was clipped into; the notes are read
  // once a pass, and only while there is a bookmark to name one.
  const clipped = rows.some((n) => n.type === 'link')
    ? buildClipNoteMap((await db.notes.toArray()).filter((n) => n.deleted !== 1))
    : new Map<string, LocalNote>();
  const out: CopyEntry[] = [];
  for (const n of rows) {
    const base: Pick<CopyEntry, 'v' | 'item' | 'name' | 'pinned'> = { v: COPY_VERSION, item: n.id, name: n.title, pinned: n.starred === 1 };
    if (n.type === 'login') {
      const l = parseLoginBody(n.body);
      const extra = loginExtrasOf(n.trackers).extraUrls;
      out.push({ ...base, kind: 'login', username: l.username, password: l.password, totp: l.totp, urls: [l.url, ...extra].filter(Boolean) });
    } else if (n.type === 'card') {
      const c = parseCardBody(n.body);
      out.push({ ...base, kind: 'card', holder: c.cardholderName, number: c.cardNumber, expMonth: c.expMonth, expYear: c.expYear, cvv: c.cvv, network: detectCardNetwork(c.cardNumber) });
    } else if (n.type === 'ssh-key') {
      const { publicKey } = parseSshKeyBody(n.body);
      out.push({ ...base, kind: 'ssh', publicKey, fingerprint: await sshKeyFingerprint(publicKey), keyType: sshKeyType(publicKey) });
    } else {
      const { url } = parseLinkBody(n.body);
      out.push({ ...base, kind: 'bookmark', url, note: (url && clipped.get(linkDedupeKey(url))?.id) || null, savedAt: n.createdAt });
    }
  }
  return out;
}

/**
 * The vault the last full copy read: while no note was written in this tab
 * and the server rows still match the memo, a new copy would write nothing,
 * so the vault is not read again. Reading every note each pass (every 30 s)
 * grew the desktop app's memory all day (issue #643). A full copy still runs
 * every ten minutes, for writes made in another tab.
 */
let lastCopy: { pubkey: string; tag: string; writes: number; at: number } | null = null;
const FULL_COPY_MS = 10 * 60_000;

async function keepLoginsCopy(deps: ExtensionSyncDeps, state: ExtensionState): Promise<number> {
  let tag = state.keyTag;
  if (!tag) return 0;
  const held = loginsKeyFor(deps.readKeys(), deps.contentKey, tag);
  // Another app holds this key and its settings have not arrived yet.
  if (!held) return 0;
  let p: Uint8Array = held;
  const now = deps.now?.() ?? Date.now();
  const live = new Set(state.extensions.filter((e) => e.logins && e.key_tag === tag).map((e) => e.id));
  const halves = browserHalves(deps.readKeys(), deps.contentKey);
  const removed = [...halves].filter(([id, h]) => !live.has(id) && now - h.at > PENDING_HALF_MS).map(([id]) => id);
  if (!deps.isCurrent()) return 0;

  if (removed.length) {
    if (live.size === 0) {
      // The last extension that showed logins is gone: the copy and P go.
      await deps.store.rekey(tag, null, {});
      deps.saveKeys((k) => withoutEntries(k, [`p:${tag}`, ...[...halves.keys()].map((id) => `k:${id}`)]));
      writeMemo({ pubkey: deps.pubkey, tag: '', fps: {} });
      return 0;
    }
    // A half this app has not seen yet: wait for the settings that carry it.
    if ([...live].some((id) => !halves.has(id))) return 0;
    const { p: nextP, tag: nextTag } = newLoginsKey();
    const ksrv: Record<string, string> = {};
    for (const id of live) ksrv[id] = bytesToBase64(serverHalf(nextP, halves.get(id)!.kext));
    // The new P reaches the server's settings before the swap, so a pass that
    // stops after it, on any device, still finds P. The browser halves never
    // change; a swap that fails leaves everything as it was for the next try.
    deps.saveKeys((k) => withLoginsKey(k, deps.contentKey, nextTag, nextP));
    if (!(await deps.pushKeys())) return 0;
    try {
      await deps.store.rekey(tag, nextTag, ksrv);
    } catch (err) {
      // Another app changed the key first; its settings bring the new one.
      if (err instanceof ExtensionCallError && err.code === 'key_conflict') return 0;
      throw err;
    }
    // Every half of an extension that does not hold the new key is dead: a
    // removed one, or a code nobody pasted, which the swap deleted.
    const oldTag = tag;
    const dead = [...halves.keys()].filter((id) => !live.has(id));
    deps.saveKeys((k) => withoutEntries(k, [`p:${oldTag}`, ...dead.map((id) => `k:${id}`)]));
    tag = nextTag;
    p = nextP;
  }

  const idKey = deriveLoginsIdKey(deps.contentKey);
  const memo = readMemo(deps.pubkey, tag);
  const server = await deps.store.listCopy();
  const serverCurrent = new Map(server.filter((r) => r.key_tag === tag).map((r) => [r.id, r]));
  const writesNow = notesWriteCount();
  const liveOnServer = [...serverCurrent.values()].filter((r) => !r.deleted);
  if (
    lastCopy && lastCopy.pubkey === deps.pubkey && lastCopy.tag === tag &&
    lastCopy.writes === writesNow && now - lastCopy.at < FULL_COPY_MS &&
    server.every((r) => r.key_tag === tag) &&
    liveOnServer.length === Object.keys(memo.fps).length && liveOnServer.every((r) => r.id in memo.fps)
  ) return 0;
  const writes: CopyWrite[] = [];
  const nextFps: Record<string, string> = {};
  for (const entry of await vaultCopy()) {
    const id = loginsRowId(idKey, entry.item);
    const fp = loginsFingerprint(idKey, `${tag}:${JSON.stringify(entry)}`);
    nextFps[id] = fp;
    const have = serverCurrent.get(id);
    if (have && !have.deleted && memo.fps[id] === fp) continue;
    const { ciphertext, nonce } = encryptJsonAad(entry, p, loginsCopyAad(deps.pubkey, id));
    writes.push({ id, key_tag: tag, ciphertext: bytesToBase64(ciphertext), nonce: bytesToBase64(nonce), deleted: false });
  }
  for (const [id, row] of serverCurrent) {
    if (nextFps[id] || row.deleted) continue;
    writes.push({ id, key_tag: tag, ciphertext: '', nonce: '', deleted: true });
  }
  await deps.store.writeCopy(writes);
  // Rows under an older key were rewritten above or are dead: they go, but
  // only while the key is still this one. Another app may have moved it on
  // meanwhile and written rows this pass must not touch.
  // A row's id does not change with the key, so a row rewritten above is not stale.
  const rewritten = new Set(writes.map((w) => w.id));
  const stale = server.filter((r) => r.key_tag !== tag && !rewritten.has(r.id)).map((r) => r.id);
  if (stale.length && (await deps.store.state()).keyTag === tag) await deps.store.dropCopy(stale);
  writeMemo({ pubkey: deps.pubkey, tag, fps: nextFps });
  lastCopy = { pubkey: deps.pubkey, tag, writes: writesNow, at: now };
  return writes.length;
}

/** Open one copy row: what the extension does, here for the tests. Null when
 *  the plaintext is not a copy entry this version knows. */
export function openCopyRow(p: Uint8Array, pubkey: string, row: { id: string; ciphertext: string; nonce: string }): CopyEntry | null {
  return parseCopyEntry(decryptJsonAad<unknown>(base64ToBytes(row.ciphertext), base64ToBytes(row.nonce), p, loginsCopyAad(pubkey, row.id)));
}
