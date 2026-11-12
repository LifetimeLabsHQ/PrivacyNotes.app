/**
 * A button that says what it did: its words roll to "Saving..." with a
 * spinner, then to the done words with a check, a green tint and one soft
 * ring, and it stays done until the popup closes, as Bookmarked always did.
 * A button that opens already done (a page bookmarked before) does not play.
 * Spec: docs/internal/design/patterns/171-180.md (pattern 177); picture mockups/browser-extension-redesign-11nov2026.html (round 3, D)
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Spinner } from '@web/ui/feedback';

export type SaveState = 'idle' | 'busy' | 'done';

/** How long a sheet's Save shows Saved before the sheet closes. */
export const DONE_HOLD_MS = 600;

export function SaveButton({ state, icon, label, busyLabel, doneLabel, variant = 'secondary', onClick, type = 'button', disabled = false, className = '' }: {
  state: SaveState;
  icon: ReactNode;
  label: ReactNode;
  busyLabel: ReactNode;
  doneLabel: ReactNode;
  variant?: 'primary' | 'secondary';
  /** A form's Save submits the form instead. */
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
  className?: string;
}) {
  // Only a change plays; a button born done stays still.
  const was = useRef(state);
  const [playing, setPlay] = useState(false);
  // The render that brings the change plays at once; the state keeps it on
  // for the length of the motion.
  const play = playing || was.current !== state;
  useEffect(() => {
    if (was.current === state) return;
    was.current = state;
    setPlay(true);
    const timer = window.setTimeout(() => setPlay(false), 800);
    return () => window.clearTimeout(timer);
  }, [state]);
  const glyph = state === 'busy' ? <Spinner /> : state === 'done' ? <Check aria-hidden="true" className={`shrink-0${play ? ' pn-pop' : ''}`} /> : icon;
  return (
    <Button
      icon={glyph}
      variant={state === 'done' ? 'successSoft' : variant}
      type={type}
      onClick={onClick}
      disabled={state === 'busy' || (state === 'idle' && disabled)}
      aria-disabled={state === 'done' || undefined}
      className={`${state === 'done' ? 'pointer-events-none' : ''}${play && state === 'done' ? ' pn-save-done' : ''}${className ? ` ${className}` : ''}`}
    >
      <span key={state} className={play ? 'pn-roll' : undefined}>
        {state === 'busy' ? busyLabel : state === 'done' ? doneLabel : label}
      </span>
    </Button>
  );
}
