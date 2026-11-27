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
  Check,
  CheckFat,
  ClockCounterClockwise,
  Columns,
  Compass,
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
  LockSimpleOpen,
  MapPin,
  NotePencil,
  Paperclip,
  Pause,
  PenNib,
  PencilSimple,
  Play,
  PushPin,
  PushPinSlash,
  ShieldCheck,
  SidebarSimple,
  SlidersHorizontal,
  Sparkle,
  Stack,
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
  DeleteButton,
  Disclosure,
  Divider,
  EmptyState,
  FeedbackButton,
  IconButton,
  IconUpgrade,
  InlineRenameField,
  Kbd,
  ListSearchInput,
  PickerModal,
  Popover,
  RangeSlider,
  SETTINGS_HELP,
  SETTINGS_TRACK,
  SectionEyebrow,
  SettingsSegmented,
  SettingsTabStrip,
  Snackbar,
  StatusLine,
  Switch,
  TextField,
  settingsSegClass,
  settingsTabClass,
  useContextMenu,
} from '../ui';
import type { ContextMenuItem } from '../ContextMenu';
import { DockableWindow } from '../ui/DockableWindow';
import { credentialKey, proUnlocked } from '../demo';
import { KEY_OS } from '../shortcutMatch';
import { noteLinkTarget } from '../noteLinks';
import { canStoreNoteLinks } from '../noteLinkEdit';
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
import { googleMapsUrl, osmUrl, readLocation, type NoteLocation } from '../noteLocation';
import { typeGlyph } from '../NoteRow';
import { LocationPanel } from '../notesView/NoteLocationChip';
import { deriveDisplayTitle, deriveExcerpt } from '../notesViewUtils';
import { meaningHits } from '../onDeviceAi';
import { openExternal } from '../openExternal';
import { loadPlaces, type PlaceList } from '../placeSearch';
import { listOf } from '../scheduleText';
import { folderSpaces, foldersIn, inSpace, type SpaceView } from '../spaces';
import { SpaceSwitch } from '../SpaceSwitch';
import { sortTags } from '../tagOrder';
import { textMatcher } from '../textMatch';
import { useTheme } from '../theme';
import { useIsTouchDevice } from '../useIsMobile';
import {
  canSaveGraphView,
  DEFAULT_GRAPH_VIEW_STATE,
  deleteGraphView,
  GRAPH_VIEW_MAX,
  GRAPH_VIEW_NAME_MAX,
  graphViewStatesEqual,
  liveGraphViews,
  newGraphViewId,
  saveGraphView,
  type GraphViews,
  type GraphViewState,
  type SavedGraphView,
} from '../graphViews';
import { GraphCanvas, kindLookColor, type CanvasEdge, type CanvasNode, type GraphCanvasHandle } from './GraphCanvas';
import type { PlacesMapItem } from './GraphPlacesMap';
import {
  buildExploreInbox,
  buildGraphSnapshot,
  clearSavedGraphLayout,
  computeGraphSuggestions,
  isEligibleGraphItem,
  isSyntheticGraphId,
  parseGraphSelectionId,
  readSavedGraphLayout,
  resolveMissingTarget,
  resolvePlacedItems,
  writeSavedGraphLayout,
  type GraphColorBy,
  type GraphFilters,
  type GraphNode,
  type PlacedItem,
  type RelatedWhyData,
  type SavedGraphLayout,
} from './graphModel';

// Spec: docs/internal/specs/graph-view.md (section 4.6)

export type GraphLens = 'graph' | 'places' | 'inbox';

export const GRAPH_LENS_STORAGE_KEY = 'privacynotes.graph.lens';
export const GRAPH_LOCK_STORAGE_KEY = 'privacynotes.graph.locked';
export const GRAPH_ACTIVE_VIEW_STORAGE_KEY = 'privacynotes.graph.activeView';
export const GRAPH_PLACES_PANEL_STORAGE_KEY = 'privacynotes.graph.placesPanel';

function activeLensStorageKey(): string {
  return credentialKey(GRAPH_LENS_STORAGE_KEY);
}

function activeLockStorageKey(): string {
  return credentialKey(GRAPH_LOCK_STORAGE_KEY);
}

function activeViewStorageKey(): string {
  return credentialKey(GRAPH_ACTIVE_VIEW_STORAGE_KEY);
}

function activePlacesPanelStorageKey(): string {
  return credentialKey(GRAPH_PLACES_PANEL_STORAGE_KEY);
}

function readSavedPlacesPanelOpen(): boolean {
  try {
    const raw = localStorage.getItem(activePlacesPanelStorageKey());
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch {
    // Storage unavailable.
  }
  return true;
}

function writeSavedPlacesPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(activePlacesPanelStorageKey(), open ? '1' : '0');
  } catch {
    // Storage unavailable.
  }
}

function readSavedGraphLocked(defaultLocked: boolean): boolean {
  try {
    const raw = localStorage.getItem(activeLockStorageKey());
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // Storage unavailable.
  }
  return defaultLocked;
}

function writeSavedGraphLocked(locked: boolean): void {
  try {
    localStorage.setItem(activeLockStorageKey(), locked ? '1' : '0');
  } catch {
    // Storage unavailable.
  }
}

function readSavedActiveViewId(): string | null {
  try {
    const raw = localStorage.getItem(activeViewStorageKey());
    if (raw && /^[a-z0-9]{12}$/.test(raw)) return raw;
  } catch {
    // Storage unavailable.
  }
  return null;
}

function writeSavedActiveViewId(id: string | null): void {
  try {
    if (id) localStorage.setItem(activeViewStorageKey(), id);
    else localStorage.removeItem(activeViewStorageKey());
  } catch {
    // Storage unavailable.
  }
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
  graphViews?: GraphViews;
  onGraphViewsChange?: (updater: (prev: GraphViews) => GraphViews) => void;
  initialLens?: GraphLens;
  initialFocusId?: string | null;
  initialRequestTick?: number;
  /** True when Spaces is enabled on this account (Pro or Demo with Spaces on). */
  spacesEnabled?: boolean;
  /** Currently active workspace space (`all`, `personal`, or `work`). */
  activeSpace?: SpaceView;
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

export function resolveColorBy(node: GraphNode, colorBy: GraphColorBy): LookColor | null {
  if (colorBy === 'looks') return node.colorKey;
  if (colorBy === 'kind') {
    if (node.kind === 'missing' || node.kind === 'folderHub') return node.colorKey;
    if (node.kind === 'note') return 'blue';
    return kindLookColor(node.kind) ?? node.colorKey;
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
  graphViews,
  onGraphViewsChange,
  initialLens,
  initialFocusId = null,
  initialRequestTick = 0,
  spacesEnabled = false,
  activeSpace = 'all',
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
  const spaceOfFolder = useMemo(
    () => folderSpaces(folders, itemStyles),
    [folders, itemStyles],
  );
  const [spaceFilter, setSpaceFilter] = useState<SpaceView>(() => {
    if (!spacesEnabled) return 'all';
    if (initialFocusId && activeSpace !== 'all') {
      const target = notes.find((n) => n.id === initialFocusId);
      if (target && !inSpace(target, activeSpace, spaceOfFolder)) {
        const filed = target.folderId ? spaceOfFolder.get(target.folderId) : undefined;
        return filed ?? 'personal';
      }
    }
    return activeSpace;
  });
  const effectiveSpace: SpaceView = spacesEnabled ? spaceFilter : 'all';

  // Keep spaceFilter in sync when the app's open space or Spaces setting changes (e.g. while docked).
  const prevSpacePropsRef = useRef({ spacesEnabled, activeSpace });
  useEffect(() => {
    const prev = prevSpacePropsRef.current;
    prevSpacePropsRef.current = { spacesEnabled, activeSpace };
    if (prev.spacesEnabled !== spacesEnabled || prev.activeSpace !== activeSpace) {
      setSpaceFilter(spacesEnabled ? activeSpace : 'all');
    }
  }, [spacesEnabled, activeSpace]);

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
      setSelectedId((prev) => (prev && isSyntheticGraphId(prev) ? null : prev));
    }
    setLensState(next);
    writeSavedLens(next);
  }, [placesUnlocked, onOpenPlacesUpgrade]);

  // Sync lens & focus whenever caller explicitly opens or re-targets while mounted (e.g. docked).
  const lastRequestTickRef = useRef(initialRequestTick);
  const mountedWithLensRef = useRef(false);
  useEffect(() => {
    if (mountedWithLensRef.current) return;
    mountedWithLensRef.current = true;
    if (initialLens) {
      writeSavedLens(initialLens === 'places' && !placesUnlocked ? 'graph' : initialLens);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- record explicit initialLens once on mount.
  }, []);
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
      if (spacesEnabled && spaceFilter !== 'all') {
        const target = notes.find((n) => n.id === initialFocusId);
        if (target && !inSpace(target, spaceFilter, spaceOfFolder)) {
          const filed = target.folderId ? spaceOfFolder.get(target.folderId) : undefined;
          setSpaceFilter(filed ?? 'personal');
        }
      }
      setSelectedId(initialFocusId);
      requestFocusPin(initialFocusId);
      if (initialLens !== 'places') setPendingCanvasFocusId(initialFocusId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only respond to external open/re-target signals.
  }, [initialLens, initialFocusId, initialRequestTick, placesUnlocked, requestFocusPin]);

  // Saved graph views (synced encrypted settings when provided, with local state fallback for isolated tests)
  const [localGraphViews, setLocalGraphViews] = useState<GraphViews>({});
  const effectiveGraphViews = graphViews ?? localGraphViews;
  const updateGraphViews = useCallback(
    (updater: (prev: GraphViews) => GraphViews) => {
      if (onGraphViewsChange) onGraphViewsChange(updater);
      else setLocalGraphViews(updater);
    },
    [onGraphViewsChange],
  );
  const savedViewsList = useMemo(() => liveGraphViews(effectiveGraphViews), [effectiveGraphViews]);

  const initialRestoredView = useMemo<SavedGraphView | null>(() => {
    if (initialFocusId) return null;
    const savedId = readSavedActiveViewId();
    if (!savedId) return null;
    return liveGraphViews(graphViews ?? {}).find((v) => v.id === savedId) ?? null;
    // Only seed from the remembered saved view once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [activeViewId, setActiveViewId] = useState<string | null>(() => initialRestoredView?.id ?? null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const viewsAnchorRef = useRef<HTMLSpanElement | null>(null);
  const [newViewName, setNewViewName] = useState('');
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Graph lens controls state
  const [colorBy, setColorBy] = useState<GraphColorBy>(() => initialRestoredView?.state.colorBy ?? DEFAULT_GRAPH_VIEW_STATE.colorBy);
  const [showNotes, setShowNotes] = useState(() => initialRestoredView?.state.showNotes ?? DEFAULT_GRAPH_VIEW_STATE.showNotes);
  const [showJournals, setShowJournals] = useState(() => initialRestoredView?.state.showJournals ?? DEFAULT_GRAPH_VIEW_STATE.showJournals);
  const [showMissing, setShowMissing] = useState(() => initialRestoredView?.state.showMissing ?? DEFAULT_GRAPH_VIEW_STATE.showMissing);
  const [showOrphans, setShowOrphans] = useState(() => initialRestoredView?.state.showOrphans ?? DEFAULT_GRAPH_VIEW_STATE.showOrphans);
  const [showSuggested, setShowSuggested] = useState(() => initialRestoredView?.state.showSuggested ?? DEFAULT_GRAPH_VIEW_STATE.showSuggested);
  const [showArrows, setShowArrows] = useState(() => initialRestoredView?.state.showArrows ?? DEFAULT_GRAPH_VIEW_STATE.showArrows);
  const [showAllLabels, setShowAllLabels] = useState(() => initialRestoredView?.state.showAllLabels ?? DEFAULT_GRAPH_VIEW_STATE.showAllLabels);
  const [collapseFolders, setCollapseFolders] = useState(() => initialRestoredView?.state.collapseFolders ?? DEFAULT_GRAPH_VIEW_STATE.collapseFolders);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
    () => new Set(initialRestoredView?.state.expandedFolderIds ?? []),
  );
  const [focusNodeId, setFocusNodeId] = useState<string | null>(() => initialRestoredView?.state.focusNodeId ?? null);
  const [focusDepth, setFocusDepth] = useState<1 | 2>(() => initialRestoredView?.state.focusDepth ?? DEFAULT_GRAPH_VIEW_STATE.focusDepth);
  const [repelStrength, setRepelStrength] = useState(() => initialRestoredView?.state.repelStrength ?? DEFAULT_GRAPH_VIEW_STATE.repelStrength);
  const [layoutLocked, setLayoutLocked] = useState<boolean>(() => readSavedGraphLocked(isTouch));
  const [savedPositions, setSavedPositions] = useState<SavedGraphLayout>(() => readSavedGraphLayout());
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [controlsOpen, setControlsOpen] = useState(false);
  const controlsAnchorRef = useRef<HTMLSpanElement | null>(null);

  // Restore search query from remembered view on mount (kept separate so initialFocusId stays clean).
  useEffect(() => {
    if (initialRestoredView?.state.searchQuery) {
      setSearchQuery(initialRestoredView.state.searchQuery);
    }
    if (initialRestoredView?.state.focusNodeId) {
      setPendingCanvasFocusId(initialRestoredView.state.focusNodeId);
    }
  }, [initialRestoredView]);

  const toggleLayoutLocked = useCallback(() => {
    setLayoutLocked((prev) => {
      const next = !prev;
      writeSavedGraphLocked(next);
      return next;
    });
  }, []);

  const currentViewState = useMemo<GraphViewState>(
    () => ({
      searchQuery,
      colorBy,
      showNotes,
      showJournals,
      showMissing,
      showOrphans,
      showSuggested,
      showArrows,
      showAllLabels,
      collapseFolders,
      expandedFolderIds: [...expandedFolderIds].sort(),
      focusNodeId,
      focusDepth,
      repelStrength,
    }),
    [
      searchQuery,
      colorBy,
      showNotes,
      showJournals,
      showMissing,
      showOrphans,
      showSuggested,
      showArrows,
      showAllLabels,
      collapseFolders,
      expandedFolderIds,
      focusNodeId,
      focusDepth,
      repelStrength,
    ],
  );

  const activeView = useMemo(
    () => (activeViewId ? savedViewsList.find((v) => v.id === activeViewId) ?? null : null),
    [savedViewsList, activeViewId],
  );
  const isViewModified = useMemo(
    () => (activeView ? !graphViewStatesEqual(currentViewState, activeView.state) : false),
    [activeView, currentViewState],
  );
  const hasNonDefaultFilters = useMemo(
    () => !graphViewStatesEqual(currentViewState, DEFAULT_GRAPH_VIEW_STATE),
    [currentViewState],
  );
  const canCreateView = useMemo(() => canSaveGraphView(effectiveGraphViews), [effectiveGraphViews]);

  const applyViewState = useCallback((state: GraphViewState) => {
    setSearchQuery(state.searchQuery);
    setColorBy(state.colorBy);
    setShowNotes(state.showNotes);
    setShowJournals(state.showJournals);
    setShowMissing(state.showMissing);
    setShowOrphans(state.showOrphans);
    setShowSuggested(state.showSuggested);
    setShowArrows(state.showArrows);
    setShowAllLabels(state.showAllLabels);
    setCollapseFolders(state.collapseFolders);
    setExpandedFolderIds(new Set(state.expandedFolderIds));
    setFocusNodeId(state.focusNodeId);
    setFocusDepth(state.focusDepth);
    setRepelStrength(state.repelStrength);
    if (state.focusNodeId) {
      setSelectedId(state.focusNodeId);
      setPendingCanvasFocusId(state.focusNodeId);
    }
  }, []);

  const handleApplySavedView = useCallback(
    (view: SavedGraphView) => {
      applyViewState(view.state);
      setActiveViewId(view.id);
      writeSavedActiveViewId(view.id);
      setNewViewName('');
      setViewsOpen(false);
    },
    [applyViewState],
  );

  const handleResetFilters = useCallback(() => {
    applyViewState(DEFAULT_GRAPH_VIEW_STATE);
    setActiveViewId(null);
    writeSavedActiveViewId(null);
    setNewViewName('');
    setViewsOpen(false);
  }, [applyViewState]);

  const handleSaveNewView = useCallback(() => {
    const trimmed = newViewName.trim().slice(0, GRAPH_VIEW_NAME_MAX);
    if (!trimmed || !canSaveGraphView(effectiveGraphViews)) return;
    const id = newGraphViewId();
    updateGraphViews((prev) => saveGraphView(prev, trimmed, currentViewState, id).views);
    setActiveViewId(id);
    writeSavedActiveViewId(id);
    setNewViewName('');
    setViewsOpen(false);
    setToast({ message: t('notes:graph.viewSavedToast', { name: trimmed }) });
  }, [newViewName, effectiveGraphViews, currentViewState, updateGraphViews, t]);

  const handleUpdateActiveView = useCallback(() => {
    if (!activeView) return;
    updateGraphViews((prev) => saveGraphView(prev, activeView.name, currentViewState, activeView.id).views);
    setViewsOpen(false);
    setToast({ message: t('notes:graph.viewUpdatedToast', { name: activeView.name }) });
  }, [activeView, currentViewState, updateGraphViews, t]);

  const handleDeleteView = useCallback(
    (view: SavedGraphView) => {
      updateGraphViews((prev) => deleteGraphView(prev, view.id));
      if (renamingViewId === view.id) setRenamingViewId(null);
      if (activeViewId === view.id) {
        setActiveViewId(null);
        writeSavedActiveViewId(null);
      }
      setToast({ message: t('notes:graph.viewDeletedToast', { name: view.name }) });
    },
    [activeViewId, renamingViewId, updateGraphViews, t],
  );

  const handleCommitRenameView = useCallback(
    (view: SavedGraphView) => {
      const trimmed = renameDraft.trim().slice(0, GRAPH_VIEW_NAME_MAX);
      setRenamingViewId(null);
      if (!trimmed || trimmed === view.name) return;
      updateGraphViews((prev) => saveGraphView(prev, trimmed, view.state, view.id).views);
      setToast({ message: t('notes:graph.viewRenamedToast', { name: trimmed }) });
    },
    [renameDraft, updateGraphViews, t],
  );

  // Chronological replay state
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayCutoffMs, setReplayCutoffMs] = useState<number | null>(null);

  // Places lens state
  const [placesState, setPlacesState] = useState<{
    locale: string;
    status: 'idle' | 'loading' | 'ready' | 'error';
    rows: PlaceList | null;
  }>({ locale, status: 'idle', rows: null });
  const [placesRetryTick, setPlacesRetryTick] = useState(0);
  const [placesNotes, setPlacesNotes] = useState(true);
  const [placesJournals, setPlacesJournals] = useState(true);
  const [placesTasks, setPlacesTasks] = useState(true);
  const [placesFiles, setPlacesFiles] = useState(true);
  const [placesContacts, setPlacesContacts] = useState(true);
  const [placesPanelOpen, setPlacesPanelOpen] = useState<boolean>(() => readSavedPlacesPanelOpen());
  const togglePlacesPanel = useCallback(() => {
    setPlacesPanelOpen((prev) => {
      const next = !prev;
      writeSavedPlacesPanelOpen(next);
      return next;
    });
  }, []);
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

  const scopedNotes = useMemo(
    () => (effectiveSpace === 'all' ? notes : notes.filter((n) => inSpace(n, effectiveSpace, spaceOfFolder))),
    [notes, effectiveSpace, spaceOfFolder],
  );
  const scopedFolders = useMemo(
    () => (effectiveSpace === 'all' ? folders : foldersIn(folders as FolderDef[], spaceOfFolder, effectiveSpace)),
    [folders, effectiveSpace, spaceOfFolder],
  );
  const hasItemsInOtherSpace = useMemo(() => {
    if (effectiveSpace === 'all') return false;
    return notes.some((n) => isEligibleGraphItem(n, isNoteLocked) && !inSpace(n, effectiveSpace, spaceOfFolder));
  }, [effectiveSpace, notes, isNoteLocked, spaceOfFolder]);

  const handleSpaceFilterChange = useCallback(
    (next: SpaceView) => {
      setSpaceFilter(next);
      setCoLocatedIds(null);
      setEditingPlaceForId(null);
      if (focusNodeId && next !== 'all') {
        const parsed = parseGraphSelectionId(focusNodeId);
        if (parsed.kind === 'note') {
          const target = notes.find((n) => n.id === parsed.noteId);
          if (!target || !inSpace(target, next, spaceOfFolder)) setFocusNodeId(null);
        } else if (parsed.kind === 'folder') {
          if ((spaceOfFolder.get(parsed.folderId) ?? 'personal') !== next) setFocusNodeId(null);
        }
      }
    },
    [focusNodeId, notes, spaceOfFolder],
  );

  const notesById = useMemo(() => new Map(scopedNotes.map((n) => [n.id, n])), [scopedNotes]);
  const foldersById = useMemo(() => new Map(scopedFolders.map((f) => [f.id, f])), [scopedFolders]);

  const folderLabels = useMemo(() => {
    const map = new Map<string, { label: string; colorKey: string | null }>();
    for (const f of scopedFolders) {
      map.set(f.id, { label: f.name, colorKey: folderColor(f.id, itemStyles) });
    }
    return map;
  }, [scopedFolders, itemStyles]);

  const suggestedEdges = useMemo(() => {
    if (!linkSuggestions) return [];
    return computeGraphSuggestions(
      scopedNotes,
      linkIndex,
      isNoteLocked,
      dismissedSuggestions,
      (n, skip, limit) => meaningHits(n, skip, limit),
    );
    // relatedIndexVersion triggers recomputation after the in-memory index finishes building.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedNotes, linkIndex, isNoteLocked, dismissedSuggestions, linkSuggestions, relatedIndexVersion]);

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
        notes: scopedNotes,
        linkIndex,
        isNoteLocked,
        itemStyles,
        folders: scopedFolders,
        suggestedEdges,
        filters,
      }),
    [scopedNotes, linkIndex, isNoteLocked, itemStyles, scopedFolders, suggestedEdges, filters],
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
      resolvePlacedItems(scopedNotes, isNoteLocked, itemStyles, placeRows, {
        showNotes: lens === 'places' ? placesNotes : true,
        showJournals: lens === 'places' ? placesJournals : true,
        showTasks: lens === 'places' ? placesTasks : true,
        showFiles: lens === 'places' ? placesFiles : true,
        showContacts: lens === 'places' ? placesContacts : true,
        searchQuery: lens === 'places' ? deferredSearchQuery : '',
      }),
    [scopedNotes, isNoteLocked, itemStyles, placeRows, lens, placesNotes, placesJournals, placesTasks, placesFiles, placesContacts, deferredSearchQuery],
  );

  const placedById = useMemo(
    () => new Map<string, PlacedItem>(placesResult.placed.map((p) => [p.id, p])),
    [placesResult.placed],
  );

  // Clear stale selection in Places when the active item is not a placed pin (e.g. filtered out or unplaced note from Graph).
  useEffect(() => {
    if (lens !== 'places' || !selectedId) return;
    if (editingPlaceForId === selectedId) return;
    if (placesState.locale !== locale || placesState.status === 'idle' || placesState.status === 'loading') return;
    if (!placedById.has(selectedId)) {
      if (placesResult.unplacedContacts.some((c) => c.id === selectedId)) {
        setNotOnMapOpen(true);
      }
      setSelectedId(null);
    }
  }, [lens, selectedId, editingPlaceForId, placesState.locale, placesState.status, locale, placedById, placesResult.unplacedContacts]);

  // Clear co-located filter whenever Places search, space, or filter toggles change.
  useEffect(() => {
    if (lens === 'places') setCoLocatedIds(null);
  }, [lens, effectiveSpace, deferredSearchQuery, placesNotes, placesJournals, placesTasks, placesFiles, placesContacts]);

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

  // Explore inbox lists (computed only when the Explore lens is open so Graph filter/replay ticks stay single-pass)
  const exploreInbox = useMemo(
    () =>
      lens === 'inbox'
        ? buildExploreInbox({
            notes: scopedNotes,
            linkIndex,
            isNoteLocked,
            itemStyles,
            suggestedEdges,
          })
        : null,
    [lens, scopedNotes, linkIndex, isNoteLocked, itemStyles, suggestedEdges],
  );

  // Filtered Inbox lists
  const filteredInbox = useMemo(() => {
    if (!exploreInbox) return { suggested: [], missing: [], orphans: [], hubs: [] };
    const q = deferredSearchQuery.trim();
    if (!q) return exploreInbox;
    const match = textMatcher(q);
    return {
      suggested: exploreInbox.suggested.filter(
        (pair) =>
          Boolean(match(pair.sourceTitle)) ||
          Boolean(match(pair.targetTitle)) ||
          Boolean(formatWhyText(pair.why, t) && match(formatWhyText(pair.why, t)!)),
      ),
      missing: exploreInbox.missing.filter((m) => Boolean(match(m.name))),
      orphans: exploreInbox.orphans.filter(
        (n) => Boolean(match(n.title)) || Boolean(match(n.snippet)) || n.tags.some((tag) => Boolean(match(tag))),
      ),
      hubs: exploreInbox.hubs.filter(
        (n) => Boolean(match(n.title)) || Boolean(match(n.snippet)) || n.tags.some((tag) => Boolean(match(tag))),
      ),
    };
  }, [exploreInbox, deferredSearchQuery, t]);

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

  const parsedSelection = useMemo(
    () => (selectedId ? parseGraphSelectionId(selectedId) : null),
    [selectedId],
  );

  // Selected entity resolution for shared Inspector card
  const selectedGraphNode = useMemo(
    () => (selectedId ? snapshot.nodes.find((n) => n.id === selectedId) ?? null : null),
    [snapshot.nodes, selectedId],
  );

  const selectedMissing = useMemo(
    () =>
      parsedSelection?.kind === 'missing'
        ? resolveMissingTarget(parsedSelection.key, scopedNotes, linkIndex, isNoteLocked)
        : null,
    [parsedSelection, scopedNotes, linkIndex, isNoteLocked],
  );

  const selectedRealNote = useMemo(() => {
    if (parsedSelection?.kind !== 'note') return null;
    const note = notesById.get(parsedSelection.noteId);
    if (!note || !isEligibleGraphItem(note, isNoteLocked)) return null;
    return note;
  }, [parsedSelection, notesById, isNoteLocked]);

  const selectedConnections = useMemo(() => {
    if (!selectedRealNote) return null;
    const isVisible = (n: LocalNote | undefined): n is LocalNote =>
      Boolean(n && isEligibleGraphItem(n, isNoteLocked));
    const outgoingIds = linkIndex.outgoing.get(selectedRealNote.id)?.ids ?? [];
    const incomingIds = linkIndex.incoming.get(selectedRealNote.id) ?? [];
    const linkedSet = new Set<string>([...outgoingIds, ...incomingIds]);
    const from = incomingIds
      .map((id) => notesById.get(id))
      .filter(isVisible);
    const to = outgoingIds
      .map((id) => notesById.get(id))
      .filter(isVisible);
    const seenPairs = new Set<string>();
    const suggested = suggestedEdges
      .filter((edge) => edge.sourceId === selectedRealNote.id || edge.targetId === selectedRealNote.id)
      .map((edge) => {
        const otherId = edge.sourceId === selectedRealNote.id ? edge.targetId : edge.sourceId;
        if (otherId === selectedRealNote.id || linkedSet.has(otherId) || seenPairs.has(edge.key)) return null;
        const otherNote = notesById.get(otherId);
        if (!otherNote || !isVisible(otherNote)) return null;
        seenPairs.add(edge.key);
        return { key: edge.key, otherNote, whyText: formatWhyText(edge.why, t) };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return { from, to, suggested };
  }, [selectedRealNote, linkIndex, notesById, isNoteLocked, suggestedEdges, t]);

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

  const spaceOptions = useMemo(
    () => [
      { value: 'all' as const, label: t('shell:spaces.all') },
      { value: 'personal' as const, label: t('shell:spaces.personal') },
      { value: 'work' as const, label: t('shell:spaces.work') },
    ],
    [t],
  );

  const colorByOptions = useMemo(
    () => [
      { value: 'looks' as const, label: t('notes:graph.colorLooks') },
      { value: 'kind' as const, label: t('notes:graph.colorKind') },
      { value: 'hubs' as const, label: t('notes:graph.colorHubs') },
    ],
    [t],
  );

  const kindColorLegend = useMemo(
    () =>
      [
        { kind: 'note', color: 'blue' as const, label: t('notes:newMenu.note') },
        { kind: 'journal', color: 'purple' as const, label: t('notes:newMenu.journal') },
        { kind: 'task', color: 'green' as const, label: t('notes:newMenu.task') },
        { kind: 'contact', color: 'teal' as const, label: t('notes:newMenu.contact') },
        { kind: 'event', color: 'orange' as const, label: t('notes:newMenu.event') },
        { kind: 'drawing', color: 'pink' as const, label: t('notes:newMenu.drawing') },
        { kind: 'link', color: 'indigo' as const, label: t('notes:newMenu.bookmark') },
        { kind: 'file', color: 'gray' as const, label: t('shell:fileTypes.file') },
      ] as const,
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
    if (!parsedSelection) return null;

    const closeInspector = () => {
      setSelectedId(null);
      setEditingPlaceForId(null);
    };

    const shellClass =
      placement === 'overlay'
        ? compact
          ? 'absolute inset-x-2 bottom-2 z-30 flex max-h-[55%] flex-col gap-2.5 overflow-y-auto rounded-lg border border-divider bg-surface-2 p-3.5 shadow-lg'
          : lens === 'places'
            ? 'absolute top-3 start-3 z-30 flex w-80 max-h-[calc(100%-3rem)] flex-col gap-2.5 overflow-y-auto rounded-lg border border-divider bg-surface-2 p-3.5 shadow-lg'
            : 'absolute top-3 end-3 z-20 flex w-80 max-h-[calc(100%-4rem)] flex-col gap-2.5 overflow-y-auto rounded-lg border border-divider bg-surface-2 p-3.5 shadow-lg'
        : compact
          ? 'flex shrink-0 flex-col gap-2.5 border-b border-divider bg-surface-2 p-3.5'
          : 'flex max-h-[55%] shrink-0 flex-col gap-2.5 overflow-y-auto border-b border-divider bg-surface-2 p-3.5';

    // 1. Missing note-link node
    if (parsedSelection.kind === 'missing') {
      const title = selectedMissing?.name ?? selectedGraphNode?.title ?? parsedSelection.key;
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
          <div className="flex items-center gap-1.5 pt-0.5">
            <Button
              action="create"
              className="w-full justify-center"
              onClick={() => void (docked ? onCreateMissingNote(title, { keepOpen: true }) : onCreateMissingNote(title))}
            >
              {t('notes:createNote.confirm')}
            </Button>
          </div>
        </aside>
      );
    }

    // 2. Collapsed folder hub node
    if (parsedSelection.kind === 'folder') {
      const folderId = selectedGraphNode?.folderId ?? parsedSelection.folderId;
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
          <div className="flex items-center gap-1.5 pt-0.5">
            <Button
              variant="primary"
              className="w-full justify-center"
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
                    <FolderGlyph folderId={folder.id} size={14} className="shrink-0 text-label" />
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
                    <MapPin size={14} aria-hidden="true" className="shrink-0" />
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
                    className="inline-flex max-w-[11rem] items-center rounded-full bg-track px-2 py-0.5 text-meta font-medium text-pn-soft"
                  >
                    <TagMark tag={tag} size={14} />
                    <span className="truncate">{tag}</span>
                  </span>
                ))}
                {hiddenTagCount > 0 && (
                  <span className="inline-flex items-center rounded-full bg-track px-2 py-0.5 text-meta text-pn-muted">
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

        {/* Uniform 2-column action grid */}
        <div className="grid grid-cols-2 gap-1.5 pt-0.5">
          <Button
            action="open"
            variant="primary"
            className={
              (lens === 'places' && (note.locked === 1 || isEditingPlace))
                ? 'col-span-2 w-full justify-center'
                : 'w-full justify-center'
            }
            onClick={() => (docked ? onOpenNote(note.id, { keepOpen: true }) : onOpenNote(note.id))}
          >
            {t('shell:contacts.open')}
          </Button>
          {lens === 'places' && note.locked !== 1 && !isEditingPlace && (
            <Button
              icon={<MapPin aria-hidden="true" />}
              className="w-full justify-center"
              onClick={() => setEditingPlaceForId(note.id)}
            >
              {exactLoc ? t('notes:graph.editPlace') : t('notes:graph.setPlace')}
            </Button>
          )}
          {lens === 'graph' && (
            <Button
              variant={isFocused ? 'primary' : 'secondary'}
              aria-pressed={isFocused}
              icon={<Crosshair aria-hidden="true" />}
              className="w-full justify-center"
              onClick={() => {
                if (isFocused) setFocusNodeId(null);
                else {
                  setFocusNodeId(note.id);
                  setFocusDepth(2);
                }
              }}
            >
              {isFocused ? t('notes:graph.clearFocus') : t('notes:graph.focus2Hop')}
            </Button>
          )}
          {lens === 'graph' && isPinned && (
            <Button
              icon={<PushPinSlash aria-hidden="true" />}
              className="col-span-2 w-full justify-center"
              onClick={() => handleUnpinNode(note.id)}
            >
              {t('notes:graph.unpinPosition')}
            </Button>
          )}
        </div>

        {/* External map links (OpenStreetMap + Google Maps) */}
        {lens === 'places' && activeLoc && (
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              action="open"
              className="w-full justify-center"
              aria-label={t('notes:location.openOsm')}
              onClick={() => openExternal(osmUrl(activeLoc.lat, activeLoc.lng), { browser: true })}
            >
              OpenStreetMap
            </Button>
            <Button
              action="open"
              className="w-full justify-center"
              aria-label={t('notes:location.openGoogleMaps')}
              onClick={() => openExternal(googleMapsUrl(activeLoc.lat, activeLoc.lng), { browser: true })}
            >
              Google Maps
            </Button>
          </div>
        )}

        {/* Contact quick actions */}
        {isContact && (contact?.phones[0] || contact?.emails[0]) && (
          <div className="grid grid-cols-2 gap-1.5">
            {contact?.phones[0] && (
              <>
                <Button
                  action="open"
                  className="w-full justify-center"
                  onClick={() => openExternal(telHref(contact.phones[0]!.value))}
                >
                  {t('shell:contacts.call')}
                </Button>
                <Button
                  action="open"
                  className="w-full justify-center"
                  onClick={() => openExternal(smsHref(contact.phones[0]!.value))}
                >
                  {t('shell:contacts.message')}
                </Button>
              </>
            )}
            {contact?.emails[0] && (
              <Button
                icon={<EnvelopeSimple aria-hidden="true" />}
                className="col-span-2 w-full justify-center"
                onClick={() => openExternal(`mailto:${contact.emails[0]!.value}`)}
              >
                {t('shell:contacts.sendEmail')}
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
                      className="flex flex-col gap-1 rounded-md border border-dashed border-divider bg-surface-2 p-2"
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
      title={t('notes:graph.workspaceTitle')}
      headerExtra={
        spacesEnabled ? (
          <SpaceSwitch active={spaceFilter} onChange={handleSpaceFilterChange} locked={!isPro} />
        ) : undefined
      }
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
          const parsed = parseGraphSelectionId(nodeId);
          if (parsed.kind === 'missing') {
            const missing = resolveMissingTarget(parsed.key, scopedNotes, linkIndex, isNoteLocked);
            const name = missing?.name ?? parsed.key;
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
          if (parsed.kind === 'folder') {
            const fid = parsed.folderId;
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
              return scopedNotes
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

        const searchField = (
          <div className={compact ? 'w-full' : 'min-w-[11rem] max-w-xs flex-1'}>
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
        );

        return (
          <>
            {/* Full-width underline lens tab strip (SettingsTabStrip pattern) */}
            <SettingsTabStrip
              aria-label={t('notes:graph.workspaceTitle')}
              className="shrink-0 bg-surface-2 px-4"
            >
              <button
                type="button"
                aria-pressed={lens === 'graph'}
                className={settingsTabClass(lens === 'graph')}
                onClick={() => setLens('graph')}
              >
                <Graph aria-hidden="true" />
                <span>{t('notes:footer.graph')}</span>
              </button>
              <button
                type="button"
                aria-pressed={lens === 'places'}
                className={settingsTabClass(lens === 'places')}
                onClick={() => setLens('places')}
              >
                <MapPin aria-hidden="true" />
                <span className="inline-flex items-center gap-1">
                  {t('notes:graph.lensPlaces')}
                  {!isPro && <IconUpgrade size={10} />}
                </span>
              </button>
              <button
                type="button"
                aria-pressed={lens === 'inbox'}
                className={settingsTabClass(lens === 'inbox')}
                onClick={() => setLens('inbox')}
              >
                <Compass aria-hidden="true" />
                <span>{t('stats:wellness.subTabs.explore')}</span>
              </button>
            </SettingsTabStrip>

      {/* Lens 1: Graph */}
      {lens === 'graph' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Focus badge strip (dedicated row when active so toolbar stays clean) */}
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

          {/* Search + Graph toolbar strip */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider bg-surface-2 px-4 py-2">
            {searchField}
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
              {compact ? (
                <IconButton
                  label={layoutLocked ? t('notes:graph.unlockLayout') : t('notes:graph.lockLayout')}
                  tone={layoutLocked ? 'accent' : 'quiet'}
                  aria-pressed={layoutLocked}
                  className={layoutLocked ? 'bg-accent/12' : ''}
                  onClick={toggleLayoutLocked}
                >
                  {layoutLocked ? (
                    <LockSimple weight="fill" aria-hidden="true" />
                  ) : (
                    <LockSimpleOpen aria-hidden="true" />
                  )}
                </IconButton>
              ) : (
                <Button
                  variant={layoutLocked ? 'primary' : 'secondary'}
                  aria-pressed={layoutLocked}
                  icon={
                    layoutLocked ? (
                      <LockSimple weight="fill" aria-hidden="true" />
                    ) : (
                      <LockSimpleOpen aria-hidden="true" />
                    )
                  }
                  onClick={toggleLayoutLocked}
                >
                  {layoutLocked ? t('notes:graph.layoutLocked') : t('notes:graph.lockLayout')}
                </Button>
              )}
            </div>

            <div className="ms-auto flex items-center gap-1.5">
              <span ref={viewsAnchorRef}>
                {compact ? (
                  <IconButton
                    label={activeView ? `${t('notes:graph.savedViews')}: ${activeView.name}` : t('notes:graph.savedViews')}
                    tone={viewsOpen || activeView ? 'accent' : 'quiet'}
                    aria-expanded={viewsOpen}
                    aria-pressed={Boolean(activeView)}
                    className={viewsOpen || activeView ? 'bg-accent/12' : ''}
                    onClick={() => {
                      setControlsOpen(false);
                      setViewsOpen((o) => !o);
                    }}
                  >
                    <Stack weight={activeView ? 'fill' : 'bold'} aria-hidden="true" />
                  </IconButton>
                ) : (
                  <Button
                    icon={<Stack weight={activeView ? 'fill' : 'bold'} aria-hidden="true" />}
                    variant={viewsOpen || activeView ? 'primary' : 'secondary'}
                    aria-expanded={viewsOpen}
                    onClick={() => {
                      setControlsOpen(false);
                      setViewsOpen((o) => !o);
                    }}
                  >
                    <span className="max-w-[9rem] truncate" dir="auto">
                      {activeView ? activeView.name : t('notes:graph.views')}
                    </span>
                    {activeView && isViewModified && (
                      <span className="ms-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                    )}
                  </Button>
                )}
              </span>
              <Popover
                open={viewsOpen}
                anchorRef={viewsAnchorRef}
                onClose={() => {
                  setViewsOpen(false);
                  setNewViewName('');
                  setRenamingViewId(null);
                }}
                title={t('notes:graph.savedViews')}
                align="end"
                className="w-80 max-w-[calc(100vw-1rem)]"
              >
                <div className="flex flex-col gap-2.5 p-1">
                  {savedViewsList.length === 0 ? (
                    <p className={SETTINGS_HELP}>{t('notes:graph.savedViewsEmpty')}</p>
                  ) : (
                    <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                      {savedViewsList.map((view) => {
                        const isActive = view.id === activeView?.id;
                        const isRenaming = renamingViewId === view.id;
                        return (
                          <li key={view.id} className="flex items-center gap-1">
                            {isRenaming ? (
                              <InlineRenameField
                                value={renameDraft}
                                onValueChange={setRenameDraft}
                                onCommit={() => handleCommitRenameView(view)}
                                onCancel={() => setRenamingViewId(null)}
                                onFocus={(e) => e.currentTarget.select()}
                                maxLength={GRAPH_VIEW_NAME_MAX}
                                aria-label={t('common:actions.rename')}
                                className="min-w-0 flex-1 border-b border-accent/50 bg-transparent px-2 py-1 text-small font-medium text-pn outline-none focus:border-accent"
                              />
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleApplySavedView(view)}
                                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-small transition ${
                                    isActive
                                      ? 'bg-accent/10 font-medium text-accent-strong'
                                      : 'text-pn hover:bg-pn/5'
                                  }`}
                                >
                                  <Check
                                    aria-hidden="true"
                                    className={`shrink-0 ${isActive ? 'text-accent opacity-100' : 'opacity-0'}`}
                                  />
                                  <span className="min-w-0 flex-1 truncate" dir="auto">
                                    {view.name}
                                  </span>
                                  {isActive && isViewModified && (
                                    <Badge tone="neutral">{t('notes:graph.viewEdited')}</Badge>
                                  )}
                                </button>
                                <IconButton
                                  label={t('common:actions.rename')}
                                  position="above-end"
                                  onClick={() => {
                                    setRenamingViewId(view.id);
                                    setRenameDraft(view.name);
                                  }}
                                >
                                  <PencilSimple aria-hidden="true" />
                                </IconButton>
                                <DeleteButton
                                  label={t('notes:graph.deleteView', { name: view.name })}
                                  position="above-end"
                                  onConfirm={() => handleDeleteView(view)}
                                />
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <Divider />
                  {activeView && isViewModified && (
                    <Button
                      action="save"
                      className="w-full justify-center"
                      onClick={handleUpdateActiveView}
                    >
                      {t('notes:graph.updateView', { name: activeView.name })}
                    </Button>
                  )}
                  {canCreateView ? (
                    <div className="flex flex-col gap-2">
                      <TextField
                        autoFocus={savedViewsList.length === 0}
                        value={newViewName}
                        maxLength={GRAPH_VIEW_NAME_MAX}
                        onChange={(e) => setNewViewName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleSaveNewView();
                          }
                        }}
                        label={t('notes:graph.viewNameLabel')}
                        placeholder={t('notes:graph.viewNamePlaceholder')}
                      />
                      <Button
                        action="save"
                        className="w-full justify-center"
                        disabled={newViewName.trim().length === 0}
                        onClick={handleSaveNewView}
                      >
                        {t('notes:graph.saveCurrentView')}
                      </Button>
                    </div>
                  ) : (
                    <p className={SETTINGS_HELP}>
                      {t('notes:graph.viewLimitReached', { count: GRAPH_VIEW_MAX })}
                    </p>
                  )}
                  {(activeView || hasNonDefaultFilters) && (
                    <Button
                      icon={<ArrowCounterClockwise aria-hidden="true" />}
                      className="w-full justify-center"
                      onClick={handleResetFilters}
                    >
                      {t('notes:graph.resetFilters')}
                    </Button>
                  )}
                </div>
              </Popover>
              <span ref={controlsAnchorRef}>
                <Button
                  icon={<SlidersHorizontal aria-hidden="true" />}
                  variant={controlsOpen ? 'primary' : 'secondary'}
                  aria-expanded={controlsOpen}
                  onClick={() => {
                    setViewsOpen(false);
                    setControlsOpen((o) => !o);
                  }}
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
                  {spacesEnabled && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <SectionEyebrow>{t('shell:spaces.label')}</SectionEyebrow>
                        <div role="group" aria-label={t('shell:spaces.label')} className={SETTINGS_TRACK}>
                          {spaceOptions.map((o) => (
                            <button
                              key={o.value}
                              type="button"
                              aria-pressed={spaceFilter === o.value}
                              onClick={() => handleSpaceFilterChange(o.value)}
                              className={settingsSegClass(spaceFilter === o.value, true)}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <Divider />
                    </>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <SectionEyebrow>{t('notes:graph.colorBy')}</SectionEyebrow>
                    <div role="group" aria-label={t('notes:graph.colorBy')} className={SETTINGS_TRACK}>
                      {colorByOptions.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          aria-pressed={colorBy === o.value}
                          onClick={() => setColorBy(o.value)}
                          className={settingsSegClass(colorBy === o.value, true)}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                    {colorBy === 'kind' && (
                      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1" aria-label={t('notes:graph.colorKind')}>
                        {kindColorLegend.map((item) => (
                          <li key={item.kind} className="flex min-w-0 items-center gap-1.5 text-meta text-pn-soft">
                            <span
                              aria-hidden="true"
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: `var(--pn-label-${item.color}-ink)` }}
                            />
                            <span className="truncate">{item.label}</span>
                          </li>
                        ))}
                      </ul>
                    )}
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
                    className="w-full justify-center"
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
              <Button
                variant={replayPlaying ? 'secondary' : 'primary'}
                icon={replayPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                onClick={() => setReplayPlaying((p) => !p)}
              >
                {replayPlaying ? t('media:attachment.pause') : t('media:attachment.play')}
              </Button>
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
              <span className="shrink-0 whitespace-nowrap text-small tabular-nums text-pn-soft">
                {t('notes:graph.upToDate', { date: replayDateLabel })}
              </span>
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
                if (!isSyntheticGraphId(id)) openNote(id, opts);
              }}
              onExpandFolderHub={(fid) => setExpandedFolderIds((prev) => new Set(prev).add(fid))}
              onCreateLink={(src, tgt) => {
                if (!isSyntheticGraphId(src) && !isSyntheticGraphId(tgt)) {
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
              layoutLocked={layoutLocked}
              canvasUnavailableLabel={t('notes:graph.canvasUnavailable')}
              dark={dark}
              ariaLabel={t('notes:graph.canvasAria')}
            />
            {snapshot.nodes.length === 0 && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-0/90">
                <EmptyState
                  icon={<Graph weight="duotone" aria-hidden="true" />}
                  title={t('notes:graph.emptyGraphTitle')}
                  actions={
                    hasItemsInOtherSpace ? (
                      <Button icon={<Stack aria-hidden="true" />} onClick={() => handleSpaceFilterChange('all')}>
                        {t('shell:spaces.switchToAll')}
                      </Button>
                    ) : undefined
                  }
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
                  {layoutLocked ? (
                    <span className="inline-flex items-center gap-1">
                      <LockSimple aria-hidden="true" />
                      <span>{t('notes:graph.lockedBrowseHint')}</span>
                    </span>
                  ) : (
                    <>
                      <span>{t('notes:graph.dragPinHint')}</span>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1">
                        <Trans
                          i18nKey={KEY_OS === 'mac' ? 'notes:graph.dragLinkHintMac' : 'notes:graph.dragLinkHintPc'}
                          components={{ kbd: <Kbd>{null}</Kbd> }}
                        />
                      </span>
                    </>
                  )}
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
          {/* Search + Places filter strip + collapsible In this area toggle */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider bg-surface-2 px-4 py-2">
            {searchField}
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {compact ? (
                <>
                  <IconButton
                    label={t('shell:tagsRail.notes')}
                    tone={placesNotes ? 'accent' : 'quiet'}
                    aria-pressed={placesNotes}
                    className={placesNotes ? 'bg-accent/12' : ''}
                    onClick={() => setPlacesNotes((v) => !v)}
                  >
                    <NotePencil aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t('shell:tagsRail.journals')}
                    tone={placesJournals ? 'accent' : 'quiet'}
                    aria-pressed={placesJournals}
                    className={placesJournals ? 'bg-accent/12' : ''}
                    onClick={() => setPlacesJournals((v) => !v)}
                  >
                    <PenNib aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t('shell:tagsRail.tasks')}
                    tone={placesTasks ? 'accent' : 'quiet'}
                    aria-pressed={placesTasks}
                    className={placesTasks ? 'bg-accent/12' : ''}
                    onClick={() => setPlacesTasks((v) => !v)}
                  >
                    <CheckFat aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t('shell:tagsRail.files')}
                    tone={placesFiles ? 'accent' : 'quiet'}
                    aria-pressed={placesFiles}
                    className={placesFiles ? 'bg-accent/12' : ''}
                    onClick={() => setPlacesFiles((v) => !v)}
                  >
                    <Paperclip aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t('shell:tagsRail.contacts')}
                    tone={placesContacts ? 'accent' : 'quiet'}
                    aria-pressed={placesContacts}
                    className={placesContacts ? 'bg-accent/12' : ''}
                    onClick={() => setPlacesContacts((v) => !v)}
                  >
                    <User aria-hidden="true" />
                  </IconButton>
                </>
              ) : (
                <>
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
                    variant={placesTasks ? 'primary' : 'secondary'}
                    aria-pressed={placesTasks}
                    icon={<CheckFat aria-hidden="true" />}
                    onClick={() => setPlacesTasks((v) => !v)}
                  >
                    {t('shell:tagsRail.tasks')}
                  </Button>
                  <Button
                    variant={placesFiles ? 'primary' : 'secondary'}
                    aria-pressed={placesFiles}
                    icon={<Paperclip aria-hidden="true" />}
                    onClick={() => setPlacesFiles((v) => !v)}
                  >
                    {t('shell:tagsRail.files')}
                  </Button>
                  <Button
                    variant={placesContacts ? 'primary' : 'secondary'}
                    aria-pressed={placesContacts}
                    icon={<User aria-hidden="true" />}
                    onClick={() => setPlacesContacts((v) => !v)}
                  >
                    {t('shell:tagsRail.contacts')}
                  </Button>
                </>
              )}
            </div>

            <div className="ms-auto flex shrink-0 items-center gap-1.5">
              {compact ? (
                <IconButton
                  label={
                    coLocatedIds
                      ? t('notes:graph.coLocatedTitle', { count: areaItems.length })
                      : t('notes:graph.inThisArea', { count: areaItems.length })
                  }
                  tone={placesPanelOpen ? 'accent' : 'quiet'}
                  aria-pressed={placesPanelOpen}
                  className={placesPanelOpen ? 'bg-accent/12' : ''}
                  onClick={togglePlacesPanel}
                >
                  <SidebarSimple aria-hidden="true" />
                </IconButton>
              ) : (
                <Button
                  variant={placesPanelOpen ? 'primary' : 'secondary'}
                  aria-pressed={placesPanelOpen}
                  icon={<SidebarSimple aria-hidden="true" />}
                  onClick={togglePlacesPanel}
                >
                  {coLocatedIds
                    ? t('notes:graph.coLocatedTitle', { count: areaItems.length })
                    : t('notes:graph.inThisArea', { count: areaItems.length })}
                </Button>
              )}
            </div>
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
                    if (!placesPanelOpen) setPlacesPanelOpen(true);
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
              {!placesPanelOpen && selectedRealNote && renderInspector('overlay', compact, docked)}
            </div>

            {/* Collapsible side list column (wide) / bottom panel (phone or docked).
                In compact mode the inspector and list share one scroll region so the list is never crushed to 0px. */}
            {placesPanelOpen && (
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
                    actions={
                      hasItemsInOtherSpace ? (
                        <Button icon={<Stack aria-hidden="true" />} onClick={() => handleSpaceFilterChange('all')}>
                          {t('shell:spaces.switchToAll')}
                        </Button>
                      ) : undefined
                    }
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
                  <div className="border-t border-divider bg-surface-2 px-3 py-2">
                    <Disclosure
                      open={notOnMapOpen}
                      onOpenChange={setNotOnMapOpen}
                      label={t('notes:graph.notOnMapCount', { count: placesResult.unplacedContacts.length })}
                      panelClassName="mt-2 flex flex-col gap-2 pb-1"
                    >
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
                    </Disclosure>
                  </div>
                )}
              </div>

              {/* Privacy notice at foot */}
              <p className={`flex shrink-0 items-start gap-1.5 border-t border-divider px-3 py-2 ${SETTINGS_HELP}`}>
                <ShieldCheck className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{t('notes:location.mapNotice')}</span>
              </p>
            </div>
            )}
          </div>
        </div>
      )}

      {/* Lens 3: Inbox */}
      {lens === 'inbox' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center border-b border-divider bg-surface-2 px-4 py-2">
            <div className="w-full max-w-md">
              <ListSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder={t('notes:graph.searchGraphPlaceholder')}
                ariaLabel={t('notes:graph.searchGraphPlaceholder')}
              />
            </div>
          </div>
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
                    <Button
                      icon={<CaretDown aria-hidden="true" />}
                      className="w-full justify-center"
                      onClick={() => setMissingLimit((n) => n + INBOX_INITIAL_ROWS)}
                    >
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
                    <Button
                      icon={<CaretDown aria-hidden="true" />}
                      className="w-full justify-center"
                      onClick={() => setOrphanLimit((n) => n + INBOX_INITIAL_ROWS)}
                    >
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
        </div>
      )}

            <ContextMenu state={nodeCtx.state} onClose={nodeCtx.close} />
            {linkPickerSource && (
              <PickerModal
                title={t('notes:graph.linkTo')}
                icon={<LinkSimple size={16} />}
                layer="z-[60]"
                maxHeight="max-h-[70vh]"
                onClose={() => setLinkPickerSourceId(null)}
                search={{
                  value: linkPickerQuery,
                  onChange: setLinkPickerQuery,
                  placeholder: t('notes:graph.linkToPlaceholder'),
                  ariaLabel: t('notes:graph.linkToPlaceholder'),
                }}
              >
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
                          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-start text-body text-pn transition hover:bg-pn/5"
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
              </PickerModal>
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
