/**
 * Shared MapLibre + PMTiles protocol setup and Protomaps style builder for
 * `NoteLocationMap.tsx` and `GraphPlacesMap.tsx`.
 *
 * Imported only from lazy-loaded map chunks so `maplibre-gl`, `pmtiles`, and
 * `@protomaps/basemaps` stay off the boot path.
 *
 * Spec: docs/internal/specs/note-location.md (section 5)
 * Spec: docs/internal/specs/graph-view.md (section 4.4)
 */

import { addProtocol, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
// MapLibre looks for its worker next to its own module, which bundling moves and
// which is no http address inside the native apps; the copied file is named here.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol } from 'pmtiles';
import { language_script_pairs, layers, namedFlavor } from '@protomaps/basemaps';
import { mapSource, type MapSource } from './noteLocation';

let mapLibreReady = false;

const PROTOMAPS_LANGS = new Set(language_script_pairs.map((p) => p.lang));

const NON_LOCALIZED_SYMBOL_LAYERS = new Set([
  'address_label',
  'roads_oneway',
  'roads_shields',
]);

/** True when `error` is a DOM/fetch `AbortError` from a cancelled tile read. */
export function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError',
  );
}

/** True when a MapLibre error event wraps an `AbortError` from a removed map. */
export function isMapAbortEvent(event: unknown): boolean {
  return Boolean(
    event &&
    typeof event === 'object' &&
    'error' in event &&
    isAbortError((event as { error?: unknown }).error),
  );
}

/**
 * Register the MapLibre worker URL and PMTiles protocol once per session.
 *
 * `Protocol` caches archive headers by URL, including failed fetches; clearing
 * `reader.tiles` on non-abort errors lets a retry or a later map ask the host
 * again instead of replaying a cached network failure. Aborted reads from an
 * unmounted map keep cached headers intact.
 */
export function ensureMapLibreReady(): void {
  if (mapLibreReady) return;
  setWorkerUrl(workerUrl);
  const reader = new Protocol();
  try {
    addProtocol('pmtiles', async (request, abort) => {
      try {
        return await reader.tile(request, abort);
      } catch (error) {
        if (!isAbortError(error)) reader.tiles.clear();
        throw error;
      }
    });
  } catch {
    // Another map bundle in HMR already registered the pmtiles protocol.
  }
  mapLibreReady = true;
}

/**
 * Map an app locale tag onto a Protomaps `language_script_pairs` code, or
 * `undefined` when Protomaps does not ship dedicated `name:<lang>` tags for
 * that language (such as `ca` or `th`), so local script labels display instead
 * of forcing English.
 */
export function resolveProtomapsLanguage(locale: string): string | undefined {
  const trimmed = locale.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase().replace(/_/g, '-');

  if (
    lower === 'zh-tw' ||
    lower === 'zh-hk' ||
    lower === 'zh-mo' ||
    lower === 'zh-hant' ||
    lower.startsWith('zh-hant-')
  ) {
    return 'zh-Hant';
  }
  if (
    lower === 'zh' ||
    lower === 'zh-cn' ||
    lower === 'zh-sg' ||
    lower === 'zh-hans' ||
    lower.startsWith('zh-hans-')
  ) {
    return 'zh-Hans';
  }

  if (PROTOMAPS_LANGS.has(lower)) return lower;
  const base = lower.split('-')[0] ?? '';
  if (base && PROTOMAPS_LANGS.has(base)) return base;
  return undefined;
}

function localScriptTextField(defaultFont: string): unknown[] {
  return [
    'format',
    ['coalesce', ['get', 'pgf:name'], ['get', 'name']],
    {
      'text-font': [
        'case',
        ['==', ['get', 'script'], 'Devanagari'],
        ['literal', ['Noto Sans Devanagari Regular v1']],
        ['literal', [defaultFont]],
      ],
    },
  ];
}

/**
 * Build the MapLibre style specification for our self-hosted Protomaps tiles.
 * When `locale` is outside Protomaps' `language_script_pairs` (for example `ca`
 * or `th`), symbol layers read the tile's local `pgf:name` / `name` fields
 * directly instead of forcing `name:en`.
 */
export function createProtomapsStyle(
  dark: boolean,
  locale: string,
  source: MapSource = mapSource(),
): StyleSpecification {
  const flavorName = dark ? 'dark' : 'light';
  const flavor = namedFlavor(flavorName);
  const lang = resolveProtomapsLanguage(locale);

  const styleLayers =
    lang !== undefined
      ? layers('protomaps', flavor, { lang })
      : layers('protomaps', flavor, { lang: 'en' }).map((layer) => {
          if (layer.type !== 'symbol' || NON_LOCALIZED_SYMBOL_LAYERS.has(layer.id) || !layer.layout) {
            return layer;
          }
          const regularFont = flavor.regular || 'Noto Sans Regular';
          const boldFont = flavor.bold || 'Noto Sans Medium';
          if (layer.id === 'places_region') {
            return {
              ...layer,
              layout: {
                ...layer.layout,
                'text-field': [
                  'step',
                  ['zoom'],
                  ['get', 'ref'],
                  6,
                  localScriptTextField(regularFont),
                ] as never,
              },
            };
          }
          const font = layer.id === 'places_country' ? boldFont : regularFont;
          return {
            ...layer,
            layout: {
              ...layer.layout,
              'text-field': localScriptTextField(font) as never,
            },
          };
        });

  return {
    version: 8,
    glyphs: source.glyphs,
    sprite: `${source.sprite}/${flavorName}`,
    sources: { protomaps: { type: 'vector', url: source.tiles } },
    layers: styleLayers,
  };
}
