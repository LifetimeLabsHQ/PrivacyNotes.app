import { useId, type ComponentType } from 'react';
import type { CoreThemeLogoId } from './themeLogoResolver';

export interface ThemeLogoProps {
  className?: string;
}

/**
 * Darth Vader (`darthvader00`, sidebar `#000400`):
 * Free-form obsidian Vader helmet silhouette backlit by a crimson Sith aura,
 * with wide samurai-style flared cowl, overhanging dome rim, specular lenses,
 * crimson saber rim-light, and triangular metallic respirator grille.
 */
function DarthVaderMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const aura = `pn-dv-a-${uid}`;
  const dome = `pn-dv-d-${uid}`;
  const cowl = `pn-dv-c-${uid}`;
  const mask = `pn-dv-m-${uid}`;
  const rim = `pn-dv-r-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={aura} cx="50%" cy="52%" r="50%">
          <stop offset="0%" stopColor="#FF302E" stopOpacity="0.6" />
          <stop offset="56%" stopColor="#B81214" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#FF302E" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={dome} x1="16%" y1="6%" x2="86%" y2="82%">
          <stop offset="0%" stopColor="#7C7988" />
          <stop offset="30%" stopColor="#35333E" />
          <stop offset="72%" stopColor="#16141C" />
          <stop offset="100%" stopColor="#4A171C" />
        </linearGradient>
        <linearGradient id={cowl} x1="8%" y1="30%" x2="92%" y2="88%">
          <stop offset="0%" stopColor="#524F5E" />
          <stop offset="46%" stopColor="#1E1C24" />
          <stop offset="82%" stopColor="#121017" />
          <stop offset="100%" stopColor="#57181E" />
        </linearGradient>
        <linearGradient id={mask} x1="50%" y1="36%" x2="50%" y2="92%">
          <stop offset="0%" stopColor="#2E2C37" />
          <stop offset="100%" stopColor="#0E0D12" />
        </linearGradient>
        <linearGradient id={rim} x1="6%" y1="8%" x2="94%" y2="92%">
          <stop offset="0%" stopColor="#A8A4B6" stopOpacity="0.82" />
          <stop offset="46%" stopColor="#605C6E" stopOpacity="0.38" />
          <stop offset="100%" stopColor="#FF4240" stopOpacity="0.96" />
        </linearGradient>
      </defs>
      {/* Crimson Sith backlight so the obsidian helmet separates cleanly from #000400 */}
      <circle cx="50" cy="52" r="48" fill={`url(#${aura})`} />
      {/* Wide, heavy flared Vader helmet silhouette */}
      <path
        d="M50 8 C30 8 19.5 21 18.5 39 L7.5 73.5 C6.5 78.5 10.5 84 16.5 84.5 L33 80.5 L41 90 L50 93.5 L59 90 L67 80.5 L83.5 84.5 C89.5 84 93.5 78.5 92.5 73.5 L81.5 39 C80.5 21 70 8 50 8 Z"
        fill={`url(#${cowl})`}
        stroke={`url(#${rim})`}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* Sculpted upper helmet dome with iconic overhanging flared brow lip */}
      <path
        d="M50 9.5 C31.5 9.5 21 22 19.5 39.5 L15.5 44.5 Q50 34 84.5 44.5 L80.5 39.5 C79 22 68.5 9.5 50 9.5 Z"
        fill={`url(#${dome})`}
      />
      {/* Central vertical crown fin */}
      <path d="M46.5 11 L50 10 L53.5 11 L52.5 37 L50 38.5 L47.5 37 Z" fill="#7D798A" fillOpacity="0.58" />
      {/* Specular crown shine (left) & crimson saber edge-light hugging right bevel */}
      <path
        d="M30 19.5 C35 14.5 41 12 46 11.5"
        fill="none"
        stroke="#C8C4D4"
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity="0.72"
      />
      <path
        d="M78 39 L89 73.5 C89.5 76.5 87.5 80 83 81"
        fill="none"
        stroke="#FF4442"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.92"
      />
      {/* Inner face mask plate */}
      <path d="M26 42.5 Q50 35.5 74 42.5 L71 77 L50 90.5 L29 77 Z" fill={`url(#${mask})`} />
      {/* Heavy furrowed brow */}
      <path d="M23.5 43 Q50 35 76.5 43 L73 49.5 Q50 42.5 27 49.5 Z" fill="#5E5A6A" />
      {/* Iconic dark obsidian angled eye lenses with crisp metallic/crimson specular edge */}
      <path d="M29 49 L47 51 L45 59.5 L31 57.5 Z" fill="#050408" stroke="#7A7688" strokeWidth="1.3" />
      <path d="M71 49 L53 51 L55 59.5 L69 57.5 Z" fill="#050408" stroke="#B84245" strokeWidth="1.3" />
      <path d="M32 51.8 L41 52.8" stroke="#C8C4D4" strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
      <path d="M59 52.8 L68 51.8" stroke="#FF5E5C" strokeWidth="1.8" strokeLinecap="round" opacity="0.9" />
      {/* Sculpted cheek plates */}
      <path d="M25.5 58 L35 61.5 L33 77 L22.5 75 Z" fill="#2D2B36" opacity="0.9" />
      <path d="M74.5 58 L65 61.5 L67 77 L77.5 75 Z" fill="#421E24" opacity="0.9" />
      {/* Triangular metallic respirator mouth grille */}
      <path
        d="M50 57 L66.5 80 L33.5 80 Z"
        fill="#100F14"
        stroke="#B0ACB8"
        strokeWidth="2.3"
        strokeLinejoin="round"
      />
      <line x1="41.5" y1="68.5" x2="41.5" y2="79" stroke="#D8D4E2" strokeWidth="2.3" strokeLinecap="round" />
      <line x1="45.8" y1="63.5" x2="45.8" y2="79" stroke="#F0ECF6" strokeWidth="2.3" strokeLinecap="round" />
      <line x1="50" y1="60" x2="50" y2="79" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="54.2" y1="63.5" x2="54.2" y2="79" stroke="#F0ECF6" strokeWidth="2.3" strokeLinecap="round" />
      <line x1="58.5" y1="68.5" x2="58.5" y2="79" stroke="#D8D4E2" strokeWidth="2.3" strokeLinecap="round" />
      {/* Metallic breather studs & chin vent */}
      <circle cx="30.5" cy="77" r="3" fill="#CCC8D6" />
      <circle cx="69.5" cy="77" r="3" fill="#CCC8D6" />
      <rect x="44.5" y="83.5" width="11" height="4.8" rx="1.6" fill="#464350" stroke="#FF3836" strokeWidth="1" />
    </svg>
  );
}

/**
 * Death Star (`deathstar000`, sidebar `#171112`):
 * Gunmetal battle-station sphere with equatorial trench, deeply shaded concave
 * superlaser dish, and glowing cyan hologram focal core.
 */
function DeathStarMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const clip = `pn-ds-c-${uid}`;
  const sphere = `pn-ds-s-${uid}`;
  const dish = `pn-ds-d-${uid}`;
  const halo = `pn-ds-h-${uid}`;
  const laser = `pn-ds-l-${uid}`;
  const rim = `pn-ds-r-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><circle cx="50" cy="50" r="43" /></clipPath>
        <radialGradient id={halo} cx="50%" cy="50%" r="50%">
          <stop offset="72%" stopColor="#5DE1E4" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#5DE1E4" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={sphere} cx="34%" cy="28%" r="72%">
          <stop offset="0%" stopColor="#AEB8C4" />
          <stop offset="38%" stopColor="#6D7682" />
          <stop offset="76%" stopColor="#3B4048" />
          <stop offset="100%" stopColor="#1E2127" />
        </radialGradient>
        {/* Strong inverse lighting (bright bottom-right, deep dark top-left) for unmistakable concave depth */}
        <radialGradient id={dish} cx="70%" cy="72%" r="70%">
          <stop offset="0%" stopColor="#99A5B2" />
          <stop offset="44%" stopColor="#4A525E" />
          <stop offset="82%" stopColor="#1C2026" />
          <stop offset="100%" stopColor="#111419" />
        </radialGradient>
        <radialGradient id={laser} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#EEFFFF" />
          <stop offset="42%" stopColor="#5DE1E4" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#5DE1E4" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={rim} x1="15%" y1="15%" x2="88%" y2="88%">
          <stop offset="0%" stopColor="#DDE8F2" stopOpacity="0.82" />
          <stop offset="45%" stopColor="#5DE1E4" stopOpacity="0.62" />
          <stop offset="100%" stopColor="#5DE1E4" stopOpacity="0.88" />
        </linearGradient>
      </defs>
      {/* Subtle cyan hologram atmosphere */}
      <circle cx="50" cy="50" r="49" fill={`url(#${halo})`} />
      <g clipPath={`url(#${clip})`}>
        {/* Gunmetal hull */}
        <circle cx="50" cy="50" r="43" fill={`url(#${sphere})`} />
        {/* Clean geometric armor plates */}
        <path d="M55 8 V48 M68 14 V48 M30 53 V88 M58 53 V92" stroke="#22262C" strokeWidth="1.7" opacity="0.58" />
        <path d="M56 26 H89 M69 37 H93 M12 67 H58 M42 78 H86" stroke="#22262C" strokeWidth="1.7" opacity="0.52" />
        <rect x="61" y="29" width="16" height="6" rx="1" fill="#929BA8" opacity="0.28" />
        <rect x="20" y="60" width="18" height="5" rx="1" fill="#929BA8" opacity="0.24" />
        <rect x="62" y="61" width="15" height="9" rx="1" fill="#20242A" opacity="0.48" />
        {/* Equatorial trench */}
        <rect x="6" y="47.5" width="88" height="5.5" fill="#101216" />
        <line x1="6" y1="47.8" x2="94" y2="47.8" stroke="#5DE1E4" strokeWidth="1.5" opacity="0.72" />
        <line x1="6" y1="53.2" x2="94" y2="53.2" stroke="#909AA8" strokeWidth="1.1" opacity="0.58" />
        {/* Trench bay lights */}
        <rect x="20" y="49.2" width="5" height="2" rx="0.8" fill="#5DE1E4" opacity="0.92" />
        <rect x="52" y="49.2" width="7" height="2" rx="0.8" fill="#5DE1E4" opacity="0.96" />
        <rect x="74" y="49.2" width="4" height="2" rx="0.8" fill="#C4FCFF" opacity="0.88" />
        {/* Concave superlaser dish */}
        <circle cx="35.5" cy="30.5" r="15" fill={`url(#${dish})`} stroke="#1E2228" strokeWidth="2.2" />
        <circle cx="35.5" cy="30.5" r="13.6" fill="none" stroke="#A6B1BE" strokeWidth="1.1" opacity="0.6" />
        <circle cx="35.5" cy="30.5" r="8.4" fill="none" stroke="#5DE1E4" strokeWidth="1.4" opacity="0.72" />
        {/* Emitter spokes converging on the cyan hologram focal emitter */}
        <line x1="23" y1="30.5" x2="48" y2="30.5" stroke="#5DE1E4" strokeWidth="1.3" opacity="0.6" />
        <line x1="35.5" y1="18" x2="35.5" y2="43" stroke="#5DE1E4" strokeWidth="1.3" opacity="0.6" />
        <circle cx="35.5" cy="30.5" r="7.8" fill={`url(#${laser})`} />
        <circle cx="35.5" cy="30.5" r="2.8" fill="#EEFFFF" />
      </g>
      {/* Sunlit metallic top-left fading to glowing cyan hologram rim */}
      <circle cx="50" cy="50" r="43" fill="none" stroke={`url(#${rim})`} strokeWidth="2.2" />
    </svg>
  );
}

/**
 * Jedi (`jedi00000000`, sidebar `#D5C9B0`):
 * Warm cream parchment Jedi medallion pierced diagonally by a bold, chunky
 * Luke ROTJ lightsaber hilt and saturated glowing green blade breaking past
 * the rim so it carries full visual weight on the warm tan sidebar.
 */
function JediMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const cream = `pn-jd-c-${uid}`;
  const blade = `pn-jd-b-${uid}`;
  const aura = `pn-jd-a-${uid}`;
  const steel = `pn-jd-s-${uid}`;
  const gold = `pn-jd-g-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={cream} cx="38%" cy="32%" r="72%">
          <stop offset="0%" stopColor="#FAF5EA" />
          <stop offset="68%" stopColor="#EFE6D3" />
          <stop offset="100%" stopColor="#DDD0B6" />
        </radialGradient>
        <linearGradient id={aura} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#14532D" stopOpacity="0" />
          <stop offset="22%" stopColor="#166534" stopOpacity="0.62" />
          <stop offset="50%" stopColor="#22C55E" stopOpacity="0.9" />
          <stop offset="78%" stopColor="#166534" stopOpacity="0.62" />
          <stop offset="100%" stopColor="#14532D" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={blade} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#16702D" />
          <stop offset="25%" stopColor="#34D35C" />
          <stop offset="50%" stopColor="#F6FFF7" />
          <stop offset="75%" stopColor="#34D35C" />
          <stop offset="100%" stopColor="#16702D" />
        </linearGradient>
        <linearGradient id={steel} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#5C534A" />
          <stop offset="35%" stopColor="#F2ECE0" />
          <stop offset="70%" stopColor="#B8AFA0" />
          <stop offset="100%" stopColor="#3B332D" />
        </linearGradient>
        <linearGradient id={gold} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#8A540E" />
          <stop offset="38%" stopColor="#F7D372" />
          <stop offset="72%" stopColor="#C98A24" />
          <stop offset="100%" stopColor="#693E09" />
        </linearGradient>
      </defs>
      {/* Warm Jedi-robe cream medallion giving crisp presence on #D5C9B0 tan */}
      <circle cx="50" cy="50" r="39" fill={`url(#${cream})`} stroke="#8F7D63" strokeWidth="2.8" />
      <circle cx="50" cy="50" r="32.5" fill="none" stroke="#B8A68A" strokeWidth="1.6" />
      {/* Subtle Jedi Order wing emblem recessed inside the cream medallion */}
      <path
        d="M50 75 C35 71 24 58 24 43 C29 52 36 59 44 62 C34 54 29 44 30 33 C35 43 42 50 50 54 C58 50 65 43 70 33 C71 44 66 54 56 62 C64 59 71 52 76 43 C76 58 65 71 50 75 Z"
        fill="#C9B99C"
        opacity="0.72"
      />
      {/* Bold diagonal Luke lightsaber piercing cleanly beyond the medallion rim */}
      <g transform="rotate(45 50 50)">
        {/* Saturated emerald outer plasma aura */}
        <rect x="34" y="-12" width="32" height="72" rx="16" fill={`url(#${aura})`} />
        {/* Crisp deep-emerald blade edge + luminous green plasma body + hot core */}
        <rect x="41.5" y="-6.5" width="17" height="64" rx="8.5" fill="#145A24" />
        <rect x="43.3" y="-4.8" width="13.4" height="61" rx="6.7" fill={`url(#${blade})`} />
        <rect x="47.2" y="-2" width="5.6" height="56" rx="2.8" fill="#FAFFFA" />
        {/* Emitter ignition flare */}
        <ellipse cx="50" cy="55.5" rx="12" ry="3.8" fill="#22C55E" opacity="0.58" />
        <ellipse cx="50" cy="55.5" rx="6.5" ry="2" fill="#F4FFF6" opacity="0.92" />
        {/* Flared silver emitter shroud */}
        <rect x="38" y="55" width="24" height="6.5" rx="2.4" fill={`url(#${steel})`} stroke="#3B302A" strokeWidth="2" />
        {/* Iconic copper-gold thin neck */}
        <rect x="43.5" y="61.5" width="13" height="7.5" fill={`url(#${gold})`} stroke="#4A351E" strokeWidth="1.8" />
        {/* Upper silver collar + activation clamp */}
        <rect x="40" y="69" width="20" height="8" rx="1.8" fill={`url(#${steel})`} stroke="#3B302A" strokeWidth="2" />
        <rect x="58.5" y="70.5" width="6" height="10" rx="1.6" fill={`url(#${gold})`} stroke="#3B302A" strokeWidth="1.6" />
        {/* Ribbed dark espresso-black lower grip */}
        <rect x="40.5" y="77" width="19" height="20.5" rx="2.2" fill="#2B231F" stroke="#3B302A" strokeWidth="2" />
        <line x1="41" y1="81.5" x2="59" y2="81.5" stroke="#DDD4C2" strokeWidth="2.4" />
        <line x1="41" y1="87" x2="59" y2="87" stroke="#DDD4C2" strokeWidth="2.4" />
        <line x1="41" y1="92.5" x2="59" y2="92.5" stroke="#DDD4C2" strokeWidth="2.4" />
        {/* Chunky silver pommel */}
        <rect x="39" y="96.5" width="22" height="7.5" rx="3.4" fill={`url(#${steel})`} stroke="#3B302A" strokeWidth="2" />
      </g>
    </svg>
  );
}

/**
 * White Rabbit (`whiterabbit0`, sidebar `#030803`):
 * Glowing Matrix terminal ring with crisp segmented neon-green digital rain
 * behind a sleek, anatomically unmistakable pure-white rabbit silhouette.
 */
function WhiteRabbitMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const clip = `pn-wr-c-${uid}`;
  const bg = `pn-wr-b-${uid}`;
  const rain = `pn-wr-r-${uid}`;
  const glow = `pn-wr-g-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><circle cx="50" cy="50" r="44" /></clipPath>
        <radialGradient id={bg} cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor="#082910" />
          <stop offset="70%" stopColor="#031206" />
          <stop offset="100%" stopColor="#020803" />
        </radialGradient>
        <linearGradient id={rain} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#00FF41" stopOpacity="0.1" />
          <stop offset="72%" stopColor="#00FF41" stopOpacity="0.82" />
          <stop offset="100%" stopColor="#D6FFE0" stopOpacity="1" />
        </linearGradient>
        <radialGradient id={glow} cx="52%" cy="56%" r="42%">
          <stop offset="0%" stopColor="#00FF41" stopOpacity="0.54" />
          <stop offset="100%" stopColor="#00FF41" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* Subtle outer Matrix phosphor bloom */}
      <circle cx="50" cy="50" r="47.5" fill="none" stroke="#00FF41" strokeWidth="3" opacity="0.28" />
      <g clipPath={`url(#${clip})`}>
        <circle cx="50" cy="50" r="44" fill={`url(#${bg})`} />
        {/* Crisp Matrix digital rain streams (segmented dashes + bright leading droplets) */}
        <g strokeLinecap="round">
          <line x1="16" y1="14" x2="16" y2="44" stroke={`url(#${rain})`} strokeWidth="2.8" strokeDasharray="4 4" />
          <circle cx="16" cy="48" r="2.2" fill="#D8FFE2" />
          <line x1="27" y1="12" x2="27" y2="70" stroke={`url(#${rain})`} strokeWidth="2.8" strokeDasharray="5 4" opacity="0.82" />
          <circle cx="27" cy="74" r="2" fill="#B8FFC8" />
          <line x1="39" y1="8" x2="39" y2="34" stroke={`url(#${rain})`} strokeWidth="2.6" strokeDasharray="4 3.5" opacity="0.8" />
          <line x1="62" y1="9" x2="62" y2="42" stroke={`url(#${rain})`} strokeWidth="2.6" strokeDasharray="4 4" opacity="0.78" />
          <line x1="73" y1="12" x2="73" y2="72" stroke={`url(#${rain})`} strokeWidth="2.8" strokeDasharray="5 4" opacity="0.88" />
          <circle cx="73" cy="76" r="2.2" fill="#D8FFE2" />
          <line x1="84" y1="22" x2="84" y2="54" stroke={`url(#${rain})`} strokeWidth="2.8" strokeDasharray="4 4" opacity="0.92" />
          <circle cx="84" cy="58" r="2.2" fill="#D8FFE2" />
        </g>
        {/* Soft green backlight halo behind the white rabbit */}
        <circle cx="51" cy="56" r="34" fill={`url(#${glow})`} />
        {/* Fluffy round cotton tail cleanly separated on lower-left */}
        <circle cx="26.5" cy="67" r="6.8" fill="#FFFFFF" />
        {/* Sleek, unmistakable seated alert white rabbit profile facing right */}
        <path
          d="M50 38
             C46 28 38 17 42 13.5 C45.5 11 51 18 54 31
             C56.5 22 61.5 14 66 15.5 C69.5 17 66.5 27 61 36.5
             C68.5 38 75 42.5 76.5 47.5 C77.5 51 74 54.5 68 54.5
             C64 54.5 62.5 57 63 61 C64 66 68 71 72 74 C74.5 76 74 79.5 70 79.5
             L60 79.5 C57 79.5 55.5 77 56 74 C55 70 52 67 48.5 67.5
             C46.5 71 48 75 51.5 77 C53 78 52.5 80 49.5 80 L34 80
             C29.5 80 28 76.5 30 72 C29.5 63 32 54 38 48 C42 44 46 41 50 38 Z"
          fill="#FFFFFF"
        />
        {/* Crisp emerald eye dot for instant character recognition at 30px */}
        <circle cx="66.5" cy="44.5" r="2.1" fill="#05260C" />
      </g>
      {/* Glowing neon-green perimeter ring */}
      <circle cx="50" cy="50" r="44.5" fill="none" stroke="#00FF41" strokeWidth="2.8" />
    </svg>
  );
}

/**
 * The Grid (`thegrid00000`, sidebar `#02050A`):
 * Hollow Tron Identity Disc with glowing electric-cyan light blade ring,
 * dark metallic circuit channel, and opposing Tron orange arc accents.
 */
function TheGridMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const cyanBloom = `pn-tg-c-${uid}`;
  const disc = `pn-tg-d-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={cyanBloom} cx="50%" cy="50%" r="50%">
          <stop offset="68%" stopColor="#00D8FF" stopOpacity="0" />
          <stop offset="86%" stopColor="#00D8FF" stopOpacity="0.44" />
          <stop offset="100%" stopColor="#00D8FF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={disc} x1="15%" y1="15%" x2="85%" y2="85%">
          <stop offset="0%" stopColor="#1F4258" />
          <stop offset="50%" stopColor="#0A1A26" />
          <stop offset="100%" stopColor="#1A364A" />
        </linearGradient>
      </defs>
      {/* Outer cyan energy bloom */}
      <circle cx="50" cy="50" r="49" fill={`url(#${cyanBloom})`} />
      {/* Dark metallic disc track (hollow center) */}
      <circle cx="50" cy="50" r="32.5" fill="none" stroke={`url(#${disc})`} strokeWidth="17" />
      {/* 4 geometric diagonal segment notches across the dark disc body */}
      <g stroke="#02050A" strokeWidth="4.2" strokeLinecap="butt">
        <line x1="24" y1="24" x2="36" y2="36" />
        <line x1="76" y1="24" x2="64" y2="36" />
        <line x1="24" y1="76" x2="36" y2="64" />
        <line x1="76" y1="76" x2="64" y2="64" />
      </g>
      {/* Glowing outer Tron cyan blade ring */}
      <circle cx="50" cy="50" r="42.5" fill="none" stroke="#00D8FF" strokeWidth="5.2" />
      <circle cx="50" cy="50" r="42.5" fill="none" stroke="#D8FAFF" strokeWidth="1.8" />
      {/* Opposing cyan inner energy arcs (top-left & bottom-right) */}
      <path d="M27 36 A26.5 26.5 0 0 1 64 27" fill="none" stroke="#00D8FF" strokeWidth="4.4" strokeLinecap="round" />
      <path d="M27 36 A26.5 26.5 0 0 1 64 27" fill="none" stroke="#D8FAFF" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M73 64 A26.5 26.5 0 0 1 36 73" fill="none" stroke="#00D8FF" strokeWidth="4.4" strokeLinecap="round" />
      <path d="M73 64 A26.5 26.5 0 0 1 36 73" fill="none" stroke="#D8FAFF" strokeWidth="1.4" strokeLinecap="round" />
      {/* Rival team Tron orange energy arcs (top-right & bottom-left) */}
      <path d="M71 33 A26.5 26.5 0 0 1 75 56" fill="none" stroke="#FF7449" strokeWidth="5.2" strokeLinecap="round" />
      <path d="M71 33 A26.5 26.5 0 0 1 75 56" fill="none" stroke="#FFE4B8" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M29 67 A26.5 26.5 0 0 1 25 44" fill="none" stroke="#FF7449" strokeWidth="5.2" strokeLinecap="round" />
      <path d="M29 67 A26.5 26.5 0 0 1 25 44" fill="none" stroke="#FFE4B8" strokeWidth="1.6" strokeLinecap="round" />
      {/* Crisp cyan inner aperture ring framing the hollow center */}
      <circle cx="50" cy="50" r="19" fill="none" stroke="#00D8FF" strokeWidth="2.4" />
      <circle cx="50" cy="50" r="19" fill="none" stroke="#D8FAFF" strokeWidth="0.9" opacity="0.8" />
    </svg>
  );
}

/**
 * Grand Theft Notes (`grandtheftno`, sidebar `#070E1E`):
 * Vice City striped neon sunset (gold -> flamingo pink -> magenta) with
 * electric-cyan horizon shimmer and a sweeping midnight palm tree silhouette.
 */
function GrandTheftNotesMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const clip = `pn-gt-c-${uid}`;
  const sun = `pn-gt-s-${uid}`;
  const halo = `pn-gt-h-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><circle cx="50" cy="52" r="41" /></clipPath>
        <radialGradient id={halo} cx="50%" cy="52%" r="50%">
          <stop offset="68%" stopColor="#FF5E9C" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#5CE8F0" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={sun} x1="50%" y1="10%" x2="50%" y2="92%">
          <stop offset="0%" stopColor="#FFE169" />
          <stop offset="32%" stopColor="#FF829C" />
          <stop offset="66%" stopColor="#FF4791" />
          <stop offset="100%" stopColor="#B81674" />
        </linearGradient>
      </defs>
      {/* Neon flamingo-to-cyan dusk glow */}
      <circle cx="50" cy="52" r="48" fill={`url(#${halo})`} />
      {/* Striped Vice City sunset disc */}
      <g clipPath={`url(#${clip})`}>
        <circle cx="50" cy="52" r="41" fill={`url(#${sun})`} />
        {/* Iconic retro outrun horizontal horizon slices */}
        <rect x="6" y="61" width="88" height="3.2" fill="#070E1E" />
        <rect x="6" y="69" width="88" height="4.5" fill="#070E1E" />
        <rect x="6" y="78" width="88" height="6" fill="#070E1E" />
        {/* Electric-cyan water/horizon shimmer bars */}
        <rect x="14" y="85.5" width="72" height="3.5" rx="1.6" fill="#5CE8F0" />
        <rect x="26" y="90.5" width="48" height="2.4" rx="1.2" fill="#5CE8F0" opacity="0.75" />
      </g>
      {/* Crisp electric-cyan lower rim arc */}
      <path d="M16 74 A41 41 0 0 0 84 74" fill="none" stroke="#5CE8F0" strokeWidth="2.4" strokeLinecap="round" opacity="0.92" />
      {/* Gracefully sweeping midnight palm trunk */}
      <path
        d="M27 92 C33 74 42 56 54 39 L59.5 41 C49 58 42 75 37 92 Z"
        fill="#070E1E"
      />
      {/* Neon cyan rim glint along the right edge of the curved trunk */}
      <path
        d="M36 91 C41 75 48 58 58.5 42"
        fill="none"
        stroke="#5CE8F0"
        strokeWidth="1.8"
        strokeLinecap="round"
        opacity="0.84"
      />
      {/* 5 individually sculpted arching palm fronds fanning cleanly from the crown */}
      <g fill="#070E1E">
        {/* Upper-left sweeping frond */}
        <path d="M56 39 C45 26 29 22 14 31 C27 30 41 34 53 41 Z" />
        {/* Lower-left drooping frond */}
        <path d="M55 41 C40 37 26 42 17 54 C30 48 42 46 54 44 Z" />
        {/* Top crest frond breaking past the sun */}
        <path d="M56 39 C56 24 61 13 73 8 C68 18 65 28 61 39 Z" />
        {/* Upper-right sweeping frond */}
        <path d="M58 39 C70 27 83 25 94 34 C82 33 70 36 60 42 Z" />
        {/* Lower-right arching frond */}
        <path d="M58 42 C72 41 84 47 90 58 C79 51 69 48 57 45 Z" />
      </g>
      {/* Subtle flamingo-pink rim kiss along the upper fronds */}
      <path
        d="M19 29 C33 23 46 27 56 37 M58 35 C60 23 65 14 72 9 M61 37 C72 28 83 27 91 33"
        fill="none"
        stroke="#FF7AB2"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.75"
      />
    </svg>
  );
}

/**
 * Master Sword (`mastersword0`, sidebar `#0D1422`):
 * Free-form vertical Master Sword backed by a radiant Triforce gold emblem,
 * with sweeping royal-blue winged crossguard and gleaming double-edged blade.
 */
function MasterSwordMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const aura = `pn-ms-a-${uid}`;
  const wing = `pn-ms-w-${uid}`;
  const gold = `pn-ms-g-${uid}`;
  const bladeL = `pn-ms-l-${uid}`;
  const bladeR = `pn-ms-r-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={aura} cx="50%" cy="46%" r="48%">
          <stop offset="0%" stopColor="#60A5FA" stopOpacity="0.42" />
          <stop offset="56%" stopColor="#E8C547" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#0D1422" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={wing} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7AB8FF" />
          <stop offset="45%" stopColor="#2D6BE4" />
          <stop offset="100%" stopColor="#1B3C94" />
        </linearGradient>
        <linearGradient id={gold} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFF5BE" />
          <stop offset="48%" stopColor="#E8C547" />
          <stop offset="100%" stopColor="#A67B14" />
        </linearGradient>
        <linearGradient id={bladeL} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#CEDEF2" />
        </linearGradient>
        <linearGradient id={bladeR} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A5B8D4" />
          <stop offset="100%" stopColor="#6E82A1" />
        </linearGradient>
      </defs>
      {/* Ethereal Hylian steel-blue and Triforce-gold aura */}
      <circle cx="50" cy="48" r="46" fill={`url(#${aura})`} />
      {/* Bold radiant Triforce emblem framing the Master Sword behind the blade */}
      <g fill={`url(#${gold})`} stroke="#7D5A0B" strokeWidth="1.2" strokeLinejoin="round">
        <polygon points="50,36 37.5,57 62.5,57" />
        <polygon points="37.5,58 25,79 50,79" />
        <polygon points="62.5,58 50,79 75,79" />
      </g>
      {/* Subtle dark shadow under the blade so the steel pops cleanly over the Triforce */}
      <path d="M50 43 L61 48 L59 55 L58 84 L50 97 L42 84 L41 55 L39 48 Z" fill="#0D1422" opacity="0.58" />
      {/* Bold double-edged Master Sword blade */}
      <path d="M50 43 L39.5 47.5 L42 54.5 L43 83 L50 96.5 Z" fill={`url(#${bladeL})`} />
      <path d="M50 43 L60.5 47.5 L58 54.5 L57 83 L50 96.5 Z" fill={`url(#${bladeR})`} />
      <path
        d="M39.5 47.5 L42 54.5 L43 83 L50 96.5 L57 83 L58 54.5 L60.5 47.5"
        fill="none"
        stroke="#EEF5FF"
        strokeWidth="1.3"
        strokeLinejoin="round"
        opacity="0.82"
      />
      <line x1="50" y1="45" x2="50" y2="93.5" stroke="#FFFFFF" strokeWidth="1.7" opacity="0.9" />
      {/* Wrapped indigo grip + Triforce gold pommel */}
      <rect x="44.5" y="12.5" width="11" height="20" rx="2.2" fill="#1C3F78" stroke="#7AB8FF" strokeWidth="1.5" />
      <path d="M45 17.5 L55 21.5 M45 24 L55 28" stroke="#E8C547" strokeWidth="2" strokeLinecap="round" />
      <path d="M50 4.5 L57.5 11.5 L54.5 15 H45.5 L42.5 11.5 Z" fill={`url(#${gold})`} stroke="#7D5A0B" strokeWidth="1.3" />
      {/* Sweeping royal-blue winged crossguard */}
      <path
        d="M50 28
           L61 30.5 C72 29.5 82 24 91 18.5 C88 31 79 39.5 67 43.5 L56 46.5 L50 48.5
           L44 46.5 L33 43.5 C21 39.5 12 31 9 18.5 C18 24 28 29.5 39 30.5 Z"
        fill={`url(#${wing})`}
        stroke="#9BCBFF"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      {/* Wing feather highlights */}
      <path d="M16 25.5 C25 32 33 35.5 42 36.5 M84 25.5 C75 32 67 35.5 58 36.5" fill="none" stroke="#E0EFFF" strokeWidth="1.9" strokeLinecap="round" opacity="0.78" />
      {/* Gleaming Triforce-gold center gem */}
      <polygon points="50,30 57.5,38 50,46 42.5,38" fill={`url(#${gold})`} stroke="#7A5608" strokeWidth="1.5" />
      <polygon points="50,33.5 53.8,38 50,42 46.2,38" fill="#FFF8CC" opacity="0.82" />
    </svg>
  );
}

/**
 * Shrine (`shrine000000`, sidebar `#0F242C`):
 * Sculpted BotW Sheikah stone diamond crest with glowing cyan Sheikah Eye,
 * teardrop, and bold ancient amber corner inlays.
 */
function ShrineMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const stone = `pn-sh-s-${uid}`;
  const glow = `pn-sh-g-${uid}`;
  const amber = `pn-sh-m-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={stone} x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#2B5B6A" />
          <stop offset="50%" stopColor="#163540" />
          <stop offset="100%" stopColor="#0A1D24" />
        </linearGradient>
        <radialGradient id={glow} cx="50%" cy="52%" r="42%">
          <stop offset="0%" stopColor="#5AD8F5" stopOpacity="0.54" />
          <stop offset="65%" stopColor="#5AD8F5" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#5AD8F5" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={amber} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFDC8A" />
          <stop offset="100%" stopColor="#EB8F1E" />
        </linearGradient>
      </defs>
      {/* Carved octagonal/diamond Sheikah stone crest */}
      <path
        d="M50 5 L86 26 L93 50 L86 74 L50 95 L14 74 L7 50 L14 26 Z"
        fill={`url(#${stone})`}
        stroke="#4F93A8"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      {/* Recessed inner stone groove */}
      <path
        d="M50 11 L81 29 L87 50 L81 71 L50 89 L19 71 L13 50 L19 29 Z"
        fill="none"
        stroke="#0A1A20"
        strokeWidth="2"
      />
      {/* Bold ancient Sheikah amber corner inlays */}
      <polygon points="50,7.5 58,17 42,17" fill={`url(#${amber})`} />
      <polygon points="50,92.5 58,83 42,83" fill={`url(#${amber})`} />
      <polygon points="9.5,50 18.5,42.5 18.5,57.5" fill={`url(#${amber})`} />
      <polygon points="90.5,50 81.5,42.5 81.5,57.5" fill={`url(#${amber})`} />
      {/* Glowing cyan shrine core aura */}
      <circle cx="50" cy="52" r="34" fill={`url(#${glow})`} />
      {/* Three iconic upward Sheikah eyelashes */}
      <path d="M50 22 L50 32" stroke="#5AD8F5" strokeWidth="4.2" strokeLinecap="round" />
      <path d="M50 22 L50 32" stroke="#E0FCFF" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M32 27 L38 35" stroke="#5AD8F5" strokeWidth="4" strokeLinecap="round" />
      <path d="M32 27 L38 35" stroke="#E0FCFF" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M68 27 L62 35" stroke="#5AD8F5" strokeWidth="4" strokeLinecap="round" />
      <path d="M68 27 L62 35" stroke="#E0FCFF" strokeWidth="1.4" strokeLinecap="round" />
      {/* Luminous cyan almond eye outline */}
      <path
        d="M23 50 Q50 32 77 50 Q50 68 23 50 Z"
        fill="#0D2730"
        stroke="#5AD8F5"
        strokeWidth="4.4"
        strokeLinejoin="round"
      />
      <path
        d="M23 50 Q50 32 77 50 Q50 68 23 50 Z"
        fill="none"
        stroke="#DDFBFF"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* Glowing iris and bright core */}
      <circle cx="50" cy="50" r="9" fill="none" stroke="#5AD8F5" strokeWidth="3.6" />
      <circle cx="50" cy="50" r="4.2" fill="#ECFFFF" />
      {/* Iconic Sheikah teardrop */}
      <path
        d="M50 65.5 C50 65.5 56.5 73.5 56.5 77.5 A6.5 6.5 0 1 1 43.5 77.5 C43.5 73.5 50 65.5 50 65.5 Z"
        fill="#5AD8F5"
      />
      <circle cx="48.5" cy="77.5" r="2.2" fill="#ECFFFF" />
    </svg>
  );
}

/**
 * Wax Seal (`harrynoter00`, sidebar `#4A1012`):
 * Organic hand-poured scalloped crimson wax seal lifted off the scarlet
 * sidebar by a deep drop shadow, glossy wax rim, and gleaming embossed gold crest.
 */
function WaxSealMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const wax = `pn-ws-w-${uid}`;
  const well = `pn-ws-i-${uid}`;
  const gold = `pn-ws-g-${uid}`;

  // Distinct organic melted wax rim with natural hand-pressed lobes
  const waxPath =
    'M50 4 C58 3 63 8 71 9 C80 10 86 16 88 25 C90 32 95 38 95 47 C95 56 90 61 89 69 C88 78 82 85 73 88 C65 90 60 95 50 95 C41 95 36 90 27 89 C18 88 12 81 10 72 C9 64 4 58 5 49 C6 40 10 34 11 26 C12 17 19 11 28 9 C36 8 42 4.5 50 4 Z';

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={wax} cx="32%" cy="26%" r="74%">
          <stop offset="0%" stopColor="#F2424B" />
          <stop offset="42%" stopColor="#C71D26" />
          <stop offset="82%" stopColor="#850E15" />
          <stop offset="100%" stopColor="#5C070C" />
        </radialGradient>
        <radialGradient id={well} cx="68%" cy="72%" r="72%">
          <stop offset="0%" stopColor="#BC1C25" />
          <stop offset="55%" stopColor="#7A0C13" />
          <stop offset="100%" stopColor="#4A050A" />
        </radialGradient>
        <linearGradient id={gold} x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#FFF4BC" />
          <stop offset="45%" stopColor="#F0BE3A" />
          <stop offset="100%" stopColor="#AD750E" />
        </linearGradient>
      </defs>
      {/* Deep dark separation shadow so the crimson seal lifts cleanly off #4A1012 */}
      <g transform="translate(1.5 2.5)">
        <path d={waxPath} fill="#1C0204" opacity="0.86" />
      </g>
      {/* Sculpted glossy ruby-crimson wax body */}
      <path d={waxPath} fill={`url(#${wax})`} stroke="#2B0407" strokeWidth="1.6" />
      {/* Glossy melted wax rim catchlight */}
      <path
        d="M16 32 C20 18 33 10 50 9.5 C61 9.5 70 12.5 77 18"
        fill="none"
        stroke="#FFA8A3"
        strokeWidth="3.2"
        strokeLinecap="round"
        opacity="0.62"
      />
      {/* Deep stamped impression well */}
      <circle cx="50" cy="50" r="34.5" fill={`url(#${well})`} stroke="#45050A" strokeWidth="2.2" />
      <path d="M26 73 A33 33 0 0 0 74 27" fill="none" stroke="#E0414A" strokeWidth="1.6" opacity="0.55" />
      {/* Embossed Gryffindor gold outer seal ring + cardinal studs */}
      <circle cx="50" cy="50" r="31" fill="none" stroke={`url(#${gold})`} strokeWidth="3.4" />
      <circle cx="50" cy="19" r="2.3" fill="#FFF0A8" />
      <circle cx="50" cy="81" r="2.3" fill="#D8A024" />
      <circle cx="19" cy="50" r="2.3" fill="#F0BE3A" />
      <circle cx="81" cy="50" r="2.3" fill="#D8A024" />
      {/* Bold embossed gold crown + heraldic crest shield */}
      <path d="M38 33 L41.5 25 L46.2 29.5 L50 23.5 L53.8 29.5 L58.5 25 L62 33 Z" fill={`url(#${gold})`} />
      <path
        d="M32.5 36.5 L50 34.5 L67.5 36.5 V53.5 C67.5 65.5 50 74.5 50 74.5 C50 74.5 32.5 65.5 32.5 53.5 Z"
        fill={`url(#${gold})`}
        stroke="#633D05"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Recessed crimson shield field with bold gold lightning-bolt centerpiece */}
      <path
        d="M37.5 40.5 L50 39 L62.5 40.5 V53 C62.5 62 50 68.5 50 68.5 C50 68.5 37.5 62 37.5 53 Z"
        fill="#7C0E15"
      />
      <path d="M53 41.5 L42.5 54 H50.5 L47 65.5 L57.5 52.5 H49.5 Z" fill="#FFF2B0" />
    </svg>
  );
}

/**
 * Stranger Notes (`strangernote`, sidebar `#0E141A`):
 * Iconic 80s glowing neon-red horizontal framing bars around a dark Upside Down
 * silhouette torn open by an organic jagged crimson dimensional rift and spores.
 */
function StrangerNotesMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const riftGlow = `pn-sn-g-${uid}`;
  const riftCore = `pn-sn-c-${uid}`;
  const portal = `pn-sn-p-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={portal} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#4A0A10" />
          <stop offset="56%" stopColor="#172432" />
          <stop offset="100%" stopColor="#0A1017" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={riftGlow} cx="50%" cy="50%" r="44%">
          <stop offset="0%" stopColor="#FF3B3B" stopOpacity="0.95" />
          <stop offset="50%" stopColor="#E01B24" stopOpacity="0.44" />
          <stop offset="100%" stopColor="#FF3B3B" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={riftCore} x1="50%" y1="16%" x2="50%" y2="86%">
          <stop offset="0%" stopColor="#FF5959" />
          <stop offset="28%" stopColor="#FFD8D8" />
          <stop offset="50%" stopColor="#FFFFFF" />
          <stop offset="74%" stopColor="#FFD8D8" />
          <stop offset="100%" stopColor="#FF5959" />
        </linearGradient>
      </defs>
      {/* Atmospheric cold-slate Upside Down backdrop aura */}
      <ellipse cx="50" cy="51" rx="45" ry="38" fill={`url(#${portal})`} />
      {/* Creeping Upside Down vines silhouetted along left and right edges */}
      <path
        d="M11 29 C21 33 27 42 38 45 M10 67 C21 63 27 57 37 55 M16 49 C24 50 31 50 38 49"
        fill="none"
        stroke="#2C3F52"
        strokeWidth="3.8"
        strokeLinecap="round"
      />
      <path
        d="M89 31 C78 35 72 42 62 46 M90 68 C79 63 72 58 62 55 M84 50 C76 50 69 50 62 50"
        fill="none"
        stroke="#2C3F52"
        strokeWidth="3.8"
        strokeLinecap="round"
      />
      {/* Crimson edge-light kissing the vines closest to the dimensional rift */}
      <path d="M26 40 L38 45 M26 59 L37 55 M74 41 L62 46 M74 59 L62 55" stroke="#FF4E4E" strokeWidth="1.8" strokeLinecap="round" opacity="0.78" />
      {/* Blazing crimson rift aura */}
      <ellipse cx="50" cy="51" rx="28" ry="36" fill={`url(#${riftGlow})`} />
      {/* Branching energy cracks radiating from the dimensional tear */}
      <path
        d="M44 43 L33 37 M57 47 L69 41 M45 60 L35 65 M55 62 L67 66"
        stroke="#FF4A4A"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.82"
      />
      {/* Organic asymmetric jagged dimensional rift tearing down the center */}
      <path
        d="M52 17 L47 29 L57 39 L62 49 L54 58 L58 70 L48 85 L43 71 L38 59 L45 48 L40 37 L46 27 Z"
        fill="#FF2B2B"
        stroke="#FF7070"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {/* White-hot zigzagging dimensional rift core */}
      <path
        d="M51 21 L48 31 L54 41 L56 50 L50 59 L53 70 L48 81 L46 69 L43 59 L48 49 L44 38 L49 29 Z"
        fill={`url(#${riftCore})`}
      />
      {/* Iconic 80s glowing neon-red top title bar */}
      <line x1="10" y1="12" x2="90" y2="12" stroke="#FF2A2A" strokeWidth="9" strokeLinecap="round" opacity="0.34" />
      <line x1="10" y1="12" x2="90" y2="12" stroke="#FF4A4A" strokeWidth="4.6" strokeLinecap="round" />
      <line x1="12" y1="12" x2="88" y2="12" stroke="#FFDADA" strokeWidth="1.6" strokeLinecap="round" />
      {/* Matching split 80s neon-red bottom bars flanking the rift */}
      <line x1="10" y1="88" x2="36" y2="88" stroke="#FF2A2A" strokeWidth="9" strokeLinecap="round" opacity="0.34" />
      <line x1="10" y1="88" x2="36" y2="88" stroke="#FF4A4A" strokeWidth="4.6" strokeLinecap="round" />
      <line x1="12" y1="88" x2="35" y2="88" stroke="#FFDADA" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="64" y1="88" x2="90" y2="88" stroke="#FF2A2A" strokeWidth="9" strokeLinecap="round" opacity="0.34" />
      <line x1="64" y1="88" x2="90" y2="88" stroke="#FF4A4A" strokeWidth="4.6" strokeLinecap="round" />
      <line x1="65" y1="88" x2="88" y2="88" stroke="#FFDADA" strokeWidth="1.6" strokeLinecap="round" />
      {/* Drifting Upside Down ash spores */}
      <circle cx="24" cy="27" r="2.2" fill="#DCE6F0" opacity="0.82" />
      <circle cx="78" cy="27" r="2.1" fill="#FF9A94" opacity="0.9" />
      <circle cx="22" cy="73" r="2.2" fill="#FF9A94" opacity="0.86" />
      <circle cx="79" cy="73" r="2.1" fill="#DCE6F0" opacity="0.8" />
    </svg>
  );
}

/**
 * Brass Vault (`brassvault00`, sidebar `#101214`):
 * Machined brushed-steel circular bank vault door with locking lugs and a
 * heavy gleaming polished-brass 4-spoke handwheel.
 */
function BrassVaultMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const steel = `pn-bv-s-${uid}`;
  const drum = `pn-bv-d-${uid}`;
  const brass = `pn-bv-b-${uid}`;
  const hub = `pn-bv-h-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={steel} x1="12%" y1="10%" x2="88%" y2="90%">
          <stop offset="0%" stopColor="#949FA9" />
          <stop offset="42%" stopColor="#565E68" />
          <stop offset="80%" stopColor="#32373E" />
          <stop offset="100%" stopColor="#4C545E" />
        </linearGradient>
        <radialGradient id={drum} cx="42%" cy="38%" r="65%">
          <stop offset="0%" stopColor="#30353D" />
          <stop offset="72%" stopColor="#1A1D22" />
          <stop offset="100%" stopColor="#101216" />
        </radialGradient>
        <linearGradient id={brass} x1="15%" y1="12%" x2="85%" y2="88%">
          <stop offset="0%" stopColor="#FFF0B8" />
          <stop offset="35%" stopColor="#E6BE63" />
          <stop offset="72%" stopColor="#C49234" />
          <stop offset="100%" stopColor="#855E1A" />
        </linearGradient>
        <radialGradient id={hub} cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#FFF4C4" />
          <stop offset="55%" stopColor="#D9AD50" />
          <stop offset="100%" stopColor="#7A5615" />
        </radialGradient>
      </defs>
      {/* Heavy brushed-steel circular vault door */}
      <circle cx="50" cy="50" r="45.5" fill={`url(#${steel})`} stroke="#A6B0BA" strokeWidth="2" />
      {/* 4 machined brass locking bolt lugs at 12, 3, 6, 9 o'clock */}
      <rect x="46" y="7.5" width="8" height="7" rx="2" fill={`url(#${brass})`} stroke="#252930" strokeWidth="1.2" />
      <rect x="46" y="85.5" width="8" height="7" rx="2" fill={`url(#${brass})`} stroke="#252930" strokeWidth="1.2" />
      <rect x="7.5" y="46" width="7" height="8" rx="2" fill={`url(#${brass})`} stroke="#252930" strokeWidth="1.2" />
      <rect x="85.5" y="46" width="7" height="8" rx="2" fill={`url(#${brass})`} stroke="#252930" strokeWidth="1.2" />
      {/* Recessed dark steel wheel chamber */}
      <circle cx="50" cy="50" r="33.5" fill={`url(#${drum})`} stroke="#6B737D" strokeWidth="1.8" />
      {/* Subtle wheel drop shadow for 3D mechanical depth */}
      <g transform="translate(1.5 2.5)" opacity="0.52">
        <circle cx="50" cy="50" r="24" fill="none" stroke="#000000" strokeWidth="7" />
        <line x1="33" y1="33" x2="67" y2="67" stroke="#000000" strokeWidth="6.5" strokeLinecap="round" />
        <line x1="67" y1="33" x2="33" y2="67" stroke="#000000" strokeWidth="6.5" strokeLinecap="round" />
      </g>
      {/* Polished brass 4-spoke vault handwheel */}
      <line x1="33" y1="33" x2="67" y2="67" stroke={`url(#${brass})`} strokeWidth="6.5" strokeLinecap="round" />
      <line x1="67" y1="33" x2="33" y2="67" stroke={`url(#${brass})`} strokeWidth="6.5" strokeLinecap="round" />
      <circle cx="50" cy="50" r="24" fill="none" stroke={`url(#${brass})`} strokeWidth="6.8" />
      {/* Specular gleam along the upper-left wheel rim */}
      <path d="M32 34 A24 24 0 0 1 65 31" fill="none" stroke="#FFF6D1" strokeWidth="1.8" strokeLinecap="round" opacity="0.8" />
      {/* Central machined brass hub cap */}
      <circle cx="50" cy="50" r="10.5" fill={`url(#${hub})`} stroke="#5C3F0E" strokeWidth="1.6" />
      <circle cx="50" cy="50" r="3.4" fill="#3B290B" />
      <circle cx="49" cy="49" r="1.2" fill="#FFF2B8" opacity="0.8" />
    </svg>
  );
}

/**
 * Amber CRT (`ambercrt0000`, sidebar `#14100A`):
 * Chunky vintage CRT computer monitor on a pedestal base with a curved dark
 * phosphor glass screen, glowing amber prompt/text lines, and solid cursor.
 */
function AmberCrtMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const casing = `pn-ac-c-${uid}`;
  const stand = `pn-ac-t-${uid}`;
  const screen = `pn-ac-s-${uid}`;
  const clip = `pn-ac-p-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><rect x="14" y="18" width="72" height="47" rx="7" /></clipPath>
        <linearGradient id={casing} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7A6750" />
          <stop offset="48%" stopColor="#4A3E30" />
          <stop offset="100%" stopColor="#2C241B" />
        </linearGradient>
        <linearGradient id={stand} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#63523E" />
          <stop offset="100%" stopColor="#33291E" />
        </linearGradient>
        <radialGradient id={screen} cx="46%" cy="46%" r="64%">
          <stop offset="0%" stopColor="#5C3604" />
          <stop offset="58%" stopColor="#261603" />
          <stop offset="100%" stopColor="#120A01" />
        </radialGradient>
      </defs>
      {/* Monitor neck + flared retro pedestal base */}
      <rect x="38" y="74" width="24" height="9" fill="#33291E" />
      <path
        d="M30 82 H70 L76 90 C77 92 75.5 93.5 73 93.5 H27 C24.5 93.5 23 92 24 90 Z"
        fill={`url(#${stand})`}
        stroke="#9A8466"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      {/* Chunky vintage CRT monitor chassis */}
      <rect
        x="6"
        y="9.5"
        width="88"
        height="67"
        rx="10"
        fill={`url(#${casing})`}
        stroke="#A48D6D"
        strokeWidth="2.3"
      />
      {/* Top chassis catchlight */}
      <line x1="16" y1="12.5" x2="84" y2="12.5" stroke="#C9B18E" strokeWidth="1.8" strokeLinecap="round" opacity="0.65" />
      {/* Recessed curved amber phosphor CRT tube */}
      <rect x="13" y="17" width="74" height="49" rx="8" fill="#0D0802" stroke="#1E170F" strokeWidth="2" />
      <g clipPath={`url(#${clip})`}>
        <rect x="14" y="18" width="72" height="47" rx="7" fill={`url(#${screen})`} />
        {/* Soft phosphor bloom behind text */}
        <ellipse cx="47" cy="42" rx="31" ry="19" fill="#FFB000" opacity="0.18" />
        {/* Glowing amber prompt chevron + crisp terminal note lines */}
        <path d="M21 27.5 L27.5 31.5 L21 35.5" fill="none" stroke="#FFDC73" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="32" y="29" width="38" height="5" rx="2" fill="#FFB81C" />
        <rect x="33" y="30.2" width="35" height="2" rx="1" fill="#FFE8AB" opacity="0.85" />
        <rect x="21" y="40" width="51" height="5" rx="2" fill="#FFB000" />
        <rect x="21" y="51" width="29" height="5" rx="2" fill="#F5A600" />
        {/* Bright phosphor block cursor */}
        <rect x="54" y="48.5" width="9" height="9.5" rx="1.6" fill="#FFB000" opacity="0.42" />
        <rect x="55.5" y="49.8" width="6.5" height="7" rx="1.2" fill="#FFE68C" />
        {/* Subtle retro glass glare + delicate scanline texture */}
        <polygon points="14,18 44,18 24,65 14,65" fill="#FFE8B0" opacity="0.09" />
        <path d="M14 25 H86 M14 36 H86 M14 47 H86 M14 58 H86" stroke="#000000" strokeWidth="1" opacity="0.22" />
      </g>
      <rect x="14" y="18" width="72" height="47" rx="7" fill="none" stroke="#FFB000" strokeWidth="1.3" opacity="0.46" />
      {/* Bezel vent slots (left) & glowing amber power indicator LED (right) */}
      <line x1="16" y1="71.5" x2="26" y2="71.5" stroke="#1E170F" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="30" y1="71.5" x2="36" y2="71.5" stroke="#1E170F" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="81" cy="71.5" r="3.6" fill="#FFB000" opacity="0.38" />
      <circle cx="81" cy="71.5" r="2.2" fill="#FFD65C" />
    </svg>
  );
}

/**
 * Lazy-loaded registry of bespoke community theme sidebar icons.
 * Keyed by canonical community theme ID from `communityThemes.ts` (Note Boy
 * stays in `LogoIcon.tsx` because `AppIconPicker.tsx` also renders it directly).
 */
export const THEME_LOGOS: Record<CoreThemeLogoId, ComponentType<ThemeLogoProps>> = {
  darthvader00: DarthVaderMark,
  deathstar000: DeathStarMark,
  jedi00000000: JediMark,
  whiterabbit0: WhiteRabbitMark,
  thegrid00000: TheGridMark,
  grandtheftno: GrandTheftNotesMark,
  mastersword0: MasterSwordMark,
  shrine000000: ShrineMark,
  harrynoter00: WaxSealMark,
  strangernote: StrangerNotesMark,
  brassvault00: BrassVaultMark,
  ambercrt0000: AmberCrtMark,
};
