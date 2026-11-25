import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassMinus, MagnifyingGlassPlus, X } from '../icons';
import { CanvasControlBar, CanvasControlDivider, HoverLabel, IconButton } from '../ui';
import { isEditableTarget } from '../ContextMenu';
import { hasOpenOverlay } from '../useEscapeToClose';
import { keyText } from '../shortcutMatch';
import {
  DEFAULT_FULL_SCREEN_SCALE,
  FULL_SCREEN_SCALES,
  formatFullScreenPercent,
  type FullScreenScale,
} from '../fullScreen';

const HIDE_DELAY_MS = 2200;
const WHEEL_THROTTLE_MS = 140;

/**
 * Floating hover-only controls for Full screen mode (GitHub #911).
 *
 * Starts hidden so projecting a note onto a second screen shows zero UI.
 * Any pointer movement reveals the corner pill briefly and fades it away
 * once the pointer stops; hovering or focusing inside holds it open.
 *
 * Also intercepts +/-/0 and Ctrl/Cmd+scroll while Full screen is active so
 * text resizing stays local to the note without changing the app's zoom.
 */
export function FullScreenControls({
  scale,
  onStep,
  onReset,
  onExit,
}: {
  scale: FullScreenScale;
  onStep: (direction: 1 | -1) => void;
  onReset: () => void;
  onExit: () => void;
}) {
  const { t } = useTranslation('notes');
  const [visible, setVisible] = useState(false);
  const pinnedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const wheelStampRef = useRef(0);
  const callbacksRef = useRef({ onStep, onReset, onExit });
  callbacksRef.current = { onStep, onReset, onExit };

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const scheduleHide = () => {
      clearTimer();
      if (pinnedRef.current) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!pinnedRef.current) setVisible(false);
      }, HIDE_DELAY_MS);
    };
    const reveal = () => {
      setVisible(true);
      scheduleHide();
    };
    window.addEventListener('pointermove', reveal, { passive: true });
    return () => {
      clearTimer();
      window.removeEventListener('pointermove', reveal);
    };
  }, []);

  // Capture-phase keyboard & Ctrl/Cmd+wheel scaling while Full screen is active.
  // Runs before useKeyboardShortcuts and browser/webview zoom so the rest of
  // the app never changes scale.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hasOpenOverlay() || e.altKey) return;
      const mod = e.metaKey || e.ctrlKey;
      const typing = isEditableTarget(e.target);
      if (!mod && typing) return;
      if (e.key === '+' || e.key === '=' || (mod && e.code === 'Equal')) {
        e.preventDefault();
        e.stopPropagation();
        callbacksRef.current.onStep(1);
        return;
      }
      if (e.key === '-' || e.key === '_' || (mod && e.code === 'Minus')) {
        e.preventDefault();
        e.stopPropagation();
        callbacksRef.current.onStep(-1);
        return;
      }
      if (e.key === '0' && (!typing || mod)) {
        e.preventDefault();
        e.stopPropagation();
        callbacksRef.current.onReset();
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (hasOpenOverlay()) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const now = Date.now();
      if (now - wheelStampRef.current < WHEEL_THROTTLE_MS) return;
      wheelStampRef.current = now;
      callbacksRef.current.onStep(e.deltaY < 0 ? 1 : -1);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  const holdOpen = () => {
    pinnedRef.current = true;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(true);
  };

  const releaseHold = () => {
    pinnedRef.current = false;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!pinnedRef.current) setVisible(false);
    }, HIDE_DELAY_MS);
  };

  const atMin = scale <= FULL_SCREEN_SCALES[0];
  const atMax = scale >= FULL_SCREEN_SCALES[FULL_SCREEN_SCALES.length - 1]!;
  const atDefault = scale === DEFAULT_FULL_SCREEN_SCALE;

  return (
    <div
      data-pn-fullscreen-controls=""
      inert={!visible}
      onPointerEnter={holdOpen}
      onPointerLeave={releaseHold}
      onFocusCapture={holdOpen}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) releaseHold();
      }}
      className={`fixed top-4 end-4 z-30 transition-opacity duration-200 motion-reduce:transition-none ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <CanvasControlBar aria-label={t('drawing.fullScreen')}>
        <IconButton
          label={t('fullScreen.smallerText')}
          keys="-"
          position="below"
          disabled={atMin}
          onClick={() => onStep(-1)}
        >
          <MagnifyingGlassMinus aria-hidden="true" />
        </IconButton>
        <HoverLabel label={t('fullScreen.resetTextSize')} keys="0" position="below">
          <button
            type="button"
            disabled={atDefault}
            onClick={onReset}
            aria-label={t('fullScreen.resetTextSize')}
            className="inline-flex h-8 min-w-[3.25rem] items-center justify-center rounded-md text-compact font-medium tabular-nums text-pn-soft hover:text-pn hover:bg-pn/10 disabled:opacity-60 disabled:hover:bg-transparent transition"
          >
            {formatFullScreenPercent(scale)}
          </button>
        </HoverLabel>
        <IconButton
          label={t('fullScreen.largerText')}
          keys="+"
          position="below"
          disabled={atMax}
          onClick={() => onStep(1)}
        >
          <MagnifyingGlassPlus aria-hidden="true" />
        </IconButton>
        <CanvasControlDivider />
        <IconButton
          label={t('fullScreen.exit')}
          keys={keyText('escape')}
          position="below-end"
          onClick={onExit}
        >
          <X aria-hidden="true" />
        </IconButton>
      </CanvasControlBar>
    </div>
  );
}
