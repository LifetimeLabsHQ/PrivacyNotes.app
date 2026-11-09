/**
 * Loads the look icon catalog and the logos on first need, each part once.
 * Small and eager on purpose: the glyph components import it, so the
 * catalogs themselves stay out of every boot path, and a folder that wears an
 * icon never loads a logo. The logos come in parts: the curated set the Logo
 * tab opens on, the names of all the others for its search, and their paths
 * in shards of slug order, so one glyph loads one small file. A
 * failed load (a dropped connection on the web) clears the promise, so the
 * next glyph or the picker tries again; until then every glyph draws its
 * default.
 * Spec: docs/internal/specs/folder-tag-icons.md (sections 3.6 and 8)
 */
import { useEffect, useState } from 'react';
import { LOGO_SHARD_STARTS } from './logos/shards.gen';

type LookIconsModule = typeof import('./lookIcons');
type LookLogosModule = typeof import('./lookLogos.gen');
type LogoPaths = Readonly<Record<string, readonly string[]>>;
/** The name of every logo outside the curated set, for the search. */
export interface LogoIndex {
  logos: readonly (readonly [id: string, name: string])[];
}

function lazyModule<T>(load: () => Promise<T>) {
  const box: { loaded: T | null; loading: Promise<T> | null; load: () => Promise<T> } = {
    loaded: null,
    loading: null,
    load: () => {
      if (box.loaded) return Promise.resolve(box.loaded);
      box.loading ??= load().then(
        (mod) => (box.loaded = mod),
        (err: unknown) => {
          box.loading = null;
          throw err;
        },
      );
      return box.loading;
    },
  };
  return box;
}

const icons = lazyModule(() => import('./lookIcons'));
const logos = lazyModule(() => import('./lookLogos.gen'));
const logoIndex = lazyModule<LogoIndex>(() =>
  import('./logos/index.gen.json').then((m) => m.default as unknown as LogoIndex),
);

/** The shard of a slug: the last one that starts at or before it, by code
 *  unit, the order tools/gen-look-logos.mjs sorts in. */
export function logoShard(slug: string): number {
  let n = 0;
  while (n + 1 < LOGO_SHARD_STARTS.length && LOGO_SHARD_STARTS[n + 1]! <= slug) n++;
  return n;
}

const shardFiles = import.meta.glob<{ default: LogoPaths }>('./logos/shard-*.gen.json');
const shards = new Map<number, ReturnType<typeof lazyModule<LogoPaths>>>();
const shardNumber = (id: string) => logoShard(id.slice('logo:'.length));
function shardBox(n: number) {
  let box = shards.get(n);
  if (!box) {
    const file = shardFiles[`./logos/shard-${String(n).padStart(2, '0')}.gen.json`];
    box = lazyModule<LogoPaths>(() => (file ? file().then((m) => m.default) : Promise.resolve({})));
    shards.set(n, box);
  }
  return box;
}

function useLazyModule<T>(box: ReturnType<typeof lazyModule<T>>, wanted: boolean): T | null {
  const [mod, setMod] = useState<T | null>(box.loaded);
  useEffect(() => {
    if (mod || !wanted) return;
    let live = true;
    box.load().then(
      (m) => {
        if (live) setMod(m);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [box, mod, wanted]);
  return mod;
}

/** The icon catalog once it is here, else null. `wanted` false never loads
 *  it: a folder without an icon costs nothing. */
export function useLookIcons(wanted = true): LookIconsModule | null {
  return useLazyModule(icons, wanted);
}

/** The logo catalog, the same way. */
export function useLookLogos(wanted = true): LookLogosModule | null {
  return useLazyModule(logos, wanted);
}

/** A logo's id; every other id is a look icon. */
export function isLogoId(id: string | null | undefined): boolean {
  return !!id && id.startsWith('logo:');
}

/** The names of the logos outside the curated set, once here, else null. */
export function useLogoIndex(wanted = true): LogoIndex | null {
  return useLazyModule(logoIndex, wanted);
}

/**
 * The paths of these logos: from the curated chunk, else from the shard each
 * one lives in, which loads here. The returned lookup gives undefined while a
 * part loads, and for an id no part knows.
 */
export function useLogoPaths(ids: readonly (string | null | undefined)[]): (id: string) => readonly string[] | undefined {
  const wanted = ids.filter((id): id is string => isLogoId(id));
  const curated = useLookLogos(wanted.length > 0);
  const [, setLoaded] = useState(0);
  const pending = curated
    ? [...new Set(wanted.filter((id) => !curated.LOOK_LOGO_PATHS[id]).map(shardNumber))].filter((n) => !shardBox(n).loaded)
    : [];
  const pendingKey = pending.join(',');
  useEffect(() => {
    if (!pendingKey) return;
    let live = true;
    Promise.all(pendingKey.split(',').map((n) => shardBox(Number(n)).load())).then(
      () => live && setLoaded((n) => n + 1),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [pendingKey]);
  return (id) => curated?.LOOK_LOGO_PATHS[id] ?? (isLogoId(id) ? shardBox(shardNumber(id)).loaded?.[id] : undefined);
}

/** The paths of a picked icon or logo, from the catalog it lives in, or
 *  undefined while that catalog loads or for an id this build does not know. */
export function useLookPaths(id: string | null | undefined): readonly string[] | undefined {
  const logo = isLogoId(id);
  const iconCatalog = useLookIcons(!!id && !logo);
  const logoPaths = useLogoPaths(logo ? [id] : []);
  if (!id) return undefined;
  return logo ? logoPaths(id) : iconCatalog?.LOOK_ICONS[id];
}

/** The paths of these icons and logos, for a reader outside React (the
 *  HTML and PDF export). An id no part knows is left out. */
export async function loadLookPaths(ids: readonly string[]): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  const logoIds = ids.filter(isLogoId);
  const iconIds = ids.filter((id) => !isLogoId(id));
  const [iconMod, curated] = await Promise.all([
    iconIds.length ? icons.load() : null,
    logoIds.length ? logos.load() : null,
  ]);
  for (const id of iconIds) {
    const paths = iconMod?.LOOK_ICONS[id];
    if (paths) out.set(id, paths);
  }
  const rest = logoIds.filter((id) => !curated?.LOOK_LOGO_PATHS[id]);
  const shardData = await Promise.all([...new Set(rest.map(shardNumber))].map((n) => shardBox(n).load()));
  for (const id of logoIds) {
    const paths = curated?.LOOK_LOGO_PATHS[id] ?? shardData.find((s) => s[id])?.[id];
    if (paths) out.set(id, paths);
  }
  return out;
}
