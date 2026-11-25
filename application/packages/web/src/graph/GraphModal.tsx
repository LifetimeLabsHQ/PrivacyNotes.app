import { Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsIn,
  ArrowsOut,
  ArrowsOutSimple,
  Browsers,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  Columns,
  Copy,
  CornersOut,
  Crosshair,
  EnvelopeSimple,
  Folder,
  FolderSimple,
  Graph,
  Intersect,
  LinkSimple,
  LockSimple,
  MapPin,
  NotePencil,
  Pause,
  PenNib,
  Play,
  PushPin,
  PushPinSlash,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Tag,
  Trash,
  User,
  X,
} from '../icons';
import {
  Badge,
  Button,
  Callout,
  CloseButton,
  ContextMenu,
  Divider,
  EmptyState,
  FeedbackButton,
  IconButton,
  IconUpgrade,
  Kbd,
  ListSearchInput,
  Modal,
  Popover,
  RangeSlider,
  SETTINGS_HELP,
  SectionEyebrow,
  SettingsSegmented,
  Snackbar,
  StatusLine,
  Switch,
  useContextMenu,
} from '../ui';
import type { ContextMenuItem } from '../ContextMenu';
import { DockableWindow } from '../ui/DockableWindow';
import { isDemoMode, proUnlocked } from '../demo';
import { KEY_OS } from '../shortcutMatch';
import { noteLinkTarget } from '../noteLinks';
import type { LocalNote } from '../db';
import type { LinkIndex } from '../connectionsIndex';
import type { RelatedWhy } from '../ConnectionsPanel';
import { lazyPart } from '../chunkLoad';
import {
  contactSecondLine,
  formatAddressLines,
  isAddressEmpty,
  parseContactBody,
  smsHref,
  telHref,
} from '../contactBody';
import type { FolderDef } from '../folders';
import { activeLocale } from '../i18n';
import { formatDay, toLocalIso, useDateFormatKey } from '../intlFormat';
import { folderColor, type ItemStyles, type LookColor } from '../itemStyles';
import { FolderGlyph, PathGlyph, TagMark, useItemLook } from '../looks/LookGlyph';
import { osmUrl, readLocation, type NoteLocation } from '../noteLocation';
import { typeGlyph } from '../NoteRow';
import { LocationPanel } from '../notesView/NoteLocationChip';
import { deriveDisplayTitle, deriveExcerpt } from '../notesViewUtils';
import { meaningHits } from '../onDeviceAi';
import { openExternal } from '../openExternal';
import { loadPlaces, type PlaceRow } from '../placeSearch';
import { listOf } from '../scheduleText';
import { sortTags } from '../tagOrder';
import { textMatcher } from '../textMatch';
import { useTheme } from '../theme';
import { useIsTouchDevice } from '../useIsMobile';
import { GraphCanvas, type CanvasEdge, type CanvasNode, type GraphCanvasHandle } from './GraphCanvas';
import type { PlacesMapItem } from './GraphPlacesMap';
import {
  buildGraphSnapshot,
  canStoreNoteLinks,
  clearSavedGraphLayout,
  computeGraphSuggestions,
  isEligibleGraphItem,
  readSavedGraphLayout,
  resolvePlacedItems,
  writeSavedGraphLayout,
  type GraphColorBy,
  type GraphFilters,
  type GraphNode,
  type GraphNodeKind,
  type PlacedItem,
  type RelatedWhyData,
  type SavedGraphLayout,
} from './graphModel';

// Spec: docs/internal/specs/graph-view.md (section 4.6)

export type GraphLens = 'graph' | 'places' | 'inbox';

export const GRAPH_LENS_STORAGE_KEY = 'privacynotes.graph.lens';
const GRAPH_LENS_DEMO_STORAGE_KEY = 'privacynotes.graph.lens.demo';

function activeLensStorageKey(): string {
  return isDemoMode() ? GRAPH_LENS_DEMO_STORAGE_KEY : GRAPH_LENS_STORAGE_KEY;
}

export interface GraphModalProps {
  notes: readonly LocalNote[];
  linkIndex: LinkIndex;
  isNoteLocked: (note: LocalNote) => boolean;
  itemStyles: ItemStyles;
  folders: readonly FolderDef[];
  relatedIndexVersion: number;
  linkSuggestions: boolean;
  dismissedSuggestions: readonly string[];
  initialLens?: GraphLens;
  initialFocusId?: string | null;
  initialRequestTick?: number;
  /** True for Pro accounts (controls Places Pro mark; demo unlocks via proUnlocked). */
  isPro?: boolean;
  /** True when tabs are enabled so the node menu can offer "Open in tab". */
  canNewTab?: boolean;
  canSideBySide?: (noteId: string) => boolean;
  onOpenPlacesUpgrade?: () => void;
  onAddTag?: (noteId: string) => void;
  onOpenNote: (noteId: string, opts?: { newTab?: boolean; sideBySide?: boolean; keepOpen?: boolean }) => void;
  onLinkNotes: (sourceId: string, targetId: string, suggested?: boolean) => Promise<boolean>;
  onUnlinkNotes?: (sourceId: string, targetId: string) => Promise<boolean>;
  onCreateMissingNote: (title: string, opts?: { keepOpen?: boolean }) => Promise<void>;
  onDismissSuggestion: (sourceId: string, targetId: string) => void;
  onUndismissSuggestion?: (sourceId: string, targetId: string) => void;
  onSetItemLocation: (noteId: string, location: NoteLocation | undefined) => Promise<boolean>;
  onClose: () => void;
}

const GraphPlacesMapLazy = lazyPart(() => import('./GraphPlacesMap').then((m) => m.default));

const REPLAY_DURATION_MS = 6000;
const REPLAY_TICK_MS = 66;
const TOAST_MS = 4000;
const INBOX_INITIAL_ROWS = 50;

const KIND_LOOK_COLOR: Partial<Record<GraphNodeKind, LookColor>> = {
  note: 'blue',
  journal: 'purple',
  task: 'orange',
  contact: 'teal',
  link: 'indigo',
  file: 'gray',
  drawing: 'pink',
  event: 'green',
};

function readSavedLens(): GraphLens {
  try {
    const raw = localStorage.getItem(activeLensStorageKey());
    if (raw === 'graph' || raw === 'places' || raw === 'inbox') return raw;
  } catch {
    // Storage unavailable.
  }
  return 'graph';
}

function writeSavedLens(lens: GraphLens): void {
  try {
    localStorage.setItem(activeLensStorageKey(), lens);
  } catch {
    // Storage unavailable.
  }
}

function resolveColorBy(node: GraphNode, colorBy: GraphColorBy): LookColor | null {
  if (colorBy === 'looks') return node.colorKey;
  if (colorBy === 'kind') {
    if (node.kind === 'missing' || node.kind === 'folderHub') return node.colorKey;
    return KIND_LOOK_COLOR[node.kind] ?? node.colorKey;
  }
  if (node.degree >= 5) return 'orange';
  if (node.degree >= 2) return 'blue';
  return null;
}

function formatWhyText(why: RelatedWhyData | RelatedWhy | undefined, t: TFunction): string | undefined {
  if (!why) return undefined;
  if ('sentence' in why) return why.sentence;
  switch (why.kind) {
    case 'words':
      return t('notes:connections.relatedWords', { words: listOf(why.words) });
    case 'linksTo':
      return t('notes:connections.relatedLinksTo', { title: why.viaTitle });
    case 'linkedFrom':
      return t('notes:connections.relatedLinkedFrom', { title: why.viaTitle });
    case 'tag':
      return t('notes:connections.relatedTag', { tag: why.tag });
    case 'meaning':
      return t('notes:connections.relatedMeaning');
  }
}

function NoteGlyph({ note }: { note: LocalNote }) {
  const { iconPaths: paths, icon } = useItemLook(note.id, note.tags, note.folderId);
  const { Icon, color } = typeGlyph(note.type);
  const cls = `shrink-0 ${icon ? '' : color}`;
  if (paths) return <PathGlyph paths={paths} size={16} className={cls} style={icon} />;
  return <Icon aria-hidden="true" className={cls} style={icon} />;
}

export function GraphModal({
  notes,
  linkIndex,
  isNoteLocked,
  itemStyles,
  folders,
  relatedIndexVersion,
  linkSuggestions,
  dismissedSuggestions,
  initialLens,
  initialFocusId = null,
  initialRequestTick = 0,
  isPro = true,
  canNewTab = false,
  canSideBySide,
  onOpenPlacesUpgrade,
  onAddTag,
  onOpenNote,
  onLinkNotes,
  onUnlinkNotes,
  onCreateMissingNote,
  onDismissSuggestion,
  onUndismissSuggestion,
  onSetItemLocation,
  onClose,
}: GraphModalProps) {
  const { t } = useTranslation(['notes', 'common', 'shell', 'media', 'stats', 'auth']);
  const { theme } = useTheme();
  const dark = theme !== 'light';
  const dateFormatKey = useDateFormatKey();
  const locale = activeLocale();
  const isTouch = useIsTouchDevice();
  const placesUnlocked = proUnlocked(isPro);

  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  const focusPinNonceRef = useRef(1);
  const [lens, setLensState] = useState<GraphLens>(() => {
    const start = initialLens ?? readSavedLens();
    return start === 'places' && !placesUnlocked ? 'graph' : start;
  });

  const nodeCtx = useContextMenu();
  const [linkPickerSourceId, setLinkPickerSourceId] = useState<string | null>(null);
  const [linkPickerQuery, setLinkPickerQuery] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [selectedId, setSelectedId] = useState<string | null>(initialFocusId ?? null);
  const [focusPinRequest, setFocusPinRequest] = useState<{ id: string; nonce: number } | null>(
    initialFocusId ? { id: initialFocusId, nonce: 1 } : null,
  );
  const [pendingCanvasFocusId, setPendingCanvasFocusId] = useState<string | null>(initialFocusId ?? null);

  const requestFocusPin = useCallback((id: string | null) => {
    if (!id) {
      setFocusPinRequest(null);
      return;
    }
    focusPinNonceRef.current += 1;
    setFocusPinRequest({ id, nonce: focusPinNonceRef.current });
  }, []);

  const setLens = useCallback((next: GraphLens) => {
    if (next === 'places' && !placesUnlocked) {
      onOpenPlacesUpgrade?.();
      return;
    }
    setCoLocatedIds(null);
    setEditingPlaceForId(null);
    if (next === 'places') {
      setSelectedId((prev) => (prev && (prev.startsWith('missing:') || prev.startsWith('folder:')) ? null : prev));
    }
    setLensState(next);
    writeSavedLens(next);
  }, [placesUnlocked, onOpenPlacesUpgrade]);

  // Sync lens & focus whenever caller explicitly opens or re-targets while mounted (e.g. docked).
  const lastRequestTickRef = useRef(initialRequestTick);
  useEffect(() => {
    const tickChanged = initialRequestTick !== lastRequestTickRef.current;
    lastRequestTickRef.current = initialRequestTick;
    if (tickChanged && initialLens) {
      const targetLens = initialLens === 'places' && !placesUnlocked ? 'graph' : initialLens;
      setLensState(targetLens);
      writeSavedLens(targetLens);
      setCoLocatedIds(null);
      setEditingPlaceForId(null);
    }
    if (initialFocusId && (tickChanged || initialFocusId !== selectedId)) {
      setSelectedId(initialFocusId);
      requestFocusPin(initialFocusId);
      if (initialLens !== 'places') setPendingCanvasFocusId(initialFocusId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only respond to external open/re-target signals.
  }, [initialLens, initialFocusId, initialRequestTick, placesUnlocked, requestFocusPin]);

  // Graph lens controls state
  const [colorBy, setColorBy] = useState<GraphColorBy>('looks');
  const [showNotes, setShowNotes] = useState(true);
  const [showJournals, setShowJournals] = useState(true);
  const [showMissing, setShowMissing] = useState(true);
  const [showOrphans, setShowOrphans] = useState(true);
  const [showSuggested, setShowSuggested] = useState(true);
  const [showArrows, setShowArrows] = useState(true);
  const [showAllLabels, setShowAllLabels] = useState(false);
  const [collapseFolders, setCollapseFolders] = useState(false);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set());
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState<1 | 2>(2);
  const [repelStrength, setRepelStrength] = useState(100);
  const [savedPositions, setSavedPositions] = useState<SavedGraphLayout>(() => readSavedGraphLayout());
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [controlsOpen, setControlsOpen] = useState(false);
  const controlsAnchorRef = useRef<HTMLSpanElement | null>(null);

  // Chronological replay state
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayCutoffMs, setReplayCutoffMs] = useState<number | null>(null);

  // Places lens state
  const [placesState, setPlacesState] = useState<{
    locale: string;
    status: 'idle' | 'loading' | 'ready' | 'error';
    rows: PlaceRow[] | null;
  }>({ locale, status: 'idle', rows: null });
  const [placesRetryTick, setPlacesRetryTick] = useState(0);
  const [placesNotes, setPlacesNotes] = useState(true);
  const [placesJournals, setPlacesJournals] = useState(true);
  const [placesContacts, setPlacesContacts] = useState(true);
  const [visibleMapIds, setVisibleMapIds] = useState<Set<string> | null>(null);
  const [coLocatedIds, setCoLocatedIds] = useState<Set<string> | null>(null);
  const [notOnMapOpen, setNotOnMapOpen] = useState(false);
  const [editingPlaceForId, setEditingPlaceForId] = useState<string | null>(null);

  // Explore list pagination state
  const [orphanLimit, setOrphanLimit] = useState(INBOX_INITIAL_ROWS);
  const [missingLimit, setMissingLimit] = useState(INBOX_INITIAL_ROWS);

  // Brief feedback toast for link / copy / dismiss actions, with optional Undo.
  const [toast, setToast] = useState<{ message: string; undo?: () => void } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), toast.undo ? 6000 : TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Load offline place list when Places lens opens (reloads on locale change or manual retry).
  useEffect(() => {
    if (lens !== 'places') return;
    if (placesState.locale === locale && (placesState.status === 'ready' || placesState.status === 'loading')) return;
    let live = true;
    setPlacesState({ locale, status: 'loading', rows: null });
    loadPlaces(locale).then(
      (rows) => {
        if (live) setPlacesState({ locale, status: 'ready', rows });
      },
      () => {
        if (live) setPlacesState({ locale, status: 'error', rows: null });
      },
    );
    return () => {
      live = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- triggers on lens, locale, or retry tick.
  }, [lens, locale, placesRetryTick]);

  const placeRows = placesState.locale === locale && placesState.status === 'ready' ? placesState.rows : null;

  const notesById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const foldersById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  const folderLabels = useMemo(() => {
    const map = new Map<string, { label: string; colorKey: string | null }>();
    for (const f of folders) {
      map.set(f.id, { label: f.name, colorKey: folderColor(f.id, itemStyles) });
    }
    return map;
  }, [folders, itemStyles]);

  const suggestedEdges = useMemo(() => {
    if (!linkSuggestions) return [];
    return computeGraphSuggestions(
      notes,
      linkIndex,
      isNoteLocked,
      dismissedSuggestions,
      (n, skip, limit) => meaningHits(n, skip, limit),
    );
    // relatedIndexVersion triggers recomputation after the in-memory index finishes building.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, linkIndex, isNoteLocked, dismissedSuggestions, linkSuggestions, relatedIndexVersion]);

  const filters = useMemo<GraphFilters>(
    () => ({
      searchQuery: lens === 'graph' ? deferredSearchQuery : '',
      colorBy,
      showNotes,
      showJournals,
      showMissing,
      showOrphans,
      showSuggested: linkSuggestions && showSuggested,
      collapseFolders,
      expandedFolderIds,
      focusNodeId,
      focusDepth,
      maxCreatedAt: replayOpen ? replayCutoffMs : null,
    }),
    [
      lens,
      deferredSearchQuery,
      colorBy,
      showNotes,
      showJournals,
      showMissing,
      showOrphans,
      linkSuggestions,
      showSuggested,
      collapseFolders,
      expandedFolderIds,
      focusNodeId,
      focusDepth,
      replayOpen,
      replayCutoffMs,
    ],
  );

  // Only persist settled layout coordinates when the full unfiltered graph is visible,
  // so filtered/replay/collapsed views never wipe saved or pinned positions of hidden notes.
  const canPersistFullLayout =
    lens === 'graph' &&
    !replayOpen &&
    !collapseFolders &&
    !focusNodeId &&
    !deferredSearchQuery.trim() &&
    showNotes &&
    showJournals &&
    showOrphans &&
    showMissing;
  const canPersistFullLayoutRef = useRef(canPersistFullLayout);
  canPersistFullLayoutRef.current = canPersistFullLayout;

  const snapshot = useMemo(
    () =>
      buildGraphSnapshot({
        notes,
        linkIndex,
        isNoteLocked,
        itemStyles,
        folders,
        suggestedEdges,
        filters,
      }),
    [notes, linkIndex, isNoteLocked, itemStyles, folders, suggestedEdges, filters],
  );

  const timeRange = snapshot.timeRange;
  const hasTimeline = Boolean(timeRange && timeRange.min < timeRange.max);

  // Focus a requested node on the Graph canvas after lens/filters settle.
  useEffect(() => {
    if (lens !== 'graph' || !pendingCanvasFocusId) return;
    if (!snapshot.nodes.some((n) => n.id === pendingCanvasFocusId)) return;
    const id = pendingCanvasFocusId;
    setPendingCanvasFocusId(null);
    const frame = requestAnimationFrame(() => canvasRef.current?.focusNode(id, true));
    return () => cancelAnimationFrame(frame);
  }, [lens, pendingCanvasFocusId, snapshot.nodes]);

  // Smooth chronological replay over ~6 seconds when playing (throttled to ~15 Hz to keep large vaults responsive).
  useEffect(() => {
    if (!replayOpen || !replayPlaying || !timeRange || timeRange.min >= timeRange.max) return;
    const span = timeRange.max - timeRange.min;
    const startCutoff =
      replayCutoffMs === null || replayCutoffMs >= timeRange.max ? timeRange.min : replayCutoffMs;
    const startOffsetFraction = Math.max(0, Math.min(1, (startCutoff - timeRange.min) / span));
    const startTime = performance.now() - startOffsetFraction * REPLAY_DURATION_MS;
    let raf = 0;
    let lastEmit = 0;

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startTime) / REPLAY_DURATION_MS);
      if (progress >= 1 || now - lastEmit >= REPLAY_TICK_MS) {
        lastEmit = now;
        setReplayCutoffMs(Math.round(timeRange.min + span * progress));
      }
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setReplayPlaying(false);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Only restart the animation loop when playback toggles or range bounds change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayOpen, replayPlaying, timeRange?.min, timeRange?.max]);

  const canvasNodes = useMemo<CanvasNode[]>(
    () =>
      snapshot.nodes.map((node) => ({
        id: node.id,
        noteId: node.noteId,
        folderId: node.folderId,
        title: node.title,
        kind: node.kind,
        colorKey: resolveColorBy(node, colorBy),
        tags: node.tags,
        degree: node.degree,
        inCount: node.inCount,
        outCount: node.outCount,
        memberCount: node.memberCount,
        snippet: node.snippet,
      })),
    [snapshot.nodes, colorBy],
  );

  const canvasEdges = useMemo<CanvasEdge[]>(
    () =>
      snapshot.edges.map((edge) => ({
        key: edge.key,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        why: edge.why,
        whyText: edge.kind === 'smart' ? formatWhyText(edge.why, t) : undefined,
      })),
    [snapshot.edges, t],
  );

  const searchMatchIds = useMemo<ReadonlySet<string> | null>(() => {
    if (lens !== 'graph' || !deferredSearchQuery.trim()) return null;
    return new Set(snapshot.nodes.map((n) => n.id));
  }, [lens, deferredSearchQuery, snapshot.nodes]);

  // Places resolution (also used to show a place chip on matched contacts in Graph inspector)
  const placesResult = useMemo(
    () =>
      resolvePlacedItems(notes, isNoteLocked, itemStyles, folders, placeRows, {
        showNotes: lens === 'places' ? placesNotes : true,
        showJournals: lens === 'places' ? placesJournals : true,
        showContacts: lens === 'places' ? placesContacts : true,
        searchQuery: lens === 'places' ? deferredSearchQuery : '',
      }),
    [notes, isNoteLocked, itemStyles, folders, placeRows, lens, placesNotes, placesJournals, placesContacts, deferredSearchQuery],
  );

  const placedById = useMemo(
    () => new Map<string, PlacedItem>(placesResult.placed.map((p) => [p.id, p])),
    [placesResult.placed],
  );

  // Clear stale selection in Places when the active item is not a placed pin (e.g. filtered out or unplaced note from Graph).
  useEffect(() => {
    if (lens !== 'places' || !selectedId) return;
    if (editingPlaceForId === selectedId) return;
    if (placesState.status === 'loading') return;
    if (!placedById.has(selectedId)) {
      setSelectedId(null);
    }
  }, [lens, selectedId, editingPlaceForId, placesState.status, placedById]);

  // Clear co-located filter whenever Places search or filter toggles change.
  useEffect(() => {
    if (lens === 'places') setCoLocatedIds(null);
  }, [lens, deferredSearchQuery, placesNotes, placesJournals, placesContacts]);

  const mapItems = useMemo<PlacesMapItem[]>(
    () =>
      placesResult.placed.map((item) => ({
        id: item.id,
        title: item.title,
        kind: item.kind,
        lat: item.location.lat,
        lng: item.location.lng,
        label: item.location.label,
        exact: item.exact,
        initials: item.initials,
        colorKey: item.colorKey,
      })),
    [placesResult.placed],
  );

  const areaItems = useMemo(() => {
    const activeSet = coLocatedIds ?? visibleMapIds;
    if (!activeSet) return placesResult.placed;
    return placesResult.placed.filter((item) => activeSet.has(item.id));
  }, [placesResult.placed, coLocatedIds, visibleMapIds]);

  // Filtered Inbox lists
  const filteredInbox = useMemo(() => {
    const q = deferredSearchQuery.trim();
    if (lens !== 'inbox' || !q) return snapshot.inbox;
    const match = textMatcher(q);
    return {
      suggested: snapshot.inbox.suggested.filter(
        (pair) =>
          Boolean(match(pair.sourceTitle)) ||
          Boolean(match(pair.targetTitle)) ||
          Boolean(formatWhyText(pair.why, t) && match(formatWhyText(pair.why, t)!)),
      ),
      missing: snapshot.inbox.missing.filter((m) => Boolean(match(m.name))),
      orphans: snapshot.inbox.orphans.filter(
        (n) => Boolean(match(n.title)) || Boolean(match(n.snippet)) || n.tags.some((tag) => Boolean(match(tag))),
      ),
      hubs: snapshot.inbox.hubs.filter(
        (n) => Boolean(match(n.title)) || Boolean(match(n.snippet)) || n.tags.some((tag) => Boolean(match(tag))),
      ),
    };
  }, [lens, deferredSearchQuery, snapshot.inbox, t]);

  useEffect(() => {
    setOrphanLimit(INBOX_INITIAL_ROWS);
    setMissingLimit(INBOX_INITIAL_ROWS);
  }, [deferredSearchQuery, lens]);

  const handleUnlinkNotes = useCallback(
    async (sourceId: string, targetId: string, allowUndo = true) => {
      if (!onUnlinkNotes) return false;
      const ok = await onUnlinkNotes(sourceId, targetId);
      const src = notesById.get(sourceId);
      const tgt = notesById.get(targetId);
      if (ok && src && tgt && isEligibleGraphItem(src, isNoteLocked) && isEligibleGraphItem(tgt, isNoteLocked)) {
        setToast({
          message: t('notes:graph.unlinkedToast', {
            source: deriveDisplayTitle(src, false),
            target: deriveDisplayTitle(tgt, false),
          }),
          ...(allowUndo ? { undo: () => void onLinkNotes(sourceId, targetId, false) } : {}),
        });
      }
      return ok;
    },
    [onUnlinkNotes, onLinkNotes, notesById, isNoteLocked, t],
  );

  const handleLinkNotes = useCallback(
    async (sourceId: string, targetId: string, suggested = false) => {
      let fromId = sourceId;
      let toId = targetId;
      // If source cannot store note-links (e.g. a drawing, file, or read-only item) and target can,
      // flip the direction so Option/Alt+drag and suggested bridges still connect the two items.
      const s = notesById.get(sourceId);
      const tg = notesById.get(targetId);
      const sWritable = Boolean(s && s.locked !== 1 && canStoreNoteLinks(s.type));
      const tWritable = Boolean(tg && tg.locked !== 1 && canStoreNoteLinks(tg.type));
      if (!sWritable && tWritable) {
        fromId = targetId;
        toId = sourceId;
      }
      const ok = await onLinkNotes(fromId, toId, suggested);
      const src = notesById.get(fromId);
      const tgt = notesById.get(toId);
      if (ok && src && tgt && isEligibleGraphItem(src, isNoteLocked) && isEligibleGraphItem(tgt, isNoteLocked)) {
        setToast({
          message: t('notes:graph.linkedToast', {
            source: deriveDisplayTitle(src, false),
            target: deriveDisplayTitle(tgt, false),
          }),
          ...(onUnlinkNotes ? { undo: () => void handleUnlinkNotes(fromId, toId, false) } : {}),
        });
      } else if (!ok && src && isEligibleGraphItem(src, isNoteLocked)) {
        if (src.locked === 1) {
          setToast({
            message: t('notes:graph.linkReadOnlyToast', {
              title: deriveDisplayTitle(src, false),
            }),
          });
        } else if (!canStoreNoteLinks(src.type)) {
          setToast({
            message: t('notes:graph.linkUnsupportedToast'),
          });
        }
      }
      return ok;
    },
    [onLinkNotes, onUnlinkNotes, handleUnlinkNotes, notesById, isNoteLocked, t],
  );

  const handleDismissSuggestion = useCallback(
    (sourceId: string, targetId: string) => {
      onDismissSuggestion(sourceId, targetId);
      const src = notesById.get(sourceId);
      const tgt = notesById.get(targetId);
      if (src && tgt && isEligibleGraphItem(src, isNoteLocked) && isEligibleGraphItem(tgt, isNoteLocked)) {
        setToast({
          message: t('notes:graph.dismissedToast', {
            source: deriveDisplayTitle(src, false),
            target: deriveDisplayTitle(tgt, false),
          }),
          ...(onUndismissSuggestion ? { undo: () => onUndismissSuggestion(sourceId, targetId) } : {}),
        });
      }
    },
    [onDismissSuggestion, onUndismissSuggestion, notesById, isNoteLocked, t],
  );

  const handleResetLayout = useCallback(() => {
    clearSavedGraphLayout();
    setSavedPositions({});
    setLayoutEpoch((e) => e + 1);
  }, []);

  const handlePositionsSettled = useCallback((positions: Map<string, { x: number; y: number; pinned: boolean }>) => {
    if (!canPersistFullLayoutRef.current) return;
    setSavedPositions((prev) => {
      const merged: SavedGraphLayout = { ...prev };
      for (const [id, pos] of positions) {
        merged[id] = { x: Math.round(pos.x), y: Math.round(pos.y), pinned: Boolean(pos.pinned) };
      }
      writeSavedGraphLayout(merged);
      return merged;
    });
  }, []);

  const handleTogglePinNode = useCallback((id: string, pinned: boolean) => {
    const live = canvasRef.current?.getNodePosition(id);
    setSavedPositions((prev) => {
      const existing = live ?? prev[id] ?? { x: 0, y: 0, pinned: false };
      const next: SavedGraphLayout = { ...prev, [id]: { x: existing.x, y: existing.y, pinned } };
      writeSavedGraphLayout(next);
      return next;
    });
  }, []);

  const handleUnpinNode = useCallback((id: string) => handleTogglePinNode(id, false), [handleTogglePinNode]);

  const jumpToPlace = useCallback(
    (id: string) => {
      if (!placesUnlocked) {
        onOpenPlacesUpgrade?.();
        return;
      }
      setCoLocatedIds(null);
      setSelectedId(id);
      requestFocusPin(id);
      setEditingPlaceForId(null);
      setLens('places');
    },
    [placesUnlocked, onOpenPlacesUpgrade, requestFocusPin, setLens],
  );

  const focusGraphNode = useCallback(
    (id: string, depth: 1 | 2 = 2) => {
      setFocusNodeId(id);
      setFocusDepth(depth);
      setSelectedId(id);
      setPendingCanvasFocusId(id);
      setLens('graph');
    },
    [setLens],
  );

  const jumpToGraphNode = useCallback(
    (id: string, ensureOrphans = false) => {
      if (ensureOrphans) setShowOrphans(true);
      setFocusNodeId(null);
      setSelectedId(id);
      setPendingCanvasFocusId(id);
      setLens('graph');
    },
    [setLens],
  );

  const handleEscape = useCallback(() => {
    if (editingPlaceForId) {
      setEditingPlaceForId(null);
      return;
    }
    if (searchQuery.trim()) {
      setSearchQuery('');
      return;
    }
    if (selectedId) {
      setSelectedId(null);
      return;
    }
    onClose();
  }, [editingPlaceForId, searchQuery, selectedId, onClose]);

  // Stats for Graph bottom status bar
  const graphStats = useMemo(() => {
    let realCount = 0;
    for (const n of snapshot.nodes) {
      if (n.kind === 'folderHub') realCount += n.memberCount ?? 0;
      else if (n.kind !== 'missing') realCount += 1;
    }
    let linkCount = 0;
    let smartCount = 0;
    for (const e of snapshot.edges) {
      if (e.kind === 'smart') smartCount += 1;
      else linkCount += 1;
    }
    return { realCount, linkCount, smartCount };
  }, [snapshot.nodes, snapshot.edges]);

  // Selected entity resolution for shared Inspector card
  const selectedGraphNode = useMemo(
    () => (selectedId ? snapshot.nodes.find((n) => n.id === selectedId) ?? null : null),
    [snapshot.nodes, selectedId],
  );

  const selectedMissing = useMemo(
    () =>
      selectedId?.startsWith('missing:')
        ? snapshot.inbox.missing.find((m) => m.id === selectedId) ?? null
        : null,
    [snapshot.inbox.missing, selectedId],
  );

  const selectedRealNote = useMemo(() => {
    if (!selectedId || selectedId.startsWith('missing:') || selectedId.startsWith('folder:')) return null;
    const note = notesById.get(selectedId);
    if (!note || !isEligibleGraphItem(note, isNoteLocked)) return null;
    return note;
  }, [selectedId, notesById, isNoteLocked]);

  const selectedConnections = useMemo(() => {
    if (!selectedRealNote) return null;
    const isVisible = (n: LocalNote | undefined): n is LocalNote =>
      Boolean(n && isEligibleGraphItem(n, isNoteLocked));
    const from = (linkIndex.incoming.get(selectedRealNote.id) ?? [])
      .map((id) => notesById.get(id))
      .filter(isVisible);
    const to = (linkIndex.outgoing.get(selectedRealNote.id)?.ids ?? [])
      .map((id) => notesById.get(id))
      .filter(isVisible);
    const suggested = snapshot.inbox.suggested
      .filter((pair) => pair.sourceId === selectedRealNote.id || pair.targetId === selectedRealNote.id)
      .map((pair) => {
        const otherId = pair.sourceId === selectedRealNote.id ? pair.targetId : pair.sourceId;
        const otherNote = notesById.get(otherId);
        return otherNote && isVisible(otherNote)
          ? { key: pair.key, otherNote, whyText: formatWhyText(pair.why, t) }
          : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return { from, to, suggested };
  }, [selectedRealNote, linkIndex, notesById, isNoteLocked, snapshot.inbox.suggested, t]);

  const focusNodeTitle = useMemo(() => {
    if (!focusNodeId) return '';
    const n = notesById.get(focusNodeId);
    if (n && isEligibleGraphItem(n, isNoteLocked)) return deriveDisplayTitle(n, false);
    const g = snapshot.nodes.find((node) => node.id === focusNodeId);
    return g?.title ?? '';
  }, [focusNodeId, notesById, isNoteLocked, snapshot.nodes]);

  const effectiveReplayMs = timeRange ? (replayCutoffMs ?? timeRange.max) : null;
  const replayDateLabel = useMemo(() => {
    if (effectiveReplayMs === null) return '';
    // Referencing dateFormatKey ensures the formatted label updates if date preferences change.
    void dateFormatKey;
    return formatDay(toLocalIso(new Date(effectiveReplayMs)), 'date');
  }, [effectiveReplayMs, dateFormatKey]);

  const lensOptions = useMemo(
    () => [
      { value: 'graph' as const, label: t('notes:footer.graph') },
      {
        value: 'places' as const,
        label: (
          <span className="inline-flex items-center gap-1">
            {t('notes:graph.lensPlaces')}
            {!isPro && <IconUpgrade size={10} />}
          </span>
        ),
      },
      { value: 'inbox' as const, label: t('stats:wellness.subTabs.explore') },
    ],
    [t, isPro],
  );

  const colorByOptions = useMemo(
    () => [
      { value: 'looks' as const, label: t('notes:graph.colorLooks') },
      { value: 'kind' as const, label: t('notes:graph.colorKind') },
      { value: 'hubs' as const, label: t('notes:graph.colorHubs') },
    ],
    [t],
  );

  const depthOptions = useMemo(
    () => [
      { value: '1' as const, label: t('notes:graph.hop1') },
      { value: '2' as const, label: t('notes:graph.hop2') },
    ],
    [t],
  );

  const renderInspector = (placement: 'overlay' | 'inline', compact: boolean, docked: boolean) => {
    if (!selectedId) return null;

    const closeInspector = () => {
      setSelectedId(null);
      setEditingPlaceForId(null);
    };

    const shellClass =
      placement === 'overlay'
        ? compact
          ? 'absolute inset-x-2 bottom-2 z-20 flex max-h-[55%] flex-col gap-2.5 overflow-y-auto rounded-lg border border-divider bg-surface-2 p-3.5 shadow-lg'
          : 'absolute top-3 end-3 z-20 flex w-80 max-h-[calc(100%-4rem)] flex-col gap-2.5 overflow-y-auto rounded-lg border border-divider bg-surface-2 p-3.5 shadow-lg'
        : compact
          ? 'flex shrink-0 flex-col gap-2.5 border-b border-divider bg-surface-1 p-3.5'
          : 'flex max-h-[55%] shrink-0 flex-col gap-2.5 overflow-y-auto border-b border-divider bg-surface-1 p-3.5';

    // 1. Missing note-link node
    if (selectedId.startsWith('missing:')) {
      const title = selectedMissing?.name ?? selectedGraphNode?.title ?? selectedId.slice('missing:'.length);
      const referrers = (selectedMissing?.referrerIds ?? [])
        .map((id) => notesById.get(id))
        .filter((n): n is LocalNote => Boolean(n && isEligibleGraphItem(n, isNoteLocked)));
      return (
        <aside aria-label={title} className={shellClass}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <LinkSimple className="shrink-0 text-pn-muted" aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-body font-semibold text-pn" dir="auto">
                  {title}
                </p>
                <p className="text-small text-pn-muted">{t('notes:graph.missingHint')}</p>
              </div>
            </div>
            <CloseButton onClick={closeInspector} className="-me-1 -mt-1" />
          </div>
          {referrers.length > 0 && (
            <div className="flex flex-col gap-1">
              <SectionEyebrow>{t('notes:connections.linkedFrom')}</SectionEyebrow>
              <ul className="flex flex-col gap-0.5">
                {referrers.map((refNote) => (
                  <li key={refNote.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(refNote.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-small text-pn-soft transition hover:bg-pn/5 hover:text-pn"
                    >
                      <NoteGlyph note={refNote} />
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {deriveDisplayTitle(refNote, false)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button action="create" onClick={() => void (docked ? onCreateMissingNote(title, { keepOpen: true }) : onCreateMissingNote(title))}>
              {t('notes:createNote.confirm')}
            </Button>
          </div>
        </aside>
      );
    }

    // 2. Collapsed folder hub node
    if (selectedId.startsWith('folder:')) {
      const folderId = selectedGraphNode?.folderId ?? selectedId.slice('folder:'.length);
      const folder = foldersById.get(folderId);
      const title = folder?.name ?? selectedGraphNode?.title ?? folderId;
      const memberCount = selectedGraphNode?.memberCount ?? 0;
      return (
        <aside aria-label={title} className={shellClass}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Folder className="shrink-0 text-accent" aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-body font-semibold text-pn" dir="auto">
                  {title}
                </p>
                <Badge tone="info">{t('common:quickSwitcher.tagItems', { count: memberCount })}</Badge>
              </div>
            </div>
            <CloseButton onClick={closeInspector} className="-me-1 -mt-1" />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="primary"
              icon={<ArrowsOutSimple aria-hidden="true" />}
              onClick={() => {
                setExpandedFolderIds((prev) => new Set(prev).add(folderId));
                setSelectedId(null);
              }}
            >
              {t('notes:graph.expandFolder')}
            </Button>
          </div>
        </aside>
      );
    }

    // 3. Real item (in Graph lens, only inspect nodes currently present on the canvas)
    if (!selectedRealNote) return null;
    if (lens === 'graph' && !selectedGraphNode) return null;

    const note = selectedRealNote;
    const title = deriveDisplayTitle(note, false);
    const folder = note.folderId ? foldersById.get(note.folderId) : undefined;
    const exactLoc = readLocation(note.trackers);
    const placedMatch = placedById.get(note.id);
    const activeLoc = exactLoc ?? placedMatch?.location;
    const isContact = note.type === 'contact';
    const contact = isContact ? parseContactBody(note.body) : null;
    const contactSub = contact ? contactSecondLine(contact) : '';
    const firstAddr = contact?.addresses.find((a) => !isAddressEmpty(a));
    const addressSummary = placedMatch?.addressSummary ?? (firstAddr ? formatAddressLines(firstAddr).join(', ') : '');
    const excerpt = isContact ? contactSub : deriveExcerpt(note, false);
    const isFocused = focusNodeId === note.id;
    const isPinned = Boolean(savedPositions[note.id]?.pinned);
    const isEditingPlace = editingPlaceForId === note.id;
    const sortedTags = sortTags(note.tags);
    const shownTags = sortedTags.slice(0, 6);
    const hiddenTagCount = sortedTags.length - shownTags.length;

    return (
      <aside aria-label={title} className={shellClass}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <NoteGlyph note={note} />
              <p className="min-w-0 truncate text-body font-semibold text-pn" dir="auto">
                {title}
              </p>
            </div>
            {(folder || sortedTags.length > 0 || activeLoc) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {folder && (
                  <span className="inline-flex max-w-[12rem] items-center gap-1 rounded px-1.5 py-0.5 text-meta font-medium pn-chip text-accent-strong">
                    <FolderGlyph folderId={folder.id} size={11} className="shrink-0 text-label" />
                    <span className="truncate" dir="auto">{folder.name}</span>
                  </span>
                )}
                {activeLoc && (
                  <button
                    type="button"
                    aria-label={t('notes:location.showOnMap')}
                    onClick={lens === 'graph' ? () => jumpToPlace(note.id) : () => requestFocusPin(note.id)}
                    className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-meta font-medium pn-chip pn-chip-pick text-accent-strong transition"
                  >
                    <MapPin size={11} aria-hidden="true" className="shrink-0" />
                    <span className="truncate" dir="auto">
                      {activeLoc.label ?? `${activeLoc.lat.toFixed(2)}, ${activeLoc.lng.toFixed(2)}`}
                    </span>
                    {!isPro && lens === 'graph' && <IconUpgrade size={9} />}
                  </button>
                )}
                {placedMatch && !placedMatch.exact && (
                  <Badge tone="info">{t('notes:graph.townMatchBadge')}</Badge>
                )}
                {shownTags.map((tag) => (
                  <span
                    key={tag}
                    dir="auto"
                    className="inline-flex max-w-[11rem] items-center rounded-full bg-accent/10 px-2 py-0.5 text-meta font-medium text-accent-strong"
                  >
                    <TagMark tag={tag} size={11} />
                    <span className="truncate">{tag}</span>
                  </span>
                ))}
                {hiddenTagCount > 0 && (
                  <span className="inline-flex items-center rounded-full bg-pn/6 px-2 py-0.5 text-meta text-pn-muted">
                    {t('shell:calendar.more', { count: hiddenTagCount })}
                  </span>
                )}
              </div>
            )}
          </div>
          <CloseButton onClick={closeInspector} className="-me-1.5 -mt-1 shrink-0" />
        </div>

        {excerpt && (
          <p
            className={
              note.type === 'link' || /^https?:\/\//i.test(excerpt)
                ? 'truncate text-small text-pn-muted'
                : 'line-clamp-2 text-small text-pn-soft'
            }
            dir="auto"
          >
            {excerpt}
          </p>
        )}
        {addressSummary && (
          <p className="truncate text-small text-pn-muted" dir="auto">
            {addressSummary}
          </p>
        )}

        {/* Single balanced action row */}
        <div className="flex items-center gap-1.5 pt-0.5">
          <Button
            action="open"
            variant="primary"
            className="flex-1 justify-center"
            onClick={() => (docked ? onOpenNote(note.id, { keepOpen: true }) : onOpenNote(note.id))}
          >
            {t('shell:contacts.open')}
          </Button>
          {canSideBySide?.(note.id) && (
            <IconButton
              label={t('shell:contextMenu.openSideBySide')}
              position="below-end"
              onClick={() => onOpenNote(note.id, { sideBySide: true, ...(docked ? { keepOpen: true } : {}) })}
            >
              <Columns aria-hidden="true" />
            </IconButton>
          )}
          {lens === 'graph' && (
            <IconButton
              label={isFocused ? t('notes:graph.clearFocus') : t('notes:graph.focus2Hop')}
              tone={isFocused ? 'accent' : 'quiet'}
              aria-pressed={isFocused}
              position="below-end"
              className={isFocused ? 'bg-accent/12' : ''}
              onClick={() => {
                if (isFocused) setFocusNodeId(null);
                else {
                  setFocusNodeId(note.id);
                  setFocusDepth(2);
                }
              }}
            >
              <Crosshair aria-hidden="true" />
            </IconButton>
          )}
          {lens === 'graph' && isPinned && (
            <IconButton
              label={t('notes:graph.unpinPosition')}
              position="below-end"
              onClick={() => handleUnpinNode(note.id)}
            >
              <PushPinSlash aria-hidden="true" />
            </IconButton>
          )}
          {lens === 'places' && note.locked !== 1 && !isEditingPlace && (
            <IconButton
              label={exactLoc ? t('common:actions.edit') : t('notes:graph.setPlace')}
              position="below-end"
              onClick={() => setEditingPlaceForId(note.id)}
            >
              <MapPin aria-hidden="true" />
            </IconButton>
          )}
        </div>

        {/* Contact quick actions & OpenStreetMap */}
        {(isContact || (lens === 'places' && activeLoc)) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {contact?.phones[0] && (
              <>
                <Button
                  action="open"
                  onClick={() => openExternal(telHref(contact.phones[0]!.value))}
                >
                  {t('shell:contacts.call')}
                </Button>
                <Button
                  action="open"
                  onClick={() => openExternal(smsHref(contact.phones[0]!.value))}
                >
                  {t('shell:contacts.message')}
                </Button>
              </>
            )}
            {contact?.emails[0] && (
              <Button
                icon={<EnvelopeSimple aria-hidden="true" />}
                onClick={() => openExternal(`mailto:${contact.emails[0]!.value}`)}
              >
                {t('shell:contacts.sendEmail')}
              </Button>
            )}
            {activeLoc && (
              <Button
                action="open"
                aria-label={t('notes:location.openOsm')}
                onClick={() => openExternal(osmUrl(activeLoc.lat, activeLoc.lng), { browser: true })}
              >
                OpenStreetMap
              </Button>
            )}
          </div>
        )}

        {/* Inline LocationPanel editor on Places lens */}
        {lens === 'places' && isEditingPlace && (
          <div className="rounded-md border border-divider bg-surface-2 p-2">
            <LocationPanel
              place={exactLoc}
              readOnly={note.locked === 1}
              startEditing={true}
              onSave={(loc) => onSetItemLocation(note.id, loc)}
              onRemove={exactLoc ? () => onSetItemLocation(note.id, undefined) : undefined}
              onDone={() => setEditingPlaceForId(null)}
            />
          </div>
        )}

        {/* Connections summary */}
        {lens === 'graph' && selectedConnections && (
          selectedConnections.from.length > 0 ||
          selectedConnections.to.length > 0 ||
          selectedConnections.suggested.length > 0
        ) && (
          <div className="flex flex-col gap-2.5 border-t border-divider pt-2.5">
            {selectedConnections.from.length > 0 && (
              <div className="flex flex-col gap-1">
                <SectionEyebrow icon={ArrowsIn}>
                  {t('notes:connections.linkedFrom')} ({selectedConnections.from.length})
                </SectionEyebrow>
                <ul className="flex flex-col gap-0.5">
                  {selectedConnections.from.slice(0, 6).map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(n.id)}
                        className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-start text-small text-pn-soft transition hover:bg-pn/5 hover:text-pn"
                      >
                        <NoteGlyph note={n} />
                        <span className="min-w-0 flex-1 truncate" dir="auto">
                          {deriveDisplayTitle(n, false)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selectedConnections.to.length > 0 && (
              <div className="flex flex-col gap-1">
                <SectionEyebrow icon={ArrowsOut}>
                  {t('notes:connections.linksTo')} ({selectedConnections.to.length})
                </SectionEyebrow>
                <ul className="flex flex-col gap-0.5">
                  {selectedConnections.to.slice(0, 6).map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(n.id)}
                        className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-start text-small text-pn-soft transition hover:bg-pn/5 hover:text-pn"
                      >
                        <NoteGlyph note={n} />
                        <span className="min-w-0 flex-1 truncate" dir="auto">
                          {deriveDisplayTitle(n, false)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selectedConnections.suggested.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <SectionEyebrow icon={Intersect}>
                  {t('notes:connections.related')} ({selectedConnections.suggested.length})
                </SectionEyebrow>
                <ul className="flex flex-col gap-1.5">
                  {selectedConnections.suggested.slice(0, 4).map((entry) => (
                    <li
                      key={entry.key}
                      className="flex flex-col gap-1 rounded-md border border-dashed border-divider bg-surface-1 p-2"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedId(entry.otherNote.id)}
                        className="flex w-full items-center gap-1.5 text-start text-small font-medium text-pn hover:text-accent"
                      >
                        <NoteGlyph note={entry.otherNote} />
                        <span className="min-w-0 flex-1 truncate" dir="auto">
                          {deriveDisplayTitle(entry.otherNote, false)}
                        </span>
                      </button>
                      {entry.whyText && (
                        <p className="text-meta text-pn-muted" dir="auto">
                          {entry.whyText}
                        </p>
                      )}
                      <div className="flex items-center gap-1">
                        <Button
                          variant="primary"
                          icon={<LinkSimple aria-hidden="true" />}
                          onClick={() => void handleLinkNotes(note.id, entry.otherNote.id, true)}
                        >
                          {t('notes:graph.linkNotes')}
                        </Button>
                        <IconButton
                          label={t('notes:connections.notRelated')}
                          onClick={() => handleDismissSuggestion(note.id, entry.otherNote.id)}
                        >
                          <X aria-hidden="true" />
                        </IconButton>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </aside>
    );
  };

  return (
    <DockableWindow
      storagePrefix="privacynotes.graph"
      icon={<Graph size={16} />}
      title={t('notes:graph.workspaceTitle')}
      onClose={onClose}
      onEscape={handleEscape}
      noAppMenu
      normalClassName="h-[min(90vh,56rem)] max-w-6xl"
    >
      {({ docked, isMobile }) => {
        const compact = isMobile || docked;
        const openNote = (noteId: string, opts?: { newTab?: boolean; sideBySide?: boolean }) => {
          if (docked) onOpenNote(noteId, { ...opts, keepOpen: true });
          else if (opts) onOpenNote(noteId, opts);
          else onOpenNote(noteId);
        };
        const openNodeContextMenu = (nodeId: string, clientX: number, clientY: number) => {
          const synth = { clientX, clientY, preventDefault() {}, stopPropagation() {} };
          if (nodeId.startsWith('missing:')) {
            const missing = snapshot.inbox.missing.find((m) => m.id === nodeId);
            const name = missing?.name ?? nodeId.slice('missing:'.length);
            const items: ContextMenuItem[] = [
              { type: 'header', label: name, keepCase: true },
              {
                label: t('notes:createNote.confirm'),
                icon: <NotePencil size={16} aria-hidden="true" />,
                onSelect: () => void (docked ? onCreateMissingNote(name, { keepOpen: true }) : onCreateMissingNote(name)),
              },
              {
                label: t('shell:shortcut.copyNoteLink'),
                icon: <Copy size={16} aria-hidden="true" />,
                onSelect: () => {
                  void navigator.clipboard?.writeText(`[[${noteLinkTarget(name)}]]`);
                  setToast({ message: t('shell:shortcut.copiedNoteLink') });
                },
              },
            ];
            nodeCtx.open(synth, items);
            return;
          }
          if (nodeId.startsWith('folder:')) {
            const fid = nodeId.slice('folder:'.length);
            const folder = foldersById.get(fid);
            const items: ContextMenuItem[] = [
              { type: 'header', label: folder?.name ?? fid, keepCase: true },
              {
                label: t('notes:graph.expandFolder'),
                icon: <ArrowsOutSimple size={16} aria-hidden="true" />,
                onSelect: () => setExpandedFolderIds((prev) => new Set(prev).add(fid)),
              },
            ];
            nodeCtx.open(synth, items);
            return;
          }

          const note = notesById.get(nodeId);
          if (!note || !isEligibleGraphItem(note, isNoteLocked)) return;
          const title = deriveDisplayTitle(note, false);
          const isFocused = focusNodeId === note.id;
          const isPinned = Boolean(savedPositions[note.id]?.pinned);
          const editable = note.locked !== 1 && canStoreNoteLinks(note.type);
          const hasPlace = Boolean(readLocation(note.trackers) ?? placedById.get(note.id));

          const items: ContextMenuItem[] = [
            { type: 'header', label: title, keepCase: true },
            {
              label: t('shell:contacts.open'),
              icon: <ArrowSquareOut size={16} aria-hidden="true" />,
              onSelect: () => openNote(note.id),
            },
          ];
          if (canNewTab) {
            items.push({
              label: t('shell:contextMenu.openInTab'),
              icon: <Browsers size={16} aria-hidden="true" />,
              onSelect: () => openNote(note.id, { newTab: true }),
            });
          }
          if (canSideBySide?.(note.id)) {
            items.push({
              label: t('shell:contextMenu.openSideBySide'),
              icon: <Columns size={16} aria-hidden="true" />,
              onSelect: () => openNote(note.id, { sideBySide: true }),
            });
          }
          items.push({ type: 'separator' });
          items.push({
            label: isFocused ? t('notes:graph.clearFocus') : t('notes:graph.focus2Hop'),
            icon: <Crosshair size={16} aria-hidden="true" />,
            onSelect: () => {
              if (isFocused) setFocusNodeId(null);
              else {
                setFocusNodeId(note.id);
                setFocusDepth(2);
              }
            },
          });
          if (editable) {
            items.push({
              label: t('notes:graph.linkTo'),
              icon: <LinkSimple size={16} aria-hidden="true" />,
              onSelect: () => {
                setLinkPickerQuery('');
                setLinkPickerSourceId(note.id);
              },
            });
          }
          if (onAddTag) {
            items.push({
              label: t('shell:selectionToolbar.tag'),
              icon: <Tag size={16} aria-hidden="true" />,
              onSelect: () => onAddTag(note.id),
            });
          }
          items.push({
            label: isPinned ? t('notes:graph.unpinPosition') : t('notes:graph.pinPosition'),
            icon: isPinned ? <PushPinSlash size={16} aria-hidden="true" /> : <PushPin size={16} aria-hidden="true" />,
            onSelect: () => handleTogglePinNode(note.id, !isPinned),
          });
          items.push({
            label: t('shell:shortcut.copyNoteLink'),
            icon: <Copy size={16} aria-hidden="true" />,
            onSelect: () => {
              void navigator.clipboard?.writeText(`[[${noteLinkTarget(title)}]]`);
              setToast({ message: t('shell:shortcut.copiedNoteLink') });
            },
          });
          if (hasPlace) {
            items.push({
              label: t('notes:location.showOnMap'),
              icon: <MapPin size={16} aria-hidden="true" />,
              pro: !isPro,
              onSelect: () => jumpToPlace(note.id),
            });
          }

          if (editable && onUnlinkNotes) {
            const outgoing = (linkIndex.outgoing.get(note.id)?.ids ?? [])
              .map((id) => notesById.get(id))
              .filter(
                (n): n is LocalNote =>
                  Boolean(n && isEligibleGraphItem(n, isNoteLocked)),
              )
              .slice(0, 4);
            if (outgoing.length > 0) {
              items.push({ type: 'separator' });
              for (const tgt of outgoing) {
                const tgtTitle = deriveDisplayTitle(tgt, false);
                items.push({
                  label: t('notes:graph.removeLinkTo', { title: tgtTitle }),
                  icon: <Trash size={16} aria-hidden="true" />,
                  destructive: true,
                  onSelect: () => void handleUnlinkNotes(note.id, tgt.id),
                });
              }
            }
          }

          nodeCtx.open(synth, items);
        };

        const toggleReplay = () => {
          setReplayOpen((open) => {
            const next = !open;
            if (!next) {
              setReplayPlaying(false);
              setReplayCutoffMs(null);
            } else if (timeRange) {
              setReplayCutoffMs(timeRange.max);
            }
            return next;
          });
        };

        const linkPickerSource = linkPickerSourceId ? notesById.get(linkPickerSourceId) ?? null : null;
        const linkPickerCandidates = linkPickerSource
          ? (() => {
              const existingOut = new Set(linkIndex.outgoing.get(linkPickerSource.id)?.ids ?? []);
              const q = linkPickerQuery.trim();
              const match = q ? textMatcher(q) : null;
              return notes
                .filter((n) => {
                  if (n.id === linkPickerSource.id) return false;
                  if (!isEligibleGraphItem(n, isNoteLocked)) return false;
                  if (existingOut.has(n.id)) return false;
                  if (match && !match(deriveDisplayTitle(n, false))) return false;
                  return true;
                })
                .slice(0, 30);
            })()
          : [];

        return (
          <>
            {/* Top lens switcher + search sub-bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider bg-surface-2 px-4 py-2.5">
        <SettingsSegmented
          value={lens}
          options={lensOptions}
          onChange={setLens}
          label={t('notes:graph.workspaceTitle')}
        />
        <div className="min-w-[12rem] flex-1">
          <ListSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={
              lens === 'places'
                ? t('notes:graph.searchPlacesPlaceholder')
                : t('notes:graph.searchGraphPlaceholder')
            }
            ariaLabel={
              lens === 'places'
                ? t('notes:graph.searchPlacesPlaceholder')
                : t('notes:graph.searchGraphPlaceholder')
            }
          />
        </div>
      </div>

      {/* Lens 1: Graph */}
      {lens === 'graph' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Focus badge strip (dedicated row when active so toolbar stays single-row) */}
          {focusNodeId && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-divider bg-accent/8 px-4 py-1.5">
              <span className="min-w-0 flex-1 truncate text-small font-medium text-accent-strong" dir="auto">
                {t('notes:graph.focusBadge', { depth: focusDepth, title: focusNodeTitle })}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <SettingsSegmented
                  value={focusDepth === 1 ? '1' : '2'}
                  options={depthOptions}
                  onChange={(v) => setFocusDepth(v === '1' ? 1 : 2)}
                  label={t('notes:graph.depthLabel')}
                />
                <IconButton
                  label={t('notes:graph.clearFocus')}
                  position="below-end"
                  onClick={() => setFocusNodeId(null)}
                >
                  <X aria-hidden="true" />
                </IconButton>
              </div>
            </div>
          )}

          {/* Single-row toolbar strip: icon toggles on compact/docked, full buttons on wide */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-divider bg-surface-2 px-4 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {linkSuggestions && (
                compact ? (
                  <IconButton
                    label={t('notes:graph.suggestedToggle')}
                    tone={showSuggested ? 'accent' : 'quiet'}
                    aria-pressed={showSuggested}
                    className={showSuggested ? 'bg-accent/12' : ''}
                    onClick={() => setShowSuggested((v) => !v)}
                  >
                    <Sparkle aria-hidden="true" />
                  </IconButton>
                ) : (
                  <Button
                    variant={showSuggested ? 'primary' : 'secondary'}
                    aria-pressed={showSuggested}
                    icon={<Sparkle aria-hidden="true" />}
                    onClick={() => setShowSuggested((v) => !v)}
                  >
                    {t('notes:graph.suggestedToggle')}
                  </Button>
                )
              )}
              {compact ? (
                <IconButton
                  label={t('notes:graph.collapseFolders')}
                  tone={collapseFolders ? 'accent' : 'quiet'}
                  aria-pressed={collapseFolders}
                  className={collapseFolders ? 'bg-accent/12' : ''}
                  onClick={() => {
                    setCollapseFolders((v) => !v);
                    setExpandedFolderIds(new Set());
                  }}
                >
                  <FolderSimple aria-hidden="true" />
                </IconButton>
              ) : (
                <Button
                  variant={collapseFolders ? 'primary' : 'secondary'}
                  aria-pressed={collapseFolders}
                  icon={<FolderSimple aria-hidden="true" />}
                  onClick={() => {
                    setCollapseFolders((v) => !v);
                    setExpandedFolderIds(new Set());
                  }}
                >
                  {t('notes:graph.collapseFolders')}
                </Button>
              )}
              {hasTimeline && (
                compact ? (
                  <IconButton
                    label={t('notes:graph.replay')}
                    tone={replayOpen ? 'accent' : 'quiet'}
                    aria-pressed={replayOpen}
                    className={replayOpen ? 'bg-accent/12' : ''}
                    onClick={toggleReplay}
                  >
                    <ClockCounterClockwise aria-hidden="true" />
                  </IconButton>
                ) : (
                  <Button
                    variant={replayOpen ? 'primary' : 'secondary'}
                    aria-pressed={replayOpen}
                    icon={<ClockCounterClockwise aria-hidden="true" />}
                    onClick={toggleReplay}
                  >
                    {t('notes:graph.replay')}
                  </Button>
                )
              )}
            </div>

            <div className="ms-auto flex items-center gap-1.5">
              <span ref={controlsAnchorRef}>
                <Button
                  icon={<SlidersHorizontal aria-hidden="true" />}
                  variant={controlsOpen ? 'primary' : 'secondary'}
                  aria-expanded={controlsOpen}
                  onClick={() => setControlsOpen((o) => !o)}
                >
                  {t('notes:graph.controls')}
                </Button>
              </span>
              <Popover
                open={controlsOpen}
                anchorRef={controlsAnchorRef}
                onClose={() => setControlsOpen(false)}
                title={t('notes:graph.controls')}
                align="end"
                className="w-80 max-w-[calc(100vw-1rem)]"
              >
                <div className="flex flex-col gap-2.5 p-1">
                  <div className="flex flex-col gap-1.5">
                    <SectionEyebrow>{t('notes:graph.colorBy')}</SectionEyebrow>
                    <SettingsSegmented
                      value={colorBy}
                      options={colorByOptions}
                      onChange={setColorBy}
                      label={t('notes:graph.colorBy')}
                    />
                  </div>
                  <Divider />
                  <div className="flex flex-col gap-1.5">
                    <SectionEyebrow>{t('notes:graph.include')}</SectionEyebrow>
                    <Switch
                      label={t('shell:tagsRail.notes')}
                      checked={showNotes}
                      onChange={setShowNotes}
                      className="py-1"
                    />
                    <Switch
                      label={t('shell:tagsRail.journals')}
                      checked={showJournals}
                      onChange={setShowJournals}
                      className="py-1"
                    />
                    <Switch
                      label={t('notes:graph.missingLinks')}
                      checked={showMissing}
                      onChange={setShowMissing}
                      className="py-1"
                    />
                    <Switch
                      label={t('notes:graph.unconnected')}
                      checked={showOrphans}
                      onChange={setShowOrphans}
                      className="py-1"
                    />
                    <Switch
                      label={t('notes:graph.linkArrows')}
                      checked={showArrows}
                      onChange={setShowArrows}
                      className="py-1"
                    />
                    <Switch
                      label={t('notes:graph.allTitles')}
                      checked={showAllLabels}
                      onChange={setShowAllLabels}
                      className="py-1"
                    />
                  </div>
                  <Divider />
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-small text-pn-soft">
                      <span>{t('notes:graph.spread')}</span>
                      <span className="tabular-nums text-meta text-pn-muted">{repelStrength}</span>
                    </div>
                    <RangeSlider
                      min={40}
                      max={180}
                      value={repelStrength}
                      onChange={(e) => setRepelStrength(Number(e.target.value))}
                      aria-label={t('notes:graph.spread')}
                      className="w-full"
                    />
                  </div>
                  <Divider />
                  <Button
                    icon={<ArrowCounterClockwise aria-hidden="true" />}
                    onClick={handleResetLayout}
                  >
                    {t('notes:graph.resetLayout')}
                  </Button>
                </div>
              </Popover>
            </div>
          </div>

          {/* Chronological replay bar */}
          {replayOpen && timeRange && timeRange.min < timeRange.max && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider bg-surface-2 px-4 py-2">
              <IconButton
                label={replayPlaying ? t('notes:graph.pauseTimeline') : t('notes:graph.playTimeline')}
                tone="accent"
                onClick={() => setReplayPlaying((p) => !p)}
              >
                {replayPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              </IconButton>
              <RangeSlider
                min={timeRange.min}
                max={timeRange.max}
                value={effectiveReplayMs ?? timeRange.max}
                onChange={(e) => {
                  setReplayPlaying(false);
                  setReplayCutoffMs(Number(e.target.value));
                }}
                aria-label={t('notes:graph.replay')}
                className="min-w-[8rem] flex-1"
              />
              <span className="shrink-0 text-small tabular-nums text-pn-soft">
                {t('notes:graph.upToDate', { date: replayDateLabel })}
              </span>
              <Button
                icon={<ClockCounterClockwise aria-hidden="true" />}
                onClick={() => {
                  setReplayPlaying(false);
                  setReplayCutoffMs(null);
                }}
              >
                {t('notes:graph.allDates')}
              </Button>
            </div>
          )}

          {/* Graph canvas stage + floating inspector (keep GraphCanvas mounted across empty search so camera & physics stay intact) */}
          <div className="relative min-h-0 flex-1 bg-surface-0">
            <GraphCanvas
              ref={canvasRef}
              nodes={canvasNodes}
              edges={canvasEdges}
              selectedId={selectedId}
              onSelectNode={setSelectedId}
              onOpenNode={(id, opts) => {
                if (!id.startsWith('missing:') && !id.startsWith('folder:')) openNote(id, opts);
              }}
              onExpandFolderHub={(fid) => setExpandedFolderIds((prev) => new Set(prev).add(fid))}
              onCreateLink={(src, tgt) => {
                if (
                  !src.startsWith('missing:') &&
                  !src.startsWith('folder:') &&
                  !tgt.startsWith('missing:') &&
                  !tgt.startsWith('folder:')
                ) {
                  void handleLinkNotes(src, tgt, false);
                }
              }}
              onNodeContextMenu={openNodeContextMenu}
              showArrows={showArrows}
              showAllLabels={showAllLabels}
              showFolderHalos={!collapseFolders}
              folderLabels={folderLabels}
              repelStrength={repelStrength}
              searchMatchIds={searchMatchIds}
              savedPositions={savedPositions}
              onPositionsSettled={handlePositionsSettled}
              layoutEpoch={layoutEpoch}
              dark={dark}
              ariaLabel={t('notes:graph.canvasAria')}
              controlsLabels={{
                zoomIn: t('media:viewer.zoomIn'),
                zoomOut: t('media:viewer.zoomOut'),
                fitGraph: t('notes:graph.fitGraph'),
                connectionsCount: (count) => t('notes:graph.connectionsCount', { count }),
                missingHint: t('notes:graph.missingHint'),
                folderHubHint: t('notes:graph.expandFolder'),
              }}
            />
            {snapshot.nodes.length === 0 && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-0/90">
                <EmptyState
                  icon={<Graph weight="duotone" aria-hidden="true" />}
                  title={t('notes:graph.emptyGraphTitle')}
                >
                  {t('notes:graph.emptyGraphHint')}
                </EmptyState>
              </div>
            )}
            {renderInspector('overlay', compact, docked)}
          </div>

          {/* Bottom status bar */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-divider bg-surface-2 px-4 py-1.5 text-small text-pn-muted">
            <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
              <span>{t('common:quickSwitcher.tagItems', { count: graphStats.realCount })}</span>
              <span aria-hidden="true">·</span>
              <span>{t('notes:graph.statsLinks', { count: graphStats.linkCount })}</span>
              {graphStats.smartCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{t('notes:graph.statsSmart', { count: graphStats.smartCount })}</span>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {!compact && !isTouch && (
                <span className="inline-flex flex-wrap items-center gap-2 text-meta text-pn-muted">
                  <span>{t('notes:graph.dragPinHint')}</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1">
                    <Trans
                      i18nKey={KEY_OS === 'mac' ? 'notes:graph.dragLinkHintMac' : 'notes:graph.dragLinkHintPc'}
                      components={{ kbd: <Kbd>{null}</Kbd> }}
                    />
                  </span>
                </span>
              )}
              {snapshot.protectedHiddenCount > 0 && (
                <span className="flex items-center gap-1.5 text-small text-pn-muted">
                  <LockSimple aria-hidden="true" className="shrink-0" />
                  {t('notes:connections.protectedHidden', { count: snapshot.protectedHiddenCount })}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Lens 2: Places */}
      {lens === 'places' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Places filter strip */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-divider bg-surface-2 px-4 py-2">
            <Button
              variant={placesNotes ? 'primary' : 'secondary'}
              aria-pressed={placesNotes}
              icon={<NotePencil aria-hidden="true" />}
              onClick={() => setPlacesNotes((v) => !v)}
            >
              {t('shell:tagsRail.notes')}
            </Button>
            <Button
              variant={placesJournals ? 'primary' : 'secondary'}
              aria-pressed={placesJournals}
              icon={<PenNib aria-hidden="true" />}
              onClick={() => setPlacesJournals((v) => !v)}
            >
              {t('shell:tagsRail.journals')}
            </Button>
            <Button
              variant={placesContacts ? 'primary' : 'secondary'}
              aria-pressed={placesContacts}
              icon={<User aria-hidden="true" />}
              onClick={() => setPlacesContacts((v) => !v)}
            >
              {t('shell:tagsRail.contacts')}
            </Button>
          </div>

          <div className={`flex min-h-0 flex-1 ${compact ? 'flex-col' : 'flex-col sm:flex-row'}`}>
            {/* Map stage */}
            <div className="relative min-h-[14rem] flex-1 bg-surface-0">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center p-6">
                    <StatusLine busy>{t('notes:location.mapLoading')}</StatusLine>
                  </div>
                }
              >
                <GraphPlacesMapLazy
                  items={mapItems}
                  selectedId={selectedId}
                  focusItemId={focusPinRequest?.id ?? null}
                  focusRequest={focusPinRequest}
                  placesLoaded={placesState.locale === locale && placesState.status === 'ready'}
                  dark={dark}
                  lang={locale}
                  onSelectItem={(id) => {
                    setCoLocatedIds(null);
                    setSelectedId(id);
                    setEditingPlaceForId(null);
                  }}
                  onOpenItem={(id) => openNote(id)}
                  onSelectCoLocated={(group) => {
                    setCoLocatedIds(new Set(group.map((g) => g.id)));
                    setSelectedId(compact ? null : (group[0]?.id ?? null));
                    setEditingPlaceForId(null);
                  }}
                  onVisibleIdsChange={setVisibleMapIds}
                  onUserMove={() => setCoLocatedIds(null)}
                  labels={{
                    mapLabel: t('common:ninja.features.placesMap.label'),
                    zoomIn: t('media:viewer.zoomIn'),
                    zoomOut: t('media:viewer.zoomOut'),
                    fitAll: t('notes:graph.fitAllPins'),
                    myLocation: t('notes:location.useCurrent'),
                    locating: t('notes:location.locating'),
                    mapFailed: t('notes:location.mapFailed'),
                    osmCredit: t('notes:graph.osmCredit'),
                    retry: t('auth:signIn.tryAgain'),
                    locateError: (err) =>
                      t(
                        err === 'denied'
                          ? 'notes:location.errorDenied'
                          : err === 'off'
                            ? 'notes:location.errorOff'
                            : 'notes:location.errorTimeout',
                      ),
                  }}
                />
              </Suspense>
            </div>

            {/* Side list column (wide) / bottom panel (phone or docked).
                In compact mode the inspector and list share one scroll region so the list is never crushed to 0px. */}
            <div className={`flex min-h-0 flex-col border-divider bg-surface-2 ${compact ? 'max-h-[48%] border-t' : 'max-sm:max-h-[48%] max-sm:border-t sm:w-80 sm:shrink-0 sm:border-s'}`}>
              {!compact && selectedRealNote && renderInspector('inline', compact, docked)}

              {/* Area header (sticky above list in wide mode; scrolls with inspector in compact mode) */}
              {!compact && (
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-divider px-3 py-2">
                  <span className="min-w-0 truncate text-small font-semibold text-pn">
                    {coLocatedIds
                      ? t('notes:graph.coLocatedTitle', { count: areaItems.length })
                      : t('notes:graph.inThisArea', { count: areaItems.length })}
                  </span>
                  {coLocatedIds && (
                    <Button
                      icon={<CornersOut aria-hidden="true" />}
                      onClick={() => setCoLocatedIds(null)}
                    >
                      {t('notes:graph.showAllInArea')}
                    </Button>
                  )}
                </div>
              )}

              {/* Scrollable visible pins + unplaced contacts repair section */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {compact && selectedRealNote && renderInspector('inline', compact, docked)}
                {compact && (
                  <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-divider bg-surface-2 px-3 py-2">
                    <span className="min-w-0 truncate text-small font-semibold text-pn">
                      {coLocatedIds
                        ? t('notes:graph.coLocatedTitle', { count: areaItems.length })
                        : t('notes:graph.inThisArea', { count: areaItems.length })}
                    </span>
                    {coLocatedIds && (
                      <Button
                        icon={<CornersOut aria-hidden="true" />}
                        onClick={() => setCoLocatedIds(null)}
                      >
                        {t('notes:graph.showAllInArea')}
                      </Button>
                    )}
                  </div>
                )}
                {placesState.status === 'error' && (
                  <div className="border-b border-divider p-2.5">
                    <Callout
                      tone="danger"
                      action={
                        <FeedbackButton action="retry" onClick={() => setPlacesRetryTick((n) => n + 1)}>
                          {t('auth:signIn.tryAgain')}
                        </FeedbackButton>
                      }
                    >
                      {t('notes:graph.townsLoadFailed')}
                    </Callout>
                  </div>
                )}
                {placesResult.placed.length === 0 && placesResult.unplacedContacts.length === 0 ? (
                  <EmptyState
                    icon={<MapPin weight="duotone" aria-hidden="true" />}
                    title={t('notes:graph.emptyPlacesTitle')}
                  >
                    {t('notes:graph.emptyPlacesHint')}
                  </EmptyState>
                ) : areaItems.length === 0 ? (
                  <EmptyState compact>{t('notes:graph.emptyAreaHint')}</EmptyState>
                ) : (
                  <ul className="divide-y divide-divider">
                    {areaItems.map((item) => {
                      const isSel = selectedId === item.id;
                      const subtitle = item.location.label ?? item.addressSummary ?? '';
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            aria-pressed={isSel}
                            onClick={() => {
                              setSelectedId(item.id);
                              requestFocusPin(item.id);
                              setEditingPlaceForId(null);
                            }}
                            className={`flex w-full items-start gap-2.5 px-3 py-2 text-start transition ${
                              isSel ? 'bg-accent/10' : 'hover:bg-pn/5'
                            }`}
                          >
                            {item.kind === 'contact' && item.initials ? (
                              <span
                                aria-hidden="true"
                                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-meta font-semibold text-accent-strong"
                              >
                                {item.initials}
                              </span>
                            ) : (
                              <span className="mt-0.5 flex shrink-0">
                                <NoteGlyph note={item.note} />
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="min-w-0 flex-1 truncate text-body font-medium text-pn" dir="auto">
                                  {item.title}
                                </span>
                                {!item.exact && (
                                  <Badge tone="info">{t('notes:graph.townMatchBadge')}</Badge>
                                )}
                              </span>
                              {subtitle && (
                                <span className="block truncate text-small text-pn-muted" dir="auto">
                                  {subtitle}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {/* Folded "Not on the map (N)" repair section (hidden while offline town list failed to load) */}
                {placesState.status !== 'error' && placesResult.unplacedContacts.length > 0 && (
                  <div className="border-t border-divider bg-surface-1">
                    <button
                      type="button"
                      aria-expanded={notOnMapOpen}
                      onClick={() => setNotOnMapOpen((o) => !o)}
                      className="flex w-full items-center gap-1.5 px-3 py-2 text-start text-small font-medium text-pn-soft transition hover:text-pn"
                    >
                      {notOnMapOpen ? (
                        <CaretDown aria-hidden="true" className="shrink-0" />
                      ) : (
                        <CaretRight aria-hidden="true" className="shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {t('notes:graph.notOnMapCount', { count: placesResult.unplacedContacts.length })}
                      </span>
                    </button>
                    {notOnMapOpen && (
                      <div className="flex flex-col gap-2 px-3 pb-3">
                        <p className={SETTINGS_HELP}>{t('notes:graph.notOnMapHint')}</p>
                        <ul className="flex flex-col gap-2">
                          {placesResult.unplacedContacts.map((c) => {
                            const isEditing = editingPlaceForId === c.id;
                            const isReadOnly = c.note.locked === 1;
                            return (
                              <li
                                key={c.id}
                                className="flex flex-col gap-2 rounded-md border border-divider bg-surface-2 p-2.5"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-body font-medium text-pn" dir="auto">
                                      {c.title}
                                    </p>
                                    <p className="truncate text-small text-pn-muted" dir="auto">
                                      {c.addressSummary}
                                    </p>
                                  </div>
                                  {!isEditing && !isReadOnly && (
                                    <Button
                                      icon={<MapPin aria-hidden="true" />}
                                      onClick={() => setEditingPlaceForId(c.id)}
                                    >
                                      {t('notes:graph.setPlace')}
                                    </Button>
                                  )}
                                  {isReadOnly && (
                                    <LockSimple size={14} aria-hidden="true" className="mt-1 shrink-0 text-pn-muted" />
                                  )}
                                </div>
                                {isEditing && !isReadOnly && (
                                  <LocationPanel
                                    place={readLocation(c.note.trackers)}
                                    readOnly={false}
                                    startEditing={true}
                                    onSave={async (loc) => {
                                      const ok = await onSetItemLocation(c.id, loc);
                                      if (ok) {
                                        setSelectedId(c.id);
                                        requestFocusPin(c.id);
                                      }
                                      return ok;
                                    }}
                                    onDone={() => setEditingPlaceForId(null)}
                                  />
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Privacy notice at foot */}
              <p className={`flex shrink-0 items-start gap-1.5 border-t border-divider px-3 py-2 ${SETTINGS_HELP}`}>
                <ShieldCheck className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{t('notes:location.mapNotice')}</span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Lens 3: Inbox */}
      {lens === 'inbox' && (
        <div className="min-h-0 flex-1 overflow-y-auto bg-surface-0 p-4">
          <div className={`grid grid-cols-1 gap-4 ${compact ? '' : 'md:grid-cols-2'}`}>
            {/* Suggested bridges */}
            <section className="flex flex-col gap-2 rounded-lg border border-divider bg-surface-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <SectionEyebrow icon={Sparkle}>{t('notes:graph.inboxSuggested')}</SectionEyebrow>
                <Badge tone="success">{filteredInbox.suggested.length}</Badge>
              </div>
              {filteredInbox.suggested.length === 0 ? (
                <EmptyState compact>{t('notes:graph.inboxSuggestedEmpty')}</EmptyState>
              ) : (
                <ul className="divide-y divide-divider">
                  {filteredInbox.suggested.map((pair) => {
                    const whyText = formatWhyText(pair.why, t);
                    return (
                      <li key={pair.key} className="flex flex-col gap-1.5 py-2.5 first:pt-1 last:pb-0">
                        <div className="flex items-center gap-1.5 text-body font-medium text-pn">
                          <button
                            type="button"
                            onClick={() => jumpToGraphNode(pair.sourceId)}
                            className="min-w-0 truncate text-start transition hover:text-accent hover:underline"
                            dir="auto"
                          >
                            {pair.sourceTitle}
                          </button>
                          <span aria-hidden="true" className="shrink-0 text-pn-muted">-</span>
                          <button
                            type="button"
                            onClick={() => jumpToGraphNode(pair.targetId)}
                            className="min-w-0 truncate text-start transition hover:text-accent hover:underline"
                            dir="auto"
                          >
                            {pair.targetTitle}
                          </button>
                        </div>
                        {whyText && (
                          <p className="text-small text-pn-muted" dir="auto">
                            {whyText}
                          </p>
                        )}
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <Button
                            variant="primary"
                            icon={<LinkSimple aria-hidden="true" />}
                            onClick={() => void handleLinkNotes(pair.sourceId, pair.targetId, true)}
                          >
                            {t('notes:graph.linkNotes')}
                          </Button>
                          <IconButton
                            label={t('notes:connections.notRelated')}
                            onClick={() => handleDismissSuggestion(pair.sourceId, pair.targetId)}
                          >
                            <X aria-hidden="true" />
                          </IconButton>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Missing note-links */}
            <section className="flex flex-col gap-2 rounded-lg border border-divider bg-surface-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <SectionEyebrow icon={LinkSimple}>{t('notes:graph.inboxMissing')}</SectionEyebrow>
                <Badge tone="warning">{filteredInbox.missing.length}</Badge>
              </div>
              {filteredInbox.missing.length === 0 ? (
                <EmptyState compact>{t('notes:graph.inboxMissingEmpty')}</EmptyState>
              ) : (
                <>
                  <ul className="divide-y divide-divider">
                    {filteredInbox.missing.slice(0, missingLimit).map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-2 py-2.5 first:pt-1 last:pb-0">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-body font-medium text-pn" dir="auto">
                            {`[[${m.name}]]`}
                          </p>
                          <p className="text-small text-pn-muted">
                            {t('notes:graph.referrersCount', { count: m.referrerCount })}
                          </p>
                        </div>
                        <Button action="create" onClick={() => void (docked ? onCreateMissingNote(m.name, { keepOpen: true }) : onCreateMissingNote(m.name))}>
                          {t('notes:createNote.confirm')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {filteredInbox.missing.length > missingLimit && (
                    <Button icon={<CaretDown aria-hidden="true" />} onClick={() => setMissingLimit((n) => n + INBOX_INITIAL_ROWS)}>
                      {t('notes:graph.showMoreRows', { count: filteredInbox.missing.length - missingLimit })}
                    </Button>
                  )}
                </>
              )}
            </section>

            {/* Unconnected items */}
            <section className="flex flex-col gap-2 rounded-lg border border-divider bg-surface-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <SectionEyebrow icon={Graph}>{t('notes:graph.inboxOrphans')}</SectionEyebrow>
                <Badge tone="neutral">{filteredInbox.orphans.length}</Badge>
              </div>
              {filteredInbox.orphans.length === 0 ? (
                <EmptyState compact>{t('notes:graph.inboxOrphansEmpty')}</EmptyState>
              ) : (
                <>
                  <ul className="divide-y divide-divider">
                    {filteredInbox.orphans.slice(0, orphanLimit).map((node) => {
                      const realNote = notesById.get(node.id);
                      return (
                        <li key={node.id} className="flex items-center gap-2 py-2 first:pt-1 last:pb-0">
                          <button
                            type="button"
                            onClick={() => jumpToGraphNode(node.id, true)}
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-start transition hover:bg-pn/5"
                          >
                            {realNote && <NoteGlyph note={realNote} />}
                            <span className="min-w-0 flex-1 truncate text-body text-pn" dir="auto">
                              {node.title}
                            </span>
                          </button>
                          <Button action="open" onClick={() => openNote(node.id)}>
                            {t('shell:contacts.open')}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                  {filteredInbox.orphans.length > orphanLimit && (
                    <Button icon={<CaretDown aria-hidden="true" />} onClick={() => setOrphanLimit((n) => n + INBOX_INITIAL_ROWS)}>
                      {t('notes:graph.showMoreRows', { count: filteredInbox.orphans.length - orphanLimit })}
                    </Button>
                  )}
                </>
              )}
            </section>

            {/* Top hubs */}
            <section className="flex flex-col gap-2 rounded-lg border border-divider bg-surface-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <SectionEyebrow icon={Crosshair}>{t('notes:graph.inboxHubs')}</SectionEyebrow>
                <Badge tone="info">{filteredInbox.hubs.length}</Badge>
              </div>
              {filteredInbox.hubs.length === 0 ? (
                <EmptyState compact>{t('notes:graph.inboxHubsEmpty')}</EmptyState>
              ) : (
                <ul className="divide-y divide-divider">
                  {filteredInbox.hubs.map((node) => {
                    const realNote = notesById.get(node.id);
                    return (
                      <li key={node.id} className="flex flex-wrap items-center gap-2 py-2 first:pt-1 last:pb-0">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          {realNote && <NoteGlyph note={realNote} />}
                          <span className="min-w-0 flex-1 truncate text-body font-medium text-pn" dir="auto">
                            {node.title}
                          </span>
                          <Badge tone="info">
                            {t('notes:graph.connectionsCount', { count: node.degree })}
                          </Badge>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            icon={<Crosshair aria-hidden="true" />}
                            onClick={() => focusGraphNode(node.id, 2)}
                          >
                            {t('notes:graph.focus2Hop')}
                          </Button>
                          <Button action="open" onClick={() => openNote(node.id)}>
                            {t('shell:contacts.open')}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}

            <ContextMenu state={nodeCtx.state} onClose={nodeCtx.close} />
            {linkPickerSource && (
              <Modal
                title={t('notes:graph.linkTo')}
                icon={<LinkSimple size={16} />}
                header="bar"
                layer="z-[60]"
                onClose={() => setLinkPickerSourceId(null)}
                className="flex max-h-[70vh] max-w-sm flex-col overflow-hidden"
              >
                <div className="shrink-0 border-b border-divider p-3">
                  <ListSearchInput
                    value={linkPickerQuery}
                    onChange={setLinkPickerQuery}
                    placeholder={t('notes:graph.linkToPlaceholder')}
                    ariaLabel={t('notes:graph.linkToPlaceholder')}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {linkPickerCandidates.length === 0 ? (
                    <EmptyState compact>{t('notes:graph.emptyGraphTitle')}</EmptyState>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {linkPickerCandidates.map((cand) => (
                        <li key={cand.id}>
                          <button
                            type="button"
                            onClick={() => {
                              const srcId = linkPickerSource.id;
                              setLinkPickerSourceId(null);
                              void handleLinkNotes(srcId, cand.id, false);
                            }}
                            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-start text-body text-pn transition hover:bg-surface-1"
                          >
                            <NoteGlyph note={cand} />
                            <span className="min-w-0 flex-1 truncate" dir="auto">
                              {deriveDisplayTitle(cand, false)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Modal>
            )}
            {toast && createPortal(
              <div className="fixed inset-x-0 bottom-0 z-[70] pointer-events-none">
                <div className="pointer-events-auto">
                  <Snackbar
                    actionLabel={toast.undo ? t('notes:editor.undo') : undefined}
                    onAction={
                      toast.undo
                        ? () => {
                            const fn = toast.undo;
                            setToast(null);
                            fn?.();
                          }
                        : undefined
                    }
                  >
                    {toast.message}
                  </Snackbar>
                </div>
              </div>,
              document.body,
            )}
          </>
        );
      }}
    </DockableWindow>
  );
}
