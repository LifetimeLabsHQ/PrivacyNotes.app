/**
 * Named saved views for the Graph workspace (#177 / #902).
 *
 * Stored in the encrypted, synced `UserSettings.graphViews` RegisterMap so view
 * names and search queries never touch plaintext localStorage and views created
 * on desktop travel automatically to mobile. Older builds pass unknown top-level
 * keys through untouched.
 *
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */
import {
  mergeRegisterMaps,
  newRegisterId,
  REGISTER_ID,
  registerMapsEqual,
  stampAfter,
  validateRegisterMap,
  type RegisterMap,
} from './registers';

export type GraphViews = RegisterMap;

type GraphViewColorBy = 'looks' | 'kind' | 'hubs';

export interface GraphViewState {
  searchQuery: string;
  colorBy: GraphViewColorBy;
  showNotes: boolean;
  showJournals: boolean;
  showMissing: boolean;
  showOrphans: boolean;
  showSuggested: boolean;
  showArrows: boolean;
  showAllLabels: boolean;
  collapseFolders: boolean;
  expandedFolderIds: string[];
  focusNodeId: string | null;
  focusDepth: 1 | 2;
  repelStrength: number;
}

export interface SavedGraphView {
  id: string;
  name: string;
  state: GraphViewState;
  at: string;
}

/** Maximum live saved views per account. */
export const GRAPH_VIEW_MAX = 30;
/** Maximum length for a saved view name. */
export const GRAPH_VIEW_NAME_MAX = 60;
/** Maximum length for a saved search query. */
const GRAPH_VIEW_SEARCH_MAX = 200;
/** Maximum expanded folder ids persisted in a single saved view. */
const GRAPH_VIEW_EXPANDED_MAX = 50;
/** Maximum serialized JSON byte budget for one register value. */
const GRAPH_VIEW_JSON_MAX = 2400;
const REPEL_MIN = 40;
const REPEL_MAX = 180;
const REPEL_DEFAULT = 100;
const ID_MAX = 80;

export const DEFAULT_GRAPH_VIEW_STATE: GraphViewState = {
  searchQuery: '',
  colorBy: 'looks',
  showNotes: true,
  showJournals: true,
  showMissing: true,
  showOrphans: true,
  showSuggested: true,
  showArrows: true,
  showAllLabels: false,
  collapseFolders: false,
  expandedFolderIds: [],
  focusNodeId: null,
  focusDepth: 2,
  repelStrength: REPEL_DEFAULT,
};

const isGraphViewKey = (id: string) => REGISTER_ID.test(id);

function clampRepel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return REPEL_DEFAULT;
  return Math.max(REPEL_MIN, Math.min(REPEL_MAX, Math.round(value)));
}

function normalizeColorBy(value: unknown): GraphViewColorBy {
  return value === 'kind' || value === 'hubs' ? value : 'looks';
}

function normalizeIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > ID_MAX || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= GRAPH_VIEW_EXPANDED_MAX) break;
  }
  out.sort();
  return out;
}

function normalizeFocusId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= ID_MAX ? trimmed : null;
}

function normalizeGraphViewState(raw: Partial<GraphViewState> | Record<string, unknown>): GraphViewState {
  const r = raw as Record<string, unknown>;
  const searchRaw = typeof r.searchQuery === 'string' ? r.searchQuery : '';
  return {
    searchQuery: searchRaw.slice(0, GRAPH_VIEW_SEARCH_MAX),
    colorBy: normalizeColorBy(r.colorBy),
    showNotes: typeof r.showNotes === 'boolean' ? r.showNotes : DEFAULT_GRAPH_VIEW_STATE.showNotes,
    showJournals: typeof r.showJournals === 'boolean' ? r.showJournals : DEFAULT_GRAPH_VIEW_STATE.showJournals,
    showMissing: typeof r.showMissing === 'boolean' ? r.showMissing : DEFAULT_GRAPH_VIEW_STATE.showMissing,
    showOrphans: typeof r.showOrphans === 'boolean' ? r.showOrphans : DEFAULT_GRAPH_VIEW_STATE.showOrphans,
    showSuggested: typeof r.showSuggested === 'boolean' ? r.showSuggested : DEFAULT_GRAPH_VIEW_STATE.showSuggested,
    showArrows: typeof r.showArrows === 'boolean' ? r.showArrows : DEFAULT_GRAPH_VIEW_STATE.showArrows,
    showAllLabels: typeof r.showAllLabels === 'boolean' ? r.showAllLabels : DEFAULT_GRAPH_VIEW_STATE.showAllLabels,
    collapseFolders: typeof r.collapseFolders === 'boolean' ? r.collapseFolders : DEFAULT_GRAPH_VIEW_STATE.collapseFolders,
    expandedFolderIds: normalizeIdList(r.expandedFolderIds),
    focusNodeId: normalizeFocusId(r.focusNodeId),
    focusDepth: r.focusDepth === 1 ? 1 : 2,
    repelStrength: clampRepel(r.repelStrength),
  };
}

function parseGraphViewPayload(raw: string): { name: string; state: GraphViewState } | null {
  if (raw.length === 0 || raw.length > GRAPH_VIEW_JSON_MAX) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string') return null;
  const name = obj.name.trim().slice(0, GRAPH_VIEW_NAME_MAX);
  if (!name) return null;
  const stateObj = obj.state && typeof obj.state === 'object' && !Array.isArray(obj.state)
    ? (obj.state as Record<string, unknown>)
    : {};
  return { name, state: normalizeGraphViewState(stateObj) };
}

function serializeGraphViewPayload(name: string, state: GraphViewState): string | null {
  const trimmed = name.trim().slice(0, GRAPH_VIEW_NAME_MAX);
  if (!trimmed) return null;
  const payload = JSON.stringify({ name: trimmed, state: normalizeGraphViewState(state) });
  return payload.length <= GRAPH_VIEW_JSON_MAX ? payload : null;
}

/** Sanitize a raw map from a settings blob. Drops malformed entries cleanly. */
export function validateGraphViews(raw: unknown, now = Date.now()): GraphViews {
  const base = validateRegisterMap(raw, isGraphViewKey, GRAPH_VIEW_JSON_MAX, now);
  const out: GraphViews = {};
  for (const [id, reg] of Object.entries(base)) {
    if (reg.v === null || parseGraphViewPayload(reg.v) !== null) {
      out[id] = reg;
    }
  }
  return out;
}

export function mergeGraphViews(local: GraphViews, remote: GraphViews, now = Date.now()): GraphViews {
  return mergeRegisterMaps(local, remote, now);
}

export const graphViewsEqual = registerMapsEqual;

/** Live (non-deleted) saved views, sorted alphabetically by name. */
export function liveGraphViews(views: GraphViews): SavedGraphView[] {
  const out: SavedGraphView[] = [];
  for (const [id, reg] of Object.entries(views)) {
    if (typeof reg.v !== 'string') continue;
    const parsed = parseGraphViewPayload(reg.v);
    if (!parsed) continue;
    out.push({ id, name: parsed.name, state: parsed.state, at: reg.at });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

/** Whether a new or updated saved view fits within GRAPH_VIEW_MAX. */
export function canSaveGraphView(views: GraphViews, id?: string): boolean {
  if (id && typeof views[id]?.v === 'string') return true;
  return liveGraphViews(views).length < GRAPH_VIEW_MAX;
}

/** A fresh saved graph view id: twelve lower-case letters and digits. */
export function newGraphViewId(): string {
  return newRegisterId();
}

/** Save a new or updated graph view. Returns the updated map and the view id (or null if refused). */
export function saveGraphView(
  views: GraphViews,
  name: string,
  state: GraphViewState,
  id?: string,
): { views: GraphViews; id: string | null } {
  const targetId = id && isGraphViewKey(id) ? id : newRegisterId();
  if (!canSaveGraphView(views, targetId)) return { views, id: null };
  const serialized = serializeGraphViewPayload(name, state);
  if (!serialized) return { views, id: null };
  const prev = views[targetId];
  if (prev?.v === serialized) return { views, id: targetId };
  return {
    views: { ...views, [targetId]: { v: serialized, at: stampAfter(prev?.at) } },
    id: targetId,
  };
}

/** Delete a saved graph view with a synced null tombstone. */
export function deleteGraphView(views: GraphViews, id: string): GraphViews {
  const prev = views[id];
  if (!prev || prev.v === null) return views;
  return { ...views, [id]: { v: null, at: stampAfter(prev.at) } };
}

/** Exact structural comparison of two graph view states (order-insensitive on expandedFolderIds). */
export function graphViewStatesEqual(a: GraphViewState, b: GraphViewState): boolean {
  const na = normalizeGraphViewState(a);
  const nb = normalizeGraphViewState(b);
  if (
    na.searchQuery !== nb.searchQuery ||
    na.colorBy !== nb.colorBy ||
    na.showNotes !== nb.showNotes ||
    na.showJournals !== nb.showJournals ||
    na.showMissing !== nb.showMissing ||
    na.showOrphans !== nb.showOrphans ||
    na.showSuggested !== nb.showSuggested ||
    na.showArrows !== nb.showArrows ||
    na.showAllLabels !== nb.showAllLabels ||
    na.collapseFolders !== nb.collapseFolders ||
    na.focusNodeId !== nb.focusNodeId ||
    na.focusDepth !== nb.focusDepth ||
    na.repelStrength !== nb.repelStrength ||
    na.expandedFolderIds.length !== nb.expandedFolderIds.length
  ) {
    return false;
  }
  for (let i = 0; i < na.expandedFolderIds.length; i++) {
    if (na.expandedFolderIds[i] !== nb.expandedFolderIds[i]) return false;
  }
  return true;
}
