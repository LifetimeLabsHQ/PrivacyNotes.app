import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CornersOut, Graph, MagnifyingGlassMinus, MagnifyingGlassPlus } from '../icons';
import { isLookColor, LOOK_COLORS, type LookColor } from '../itemStyles';
import { isItemMark, TypeMark } from '../typeMark';
import { Badge, CanvasControlBar, EmptyState, IconButton } from '../ui';
import {
  parseGraphSelectionId,
  type GraphNodeKind,
  type SavedGraphLayout,
  type SavedNodePosition,
} from './graphModel';
import { createForceSimulation, type ForceSimulation } from './graphPhysics';

// Spec: docs/internal/specs/graph-view.md (section 4.3)

export interface GraphCanvasHandle {
  focusNode: (id: string, animate?: boolean) => void;
  getNodePosition: (id: string) => SavedNodePosition | null;
  exportPositions: () => SavedGraphLayout;
}

export type CanvasNodeKind = GraphNodeKind;

export interface CanvasNode {
  id: string;
  noteId?: string;
  folderId?: string | null;
  title: string;
  kind: CanvasNodeKind;
  colorKey: LookColor | null;
  tags: readonly string[];
  degree: number;
  inCount?: number;
  outCount?: number;
  memberCount?: number;
  snippet?: string;
}

export interface CanvasEdge {
  key: string;
  source: string;
  target: string;
  kind: 'link' | 'smart';
  whyText?: string;
  why?: unknown;
}

export type { SavedNodePosition };

export interface GraphCanvasProps {
  nodes: readonly CanvasNode[];
  edges: readonly CanvasEdge[];
  selectedId: string | null;
  onSelectNode: (id: string | null) => void;
  onOpenNode: (id: string, opts?: { newTab?: boolean }) => void;
  onExpandFolderHub?: (folderId: string) => void;
  onCreateLink?: (sourceId: string, targetId: string) => void;
  onNodeContextMenu?: (nodeId: string, clientX: number, clientY: number) => void;
  showArrows: boolean;
  showAllLabels: boolean;
  showFolderHalos: boolean;
  folderLabels?: ReadonlyMap<string, { label: string; colorKey: string | null }>;
  repelStrength: number;
  searchMatchIds?: ReadonlySet<string> | null;
  savedPositions?: ReadonlyMap<string, SavedNodePosition> | SavedGraphLayout | null;
  onPositionsSettled?: (positions: Map<string, SavedNodePosition>) => void;
  layoutEpoch?: number;
  /** When true, dragging anywhere (even starting on a node) pans the canvas safely without moving or pinning nodes. */
  layoutLocked?: boolean;
  canvasUnavailableLabel?: string;
  dark: boolean;
  ariaLabel: string;
}

const DRAG_THRESHOLD_MOUSE_PX = 5;
const DRAG_THRESHOLD_TOUCH_PX = 8;
const HOVER_FADE_MS = 200;
const DOUBLE_CLICK_MS = 320;
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 3.0;
const PREWARM_MAX_TICKS = 96;
const PREWARM_BUDGET_MS = 45;
const SEARCH_FORCE_LABEL_LIMIT = 25;
const SEARCH_HALO_LIMIT = 40;
const DEFAULT_FONT_SANS = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif';

function toPhysicsRepel(strength: number): number {
  if (!Number.isFinite(strength) || strength <= 0) return 4200;
  return strength < 400 ? Math.max(20, strength) * 42 : strength;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function ambientLabelOpacity(degree: number, zoom: number, nodeCount: number): number {
  // Small vaults (like the 30-item demo) reveal titles earlier so the canvas feels alive.
  const boost = nodeCount <= 36 ? 0.35 : nodeCount <= 90 ? 0.15 : 0;
  const z = zoom + boost;
  // Top landmarks stay gently visible even at full-vault zoom so the graph is immediately readable
  // while the viewport label budget and generous collision padding prevent clutter.
  if (degree >= 6) return Math.max(0.82, smoothstep(0.14, 0.30, z));
  if (degree >= 4) return smoothstep(0.16, 0.36, z);
  if (degree >= 3) return smoothstep(0.42, 0.68, z);
  if (degree >= 2) return smoothstep(0.78, 1.02, z);
  if (degree >= 1) return smoothstep(1.10, 1.35, z);
  return smoothstep(1.38, 1.65, z);
}

function prewarmSimulation(sim: ForceSimulation): void {
  if (sim.getAlpha() < 0.5) return;
  const deadline = performance.now() + PREWARM_BUDGET_MS;
  for (let i = 0; i < PREWARM_MAX_TICKS; i++) {
    if (!sim.step()) break;
    if ((i & 7) === 7 && performance.now() >= deadline) break;
  }
}

function toSavedLayoutRecord(
  saved: ReadonlyMap<string, SavedNodePosition> | SavedGraphLayout | null | undefined,
): SavedGraphLayout | null {
  if (!saved) return null;
  if (saved instanceof Map) {
    const out: SavedGraphLayout = {};
    for (const [id, pos] of saved) out[id] = pos;
    return out;
  }
  return saved as SavedGraphLayout;
}

function toPositionsMap(layout: SavedGraphLayout): Map<string, SavedNodePosition> {
  const out = new Map<string, SavedNodePosition>();
  for (const [id, pos] of Object.entries(layout)) out.set(id, pos);
  return out;
}

export interface GraphThemePalette {
  surface: string;
  text: string;
  soft: string;
  muted: string;
  divider: string;
  accent: string;
  warning: string;
  success: string;
  ringWhite: string;
  labels: Record<LookColor, string>;
}

export interface GraphCanvasFonts {
  sans: string;
  metaPx: number;
  smallPx: number;
  compactPx: number;
}

function parseCssFontSizePx(
  raw: string,
  rootFontPx: number,
  systemTextScale: number,
  fallbackPx: number,
): number {
  const trimmed = raw.trim();
  if (!trimmed) return Math.round(fallbackPx * systemTextScale * 100) / 100;
  const pxMatch = /^(\d+(?:\.\d+)?)px$/i.exec(trimmed);
  if (pxMatch) return Number(pxMatch[1]);
  const remMatch = /^(\d+(?:\.\d+)?)rem$/i.exec(trimmed);
  if (remMatch) return Math.round(Number(remMatch[1]) * rootFontPx * 100) / 100;
  const calcNumMatch = /^calc\(\s*(\d+(?:\.\d+)?)(rem|px)\s*\*\s*(\d+(?:\.\d+)?)\s*\)$/i.exec(trimmed);
  if (calcNumMatch) {
    const base =
      calcNumMatch[2]!.toLowerCase() === 'rem'
        ? Number(calcNumMatch[1]) * rootFontPx
        : Number(calcNumMatch[1]);
    return Math.round(base * Number(calcNumMatch[3]) * 100) / 100;
  }
  const calcVarMatch = /^calc\(\s*(\d+(?:\.\d+)?)(rem|px)\s*\*\s*var\(--pn-system-text[^)]*\)\s*\)$/i.exec(trimmed);
  if (calcVarMatch) {
    const base =
      calcVarMatch[2]!.toLowerCase() === 'rem'
        ? Number(calcVarMatch[1]) * rootFontPx
        : Number(calcVarMatch[1]);
    return Math.round(base * systemTextScale * 100) / 100;
  }
  return Math.round(fallbackPx * systemTextScale * 100) / 100;
}

/** Resolve `--font-sans` and `--fs-*` design tokens on the canvas host element. */
export function resolveGraphCanvasFonts(el: HTMLElement | null): GraphCanvasFonts {
  const target = el ?? document.documentElement;
  const cs = getComputedStyle(target);
  const rootCs = target === document.documentElement ? cs : getComputedStyle(document.documentElement);
  const rootFontPx = Number.parseFloat(rootCs.fontSize) || 16;
  const rawSystemScale = Number.parseFloat(
    cs.getPropertyValue('--pn-system-text').trim() || rootCs.getPropertyValue('--pn-system-text').trim(),
  );
  const systemTextScale = Number.isFinite(rawSystemScale) && rawSystemScale > 0 ? rawSystemScale : 1;
  const sans =
    cs.getPropertyValue('--font-sans').trim() ||
    rootCs.getPropertyValue('--font-sans').trim() ||
    cs.fontFamily.trim() ||
    DEFAULT_FONT_SANS;

  return {
    sans,
    metaPx: parseCssFontSizePx(
      cs.getPropertyValue('--fs-meta') || rootCs.getPropertyValue('--fs-meta'),
      rootFontPx,
      systemTextScale,
      11,
    ),
    smallPx: parseCssFontSizePx(
      cs.getPropertyValue('--fs-small') || rootCs.getPropertyValue('--fs-small'),
      rootFontPx,
      systemTextScale,
      12,
    ),
    compactPx: parseCssFontSizePx(
      cs.getPropertyValue('--fs-compact') || rootCs.getPropertyValue('--fs-compact'),
      rootFontPx,
      systemTextScale,
      13,
    ),
  };
}

function readTokenColor(cs: CSSStyleDeclaration, names: readonly string[], fallback: string): string {
  for (const name of names) {
    const raw = cs.getPropertyValue(name).trim();
    if (!raw) continue;
    if (/^\d+\s+\d+\s+\d+$/.test(raw)) return `rgb(${raw})`;
    return raw;
  }
  return fallback;
}

export function resolveGraphThemePalette(el: HTMLElement | null, dark: boolean): GraphThemePalette {
  const cs = getComputedStyle(el ?? document.documentElement);
  const labels = {} as Record<LookColor, string>;
  const accent = readTokenColor(cs, ['--pn-accent', '--accent'], dark ? '#4A90D9' : '#1E40AF');
  for (const key of LOOK_COLORS) {
    labels[key] = readTokenColor(cs, [`--pn-label-${key}-ink`], accent);
  }
  return {
    surface: readTokenColor(cs, ['--pn-surface-2', '--pn-bg'], dark ? '#23211E' : '#FFFFFF'),
    text: readTokenColor(cs, ['--pn-text'], dark ? '#D9D4CC' : '#0A0A0A'),
    soft: readTokenColor(cs, ['--pn-text-soft'], dark ? '#BDB6AC' : '#404040'),
    muted: readTokenColor(cs, ['--pn-text-muted', '--pn-muted'], dark ? '#8E887E' : '#6A6A6A'),
    divider: readTokenColor(cs, ['--pn-divider'], dark ? '#302D29' : '#E5E5E5'),
    accent,
    warning: readTokenColor(cs, ['--pn-warning', '--warning'], dark ? '#FFB900' : '#973C00'),
    success: readTokenColor(cs, ['--pn-success', '--success'], dark ? '#00D492' : '#006045'),
    ringWhite: dark ? '#F5F5F4' : '#FFFFFF',
    labels,
  };
}

function nodeRadius(node: CanvasNode): number {
  if (node.kind === 'folderHub') {
    const count = node.memberCount ?? 2;
    return Math.min(20, 13.5 + Math.sqrt(count) * 1.4);
  }
  if (node.kind === 'missing') return 6.5;
  return Math.min(14, 6 + Math.min(node.degree, 12) * 1.05);
}

/** Canonical LookColor per non-note item kind, shared by Graph and Places. */
export function kindLookColor(kind: CanvasNodeKind): LookColor | null {
  switch (kind) {
    case 'journal': return 'purple';
    case 'task': return 'green';
    case 'contact': return 'teal';
    case 'event': return 'orange';
    case 'drawing': return 'pink';
    case 'link': return 'indigo';
    case 'file': return 'gray';
    default: return null;
  }
}

export function resolveNodeColor(node: CanvasNode, palette: GraphThemePalette): string {
  if (node.kind === 'missing') return palette.muted;
  if (node.colorKey && isLookColor(node.colorKey)) return palette.labels[node.colorKey];
  if (node.kind === 'folderHub') return palette.warning;
  const fallback = kindLookColor(node.kind);
  return fallback ? palette.labels[fallback] : palette.accent;
}

function isLinkableNode(node: CanvasNode): boolean {
  return node.kind !== 'missing' && node.kind !== 'folderHub';
}

/** Truncate a canvas label by Unicode code points so surrogate-pair emoji never split. */
export function truncateGraphLabel(title: string, max = 28): string {
  if (max <= 0) return '';
  const chars = [...title];
  if (chars.length <= max) return title;
  return `${chars.slice(0, max - 1).join('')}…`;
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface HoverTipState {
  node: CanvasNode;
  x: number;
  y: number;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelectNode,
  onOpenNode,
  onExpandFolderHub,
  onCreateLink,
  onNodeContextMenu,
  showArrows,
  showAllLabels,
  showFolderHalos,
  folderLabels,
  repelStrength,
  searchMatchIds = null,
  savedPositions,
  onPositionsSettled,
  layoutEpoch = 0,
  layoutLocked = false,
  canvasUnavailableLabel,
  dark,
  ariaLabel,
}, ref) {
  const { t } = useTranslation(['notes', 'shell', 'media']);
  const kindLabel = useCallback((kind: CanvasNodeKind): string => {
    switch (kind) {
      case 'folderHub': return t('shell:folders.chipUnfiled');
      case 'missing': return t('notes:connections.missing');
      case 'journal': return t('notes:newMenu.journal');
      case 'task': return t('notes:newMenu.task');
      case 'contact': return t('notes:newMenu.contact');
      case 'link': return t('notes:newMenu.bookmark');
      case 'file': return t('shell:fileTypes.file');
      case 'drawing': return t('notes:newMenu.drawing');
      case 'event': return t('notes:newMenu.event');
      default: return t('notes:newMenu.note');
    }
  }, [t]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<ForceSimulation | null>(null);
  if (!simRef.current) simRef.current = createForceSimulation({ repelStrength: toPhysicsRepel(repelStrength) });

  const paletteRef = useRef<GraphThemePalette | null>(null);
  const fontsRef = useRef<GraphCanvasFonts | null>(null);
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const textWidthCacheRef = useRef<Map<string, number>>(new Map());
  const cameraRef = useRef({ panX: 0, panY: 0, zoom: 1 });
  const cameraAnimRef = useRef<{
    fromPanX: number;
    fromPanY: number;
    fromZoom: number;
    toPanX: number;
    toPanY: number;
    toZoom: number;
    start: number;
    duration: number;
  } | null>(null);
  const hasAutoFitRef = useRef(false);
  const lastLayoutEpochRef = useRef(layoutEpoch);

  // Hover spotlight fade state (200ms easeOutQuad)
  const hoverAnimRef = useRef<{
    targetId: string | null;
    displayId: string | null;
    progress: number;
    startProgress: number;
    startTime: number;
  }>({ targetId: null, displayId: null, progress: 0, startProgress: 0, startTime: 0 });

  const [hoverTip, setHoverTip] = useState<HoverTipState | null>(null);
  const hoverTipNodeIdRef = useRef<string | null>(null);
  const [cursorStyle, setCursorStyle] = useState<'grab' | 'grabbing' | 'pointer' | 'crosshair'>('grab');
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);

  // Interaction state refs
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);
  const nodeDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    altKey: boolean;
    threshold: number;
  } | null>(null);
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
    moved: boolean;
    threshold: number;
    hitNodeId: string | null;
    altKey: boolean;
  } | null>(null);
  const linkDragRef = useRef<{
    sourceId: string;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    moved: boolean;
    targetId: string | null;
  } | null>(null);
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);
  const longPressRef = useRef<{ timer: number; pointerId: number; startX: number; startY: number } | null>(null);
  const longPressFiredRef = useRef(false);
  const cancelLongPress = useCallback(() => {
    const lp = longPressRef.current;
    if (lp) {
      window.clearTimeout(lp.timer);
      longPressRef.current = null;
    }
  }, []);
  const clearHoverTip = useCallback(() => {
    if (hoverTipNodeIdRef.current !== null) {
      hoverTipNodeIdRef.current = null;
      setHoverTip(null);
    }
  }, []);
  const abortNodeDrag = useCallback(() => {
    const nd = nodeDragRef.current;
    if (nd) {
      nodeDragRef.current = null;
      simRef.current?.release(nd.id, false);
    }
  }, []);
  useEffect(() => () => {
    cancelLongPress();
    abortNodeDrag();
  }, [cancelLongPress, abortNodeDrag]);
  useEffect(() => {
    if (!layoutLocked) return;
    abortNodeDrag();
    if (linkDragRef.current) {
      linkDragRef.current = null;
      setCursorStyle('grab');
    }
  }, [layoutLocked, abortNodeDrag]);
  const wasMovingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });

  // Latest props ref for stable rAF draw loop
  const propsRef = useRef({
    nodes,
    edges,
    selectedId,
    showArrows,
    showAllLabels,
    showFolderHalos,
    folderLabels,
    searchMatchIds,
    onPositionsSettled,
    layoutLocked,
  });
  propsRef.current = {
    nodes,
    edges,
    selectedId,
    showArrows,
    showAllLabels,
    showFolderHalos,
    folderLabels,
    searchMatchIds,
    onPositionsSettled,
    layoutLocked,
  };

  // Precomputed node, neighbor, and bidirectional-link maps for O(1) lookup per frame
  const graphLookup = useMemo(() => {
    const byId = new Map<string, CanvasNode>();
    for (const n of nodes) byId.set(n.id, n);
    const adj = new Map<string, Set<string>>();
    const directedLinks = new Set<string>();
    for (const e of edges) {
      if (!byId.has(e.source) || !byId.has(e.target)) continue;
      if (e.kind === 'link') directedLinks.add(`${e.source}->${e.target}`);
      let sa = adj.get(e.source);
      if (!sa) { sa = new Set(); adj.set(e.source, sa); }
      sa.add(e.target);
      let sb = adj.get(e.target);
      if (!sb) { sb = new Set(); adj.set(e.target, sb); }
      sb.add(e.source);
    }
    const biLinks = new Set<string>();
    for (const e of edges) {
      if (e.kind === 'link' && directedLinks.has(`${e.target}->${e.source}`)) {
        biLinks.add(e.key);
      }
    }
    return { byId, adj, biLinks };
  }, [nodes, edges]);
  const lookupRef = useRef(graphLookup);
  lookupRef.current = graphLookup;

  const worldToScreen = useCallback((wx: number, wy: number) => {
    const { width, height } = sizeRef.current;
    const { panX, panY, zoom } = cameraRef.current;
    return {
      x: width / 2 + panX + wx * zoom,
      y: height / 2 + panY + wy * zoom,
    };
  }, []);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const { width, height } = sizeRef.current;
    const { panX, panY, zoom } = cameraRef.current;
    return {
      x: (sx - width / 2 - panX) / zoom,
      y: (sy - height / 2 - panY) / zoom,
    };
  }, []);

  const hitNodeAt = useCallback((sx: number, sy: number): CanvasNode | null => {
    const sim = simRef.current;
    if (!sim) return null;
    const { nodes: curNodes } = propsRef.current;
    const zoom = cameraRef.current.zoom;
    for (let i = curNodes.length - 1; i >= 0; i--) {
      const node = curNodes[i]!;
      const body = sim.getPositions().get(node.id);
      if (!body) continue;
      const pos = worldToScreen(body.x, body.y);
      const r = Math.max(10, nodeRadius(node) * zoom + 5);
      const dx = sx - pos.x;
      const dy = sy - pos.y;
      if (dx * dx + dy * dy <= r * r) return node;
    }
    return null;
  }, [worldToScreen]);

  const scheduleDrawRef = useRef<() => void>(() => {});

  const fitGraph = useCallback((animate = true) => {
    const sim = simRef.current;
    const { nodes: curNodes } = propsRef.current;
    const { width, height } = sizeRef.current;
    if (!sim || curNodes.length === 0 || width === 0 || height === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of curNodes) {
      const b = sim.getPositions().get(n.id);
      if (!b) continue;
      if (b.x < minX) minX = b.x;
      if (b.x > maxX) maxX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.y > maxY) maxY = b.y;
    }
    if (!Number.isFinite(minX)) return;

    const spanX = Math.max(120, maxX - minX + 96);
    const spanY = Math.max(100, maxY - minY + 96);
    const padX = Math.max(36, width * 0.08);
    const padY = Math.max(36, height * 0.09);
    const availW = Math.max(80, width - padX * 2);
    const availH = Math.max(80, height - padY * 2);
    const targetZoom = Math.max(MIN_ZOOM, Math.min(1.65, Math.min(availW / spanX, availH / spanY)));
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const targetPanX = -midX * targetZoom;
    const targetPanY = -midY * targetZoom;

    if (!animate) {
      cameraAnimRef.current = null;
      cameraRef.current = { panX: targetPanX, panY: targetPanY, zoom: targetZoom };
    } else {
      const cur = cameraRef.current;
      cameraAnimRef.current = {
        fromPanX: cur.panX,
        fromPanY: cur.panY,
        fromZoom: cur.zoom,
        toPanX: targetPanX,
        toPanY: targetPanY,
        toZoom: targetZoom,
        start: performance.now(),
        duration: 240,
      };
    }
    scheduleDrawRef.current();
  }, []);

  const focusNode = useCallback((id: string, animate = true) => {
    const sim = simRef.current;
    if (!sim) return;
    const body = sim.getPositions().get(id);
    if (!body) return;
    const cur = cameraRef.current;
    const targetZoom = Math.max(cur.zoom, Math.min(1.25, 0.95));
    const targetPanX = -body.x * targetZoom;
    const targetPanY = -body.y * targetZoom;
    if (!animate) {
      cameraAnimRef.current = null;
      cameraRef.current = { panX: targetPanX, panY: targetPanY, zoom: targetZoom };
    } else {
      cameraAnimRef.current = {
        fromPanX: cur.panX,
        fromPanY: cur.panY,
        fromZoom: cur.zoom,
        toPanX: targetPanX,
        toPanY: targetPanY,
        toZoom: targetZoom,
        start: performance.now(),
        duration: 260,
      };
    }
    scheduleDrawRef.current();
  }, []);

  useImperativeHandle(ref, () => ({
    focusNode,
    getNodePosition(id: string) {
      const b = simRef.current?.getPositions().get(id);
      if (!b) return null;
      return { x: Math.round(b.x), y: Math.round(b.y), pinned: b.pinned };
    },
    exportPositions() {
      return simRef.current ? simRef.current.exportPositions() : {};
    },
  }), [focusNode]);

  const zoomBy = useCallback((factor: number, centerX?: number, centerY?: number) => {
    const { width, height } = sizeRef.current;
    const cx = centerX ?? width / 2;
    const cy = centerY ?? height / 2;
    const cam = cameraRef.current;
    cameraAnimRef.current = null;
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor));
    const ratio = nextZoom / cam.zoom;
    const ox = cx - width / 2;
    const oy = cy - height / 2;
    cam.panX = ox - (ox - cam.panX) * ratio;
    cam.panY = oy - (oy - cam.panY) * ratio;
    cam.zoom = nextZoom;
    clearHoverTip();
    scheduleDrawRef.current();
  }, [clearHoverTip]);

  const setHoveredTarget = useCallback((id: string | null) => {
    const h = hoverAnimRef.current;
    if (h.targetId === id) return;
    const now = performance.now();
    h.startProgress = h.progress;
    h.startTime = now;
    h.targetId = id;
    if (id !== null) h.displayId = id;
    scheduleDrawRef.current();
  }, []);

  // Re-resolve CSS tokens whenever theme switches
  useEffect(() => {
    paletteRef.current = resolveGraphThemePalette(containerRef.current, dark);
    fontsRef.current = resolveGraphCanvasFonts(containerRef.current);
    textWidthCacheRef.current.clear();
    scheduleDrawRef.current();
  }, [dark]);

  // Sync physics on nodes/edges/savedPositions changes
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.sync(nodes, edges, toSavedLayoutRecord(savedPositions));
    if (hoverTipNodeIdRef.current && !lookupRef.current.byId.has(hoverTipNodeIdRef.current)) {
      clearHoverTip();
    }
    if (!hasAutoFitRef.current && nodes.length > 0 && sizeRef.current.width > 0) {
      // Pre-warm cold layouts before the initial fit so clusters reach a clean resting spread.
      prewarmSimulation(sim);
      hasAutoFitRef.current = true;
      fitGraph(false);
    }
    scheduleDrawRef.current();
  }, [nodes, edges, savedPositions, fitGraph, clearHoverTip]);

  // Repel strength change
  useEffect(() => {
    simRef.current?.setRepel(toPhysicsRepel(repelStrength));
    scheduleDrawRef.current();
  }, [repelStrength]);

  // Layout epoch reset
  useEffect(() => {
    if (layoutEpoch === lastLayoutEpochRef.current) return;
    lastLayoutEpochRef.current = layoutEpoch;
    const sim = simRef.current;
    if (sim) {
      sim.relayout();
      prewarmSimulation(sim);
    }
    fitGraph(true);
    scheduleDrawRef.current();
  }, [layoutEpoch, fitGraph]);

  // Redraw when purely visual props change
  useEffect(() => {
    scheduleDrawRef.current();
  }, [selectedId, showArrows, showAllLabels, showFolderHalos, folderLabels, searchMatchIds]);

  // Main demand-driven canvas render loop + ResizeObserver + non-passive wheel listener
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setCanvasUnavailable(true);
      return;
    }
    setCanvasUnavailable(false);

    paletteRef.current = resolveGraphThemePalette(container, darkRef.current);
    fontsRef.current = resolveGraphCanvasFonts(container);

    const measureCached = (font: string, text: string): number => {
      const key = `${font}|${text}`;
      const cache = textWidthCacheRef.current;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      ctx.font = font;
      const w = ctx.measureText(text).width;
      if (cache.size > 2000) cache.clear();
      cache.set(key, w);
      return w;
    };

    const drawFrame = (now: number) => {
      rafRef.current = null;
      const sim = simRef.current;
      if (!sim) return;
      const { width, height } = sizeRef.current;
      if (width <= 0 || height <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.round(width * dpr);
      const targetH = Math.round(height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      // Advance camera animation
      let cameraMoving = false;
      const anim = cameraAnimRef.current;
      if (anim) {
        const rawT = Math.min(1, (now - anim.start) / anim.duration);
        const eased = easeOutQuad(rawT);
        cameraRef.current.panX = lerp(anim.fromPanX, anim.toPanX, eased);
        cameraRef.current.panY = lerp(anim.fromPanY, anim.toPanY, eased);
        cameraRef.current.zoom = lerp(anim.fromZoom, anim.toZoom, eased);
        if (rawT < 1) cameraMoving = true;
        else cameraAnimRef.current = null;
      }

      // Advance hover fade (200ms easeOutQuad)
      const hover = hoverAnimRef.current;
      let hoverFading = false;
      const goal = hover.targetId !== null ? 1 : 0;
      if (Math.abs(hover.progress - goal) > 0.002) {
        const rawT = Math.min(1, (now - hover.startTime) / HOVER_FADE_MS);
        const eased = easeOutQuad(rawT);
        hover.progress = lerp(hover.startProgress, goal, eased);
        if (rawT < 1) {
          hoverFading = true;
        } else {
          hover.progress = goal;
          if (goal === 0) hover.displayId = null;
        }
      } else if (goal === 0 && hover.displayId !== null) {
        hover.progress = 0;
        hover.displayId = null;
      }

      // Advance physics
      const physicsMoving = sim.step();
      if (wasMovingRef.current && !physicsMoving) {
        propsRef.current.onPositionsSettled?.(toPositionsMap(sim.exportPositions()));
      }
      wasMovingRef.current = physicsMoving;

      const {
        nodes: curNodes,
        edges: curEdges,
        selectedId: curSelected,
        showArrows: curArrows,
        showAllLabels: curAllLabels,
        showFolderHalos: curHalos,
        folderLabels: curFolders,
        searchMatchIds: curSearch,
      } = propsRef.current;
      const { byId, adj, biLinks } = lookupRef.current;
      const palette = paletteRef.current ?? resolveGraphThemePalette(container, darkRef.current);
      const fonts = fontsRef.current ?? resolveGraphCanvasFonts(container);
      fontsRef.current = fonts;
      const { panX, panY, zoom } = cameraRef.current;
      const positions = sim.getPositions();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const toScreenX = (wx: number) => width / 2 + panX + wx * zoom;
      const toScreenY = (wy: number) => height / 2 + panY + wy * zoom;

      const hoverId = hover.displayId && byId.has(hover.displayId) ? hover.displayId : null;
      const hoverP = hoverId ? hover.progress : 0;
      const hoverNeighbors = hoverId ? adj.get(hoverId) : undefined;
      const validSelected = curSelected && byId.has(curSelected) ? curSelected : null;
      const selectedNeighbors = validSelected ? adj.get(validSelected) : undefined;
      const activeSpotId = hoverP > 0.05 && hoverId ? hoverId : validSelected;
      const searchActive = curSearch !== null && curSearch !== undefined;
      const narrowSearch = searchActive && curSearch.size <= SEARCH_FORCE_LABEL_LIMIT;
      const showSearchHalos = searchActive && curSearch.size <= SEARCH_HALO_LIMIT;

      // 1. Folder territory halos (draw discs now; defer halo labels until after Tier 0/1 node labels)
      const deferredHaloLabels: Array<{ text: string; cx: number; cy: number; maxR: number; col: string }> = [];
      if (curHalos && (curNodes.length <= 450 || zoom >= 0.45)) {
        const groups = new Map<string, { sx: number; sy: number }[]>();
        for (let i = 0; i < curNodes.length; i++) {
          const n = curNodes[i]!;
          if (!n.folderId || n.kind === 'missing' || n.kind === 'folderHub') continue;
          const b = positions.get(n.id);
          if (!b) continue;
          let arr = groups.get(n.folderId);
          if (!arr) { arr = []; groups.set(n.folderId, arr); }
          arr.push({ sx: toScreenX(b.x), sy: toScreenY(b.y) });
        }

        const maxAllowedHaloR = Math.min(width, height) * 0.32;
        groups.forEach((pts, folderId) => {
          if (pts.length < 2) return;
          let cx = 0;
          let cy = 0;
          for (const p of pts) { cx += p.sx; cy += p.sy; }
          cx /= pts.length;
          cy /= pts.length;
          let maxR = 44 * Math.min(1.4, Math.max(0.7, zoom));
          for (const p of pts) {
            const d = Math.hypot(p.sx - cx, p.sy - cy) + 26 * Math.min(1.3, Math.max(0.75, zoom));
            if (d > maxR) maxR = d;
          }
          if (maxR > maxAllowedHaloR) return;
          if (cx + maxR < -20 || cx - maxR > width + 20 || cy + maxR < -20 || cy - maxR > height + 20) return;

          const meta = curFolders?.get(folderId);
          const col = meta?.colorKey && isLookColor(meta.colorKey)
            ? palette.labels[meta.colorKey]
            : palette.accent;

          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
          ctx.fillStyle = col;
          ctx.globalAlpha = lerp(0.032, 0.012, hoverP);
          ctx.fill();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.globalAlpha = lerp(0.14, 0.04, hoverP);
          ctx.stroke();
          ctx.restore();

          if (meta?.label && maxR > 26) {
            deferredHaloLabels.push({ text: meta.label.toUpperCase(), cx, cy, maxR, col });
          }
        });
      }

      // 2. Edges: batch background link/smart edges into two strokes; draw highlighted edges on top.
      const pad = 40;
      const idleLinkAlpha = darkRef.current ? 0.44 : 0.38;
      const bgLinkAlpha = hoverId
        ? lerp(validSelected ? 0.32 : idleLinkAlpha, 0.1, hoverP)
        : (validSelected ? 0.32 : idleLinkAlpha);
      const bgSmartAlpha = hoverId
        ? lerp(validSelected ? 0.34 : 0.44, 0.1, hoverP)
        : (validSelected ? 0.34 : 0.44);

      const curveControlPoint = (ax: number, ay: number, bx: number, by: number) => {
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const offset = Math.min(14, Math.max(6, len * 0.12));
        return {
          mx: (ax + bx) / 2 - (dy / len) * offset,
          my: (ay + by) / 2 + (dx / len) * offset,
        };
      };

      const highlightedEdges: Array<{
        e: CanvasEdge;
        ax: number;
        ay: number;
        bx: number;
        by: number;
        bi: boolean;
        alpha: number;
        strokeColor: string;
        spotActive: boolean;
      }> = [];
      const bgArrowTips: Array<{ ax: number; ay: number; bx: number; by: number; fromX: number; fromY: number; targetId: string }> = [];

      let hasBgLink = false;
      let hasBgSmart = false;
      const bgLinkPath = new Path2D();
      const bgSmartPath = new Path2D();

      for (let i = 0; i < curEdges.length; i++) {
        const e = curEdges[i]!;
        const ba = positions.get(e.source);
        const bb = positions.get(e.target);
        if (!ba || !bb) continue;
        const ax = toScreenX(ba.x);
        const ay = toScreenY(ba.y);
        const bx = toScreenX(bb.x);
        const by = toScreenY(bb.y);

        if (
          (ax < -pad && bx < -pad) ||
          (ax > width + pad && bx > width + pad) ||
          (ay < -pad && by < -pad) ||
          (ay > height + pad && by > height + pad)
        ) {
          continue;
        }

        const hoverActive = hoverId !== null && (e.source === hoverId || e.target === hoverId);
        const selActive = validSelected !== null && (e.source === validSelected || e.target === validSelected);
        const spotActive = activeSpotId !== null && (e.source === activeSpotId || e.target === activeSpotId);
        const searchDim = searchActive && !(curSearch.has(e.source) && curSearch.has(e.target));
        const bi = e.kind === 'link' && biLinks.has(e.key);

        if (!spotActive && !hoverActive && !selActive && !searchDim) {
          if (e.kind === 'smart') {
            bgSmartPath.moveTo(ax, ay);
            bgSmartPath.lineTo(bx, by);
            hasBgSmart = true;
          } else {
            bgLinkPath.moveTo(ax, ay);
            let fromX = ax;
            let fromY = ay;
            if (bi) {
              const cp = curveControlPoint(ax, ay, bx, by);
              bgLinkPath.quadraticCurveTo(cp.mx, cp.my, bx, by);
              fromX = cp.mx;
              fromY = cp.my;
            } else {
              bgLinkPath.lineTo(bx, by);
            }
            hasBgLink = true;
            if (curArrows && bgLinkAlpha > 0.18) {
              bgArrowTips.push({ ax, ay, bx, by, fromX, fromY, targetId: e.target });
            }
          }
          continue;
        }

        const baseAlpha = e.kind === 'smart'
          ? (selActive ? 0.94 : validSelected ? 0.34 : 0.44)
          : (selActive ? 0.95 : validSelected ? 0.32 : idleLinkAlpha);
        const hoverAlpha = e.kind === 'smart'
          ? (hoverActive ? 0.96 : 0.1)
          : (hoverActive ? 0.96 : 0.1);
        let alpha = hoverId ? lerp(baseAlpha, hoverAlpha, hoverP) : baseAlpha;
        if (searchDim) alpha = Math.min(alpha, 0.12);

        const isIncoming = activeSpotId !== null && e.target === activeSpotId;
        const strokeColor = e.kind === 'smart'
          ? palette.success
          : spotActive
            ? (isIncoming ? palette.warning : palette.accent)
            : palette.muted;

        highlightedEdges.push({ e, ax, ay, bx, by, bi, alpha, strokeColor, spotActive });
      }

      if (hasBgLink) {
        ctx.save();
        ctx.strokeStyle = palette.muted;
        ctx.globalAlpha = bgLinkAlpha;
        ctx.lineWidth = 1.3;
        ctx.stroke(bgLinkPath);
        if (bgArrowTips.length > 0) {
          const headLen = Math.min(7, Math.max(4.5, 5.5 * Math.sqrt(zoom)));
          ctx.fillStyle = palette.muted;
          ctx.globalAlpha = Math.min(0.68, bgLinkAlpha + 0.14);
          ctx.beginPath();
          for (let i = 0; i < bgArrowTips.length; i++) {
            const tip = bgArrowTips[i]!;
            const targetNode = byId.get(tip.targetId);
            if (!targetNode) continue;
            const targetOffset = nodeRadius(targetNode) * zoom + 4.5;
            const dx = tip.bx - tip.fromX;
            const dy = tip.by - tip.fromY;
            const len = Math.hypot(dx, dy);
            if (len <= targetOffset + 6) continue;
            const ang = Math.atan2(dy, dx);
            const tipX = tip.bx - Math.cos(ang) * targetOffset;
            const tipY = tip.by - Math.sin(ang) * targetOffset;
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(tipX - Math.cos(ang - 0.45) * headLen, tipY - Math.sin(ang - 0.45) * headLen);
            ctx.lineTo(tipX - Math.cos(ang + 0.45) * headLen, tipY - Math.sin(ang + 0.45) * headLen);
            ctx.closePath();
          }
          ctx.fill();
        }
        ctx.restore();
      }

      if (hasBgSmart) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = palette.success;
        ctx.globalAlpha = bgSmartAlpha;
        ctx.lineWidth = 1.35;
        ctx.stroke(bgSmartPath);
        ctx.restore();
      }

      for (let i = 0; i < highlightedEdges.length; i++) {
        const { e, ax, ay, bx, by, bi, alpha, strokeColor, spotActive } = highlightedEdges[i]!;
        ctx.save();
        ctx.beginPath();
        if (e.kind === 'smart') ctx.setLineDash([4, 4]);
        ctx.strokeStyle = strokeColor;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = spotActive ? (e.kind === 'smart' ? 2.1 : 2.15) : (e.kind === 'smart' ? 1.35 : 1.3);
        ctx.moveTo(ax, ay);
        let fromX = ax;
        let fromY = ay;
        if (bi) {
          const cp = curveControlPoint(ax, ay, bx, by);
          ctx.quadraticCurveTo(cp.mx, cp.my, bx, by);
          fromX = cp.mx;
          fromY = cp.my;
        } else {
          ctx.lineTo(bx, by);
        }
        ctx.stroke();

        if (curArrows && e.kind === 'link' && alpha > 0.18) {
          const targetNode = byId.get(e.target);
          if (targetNode) {
            const dx = bx - fromX;
            const dy = by - fromY;
            const len = Math.hypot(dx, dy);
            const targetOffset = nodeRadius(targetNode) * zoom + 4.5;
            if (len > targetOffset + 6) {
              const ang = Math.atan2(dy, dx);
              const tipX = bx - Math.cos(ang) * targetOffset;
              const tipY = by - Math.sin(ang) * targetOffset;
              const headLen = Math.min(7.5, Math.max(4.5, 5.8 * Math.sqrt(zoom)));
              ctx.setLineDash([]);
              ctx.fillStyle = strokeColor;
              ctx.beginPath();
              ctx.moveTo(tipX, tipY);
              ctx.lineTo(tipX - Math.cos(ang - 0.45) * headLen, tipY - Math.sin(ang - 0.45) * headLen);
              ctx.lineTo(tipX - Math.cos(ang + 0.45) * headLen, tipY - Math.sin(ang + 0.45) * headLen);
              ctx.closePath();
              ctx.fill();
            }
          }
        }
        ctx.restore();
      }

      // 3. Alt/Option + Drag live link tether
      const linkDrag = linkDragRef.current;
      if (linkDrag && linkDrag.moved) {
        const srcBody = positions.get(linkDrag.sourceId);
        if (srcBody) {
          const sx = toScreenX(srcBody.x);
          const sy = toScreenY(srcBody.y);
          let tx = linkDrag.x;
          let ty = linkDrag.y;
          if (linkDrag.targetId) {
            const tb = positions.get(linkDrag.targetId);
            if (tb) {
              tx = toScreenX(tb.x);
              ty = toScreenY(tb.y);
            }
          }
          ctx.save();
          ctx.strokeStyle = palette.accent;
          ctx.lineWidth = 2.2;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          if (linkDrag.targetId) {
            const targetNode = byId.get(linkDrag.targetId);
            const tr = (targetNode ? nodeRadius(targetNode) : 8) * zoom + 6;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(tx, ty, tr, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      }

      // 4. Nodes + tiered, collision-free Smart Labels
      const visibleNodeBoxes: Array<{ id: string; x0: number; y0: number; x1: number; y1: number }> = [];
      const labelCandidates: Array<{
        node: CanvasNode;
        sx: number;
        sy: number;
        r: number;
        labelAlpha: number;
        isSel: boolean;
        isHov: boolean;
        tier: 0 | 1 | 2;
        priority: number;
      }> = [];

      for (let i = 0; i < curNodes.length; i++) {
        const node = curNodes[i]!;
        const body = positions.get(node.id);
        if (!body) continue;
        const sx = toScreenX(body.x);
        const sy = toScreenY(body.y);
        const r = Math.max(1.8, nodeRadius(node) * zoom);

        // Viewport cull (keep generous margin for labels)
        if (sx < -120 || sx > width + 120 || sy < -60 || sy > height + 60) continue;

        if (r >= 3) {
          const padNode = r + 1.5;
          visibleNodeBoxes.push({ id: node.id, x0: sx - padNode, y0: sy - padNode, x1: sx + padNode, y1: sy + padNode });
        }

        const col = resolveNodeColor(node, palette);
        const isSel = node.id === validSelected;
        const isHov = node.id === hoverId;
        const inHoverHood = hoverId !== null && (isHov || Boolean(hoverNeighbors?.has(node.id)));
        const inSelHood = validSelected !== null && (isSel || Boolean(selectedNeighbors?.has(node.id)));
        const matchesSearch = searchActive && curSearch.has(node.id);

        const baseNodeAlpha = validSelected ? (inSelHood ? 1 : 0.78) : 1;
        const hoverNodeAlpha = inHoverHood ? 1 : 0.18;
        let nodeAlpha = hoverId ? lerp(baseNodeAlpha, hoverNodeAlpha, hoverP) : baseNodeAlpha;
        if (searchActive && !matchesSearch) nodeAlpha = 0.18;

        ctx.save();
        ctx.globalAlpha = nodeAlpha;

        // Soft layered halo for selected, hovered, or focused search match
        if (isSel || (isHov && hoverP > 0.1) || (matchesSearch && showSearchHalos)) {
          const haloCol = matchesSearch && showSearchHalos ? palette.success : col;
          ctx.beginPath();
          ctx.arc(sx, sy, r + 7, 0, Math.PI * 2);
          ctx.fillStyle = haloCol;
          ctx.globalAlpha = nodeAlpha * 0.16;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(sx, sy, r + 3.5, 0, Math.PI * 2);
          ctx.globalAlpha = nodeAlpha * 0.14;
          ctx.fill();
          ctx.globalAlpha = nodeAlpha;
        }

        // Node body
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        if (node.kind === 'missing') {
          ctx.fillStyle = palette.surface;
          ctx.fill();
          ctx.setLineDash([3, 2.5]);
          ctx.lineWidth = 1.8;
          ctx.strokeStyle = palette.muted;
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (node.kind === 'folderHub') {
          ctx.fillStyle = col;
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = palette.ringWhite;
          ctx.stroke();
          if (node.memberCount != null && r >= 10) {
            const countPx = Math.max(Math.round(fonts.metaPx * 0.82), Math.min(Math.round(fonts.smallPx), Math.round(r * 0.68)));
            ctx.font = `700 ${countPx}px ${fonts.sans}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = palette.ringWhite;
            ctx.fillText(String(node.memberCount), sx, sy + 0.5);
          }
        } else {
          ctx.fillStyle = col;
          ctx.fill();
          if (isSel || isHov) {
            ctx.lineWidth = 2;
            ctx.strokeStyle = palette.ringWhite;
            ctx.stroke();
          } else if (r >= 4) {
            ctx.lineWidth = 1.25;
            ctx.strokeStyle = palette.surface;
            ctx.stroke();
          }
        }

        // Pin dot at top-right of pinned nodes
        if (body.pinned) {
          ctx.beginPath();
          ctx.arc(sx + r * 0.72, sy - r * 0.72, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = palette.warning;
          ctx.fill();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = palette.surface;
          ctx.stroke();
        }

        ctx.restore();

        // Classify smart label tier and continuous zoom opacity
        if (nodeAlpha > 0.25) {
          const isTier0 = isHov || isSel || node.kind === 'folderHub' || (matchesSearch && narrowSearch);
          const isTier1 = !isTier0 && (inHoverHood || inSelHood);

          let tier: 0 | 1 | 2 | null = null;
          let labelAlpha = nodeAlpha;

          if (isTier0) {
            tier = 0;
          } else if (isTier1) {
            tier = 1;
          } else if (curAllLabels) {
            tier = 2;
          } else {
            const zoomFade = ambientLabelOpacity(node.degree, zoom, curNodes.length);
            if (zoomFade > 0.08) {
              tier = 2;
              labelAlpha = nodeAlpha * zoomFade;
            }
          }

          if (tier !== null) {
            const priority =
              (isHov ? 200_000 : 0) +
              (isSel ? 100_000 : 0) +
              (inHoverHood ? 40_000 : 0) +
              (inSelHood ? 30_000 : 0) +
              (matchesSearch ? 15_000 : 0) +
              (node.kind === 'folderHub' ? 8_000 : 0) +
              node.degree * 100 +
              (node.kind === 'missing' ? -20 : 0);
            labelCandidates.push({ node, sx, sy, r, labelAlpha, isSel, isHov, tier, priority });
          }
        }
      }

      labelCandidates.sort((a, b) => b.priority - a.priority);
      const placedBoxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
      const padX = zoom < 0.7 ? 18 : 10;
      const padY = zoom < 0.7 ? 14 : 6;
      const maxLabelChars = zoom < 0.55 ? 20 : zoom < 0.9 ? 24 : 28;
      // Viewport-scaled ambient label budget keeps galaxy views serene and uncluttered.
      const maxAmbientLabels = curAllLabels
        ? Number.POSITIVE_INFINITY
        : Math.max(10, Math.min(40, Math.round(((width * height) / 30_000) * Math.min(1.6, Math.max(0.45, zoom)))));
      let ambientPlaced = 0;

      const collidesAny = (
        box: { x0: number; y0: number; x1: number; y1: number },
      ): boolean => {
        for (let j = 0; j < placedBoxes.length; j++) {
          const p = placedBoxes[j]!;
          if (box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0) return true;
        }
        return false;
      };

      const collidesNode = (
        box: { x0: number; y0: number; x1: number; y1: number },
        ignoreId?: string,
      ): boolean => {
        if (visibleNodeBoxes.length > 400) return false;
        for (let j = 0; j < visibleNodeBoxes.length; j++) {
          const p = visibleNodeBoxes[j]!;
          if (p.id === ignoreId) continue;
          if (box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0) return true;
        }
        return false;
      };

      const drawCandidateLabel = (c: (typeof labelCandidates)[number]) => {
        const weight = c.isSel || c.isHov || c.node.kind === 'folderHub' ? 600 : 500;
        const font = `${weight} ${fonts.smallPx}px ${fonts.sans}`;
        const text = truncateGraphLabel(c.node.title, c.isHov || c.isSel ? 34 : maxLabelChars);
        const textW = measureCached(font, text);
        const halfW = textW / 2 + (c.tier === 2 && !curAllLabels ? padX / 2 : 6);
        const ly = c.sy + c.r + 13.5;
        const extraY = c.tier === 2 && !curAllLabels ? padY : 6;
        const box = { x0: c.sx - halfW, y0: ly - 11 - extraY / 2, x1: c.sx + halfW, y1: ly + 3 + extraY / 2 };

        if (!c.isHov && !c.isSel && !curAllLabels) {
          if (c.tier === 2 && ambientPlaced >= maxAmbientLabels) return;
          if (collidesAny(box)) return;
          if (c.tier === 2 && collidesNode({ x0: c.sx - textW / 2 - 2, y0: ly - 10, x1: c.sx + textW / 2 + 2, y1: ly + 2 }, c.node.id)) return;
        }
        placedBoxes.push(box);
        if (c.tier === 2) ambientPlaced += 1;

        ctx.save();
        ctx.font = font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3.5;
        ctx.globalAlpha = c.labelAlpha;
        ctx.strokeStyle = palette.surface;
        ctx.strokeText(text, c.sx, ly);
        ctx.fillStyle = c.node.kind === 'missing' ? palette.muted : palette.text;
        ctx.fillText(text, c.sx, ly);
        ctx.restore();
      };

      // Pass A: Tier 0 & Tier 1 node labels first (always win priority)
      for (let i = 0; i < labelCandidates.length; i++) {
        const c = labelCandidates[i]!;
        if (c.tier <= 1) drawCandidateLabel(c);
      }

      // Pass B: Deferred folder halo labels above the rim (never cover Tier 0/1 node labels or node dots)
      if (deferredHaloLabels.length > 0) {
        const haloFont = `700 ${Math.max(9, Math.round(fonts.metaPx * 0.88 * 10) / 10)}px ${fonts.sans}`;
        for (let i = 0; i < deferredHaloLabels.length; i++) {
          const h = deferredHaloLabels[i]!;
          const halfW = measureCached(haloFont, h.text) / 2 + 6;
          const ly = Math.max(14, h.cy - h.maxR - 4);
          const box = { x0: h.cx - halfW, y0: ly - 10, x1: h.cx + halfW, y1: ly + 3 };
          if (collidesAny(box) || collidesNode(box)) continue;
          placedBoxes.push(box);
          ctx.save();
          ctx.font = haloFont;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = h.col;
          ctx.globalAlpha = lerp(0.62, 0.22, hoverP);
          ctx.fillText(h.text, h.cx, ly);
          ctx.restore();
        }
      }

      // Pass C: Tier 2 ambient labels (zoom-faded, collision-checked, viewport-capped)
      for (let i = 0; i < labelCandidates.length; i++) {
        const c = labelCandidates[i]!;
        if (c.tier === 2) drawCandidateLabel(c);
      }

      if (physicsMoving || hoverFading || cameraMoving) {
        rafRef.current = requestAnimationFrame(drawFrame);
      }
    };

    const schedule = () => {
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(drawFrame);
      }
    };
    scheduleDrawRef.current = schedule;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      sizeRef.current = { width: rect.width, height: rect.height };
      if (!hasAutoFitRef.current && propsRef.current.nodes.length > 0 && rect.width > 0 && rect.height > 0) {
        const sim = simRef.current;
        if (sim) prewarmSimulation(sim);
        hasAutoFitRef.current = true;
        fitGraph(false);
      }
      schedule();
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(container);

    // Re-render crisply when moving between displays with different devicePixelRatio.
    let dprMql: MediaQueryList | null = null;
    const watchDpr = () => {
      dprMql?.removeEventListener?.('change', onDprChange);
      if (typeof window.matchMedia === 'function') {
        dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        dprMql?.addEventListener?.('change', onDprChange);
      }
    };
    const onDprChange = () => {
      textWidthCacheRef.current.clear();
      schedule();
      watchDpr();
    };
    watchDpr();

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 400;
      const clamped = Math.max(-180, Math.min(180, dy));
      const coeff = e.ctrlKey ? 0.01 : 0.0018;
      zoomBy(Math.exp(-clamped * coeff), sx, sy);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      ro.disconnect();
      dprMql?.removeEventListener?.('change', onDprChange);
      canvas.removeEventListener('wheel', onWheel);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [fitGraph, zoomBy]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    canvas.focus({ preventScroll: true });
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    activePointersRef.current.set(e.pointerId, { x: sx, y: sy });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore synthetic events */ }

    // Two-finger touch pinch-zoom + pan
    if (activePointersRef.current.size === 2) {
      cancelLongPress();
      abortNodeDrag();
      panDragRef.current = null;
      linkDragRef.current = null;
      clearHoverTip();
      const pts = Array.from(activePointersRef.current.values());
      const a = pts[0]!;
      const b = pts[1]!;
      pinchRef.current = {
        dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
      return;
    }

    const hit = hitNodeAt(sx, sy);
    const locked = propsRef.current.layoutLocked;
    const pointerThreshold = e.pointerType === 'touch' ? DRAG_THRESHOLD_TOUCH_PX : DRAG_THRESHOLD_MOUSE_PX;
    if (hit) {
      if (!locked && e.altKey && isLinkableNode(hit) && onCreateLink) {
        linkDragRef.current = {
          sourceId: hit.id,
          pointerId: e.pointerId,
          startX: sx,
          startY: sy,
          x: sx,
          y: sy,
          moved: false,
          targetId: null,
        };
        clearHoverTip();
        setCursorStyle('crosshair');
        scheduleDrawRef.current();
        return;
      }
      longPressFiredRef.current = false;
      cancelLongPress();
      if (e.pointerType === 'touch' && onNodeContextMenu) {
        const cx = e.clientX;
        const cy = e.clientY;
        const hitId = hit.id;
        const pid = e.pointerId;
        const timer = window.setTimeout(() => {
          longPressRef.current = null;
          longPressFiredRef.current = true;
          abortNodeDrag();
          panDragRef.current = null;
          onSelectNode(hitId);
          onNodeContextMenu(hitId, cx, cy);
        }, 500);
        longPressRef.current = { timer, pointerId: pid, startX: sx, startY: sy };
      }
      if (locked) {
        // Layout locked: dragging anywhere (even starting on a node) pans safely, while a tap still selects/opens.
        panDragRef.current = {
          pointerId: e.pointerId,
          startX: sx,
          startY: sy,
          origPanX: cameraRef.current.panX,
          origPanY: cameraRef.current.panY,
          moved: false,
          threshold: pointerThreshold,
          hitNodeId: hit.id,
          altKey: e.altKey,
        };
      } else {
        nodeDragRef.current = {
          id: hit.id,
          pointerId: e.pointerId,
          startX: sx,
          startY: sy,
          moved: false,
          altKey: e.altKey,
          threshold: pointerThreshold,
        };
      }
      setCursorStyle('grabbing');
      scheduleDrawRef.current();
    } else {
      panDragRef.current = {
        pointerId: e.pointerId,
        startX: sx,
        startY: sy,
        origPanX: cameraRef.current.panX,
        origPanY: cameraRef.current.panY,
        moved: false,
        threshold: pointerThreshold,
        hitNodeId: null,
        altKey: false,
      };
      setCursorStyle('grabbing');
      scheduleDrawRef.current();
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: sx, y: sy });
    }

    const lp = longPressRef.current;
    if (lp && lp.pointerId === e.pointerId && Math.hypot(sx - lp.startX, sy - lp.startY) > DRAG_THRESHOLD_TOUCH_PX) {
      cancelLongPress();
    }

    // Two-finger pinch-zoom + pan
    if (activePointersRef.current.size === 2 && pinchRef.current) {
      const pts = Array.from(activePointersRef.current.values());
      const a = pts[0]!;
      const b = pts[1]!;
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const prev = pinchRef.current;
      const factor = dist / prev.dist;
      cameraRef.current.panX += midX - prev.midX;
      cameraRef.current.panY += midY - prev.midY;
      zoomBy(factor, midX, midY);
      pinchRef.current = { dist, midX, midY };
      return;
    }

    // Alt+Drag live link tether (tiny tap resolves to Alt+Click open in tab)
    const linkDrag = linkDragRef.current;
    if (linkDrag && linkDrag.pointerId === e.pointerId) {
      linkDrag.x = sx;
      linkDrag.y = sy;
      if (!linkDrag.moved && Math.hypot(sx - linkDrag.startX, sy - linkDrag.startY) > DRAG_THRESHOLD_MOUSE_PX) {
        linkDrag.moved = true;
      }
      if (linkDrag.moved) {
        const hit = hitNodeAt(sx, sy);
        const validTarget = hit && hit.id !== linkDrag.sourceId && isLinkableNode(hit) ? hit.id : null;
        linkDrag.targetId = validTarget;
        setHoveredTarget(validTarget);
        scheduleDrawRef.current();
      }
      return;
    }

    // Node drag
    const nodeDrag = nodeDragRef.current;
    if (nodeDrag && nodeDrag.pointerId === e.pointerId) {
      const dist = Math.hypot(sx - nodeDrag.startX, sy - nodeDrag.startY);
      if (!nodeDrag.moved && dist > nodeDrag.threshold) {
        nodeDrag.moved = true;
        cancelLongPress();
        simRef.current?.grab(nodeDrag.id);
        clearHoverTip();
      }
      if (nodeDrag.moved) {
        const w = screenToWorld(sx, sy);
        simRef.current?.drag(nodeDrag.id, w.x, w.y);
        scheduleDrawRef.current();
      }
      return;
    }

    // Canvas pan
    const panDrag = panDragRef.current;
    if (panDrag && panDrag.pointerId === e.pointerId) {
      const dist = Math.hypot(sx - panDrag.startX, sy - panDrag.startY);
      if (!panDrag.moved && dist > panDrag.threshold) {
        panDrag.moved = true;
        cancelLongPress();
        clearHoverTip();
      }
      if (panDrag.moved) {
        cameraAnimRef.current = null;
        cameraRef.current.panX = panDrag.origPanX + (sx - panDrag.startX);
        cameraRef.current.panY = panDrag.origPanY + (sy - panDrag.startY);
        scheduleDrawRef.current();
      }
      return;
    }

    // Passive hover: anchor tooltip to the node position so mouse jitter never causes 60Hz React re-renders.
    if (e.pointerType === 'touch') return;
    const hit = hitNodeAt(sx, sy);
    setHoveredTarget(hit ? hit.id : null);
    setCursorStyle(hit ? 'pointer' : 'grab');
    if (hit) {
      if (hoverTipNodeIdRef.current !== hit.id) {
        hoverTipNodeIdRef.current = hit.id;
        const body = simRef.current?.getPositions().get(hit.id);
        const anchor = body ? worldToScreen(body.x, body.y) : { x: sx, y: sy };
        setHoverTip({ node: hit, x: anchor.x, y: anchor.y });
      }
    } else {
      clearHoverTip();
    }
  };

  const finishPointer = (e: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const canvas = canvasRef.current;
    cancelLongPress();
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      activePointersRef.current.delete(e.pointerId);
      return;
    }
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) pinchRef.current = null;

    if (canvas) {
      try {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      } catch { /* ignore */ }
    }

    const rect = canvas?.getBoundingClientRect();
    const sx = rect ? e.clientX - rect.left : 0;
    const sy = rect ? e.clientY - rect.top : 0;

    // Alt+Drag link completion (or Alt+Click open in tab when not dragged)
    const linkDrag = linkDragRef.current;
    if (linkDrag && linkDrag.pointerId === e.pointerId) {
      linkDragRef.current = null;
      setHoveredTarget(null);
      setCursorStyle('grab');
      if (!cancelled) {
        if (!linkDrag.moved) {
          onOpenNode(linkDrag.sourceId, { newTab: true });
        } else {
          const target = hitNodeAt(sx, sy);
          if (target && target.id !== linkDrag.sourceId && isLinkableNode(target)) {
            onCreateLink?.(linkDrag.sourceId, target.id);
          }
        }
      }
      scheduleDrawRef.current();
      return;
    }

    const activateClickedNode = (nodeId: string, altKey: boolean) => {
      const clicked = lookupRef.current.byId.get(nodeId);
      if (!clicked) return;
      if (clicked.kind === 'folderHub') {
        const parsed = parseGraphSelectionId(clicked.id);
        const fId = clicked.folderId ?? (parsed.kind === 'folder' ? parsed.folderId : clicked.id);
        onExpandFolderHub?.(fId);
      } else if (altKey && isLinkableNode(clicked)) {
        onOpenNode(clicked.id, { newTab: true });
      } else {
        const now = performance.now();
        const prev = lastClickRef.current;
        if (prev && prev.id === clicked.id && now - prev.time <= DOUBLE_CLICK_MS) {
          lastClickRef.current = null;
          if (isLinkableNode(clicked)) onOpenNode(clicked.id);
          else onSelectNode(clicked.id);
        } else {
          lastClickRef.current = { id: clicked.id, time: now };
          onSelectNode(clicked.id);
        }
      }
    };

    // Node click or drag end
    const nodeDrag = nodeDragRef.current;
    if (nodeDrag && nodeDrag.pointerId === e.pointerId) {
      nodeDragRef.current = null;
      setCursorStyle('pointer');
      if (nodeDrag.moved) {
        simRef.current?.release(nodeDrag.id, !cancelled);
        if (!cancelled && simRef.current) onPositionsSettled?.(toPositionsMap(simRef.current.exportPositions()));
      } else if (!cancelled) {
        simRef.current?.release(nodeDrag.id, false);
        activateClickedNode(nodeDrag.id, nodeDrag.altKey);
      } else {
        simRef.current?.release(nodeDrag.id, false);
      }
      scheduleDrawRef.current();
      return;
    }

    // Pan end (or tap on a node while layout is locked)
    const panDrag = panDragRef.current;
    if (panDrag && panDrag.pointerId === e.pointerId) {
      panDragRef.current = null;
      setCursorStyle(panDrag.hitNodeId && !panDrag.moved ? 'pointer' : 'grab');
      if (!panDrag.moved && !cancelled) {
        if (panDrag.hitNodeId) {
          activateClickedNode(panDrag.hitNodeId, panDrag.altKey);
        } else {
          lastClickRef.current = null;
          onSelectNode(null);
        }
      }
      scheduleDrawRef.current();
    }
  };

  const handlePointerLeave = () => {
    if (!nodeDragRef.current && !linkDragRef.current) {
      setHoveredTarget(null);
      clearHoverTip();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(1.18);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomBy(0.84);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      fitGraph(true);
      return;
    }
    if (e.key === 'Escape') {
      if (linkDragRef.current) {
        e.preventDefault();
        e.stopPropagation();
        linkDragRef.current = null;
        setHoveredTarget(null);
        setCursorStyle('grab');
        scheduleDrawRef.current();
        return;
      }
      if (selectedId !== null) {
        e.preventDefault();
        e.stopPropagation();
        onSelectNode(null);
      }
      return;
    }
    if (e.key === 'Enter' && selectedId) {
      const sel = lookupRef.current.byId.get(selectedId);
      if (!sel) return;
      e.preventDefault();
      if (sel.kind === 'folderHub') {
        const parsed = parseGraphSelectionId(sel.id);
        onExpandFolderHub?.(sel.folderId ?? (parsed.kind === 'folder' ? parsed.folderId : sel.id));
      } else if (isLinkableNode(sel)) {
        onOpenNode(sel.id, { newTab: e.altKey });
      }
      return;
    }

    const dirMap: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const dir = dirMap[e.key];
    if (!dir) return;
    e.preventDefault();

    const sim = simRef.current;
    if (!sim || nodes.length === 0) return;

    if (!selectedId || !lookupRef.current.byId.has(selectedId)) {
      let best = nodes[0]!;
      for (const n of nodes) {
        if (n.degree > best.degree) best = n;
      }
      onSelectNode(best.id);
      return;
    }

    const curBody = sim.getPositions().get(selectedId);
    if (!curBody) return;
    const [dxDir, dyDir] = dir;

    const pickNearest = (candidateIds: Iterable<string>): string | null => {
      let bestId: string | null = null;
      let bestScore = Infinity;
      for (const cid of candidateIds) {
        if (cid === selectedId) continue;
        const b = sim.getPositions().get(cid);
        if (!b) continue;
        const vx = b.x - curBody.x;
        const vy = b.y - curBody.y;
        const dist = Math.hypot(vx, vy);
        if (dist < 0.001) continue;
        const cos = (vx * dxDir + vy * dyDir) / dist;
        if (cos < 0.25) continue;
        // Prefer tightly aligned and closer candidates
        const score = dist / (cos * cos);
        if (score < bestScore) {
          bestScore = score;
          bestId = cid;
        }
      }
      return bestId;
    };

    const connected = lookupRef.current.adj.get(selectedId);
    const nextId = (connected ? pickNearest(connected) : null) ?? pickNearest(nodes.map((n) => n.id));
    if (nextId) {
      onSelectNode(nextId);
      const nb = sim.getPositions().get(nextId);
      if (nb) {
        const s = worldToScreen(nb.x, nb.y);
        const { width, height } = sizeRef.current;
        if (s.x < 48 || s.x > width - 48 || s.y < 48 || s.y > height - 48) {
          cameraRef.current.panX -= s.x - width / 2;
          cameraRef.current.panY -= s.y - height / 2;
          scheduleDrawRef.current();
        }
      }
    }
  };

  // Flip & clamp hover tooltip cleanly inside container bounds
  const tipPos = useMemo(() => {
    if (!hoverTip) return null;
    const { width, height } = sizeRef.current;
    const tipW = 224;
    const tipH = hoverTip.node.tags.length > 0 ? 124 : 88;
    const rawX = hoverTip.x + 16;
    const left = rawX + tipW > width - 10
      ? Math.max(10, hoverTip.x - tipW - 16)
      : Math.max(10, rawX);
    const rawY = hoverTip.y + 12;
    const top = rawY + tipH > height - 10
      ? Math.max(10, hoverTip.y - tipH - 12)
      : Math.max(10, rawY);
    return { left, top };
  }, [hoverTip]);

  const zoomInLabel = t('media:viewer.zoomIn');
  const zoomOutLabel = t('media:viewer.zoomOut');
  const fitLabel = t('notes:graph.fitGraph');
  const formatConn = (c: number) => t('notes:graph.connectionsCount', { count: c });

  const tipFolderLabel =
    hoverTip && hoverTip.node.kind !== 'folderHub' && hoverTip.node.folderId
      ? folderLabels?.get(hoverTip.node.folderId)?.label
      : undefined;

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onNodeContextMenu) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitNodeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    clearHoverTip();
    onSelectNode(hit.id);
    onNodeContextMenu(hit.id, e.clientX, e.clientY);
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-surface-2 select-none"
      style={{
        backgroundImage: dark
          ? 'radial-gradient(rgb(var(--pn-text) / 0.06) 1px, transparent 1px)'
          : 'radial-gradient(rgb(var(--pn-text) / 0.075) 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label={ariaLabel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => finishPointer(e, false)}
        onPointerCancel={(e) => finishPointer(e, true)}
        onPointerLeave={handlePointerLeave}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        className="block h-full w-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        style={{ cursor: cursorStyle }}
      />

      {/* Floating hover tooltip */}
      {hoverTip && tipPos && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 isolate w-[220px] rounded-lg border border-divider bg-surface-2/95 px-2.5 py-2 shadow-md backdrop-blur-sm"
          /* rtl-ok: canvas pointer coordinates */
          style={{ left: tipPos.left, top: tipPos.top }}
        >
          {isItemMark(hoverTip.node.kind) && <TypeMark mark={hoverTip.node.kind} />}
          <p className="truncate text-compact font-semibold text-pn" dir="auto">
            {hoverTip.node.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={hoverTip.node.kind === 'folderHub' ? 'warning' : hoverTip.node.kind === 'missing' ? 'neutral' : 'info'}>
              {tipFolderLabel ?? kindLabel(hoverTip.node.kind)}
            </Badge>
            <span className="text-meta tabular-nums text-pn-muted">
              {hoverTip.node.kind === 'folderHub'
                ? hoverTip.node.memberCount != null
                  ? t('notes:graph.folderHubHint', { count: hoverTip.node.memberCount })
                  : t('notes:graph.expandFolder')
                : hoverTip.node.kind === 'missing'
                  ? t('notes:graph.missingHint')
                  : formatConn(hoverTip.node.degree)}
            </span>
          </div>
          {hoverTip.node.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {hoverTip.node.tags.slice(0, 4).map((tag) => (
                <Badge key={tag} tone="neutral">
                  #{tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Fallback when 2D canvas context is blocked or unavailable */}
      {canvasUnavailable && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-0/95 p-4">
          <EmptyState
            icon={<Graph weight="duotone" aria-hidden="true" />}
            title={canvasUnavailableLabel ?? ariaLabel}
          />
        </div>
      )}

      {/* Bottom-end zoom controls */}
      <CanvasControlBar orientation="horizontal" className="absolute bottom-3 end-3 z-10 !p-0.5">
        <IconButton label={zoomInLabel} position="above-end" onClick={() => zoomBy(1.22)}>
          <MagnifyingGlassPlus aria-hidden="true" />
        </IconButton>
        <IconButton label={zoomOutLabel} position="above-end" onClick={() => zoomBy(0.82)}>
          <MagnifyingGlassMinus aria-hidden="true" />
        </IconButton>
        <IconButton label={fitLabel} position="above-end" onClick={() => fitGraph(true)}>
          <CornersOut aria-hidden="true" />
        </IconButton>
      </CanvasControlBar>

      {/* Screen-reader accessible summary of visible nodes */}
      <ul className="sr-only" aria-label={ariaLabel}>
        {nodes.slice(0, 120).map((node) => (
          <li key={node.id}>
            {node.title} - {formatConn(node.degree)}
          </li>
        ))}
      </ul>
    </div>
  );
});
