/**
 * App size: the whole app, as a scale on every pixel in it, on desktop and
 * on phones (#834).
 *
 * The desktop app runs in a webview, so the engine under the page can scale
 * the page the way a browser does. That is what makes this reach the app
 * chrome, which the editor text size next to it cannot. The chrome's text
 * is in rem (typeScale.css), but its spacing, borders and pictures are not
 * all, so a root font size would still move part of the UI and freeze the
 * rest. Zoom happens below our stylesheet instead of inside it, so no
 * component is aware of it, and it multiplies the type roles as they are.
 *
 * One ladder owns the level and both the Appearance row and the keyboard step
 * along it. Tauri's own `zoomHotkeysEnabled` is deliberately off, even though
 * it would give the keystrokes for nothing: it keeps a level of its own that
 * nothing can read back, so after one keypress the Appearance row would state
 * a size the window no longer has. On macOS and Linux that level also lives
 * in an injected script, which forgets it on every start.
 *
 * Phones have no such engine call, so there the level goes into the viewport
 * tag instead: `initial-scale` without a width makes the layout viewport the
 * screen width divided by the level, and the engine scales it back up. That
 * is a phone browser's own page zoom, so vh units, touch points, popovers and
 * the keyboard all agree with no component aware of it. CSS `zoom` on the
 * root was tried first and dropped: every 100dvh in the app overflowed by the
 * level. The one leak is the safe-area insets, which the engine reports
 * unscaled; `--pn-page-scale` divides them back (index.css).
 *
 * Device-local, like the editor text size, and for the same reason: a 13 inch
 * laptop and a 27 inch monitor want different answers, so one synced value
 * would fix one screen and break the other.
 *
 * Spec: docs/internal/design-decisions.md (app zoom)
 */

import { useCallback, useSyncExternalStore } from 'react';
import { createListeners } from './listeners';

const KEY = 'privacynotes.appZoom';

/**
 * The offered levels, smallest first. 1 is unscaled and is the default.
 *
 * Two steps below 1 and three above it. The row is one button wider than
 * the editor text size beside it and 1 therefore sits left of its middle,
 * which is the price of keeping both ends: the steps below are for a laptop
 * screen with too little on it, and the steps above are what the feature is
 * for.
 *
 * 2 is the top because it is the number an accessibility review asks for
 * (WCAG 2.1, resize text) and because zoom narrows the window's CSS width:
 * the app takes its narrow layout under 768 of them, so at 2 a window must
 * be 1536 points wide to stay on the wide one, which the default 1440 is
 * not. A higher step would make the narrow layout the normal result at
 * every window size rather than an edge of the range.
 */
const DESKTOP_LEVELS = [0.8, 0.9, 1, 1.25, 1.5, 2] as const;

/**
 * The phone ladder. Small steps, because on a phone every step costs width:
 * the layout viewport is the screen width divided by the level, so 1.5 on a
 * 402 point iPhone lays the app out in 268. A higher step would squeeze the
 * phone layout below what it is built for; the phone's own text size setting
 * is the way past it. Nothing below 1: Android's webview refuses a page scale
 * under 1 (it keeps the page at the screen width), so a 90% step did nothing
 * there, and the phone row is for going bigger.
 */
const PHONE_LEVELS = [1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

/** True in the iOS and Android builds, which scale through the viewport tag. */
function isPhoneBuild(): boolean {
  return __PN_BUILD_PLATFORM__ === 'ios' || __PN_BUILD_PLATFORM__ === 'android';
}

export type AppZoom = (typeof DESKTOP_LEVELS)[number] | (typeof PHONE_LEVELS)[number];

/** The ladder this build offers. */
export const APP_ZOOM_LEVELS: readonly AppZoom[] = isPhoneBuild() ? PHONE_LEVELS : DESKTOP_LEVELS;

/** The level a fresh install and a Reset to defaults both land on. */
export const DEFAULT_APP_ZOOM: AppZoom = 1;

/**
 * True in a desktop build and nowhere else. Other desktop-only rows (System,
 * the tray, the Ninja key) gate on this too, so it keeps that meaning; the App
 * size row itself gates on `appSizeSupported`.
 *
 * `__PN_BUILD_PLATFORM__` is baked in at build time, so on the web the
 * Appearance row, the key handler and the dynamic import behind them never
 * run; the web build still carries them as unreachable code and lazy chunks
 * it never loads. It repeats the platform test in `devices.ts`
 * instead of calling it, because this module runs before React mounts and
 * that one reaches the whole sync and crypto graph.
 */
export function appZoomSupported(): boolean {
  return (
    __PN_BUILD_PLATFORM__ !== '' &&
    __PN_BUILD_PLATFORM__ !== 'ios' &&
    __PN_BUILD_PLATFORM__ !== 'android'
  );
}

/**
 * True where Settings > Design draws the App size row: the desktop and phone
 * apps. Not on the web, where the browser's own zoom does the job.
 */
export function appSizeSupported(): boolean {
  return appZoomSupported() || isPhoneBuild();
}

function isAppZoom(v: unknown): v is AppZoom {
  return typeof v === 'number' && (APP_ZOOM_LEVELS as readonly number[]).includes(v);
}

/** The stored level. Anything unrecognised means the default. */
function getStoredAppZoom(): AppZoom {
  try {
    const raw = Number(localStorage.getItem(KEY));
    return isAppZoom(raw) ? raw : DEFAULT_APP_ZOOM;
  } catch {
    return DEFAULT_APP_ZOOM;
  }
}

/** Currently applied level, for the React snapshot. */
let activeAppZoom: AppZoom = DEFAULT_APP_ZOOM;

/** Hand a level to the webview. Rejects when the build is not a desktop one,
 *  which the callers all gate on, so a rejection is swallowed. */
async function pushToWebview(level: AppZoom): Promise<void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().setZoom(level);
}

/** The viewport tag index.html ships, kept so level 1 restores it exactly. */
let shippedViewport: string | null = null;

/**
 * Scale the page through the viewport tag. Minimum and maximum pin the scale,
 * so a pinch cannot leave it, as the shipped tag does at 1. Width is left out
 * on purpose: with only a scale, the engine derives the width from the screen,
 * so a rotation or an iPad window resize keeps the level.
 */
function pushToViewport(level: AppZoom): void {
  const tag = document.querySelector('meta[name="viewport"]');
  if (!tag) return;
  shippedViewport ??= tag.getAttribute('content');
  const rest = 'user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content';
  tag.setAttribute('content', level === 1 && shippedViewport
    ? shippedViewport
    : `initial-scale=${level}, minimum-scale=${level}, maximum-scale=${level}, ${rest}`);
  document.documentElement.style.setProperty('--pn-page-scale', String(level));
}

const { subscribe, notify } = createListeners();

function snapshot(): AppZoom {
  return activeAppZoom;
}

/** Apply a level to the window and persist it. */
export function applyAppZoom(level: AppZoom): void {
  activeAppZoom = level;
  try { localStorage.setItem(KEY, String(level)); } catch { /* private mode */ }
  if (appZoomSupported()) void pushToWebview(level).catch(() => { /* no webview */ });
  else if (isPhoneBuild()) pushToViewport(level);
  notify();
}

/**
 * Apply the stored level at start.
 *
 * It pushes even at 1, rather than treating 1 as nothing to do, because the
 * webview can start at a level we did not set: WebView2 keeps a zoom factor
 * of its own in the user data folder. Pushing unconditionally is what makes
 * the stored value the one that decides, so the Appearance row never
 * describes a window somebody else scaled.
 */
export function initAppZoom(): void {
  if (!appSizeSupported()) return;
  applyAppZoom(getStoredAppZoom());
}

/**
 * Move one step along the ladder and stop at either end.
 *
 * The ends are silent on purpose. A keystroke that already sits at the top
 * has nothing to report, and a toast on every extra press of a held key
 * would be the loudest thing in the app.
 */
export function stepAppZoom(direction: 1 | -1): void {
  const at = APP_ZOOM_LEVELS.indexOf(activeAppZoom);
  const next = Math.min(APP_ZOOM_LEVELS.length - 1, Math.max(0, at + direction));
  applyAppZoom(APP_ZOOM_LEVELS[next] ?? DEFAULT_APP_ZOOM);
}

/** The level, and a setter, shared by every caller. */
export function useAppZoom() {
  const appZoom = useSyncExternalStore(subscribe, snapshot);
  const setAppZoom = useCallback((next: AppZoom) => { applyAppZoom(next); }, []);
  return { appZoom, setAppZoom };
}
