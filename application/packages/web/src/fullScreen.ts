import type { LocalNote } from './db';
import { isDesktopApp } from './shortcutMatch';
import { isKnownNoteType, traitsOf } from './noteTypes';
import type { View } from './views';

/**
 * Full-screen reading and presenting mode for text notes (GitHub #911).
 *
 * Device-local text scale on an industry-standard zoom ladder (75% to 300%),
 * defaulting to 150%. Scaling lives on the note's own CSS variables rather
 * than webview/browser zoom, so app chrome and other notes stay untouched.
 */

export const FULL_SCREEN_SCALES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
export type FullScreenScale = (typeof FULL_SCREEN_SCALES)[number];

export const DEFAULT_FULL_SCREEN_SCALE: FullScreenScale = 1.5;

const STORAGE_KEY = 'privacynotes.fullScreenScale';

function isFullScreenScale(value: unknown): value is FullScreenScale {
  return typeof value === 'number' && (FULL_SCREEN_SCALES as readonly number[]).includes(value);
}

export function readFullScreenScale(storage: Pick<Storage, 'getItem'> | null = safeStorage()): FullScreenScale {
  if (!storage) return DEFAULT_FULL_SCREEN_SCALE;
  try {
    const raw = Number(storage.getItem(STORAGE_KEY));
    return isFullScreenScale(raw) ? raw : DEFAULT_FULL_SCREEN_SCALE;
  } catch {
    return DEFAULT_FULL_SCREEN_SCALE;
  }
}

export function writeFullScreenScale(
  scale: FullScreenScale,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, String(scale));
  } catch {
    // Private browsing or blocked storage; the scale still holds for this session.
  }
}

export function stepFullScreenScale(current: FullScreenScale, direction: 1 | -1): FullScreenScale {
  const index = FULL_SCREEN_SCALES.indexOf(current);
  const base = index < 0 ? FULL_SCREEN_SCALES.indexOf(DEFAULT_FULL_SCREEN_SCALE) : index;
  const next = Math.min(FULL_SCREEN_SCALES.length - 1, Math.max(0, base + direction));
  return FULL_SCREEN_SCALES[next] ?? DEFAULT_FULL_SCREEN_SCALE;
}

export function formatFullScreenPercent(scale: FullScreenScale): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * Reading column max-width inside full-screen mode.
 * Widens gently above 100% so 200%-300% text stays comfortable to scan
 * instead of wrapping into three words per line.
 */
export function fullScreenContentWidth(scale: FullScreenScale): string {
  const factor = Math.max(1, 1 + (scale - 1) * 0.5);
  return `${(56 * factor).toFixed(2).replace(/\.?0+$/, '')}rem`;
}

/**
 * True when an item can enter full-screen reading/presenting mode:
 * a known markdown-body item that is not behind a closed PIN gate and not in Trash.
 * Drawings have their own full-screen canvas; structured forms (vault, contacts,
 * bookmarks) stay in the normal pane.
 */
export function canOpenFullScreen(
  note: LocalNote | null,
  view: View,
  locked: boolean,
  removingProtection = false,
): boolean {
  if (!note || view === 'trash' || locked || removingProtection) return false;
  if (!isKnownNoteType(note.type)) return false;
  return traitsOf(note.type).body === 'markdown';
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Enters OS fullscreen while full-screen note mode is active and restores
 * the previous window state on cleanup. Never throws if the environment
 * refuses or lacks fullscreen support - the chrome-free view still works.
 */
export function startOsFullScreen(onExternalExit: () => void): () => void {
  let active = true;
  let enteredByUs = false;

  if (isDesktopApp()) {
    let winRef: { setFullscreen: (v: boolean) => Promise<void>; isFullscreen: () => Promise<boolean> } | null = null;
    const onResize = () => {
      if (!active || !enteredByUs || !winRef) return;
      void winRef.isFullscreen().then((fs) => {
        if (active && enteredByUs && !fs) {
          enteredByUs = false;
          onExternalExit();
        }
      }).catch(() => {});
    };

    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        if (!active) return;
        const win = getCurrentWindow();
        winRef = win;
        const already = await win.isFullscreen().catch(() => false);
        if (!active || already) return;
        await win.setFullscreen(true);
        if (!active) {
          await win.setFullscreen(false).catch(() => {});
          return;
        }
        enteredByUs = true;
        window.addEventListener('resize', onResize);
      })
      .catch(() => {});

    return () => {
      active = false;
      window.removeEventListener('resize', onResize);
      if (enteredByUs && winRef) {
        enteredByUs = false;
        void winRef.setFullscreen(false).catch(() => {});
      }
    };
  }

  // Browser Fullscreen API
  if (typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  const onFsChange = () => {
    if (!active) return;
    if (document.fullscreenElement) {
      enteredByUs = true;
    } else if (enteredByUs) {
      enteredByUs = false;
      onExternalExit();
    }
  };
  document.addEventListener('fullscreenchange', onFsChange);

  if (!document.fullscreenElement && typeof root.requestFullscreen === 'function') {
    void root.requestFullscreen().then(() => {
      if (!active) {
        if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
        return;
      }
      if (document.fullscreenElement) enteredByUs = true;
    }).catch(() => {
      // Browser refused (e.g. non-gesture call or restricted context); stay in chrome-free view.
    });
  }

  return () => {
    active = false;
    document.removeEventListener('fullscreenchange', onFsChange);
    if (enteredByUs && document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      enteredByUs = false;
      void document.exitFullscreen().catch(() => {});
    }
  };
}
