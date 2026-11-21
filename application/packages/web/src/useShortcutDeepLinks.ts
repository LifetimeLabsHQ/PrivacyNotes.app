import { useEffect, useRef } from 'react';
import { detectPlatform } from './devices';
import { takeDeepLinks } from './deepLinks';
import { parseShortcut, type ShortcutTarget } from './noteShortcut';

const LAST_KEY = 'privacynotes.shortcut.lastNative';

/**
 * Shortcuts that reach an installed app: `privacynotes://note/<id>` on the
 * desktop, the `https://use.privacynotes.app/note` app link on a phone.
 * Mounted by the notes view, so it listens only while the vault is open. The
 * link the app was started with still opens after sign-in or unlock, because
 * the mount asks `getCurrent()`; a click while the app runs locked fires no
 * listener here.
 *
 * The one deep-link listener (deepLinks.ts) hands this hook only shortcut
 * links. `getCurrent()` hands back the launch link again after a webview
 * reload and after the view remounts, so a `launch` or `resume` link opens
 * only when it differs from the last one handled in this tab. An `open`
 * event is a new click and always opens. Android delivers a link to a
 * running app without firing `onOpenUrl`, so deepLinks.ts also reads the
 * current link on a resume.
 *
 * Spec: docs/internal/specs/note-shortcuts.md (5.2)
 */
export function useShortcutDeepLinks(onTarget: (t: ShortcutTarget) => void): void {
  const onTargetRef = useRef(onTarget);
  onTargetRef.current = onTarget;

  useEffect(() => {
    if (detectPlatform() === 'web') return;
    const link = takeDeepLinks('shortcut', (url, way) => {
      const t = parseShortcut(url);
      if (!t) return;
      try {
        if (way !== 'open' && sessionStorage.getItem(LAST_KEY) === url) return;
        sessionStorage.setItem(LAST_KEY, url);
      } catch {
        /* storage unavailable: the link opens, a replay may open it again */
      }
      onTargetRef.current(t);
    }, { launch: true });
    return link.stop;
  }, []);
}
