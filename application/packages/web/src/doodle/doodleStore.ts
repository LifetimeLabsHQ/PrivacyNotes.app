/**
 * The doodle blocks' shared state, outside React (issue #736): the pen the
 * next stroke takes, the tool, and the block that is open full screen.
 *
 * A sync pass can remount the open editor (a pull from another device:
 * useSyncOrchestrator), which draws every block again. The full-screen
 * window belongs to a block, so it is named here by the block's id, and the
 * block drawn again opens it again. The strokes themselves are in the note.
 *
 * The pen settings, the colours, the paper of a new block and the open
 * panel are kept in this browser for the next doodle.
 */
import { useSyncExternalStore } from 'react';
import { readStyle } from './doodleFormat';
import { DEFAULT_PAPER, DEFAULT_STYLE, INK_COLORS, PAPER_COLORS, type DoodleStyle } from './doodleStyle';

export type DoodlePen = {
  /** The style a new block starts with: the last one set. */
  style: DoodleStyle;
  fill: string;
  stroke: string;
  /** The paper a new block starts with. */
  paper: string | null;
  /** The pen settings panel of the full-screen window is open. */
  panel: boolean;
};

export type DoodleState = {
  tool: 'draw' | 'erase';
  /** The id of the block open full screen, or null. */
  fullId: string | null;
  pen: DoodlePen;
};

const PEN_KEY = 'privacynotes.doodle.pen';

const DEFAULT_PEN: DoodlePen = { style: DEFAULT_STYLE, fill: INK_COLORS[0].value, stroke: INK_COLORS[0].value, paper: DEFAULT_PAPER, panel: false };

/** A saved pen, field by field: a field that is missing or of the wrong
 *  kind takes its default. */
export function readPen(raw: unknown): DoodlePen {
  if (!raw || typeof raw !== 'object') return DEFAULT_PEN;
  const r = raw as Record<string, unknown>;
  const ink = (v: unknown, d: string) => (INK_COLORS.some((c) => c.value === v) ? (v as string) : d);
  const paper = PAPER_COLORS.some((c) => c.value === r.paper) ? (r.paper as string | null) : DEFAULT_PEN.paper;
  return { style: readStyle(r.style), fill: ink(r.fill, DEFAULT_PEN.fill), stroke: ink(r.stroke, DEFAULT_PEN.stroke), paper, panel: r.panel === true };
}

function loadPen(): DoodlePen {
  try {
    const raw = localStorage.getItem(PEN_KEY);
    return raw ? readPen(JSON.parse(raw)) : DEFAULT_PEN;
  } catch {
    return DEFAULT_PEN;
  }
}

function savePen(pen: DoodlePen): void {
  try {
    localStorage.setItem(PEN_KEY, JSON.stringify(pen));
  } catch {
    // A full or blocked storage only loses the remembered settings.
  }
}

let state: DoodleState | null = null;
const listeners = new Set<() => void>();

export function doodleState(): DoodleState {
  if (!state) state = { tool: 'draw', fullId: null, pen: loadPen() };
  return state;
}

function set(patch: Partial<DoodleState>): void {
  state = { ...doodleState(), ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDoodle(): DoodleState {
  return useSyncExternalStore(subscribe, doodleState, doodleState);
}

export function setDoodleTool(tool: 'draw' | 'erase'): void {
  set({ tool });
}

/** Opens a block full screen, or closes the window with null. */
export function setFullDoodle(id: string | null): void {
  set({ fullId: id });
}

export function setDoodlePen(patch: Partial<DoodlePen>): void {
  const pen = { ...doodleState().pen, ...patch };
  savePen(pen);
  set({ pen });
}
