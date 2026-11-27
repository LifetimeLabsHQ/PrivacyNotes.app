/**
 * Items other apps shared into the phone app, taken once the app can act.
 *
 * The system share sheet hands an item to a separate process (the iOS share
 * extension), which drops it into an inbox folder and never sees a key. This
 * hook drains that inbox from inside the authenticated shell: NotesView only
 * mounts after sign-in and after the app lock, so nothing is saved before the
 * user has proved who they are, and each item is encrypted like any other the
 * moment it becomes one. It drains on mount, whenever the app comes back to
 * the front (how a user returns from the iOS share sheet), and on the
 * `pn-share-inbox` event Android's activity fires once a share is copied.
 *
 * Each shared item carries a validated target chosen in the unified share
 * sheet (Bookmark, Clip page, Note, Task, Today's journal, or Files) plus
 * optional organization metadata (Task list, Folder, Tags). An item leaves
 * the inbox only once it is saved; one that fails stays for the next drain and
 * does not hold up the items after it.
 * Spec: docs/internal/specs/share-into-app.md
 */
import { useEffect, useRef } from 'react';
import { detectPlatform } from './devices';
import { normalizeUrl } from './linkBody';
import { perFileLimit } from './attachmentValidation';
import { isSupportedImage } from './imageProcessing';
import { isDemoMode, proUnlocked } from './demo';
import {
  clearShareInboxPendingMark,
  hasLiveSignIn,
  hasShareInboxClearPending,
  markShareInboxClearPending,
  signInStamp,
  signedOutSince,
} from './liveSignIn';
import type { LaterFile } from './notesView/useFilesUpload';

export type ShareTarget = 'bookmark' | 'clip' | 'note' | 'task' | 'journal' | 'files';

export interface SharedItem {
  id: string;
  kind: 'url' | 'text' | 'file';
  created: number;
  url?: string;
  title?: string;
  text?: string;
  name?: string;
  mime?: string;
  size?: number;
  /** Destination chosen in the share sheet (Bookmark, Clip, Note, Task, Journal, Files). */
  target?: ShareTarget;
  /** Shared batch id grouping multiple files from one share into one note or journal entry. */
  group?: string;
  /** Chosen task list note id when target is 'task' (absent or gone -> Quick Tasks). */
  taskListId?: string;
  /** Chosen folder id (Pro-gated; ignored on free accounts or unknown folders). */
  folderId?: string;
  /** Chosen tags to apply on save. */
  tags?: string[];
}

interface ShareChoice {
  target: ShareTarget;
  title?: string;
  text?: string;
  taskListId?: string | null;
  folderId?: string | null;
  tags?: string[];
}

export type ShareApproval =
  | 'save'
  | 'discard'
  | 'later'
  | { action: 'save'; asNote: { title: string; text: string } }
  | { action: 'save'; choice: ShareChoice };

export interface ShareOrg {
  folderId?: string;
  tags?: string[];
}

export interface ShareCatalogPayload {
  foldersUnlocked: boolean;
  taskLists: { id: string; title: string }[];
  folders: { id: string; name: string }[];
  tags: string[];
}

type ShareFile = { id: string; name: string; mime: string; size: number };

export type ShareStep =
  | { kind: 'bookmark'; id: string; url: string; title: string; text?: string; folderId?: string; tags?: string[] }
  | { kind: 'clip'; id: string; url: string; title: string; text?: string; folderId?: string; tags?: string[] }
  | { kind: 'note'; id: string; title?: string; text: string; url?: string; folderId?: string; tags?: string[] }
  | { kind: 'task'; id: string; url?: string; title?: string; text?: string; taskListId?: string }
  | { kind: 'journal'; id: string; url?: string; title?: string; text?: string; tags?: string[] }
  | { kind: 'photoNote'; title: string; text: string; files: ShareFile[]; folderId?: string; tags?: string[] }
  | { kind: 'photoJournal'; text: string; files: ShareFile[]; tags?: string[] }
  | { kind: 'fileNote'; title: string; text: string; files: ShareFile[]; folderId?: string; tags?: string[] }
  | { kind: 'files'; files: ShareFile[]; folderId?: string; tags?: string[] };

/** Whether a waiting share item is an image the note image pipeline can embed. */
export function isSharedImage(item: SharedItem): boolean {
  return item.kind === 'file' && isSupportedImage({ type: item.mime ?? '', name: item.name ?? '' });
}

/** Whether a shared file was classified as an image by the OS share sheet
 *  (including formats such as AVIF/HEIC that the image pipeline may refuse). */
function isImageFileItem(item: SharedItem): boolean {
  return isSharedImage(item) || (item.kind === 'file' && /^image\//i.test(item.mime ?? ''));
}

/** A text that is nothing but one valid web address, which people share as text. */
export function loneWebUrl(text: string): string | null {
  const t = text.trim();
  return /^https?:\/\/\S+$/i.test(t) ? normalizeUrl(t) : null;
}

const LAST_TASK_LIST_KEY = 'privacynotes.share.lastTaskList';

export function readLastShareTaskList(): string | null {
  try {
    const raw = localStorage.getItem(LAST_TASK_LIST_KEY)?.trim() ?? '';
    return raw || null;
  } catch {
    return null;
  }
}

export function writeLastShareTaskList(id: string | null): void {
  try {
    if (id && id.trim()) localStorage.setItem(LAST_TASK_LIST_KEY, id.trim());
    else localStorage.removeItem(LAST_TASK_LIST_KEY);
  } catch {
    // Storage disabled.
  }
}

/** What to create, in the order the items were shared, with grouped photo/file
 *  notes and file uploads combined cleanly. Pure, for the tests. */
export function planShares(items: SharedItem[]): ShareStep[] {
  const steps: ShareStep[] = [];
  let filesStep: Extract<ShareStep, { kind: 'files' }> | null = null;
  const photoNotes = new Map<string, Extract<ShareStep, { kind: 'photoNote' }>>();
  const photoJournals = new Map<string, Extract<ShareStep, { kind: 'photoJournal' }>>();
  const fileNotes = new Map<string, Extract<ShareStep, { kind: 'fileNote' }>>();

  for (const item of items) {
    const org: ShareOrg = {
      ...(item.folderId ? { folderId: item.folderId } : {}),
      ...(item.tags?.length ? { tags: item.tags } : {}),
    };

    if (item.kind === 'url' && item.url) {
      if (item.target === 'clip') {
        steps.push({
          kind: 'clip',
          id: item.id,
          url: item.url,
          title: item.title ?? '',
          ...(item.text ? { text: item.text } : {}),
          ...org,
        });
      } else if (item.target === 'task') {
        steps.push({
          kind: 'task',
          id: item.id,
          url: item.url,
          ...(item.title ? { title: item.title } : {}),
          ...(item.text ? { text: item.text } : {}),
          ...(item.taskListId ? { taskListId: item.taskListId } : {}),
        });
      } else if (item.target === 'journal') {
        steps.push({
          kind: 'journal',
          id: item.id,
          url: item.url,
          ...(item.title ? { title: item.title } : {}),
          ...(item.text ? { text: item.text } : {}),
          ...(item.tags?.length ? { tags: item.tags } : {}),
        });
      } else if (item.target === 'note') {
        steps.push({
          kind: 'note',
          id: item.id,
          ...(item.title ? { title: item.title } : {}),
          text: item.text ?? '',
          url: item.url,
          ...org,
        });
      } else {
        steps.push({
          kind: 'bookmark',
          id: item.id,
          url: item.url,
          title: item.title ?? '',
          ...(item.text ? { text: item.text } : {}),
          ...org,
        });
      }
    } else if (item.kind === 'text' && item.text) {
      const url = loneWebUrl(item.text);
      if (item.target === 'task') {
        steps.push({
          kind: 'task',
          id: item.id,
          ...(url ? { url } : { text: item.text }),
          ...(item.title ? { title: item.title } : {}),
          ...(item.taskListId ? { taskListId: item.taskListId } : {}),
        });
      } else if (item.target === 'journal') {
        steps.push({
          kind: 'journal',
          id: item.id,
          ...(url ? { url } : { text: item.text }),
          ...(item.title ? { title: item.title } : {}),
          ...(item.tags?.length ? { tags: item.tags } : {}),
        });
      } else if (item.target === 'note') {
        steps.push({
          kind: 'note',
          id: item.id,
          ...(item.title ? { title: item.title } : {}),
          text: item.text,
          ...org,
        });
      } else if (url) {
        steps.push({
          kind: 'bookmark',
          id: item.id,
          url,
          title: item.title ?? '',
          ...org,
        });
      } else {
        steps.push({
          kind: 'note',
          id: item.id,
          ...(item.title ? { title: item.title } : {}),
          text: item.text,
          ...org,
        });
      }
    } else if (item.kind === 'file' && item.target === 'note') {
      const key = item.group ?? item.id;
      const entry: ShareFile = { id: item.id, name: item.name ?? 'file', mime: item.mime ?? '', size: item.size ?? 0 };
      if (isImageFileItem(item) && !fileNotes.has(key)) {
        let step = photoNotes.get(key);
        if (!step) {
          step = { kind: 'photoNote', title: item.title ?? '', text: item.text ?? '', files: [], ...org };
          photoNotes.set(key, step);
          steps.push(step);
        } else {
          if (!step.title && item.title) step.title = item.title;
          if (!step.text && item.text) step.text = item.text;
          if (!step.folderId && item.folderId) step.folderId = item.folderId;
          if (!step.tags?.length && item.tags?.length) step.tags = item.tags;
        }
        step.files.push(entry);
      } else {
        // Non-image file (or mixed batch with a non-image) saved as a Note with attachment link(s).
        let step = fileNotes.get(key);
        const existingPhotos = photoNotes.get(key);
        if (!step && existingPhotos) {
          // Promote a mixed batch (image + non-image sharing a group) to fileNote so all files attach cleanly.
          const idx = steps.indexOf(existingPhotos);
          step = {
            kind: 'fileNote',
            title: existingPhotos.title,
            text: existingPhotos.text,
            files: [...existingPhotos.files],
            ...(existingPhotos.folderId ? { folderId: existingPhotos.folderId } : {}),
            ...(existingPhotos.tags?.length ? { tags: existingPhotos.tags } : {}),
          };
          photoNotes.delete(key);
          fileNotes.set(key, step);
          if (idx >= 0) steps[idx] = step;
          else steps.push(step);
        } else if (!step) {
          step = { kind: 'fileNote', title: item.title ?? '', text: item.text ?? '', files: [], ...org };
          fileNotes.set(key, step);
          steps.push(step);
        } else {
          if (!step.title && item.title) step.title = item.title;
          if (!step.text && item.text) step.text = item.text;
          if (!step.folderId && item.folderId) step.folderId = item.folderId;
          if (!step.tags?.length && item.tags?.length) step.tags = item.tags;
        }
        step.files.push(entry);
      }
    } else if (item.kind === 'file' && item.target === 'journal' && isImageFileItem(item)) {
      const key = item.group ?? item.id;
      let step = photoJournals.get(key);
      if (!step) {
        step = {
          kind: 'photoJournal',
          text: item.text ?? '',
          files: [],
          ...(item.tags?.length ? { tags: item.tags } : {}),
        };
        photoJournals.set(key, step);
        steps.push(step);
      } else {
        if (!step.text && item.text) step.text = item.text;
        if (!step.tags?.length && item.tags?.length) step.tags = item.tags;
      }
      step.files.push({ id: item.id, name: item.name ?? 'file', mime: item.mime ?? '', size: item.size ?? 0 });
    } else if (item.kind === 'file') {
      if (!filesStep) {
        filesStep = { kind: 'files', files: [], ...org };
        steps.push(filesStep);
      } else {
        if (!filesStep.folderId && item.folderId) filesStep.folderId = item.folderId;
        if (!filesStep.tags?.length && item.tags?.length) filesStep.tags = item.tags;
      }
      filesStep.files.push({ id: item.id, name: item.name ?? 'file', mime: item.mime ?? '', size: item.size ?? 0 });
    }
  }
  return steps;
}

export interface ShareHandlers {
  /** Saves a bookmark, or finds the one already saved. Returns its id, or null if aborted. */
  addBookmark: (url: string, title: string, opts?: ShareOrg & { text?: string }) => Promise<string | null>;
  /** Clips a web page into a full note, falling back to a bookmark when clipping fails. */
  addClip?: (url: string, title: string, opts?: ShareOrg & { text?: string }) => Promise<string | null>;
  /** Saves a note and returns its id, or null if aborted. */
  addNote: (text: string, opts?: ShareOrg & { title?: string; url?: string }) => Promise<string | null>;
  /** Appends a task item to the chosen task list (or Quick Tasks fallback). */
  addTask?: (input: { url?: string; title?: string; text?: string; taskListId?: string }) => Promise<string | null>;
  /** Appends text/link to today's journal entry (creating it when missing). */
  addJournal?: (input: { url?: string; title?: string; text?: string; tags?: string[] }) => Promise<string | null>;
  /** Saves shared photo(s) as an encrypted note with inline images (#870). */
  addPhotoNote: (
    title: string,
    text: string,
    files: LaterFile[],
    opts?: ShareOrg,
  ) => Promise<{ noteId: string | null; handled: LaterFile[] }>;
  /** Appends shared photo(s) + optional caption to today's journal entry. */
  addPhotoJournal?: (
    text: string,
    files: LaterFile[],
    opts?: { tags?: string[] },
  ) => Promise<{ noteId: string | null; handled: LaterFile[] }>;
  /** Uploads non-image (or mixed) files and embeds their attachment links inside a new note. */
  addFileNote?: (
    title: string,
    text: string,
    files: LaterFile[],
    opts?: ShareOrg,
  ) => Promise<{ noteId: string | null; handled: LaterFile[] }>;
  /** Stores files through the Files upload path, which shows its own progress. */
  addFiles: (files: LaterFile[], opts?: ShareOrg) => Promise<LaterFile[]>;
  /** Shows the item made last, once the whole inbox is in. */
  reveal: (id: string) => void;
  /** False until the shell's first sync has run. */
  ready: boolean;
  /** Identity and phrase scope (`${pubkey}:${phrase}`). */
  scopeKey?: string;
  /** Asks the person about the waiting items before anything is saved (Android). */
  approve?: (items: SharedItem[]) => Promise<ShareApproval>;
}

let publishedLimit: number | null = null;
let limitGen = 0;
let publishedCatalogJson: string | null = null;
let catalogGen = 0;

/**
 * Tells the iOS share extension this account's per-file limit, so a file the
 * upload would refuse is refused in the share sheet, with the reason, instead
 * of after a "Saved".
 */
export function publishShareLimit(isPro: boolean, maxTotalBytes: number) {
  if (detectPlatform() !== 'ios' || isDemoMode() || !hasLiveSignIn()) return;
  const limit = perFileLimit(proUnlocked(isPro), maxTotalBytes > 500 * 1000 * 1000);
  if (limit === publishedLimit) return;
  const gen = ++limitGen;
  const stamp = signInStamp();
  publishedLimit = limit;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => {
      if (gen !== limitGen || !hasLiveSignIn() || signedOutSince(stamp)) {
        if (gen === limitGen) publishedLimit = null;
        return;
      }
      return invoke('share_limit_set', { bytes: limit });
    })
    .catch((err) => {
      if (gen === limitGen) publishedLimit = null;
      console.warn('[shareInbox] limit not written:', err);
    });
}

/**
 * Mirrors non-PIN-protected task list names, Pro folder names, and tags to the
 * iOS share extension while App Lock is off. Passing `null` (when App Lock is
 * enabled) clears the catalog file and last-picked task list immediately so no
 * vault metadata sits readable while the app is locked.
 */
export function publishShareCatalog(catalog: ShareCatalogPayload | null) {
  if (detectPlatform() !== 'ios' || isDemoMode() || !hasLiveSignIn()) return;
  const signature = catalog ? JSON.stringify(catalog) : 'null';
  if (signature === publishedCatalogJson) return;
  const gen = ++catalogGen;
  const stamp = signInStamp();
  publishedCatalogJson = signature;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => {
      if (gen !== catalogGen || !hasLiveSignIn() || signedOutSince(stamp)) {
        if (gen === catalogGen) publishedCatalogJson = null;
        return;
      }
      return invoke('share_catalog_set', { catalog });
    })
    .catch((err) => {
      if (gen === catalogGen) publishedCatalogJson = null;
      console.warn('[shareInbox] catalog not written:', err);
    });
}

/** Module scope, so the drain of a remount (after the app lock, say) waits
 *  for one still running from before; two would save the same item twice. */
let queue: Promise<void> = Promise.resolve();
/** The items the person answered "later" for, in this run of the app. */
const deferred = new Set<string>();
let inboxGen = 0;
const activeDrains = new Set<() => void>();

/**
 * Empties the phone share inbox, removes ShareLimit, ShareCatalog, and
 * ShareLastPick beside it, and resets in-memory state so items or metadata
 * from a departing account cannot stay on disk or drain into the next vault.
 */
export async function clearShareInbox(): Promise<boolean> {
  if (isDemoMode()) return true;
  ++limitGen;
  publishedLimit = null;
  ++catalogGen;
  publishedCatalogJson = null;
  writeLastShareTaskList(null);
  deferred.clear();
  ++inboxGen;
  for (const abort of activeDrains) abort();
  activeDrains.clear();
  const platform = detectPlatform();
  if (platform !== 'ios' && platform !== 'android') {
    clearShareInboxPendingMark();
    return true;
  }
  markShareInboxClearPending();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('share_inbox_clear');
    clearShareInboxPendingMark();
    return true;
  } catch (err) {
    console.warn('[shareInbox] clear failed:', err);
    markShareInboxClearPending();
    return false;
  }
}

function applyApprovalChoice(items: SharedItem[], choice: ShareChoice): SharedItem[] {
  const group = items[0]?.id ?? 'group';
  const tags = choice.tags?.length ? choice.tags : undefined;
  const folderId = choice.target !== 'task' && choice.target !== 'journal' && choice.folderId ? choice.folderId : undefined;
  const taskListId = choice.target === 'task' && choice.taskListId ? choice.taskListId : undefined;
  const title = choice.title?.trim() || undefined;
  const text = choice.text?.trim() || undefined;

  return items.map((it) => {
    if (it.kind === 'file') {
      return {
        ...it,
        target: choice.target,
        ...(choice.target === 'note' || choice.target === 'journal' ? { group } : {}),
        ...(choice.target === 'note' && title ? { title } : {}),
        ...((choice.target === 'note' || choice.target === 'journal') && text ? { text } : {}),
        ...(folderId ? { folderId } : {}),
        ...(tags ? { tags } : {}),
      };
    }
    if (it.kind === 'url') {
      return {
        ...it,
        target: choice.target,
        ...(title !== undefined ? { title } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(taskListId ? { taskListId } : {}),
        ...(folderId ? { folderId } : {}),
        ...(choice.target !== 'task' && tags ? { tags } : {}),
      };
    }
    // Text item (possibly a lone URL).
    const lone = it.text ? loneWebUrl(it.text) : null;
    if (lone && (choice.target === 'clip' || choice.target === 'bookmark' || choice.target === 'task')) {
      return {
        ...it,
        kind: 'url',
        url: lone,
        target: choice.target,
        title: title ?? it.title,
        text: text ?? undefined,
        ...(taskListId ? { taskListId } : {}),
        ...(folderId ? { folderId } : {}),
        ...(choice.target !== 'task' && tags ? { tags } : {}),
      };
    }
    return {
      ...it,
      target: choice.target,
      ...(title !== undefined ? { title } : {}),
      text: text ?? it.text,
      ...(taskListId ? { taskListId } : {}),
      ...(folderId ? { folderId } : {}),
      ...(choice.target !== 'task' && tags ? { tags } : {}),
    };
  });
}

export async function drainOnce(
  live: () => boolean,
  handlers: (stillLive: () => boolean) => ShareHandlers,
  gone?: Promise<void>,
) {
  if (hasShareInboxClearPending()) {
    await clearShareInbox();
    return;
  }
  const gen = inboxGen;
  const drainStamp = signInStamp();
  const stillLive = () => live() && gen === inboxGen && !signedOutSince(drainStamp);
  if (!stillLive()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  const items = await invoke<SharedItem[]>('share_inbox_list');
  if (items.length === 0 || !stillLive()) return;
  let plannedItems = items;
  const approve = handlers(stillLive).approve;
  if (approve) {
    if (items.every((it) => deferred.has(it.id))) return;
    let cancelDrain!: () => void;
    const cleared = new Promise<'gone'>((resolve) => {
      cancelDrain = () => resolve('gone');
    });
    activeDrains.add(cancelDrain);
    let choice: ShareApproval | 'gone';
    try {
      choice = await Promise.race([
        approve(items),
        cleared,
        ...(gone ? [gone.then(() => 'gone' as const)] : []),
      ]);
    } finally {
      activeDrains.delete(cancelDrain);
    }
    if (choice === 'gone' || !stillLive()) return;
    if (choice === 'later') {
      for (const it of items) deferred.add(it.id);
      return;
    }
    for (const it of items) deferred.delete(it.id);
    if (choice === 'discard') {
      for (const it of items) {
        if (gen !== inboxGen) return;
        await invoke('share_inbox_remove', { id: it.id }).catch(() => {});
      }
      return;
    }
    if (typeof choice === 'object' && choice.action === 'save') {
      if ('choice' in choice) {
        if (choice.choice.target === 'task') {
          writeLastShareTaskList(choice.choice.taskListId ?? null);
        }
        plannedItems = applyApprovalChoice(items, choice.choice);
      } else {
        const group = items[0]?.id ?? 'note';
        plannedItems = items.map((it) =>
          isSharedImage(it)
            ? {
                ...it,
                target: 'note' as const,
                group,
                title: choice.asNote.title || undefined,
                text: choice.asNote.text || undefined,
              }
            : it,
        );
      }
    }
  }

  const makeLater = (list: ShareFile[]): LaterFile[] =>
    list.map((f) => ({
      name: f.name,
      size: f.size,
      read: async () => {
        if (!stillLive()) throw new Error('share drain ended');
        const bytes = await invoke<ArrayBuffer>('share_inbox_read', { id: f.id });
        if (!stillLive()) throw new Error('share drain ended');
        return new File([bytes], f.name, { type: f.mime });
      },
      discard: async () => {
        if (gen !== inboxGen) return;
        await invoke('share_inbox_remove', { id: f.id });
      },
    }));

  const orgOf = (s: { folderId?: string; tags?: string[] }): ShareOrg | undefined =>
    s.folderId || s.tags?.length
      ? { ...(s.folderId ? { folderId: s.folderId } : {}), ...(s.tags?.length ? { tags: s.tags } : {}) }
      : undefined;

  let last: string | null = null;
  for (const step of planShares(plannedItems)) {
    if (!stillLive()) return;
    try {
      const h = handlers(stillLive);
      let ids: string[];
      if (step.kind === 'bookmark') {
        const opts = orgOf(step) || step.text ? { ...orgOf(step), ...(step.text ? { text: step.text } : {}) } : undefined;
        const saved = opts ? await h.addBookmark(step.url, step.title, opts) : await h.addBookmark(step.url, step.title);
        if (saved === null) {
          if (!stillLive()) return;
          ids = [];
        } else {
          last = saved;
          ids = [step.id];
        }
      } else if (step.kind === 'clip') {
        const opts = orgOf(step) || step.text ? { ...orgOf(step), ...(step.text ? { text: step.text } : {}) } : undefined;
        const saved = h.addClip
          ? await h.addClip(step.url, step.title, opts)
          : await h.addBookmark(step.url, step.title, opts);
        if (saved === null) {
          if (!stillLive()) return;
          ids = [];
        } else {
          last = saved;
          ids = [step.id];
        }
      } else if (step.kind === 'note') {
        const opts = orgOf(step) || step.title || step.url
          ? { ...orgOf(step), ...(step.title ? { title: step.title } : {}), ...(step.url ? { url: step.url } : {}) }
          : undefined;
        const saved = opts ? await h.addNote(step.text, opts) : await h.addNote(step.text);
        if (saved === null) {
          if (!stillLive()) return;
          ids = [];
        } else {
          last = saved;
          ids = [step.id];
        }
      } else if (step.kind === 'task') {
        const saved = h.addTask
          ? await h.addTask({
              ...(step.url ? { url: step.url } : {}),
              ...(step.title ? { title: step.title } : {}),
              ...(step.text ? { text: step.text } : {}),
              ...(step.taskListId ? { taskListId: step.taskListId } : {}),
            })
          : await h.addNote(step.text ?? step.title ?? step.url ?? '');
        if (saved === null) {
          if (!stillLive()) return;
          ids = [];
        } else {
          last = saved;
          ids = [step.id];
        }
      } else if (step.kind === 'journal') {
        const saved = h.addJournal
          ? await h.addJournal({
              ...(step.url ? { url: step.url } : {}),
              ...(step.title ? { title: step.title } : {}),
              ...(step.text ? { text: step.text } : {}),
              ...(step.tags?.length ? { tags: step.tags } : {}),
            })
          : await h.addNote(step.text ?? step.title ?? step.url ?? '');
        if (saved === null) {
          if (!stillLive()) return;
          ids = [];
        } else {
          last = saved;
          ids = [step.id];
        }
      } else if (step.kind === 'photoNote') {
        const later = makeLater(step.files);
        const opts = orgOf(step);
        const res = opts
          ? await h.addPhotoNote(step.title, step.text, later, opts)
          : await h.addPhotoNote(step.title, step.text, later);
        if (res.noteId) last = res.noteId;
        const done = new Set(res.handled);
        ids = step.files.filter((_, i) => done.has(later[i]!)).map((f) => f.id);
        if (ids.length === 0 && !stillLive()) return;
      } else if (step.kind === 'photoJournal') {
        const later = makeLater(step.files);
        const res = h.addPhotoJournal
          ? await h.addPhotoJournal(step.text, later, step.tags?.length ? { tags: step.tags } : undefined)
          : await h.addPhotoNote('', step.text, later);
        if (res.noteId) last = res.noteId;
        const done = new Set(res.handled);
        ids = step.files.filter((_, i) => done.has(later[i]!)).map((f) => f.id);
        if (ids.length === 0 && !stillLive()) return;
      } else if (step.kind === 'fileNote') {
        const later = makeLater(step.files);
        const opts = orgOf(step);
        if (h.addFileNote) {
          const res = await h.addFileNote(step.title, step.text, later, opts);
          if (res.noteId) last = res.noteId;
          const done = new Set(res.handled);
          ids = step.files.filter((_, i) => done.has(later[i]!)).map((f) => f.id);
          if (ids.length === 0 && !stillLive()) return;
        } else {
          const done = new Set(opts ? await h.addFiles(later, opts) : await h.addFiles(later));
          ids = step.files.filter((_, i) => done.has(later[i]!)).map((f) => f.id);
          if (ids.length === 0 && !stillLive()) return;
        }
      } else {
        const later = makeLater(step.files);
        const opts = orgOf(step);
        const done = new Set(opts ? await h.addFiles(later, opts) : await h.addFiles(later));
        ids = step.files.filter((_, i) => done.has(later[i]!)).map((f) => f.id);
        if (ids.length === 0 && !stillLive()) return;
      }
      if (gen === inboxGen) {
        for (const id of ids) await invoke('share_inbox_remove', { id });
      }
    } catch (err) {
      console.warn('[shareInbox] item kept for the next drain:', err);
    }
  }
  if (last && stillLive()) handlers(stillLive).reveal(last);
}

export function useShareInbox(handlers: ShareHandlers | ((stillLive: () => boolean) => ShareHandlers)) {
  const ref = useRef(handlers);
  ref.current = handlers;

  const current = typeof handlers === 'function' ? handlers(() => false) : handlers;
  const { ready, scopeKey } = current;
  useEffect(() => {
    const platform = detectPlatform();
    if (!ready || isDemoMode() || (platform !== 'ios' && platform !== 'android')) return;
    let live = true;
    let drainWaiting = false;
    const mountStamp = signInStamp();
    let leave!: () => void;
    const gone = new Promise<void>((resolve) => { leave = resolve; });

    function drain() {
      if (!live || drainWaiting) return;
      drainWaiting = true;
      queue = queue
        .then(() => {
          drainWaiting = false;
          if (!live) return;
          return drainOnce(
            () => live && hasLiveSignIn() && !signedOutSince(mountStamp),
            (stillLive) => (typeof ref.current === 'function' ? ref.current(stillLive) : ref.current),
            gone,
          );
        })
        .catch((err) => {
          drainWaiting = false;
          console.warn('[shareInbox] drain failed:', err);
        });
    }

    function onVisible() {
      if (document.visibilityState === 'visible') drain();
    }

    drain();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pn-share-inbox', drain);
    return () => {
      live = false;
      leave();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pn-share-inbox', drain);
    };
  }, [ready, scopeKey]);
}
