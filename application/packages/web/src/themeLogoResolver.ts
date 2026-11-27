import type { ComponentType } from 'react';
import type { CustomSnapshot } from './theme';
import type { ThemeLogoProps } from './themeLogos';

/**
 * Lazy-loaded lookup table and per-category chunk loader for built-in bespoke
 * sidebar theme marks (`communityThemes.ts`, `teamThemes.ts`).
 *
 * Lives off the boot path: Default, Cream, Slate, Sage, Soft, Navy, OLED, and
 * Note Boy never load this module. Activating any other shipped theme loads
 * this tiny router plus only the single ~7 kB chunk holding its artwork.
 * Spec: docs/contrib/community-themes.md (section 3, The sidebar icon)
 */
const CORE_THEME_LOGOS = {
  darthvader00: 'Darth Vader',
  deathstar000: 'Death Star',
  jedi00000000: 'Jedi',
  whiterabbit0: 'White Rabbit',
  thegrid00000: 'The Grid',
  grandtheftno: 'Grand Theft Notes',
  mastersword0: 'Master Sword',
  shrine000000: 'Shrine',
  harrynoter00: 'Wax Seal',
  strangernote: 'Stranger Notes',
  brassvault00: 'Brass Vault',
  ambercrt0000: 'Amber CRT',
} as const;

const POP_THEME_LOGOS = {
  hoth00000000: 'Hoth',
  hyrule000000: 'Hyrule',
  kokiriforest: 'Kokiri Forest',
  breathofthen: 'Breath of the Notes',
  harrynoter01: 'Spellbook',
  haveaviceday: 'Have a Vice Day',
  bikinibottom: 'Bikini Bottom',
  krustykrab00: 'Krusty Krab',
  madteaparty0: 'Mad Tea Party',
  centralperk0: 'Central Perk',
  koipond00000: 'Koi Pond',
  grimoire0000: 'Grimoire',
} as const;

const CRAFT_THEME_LOGOS = {
  jackolantern: 'Jack-o-Lantern',
  candycane000: 'Candy Cane',
  marmaladesan: 'Marmalade Sandwich',
  honeycomb000: 'Honeycomb',
  hazard000000: 'Hazard',
  voidamethyst: 'Void Amethyst',
  terminal0000: 'Terminal',
  outrun000000: 'Outrun',
  sailcloth000: 'Sailcloth',
  risograph000: 'Risograph',
  zengarden000: 'Zen Garden',
  citypop00000: 'City Pop',
  graveyardfog: 'Graveyard Fog',
  cranberry000: 'Cranberry',
  cybergridole: 'CyberGrid OLED',
  rgbmadness00: 'RGB Madness',
} as const;

const STUDIO_THEME_LOGOS = {
  eink00000000: 'E-Ink',
  mono00000000: 'Mono',
  simpledark00: 'Simple Dark',
  highcontrst1: 'High Contrast Light',
  highcontrst0: 'High Contrast Dark',
  midnightink0: 'Midnight',
  rosewater000: 'Rose',
  frost0000000: 'Frost',
  papermint000: 'Mint',
  espresso0000: 'Espresso',
  lavender0000: 'Lavender',
  plum00000000: 'Plum',
  apricot00000: 'Apricot',
} as const;

export type CoreThemeLogoId = keyof typeof CORE_THEME_LOGOS;
export type PopThemeLogoId = keyof typeof POP_THEME_LOGOS;
export type CraftThemeLogoId = keyof typeof CRAFT_THEME_LOGOS;
export type StudioThemeLogoId = keyof typeof STUDIO_THEME_LOGOS;
export type LazyThemeLogoId = CoreThemeLogoId | PopThemeLogoId | CraftThemeLogoId | StudioThemeLogoId;
export type BuiltinThemeLogoId = 'noteboy00000' | LazyThemeLogoId;
export type ThemeLogoChunk = 'core' | 'pop' | 'craft' | 'studio';

const BUILTIN_THEME_LOGO_NAMES: Record<BuiltinThemeLogoId, string> = {
  noteboy00000: 'Note Boy',
  ...CORE_THEME_LOGOS,
  ...POP_THEME_LOGOS,
  ...CRAFT_THEME_LOGOS,
  ...STUDIO_THEME_LOGOS,
};

const BUILTIN_THEME_LOGO_BY_NAME: Record<string, BuiltinThemeLogoId> = Object.fromEntries(
  Object.entries(BUILTIN_THEME_LOGO_NAMES).map(([id, name]) => [name, id as BuiltinThemeLogoId]),
);

/** Resolve a custom theme snapshot to its built-in bespoke logo ID, if any. */
export function resolveBuiltinThemeLogo(
  snap: Pick<CustomSnapshot, 'id' | 'code'> | null,
): BuiltinThemeLogoId | null {
  if (!snap) return null;
  if (Object.prototype.hasOwnProperty.call(BUILTIN_THEME_LOGO_NAMES, snap.id)) {
    return snap.id as BuiltinThemeLogoId;
  }
  if (snap.code.startsWith('pn1:')) {
    const end = snap.code.indexOf(':', 4);
    if (end > 4) {
      const name = snap.code.slice(4, end);
      if (Object.prototype.hasOwnProperty.call(BUILTIN_THEME_LOGO_BY_NAME, name)) {
        return BUILTIN_THEME_LOGO_BY_NAME[name]!;
      }
    }
  }
  return null;
}

/** Resolve from the compact `${id}\0${name}` identity string emitted by `theme.ts`. */
export function resolveThemeLogoFromIdentity(identity: string): LazyThemeLogoId | null {
  const sep = identity.indexOf('\0');
  const id = sep === -1 ? identity : identity.slice(0, sep);
  const name = sep === -1 ? '' : identity.slice(sep + 1);
  if (id === 'noteboy00000' || name === 'Note Boy') return null;
  if (Object.prototype.hasOwnProperty.call(BUILTIN_THEME_LOGO_NAMES, id)) {
    return id as LazyThemeLogoId;
  }
  if (name && Object.prototype.hasOwnProperty.call(BUILTIN_THEME_LOGO_BY_NAME, name)) {
    const matched = BUILTIN_THEME_LOGO_BY_NAME[name]!;
    return matched === 'noteboy00000' ? null : matched;
  }
  return null;
}

/** Which lazy icon chunk holds the SVG mark for a non-Note-Boy built-in logo ID. */
export function builtinThemeLogoChunk(id: LazyThemeLogoId): ThemeLogoChunk {
  if (Object.prototype.hasOwnProperty.call(CORE_THEME_LOGOS, id)) return 'core';
  if (Object.prototype.hasOwnProperty.call(POP_THEME_LOGOS, id)) return 'pop';
  if (Object.prototype.hasOwnProperty.call(CRAFT_THEME_LOGOS, id)) return 'craft';
  return 'studio';
}

type ThemeLogoMap = Partial<Record<LazyThemeLogoId, ComponentType<ThemeLogoProps>>>;
const cachedChunks: Partial<Record<ThemeLogoChunk, ThemeLogoMap>> = {};
const pendingChunks: Partial<Record<ThemeLogoChunk, Promise<ThemeLogoMap>>> = {};

const CHUNK_LOADERS: Record<ThemeLogoChunk, () => Promise<ThemeLogoMap>> = {
  core: () => import('./themeLogos').then((m) => m.THEME_LOGOS),
  pop: () => import('./themeLogosPop').then((m) => m.POP_THEME_LOGOS),
  craft: () => import('./themeLogosCraft').then((m) => m.CRAFT_THEME_LOGOS),
  studio: () => import('./themeLogosStudio').then((m) => m.STUDIO_THEME_LOGOS),
};

/** Synchronous lookup when the chunk holding `id` is already cached. */
export function getCachedThemeLogo(id: LazyThemeLogoId): ComponentType<ThemeLogoProps> | null {
  return cachedChunks[builtinThemeLogoChunk(id)]?.[id] ?? null;
}

/** Load only the chunk holding `id` and return its SVG component. */
export async function loadThemeLogo(id: LazyThemeLogoId): Promise<ComponentType<ThemeLogoProps> | null> {
  const chunk = builtinThemeLogoChunk(id);
  const cached = cachedChunks[chunk];
  if (cached) return cached[id] ?? null;
  let req = pendingChunks[chunk];
  if (!req) {
    req = CHUNK_LOADERS[chunk]()
      .then((loaded) => {
        cachedChunks[chunk] = loaded;
        return loaded;
      })
      .catch((err) => {
        delete pendingChunks[chunk];
        throw err;
      });
    pendingChunks[chunk] = req;
  }
  const map = await req;
  return map[id] ?? null;
}
