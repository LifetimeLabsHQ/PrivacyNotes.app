/**
 * The drawing editor: Excalidraw, with the settings the app fixes.
 *
 * The only importer of `@excalidraw/excalidraw`, reached by a dynamic import
 * from `DrawingItem.tsx`, so neither the boot path nor a note ever loads it.
 * Being a lazy chunk, it imports nothing of the NotesView chunk: the picture
 * calls and the link opener arrive as props (docs/contrib/bundle-size.md
 * section 8).
 *
 * - Pictures: every door (the image tool, a paste, a drop) reaches
 *   `generateIdForFile` with the file as it arrived, before Excalidraw
 *   shrinks it. The file goes through our pipeline there, and the stored
 *   picture is handed to the canvas under its id, so Excalidraw skips its
 *   own resize and the picture is encoded once. A picture that arrives with
 *   its bytes only (a loaded `.excalidraw` file, pasted shapes) is stored
 *   before the body names it. The body holds references, never bytes.
 * - Saving: a change is written when the scene's version or the drawing's
 *   own settings move, never for a look around, a selection or a tool.
 * - No collaboration, no Excalidraw+ or social links, no AI, no web
 *   embeds; the menu is ours.
 *
 * Spec: docs/internal/specs/drawing.md (sections 3 and 7)
 */

import './assetPath';
import '@excalidraw/excalidraw/index.css';
import './drawing.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptureUpdateAction, Excalidraw, getSceneVersion } from '@excalidraw/excalidraw';
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from '@excalidraw/excalidraw/types';
import type { DrawingScene, parseScene, serializeScene } from './scene';

type SceneElements = Parameters<NonNullable<ExcalidrawProps['onChange']>>[0];

/** A save waits this long after the last change, so a stroke is one write. */
const SAVE_DELAY_MS = 500;

/** Fonts the build leaves out (`pn-excalidraw-fonts` in vite.config.ts). */
const MISSING_FONTS = new Set(['Xiaolai']);

/**
 * Take the left-out fonts off the page, so the browser never asks for files
 * the build does not ship; their text falls back to the system font.
 */
function dropMissingFonts(): void {
  for (const face of document.fonts) {
    if (MISSING_FONTS.has(face.family.replace(/["']/g, ''))) document.fonts.delete(face);
  }
}

/** Whether Escape belongs to the canvas right now: a text box, a shape
 *  being drawn, or one of Excalidraw's own menus and dialogs. */
function canvasOwnsEscape(s: AppState): boolean {
  return !!(s.editingTextElement || s.newElement || s.multiElement || s.openDialog || s.openMenu || s.openPopup);
}

export type DrawingCanvasProps = {
  /** The body when the canvas opened. Later bodies come from the canvas. */
  body: string;
  /** `scene.ts`, handed down: a module of the NotesView chunk imported by
   *  this lazy chunk would be split out onto the boot path
   *  (docs/contrib/bundle-size.md section 8). */
  scene: { parse: typeof parseScene; serialize: typeof serializeScene };
  readOnly: boolean;
  theme: 'light' | 'dark';
  onBodyChange: (body: string) => void;
  /** A picture's data URL from its `pn:img/` reference, or null. */
  loadPicture: (src: string) => Promise<string | null>;
  /** Store a picture; its `pn:img/` reference, or null when refused. */
  storePicture: (file: File) => Promise<string | null>;
  /** A data URL as a file, for a picture that arrives with bytes only. */
  toFile: (dataUrl: string, name: string) => Promise<File>;
  onOpenLink: (url: string) => void;
  /** The tool, whether it stays, and the zoom, for the app's toolbar
   *  (DrawingToolbar.tsx), which stands in for Excalidraw's own. */
  onToolState?: (state: CanvasToolState) => void;
  /** Set to the canvas calls the app's toolbar makes without a key: open or
   *  close Excalidraw's shape panel (its Style button, in Excalidraw's phone
   *  layout, where the panel opens on demand), and clear the canvas after
   *  the app's own confirm. */
  commandsRef?: React.RefObject<DrawingCommands | null>;
  /** Whether Escape belongs to the canvas, so a window around it stays. */
  onEscapeOwnedChange?: (owned: boolean) => void;
  /** Set to a call that writes a save still waiting, for the owner to run
   *  before it opens the same drawing somewhere else. */
  flushRef?: React.RefObject<(() => void) | null>;
};

/** What the canvas reports to the toolbar: the tool, whether it stays,
 *  the zoom, and for the Style button the layout, whether a style applies
 *  (a selection, or a tool that draws), and whether the panel is open. */
type CanvasToolState = { tool: string; locked: boolean; zoom: number; phone: boolean; styled: boolean; styleOpen: boolean };

type DrawingCommands = { toggleStyle: () => void; clear: () => void; escape: () => void; closeMenu: () => void };

/** The tools whose next shape takes the panel's style. */
const STYLED_TOOLS = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text']);

export default function DrawingCanvas({
  body,
  scene: codec,
  readOnly,
  theme,
  onBodyChange,
  loadPicture,
  storePicture,
  toFile,
  onOpenLink,
  onToolState,
  onEscapeOwnedChange,
  flushRef,
  commandsRef,
}: DrawingCanvasProps) {
  // The scene as stored: unknown fields and pictures the canvas has not
  // loaded yet ride along into every save.
  const [initial] = useState<DrawingScene | null>(() => codec.parse(body));
  const scene = useRef(initial);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  // A picture's reference, by its id on the canvas.
  const srcs = useRef(new Map(Object.entries(initial?.files ?? {}).map(([id, f]) => [id, f.src])));
  const uploading = useRef(new Set<string>());
  const lastSignature = useRef<string | null>(null);
  const lastBody = useRef(body);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<{ elements: SceneElements; appState: AppState; files: BinaryFiles } | null>(null);
  const escapeOwned = useRef(false);
  const props = useRef({ onBodyChange, onEscapeOwnedChange, onToolState });
  props.current = { onBodyChange, onEscapeOwnedChange, onToolState };
  const toolState = useRef('');
  // Excalidraw's layout, as its last render saw it (`renderTopRightUI`).
  const phone = useRef(false);
  const openMenu = useRef<string | null>(null);

  const save = useCallback(() => {
    pending.current = null;
    const now = latest.current;
    if (!now || !scene.current) return;
    const next = codec.serialize(scene.current, now.elements as never, now.appState as never, now.files as never, (id) => srcs.current.get(id));
    if (next === lastBody.current) return;
    lastBody.current = next;
    scene.current = codec.parse(next) ?? scene.current;
    props.current.onBodyChange(next);
  }, [codec]);

  const scheduleSave = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(save, SAVE_DELAY_MS);
  }, [save]);

  // A save still waiting is written when the canvas closes, or at once
  // when the owner asks.
  const flush = useCallback(() => {
    if (!pending.current) return;
    clearTimeout(pending.current);
    save();
  }, [save]);
  useEffect(() => {
    if (flushRef) flushRef.current = flush;
    return () => {
      if (flushRef?.current === flush) flushRef.current = null;
      flush();
    };
  }, [flush, flushRef]);
  useEffect(() => {
    if (!commandsRef) return;
    const commands: DrawingCommands = {
      toggleStyle: () => api.current?.updateScene({ appState: { openMenu: openMenu.current === 'shape' ? null : 'shape' } as never }),
      // One step of the canvas's history: Undo brings the drawing back.
      clear: () => api.current?.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.IMMEDIATELY }),
      // Excalidraw's hidden right-click menu, when the app's menu in its
      // place closes without a pick (DrawingMenu.tsx).
      closeMenu: () => api.current?.updateScene({ appState: { contextMenu: null } as never }),
      // What Escape does, for the Android back button: a panel or menu
      // closes, a text box is finished by its own Escape, and a shape being
      // drawn by the canvas's.
      escape: () => {
        const now = api.current?.getAppState();
        if (!now) return;
        const press = (target: Element | null | undefined) => target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        if (now.openMenu || now.openPopup || now.openDialog) api.current?.updateScene({ appState: { openMenu: null, openPopup: null, openDialog: null } as never });
        else if (now.editingTextElement) press(document.querySelector('.excalidraw-wysiwyg'));
        else press(document.querySelector('.excalidraw'));
      },
    };
    commandsRef.current = commands;
    return () => {
      if (commandsRef.current === commands) commandsRef.current = null;
    };
  }, [commandsRef]);

  // Only the pictures of this drawing are decrypted, once it is open.
  const onApi = useCallback((ready: ExcalidrawImperativeAPI) => {
    api.current = ready;
    dropMissingFonts();
    for (const [id, file] of Object.entries(scene.current?.files ?? {})) {
      void loadPicture(file.src).then((dataURL) => {
        if (!dataURL || !api.current) return;
        api.current.addFiles([{ id, mimeType: file.mimeType, created: file.created, dataURL } as BinaryFileData]);
      });
    }
  }, [loadPicture]);

  /** Store a picture the canvas holds only as bytes, then save again. */
  const storeLoose = useCallback(async (id: string, file: BinaryFileData) => {
    if (uploading.current.has(id)) return;
    uploading.current.add(id);
    try {
      const src = await storePicture(await toFile(file.dataURL, `drawing-${id}`));
      if (src) {
        srcs.current.set(id, src);
        scheduleSave();
      }
    } finally {
      uploading.current.delete(id);
    }
  }, [storePicture, toFile, scheduleSave]);

  const onChange = useCallback((elements: SceneElements, appState: AppState, files: BinaryFiles) => {
    const owned = canvasOwnsEscape(appState);
    if (owned !== escapeOwned.current) {
      escapeOwned.current = owned;
      props.current.onEscapeOwnedChange?.(owned);
    }
    openMenu.current = appState.openMenu;
    const tool: CanvasToolState = {
      tool: appState.activeTool.type, locked: appState.activeTool.locked, zoom: appState.zoom.value, phone: phone.current,
      styled: Object.keys(appState.selectedElementIds).length > 0 || STYLED_TOOLS.has(appState.activeTool.type),
      styleOpen: appState.openMenu === 'shape',
    };
    const toolKey = Object.values(tool).join('|');
    if (toolKey !== toolState.current) {
      toolState.current = toolKey;
      props.current.onToolState?.(tool);
    }
    dropMissingFonts();
    if (readOnly) return;
    latest.current = { elements, appState, files };
    const signature = `${getSceneVersion(elements)}|${appState.gridModeEnabled}|${appState.gridSize}|${appState.gridStep}`;
    // The first call is the scene as opened: never a change.
    if (lastSignature.current === null) {
      lastSignature.current = signature;
      return;
    }
    for (const element of elements) {
      if (element.type !== 'image' || element.isDeleted || !element.fileId) continue;
      const file = files[element.fileId];
      if (file && !srcs.current.has(file.id)) void storeLoose(file.id, file);
    }
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;
    scheduleSave();
  }, [readOnly, storeLoose, scheduleSave]);

  // Every new picture: stored by our pipeline, then handed to the canvas
  // under its id, which tells Excalidraw it needs no resize of its own.
  const generateIdForFile = useCallback(async (file: File): Promise<string> => {
    const src = await storePicture(file);
    if (!src) throw new Error('');
    const dataURL = await loadPicture(src);
    const id = src.slice(src.lastIndexOf('/') + 1);
    if (!dataURL || !api.current) throw new Error('');
    srcs.current.set(id, src);
    api.current.addFiles([{ id, mimeType: dataURL.slice(5, dataURL.indexOf(';')), created: Date.now(), dataURL } as BinaryFileData]);
    return id;
  }, [storePicture, loadPicture]);

  if (!initial) return null;
  return (
    <Excalidraw
      excalidrawAPI={onApi}
      // Transparent: the note's own background colour (the "..." menu's
      // Color) shows through, where Excalidraw would paint its own.
      initialData={{ elements: initial.elements as never, appState: { ...initial.appState, viewBackgroundColor: 'transparent' } as never, files: {} }}
      onChange={onChange}
      // Draws nothing: it is the one place Excalidraw tells which layout it
      // drew; the next change report carries it to the toolbar.
      renderTopRightUI={(isMobile) => {
        phone.current = isMobile;
        return null;
      }}
      theme={theme}
      viewModeEnabled={readOnly}
      aiEnabled={false}
      validateEmbeddable={() => false}
      generateIdForFile={generateIdForFile}
      onLinkOpen={(element, event) => {
        event.preventDefault();
        if (element.link) onOpenLink(element.link);
      }}
      UIOptions={{
        // Excalidraw reads this list by action name for its keys and its
        // buttons. `hyperlink` gives Cmd+K back to the app's quick switcher;
        // a shape still gets a link from Excalidraw's right-click menu.
        // `clearCanvas`: the toolbar's reset asks the app's own confirm and
        // clears through the API (`commandsRef`). The rest have no place in
        // the app (drawing.css hides their menu rows). `toggleShortcuts`
        // hides the menu row only: `?` opens Excalidraw's help on its own,
        // so DrawingItem takes that key before the canvas sees it.
        canvasActions: {
          export: false, saveToActiveFile: false, saveAsImage: false, toggleTheme: false, hyperlink: false, changeViewBackgroundColor: false,
          zenMode: false, viewMode: false, stats: false, copyElementLink: false, copyAsSvg: false, addToLibrary: false,
          toggleShortcuts: false, clearCanvas: false,
        } as never,
        tools: { image: !readOnly },
      }}
    />
  );
}
