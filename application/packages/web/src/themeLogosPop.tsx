import { useId, type ComponentType } from 'react';
import type { PopThemeLogoId } from './themeLogoResolver';
import type { ThemeLogoProps } from './themeLogos';

/**
 * Hoth (`hoth00000000`, sidebar `#E0E9F0`):
 * Iconic armored AT-AT walker in crisp side profile striding across an icy
 * snowdrift ridge, sculpted in slate steel so it pops off the frosty sidebar.
 */
function HothMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const hull = `pn-ht-h-${uid}`;
  const snow = `pn-ht-s-${uid}`;
  const sky = `pn-ht-k-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={sky} cx="50%" cy="42%" r="50%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.92" />
          <stop offset="70%" stopColor="#BFD6E8" stopOpacity="0.52" />
          <stop offset="100%" stopColor="#7D9CBA" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={hull} x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#7C91A3" />
          <stop offset="48%" stopColor="#4B5B67" />
          <stop offset="100%" stopColor="#2A353E" />
        </linearGradient>
        <linearGradient id={snow} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#9EBAD4" />
        </linearGradient>
      </defs>
      {/* Crisp icy arctic glow */}
      <circle cx="50" cy="46" r="44" fill={`url(#${sky})`} />
      {/* Back legs (darker depth plane) */}
      <path d="M35 51 L31 66 L26 80 L33 80 L38 66 L41 51 Z" fill="#2D3943" />
      <path d="M56 51 L60 66 L66 80 L73 80 L67 65 L62 51 Z" fill="#2D3943" />
      {/* Armored main AT-AT body + side panel hatch */}
      <path
        d="M20 26 L56 24 L65 33 L62 53 L23 53 L16 42 Z"
        fill={`url(#${hull})`}
        stroke="#222B33"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M23 28 L55 26.5 L61 33 L21 34 Z" fill="#B8CBE0" opacity="0.45" />
      <rect x="30" y="36" width="21" height="10" rx="1.5" fill="#2E3A44" stroke="#8CA3B8" strokeWidth="1.2" />
      {/* Articulated neck & iconic angled command head */}
      <rect x="61" y="34" width="9" height="9" rx="1.5" fill="#35424D" />
      <path
        d="M68 29 L84 31 L88 41 L82 47 L68 45 Z"
        fill={`url(#${hull})`}
        stroke="#222B33"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Glowing crimson cockpit viewport slit & chin laser cannons */}
      <rect x="77" y="34.5" width="7.5" height="3" rx="1" fill="#EF4444" />
      <line x1="84" y1="43.5" x2="94" y2="44.5" stroke="#2D3943" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="82" y1="46.5" x2="91" y2="47.5" stroke="#2D3943" strokeWidth="2" strokeLinecap="round" />
      {/* Front armored legs + circular knee joints & wide snow feet */}
      <path
        d="M25 51 L21 67 L17 82 L26 82 L29 67 L33 51 Z"
        fill={`url(#${hull})`}
        stroke="#222B33"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M47 51 L51 67 L55 82 L64 82 L60 67 L55 51 Z"
        fill={`url(#${hull})`}
        stroke="#222B33"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="25" cy="67" r="3.4" fill="#A4B8CC" stroke="#222B33" strokeWidth="1.3" />
      <circle cx="55.5" cy="67" r="3.4" fill="#A4B8CC" stroke="#222B33" strokeWidth="1.3" />
      <path d="M13 82 H30 L28 86 H15 Z" fill="#34424E" />
      <path d="M51 82 H68 L66 86 H53 Z" fill="#34424E" />
      {/* Icy Hoth snowdrift ridge at base */}
      <path
        d="M8 86 Q32 79 54 84 T92 84 Q80 93 50 93 Q20 93 8 86 Z"
        fill={`url(#${snow})`}
        stroke="#6B8BA8"
        strokeWidth="1.8"
      />
    </svg>
  );
}

/**
 * Hyrule (`hyrule000000`, sidebar `#102C1B`):
 * Radiant beveled Triforce in forged gold flanked by subtle emerald-and-gold
 * Hylian royal wings, glowing warmly against deep Hyrule Field green.
 */
function HyruleMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const aura = `pn-hy-a-${uid}`;
  const light = `pn-hy-l-${uid}`;
  const mid = `pn-hy-m-${uid}`;
  const shade = `pn-hy-s-${uid}`;

  const renderTri = (cx: number, topY: number, halfW: number, h: number) => {
    const botY = topY + h;
    const midY = topY + h * 0.62;
    return (
      <g>
        <polygon points={`${cx},${topY} ${cx - halfW},${botY} ${cx},${midY}`} fill={`url(#${light})`} />
        <polygon points={`${cx},${topY} ${cx + halfW},${botY} ${cx},${midY}`} fill={`url(#${mid})`} />
        <polygon points={`${cx - halfW},${botY} ${cx + halfW},${botY} ${cx},${midY}`} fill={`url(#${shade})`} />
        <polygon
          points={`${cx},${topY} ${cx - halfW},${botY} ${cx + halfW},${botY}`}
          fill="none"
          stroke="#FFF3B0"
          strokeWidth="1.3"
          strokeLinejoin="round"
          opacity="0.85"
        />
      </g>
    );
  };

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={aura} cx="50%" cy="54%" r="48%">
          <stop offset="0%" stopColor="#ECC046" stopOpacity="0.46" />
          <stop offset="58%" stopColor="#ECC046" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#102C1B" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={light} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFF7C8" />
          <stop offset="100%" stopColor="#F2CE5E" />
        </linearGradient>
        <linearGradient id={mid} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#E8B938" />
          <stop offset="100%" stopColor="#B88414" />
        </linearGradient>
        <linearGradient id={shade} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#C9961E" />
          <stop offset="100%" stopColor="#855E0B" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="54" r="46" fill={`url(#${aura})`} />
      {/* Subtle royal crest wings behind the golden Triforce */}
      <path
        d="M50 56 L22 46 C14 42 8 36 6 29 C13 33 21 36 30 37 L16 55 C24 57 34 59 44 61 Z"
        fill="#2E7A4A"
        stroke="#ECC046"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.72"
      />
      <path
        d="M50 56 L78 46 C86 42 92 36 94 29 C87 33 79 36 70 37 L84 55 C76 57 66 59 56 61 Z"
        fill="#2E7A4A"
        stroke="#ECC046"
        strokeWidth="1.4"
        strokeLinejoin="round"
        opacity="0.72"
      />
      {/* Beveled three-piece Triforce */}
      {renderTri(50, 12, 20, 35)}
      {renderTri(29, 49, 20, 35)}
      {renderTri(71, 49, 20, 35)}
    </svg>
  );
}

/**
 * Kokiri Forest (`kokiriforest`, sidebar `#0F1F14`):
 * Carved Ocarina of Time Kokiri Deku Shield in warm forest timber with brass
 * rivets, a glowing Kokiri-green forest crest, and fairy-gold rim accents.
 */
function KokiriForestMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const glow = `pn-kf-g-${uid}`;
  const wood = `pn-kf-w-${uid}`;
  const rim = `pn-kf-r-${uid}`;
  const crest = `pn-kf-c-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={glow} cx="50%" cy="50%" r="48%">
          <stop offset="0%" stopColor="#4CC24C" stopOpacity="0.42" />
          <stop offset="68%" stopColor="#E8C860" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#0F1F14" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={wood} x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#9C6432" />
          <stop offset="48%" stopColor="#693E1B" />
          <stop offset="100%" stopColor="#3D220D" />
        </linearGradient>
        <linearGradient id={rim} x1="10%" y1="8%" x2="90%" y2="92%">
          <stop offset="0%" stopColor="#FFF0A8" />
          <stop offset="48%" stopColor="#E8C860" />
          <stop offset="100%" stopColor="#9E761B" />
        </linearGradient>
        <linearGradient id={crest} x1="20%" y1="12%" x2="80%" y2="88%">
          <stop offset="0%" stopColor="#A8FFA8" />
          <stop offset="48%" stopColor="#4CC24C" />
          <stop offset="100%" stopColor="#1E7D28" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`url(#${glow})`} />
      {/* Carved wooden Kokiri Deku Shield silhouette */}
      <path
        d="M50 8 C66 8 79 13 85 21 C86 43 81 63 70 76 C63 84 56 89 50 93 C44 89 37 84 30 76 C19 63 14 43 15 21 C21 13 34 8 50 8 Z"
        fill={`url(#${wood})`}
        stroke={`url(#${rim})`}
        strokeWidth="3.6"
        strokeLinejoin="round"
      />
      {/* Subtle carved wood plank lines */}
      <path d="M35 14 V78 M65 14 V78" stroke="#361C0A" strokeWidth="1.6" opacity="0.52" />
      <path d="M37 15 V77 M67 15 V77" stroke="#B57A45" strokeWidth="1" opacity="0.28" />
      {/* Fairy-gold shield rivets */}
      <circle cx="24" cy="26" r="2.6" fill="#FFF0A8" stroke="#6E4D0A" strokeWidth="1" />
      <circle cx="76" cy="26" r="2.6" fill="#FFF0A8" stroke="#6E4D0A" strokeWidth="1" />
      <circle cx="50" cy="83" r="2.6" fill="#E8C860" stroke="#6E4D0A" strokeWidth="1" />
      {/* Bold glowing Kokiri Emerald sprout-and-swirl emblem carved on the shield face */}
      <path
        d="M50 22 C63 26 70 37 68 50 C66 61 57 69 50 74 C43 69 34 61 32 50 C30 37 37 26 50 22 Z"
        fill={`url(#${crest})`}
        stroke="#13451A"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      {/* Crisp central leaf vein & Kokiri forest spiral flourish */}
      <path d="M50 28 V68" stroke="#E0FFE0" strokeWidth="2.6" strokeLinecap="round" opacity="0.88" />
      <path d="M50 42 L61 36 M50 53 L39 46 M50 59 L60 53" stroke="#D2FFD2" strokeWidth="2.2" strokeLinecap="round" opacity="0.78" />
      {/* Warm fairy-gold glow jewel crowning the shield */}
      <circle cx="50" cy="18" r="4" fill="#FFF4B8" stroke="#8C6410" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * Breath of the Notes (`breathofthen`, sidebar `#F7DEA9`):
 * Glowing blue Silent Princess blossom with pale luminous petal tips and golden
 * stamen heart, anchored by deep forest-teal leaves on warm BotW parchment gold.
 */
function BreathOfTheNotesMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const petal = `pn-bn-p-${uid}`;
  const leaf = `pn-bn-l-${uid}`;
  const core = `pn-bn-c-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={petal} cx="50%" cy="62%" r="65%">
          <stop offset="0%" stopColor="#F2FAFF" />
          <stop offset="48%" stopColor="#6AA4F8" />
          <stop offset="100%" stopColor="#264EA8" />
        </radialGradient>
        <linearGradient id={leaf} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#2E7D6E" />
          <stop offset="100%" stopColor="#16423D" />
        </linearGradient>
        <radialGradient id={core} cx="42%" cy="38%" r="65%">
          <stop offset="0%" stopColor="#FFFBE0" />
          <stop offset="55%" stopColor="#F5B82E" />
          <stop offset="100%" stopColor="#B86B0A" />
        </radialGradient>
      </defs>
      {/* Deep teal-green leaves framing the base for strong contrast on #F7DEA9 */}
      <path d="M50 64 C29 68 13 80 9 93 C26 90 41 83 50 73 Z" fill={`url(#${leaf})`} stroke="#12302C" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M50 64 C71 68 87 80 91 93 C74 90 59 83 50 73 Z" fill={`url(#${leaf})`} stroke="#12302C" strokeWidth="1.7" strokeLinejoin="round" />
      {/* 5 fuller luminous pointed Silent Princess petals */}
      <g stroke="#1C3980" strokeWidth="2.1" strokeLinejoin="round">
        {/* Top center petal */}
        <path d="M50 48 C35 35 35 16 50 4 C65 16 65 35 50 48 Z" fill={`url(#${petal})`} />
        {/* Upper-left petal */}
        <path d="M47 51 C29 50 13 42 5 26 C24 21 39 31 47 51 Z" fill={`url(#${petal})`} />
        {/* Upper-right petal */}
        <path d="M53 51 C71 50 87 42 95 26 C76 21 61 31 53 51 Z" fill={`url(#${petal})`} />
        {/* Lower-left petal */}
        <path d="M47 54 C31 62 19 72 17 87 C35 82 45 70 47 54 Z" fill={`url(#${petal})`} />
        {/* Lower-right petal */}
        <path d="M53 54 C69 62 81 72 83 87 C65 82 55 70 53 54 Z" fill={`url(#${petal})`} />
      </g>
      {/* Luminous pale-cyan petal center veins */}
      <path d="M50 43 V15 M43 47 L19 32 M57 47 L81 32" stroke="#EDF8FF" strokeWidth="2.2" strokeLinecap="round" opacity="0.88" />
      {/* Glowing golden Silent Princess stamen heart */}
      <circle cx="50" cy="51" r="11.5" fill={`url(#${core})`} stroke="#7D4908" strokeWidth="1.9" />
      <circle cx="47.2" cy="48.2" r="3.4" fill="#FFFFFF" opacity="0.88" />
    </svg>
  );
}

/**
 * Spellbook (`harrynoter01`, sidebar `#E3D0A4`):
 * Hand-bound leather grimoire with cream deckle pages, brass corner clasps,
 * embossed gold star crest, and a crimson ribbon bookmark trailing below.
 */
function SpellbookMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const cover = `pn-sb-c-${uid}`;
  const spine = `pn-sb-s-${uid}`;
  const gold = `pn-sb-g-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={cover} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7A2A1E" />
          <stop offset="48%" stopColor="#521B14" />
          <stop offset="100%" stopColor="#300E0A" />
        </linearGradient>
        <linearGradient id={spine} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#300E0A" />
          <stop offset="55%" stopColor="#5C2017" />
          <stop offset="100%" stopColor="#260A07" />
        </linearGradient>
        <linearGradient id={gold} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFF0A8" />
          <stop offset="50%" stopColor="#DFAD3A" />
          <stop offset="100%" stopColor="#946812" />
        </linearGradient>
      </defs>
      {/* Crimson satin ribbon bookmark peeking below the pages */}
      <path d="M56 80 H68 V96 L62 91 L56 96 Z" fill="#A81B1B" stroke="#4D0A0A" strokeWidth="1.5" strokeLinejoin="round" />
      {/* Cream parchment page block visible on bottom and right edge */}
      <path
        d="M21 14 H81 C84 14 86 16 86 19 V80 C86 84 83 87 79 87 H21 C16 87 13 83 13 78 V22 C13 17 16 14 21 14 Z"
        fill="#FAF2DC"
        stroke="#4A2E19"
        strokeWidth="2"
      />
      <line x1="25" y1="82.5" x2="82" y2="82.5" stroke="#C9B38A" strokeWidth="1.6" />
      {/* Rich dark mahogany leather cover */}
      <path
        d="M19 9 H82 C85 9 87 11 87 14 V75 C87 78 85 80 82 80 H19 C15 80 13 77 13 73 V15 C13 11 15 9 19 9 Z"
        fill={`url(#${cover})`}
        stroke="#240A07"
        strokeWidth="2"
      />
      {/* Raised bound spine with gold spine bands */}
      <path d="M13 15 C13 11 16 9 20 9 H27 V80 H20 C16 80 13 77 13 73 Z" fill={`url(#${spine})`} />
      <line x1="14" y1="24" x2="26" y2="24" stroke={`url(#${gold})`} strokeWidth="2.4" />
      <line x1="14" y1="45" x2="26" y2="45" stroke={`url(#${gold})`} strokeWidth="2.4" />
      <line x1="14" y1="66" x2="26" y2="66" stroke={`url(#${gold})`} strokeWidth="2.4" />
      {/* Brass corner fittings & clasp */}
      <path d="M72 9 H84 C86 9 87 10 87 12 V24 L79 17 Z" fill={`url(#${gold})`} />
      <path d="M72 80 H84 C86 80 87 79 87 77 V65 L79 72 Z" fill={`url(#${gold})`} />
      <rect x="78" y="40" width="11" height="10" rx="2.2" fill={`url(#${gold})`} stroke="#4D3206" strokeWidth="1.5" />
      {/* Embossed gold inner frame and 4-point arcane star */}
      <rect x="32" y="16.5" width="46" height="56" rx="3" fill="none" stroke={`url(#${gold})`} strokeWidth="1.6" opacity="0.72" />
      <path
        d="M55 27 L59 40 L71 44.5 L59 49 L55 62 L51 49 L39 44.5 L51 40 Z"
        fill={`url(#${gold})`}
      />
      <circle cx="55" cy="44.5" r="3.2" fill="#FFF7C8" />
    </svg>
  );
}

/**
 * Have a Vice Day (`haveaviceday`, sidebar `#C5EFE7`):
 * Daylight Art Deco twin to Grand Theft Notes - hot flamingo-magenta standing
 * flamingo silhouette poised over a sunlit peach-coral Art Deco sunburst arch.
 */
function HaveAViceDayMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const sun = `pn-vd-s-${uid}`;
  const pink = `pn-vd-p-${uid}`;
  const clip = `pn-vd-c-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><path d="M12 84 V48 A38 38 0 0 1 88 48 V84 Z" /></clipPath>
        <linearGradient id={sun} x1="50%" y1="8%" x2="50%" y2="92%">
          <stop offset="0%" stopColor="#FFF7F2" />
          <stop offset="52%" stopColor="#FFD2C4" />
          <stop offset="100%" stopColor="#FF97B7" />
        </linearGradient>
        <linearGradient id={pink} x1="20%" y1="10%" x2="80%" y2="90%">
          <stop offset="0%" stopColor="#FF3D8E" />
          <stop offset="55%" stopColor="#BD1868" />
          <stop offset="100%" stopColor="#850E49" />
        </linearGradient>
      </defs>
      {/* Sunlit Ocean Beach Art Deco arch frame */}
      <g clipPath={`url(#${clip})`}>
        <rect x="12" y="10" width="76" height="74" fill={`url(#${sun})`} />
        {/* Delicate Art Deco sunburst rays */}
        <g stroke="#085E66" strokeWidth="1.6" opacity="0.22">
          <line x1="50" y1="84" x2="18" y2="24" />
          <line x1="50" y1="84" x2="36" y2="12" />
          <line x1="50" y1="84" x2="64" y2="12" />
          <line x1="50" y1="84" x2="82" y2="24" />
        </g>
        {/* Teal Art Deco ocean horizon stripe & water reflection */}
        <rect x="12" y="75" width="76" height="9" fill="#085E66" />
        <line x1="33" y1="79.5" x2="63" y2="79.5" stroke="#85EFE0" strokeWidth="2" strokeLinecap="round" opacity="0.72" />
        {/* Poised flamingo legs standing cleanly on the waterline inside the arch */}
        <path d="M47 61 V75 M47 62 L58 69 L50 72" fill="none" stroke="#850E49" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <path d="M12 84 V48 A38 38 0 0 1 88 48 V84 Z" fill="none" stroke="#085E66" strokeWidth="3.4" strokeLinejoin="round" />
      {/* Bold standing hot-flamingo-magenta silhouette */}
      <path
        d="M61 17 C55 15 48 19 47 25 C46 31 53 36 52 43 C51 46 46 46 41 46 C30 46 23 52 25 59 C27 65 39 67 52 63 C61 60 67 54 66 47 C65 42 59 40 58 34 C57 29 60 25 64 25 C67 25 69 27 70 30 C72 27 72 22 68 19 C66 17.5 63.5 17 61 17 Z"
        fill={`url(#${pink})`}
        stroke="#6B0A3A"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Hooked dark beak tip & wing catchlight */}
      <path d="M67 22 C71 23 73 26 71 30 C69 28 68 26 66 25 Z" fill="#132B34" />
      <path d="M31 56 C38 54 46 53 55 55" fill="none" stroke="#FF9BC7" strokeWidth="2.2" strokeLinecap="round" opacity="0.78" />
    </svg>
  );
}

/**
 * Bikini Bottom (`bikinibottom`, sidebar `#FFF2A8`):
 * Iconic underwater Pineapple House with lush green crown leaves, woven amber
 * pineapple texture, lagoon-blue porthole window, and rounded ship door.
 */
function BikiniBottomMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const body = `pn-bb-b-${uid}`;
  const leaf = `pn-bb-l-${uid}`;
  const glass = `pn-bb-g-${uid}`;
  const clip = `pn-bb-c-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <path d="M50 32 C31 32 21 47 22 66 C23 82 34 92 50 92 C66 92 77 82 78 66 C79 47 69 32 50 32 Z" />
        </clipPath>
        <radialGradient id={body} cx="38%" cy="42%" r="65%">
          <stop offset="0%" stopColor="#FFB830" />
          <stop offset="55%" stopColor="#E6820E" />
          <stop offset="100%" stopColor="#A84C00" />
        </radialGradient>
        <linearGradient id={leaf} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#48B84E" />
          <stop offset="100%" stopColor="#1B6627" />
        </linearGradient>
        <radialGradient id={glass} cx="36%" cy="32%" r="68%">
          <stop offset="0%" stopColor="#9CE6FF" />
          <stop offset="55%" stopColor="#1C94D4" />
          <stop offset="100%" stopColor="#084C7A" />
        </radialGradient>
      </defs>
      {/* Lush tropical green pineapple crown leaves */}
      <g fill={`url(#${leaf})`} stroke="#14451C" strokeWidth="1.8" strokeLinejoin="round">
        <path d="M46 36 C36 24 23 19 14 23 C22 29 31 35 42 39 Z" />
        <path d="M54 36 C64 24 77 19 86 23 C78 29 69 35 58 39 Z" />
        <path d="M48 35 C41 21 35 12 31 9 C38 15 44 23 49 34 Z" />
        <path d="M52 35 C59 21 65 12 69 9 C62 15 56 23 51 34 Z" />
        <path d="M50 35 C45 21 46 11 50 6 C54 11 55 21 50 35 Z" />
      </g>
      {/* Sculpted golden-orange pineapple house */}
      <g clipPath={`url(#${clip})`}>
        <rect x="20" y="30" width="60" height="64" fill={`url(#${body})`} />
        {/* Crisp pineapple diamond crosshatch lines */}
        <g stroke="#7A3200" strokeWidth="2.1" opacity="0.52">
          <path d="M18 48 L48 92 M32 32 L72 90 M54 32 L84 76" />
          <path d="M82 48 L52 92 M68 32 L28 90 M46 32 L16 76" />
        </g>
      </g>
      <path
        d="M50 32 C31 32 21 47 22 66 C23 82 34 92 50 92 C66 92 77 82 78 66 C79 47 69 32 50 32 Z"
        fill="none"
        stroke="#6B2D00"
        strokeWidth="2.4"
      />
      {/* Lagoon-blue circular porthole window */}
      <circle cx="38" cy="54" r="9.5" fill="#0B70AA" stroke="#073E63" strokeWidth="2" />
      <circle cx="38" cy="54" r="6" fill={`url(#${glass})`} />
      <circle cx="35.8" cy="51.8" r="1.8" fill="#FFFFFF" opacity="0.85" />
      {/* Rounded blue-steel ship door at the bottom right */}
      <path
        d="M50 91 V71 C50 64 67 64 67 71 V91 Z"
        fill="#0B70AA"
        stroke="#073E63"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <circle cx="62" cy="79" r="2.2" fill="#FFF2A8" />
    </svg>
  );
}

/**
 * Krusty Krab (`krustykrab00`, sidebar `#FCE0C2`):
 * Bold, joyful stylized Krabby Patty burger with sesame-seeded golden bun,
 * crisp green lettuce, ketchup-red tomato, melty cheese, and seared patty.
 */
function KrustyKrabMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const bun = `pn-kk-b-${uid}`;
  const patty = `pn-kk-p-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={bun} x1="25%" y1="10%" x2="75%" y2="90%">
          <stop offset="0%" stopColor="#F5B856" />
          <stop offset="55%" stopColor="#D98324" />
          <stop offset="100%" stopColor="#A6550A" />
        </linearGradient>
        <linearGradient id={patty} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#6E3618" />
          <stop offset="100%" stopColor="#3B1A09" />
        </linearGradient>
      </defs>
      {/* Toasted bottom bun */}
      <path
        d="M15 73 H85 V79 C85 86 78 90 70 90 H30 C22 90 15 86 15 79 Z"
        fill={`url(#${bun})`}
        stroke="#3A2410"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      {/* Thick seared patty */}
      <rect x="11" y="61" width="78" height="14.5" rx="7" fill={`url(#${patty})`} stroke="#2B1206" strokeWidth="2.6" />
      {/* Melted golden cheddar wedge draping over the patty */}
      <path
        d="M15 58 H85 L78 65 L64 62 L50 71 L36 62 L22 65 Z"
        fill="#FACC15"
        stroke="#784B00"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Bright ketchup-red tomato layer */}
      <rect x="14" y="50" width="72" height="9.5" rx="4.5" fill="#C8102E" stroke="#6B0818" strokeWidth="2.2" />
      {/* Crisp ruffled lettuce wave */}
      <path
        d="M10 47 Q18 39 27 46 T45 46 T63 46 T81 46 Q89 41 91 49 Q85 55 76 52 T58 52 T40 52 T22 52 Q12 55 10 47 Z"
        fill="#2E8B42"
        stroke="#174D23"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      {/* Domed golden sesame top bun */}
      <path
        d="M14 44 C14 21 30 12 50 12 C70 12 86 21 86 44 Z"
        fill={`url(#${bun})`}
        stroke="#3A2410"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      {/* Glossy top highlight & cream sesame seeds */}
      <path d="M25 27 C32 19 42 16 53 16" fill="none" stroke="#FFE2A8" strokeWidth="3" strokeLinecap="round" opacity="0.65" />
      <ellipse cx="36" cy="27" rx="3.4" ry="2" transform="rotate(-18 36 27)" fill="#FFF4DC" />
      <ellipse cx="52" cy="23" rx="3.4" ry="2" transform="rotate(8 52 23)" fill="#FFF4DC" />
      <ellipse cx="66" cy="29" rx="3.4" ry="2" transform="rotate(24 66 29)" fill="#FFF4DC" />
      <ellipse cx="45" cy="35" rx="3.2" ry="1.9" transform="rotate(-8 45 35)" fill="#FFF4DC" />
      <ellipse cx="61" cy="36" rx="3.2" ry="1.9" transform="rotate(14 61 36)" fill="#FFF4DC" />
    </svg>
  );
}

/**
 * Mad Tea Party (`madteaparty0`, sidebar `#150B1C`):
 * Jauntily tilted Mad Hatter purple velvet top hat wrapped in a glowing
 * teacup-turquoise ribbon with the iconic cream "10/6" card tucked in the band.
 */
function MadTeaPartyMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const hat = `pn-mt-h-${uid}`;
  const brim = `pn-mt-b-${uid}`;
  const band = `pn-mt-r-${uid}`;
  const glow = `pn-mt-g-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={glow} cx="50%" cy="54%" r="48%">
          <stop offset="0%" stopColor="#C77DFF" stopOpacity="0.44" />
          <stop offset="65%" stopColor="#3DF5C4" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#150B1C" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={hat} x1="15%" y1="10%" x2="85%" y2="85%">
          <stop offset="0%" stopColor="#C77DFF" />
          <stop offset="48%" stopColor="#7E35B8" />
          <stop offset="100%" stopColor="#42176E" />
        </linearGradient>
        <linearGradient id={brim} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A65CE0" />
          <stop offset="100%" stopColor="#4D1C7D" />
        </linearGradient>
        <linearGradient id={band} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#12A88A" />
          <stop offset="50%" stopColor="#3DF5C4" />
          <stop offset="100%" stopColor="#0E8C73" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="54" r="46" fill={`url(#${glow})`} />
      <g transform="rotate(-9 50 54)">
        {/* Flared top-hat crown */}
        <path
          d="M21 18 Q50 10 79 18 L72 68 Q50 74 28 68 Z"
          fill={`url(#${hat})`}
          stroke="#E0B3FF"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        {/* Velvet specular highlight along left flare */}
        <path d="M27 22 L32 62" stroke="#EBC9FF" strokeWidth="3.2" strokeLinecap="round" opacity="0.42" />
        {/* Glowing teacup-turquoise ribbon band */}
        <path
          d="M26.5 52 Q50 58 73.5 52 L72 68 Q50 74 28 68 Z"
          fill={`url(#${band})`}
          stroke="#0A5C4B"
          strokeWidth="1.6"
        />
        {/* Iconic cream hat-card tucked into the right side of the ribbon */}
        <g transform="rotate(14 64 46)">
          <rect x="55" y="34" width="17" height="22" rx="2.5" fill="#FAF0DC" stroke="#5E239D" strokeWidth="1.8" />
          <line x1="59" y1="41" x2="68" y2="41" stroke="#3D1A66" strokeWidth="2.3" strokeLinecap="round" />
          <line x1="59" y1="47" x2="66" y2="47" stroke="#7E35B8" strokeWidth="2.1" strokeLinecap="round" />
        </g>
        {/* Dramatic curving Hatter brim */}
        <path
          d="M7 66 C18 78 36 82 50 82 C64 82 82 78 93 66 C88 78 72 88 50 88 C28 88 12 78 7 66 Z"
          fill={`url(#${brim})`}
          stroke="#DFB3FF"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      </g>
      {/* Whimsical golden Wonderland sparkle */}
      <path d="M84 18 L86 23 L91 25 L86 27 L84 32 L82 27 L77 25 L82 23 Z" fill="#F2C14E" />
    </svg>
  );
}

/**
 * Central Perk (`centralperk0`, sidebar `#172019`):
 * Oversized glossy cafe-orange ceramic coffee mug on a cream saucer with rich
 * dark roast rim and warm curling cream steam.
 */
function CentralPerkMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const mug = `pn-cp-m-${uid}`;
  const saucer = `pn-cp-s-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={mug} x1="15%" y1="15%" x2="85%" y2="85%">
          <stop offset="0%" stopColor="#FFA85C" />
          <stop offset="48%" stopColor="#E8823A" />
          <stop offset="100%" stopColor="#9C4612" />
        </linearGradient>
        <linearGradient id={saucer} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FAF3E6" />
          <stop offset="100%" stopColor="#C2B59B" />
        </linearGradient>
      </defs>
      {/* Rising warm cream coffee steam curls */}
      <path
        d="M36 28 C32 22 41 18 37 11"
        fill="none"
        stroke="#F3EBDD"
        strokeWidth="3.6"
        strokeLinecap="round"
        opacity="0.88"
      />
      <path
        d="M52 26 C48 19 57 15 53 8"
        fill="none"
        stroke="#FFE0B8"
        strokeWidth="3.8"
        strokeLinecap="round"
        opacity="0.95"
      />
      {/* Cream ceramic saucer */}
      <ellipse cx="46" cy="83" rx="39" ry="9" fill={`url(#${saucer})`} stroke="#5E4A36" strokeWidth="1.8" />
      <ellipse cx="46" cy="81.5" rx="25" ry="4.5" fill="#B5A68C" opacity="0.55" />
      {/* Bold mug handle */}
      <path
        d="M70 43 H78 C86 43 90 48 90 56 C90 64 85 69 77 69 H68"
        fill="none"
        stroke="#E8823A"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <path
        d="M70 43 H78 C86 43 90 48 90 56 C90 64 85 69 77 69 H68"
        fill="none"
        stroke="#FFC68A"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.65"
      />
      {/* Oversized cafe-orange mug body */}
      <path
        d="M17 37 H73 V63 C73 75 63 82 45 82 C27 82 17 75 17 63 Z"
        fill={`url(#${mug})`}
        stroke="#5C2808"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      {/* Cream cup rim + dark coffee surface */}
      <ellipse cx="45" cy="37" rx="28" ry="6.5" fill="#F3EBDD" stroke="#5C2808" strokeWidth="1.8" />
      <ellipse cx="45" cy="37.2" rx="22" ry="3.8" fill="#3B2113" />
      {/* Glossy ceramic shine on front-left of mug */}
      <path d="M25 48 V64 C25 69 29 73 34 75" fill="none" stroke="#FFD8B0" strokeWidth="3.2" strokeLinecap="round" opacity="0.65" />
      {/* Small cream cafe emblem band */}
      <circle cx="45" cy="59" r="7.5" fill="#F3EBDD" opacity="0.92" />
      <circle cx="45" cy="59" r="3.6" fill="#2A4D38" />
    </svg>
  );
}

/**
 * Koi Pond (`koipond00000`, sidebar `#0A1F22`):
 * Tranquil circular teal pond ripple framing a curving koi-orange and white
 * calico Koi fish with flowing tail and a deep-emerald lily pad.
 */
function KoiPondMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const water = `pn-kp-w-${uid}`;
  const koi = `pn-kp-k-${uid}`;
  const clip = `pn-kp-c-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><circle cx="50" cy="50" r="44" /></clipPath>
        <radialGradient id={water} cx="45%" cy="42%" r="60%">
          <stop offset="0%" stopColor="#1E5B63" />
          <stop offset="68%" stopColor="#11383E" />
          <stop offset="100%" stopColor="#092125" />
        </radialGradient>
        <linearGradient id={koi} x1="20%" y1="15%" x2="80%" y2="85%">
          <stop offset="0%" stopColor="#FFA15C" />
          <stop offset="52%" stopColor="#F2763B" />
          <stop offset="100%" stopColor="#C44816" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${clip})`}>
        {/* Deep pond water + delicate pale aqua concentric ripples */}
        <circle cx="50" cy="50" r="44" fill={`url(#${water})`} />
        <circle cx="46" cy="50" r="34" fill="none" stroke="#7AE0E0" strokeWidth="1.4" opacity="0.32" />
        <circle cx="46" cy="50" r="22" fill="none" stroke="#7AE0E0" strokeWidth="1.2" opacity="0.28" />
        {/* Emerald lily pad tucked cleanly at lower-left */}
        <path d="M23 76 A14 14 0 1 1 35 66 L26 73 Z" fill="#2E7D5B" stroke="#6BD4A2" strokeWidth="1.4" />
        {/* Flowing Koi pectoral fins */}
        <path d="M41 37 C29 33 23 39 24 47 C32 46 38 44 43 42 Z" fill="#FFF3E6" opacity="0.92" />
        <path d="M62 41 C74 37 81 42 79 51 C72 50 66 47 61 45 Z" fill="#FFF3E6" opacity="0.92" />
        {/* Sweeping white-tipped fan tail */}
        <path
          d="M52 68 C58 76 68 83 78 82 C73 74 68 69 63 66 C71 67 79 65 83 59 C73 59 64 60 55 62 Z"
          fill="#FFF3E6"
          opacity="0.94"
        />
        {/* Graceful S-curving Koi body */}
        <path
          d="M47 16 C59 16 67 27 65 41 C63 53 56 62 56 70 C47 69 40 60 40 48 C40 36 37 26 40 20 C42 17 44 16 47 16 Z"
          fill={`url(#${koi})`}
          stroke="#7A2A0A"
          strokeWidth="1.5"
        />
        {/* Calico snow-white Koi markings & head dot */}
        <path d="M43 32 C50 29 58 32 61 39 C55 43 46 43 42 38 Z" fill="#FFFFFF" opacity="0.95" />
        <path d="M44 53 C50 51 55 54 56 60 C51 62 46 59 44 53 Z" fill="#FFFFFF" opacity="0.92" />
        <circle cx="48" cy="23" r="3.4" fill="#FFF3E6" />
        <circle cx="42.5" cy="21" r="1.5" fill="#092125" />
        <circle cx="54.5" cy="22" r="1.5" fill="#092125" />
      </g>
      <circle cx="50" cy="50" r="44" fill="none" stroke="#5EC8C8" strokeWidth="2.4" opacity="0.72" />
    </svg>
  );
}

/**
 * Grimoire (`grimoire0000`, sidebar `#0E0B12`):
 * Pointed-arch obsidian tarot emblem framed in antique gold, cradling a glowing
 * golden crescent moon and radiant 8-point celestial star.
 */
function GrimoireMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const plaque = `pn-gr-p-${uid}`;
  const gold = `pn-gr-g-${uid}`;
  const aura = `pn-gr-a-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={aura} cx="52%" cy="48%" r="48%">
          <stop offset="0%" stopColor="#D4AF37" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#0E0B12" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={plaque} x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#261E33" />
          <stop offset="55%" stopColor="#16111F" />
          <stop offset="100%" stopColor="#0C0912" />
        </linearGradient>
        <linearGradient id={gold} x1="12%" y1="8%" x2="88%" y2="92%">
          <stop offset="0%" stopColor="#FFF4BE" />
          <stop offset="48%" stopColor="#D4AF37" />
          <stop offset="100%" stopColor="#8A6814" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`url(#${aura})`} />
      {/* Gothic pointed-arch tarot plaque */}
      <path
        d="M50 6 C68 13 80 26 82 44 V82 C82 88 77 93 71 93 H29 C23 93 18 88 18 82 V44 C20 26 32 13 50 6 Z"
        fill={`url(#${plaque})`}
        stroke={`url(#${gold})`}
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      <path
        d="M50 13 C64 19 74 30 75.5 45 V80 C75.5 83.5 72.5 86.5 69 86.5 H31 C27.5 86.5 24.5 83.5 24.5 80 V45 C26 30 36 19 50 13 Z"
        fill="none"
        stroke={`url(#${gold})`}
        strokeWidth="1.2"
        opacity="0.58"
      />
      {/* Antique gold crescent moon */}
      <path
        d="M52 29 A22 22 0 1 0 65 69 A16.5 16.5 0 1 1 52 29 Z"
        fill={`url(#${gold})`}
      />
      {/* Radiant 8-point celestial starburst nestled inside the crescent */}
      <path
        d="M59 35 L61.5 46 L72 48.5 L61.5 51 L59 62 L56.5 51 L46 48.5 L56.5 46 Z"
        fill="#FFF4C2"
      />
      <path
        d="M59 41 L64.5 43 L62.5 48.5 L64.5 54 L59 56 L53.5 54 L55.5 48.5 L53.5 43 Z"
        fill={`url(#${gold})`}
        opacity="0.72"
      />
      {/* Delicate corner tarot stars */}
      <circle cx="50" cy="20" r="2" fill="#FFF0AE" />
      <circle cx="34" cy="79" r="1.8" fill="#D4AF37" />
      <circle cx="66" cy="79" r="1.8" fill="#D4AF37" />
    </svg>
  );
}

export const POP_THEME_LOGOS: Record<PopThemeLogoId, ComponentType<ThemeLogoProps>> = {
  hoth00000000: HothMark,
  hyrule000000: HyruleMark,
  kokiriforest: KokiriForestMark,
  breathofthen: BreathOfTheNotesMark,
  harrynoter01: SpellbookMark,
  haveaviceday: HaveAViceDayMark,
  bikinibottom: BikiniBottomMark,
  krustykrab00: KrustyKrabMark,
  madteaparty0: MadTeaPartyMark,
  centralperk0: CentralPerkMark,
  koipond00000: KoiPondMark,
  grimoire0000: GrimoireMark,
};
