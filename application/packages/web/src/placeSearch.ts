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
 * Spec: docs/internal/specs/note-location.md (section 3b)
 */
import { MAP_ORIGIN } from './hosts';
import { LOCALE_TO_SLUG } from './localeRoutes';
import { foldForMatch } from './textMatch';

/** The upload of the place lists the app reads; a new upload is a new folder.
 *  Spec: docs/internal/specs/note-location.md (section 3b) */
const PLACES_BUILD = '202611101705';

export interface PlaceHit {
  name: string;
  lat: number;
  lng: number;
  /** ISO country code; the caller names it in the app language. */
  country: string;
  region: string;
}

export interface PlaceAddressInput {
  street: string;
  city: string;
  region: string;
  country: string;
}

export type PlaceList = readonly PlaceHit[];

interface PlaceRow {
  hit: PlaceHit;
  /** The name and its other spellings, folded once at load. */
  keys: readonly string[];
}

interface PlaceLookupIndex {
  byKey: Map<string, PlaceRow[]>;
  knownCountryNames: ReadonlyArray<readonly [string, string]>;
  knownIsoCodes: Set<string>;
  knownRegionsByCountry: Map<string, Set<string>>;
}

const VALID_ISO_COUNTRIES = new Set<string>([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]);

const COUNTRY_ALIASES = new Map<string, string>([
  ['usa', 'US'],
  ['u s a', 'US'],
  ['u s', 'US'],
  ['united states of america', 'US'],
  ['united states', 'US'],
  ['vereinigte staaten', 'US'],
  ['etats unis', 'US'],
  ['etats-unis', 'US'],
  ['america', 'US'],
  ['uk', 'GB'],
  ['u k', 'GB'],
  ['united kingdom', 'GB'],
  ['great britain', 'GB'],
  ['royaume uni', 'GB'],
  ['royaume-uni', 'GB'],
  ['vereinigtes konigreich', 'GB'],
  ['britain', 'GB'],
  ['england', 'GB'],
  ['scotland', 'GB'],
  ['wales', 'GB'],
  ['uae', 'AE'],
  ['deutschland', 'DE'],
  ['allemagne', 'DE'],
  ['alemania', 'DE'],
  ['frankreich', 'FR'],
  ['francia', 'FR'],
  ['schweiz', 'CH'],
  ['suisse', 'CH'],
  ['svizzera', 'CH'],
  ['suiza', 'CH'],
  ['osterreich', 'AT'],
  ['autriche', 'AT'],
  ['nederland', 'NL'],
  ['pays bas', 'NL'],
  ['pays-bas', 'NL'],
  ['niederlande', 'NL'],
  ['holland', 'NL'],
  ['espana', 'ES'],
  ['espagne', 'ES'],
  ['spanien', 'ES'],
  ['italia', 'IT'],
  ['italie', 'IT'],
  ['italien', 'IT'],
  ['kanada', 'CA'],
  ['brasil', 'BR'],
  ['mexico', 'MX'],
  ['turkey', 'TR'],
  ['turkiye', 'TR'],
  ['czech republic', 'CZ'],
  ['czechia', 'CZ'],
  ['ivory coast', 'CI'],
  ['burma', 'MM'],
  ['japon', 'JP'],
  ['日本', 'JP'],
  ['belgique', 'BE'],
  ['belgien', 'BE'],
  ['portugal', 'PT'],
  ['can', 'CA'],
  ['aus', 'AU'],
  ['deu', 'DE'],
  ['fra', 'FR'],
  ['gbr', 'GB'],
  ['che', 'CH'],
  ['jpn', 'JP'],
  ['nld', 'NL'],
  ['phl', 'PH'],
  ['sgp', 'SG'],
  ['nzl', 'NZ'],
]);

const REGION_CODES_BY_COUNTRY = new Map<string, ReadonlyMap<string, readonly string[]>>([
  [
    'US',
    new Map<string, readonly string[]>([
      ['al', ['alabama']], ['ak', ['alaska']], ['az', ['arizona']], ['ar', ['arkansas']],
      ['ca', ['california']], ['co', ['colorado']], ['ct', ['connecticut']], ['de', ['delaware']],
      ['dc', ['district of columbia']], ['fl', ['florida']], ['ga', ['georgia']], ['hi', ['hawaii']],
      ['id', ['idaho']], ['il', ['illinois']], ['in', ['indiana']], ['ia', ['iowa']],
      ['ks', ['kansas']], ['ky', ['kentucky']], ['la', ['louisiana']], ['me', ['maine']],
      ['md', ['maryland']], ['ma', ['massachusetts']], ['mi', ['michigan']], ['mn', ['minnesota']],
      ['ms', ['mississippi']], ['mo', ['missouri']], ['mt', ['montana']], ['ne', ['nebraska']],
      ['nv', ['nevada']], ['nh', ['new hampshire']], ['nj', ['new jersey']], ['nm', ['new mexico']],
      ['ny', ['new york']], ['nc', ['north carolina']], ['nd', ['north dakota']], ['oh', ['ohio']],
      ['ok', ['oklahoma']], ['or', ['oregon']], ['pa', ['pennsylvania']], ['pr', ['puerto rico']],
      ['ri', ['rhode island']], ['sc', ['south carolina']], ['sd', ['south dakota']],
      ['tn', ['tennessee']], ['tx', ['texas']], ['ut', ['utah']], ['vt', ['vermont']],
      ['va', ['virginia']], ['wa', ['washington']], ['wv', ['west virginia']],
      ['wi', ['wisconsin']], ['wy', ['wyoming']],
    ]),
  ],
  [
    'CA',
    new Map<string, readonly string[]>([
      ['ab', ['alberta']],
      ['bc', ['british columbia', 'colombie-britannique']],
      ['mb', ['manitoba']],
      ['nb', ['new brunswick', 'nouveau-brunswick']],
      ['nl', ['newfoundland and labrador', 'newfoundland', 'terre-neuve-et-labrador']],
      ['ns', ['nova scotia', 'nouvelle-ecosse']],
      ['nt', ['northwest territories', 'territoires du nord-ouest']],
      ['nu', ['nunavut']],
      ['on', ['ontario']],
      ['pe', ['prince edward island', 'ile-du-prince-edouard']],
      ['qc', ['quebec']],
      ['sk', ['saskatchewan']],
      ['yt', ['yukon']],
    ]),
  ],
  [
    'AU',
    new Map<string, readonly string[]>([
      ['act', ['australian capital territory']],
      ['nsw', ['new south wales']],
      ['nt', ['northern territory']],
      ['qld', ['queensland']],
      ['sa', ['south australia']],
      ['tas', ['tasmania']],
      ['vic', ['victoria']],
      ['wa', ['western australia']],
    ]),
  ],
  [
    'CH',
    new Map<string, readonly string[]>([
      ['ag', ['aargau', 'argovie']],
      ['ai', ['appenzell innerrhoden']],
      ['ar', ['appenzell ausserrhoden']],
      ['be', ['bern', 'berne']],
      ['bl', ['basel-landschaft', 'basel-country', 'bale-campagne']],
      ['bs', ['basel-stadt', 'basel-city', 'bale-ville']],
      ['fr', ['fribourg', 'freiburg']],
      ['ge', ['geneva', 'geneve', 'genf', 'ginevra']],
      ['gl', ['glarus', 'glaris']],
      ['gr', ['grisons', 'graubunden', 'grigioni']],
      ['ju', ['jura']],
      ['lu', ['lucerne', 'luzern', 'lucerna']],
      ['ne', ['neuchatel', 'neuenburg']],
      ['nw', ['nidwalden', 'nidwald']],
      ['ow', ['obwalden', 'obwald']],
      ['sg', ['saint gallen', 'st. gallen', 'st gallen', 'sankt gallen', 'saint-gall']],
      ['sh', ['schaffhausen', 'schaffhouse']],
      ['so', ['solothurn', 'soleure']],
      ['sz', ['schwyz']],
      ['tg', ['thurgau', 'thurgovie']],
      ['ti', ['ticino', 'tessin']],
      ['ur', ['uri']],
      ['vd', ['vaud', 'waadt']],
      ['vs', ['valais', 'wallis']],
      ['zg', ['zug', 'zoug']],
      ['zh', ['zurich']],
    ]),
  ],
]);

const US_STATE_SET = new Set<string>(REGION_CODES_BY_COUNTRY.get('US')!.keys());

function hasAnyRegionCode(codeKey: string): boolean {
  for (const map of REGION_CODES_BY_COUNTRY.values()) {
    if (map.has(codeKey)) return true;
  }
  return false;
}

const STREET_SUFFIX_RE =
  /\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pl|place|pkwy|parkway|str|strasse|rue|weg|allee)\b\.?(?:\s+\d+[a-z]?)?$/i;

const placeRowsCache = new WeakMap<PlaceList, readonly PlaceRow[]>();
const placeLookupCache = new WeakMap<PlaceList, PlaceLookupIndex>();

function getPlaceRows(rows: PlaceList): readonly PlaceRow[] {
  const cached = placeRowsCache.get(rows);
  if (cached) return cached;
  const built: PlaceRow[] = rows.map((item) => {
    const hit: PlaceHit = {
      name: item.name,
      lat: item.lat,
      lng: item.lng,
      country: item.country,
      region: item.region,
    };
    const keys = [foldForMatch(item.name).trim()].filter(Boolean);
    return { hit, keys };
  });
  placeRowsCache.set(rows, built);
  return built;
}

function getPlaceLookupIndex(rows: PlaceList): PlaceLookupIndex {
  const cached = placeLookupCache.get(rows);
  if (cached) return cached;
  const built = buildPlaceLookupIndex(getPlaceRows(rows));
  placeLookupCache.set(rows, built);
  return built;
}

let cachedDisplayNames: Intl.DisplayNames[] | null = null;
let cachedCountryNameToIso: Map<string, string> | null = null;

function getRegionDisplayNames(): readonly Intl.DisplayNames[] {
  if (cachedDisplayNames) return cachedDisplayNames;
  const instances: Intl.DisplayNames[] = [];
  for (const lang of Object.keys(LOCALE_TO_SLUG)) {
    try {
      instances.push(new Intl.DisplayNames([lang], { type: 'region' }));
    } catch {
      // Ignore unavailable region display names.
    }
  }
  cachedDisplayNames = instances;
  return instances;
}

function getGlobalCountryNameToIso(): ReadonlyMap<string, string> {
  if (cachedCountryNameToIso) return cachedCountryNameToIso;
  const map = new Map<string, string>();
  const displayInstances = getRegionDisplayNames();
  for (const iso of VALID_ISO_COUNTRIES) {
    for (const display of displayInstances) {
      try {
        const label = display.of(iso);
        if (label) {
          const folded = foldForMatch(label).replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
          if (folded && folded.length >= 2) map.set(folded, iso);
        }
      } catch {
        // Ignore invalid region codes.
      }
    }
  }
  for (const iso of VALID_ISO_COUNTRIES) {
    map.set(iso.toLowerCase(), iso);
  }
  cachedCountryNameToIso = map;
  return map;
}

function buildPlaceLookupIndex(rows: readonly PlaceRow[]): PlaceLookupIndex {
  const byKey = new Map<string, PlaceRow[]>();
  const knownIsoCodes = new Set<string>();
  const knownRegionsByCountry = new Map<string, Set<string>>();
  for (const row of rows) {
    const iso = row.hit.country.toUpperCase();
    if (iso) {
      knownIsoCodes.add(iso);
      const foldedRegion = foldForMatch(row.hit.region).trim();
      if (foldedRegion) {
        let regionSet = knownRegionsByCountry.get(iso);
        if (!regionSet) {
          regionSet = new Set<string>();
          knownRegionsByCountry.set(iso, regionSet);
        }
        regionSet.add(foldedRegion);
      }
    }
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
  const knownCountryNames: Array<readonly [string, string]> = [];
  for (const [name, iso] of getGlobalCountryNameToIso()) {
    if (knownIsoCodes.has(iso)) knownCountryNames.push([name, iso]);
  }
  return { byKey, knownCountryNames, knownIsoCodes, knownRegionsByCountry };
}

function normalizeCountryQuery(rawCountry: string): string {
  return foldForMatch(rawCountry).replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveCountryIso(rawCountry: string): string | null {
  const cleaned = normalizeCountryQuery(rawCountry);
  if (!cleaned) return null;
  const fromAlias = COUNTRY_ALIASES.get(cleaned);
  if (fromAlias) return fromAlias;
  if (/^[a-z]{2}$/.test(cleaned)) {
    const upper = cleaned.toUpperCase();
    return VALID_ISO_COUNTRIES.has(upper) ? upper : null;
  }
  return getGlobalCountryNameToIso().get(cleaned) ?? null;
}

function resolveCountryPrefixIsos(rawQualifier: string, index: PlaceLookupIndex): ReadonlySet<string> {
  const out = new Set<string>();
  const exact = resolveCountryIso(rawQualifier);
  if (exact && index.knownIsoCodes.has(exact)) out.add(exact);
  const cleaned = normalizeCountryQuery(rawQualifier);
  const charCount = [...cleaned].length;
  if (charCount >= 3 || (charCount >= 2 && !/^[a-z\s-]+$/.test(cleaned))) {
    for (const [alias, iso] of COUNTRY_ALIASES) {
      if (index.knownIsoCodes.has(iso) && alias.startsWith(cleaned)) out.add(iso);
    }
    for (const [name, iso] of index.knownCountryNames) {
      if (name.startsWith(cleaned)) out.add(iso);
    }
  }
  return out;
}

function startsRegionWord(text: string, prefix: string): boolean {
  return (
    text === prefix
    || text.startsWith(`${prefix} `)
    || text.startsWith(`${prefix}-`)
    || text.startsWith(`${prefix}/`)
  );
}

function expandRegionCode(codeKey: string, rowCountry?: string): readonly string[] | undefined {
  if (!rowCountry) return undefined;
  return REGION_CODES_BY_COUNTRY.get(rowCountry.toUpperCase())?.get(codeKey);
}

function regionMatches(rowRegion: string, rawRegion: string, rowCountry?: string): boolean {
  const a = foldForMatch(rowRegion).trim();
  const b = foldForMatch(rawRegion).trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const codeKey = b.includes('.') ? b.replace(/\./g, '') : b;
  const expandedList = expandRegionCode(codeKey, rowCountry);
  if (expandedList && expandedList.some((expanded) => startsRegionWord(a, expanded))) return true;
  // Require full-word boundary match rather than arbitrary substring so "Virginia"
  // does not match "West Virginia" and "Kansas" does not match "Arkansas".
  if (b.length >= 4 && startsRegionWord(a, b)) return true;
  if (a.length >= 4 && startsRegionWord(b, a)) return true;
  return false;
}

function regionMatchesQualifier(rowRegion: string, rawQualifier: string, rowCountry: string): boolean {
  if (regionMatches(rowRegion, rawQualifier, rowCountry)) return true;
  const a = foldForMatch(rowRegion).trim();
  const b = foldForMatch(rawQualifier).trim();
  if (!a || !b) return false;
  if (/^[A-Z]{2,3}\.?$/.test(rawQualifier.trim())) {
    const codeKey = b.includes('.') ? b.replace(/\./g, '') : b;
    if (REGION_CODES_BY_COUNTRY.get(rowCountry.toUpperCase())?.has(codeKey)) return false;
  }
  return a.startsWith(b);
}

function isKnownCanonicalRegion(rawRegion: string, countryIso: string, index: PlaceLookupIndex): boolean {
  const folded = foldForMatch(rawRegion).trim();
  if (!folded) return false;
  const upperIso = countryIso.toUpperCase();
  if (index.knownRegionsByCountry.get(upperIso)?.has(folded)) return true;
  const codeMap = REGION_CODES_BY_COUNTRY.get(upperIso);
  if (codeMap) {
    const codeKey = folded.includes('.') ? folded.replace(/\./g, '') : folded;
    if (codeMap.has(codeKey)) return true;
    for (const names of codeMap.values()) {
      if (names.includes(folded)) return true;
    }
  }
  return false;
}

function isKnownCanonicalRegionAny(rawRegion: string, index: PlaceLookupIndex): boolean {
  const folded = foldForMatch(rawRegion).trim();
  if (!folded) return false;
  for (const set of index.knownRegionsByCountry.values()) {
    if (set.has(folded)) return true;
  }
  const codeKey = folded.includes('.') ? folded.replace(/\./g, '') : folded;
  for (const codeMap of REGION_CODES_BY_COUNTRY.values()) {
    if (codeMap.has(codeKey)) return true;
    for (const names of codeMap.values()) {
      if (names.includes(folded)) return true;
    }
  }
  return false;
}

function extractPostalCountryIso(rawToken: string): string | null {
  const clean = rawToken.replace(/\s+/g, ' ').trim();
  const m = /^(?:[a-z]{1,2}-?)?\d{4,6}(?:-\d{3,4})? ([a-z]{2})$/i.exec(clean);
  if (!m) return null;
  const upper = m[1]!.toUpperCase();
  if (upper !== 'NL' && VALID_ISO_COUNTRIES.has(upper)) return upper;
  return null;
}

function matchUsStateZip(rawToken: string): string | null {
  const clean = rawToken.replace(/\s+/g, ' ').trim();
  const m = /^(.+) \d{5}(?:-\d{4})?$/.exec(clean);
  if (!m) return null;
  const stateRaw = m[1]!.trim();
  const folded = foldForMatch(stateRaw).trim();
  const codeKey = folded.replace(/\./g, '');
  const usMap = REGION_CODES_BY_COUNTRY.get('US')!;
  if (/^[a-z]{2}$/.test(codeKey) && usMap.has(codeKey)) return codeKey.toUpperCase();
  for (const names of usMap.values()) {
    if (names.includes(folded)) return stateRaw;
  }
  return null;
}

function stripPostalCodes(token: string): string {
  const clean = token.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean
    // Japanese postal mark + code (〒100-0001)
    .replace(/〒 ?\d{3}-?\d{4}/g, ' ')
    // UK postcode (SW1A 1AA, SE1 9QG, M1 1AE)
    .replace(/(?<![\p{L}\d])[a-z]{1,2}\d[a-z\d]? ?\d[a-z]{2}(?![\p{L}\d])/giu, ' ')
    // Canadian postcode (H2W 2M5)
    .replace(/(?<![\p{L}\d])[a-z]\d[a-z] ?\d[a-z]\d(?![\p{L}\d])/giu, ' ')
    // Dutch postcode ahead of town (1012 JS Amsterdam), never eating 2-letter prefixes
    // or accented names ("9000 St. Gallen", "4000 Liège", "2300 La Chaux-de-Fonds").
    .replace(/(?<![\p{L}\d])(?:[A-Z]{1,2}-)?\d{4} [A-Z]{2}(?= \p{L})/gu, ' ')
    // Trailing/standalone Dutch postcode (1012 JS), preserving non-NL ISO country codes ("2000 AU").
    .replace(/(^| )\d{4} ([a-z]{2})$/i, (full, lead: string, letters: string) => {
      const upper = letters.toUpperCase();
      if (upper !== 'NL' && VALID_ISO_COUNTRIES.has(upper)) return full;
      return lead ? ' ' : '';
    })
    .replace(/\s+/g, ' ')
    .trim()
    // Standalone European/US postal code (CH-8001, 94105, 94105-1234)
    .replace(/^(?:[a-z]{1,2}-)?\d{4,6}(?:-\d{3,4})?$/i, '')
    // Leading European/US postal code (CH-8001 Zurich, 10119 Berlin, 100-0001 Tokyo)
    .replace(/^(?:[a-z]{1,2}-?)?\d{4,6}(?:-\d{3,4})? /i, '')
    // Trailing numeric postal code (94105, 94105-1234, 8001)
    .replace(/ \d{4,6}(?:-\d{3,4})?$/i, '')
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
  // Handle "Austin, TX" or "St. Louis" / "St. Gallen" / "Aix-en-Provence" variants
  const beforeComma = rawCity.split(',')[0]?.trim();
  if (beforeComma && beforeComma !== rawCity.trim()) {
    push(beforeComma);
    push(stripPostalCodes(beforeComma));
  }
  for (const base of [...out]) {
    if (/\bst\.\s+/i.test(base)) push(base.replace(/\bst\.\s+/gi, 'st '));
    if (/\bst\s+/i.test(base)) push(base.replace(/\bst\s+/gi, 'st. '));
    if (/\bst\.?\s+/i.test(base)) {
      push(base.replace(/\bst\.?\s+/gi, 'saint '));
      push(base.replace(/\bst\.?\s+/gi, 'sankt '));
    }
    if (/\bsaint\s+/i.test(base)) {
      push(base.replace(/\bsaint\s+/gi, 'st '));
      push(base.replace(/\bsaint\s+/gi, 'st. '));
    }
    if (/\bsankt\s+/i.test(base)) {
      push(base.replace(/\bsankt\s+/gi, 'st '));
      push(base.replace(/\bsankt\s+/gi, 'st. '));
    }
    if (base.includes('-')) push(base.replace(/-/g, ' '));
  }
  return out;
}

function pickBestPlaceHit(
  hits: readonly PlaceRow[],
  countryIso: string | null,
  rawRegion: string,
  extraTokens: readonly string[],
  index: PlaceLookupIndex,
  strictRegion = false,
  commaCountryIso: string | null = null,
): PlaceRow | null {
  let candidates = hits;
  if (countryIso) {
    const byCountry = candidates.filter((h) => h.hit.country.toUpperCase() === countryIso);
    if (byCountry.length === 0) return null;
    candidates = byCountry;
  }
  if (rawRegion.trim()) {
    const foldedRaw = foldForMatch(rawRegion).trim();
    const exactRegion = candidates.filter((h) => foldForMatch(h.hit.region).trim() === foldedRaw);
    if (exactRegion.length > 0) return exactRegion[0]!;
    const byRegion = candidates.filter((h) => regionMatches(h.hit.region, rawRegion, h.hit.country));
    if (byRegion.length > 0) return byRegion[0]!;
    if (strictRegion) return null;
    const canonicalConflict = countryIso
      ? isKnownCanonicalRegion(rawRegion, countryIso, index)
      : isKnownCanonicalRegionAny(rawRegion, index);
    if (canonicalConflict) {
      candidates = candidates.filter(
        (h) =>
          !h.hit.region.trim()
          || (commaCountryIso !== null && h.hit.country.toUpperCase() === commaCountryIso),
      );
      if (candidates.length === 0) return null;
    }
  }
  if (extraTokens.length > 0 && candidates.length > 1) {
    for (const token of extraTokens) {
      const byRegion = candidates.filter((h) => regionMatches(h.hit.region, token, h.hit.country));
      if (byRegion.length > 0) return byRegion[0]!;
    }
  }
  // Place lists are sorted by rank (population or prominence).
  return candidates[0] ?? null;
}

/** One line: name, lat, lng, country, region, population, other|names. */
export function parsePlaces(text: string): PlaceList {
  const hits: PlaceHit[] = [];
  const internalRows: PlaceRow[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [name, lat, lng, country, region, , others] = line.split('\t');
    const la = Number(lat);
    const ln = Number(lng);
    if (!name || !Number.isFinite(la) || !Number.isFinite(ln)) continue;
    const hit: PlaceHit = { name, lat: la, lng: ln, country: country ?? '', region: region ?? '' };
    const keys = [name, ...(others ? others.split('|') : [])].map((k) => foldForMatch(k).trim()).filter(Boolean);
    hits.push(hit);
    internalRows.push({ hit, keys });
  }
  placeRowsCache.set(hits, internalRows);
  return hits;
}

type SearchQualifier =
  | { kind: 'usStateZip'; stateCode: string }
  | { kind: 'postalCountry'; countryIso: string }
  | { kind: 'general'; raw: string; stripped: string; countryIsos: ReadonlySet<string> };

/**
 * The towns whose name, or another spelling of it, starts with the query, the
 * largest first; then those where a later word starts with it ("York" finds
 * New York). Two letters at least, at most `limit` towns.
 */
export function searchPlaces(rows: PlaceList, query: string, limit = 6): PlaceHit[] {
  const rawParts = query.split(',').map((p) => p.trim()).filter(Boolean);
  const needle = foldForMatch(rawParts[0] ?? '').trim();
  if ([...needle].length < 2 || rows.length === 0 || limit <= 0) return [];
  const rawQualifiers = rawParts.slice(1);
  const internalRows = getPlaceRows(rows);
  const index = rawQualifiers.length > 0 ? getPlaceLookupIndex(rows) : null;
  const parsedQualifiers: SearchQualifier[] = [];
  for (let i = 0; i < rawQualifiers.length; i++) {
    const raw = rawQualifiers[i]!.replace(/\s+/g, ' ').trim();
    const usStateZip = /^([a-z]{2}) \d{5}(?:-\d{4})?$/i.exec(raw);
    if (usStateZip && US_STATE_SET.has(usStateZip[1]!.toLowerCase())) {
      parsedQualifiers.push({ kind: 'usStateZip', stateCode: usStateZip[1]! });
      continue;
    }
    if (
      i + 1 < rawQualifiers.length
      && /^[a-z]{2}$/i.test(raw)
      && US_STATE_SET.has(raw.toLowerCase())
      && /^\d{5}(?:-\d{4})?$/.test(rawQualifiers[i + 1]!)
    ) {
      parsedQualifiers.push({ kind: 'usStateZip', stateCode: raw });
      i += 1;
      continue;
    }
    const postalIso = extractPostalCountryIso(raw);
    if (postalIso) {
      parsedQualifiers.push({ kind: 'postalCountry', countryIso: postalIso });
      continue;
    }
    const stripped = stripPostalCodes(raw);
    const countryIsos = index
      ? new Set([
          ...resolveCountryPrefixIsos(raw, index),
          ...(stripped && stripped !== raw ? resolveCountryPrefixIsos(stripped, index) : []),
        ])
      : new Set<string>();
    if (!stripped && countryIsos.size === 0) continue;
    parsedQualifiers.push({ kind: 'general', raw, stripped, countryIsos });
  }
  const matchesQualifiers = (row: PlaceRow): boolean => {
    if (parsedQualifiers.length === 0) return true;
    const rowCountry = row.hit.country.toUpperCase();
    return parsedQualifiers.every((q) => {
      if (q.kind === 'usStateZip') {
        return rowCountry === 'US' && regionMatches(row.hit.region, q.stateCode, 'US');
      }
      if (q.kind === 'postalCountry') {
        return rowCountry === q.countryIso;
      }
      return (
        regionMatchesQualifier(row.hit.region, q.raw, rowCountry)
        || (Boolean(q.stripped) && q.stripped !== q.raw && regionMatchesQualifier(row.hit.region, q.stripped, rowCountry))
        || q.countryIsos.has(rowCountry)
      );
    });
  };
  const first: PlaceRow[] = [];
  const later: PlaceRow[] = [];
  for (const row of internalRows) {
    if (!matchesQualifiers(row)) continue;
    if (row.keys.some((k) => k.startsWith(needle))) {
      first.push(row);
      if (first.length >= limit) break;
    } else if (later.length < limit && row.keys.some((k) => k.includes(` ${needle}`) || k.includes(`-${needle}`))) {
      later.push(row);
    }
  }
  return [...first, ...later].slice(0, limit).map(({ hit }) => ({ ...hit }));
}

/**
 * Match a structured or street-blob postal address offline against `rows`,
 * disambiguating towns by ISO country code, country name, or state/region.
 * Spec: docs/internal/specs/graph-view.md (section 4.1)
 */
export function matchPlaceAddress(rows: PlaceList, address: PlaceAddressInput): PlaceHit | null {
  if (rows.length === 0) return null;
  const index = getPlaceLookupIndex(rows);
  const rawCountry = address.country.trim();
  let countryIso: string | null = null;
  if (rawCountry) {
    const postalIso = extractPostalCountryIso(rawCountry);
    const strippedCountry = stripPostalCodes(rawCountry);
    countryIso = postalIso
      ?? resolveCountryIso(rawCountry)
      ?? (strippedCountry !== rawCountry ? resolveCountryIso(strippedCountry) : null);
    if (!countryIso || !index.knownIsoCodes.has(countryIso)) return null;
  }
  let rawRegion = address.region.trim();
  let strictRegion = false;

  // Primary path: explicit city field.
  const rawCity = address.city.trim();
  if (rawCity) {
    const cityQualifiers: Array<(row: PlaceRow) => boolean> = [];
    const extraHints: string[] = [];
    let commaCountryIso: string | null = null;
    if (rawCity.includes(',')) {
      const trailingParts = rawCity.split(',').slice(1).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
      // Pre-resolve an unambiguous trailing country token ("Paris, TX, USA", "Paris, Brazil")
      // so earlier state/region tokens are evaluated under that country's scope.
      if (!countryIso && trailingParts.length >= 1) {
        const lastPart = trailingParts[trailingParts.length - 1]!;
        if (!matchUsStateZip(lastPart)) {
          const lastPostalIso = extractPostalCountryIso(lastPart);
          const lastStripped = stripPostalCodes(lastPart);
          const lastCodeKey = foldForMatch(lastStripped).trim().replace(/\./g, '');
          const lastIso = lastPostalIso
            ?? resolveCountryIso(lastPart)
            ?? (lastStripped && lastStripped !== lastPart ? resolveCountryIso(lastStripped) : null);
          if (
            lastIso
            && (lastPostalIso !== null || trailingParts.length >= 2 || !hasAnyRegionCode(lastCodeKey))
          ) {
            if (!index.knownIsoCodes.has(lastIso)) return null;
            countryIso = lastIso;
            trailingParts.pop();
          }
        }
      }

      for (let i = 0; i < trailingParts.length; i++) {
        const part = trailingParts[i]!;
        const stateFromZip = matchUsStateZip(part);
        if (stateFromZip) {
          if (countryIso && countryIso !== 'US') return null;
          if (!index.knownIsoCodes.has('US')) return null;
          countryIso = 'US';
          if (!rawRegion) rawRegion = stateFromZip;
          strictRegion = true;
          cityQualifiers.push((h) => h.hit.country.toUpperCase() === 'US' && regionMatches(h.hit.region, stateFromZip, 'US'));
          continue;
        }
        if (
          i + 1 < trailingParts.length
          && /^[a-z]{2}$/i.test(part)
          && US_STATE_SET.has(part.toLowerCase())
          && /^\d{5}(?:-\d{4})?$/.test(trailingParts[i + 1]!)
        ) {
          if (countryIso && countryIso !== 'US') return null;
          if (!index.knownIsoCodes.has('US')) return null;
          countryIso = 'US';
          const stateCode = part.toUpperCase();
          if (!rawRegion) rawRegion = stateCode;
          strictRegion = true;
          cityQualifiers.push((h) => h.hit.country.toUpperCase() === 'US' && regionMatches(h.hit.region, stateCode, 'US'));
          i += 1;
          continue;
        }
        const postalIso = extractPostalCountryIso(part);
        if (postalIso) {
          if (countryIso === 'NL' && /^\d{4} [a-z]{2}$/i.test(part)) continue;
          if (countryIso && countryIso !== postalIso) return null;
          if (!index.knownIsoCodes.has(postalIso)) return null;
          countryIso = postalIso;
          cityQualifiers.push((h) => h.hit.country.toUpperCase() === postalIso);
          continue;
        }
        const stripped = stripPostalCodes(part);
        if (!stripped) continue;
        const codeKey = foldForMatch(stripped).trim().replace(/\./g, '');

        if (countryIso) {
          if (REGION_CODES_BY_COUNTRY.get(countryIso)?.has(codeKey)) {
            if (!rawRegion) rawRegion = stripped;
            const targetCountry = countryIso;
            cityQualifiers.push((h) => regionMatches(h.hit.region, stripped, targetCountry));
            continue;
          }
          const partIso = resolveCountryIso(part)
            ?? (stripped !== part ? resolveCountryIso(stripped) : null);
          if (partIso) {
            if (partIso !== countryIso) return null;
            continue;
          }
          if (isKnownCanonicalRegion(stripped, countryIso, index)) {
            if (!rawRegion) rawRegion = stripped;
            const targetCountry = countryIso;
            cityQualifiers.push((h) =>
              regionMatches(h.hit.region, part, targetCountry)
              || (stripped !== part && regionMatches(h.hit.region, stripped, targetCountry)),
            );
            continue;
          }
          // Sub-region, county, or unmapped local code ("Greater London", "NRW"):
          // treat as preference hint under the known country rather than rejecting the city.
          if (!rawRegion) rawRegion = stripped;
          else extraHints.push(stripped);
          continue;
        }

        const partIso = resolveCountryIso(part)
          ?? (stripped !== part ? resolveCountryIso(stripped) : null);
        const validIso = partIso && index.knownIsoCodes.has(partIso) ? partIso : null;
        if (!rawRegion && (!validIso || hasAnyRegionCode(codeKey))) {
          rawRegion = stripped;
          commaCountryIso = validIso;
        }
        cityQualifiers.push((h) => {
          const hc = h.hit.country.toUpperCase();
          return (
            regionMatches(h.hit.region, part, hc)
            || (stripped !== part && regionMatches(h.hit.region, stripped, hc))
            || (validIso !== null && hc === validIso)
          );
        });
      }
    }
    for (const key of cityKeyCandidates(rawCity)) {
      const rawHits = index.byKey.get(key);
      if (!rawHits || rawHits.length === 0) continue;
      const hits = cityQualifiers.length > 0
        ? rawHits.filter((h) => cityQualifiers.every((fn) => fn(h)))
        : rawHits;
      if (hits.length === 0) continue;
      const best = pickBestPlaceHit(hits, countryIso, rawRegion, extraHints, index, strictRegion, commaCountryIso);
      if (best) return { ...best.hit };
    }
    return null;
  }

  // Fallback path: scan lines and comma-separated tokens of a multi-line street blob.
  if (!address.street.trim()) return null;
  const parts: string[] = [];
  for (const line of address.street.split(/\r?\n/)) {
    for (const piece of line.split(',')) {
      const trimmed = piece.replace(/\s+/g, ' ').trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  if (parts.length === 0) return null;

  const skipIndices = new Set<number>();

  // Infer country from trailing tokens when the structured country field is empty.
  // Guard against US state + ZIP tokens ("CA 94105", "California 90001") colliding
  // with ISO country codes (Canada, Israel, Colombia, etc.).
  if (!countryIso) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const rawPart = parts[i]!;
      if (matchUsStateZip(rawPart)) {
        if (!index.knownIsoCodes.has('US')) return null;
        countryIso = 'US';
        break;
      }
      const postalIso = extractPostalCountryIso(rawPart);
      if (postalIso) {
        if (!index.knownIsoCodes.has(postalIso)) return null;
        countryIso = postalIso;
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
        if (!index.knownIsoCodes.has('US')) return null;
        countryIso = 'US';
        if (!rawRegion) {
          rawRegion = lower.toUpperCase();
          strictRegion = true;
        }
        skipIndices.add(i);
        break;
      }
      const iso = resolveCountryIso(rawPart)
        ?? (cleanedForCountry && cleanedForCountry !== rawPart ? resolveCountryIso(cleanedForCountry) : null);
      if (iso) {
        if (index.knownIsoCodes.has(iso)) {
          countryIso = iso;
          skipIndices.add(i);
          break;
        }
        // Fail closed when a trailing country token resolves to an ISO country absent from `rows`
        // (unless a mid-address 2-letter token is a known region code of a present country).
        const mayBeMidRegionCode =
          i < parts.length - 1
          && /^[a-z]{2}$/.test(lower)
          && [...index.knownIsoCodes].some((known) => REGION_CODES_BY_COUNTRY.get(known)?.has(lower));
        if (!mayBeMidRegionCode) return null;
      }
    }
  }

  const hasEarlierCityCandidate = (beforeIndex: number): boolean => {
    for (let j = beforeIndex - 1; j >= 0; j--) {
      if (skipIndices.has(j)) continue;
      const earlier = parts[j]!;
      if (STREET_SUFFIX_RE.test(earlier)) continue;
      if (j === 0 && parts.length > 1 && /^\d+\s+/.test(earlier)) continue;
      const earlierCleaned = stripPostalCodes(earlier);
      for (const key of cityKeyCandidates(earlierCleaned)) {
        if (index.byKey.has(key)) return true;
      }
    }
    return false;
  };

  // Scan bottom-up because postal addresses place city/region/country after street lines.
  const globalCountryNames = getGlobalCountryNameToIso();
  const extraTokens = parts.map((p) => stripPostalCodes(p)).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (skipIndices.has(i)) continue;
    const part = parts[i]!;

    const stateFromZip = matchUsStateZip(part);
    const splitUsStateZip =
      !stateFromZip
      && i + 1 < parts.length
      && /^[a-z]{2}$/i.test(part)
      && US_STATE_SET.has(part.toLowerCase())
      && /^\d{5}(?:-\d{4})?$/.test(parts[i + 1]!);
    if (stateFromZip || splitUsStateZip) {
      if (countryIso && countryIso !== 'US') return null;
      if (!index.knownIsoCodes.has('US')) return null;
      countryIso = 'US';
      const resolvedState = stateFromZip ?? part.toUpperCase();
      if (!rawRegion) rawRegion = resolvedState;
      strictRegion = true;
      if (splitUsStateZip || /^[a-z]{2}$/i.test(resolvedState)) continue;
      const zipStateLower = foldForMatch(stripPostalCodes(part)).trim();
      if (!index.byKey.has(zipStateLower) || hasEarlierCityCandidate(i)) continue;
    }

    const postalIso = extractPostalCountryIso(part);
    if (postalIso) {
      if (countryIso === 'NL' && /^\d{4} [a-z]{2}$/i.test(part)) continue;
      if (countryIso && countryIso !== postalIso) return null;
      if (!index.knownIsoCodes.has(postalIso)) return null;
      countryIso = postalIso;
      continue;
    }

    if (STREET_SUFFIX_RE.test(part)) continue;
    // Skip pure leading street line ("123 Main St" or "Bahnhofstrasse 1") when later parts exist.
    if (i === 0 && parts.length > 1 && /^\d+\s+/.test(part)) continue;
    const cleaned = stripPostalCodes(part);
    const lower = foldForMatch(cleaned).trim();
    if (!lower || /^\d+$/.test(lower) || [...lower].length < 2) continue;

    // Evaluate region codes and canonical region names before skipping 2-letter ISO country codes
    // so region tokens ("CA", "DE", "California", "Bayern") populate rawRegion instead of dropping.
    const codeKey = lower.replace(/\./g, '');
    const isRegionToken = countryIso
      ? Boolean(REGION_CODES_BY_COUNTRY.get(countryIso)?.has(codeKey)) || isKnownCanonicalRegion(cleaned, countryIso, index)
      : hasAnyRegionCode(codeKey) || isKnownCanonicalRegionAny(cleaned, index);
    if (i > 0 && isRegionToken && (!index.byKey.has(lower) || hasEarlierCityCandidate(i))) {
      if (!rawRegion) rawRegion = cleaned;
      continue;
    }

    // Skip tokens that are purely a country alias or country name/code so Wikidata country
    // rows do not hijack the city match, failing closed on conflicting explicit countries.
    if (COUNTRY_ALIASES.has(lower) || (globalCountryNames.has(lower) && !index.byKey.has(lower))) {
      const tokenIso = resolveCountryIso(part) ?? (cleaned !== part ? resolveCountryIso(cleaned) : null);
      if (tokenIso && countryIso && tokenIso !== countryIso) return null;
      continue;
    }

    for (const key of cityKeyCandidates(cleaned)) {
      const hits = index.byKey.get(key);
      if (!hits || hits.length === 0) continue;
      const best = pickBestPlaceHit(hits, countryIso, rawRegion, extraTokens, index, strictRegion);
      if (best) return { ...best.hit };
    }
  }

  return null;
}

const loaded = new Map<string, Promise<PlaceList>>();

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
export function nearestPlace(rows: PlaceList, lat: number, lng: number, maxKm = 25): PlaceHit | undefined {
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
export function loadPlaces(locale: string): Promise<PlaceList> {
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
