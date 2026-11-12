/**
 * The small map of a note's place (the place window, a map in the text). Its own
 * lazy chunk: MapLibre, the pmtiles reader and the Protomaps style never load
 * on the boot path or before the click.
 *
 * The tiles come in byte ranges from one world file on our own host
 * (`mapSource()` in noteLocation.ts, which returns nothing in the demo), so no
 * third party sees the request; our host sees the area. Nothing about the
 * map is stored: closing the popover removes it.
 *
 * No MapLibre control is drawn, because each one brings English text of its
 * own: the zoom buttons are ours (the media viewer's strings), and the credit
 * line on the map is the caller's. In the place window every gesture moves
 * the map. In a note's text MapLibre's cooperative gestures keep the note's
 * scroll: two fingers, or Ctrl/Cmd with the wheel, move the map, and its hint
 * speaks our strings.
 * Spec: docs/internal/plans/note-location.md (section 5)
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Map as MapLibreMap, Marker, addProtocol, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre looks for its worker next to its own module, which bundling moves and
// which is no http address inside the native apps; the copied file is named here.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol } from 'pmtiles';
import { language_script_pairs, layers, namedFlavor } from '@protomaps/basemaps';
import type { MapSource } from '../noteLocation';
import { MagnifyingGlassMinus, MagnifyingGlassPlus } from '../icons';
import { IconButton } from '../ui';

/** How long the first draw may take before the map counts as failed. */
const LOAD_TIMEOUT_MS = 15_000;

let setUp = false;
function ensureSetUp(): void {
  if (setUp) return;
  setWorkerUrl(workerUrl);
  addProtocol('pmtiles', new Protocol().tile);
  setUp = true;
}

export default function NoteLocationMap({ lat, lng, dark, lang, source, label, scrollZoom, bleed, height, onFail }: {
  lat: number;
  lng: number;
  dark: boolean;
  /** The app language; labels fall back to English where Protomaps has no names in it. */
  lang: string;
  source: MapSource;
  /** The accessible name of the map. */
  label: string;
  /** Every gesture moves the map (the place window). Off in a note's text, where one finger and the plain wheel scroll the note. */
  scrollZoom: boolean;
  /** Edge to edge with no frame: the place window, where the map spans the panel. */
  bleed: boolean;
  /** In CSS pixels: a map in a note keeps the height its corner handle gave it. '100%' fills the large map. */
  height: number | '100%';
  /** No WebGL, offline, or the host did not answer before the first draw. */
  onFail: () => void;
}) {
  const { t } = useTranslation('media');
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let map: MapLibreMap | undefined;
    let loaded = false;
    let failed = false;
    // A map that was removed (a closed window, a hot reload, React's second
    // mount in development) can still report its aborted requests. Those
    // must not fail the map that replaced it.
    let gone = false;
    const fail = (event?: object) => {
      if (failed || loaded || gone) return;
      if (event && 'error' in event && (event.error as { name?: string } | undefined)?.name === 'AbortError') return;
      failed = true;
      failRef.current();
    };
    try {
      ensureSetUp();
      const flavor = dark ? 'dark' : 'light';
      const base = lang.split('-')[0] ?? 'en';
      const labelLang = language_script_pairs.some((p) => p.lang === base) ? base : 'en';
      map = new MapLibreMap({
        container: el,
        style: {
          version: 8,
          glyphs: source.glyphs,
          sprite: `${source.sprite}/${flavor}`,
          sources: { protomaps: { type: 'vector', url: source.tiles } },
          layers: layers('protomaps', namedFlavor(flavor), { lang: labelLang }),
        },
        center: [lng, lat],
        zoom: 14,
        attributionControl: false,
        // In a note's text the map must not take the note's scroll: one
        // finger and the plain wheel scroll the note, two fingers or Ctrl/Cmd
        // with the wheel move and zoom the map, and a hint says so.
        scrollZoom: true,
        cooperativeGestures: !scrollZoom,
        locale: {
          'CooperativeGesturesHandler.WindowsHelpText': t('notes:location.gestureCtrl'),
          'CooperativeGesturesHandler.MacHelpText': t('notes:location.gestureMac'),
          'CooperativeGesturesHandler.MobileHelpText': t('notes:location.gestureTouch'),
        },
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
      map.touchZoomRotate.disableRotation();
      new Marker().setLngLat([lng, lat]).addTo(map);
      mapRef.current = map;
      map.on('load', () => { loaded = true; });
      // After the first draw a missing tile is only a gap; before it, the map failed.
      map.on('error', fail);
    } catch {
      // No WebGL: MapLibre throws while it builds the canvas.
      fail();
    }
    const timer = setTimeout(() => fail(), LOAD_TIMEOUT_MS);
    // A drag of the note map's corner changes the box; the canvas follows.
    // A resize clears the canvas and MapLibre draws again only on the next
    // frame, so the map flickered on every move: draw at once instead. The
    // observer runs after layout and before paint, so no blank frame shows.
    const sized = new ResizeObserver(() => {
      if (!map) return;
      map.resize();
      if (map.isStyleLoaded()) map.redraw();
    });
    sized.observe(el);
    return () => {
      gone = true;
      sized.disconnect();
      clearTimeout(timer);
      mapRef.current = null;
      map?.remove();
    };
  }, [lat, lng, dark, lang, scrollZoom, source.tiles, source.glyphs, source.sprite, t]);

  return (
    <div className={`relative${height === '100%' ? ' h-full' : ''}`}>
      <div ref={ref} role="img" aria-label={label} style={{ height }} className={`w-full overflow-hidden ${bleed ? 'border-y border-divider' : 'rounded-md border border-divider'}`} />
      <div className="absolute top-1.5 end-1.5 flex flex-col rounded-md border border-divider bg-surface-2">
        <IconButton label={t('viewer.zoomIn')} position="start" onClick={() => mapRef.current?.zoomIn()}>
          <MagnifyingGlassPlus aria-hidden="true" />
        </IconButton>
        <IconButton label={t('viewer.zoomOut')} position="start" onClick={() => mapRef.current?.zoomOut()}>
          <MagnifyingGlassMinus aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}
