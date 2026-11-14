/**
 * A quick note from the Ninja box (#694 request 2, way C). The main window
 * saves it at once when the app is unlocked. Behind the lock screen it has no
 * content key, so it seals the note to the account's inbox public key, as the
 * extension and `privacynotes` do, and keeps it in `db.quickNotes` on this
 * computer. At the next unlock the app opens each row with the inbox secret
 * and adds it through the note branch of the extension inbox. Nothing goes to
 * the server until then, and the box never gets a note back.
 *
 * The inbox public key is written to `db.kv` at every unlock, with the
 * account it belongs to, so a cold start behind the lock screen has it. It is
 * public: the extension's pairing code carries it too. A full sign-out deletes
 * it and the queue (clearLocalDatabase).
 * Spec: docs/internal/plans/quick-note-694.md (section 5.2)
 */
import { bytesToBase64, base64ToBytes, phraseToSeed } from '@notes/shared';
import { deriveInboxKeyPair, padInboxJson, parseInboxNote, sealInbox, type InboxNote } from '@notes/shared/extension';
import { db, QUICK_NOTE_INBOX_KEY } from './db';
import { createInboxNote, inboxSecretOf, openInboxRow } from './extensionSync';
import { holdsEveryEpoch } from './keyRing';
import { loadLocalSettings } from './userSettings';
import { parseQuickAdd } from './quickAdd';
import { quickAddContext } from './quickAddContext';
import { toLocalIso } from './intlFormat';

/** At most this many notes wait for an unlock. Spec: docs/internal/plans/quick-note-694.md (section 5.2 step 5) */
export const QUICK_NOTE_MAX = 100;

interface InboxKeyEntry {
  /** The account's signing public key, hex. */
  account: string;
  /** Its inbox public key, base64. */
  inbox: string;
}

/** What the box sends: the title line as typed, the text under it. */
export interface QuickNoteInput {
  title: string;
  markdown: string;
}

export type QuickNoteAnswer = 'saved' | 'queued' | 'too_long' | 'full' | 'locked' | 'empty' | 'failed';

/**
 * The title line read the way Ninja's `+` line reads it: `#tag` words become
 * tags and a `/Folder` word the folder, when the folder exists. Dates and
 * times stay in the title, because a note has no day.
 */
function readTitleLine(line: string): { title: string; tags: string[]; folderId: string | null } {
  const folders = loadLocalSettings().folders.map((f) => ({ id: f.id, name: f.name }));
  const parsed = parseQuickAdd(line, { ...quickAddContext(), today: toLocalIso(new Date()), folders, as: 'note' });
  let title = line;
  for (const part of parsed.parts) {
    if (part.kind === 'tag' || part.kind === 'folder') title = title.replace(part.text, ' ');
  }
  return { title: title.replace(/\s+/g, ' ').trim(), tags: parsed.tags, folderId: parsed.folderId };
}

/**
 * The note as an inbox row would carry it, or why not. With no text under
 * the title, the title is the text and the title is left empty: the list
 * shows the first line, and an older app refuses a row with no text.
 */
async function quickInboxNote(input: QuickNoteInput, id: string): Promise<InboxNote | 'too_long' | 'empty'> {
  const { title, tags, folderId } = readTitleLine(input.title);
  const text = input.markdown.trim() ? input.markdown : title;
  if (!text.trim()) return 'empty';
  const note: InboxNote = {
    v: 1, id, title: input.markdown.trim() ? title : '', markdown: text, tags, savedAt: new Date().toISOString(), from: 'quick',
    ...(folderId ? { folder: folderId } : {}),
  };
  if (!parseInboxNote(note, id)) return 'too_long';
  // The size rule the adoption runs (createInboxNote), so a note queued
  // behind the lock is never refused at the next unlock.
  const { inboxNoteFits } = await import('@notes/clipper');
  return inboxNoteFits(note.markdown) ? note : 'too_long';
}

const hasFolder = (id: string) => loadLocalSettings().folders.some((f) => f.id === id);

/**
 * The app is unlocked: the note goes in at once, through the same checks and
 * the same note branch as a sealed one, so both ways make the same note.
 */
export async function saveQuickNote(input: QuickNoteInput, isCurrent: () => boolean): Promise<QuickNoteAnswer> {
  const id = crypto.randomUUID();
  const note = await quickInboxNote(input, id);
  if (typeof note === 'string') return note;
  const made = await createInboxNote(note, id, { isCurrent, hasFolder });
  return made === 'created' ? 'saved' : made === 'refused' ? 'too_long' : 'failed';
}

/** At unlock: keep the inbox public key for the next time the app is locked. */
export async function rememberInboxKey(account: string, phrase: string): Promise<void> {
  const inbox = bytesToBase64(deriveInboxKeyPair(phraseToSeed(phrase)).publicKey);
  const value = JSON.stringify({ account, inbox } satisfies InboxKeyEntry);
  if ((await db.kv.get(QUICK_NOTE_INBOX_KEY))?.value !== value) await db.kv.put({ key: QUICK_NOTE_INBOX_KEY, value });
}

async function readInboxKey(): Promise<InboxKeyEntry | null> {
  try {
    const raw = (await db.kv.get(QUICK_NOTE_INBOX_KEY))?.value;
    const entry = typeof raw === 'string' ? (JSON.parse(raw) as InboxKeyEntry) : null;
    return entry && /^[0-9a-f]{64}$/.test(entry.account) && typeof entry.inbox === 'string' ? entry : null;
  } catch {
    return null;
  }
}

/** Whether a locked app can take a quick note: it knows where to seal one. */
export async function canQueue(): Promise<boolean> {
  return (await readInboxKey()) !== null;
}

/** Behind the lock screen: seal the note and keep it until the next unlock. */
export async function queueQuickNote(input: QuickNoteInput): Promise<QuickNoteAnswer> {
  const key = await readInboxKey();
  if (!key) return 'locked';
  if ((await db.quickNotes.count()) >= QUICK_NOTE_MAX) return 'full';
  const id = crypto.randomUUID();
  const note = await quickInboxNote(input, id);
  if (typeof note === 'string') return note;
  const payload = sealInbox(padInboxJson(note), base64ToBytes(key.inbox), { account: key.account, id, kind: 'note' });
  await db.quickNotes.add({ id, account: key.account, payload, created: note.savedAt });
  return 'queued';
}

/**
 * At unlock: add the waiting notes of this account, oldest first, and delete
 * each row once its note is in the local database. A row opens with the
 * current inbox secret or the secret of an earlier epoch (the key it was
 * sealed to can be the one before a phrase change), and its note takes the
 * id of the secret that opened it. A row that opens under none, or fails the
 * shape check, is deleted, as a bad inbox row is; one that opens under none
 * while this device lacks the key of an epoch the account has had waits for
 * it. Rows of another account are left alone; a full sign-out deletes them.
 * Returns the ids of the notes it made.
 * Spec: docs/internal/plans/phrase-change.md (6.2, inbox rows)
 */
export async function adoptQuickNotes(
  account: string,
  phrase: string,
  isCurrent: () => boolean,
): Promise<string[]> {
  const rows = (await db.quickNotes.where('account').equals(account).toArray()).sort((a, b) => a.created.localeCompare(b.created));
  if (!rows.length) return [];
  const secret = inboxSecretOf(account, phrase);
  const made: string[] = [];
  for (const row of rows) {
    if (!isCurrent()) break;
    const opened = openInboxRow(row.payload, secret, { account, id: row.id, kind: 'note' });
    if (!opened && !holdsEveryEpoch()) continue;
    let note: InboxNote | null = null;
    try {
      note = opened ? parseInboxNote(JSON.parse(new TextDecoder().decode(opened.plain)), row.id) : null;
    } catch {
      note = null;
    }
    const itemId = opened?.itemId;
    if (note && itemId && !(await db.notes.get(itemId))) {
      const result = await createInboxNote(note, itemId, { isCurrent, hasFolder });
      if (result === 'stopped') break;
      if (result === 'created') made.push(itemId);
    }
    await db.quickNotes.delete(row.id);
  }
  return made;
}
