/**
 * The 2FA countdown bar: 2px, drains over the code's period, red in the last
 * 5 seconds (owner 2026-11-06, mockups/extension-2fa-countdown-06nov2026.html,
 * variant 2). Under each login's code, and as a live sample on its own
 * setting, still and dim while the setting is off (owner 2026-11-12).
 */
import { useEffect, useState } from 'react';
import { totpSecondsRemaining } from '@notes/shared';

/** The seconds the bar turns red. */
export const TOTP_RED_S = 5;

/** The time now, once a second. */
export function useSecondTick(on = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function TotpBar({ period, now, off = false, className = '' }: { period: number; now: number; off?: boolean; className?: string }) {
  const left = totpSecondsRemaining(period, now);
  return (
    <div aria-hidden="true" className={`h-0.5 overflow-hidden rounded-full bg-divider ${off ? 'opacity-40' : ''} ${className}`}>
      <div
        // A new code starts a new bar, so the refill does not animate.
        key={Math.floor(now / 1000 / period)}
        className={`h-full rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none ${off ? 'bg-pn-muted' : left <= TOTP_RED_S ? 'bg-danger' : 'bg-accent'}`}
        style={{ width: off ? '100%' : `${(left / period) * 100}%` }}
      />
    </div>
  );
}
