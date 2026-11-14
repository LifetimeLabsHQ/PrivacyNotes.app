import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { SETTINGS_HELP } from './settingsUI';

/**
 * How far the background pass of a phrase change has come, and the one
 * quiet line in Settings > Security > Your Phrase that shows it while the
 * pass runs. Null while no pass runs.
 * The pass itself (reencryptPass.ts) loads only for an account that changed
 * its phrase, so this store stays apart from it and the settings read it
 * without loading the pass.
 * Spec: docs/internal/plans/phrase-change.md (6.4, item 5)
 */
let percent: number | null = null;
const listeners = new Set<() => void>();

/** The pass reports its share done, 0 to 100, or null when it stops. */
export function setReencryptProgress(next: number | null): void {
  const value = next === null ? null : Math.max(0, Math.min(100, Math.floor(next)));
  if (value === percent) return;
  percent = value;
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return percent;
}

/** The share done while a pass runs, else null. */
function useReencryptProgress(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** "Encrypting older data again: 62%" while a pass runs; nothing otherwise. */
export function ReencryptProgressLine() {
  const { t } = useTranslation('security');
  const percent = useReencryptProgress();
  if (percent === null) return null;
  return <p className={SETTINGS_HELP} role="status">{t('reencryptPass.progress', { percent })}</p>;
}
