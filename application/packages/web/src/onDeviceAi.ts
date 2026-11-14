import { useSyncExternalStore } from 'react';
import type { LocalNote } from './db';
import type { NotesIndexOps } from './searchIndexSync';
import { MAP_ORIGIN } from './hosts';
import { isDemoMode } from './demo';

/**
 * Smart connections (Settings > Editor > Behavior, under Suggested
 * connections): a small meaning model
 * the user downloads once to this device, used by Related notes. The model is
 * public data, kept in the browser's Cache Storage so it is not downloaded
 * again. The meaning vectors of the notes live in memory only and are
 * rebuilt each session (about 10 s for 5,000 notes on a phone): a vector
 * says what a note is about, so it is never written to disk.
 *
 * This file is the light half, on the boot path: the switch, the state and
 * thin doors that load `onDeviceAiModel.ts` when needed.
 *
 * Released (owner, 2026-11-14): the model is on our map host and the FAQ
 * answer "no-ai" describes it. The switch stays, so one line hides it again.
 * Spec: docs/internal/plans/related-notes.md (part 2)
 */

const ON_DEVICE_AI_RELEASED = true;

export function onDeviceAiShown(): boolean {
  return ON_DEVICE_AI_RELEASED || import.meta.env.DEV;
}

/**
 * The one model, bekko-static at 256 dims with its whole vocabulary, so every
 * language it reads works (plan sections 4b and 4c), as the files we host. Each name carries the start of its SHA-256, so a new model is a new
 * name and the browser never mixes two; the whole hash is checked before the
 * model loads. `tools/embed-model/convert.mjs` prints these lines.
 * Spec: docs/internal/plans/related-notes.md (section 4d)
 */
export const MEANING_FILES = [
  { name: 'bekko256-vocab-3646307292d4.txt', bytes: 1_814_140, sha256: '3646307292d41b3bc33500b26a0110601d2887da9579375c22d2c3254460f61d' },
  { name: 'bekko256-vectors-e4275d533077.bin', bytes: 52_000_012, sha256: 'e4275d5330778850e830a7e196a9f3197d1e360ef0425a794545e6c44731f8a6' },
] as const;
export const MEANING_BYTES = MEANING_FILES.reduce((sum, f) => sum + f.bytes, 0);

export const ENABLED_KEY = 'privacynotes.onDeviceAi.meaning';
const NO_DOOR_KEY = 'privacynotes.onDeviceAi.noDoor';
const BASE_KEY = 'privacynotes.onDeviceAi.modelBase';
export const CACHE = 'pn-on-device-ai';

/**
 * Where the model files are served: our map host, in its `models/` folder
 * (`.github/workflows/model-upload.yml` puts them there). A development build
 * reads the local copy the dev server serves from
 * `packages/web/node_modules/.cache/pn-models/` (made by `convert.mjs`), or
 * the address in the `localStorage` key above, such as the host itself.
 */
export function modelBase(): string {
  if (import.meta.env.DEV) {
    try {
      const local = localStorage.getItem(BASE_KEY);
      if (local) return local.endsWith('/') ? local : `${local}/`;
    } catch {
      // no storage: the local copy
    }
    return '/node_modules/.cache/pn-models/';
  }
  return `${MAP_ORIGIN}/models/`;
}

/**
 * `kept`: off, with the model still in this device's cache, so turning it on
 * again reads the cache and downloads nothing. `off`: no model here (or not
 * checked yet).
 */
export type MeaningState =
  | { status: 'off' }
  | { status: 'kept' }
  | { status: 'unavailable' }
  | { status: 'downloading'; loaded: number; total: number }
  | { status: 'loading' }
  | { status: 'on' }
  | { status: 'error' };

let state: MeaningState = { status: 'off' };
const listeners = new Set<() => void>();

/** The heavy half (onDeviceAiModel.ts) reports progress through this. */
export function setMeaningState(next: MeaningState) {
  state = next;
  for (const l of listeners) l();
}

export function useMeaningState(): MeaningState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

function enabledHere(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

type MeaningModule = {
  index: NotesIndexOps;
  nearest: typeof import('./onDeviceAiModel').nearestInMeaning;
  turnOn: typeof import('./onDeviceAiModel').turnMeaningOn;
};

let meaning: MeaningModule | null = null;
let meaningLoading: Promise<MeaningModule> | null = null;

function loadMeaning(): Promise<MeaningModule> {
  meaningLoading ??= import('./onDeviceAiModel').then((m) => (meaning = {
    index: m.MEANING_INDEX_OPS,
    nearest: m.nearestInMeaning,
    turnOn: m.turnMeaningOn,
  }));
  return meaningLoading;
}

/**
 * At boot: a device that turned meaning on loads the model from its cache.
 * Never in the demo: it shares this origin's flag with a signed-in tab, and it
 * cannot download the model.
 */
export function restoreMeaning(): void {
  if (!onDeviceAiShown() || isDemoMode() || state.status !== 'off' || !enabledHere()) return;
  void loadMeaning().then((m) => m.turnOn());
}

/** The meaning index as `useIndexSync` drives it; fed no notes while the model is off. */
export const MEANING_INDEX: NotesIndexOps = {
  ready: () => !!meaning && meaning.index.ready(),
  wantsFullBuild: (changed) => !meaning || meaning.index.wantsFullBuild(changed),
  update: (notes, changed) => meaning?.index.update(notes, changed),
  buildSliced: async (notes) => (await loadMeaning()).index.buildSliced(notes),
};

/** The notes nearest in meaning to one note, best first. Empty while meaning is off. */
export function meaningHits(note: Pick<LocalNote, 'id' | 'title' | 'body'>, skip: (id: string) => boolean, limit: number): string[] {
  return meaning ? meaning.nearest(note, skip, limit) : [];
}

/** "Not now": hides the panel's offer line in every note until the app starts again. Memory only. */
let doorLater = false;

/** Whether the panel's offer line is hidden: "Not now" this session, or "Don't show again" on this device. */
export function meaningDoorClosed(): boolean {
  if (doorLater) return true;
  try {
    return localStorage.getItem(NO_DOOR_KEY) === '1';
  } catch {
    return false;
  }
}

export function laterMeaningDoor(): void {
  doorLater = true;
}

/** Undo after "Don't show again". */
export function reopenMeaningDoor(): void {
  try {
    localStorage.removeItem(NO_DOOR_KEY);
  } catch {
    // nothing stored
  }
}

/** "Don't show again": hides the offer line in every note on this device, for good. */
export function closeMeaningDoor(): void {
  try {
    localStorage.setItem(NO_DOOR_KEY, '1');
  } catch {
    // A private window: closed for this session only (the panel keeps it in state).
  }
}
