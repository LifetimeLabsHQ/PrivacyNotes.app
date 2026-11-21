import { useMemo, useSyncExternalStore } from 'react';
import type { DayKind } from './notesViewUtils';

/**
 * The Calendar legend's two device-local lists, one store each over one
 * helper: the item types the legend hides, and the trackers it shows on the
 * days. Comma lists in localStorage, never synced.
 * Spec: docs/internal/specs/calendar-pillar-spec.md, docs/internal/specs/tracker-focus-771.md (D7)
 */
function deviceList(key: string) {
  const listeners = new Set<() => void>();
  const read = (): string => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  };
  const set = (items: readonly string[]) => {
    try {
      if (items.length) localStorage.setItem(key, items.join(','));
      else localStorage.removeItem(key);
    } catch {
      // Storage refused: the list resets on the next load.
    }
    listeners.forEach((l) => l());
  };
  const useRaw = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, read);
  return { set, useRaw };
}

const hiddenKinds = deviceList('privacynotes.calendarHiddenKinds');
const shownTrackers = deviceList('privacynotes.calendarTrackers');

export function useHiddenKinds(): Set<DayKind> {
  const raw = hiddenKinds.useRaw();
  return useMemo(() => new Set(raw.split(',').filter(Boolean) as DayKind[]), [raw]);
}
export function setHiddenKinds(kinds: readonly DayKind[]): void {
  hiddenKinds.set(kinds);
}

/** The trackers the Calendar shows on its days, in the order they were switched on. */
export function useCalendarTrackers(): string[] {
  const raw = shownTrackers.useRaw();
  return useMemo(() => raw.split(',').filter(Boolean), [raw]);
}
export function setCalendarTrackers(ids: readonly string[]): void {
  shownTrackers.set([...new Set(ids)]);
}
