import { createContext, useSyncExternalStore } from 'react';

/**
 * The tracker in focus in Journals: the list shows only the entries that
 * hold it, and Statistics opens on its page. One tracker at a time, kept on this
 * device until the person clears it, never synced. A yes or no tracker and a
 * tag set take an answer (Yes by default); a tag set may name one tag.
 * Spec: docs/internal/specs/tracker-focus-771.md (D1 to D5)
 */
export type FocusAnswer = 'yes' | 'no' | 'any';
export interface TrackerFocus {
  /** The tracker's registry id (`trackerRegistry.ts`). */
  id: string;
  answer?: FocusAnswer;
  /** A factor id or an emotion key, for a tag set. */
  tag?: string;
}

const KEY = 'privacynotes.journalTrackerFocus';
const listeners = new Set<() => void>();

function readRaw(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** The stored focus, or null when there is none or the value is not one we wrote. */
export function parseFocus(raw: string): TrackerFocus | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const { id, answer, tag } = v as Record<string, unknown>;
    if (typeof id !== 'string' || !id || id.length > 200) return null;
    return {
      id,
      ...(answer === 'yes' || answer === 'no' || answer === 'any' ? { answer } : {}),
      ...(typeof tag === 'string' && tag && tag.length <= 200 ? { tag } : {}),
    };
  } catch {
    return null;
  }
}

let cachedRaw: string | null = null;
let cached: TrackerFocus | null = null;
function snapshot(): TrackerFocus | null {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseFocus(raw);
  }
  return cached;
}

export function useTrackerFocus(): TrackerFocus | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, snapshot);
}

export function setTrackerFocus(focus: TrackerFocus | null): void {
  try {
    if (focus) localStorage.setItem(KEY, JSON.stringify(focus));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage refused (a private window): the focus cannot be kept.
  }
  listeners.forEach((l) => l());
}

/** Puts a tracker in focus from its open panel ("Show every day with this"):
 *  NotesView provides it around the list and the editor; absent elsewhere,
 *  and the link does not draw. */
export const TrackerFocusLinkContext = createContext<((id: string) => void) | null>(null);
