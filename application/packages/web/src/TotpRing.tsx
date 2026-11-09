/**
 * The 2FA code's two shared parts, for the app's vault item and the browser
 * extension's login rows: the countdown ring and the code split in two.
 */

/* ────────────────────────────────────────────────────────────────
 * TOTP countdown ring - a thin SVG circle that drains over the
 * code's period, red in the last 5 seconds. Static (full, muted)
 * when there's no code to count down (the locked teaser state).
 * ──────────────────────────────────────────────────────────────── */
export function TotpRing({ secondsLeft, period, danger, static: isStatic = false }: {
  secondsLeft: number;
  period: number;
  danger: boolean;
  static?: boolean;
}) {
  const r = 9;
  const circumference = 2 * Math.PI * r; // ~56.5
  const offset = isStatic ? 0 : circumference * (1 - secondsLeft / period);
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" className="shrink-0" aria-hidden="true">
      <circle cx={10} cy={10} r={r} fill="none" strokeWidth={2} stroke="currentColor" className="text-pn-muted/50" />
      <circle
        cx={10}
        cy={10}
        r={r}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        stroke="currentColor"
        className={isStatic ? 'text-pn-muted/50' : danger ? 'text-red-500' : 'text-accent'}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 10 10)"
        style={isStatic ? undefined : { transition: 'stroke-dashoffset 1s linear' }}
      />
    </svg>
  );
}

/** Split a code into two halves with a thin space between (6→3+3, 8→4+4, 7→4+3). */
export function groupTotpCode(code: string): string {
  const mid = Math.ceil(code.length / 2);
  return `${code.slice(0, mid)} ${code.slice(mid)}`;
}
