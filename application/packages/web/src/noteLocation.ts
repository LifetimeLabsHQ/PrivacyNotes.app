/**
 * A place on a note: latitude, longitude and the person's own name for it.
 *
 * It lives in `note.trackers.location`, the one slot every shipped client
 * carries through sync, conflicts, backups and the at-rest seal without
 * knowing the key. A new top-level note field would be dropped by an older
 * client on its first pull, and a new sealed field would lock a rollback out
 * of every row that has one.
 *
 * Everything here is pure and makes no network call: the paste parser reads
 * coordinates out of the text it is given, and a short link it cannot read
 * without following it is refused rather than followed.
 *
 * Spec: docs/internal/plans/note-location.md
 */
import { clipGraphemes } from './clipText';
import { MAP_ORIGIN } from './hosts';

/** The tracker key that holds the place. Spec: docs/internal/plans/note-location.md (section 2) */
export const LOCATION_KEY = 'location';

/** The longest name a place keeps, in UTF-16 units (the tag and folder caps use the same unit). */
const LOCATION_LABEL_MAX = 200;

export interface NoteLocation {
  lat: number;
  lng: number;
  label?: string;
}

/** Five decimals is about a metre: finer than a phone fix, short enough to read. */
function round5(n: number): number {
  const r = Math.round(n * 1e5) / 1e5;
  return r === 0 ? 0 : r;
}

/**
 * A place from two numbers and an optional name, or undefined when the numbers
 * are not a point on the map. Longitude 180 and -180 are the same meridian, so
 * it is written as -180 and two copies of one place compare equal.
 */
export function makeLocation(lat: unknown, lng: unknown, label?: unknown): NoteLocation | undefined {
  if (typeof lat !== 'number' || typeof lng !== 'number') return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  const name = typeof label === 'string' ? clipGraphemes(label.replace(/\s+/g, ' ').trim(), LOCATION_LABEL_MAX).trim() : '';
  const out: NoteLocation = { lat: round5(lat), lng: lng === 180 ? -180 : round5(lng) };
  if (name) out.label = name;
  return out;
}

/**
 * A place from an importer's two coordinate fields (numbers, or the text an
 * export writes), or undefined. 0, 0 counts as no place: Joplin writes
 * 0.00000000 for a note it has no position for, and nobody keeps notes in
 * the Gulf of Guinea at that exact point.
 * Spec: docs/internal/plans/note-location.md (section 6)
 */
export function importedLocation(lat: unknown, lng: unknown, label?: unknown): NoteLocation | undefined {
  const num = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
  const loc = makeLocation(num(lat), num(lng), label);
  return loc && (loc.lat !== 0 || loc.lng !== 0) ? loc : undefined;
}

/**
 * The note's place, read from its trackers. Every reader goes through here, so
 * a value an import or an old bug wrote in another shape reads as no place
 * rather than throwing in the editor or the export.
 */
export function readLocation(trackers: Record<string, unknown> | undefined | null): NoteLocation | undefined {
  const raw = trackers?.[LOCATION_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  return makeLocation(v.lat, v.lng, v.label);
}

/** The coordinates as text: four decimals in the popover, two on the chip. */
export function formatCoordinates(loc: Pick<NoteLocation, 'lat' | 'lng'>, digits = 4): string {
  return `${loc.lat.toFixed(digits)}, ${loc.lng.toFixed(digits)}`;
}

/** The OpenStreetMap page with a pin at the place. The Apple Journal importer builds its links here too. */
export function osmUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

// ------------------------------------------------------------------
// The map on a click
// ------------------------------------------------------------------

/** The world map file in the privacynotes-maps bucket. An upload is a new
 *  name, so a released app keeps reading the file it was built with.
 *  Spec: docs/internal/plans/note-location.md (section 5) */
const MAP_FILE = 'planet-20261110.pmtiles';

export interface MapSource {
  /** The vector tiles, read in byte ranges through the pmtiles protocol. */
  tiles: string;
  glyphs: string;
  /** Without the flavor: `${sprite}/light` or `${sprite}/dark`. */
  sprite: string;
}

/**
 * Where a note's maps come from: the place window and a map in the text. The
 * demo reads it too: the owner made the map host the demo's second server
 * exception, beside the clipper's /clip-fetch (2026-11-11). The map reads
 * only what this returns.
 */
export function mapSource(): MapSource {
  return {
    tiles: `pmtiles://${MAP_ORIGIN}/${MAP_FILE}`,
    glyphs: `${MAP_ORIGIN}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${MAP_ORIGIN}/sprites/v4`,
  };
}

// ------------------------------------------------------------------
// The paste parser
// ------------------------------------------------------------------

export type LocationParse =
  | { ok: true; lat: number; lng: number }
  | { ok: false; error: 'unreadable' | 'shortLink' | 'range' };

const NUM = String.raw`~?[+-]?\d{1,3}(?:\.\d+)?`;
/** Two numbers, an optional degree sign after each, and a separator: a comma, a semicolon or a space. */
const PAIR = new RegExp(String.raw`^\(?\[?\s*(${NUM})\s*°?\s*([,;\s])\s*(${NUM})\s*°?\s*\]?\)?$`);

/** Hosts whose links are redirects: the coordinates are only behind a network call. */
const SHORT_LINK = /^(?:maps\.app\.goo\.gl|goo\.gl|g\.co|maps\.apple|apple\.co)$/i;

/** Query keys that hold a `lat,lng` pair in the map links people paste. */
const PAIR_PARAMS = ['ll', 'q', 'query', 'coordinate', 'center', 'daddr', 'destination'];

function pairOf(text: string): LocationParse | undefined {
  const m = PAIR.exec(text.trim());
  if (!m) return undefined;
  const [, rawA, sep, rawB] = m as unknown as [string, string, string, string];
  // "~35.36" is an approximate value, read as the value.
  const a = rawA.replace('~', '');
  const b = rawB.replace('~', '');
  // "35,36" reads as one number with a comma decimal as easily as a pair, so
  // a bare comma between two whole numbers is no answer either way.
  if (sep === ',' && !a.includes('.') && !b.includes('.') && !/,\s/.test(text)) return { ok: false, error: 'unreadable' };
  return checked(Number(a), Number(b));
}

/**
 * One coordinate with a hemisphere letter: decimal degrees ("35.3606° N",
 * "N 35.3606") or degrees, minutes and seconds ("35°21'38\"N"). A "~" before
 * it is allowed. The letter gives the sign and says which axis it is.
 */
const VALUE = String.raw`~?\s*(\d{1,3}(?:\.\d+)?)\s*°?\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’]\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″”]|'')\s*)?)?`;
const AFTER = new RegExp(String.raw`${VALUE}([NSEWnsew])\b`, 'g');
const BEFORE = new RegExp(String.raw`\b([NSEWnsew])\s*${VALUE}`, 'g');

type Axis = { value: number; letter: string };

/** The lettered values of one reading order, in text order. */
function axesIn(text: string, order: RegExp, letterFirst: boolean): Axis[] {
  const found: { at: number; axis: Axis }[] = [];
  const add = (at: number, deg?: string, min?: string, sec?: string, letter?: string) => {
    if (!deg || !letter) return;
    const m = Number(min ?? 0);
    const sc = Number(sec ?? 0);
    if (m >= 60 || sc >= 60) return;
    found.push({ at, axis: { value: Number(deg) + m / 60 + sc / 3600, letter: letter.toUpperCase() } });
  };
  for (const m of text.matchAll(order)) {
    if (letterFirst) add(m.index ?? 0, m[2], m[3], m[4], m[1]);
    else add(m.index ?? 0, m[1], m[2], m[3], m[4]);
  }
  return found.map((f) => f.axis);
}

/**
 * The first latitude and longitude written with hemisphere letters, anywhere
 * in the text: "35.3636° N, 138.7264° E (or ~35.3606° N, ...)" reads the first
 * pair. Undefined when the text holds no N/S and E/W pair.
 */
function lettersPairOf(text: string): LocationParse | undefined {
  // Each reading order on its own: "N 35.36 E 138.72" read with the letter
  // after the number would take "35.36 E" as a longitude.
  return firstPair(axesIn(text, AFTER, false)) ?? firstPair(axesIn(text, BEFORE, true));
}

function firstPair(axes: Axis[]): LocationParse | undefined {
  for (let i = 0; i + 1 < axes.length; i++) {
    const [p, q] = [axes[i]!, axes[i + 1]!];
    const lat = 'NS'.includes(p.letter) ? p : 'NS'.includes(q.letter) ? q : null;
    const lng = 'EW'.includes(p.letter) ? p : 'EW'.includes(q.letter) ? q : null;
    if (!lat || !lng || lat === lng) continue;
    return checked(lat.letter === 'S' ? -lat.value : lat.value, lng.letter === 'W' ? -lng.value : lng.value);
  }
  return undefined;
}

function checked(lat: number, lng: number): LocationParse {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: 'unreadable' };
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false, error: 'range' };
  return { ok: true, lat, lng };
}

function fromUrl(url: URL): LocationParse | undefined {
  if (SHORT_LINK.test(url.hostname) || (url.hostname === 'goo.gl' && url.pathname.startsWith('/maps'))) {
    return { ok: false, error: 'shortLink' };
  }
  const p = url.searchParams;
  const mlat = p.get('mlat');
  const mlon = p.get('mlon');
  if (mlat !== null && mlon !== null) return checked(Number(mlat), Number(mlon));
  // Google's place marker, which is where the pin is; `/@` is only the middle of the view.
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(url.pathname + url.search);
  if (pin) return checked(Number(pin[1]), Number(pin[2]));
  for (const key of PAIR_PARAMS) {
    const v = p.get(key);
    if (!v) continue;
    const pair = pairOf(v.replace(/^loc:/i, '').replace(/\+/g, ' '));
    if (pair) return pair;
  }
  const at = /\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url.pathname);
  if (at) return checked(Number(at[1]), Number(at[2]));
  const hash = /map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(url.hash);
  if (hash) return checked(Number(hash[1]), Number(hash[2]));
  return undefined;
}

/**
 * Coordinates from what the person pasted: a pair of numbers, a `geo:` link,
 * or an OpenStreetMap, Google Maps or Apple Maps address. The text itself is
 * never stored, only the two numbers.
 */
export function parseLocationInput(input: string): LocationParse {
  const text = input.trim();
  if (!text) return { ok: false, error: 'unreadable' };
  const geo = /^geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (geo) return checked(Number(geo[1]), Number(geo[2]));
  const pair = pairOf(text);
  if (pair) return pair;
  // Not inside a link: a URL's own letters are no hemisphere.
  if (!/:\/\/|^[\w-]+(?:\.[\w-]+)+\//.test(text)) {
    const lettered = lettersPairOf(text);
    if (lettered) return lettered;
  }
  // An address with no scheme ("www.openstreetmap.org/?mlat=..."), as a share
  // sheet sometimes copies it.
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(text) ? text : /^[\w-]+(?:\.[\w-]+)+\//.test(text) ? `https://${text}` : null;
  if (withScheme) {
    let url: URL | undefined;
    try {
      url = new URL(withScheme);
    } catch {
      url = undefined;
    }
    if (url) return fromUrl(url) ?? { ok: false, error: 'unreadable' };
  }
  return { ok: false, error: 'unreadable' };
}

// ------------------------------------------------------------------
// A map in a note's body (PlaceMapNode.tsx, markdownRender.ts)
// ------------------------------------------------------------------

/** The fence language of a map in a note. Spec: docs/internal/plans/note-location.md (section 4b) */
export const MAP_FENCE = 'map';

/** A map's height in the note, in CSS pixels: the place window's height by default. Spec: docs/internal/plans/note-location.md (section 4b) */
export const MAP_HEIGHT_DEFAULT = 240;
const MAP_HEIGHT_MIN = 120;
const MAP_HEIGHT_MAX = 720;

/** Round a map's height and clamp it to the range, or null when it is not a number. */
export function clampMapHeight(raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  return Math.min(MAP_HEIGHT_MAX, Math.max(MAP_HEIGHT_MIN, Math.round(raw)));
}

/** The fence's text for a place: the coordinates, then the name on its own line. */
export function mapFenceBody(loc: NoteLocation): string {
  const at = `${loc.lat}, ${loc.lng}`;
  // A run of three backticks in a name would close the fence early.
  return loc.label ? `${at}\n${loc.label.replace(/`{3,}/g, '``')}` : at;
}

/** A place from a fence's text, or undefined when its first line is no place. */
export function parseMapFence(text: string): NoteLocation | undefined {
  const [first = '', ...rest] = text.trim().split('\n');
  const parsed = parseLocationInput(first);
  return parsed.ok ? makeLocation(parsed.lat, parsed.lng, rest.join(' ')) : undefined;
}

// ------------------------------------------------------------------
// Front matter
// ------------------------------------------------------------------

/** The front-matter key Obsidian Map View reads, and ours for the name. Spec: docs/internal/plans/note-location.md (section 6) */
export const FRONT_MATTER_LOCATION = 'location';
export const FRONT_MATTER_LOCATION_NAME = 'location_name';

/**
 * A place from a front-matter value: `35.36,138.72`, `[35.36, 138.72]`, the
 * list a reader already split, or quoted numbers in either. Undefined for
 * anything else, a place name with no coordinates included.
 */
export function parseFrontMatterLocation(value: unknown, name?: unknown): NoteLocation | undefined {
  if (value === undefined || value === null) return undefined;
  const text = (Array.isArray(value) ? value.map(String).join(', ') : String(value)).replace(/["'[\]]/g, '').trim();
  const parsed = parseLocationInput(text);
  return parsed.ok ? makeLocation(parsed.lat, parsed.lng, name) : undefined;
}
