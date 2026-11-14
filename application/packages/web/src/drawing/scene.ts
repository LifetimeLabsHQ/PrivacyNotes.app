/**
 * Drawing ('drawing') body helpers - the single source of truth for how a
 * drawing stores its Excalidraw scene.
 *
 * The body is the `.excalidraw` file format, `{ type, version, source,
 * elements, appState, files }`, with two rules of our own:
 *   - appState keeps only the grid; the background is the note's own colour
 *     (the canvas is transparent), never a colour of Excalidraw's,
 *     never the viewport, the selection or the open tool, so opening a
 *     drawing and looking around does not change its body.
 *   - a picture is a reference, never its bytes: `files[id].src` holds the
 *     same `pn:img/<uuid>` a note body holds, so blob GC, the version holds
 *     and Files find it with no change (`extractImageIds`). A file with no
 *     `src` is never written; the canvas stores the picture first.
 * Fields this build does not know are kept, so a save never drops what a
 * newer build wrote.
 *
 * Spec: docs/internal/specs/drawing.md (sections 2 and 7)
 */

import { isRecord } from '../isRecord';

/** A picture of the drawing as the body stores it. */
type DrawingFile = {
  id: string;
  mimeType: string;
  created: number;
  /** `pn:img/<uuid>`: the encrypted image store holds the bytes. */
  src: string;
  [key: string]: unknown;
};

/** An Excalidraw element as far as this module reads one. */
type SceneElement = {
  id?: unknown;
  type?: unknown;
  isDeleted?: unknown;
  fileId?: unknown;
  text?: unknown;
  originalText?: unknown;
  [key: string]: unknown;
};

export type DrawingScene = {
  type: 'excalidraw';
  version: number;
  source: string;
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, DrawingFile>;
  [key: string]: unknown;
};

/** The appState keys a drawing owns. Everything else is the viewer's, and
 *  the background is the note's colour, which shows through the canvas. */
const SCENE_APP_STATE_KEYS = ['gridSize', 'gridStep', 'gridModeEnabled'] as const;

const SCENE_SOURCE = 'https://privacynotes.app';

export function emptyScene(): DrawingScene {
  return { type: 'excalidraw', version: 2, source: SCENE_SOURCE, elements: [], appState: {}, files: {} };
}

/** The body a new drawing is born with. */
export function emptyDrawingBody(): string {
  return JSON.stringify(emptyScene());
}

/**
 * The scene a body holds, or null when the body is not a scene. A null is
 * never saved over: the caller shows the body as unreadable instead.
 */
export function parseScene(body: string): DrawingScene | null {
  if (!body.trim()) return emptyScene();
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.type !== 'excalidraw') return null;
  const elements = Array.isArray(data.elements) ? data.elements.filter(isRecord) : [];
  const appState = isRecord(data.appState) ? data.appState : {};
  const files: Record<string, DrawingFile> = {};
  if (isRecord(data.files)) {
    for (const [id, file] of Object.entries(data.files)) {
      if (isRecord(file) && typeof file.src === 'string') files[id] = file as DrawingFile;
    }
  }
  return {
    ...data,
    type: 'excalidraw',
    version: typeof data.version === 'number' ? data.version : 2,
    source: typeof data.source === 'string' ? data.source : SCENE_SOURCE,
    elements,
    appState,
    files,
  };
}

/** Elements a person can see: Excalidraw keeps deleted ones for undo. */
function liveElements(elements: readonly SceneElement[]): SceneElement[] {
  return elements.filter((e) => e.isDeleted !== true);
}

/**
 * The body for a scene. `files` are the canvas's files, `srcOf` the
 * reference each one is stored under; a file with none, or one no live
 * picture uses, is left out. A `dataURL` never reaches the body.
 */
export function serializeScene(
  previous: DrawingScene,
  elements: readonly SceneElement[],
  appState: Record<string, unknown>,
  files: Record<string, { id: string; mimeType: string; created: number }>,
  srcOf: (fileId: string) => string | undefined,
): string {
  const live = liveElements(elements);
  const used = new Set(live.filter((e) => e.type === 'image' && typeof e.fileId === 'string').map((e) => e.fileId as string));
  const kept: Record<string, DrawingFile> = {};
  for (const id of used) {
    const src = srcOf(id);
    const file = files[id] ?? previous.files[id];
    if (!src || !file) continue;
    const { dataURL: _dataURL, ...rest } = file as typeof file & { dataURL?: unknown };
    kept[id] = { ...rest, id, mimeType: file.mimeType, created: file.created, src };
  }
  const state: Record<string, unknown> = {};
  for (const key of SCENE_APP_STATE_KEYS) {
    if (appState[key] !== undefined) state[key] = appState[key];
  }
  return JSON.stringify({ ...previous, elements: live, appState: state, files: kept });
}

/** The words of a drawing's text boxes, for search. Never the JSON. */
export function sceneText(scene: DrawingScene): string {
  return liveElements(scene.elements)
    .flatMap((e) => {
      const text = typeof e.originalText === 'string' ? e.originalText : e.text;
      return typeof text === 'string' && text.trim() ? [text.trim()] : [];
    })
    .join('\n');
}

/** Whether a scene holds nothing a person drew or placed. */
export function isEmptyScene(scene: DrawingScene): boolean {
  return liveElements(scene.elements).length === 0;
}

/**
 * The scene as a `.excalidraw` file another app opens: every picture gets
 * its bytes back as a data URL and loses our reference. A picture that could
 * not be read is left out, and Excalidraw draws its empty box.
 */
export function toExcalidrawFile(scene: DrawingScene, dataUrls: ReadonlyMap<string, string>): string {
  const files: Record<string, Record<string, unknown>> = {};
  for (const [id, file] of Object.entries(scene.files)) {
    const dataURL = dataUrls.get(id);
    if (!dataURL) continue;
    const { src: _src, ...rest } = file;
    files[id] = { ...rest, dataURL };
  }
  return JSON.stringify({ ...scene, elements: liveElements(scene.elements), files }, null, 2);
}
