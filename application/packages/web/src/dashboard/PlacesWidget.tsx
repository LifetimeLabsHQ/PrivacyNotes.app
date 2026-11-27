/**
 * Home Places map widget (Pro): live multi-pin map of placed notes, journal
 * entries and contacts. Lazy-loaded from widgets.tsx so MapLibre and PMTiles
 * never touch the boot path and only load when Places is actually on Home.
 * Spec: docs/internal/specs/dashboard.md (section 5)
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState } from '../ui';
import { activeLocale } from '../i18n';
import { useTheme } from '../theme';
import GraphPlacesMap, { type PlacesMapItem } from '../graph/GraphPlacesMap';
import { resolvePlacedItems } from '../graph/graphModel';
import { loadPlaces, type PlaceList } from '../placeSearch';
import { useDashboardEnv } from './env';

export default function PlacesWidget() {
  const { t } = useTranslation(['shell', 'notes', 'common', 'media', 'auth']);
  const env = useDashboardEnv();
  const dark = useTheme().theme === 'dark';
  const locale = activeLocale();
  const [placeRows, setPlaceRows] = useState<PlaceList | null>(null);
  const [placesLoaded, setPlacesLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setPlacesLoaded(false);
    void loadPlaces(locale)
      .then((rows) => {
        if (!alive) return;
        setPlaceRows(rows);
        setPlacesLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setPlaceRows(null);
        setPlacesLoaded(true);
      });
    return () => { alive = false; };
  }, [locale]);

  const placedResult = useMemo(
    () =>
      resolvePlacedItems(env.pool, env.isNoteLocked, env.itemStyles, placeRows, {
        showNotes: true,
        showJournals: true,
        showTasks: true,
        showFiles: true,
        showContacts: true,
        searchQuery: '',
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gatedKey tracks lock predicate changes
    [env.pool, env.gatedKey, env.itemStyles, placeRows],
  );

  const mapItems = useMemo<PlacesMapItem[]>(
    () =>
      placedResult.placed.map((p) => ({
        id: p.id,
        title: p.title,
        kind: p.kind,
        lat: p.location.lat,
        lng: p.location.lng,
        label: p.location.label,
        exact: p.exact,
        initials: p.initials,
        colorKey: p.colorKey,
      })),
    [placedResult.placed],
  );

  if (placesLoaded && mapItems.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <EmptyState compact flush>{t('shell:dashboard.empty.places')}</EmptyState>
        <Button action="open" onClick={() => env.openGraph('places')}>
          {t('common:ninja.features.placesMap.label')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-divider bg-track/40">
        <GraphPlacesMap
          items={mapItems}
          selectedId={env.selectedId}
          placesLoaded={placesLoaded}
          dark={dark}
          lang={locale}
          onSelectItem={(id) => {
            if (id) env.open(id);
          }}
          onOpenItem={(id) => env.open(id)}
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
          }}
        />
      </div>
      <p className="shrink-0 truncate text-meta tabular-nums text-pn-muted">
        {t('shell:dashboard.placesSummary', { count: mapItems.length })}
      </p>
    </div>
  );
}
