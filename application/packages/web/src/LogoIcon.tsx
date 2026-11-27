import { useEffect, useState, type ComponentType } from 'react';
import { useActiveCustomThemeIdentity, useThemeLogoIcon } from './theme';
import { NoteBoyMark } from './noteBoyMark';
import type { ThemeLogoProps } from './themeLogos';

export { NoteBoyMark };

type ThemeLogoComponent = ComponentType<ThemeLogoProps>;
type ThemeLogoResolverMod = typeof import('./themeLogoResolver');
let cachedResolver: ThemeLogoResolverMod | null = null;
let pendingResolver: Promise<ThemeLogoResolverMod> | null = null;

function loadResolver(): Promise<ThemeLogoResolverMod> {
  if (cachedResolver) return Promise.resolve(cachedResolver);
  if (!pendingResolver) {
    pendingResolver = import('./themeLogoResolver')
      .then((mod) => {
        cachedResolver = mod;
        return mod;
      })
      .catch((err) => {
        pendingResolver = null;
        throw err;
      });
  }
  return pendingResolver;
}

function getSyncLogo(identity: string): ThemeLogoComponent | null {
  if (!cachedResolver) return null;
  const id = cachedResolver.resolveThemeLogoFromIdentity(identity);
  return id ? cachedResolver.getCachedThemeLogo(id) : null;
}

/** Lazy-loaded bespoke mark for non-Note-Boy shipped themes (router + per-category chunk). */
function LazyThemeLogo({ identity, fallback }: { identity: string; fallback: React.ReactNode }) {
  const [Mark, setMark] = useState<ThemeLogoComponent | null>(() => getSyncLogo(identity));

  useEffect(() => {
    const sync = getSyncLogo(identity);
    if (sync) {
      setMark(() => sync);
      return;
    }
    setMark(null);
    let alive = true;
    void loadResolver()
      .then((resolver) => {
        const id = resolver.resolveThemeLogoFromIdentity(identity);
        return id ? resolver.loadThemeLogo(id) : null;
      })
      .then(
        (loaded) => {
          if (alive) setMark(() => loaded);
        },
        () => {
          /* Offline or failed chunk fetch falls back cleanly to the tinted brand mark. */
        },
      );
    return () => {
      alive = false;
    };
  }, [identity]);

  if (!Mark) return <>{fallback}</>;
  return <Mark className="pn-logo-bespoke w-full h-full" />;
}

function TintedLogo({ size, className }: { size: number; className: string }) {
  const customLogo = useThemeLogoIcon();
  const themeIdentity = useActiveCustomThemeIdentity();

  // A user-uploaded custom icon for the active theme always takes precedence.
  if (customLogo) {
    return (
      <span className={`pn-logo relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
        <img
          src={customLogo}
          alt=""
          width={size}
          height={size}
          aria-hidden="true"
          className="w-full h-full object-contain rounded-[22%]"
          style={{ filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.24))' }}
          draggable={false}
        />
      </span>
    );
  }

  if (themeIdentity && (themeIdentity.startsWith('noteboy00000\0') || themeIdentity.endsWith('\0Note Boy'))) {
    return (
      <span className={`pn-logo relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
        <NoteBoyMark className="pn-logo-bespoke w-full h-full" />
      </span>
    );
  }

  const defaultMark = (
    <>
      <img
        src="/privacy-notes.webp"
        alt=""
        width={size}
        height={size}
        aria-hidden="true"
        draggable={false}
      />
      <span className="pn-logo-tint" aria-hidden="true" />
    </>
  );

  return (
    <span className={`pn-logo relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
      {themeIdentity ? <LazyThemeLogo identity={themeIdentity} fallback={defaultMark} /> : defaultMark}
    </span>
  );
}

/**
 * Brand logo icon. Renders the WebP logo at the requested size.
 *
 * `tint` lays the theme accent over the mark in every palette but Default
 * (`--pn-logo-tint` in index.css): a layer cut
 * to the logo's own shape, blended in `color` mode, so the mark keeps its
 * light and dark parts and takes the accent's hue. Hovering the nearest
 * `.pn-logo-host` shows the real colors. When the active theme has a custom
 * uploaded icon it takes precedence; otherwise selected community themes swap
 * in their bespoke mark (lazy-loaded from `themeLogos.tsx` so other themes pay
 * zero boot cost). Spec: docs/contrib/color-themes.md (section 6)
 */
export function LogoIcon({ size = 24, className = '', tint = false }: { size?: number; className?: string; tint?: boolean }) {
  if (tint) return <TintedLogo size={size} className={className} />;
  return (
    <img
      src="/privacy-notes.webp"
      alt=""
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
      draggable={false}
    />
  );
}
