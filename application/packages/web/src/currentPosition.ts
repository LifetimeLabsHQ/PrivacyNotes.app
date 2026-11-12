/**
 * One reading of the phone's position, for "Use my current location".
 *
 * The permission question comes from here and only from here: the first tap
 * asks, nothing at launch or install does. On iOS the plugin would ask inside
 * `get_current_position` anyway; on Android it never asks, so the state is
 * checked and requested first on both. A watch is never started, and the
 * reading is taken only while the app is in front.
 *
 * Phone builds only. Desktop and web have no button: the Tauri plugin has no
 * desktop build, and a browser hands the nearby Wi-Fi networks to its
 * vendor's location service (our `Permissions-Policy: geolocation=()` blocks
 * it anyway).
 * Spec: docs/internal/plans/note-location.md (section 3)
 */
import { detectPlatform } from './devices';

export type PositionResult =
  | { ok: true; lat: number; lng: number }
  | { ok: false; error: 'denied' | 'timeout' | 'off' };

/** How long a fix may take before the person is told to try again or paste. */
const FIX_TIMEOUT_MS = 15_000;

type PermissionState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';
type Permissions = { location?: PermissionState; coarseLocation?: PermissionState };

/** Whether this build can read the position at all. */
export function canReadPosition(): boolean {
  const p = detectPlatform();
  return p === 'ios' || p === 'android';
}

const granted = (s: Permissions | null) => s?.location === 'granted' || s?.coarseLocation === 'granted';
const asking = (s: Permissions | null) => !!s && [s.location, s.coarseLocation].some((v) => v === 'prompt' || v === 'prompt-with-rationale');

export async function readCurrentPosition(): Promise<PositionResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  // A rejection here means location services are switched off for the whole phone.
  let state = await invoke<Permissions>('plugin:geolocation|check_permissions').catch(() => null);
  if (!state) return { ok: false, error: 'off' };
  if (!granted(state) && asking(state)) {
    state = await invoke<Permissions>('plugin:geolocation|request_permissions', { permissions: ['location'] }).catch(() => null);
  }
  if (!granted(state)) return { ok: false, error: 'denied' };
  const fix = invoke<{ coords: { latitude: number; longitude: number } }>('plugin:geolocation|get_current_position', {
    options: { enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: 0 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FIX_TIMEOUT_MS + 1000); });
  const pos = await Promise.race([fix.catch(() => null), late]);
  clearTimeout(timer);
  if (!pos) return { ok: false, error: 'timeout' };
  return { ok: true, lat: pos.coords.latitude, lng: pos.coords.longitude };
}
