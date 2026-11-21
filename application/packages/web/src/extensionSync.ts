/**
 * The browser extension, as every app keeps up with it after a sync pass
 * that pulled cleanly: adopt the sealed inbox, and keep the vault copy.
 *
 * Adoption. Each inbox row is hostile until it opens under the inbox key and
 * passes the shape check here. A clip becomes the note, or the bookmark, the
 * in-app clipper makes, through the same `finishClip`; a login becomes a
 * vault login. The item id is derived from the row id (`inboxItemId`), so
 * two apps adopting one row make one item, and a row is deleted only once its
 * item is on the server: pushed, or deleted after a push. A deleted item may
 * be gone from this device already, so the server's tombstone settles its row
 * too: built again, the item met the tombstone and came back as a new note
 * under a fresh id, once a pass (issue 769). A row of an unknown
 * version or kind stays for a newer app. A `loginedit` row changes a login
 * (or makes one) once: `appliedInbox` records it, and it settles once that
 * login is on the server (passkeys.md section 6).
 *
 * Senders. A signed row (byte 3) names the connection that sealed it, and is
 * taken only when the sealed settings hold that connection's live sender key
 * and its signature holds; a removed connection's row is refused. An unsigned
 * row is taken as before, unless the account is closed to them, the date of
 * `INBOX_UNSIGNED_REFUSED_FROM` passed, or the server says a signed connection
 * posted it. Spec: docs/internal/plans/inbox-signed-hybrid.md (section 5.4)
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
  inboxVersionKnown,
  loginsCopyAad,
  loginsFingerprint,
  loginsRowId,
  newLoginsKey,
  openInbox,
  parseCopyEntry,
  SIGNED_INBOX_VERSION,
  loginEditProofOk,
  parseInboxLoginEdit,
  parseInboxNote,
  parseInboxKeyHalf,
  browserHalfId,
  serverHalf,
  unpackInboxPicture,
  type CopyEntry,
  type InboxKind,
  type InboxLoginEdit,
  type InboxNote,
} from '@notes/shared/extension';
import { db, notesWriteCount, type LocalNote } from './db';
import { holdsEveryEpoch, onKeyEpochChange, openWithRing, ringKeyCopies } from './keyRing';
import { onLocalDataKeyCleared } from './localKey';
import { hash53 } from './noteMerge';
import { createNote, liveNotesOfType, normalizeTag, updateNote, updateNoteFrom } from './notesRepo';
import { keepCurrentText } from './replacedCopies';
import { buildLinkBody, buildLinkKeyMap, linkDedupeKey, parseLinkBody } from './linkBody';
import { buildClipNoteMap, clipTrackers } from './clipLink';
import { parseLoginBody, serializeLoginBody } from './loginBody';
import { loginExtrasOf } from './loginExtras';
import { detectCardNetwork, parseCardBody } from './cardBody';
import { parseSshKeyBody, sshKeyFingerprint, sshKeyType } from './sshKeyBody';
import { isRetiredLoginsKey, withoutEntries, type ExtensionKeys } from './extensionKeys';
import {
  browserHalves,
  hasSenderEntries,
  inboxClosed,
  inboxSenders,
  lookupSender,
  loginsKeyFor,
  withBrowserHalf,
  withInboxClosed,
  withLoginsKey,
  type InboxSenderEntry,
} from './extensionKeyring';
import { loadExtensionState, rehalfLogins, rekeyLogins, ExtensionCallError, type ExtensionState } from './extensionApi';
import type { StorePicture } from './clipPage';
import { isDemoMode } from './demo';
import { isUuid } from './uuid';
import { unsyncedDeletes } from './unsyncedDeletes';

// ── The server, as this module needs it ─────────────────────────────

export interface InboxRow {
  id: string;
  kind: string;
  payload: string;
  created_at: string;
  /** The client of the connection that posted the row, written by the
   *  server (migration 0141); none on a row from before it. */
  client?: string | null;
  /** The connection that posted the row, written by the server (0115). Removing
   *  the connection deletes its rows (the cascade), except a `loginedit` row,
   *  whose `token_id` goes NULL instead (0131, 0132, 0136); a phrase change sets
   *  it NULL on every row (0122); rows from before 0115 have none. A database
   *  writer sets any value, so it names no sender (inbox-signed-hybrid.md).
   *  A legacy `keyhalf` row is that browser's. */
  token_id?: string | null;
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
  /** The sealed rows of these ids, for the repair of rows an older app wrote
   *  without a login's passkeys. A store without it skips the repair.
   *  Spec: docs/contrib/passkeys.md (section 5.3, Repair) */
  copyCiphertexts?(ids: string[]): Promise<CopyWrite[]>;
  writeCopy(rows: CopyWrite[]): Promise<void>;
  dropCopy(ids: string[]): Promise<void>;
  rekey(oldTag: string, newTag: string | null, ksrv: Record<string, string>): Promise<void>;
  /** One remaining browser's server half for its fresh browser half, under
   *  the account's current tag (migration 0156). A store without it leaves
   *  `keyhalf` rows for an app that has it. */
  rehalf?(tokenId: string, tag: string, ksrv: string, halfId: string): Promise<void>;
  /** Claim rows for this device; returns the ids it may adopt now. */
  claimInbox(ids: string[], deviceId: string): Promise<string[]>;
  /** The item ids among these that the server holds as tombstones. */
  tombstonedItems(ids: string[]): Promise<Set<string>>;
  /** The server's clock (ms), the one that stamps `created_at`, for the wait
   *  of a login edit; null when the server does not answer it. A store
   *  without it never counts a row as aged. Spec: docs/contrib/passkeys.md (section 6, Adoption) */
  serverNow?(): Promise<number | null>;
}

// Spec: docs/internal/plans/browser-extension-build.md (section 4, inbox and copy caps)
const INBOX_PAGE = 100;
// The inbox holds 500 rows at most (extension_inbox_post), so five pages read it all.
const INBOX_PAGES = 5;
const COPY_PAGE = 1000;
// The copy's rows per account (extension_logins_stamp, migration 0138: it
// counts only a new id) and the longest ciphertext a row may hold
// (extension_logins_ciphertext_check). A statement with one row over either
// is refused whole, so the pass sends only what fits.
const COPY_ROW_CAP = 5000;
const COPY_ROW_MAX_CHARS = 65536;

export function supabaseExtensionStore(supabase: SupabaseClient, pubkey: string): ExtensionStore {
  const fail = (code: string, error: unknown): void => {
    if (error) throw new ExtensionCallError(code);
  };
  return {
    async listInbox(after) {
      let query = supabase
        .from('extension_inbox')
        .select('id, kind, payload, created_at, client, token_id')
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
    async copyCiphertexts(ids) {
      const out: CopyWrite[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase
          .from('extension_logins')
          .select('id, key_tag, ciphertext, nonce, deleted')
          .eq('user_pubkey', pubkey)
          .in('id', ids.slice(i, i + 200));
        fail('copy_read', error);
        out.push(...((data ?? []) as CopyWrite[]));
      }
      return out;
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
    rehalf: (tokenId, tag, ksrv, halfId) => rehalfLogins(supabase, tokenId, tag, ksrv, halfId),
    async claimInbox(ids, deviceId) {
      if (!ids.length) return [];
      const { data, error } = await supabase.rpc('extension_inbox_claim', { p_ids: ids, p_device: deviceId });
      fail('inbox_claim', error);
      return Array.isArray(data) ? (data as string[]) : [];
    },
    async tombstonedItems(ids) {
      if (!ids.length) return new Set();
      const { data, error } = await supabase
        .from('notes')
        .select('id')
        .eq('user_pubkey', pubkey)
        .in('id', ids)
        .not('deleted_at', 'is', null);
      fail('inbox_tombstones', error);
      return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
    },
    // Migration 0137. Before it, or on an error, no row counts as aged.
    async serverNow() {
      const { data, error } = await supabase.rpc('extension_inbox_now');
      const at = typeof data === 'string' ? Date.parse(data) : NaN;
      return error || !Number.isFinite(at) ? null : at;
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
  /** The tests' stand-in for `LOGINEDIT_QUEUED_AT_REQUIRED_FROM`. */
  queuedAtRequiredFrom?: string | null;
  /** The tests' stand-ins for `INBOX_UNSIGNED_REFUSED_FROM` and
   *  `INBOX_CLOSE_SIGNED_ACCOUNTS`. */
  unsignedRefusedFrom?: string | null;
  closeSignedAccounts?: boolean;
  /** Whether this pass read the server's synced settings: without that a
   *  signed row of a sender this device does not know waits. None: false. */
  settingsPulled?: () => boolean;
}

export interface ExtensionSyncResult {
  /** Items this pass created. */
  adopted: number;
  /** Inbox rows this pass deleted. */
  settled: number;
  /** Copy rows this pass wrote. */
  copied: number;
  /** Unsigned (legacy) rows this pass met in the inbox. */
  unsigned?: number;
}

// Most accounts never connect an extension, so the pass asks the server
// whether any is connected at most every 10 minutes, and every pass only
// while one is (or a logins key is still to clean up).
// Spec: docs/internal/plans/browser-extension-build.md (section 3.3 step 5)
const IDLE_CHECK_MS = 10 * 60 * 1000;
let known: { pubkey: string; at: number; state: ExtensionState } | null = null;
/** The pass running now, so a second never starts beside it and Remove can
 *  wait for it (`adoptInboxNow`). */
let running: Promise<unknown> | null = null;
let inboxKey: { pubkey: string; phraseMark: string; secret: Uint8Array } | null = null;

/**
 * The account's inbox secret, derived from the phrase once per sign-in. The
 * cache is keyed by a mark of the phrase as well as the account id: a phrase
 * change keeps the account id, and a caller still holding the old phrase must
 * not leave its secret behind for a caller with the new one. The mark, not
 * the phrase, so the cache keeps no second copy of the phrase. A new epoch
 * and a sign-out forget the cache. Every phrase has its own inbox key; the
 * earlier ones live in the key ring.
 * Spec: docs/internal/plans/phrase-change.md (6.2, inbox key cache)
 */
export function inboxSecretOf(pubkey: string, phrase: string): Uint8Array {
  const phraseMark = hash53(3, phrase);
  if (inboxKey?.pubkey !== pubkey || inboxKey.phraseMark !== phraseMark) {
    inboxKey = { pubkey, phraseMark, secret: deriveInboxKeyPair(phraseToSeed(phrase)).secretKey };
  }
  return inboxKey.secret;
}

const forgetInboxKey = () => {
  inboxKey = null;
};
onKeyEpochChange(forgetInboxKey);
onLocalDataKeyCleared(forgetInboxKey);

/**
 * Open a sealed inbox row with the current inbox secret, then the secret of
 * each earlier epoch in the key ring, and name the item it becomes from the
 * secret that OPENED it: an extension or the command line seals to the key
 * it holds, which is an earlier one until it connects again, and one row
 * must become the same item on every device. Null when no secret this
 * device holds opens the row.
 * Spec: docs/internal/plans/phrase-change.md (6.2, inbox rows and item ids)
 */
export function openInboxRow(
  payload: string,
  currentSecret: Uint8Array,
  ctx: { account: string; id: string; kind: InboxKind },
): { plain: Uint8Array; itemId: string } | null {
  try {
    return openWithRing('inbox', currentSecret, (secret) => ({
      plain: openInbox(payload, secret, ctx),
      itemId: inboxItemId(secret, ctx.id),
    }));
  } catch {
    return null;
  }
}

/** One pass, never two at once. The demo has no extension and never adopts. */
export async function runExtensionSync(deps: ExtensionSyncDeps): Promise<ExtensionSyncResult> {
  if (isDemoMode() || running) return { adopted: 0, settled: 0, copied: 0 };
  const pass = extensionPass(deps);
  running = pass;
  try {
    return await pass;
  } finally {
    running = null;
  }
}

/** What adoption needs; the copy's keys stay out. */
export type AdoptDeps = Pick<ExtensionSyncDeps, 'store' | 'pubkey' | 'inboxSecret' | 'contentKey' | 'readKeys' | 'deviceId' | 'isCurrent' | 'storePicture' | 'agentFolder' | 'hasFolder' | 'now' | 'queuedAtRequiredFrom' | 'unsignedRefusedFrom' | 'settingsPulled'>;

/**
 * Adopt the inbox now, for Remove in Settings > Extension: removing a
 * connection deletes the rows it posted (the cascade of 0115) except its
 * `loginedit` rows, which outlive it (0132), so what they carry (a passkey
 * the page already uses, among them) is adopted first. Remove anyway deletes
 * the `loginedit` rows this app could not take in, with the connection
 * (`removeExtension`, beta #133).
 * Waits for a pass that is running. Returns the rows still in the inbox that
 * this device has not taken in: a row for a newer app, a row another app
 * claimed, an edit that waits for the PIN. Spec: docs/contrib/passkeys.md (section 5.4, App side of Remove)
 */
export async function adoptInboxNow(deps: AdoptDeps): Promise<{ waiting: number }> {
  if (isDemoMode()) return { waiting: 0 };
  while (running) await running.catch(() => undefined);
  const pass = (async () => {
    await adoptInbox(deps);
    return { waiting: await rowsNotTakenIn(deps) };
  })();
  running = pass;
  try {
    return await pass;
  } finally {
    running = null;
  }
}

/** The inbox rows whose item is not on this device yet. */
async function rowsNotTakenIn(deps: AdoptDeps): Promise<number> {
  let waiting = 0;
  let after: InboxRow | undefined;
  for (let page = 0; page < INBOX_PAGES; page++) {
    const rows = await deps.store.listInbox(after);
    const pass = pageReader(deps);
    for (const row of rows) {
      if (row.kind === 'picture' || row.kind === 'keyhalf') continue;
      const got = await openRow(deps, row, pass);
      if (got === 'skip' || got === 'wait') {
        waiting += 1;
        continue;
      }
      if (got === 'refuse') continue;
      if (row.kind === 'loginedit' ? await db.appliedInbox.get(row.id) : await db.notes.get(got.itemId)) continue;
      waiting += 1;
    }
    pass.done();
    if (rows.length < INBOX_PAGE) break;
    after = rows[rows.length - 1];
  }
  return waiting;
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
  const { halves, unsigned, complete, ...inbox } = await adoptInbox(deps);
  if (halves.length) inbox.settled += await takeFreshHalves(deps, known.state, halves);
  if (checked && complete && unsigned === 0 && deps.isCurrent()) await closeIfSigned(deps);
  const copied = active(known.state) ? await keepLoginsCopy(deps, known.state) : 0;
  return { ...inbox, copied, unsigned };
}

// ── Senders ─────────────────────────────────────────────────────────
// Spec: docs/internal/plans/inbox-signed-hybrid.md (sections 5.2 and 5.4)

/** A date (ISO) from which an unsigned inbox row is refused on every account;
 *  null keeps taking them. Set it only after the release order of section 9. */
const INBOX_UNSIGNED_REFUSED_FROM: string | null = null;
/** Close an account to unsigned rows once every connection signs. Off until
 *  no app makes a version 1 code (section 9, step 5). */
const INBOX_CLOSE_SIGNED_ACCOUNTS = false;
/** A signed row whose sender this device does not know yet (a settings push
 *  still on its way) waits this long on the server's clock, then goes. */
const UNKNOWN_SENDER_WAIT_MS = 24 * 60 * 60 * 1000;
const UNSIGNED_CLOCK_MARGIN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * With the switch on, close the account to unsigned rows once it has a
 * sender and every connection the server lists signs, after a pass that read
 * the whole inbox and met no unsigned row. The list is read again here, after
 * the adoption, so a connection paired meanwhile counts (spec review M6).
 * Only Remove in Settings clears a sender (`forgetSenderOf`); a sender whose
 * connection left another way stays live, so its waiting rows still open.
 */
async function closeIfSigned(deps: ExtensionSyncDeps): Promise<void> {
  if (!(deps.closeSignedAccounts ?? INBOX_CLOSE_SIGNED_ACCOUNTS)) return;
  const keys = deps.readKeys();
  if (inboxClosed(keys) || !hasSenderEntries(keys)) return;
  const state = await deps.store.state();
  const signing = new Set([...inboxSenders(keys, deps.contentKey).values()].map((s) => s.tokenId));
  if (deps.isCurrent() && state.extensions.every((e) => signing.has(e.id))) deps.saveKeys((k) => withInboxClosed(k, deps.contentKey));
}

type SignedModule = typeof import('@notes/shared/inbox-signed');
let signedModule: Promise<SignedModule> | null = null;
/** ML-KEM stays off the boot path: loaded the first time a signed row shows.
 *  A failed load is not kept, so the next pass tries again (code review 4). */
const loadSigned = (): Promise<SignedModule> => (signedModule ??= import('@notes/shared/inbox-signed').catch((err: unknown) => {
  signedModule = null;
  throw err;
}));

/** What one page's reads share: the settings' senders, and the keys of a
 *  signed row, derived once, the first time one is met. */
interface PageReader {
  keys: ExtensionKeys;
  senders: Map<string, InboxSenderEntry>;
  closed: boolean;
  settingsPulled: boolean;
  clock(): Promise<number | null>;
  signed(): Promise<{ mod: SignedModule; epochs: { inboxSecret: Uint8Array; kem: { secretKey: Uint8Array; publicKey: Uint8Array } }[] }>;
  /** Zero the ring copies this page took. */
  done(): void;
}

function pageReader(deps: AdoptDeps): PageReader {
  const keys = deps.readKeys();
  let clock: Promise<number | null> | null = null;
  let signed: ReturnType<PageReader['signed']> | null = null;
  const copies: Uint8Array[] = [];
  return {
    keys,
    senders: inboxSenders(keys, deps.contentKey),
    closed: inboxClosed(keys),
    settingsPulled: deps.settingsPulled?.() ?? false,
    clock: () => (clock ??= (async () => (await deps.store.serverNow?.()) ?? null)()),
    signed: () => (signed ??= (async () => {
      const mod = await loadSigned();
      const epochs = [{ inboxSecret: deps.inboxSecret, kem: mod.deriveInboxKemKeyPair(deps.contentKey) }];
      // The current keys first, then each earlier epoch, newest first.
      for (const [, k] of [...ringKeyCopies()].sort((a, b) => b[0] - a[0])) {
        copies.push(k.inbox, k.local);
        epochs.push({ inboxSecret: k.inbox, kem: mod.deriveInboxKemKeyPair(k.sync) });
        k.sync.fill(0);
      }
      for (const e of epochs) copies.push(e.kem.secretKey);
      return { mod, epochs };
    })()),
    done: () => {
      for (const c of copies) c.fill(0);
    },
  };
}

type OpenedRow = { row: InboxRow; plain: Uint8Array; itemId: string };
/** A row this app can act on, or: `skip` (a newer app's), `wait` (a key or a
 *  sender this device lacks yet), `refuse` (never anything). */
type RowOutcome = OpenedRow | 'skip' | 'wait' | 'refuse';

async function openRow(deps: AdoptDeps, row: InboxRow, pass: PageReader): Promise<RowOutcome> {
  const version = inboxRowVersion(row.payload);
  if (!KNOWN_KINDS.has(row.kind) || !inboxVersionKnown(row.kind, version)) return 'skip';
  const ctx = { account: deps.pubkey, id: row.id, kind: row.kind as InboxKind };
  if (version === SIGNED_INBOX_VERSION) {
    // The module did not load (a deploy, offline): the row waits, and the
    // unsigned rows of the page go on (code review 4).
    try {
      return await openSignedRow(row, ctx, pass);
    } catch {
      return 'wait';
    }
  }
  if (legacyRefused(deps, row, pass)) return 'refuse';
  const got = openInboxRow(row.payload, deps.inboxSecret, ctx);
  // A row of a known version that opens under none of this account's keys
  // is damaged or not ours: it can never become anything. Unless this
  // device lacks the key of an epoch the account has had: then the row
  // can be sealed to that key, and it waits for it.
  if (!got) return holdsEveryEpoch() ? 'refuse' : 'wait';
  return { row, ...got };
}

/** An unsigned row that no app takes any more (section 5.4, rules 1 to 3). */
function legacyRefused(deps: AdoptDeps, row: InboxRow, pass: PageReader): boolean {
  if (pass.closed) return true;
  // By the server's stamp first; this app's clock only two weeks later, so a
  // clock that runs fast does not refuse a row posted before the date
  // (spec review M3; the shape of LOGINEDIT_QUEUED_AT_REQUIRED_FROM).
  const from = Date.parse((deps.unsignedRefusedFrom !== undefined ? deps.unsignedRefusedFrom : INBOX_UNSIGNED_REFUSED_FROM) ?? '');
  if (Number.isFinite(from) && (Date.parse(row.created_at) >= from || (deps.now?.() ?? Date.now()) >= from + UNSIGNED_CLOCK_MARGIN_MS)) return true;
  // Against an honest server only: a connection that signs never posts an
  // unsigned row, so one under its token id is not from it.
  return !!row.token_id && [...pass.senders.values()].some((s) => s.tokenId === row.token_id);
}

async function openSignedRow(row: InboxRow, ctx: { account: string; id: string; kind: InboxKind }, pass: PageReader): Promise<RowOutcome> {
  const { mod, epochs } = await pass.signed();
  let opened: ReturnType<SignedModule['openInboxSigned']> | null = null;
  let secret: Uint8Array | null = null;
  for (const keys of epochs) {
    try {
      opened = mod.openInboxSigned(row.payload, keys, ctx);
      secret = keys.inboxSecret;
      break;
    } catch {
      /* the next epoch */
    }
  }
  if (!opened || !secret) return holdsEveryEpoch() ? 'refuse' : 'wait';
  const who = lookupSender(pass.keys, pass.senders, opened.keyId);
  if (who === 'removed') return 'refuse';
  if (who === 'unknown') {
    // A device whose settings this pass did not read may not know it yet.
    if (!pass.settingsPulled) return 'wait';
    const at = await pass.clock();
    return at !== null && at - Date.parse(row.created_at) > UNKNOWN_SENDER_WAIT_MS ? 'refuse' : 'wait';
  }
  // A command line may post notes only, as the server holds it (0113); its
  // seed alone must not add a login, a clip or a key half (code review 1).
  if (who.live.client === 'cli' && row.kind !== 'note') return 'refuse';
  const plain = opened.bodyFrom(who.live.publicKey);
  if (!plain) return 'refuse';
  // The sealed entry, not the server's columns, says which connection this is.
  return { row: { ...row, client: who.live.client, token_id: who.live.tokenId }, plain, itemId: inboxItemId(secret, row.id) };
}

/** Forget what the last pass learnt, so the next one asks at once (after a
 *  pairing, a Remove, or a sign-out). */
export function resetExtensionSync(): void {
  known = null;
  inboxKey = null;
  lastCopy = null;
  copyFull = null;
}

// ── Adoption ───────────────────────────────────────────────────────

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
/** A `loginedit` row waits at most this long for its login to arrive, or for
 *  the logins key its proof names; then it is treated as one whose login is
 *  gone, and makes a new login. A row that waited for ever counted against
 *  the inbox cap for good (passkeys code review 3, finding 12). Counted on
 *  the server's clock (`ExtensionStore.serverNow`, beta #132).
 *  Spec: docs/contrib/passkeys.md (section 16, finding 12) */
const EDIT_WAIT_MS = 14 * 24 * 60 * 60 * 1000;
/** A `loginedit` row whose sealed `queuedAt` is more than this before its
 *  server `created_at` is refused: the server remembers a settled id for 90
 *  days (0132), so an older row is one posted again from a copy of the
 *  extension's queue (beta #140 item 1). A row with no `queuedAt` (from an
 *  extension before it) is taken as before, so a row already waiting still
 *  lands. Spec: docs/contrib/passkeys.md (section 6, Adoption) */
const EDIT_REPLAY_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * The end of that exception (beta #198 item 8): a `loginedit` row the server
 * stamped at or after this time with no sealed `queuedAt` is refused, so a
 * copy of an edit sealed before the fix cannot be posted again for ever. Null
 * while extensions older than the one that seals `queuedAt` (0.786.0) may
 * still post. Set it to the day the release floor passes 0.786.0; a row
 * already waiting from before that day still lands.
 * Spec: docs/contrib/passkeys.md (section 6, Adoption)
 */
const LOGINEDIT_QUEUED_AT_REQUIRED_FROM: string | null = null;

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
  if (pictures.some((p) => p !== null && !(typeof p === 'string' && isUuid(p)))) return null;
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
  if (!got || !h || h.v !== 1 || h.id !== rowId || typeof h.clip !== 'string' || !isUuid(h.clip)) return null;
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

// Spec: docs/contrib/passkeys.md (section 6, `loginedit`)
const KNOWN_KINDS = new Set<string>(['clip', 'picture', 'login', 'note', 'loginedit', 'keyhalf']);

/** Whether the item of a row is on the server: pushed, or deleted and the
 *  delete pushed. Only then may the row go. */
function onServer(n: LocalNote | undefined): boolean {
  return !!n && n.dirty === 0 && (n.deleted === 1 || !!n.syncedNonce);
}

/** Every page of the inbox, not only the first: a row that waits (a newer
 *  app's version, another app's claim, a clip's missing picture) must never
 *  hide the rows behind it. The pictures of a clip may sit on the page before. */
async function adoptInbox(deps: AdoptDeps): Promise<{ adopted: number; settled: number; halves: FreshHalf[]; unsigned: number; complete: boolean }> {
  const out = { adopted: 0, settled: 0, halves: [] as FreshHalf[], unsigned: 0, complete: false };
  const pictures = new Map<string, { clip: string; type: string; bytes: Uint8Array }>();
  // The logins an edit of this pass left unsettled, across the pages, and
  // those an edit of this pass left waiting, unapplied.
  const unsettled = new Set<string>();
  const waitingEdits = new Set<string>();
  let after: InboxRow | undefined;
  for (let page = 0; page < INBOX_PAGES; page++) {
    const rows = await deps.store.listInbox(after);
    if (!rows.length) {
      out.complete = true;
      break;
    }
    const got = await adoptPage(deps, rows, pictures, unsettled, waitingEdits);
    out.adopted += got.adopted;
    out.settled += got.settled;
    out.unsigned += got.unsigned;
    out.halves.push(...got.halves);
    if (got.stopped || !deps.isCurrent()) break;
    if (rows.length < INBOX_PAGE) {
      out.complete = true;
      break;
    }
    after = rows[rows.length - 1];
  }
  return out;
}

async function adoptPage(
  deps: AdoptDeps,
  rows: InboxRow[],
  pictures: Map<string, { clip: string; type: string; bytes: Uint8Array }>,
  unsettled: Set<string>,
  waitingEdits: Set<string>,
): Promise<{ adopted: number; settled: number; stopped: boolean; halves: FreshHalf[]; unsigned: number }> {
  const now = deps.now?.() ?? Date.now();
  const halves: FreshHalf[] = [];
  const opened = new Map<string, OpenedRow>();
  const refuse: string[] = [];
  let stopped = false;
  const pass = pageReader(deps);
  let unsigned = 0;
  try {
    for (const row of rows) {
      const got = await openRow(deps, row, pass);
      if (got !== 'skip' && inboxRowVersion(row.payload) !== SIGNED_INBOX_VERSION) unsigned += 1;
      // A newer app's row waits for that app; a row whose key or sender this
      // device lacks waits for it.
      if (got === 'skip' || got === 'wait') continue;
      if (got === 'refuse') refuse.push(row.id);
      else opened.set(row.id, got);
    }
  } finally {
    pass.done();
  }

  for (const [id, { row, plain }] of opened) {
    if (row.kind !== 'picture') continue;
    const p = parsePicture(plain, id);
    if (p) pictures.set(id, p);
    else refuse.push(id);
  }
  // A fresh browser half makes no item: the pass writes its server half
  // after adoption (takeFreshHalves), with the extensions' state at hand.
  for (const [id, { row, plain }] of opened) {
    if (row.kind !== 'keyhalf') continue;
    const kext = parseInboxKeyHalf(decodeJson(plain), id);
    if (kext) halves.push({ row: id, tokenId: row.token_id ?? null, kext });
    else refuse.push(id);
  }

  // A login edit: what it does to this device's Vault, decided before the
  // claims, since only an edit that writes needs one.
  // A login this device has not pulled is gone only when the server holds it
  // as deleted, or this device deleted it before it reached the server.
  const parsedEdits = new Map<string, { edit: InboxLoginEdit; itemId: string; trust: EditTrust; createdAt: string }>();
  // The wait is counted on the server's clock, the one that stamped
  // `created_at`: an app whose clock runs fast made a second login at once
  // (beta #132). Asked only for a page with a login edit; no answer, no aging.
  const serverNow = [...opened.values()].some((o) => o.row.kind === 'loginedit') ? await pass.clock() : null;
  const aged = (row: InboxRow) => serverNow !== null && serverNow - Date.parse(row.created_at) > EDIT_WAIT_MS;
  const requiredFrom = Date.parse((deps.queuedAtRequiredFrom !== undefined ? deps.queuedAtRequiredFrom : LOGINEDIT_QUEUED_AT_REQUIRED_FROM) ?? '');
  for (const [id, { row, plain, itemId }] of opened) {
    if (row.kind !== 'loginedit') continue;
    const edit = parseInboxLoginEdit(decodeJson(plain), id);
    const replayed = edit?.queuedAt !== undefined
      ? Date.parse(row.created_at) - edit.queuedAt > EDIT_REPLAY_MS
      : Number.isFinite(requiredFrom) && !(Date.parse(row.created_at) < requiredFrom);
    if (!edit || replayed) {
      refuse.push(id);
      continue;
    }
    const trust = editTrust(edit, deps);
    parsedEdits.set(id, { edit, itemId, trust: aged(row) && trust === 'wait' ? 'unproven' : trust, createdAt: row.created_at });
  }
  const unseen: string[] = [];
  for (const { edit, trust } of parsedEdits.values()) {
    if (edit.item && trust === 'proven' && !(await db.notes.get(edit.item))) unseen.push(edit.item);
  }
  const editGone = await deps.store.tombstonedItems(unseen);
  if (unseen.length) for (const id of await unsyncedDeletes(now)) editGone.add(id);
  // A login that has not arrived in EDIT_WAIT_MS is taken as gone.
  for (const [id, { edit }] of parsedEdits) {
    const row = opened.get(id)?.row;
    if (edit.item && row && aged(row)) editGone.add(edit.item);
  }
  const edits = new Map<string, EditPlan>();
  for (const [id, { edit, itemId, trust, createdAt }] of parsedEdits) edits.set(id, await planEdit(edit, itemId, deps.pubkey, editGone, trust, createdAt));

  // The rows whose item does not exist here yet. An item the server holds as
  // a tombstone, or one this device deleted before it reached the server,
  // was deleted: its row settles and is never built again. The others are
  // claimed, so one app builds each; another app's claim lasts 10 minutes.
  // An edit that changes a login here is claimed the same way.
  const missing = new Map<string, string>();
  for (const [id, { row, itemId }] of opened) {
    if (row.kind === 'picture' || row.kind === 'keyhalf') continue;
    if (row.kind === 'loginedit' && edits.get(id)?.step !== 'create') continue;
    if (!(await db.notes.get(itemId))) missing.set(id, itemId);
  }
  const gone = await deps.store.tombstonedItems([...missing.values()]);
  if (missing.size) for (const id of await unsyncedDeletes(now)) gone.add(id);
  const unbuilt = [...missing].filter(([, itemId]) => !gone.has(itemId)).map(([id]) => id);
  const applying = [...edits].filter(([, plan]) => plan.step === 'apply').map(([id]) => id);
  const mine = new Set(await deps.store.claimInbox([...unbuilt, ...applying], deps.deviceId));

  let adopted = 0;
  const settled: string[] = [];
  const decode = decodeJson;
  for (const [id, { row, plain, itemId }] of opened) {
    if (row.kind === 'picture' || row.kind === 'keyhalf') continue;
    if (row.kind === 'loginedit') {
      const parsed = parsedEdits.get(id);
      if (!parsed) continue;
      // Planned again just before it runs, in the inbox's order (oldest
      // first): an earlier edit of this pass may have changed the login
      // since the plans above, which only decided the claims. A plan that
      // now writes without a claim waits for the next pass (finding 5).
      let plan = await planEdit(parsed.edit, itemId, deps.pubkey, editGone, parsed.trust, parsed.createdAt);
      const login = parsed.edit.item ?? itemId;
      // "The login already carries these values" proves nothing while an
      // older edit of the same login is still to come: the newer row would
      // settle first, and the older one would then stand.
      if (plan.step === 'settle' && plan.record && unsettled.has(login)) plan = { step: 'wait' };
      // Nor does a newer edit run past an older one that waits (unclaimed,
      // or held by another app): the older one would run later and write
      // over it (beta #122).
      if (plan.step === 'apply' && waitingEdits.has(login)) plan = { step: 'wait' };
      if (plan.step === 'create' && gone.has(itemId)) {
        settled.push(id);
        continue;
      }
      const outcome = await runEdit(plan, id, itemId, mine.has(id), deps, parsed.createdAt);
      if (outcome === 'settle') settled.push(id);
      else {
        unsettled.add(login);
        // A settled row that waits only for the push is not behind. Nor is
        // one that waits for a logins key this app has not seen: its proof
        // is unchecked, and any tag and any mac would hold every later edit
        // of the login (beta #198 item 2). When its key arrives and a newer
        // edit ran meanwhile, it settles without writing (planEdit).
        if (outcome === 'wait' && plan.step !== 'settle' && parsed.trust !== 'wait') waitingEdits.add(login);
        if (outcome === 'created') adopted += 1;
      }
      continue;
    }
    if (gone.has(itemId)) {
      settled.push(id, ...[...pictures].filter(([, p]) => p.clip === id).map(([pid]) => pid));
      continue;
    }
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
      const made = await createInboxNote(note, itemId, deps, row.client);
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
  if (done.length && deps.isCurrent()) {
    await deps.store.deleteInbox(done);
    // The row is gone from the server, so its record has nothing left to guard.
    await db.appliedInbox.bulkDelete(done);
  }
  for (const id of done) pictures.delete(id);
  return { adopted, settled: done.length, stopped, halves, unsigned };
}

function decodeJson(plain: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

// ── Login edits from the extension ─────────────────────────────────
// Spec: docs/contrib/passkeys.md (section 6, Adoption; P25)

/**
 * What a `loginedit` row does on this device:
 * - `settle`: applied here before (in `appliedInbox`), or the login already
 *   carries every value it sets (another app applied it); the row goes once
 *   that login is on the server, and only while it still holds every passkey
 *   the row added. A login that lost one (a conflict answer that took the
 *   other device's body) gets it again, under a claim: `apply` with the
 *   missing passkeys only, so no field is written twice.
 * - `wait`: the login is not on this device yet and the server does not hold
 *   it as deleted: it may arrive with the next pull.
 * - `apply`: change the login, under a claim.
 * - `create`: the login is gone, trashed, not a login, behind the PIN or
 *   read-only, the row names none, or its proof of unlock is missing or
 *   wrong (`EditTrust`): a new login under the row's derived id,
 *   as a `login` row makes. A guarded login never takes the edit, and a row
 *   that waited for it could wait until the inbox purge.
 * Spec: docs/contrib/passkeys.md (section 6, Adoption; P25), and the
 * code review of the built code (findings 7, 10, 13), and section 16.
 */
type EditPlan =
  | { step: 'settle'; target: string; record: boolean }
  | { step: 'wait' }
  | { step: 'apply'; edit: InboxLoginEdit; target: string }
  | { step: 'create'; edit: InboxLoginEdit };

/**
 * Whether a row may change the login it names: `proven` when its proof of
 * unlock checks under the logins key it names; `wait` while this app has not
 * seen that key yet; `unproven` for no proof or a wrong one, for a key the
 * apps retired (its entry is a tombstone, so it never comes back; beta #140
 * item 2), and for a row that names no login. An unproven row is a new
 * login, never a change. Once the tombstone itself is purged the tag reads
 * as not seen, and the row waits the 14 days as before.
 * Spec: docs/contrib/passkeys.md (section 16, finding 1)
 */
type EditTrust = 'proven' | 'wait' | 'unproven';

function editTrust(edit: InboxLoginEdit, deps: Pick<AdoptDeps, 'pubkey' | 'contentKey' | 'readKeys'>): EditTrust {
  if (!edit.item || !edit.proof) return 'unproven';
  const keys = deps.readKeys();
  const p = loginsKeyFor(keys, deps.contentKey, edit.proof.tag);
  if (!p) return isRetiredLoginsKey(keys, edit.proof.tag) ? 'unproven' : 'wait';
  return loginEditProofOk(edit.proof.mac, p, deps.pubkey, edit.id, edit.item) ? 'proven' : 'unproven';
}

/** A live login that takes edits: not deleted, trashed, behind the PIN or read-only. */
const editable = (n: LocalNote | undefined): n is LocalNote =>
  !!n && n.type === 'login' && n.deleted !== 1 && n.trashed !== 1 && n.pinProtected !== 1 && n.locked !== 1;

/** Settle on this login, or give it back the passkeys of the row it lost. */
async function settleOn(edit: InboxLoginEdit, target: string, record: boolean): Promise<EditPlan> {
  const n = await db.notes.get(target);
  if (editable(n)) {
    const held = new Set(parseLoginBody(n.body).passkeys.map((p) => p.credentialId));
    const missing = edit.addPasskeys.filter((p) => !held.has(p.credentialId));
    if (missing.length) return { step: 'apply', edit: { ...edit, set: {}, addPasskeys: missing }, target };
  }
  return { step: 'settle', target, record };
}

/** Whether this device applied an edit of `item` from a row the server
 *  stamped after `createdAt`. */
async function newerEditApplied(account: string, item: string, createdAt: string): Promise<boolean> {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return false;
  const records = await db.appliedInbox.where('account').equals(account).toArray();
  return records.some((r) => r.item === item && typeof r.rowAt === 'string' && Date.parse(r.rowAt) > at);
}

async function planEdit(edit: InboxLoginEdit, itemId: string, account: string, gone: Set<string>, trust: EditTrust, createdAt: string): Promise<EditPlan> {
  const applied = await db.appliedInbox.get(edit.id);
  if (applied && applied.account === account) return settleOn(edit, applied.item, false);
  if (trust === 'wait') return { step: 'wait' };
  // An unproven row never reads the login it names: it is a new login.
  const target = trust === 'proven' && edit.item ? await db.notes.get(edit.item) : undefined;
  if (trust === 'proven' && edit.item && !target && !gone.has(edit.item)) return { step: 'wait' };
  if (!editable(target)) {
    // A new login made before (by this app, or another app's and pulled).
    if (await db.notes.get(itemId)) return settleOn(edit, itemId, true);
    return { step: 'create', edit };
  }
  if (carriesEdit(target, edit)) return { step: 'settle', target: target.id, record: true };
  // A newer edit of this login ran first (this row waited for its logins
  // key): its values stand, and this row adds only the passkeys it carries.
  if (await newerEditApplied(account, target.id, createdAt)) return settleOn({ ...edit, set: {} }, target.id, true);
  return { step: 'apply', edit, target: target.id };
}

/** Whether a login already holds every value an edit sets. */
function carriesEdit(n: Pick<LocalNote, 'title' | 'body'>, edit: InboxLoginEdit): boolean {
  const l = parseLoginBody(n.body);
  const { name, ...fields } = edit.set;
  if (name !== undefined && n.title !== name) return false;
  for (const [key, value] of Object.entries(fields) as [keyof typeof fields, string][]) {
    if (l[key] !== value) return false;
  }
  const ids = new Set(l.passkeys.map((p) => p.credentialId));
  return edit.addPasskeys.every((p) => ids.has(p.credentialId));
}

/** The login body with an edit applied: each set field, and the passkeys
 *  added by credential id, an equal id replaced. Every other key stays. */
function editedLoginBody(body: string, edit: InboxLoginEdit): string {
  const l = parseLoginBody(body);
  const { name: _name, ...fields } = edit.set;
  const added = new Set(edit.addPasskeys.map((p) => p.credentialId));
  return serializeLoginBody(
    { ...l, ...fields, passkeys: [...l.passkeys.filter((p) => !added.has(p.credentialId)), ...edit.addPasskeys] },
    body,
  );
}

async function recordApplied(id: string, account: string, item: string, now: number, rowAt?: string): Promise<void> {
  await db.appliedInbox.put({ id, account, item, at: new Date(now).toISOString(), ...(rowAt ? { rowAt } : {}) });
}

async function runEdit(
  plan: EditPlan,
  rowId: string,
  itemId: string,
  claimed: boolean,
  deps: AdoptDeps,
  rowAt?: string,
): Promise<'settle' | 'created' | 'applied' | 'wait'> {
  const now = deps.now?.() ?? Date.now();
  if (plan.step === 'wait') return 'wait';
  if (plan.step === 'settle') {
    if (plan.record && deps.isCurrent()) await recordApplied(rowId, deps.pubkey, plan.target, now, rowAt);
    const n = await db.notes.get(plan.target);
    // A login purged from this device has nothing left to push.
    return !n || onServer(n) ? 'settle' : 'wait';
  }
  if (!claimed || !deps.isCurrent()) return 'wait';
  if (plan.step === 'apply') {
    const { edit } = plan;
    // The login as it is goes into the replaced copies first, so its History
    // window offers it back: an edit can replace a password or a 2FA key, and
    // the save path keeps no version of its own (finding 9).
    const before = await db.notes.get(plan.target);
    if (editable(before) && (editedLoginBody(before.body, edit) !== before.body || (edit.set.name ?? before.title) !== before.title)) {
      await keepCurrentText(before, now);
    }
    // The patch is built from the row inside the write's own transaction, so
    // an edit landing meanwhile is not written over.
    const written = await updateNoteFrom(plan.target, (current) => {
      if (!editable(current)) return null;
      const body = editedLoginBody(current.body, edit);
      const title = edit.set.name ?? current.title;
      return body === current.body && title === current.title ? null : { body, title };
    });
    if (!written) return 'wait';
    await recordApplied(rowId, deps.pubkey, plan.target, now, rowAt);
    return 'applied';
  }
  const { edit } = plan;
  const base = edit.base ?? { name: '', username: '', url: '' };
  const body = editedLoginBody(
    serializeLoginBody({ url: base.url, username: base.username, password: '', totp: '', notes: '' }),
    edit,
  );
  const l = parseLoginBody(body);
  const title = edit.set.name ?? base.name;
  await createNote(title || l.url || l.username || edit.addPasskeys[0]?.rpId || '', body, [], false, 'login', null, { id: itemId, counted: false });
  await recordApplied(rowId, deps.pubkey, itemId, now, rowAt);
  return 'created';
}

/**
 * Where an inbox note goes. From the command line: the Agent folder. From the
 * extension's New note or the Ninja box: the root, as New note with no folder
 * open, or the folder the box read from the title line while it still exists.
 * `client` is the server's word on who posted the row (migration 0141): a
 * command line row goes to the Agent folder whatever its `from` says, since
 * the sender writes `from` (beta #184, item 5). A row from before 0141 has
 * none and keeps the rule by `from`.
 * Spec: docs/internal/plans/quick-note-694.md (Q3); docs/internal/plans/agent-cli.md (section 3.4)
 */
function inboxNoteFolder(note: InboxNote, deps: Pick<ExtensionSyncDeps, 'agentFolder' | 'hasFolder'>, client?: string | null): string | null {
  if (client === 'cli' || !note.from) return deps.agentFolder?.() ?? null;
  return note.folder && deps.hasFolder?.(note.folder) ? note.folder : null;
}

/**
 * Make the item of an opened `note` row, or of a quick note the Ninja box
 * queued while the app was locked (quickNoteQueue.ts). The body rule is
 * `inboxNoteBody` of the clip engine. `refused`: the body is too long even
 * as one code block, which no sender that checks `inboxNoteFits` sends;
 * `stopped`: the sign-in ended first.
 */
export async function createInboxNote(
  note: InboxNote,
  itemId: string,
  deps: Pick<ExtensionSyncDeps, 'agentFolder' | 'hasFolder' | 'isCurrent'>,
  client?: string | null,
): Promise<'created' | 'refused' | 'stopped'> {
  const { inboxNoteBody } = await import('@notes/clipper');
  const body = inboxNoteBody(note.markdown);
  if (body === null) return 'refused';
  const tags = [...new Set(note.tags.map(normalizeTag).filter(Boolean))];
  if (!deps.isCurrent()) return 'stopped';
  await createNote(note.title.trim(), body, tags, false, 'note', inboxNoteFolder(note, deps, client), { id: itemId, counted: false });
  return 'created';
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
  deps: AdoptDeps,
  clip: ParsedClip,
  itemId: string,
  held: ({ type: string; bytes: Uint8Array } | undefined)[],
): Promise<'created' | 'none' | 'stopped'> {
  const saveBookmark = async (): Promise<'created' | 'none' | 'stopped'> => {
    const bookmarked = buildLinkKeyMap(await liveNotesOfType(['link'])).has(linkDedupeKey(clip.url));
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
  const rows = (await liveNotesOfType(COPY_TYPES)).filter((n) => n.trashed !== 1 && n.pinProtected !== 1);
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
      // A login's site passkeys go with it, for the extension to sign with.
      // Spec: docs/contrib/passkeys.md (section 5.3)
      out.push({
        ...base, kind: 'login', username: l.username, password: l.password, totp: l.totp, urls: [l.url, ...extra].filter(Boolean),
        ...(l.passkeys.length ? { passkeys: l.passkeys } : {}),
      });
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

/** Whether the last full pass left new rows out because the copy is at its
 *  row cap: Settings > Extension then says so (beta #202 item 1). */
let copyFull: { pubkey: string; full: boolean } | null = null;

/** True when the extension's copy of this account is full, as the last full
 *  pass of this tab found it. */
export function loginsCopyFull(pubkey: string): boolean {
  return copyFull?.pubkey === pubkey && copyFull.full;
}

async function keepLoginsCopy(deps: ExtensionSyncDeps, state: ExtensionState): Promise<number> {
  let tag = state.keyTag;
  if (!tag) return 0;
  const held = loginsKeyFor(deps.readKeys(), deps.contentKey, tag);
  // Another app holds this key and its settings have not arrived yet.
  if (!held) return 0;
  let p: Uint8Array = held;
  const now = deps.now?.() ?? Date.now();
  // Every browser that shows logins: on this key, or on an earlier one while
  // it has not sent its fresh half yet (beta #205 item 1).
  const live = new Set(state.extensions.filter((e) => e.logins).map((e) => e.id));
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
    // No server half for any browser that stays: one under its kept half
    // would give P xor P' to whoever holds the removed browser's P and the
    // server's halves from before and after. Each browser sends a fresh half
    // at its next unlock instead (takeFreshHalves); one too old to send it
    // is connected again with a code (beta #205 item 1).
    const { p: nextP, tag: nextTag } = newLoginsKey();
    // The new P reaches the server's settings before the swap, so a pass that
    // stops after it, on any device, still finds P. A swap that fails leaves
    // everything as it was for the next try.
    deps.saveKeys((k) => withLoginsKey(k, deps.contentKey, nextTag, nextP));
    if (!(await deps.pushKeys())) return 0;
    try {
      await deps.store.rekey(tag, nextTag, {});
    } catch (err) {
      // Another app changed the key first; its settings bring the new one.
      if (err instanceof ExtensionCallError && err.code === 'key_conflict') return 0;
      throw err;
    }
    // Every half of an extension that is gone is dead: a removed one, or a
    // code nobody pasted, which the swap deleted.
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
  const seal = (id: string, entry: CopyEntry) => {
    const { ciphertext, nonce } = encryptJsonAad(entry, p, loginsCopyAad(deps.pubkey, id));
    writes.push({ id, key_tag: tag, ciphertext: bytesToBase64(ciphertext), nonce: bytesToBase64(nonce), deleted: false });
  };
  // Rows the memo says are current but that hold a login's passkeys: an
  // older app writes the same row without them, and its write leaves this
  // memo as it was, so each is opened and compared once a full pass.
  // Spec: docs/contrib/passkeys.md (section 5.3, Repair)
  const unsure = new Map<string, CopyEntry>();
  for (const entry of await vaultCopy()) {
    const id = loginsRowId(idKey, entry.item);
    const fp = loginsFingerprint(idKey, `${tag}:${JSON.stringify(entry)}`);
    nextFps[id] = fp;
    const have = serverCurrent.get(id);
    if (have && !have.deleted && memo.fps[id] === fp) {
      if (entry.kind === 'login' && entry.passkeys?.length) unsure.set(id, entry);
      continue;
    }
    seal(id, entry);
  }
  if (unsure.size && deps.store.copyCiphertexts) {
    const sealed = new Map((await deps.store.copyCiphertexts([...unsure.keys()])).map((r) => [r.id, r]));
    for (const [id, entry] of unsure) {
      const row = sealed.get(id);
      let opened: CopyEntry | null = null;
      try {
        if (row && !row.deleted && row.key_tag === tag) opened = openCopyRow(p, deps.pubkey, row);
      } catch {
        // A row that does not open is written again.
      }
      if (!opened || JSON.stringify(opened) !== JSON.stringify(parseCopyEntry(entry))) seal(id, entry);
    }
  }
  for (const [id, row] of serverCurrent) {
    if (nextFps[id] || row.deleted) continue;
    writes.push({ id, key_tag: tag, ciphertext: '', nonce: '', deleted: true });
  }
  // Changed rows and deleted marks go first: they add no row, so they land at
  // the cap. New rows follow, only as many as the cap still has room for; one
  // that does not fit stays out of the memo and is tried again next pass
  // (beta #202 item 1). A row too long for the column never fits.
  const onServer = new Set(server.map((r) => r.id));
  const fits = writes.filter((w) => w.ciphertext.length <= COPY_ROW_MAX_CHARS);
  const fresh = fits.filter((w) => !onServer.has(w.id));
  const room = Math.max(0, COPY_ROW_CAP - onServer.size);
  const sent = [...fits.filter((w) => onServer.has(w.id)), ...fresh.slice(0, room)];
  const sentIds = new Set(sent.map((w) => w.id));
  copyFull = { pubkey: deps.pubkey, full: fresh.length > room };
  for (const w of writes) if (!sentIds.has(w.id)) delete nextFps[w.id];
  await deps.store.writeCopy(sent);
  // Rows under an older key were rewritten above or are dead: they go, but
  // only while the key is still this one. Another app may have moved it on
  // meanwhile and written rows this pass must not touch.
  // A row's id does not change with the key, so a row rewritten above is not stale.
  const stale = server.filter((r) => r.key_tag !== tag && !sentIds.has(r.id)).map((r) => r.id);
  if (stale.length && (await deps.store.state()).keyTag === tag) await deps.store.dropCopy(stale);
  writeMemo({ pubkey: deps.pubkey, tag, fps: nextFps });
  lastCopy = { pubkey: deps.pubkey, tag, writes: writesNow, at: now };
  return sent.length;
}

/** A remaining browser's fresh half, from a `keyhalf` row. */
interface FreshHalf {
  row: string;
  /** The connection that posted it, as the server wrote it. */
  tokenId: string | null;
  kext: Uint8Array;
}

/**
 * Write the server half of each fresh browser half for the account's current
 * P, and keep the half in the synced settings so a later removal is noticed.
 * The connection that posted the row names the browser, never the sealed
 * payload. A row of a connection that is gone, or one without logins, goes.
 * One whose key this app has not seen yet, or whose tag moved meanwhile,
 * waits for the next pass. Returns the rows settled.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4 step 7)
 */
async function takeFreshHalves(deps: ExtensionSyncDeps, state: ExtensionState, halves: FreshHalf[]): Promise<number> {
  if (!deps.store.rehalf) return 0;
  const done: string[] = [];
  for (const half of halves) {
    const ext = state.extensions.find((e) => e.id === half.tokenId && e.logins && e.client === 'browser');
    if (!ext || !state.keyTag) {
      done.push(half.row);
      continue;
    }
    const p = loginsKeyFor(deps.readKeys(), deps.contentKey, state.keyTag);
    if (!p || !deps.isCurrent()) continue;
    try {
      await deps.store.rehalf(ext.id, state.keyTag, bytesToBase64(serverHalf(p, half.kext)), browserHalfId(half.kext));
    } catch (err) {
      // Another app changed the key first: the next pass uses the new one.
      if (err instanceof ExtensionCallError && err.code === 'key_conflict') continue;
      if (err instanceof ExtensionCallError && err.code === 'not_found') {
        done.push(half.row);
        continue;
      }
      throw err;
    }
    deps.saveKeys((k) => withBrowserHalf(k, deps.contentKey, ext.id, half.kext));
    ext.key_tag = state.keyTag;
    done.push(half.row);
  }
  if (done.length && deps.isCurrent()) await deps.store.deleteInbox(done);
  return done.length;
}

/** Open one copy row: what the extension does, here for the tests. Null when
 *  the plaintext is not a copy entry this version knows. */
export function openCopyRow(p: Uint8Array, pubkey: string, row: { id: string; ciphertext: string; nonce: string }): CopyEntry | null {
  return parseCopyEntry(decryptJsonAad<unknown>(base64ToBytes(row.ciphertext), base64ToBytes(row.nonce), p, loginsCopyAad(pubkey, row.id)));
}
