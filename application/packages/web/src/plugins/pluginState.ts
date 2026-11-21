import { useRef, useSyncExternalStore } from 'react';

/**
 * The light half of the plugin manager, on the boot path: the state of each
 * plugin and its per-device flag. The heavy half (`pluginManager.ts`, the
 * download and the cache) and the registry (`registry.ts`, the pinned files)
 * load on demand, so the boot path never carries a file list.
 *
 * One state per key: a plugin id, or `translate.<lang>` for one language of
 * Translate notes.
 * Spec: docs/internal/plans/plugins.md (section 3)
 */

export type PluginId = 'smartConnections' | 'ocr' | 'translate' | 'voice' | 'cleanup';
export type PluginKey = PluginId | `translate.${string}`;

/**
 * `kept`: off, with the files still in this device's cache, so turning it on
 * again downloads nothing. `off`: no files here (or not checked yet).
 * `needsPro`: the account is free (a refund within 30 days), so nothing
 * loads; the files stay on the device. `error` with `space`: the device
 * refused to store the files.
 */
export type PluginState =
  | { status: 'off' }
  | { status: 'kept' }
  | { status: 'unavailable' }
  /** `waiting`: in the queue behind another download (one runs at a time). */
  | { status: 'downloading'; loaded: number; total: number; waiting?: true }
  | { status: 'loading' }
  | { status: 'on' }
  | { status: 'error'; reason?: 'space' }
  | { status: 'needsPro' };

const OFF: PluginState = { status: 'off' };
const states = new Map<PluginKey, PluginState>();
const listeners = new Set<() => void>();
/** Bumps on every change, so a list of states is rebuilt only when one changed. */
let version = 0;

export function pluginState(key: PluginKey): PluginState {
  return states.get(key) ?? OFF;
}

export function setPluginState(key: PluginKey, next: PluginState): void {
  states.set(key, next);
  version++;
  for (const l of listeners) l();
}

export function usePluginState(key: PluginKey): PluginState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pluginState(key),
  );
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The states of several keys at once, as one stable list (the Translate languages). */
export function usePluginStates(keys: readonly PluginKey[]): readonly PluginState[] {
  const memo = useRef<{ version: number; id: string; list: readonly PluginState[] } | null>(null);
  const id = keys.join(' ');
  return useSyncExternalStore(subscribe, () => {
    if (memo.current?.version !== version || memo.current.id !== id) memo.current = { version, id, list: keys.map(pluginState) };
    return memo.current.list;
  });
}

/**
 * Whether the account is Pro, for a note's door that draws the Pro mark on a
 * menu row (the mark keys off the plan, not the unlock, so the demo keeps it).
 * NotesView sets it through `restorePlugins`.
 */
let planPro = false;

export function setPlanPro(isPro: boolean): void {
  planPro = isPro;
}

export function planIsPro(): boolean {
  return planPro;
}

/**
 * Whether the OS answered `os-too-old` for SpeechAnalyzer (below iOS and
 * macOS 26): `checkAppleSpeech` in the registry and a transcription that
 * met it set it. Here, not in the registry, so an audio chip's door
 * (`voiceShown`) reads it without the file list (beta #242 item 1).
 */
let speechTooOld = false;

export function markSpeechTooOld(): void {
  speechTooOld = true;
}

export function speechIsTooOld(): boolean {
  return speechTooOld;
}

/** Smart connections keeps the flag it had before Plugins, so nobody downloads it again. */
export const MEANING_FLAG = 'privacynotes.onDeviceAi.meaning';

/** The per-device "on" flag of a plugin or a Translate language. */
function pluginFlagKey(key: PluginKey): string {
  return key === 'smartConnections' ? MEANING_FLAG : `privacynotes.plugin.${key}`;
}

export function pluginFlagOn(key: PluginKey): boolean {
  try {
    return localStorage.getItem(pluginFlagKey(key)) === '1';
  } catch {
    return false;
  }
}

export function setPluginFlag(key: PluginKey, on: boolean): void {
  try {
    if (on) localStorage.setItem(pluginFlagKey(key), '1');
    else localStorage.removeItem(pluginFlagKey(key));
  } catch {
    // A private window: on for this session only.
  }
}

/** "Tag and folder suggestions" inside Smart connections: on by default, per device like the plugin. */
const SUGGEST_KEY = 'privacynotes.plugin.smartSuggestions';
const suggestListeners = new Set<() => void>();

function suggestionsOn(): boolean {
  try {
    return localStorage.getItem(SUGGEST_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setSuggestionsOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SUGGEST_KEY);
    else localStorage.setItem(SUGGEST_KEY, '0');
  } catch {
    // A private window: for this session only.
  }
  for (const l of suggestListeners) l();
}

export function useSuggestionsOn(): boolean {
  return useSyncExternalStore(
    (l) => {
      suggestListeners.add(l);
      return () => suggestListeners.delete(l);
    },
    suggestionsOn,
  );
}
