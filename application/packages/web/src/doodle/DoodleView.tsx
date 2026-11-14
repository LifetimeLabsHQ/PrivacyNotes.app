/**
 * A doodle block in the note (issue #736): draw right in the note, or open
 * the same board full screen with the corner button. On a touch screen with
 * no pointer that hovers (a phone, a tablet), a tap opens it full screen,
 * because a finger on the block in the note must still scroll the note.
 *
 * The strokes are perfect-freehand's, and the pen settings panel holds every
 * option of that repository's demo, with the demo's rules (`strokes.ts`).
 * Every finished stroke is one change of the block, so the note's own undo
 * takes it back and the note saves and syncs it like typing.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { Checkbox, Modal, Popover, Select } from '../ui';
import { ResetDefaultsButton } from '../settingsUI';
import { GroupHeading } from '../formFields';
import { ColorSwatch } from '../ColorSwatch';
import { ColorBar, ToolbarBtn } from '../editorToolbarParts';
import { HoverLabel } from '../HoverLabel';
import { ArrowUUpLeft, ArrowUUpRight, ArrowsOut, Eraser, Notches, PaintBucket, PencilSimple, SlidersHorizontal, Trash } from '../icons';
import { setDoodlePen, setDoodleTool, setFullDoodle, useDoodle } from './doodleStore';
import { BOARD_HEIGHT_DEFAULT, BOARD_WIDTH, clampBoardHeight, parseDoodle, serializeDoodle, type DoodleData } from './doodleFormat';
import { hitsStroke, paintOf, strokeOutline, svgPath } from './strokes';
import {
  DEFAULT_STYLE, EASING_NAMES, INK_COLORS, PAPER_COLORS, RANGES, type DoodleStroke, type DoodleStyle, type Easing,
} from './doodleStyle';

/** The editor's own colour names where it has one, else the block's. */
const EDITOR_COLOR_NAMES = new Set(['gray', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']);
function colorKey(name: string): string {
  if (name === 'none') return 'shell:noteOptionsMenu.colorNone';
  if (name === 'dark') return 'settings:appearance.dark';
  return EDITOR_COLOR_NAMES.has(name) ? `color.names.${name}` : `doodle.colors.${name}`;
}

/** A touch screen whose pointer cannot hover: drawing happens full screen. */
function useTouchOnly(): boolean {
  const query = '(hover: none) and (pointer: coarse)';
  const [touch, setTouch] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const on = () => setTouch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return touch;
}

type Edit = {
  data: DoodleData;
  height: number;
  editable: boolean;
  commit: (strokes: DoodleStroke[]) => void;
  setStyle: (patch: Partial<DoodleStyle>) => void;
  setPaper: (paper: string | null) => void;
  /** Absent while the note is read-only. */
  commitHeight?: (height: number) => void;
  undo: () => void;
  redo: () => void;
};

/** The node view: the block in the note, and its full-screen window. */
export function DoodleView({ node, editor, selected, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation('editor');
  const text = node.attrs['text'] as string;
  const data = useMemo(() => parseDoodle(text), [text]);
  const height = clampBoardHeight(Number(node.attrs['height'] ?? BOARD_HEIGHT_DEFAULT)) ?? BOARD_HEIGHT_DEFAULT;
  const doodle = useDoodle();
  const touchOnly = useTouchOnly();
  // The History window draws the note again, read-only: there the block is a
  // picture to look at, and it opens no window of its own (each copy of a
  // block would open one, all with the same id). A note editor carries
  // pn-editor-topgapped (Editor.tsx), the preview does not.
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    setPreview(!editor.view.dom.closest('.pn-editor-topgapped'));
  }, [editor]);
  // Tracked, as the map block does: Read-only switches the same editor.
  const [editable, setEditable] = useState(editor.isEditable);
  useEffect(() => {
    const sync = () => setEditable(editor.isEditable);
    sync();
    editor.on('update', sync);
    return () => { editor.off('update', sync); };
  }, [editor]);

  const dataRef = useRef(data);
  dataRef.current = data;
  const patch = useCallback((p: Partial<DoodleData>) => {
    const d = dataRef.current;
    if (d) updateAttributes({ text: serializeDoodle({ ...d, ...p }) });
  }, [updateAttributes]);
  const edit: Edit | null = data && {
    data,
    height,
    editable,
    commit: (strokes) => patch({ strokes }),
    setStyle: (p) => {
      const style = { ...(dataRef.current?.style ?? DEFAULT_STYLE), ...p };
      patch({ style });
      setDoodlePen({ style });
    },
    setPaper: (paper) => {
      patch({ paper });
      setDoodlePen({ paper });
    },
    commitHeight: editable ? (h) => updateAttributes({ height: h === BOARD_HEIGHT_DEFAULT ? null : h }) : undefined,
    undo: () => { editor.commands.undo(); },
    redo: () => { editor.commands.redo(); },
  };
  if (!data || !edit) return <NodeViewWrapper />;
  const full = !preview && doodle.fullId === data.id;
  const open = () => { if (!preview) setFullDoodle(data.id); };

  return (
    <NodeViewWrapper className={`pn-doodle my-6 rounded-lg ${selected ? 'outline outline-2 outline-accent' : ''}`} contentEditable={false}>
      <div className="overflow-hidden rounded-lg border border-divider">
        {preview ? null : editable && !touchOnly ? (
          <Tools edit={edit} onFull={open} />
        ) : (
          <div data-drag-handle className="flex justify-end border-b border-divider px-1 py-0.5">
            <ToolbarBtn label={t('notes:drawing.fullScreen')} onClick={open}><ArrowsOut /></ToolbarBtn>
          </div>
        )}
        <InlineBoard edit={edit} drawable={editable && !touchOnly && !preview} onTap={open} />
      </div>
      {full && createPortal(<DoodleWindow edit={edit} />, document.body)}
    </NodeViewWrapper>
  );
}

/** The tool row, in the block and in the window. */
function Tools({ edit, onFull }: { edit: Edit; onFull?: () => void }) {
  const { t } = useTranslation('editor');
  const { tool, pen } = useDoodle();
  const [paperOpen, setPaperOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const paperRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLButtonElement>(null);
  const inBlock = Boolean(onFull);
  return (
    <div data-doodle-surface="" data-drag-handle={inBlock ? '' : undefined} className="flex shrink-0 items-center gap-0.5 border-b border-divider px-1.5 py-0.5" role="toolbar" aria-label={t('doodle.title')}>
      {edit.editable && (
        <>
          <ToolbarBtn label={t('notes:drawing.tools.pen')} active={tool === 'draw'} onClick={() => setDoodleTool('draw')}><PencilSimple /></ToolbarBtn>
          <ToolbarBtn label={t('notes:drawing.tools.eraser')} active={tool === 'erase'} onClick={() => setDoodleTool('erase')}><Eraser /></ToolbarBtn>
        </>
      )}
      <span className="flex-1" />
      {edit.editable && (
        <>
          <ToolbarBtn label={t('notes:editor.undo')} onClick={edit.undo}><ArrowUUpLeft /></ToolbarBtn>
          <ToolbarBtn label={t('notes:editor.redo')} onClick={edit.redo}><ArrowUUpRight /></ToolbarBtn>
          <ToolbarBtn label={t('doodle.clear')} onClick={() => edit.data.strokes.length > 0 && edit.commit([])}><Trash /></ToolbarBtn>
          <span className="relative">
            <ToolbarBtn label={t('doodle.paper')} btnRef={paperRef} active={paperOpen} onClick={() => setPaperOpen((o) => !o)}>
              <PaintBucket />
            </ToolbarBtn>
            {/* White paper on a white bar would vanish: the bar has a rim. */}
            <ColorBar place="below" color={edit.data.paper ?? 'transparent'} className="outline outline-1 outline-pn-muted/60" />
          </span>
          {inBlock ? (
            <ToolbarBtn label={t('doodle.settings')} btnRef={panelRef} active={panelOpen} onClick={() => setPanelOpen((o) => !o)}><SlidersHorizontal /></ToolbarBtn>
          ) : (
            <ToolbarBtn label={t('doodle.settings')} active={pen.panel} onClick={() => setDoodlePen({ panel: !pen.panel })}><SlidersHorizontal /></ToolbarBtn>
          )}
        </>
      )}
      {onFull && <ToolbarBtn label={t('notes:drawing.fullScreen')} onClick={onFull}><ArrowsOut /></ToolbarBtn>}
      <Popover open={paperOpen} anchorRef={paperRef} onClose={() => setPaperOpen(false)} title={t('doodle.paper')} align="end" className="w-72">
        <div className="flex flex-wrap gap-1">
          {PAPER_COLORS.map((c) => (
            <ColorSwatch
              key={c.name}
              label={t(colorKey(c.name))}
              none={c.value === null}
              background={c.value ?? undefined}
              selected={edit.data.paper === c.value}
              onClick={() => edit.setPaper(c.value)}
            />
          ))}
        </div>
        <p className="mt-2 text-small text-pn-muted">{t('doodle.paperNone')}</p>
      </Popover>
      {inBlock && (
        <Popover open={panelOpen} anchorRef={panelRef} onClose={() => setPanelOpen(false)} title={t('doodle.settings')} align="end" className="w-80 max-h-[70vh]">
          <PenPanel edit={edit} />
        </Popover>
      )}
    </div>
  );
}

/** The board in the note: the whole board, scaled to the column, with the
 *  height handle at its corner. */
function InlineBoard({ edit, drawable, onTap }: { edit: Edit; drawable: boolean; onTap: () => void }) {
  const { t } = useTranslation('editor');
  const { height } = edit;
  const boxRef = useRef<HTMLDivElement>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ y: number; h: number; scale: number } | null>(null);
  const shownHeight = dragHeight ?? height;
  const resizeStart = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const w = boxRef.current?.getBoundingClientRect().width;
    if (!w) return;
    drag.current = { y: e.clientY, h: height, scale: BOARD_WIDTH / w };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragHeight(height);
  };
  const resizeMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (d) setDragHeight(clampBoardHeight(d.h + (e.clientY - d.y) * d.scale) ?? d.h);
  };
  const resizeEnd = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.type === 'pointerup' && dragHeight !== null && dragHeight !== height) edit.commitHeight?.(dragHeight);
    setDragHeight(null);
  };
  return (
    <div ref={boxRef} data-doodle-surface="" className="relative" style={{ aspectRatio: `${BOARD_WIDTH} / ${shownHeight}`, background: edit.data.paper ?? undefined }}>
      <Board edit={edit} view={{ x: 0, y: 0, w: BOARD_WIDTH, h: shownHeight }} drawable={drawable} onTap={drawable ? undefined : onTap} label={t('doodle.title')} />
      {edit.editable && edit.commitHeight && (
        <div className="pn-map-resize">
          <HoverLabel label={t('media:image.resizeHint')} position="start" disabled={dragHeight !== null}>
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('media:image.resizeHint')}
              className="pn-resize-plate cursor-ns-resize"
              onPointerDown={resizeStart}
              onPointerMove={resizeMove}
              onPointerUp={resizeEnd}
              onPointerCancel={resizeEnd}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDragStart={(e) => e.preventDefault()}
            >
              <Notches aria-hidden="true" className="rtl:-scale-x-100" />
            </button>
          </HoverLabel>
        </div>
      )}
    </div>
  );
}

type View = { x: number; y: number; w: number; h: number };

/**
 * The drawing surface. One finger, pen or mouse draws or erases. In the
 * full-screen window (`onView` set) two fingers pinch to zoom and pan, and
 * a wheel pans (with Ctrl or Cmd it zooms), as in the demo. The strokes stay
 * in board units, so the zoom never changes them.
 */
function Board({ edit, view, drawable, onTap, onView, label }: {
  edit: Edit;
  view: View;
  drawable: boolean;
  onTap?: () => void;
  onView?: (v: View) => void;
  label: string;
}) {
  const { tool, pen } = useDoodle();
  const { data } = edit;
  const style = data.style;
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [live, setLive] = useState<DoodleStroke | null>(null);
  const liveRef = useRef<DoodleStroke | null>(null);
  const [erasing, setErasing] = useState<DoodleStroke[] | null>(null);
  const erasingRef = useRef<DoodleStroke[] | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mid: { x: number; y: number }; view: View } | null>(null);
  const tap = useRef<{ x: number; y: number } | null>(null);

  const shown = erasing ?? data.strokes;
  const outlines = useMemo(() => shown.map((s) => strokeOutline(s, style)), [shown, style]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, rw: r.width || 1, rh: r.height || 1 };
  };
  const toBoard = (p: { x: number; y: number; rw: number; rh: number }): [number, number] => {
    const v = viewRef.current;
    return [v.x + (p.x / p.rw) * v.w, v.y + (p.y / p.rh) * v.h];
  };
  const twoPointers = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } } : null;
  };
  const eraseAt = (p: number[]) => {
    const base = erasingRef.current ?? data.strokes;
    const left = base.filter((s) => !hitsStroke(p, s, strokeOutline(s, style)));
    if (left.length !== base.length) {
      erasingRef.current = left;
      setErasing(left);
    }
  };

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!drawable) {
      tap.current = { x: e.clientX, y: e.clientY };
      return;
    }
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone: the stroke still draws while it moves.
    }
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2 && onView) {
      const two = twoPointers();
      if (two) pinch.current = { ...two, view: viewRef.current };
      // A second finger turns the stroke the first one started into a pinch.
      liveRef.current = null;
      setLive(null);
      return;
    }
    if (pointers.current.size > 1) return;
    const [x, y] = toBoard(p);
    if (tool === 'erase') {
      erasingRef.current = data.strokes;
      eraseAt([x, y]);
      return;
    }
    const isPen = e.pointerType === 'pen';
    const stroke = { points: [[x, y, isPen ? e.pressure : 0.5]], fill: pen.fill, stroke: pen.stroke, pressure: isPen };
    liveRef.current = stroke;
    setLive(stroke);
  };

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const pz = pinch.current;
    const two = pz ? twoPointers() : null;
    if (pz && two && onView) {
      // The board point under the first midpoint stays under the fingers.
      const k = pz.dist / two.dist;
      const w = Math.min(BOARD_WIDTH * 20, Math.max(BOARD_WIDTH / 20, pz.view.w * k));
      const h = (pz.view.h / pz.view.w) * w;
      const bx = pz.view.x + (pz.mid.x / p.rw) * pz.view.w;
      const by = pz.view.y + (pz.mid.y / p.rh) * pz.view.h;
      onView({ x: bx - (two.mid.x / p.rw) * w, y: by - (two.mid.y / p.rh) * h, w, h });
      return;
    }
    if (erasingRef.current) {
      eraseAt(toBoard(p));
      return;
    }
    const s = liveRef.current;
    if (!s) return;
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    const added = (events.length ? events : [e.nativeEvent]).map((ev) => {
      const [x, y] = toBoard({ ...local(ev), rw: p.rw, rh: p.rh });
      return [x, y, s.pressure ? ev.pressure : 0.5];
    });
    const next = { ...s, points: [...s.points, ...added] };
    liveRef.current = next;
    setLive(next);
  };

  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const start = tap.current;
    tap.current = null;
    if (start && onTap && e.type === 'pointerup' && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) {
      onTap();
      return;
    }
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      return;
    }
    if (erasingRef.current) {
      const left = erasingRef.current;
      erasingRef.current = null;
      setErasing(null);
      if (left.length !== data.strokes.length) edit.commit(left);
      return;
    }
    const s = liveRef.current;
    liveRef.current = null;
    setLive(null);
    if (s && e.type === 'pointerup') edit.commit([...data.strokes, s]);
  };

  // The wheel listener is not passive, so the page does not scroll under it.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !onView) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const k = Math.exp(e.deltaY * 0.01);
        const w = Math.min(BOARD_WIDTH * 20, Math.max(BOARD_WIDTH / 20, v.w * k));
        const h = (v.h / v.w) * w;
        const fx = (e.clientX - r.left) / (r.width || 1);
        const fy = (e.clientY - r.top) / (r.height || 1);
        onView({ x: v.x + fx * v.w - fx * w, y: v.y + fy * v.h - fy * h, w, h });
      } else {
        onView({ ...v, x: v.x + (e.deltaX / (r.width || 1)) * v.w, y: v.y + (e.deltaY / (r.height || 1)) * v.h });
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [onView]);

  const liveOutline = live ? strokeOutline(live, style, false) : null;
  const cursor = !drawable ? 'cursor-pointer' : tool === 'erase' ? 'cursor-cell' : 'cursor-crosshair';
  return (
    <svg
      ref={svgRef}
      role="img"
      aria-label={label}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      preserveAspectRatio="none"
      className={`absolute inset-0 h-full w-full select-none ${drawable ? 'touch-none' : ''} ${cursor}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {onView && (data.paper
        ? <rect x={0} y={0} width={BOARD_WIDTH} height={edit.height} fill={data.paper} />
        : <rect x={0} y={0} width={BOARD_WIDTH} height={edit.height} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />)}
      {shown.map((s, i) => <StrokePath key={i} stroke={s} outline={outlines[i] ?? []} style={style} />)}
      {live && liveOutline && <StrokePath stroke={live} outline={liveOutline} style={style} />}
    </svg>
  );
}

/** One stroke as the demo paints it: the outline under the fill. */
function StrokePath({ stroke, outline, style }: { stroke: DoodleStroke; outline: number[][]; style: DoodleStyle }) {
  const d = svgPath(outline);
  const paint = paintOf(stroke, style);
  return (
    <>
      {paint.line && <path d={d} fill="none" stroke={paint.line} strokeWidth={paint.lineWidth} strokeLinejoin="round" strokeLinecap="round" />}
      {paint.fill && <path d={d} fill={paint.fill} />}
    </>
  );
}

/** The board at 100% of the screen: the X, Escape and the Android back
 *  button close it; the strokes are in the note already. */
function DoodleWindow({ edit }: { edit: Edit }) {
  const { t } = useTranslation('editor');
  const { pen } = useDoodle();
  const areaRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  // Fit the whole board in the area, and again when the area changes size.
  const fit = useCallback(() => {
    const r = areaRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    const margin = 24;
    const scale = Math.min(r.width / (BOARD_WIDTH + margin * 2), r.height / (edit.height + margin * 2));
    const w = r.width / scale;
    const h = r.height / scale;
    setView({ x: (BOARD_WIDTH - w) / 2, y: (edit.height - h) / 2, w, h });
  }, [edit.height]);
  useEffect(() => {
    fit();
    const el = areaRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  return (
    <Modal
      title={t('doodle.title')}
      header="bar"
      onClose={() => setFullDoodle(null)}
      className="flex h-full max-w-none flex-col overflow-hidden"
    >
      <Tools edit={edit} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div ref={areaRef} className="relative min-h-[10rem] flex-1 overflow-hidden bg-surface-1">
          {view && <Board edit={edit} view={view} drawable={edit.editable} onView={setView} label={t('doodle.title')} />}
        </div>
        {edit.editable && pen.panel && (
          <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-divider p-4 md:max-h-none md:w-80 md:border-s md:border-t-0">
            <h3 className="mb-4 text-body font-semibold text-pn">{t('doodle.settings')}</h3>
            <PenPanel edit={edit} />
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The demo's options panel, in the demo's order and with its rules: Cap
 *  shows while a taper is 0, its Easing once the taper is above 0, and a
 *  colour row only while its fill or outline is on. */
function PenPanel({ edit }: { edit: Edit }) {
  const { t } = useTranslation('editor');
  const { pen } = useDoodle();
  const style = edit.data.style;
  const easingLabel = (e: Easing) => {
    if (e === 'linear') return t('doodle.easing.linear');
    const m = /^ease(InOut|In|Out)(\w+)$/.exec(e);
    if (!m) return e;
    const way = m[1] === 'InOut' ? 'inOut' : m[1] === 'In' ? 'in' : 'out';
    return t(`doodle.easing.${way}`, { curve: t(`doodle.curve.${(m[2] ?? '').toLowerCase()}`) });
  };
  const easingSelect = (key: 'easing' | 'easingStart' | 'easingEnd', label: string) => (
    <SelectRow label={label} value={style[key]} onChange={(v) => edit.setStyle({ [key]: v as Easing })}>
      {EASING_NAMES.map((e) => <option key={e} value={e}>{easingLabel(e)}</option>)}
    </SelectRow>
  );
  const slider = (key: keyof typeof RANGES, label: string) => (
    <SliderRow label={label} value={style[key]} range={RANGES[key]} onChange={(v) => edit.setStyle({ [key]: v })} />
  );
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <GroupHeading>{t('doodle.stroke')}</GroupHeading>
        {slider('size', t('shell:listPrefs.size'))}
        {slider('thinning', t('doodle.thinning'))}
        {slider('streamline', t('doodle.streamline'))}
        {slider('smoothing', t('doodle.smoothing'))}
        {easingSelect('easing', t('doodle.easingLabel'))}
      </section>
      <section className="space-y-2">
        <GroupHeading>{t('doodle.start')}</GroupHeading>
        {slider('taperStart', t('doodle.taperStart'))}
        {style.taperStart > 0
          ? easingSelect('easingStart', t('doodle.easingStart'))
          : <Checkbox label={t('doodle.capStart')} checked={style.capStart} onChange={(e) => edit.setStyle({ capStart: e.target.checked })} />}
      </section>
      <section className="space-y-2">
        <GroupHeading>{t('doodle.end')}</GroupHeading>
        {slider('taperEnd', t('doodle.taperEnd'))}
        {style.taperEnd > 0
          ? easingSelect('easingEnd', t('doodle.easingEnd'))
          : <Checkbox label={t('doodle.capEnd')} checked={style.capEnd} onChange={(e) => edit.setStyle({ capEnd: e.target.checked })} />}
      </section>
      <section className="space-y-2">
        <GroupHeading>{t('shell:noteOptionsMenu.color')}</GroupHeading>
        <Checkbox label={t('doodle.fill')} checked={style.isFilled} onChange={(e) => edit.setStyle({ isFilled: e.target.checked })} />
        {style.isFilled && <InkRow label={t('doodle.fill')} value={pen.fill} onPick={(c) => setDoodlePen({ fill: c })} />}
        {slider('strokeWidth', t('doodle.outline'))}
        {style.strokeWidth > 0 && <InkRow label={t('doodle.outline')} value={pen.stroke} onPick={(c) => setDoodlePen({ stroke: c })} />}
      </section>
      <ResetDefaultsButton
        onReset={() => {
          edit.setStyle(DEFAULT_STYLE);
          setDoodlePen({ fill: INK_COLORS[0].value, stroke: INK_COLORS[0].value });
        }}
        className="pt-1"
      />
    </div>
  );
}

/** A slider with its value, the demo's number field as plain text. */
function SliderRow({ label, value, range, onChange }: {
  label: string;
  value: number;
  range: { min: number; max: number; step: number };
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_2.75rem] items-center gap-2">
      <label htmlFor={id} className="text-small text-pn">{label}</label>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 accent-accent"
      />
      <span className="text-end text-small tabular-nums text-pn-muted">{value.toFixed(range.step < 1 ? 2 : 0)}</span>
    </div>
  );
}

function SelectRow({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2">
      <label htmlFor={id} className="text-small text-pn">{label}</label>
      <Select id={id} size="sm" value={value} onChange={(e) => onChange(e.target.value)}>{children}</Select>
    </div>
  );
}

/** The demo's colour row, for the fill or the outline of the next stroke. */
function InkRow({ label, value, onPick }: { label: string; value: string; onPick: (c: string) => void }) {
  const { t } = useTranslation('editor');
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {INK_COLORS.map((c) => (
        <ColorSwatch
          key={c.value}
          label={t(colorKey(c.name))}
          background={c.value}
          selected={value === c.value}
          labelPosition="below"
          onClick={() => onPick(c.value)}
        />
      ))}
    </div>
  );
}
