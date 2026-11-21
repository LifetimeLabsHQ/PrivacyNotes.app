import { useMemo } from 'react';
import { hasPin, isViewRelocked, shouldPromptForPin } from './pin';
import type { View } from './views';

/**
 * The protected sections that are shut now: shut with "Lock now" or just
 * protected, on a device with no PIN, or past the PIN window.
 *
 * Asked on every render, as `isNoteLocked` asks for a note: the window runs
 * out with time, which no dependency list sees. `usePinExpiryPoll` renders an
 * idle view when the answer changes; a view that is in use renders by itself.
 * The set keeps its identity while its members stay the same, so a list
 * filtered by it is filtered again only when a section opens or shuts.
 * Spec: docs/internal/specs/section-lock.md (section 6)
 */
export function useShutViews(protectedViews: readonly View[], timeoutMinutes: number): ReadonlySet<View> {
  const shut = protectedViews
    .filter((v) => isViewRelocked(v) || !hasPin() || shouldPromptForPin(timeoutMinutes))
    .join(',');
  return useMemo(() => new Set(shut ? (shut.split(',') as View[]) : []), [shut]);
}
