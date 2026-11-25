/**
 * Pure data models, privacy filtering, contact town matching, layout storage,
 * and markdown footnote-link helper for the Graph and Places workspace (#177).
 *
 * Every function here is pure (apart from the bounded localStorage layout store)
 * and makes zero network or database calls.
 *
 * Spec: docs/internal/specs/graph-view.md (sections 3, 4.1)
 */

import type { LocalNote } from '../db';
import type { LinkIndex } from '../connectionsIndex';
import type { RelatedWhy } from '../ConnectionsPanel';
import {
  contactInitialsFor,
  formatAddressLines,
  isAddressEmpty,
  parseContactBody,
  type ContactAddress,
} from '../contactBody';
import { isDemoMode } from '../demo';
import { hiddenPairs } from '../dismissedSuggestions';
import type { FolderDef } from '../folders';
import { folderColor, resolveNoteLook, type ItemStyles, type LookColor } from '../itemStyles';
import { nextFence, type Fence } from '../markdownFence';
import {
  noteLinkKey,
  noteLinkTarget,
  noteLinkTargets,
  parseNoteLinkTarget,
  SUGGESTED_LINK_MARKER,
} from '../noteLinks';
import { readLocation, type NoteLocation } from '../noteLocation';
import { deriveDisplayTitle, deriveExcerpt, editedAtOf, hasStructuredBody } from '../notesViewUtils';
import type { PlaceRow } from '../placeSearch';
import { isRelatedSource, relatedModule, suggestionPairKey } from '../relatedLoader';
import type { RelatedReason } from '../relatedNotes';
import { foldForMatch, textMatcher } from '../textMatch';

// ------------------------------------------------------------------
// Graph types
// ------------------------------------------------------------------

export type GraphNodeKind =
  | 'note'
  | 'journal'
  | 'task'
  | 'contact'
  | 'link'
  | 'file'
  | 'drawing'
  | 'event'
  | 'missing'
  | 'folderHub';

export type GraphColorBy = 'looks' | 'kind' | 'hubs';

export interface GraphFilters {
  searchQuery: string;
  colorBy: GraphColorBy;
  showNotes: boolean;
  showJournals: boolean;
  showMissing: boolean;
  showOrphans: boolean;
  showSuggested: boolean;
  collapseFolders: boolean;
  expandedFolderIds: ReadonlySet<string>;
  focusNodeId: string | null;
  focusDepth: 1 | 2;
  maxCreatedAt: number | null;
}

/** Structured suggestion reason before i18n formatting in the UI. */
export type RelatedWhyData =
  | { kind: 'words'; words: string[] }
  | { kind: 'linksTo'; viaId: string; viaTitle: string }
  | { kind: 'linkedFrom'; viaId: string; viaTitle: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'meaning' };

export interface GraphNode {
  id: string;
  noteId?: string;
  folderId?: string | null;
  title: string;
  kind: GraphNodeKind;
  colorKey: LookColor | null;
  tags: readonly string[];
  createdAt: number;
  degree: number;
  inCount: number;
  outCount: number;
  memberCount?: number;
  hasPlace: boolean;
  snippet: string;
}

export interface GraphEdge {
  key: string;
  source: string;
  target: string;
  kind: 'link' | 'smart';
  why?: RelatedWhyData | RelatedWhy;
}

export interface SuggestedEdge {
  key: string;
  sourceId: string;
  targetId: string;
  why: RelatedWhyData;
}

interface SuggestedPair {
  key: string;
  sourceId: string;
  targetId: string;
  sourceTitle: string;
  targetTitle: string;
  why: RelatedWhyData;
}

interface MissingTarget {
  id: string;
  name: string;
  referrerIds: string[];
  referrerCount: number;
}

interface GraphInbox {
  suggested: SuggestedPair[];
  missing: MissingTarget[];
  orphans: GraphNode[];
  hubs: GraphNode[];
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  inbox: GraphInbox;
  protectedHiddenCount: number;
  timeRange: { min: number; max: number } | null;
}

export interface BuildGraphInput {
  notes: readonly LocalNote[];
  linkIndex: LinkIndex;
  isNoteLocked: (note: LocalNote) => boolean;
  itemStyles: ItemStyles;
  folders: readonly FolderDef[];
  suggestedEdges?: readonly SuggestedEdge[];
  filters: GraphFilters;
}

export interface LocalRelatedEntry {
  note: LocalNote;
  why: RelatedWhy | RelatedWhyData;
}

export type MeaningHitsFn = (
  note: Pick<LocalNote, 'id' | 'title' | 'body'>,
  skip: (id: string) => boolean,
  limit: number,
) => string[];

// ------------------------------------------------------------------
// Places types
// ------------------------------------------------------------------

type PlacePinKind = 'note' | 'journal' | 'contact';

export interface PlacedItem {
  id: string;
  note: LocalNote;
  title: string;
  kind: PlacePinKind;
  location: NoteLocation;
  exact: boolean;
  addressSummary?: string;
  initials?: string;
  colorKey: LookColor | null;
}

export interface UnplacedContact {
  id: string;
  note: LocalNote;
  title: string;
  addressSummary: string;
}

export interface PlacesFilterState {
  showNotes: boolean;
  showJournals: boolean;
  showContacts: boolean;
  searchQuery: string;
}

// ------------------------------------------------------------------
// Saved layout types and storage
// ------------------------------------------------------------------

export interface SavedNodePosition {
  x: number;
  y: number;
  pinned: boolean;
}

export type SavedGraphLayout = Record<string, SavedNodePosition>;

// Spec: docs/internal/specs/graph-view.md (section 3)
export const GRAPH_LAYOUT_STORAGE_KEY = 'privacynotes.graph.layout';
// Spec: docs/internal/specs/graph-view.md (section 3)
const MAX_SAVED_LAYOUT_ENTRIES = 3000;
// Spec: docs/internal/specs/graph-view.md (section 3)
const LAYOUT_UUID_KEY_RE = /^[0-9a-f]{8}-[0-9a-f-]{9,60}$/i;

function activeLayoutStorageKey(): string {
  return isDemoMode() ? `${GRAPH_LAYOUT_STORAGE_KEY}.demo` : GRAPH_LAYOUT_STORAGE_KEY;
}

/** Read device-local saved graph positions. Only opaque UUID keys survive. */
export function readSavedGraphLayout(): SavedGraphLayout {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(activeLayoutStorageKey());
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: SavedGraphLayout = {};
  let count = 0;
  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (count >= MAX_SAVED_LAYOUT_ENTRIES) break;
    if (!LAYOUT_UUID_KEY_RE.test(id)) continue;
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const x = entry[0];
    const y = entry[1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[id] = { x: Math.round(x), y: Math.round(y), pinned: entry[2] === 1 || entry[2] === true };
    count += 1;
  }
  return out;
}

/**
 * Persist device-local graph node positions. Synthetic keys (missing:*, folder:*)
 * and non-UUID keys are stripped so no titles or folder names ever enter storage.
 * Pinned entries are kept ahead of unpinned entries when the 3,000-entry cap applies.
 */
export function writeSavedGraphLayout(
  positions:
    | Readonly<Record<string, { x: number; y: number; pinned?: boolean }>>
    | ReadonlyMap<string, { x: number; y: number; pinned?: boolean }>,
): void {
  const entries = positions instanceof Map ? [...positions.entries()] : Object.entries(positions);
  const pinnedList: Array<[string, [number, number, 1]]> = [];
  const freeList: Array<[string, [number, number, 0]]> = [];
  for (const [id, pos] of entries) {
    if (!LAYOUT_UUID_KEY_RE.test(id)) continue;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
    if (pos.pinned) {
      pinnedList.push([id, [Math.round(pos.x), Math.round(pos.y), 1]]);
    } else {
      freeList.push([id, [Math.round(pos.x), Math.round(pos.y), 0]]);
    }
  }
  const packed: Record<string, [number, number, 0 | 1]> = {};
  let count = 0;
  for (const [id, tuple] of pinnedList) {
    if (count >= MAX_SAVED_LAYOUT_ENTRIES) break;
    packed[id] = tuple;
    count += 1;
  }
  for (const [id, tuple] of freeList) {
    if (count >= MAX_SAVED_LAYOUT_ENTRIES) break;
    packed[id] = tuple;
    count += 1;
  }
  try {
    localStorage.setItem(activeLayoutStorageKey(), JSON.stringify(packed));
  } catch {
    // Storage unavailable or full (private window).
  }
}

/** Clear device-local graph positions (called on sign-out). */
export function clearSavedGraphLayout(): void {
  try {
    localStorage.removeItem(activeLayoutStorageKey());
  } catch {
    // Storage unavailable.
  }
}

// ------------------------------------------------------------------
// Shared privacy and item helpers
// ------------------------------------------------------------------

// Spec: docs/internal/specs/graph-view.md (section 3)
const EXCLUDED_VAULT_TYPES = new Set<string>(['login', 'card', 'ssh-key']);

const KIND_BY_NOTE_TYPE: Record<string, GraphNodeKind> = {
  note: 'note',
  journal: 'journal',
  task: 'task',
  contact: 'contact',
  link: 'link',
  file: 'file',
  drawing: 'drawing',
  event: 'event',
};

/** Single source of truth for whether an item may appear in Graph, Places, or Explore. */
export function isEligibleGraphItem(note: LocalNote, isNoteLocked: (n: LocalNote) => boolean): boolean {
  if (note.deleted !== 0 || note.trashed !== 0) return false;
  if (note.pinProtected === 1) return false;
  if (isNoteLocked(note)) return false;
  if (EXCLUDED_VAULT_TYPES.has(note.type ?? 'note')) return false;
  return true;
}

const isEligibleItem = isEligibleGraphItem;

function graphKindOf(note: LocalNote): GraphNodeKind {
  return KIND_BY_NOTE_TYPE[note.type ?? 'note'] ?? 'note';
}

function createdAtMsOf(note: LocalNote): number {
  const parsed = Date.parse(note.createdAt);
  if (Number.isFinite(parsed)) return parsed;
  const fallback = Date.parse(note.updatedAt);
  return Number.isFinite(fallback) ? fallback : 0;
}

function noteColorKey(note: LocalNote, itemStyles: ItemStyles): LookColor | null {
  return resolveNoteLook(note.id, note.tags, note.folderId, itemStyles, true, 'background')?.color ?? null;
}

function makeRealGraphNode(note: LocalNote, itemStyles: ItemStyles): GraphNode {
  return {
    id: note.id,
    noteId: note.id,
    folderId: note.folderId,
    title: deriveDisplayTitle(note, false),
    kind: graphKindOf(note),
    colorKey: noteColorKey(note, itemStyles),
    tags: note.tags,
    createdAt: createdAtMsOf(note),
    degree: 0,
    inCount: 0,
    outCount: 0,
    hasPlace: readLocation(note.trackers) !== undefined,
    snippet: deriveExcerpt(note, false),
  };
}

function pairHasLink(linkIndex: LinkIndex, a: string, b: string): boolean {
  const outA = linkIndex.outgoing.get(a)?.ids;
  if (outA && outA.includes(b)) return true;
  const outB = linkIndex.outgoing.get(b)?.ids;
  if (outB && outB.includes(a)) return true;
  return false;
}

function linkEdgeKey(source: string, target: string): string {
  return `link:${source}->${target}`;
}

function smartEdgeKey(a: string, b: string): string {
  return `smart:${suggestionPairKey(a, b)}`;
}

function applyLinkDegrees(nodes: Map<string, GraphNode>, edges: readonly GraphEdge[]): void {
  for (const node of nodes.values()) {
    node.inCount = 0;
    node.outCount = 0;
    node.degree = 0;
  }
  for (const edge of edges) {
    if (edge.kind !== 'link') continue;
    const src = nodes.get(edge.source);
    const tgt = nodes.get(edge.target);
    if (!src || !tgt) continue;
    src.outCount += 1;
    tgt.inCount += 1;
  }
  for (const node of nodes.values()) {
    node.degree = node.inCount + node.outCount;
  }
}

/**
 * Resolve which folder collapses a note when `collapseFolders` is active.
 * Returns null when the note is unfiled, its folder is unknown, or its folder
 * (and every ancestor above it) is expanded.
 */
function collapsedFolderFor(
  folderId: string | null,
  foldersById: ReadonlyMap<string, FolderDef>,
  expandedFolderIds: ReadonlySet<string>,
): string | null {
  if (!folderId || !foldersById.has(folderId)) return null;
  if (expandedFolderIds.has(folderId)) return null;
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: FolderDef | undefined = foldersById.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current.id);
    current = current.parentId ? foldersById.get(current.parentId) : undefined;
  }
  // Walk root-down so an unexpanded root collapses its whole branch together.
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i]!;
    if (!expandedFolderIds.has(id)) return id;
  }
  return null;
}

// ------------------------------------------------------------------
// Whole-library Graph snapshot
// ------------------------------------------------------------------

const MAX_INBOX_HUBS = 20;

/**
 * Build the filtered graph nodes, edges, inbox lists, and protected-incoming
 * count from live vault state.
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */
export function buildGraphSnapshot(input: BuildGraphInput): GraphSnapshot {
  const { notes, linkIndex, isNoteLocked, itemStyles, folders, suggestedEdges = [], filters } = input;
  const foldersById = new Map(folders.map((f) => [f.id, f]));

  const eligibleNotes: LocalNote[] = [];
  for (const note of notes) {
    if (isEligibleItem(note, isNoteLocked)) eligibleNotes.push(note);
  }

  let timeRange: { min: number; max: number } | null = null;
  for (const note of eligibleNotes) {
    const ts = createdAtMsOf(note);
    if (!timeRange) timeRange = { min: ts, max: ts };
    else {
      if (ts < timeRange.min) timeRange.min = ts;
      if (ts > timeRange.max) timeRange.max = ts;
    }
  }

  // Filter by item kind and chronological replay bound.
  const liveNotes: LocalNote[] = [];
  const liveById = new Map<string, LocalNote>();
  for (const note of eligibleNotes) {
    const isJournal = note.type === 'journal';
    if (isJournal && !filters.showJournals) continue;
    if (!isJournal && !filters.showNotes) continue;
    if (filters.maxCreatedAt !== null && createdAtMsOf(note) > filters.maxCreatedAt) continue;
    liveNotes.push(note);
    liveById.set(note.id, note);
  }

  let protectedHiddenCount = 0;
  const realNodes = new Map<string, GraphNode>();
  for (const note of liveNotes) {
    protectedHiddenCount += linkIndex.protectedIncoming.get(note.id) ?? 0;
    realNodes.set(note.id, makeRealGraphNode(note, itemStyles));
  }

  // Real link edges and missing [[target]] tracking.
  const rawLinkEdges: GraphEdge[] = [];
  const rawLinkKeys = new Set<string>();
  const linkedPairKeys = new Set<string>();
  const missingMap = new Map<string, { id: string; name: string; referrers: Set<string>; createdAt: number }>();

  for (const note of liveNotes) {
    const out = linkIndex.outgoing.get(note.id);
    if (!out) continue;
    for (const targetId of out.ids) {
      if (targetId === note.id || !liveById.has(targetId)) continue;
      const key = linkEdgeKey(note.id, targetId);
      if (rawLinkKeys.has(key)) continue;
      rawLinkKeys.add(key);
      linkedPairKeys.add(suggestionPairKey(note.id, targetId));
      rawLinkEdges.push({ key, source: note.id, target: targetId, kind: 'link' });
    }
    const noteTs = createdAtMsOf(note);
    for (const rawName of out.missing) {
      const mKey = noteLinkKey(rawName);
      if (!mKey) continue;
      const missingId = `missing:${mKey}`;
      let entry = missingMap.get(missingId);
      if (!entry) {
        entry = { id: missingId, name: rawName, referrers: new Set([note.id]), createdAt: noteTs };
        missingMap.set(missingId, entry);
      } else {
        entry.referrers.add(note.id);
        if (noteTs < entry.createdAt) entry.createdAt = noteTs;
      }
    }
  }

  // Build Explore inbox lists from ALL eligible notes (independent of Graph-only
  // toggles and Chronological Replay so switching to Explore never looks silently empty).
  const allEligibleById = new Map<string, LocalNote>();
  const inboxNodes = new Map<string, GraphNode>();
  for (const note of eligibleNotes) {
    allEligibleById.set(note.id, note);
    inboxNodes.set(note.id, makeRealGraphNode(note, itemStyles));
  }
  const inboxEdges: GraphEdge[] = [];
  const inboxLinkKeys = new Set<string>();
  const inboxLinkedPairs = new Set<string>();
  const inboxMissingMap = new Map<string, { id: string; name: string; referrers: Set<string>; createdAt: number }>();

  for (const note of eligibleNotes) {
    const out = linkIndex.outgoing.get(note.id);
    if (!out) continue;
    for (const targetId of out.ids) {
      if (targetId === note.id || !allEligibleById.has(targetId)) continue;
      const key = linkEdgeKey(note.id, targetId);
      if (inboxLinkKeys.has(key)) continue;
      inboxLinkKeys.add(key);
      inboxLinkedPairs.add(suggestionPairKey(note.id, targetId));
      inboxEdges.push({ key, source: note.id, target: targetId, kind: 'link' });
    }
    const noteTs = createdAtMsOf(note);
    for (const rawName of out.missing) {
      const mKey = noteLinkKey(rawName);
      if (!mKey) continue;
      const missingId = `missing:${mKey}`;
      let entry = inboxMissingMap.get(missingId);
      if (!entry) {
        entry = { id: missingId, name: rawName, referrers: new Set([note.id]), createdAt: noteTs };
        inboxMissingMap.set(missingId, entry);
      } else {
        entry.referrers.add(note.id);
        if (noteTs < entry.createdAt) entry.createdAt = noteTs;
      }
    }
  }
  for (const entry of inboxMissingMap.values()) {
    inboxNodes.set(entry.id, {
      id: entry.id,
      title: entry.name,
      kind: 'missing',
      colorKey: null,
      tags: [],
      createdAt: entry.createdAt,
      degree: 0,
      inCount: 0,
      outCount: 0,
      hasPlace: false,
      snippet: '',
    });
    for (const refId of entry.referrers) {
      inboxEdges.push({ key: linkEdgeKey(refId, entry.id), source: refId, target: entry.id, kind: 'link' });
    }
  }
  applyLinkDegrees(inboxNodes, inboxEdges);

  const inboxSuggested: SuggestedPair[] = [];
  const seenInboxSuggested = new Set<string>();
  for (const s of suggestedEdges) {
    if (s.sourceId === s.targetId) continue;
    if (!allEligibleById.has(s.sourceId) || !allEligibleById.has(s.targetId)) continue;
    const pairKey = suggestionPairKey(s.sourceId, s.targetId);
    if (inboxLinkedPairs.has(pairKey) || seenInboxSuggested.has(pairKey)) continue;
    seenInboxSuggested.add(pairKey);
    const srcNode = inboxNodes.get(s.sourceId)!;
    const tgtNode = inboxNodes.get(s.targetId)!;
    inboxSuggested.push({
      key: pairKey,
      sourceId: s.sourceId,
      targetId: s.targetId,
      sourceTitle: srcNode.title,
      targetTitle: tgtNode.title,
      why: s.why,
    });
  }

  const rawSmartEdges: GraphEdge[] = [];
  const seenGraphSuggested = new Set<string>();
  for (const s of suggestedEdges) {
    if (s.sourceId === s.targetId) continue;
    if (!liveById.has(s.sourceId) || !liveById.has(s.targetId)) continue;
    const pairKey = suggestionPairKey(s.sourceId, s.targetId);
    if (linkedPairKeys.has(pairKey) || seenGraphSuggested.has(pairKey)) continue;
    seenGraphSuggested.add(pairKey);
    if (filters.showSuggested) {
      rawSmartEdges.push({
        key: smartEdgeKey(s.sourceId, s.targetId),
        source: s.sourceId,
        target: s.targetId,
        kind: 'smart',
        why: s.why,
      });
    }
  }

  const inboxMissing: MissingTarget[] = [...inboxMissingMap.values()]
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      referrerIds: [...entry.referrers],
      referrerCount: entry.referrers.size,
    }))
    .sort((a, b) => b.referrerCount - a.referrerCount || a.name.localeCompare(b.name));

  const realInboxNodes = [...inboxNodes.values()].filter((n) => n.kind !== 'missing');
  const inboxOrphans = realInboxNodes
    .filter((n) => n.degree === 0)
    .sort((a, b) => b.createdAt - a.createdAt || a.title.localeCompare(b.title));
  const inboxHubs = realInboxNodes
    .filter((n) => n.degree > 0)
    .sort((a, b) => b.degree - a.degree || b.inCount - a.inCount || a.title.localeCompare(b.title))
    .slice(0, MAX_INBOX_HUBS);

  // Assemble display nodes (with optional folder collapsing and missing targets).
  const displayNodes = new Map<string, GraphNode>();
  const collapsedTo = new Map<string, string>();

  if (filters.collapseFolders) {
    const hubs = new Map<
      string,
      { folder: FolderDef; memberCount: number; minCreatedAt: number; hasPlace: boolean }
    >();
    for (const [id, node] of realNodes) {
      const hubFolderId = collapsedFolderFor(node.folderId ?? null, foldersById, filters.expandedFolderIds);
      if (!hubFolderId) {
        displayNodes.set(id, { ...node });
        continue;
      }
      const hubId = `folder:${hubFolderId}`;
      collapsedTo.set(id, hubId);
      const existing = hubs.get(hubId);
      if (!existing) {
        hubs.set(hubId, {
          folder: foldersById.get(hubFolderId)!,
          memberCount: 1,
          minCreatedAt: node.createdAt,
          hasPlace: node.hasPlace,
        });
      } else {
        existing.memberCount += 1;
        if (node.createdAt < existing.minCreatedAt) existing.minCreatedAt = node.createdAt;
        if (node.hasPlace) existing.hasPlace = true;
      }
    }
    for (const [hubId, info] of hubs) {
      displayNodes.set(hubId, {
        id: hubId,
        folderId: info.folder.id,
        title: info.folder.name,
        kind: 'folderHub',
        colorKey: folderColor(info.folder.id, itemStyles),
        tags: [],
        createdAt: info.minCreatedAt,
        degree: 0,
        inCount: 0,
        outCount: 0,
        memberCount: info.memberCount,
        hasPlace: info.hasPlace,
        snippet: '',
      });
    }
  } else {
    for (const [id, node] of realNodes) displayNodes.set(id, { ...node });
  }

  if (filters.showMissing) {
    for (const entry of missingMap.values()) {
      displayNodes.set(entry.id, {
        id: entry.id,
        title: entry.name,
        kind: 'missing',
        colorKey: null,
        tags: [],
        createdAt: entry.createdAt,
        degree: 0,
        inCount: 0,
        outCount: 0,
        hasPlace: false,
        snippet: '',
      });
    }
  }

  // Remap edges cleanly across any collapsed folder hubs without self-loops or duplicates.
  const remap = (id: string): string => collapsedTo.get(id) ?? id;
  let displayEdges: GraphEdge[] = [];
  const emittedLinkKeys = new Set<string>();
  const emittedLinkPairs = new Set<string>();

  for (const edge of rawLinkEdges) {
    const source = remap(edge.source);
    const target = remap(edge.target);
    if (source === target || !displayNodes.has(source) || !displayNodes.has(target)) continue;
    const key = linkEdgeKey(source, target);
    if (emittedLinkKeys.has(key)) continue;
    emittedLinkKeys.add(key);
    emittedLinkPairs.add(suggestionPairKey(source, target));
    displayEdges.push({ key, source, target, kind: 'link' });
  }

  if (filters.showMissing) {
    for (const entry of missingMap.values()) {
      for (const refId of entry.referrers) {
        const source = remap(refId);
        const target = entry.id;
        if (source === target || !displayNodes.has(source) || !displayNodes.has(target)) continue;
        const key = linkEdgeKey(source, target);
        if (emittedLinkKeys.has(key)) continue;
        emittedLinkKeys.add(key);
        emittedLinkPairs.add(suggestionPairKey(source, target));
        displayEdges.push({ key, source, target, kind: 'link' });
      }
    }
  }

  if (filters.showSuggested) {
    const emittedSmartKeys = new Set<string>();
    for (const edge of rawSmartEdges) {
      const source = remap(edge.source);
      const target = remap(edge.target);
      if (source === target || !displayNodes.has(source) || !displayNodes.has(target)) continue;
      const pairKey = suggestionPairKey(source, target);
      if (emittedLinkPairs.has(pairKey)) continue;
      const key = `smart:${pairKey}`;
      if (emittedSmartKeys.has(key)) continue;
      emittedSmartKeys.add(key);
      displayEdges.push({ key, source, target, kind: 'smart', why: edge.why });
    }
  }

  // Focus filter: undirected BFS up to focusDepth hops (1 or 2).
  const resolvedFocusId = filters.focusNodeId ? remap(filters.focusNodeId) : null;
  if (resolvedFocusId && displayNodes.has(resolvedFocusId)) {
    const adj = new Map<string, Set<string>>();
    for (const edge of displayEdges) {
      let a = adj.get(edge.source);
      if (!a) {
        a = new Set();
        adj.set(edge.source, a);
      }
      a.add(edge.target);
      let b = adj.get(edge.target);
      if (!b) {
        b = new Set();
        adj.set(edge.target, b);
      }
      b.add(edge.source);
    }
    const visited = new Set<string>([resolvedFocusId]);
    let frontier: string[] = [resolvedFocusId];
    for (let hop = 0; hop < filters.focusDepth && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const curr of frontier) {
        for (const neighbor of adj.get(curr) ?? []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    for (const id of [...displayNodes.keys()]) {
      if (!visited.has(id)) displayNodes.delete(id);
    }
    displayEdges = displayEdges.filter((e) => visited.has(e.source) && visited.has(e.target));
  }

  // Search filter.
  if (filters.searchQuery.trim()) {
    const matches = textMatcher(filters.searchQuery);
    for (const [id, node] of [...displayNodes]) {
      const hit = matches(node.title) || matches(node.snippet) || node.tags.some((tag) => matches(tag));
      if (!hit) displayNodes.delete(id);
    }
    displayEdges = displayEdges.filter((e) => displayNodes.has(e.source) && displayNodes.has(e.target));
  }

  // Recompute degrees over the surviving edges.
  applyLinkDegrees(displayNodes, displayEdges);

  // Orphan filter: hide nodes with zero link degree (except the active focus node).
  if (!filters.showOrphans) {
    for (const [id, node] of [...displayNodes]) {
      if (node.degree === 0 && id !== resolvedFocusId) displayNodes.delete(id);
    }
    displayEdges = displayEdges.filter((e) => displayNodes.has(e.source) && displayNodes.has(e.target));
    applyLinkDegrees(displayNodes, displayEdges);
  }

  return {
    nodes: [...displayNodes.values()],
    edges: displayEdges,
    inbox: {
      suggested: inboxSuggested,
      missing: inboxMissing,
      orphans: inboxOrphans,
      hubs: inboxHubs,
    },
    protectedHiddenCount,
    timeRange,
  };
}

// ------------------------------------------------------------------
// Whole-library smart suggestion pairs
// ------------------------------------------------------------------

const MAX_SUGGESTION_SEEDS = 60;
const MAX_GRAPH_SUGGESTIONS = 36;

function reasonToWhyData(reason: RelatedReason, titleOf: (id: string) => string): RelatedWhyData {
  switch (reason.kind) {
    case 'words':
      return { kind: 'words', words: reason.words };
    case 'linksTo':
      return { kind: 'linksTo', viaId: reason.via, viaTitle: titleOf(reason.via) };
    case 'linkedFrom':
      return { kind: 'linkedFrom', viaId: reason.via, viaTitle: titleOf(reason.via) };
    case 'tag':
      return { kind: 'tag', tag: reason.tag };
    case 'meaning':
      return { kind: 'meaning' };
  }
}

/**
 * Collect up to 36 top deduplicated suggested bridges across up to 60 of the
 * most-connected and most-recent eligible markdown notes using the in-memory
 * related-notes index (and optional offline meaning vectors).
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */
export function computeGraphSuggestions(
  notes: readonly LocalNote[],
  linkIndex: LinkIndex,
  isNoteLocked: (note: LocalNote) => boolean,
  dismissedSuggestions: readonly string[],
  getMeaningHits?: MeaningHitsFn,
): SuggestedEdge[] {
  const mod = relatedModule();
  if (!mod || !mod.index.ready()) return [];

  const eligible: LocalNote[] = [];
  const byId = new Map<string, LocalNote>();
  const eligibleIds = new Set<string>();
  for (const note of notes) {
    byId.set(note.id, note);
    if (note.deleted === 0 && isRelatedSource(note) && !isNoteLocked(note)) {
      eligible.push(note);
      eligibleIds.add(note.id);
    }
  }
  if (eligible.length < 2) return [];

  const degreeOf = (id: string): number =>
    (linkIndex.incoming.get(id)?.length ?? 0) + (linkIndex.outgoing.get(id)?.ids.length ?? 0);

  // Pick up to 30 most-connected notes plus most-recent notes to reach 60 seeds.
  const seedIds = new Set<string>();
  const seeds: LocalNote[] = [];
  const byDegree = [...eligible].sort((a, b) => {
    const cmp = degreeOf(b.id) - degreeOf(a.id);
    if (cmp !== 0) return cmp;
    const ea = editedAtOf(a);
    const eb = editedAtOf(b);
    return eb > ea ? 1 : eb < ea ? -1 : a.id.localeCompare(b.id);
  });
  for (const n of byDegree) {
    if (seeds.length >= Math.floor(MAX_SUGGESTION_SEEDS / 2)) break;
    if (degreeOf(n.id) === 0) break;
    seedIds.add(n.id);
    seeds.push(n);
  }
  const byRecent = [...eligible].sort((a, b) => {
    const ea = editedAtOf(a);
    const eb = editedAtOf(b);
    return eb > ea ? 1 : eb < ea ? -1 : a.id.localeCompare(b.id);
  });
  for (const n of byRecent) {
    if (seeds.length >= MAX_SUGGESTION_SEEDS) break;
    if (seedIds.has(n.id)) continue;
    seedIds.add(n.id);
    seeds.push(n);
  }

  const dismissed = hiddenPairs(dismissedSuggestions);
  const titleOf = (id: string): string => {
    const n = byId.get(id);
    if (!n || !isEligibleItem(n, isNoteLocked)) return '';
    return deriveDisplayTitle(n, false);
  };

  const candidates: Array<{ edge: SuggestedEdge; rank: number; order: number }> = [];
  const seenPairs = new Set<string>();
  let order = 0;

  for (const seed of seeds) {
    const isListable = (id: string): boolean =>
      eligibleIds.has(id) && !dismissed.has(suggestionPairKey(seed.id, id));
    const meaning = getMeaningHits
      ? (skip: (id: string) => boolean, limit: number) => getMeaningHits(seed, skip, limit)
      : undefined;
    const hits = mod.relatedNotes(seed, linkIndex, isListable, meaning);
    for (let rank = 0; rank < hits.length; rank++) {
      const hit = hits[rank]!;
      if (hit.id === seed.id || !eligibleIds.has(hit.id)) continue;
      if (pairHasLink(linkIndex, seed.id, hit.id)) continue;
      const pairKey = suggestionPairKey(seed.id, hit.id);
      if (dismissed.has(pairKey) || seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      candidates.push({
        edge: {
          key: pairKey,
          sourceId: seed.id,
          targetId: hit.id,
          why: reasonToWhyData(hit.reason, titleOf),
        },
        rank,
        order: order++,
      });
    }
  }

  candidates.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return candidates.slice(0, MAX_GRAPH_SUGGESTIONS).map((c) => c.edge);
}

// ------------------------------------------------------------------
// Compact 1-hop / 2-hop local graph for ConnectionsPanel
// ------------------------------------------------------------------

/**
 * Build the compact 1-hop or 2-hop neighborhood around `centerId`, including
 * incoming links, outgoing links, hop-1 missing targets, and hop-1 suggested
 * connections for the center note.
 * Spec: docs/internal/specs/graph-view.md (section 4.5)
 */
export function buildLocalGraph(
  centerId: string,
  depth: 1 | 2,
  notes: readonly LocalNote[],
  linkIndex: LinkIndex,
  isNoteLocked: (note: LocalNote) => boolean,
  itemStyles: ItemStyles,
  _folders: readonly FolderDef[],
  relatedForCenter: readonly LocalRelatedEntry[] = [],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const eligibleById = new Map<string, LocalNote>();
  for (const note of notes) {
    if (isEligibleItem(note, isNoteLocked)) eligibleById.set(note.id, note);
  }
  const centerNote = eligibleById.get(centerId);
  if (!centerNote) return { nodes: [], edges: [] };

  const visited = new Set<string>([centerId]);
  const hop1 = new Set<string>();

  const addNeighbor = (id: string, bucket: Set<string>) => {
    if (id === centerId || !eligibleById.has(id)) return;
    if (!visited.has(id)) {
      visited.add(id);
      bucket.add(id);
    }
  };

  for (const srcId of linkIndex.incoming.get(centerId) ?? []) addNeighbor(srcId, hop1);
  for (const tgtId of linkIndex.outgoing.get(centerId)?.ids ?? []) addNeighbor(tgtId, hop1);

  if (depth === 2) {
    const hop2 = new Set<string>();
    for (const id of hop1) {
      for (const srcId of linkIndex.incoming.get(id) ?? []) {
        if (eligibleById.has(srcId) && !visited.has(srcId)) {
          visited.add(srcId);
          hop2.add(srcId);
        }
      }
      for (const tgtId of linkIndex.outgoing.get(id)?.ids ?? []) {
        if (eligibleById.has(tgtId) && !visited.has(tgtId)) {
          visited.add(tgtId);
          hop2.add(tgtId);
        }
      }
    }
  }

  // Include eligible hop-1 suggested notes.
  const smartEdges: GraphEdge[] = [];
  const seenSmart = new Set<string>();
  for (const entry of relatedForCenter) {
    const other = eligibleById.get(entry.note.id);
    if (!other || other.id === centerId) continue;
    if (pairHasLink(linkIndex, centerId, other.id)) continue;
    const key = smartEdgeKey(centerId, other.id);
    if (seenSmart.has(key)) continue;
    seenSmart.add(key);
    visited.add(other.id);
    smartEdges.push({
      key,
      source: centerId,
      target: other.id,
      kind: 'smart',
      why: entry.why,
    });
  }

  const nodeMap = new Map<string, GraphNode>();
  // Keep center node first for deterministic rendering.
  nodeMap.set(centerId, makeRealGraphNode(centerNote, itemStyles));
  for (const id of visited) {
    if (id === centerId) continue;
    const note = eligibleById.get(id);
    if (note) nodeMap.set(id, makeRealGraphNode(note, itemStyles));
  }

  const edges: GraphEdge[] = [];
  const seenLinks = new Set<string>();
  for (const srcId of visited) {
    for (const tgtId of linkIndex.outgoing.get(srcId)?.ids ?? []) {
      if (srcId === tgtId || !visited.has(tgtId)) continue;
      const key = linkEdgeKey(srcId, tgtId);
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      edges.push({ key, source: srcId, target: tgtId, kind: 'link' });
    }
  }

  // Missing targets linked directly from centerId at hop 1.
  const centerTs = createdAtMsOf(centerNote);
  for (const rawName of linkIndex.outgoing.get(centerId)?.missing ?? []) {
    const mKey = noteLinkKey(rawName);
    if (!mKey) continue;
    const missingId = `missing:${mKey}`;
    if (!nodeMap.has(missingId)) {
      nodeMap.set(missingId, {
        id: missingId,
        title: rawName,
        kind: 'missing',
        colorKey: null,
        tags: [],
        createdAt: centerTs,
        degree: 0,
        inCount: 0,
        outCount: 0,
        hasPlace: false,
        snippet: '',
      });
    }
    const key = linkEdgeKey(centerId, missingId);
    if (!seenLinks.has(key)) {
      seenLinks.add(key);
      edges.push({ key, source: centerId, target: missingId, kind: 'link' });
    }
  }

  for (const se of smartEdges) edges.push(se);
  applyLinkDegrees(nodeMap, edges);

  return { nodes: [...nodeMap.values()], edges };
}

// ------------------------------------------------------------------
// Places lens & offline contact town matching
// ------------------------------------------------------------------

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US',
  'u s a': 'US',
  'u s': 'US',
  'united states of america': 'US',
  'united states': 'US',
  'vereinigte staaten': 'US',
  'etats unis': 'US',
  'etats-unis': 'US',
  america: 'US',
  uk: 'GB',
  'u k': 'GB',
  'united kingdom': 'GB',
  'great britain': 'GB',
  'royaume uni': 'GB',
  'royaume-uni': 'GB',
  'vereinigtes konigreich': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  uae: 'AE',
  deutschland: 'DE',
  allemagne: 'DE',
  alemania: 'DE',
  frankreich: 'FR',
  francia: 'FR',
  schweiz: 'CH',
  suisse: 'CH',
  svizzera: 'CH',
  suiza: 'CH',
  osterreich: 'AT',
  autriche: 'AT',
  nederland: 'NL',
  'pays bas': 'NL',
  'pays-bas': 'NL',
  niederlande: 'NL',
  holland: 'NL',
  espana: 'ES',
  espagne: 'ES',
  spanien: 'ES',
  italia: 'IT',
  italie: 'IT',
  italien: 'IT',
  kanada: 'CA',
  brasil: 'BR',
  turkey: 'TR',
  turkiye: 'TR',
  'czech republic': 'CZ',
  czechia: 'CZ',
  'ivory coast': 'CI',
  burma: 'MM',
  japon: 'JP',
  '日本': 'JP',
  belgique: 'BE',
  belgien: 'BE',
  portugal: 'PT',
  can: 'CA',
  aus: 'AU',
  deu: 'DE',
  fra: 'FR',
  gbr: 'GB',
  che: 'CH',
  jpn: 'JP',
  nld: 'NL',
  phl: 'PH',
  sgp: 'SG',
  nzl: 'NZ',
};

const REGION_CODES: Record<string, string> = {
  // US states
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', dc: 'district of columbia',
  fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois',
  in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
  me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
  ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada',
  nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york',
  nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
  or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
  sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  // Canadian provinces
  ab: 'alberta', bc: 'british columbia', mb: 'manitoba', nb: 'new brunswick',
  nl: 'newfoundland and labrador', ns: 'nova scotia', on: 'ontario',
  pe: 'prince edward island', qc: 'quebec', sk: 'saskatchewan',
  // Australian states
  nsw: 'new south wales', qld: 'queensland', sa: 'south australia',
  tas: 'tasmania', vic: 'victoria',
  // Swiss cantons (major)
  zh: 'zurich', ge: 'geneva', be: 'bern', bs: 'basel-stadt', vd: 'vaud',
};

const US_STATE_SET = new Set<string>([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'dc', 'fl', 'ga', 'hi', 'id',
  'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo',
  'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa',
  'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
]);

const STREET_SUFFIX_RE =
  /\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pl|place|pkwy|parkway|str|strasse|rue|weg|allee)\b\.?(?:\s+\d+[a-z]?)?$/i;

interface PlaceLookupIndex {
  byKey: Map<string, PlaceRow[]>;
  countryNameToIso: Map<string, string>;
  knownIsoCodes: Set<string>;
}

const placeLookupCache = new WeakMap<readonly PlaceRow[], PlaceLookupIndex>();

function getPlaceLookupIndex(rows: readonly PlaceRow[]): PlaceLookupIndex {
  const cached = placeLookupCache.get(rows);
  if (cached) return cached;
  const built = buildPlaceLookupIndex(rows);
  placeLookupCache.set(rows, built);
  return built;
}

function buildPlaceLookupIndex(rows: readonly PlaceRow[]): PlaceLookupIndex {
  const byKey = new Map<string, PlaceRow[]>();
  const knownIsoCodes = new Set<string>();
  for (const row of rows) {
    if (row.country) knownIsoCodes.add(row.country.toUpperCase());
    for (const key of row.keys) {
      if (!key) continue;
      let list = byKey.get(key);
      if (!list) {
        list = [];
        byKey.set(key, list);
      }
      list.push(row);
    }
  }
  const countryNameToIso = new Map<string, string>();
  const displayInstances: Intl.DisplayNames[] = [];
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    try {
      displayInstances.push(new Intl.DisplayNames([lang], { type: 'region' }));
    } catch {
      // Ignore unavailable locale display names.
    }
  }
  for (const iso of knownIsoCodes) {
    countryNameToIso.set(iso.toLowerCase(), iso);
    for (const display of displayInstances) {
      try {
        const label = display.of(iso);
        if (label) countryNameToIso.set(foldForMatch(label).trim(), iso);
      } catch {
        // Ignore invalid region codes.
      }
    }
  }
  return { byKey, countryNameToIso, knownIsoCodes };
}

function resolveCountryIso(rawCountry: string, index: PlaceLookupIndex): string | null {
  const cleaned = foldForMatch(rawCountry).replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const fromAlias = COUNTRY_ALIASES[cleaned];
  if (fromAlias) return fromAlias;
  const fromNames = index.countryNameToIso.get(cleaned);
  if (fromNames) return fromNames;
  if (/^[a-z]{2}$/.test(cleaned)) return cleaned.toUpperCase();
  return null;
}

function regionMatches(rowRegion: string, rawRegion: string): boolean {
  const a = foldForMatch(rowRegion).trim();
  const b = foldForMatch(rawRegion).trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const expanded = REGION_CODES[b];
  if (expanded && (a === expanded || a.startsWith(`${expanded} `))) return true;
  // Require full-word boundary match rather than arbitrary substring so "Virginia"
  // does not match "West Virginia" and "Kansas" does not match "Arkansas".
  if (b.length >= 4 && a.startsWith(`${b} `)) return true;
  if (a.length >= 4 && b.startsWith(`${a} `)) return true;
  return false;
}

function stripPostalCodes(token: string): string {
  return token
    // Japanese postal mark + code (〒100-0001)
    .replace(/〒\s*\d{3}-?\d{4}/g, ' ')
    // UK postcode (SW1A 1AA, SE1 9QG, M1 1AE)
    .replace(/\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b/gi, ' ')
    // Canadian postcode (H2W 2M5)
    .replace(/\b[a-z]\d[a-z]\s*\d[a-z]\d\b/gi, ' ')
    // Dutch postcode (1012 JS)
    .replace(/\b\d{4}\s+[a-z]{2}\b/gi, ' ')
    // Leading European/US postal code (CH-8001, 10119, 100-0001)
    .replace(/^\s*(?:[a-z]{1,2}-?)?\d{4,6}(?:-\d{3,4})?\s+/i, '')
    // Trailing numeric postal code (94105, 94105-1234, 8001)
    .replace(/\s+\d{4,6}(?:-\d{3,4})?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cityKeyCandidates(rawCity: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    const folded = foldForMatch(v).replace(/\s+/g, ' ').trim();
    if (folded && !out.includes(folded)) out.push(folded);
  };
  push(rawCity);
  push(stripPostalCodes(rawCity));
  // Handle "Austin, TX" or "St. Louis" / "Aix-en-Provence" variants
  const beforeComma = rawCity.split(',')[0]?.trim();
  if (beforeComma && beforeComma !== rawCity.trim()) {
    push(beforeComma);
    push(stripPostalCodes(beforeComma));
  }
  for (const base of [...out]) {
    if (/\bst\.?\s+/i.test(base)) push(base.replace(/\bst\.?\s+/gi, 'saint '));
    if (/\bsaint\s+/i.test(base)) push(base.replace(/\bsaint\s+/gi, 'st '));
    if (base.includes('-')) push(base.replace(/-/g, ' '));
  }
  return out;
}

function pickBestPlaceHit(
  hits: readonly PlaceRow[],
  countryIso: string | null,
  rawRegion: string,
  extraTokens: readonly string[],
): PlaceRow | null {
  let candidates = hits;
  if (countryIso) {
    const byCountry = candidates.filter((h) => h.country.toUpperCase() === countryIso);
    if (byCountry.length === 0) return null;
    candidates = byCountry;
  }
  if (rawRegion.trim()) {
    const exactRegion = candidates.filter((h) => foldForMatch(h.region).trim() === foldForMatch(rawRegion).trim());
    if (exactRegion.length > 0) return exactRegion[0]!;
    const byRegion = candidates.filter((h) => regionMatches(h.region, rawRegion));
    if (byRegion.length > 0) return byRegion[0]!;
  }
  if (extraTokens.length > 0 && candidates.length > 1) {
    for (const token of extraTokens) {
      const byRegion = candidates.filter((h) => regionMatches(h.region, token));
      if (byRegion.length > 0) return byRegion[0]!;
    }
  }
  // PlaceRow lists are already sorted by rank (population / prominence).
  return candidates[0] ?? null;
}

function matchAddressOffline(address: ContactAddress, index: PlaceLookupIndex): PlaceRow | null {
  let countryIso = resolveCountryIso(address.country, index);
  let rawRegion = address.region.trim();

  // Primary path: explicit city field.
  const rawCity = address.city.trim();
  if (rawCity) {
    // If city holds "Austin, TX", use the trailing piece as a region hint when region is blank.
    if (!rawRegion && rawCity.includes(',')) {
      const afterComma = rawCity.split(',').slice(1).join(' ').trim();
      if (afterComma) rawRegion = stripPostalCodes(afterComma);
    }
    for (const key of cityKeyCandidates(rawCity)) {
      const hits = index.byKey.get(key);
      if (!hits || hits.length === 0) continue;
      const best = pickBestPlaceHit(hits, countryIso, rawRegion, []);
      if (best) return best;
    }
    return null;
  }

  // Fallback path: scan lines and comma-separated tokens of a multi-line street blob.
  if (!address.street.trim()) return null;
  const parts: string[] = [];
  for (const line of address.street.split(/\r?\n/)) {
    for (const piece of line.split(',')) {
      const trimmed = piece.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  if (parts.length === 0) return null;

  const skipIndices = new Set<number>();

  // Infer country from trailing tokens when the structured country field is empty.
  // Guard against US state + ZIP tokens ("CA 94105", "IL 60601", "CO 80202") colliding
  // with ISO country codes (Canada, Israel, Colombia, etc.).
  if (!countryIso) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const rawPart = parts[i]!;
      const usStateZip = /^([a-z]{2})\s+\d{5}(?:-\d{4})?$/i.exec(rawPart);
      if (usStateZip && US_STATE_SET.has(usStateZip[1]!.toLowerCase())) {
        countryIso = 'US';
        if (!rawRegion) rawRegion = usStateZip[1]!.toUpperCase();
        skipIndices.add(i);
        break;
      }
      const cleanedForCountry = stripPostalCodes(rawPart);
      const lower = foldForMatch(cleanedForCountry).trim();
      // A bare 2-letter US state code followed by a 5-digit ZIP token or at the end
      // of a US-style "Street, City, ST" address is a US state, not an ISO country.
      if (
        /^[a-z]{2}$/.test(lower)
        && US_STATE_SET.has(lower)
        && ((i + 1 < parts.length && /^\d{5}(?:-\d{4})?$/.test(parts[i + 1]!)) || (i === parts.length - 1 && parts.length >= 3))
      ) {
        countryIso = 'US';
        if (!rawRegion) rawRegion = lower.toUpperCase();
        skipIndices.add(i);
        break;
      }
      const iso = resolveCountryIso(rawPart, index);
      if (iso && index.knownIsoCodes.has(iso)) {
        countryIso = iso;
        skipIndices.add(i);
        break;
      }
    }
  }

  // Scan bottom-up because postal addresses place city/region/country after street lines.
  const extraTokens = parts.map((p) => stripPostalCodes(p)).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (skipIndices.has(i)) continue;
    const part = parts[i]!;
    if (STREET_SUFFIX_RE.test(part)) continue;
    // Skip pure leading street line ("123 Main St" or "Bahnhofstrasse 1") when later parts exist.
    if (i === 0 && parts.length > 1 && /^\d+\s+/.test(part)) continue;
    const cleaned = stripPostalCodes(part);
    const lower = foldForMatch(cleaned).trim();
    if (!lower || /^\d+$/.test(lower) || [...lower].length < 2) continue;
    // Skip tokens that are purely a country or region name/code so Wikidata country/state
    // rows do not hijack the city match.
    if (COUNTRY_ALIASES[lower] || (index.countryNameToIso.has(lower) && !index.byKey.has(lower))) continue;
    if (i > 0 && REGION_CODES[lower]) {
      if (!rawRegion) rawRegion = lower;
      continue;
    }
    for (const key of cityKeyCandidates(cleaned)) {
      const hits = index.byKey.get(key);
      if (!hits || hits.length === 0) continue;
      const best = pickBestPlaceHit(hits, countryIso, rawRegion, extraTokens);
      if (best) return best;
    }
  }

  return null;
}

function placePinKindOf(note: LocalNote): PlacePinKind {
  if (note.type === 'journal') return 'journal';
  if (note.type === 'contact') return 'contact';
  return 'note';
}

function allowedByPlacesFilter(kind: PlacePinKind, filters: PlacesFilterState): boolean {
  if (kind === 'journal') return filters.showJournals;
  if (kind === 'contact') return filters.showContacts;
  return filters.showNotes;
}

/**
 * Resolve every visible item with a place (exact `trackers.location` or offline
 * town-matched contact address) plus contacts with an address that did not
 * match any row in the loaded `placeRows`.
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */
export function resolvePlacedItems(
  notes: readonly LocalNote[],
  isNoteLocked: (note: LocalNote) => boolean,
  itemStyles: ItemStyles,
  _folders: readonly FolderDef[],
  placeRows: readonly PlaceRow[] | null,
  filters: PlacesFilterState,
): { placed: PlacedItem[]; unplacedContacts: UnplacedContact[] } {
  const lookup = placeRows && placeRows.length > 0 ? getPlaceLookupIndex(placeRows) : null;
  const query = filters.searchQuery.trim();
  const matches = query ? textMatcher(query) : null;

  const placed: PlacedItem[] = [];
  const unplacedContacts: UnplacedContact[] = [];

  for (const note of notes) {
    if (!isEligibleItem(note, isNoteLocked)) continue;
    const kind = placePinKindOf(note);
    if (!allowedByPlacesFilter(kind, filters)) continue;

    const title = deriveDisplayTitle(note, false);
    const colorKey = noteColorKey(note, itemStyles);
    const exactLoc = readLocation(note.trackers);

    if (exactLoc) {
      let initials: string | undefined;
      let addressSummary: string | undefined;
      if (kind === 'contact') {
        const contact = parseContactBody(note.body);
        initials = contactInitialsFor(title, contact);
        const firstAddr = contact.addresses.find((a) => !isAddressEmpty(a));
        if (firstAddr) addressSummary = formatAddressLines(firstAddr).join(', ');
      }
      if (matches) {
        const hit =
          matches(title) ||
          (exactLoc.label ? matches(exactLoc.label) : null) ||
          (addressSummary ? matches(addressSummary) : null) ||
          note.tags.some((tag) => matches(tag));
        if (!hit) continue;
      }
      placed.push({
        id: note.id,
        note,
        title,
        kind,
        location: exactLoc,
        exact: true,
        ...(addressSummary ? { addressSummary } : {}),
        ...(initials ? { initials } : {}),
        colorKey,
      });
      continue;
    }

    if (kind !== 'contact') continue;
    const contact = parseContactBody(note.body);
    const nonEmptyAddresses = contact.addresses.filter((a) => !isAddressEmpty(a));
    if (nonEmptyAddresses.length === 0) continue;

    if (placeRows === null) continue;

    let matchedRow: PlaceRow | null = null;
    let matchedAddr: ContactAddress | null = null;
    if (lookup) {
      for (const addr of nonEmptyAddresses) {
        const hit = matchAddressOffline(addr, lookup);
        if (hit) {
          matchedRow = hit;
          matchedAddr = addr;
          break;
        }
      }
    }

    if (matchedRow && matchedAddr) {
      const addressSummary = formatAddressLines(matchedAddr).join(', ');
      const location: NoteLocation = { lat: matchedRow.lat, lng: matchedRow.lng, label: matchedRow.name };
      if (matches) {
        const hit =
          matches(title) ||
          matches(matchedRow.name) ||
          matches(addressSummary) ||
          note.tags.some((tag) => matches(tag));
        if (!hit) continue;
      }
      placed.push({
        id: note.id,
        note,
        title,
        kind: 'contact',
        location,
        exact: false,
        addressSummary,
        initials: contactInitialsFor(title, contact),
        colorKey,
      });
    } else {
      const addressSummary = formatAddressLines(nonEmptyAddresses[0]!).join(', ');
      if (matches) {
        const hit =
          matches(title) ||
          matches(addressSummary) ||
          note.tags.some((tag) => matches(tag));
        if (!hit) continue;
      }
      unplacedContacts.push({
        id: note.id,
        note,
        title,
        addressSummary,
      });
    }
  }

  return { placed, unplacedContacts };
}

// ------------------------------------------------------------------
// Pure markdown footnote note-link helper
// ------------------------------------------------------------------

const FOOTNOTE_LABEL_RE = /\[\^([^\s\]^]+)\]/g;
const FOOTNOTE_DEF_START_RE = /^\[\^[^\s\]^]+\]:/;

function nextFreeFootnoteLabel(body: string): string {
  const used = new Set<string>();
  FOOTNOTE_LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOOTNOTE_LABEL_RE.exec(body)) !== null) {
    if (m[1]) used.add(m[1]);
  }
  let max = 0;
  // Nine digits at most so adding one always advances an exact integer.
  for (const label of used) {
    if (/^\d{1,9}$/.test(label)) max = Math.max(max, Number(label));
  }
  let n = max + 1;
  while (used.has(String(n))) n += 1;
  return String(n);
}

/**
 * True when an item type can hold outgoing `[[note-links]]`: markdown pillars
 * store them in their body, while bookmarks and contacts store them in their
 * JSON `notes` field (`vaultBody.ts`).
 */
export function canStoreNoteLinks(type: string | undefined): boolean {
  return !hasStructuredBody(type) || type === 'link' || type === 'contact';
}

/**
 * Append an inline `[[Target]]` note-link line to a form item's Markdown
 * `notes` field (bookmarks and contacts). Returns `notes` unchanged when a
 * note-link to `targetTitle` already exists outside code blocks.
 */
export function appendInlineNoteLink(
  notes: string,
  targetTitle: string,
  suggested = false,
): string {
  const sanitized = noteLinkTarget(targetTitle);
  if (!sanitized) return notes;
  const wantedKey = noteLinkKey(sanitized);

  for (const rawTarget of noteLinkTargets(notes)) {
    const { note } = parseNoteLinkTarget(rawTarget);
    if (note && noteLinkKey(note) === wantedKey) return notes;
  }

  const linkLine = suggested
    ? `[[${sanitized}]]${SUGGESTED_LINK_MARKER}`
    : `[[${sanitized}]]`;
  const trimmed = notes.replace(/\r\n/g, '\n').replace(/\n+$/g, '');
  return trimmed ? `${trimmed}\n${linkLine}` : linkLine;
}

/**
 * Append a footnote marker `[^N]` at the end of the last non-footnote prose
 * line and `[^N]: [[TargetTitle]]` in the footnote section, matching
 * `footnotes.ts` (`isLinkOnlyDefinition`). Returns `body` unchanged when it
 * already links to `targetTitle`.
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */
export function appendFootnoteNoteLink(
  body: string,
  targetTitle: string,
  suggested = false,
): string {
  const sanitized = noteLinkTarget(targetTitle);
  if (!sanitized) return body;
  const wantedKey = noteLinkKey(sanitized);

  for (const rawTarget of noteLinkTargets(body)) {
    const { note } = parseNoteLinkTarget(rawTarget);
    if (note && noteLinkKey(note) === wantedKey) return body;
  }

  const label = nextFreeFootnoteLabel(body);
  const linkMarkdown = suggested
    ? `[[${sanitized}]]${SUGGESTED_LINK_MARKER}`
    : `[[${sanitized}]]`;
  const defLine = `[^${label}]: ${linkMarkdown}`;

  const normalized = body.replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return `[^${label}]\n\n${defLine}`;
  }

  const lines = normalized.split('\n');
  // Identify lines belonging to footnote definitions (outside fenced code blocks).
  const isFootnoteLine = new Array<boolean>(lines.length).fill(false);
  let fence: Fence | null = null;
  let inFootnote = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stepped = nextFence(fence, line);
    const wasInFence = fence !== null;
    fence = stepped.fence;
    if (wasInFence || stepped.isFence) {
      if (inFootnote) isFootnoteLine[i] = true;
      continue;
    }
    if (FOOTNOTE_DEF_START_RE.test(line)) {
      inFootnote = true;
      isFootnoteLine[i] = true;
      continue;
    }
    if (inFootnote) {
      if (line.trim() === '' || /^(?: {4}|\t)/.test(line)) {
        isFootnoteLine[i] = true;
      } else {
        inFootnote = false;
      }
    }
  }

  let lastProseIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isFootnoteLine[i] && lines[i]!.trim() !== '') {
      lastProseIdx = i;
      break;
    }
  }

  if (lastProseIdx === -1) {
    // Body holds only footnote definitions: prepend a marker line above them.
    const trimmed = normalized.replace(/^\n+|\n+$/g, '');
    return `[^${label}]\n\n${trimmed}\n\n${defLine}`;
  }

  const targetLine = lines[lastProseIdx]!;
  const isFenceOrRule =
    /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(targetLine) ||
    /^ {0,3}(?:[-*_]\s*){3,}$/.test(targetLine);

  if (isFenceOrRule) {
    lines.splice(lastProseIdx + 1, 0, '', `[^${label}]`);
  } else {
    lines[lastProseIdx] = `${targetLine.replace(/[ \t]+$/, '')}[^${label}]`;
  }

  const withMarker = lines.join('\n').replace(/\n+$/g, '');
  return `${withMarker}\n\n${defLine}`;
}

function matchesWantedLinkTarget(targetPart: string, wantedKey: string): boolean {
  if (noteLinkKey(targetPart) === wantedKey) return true;
  const { note } = parseNoteLinkTarget(targetPart);
  return Boolean(note && noteLinkKey(note) === wantedKey);
}

/**
 * Remove every note-link pointing to `targetTitle` from `body` (outside fenced
 * and inline code spans, leaving `![[embed]]` embeds untouched). When a
 * single-line footnote definition held only that note-link (such as links added
 * by `appendFootnoteNoteLink`), the definition and its inline `[^label]`
 * references are both removed cleanly.
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */
export function removeNoteLink(body: string, targetTitle: string): string {
  const sanitized = noteLinkTarget(targetTitle);
  if (!sanitized) return body;
  const wantedKey = noteLinkKey(sanitized);

  const normalized = body.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const removedFootnotes = new Set<string>();
  const dropLine = new Array<boolean>(lines.length).fill(false);

  const escapedSuggested = SUGGESTED_LINK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkOnlyDefRe = new RegExp(
    `^ {0,3}\\[\\^([^\\]\\s]+)\\]:[ \\t]*\\[\\[([^\\]\\n]+)\\]\\](?:${escapedSuggested})?[ \\t]*$`,
  );
  const inlineLinkRe = new RegExp(`(!?)\\[\\[([^\\]\\n]+)\\]\\](?:${escapedSuggested})?`, 'g');

  // Pass 1: detect single-link footnote definitions targeting wantedKey (skip multi-line defs).
  let fence: Fence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stepped = nextFence(fence, line);
    const wasInFence = fence !== null;
    fence = stepped.fence;
    if (wasInFence || stepped.isFence) continue;
    const m = linkOnlyDefRe.exec(line);
    if (!m) continue;
    // Skip if followed by indented continuation lines belonging to the same footnote definition.
    let nextIdx = i + 1;
    while (nextIdx < lines.length && lines[nextIdx]!.trim() === '') nextIdx++;
    if (nextIdx < lines.length && /^(?: {4}|\t)/.test(lines[nextIdx]!)) continue;
    const rawTarget = m[2]!;
    const pipeIdx = rawTarget.indexOf('|');
    const targetPart = pipeIdx >= 0 ? rawTarget.slice(0, pipeIdx) : rawTarget;
    if (matchesWantedLinkTarget(targetPart, wantedKey)) {
      removedFootnotes.add(m[1]!);
      dropLine[i] = true;
    }
  }

  // Helper: rewrite only outside inline backtick spans on a single line.
  const rewriteOutsideInlineCode = (line: string, fn: (segment: string) => string): string => {
    const parts = line.split(/(`+[^`]*`+)/g);
    for (let j = 0; j < parts.length; j += 2) {
      parts[j] = fn(parts[j]!);
    }
    return parts.join('');
  };

  // Pass 2: strip removed footnote markers and any inline [[Target]] occurrences.
  const keptLines: string[] = [];
  fence = null;
  for (let i = 0; i < lines.length; i++) {
    if (dropLine[i]) continue;
    let line = lines[i]!;
    const stepped = nextFence(fence, line);
    const wasInFence = fence !== null;
    fence = stepped.fence;
    if (!wasInFence && !stepped.isFence) {
      line = rewriteOutsideInlineCode(line, (seg) => {
        let out = seg;
        if (removedFootnotes.size > 0) {
          for (const label of removedFootnotes) {
            const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp(`\\[\\^${escaped}\\](?!:)`, 'g'), '');
          }
        }
        out = out.replace(inlineLinkRe, (full, bang: string, raw: string) => {
          if (bang === '!') return full;
          const pipeIdx = raw.indexOf('|');
          const targetPart = pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw;
          const aliasPart = pipeIdx >= 0 ? raw.slice(pipeIdx + 1) : '';
          if (!matchesWantedLinkTarget(targetPart, wantedKey)) return full;
          return aliasPart;
        });
        return out;
      });
      // Collapse interior double spaces left when an inline link between words was removed,
      // while preserving leading indentation.
      const lead = /^([ \t]*)/.exec(line)?.[1] ?? '';
      line = lead + line.slice(lead.length).replace(/ {2,}/g, ' ').replace(/ +([.,;:?]|!(?!\[))/g, '$1').trimEnd();
      // Clean up a lone line that only held the removed footnote marker or link.
      if (line.trim() === '' && lines[i]!.trim() !== '') {
        continue;
      }
    }
    keptLines.push(line);
  }

  return keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}
