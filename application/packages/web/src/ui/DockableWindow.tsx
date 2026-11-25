import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { detectPlatform } from '../devices';
import { ArrowsIn, ArrowsLeftRight, ArrowsOut, SidebarSimple } from '../icons';
import { isImeComposing } from '../imeComposing';
import { useEscapeToClose } from '../useEscapeToClose';
import { useIsMobile } from '../useIsMobile';
import { CloseButton, IconButton } from './Button';
import { keepTabInside, useWindowFocus } from './Modal';

// Spec: docs/internal/design/patterns/181-190.md (section 183)

/** A desktop window's layout mode (device-local): normal centered modal,
 *  full-app edge-to-edge modal, or a live-app side panel docked at an edge. */
export type WindowSize = 'normal' | 'full' | 'side';

/** The edge a docked panel sits at (device-local): end (right in LTR) by default. */
export type DockEdge = 'start' | 'end';

/** The docked panel's width, in px (matches `w-[480px]`). */
const DOCK_WIDTH = 480;

/** The iOS and Android apps show large windows full-screen already. */
export const NATIVE_PHONE = detectPlatform() === 'ios' || detectPlatform() === 'android';

/** Android resizes the page for the keyboard (the app, and Chrome with `interactive-widget=resizes-content`). */
export const ANDROID_LIKE =
  detectPlatform() === 'android' || (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent));

export function readWindowSize(
  storage: Pick<Storage, 'getItem'>,
  storagePrefix = 'privacynotes.settings',
  legacyWideKey?: string,
): WindowSize {
  try {
    const v = storage.getItem(`${storagePrefix}.size`);
    if (v === 'normal' || v === 'full' || v === 'side') return v;
    if (legacyWideKey && storage.getItem(legacyWideKey) === '1') return 'full';
    return 'normal';
  } catch {
    return 'normal';
  }
}

export function readDockEdge(
  storage: Pick<Storage, 'getItem'>,
  storagePrefix = 'privacynotes.settings',
): DockEdge {
  try {
    return storage.getItem(`${storagePrefix}.edge`) === 'start' ? 'start' : 'end';
  } catch {
    return 'end';
  }
}

/**
 * Where the docked panel starts and ends so it covers neither the app's header
 * row nor its footer. The top is the lowest header under the panel's span: a
 * row marked `data-pn-dock-header` (the editor's title row, under the tab
 * strip), else the 3.5rem row every column draws (`h-14`). The bottom is the
 * top of the footer marked `data-pn-dock-footer`.
 */
function dockInsets(edge: DockEdge, widthPx = DOCK_WIDTH): { top: number; bottom: number } {
  const rtl = document.documentElement.dir === 'rtl';
  const atRight = (edge === 'end') !== rtl;
  const x0 = atRight ? window.innerWidth - widthPx : 0;
  const x1 = x0 + widthPx;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  let top = 3.5 * rem;
  for (const el of document.querySelectorAll('[data-pn-dock-header]')) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.right > x0 && r.left < x1) top = Math.max(top, r.bottom);
  }
  let bottom = 0;
  for (const el of document.querySelectorAll('[data-pn-dock-footer]')) {
    const r = el.getBoundingClientRect();
    if (r.height > 0) bottom = Math.max(bottom, window.innerHeight - r.top);
  }
  return { top: Math.round(top), bottom: Math.round(bottom) };
}

export interface WindowDockState {
  size: WindowSize;
  edge: DockEdge;
  /** True when the window fills the viewport on desktop (`size === 'full'`). */
  wide: boolean;
  /** True when docked as a live side panel on desktop (`size === 'side'` at `>= lg`). */
  docked: boolean;
  /** True below the `lg` breakpoint. */
  isMobile: boolean;
  insets: { top: number; bottom: number };
  mountReady: boolean;
  dockRef: RefObject<HTMLDivElement | null>;
  onTop: () => boolean;
  pickSize: (next: WindowSize) => void;
  flipEdge: () => void;
  onDockedKey: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Shared state and behavior for any window that can switch between normal,
 * full-window, and side-docked beside the live app.
 */
export function useWindowDock({
  storagePrefix,
  legacyWideKey,
  onEscape,
  escapeEnabled = true,
  dockWidth = DOCK_WIDTH,
}: {
  storagePrefix: string;
  legacyWideKey?: string;
  onEscape: () => void;
  escapeEnabled?: boolean;
  dockWidth?: number;
}): WindowDockState {
  const [size, setSize] = useState<WindowSize>(() => {
    try {
      return readWindowSize(localStorage, storagePrefix, legacyWideKey);
    } catch {
      return 'normal';
    }
  });
  const [edge, setEdge] = useState<DockEdge>(() => {
    try {
      return readDockEdge(localStorage, storagePrefix);
    } catch {
      return 'end';
    }
  });
  const isMobile = useIsMobile();
  const wide = size === 'full' && !isMobile && !NATIVE_PHONE;
  const docked = size === 'side' && !isMobile && !NATIVE_PHONE;

  const flipEdge = useCallback(() => {
    setEdge((prev) => {
      const value: DockEdge = prev === 'start' ? 'end' : 'start';
      try {
        localStorage.setItem(`${storagePrefix}.edge`, value);
      } catch {
        // The panel still moves for this visit.
      }
      return value;
    });
  }, [storagePrefix]);

  // A click on the size that is on goes back to the normal window.
  const pickSize = useCallback((next: WindowSize) => {
    setSize((prev) => {
      const value: WindowSize = prev === next ? 'normal' : next;
      try {
        localStorage.setItem(`${storagePrefix}.size`, value);
        if (legacyWideKey) localStorage.removeItem(legacyWideKey);
      } catch {
        // The size still changes for this visit.
      }
      return value;
    });
  }, [storagePrefix, legacyWideKey]);

  // Guard against the ghost click from the element that opened us landing on
  // the backdrop and dismissing immediately.
  const [mountReady, setMountReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMountReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Docked, the app beside the panel stays live, so the panel stays off the
  // global overlay stack and handles Escape only while focus is inside it.
  const onTop = useEscapeToClose(onEscape, !docked && escapeEnabled);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  const onDockedKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || isImeComposing(e)) return;
    e.preventDefault();
    e.stopPropagation();
    onEscapeRef.current();
  }, []);

  useEffect(() => {
    if (docked && !dockRef.current?.contains(document.activeElement)) {
      dockRef.current?.focus({ preventScroll: true });
    }
  }, [docked]);

  const [insets, setInsets] = useState({ top: 0, bottom: 0 });
  useLayoutEffect(() => {
    if (!docked) return;
    const apply = () => {
      const next = dockInsets(edge, dockWidth);
      setInsets((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
    };
    apply();
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    window.addEventListener('resize', measure);
    document.addEventListener('pointerup', measure, true);
    document.addEventListener('keyup', measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      document.removeEventListener('pointerup', measure, true);
      document.removeEventListener('keyup', measure, true);
    };
  }, [docked, edge, dockWidth]);

  return {
    size,
    edge,
    wide,
    docked,
    isMobile,
    insets,
    mountReady,
    dockRef,
    onTop,
    pickSize,
    flipEdge,
    onDockedKey,
  };
}

/**
 * Header controls for any dockable/full-screen window:
 * - Modal: Dock to the side (`SidebarSimple`) + Use the full window / Back to normal size (`ArrowsOut` / `ArrowsIn`).
 * - Docked: Move to the other side (`ArrowsLeftRight`) + Back to the normal size (`ArrowsIn`).
 * Hidden on phones and viewports below `lg`.
 */
export function WindowSizeButtons({
  docked,
  wide,
  isMobile,
  pickSize,
  flipEdge,
}: {
  docked: boolean;
  wide: boolean;
  isMobile: boolean;
  pickSize: (next: WindowSize) => void;
  flipEdge: () => void;
}) {
  const { t } = useTranslation('settings');
  if (NATIVE_PHONE || isMobile) return null;
  if (docked) {
    return (
      <>
        <IconButton label={t('shell.dockOtherSide')} position="below" onClick={flipEdge}>
          <ArrowsLeftRight aria-hidden="true" />
        </IconButton>
        <IconButton label={t('shell.restoreWindow')} position="below" onClick={() => pickSize('side')}>
          <ArrowsIn aria-hidden="true" />
        </IconButton>
      </>
    );
  }
  return (
    <>
      <IconButton label={t('shell.dockWindow')} position="start" onClick={() => pickSize('side')}>
        <SidebarSimple aria-hidden="true" />
      </IconButton>
      <IconButton
        label={wide ? t('shell.restoreWindow') : t('shell.fillWindow')}
        position="start"
        onClick={() => pickSize('full')}
        aria-pressed={wide}
      >
        {wide ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
      </IconButton>
    </>
  );
}

export function dockBackdropClass({
  docked,
  wide,
  edge,
  isMobile,
  backdropTone = 'dim',
}: {
  docked: boolean;
  wide: boolean;
  edge: DockEdge;
  isMobile: boolean;
  backdropTone?: 'subtle' | 'dim';
}): string {
  if (docked) {
    return `fixed inset-0 flex z-40 pointer-events-none ${edge === 'end' ? 'justify-end' : 'justify-start'} items-stretch`;
  }
  const tint = backdropTone === 'subtle' ? 'bg-black/20 dark:bg-black/20' : 'bg-black/50 dark:bg-black/70';
  const align = isMobile
    ? 'items-stretch sm:items-center sm:p-4'
    : wide
      ? 'items-stretch'
      : 'items-center p-4 sm:p-6';
  return `fixed inset-0 flex z-50 justify-center ${tint} ${align}`;
}

export function dockPanelClass(edge: DockEdge): string {
  return `pointer-events-auto w-[480px] max-w-full h-full flex flex-col text-pn bg-surface-2 ${edge === 'end' ? 'border-s' : 'border-e'} border-divider shadow-lg outline-none`;
}

export interface DockableWindowRenderState {
  size: WindowSize;
  edge: DockEdge;
  docked: boolean;
  wide: boolean;
  isMobile: boolean;
}

/**
 * @catalog DockableWindow
 * use: (import from `./ui/DockableWindow` directly, not from `ui`) every desktop window that can switch between normal size, full window, and a live side panel docked between the app's header and footer (Settings, Graph and Places, and future workspace windows). Owns the device-local `.size` and `.edge` keys, the header controls (`WindowSizeButtons` + `CloseButton`), Escape and focus behavior in both modal and docked modes, and `[data-pn-dock-header]`/`[data-pn-dock-footer]` measurement. Windows with a custom multi-pane header (Settings) share `useWindowDock` and `WindowSizeButtons` from this file.
 * never: a second copy of `dockInsets`, `readWindowSize`, `readDockEdge`, or hand-drawn dock/fullscreen buttons in a window.
 */
export function DockableWindow({
  storagePrefix,
  title,
  icon,
  onClose,
  onEscape,
  normalClassName = 'max-w-5xl h-[min(90vh,56rem)]',
  backdropTone = 'dim',
  noAppMenu = false,
  children,
}: {
  /** Device-local storage prefix (`<prefix>.size`, `<prefix>.edge`). */
  storagePrefix: string;
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  /** Optional Escape handler (defaults to `onClose`) so a window can step through local states first. */
  onEscape?: () => void;
  /** Panel size classes when in `normal` mode on desktop. */
  normalClassName?: string;
  /** `dim` matches `Modal`; `subtle` matches Settings so the app behind stays legible. */
  backdropTone?: 'subtle' | 'dim';
  /** Sets `data-no-app-menu` so the global context menu stays out of prose windows. */
  noAppMenu?: boolean;
  children: ReactNode | ((state: DockableWindowRenderState) => ReactNode);
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dock = useWindowDock({ storagePrefix, onEscape: onEscape ?? onClose });
  useWindowFocus(panelRef, !dock.docked);

  const phoneHeight = ANDROID_LIKE ? 'h-full' : 'h-[var(--pn-app-h,100%)]';
  const panelClass = dock.docked
    ? dockPanelClass(dock.edge)
    : dock.wide
      ? 'bg-surface-2 w-full h-full max-h-full flex flex-col overflow-hidden text-pn outline-none'
      : `bg-surface-2 border border-divider text-pn rounded-lg w-full flex flex-col overflow-hidden outline-none max-sm:fixed max-sm:inset-0 max-sm:h-auto max-sm:max-w-none max-sm:rounded-none max-sm:border-0 ${dock.isMobile ? `${phoneHeight} sm:h-[min(90vh,56rem)]` : ''} ${normalClassName}`;

  const body =
    typeof children === 'function'
      ? children({ size: dock.size, edge: dock.edge, docked: dock.docked, wide: dock.wide, isMobile: dock.isMobile })
      : children;

  return (
    <div
      data-no-app-menu={noAppMenu ? '' : undefined}
      role={dock.docked ? 'region' : undefined}
      aria-label={dock.docked && typeof title === 'string' ? title : undefined}
      aria-labelledby={dock.docked && typeof title !== 'string' ? titleId : undefined}
      style={dock.docked ? { top: dock.insets.top, bottom: dock.insets.bottom } : undefined}
      className={dockBackdropClass({
        docked: dock.docked,
        wide: dock.wide,
        edge: dock.edge,
        isMobile: dock.isMobile,
        backdropTone,
      })}
      onPointerDown={
        !dock.docked
          ? (e) => {
              if (dock.mountReady && e.target === e.currentTarget) onClose();
            }
          : undefined
      }
    >
      <div
        ref={(el) => {
          panelRef.current = el;
          dock.dockRef.current = el;
        }}
        role={dock.docked ? undefined : 'dialog'}
        aria-modal={dock.docked ? undefined : 'true'}
        aria-labelledby={dock.docked ? undefined : titleId}
        tabIndex={-1}
        onKeyDown={dock.docked ? dock.onDockedKey : (e) => keepTabInside(e, panelRef.current)}
        className={panelClass}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-divider px-5 py-3">
          <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-heading font-semibold text-pn">
            {icon && <span className="shrink-0 text-accent" aria-hidden="true">{icon}</span>}
            <span className="min-w-0 truncate">{title}</span>
          </h2>
          <div className="ms-auto flex shrink-0 items-center gap-1">
            <WindowSizeButtons
              docked={dock.docked}
              wide={dock.wide}
              isMobile={dock.isMobile}
              pickSize={dock.pickSize}
              flipEdge={dock.flipEdge}
            />
            <CloseButton onClick={onClose} />
          </div>
        </div>
        {body}
      </div>
    </div>
  );
}
