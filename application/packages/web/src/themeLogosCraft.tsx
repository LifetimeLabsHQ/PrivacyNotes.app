import { useId, type ComponentType } from 'react';
import type { CraftThemeLogoId } from './themeLogoResolver';
import type { ThemeLogoProps } from './themeLogos';

/**
 * Jack-o-Lantern (`jackolantern`, sidebar `#0A0710`):
 * Carved glowing Halloween pumpkin with warm candlelight radiating through
 * jagged grin and eyes against the violet-black midnight sidebar.
 */
function JackOLanternMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const aura = `pn-jl-a-${uid}`;
  const skin = `pn-jl-s-${uid}`;
  const fire = `pn-jl-f-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={aura} cx="50%" cy="56%" r="48%">
          <stop offset="0%" stopColor="#FF8C1A" stopOpacity="0.52" />
          <stop offset="68%" stopColor="#FF5E00" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#0A0710" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={skin} cx="38%" cy="38%" r="68%">
          <stop offset="0%" stopColor="#FFB347" />
          <stop offset="48%" stopColor="#F57A10" />
          <stop offset="86%" stopColor="#B84200" />
          <stop offset="100%" stopColor="#7A2400" />
        </radialGradient>
        <linearGradient id={fire} x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="48%" stopColor="#FFF099" />
          <stop offset="100%" stopColor="#FFB82E" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="56" r="47" fill={`url(#${aura})`} />
      {/* Gnarled moss-green pumpkin stem */}
      <path d="M46 27 C45 18 49 11 58 9 C56 15 55 20 56 27 Z" fill="#6BB554" stroke="#2D5720" strokeWidth="1.8" strokeLinejoin="round" />
      {/* Ribbed pumpkin lobes */}
      <ellipse cx="27" cy="58" rx="19" ry="28" fill="#B54100" stroke="#591C00" strokeWidth="1.8" />
      <ellipse cx="73" cy="58" rx="19" ry="28" fill="#B54100" stroke="#591C00" strokeWidth="1.8" />
      <ellipse cx="38" cy="58" rx="22" ry="31" fill={`url(#${skin})`} />
      <ellipse cx="62" cy="58" rx="22" ry="31" fill={`url(#${skin})`} />
      <ellipse cx="50" cy="58" rx="20" ry="32" fill={`url(#${skin})`} stroke="#8F3000" strokeWidth="1.4" />
      {/* Blazing candlelit carved eyes, nose, and jagged toothy grin */}
      <polygon points="34,40 22,54 44,53" fill={`url(#${fire})`} stroke="#3B0E00" strokeWidth="2.4" strokeLinejoin="round" />
      <polygon points="66,40 78,54 56,53" fill={`url(#${fire})`} stroke="#3B0E00" strokeWidth="2.4" strokeLinejoin="round" />
      <polygon points="50,52 45,61 55,61" fill={`url(#${fire})`} stroke="#3B0E00" strokeWidth="2" strokeLinejoin="round" />
      <path
        d="M24 65 L34 70 L37 65 L44 71 L50 66 L56 71 L63 65 L66 70 L76 65 C71 79 62 84 50 84 C38 84 29 79 24 65 Z"
        fill={`url(#${fire})`}
        stroke="#3B0E00"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Candy Cane (`candycane000`, sidebar `#FCEFF1`):
 * Glossy peppermint-striped candy cane outlined cleanly for contrast on blush
 * white, tied with a holly-green ribbon bow and festive crimson berry.
 */
function CandyCaneMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const clip = `pn-cc-c-${uid}`;
  const canePath = 'M34 38 C34 22 45 14 58 14 C71 14 80 23 80 35 C80 43 75 48 69 48 C63 48 60 44 60 39 C60 35 58 32 54 32 C50 32 48 35 48 41 L36 86 C35 90 31 92 27 91 C23 90 21 86 22 82 Z';

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><path d={canePath} /></clipPath>
      </defs>
      {/* Crisp glossy white peppermint base */}
      <path d={canePath} fill="#FFFFFF" />
      {/* Bold diagonal peppermint-red stripes clipped inside the cane */}
      <g clipPath={`url(#${clip})`} stroke="#C8102E" strokeWidth="9.5">
        <line x1="20" y1="22" x2="72" y2="8" />
        <line x1="24" y1="36" x2="88" y2="20" />
        <line x1="22" y1="51" x2="86" y2="35" />
        <line x1="16" y1="67" x2="62" y2="55" />
        <line x1="12" y1="83" x2="56" y2="71" />
        <line x1="14" y1="95" x2="48" y2="86" />
      </g>
      {/* Gloss highlight + crisp peppermint outline so white stripes pop on #FCEFF1 */}
      <path d="M38 35 C39 24 47 19 57 19" fill="none" stroke="#FFFFFF" strokeWidth="2.8" strokeLinecap="round" opacity="0.72" />
      <path d={canePath} fill="none" stroke="#8C0D22" strokeWidth="2.4" strokeLinejoin="round" />
      {/* Festive holly-green bow & twin leaves tied around the cane */}
      <path d="M40 53 C30 44 19 46 17 55 C25 60 34 59 41 56 Z" fill="#1F6B3A" stroke="#124223" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M46 55 C57 49 69 52 70 61 C61 65 52 62 45 58 Z" fill="#2A854A" stroke="#124223" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M43 58 L37 73 L43 69 L48 74 L46 58 Z" fill="#1F6B3A" stroke="#124223" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="43" cy="56" r="5" fill="#C8102E" stroke="#7A0A1D" strokeWidth="1.5" />
      <circle cx="41.5" cy="54.5" r="1.5" fill="#FF9AA8" />
    </svg>
  );
}

/**
 * Marmalade Sandwich (`marmaladesan`, sidebar `#E2E8EE`):
 * Chunky glass jar glowing with golden-orange marmalade, topped with a classic
 * red fabric cap and navy-blue coat-button label tag.
 */
function MarmaladeSandwichMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const jam = `pn-ms-j-${uid}`;
  const cap = `pn-ms-c-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={jam} x1="18%" y1="15%" x2="82%" y2="88%">
          <stop offset="0%" stopColor="#FFC145" />
          <stop offset="48%" stopColor="#E67A19" />
          <stop offset="100%" stopColor="#A63B0E" />
        </linearGradient>
        <linearGradient id={cap} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#DE3535" />
          <stop offset="100%" stopColor="#941818" />
        </linearGradient>
      </defs>
      {/* Plump glass marmalade jar */}
      <path
        d="M28 33 H72 C79 36 82 44 82 54 V76 C82 86 75 92 65 92 H35 C25 92 18 86 18 76 V54 C18 44 21 36 28 33 Z"
        fill={`url(#${jam})`}
        stroke="#4A220A"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      {/* Candied orange-peel flecks suspended in the marmalade */}
      <rect x="26" y="45" width="7" height="3.2" rx="1.4" transform="rotate(-18 26 45)" fill="#FFE08C" opacity="0.82" />
      <rect x="66" y="74" width="8" height="3.2" rx="1.4" transform="rotate(20 66 74)" fill="#FFE08C" opacity="0.78" />
      <rect x="27" y="76" width="7" height="3" rx="1.4" transform="rotate(14 27 76)" fill="#FFF0B8" opacity="0.72" />
      {/* Glossy curved glass jar highlight */}
      <path d="M25 46 V74 C25 79 27 83 31 85" fill="none" stroke="#FFFFFF" strokeWidth="3.4" strokeLinecap="round" opacity="0.58" />
      {/* Navy-blue coat-colored front jar label with cream frame */}
      <rect x="31" y="51" width="38" height="26" rx="4.5" fill="#1F4E9A" stroke="#F7F1E6" strokeWidth="2.4" />
      <circle cx="50" cy="64" r="7.5" fill="#F59E0B" />
      <circle cx="50" cy="64" r="4.5" fill="#FFE08C" />
      <path d="M50 56.5 V71.5 M42.5 64 H57.5" stroke="#B14416" strokeWidth="1.4" />
      {/* Iconic Paddington crimson scalloped fabric lid + ribbon tie */}
      <path
        d="M24 17 C24 11 33 8 50 8 C67 8 76 11 76 17 L79 28 C73 32 66 29 58 31 C52 33 48 33 42 31 C34 29 27 32 21 28 Z"
        fill={`url(#${cap})`}
        stroke="#5E0E0E"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="M27 29 H73" stroke="#1F4E9A" strokeWidth="4.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Honeycomb (`honeycomb000`, sidebar `#FBEFC9`):
 * Three interlocking sculpted golden-amber honeycomb cells with a glossy
 * honey drop dripping from the base.
 */
function HoneycombMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const cell = `pn-hc-c-${uid}`;
  const drop = `pn-hc-d-${uid}`;

  const hex = (cx: number, cy: number, r: number) => {
    const pts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(' ');
  };

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={cell} cx="35%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#FFE282" />
          <stop offset="52%" stopColor="#E69B19" />
          <stop offset="100%" stopColor="#9E5E00" />
        </radialGradient>
        <linearGradient id={drop} x1="30%" y1="10%" x2="75%" y2="90%">
          <stop offset="0%" stopColor="#FFE899" />
          <stop offset="50%" stopColor="#E69500" />
          <stop offset="100%" stopColor="#8A4B00" />
        </linearGradient>
      </defs>
      {/* 3 interlocking honey hexagons */}
      <g stroke="#6E4400" strokeWidth="3.4" strokeLinejoin="round">
        <polygon points={hex(34, 34, 21)} fill={`url(#${cell})`} />
        <polygon points={hex(68, 34, 21)} fill={`url(#${cell})`} />
        <polygon points={hex(51, 63, 21)} fill={`url(#${cell})`} />
      </g>
      {/* Inner translucent golden wax bevels */}
      <g fill="none" stroke="#FFF2B8" strokeWidth="2.1" opacity="0.72" strokeLinejoin="round">
        <polygon points={hex(34, 34, 14.5)} />
        <polygon points={hex(68, 34, 14.5)} />
        <polygon points={hex(51, 63, 14.5)} />
      </g>
      {/* Glossy golden honey droplet hanging from the bottom cell */}
      <path
        d="M51 73 C51 73 61 84 61 89 A10 10 0 1 1 41 89 C41 84 51 73 51 73 Z"
        fill={`url(#${drop})`}
        stroke="#6E4400"
        strokeWidth="2.2"
      />
      <ellipse cx="47.5" cy="88" rx="2.4" ry="3.8" transform="rotate(-15 47.5 88)" fill="#FFF7D4" opacity="0.85" />
    </svg>
  );
}

/**
 * Hazard (`hazard000000`, sidebar `#000000`):
 * Industrial octagonal caution-tape plaque with bold black-and-yellow warning
 * stripes framing a riveted matte-black core and a blazing yellow lightning bolt.
 */
function HazardMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const clip = `pn-hz-c-${uid}`;
  const yellow = `pn-hz-y-${uid}`;
  const glow = `pn-hz-g-${uid}`;
  const plate = `pn-hz-p-${uid}`;
  const oct = 'M30 7 H70 L93 30 V70 L70 93 H30 L7 70 V30 Z';

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><path d={oct} /></clipPath>
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="52%" stopColor="#FFD400" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={yellow} x1="15%" y1="10%" x2="85%" y2="90%">
          <stop offset="0%" stopColor="#FFF275" />
          <stop offset="48%" stopColor="#FFD400" />
          <stop offset="100%" stopColor="#D4A600" />
        </linearGradient>
        <linearGradient id={plate} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#262626" />
          <stop offset="100%" stopColor="#0B0B0B" />
        </linearGradient>
      </defs>
      {/* Subtle yellow industrial rim bloom on OLED black */}
      <circle cx="50" cy="50" r="48" fill={`url(#${glow})`} />
      {/* Caution-tape striped octagonal rim */}
      <g clipPath={`url(#${clip})`}>
        <rect width="100" height="100" fill={`url(#${yellow})`} />
        <g stroke="#111111" strokeWidth="10">
          <line x1="-10" y1="22" x2="22" y2="-10" />
          <line x1="-10" y1="48" x2="48" y2="-10" />
          <line x1="-10" y1="74" x2="74" y2="-10" />
          <line x1="-10" y1="100" x2="100" y2="-10" />
          <line x1="16" y1="110" x2="110" y2="16" />
          <line x1="42" y1="110" x2="110" y2="42" />
          <line x1="68" y1="110" x2="110" y2="68" />
        </g>
      </g>
      {/* Crisp outer industrial bevel */}
      <path d={oct} fill="none" stroke="#FFE854" strokeWidth="2.4" strokeLinejoin="round" />
      {/* Recessed heavy matte-black inner octagon plate */}
      <path
        d="M35 19 H65 L81 35 V65 L65 81 H35 L19 65 V35 Z"
        fill={`url(#${plate})`}
        stroke="#FFD400"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      {/* Four tiny machined corner bolts */}
      <circle cx="37" cy="25" r="1.8" fill="#A68B00" />
      <circle cx="63" cy="25" r="1.8" fill="#A68B00" />
      <circle cx="37" cy="75" r="1.8" fill="#A68B00" />
      <circle cx="63" cy="75" r="1.8" fill="#A68B00" />
      {/* Blazing high-voltage yellow hazard bolt */}
      <path
        d="M55 27 L34 54 H49 L44 74 L67 45 H52 Z"
        fill={`url(#${yellow})`}
        stroke="#FFF7AD"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Void Amethyst (`voidamethyst`, sidebar `#16171C`):
 * Sharp multi-faceted glowing violet crystal shard echoing Obsidian's signature
 * amethyst prism palette.
 */
function VoidAmethystMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const aura = `pn-va-a-${uid}`;
  const hi = `pn-va-h-${uid}`;
  const mid = `pn-va-m-${uid}`;
  const deep = `pn-va-d-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={aura} cx="50%" cy="50%" r="48%">
          <stop offset="0%" stopColor="#8A75F0" stopOpacity="0.52" />
          <stop offset="65%" stopColor="#6C4AE0" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#16171C" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={hi} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F0E8FF" />
          <stop offset="100%" stopColor="#B8A3FF" />
        </linearGradient>
        <linearGradient id={mid} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#9C84F8" />
          <stop offset="100%" stopColor="#6547D4" />
        </linearGradient>
        <linearGradient id={deep} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#5C3EC4" />
          <stop offset="100%" stopColor="#2B1969" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`url(#${aura})`} />
      {/* Faceted amethyst crystal planes */}
      <polygon points="56,6 24,33 44,44" fill={`url(#${hi})`} />
      <polygon points="56,6 44,44 76,34" fill={`url(#${mid})`} />
      <polygon points="24,33 17,67 44,44" fill={`url(#${mid})`} />
      <polygon points="44,44 17,67 45,94" fill={`url(#${deep})`} />
      <polygon points="44,44 45,94 67,69" fill={`url(#${mid})`} />
      <polygon points="44,44 76,34 67,69" fill={`url(#${hi})`} opacity="0.88" />
      <polygon points="76,34 83,60 67,69" fill={`url(#${deep})`} />
      <polygon points="45,94 67,69 83,60" fill="#3B238A" />
      {/* Crisp luminous crystal ridge highlights */}
      <path
        d="M56 6 L24 33 L17 67 L45 94 L83 60 L76 34 Z"
        fill="none"
        stroke="#DFD4FF"
        strokeWidth="2"
        strokeLinejoin="round"
        opacity="0.82"
      />
      <path d="M56 6 L44 44 L45 94 M24 33 L44 44 L76 34" fill="none" stroke="#FFFFFF" strokeWidth="1.4" opacity="0.55" />
    </svg>
  );
}

/**
 * Terminal (`terminal0000`, sidebar `#0E1214`):
 * Sleek modern dark developer terminal window badge with subtle traffic dots
 * and a bold glowing mint-green `>_` command prompt.
 */
function TerminalMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const bg = `pn-tm-b-${uid}`;
  const glow = `pn-tm-g-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={bg} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1D272D" />
          <stop offset="100%" stopColor="#0C1114" />
        </linearGradient>
        <radialGradient id={glow} cx="46%" cy="58%" r="44%">
          <stop offset="0%" stopColor="#63F2AB" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#0C1114" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* Sleek modern rounded terminal frame */}
      <rect x="7" y="12" width="86" height="76" rx="14" fill={`url(#${bg})`} stroke="#45666B" strokeWidth="2.6" />
      {/* Top title bar strip + minimalist dots */}
      <path d="M7 26 C7 18 13 12 21 12 H79 C87 12 93 18 93 26 V31 H7 Z" fill="#233038" />
      <line x1="7" y1="31" x2="93" y2="31" stroke="#364C54" strokeWidth="1.6" />
      <circle cx="20" cy="21.5" r="3" fill="#FF6E7A" />
      <circle cx="30" cy="21.5" r="3" fill="#F0C674" />
      <circle cx="40" cy="21.5" r="3" fill="#63F2AB" />
      {/* Soft mint inner phosphor glow */}
      <rect x="9" y="32" width="82" height="54" rx="11" fill={`url(#${glow})`} />
      {/* Razor-sharp glowing mint `>_` prompt */}
      <path
        d="M23 47 L42 59 L23 71"
        fill="none"
        stroke="#63F2AB"
        strokeWidth="8.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.34"
      />
      <path
        d="M23 47 L42 59 L23 71"
        fill="none"
        stroke="#63F2AB"
        strokeWidth="5.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M23 47 L42 59 L23 71"
        fill="none"
        stroke="#DCFFEE"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="49" y="64.5" width="26" height="7" rx="3" fill="#63F2AB" />
      <rect x="51" y="66" width="22" height="2.4" rx="1.2" fill="#DCFFEE" opacity="0.85" />
    </svg>
  );
}

/**
 * Outrun (`outrun000000`, sidebar `#1A1040`):
 * Electric-cyan synthwave diamond viewport with glowing hot-pink twin vector
 * mountain peaks rising above a neon cyan perspective laser grid.
 */
function OutrunMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const clip = `pn-or-c-${uid}`;
  const sky = `pn-or-s-${uid}`;
  const peak = `pn-or-p-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}><polygon points="50,6 94,50 50,94 6,50" /></clipPath>
        <linearGradient id={sky} x1="50%" y1="6%" x2="50%" y2="94%">
          <stop offset="0%" stopColor="#120929" />
          <stop offset="54%" stopColor="#3B1266" />
          <stop offset="56%" stopColor="#170A38" />
          <stop offset="100%" stopColor="#0A061A" />
        </linearGradient>
        <linearGradient id={peak} x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" stopColor="#FF81C5" />
          <stop offset="100%" stopColor="#B80D6A" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="100" height="100" fill={`url(#${sky})`} />
        {/* Warm synthwave glow orb behind mountain peaks */}
        <circle cx="50" cy="48" r="19" fill="#FF4EB8" opacity="0.85" />
        <circle cx="50" cy="44" r="14" fill="#FFB347" opacity="0.88" />
        {/* Twin jagged neon-magenta synthwave wireframe peaks */}
        <polygon points="8,57 34,30 52,57" fill="#1E0B42" stroke={`url(#${peak})`} strokeWidth="2.8" strokeLinejoin="round" />
        <polygon points="40,57 65,26 92,57" fill="#170936" stroke={`url(#${peak})`} strokeWidth="2.8" strokeLinejoin="round" />
        {/* Glowing neon-cyan perspective horizon grid */}
        <line x1="6" y1="57" x2="94" y2="57" stroke="#2CF2FF" strokeWidth="2.8" />
        <g stroke="#2CF2FF" strokeWidth="1.8" opacity="0.88">
          <line x1="14" y1="65" x2="86" y2="65" />
          <line x1="22" y1="75" x2="78" y2="75" />
          <line x1="34" y1="86" x2="66" y2="86" />
          <line x1="50" y1="57" x2="50" y2="94" />
          <line x1="36" y1="57" x2="20" y2="84" />
          <line x1="64" y1="57" x2="80" y2="84" />
        </g>
      </g>
      {/* Razor-sharp electric-cyan neon diamond frame */}
      <polygon points="50,6 94,50 50,94 6,50" fill="none" stroke="#2CF2FF" strokeWidth="3.6" strokeLinejoin="round" />
      <polygon points="50,6 94,50 50,94 6,50" fill="none" stroke="#DCF9FF" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Sailcloth (`sailcloth000`, sidebar `#F6E6CF`):
 * Sunlit cream-white billowing sails and deep harbor-teal hull riding across a
 * crisp ocean wave arc.
 */
function SailclothMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const sail = `pn-sc-s-${uid}`;
  const hull = `pn-sc-h-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={sail} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#E8DFCE" />
        </linearGradient>
        <linearGradient id={hull} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#268590" />
          <stop offset="100%" stopColor="#144D54" />
        </linearGradient>
      </defs>
      {/* Mast */}
      <line x1="51" y1="10" x2="51" y2="70" stroke="#4D3724" strokeWidth="3.4" strokeLinecap="round" />
      {/* Tiny harbor pennant at masthead */}
      <polygon points="51,10 66,14 51,18" fill="#1F6F78" />
      {/* Sweeping main sail (right) & jib sail (left) */}
      <path
        d="M54 16 C73 30 82 48 80 65 L54 65 Z"
        fill={`url(#${sail})`}
        stroke="#1F6F78"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="M47 24 C32 36 22 50 20 65 L47 65 Z"
        fill="#FFFBF2"
        stroke="#1F6F78"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* Deep harbor-teal hull */}
      <path
        d="M15 69 H85 L76 82 H25 Z"
        fill={`url(#${hull})`}
        stroke="#0E383D"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <line x1="22" y1="74" x2="79" y2="74" stroke="#F6E6CF" strokeWidth="1.8" opacity="0.65" />
      {/* Crisp curving ocean wave below the hull */}
      <path
        d="M10 86 Q24 79 38 86 T66 86 T90 86"
        fill="none"
        stroke="#1F6F78"
        strokeWidth="4.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Risograph (`risograph000`, sidebar `#F4EFD9`):
 * Overlapping three-ink Risograph circles in fluorescent pink, cyan-blue, and
 * deep teal with a crisp offset print registration crosshair.
 */
function RisographMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      {/* Three translucent riso ink circles overlapping in multiply mode */}
      <circle cx="50" cy="34" r="26" fill="#CF0074" fillOpacity="0.86" style={{ mixBlendMode: 'multiply' }} />
      <circle cx="34" cy="62" r="26" fill="#0077A8" fillOpacity="0.86" style={{ mixBlendMode: 'multiply' }} />
      <circle cx="66" cy="62" r="26" fill="#096168" fillOpacity="0.86" style={{ mixBlendMode: 'multiply' }} />
      {/* Subtle halftone dot accents inside the upper lobes */}
      <circle cx="50" cy="21" r="2.2" fill="#FFF8EE" opacity="0.65" />
      <circle cx="21" cy="67" r="2.2" fill="#FFF8EE" opacity="0.65" />
      <circle cx="79" cy="67" r="2.2" fill="#FFF8EE" opacity="0.65" />
      {/* Crisp white offset-print registration mark at center */}
      <circle cx="50" cy="52" r="9.5" fill="none" stroke="#FFFBF4" strokeWidth="2.4" />
      <line x1="50" y1="38" x2="50" y2="66" stroke="#FFFBF4" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="36" y1="52" x2="64" y2="52" stroke="#FFFBF4" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Zen Garden (`zengarden000`, sidebar `#1D1F22`):
 * Balanced cairn stack of three smooth river stones above raked sand ripples,
 * accented by a fresh moss-green bonsai sprig.
 */
function ZenGardenMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const stone = `pn-zg-s-${uid}`;
  const leaf = `pn-zg-l-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={stone} cx="35%" cy="28%" r="70%">
          <stop offset="0%" stopColor="#B8C0C4" />
          <stop offset="52%" stopColor="#6E767C" />
          <stop offset="100%" stopColor="#383D42" />
        </radialGradient>
        <linearGradient id={leaf} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A6ED7E" />
          <stop offset="100%" stopColor="#468C2A" />
        </linearGradient>
      </defs>
      {/* Subtle raked Zen garden gravel ripple arcs at base */}
      <path d="M12 84 Q50 93 88 84" fill="none" stroke="#7A8288" strokeWidth="2.4" strokeLinecap="round" opacity="0.65" />
      <path d="M22 91 Q50 97 78 91" fill="none" stroke="#5D646B" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
      {/* Balanced stack of 3 sculpted river stones */}
      <ellipse cx="48" cy="72" rx="31" ry="13" fill={`url(#${stone})`} stroke="#25282C" strokeWidth="1.8" />
      <ellipse cx="46" cy="51" rx="22" ry="11" fill={`url(#${stone})`} stroke="#25282C" strokeWidth="1.8" />
      <ellipse cx="49" cy="33" rx="14" ry="8.5" fill={`url(#${stone})`} stroke="#25282C" strokeWidth="1.8" />
      {/* Soft top catchlights on each stone */}
      <path d="M31 66 Q44 62 57 65" fill="none" stroke="#DCE2E5" strokeWidth="2" strokeLinecap="round" opacity="0.45" />
      <path d="M34 46 Q45 43 55 46" fill="none" stroke="#DCE2E5" strokeWidth="1.8" strokeLinecap="round" opacity="0.45" />
      {/* Fresh moss-green bamboo/bonsai sprig sprouting beside the cairn */}
      <path d="M67 60 C72 47 75 34 83 22" fill="none" stroke="#6BBF45" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M74 44 C77 32 86 25 93 26 C90 36 82 43 74 44 Z" fill={`url(#${leaf})`} stroke="#2B591A" strokeWidth="1.3" />
      <path d="M71 52 C64 43 63 32 69 25 C75 33 76 44 71 52 Z" fill={`url(#${leaf})`} stroke="#2B591A" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * City Pop (`citypop00000`, sidebar `#D5C6E8`):
 * Glossy indigo vinyl record emerging from a Hiroshi Nagai pool-blue & pastel
 * coral jacket sleeve.
 */
function CityPopMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const vinyl = `pn-cp2-v-${uid}`;
  const sleeve = `pn-cp2-s-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={vinyl} cx="35%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#314B73" />
          <stop offset="48%" stopColor="#14263F" />
          <stop offset="100%" stopColor="#0A1424" />
        </radialGradient>
        <linearGradient id={sleeve} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#F6D3CF" />
          <stop offset="56%" stopColor="#F2A7B3" />
          <stop offset="58%" stopColor="#055986" />
          <stop offset="100%" stopColor="#033F63" />
        </linearGradient>
      </defs>
      {/* Glossy 12-inch vinyl record peeking out to the right */}
      <circle cx="62" cy="50" r="34" fill={`url(#${vinyl})`} stroke="#0A1424" strokeWidth="2" />
      <circle cx="62" cy="50" r="27" fill="none" stroke="#4D71A8" strokeWidth="1.2" opacity="0.52" />
      <circle cx="62" cy="50" r="21" fill="none" stroke="#4D71A8" strokeWidth="1.2" opacity="0.45" />
      <circle cx="62" cy="50" r="13.5" fill="#F2859C" stroke="#FFF2F0" strokeWidth="1.6" />
      <circle cx="62" cy="50" r="3.6" fill="#14263F" />
      {/* Square Hiroshi Nagai poolside pastel-and-pool-blue album sleeve */}
      <rect x="8" y="16" width="54" height="68" rx="4.5" fill={`url(#${sleeve})`} stroke="#14263F" strokeWidth="2.4" />
      {/* Sunlit cream sun + pool shimmer lines on the jacket art */}
      <circle cx="35" cy="37" r="10.5" fill="#FFF7F0" />
      <line x1="16" y1="64" x2="54" y2="64" stroke="#85D6F5" strokeWidth="2.4" strokeLinecap="round" opacity="0.8" />
      <line x1="22" y1="72" x2="48" y2="72" stroke="#85D6F5" strokeWidth="2.2" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

/**
 * Graveyard Fog (`graveyardfog`, sidebar `#151815`):
 * Moss-lit full crescent moon rising behind a weathered gothic tombstone arch
 * and curling mist bank.
 */
function GraveyardFogMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const glow = `pn-gf-g-${uid}`;
  const stone = `pn-gf-s-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={glow} cx="64%" cy="32%" r="44%">
          <stop offset="0%" stopColor="#C2DEAF" stopOpacity="0.46" />
          <stop offset="100%" stopColor="#151815" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={stone} x1="20%" y1="15%" x2="80%" y2="90%">
          <stop offset="0%" stopColor="#5D695B" />
          <stop offset="52%" stopColor="#353C34" />
          <stop offset="100%" stopColor="#1E231E" />
        </linearGradient>
      </defs>
      <circle cx="62" cy="34" r="40" fill={`url(#${glow})`} />
      {/* Pale moss-green harvest crescent moon */}
      <path d="M68 11 A20 20 0 1 0 82 42 A15 15 0 1 1 68 11 Z" fill="#C4E6AE" />
      {/* Weathered arched gothic tombstone */}
      <path
        d="M24 84 V45 C24 27 36 18 50 18 C64 18 76 27 76 45 V84 Z"
        fill={`url(#${stone})`}
        stroke="#92B086"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="M31 78 V46 C31 33 40 26 50 26 C60 26 69 33 69 46 V78" fill="none" stroke="#1F241F" strokeWidth="2" />
      {/* Crisp carved gothic cross motif */}
      <line x1="50" y1="35" x2="50" y2="62" stroke="#A8D08D" strokeWidth="4.2" strokeLinecap="round" />
      <line x1="39" y1="45" x2="61" y2="45" stroke="#A8D08D" strokeWidth="4.2" strokeLinecap="round" />
      {/* Swirling graveyard fog ribbons across the base */}
      <path d="M10 83 Q30 76 50 82 T90 80" fill="none" stroke="#A8D08D" strokeWidth="5.2" strokeLinecap="round" opacity="0.82" />
      <path d="M18 91 Q42 86 64 91 T86 89" fill="none" stroke="#DDE6D8" strokeWidth="3.6" strokeLinecap="round" opacity="0.65" />
    </svg>
  );
}

/**
 * Cranberry (`cranberry000`, sidebar `#140A0D`):
 * Cluster of three glossy ruby-bright cranberries nestled against two crisp
 * autumn sage leaves.
 */
function CranberryMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const berry = `pn-cb-b-${uid}`;
  const leaf = `pn-cb-l-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={berry} cx="34%" cy="28%" r="68%">
          <stop offset="0%" stopColor="#FFA8B3" />
          <stop offset="36%" stopColor="#E85A6B" />
          <stop offset="78%" stopColor="#A62235" />
          <stop offset="100%" stopColor="#5C0E1B" />
        </radialGradient>
        <linearGradient id={leaf} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A6E092" />
          <stop offset="100%" stopColor="#4E8242" />
        </linearGradient>
      </defs>
      {/* Twin autumn sage leaves */}
      <path d="M46 38 C32 23 19 19 10 24 C14 36 25 46 43 45 Z" fill={`url(#${leaf})`} stroke="#2B4D24" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M52 38 C64 21 78 16 89 20 C85 33 74 44 55 44 Z" fill={`url(#${leaf})`} stroke="#2B4D24" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M42 40 L21 28 M55 39 L78 25" stroke="#D8F5CC" strokeWidth="1.6" strokeLinecap="round" opacity="0.72" />
      {/* Stems */}
      <path d="M49 20 C49 30 49 36 49 42" fill="none" stroke="#8C5A4C" strokeWidth="3.2" strokeLinecap="round" />
      {/* 3 plump glossy ruby cranberries */}
      <circle cx="33" cy="58" r="20" fill={`url(#${berry})`} stroke="#450A14" strokeWidth="1.8" />
      <circle cx="67" cy="58" r="20" fill={`url(#${berry})`} stroke="#450A14" strokeWidth="1.8" />
      <circle cx="50" cy="70" r="21" fill={`url(#${berry})`} stroke="#450A14" strokeWidth="1.8" />
      {/* Crisp specular gloss drops */}
      <ellipse cx="26" cy="51" rx="4.5" ry="2.8" transform="rotate(-30 26 51)" fill="#FFD9DE" opacity="0.82" />
      <ellipse cx="60" cy="51" rx="4.5" ry="2.8" transform="rotate(-30 60 51)" fill="#FFD9DE" opacity="0.82" />
      <ellipse cx="43" cy="62" rx="5" ry="3" transform="rotate(-30 43 62)" fill="#FFE6EA" opacity="0.88" />
    </svg>
  );
}

/**
 * CyberGrid OLED (`cybergridole`, sidebar `#000000`):
 * Glowing isometric neon-violet wireframe cyber cube enclosing a suspended
 * electric-teal energy core against true OLED black.
 */
function CyberGridOledMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  const uid = useId().replace(/:/g, '');
  const glow = `pn-cg-g-${uid}`;
  const core = `pn-cg-c-${uid}`;

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#AB47F2" stopOpacity="0.45" />
          <stop offset="65%" stopColor="#7928CA" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={core} cx="42%" cy="38%" r="65%">
          <stop offset="0%" stopColor="#E6FFF9" />
          <stop offset="52%" stopColor="#00F5D4" />
          <stop offset="100%" stopColor="#008F7A" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="47" fill={`url(#${glow})`} />
      {/* Translucent dark cyber cube faces */}
      <polygon points="50,9 87,30 87,70 50,91 13,70 13,30" fill="#120621" />
      <polygon points="50,9 87,30 50,51 13,30" fill="#2A0F4D" opacity="0.85" />
      {/* Internal wireframe grid lines */}
      <path d="M31.5 19.5 L68.5 40.5 M68.5 19.5 L31.5 40.5" stroke="#AB47F2" strokeWidth="1.4" opacity="0.52" />
      {/* Glowing electric-teal suspended core */}
      <polygon points="50,34 64,42 64,58 50,66 36,58 36,42" fill={`url(#${core})`} />
      <polygon points="50,39 58,44 50,49 42,44" fill="#FFFFFF" opacity="0.72" />
      {/* Vivid neon-violet wireframe cube edges */}
      <polygon points="50,9 87,30 87,70 50,91 13,70 13,30" fill="none" stroke="#AB47F2" strokeWidth="4.2" strokeLinejoin="round" />
      <path d="M13 30 L50 51 L87 30 M50 51 V91" fill="none" stroke="#C77DFF" strokeWidth="3.2" strokeLinejoin="round" />
      <polygon points="50,9 87,30 87,70 50,91 13,70 13,30" fill="none" stroke="#F0D8FF" strokeWidth="1.2" strokeLinejoin="round" opacity="0.85" />
    </svg>
  );
}

/**
 * RGB Madness (`rgbmadness00`, sidebar `#0F0F0F`):
 * Blazing additive pure-channel RGB triad (#FF0000, #00FF00, #0000FF) overlapping
 * cleanly in screen mode into yellow, cyan, magenta, and pure white center.
 */
function RgbMadnessMark({ className = 'w-full h-full' }: ThemeLogoProps) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      {/* Crisp black octagon stage */}
      <polygon points="50,5 86,20 95,50 86,80 50,95 14,80 5,50 14,20" fill="#000000" stroke="#FFFFFF" strokeWidth="2.4" />
      {/* Pure 0/F RGB additive circles overlapping in screen mode */}
      <g style={{ isolation: 'isolate' }}>
        <circle cx="50" cy="36" r="24" fill="#FF0000" style={{ mixBlendMode: 'screen' }} />
        <circle cx="35" cy="62" r="24" fill="#00FF00" style={{ mixBlendMode: 'screen' }} />
        <circle cx="65" cy="62" r="24" fill="#0000FF" style={{ mixBlendMode: 'screen' }} />
      </g>
      {/* Crisp center white prism highlight */}
      <polygon points="50,43 58,57 42,57" fill="#FFFFFF" />
    </svg>
  );
}

export const CRAFT_THEME_LOGOS: Record<CraftThemeLogoId, ComponentType<ThemeLogoProps>> = {
  jackolantern: JackOLanternMark,
  candycane000: CandyCaneMark,
  marmaladesan: MarmaladeSandwichMark,
  honeycomb000: HoneycombMark,
  hazard000000: HazardMark,
  voidamethyst: VoidAmethystMark,
  terminal0000: TerminalMark,
  outrun000000: OutrunMark,
  sailcloth000: SailclothMark,
  risograph000: RisographMark,
  zengarden000: ZenGardenMark,
  citypop00000: CityPopMark,
  graveyardfog: GraveyardFogMark,
  cranberry000: CranberryMark,
  cybergridole: CyberGridOledMark,
  rgbmadness00: RgbMadnessMark,
};
