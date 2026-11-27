import { useId } from 'react';
import type { ThemeLogoProps } from './themeLogos';

/**
 * Shared DMG-01 handheld mark used by the NOTE BOY desktop app icon preset
 * (`AppIconPicker.tsx`), the sidebar brand mark when the Note Boy theme is
 * active (`LogoIcon.tsx`), and the Note Boy card on `/themes` (`themes-page.ts`).
 *
 * Kept pure (React-only, no DOM or storage imports) so static page builds can
 * render it in Node via `renderToStaticMarkup`.
 */
export function NoteBoyMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const clip = `pn-nb-c-${uid}`;
  const body = `pn-nb-b-${uid}`;
  const bezel = `pn-nb-z-${uid}`;
  const lcd = `pn-nb-l-${uid}`;
  const btn = `pn-nb-p-${uid}`;
  const dpad = `pn-nb-d-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath>
        <linearGradient id={body} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#F2F0E9" />
          <stop offset="55%" stopColor="#DDD9D0" />
          <stop offset="100%" stopColor="#B9B4A8" />
        </linearGradient>
        <linearGradient id={bezel} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7D8088" />
          <stop offset="100%" stopColor="#585B63" />
        </linearGradient>
        <linearGradient id={lcd} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#89A22E" />
          <stop offset="55%" stopColor="#9CB43E" />
          <stop offset="100%" stopColor="#849C2B" />
        </linearGradient>
        <radialGradient id={btn} cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#DC337D" />
          <stop offset="55%" stopColor="#A81B5A" />
          <stop offset="100%" stopColor="#6E0F3A" />
        </radialGradient>
        <linearGradient id={dpad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3C3F47" />
          <stop offset="50%" stopColor="#222429" />
          <stop offset="100%" stopColor="#111215" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="100" height="100" fill={`url(#${body})`} />
        <path d="M93 0 H100 V100 H0 V93 H87 Q93 93 93 87 Z" fill="#9E998D" fillOpacity="0.65" />
        <path d="M0 0 H100 V5 H8 Q5 5 5 8 V100 H0 Z" fill="#FFFFFF" fillOpacity="0.62" />
        <rect x="11" y="10" width="76" height="46" rx="6" fill={`url(#${bezel})`} />
        <rect x="11" y="10" width="76" height="46" rx="6" fill="none" stroke="#45474F" strokeWidth="1.5" />
        <line x1="16" y1="14" x2="82" y2="14" stroke="#A61D5C" strokeWidth="2" />
        <line x1="16" y1="16.8" x2="82" y2="16.8" stroke="#2B3472" strokeWidth="1.8" />
        <circle cx="17" cy="33" r="3" fill="#EF4444" fillOpacity="0.35" />
        <circle cx="17" cy="33" r="2.1" fill="#F43F5E" />
        <rect x="23" y="19.5" width="54" height="31.5" rx="2.5" fill={`url(#${lcd})`} />
        <path d="M23 22 H77 M24.5 19.5 V51" stroke="#5D7319" strokeWidth="2.6" fill="none" />
        <polygon points="23,19.5 48,19.5 32,51 23,51" fill="#FFFFFF" fillOpacity="0.09" />
        <rect x="30" y="27" width="25" height="3.4" rx="1" fill="#253D11" />
        <rect x="30" y="33.8" width="36" height="3.4" rx="1" fill="#35531A" />
        <rect x="30" y="40.6" width="29" height="3.4" rx="1" fill="#35531A" />
        <g transform="translate(1.8 2.2)" opacity="0.32">
          <rect x="20" y="61.5" width="9" height="24.5" rx="2.2" fill="#000000" />
          <rect x="12" y="69.5" width="25" height="9" rx="2.2" fill="#000000" />
        </g>
        <rect x="20" y="61.5" width="9" height="24.5" rx="2.2" fill={`url(#${dpad})`} />
        <rect x="12" y="69.5" width="25" height="9" rx="2.2" fill={`url(#${dpad})`} />
        <circle cx="24.5" cy="74" r="2.7" fill="#18191D" />
        <circle cx="62" cy="80.8" r="7.8" fill="#000000" fillOpacity="0.28" />
        <circle cx="79" cy="71.8" r="7.8" fill="#000000" fillOpacity="0.28" />
        <circle cx="60.5" cy="79" r="7.8" fill={`url(#${btn})`} />
        <circle cx="77.5" cy="70" r="7.8" fill={`url(#${btn})`} />
        <ellipse cx="58.2" cy="76.2" rx="2.4" ry="1.4" transform="rotate(-30 58.2 76.2)" fill="#FFFFFF" fillOpacity="0.35" />
        <ellipse cx="75.2" cy="67.2" rx="2.4" ry="1.4" transform="rotate(-30 75.2 67.2)" fill="#FFFFFF" fillOpacity="0.35" />
        <rect x="1" y="1" width="98" height="98" rx="21" fill="none" stroke="#858075" strokeOpacity="0.65" strokeWidth="2" />
      </g>
    </svg>
  );
}
