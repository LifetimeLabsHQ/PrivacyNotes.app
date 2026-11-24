import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, Check } from './icons';
import { Spinner } from './ui';
import { isTouchPointer } from './useIsMobile';
import { hasOpenOverlay } from './useEscapeToClose';
import { hasOpenSwipeRow } from './swipeRow';

/** Pull movement ignored before the indicator engages, so taps and micro-jitters stay quiet. */
export const PULL_DEADZONE_PX = 10;
/** Damped indicator height required to arm a manual sync on release. */
export const PULL_TRIGGER_PX = 52;
/** Ceiling on damped pull travel. */
export const PULL_MAX_PX = 84;
/** Resting height of the bar while syncing or showing the brief "Synced" confirmation. */
const PULL_BAR_HEIGHT_PX = 44;

const MIN_SYNC_DWELL_MS = 450;
const DONE_DWELL_MS = 650;

type PullSyncState = 'idle' | 'pulling' | 'armed' | 'syncing' | 'done';

export interface PullToSyncTarget {
  /** False in demo mode, local-only mode, or while sync is paused. */
  available: boolean;
  /** Runs one sync pass and resolves when it completes. */
  run: () => Promise<void>;
}

export const PullToSyncContext = createContext<PullToSyncTarget | null>(null);

/** Convert raw downward touch travel (px) into damped indicator height. */
export function dampedPull(rawDy: number): number {
  if (rawDy <= PULL_DEADZONE_PX) return 0;
  return Math.min(PULL_MAX_PX, Math.round((rawDy - PULL_DEADZONE_PX) * 0.5));
}

export interface PullToSyncView {
  pullPx: number;
  state: PullSyncState;
  dragging: boolean;
}

const IDLE_VIEW: PullToSyncView = { pullPx: 0, state: 'idle', dragging: false };

/**
 * Pull-down-to-sync gesture on a scrollable touch list or Home screen.
 * Only activates on touch-first devices when the scroller starts at the top,
 * sync is available, and no overlay or swiped row is active.
 */
export function usePullToSync(
  scrollRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): PullToSyncView {
  const ctx = useContext(PullToSyncContext);
  const available = enabled && !!ctx?.available;
  const runRef = useRef(ctx?.run);
  runRef.current = ctx?.run;

  const [view, setView] = useState<PullToSyncView>(IDLE_VIEW);
  const stateRef = useRef<PullSyncState>('idle');
  stateRef.current = view.state;

  useEffect(() => {
    if (!available) {
      setView(IDLE_VIEW);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;

    let mounted = true;
    let doneTimer: number | null = null;
    let active: { id: number; x: number; y: number; locked: boolean; pullPx: number } | null = null;

    const clearDoneTimer = () => {
      if (doneTimer != null) {
        window.clearTimeout(doneTimer);
        doneTimer = null;
      }
    };

    function onTouchStart(e: TouchEvent) {
      if (stateRef.current === 'syncing' || stateRef.current === 'done') return;
      if (!isTouchPointer() || e.touches.length !== 1) return;
      if (hasOpenOverlay() || hasOpenSwipeRow()) return;
      if (!el || el.scrollTop > 1) return;
      const t = e.touches[0];
      if (!t) return;
      const target = t.target instanceof Element ? t.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"], [data-no-pull], .pn-card-grip')) return;
      active = { id: t.identifier, x: t.clientX, y: t.clientY, locked: false, pullPx: 0 };
    }

    function onTouchMove(e: TouchEvent) {
      const a = active;
      if (!a || !el) return;
      if (e.touches.length !== 1) {
        active = null;
        setView(IDLE_VIEW);
        return;
      }
      let t: Touch | undefined;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const c = e.changedTouches[i];
        if (c && c.identifier === a.id) { t = c; break; }
      }
      if (!t) return;
      const dx = t.clientX - a.x;
      const dy = t.clientY - a.y;

      if (!a.locked) {
        if (el.scrollTop > 1 || dy < 0 || Math.abs(dx) > dy) {
          if (Math.abs(dx) >= PULL_DEADZONE_PX || dy <= -PULL_DEADZONE_PX || el.scrollTop > 1) {
            active = null;
          }
          return;
        }
        if (dy < PULL_DEADZONE_PX) return;
        a.locked = true;
      }

      if (dy <= 0) {
        a.pullPx = 0;
        setView(IDLE_VIEW);
        return;
      }

      if (e.cancelable) e.preventDefault();
      const pullPx = dampedPull(dy);
      a.pullPx = pullPx;
      setView({
        pullPx,
        state: pullPx >= PULL_TRIGGER_PX ? 'armed' : 'pulling',
        dragging: true,
      });
    }

    function onTouchEnd() {
      const a = active;
      active = null;
      if (!a || !a.locked) return;

      if (a.pullPx >= PULL_TRIGGER_PX && runRef.current) {
        setView({ pullPx: PULL_BAR_HEIGHT_PX, state: 'syncing', dragging: false });
        const startedAt = performance.now();
        let job: Promise<void>;
        try {
          job = Promise.resolve(runRef.current());
        } catch {
          job = Promise.resolve();
        }
        void job
          .catch(() => {})
          .finally(() => {
            const wait = Math.max(0, MIN_SYNC_DWELL_MS - (performance.now() - startedAt));
            clearDoneTimer();
            doneTimer = window.setTimeout(() => {
              if (!mounted) return;
              setView({ pullPx: PULL_BAR_HEIGHT_PX, state: 'done', dragging: false });
              doneTimer = window.setTimeout(() => {
                if (!mounted) return;
                setView(IDLE_VIEW);
              }, DONE_DWELL_MS);
            }, wait);
          });
        return;
      }

      setView(IDLE_VIEW);
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      mounted = false;
      clearDoneTimer();
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [available, scrollRef]);

  return view;
}

/**
 * Collapsing indicator band rendered directly above a scrollable list or Home
 * grid. Zero height when idle so it adds no layout shift at rest.
 */
export function PullToSyncBar({ pullPx, state, dragging }: PullToSyncView) {
  const { t } = useTranslation('settings');
  const height = state === 'syncing' || state === 'done' ? PULL_BAR_HEIGHT_PX : pullPx;
  const visible = height > 0 || state !== 'idle';

  return (
    <div
      data-pull-sync={state}
      aria-live="polite"
      style={{ height }}
      className={`shrink-0 overflow-hidden bg-surface-0/70 select-none ${
        visible ? 'border-b border-divider/60' : ''
      } ${dragging ? '' : 'transition-[height] duration-200 motion-reduce:transition-none'}`}
    >
      {visible && (
        <div className="flex h-full items-center justify-center gap-2 text-small font-medium text-pn-muted">
          {state === 'syncing' ? (
            <>
              <Spinner />
              <span>{t('syncStatus.syncing')}</span>
            </>
          ) : state === 'done' ? (
            <>
              <Check aria-hidden="true" className="text-success shrink-0" />
              <span className="text-pn">{t('syncStatus.synced')}</span>
            </>
          ) : (
            <>
              <ArrowDown
                aria-hidden="true"
                className={`text-accent shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
                  state === 'armed' ? 'rotate-180' : ''
                }`}
              />
              <span>{state === 'armed' ? t('syncPanel.syncNow') : t('tabs.sync')}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
