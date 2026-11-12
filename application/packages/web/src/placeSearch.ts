/**
 * Place search for a note's place: type "Kyoto" or "Mount Fuji", pick it, and
 * the place is set.
 *
 * The places come from one list per language on our map host, built by the
 * map upload job: GeoNames towns of 5,000 people or more, and Wikidata places
 * with a page in 30 or more Wikipedias (mountains, lakes, islands, parks,
 * buildings, regions). The app downloads its
 * language's list whole and searches it on the device, so the host learns only
 * which language's list was read, never what anyone typed. The download starts
 * when the place window opens for editing, so the list is usually there before
 * the first letter; the browser keeps it, because a list never changes under
 * its name. The demo reads it too (the map host is its second exception).
 *
 * Rows are sorted by rank (population, or Wikipedia editions for a Wikidata
 * place), so the first matches are the largest towns and the best-known
 * places: "Paris" finds Paris, France before Paris, Texas.
 * Spec: docs/internal/plans/note-location.md (section 3b)
 */
import { MAP_ORIGIN } from './hosts';
import { foldForMatch } from './textMatch';

/** The upload of the place lists the app reads; a new upload is a new folder.
 *  Spec: docs/internal/plans/note-location.md (section 3b) */
const PLACES_BUILD = '202611101705';

export interface PlaceHit {
  name: string;
  lat: number;
  lng: number;
  /** ISO country code; the caller names it in the app language. */
  country: string;
  region: string;
}

interface PlaceRow extends PlaceHit {
  /** The name and its other spellings, folded once at load. */
  keys: string[];
}

/** One line: name, lat, lng, country, region, population, other|names. */
export function parsePlaces(text: string): PlaceRow[] {
  const rows: PlaceRow[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [name, lat, lng, country, region, , others] = line.split('\t');
    const la = Number(lat);
    const ln = Number(lng);
    if (!name || !Number.isFinite(la) || !Number.isFinite(ln)) continue;
    const keys = [name, ...(others ? others.split('|') : [])].map((k) => foldForMatch(k).trim()).filter(Boolean);
    rows.push({ name, lat: la, lng: ln, country: country ?? '', region: region ?? '', keys });
  }
  return rows;
}

/**
 * The towns whose name, or another spelling of it, starts with the query, the
 * largest first; then those where a later word starts with it ("York" finds
 * New York). Two letters at least, at most `limit` towns.
 */
export function searchPlaces(rows: readonly PlaceRow[], query: string, limit = 6): PlaceHit[] {
  const needle = foldForMatch(query).trim();
  if ([...needle].length < 2) return [];
  const first: PlaceRow[] = [];
  const later: PlaceRow[] = [];
  for (const row of rows) {
    if (row.keys.some((k) => k.startsWith(needle))) {
      first.push(row);
      if (first.length >= limit) break;
    } else if (later.length < limit && row.keys.some((k) => k.includes(` ${needle}`) || k.includes(`-${needle}`))) {
      later.push(row);
    }
  }
  return [...first, ...later].slice(0, limit).map(({ keys: _keys, ...hit }) => hit);
}

const loaded = new Map<string, Promise<PlaceRow[]>>();

/** The lists to try for an app language: its own, its base language, then the common names. */
function candidates(locale: string): string[] {
  const base = locale.split('-')[0]!.toLowerCase();
  return [...new Set([locale, base, 'default'])];
}

/**
 * The listed place nearest a point, within `maxKm`, for the name of a place
 * the phone found (an automatic place, autoLocation.ts). Undefined when none
 * is that close: a name from far away would say the wrong thing.
 */
export function nearestPlace(rows: readonly PlaceHit[], lat: number, lng: number, maxKm = 25): PlaceHit | undefined {
  const rad = Math.PI / 180;
  let best: PlaceHit | undefined;
  let bestKm = maxKm;
  for (const row of rows) {
    const dLat = (row.lat - lat) * rad;
    const dLng = (row.lng - lng) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(row.lat * rad) * Math.sin(dLng / 2) ** 2;
    const km = 12_742 * Math.asin(Math.min(1, Math.sqrt(a)));
    if (km < bestKm) { best = row; bestKm = km; }
  }
  return best;
}

/**
 * The place list for an app language, downloaded once per session and kept by
 * the browser after that. A failed download is forgotten, so the next window
 * tries again.
 */
export function loadPlaces(locale: string): Promise<PlaceRow[]> {
  const known = loaded.get(locale);
  if (known) return known;
  const promise = (async () => {
    for (const file of candidates(locale)) {
      const res = await fetch(`${MAP_ORIGIN}/places/${PLACES_BUILD}/${file}.tsv`, { cache: 'force-cache' }).catch(() => null);
      if (res?.ok) return parsePlaces(await res.text());
    }
    throw new Error('places unavailable');
  })();
  loaded.set(locale, promise);
  promise.catch(() => loaded.delete(locale));
  return promise;
}

export type { PlaceRow };
