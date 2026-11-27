/**
 * Multi-pin Places map for notes, journals, and contacts. Its own lazy chunk:
 * MapLibre, the pmtiles reader, and the Protomaps style never load on the boot
 * path or before the Places lens opens.
 *
 * Tiles come in byte ranges from one world file on our own host
 * (`mapSource()` in noteLocation.ts), so no third party sees the request.
 * Screen-space clustering groups nearby pins on the live projection, and
 * viewport changes report visible item IDs so the parent side list stays synced.
 *
 * Spec: docs/internal/specs/graph-view.md (section 4.4)
 */
import { useEffect, useRef, useState } from 'react';
import { LngLatBounds, Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createProtomapsStyle, ensureMapLibreReady, isMapAbortEvent } from '../mapLibreSetup';
import { canReadPosition, readCurrentPosition } from '../currentPosition';
import { openExternal } from '../openExternal';
import { isLookColor } from '../itemStyles';
import { kindLookColor } from './GraphCanvas';
import {
  CornersOut,
  Crosshair,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  MapPin,
  User,
} from '../icons';
import { Callout, CanvasControlBar, EmptyState, FeedbackButton, IconButton, Spinner, StatusLine } from '../ui';

export interface PlacesMapItem {
  id: string;
  title: string;
  kind: 'note' | 'journal' | 'task' | 'file' | 'contact';
  lat: number;
  lng: number;
  label?: string;
  exact: boolean;
  initials?: string;
  colorKey?: string | null;
}

interface GraphPlacesMapLabels {
  mapLabel: string;
  zoomIn: string;
  zoomOut: string;
  fitAll: string;
  myLocation: string;
  locating: string;
  mapFailed: string;
  osmCredit: string;
  retry?: string;
  locateError?: (error: 'denied' | 'off' | 'timeout') => string;
}

interface GraphPlacesMapProps {
  items: readonly PlacesMapItem[];
  selectedId: string | null;
  focusItemId?: string | null;
  focusRequest?: { id: string; nonce: number } | null;
  placesLoaded?: boolean;
  dark: boolean;
  lang: string;
  onSelectItem: (id: string | null) => void;
  onOpenItem: (id: string) => void;
  onSelectCoLocated?: (items: PlacesMapItem[]) => void;
  onVisibleIdsChange?: (visibleIds: Set<string>) => void;
  onUserMove?: () => void;
  labels: GraphPlacesMapLabels;
}

interface ScreenCluster {
  key: string;
  x: number;
  y: number;
  inViewport: boolean;
  items: PlacesMapItem[];
}

/** How long the first draw may take before the map counts as failed. */
const LOAD_TIMEOUT_MS = 15_000;
/** Pins closer than this in screen pixels group into one cluster pill. */
const CLUSTER_RADIUS_PX = 44;
/** Items within this coordinate span count as co-located on click. */
const CO_LOCATED_DEG = 0.0002;
/** At or above this zoom level, clicking a cluster selects its co-located items instead of zooming further. */
const CO_LOCATED_MAX_ZOOM = 17;
/** Target zoom when flying to a focused item or the user's current position. */
const FOCUS_ZOOM = 13;
/** Default zoom when fitting a single item or one co-located group. */
const SINGLE_PIN_ZOOM = 12;
/** Screen-space padding around the map viewport for keeping nearby markers mounted during drags. */
const VIEWPORT_MARGIN_PX = 64;

function areCoLocated(items: readonly PlacesMapItem[]): boolean {
  if (items.length <= 1) return true;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const item of items) {
    if (item.lat < minLat) minLat = item.lat;
    if (item.lat > maxLat) maxLat = item.lat;
    if (item.lng < minLng) minLng = item.lng;
    if (item.lng > maxLng) maxLng = item.lng;
  }
  return maxLat - minLat <= CO_LOCATED_DEG && maxLng - minLng <= CO_LOCATED_DEG;
}

function boundsForItems(items: readonly PlacesMapItem[]): LngLatBounds {
  const bounds = new LngLatBounds();
  for (const item of items) {
    bounds.extend([item.lng, item.lat]);
  }
  return bounds;
}

function isInBounds(bounds: LngLatBounds, lng: number, lat: number): boolean {
  if (lat < bounds.getSouth() || lat > bounds.getNorth()) return false;
  const west = bounds.getWest();
  const east = bounds.getEast();
  if (east - west >= 360) return true;
  const norm = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
  const nLng = norm(lng);
  const nWest = norm(west);
  const nEast = norm(east);
  if (nWest <= nEast) return nLng >= nWest && nLng <= nEast;
  // Bounds wrap across the antimeridian.
  return nLng >= nWest || nLng <= nEast;
}

function fitItemsOnMap(map: MapLibreMap, items: readonly PlacesMapItem[], animate: boolean, maxZoom = 14): void {
  if (items.length === 0) return;
  if (items.length === 1 || areCoLocated(items)) {
    const first = items[0]!;
    if (animate) {
      map.flyTo({ center: [first.lng, first.lat], zoom: SINGLE_PIN_ZOOM, duration: 500 });
    } else {
      map.jumpTo({ center: [first.lng, first.lat], zoom: SINGLE_PIN_ZOOM });
    }
    return;
  }
  const container = map.getContainer();
  const minDim = Math.min(container.clientWidth || 320, container.clientHeight || 240);
  const pad = Math.max(16, Math.min(64, Math.floor(minDim * 0.2)));
  try {
    map.fitBounds(boundsForItems(items), {
      padding: pad,
      maxZoom,
      duration: animate ? 500 : 0,
    });
  } catch {
    // Fallback if viewport is temporarily tiny during a layout transition.
    const first = items[0]!;
    map.jumpTo({ center: [first.lng, first.lat], zoom: 2 });
  }
}

function computeScreenClusters(map: MapLibreMap, items: readonly PlacesMapItem[]): ScreenCluster[] {
  const container = map.getContainer();
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width === 0 || height === 0 || items.length === 0) return [];

  // Deterministic input order ensures stable cluster seeds across renders and pans.
  const projected: Array<{ item: PlacesMapItem; x: number; y: number }> = [];
  for (const item of items) {
    const pt = map.project([item.lng, item.lat]);
    if (
      pt.x < -VIEWPORT_MARGIN_PX
      || pt.x > width + VIEWPORT_MARGIN_PX
      || pt.y < -VIEWPORT_MARGIN_PX
      || pt.y > height + VIEWPORT_MARGIN_PX
    ) {
      continue;
    }
    projected.push({ item, x: pt.x, y: pt.y });
  }
  projected.sort((a, b) => (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));

  interface DraftCluster {
    seedX: number;
    seedY: number;
    sumX: number;
    sumY: number;
    items: PlacesMapItem[];
  }

  const drafts: DraftCluster[] = [];
  for (const { item, x, y } of projected) {
    let matched: DraftCluster | undefined;
    for (const draft of drafts) {
      if (Math.hypot(x - draft.seedX, y - draft.seedY) <= CLUSTER_RADIUS_PX) {
        matched = draft;
        break;
      }
    }

    if (matched) {
      matched.items.push(item);
      matched.sumX += x;
      matched.sumY += y;
    } else {
      drafts.push({
        seedX: x,
        seedY: y,
        sumX: x,
        sumY: y,
        items: [item],
      });
    }
  }

  return drafts.map((draft) => {
    const count = draft.items.length;
    const x = draft.sumX / count;
    const y = draft.sumY / count;
    const key = count === 1
      ? draft.items[0]!.id
      : `c:${draft.items.map((item) => item.id).sort().join('|')}`;
    return {
      key,
      x,
      y,
      inViewport: x >= 0 && x <= width && y >= 0 && y <= height,
      items: draft.items,
    };
  });
}

export function pinColorFor(item: PlacesMapItem): string {
  const color = (item.colorKey && isLookColor(item.colorKey) ? item.colorKey : null) ?? kindLookColor(item.kind);
  return color ? `var(--pn-label-${color}-ink)` : 'var(--color-accent-fill)';
}

function formatInitials(raw?: string): string {
  if (!raw) return '';
  return [...raw.trim()].slice(0, 2).join('').toUpperCase();
}

function markerAriaLabel(item: PlacesMapItem): string {
  return item.label ? `${item.title} (${item.label})` : item.title;
}

function clusterAriaLabel(items: readonly PlacesMapItem[]): string {
  const sample = items.slice(0, 3).map((item) => item.title).join(', ');
  return items.length > 3 ? `${items.length}: ${sample}...` : `${items.length}: ${sample}`;
}

export default function GraphPlacesMap({
  items,
  selectedId,
  focusItemId = null,
  focusRequest = null,
  placesLoaded = false,
  dark,
  lang,
  onSelectItem,
  onOpenItem,
  onSelectCoLocated,
  onVisibleIdsChange,
  onUserMove,
  labels,
}: GraphPlacesMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [clusters, setClusters] = useState<ScreenCluster[]>([]);
  const [mapFailed, setMapFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<'denied' | 'off' | 'timeout' | null>(null);

  const effectiveFocusId = focusRequest?.id ?? focusItemId;
  const effectiveFocusKey = focusRequest
    ? `${focusRequest.id}:${focusRequest.nonce}`
    : (focusItemId ?? null);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const focusItemIdRef = useRef(effectiveFocusId);
  focusItemIdRef.current = effectiveFocusId;
  const focusKeyRef = useRef(effectiveFocusKey);
  focusKeyRef.current = effectiveFocusKey;
  const onSelectItemRef = useRef(onSelectItem);
  onSelectItemRef.current = onSelectItem;
  const onVisibleIdsChangeRef = useRef(onVisibleIdsChange);
  onVisibleIdsChangeRef.current = onVisibleIdsChange;
  const onUserMoveRef = useRef(onUserMove);
  onUserMoveRef.current = onUserMove;

  const mountedRef = useRef(true);
  const didInitialFitRef = useRef(false);
  const didPostLoadFitRef = useRef(false);
  const userInteractedRef = useRef(false);
  const lastFocusedKeyRef = useRef<string | null>(null);
  const lastVisibleKeyRef = useRef<string | null>(null);
  const styleKeyRef = useRef(`${dark ? 'dark' : 'light'}:${lang}`);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!locateError) return;
    const id = window.setTimeout(() => setLocateError(null), 5000);
    return () => window.clearTimeout(id);
  }, [locateError]);

  const scheduleClusterUpdateRef = useRef<() => void>(() => {});
  scheduleClusterUpdateRef.current = () => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const map = mapRef.current;
      if (!map) return;
      setClusters(computeScreenClusters(map, itemsRef.current));
    });
  };

  const emitVisibleIdsRef = useRef<() => void>(() => {});
  emitVisibleIdsRef.current = () => {
    const cb = onVisibleIdsChangeRef.current;
    if (!cb) return;
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    const visible = new Set<string>();
    for (const item of itemsRef.current) {
      if (isInBounds(bounds, item.lng, item.lat)) {
        visible.add(item.id);
      }
    }
    const key = [...visible].sort().join('\n');
    if (key === lastVisibleKeyRef.current) return;
    lastVisibleKeyRef.current = key;
    cb(visible);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initialize MapLibre once per mount/retry; theme and language updates swap the style in place.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapFailed) return;

    let map: MapLibreMap | undefined;
    let loaded = false;
    let failed = false;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (event?: object) => {
      if (failed || loaded || gone) return;
      if (isMapAbortEvent(event)) return;
      failed = true;
      setMapFailed(true);
    };

    const onContextLost = (e: Event) => {
      e.preventDefault();
      if (gone) return;
      failed = true;
      setMapFailed(true);
    };

    try {
      ensureMapLibreReady();
      const initialItems = itemsRef.current;
      const initialFocus = focusItemIdRef.current
        ? initialItems.find((item) => item.id === focusItemIdRef.current)
        : undefined;

      const initialCenter: [number, number] = initialFocus
        ? [initialFocus.lng, initialFocus.lat]
        : initialItems.length > 0
          ? [initialItems[0]!.lng, initialItems[0]!.lat]
          : [10, 25];
      const initialZoom = initialFocus
        ? FOCUS_ZOOM
        : initialItems.length > 0
          ? SINGLE_PIN_ZOOM
          : 1.6;

      styleKeyRef.current = `${dark ? 'dark' : 'light'}:${lang}`;

      map = new MapLibreMap({
        container: el,
        style: createProtomapsStyle(dark, lang),
        center: initialCenter,
        zoom: initialZoom,
        attributionControl: false,
        scrollZoom: true,
        locale: {
          'Map.Title': labels.mapLabel,
        },
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });

      map.touchZoomRotate.disableRotation();
      mapRef.current = map;

      map.getCanvas().addEventListener('webglcontextlost', onContextLost);

      if (initialFocus) {
        didInitialFitRef.current = true;
        lastFocusedKeyRef.current = focusKeyRef.current;
      } else if (initialItems.length > 0) {
        fitItemsOnMap(map, initialItems, false);
        didInitialFitRef.current = true;
      }

      map.on('load', () => {
        loaded = true;
        if (timer !== undefined) clearTimeout(timer);
        scheduleClusterUpdateRef.current();
        emitVisibleIdsRef.current();
      });

      map.on('dragstart', () => {
        userInteractedRef.current = true;
        onUserMoveRef.current?.();
      });

      map.on('zoomstart', (ev) => {
        if (ev && 'originalEvent' in ev && ev.originalEvent) {
          userInteractedRef.current = true;
          onUserMoveRef.current?.();
        }
      });

      map.on('move', () => {
        scheduleClusterUpdateRef.current();
      });

      map.on('zoom', () => {
        scheduleClusterUpdateRef.current();
      });

      map.on('moveend', () => {
        scheduleClusterUpdateRef.current();
        emitVisibleIdsRef.current();
      });

      map.on('zoomend', () => {
        scheduleClusterUpdateRef.current();
        emitVisibleIdsRef.current();
      });

      map.on('click', () => {
        onSelectItemRef.current(null);
      });

      // After the first draw a missing tile is only a gap; before it, the map failed.
      map.on('error', fail);

      scheduleClusterUpdateRef.current();
      emitVisibleIdsRef.current();
    } catch {
      // No WebGL: MapLibre throws while it builds the canvas.
      fail();
    }

    timer = setTimeout(() => fail(), LOAD_TIMEOUT_MS);

    const sized = new ResizeObserver(() => {
      if (!map) return;
      map.resize();
      if (map.isStyleLoaded()) map.redraw();
      scheduleClusterUpdateRef.current();
      emitVisibleIdsRef.current();
    });
    sized.observe(el);

    return () => {
      gone = true;
      sized.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      try {
        map?.getCanvas().removeEventListener('webglcontextlost', onContextLost);
      } catch {
        // Canvas may already be detached.
      }
      mapRef.current = null;
      didInitialFitRef.current = false;
      didPostLoadFitRef.current = false;
      userInteractedRef.current = false;
      lastVisibleKeyRef.current = null;
      map?.remove();
    };
  // MapLibre mounts once per non-failed session; dark/lang/labels update without tearing down WebGL.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapFailed, attempt]);

  // Swap basemap flavor or label language without resetting the camera.
  useEffect(() => {
    const map = mapRef.current;
    const nextKey = `${dark ? 'dark' : 'light'}:${lang}`;
    if (!map || mapFailed || styleKeyRef.current === nextKey) return;
    styleKeyRef.current = nextKey;
    map.setStyle(createProtomapsStyle(dark, lang));
  }, [dark, lang, mapFailed]);

  // React to items changes: fit once initially, and once more when async contact town matches arrive (if user hasn't panned).
  useEffect(() => {
    if (mapFailed) {
      const cb = onVisibleIdsChangeRef.current;
      if (cb) {
        const all = new Set(items.map((item) => item.id));
        const key = [...all].sort().join('\n');
        if (key !== lastVisibleKeyRef.current) {
          lastVisibleKeyRef.current = key;
          cb(all);
        }
      }
      return;
    }

    const map = mapRef.current;
    if (!map) return;

    if (!didInitialFitRef.current && items.length > 0) {
      const focusTarget = effectiveFocusId ? items.find((item) => item.id === effectiveFocusId) : undefined;
      if (focusTarget) {
        map.jumpTo({ center: [focusTarget.lng, focusTarget.lat], zoom: FOCUS_ZOOM });
        lastFocusedKeyRef.current = effectiveFocusKey;
      } else {
        fitItemsOnMap(map, items, false);
      }
      didInitialFitRef.current = true;
      if (placesLoaded) didPostLoadFitRef.current = true;
    } else if (
      placesLoaded &&
      !didPostLoadFitRef.current &&
      !userInteractedRef.current &&
      !effectiveFocusId &&
      items.length > 0
    ) {
      didPostLoadFitRef.current = true;
      fitItemsOnMap(map, items, false);
    }

    scheduleClusterUpdateRef.current();
    emitVisibleIdsRef.current();
  }, [items, effectiveFocusId, effectiveFocusKey, placesLoaded, mapFailed]);

  // Fly smoothly to a newly requested focus item (including re-focusing the same pin via nonce).
  useEffect(() => {
    if (!effectiveFocusId || !effectiveFocusKey) {
      lastFocusedKeyRef.current = null;
      return;
    }
    if (effectiveFocusKey === lastFocusedKeyRef.current) return;
    const map = mapRef.current;
    if (!map || mapFailed) return;
    const target = items.find((item) => item.id === effectiveFocusId);
    if (!target) return;
    lastFocusedKeyRef.current = effectiveFocusKey;
    didInitialFitRef.current = true;
    didPostLoadFitRef.current = true;
    map.flyTo({
      center: [target.lng, target.lat],
      zoom: FOCUS_ZOOM,
      duration: 600,
    });
  }, [effectiveFocusId, effectiveFocusKey, items, mapFailed]);

  async function handleLocateMe() {
    if (locating) return;
    setLocating(true);
    setLocateError(null);
    try {
      const pos = await readCurrentPosition();
      if (!mountedRef.current) return;
      if (pos.ok && mapRef.current) {
        userInteractedRef.current = true;
        onUserMoveRef.current?.();
        mapRef.current.flyTo({
          center: [pos.lng, pos.lat],
          zoom: FOCUS_ZOOM,
          duration: 600,
        });
      } else if (!pos.ok) {
        setLocateError(pos.error);
      }
    } finally {
      if (mountedRef.current) setLocating(false);
    }
  }

  function handleClusterClick(cluster: ScreenCluster) {
    const map = mapRef.current;
    const zoom = map ? map.getZoom() : 0;
    if (areCoLocated(cluster.items) || zoom >= CO_LOCATED_MAX_ZOOM) {
      if (onSelectCoLocated) {
        onSelectCoLocated(cluster.items);
      } else if (cluster.items[0]) {
        onSelectItem(cluster.items[0].id);
      }
      return;
    }
    if (map) {
      userInteractedRef.current = true;
      fitItemsOnMap(map, cluster.items, true, CO_LOCATED_MAX_ZOOM);
    }
  }

  if (mapFailed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-2 p-6">
        <div className="w-full max-w-md space-y-4">
          <EmptyState
            icon={<MapPin weight="duotone" aria-hidden="true" />}
            title={labels.mapLabel}
          />
          <Callout
            tone="danger"
            action={
              labels.retry ? (
                <FeedbackButton
                  action="retry"
                  onClick={() => {
                    setMapFailed(false);
                    setAttempt((n) => n + 1);
                  }}
                >
                  {labels.retry}
                </FeedbackButton>
              ) : undefined
            }
          >
            {labels.mapFailed}
          </Callout>
        </div>
      </div>
    );
  }

  const canLocate = canReadPosition();
  const hasProtomapsCredit = /protomaps/i.test(labels.osmCredit);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        ref={containerRef}
        className="h-full w-full"
      />

      {/* Screen-space projected markers and cluster pills.
          Keep CSS positioning (`transform: translate3d(...)`) on the outer button
          and hover/selected scaling (`scale-*`, `transition-transform`) on the
          inner span. CSS Transforms Level 2 applies the standalone `scale`
          property (Tailwind v4 `scale-110`) before `transform`, which otherwise
          multiplies the marker's `(x, y)` offset by 1.1 and makes unselected
          pins jump away from the pointer on hover (and sit off-target when
          selected). Keeping `transition-transform` off the positioned button
          also prevents pins from lagging behind map pans and zooms. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {clusters.map((cluster) => {
          const isSingle = cluster.items.length === 1;
          const posStyle = {
            left: 0,
            top: 0,
            transform: `translate3d(${cluster.x}px, ${cluster.y}px, 0) translate(-50%, -50%)`,
          };

          if (isSingle) {
            const item = cluster.items[0]!;
            const isSelected = selectedId === item.id;
            const color = pinColorFor(item);

            if (item.kind === 'contact') {
              const initials = formatInitials(item.initials);
              return (
                <button
                  key={cluster.key}
                  type="button"
                  tabIndex={cluster.inViewport ? 0 : -1}
                  aria-label={markerAriaLabel(item)}
                  aria-pressed={isSelected}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectItem(item.id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onOpenItem(item.id);
                  }}
                  style={posStyle}
                  className={`group pointer-events-auto absolute flex h-7 w-7 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    isSelected ? 'z-20' : 'z-10 hover:z-20'
                  }`}
                >
                  <span
                    style={{ backgroundColor: color }}
                    className={`flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface-2 text-meta font-semibold leading-none text-white shadow-md transition-transform ${
                      isSelected ? 'scale-110 ring-4 ring-accent/35' : 'group-hover:scale-110'
                    }`}
                  >
                    {initials || <User aria-hidden="true" className="h-3.5 w-3.5" />}
                  </span>
                </button>
              );
            }

            return (
              <button
                key={cluster.key}
                type="button"
                tabIndex={cluster.inViewport ? 0 : -1}
                aria-label={markerAriaLabel(item)}
                aria-pressed={isSelected}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectItem(item.id);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onOpenItem(item.id);
                }}
                style={posStyle}
                className={`group pointer-events-auto absolute flex h-7 w-7 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  isSelected ? 'z-20' : 'z-10 hover:z-20'
                }`}
              >
                <span
                  style={{ backgroundColor: color }}
                  className={`block h-4 w-4 rounded-full border-2 border-surface-2 shadow-md transition-transform ${
                    isSelected ? 'scale-110 ring-4 ring-accent/35' : 'group-hover:scale-110'
                  }`}
                />
              </button>
            );
          }

          const hasSelected = cluster.items.some((item) => item.id === selectedId);
          return (
            <button
              key={cluster.key}
              type="button"
              tabIndex={cluster.inViewport ? 0 : -1}
              aria-label={clusterAriaLabel(cluster.items)}
              onClick={(e) => {
                e.stopPropagation();
                handleClusterClick(cluster);
              }}
              style={posStyle}
              className={`group pointer-events-auto absolute flex h-7 min-w-7 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                hasSelected ? 'z-20' : 'z-10 hover:z-20'
              }`}
            >
              <span
                style={{
                  backgroundColor: 'var(--color-accent-fill)',
                  paddingInline: cluster.items.length >= 10 ? 7 : 4,
                }}
                className={`flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-surface-2 text-meta font-semibold leading-none tabular-nums text-white shadow-md transition-transform ${
                  hasSelected ? 'scale-105 ring-4 ring-accent/35' : 'group-hover:scale-110'
                }`}
              >
                {cluster.items.length}
              </span>
            </button>
          );
        })}
      </div>

      {locateError && labels.locateError && (
        <div className="pointer-events-none absolute bottom-8 start-2 z-30 rounded-md border border-divider bg-surface-2/95 px-2.5 py-1.5 shadow-sm backdrop-blur-sm">
          <StatusLine tone="danger">{labels.locateError(locateError)}</StatusLine>
        </div>
      )}

      {/* Top-end map controls stack. */}
      <CanvasControlBar orientation="vertical" className="absolute top-2 end-2 z-30 !p-0.5">
        <IconButton label={labels.zoomIn} position="start" onClick={() => mapRef.current?.zoomIn()}>
          <MagnifyingGlassPlus aria-hidden="true" />
        </IconButton>
        <IconButton label={labels.zoomOut} position="start" onClick={() => mapRef.current?.zoomOut()}>
          <MagnifyingGlassMinus aria-hidden="true" />
        </IconButton>
        <IconButton
          label={labels.fitAll}
          position="start"
          disabled={items.length === 0}
          onClick={() => {
            if (mapRef.current) fitItemsOnMap(mapRef.current, items, true);
          }}
        >
          <CornersOut aria-hidden="true" />
        </IconButton>
        {canLocate && (
          <IconButton
            label={locating ? labels.locating : labels.myLocation}
            position="start"
            aria-busy={locating}
            onClick={() => void handleLocateMe()}
          >
            {locating ? <Spinner size={14} /> : <Crosshair aria-hidden="true" />}
          </IconButton>
        )}
      </CanvasControlBar>

      {/* Bottom-end OpenStreetMap / Protomaps credit chip. */}
      <div className="absolute bottom-px end-px z-30 rounded-ss-md bg-surface-2/85 px-1.5 py-0.5 text-meta text-pn-muted">
        <a
          href="https://www.openstreetmap.org/copyright"
          draggable={false}
          className="underline hover:text-pn"
          onClick={(e) => {
            if (e.defaultPrevented) return;
            e.preventDefault();
            openExternal('https://www.openstreetmap.org/copyright');
          }}
        >
          {labels.osmCredit}
        </a>
        {!hasProtomapsCredit && (
          <>
            {' · '}
            <a
              href="https://protomaps.com"
              draggable={false}
              className="underline hover:text-pn"
              onClick={(e) => {
                if (e.defaultPrevented) return;
                e.preventDefault();
                openExternal('https://protomaps.com');
              }}
            >
              Protomaps
            </a>
          </>
        )}
      </div>
    </div>
  );
}
