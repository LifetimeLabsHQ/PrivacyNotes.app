/**
 * A drawing in the editor pane, and the same drawing over the whole app
 * (the canvas): one item, one editor, two places to draw it.
 *
 * The canvas is `DrawingCanvas.tsx`, a lazy chunk; this file is in the
 * NotesView chunk and hands it what it may not import itself (the picture
 * calls, the link opener). Only one canvas is mounted at a time: opening
 * the full-screen window closes the one in the pane, which writes a save
 * still waiting, and the window's canvas opens from the newest body.
 *
 * The window is the shared `Modal`: its X, Escape and the Android back
 * button close it, except while Escape belongs to the canvas (a text box,
 * a shape being drawn, one of Excalidraw's menus).
 * Spec: docs/internal/specs/drawing.md (section 3)
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { LocalNote } from '../db';
import { lazyModal, lazyPart } from '../chunkLoad';
import { Modal, Spinner } from '../ui';
import { ConfirmModal } from '../ConfirmModal';
import { useTranslation } from 'react-i18next';
import { isEditableTarget } from '../ContextMenu';
import { pushEscapeHandler } from '../useEscapeToClose';
import { useTheme } from '../theme';
import { openExternal } from '../openExternal';
import { deriveDisplayTitle } from '../notesViewUtils';
import { stashPendingEdit } from '../flushStash';
import { dataUrlToFile, pictureDataUrl, storeDrawingPicture } from './pictures';
import { parseScene, serializeScene } from './scene';
import { useDrawingTips } from './DrawingTips';
import { DrawingToolbar, type DrawingToolState } from './DrawingToolbar';

const DrawingCanvas = lazyPart(() => import('./DrawingCanvas').then((m) => m.default));
const DrawingHotkeys = lazyModal(() => import('./DrawingHotkeys').then((m) => m.default));
/**
 * The drawing keys' window and its doors in the canvas: the toolbar's
 * Hotkeys button and `?` (the app's key handler leaves single keys to the
 * canvas). Excalidraw opens its own help on `?` whatever `canvasActions`
 * says, so the key is taken in the capture phase, before it reaches the
 * canvas (#11).
 */
function useDrawingKeys() {
  const [open, setOpen] = useState(false);
  return {
    open: () => setOpen(true),
    window: open ? <DrawingHotkeys onClose={() => setOpen(false)} /> : null,
    onKeyDownCapture: (e: React.KeyboardEvent) => {
      if (e.key !== '?' || isEditableTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    },
  };
}
const SCENE = { parse: parseScene, serialize: serializeScene };
const noop = () => {};
const noPicture = async () => null;
const noFile = async (_url: string, name: string) => new File([], name);

export function DrawingItem({ note, readOnly, onBodyChange, openFullScreenRef, flushRef, toolbarSlot }: {
  note: LocalNote;
  /** The pane's row under the scrolling column, for the toolbar at the
   *  bottom (the note editor's bar uses the same row). */
  toolbarSlot?: HTMLElement | null;
  /** Set to the call that opens the full-screen window, for the pane
   *  header's button. */
  openFullScreenRef?: React.RefObject<(() => void) | null>;
  /** Set to a call that writes the waiting save, for the app's export and
   *  close paths (#10). */
  flushRef?: React.RefObject<(() => void) | null>;
  /** Locked or in the Trash: the canvas only shows. */
  readOnly: boolean;
  onBodyChange: (id: string, body: string) => void;
}) {
  const { theme } = useTheme();
  const { t } = useTranslation('notes');
  const [fullScreen, setFullScreen] = useState(false);
  const [canvasOwnsEscape, setCanvasOwnsEscape] = useState(false);
  // The body the canvas wrote last, which the row may not hold yet: the
  // canvas that opens next starts from it.
  const keys = useDrawingKeys();
  const tips = useDrawingTips();
  // What the toolbar shows: the canvas reports it on every change.
  const [toolState, setToolState] = useState<DrawingToolState>({ tool: 'selection', locked: false, zoom: 1, phone: false, styled: false, styleOpen: false });
  const commands = useRef<{ toggleStyle: () => void; clear: () => void; escape: () => void } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const latestBody = useRef(note.body);
  const flush = useRef<(() => void) | null>(null);
  const moveTo = (full: boolean) => {
    flush.current?.();
    setCanvasOwnsEscape(false);
    setFullScreen(full);
  };
  if (openFullScreenRef) openFullScreenRef.current = () => moveTo(true);
  // Set in an effect, not in render: a remount (a restore) renders the new
  // canvas before the old one's cleanup runs.
  useEffect(() => {
    if (!flushRef) return;
    const write = () => flush.current?.();
    flushRef.current = write;
    return () => {
      if (flushRef.current === write) flushRef.current = null;
    };
  }, [flushRef]);
  // While Escape belongs to the canvas, the Android back button does what
  // Escape does there (closes the style panel, finishes a text box) before
  // it leaves the drawing or closes its window. The key stays the canvas's.
  useEffect(() => {
    if (!canvasOwnsEscape) return;
    return pushEscapeHandler(() => commands.current?.escape(), false, false);
  }, [canvasOwnsEscape]);
  const id = note.id;
  // True while a closing or hidden tab writes the save still waiting.
  const leaving = useRef(false);
  const handleBody = useCallback((body: string) => {
    // The save is async and a closing tab dies before it commits: the
    // stash first, which the next boot folds back in (flushStash.ts, #10).
    if (leaving.current) stashPendingEdit(id, body);
    latestBody.current = body;
    onBodyChange(id, body);
  }, [id, onBodyChange]);
  useEffect(() => {
    const onLeave = (e: Event) => {
      if (e.type === 'visibilitychange' && document.visibilityState === 'visible') return;
      leaving.current = true;
      try {
        flush.current?.();
      } finally {
        leaving.current = false;
      }
    };
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onLeave);
    };
  }, []);
  // The pointer leaving the canvas writes the save still waiting, so the
  // header's export and history read the newest body.
  const onPointerLeave = () => {
    tips.onPointerLeave();
    flush.current?.();
  };

  const canvas = (where: 'pane' | 'window') => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner size={24} /></div>}>
      <DrawingCanvas
        key={`${id}-${where}`}
        body={latestBody.current}
        scene={SCENE}
        readOnly={readOnly}
        theme={theme}
        onBodyChange={handleBody}
        loadPicture={pictureDataUrl}
        storePicture={storeDrawingPicture}
        toFile={dataUrlToFile}
        onOpenLink={openExternal}
        onToolState={setToolState}
        onEscapeOwnedChange={setCanvasOwnsEscape}
        flushRef={flush}
        commandsRef={commands}
      />
    </Suspense>
  );

  return (
    <>
      {!fullScreen && <DrawingToolbar canvasRef={paneRef} state={toolState} readOnly={readOnly} onShowKeys={keys.open} onStyle={() => commands.current?.toggleStyle()} onReset={() => setConfirmReset(true)} slot={toolbarSlot} />}
      <div ref={paneRef} className="relative flex min-h-0 flex-1 flex-col" onKeyDownCapture={keys.onKeyDownCapture} onPointerOver={tips.onPointerOver} onPointerLeave={onPointerLeave} onPointerDown={tips.onPointerDown}>
        {!fullScreen && canvas('pane')}
      </div>
      {keys.window}
      {confirmReset && (
        <ConfirmModal
          title={t('drawing.resetTitle')}
          confirmLabel={t('drawing.tools.reset')}
          onConfirm={() => {
            setConfirmReset(false);
            commands.current?.clear();
          }}
          onClose={() => setConfirmReset(false)}
        >
          {t('drawing.resetBody')}
        </ConfirmModal>
      )}
      {tips.view}
      {fullScreen && (
        <Modal
          title={deriveDisplayTitle(note)}
          header="bar"
          onClose={() => moveTo(false)}
          escape={!canvasOwnsEscape}
          closeOnBackdrop={false}
          className="flex h-full max-w-none flex-col overflow-hidden"
        >
          <DrawingToolbar canvasRef={windowRef} state={toolState} readOnly={readOnly} onShowKeys={keys.open} onStyle={() => commands.current?.toggleStyle()} onReset={() => setConfirmReset(true)} />
          <div ref={windowRef} className="relative flex min-h-0 flex-1 flex-col" onKeyDownCapture={keys.onKeyDownCapture} onPointerOver={tips.onPointerOver} onPointerLeave={onPointerLeave} onPointerDown={tips.onPointerDown}>
            {canvas('window')}
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * A version of a drawing, read-only, for the history window: the same
 * canvas, drawn from the version's body. NotesView hands it to the window,
 * which is a lazy chunk and so imports none of this.
 * Spec: docs/internal/specs/drawing.md (section 7, History)
 */
export function DrawingVersion({ body }: { body: string }) {
  const { theme } = useTheme();
  return (
    <div className="relative flex h-full min-h-80 flex-col">
      <Suspense fallback={null}>
        <DrawingCanvas
          body={body}
          scene={SCENE}
          readOnly
          theme={theme}
          onBodyChange={noop}
          loadPicture={pictureDataUrl}
          storePicture={noPicture}
          toFile={noFile}
          onOpenLink={openExternal}
        />
      </Suspense>
    </div>
  );
}
