/**
 * "Automatically add my location": a new note or journal entry made on this
 * phone gets the place the phone reads once, a few seconds after it opens
 * (owner, 2026-11-11). One switch per type, kept on this device only, off by
 * default. Phones only (`canReadPosition`): a desktop has no reading, and a
 * browser's reading goes through its vendor (currentPosition.ts).
 *
 * `createNote` starts it for the person's own writing only (`counted`), so an
 * import, a share from another app or a copy never gets a place this way. The
 * place goes through the writer NotesView registers (`handleTrackersPatch`),
 * so the chip shows at once, and never over a place set in the meantime. The
 * name is the nearest listed town within 25 km, read on the device.
 * Spec: docs/internal/plans/note-location.md (section 3c)
 */
import { useSyncExternalStore } from 'react';
import { canReadPosition } from './currentPosition';
import type { NoteLocation } from './noteLocation';

/** The item types that can get a place on their own. */
export type AutoLocationType = 'note' | 'journal';

type Prefs = Record<AutoLocationType, boolean>;

const KEY = 'privacynotes.location.auto';
const OFF: Prefs = { note: false, journal: false };
const listeners = new Set<() => void>();
let cached: Prefs | null = null;

export function readAutoLocation(): Prefs {
  if (cached) return cached;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    cached = { note: raw.note === true, journal: raw.journal === true };
  } catch {
    cached = OFF;
  }
  return cached;
}

export function writeAutoLocation(type: AutoLocationType, on: boolean): void {
  cached = { ...readAutoLocation(), [type]: on };
  try { localStorage.setItem(KEY, JSON.stringify(cached)); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}

/** The switches, live: the settings row and the place window show the same state. */
export function useAutoLocation(): Prefs {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    readAutoLocation,
    () => OFF,
  );
}

/** Whether a new item of this type gets a place on this device. */
export function autoLocationOn(type: string): type is AutoLocationType {
  return (type === 'note' || type === 'journal') && readAutoLocation()[type] && canReadPosition();
}

type Writer = (id: string, place: NoteLocation) => Promise<boolean>;
let writer: Writer | null = null;

/** NotesView's tracker write; null when it unmounts. */
export function setAutoLocationWriter(fn: Writer | null): void {
  writer = fn;
}

/** Read the phone's position once and give the new item its place. Silent on every failure. */
export function startAutoLocation(id: string, type: string): void {
  if (!autoLocationOn(type)) return;
  void (async () => {
    const [{ readCurrentPosition }, { loadPlaces, nearestPlace }, { activeLocale }, { makeLocation }] = await Promise.all([
      import('./currentPosition'),
      import('./placeSearch'),
      import('./i18n'),
      import('./noteLocation'),
    ]);
    const fix = await readCurrentPosition();
    if (!fix.ok) return;
    const rows = await loadPlaces(activeLocale()).catch(() => []);
    const place = makeLocation(fix.lat, fix.lng, nearestPlace(rows, fix.lat, fix.lng)?.name);
    if (place && writer) await writer(id, place);
  })().catch(() => {});
}

/**
 * Turn a switch on or off. Turning one on asks for the phone's permission
 * now, while the person is looking at the switch, and stays off when the
 * phone refuses. A slow first reading still turns it on.
 */
export async function turnAutoLocation(type: AutoLocationType, on: boolean): Promise<'denied' | 'off' | null> {
  if (on) {
    const { readCurrentPosition } = await import('./currentPosition');
    const fix = await readCurrentPosition();
    if (!fix.ok && fix.error !== 'timeout') return fix.error;
  }
  writeAutoLocation(type, on);
  return null;
}
