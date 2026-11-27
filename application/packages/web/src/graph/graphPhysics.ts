/**
 * Zero-dependency 2D spatial-grid force simulation for the Graph canvas and
 * local mini-graph (#177).
 *
 * Invariants:
 * - `sync()` reheats only on topology changes (node IDs or edge keys). Attribute
 *   updates preserve positions, velocities, pinned flags, and current alpha.
 * - Spatial-cell grid repulsion (`cellSize = 180`) evaluates exact pairs inside
 *   the 3x3 neighborhood and cell centroids for distant cells, keeping frames
 *   near O(N) on multi-thousand-node vaults.
 * - `step()` returns false once `alpha < 0.005` and no node is dragged so the
 *   caller's animation loop sleeps at 0% CPU.
 *
 * Spec: docs/internal/specs/graph-view.md (section 4.2)
 */

import { fnv1a } from '../noteShortcut';
import type { SavedGraphLayout, SavedNodePosition } from './graphModel';

interface SimNodeInput {
  id: string;
  degree?: number;
  memberCount?: number;
  kind?: string;
  folderId?: string | null;
}

interface SimEdgeInput {
  key: string;
  source: string;
  target: string;
  kind: 'link' | 'smart';
}

interface SimPosition {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
  mass: number;
  sqrtMass: number;
  degree: number;
  folderId: string | null;
}

export interface ForceSimulationOptions {
  repelStrength?: number;
  linkDistance?: number;
  smartDistance?: number;
  centerStrength?: number;
  cellSize?: number;
  damping?: number;
  maxStep?: number;
}

export interface ForceSimulation {
  sync(
    nodes: readonly SimNodeInput[],
    edges: readonly SimEdgeInput[],
    savedLayout?: SavedGraphLayout | null,
  ): void;
  step(): boolean;
  grab(id: string): void;
  drag(id: string, x: number, y: number): void;
  release(id: string, moved: boolean): void;
  unpin(id: string): void;
  setRepel(strength: number): void;
  relayout(): void;
  getPositions(): ReadonlyMap<string, SimPosition>;
  exportPositions(): SavedGraphLayout;
  getAlpha(): number;
}

// Spec: docs/internal/specs/graph-view.md (section 4.2)
const DEFAULT_CELL_SIZE = 180;
const DEFAULT_DAMPING = 0.82;
const DEFAULT_REPEL = 4200;
const DEFAULT_LINK_DISTANCE = 112;
const DEFAULT_SMART_DISTANCE = 176;
const DEFAULT_CENTER_STRENGTH = 0.013;
const DEFAULT_MAX_STEP = 48;

const LINK_SPRING_K = 0.14;
const SMART_SPRING_K = 0.045;
const FOLDER_COHESION_K = 0.008;
const REPULSION_SOFTENING = 440;
const ALPHA_MIN = 0.005;
const ALPHA_DECAY = 0.025;
const RESTORED_ALPHA = 0.08;
const INCREMENTAL_ALPHA = 0.35;
const EXACT_PAIRWISE_LIMIT = 64;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const COORD_CLAMP = 1_000_000;

const FORWARD_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

interface SimEdgeResolved {
  source: SimPosition;
  target: SimPosition;
  kind: 'link' | 'smart';
}

interface GridCell {
  cx: number;
  cy: number;
  bodies: SimPosition[];
  totalSqrtMass: number;
  sumX: number;
  sumY: number;
  meanX: number;
  meanY: number;
}

const hashId = (s: string): number => Number.parseInt(fnv1a(s), 16);

function spiralCoords(index: number): { x: number; y: number } {
  const radius = 28 * Math.sqrt(index + 1);
  const angle = index * GOLDEN_ANGLE;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function massFor(node: SimNodeInput): number {
  const weight = (node.degree ?? 0) + (node.memberCount ?? 0);
  return 1 + Math.min(3, Math.sqrt(Math.max(0, weight)) * 0.35);
}

function cellKey(cx: number, cy: number): number {
  return (cx + 32768) * 65536 + (cy + 32768);
}

function applyPairRepulsion(a: SimPosition, b: SimPosition, repelAlpha: number): void {
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  let distSq = dx * dx + dy * dy;
  if (distSq < 1) {
    // Deterministic separation when two nodes share coordinates.
    const angle = ((hashId(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`) % 3600) / 3600) * Math.PI * 2;
    const sign = a.id < b.id ? 1 : -1;
    dx = Math.cos(angle) * sign;
    dy = Math.sin(angle) * sign;
    distSq = 1;
  }
  const dist = Math.sqrt(distSq);
  const strength = (repelAlpha * a.sqrtMass * b.sqrtMass) / (distSq + REPULSION_SOFTENING);
  const fx = (dx / dist) * strength;
  const fy = (dy / dist) * strength;
  a.vx += fx;
  a.vy += fy;
  b.vx -= fx;
  b.vy -= fy;
}

/**
 * Create a standalone 2D force simulation instance.
 * Spec: docs/internal/specs/graph-view.md (section 4.2)
 */
export function createForceSimulation(options: ForceSimulationOptions = {}): ForceSimulation {
  let repelStrength = options.repelStrength ?? DEFAULT_REPEL;
  const linkDistance = options.linkDistance ?? DEFAULT_LINK_DISTANCE;
  const smartDistance = options.smartDistance ?? DEFAULT_SMART_DISTANCE;
  const centerStrength = options.centerStrength ?? DEFAULT_CENTER_STRENGTH;
  const cellSize = options.cellSize ?? DEFAULT_CELL_SIZE;
  const damping = options.damping ?? DEFAULT_DAMPING;
  const maxStep = options.maxStep ?? DEFAULT_MAX_STEP;

  const bodies = new Map<string, SimPosition>();
  let bodyList: SimPosition[] = [];
  let resolvedEdges: SimEdgeResolved[] = [];
  let edgeKeys = new Set<string>();
  let initialized = false;
  let alpha = 0;
  let draggedId: string | null = null;
  let spiralIndex = 0;

  function rebuildResolvedEdges(edges: readonly SimEdgeInput[]): void {
    resolvedEdges = [];
    edgeKeys = new Set<string>();
    for (const edge of edges) {
      const source = bodies.get(edge.source);
      const target = bodies.get(edge.target);
      if (!source || !target || source === target) continue;
      edgeKeys.add(edge.key);
      resolvedEdges.push({ source, target, kind: edge.kind });
    }
  }

  function sync(
    nodes: readonly SimNodeInput[],
    edges: readonly SimEdgeInput[],
    savedLayout?: SavedGraphLayout | null,
  ): void {
    const incomingNodeIds = new Set<string>();
    for (const n of nodes) incomingNodeIds.add(n.id);

    const nodesUnchanged =
      incomingNodeIds.size === bodies.size &&
      nodes.every((n) => bodies.has(n.id));

    let validEdgeCount = 0;
    let edgesUnchanged = true;
    for (const e of edges) {
      if (e.source === e.target || !incomingNodeIds.has(e.source) || !incomingNodeIds.has(e.target)) continue;
      validEdgeCount += 1;
      if (!edgeKeys.has(e.key)) edgesUnchanged = false;
    }
    if (validEdgeCount !== edgeKeys.size) edgesUnchanged = false;

    // Topology-only reheat: attribute changes leave positions and alpha untouched,
    // except when the caller explicitly unpinned a previously pinned node.
    if (initialized && nodesUnchanged && edgesUnchanged) {
      let unpinnedAny = false;
      for (const n of nodes) {
        const b = bodies.get(n.id);
        if (!b) continue;
        const m = massFor(n);
        b.mass = m;
        b.sqrtMass = Math.sqrt(m);
        b.degree = n.degree ?? 0;
        b.folderId = n.kind === 'folderHub' || n.kind === 'missing' ? null : (n.folderId ?? null);
        const savedPinned = savedLayout?.[n.id]?.pinned;
        if (b.pinned && savedPinned === false) {
          b.pinned = false;
          unpinnedAny = true;
        } else if (!b.pinned && savedPinned === true) {
          b.pinned = true;
          b.vx = 0;
          b.vy = 0;
        }
      }
      if (unpinnedAny) alpha = Math.max(alpha, 0.25);
      return;
    }

    const isInitial = !initialized;

    // Drop removed nodes.
    for (const id of [...bodies.keys()]) {
      if (!incomingNodeIds.has(id)) {
        bodies.delete(id);
        if (draggedId === id) draggedId = null;
      }
    }
    spiralIndex = Math.min(spiralIndex, bodies.size);

    // Build adjacency against surviving nodes so newly added nodes spawn near neighbors.
    const existingNeighbors = new Map<string, SimPosition[]>();
    if (!isInitial) {
      for (const e of edges) {
        if (e.source === e.target) continue;
        const srcBody = bodies.get(e.source);
        const tgtBody = bodies.get(e.target);
        if (srcBody && !tgtBody) {
          let list = existingNeighbors.get(e.target);
          if (!list) {
            list = [];
            existingNeighbors.set(e.target, list);
          }
          list.push(srcBody);
        } else if (tgtBody && !srcBody) {
          let list = existingNeighbors.get(e.source);
          if (!list) {
            list = [];
            existingNeighbors.set(e.source, list);
          }
          list.push(tgtBody);
        }
      }
    }

    let restoredCount = 0;
    for (const n of nodes) {
      const m = massFor(n);
      const deg = n.degree ?? 0;
      const folderId = n.kind === 'folderHub' || n.kind === 'missing' ? null : (n.folderId ?? null);
      const existing = bodies.get(n.id);
      if (existing) {
        existing.mass = m;
        existing.sqrtMass = Math.sqrt(m);
        existing.degree = deg;
        existing.folderId = folderId;
        continue;
      }

      const saved = savedLayout?.[n.id];
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        bodies.set(n.id, {
          id: n.id,
          x: saved.x,
          y: saved.y,
          vx: 0,
          vy: 0,
          pinned: Boolean(saved.pinned),
          mass: m,
          sqrtMass: Math.sqrt(m),
          degree: deg,
          folderId,
        });
        restoredCount += 1;
        continue;
      }

      const neighbors = existingNeighbors.get(n.id);
      let x: number;
      let y: number;
      if (neighbors && neighbors.length > 0) {
        let sx = 0;
        let sy = 0;
        for (const nb of neighbors) {
          sx += nb.x;
          sy += nb.y;
        }
        const angle = ((hashId(n.id) % 3600) / 3600) * Math.PI * 2;
        const dist = 24 + ((hashId(`${n.id}:r`) % 100) / 100) * 20;
        x = sx / neighbors.length + Math.cos(angle) * dist;
        y = sy / neighbors.length + Math.sin(angle) * dist;
      } else {
        const pt = spiralCoords(spiralIndex++);
        x = pt.x;
        y = pt.y;
      }

      bodies.set(n.id, {
        id: n.id,
        x,
        y,
        vx: 0,
        vy: 0,
        pinned: false,
        mass: m,
        sqrtMass: Math.sqrt(m),
        degree: deg,
        folderId,
      });
    }

    bodyList = [...bodies.values()];
    rebuildResolvedEdges(edges);

    if (bodyList.length === 0) {
      alpha = 0;
    } else if (isInitial) {
      alpha = restoredCount >= bodyList.length * 0.5 ? RESTORED_ALPHA : 1.0;
    } else {
      alpha = Math.max(alpha, INCREMENTAL_ALPHA);
    }

    initialized = true;
  }

  function step(): boolean {
    if (bodyList.length === 0) {
      alpha = 0;
      return false;
    }
    if (alpha < ALPHA_MIN && draggedId === null) {
      alpha = 0;
      return false;
    }

    const repelAlpha = repelStrength * alpha;
    const count = bodyList.length;

    // 1. Repulsion: exact pairwise for small graphs, spatial-cell grid for large graphs.
    if (count <= EXACT_PAIRWISE_LIMIT) {
      for (let i = 0; i < count; i++) {
        const a = bodyList[i]!;
        for (let j = i + 1; j < count; j++) {
          applyPairRepulsion(a, bodyList[j]!, repelAlpha);
        }
      }
    } else {
      const activeCellSize = Math.max(cellSize, Math.min(420, Math.sqrt(count) * 12));
      const cells = new Map<number, GridCell>();
      for (let i = 0; i < count; i++) {
        const b = bodyList[i]!;
        const cx = Math.floor(Math.max(-COORD_CLAMP, Math.min(COORD_CLAMP, b.x)) / activeCellSize);
        const cy = Math.floor(Math.max(-COORD_CLAMP, Math.min(COORD_CLAMP, b.y)) / activeCellSize);
        const key = cellKey(cx, cy);
        let cell = cells.get(key);
        if (!cell) {
          cell = { cx, cy, bodies: [], totalSqrtMass: 0, sumX: 0, sumY: 0, meanX: 0, meanY: 0 };
          cells.set(key, cell);
        }
        cell.bodies.push(b);
        cell.totalSqrtMass += b.sqrtMass;
        cell.sumX += b.x * b.sqrtMass;
        cell.sumY += b.y * b.sqrtMass;
      }

      const cellList: GridCell[] = [];
      for (const cell of cells.values()) {
        cell.meanX = cell.sumX / cell.totalSqrtMass;
        cell.meanY = cell.sumY / cell.totalSqrtMass;
        cellList.push(cell);
      }

      // Exact repulsion inside each cell and across its 3x3 neighbor cells.
      for (let ci = 0; ci < cellList.length; ci++) {
        const cell = cellList[ci]!;
        const list = cell.bodies;
        for (let i = 0; i < list.length; i++) {
          const a = list[i]!;
          for (let j = i + 1; j < list.length; j++) {
            applyPairRepulsion(a, list[j]!, repelAlpha);
          }
        }
        // Check forward neighbor offsets only so each adjacent pair is evaluated once.
        for (let oi = 0; oi < FORWARD_OFFSETS.length; oi++) {
          const [ox, oy] = FORWARD_OFFSETS[oi]!;
          const neighbor = cells.get(cellKey(cell.cx + ox, cell.cy + oy));
          if (!neighbor) continue;
          const other = neighbor.bodies;
          for (let i = 0; i < list.length; i++) {
            const a = list[i]!;
            for (let j = 0; j < other.length; j++) {
              applyPairRepulsion(a, other[j]!, repelAlpha);
            }
          }
        }
      }

      // Symmetric cell-centroid far repulsion for cells outside the 3x3 neighborhood.
      const cellFx = new Float64Array(cellList.length);
      const cellFy = new Float64Array(cellList.length);
      for (let i = 0; i < cellList.length; i++) {
        const a = cellList[i]!;
        for (let j = i + 1; j < cellList.length; j++) {
          const b = cellList[j]!;
          if (Math.abs(a.cx - b.cx) <= 1 && Math.abs(a.cy - b.cy) <= 1) continue;
          const dx = a.meanX - b.meanX;
          const dy = a.meanY - b.meanY;
          const distSq = dx * dx + dy * dy;
          if (distSq < 1) continue;
          const dist = Math.sqrt(distSq);
          const base = repelAlpha / (distSq + REPULSION_SOFTENING);
          const ux = (dx / dist) * base;
          const uy = (dy / dist) * base;
          cellFx[i] = cellFx[i]! + ux * b.totalSqrtMass;
          cellFy[i] = cellFy[i]! + uy * b.totalSqrtMass;
          cellFx[j] = cellFx[j]! - ux * a.totalSqrtMass;
          cellFy[j] = cellFy[j]! - uy * a.totalSqrtMass;
        }
      }
      for (let i = 0; i < cellList.length; i++) {
        const fx = cellFx[i]!;
        const fy = cellFy[i]!;
        if (fx === 0 && fy === 0) continue;
        const list = cellList[i]!.bodies;
        for (let k = 0; k < list.length; k++) {
          const body = list[k]!;
          body.vx += fx * body.sqrtMass;
          body.vy += fy * body.sqrtMass;
        }
      }
    }

    // 2. Spring attraction along edges (degree-scaled distance & stiffness prevents hub hairballs).
    for (let i = 0; i < resolvedEdges.length; i++) {
      const edge = resolvedEdges[i]!;
      const a = edge.source;
      const b = edge.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const degBoost = Math.min(72, Math.sqrt(a.degree + b.degree) * 10);
      const ideal = (edge.kind === 'link' ? linkDistance : smartDistance) + degBoost;
      const minDeg = Math.max(1, Math.min(a.degree, b.degree));
      const k = ((edge.kind === 'link' ? LINK_SPRING_K : SMART_SPRING_K) / Math.sqrt(minDeg)) * alpha;
      const pull = (dist - ideal) * k;
      const fx = (dx / dist) * pull;
      const fy = (dy / dist) * pull;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // 2b. Gentle intra-folder centroid cohesion so notes in the same folder naturally cluster.
    const folderSums = new Map<string, { sx: number; sy: number; count: number }>();
    for (let i = 0; i < count; i++) {
      const b = bodyList[i]!;
      if (!b.folderId) continue;
      let slot = folderSums.get(b.folderId);
      if (!slot) {
        slot = { sx: 0, sy: 0, count: 0 };
        folderSums.set(b.folderId, slot);
      }
      slot.sx += b.x;
      slot.sy += b.y;
      slot.count += 1;
    }
    if (folderSums.size > 0) {
      const cohesion = FOLDER_COHESION_K * alpha;
      for (let i = 0; i < count; i++) {
        const b = bodyList[i]!;
        if (!b.folderId || b.pinned || b.id === draggedId) continue;
        const slot = folderSums.get(b.folderId);
        if (!slot || slot.count < 2) continue;
        const cx = slot.sx / slot.count;
        const cy = slot.sy / slot.count;
        b.vx += (cx - b.x) * cohesion;
        b.vy += (cy - b.y) * cohesion;
      }
    }

    // 3. Centering gravity (slightly firmer on unconnected orphans), velocity damping, clamp, integrate.
    const gravity = centerStrength * alpha;
    const orphanGravity = gravity * 1.45;
    for (let i = 0; i < count; i++) {
      const b = bodyList[i]!;
      if (b.pinned || b.id === draggedId) {
        b.vx = 0;
        b.vy = 0;
        continue;
      }
      const g = b.degree === 0 ? orphanGravity : gravity;
      b.vx = (b.vx - b.x * g) * damping;
      b.vy = (b.vy - b.y * g) * damping;
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > maxStep) {
        const scale = maxStep / speed;
        b.vx *= scale;
        b.vy *= scale;
      }
      b.x += b.vx;
      b.y += b.vy;
    }

    if (draggedId !== null) {
      alpha = Math.max(alpha, 0.12);
      return true;
    }

    alpha *= 1 - ALPHA_DECAY;
    if (alpha < ALPHA_MIN) {
      alpha = 0;
      return false;
    }
    return true;
  }

  function grab(id: string): void {
    const body = bodies.get(id);
    if (!body) return;
    draggedId = id;
    body.vx = 0;
    body.vy = 0;
    alpha = Math.max(alpha, 0.25);
  }

  function drag(id: string, x: number, y: number): void {
    const body = bodies.get(id);
    if (!body || !Number.isFinite(x) || !Number.isFinite(y)) return;
    body.x = x;
    body.y = y;
    body.vx = 0;
    body.vy = 0;
    alpha = Math.max(alpha, 0.18);
  }

  function release(id: string, moved: boolean): void {
    if (draggedId === id) draggedId = null;
    const body = bodies.get(id);
    if (!body) return;
    if (moved) {
      body.pinned = true;
      body.vx = 0;
      body.vy = 0;
    }
  }

  function unpin(id: string): void {
    const body = bodies.get(id);
    if (!body) return;
    body.pinned = false;
    alpha = Math.max(alpha, 0.25);
  }

  function setRepel(strength: number): void {
    if (!Number.isFinite(strength) || strength <= 0 || strength === repelStrength) return;
    repelStrength = strength;
    alpha = Math.max(alpha, 0.35);
  }

  function relayout(): void {
    draggedId = null;
    spiralIndex = 0;
    for (let i = 0; i < bodyList.length; i++) {
      const b = bodyList[i]!;
      const pt = spiralCoords(spiralIndex++);
      b.x = pt.x;
      b.y = pt.y;
      b.vx = 0;
      b.vy = 0;
      b.pinned = false;
    }
    alpha = bodyList.length > 0 ? 1.0 : 0;
  }

  function getPositions(): ReadonlyMap<string, SimPosition> {
    return bodies;
  }

  function exportPositions(): SavedGraphLayout {
    const out: SavedGraphLayout = {};
    for (const [id, b] of bodies) {
      out[id] = { x: Math.round(b.x), y: Math.round(b.y), pinned: b.pinned } satisfies SavedNodePosition;
    }
    return out;
  }

  function getAlpha(): number {
    return alpha;
  }

  return {
    sync,
    step,
    grab,
    drag,
    release,
    unpin,
    setRepel,
    relayout,
    getPositions,
    exportPositions,
    getAlpha,
  };
}
