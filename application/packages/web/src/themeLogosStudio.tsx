import { useId, type ComponentType } from 'react';
import type { StudioThemeLogoId } from './themeLogoResolver';
import type { ThemeLogoProps } from './themeLogos';

/**
 * E-Ink (`eink00000000`, sidebar `#DDDDD7`):
 * Calm, distraction-free monochrome e-reader tablet with paper-gray display
 * and crisp ink reading lines.
 */
function EInkMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      {/* Matte charcoal e-reader housing */}
      <rect x="13" y="6" width="74" height="88" rx="9" fill="#2B2B28" stroke="#181816" strokeWidth="2.2" />
      {/* Matte off-white e-paper screen */}
      <rect x="21" y="14" width="58" height="66" rx="3" fill="#F3F3EF" />
      {/* Crisp e-ink typography bars + subtle page corner fold */}
      <rect x="29" y="24" width="30" height="4.8" rx="1.2" fill="#1C1C1A" />
      <rect x="29" y="34" width="42" height="3.6" rx="1" fill="#4A4A46" />
      <rect x="29" y="43" width="38" height="3.6" rx="1" fill="#4A4A46" />
      <rect x="29" y="52" width="42" height="3.6" rx="1" fill="#4A4A46" />
      <rect x="29" y="61" width="26" height="3.6" rx="1" fill="#6E6E68" />
      <polygon points="67,80 79,68 79,80" fill="#CFCFC8" />
      {/* Subtle chin bar */}
      <rect x="42" y="85.5" width="16" height="3" rx="1.5" fill="#7A7A74" />
    </svg>
  );
}

/**
 * Mono (`mono00000000`, sidebar `#111111`):
 * Swiss geometric pure black-and-white contrast disc with opposing dots.
 */
function MonoMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const clip = `pn-mn-c-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><circle cx="50" cy="50" r="42" /></clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="100" height="100" fill="#141414" />
        {/* Diagonal crisp split */}
        <polygon points="0,0 100,0 0,100" fill="#FFFFFF" />
        <circle cx="34" cy="34" r="8.5" fill="#141414" />
        <circle cx="66" cy="66" r="8.5" fill="#FFFFFF" />
      </g>
      <circle cx="50" cy="50" r="42" fill="none" stroke="#FFFFFF" strokeWidth="3.8" />
    </svg>
  );
}

/**
 * Simple Dark (`simpledark00`, sidebar `#15141A`):
 * Understated warm-ivory folded note sheet inside a quiet matte charcoal seal.
 */
function SimpleDarkMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <circle cx="50" cy="50" r="43" fill="#23222B" stroke="#5A5866" strokeWidth="2.4" />
      {/* Minimalist folded warm-ivory sheet */}
      <path
        d="M31 23 H57 L71 37 V75 C71 77.5 69 79.5 66.5 79.5 H31 C28.5 79.5 26.5 77.5 26.5 75 V27.5 C26.5 25 28.5 23 31 23 Z"
        fill="#DFDEC8"
      />
      <polygon points="57,23 57,37 71,37" fill="#ABA893" />
      <rect x="35" y="45" width="27" height="4.2" rx="2" fill="#23222B" />
      <rect x="35" y="55" width="21" height="4.2" rx="2" fill="#464552" />
      <rect x="35" y="65" width="15" height="4.2" rx="2" fill="#464552" />
    </svg>
  );
}

/**
 * High Contrast Light (`highcontrst1`, sidebar `#FFFFFF`):
 * AAA-contrast geometric folded-page padlock mark in pure black, pure white,
 * and bold cobalt `#0000CC` for razor-sharp accessibility legibility.
 */
function HighContrastLightMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      {/* Crisp white folded-corner page framed in heavy pure black */}
      <path
        d="M17 9 H61 L87 35 V83 C87 87.5 83.5 91 79 91 H17 C12.5 91 9 87.5 9 83 V17 C9 12.5 12.5 9 17 9 Z"
        fill="#FFFFFF"
        stroke="#000000"
        strokeWidth="6.5"
        strokeLinejoin="round"
      />
      {/* High-contrast cobalt folded corner dog-ear */}
      <path d="M60 9 V36 H87 Z" fill="#0000CC" stroke="#000000" strokeWidth="5" strokeLinejoin="round" />
      {/* Ultra-crisp pure-black padlock shackle & body */}
      <path
        d="M36 51 V42 C36 34.5 41.5 29 48 29 C54.5 29 60 34.5 60 42 V51"
        fill="none"
        stroke="#000000"
        strokeWidth="7.2"
        strokeLinecap="round"
      />
      <rect x="27" y="49" width="42" height="30" rx="5.5" fill="#000000" />
      {/* High-contrast white keyhole with cobalt core */}
      <circle cx="48" cy="61.5" r="5.5" fill="#FFFFFF" />
      <rect x="45.2" y="64" width="5.6" height="8.5" rx="2" fill="#FFFFFF" />
      <circle cx="48" cy="61.5" r="2.2" fill="#0000CC" />
    </svg>
  );
}

/**
 * High Contrast Dark (`highcontrst0`, sidebar `#000000`):
 * Mirror AAA-contrast folded-page padlock mark on pure OLED black with blazing
 * `#FFFF00` yellow outline/fold and razor-sharp pure white padlock silhouette.
 */
function HighContrastDarkMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      {/* Pure-black folded-corner page framed in blazing high-contrast yellow */}
      <path
        d="M17 9 H61 L87 35 V83 C87 87.5 83.5 91 79 91 H17 C12.5 91 9 87.5 9 83 V17 C9 12.5 12.5 9 17 9 Z"
        fill="#000000"
        stroke="#FFFF00"
        strokeWidth="6.5"
        strokeLinejoin="round"
      />
      {/* Blazing yellow folded corner dog-ear */}
      <path d="M60 9 V36 H87 Z" fill="#FFFF00" stroke="#FFFF00" strokeWidth="4" strokeLinejoin="round" />
      {/* Razor-sharp pure-white padlock shackle & body */}
      <path
        d="M36 51 V42 C36 34.5 41.5 29 48 29 C54.5 29 60 34.5 60 42 V51"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="7.2"
        strokeLinecap="round"
      />
      <rect x="27" y="49" width="42" height="30" rx="5.5" fill="#FFFFFF" />
      {/* Pure-black keyhole accented with bright electric yellow center */}
      <circle cx="48" cy="61.5" r="5.6" fill="#000000" />
      <rect x="45.2" y="64" width="5.6" height="8.5" rx="2" fill="#000000" />
      <circle cx="48" cy="61.5" r="2.3" fill="#FFFF00" />
    </svg>
  );
}

/**
 * Midnight (`midnightink0` - Team, sidebar `#000000`):
 * Sculpted warm-amber gold fountain-pen nib cradled by a glowing midnight
 * crescent moon.
 */
function MidnightMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const gold = `pn-mi-g-${uid}`;
  const glow = `pn-mi-a-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={glow} cx="50%" cy="50%" r="48%">
          <stop offset="0%" stopColor="#E0A458" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={gold} x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#FFF0B8" />
          <stop offset="50%" stopColor="#E0A458" />
          <stop offset="100%" stopColor="#8F5C1E" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`url(#${glow})`} />
      {/* Subtle midnight crescent moon cradling the nib */}
      <path
        d="M36 16 A36 36 0 1 0 84 64 A28 28 0 1 1 36 16 Z"
        fill={`url(#${gold})`}
        opacity="0.72"
      />
      {/* Sculpted fountain pen nib angled gracefully */}
      <g transform="rotate(34 54 48)">
        <path
          d="M54 10 L71 48 L63 72 H45 L37 48 Z"
          fill={`url(#${gold})`}
          stroke="#4A2E0B"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <line x1="54" y1="12" x2="54" y2="44" stroke="#1A120A" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="54" cy="46" r="4.8" fill="#1A120A" />
        <rect x="42" y="71" width="24" height="9" rx="2.5" fill="#2A2622" stroke="#E0A458" strokeWidth="1.8" />
      </g>
    </svg>
  );
}

/**
 * Rose (`rosewater000` - Team, sidebar `#F2E4E4`):
 * Sculpted layered raspberry-rose blossom with blush petal edges and twin
 * muted-sage leaves.
 */
function RoseMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const outer = `pn-rs-o-${uid}`;
  const inner = `pn-rs-i-${uid}`;
  const leaf = `pn-rs-l-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={outer} cx="38%" cy="32%" r="68%">
          <stop offset="0%" stopColor="#E3668B" />
          <stop offset="58%" stopColor="#A33A5A" />
          <stop offset="100%" stopColor="#691D36" />
        </radialGradient>
        <radialGradient id={inner} cx="42%" cy="38%" r="62%">
          <stop offset="0%" stopColor="#FAD2DF" />
          <stop offset="55%" stopColor="#C94B72" />
          <stop offset="100%" stopColor="#7D2340" />
        </radialGradient>
        <linearGradient id={leaf} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#66947A" />
          <stop offset="100%" stopColor="#355945" />
        </linearGradient>
      </defs>
      {/* Soft sage rose leaves */}
      <path d="M36 72 C20 71 10 79 11 90 C24 90 36 84 42 75 Z" fill={`url(#${leaf})`} stroke="#243D2F" strokeWidth="1.6" />
      <path d="M64 72 C80 71 90 79 89 90 C76 90 64 84 58 75 Z" fill={`url(#${leaf})`} stroke="#243D2F" strokeWidth="1.6" />
      {/* Outer scalloped rose petals */}
      <circle cx="50" cy="31" r="21" fill={`url(#${outer})`} stroke="#5C1930" strokeWidth="1.8" />
      <circle cx="31" cy="49" r="21" fill={`url(#${outer})`} stroke="#5C1930" strokeWidth="1.8" />
      <circle cx="69" cy="49" r="21" fill={`url(#${outer})`} stroke="#5C1930" strokeWidth="1.8" />
      <circle cx="40" cy="65" r="20" fill={`url(#${outer})`} stroke="#5C1930" strokeWidth="1.8" />
      <circle cx="60" cy="65" r="20" fill={`url(#${outer})`} stroke="#5C1930" strokeWidth="1.8" />
      {/* Curled inner rose rosette */}
      <circle cx="50" cy="49" r="22" fill={`url(#${inner})`} stroke="#F9CEDC" strokeWidth="2.2" />
      <path
        d="M42 47 C42 40 52 37 58 43 C63 48 60 58 51 60 C41 62 34 54 36 44 C38 35 48 30 57 33"
        fill="none"
        stroke="#FFE8F0"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Frost (`frost0000000` - Team, sidebar `#2E3440`):
 * Precision 6-pointed polar snowflake crystal in luminous Nord frost cyan.
 */
function FrostMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const glow = `pn-fr-g-${uid}`;
  const angles = [0, 60, 120, 180, 240, 300];

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={glow} cx="50%" cy="50%" r="48%">
          <stop offset="0%" stopColor="#88C0D0" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#2E3440" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`url(#${glow})`} />
      {/* 6 symmetrical crystal arms */}
      {angles.map((deg) => (
        <g key={deg} transform={`rotate(${deg} 50 50)`}>
          <line x1="50" y1="50" x2="50" y2="10" stroke="#88C0D0" strokeWidth="5.4" strokeLinecap="round" />
          <line x1="50" y1="50" x2="50" y2="10" stroke="#E8F7FC" strokeWidth="2" strokeLinecap="round" />
          <path d="M39 24 L50 32 L61 24" fill="none" stroke="#88C0D0" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M39 24 L50 32 L61 24" fill="none" stroke="#E8F7FC" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ))}
      {/* Central crystalline hexagon core */}
      <polygon points="50,36 62,43 62,57 50,64 38,57 38,43" fill="#436A7D" stroke="#D8F3FA" strokeWidth="2.8" strokeLinejoin="round" />
      <circle cx="50" cy="50" r="5" fill="#F0FBFF" />
    </svg>
  );
}

/**
 * Mint (`papermint000` - Team, sidebar `#EEF3EF`):
 * Fresh botanical twin mint leaves with crisp pale veins sweeping cleanly off
 * off-white mint paper.
 */
function MintMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const darkLeaf = `pn-mn2-d-${uid}`;
  const brightLeaf = `pn-mn2-b-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={darkLeaf} x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#3B9B70" />
          <stop offset="100%" stopColor="#1D593F" />
        </linearGradient>
        <linearGradient id={brightLeaf} x1="10%" y1="10%" x2="90%" y2="90%">
          <stop offset="0%" stopColor="#5EC495" />
          <stop offset="100%" stopColor="#286E50" />
        </linearGradient>
      </defs>
      {/* Curved stem */}
      <path d="M48 92 C48 80 49 71 50 64" fill="none" stroke="#1C4F38" strokeWidth="4.8" strokeLinecap="round" />
      {/* Larger arching right mint leaf */}
      <path
        d="M49 69 C48 39 64 18 89 13 C86 43 72 64 49 69 Z"
        fill={`url(#${brightLeaf})`}
        stroke="#164530"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="M51 66 C61 48 72 33 83 20" fill="none" stroke="#E0F7EC" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M63 48 L75 46 M68 38 L78 36" fill="none" stroke="#E0F7EC" strokeWidth="1.8" strokeLinecap="round" opacity="0.78" />
      {/* Secondary left mint leaf */}
      <path
        d="M49 73 C24 68 12 50 11 26 C34 29 49 46 49 73 Z"
        fill={`url(#${darkLeaf})`}
        stroke="#164530"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="M47 69 C36 55 26 44 17 32" fill="none" stroke="#D4F2E4" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Espresso (`espresso0000` - Team, sidebar `#211A16`):
 * Glossy dark-roast espresso coffee bean rimmed in warm caramel crema.
 */
function EspressoMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const bean = `pn-es-b-${uid}`;
  const crema = `pn-es-c-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={bean} cx="35%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#9C6038" />
          <stop offset="50%" stopColor="#5C341C" />
          <stop offset="100%" stopColor="#2B160B" />
        </radialGradient>
        <linearGradient id={crema} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFE0B5" />
          <stop offset="55%" stopColor="#D99A5B" />
          <stop offset="100%" stopColor="#8F5A2B" />
        </linearGradient>
      </defs>
      {/* Sculpted angled dark-roast espresso bean */}
      <g transform="rotate(-28 50 50)">
        <ellipse cx="50" cy="50" rx="29" ry="40" fill={`url(#${bean})`} stroke={`url(#${crema})`} strokeWidth="3.2" />
        {/* Glossy specular roast highlight */}
        <path d="M33 29 C30 41 31 55 36 67" fill="none" stroke="#E8B986" strokeWidth="3.2" strokeLinecap="round" opacity="0.55" />
        {/* Signature S-curved espresso bean cleft */}
        <path
          d="M50 12 C43 27 57 40 50 53 C44 65 54 76 50 88"
          fill="none"
          stroke="#1C0E07"
          strokeWidth="6.2"
          strokeLinecap="round"
        />
        <path
          d="M50 12 C43 27 57 40 50 53 C44 65 54 76 50 88"
          fill="none"
          stroke={`url(#${crema})`}
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

/**
 * Lavender (`lavender0000` - Team, sidebar `#EFEBF7`):
 * Graceful diagonal botanical lavender sprig with layered deep-violet and
 * lilac blossom buds.
 */
function LavenderMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const bud = `pn-lv-b-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={bud} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A78BFA" />
          <stop offset="52%" stopColor="#6B46C1" />
          <stop offset="100%" stopColor="#43248A" />
        </linearGradient>
      </defs>
      {/* Slender sage-violet stem & twin narrow leaves */}
      <path d="M22 88 C36 74 52 54 78 18" fill="none" stroke="#4D705B" strokeWidth="4.2" strokeLinecap="round" />
      <path d="M34 75 C20 67 16 55 21 47 C29 53 34 64 34 75 Z" fill="#59826A" stroke="#304A3B" strokeWidth="1.5" />
      <path d="M36 73 C48 79 60 79 66 72 C57 67 46 68 36 73 Z" fill="#59826A" stroke="#304A3B" strokeWidth="1.5" />
      {/* Paired sculpted violet lavender blossom clusters climbing the stem */}
      <g fill={`url(#${bud})`} stroke="#381E75" strokeWidth="1.6">
        <ellipse cx="78" cy="18" rx="6.5" ry="9.5" transform="rotate(36 78 18)" />
        <ellipse cx="63" cy="24" rx="6.5" ry="9.5" transform="rotate(8 63 24)" />
        <ellipse cx="75" cy="34" rx="6.5" ry="9.5" transform="rotate(64 75 34)" />
        <ellipse cx="52" cy="37" rx="7" ry="10" transform="rotate(8 52 37)" />
        <ellipse cx="65" cy="47" rx="7" ry="10" transform="rotate(64 65 47)" />
        <ellipse cx="42" cy="50" rx="7" ry="10" transform="rotate(8 42 50)" />
        <ellipse cx="54" cy="60" rx="7" ry="10" transform="rotate(64 54 60)" />
      </g>
      {/* Pale lilac catchlights */}
      <circle cx="77" cy="16" r="2" fill="#E9DDFF" />
      <circle cx="62" cy="22" r="2" fill="#E9DDFF" />
      <circle cx="51" cy="35" r="2" fill="#E9DDFF" />
      <circle cx="41" cy="48" r="2" fill="#E9DDFF" />
    </svg>
  );
}

/**
 * Plum (`plum00000000` - Team, sidebar `#211A29`):
 * Glossy ripe violet-plum fruit with velvety blush-pink highlight bloom, cleft,
 * twig stem, and fresh leaf.
 */
function PlumMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const fruit = `pn-pl-f-${uid}`;
  const leaf = `pn-pl-l-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={fruit} cx="34%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#F5A6CE" />
          <stop offset="36%" stopColor="#B84B8C" />
          <stop offset="76%" stopColor="#6E225B" />
          <stop offset="100%" stopColor="#3B1034" />
        </radialGradient>
        <linearGradient id={leaf} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#9ED4A8" />
          <stop offset="100%" stopColor="#467A56" />
        </linearGradient>
      </defs>
      {/* Twig stem + fresh green plum leaf */}
      <path d="M51 28 C51 18 54 11 60 8" fill="none" stroke="#B58E72" strokeWidth="4" strokeLinecap="round" />
      <path d="M53 22 C65 11 79 11 86 19 C77 27 65 29 53 22 Z" fill={`url(#${leaf})`} stroke="#2B4D36" strokeWidth="1.6" strokeLinejoin="round" />
      {/* Plump ripe plum silhouette */}
      <path
        d="M50 26 C72 24 85 40 83 60 C81 79 66 93 50 93 C34 93 19 79 17 60 C15 40 28 24 50 26 Z"
        fill={`url(#${fruit})`}
        stroke="#E58FB8"
        strokeWidth="2.2"
      />
      {/* Signature plum cleft crease */}
      <path d="M51 28 C58 45 58 68 50 91" fill="none" stroke="#360D2E" strokeWidth="2.6" strokeLinecap="round" opacity="0.62" />
      {/* Velvety blush bloom catchlight */}
      <ellipse cx="34" cy="46" rx="7.5" ry="13" transform="rotate(-16 34 46)" fill="#FFD9EC" opacity="0.48" />
    </svg>
  );
}

/**
 * Apricot (`apricot00000` - Team, sidebar `#FBEBDD`):
 * Sun-warmed velvet-orange ripe apricot with signature cleft blush, short stem,
 * and deep olive leaf popping warmly off peach paper.
 */
function ApricotMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const fruit = `pn-ap-f-${uid}`;
  const leaf = `pn-ap-l-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={fruit} cx="35%" cy="32%" r="68%">
          <stop offset="0%" stopColor="#FFD28A" />
          <stop offset="44%" stopColor="#F27D30" />
          <stop offset="82%" stopColor="#B84316" />
          <stop offset="100%" stopColor="#80290A" />
        </radialGradient>
        <linearGradient id={leaf} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#5C994C" />
          <stop offset="100%" stopColor="#2B5924" />
        </linearGradient>
      </defs>
      {/* Short woody stem + crisp olive leaf */}
      <path d="M50 28 C50 18 47 11 42 8" fill="none" stroke="#5E381E" strokeWidth="4.2" strokeLinecap="round" />
      <path d="M50 23 C63 11 78 11 86 20 C76 29 62 30 50 23 Z" fill={`url(#${leaf})`} stroke="#1D3D18" strokeWidth="1.8" strokeLinejoin="round" />
      {/* Plump sun-ripened apricot silhouette */}
      <path
        d="M50 27 C72 24 85 40 83 60 C81 79 66 92 50 92 C34 92 19 79 17 60 C15 40 28 24 50 27 Z"
        fill={`url(#${fruit})`}
        stroke="#78280B"
        strokeWidth="2.4"
      />
      {/* Warm burnt-orange cleft crease & velvety highlight */}
      <path d="M50 29 C42 46 42 68 50 90" fill="none" stroke="#8C2E0C" strokeWidth="2.6" strokeLinecap="round" opacity="0.58" />
      <ellipse cx="64" cy="48" rx="7" ry="12.5" transform="rotate(16 64 48)" fill="#FFE7B8" opacity="0.52" />
    </svg>
  );
}

export const STUDIO_THEME_LOGOS: Record<StudioThemeLogoId, ComponentType<ThemeLogoProps>> = {
  eink00000000: EInkMark,
  mono00000000: MonoMark,
  simpledark00: SimpleDarkMark,
  highcontrst1: HighContrastLightMark,
  highcontrst0: HighContrastDarkMark,
  midnightink0: MidnightMark,
  rosewater000: RoseMark,
  frost0000000: FrostMark,
  papermint000: MintMark,
  espresso0000: EspressoMark,
  lavender0000: LavenderMark,
  plum00000000: PlumMark,
  apricot00000: ApricotMark,
};
