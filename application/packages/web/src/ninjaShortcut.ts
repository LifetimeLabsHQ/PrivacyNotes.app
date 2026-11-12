/**
 * Ninja from any app (GitHub #694), the key. A device setting that never
 * syncs: a global key belongs to one computer and to what else runs there.
 * This module keeps it, pushes it to `ninja.rs` at start and on every change,
 * and keeps what the push answered (a key another app holds, the command a
 * Linux Wayland session binds instead) for the Settings row.
 * Spec: docs/internal/plans/ninja-anywhere-694.md (section 2)
 */

import { useSyncExternalStore } from 'react';
import { appZoomSupported } from './appZoom';
import type { KeyBinding, KeyOs } from './commandKeys';
import type { KeyPress } from './shortcutMatch';
import { KEY_OS } from './shortcutMatch';

const KEY = 'privacynotes.ninjaKey';
/** The key, pressed while the main window has the focus: Ninja opens or closes there. */
export const NINJA_TOGGLE_EVENT = 'pn:ninja-toggle';
/** At an unlock, the quick notes the Ninja box kept while the app was locked
 *  are in: the event's detail is their ids. Spec: docs/internal/plans/quick-note-694.md (section 5.1) */
export const QUICK_NOTES_ADDED_EVENT = 'pn:quick-notes-added';

/** Option+Shift+Space on a Mac, Alt+Shift+Space elsewhere. Spec: docs/internal/plans/ninja-anywhere-694.md (N2) */
export const DEFAULT_NINJA_KEY: KeyBinding = { key: 'Space', alt: true, shift: true };

/** Every desktop app; never a phone or the browser. */
export const ninjaKeySupported = appZoomSupported;

export interface NinjaKeyState {
  /** The key, or null when it is off. */
  binding: KeyBinding | null;
  /** The system refused the key: another app holds it. */
  taken: boolean;
  /** Linux on Wayland: the command to bind in the system keyboard settings. */
  wayland: string | null;
}

/** A binding key as its key code: 'k' is 'KeyK', '1' is 'Digit1'. */
function codeOf(key: string): string {
  return /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
}

/** The physical key of a press as a binding key, or null for a key a global key cannot use. */
function keyOfCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code === 'Space' || /^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return null;
}

/**
 * A key press as a Ninja key, or null. It needs Ctrl, Alt or Cmd: Shift
 * alone, or no modifier, would take a character from every text field.
 */
export function bindingFromPress(e: KeyPress, os: KeyOs = KEY_OS): KeyBinding | null {
  const key = keyOfCode(e.code);
  if (!key) return null;
  const mod = os === 'mac' ? e.metaKey : e.ctrlKey;
  const ctrl = os === 'mac' && e.ctrlKey;
  if (!mod && !ctrl && !e.altKey) return null;
  return {
    key,
    ...(mod && { mod: true }),
    ...(ctrl && { ctrl: true }),
    ...(e.altKey && { alt: true }),
    ...(e.shiftKey && { shift: true }),
  };
}

/** The key as the global-shortcut plugin reads it: "Alt+Shift+Space", "Super+KeyK". */
export function acceleratorOf(b: KeyBinding, os: KeyOs = KEY_OS): string {
  const mods = [
    b.mod && (os === 'mac' ? 'Super' : 'Control'),
    b.ctrl && os === 'mac' && 'Control',
    b.alt && 'Alt',
    b.shift && 'Shift',
  ].filter((m): m is string => !!m);
  return [...mods, codeOf(b.key)].join('+');
}

function isBinding(v: unknown): v is KeyBinding {
  if (!v || typeof v !== 'object') return false;
  const b = v as KeyBinding;
  return typeof b.key === 'string' && keyOfCode(codeOf(b.key)) === b.key && !!(b.mod || b.ctrl || b.alt);
}

let state: NinjaKeyState | null = null;

function read(): NinjaKeyState {
  if (state) return state;
  let binding: KeyBinding | null = DEFAULT_NINJA_KEY;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'off') binding = null;
    else if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isBinding(parsed)) binding = parsed;
    }
  } catch {
    /* Storage refused or a broken value: the default key. */
  }
  state = { binding, taken: false, wayland: null };
  return state;
}

const listeners = new Set<() => void>();

function update(next: Partial<NinjaKeyState>): void {
  state = { ...read(), ...next };
  listeners.forEach((cb) => cb());
}

async function push(binding: KeyBinding | null): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const wayland = await invoke<string | null>('set_ninja_shortcut', { accelerator: binding ? acceleratorOf(binding) : null });
    if (read().binding === binding) update({ taken: false, wayland });
  } catch (err) {
    // 'taken' or 'invalid'; an older build with no such command lands here too.
    if (read().binding === binding) update({ taken: err === 'taken', wayland: null });
  }
}

let started = false;

/** At start: push the stored key, and pass the key pressed in the main window on to NotesView. */
export function startNinjaShortcut(): void {
  if (!ninjaKeySupported() || started) return;
  started = true;
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen('pn-ninja-toggle', () => window.dispatchEvent(new Event(NINJA_TOGGLE_EVENT))))
    .catch(() => {});
  void push(read().binding);
}

/** A new key, or null to turn it off. */
export function setNinjaKey(binding: KeyBinding | null): void {
  try {
    localStorage.setItem(KEY, binding ? JSON.stringify(binding) : 'off');
  } catch {
    /* Storage refused: the key holds for this session only. */
  }
  update({ binding, taken: false });
  void push(binding);
}

/**
 * While Settings records a new key, the old one lets go: the system would
 * catch a press of it before the web view sees it. `resume` takes it again.
 */
export function pauseNinjaKey(): void {
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('set_ninja_shortcut', { accelerator: null }))
    .catch(() => {});
}

export function resumeNinjaKey(): void {
  void push(read().binding);
}

export function useNinjaKey(): NinjaKeyState {
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, read);
}
