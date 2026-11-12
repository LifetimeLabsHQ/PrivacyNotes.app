/**
 * Excalidraw importer: drawings saved from excalidraw.com (`.excalidraw`, a
 * JSON scene) and from Obsidian's Excalidraw plugin (`.excalidraw.md`, the
 * same JSON in a fenced block under `## Drawing`), one file or a .zip of
 * them. Each file becomes one drawing item (type `drawing`).
 *
 * Format facts: the `.excalidraw` file is the body format our drawings use
 * (`drawing/scene.ts`), except that each picture carries its bytes as
 * `files[id].dataURL`. The body never holds bytes, so every picture travels
 * as an `ImportBlob` keyed by a placeholder `src`, and the shared blob import
 * swaps the placeholder for its `pn:img/` reference, with the image switches,
 * the quota preflight and the dedupe every importer's pictures get. A `src`
 * the file brought is dropped: only a picture with bytes is kept.
 *
 * Not read: Obsidian's `compressed-json` block (LZ-String, which this build
 * has no decoder for; a warning names the files), and Obsidian's embedded
 * files, which sit beside the drawing in the vault rather than inside it
 * (the drawing shows Excalidraw's empty box; a warning counts them).
 * Synthetic only: built from the public format, with no lab fixture.
 * Spec: docs/internal/specs/drawing.md (section 0, Exports)
 */

import { parseScene, serializeScene } from '../drawing/scene';
import { IMAGE_FORMAT_MIME, sniffImageFormat } from '../imageMetadata';
import { isUntitledStem } from '../exportNames';
import { oneLineTitle } from '../oneLineTitle';
import i18n from '../i18n';
import { zipEntryText } from './zipEntry';
import { shouldSkip } from './markdown';
import { buildFolderTree, commonRootPrefix } from './folderImport';
import type { ImportBlob, ImportedNote, ParsedImport } from './types';

/** A drawing file as read: its path inside the zip (or its name), text, date. */
type SourceFile = { path: string; text: string; date: Date | null };

const msg = (key: string, options?: Record<string, unknown>): string => i18n.t(`importExport:importLog.excalidraw.${key}`, options);

export const DRAWING_FILE = /\.excalidraw(?:\.md)?$/i;

const noDrawing = (): string => msg('noDrawing');

/** A date from the file, or now when it is missing or impossible. */
function stampOf(date: Date | null): string {
  const ms = date?.getTime();
  const now = Date.now();
  return ms !== undefined && Number.isFinite(ms) && ms > 0 && ms <= now ? new Date(ms).toISOString() : new Date(now).toISOString();
}

/** The scene JSON an Obsidian `.excalidraw.md` holds, or why it has none. */
function obsidianScene(text: string): { json: string } | 'compressed' | null {
  const heading = /^#{1,6}\s*Drawing\s*$/m.exec(text);
  if (!heading) return null;
  const fence = /```(json|compressed-json)[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/.exec(text.slice(heading.index));
  if (!fence) return null;
  return fence[1] === 'compressed-json' ? 'compressed' : { json: fence[2]! };
}

/** The bytes of a base64 picture data URL, or null for anything else. */
function dataUrlBytes(url: string): Uint8Array | null {
  const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]*)$/.exec(url);
  if (!m) return null;
  try {
    const bin = atob(m[1]!.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What one drawing file came to. */
export type DrawingRead = { note: ImportedNote; empty: boolean; outsidePictures: number; unreadablePictures: number } | 'compressed' | 'refused';

/**
 * One `.excalidraw` or Obsidian `.excalidraw.md` file as a drawing item,
 * filed under the folder its path names. Its pictures go into `blobs`
 * under placeholder keys the body names. The Obsidian vault import reads
 * a vault's drawings through this too.
 */
export function readDrawing(path: string, text: string, date: Date | null, blobs: Map<string, ImportBlob>): DrawingRead {
  const name = path.split('/').pop() ?? path;
  let json: string | null = text;
  if (/\.md$/i.test(name)) {
    const found = obsidianScene(text);
    if (found === 'compressed') return 'compressed';
    json = found?.json ?? null;
  }
  // An empty text is an empty scene to `parseScene`, never a drawing here.
  const scene = json?.trim() ? parseScene(json) : null;
  if (!scene) return 'refused';
  // parseScene has read this JSON, so it parses; the pictures' bytes are in it.
  const raw = JSON.parse(json!) as unknown;
  const rawFiles = isRecord(raw) && isRecord(raw.files) ? raw.files : {};

  // Every picture with bytes gets a placeholder src, which the blob import
  // turns into its reference. One the store cannot keep is left out.
  const pictures: Record<string, { id: string; mimeType: string; created: number; src: string }> = {};
  const placeholders = new Map<string, string>();
  let unreadablePictures = 0;
  for (const [id, entry] of Object.entries(rawFiles)) {
    if (!isRecord(entry) || typeof entry.dataURL !== 'string') continue;
    const bytes = dataUrlBytes(entry.dataURL);
    const mime = bytes ? IMAGE_FORMAT_MIME[sniffImageFormat(bytes)] : undefined;
    if (!bytes || !mime) {
      unreadablePictures++;
      continue;
    }
    const key = `excalidrawimg:${crypto.randomUUID()}`;
    placeholders.set(key, id);
    pictures[id] = { id, mimeType: mime, created: typeof entry.created === 'number' ? entry.created : Date.now(), src: key };
    blobs.set(key, { data: bytes, mime, name: `${id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'picture'}.${mime.slice('image/'.length)}` });
  }
  const live = scene.elements.filter((e) => e.isDeleted !== true);
  const outsidePictures = live.filter((e) => e.type === 'image' && typeof e.fileId === 'string' && !Object.hasOwn(pictures, e.fileId)).length;

  const body = serializeScene({ ...scene, files: {} }, scene.elements, scene.appState, pictures, (id) => (Object.hasOwn(pictures, id) ? pictures[id]!.src : undefined));
  // A picture no live element shows never reaches the body: drop its bytes too.
  for (const key of placeholders.keys()) {
    if (!body.includes(key)) blobs.delete(key);
  }
  const stem = name.replace(DRAWING_FILE, '');
  return { note: drawingNote(path, stem, body, date), empty: live.length === 0, outsidePictures, unreadablePictures };
}

/** A drawing item for a file: its name as the title, its folder from the path. */
export function drawingNote(path: string, stem: string, body: string, date: Date | null): ImportedNote {
  const stamp = stampOf(date);
  const dir = path.split('/').slice(0, -1).filter(Boolean).join('/');
  return {
    title: isUntitledStem(stem) ? '' : oneLineTitle(stem),
    body,
    tags: [],
    createdAt: stamp,
    updatedAt: stamp,
    type: 'drawing',
    ...(dir ? { folderPath: dir.split('/') } : {}),
  };
}

async function readFiles(file: File, onProgress?: (msg: string) => void): Promise<SourceFile[]> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!(head[0] === 0x50 && head[1] === 0x4b)) {
    return [{ path: file.name, text: await file.text(), date: file.lastModified ? new Date(file.lastModified) : null }];
  }
  onProgress?.(i18n.t('importExport:importLog.shared.readingZip'));
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((e) => !e.dir && !shouldSkip(e.name) && DRAWING_FILE.test(e.name));
  const prefix = commonRootPrefix(entries.map((e) => e.name));
  const out: SourceFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    out.push({ path: entry.name.slice(prefix.length), text: await zipEntryText(entry), date: entry.date ?? null });
  }
  return out;
}

export async function parseExcalidraw(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  const files = await readFiles(file, onProgress);
  if (files.length === 0) throw new Error(noDrawing());

  const notes: ImportedNote[] = [];
  const blobs = new Map<string, ImportBlob>();
  const refused: string[] = [];
  const compressed: string[] = [];
  let emptyNotes = 0;
  let outsidePictures = 0;
  let unreadablePictures = 0;

  for (const [i, f] of files.entries()) {
    onProgress?.(msg('readingDrawings', { current: i + 1, total: files.length }));
    const name = f.path.split('/').pop() ?? f.path;
    const read = readDrawing(f.path, f.text, f.date, blobs);
    if (read === 'compressed') compressed.push(name);
    else if (read === 'refused') refused.push(name);
    else {
      notes.push(read.note);
      if (read.empty) emptyNotes++;
      outsidePictures += read.outsidePictures;
      unreadablePictures += read.unreadablePictures;
    }
  }

  if (notes.length === 0) {
    throw new Error(compressed.length > 0 ? compressedLine(compressed) : noDrawing());
  }
  // Folders only for the drawings that came in, so a folder of refused
  // files is never made empty.
  const { folders, dirToFolderId } = buildFolderTree(notes.flatMap((n) => (n.folderPath ? [n.folderPath.join('/')] : [])));
  for (const n of notes) {
    if (n.folderPath) n.folderId = dirToFolderId.get(n.folderPath.join('/')) ?? null;
  }

  const warnings = drawingWarnings(refused, compressed, outsidePictures, unreadablePictures);

  const out: ParsedImport = {
    notes,
    warnings,
    transforms: [],
    stats: { totalNotes: notes.length, emptyNotes, untaggedNotes: notes.length, uniqueTags: 0 },
    source: 'excalidraw',
    ...(blobs.size > 0 ? { blobs } : {}),
  };
  if (folders.length > 0) out.folders = folders;
  return out;
}

/** The warnings for the drawing files an import read. */
export function drawingWarnings(refused: string[], compressed: string[], outsidePictures: number, unreadablePictures: number): string[] {
  const warnings: string[] = [];
  if (refused.length > 0) warnings.push(msg('refused', { count: refused.length, names: namesOf(refused) }));
  if (compressed.length > 0) warnings.push(compressedLine(compressed));
  if (outsidePictures > 0) warnings.push(msg('outsidePictures', { count: outsidePictures }));
  if (unreadablePictures > 0) warnings.push(msg('unreadablePictures', { count: unreadablePictures }));
  return warnings;
}

function namesOf(names: string[]): string {
  return names.length > 5 ? msg('namesMore', { list: names.slice(0, 5).join(', '), count: names.length - 5 }) : names.join(', ');
}

function compressedLine(names: string[]): string {
  return msg('compressed', { count: names.length, names: namesOf(names) });
}
