import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsOutSimple, PushPin } from '../icons';
import { isLookColor, type LookColor } from '../itemStyles';
import { Badge, CanvasControlBar, IconButton, SettingsSegmented } from '../ui';
import { resolveGraphThemePalette, type CanvasNodeKind } from './GraphCanvas';

// Spec: docs/internal/specs/graph-view.md (section 4.5)

interface LocalGraphNode {
  id: string;
  title: string;
  kind: CanvasNodeKind;
  colorKey: LookColor | null;
  degree?: number;
}

interface LocalGraphEdge {
  key: string;
  source: string;
  target: string;
  kind: 'link' | 'smart';
}

interface LocalGraphLabels {
  hop1: string;
  hop2: string;
  depthLabel?: string;
  pin: string;
  unpin?: string;
  pinnedTo?: (title: string) => string;
  fullGraph: string;
  empty?: string;
  ariaLabel?: string;
}

export interface LocalGraphCardProps {
  centerId: string;
  centerTitle: string;
  nodes: readonly LocalGraphNode[];
  edges: readonly LocalGraphEdge[];
  depth: 1 | 2;
  onDepthChange: (depth: 1 | 2) => void;
  pinned: boolean;
  pinnedTitle: string | null;
  onTogglePin: () => void;
  onOpenFullGraph: () => void;
  onSelectNeighbor: (id: string) => void;
  dark: boolean;
  labels: LocalGraphLabels;
}

interface PlacedMiniNode {
  node: LocalGraphNode;
  x: number;
  y: number;
  r: number;
  hop: 0 | 1 | 2;
  role: 'center' | 'in' | 'out' | 'smart' | 'hop2';
}

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';

function shortLabel(title: string, max = 16): string {
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1)}…`;
}

function distributeArc(
  count: number,
  startAngle: number,
  endAngle: number,
): number[] {
  if (count <= 0) return [];
  if (count === 1) return [(startAngle + endAngle) / 2];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(startAngle + ((endAngle - startAngle) * i) / (count - 1));
  }
  return out;
}

/**
 * Deterministic radial + gentle collision-avoidance layout centered on centerId:
 * incoming on the start side, outgoing on the end side, suggested along the
 * lower arc, and 2-hop outer ring when depth === 2.
 */
const MAX_HOP1 = 12;
const MAX_HOP2 = 16;

function layoutMiniGraph(
  centerId: string,
  centerTitle: string,
  nodes: readonly LocalGraphNode[],
  edges: readonly LocalGraphEdge[],
  depth: 1 | 2,
  width: number,
  height: number,
  rtl: boolean,
  pinned: boolean,
): PlacedMiniNode[] {
  const byId = new Map<string, LocalGraphNode>();
  for (const n of nodes) byId.set(n.id, n);

  const centerNode: LocalGraphNode = byId.get(centerId) ?? {
    id: centerId,
    title: centerTitle,
    kind: 'note',
    colorKey: null,
  };

  const cx = width / 2;
  // Center slightly below vertical midpoint to leave breathing room for top controls
  const cy = height * (pinned ? 0.54 : 0.56);

  const inRaw: string[] = [];
  const outRaw: string[] = [];
  const smartRaw: string[] = [];
  const hop1Seen = new Set<string>();

  for (const e of edges) {
    if (e.source === centerId && e.target !== centerId && byId.has(e.target)) {
      if (hop1Seen.has(e.target)) continue;
      hop1Seen.add(e.target);
      if (e.kind === 'smart') smartRaw.push(e.target);
      else outRaw.push(e.target);
    } else if (e.target === centerId && e.source !== centerId && byId.has(e.source)) {
      if (hop1Seen.has(e.source)) continue;
      hop1Seen.add(e.source);
      if (e.kind === 'smart') smartRaw.push(e.source);
      else inRaw.push(e.source);
    }
  }

  // Cap 1-hop neighbors by degree so high-degree hubs stay legible inside the mini card.
  const byDegDesc = (a: string, b: string) => (byId.get(b)?.degree ?? 0) - (byId.get(a)?.degree ?? 0);
  inRaw.sort(byDegDesc);
  outRaw.sort(byDegDesc);
  smartRaw.sort(byDegDesc);

  const inIds: string[] = [];
  const outIds: string[] = [];
  const smartIds: string[] = [];
  const hop1Set = new Set<string>();
  const buckets = [
    { src: outRaw, dst: outIds },
    { src: inRaw, dst: inIds },
    { src: smartRaw, dst: smartIds },
  ];
  let hop1Count = 0;
  let round = 0;
  while (hop1Count < MAX_HOP1) {
    let added = false;
    for (const b of buckets) {
      if (hop1Count >= MAX_HOP1) break;
      const id = b.src[round];
      if (id !== undefined) {
        b.dst.push(id);
        hop1Set.add(id);
        hop1Count += 1;
        added = true;
      }
    }
    if (!added) break;
    round += 1;
  }

  const placed: PlacedMiniNode[] = [
    { node: centerNode, x: cx, y: cy, r: 8.5, hop: 0, role: 'center' },
  ];
  const byPlaced = new Map<string, PlacedMiniNode>([[centerId, placed[0]!]]);

  const rx1 = Math.max(44, Math.min(width * 0.3, depth === 2 ? width * 0.25 : width * 0.31));
  const ry1 = Math.max(26, Math.min(height * 0.28, depth === 2 ? height * 0.23 : height * 0.27));

  // Incoming on start side (left in LTR, right in RTL), outgoing on end side
  const inAngles = rtl
    ? distributeArc(inIds.length, -Math.PI * 0.34, Math.PI * 0.34)
    : distributeArc(inIds.length, Math.PI * 0.66, Math.PI * 1.34);
  const outAngles = rtl
    ? distributeArc(outIds.length, Math.PI * 0.66, Math.PI * 1.34)
    : distributeArc(outIds.length, -Math.PI * 0.34, Math.PI * 0.34);
  const smartAngles = distributeArc(smartIds.length, Math.PI * 0.34, Math.PI * 0.66);

  const placeRing = (ids: string[], angles: number[], role: 'in' | 'out' | 'smart') => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const node = byId.get(id);
      if (!node) continue;
      const ang = angles[i] ?? 0;
      const item: PlacedMiniNode = {
        node,
        x: cx + Math.cos(ang) * rx1,
        y: cy + Math.sin(ang) * ry1,
        r: node.kind === 'missing' ? 5.5 : 6,
        hop: 1,
        role,
      };
      placed.push(item);
      byPlaced.set(id, item);
    }
  };

  placeRing(inIds, inAngles, 'in');
  placeRing(outIds, outAngles, 'out');
  placeRing(smartIds, smartAngles, 'smart');

  // 2-hop outer ring (capped by degree so 2-hop hubs never turn into a blob)
  if (depth === 2) {
    const hop2Candidates: Array<{ parentId: string; childId: string; degree: number }> = [];
    const seenHop2 = new Set<string>();
    for (const e of edges) {
      let parentId: string | null = null;
      let childId: string | null = null;
      if (hop1Set.has(e.source) && e.target !== centerId && !hop1Set.has(e.target) && byId.has(e.target)) {
        parentId = e.source;
        childId = e.target;
      } else if (hop1Set.has(e.target) && e.source !== centerId && !hop1Set.has(e.source) && byId.has(e.source)) {
        parentId = e.target;
        childId = e.source;
      }
      if (!parentId || !childId || seenHop2.has(childId)) continue;
      seenHop2.add(childId);
      hop2Candidates.push({ parentId, childId, degree: byId.get(childId)?.degree ?? 0 });
    }
    hop2Candidates.sort((a, b) => b.degree - a.degree);

    const hop2ByParent = new Map<string, string[]>();
    for (const c of hop2Candidates.slice(0, MAX_HOP2)) {
      let list = hop2ByParent.get(c.parentId);
      if (!list) { list = []; hop2ByParent.set(c.parentId, list); }
      list.push(c.childId);
    }

    const rx2 = Math.min(width * 0.43, rx1 + 42);
    const ry2 = Math.min(height * 0.36, ry1 + 22);
    hop2ByParent.forEach((children, parentId) => {
      const parent = byPlaced.get(parentId);
      if (!parent) return;
      const baseAngle = Math.atan2(parent.y - cy, parent.x - cx);
      const spread = Math.min(0.65, 0.28 * (children.length - 1));
      const angles = distributeArc(children.length, baseAngle - spread / 2, baseAngle + spread / 2);
      for (let i = 0; i < children.length; i++) {
        const cid = children[i]!;
        const node = byId.get(cid);
        if (!node) continue;
        const ang = angles[i] ?? baseAngle;
        const item: PlacedMiniNode = {
          node,
          x: cx + Math.cos(ang) * rx2,
          y: cy + Math.sin(ang) * ry2,
          r: 4.5,
          hop: 2,
          role: 'hop2',
        };
        placed.push(item);
        byPlaced.set(cid, item);
      }
    });
  }

  // Soft collision separation (including immovable center anchor i=0), clamped inside card bounds
  const padX = 24;
  const padTop = 44;
  const padBottom = pinned ? 34 : 24;
  for (let iter = 0; iter < 16; iter++) {
    for (let i = 0; i < placed.length; i++) {
      const a = placed[i]!;
      for (let j = i + 1; j < placed.length; j++) {
        const b = placed[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.1;
        const minGap = a.r + b.r + 14;
        if (dist < minGap) {
          const push = (minGap - dist) * 0.35;
          const ux = dx / dist;
          const uy = dy / dist;
          if (i === 0) {
            b.x += ux * push * 2;
            b.y += uy * push * 2;
          } else {
            a.x -= ux * push;
            a.y -= uy * push;
            b.x += ux * push;
            b.y += uy * push;
          }
        }
      }
      if (i > 0) {
        a.x = Math.max(padX, Math.min(width - padX, a.x));
        a.y = Math.max(padTop, Math.min(height - padBottom, a.y));
      }
    }
  }

  return placed;
}

export function LocalGraphCard({
  centerId,
  centerTitle,
  nodes,
  edges,
  depth,
  onDepthChange,
  pinned,
  pinnedTitle,
  onTogglePin,
  onOpenFullGraph,
  onSelectNeighbor,
  dark,
  labels,
}: LocalGraphCardProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 260, height: 156 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isRtl, setIsRtl] = useState(false);

  // Track container dimensions + RTL direction
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setSize((prev) =>
          Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5
            ? prev
            : { width: r.width, height: r.height },
        );
      }
      setIsRtl(getComputedStyle(el).direction === 'rtl');
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const paletteRef = useRef<ReturnType<typeof resolveGraphThemePalette> | null>(null);
  useEffect(() => {
    paletteRef.current = resolveGraphThemePalette(containerRef.current, dark);
  }, [dark]);
  useEffect(() => {
    setHoveredId(null);
  }, [centerId]);

  const placed = useMemo(
    () => layoutMiniGraph(centerId, centerTitle, nodes, edges, depth, size.width, size.height, isRtl, pinned),
    [centerId, centerTitle, nodes, edges, depth, size.width, size.height, isRtl, pinned],
  );

  const placedById = useMemo(() => {
    const m = new Map<string, PlacedMiniNode>();
    for (const p of placed) m.set(p.node.id, p);
    return m;
  }, [placed]);

  // Draw crisp HiDPI mini-graph whenever layout, hover, or theme changes
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const palette = paletteRef.current ?? resolveGraphThemePalette(container, dark);
    paletteRef.current = palette;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = size;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const hasHover = hoveredId !== null && placedById.has(hoveredId);
    const hoverNeighbors = new Set<string>();
    if (hasHover && hoveredId) {
      hoverNeighbors.add(hoveredId);
      for (const e of edges) {
        if (e.source === hoveredId) hoverNeighbors.add(e.target);
        else if (e.target === hoveredId) hoverNeighbors.add(e.source);
      }
    }

    // Detect bidirectional pairs so reciprocal links curve gently apart instead of overwriting each other
    const edgeDirs = new Set<string>();
    for (const e of edges) edgeDirs.add(`${e.source}->${e.target}`);

    // 1. Edges
    for (const e of edges) {
      const a = placedById.get(e.source);
      const b = placedById.get(e.target);
      if (!a || !b) continue;
      const isCenterEdge = e.source === centerId || e.target === centerId;
      const isHoverEdge = hasHover && (e.source === hoveredId || e.target === hoveredId);
      const isBi = e.kind === 'link' && edgeDirs.has(`${e.target}->${e.source}`);

      ctx.save();
      ctx.beginPath();
      if (e.kind === 'smart') {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = palette.success;
        ctx.lineWidth = isHoverEdge ? 2 : 1.4;
      } else if (isCenterEdge) {
        const isIncoming = e.target === centerId;
        ctx.strokeStyle = isIncoming ? palette.warning : palette.accent;
        if (a.node.kind === 'missing' || b.node.kind === 'missing') {
          ctx.setLineDash([3, 2]);
        }
        ctx.lineWidth = isHoverEdge ? 2 : 1.5;
      } else {
        ctx.strokeStyle = palette.divider;
        ctx.lineWidth = isHoverEdge ? 1.6 : 1;
      }
      ctx.globalAlpha = hasHover ? (isHoverEdge ? 0.98 : 0.2) : isCenterEdge ? 0.85 : 0.55;
      ctx.moveTo(a.x, a.y);
      if (isBi) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const mx = (a.x + b.x) / 2 - (dy / len) * 6;
        const my = (a.y + b.y) / 2 + (dx / len) * 6;
        ctx.quadraticCurveTo(mx, my, b.x, b.y);
      } else {
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 2. Nodes (draw all dots first, then collision-free labels on top)
    const labelQueue: Array<{ item: PlacedMiniNode; isCenter: boolean; isHovered: boolean; inHoverSet: boolean }> = [];
    for (const item of placed) {
      const { node, x, y, r, hop, role } = item;
      const isCenter = hop === 0;
      const isHovered = node.id === hoveredId;
      const inHoverSet = !hasHover || hoverNeighbors.has(node.id);

      let fill: string;
      if (node.kind === 'missing') {
        fill = palette.muted;
      } else if (role === 'smart') {
        fill = palette.success;
      } else if (role === 'in') {
        fill = palette.warning;
      } else if (role === 'out' || isCenter) {
        fill = node.colorKey && isLookColor(node.colorKey) ? palette.labels[node.colorKey] : palette.accent;
      } else {
        fill = node.colorKey && isLookColor(node.colorKey) ? palette.labels[node.colorKey] : palette.accent;
      }

      ctx.save();
      ctx.globalAlpha = inHoverSet ? 1 : 0.25;

      // Center / hovered soft halo
      if (isCenter || isHovered) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4.5, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.globalAlpha = inHoverSet ? 0.22 : 0.08;
        ctx.fill();
        ctx.globalAlpha = inHoverSet ? 1 : 0.25;
      }

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (node.kind === 'missing') {
        ctx.fillStyle = palette.surface;
        ctx.fill();
        ctx.setLineDash([2.5, 2]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = palette.muted;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = fill;
        ctx.fill();
        if (isCenter || isHovered) {
          ctx.lineWidth = 1.8;
          ctx.strokeStyle = palette.ringWhite;
          ctx.stroke();
        }
      }
      ctx.restore();

      const showLabel =
        isCenter ||
        isHovered ||
        (hop === 1 && placed.length <= 12 && inHoverSet);
      if (showLabel) {
        labelQueue.push({ item, isCenter, isHovered, inHoverSet });
      }
    }

    // Draw prioritized labels (hovered -> center -> 1-hop) with collision avoidance & edge clamping
    labelQueue.sort((a, b) => Number(b.isHovered) - Number(a.isHovered) || Number(b.isCenter) - Number(a.isCenter));
    const labelBoxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    for (const entry of labelQueue) {
      const { item, isCenter, isHovered, inHoverSet } = entry;
      const { node, x, y, r, role } = item;
      ctx.save();
      ctx.globalAlpha = inHoverSet ? 1 : 0.25;
      ctx.font = `${isCenter || isHovered ? 600 : 500} ${isCenter ? 10.5 : 9.5}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const text = shortLabel(node.title, isHovered ? 24 : 15);
      const halfW = ctx.measureText(text).width / 2 + 4;
      const lx = Math.max(halfW + 4, Math.min(width - halfW - 4, x));
      const ly = Math.min(height - (pinned ? 22 : 6), y + r + 11.5);
      const box = { x0: lx - halfW, y0: ly - 10, x1: lx + halfW, y1: ly + 2 };
      if (!isHovered && !isCenter) {
        const hits = labelBoxes.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0);
        if (hits) {
          ctx.restore();
          continue;
        }
      }
      labelBoxes.push(box);
      ctx.lineWidth = 2.6;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = palette.surface;
      ctx.strokeText(text, lx, ly);
      ctx.fillStyle =
        node.kind === 'missing'
          ? palette.muted
          : role === 'smart'
            ? palette.success
            : isCenter
              ? palette.text
              : palette.soft;
      ctx.fillText(text, lx, ly);
      ctx.restore();
    }
  }, [placed, placedById, edges, centerId, hoveredId, size, dark, pinned]);

  const hitAt = useCallback((sx: number, sy: number): PlacedMiniNode | null => {
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i]!;
      const hitR = p.r + 6;
      const dx = sx - p.x;
      const dy = sy - p.y;
      if (dx * dx + dy * dy <= hitR * hitR) return p;
    }
    return null;
  }, [placed]);

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = hitAt(e.clientX - rect.left, e.clientY - rect.top);
    setHoveredId(hit ? hit.node.id : null);
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = hitAt(e.clientX - rect.left, e.clientY - rect.top);
    if (hit && hit.node.id !== centerId && hit.node.kind !== 'missing') {
      onSelectNeighbor(hit.node.id);
    }
  };

  const depthOptions = useMemo(
    () => [
      { value: '1' as const, label: labels.hop1 },
      { value: '2' as const, label: labels.hop2 },
    ],
    [labels.hop1, labels.hop2],
  );

  const neighbors = useMemo(() => placed.filter((p) => p.hop > 0), [placed]);
  const hoveredPlaced = hoveredId ? placedById.get(hoveredId) : null;
  const isHoveringNeighbor = Boolean(hoveredPlaced && hoveredPlaced.node.id !== centerId && hoveredPlaced.node.kind !== 'missing');

  return (
    <div
      ref={containerRef}
      className="relative mb-2 h-[156px] w-full overflow-hidden rounded-lg border border-divider bg-surface-1 select-none"
      style={{
        backgroundImage: dark
          ? 'radial-gradient(rgb(var(--pn-text) / 0.055) 1px, transparent 1px)'
          : 'radial-gradient(rgb(var(--pn-text) / 0.07) 1px, transparent 1px)',
        backgroundSize: '16px 16px',
      }}
    >
      {/* Top overlay bar */}
      <div className="pointer-events-none absolute inset-x-1.5 top-1.5 z-10 flex items-center justify-between gap-1">
        <div className="pointer-events-auto">
          <SettingsSegmented
            value={depth === 1 ? '1' : '2'}
            options={depthOptions}
            onChange={(v) => onDepthChange(v === '1' ? 1 : 2)}
            label={labels.depthLabel ?? labels.hop1}
            className="border border-divider/80 shadow-sm"
          />
        </div>
        <CanvasControlBar orientation="horizontal" className="pointer-events-auto !p-0.5">
          <IconButton
            label={pinned ? (labels.unpin ?? labels.pin) : labels.pin}
            tone={pinned ? 'accent' : 'quiet'}
            aria-pressed={pinned}
            position="below-end"
            className={pinned ? 'bg-accent/12' : ''}
            onClick={onTogglePin}
          >
            <PushPin weight={pinned ? 'fill' : 'bold'} aria-hidden="true" />
          </IconButton>
          <IconButton
            label={labels.fullGraph}
            position="below-end"
            onClick={onOpenFullGraph}
          >
            <ArrowsOutSimple aria-hidden="true" />
          </IconButton>
        </CanvasControlBar>
      </div>

      {/* Interactive HiDPI mini-graph canvas */}
      <canvas
        ref={canvasRef}
        aria-label={labels.ariaLabel ?? centerTitle}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoveredId(null)}
        onClick={handleClick}
        className={`block h-full w-full ${isHoveringNeighbor ? 'cursor-pointer' : 'cursor-default'}`}
      />

      {/* Empty state caption when no neighbors exist */}
      {neighbors.length === 0 && labels.empty && (
        <p className="pointer-events-none absolute inset-x-3 bottom-2 text-center text-meta text-pn-muted">
          {labels.empty}
        </p>
      )}

      {/* Pinned center indicator */}
      {pinned && pinnedTitle && (
        <div className="pointer-events-none absolute bottom-1.5 start-1.5 z-10 max-w-[calc(100%-0.75rem)]">
          <Badge tone="info" icon={<PushPin weight="fill" aria-hidden="true" />}>
            <span className="truncate" dir="auto">
              {labels.pinnedTo ? labels.pinnedTo(pinnedTitle) : pinnedTitle}
            </span>
          </Badge>
        </div>
      )}

      {/* Keyboard / screen-reader accessible neighbor list */}
      {neighbors.length > 0 && (
        <ul className="sr-only" aria-label={labels.ariaLabel ?? centerTitle}>
          {neighbors.map(({ node }) => (
            <li key={node.id}>
              <button type="button" onClick={() => onSelectNeighbor(node.id)}>
                {node.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
