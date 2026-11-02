import { useSyncExternalStore } from 'react';

/**
 * Whether the daily check-in card heads Journals and All on this device. On
 * by default and device-local, like the calendar card's switch under it in
 * the list options (Show daily check-in, Show calendar). The key holds '0'
 * while it is off. The medication card under it (GitHub #649) has a switch
 * of its own, the same way.
 * Spec: docs/internal/issues/0439.md (Spec)
 */
const CHECK_IN_KEY = 'privacynotes.checkInCardShown';
const MEDICATION_KEY = 'privacynotes.medicationCardShown';
const listeners = new Set<() => void>();

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function write(key: string, on: boolean): void {
  try {
    if (on) localStorage.removeItem(key);
    else localStorage.setItem(key, '0');
  } catch {
    // Storage refused (a private window): the switch keeps its default.
  }
  listeners.forEach((l) => l());
}

export function useCheckInCardShown(): boolean {
  return useSyncExternalStore(subscribe, () => read(CHECK_IN_KEY));
}

export function setCheckInCardShown(on: boolean): void {
  write(CHECK_IN_KEY, on);
}

export function useMedicationCardShown(): boolean {
  return useSyncExternalStore(subscribe, () => read(MEDICATION_KEY));
}

export function setMedicationCardShown(on: boolean): void {
  write(MEDICATION_KEY, on);
}
