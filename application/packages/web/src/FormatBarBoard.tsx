import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, DotsSixVertical, DotsThree, Paperclip, Plus, PushPin, Rows } from './icons';
import { RowTitle, SETTINGS_EYEBROW, SETTINGS_HELP, SETTINGS_TRACK, settingsSegClass } from './settingsUI';
import { useEscapeToClose } from './useEscapeToClose';
import { DRAG_SOURCE, DropLine, usePointerReorder } from './ui';
import { HoverLabel } from './HoverLabel';
import { useIsTouchDevice } from './useIsMobile';
import { usePopoverPosition } from './usePopoverPosition';
import {
  FORMAT_BAR,
  homeOf,
  type BarModel,
  type FormatBarHome,
  type FormatBarRefusal,
  type ResolvedFormatBar,
} from './formatBar';
import { FORMAT_BAR_LOOK } from './formatBarItems';
import type { Icon as IconType } from './icons';
import type { BarPosition } from './editorPrefs';

export type FormatBarBoardProps = {
  layout: ResolvedFormatBar;
  onUpdate: (move: (current: ResolvedFormatBar) => ResolvedFormatBar | null) => void;
  /** Where the bar sits, top or bottom; free and per device. */
  position?: BarPosition;
  onPositionChange?: (next: BarPosition) => void;
  /** Drawn under the bar position row, over the arranging part: the
   *  pane's headline, with the Pro mark. */
  heading?: ReactNode;
  /** A free account: the board arranges a draft that is not saved. */
  locked?: boolean;
  /** The draft differs from the saved layout. */
  previewing?: boolean;
  /** Hands the draft to the upgrade window. */
  onKeep?: () => void;
  onDiscard?: () => void;
  /** The tab opened and closed: the draft goes on close, unless it was
   *  handed on. */
  onEnter?: () => void;
  onLeave?: () => void;
  /** Another bar's rules and looks (the drawing toolbar's), which has no
   *  menus: its items live on the bar, at its end, or hidden. */
  bar?: {
    model: BarModel;
    look: Readonly<Record<string, { Icon: IconType; label: string }>>;
    /** What a hidden item still does, in place of the format bar's line:
     *  a label key with its namespace. */
    hiddenNote: string;
  };
  /** The drawing toolbar's board, which the Settings tab shows beside this one. */
  drawing?: Omit<FormatBarBoardProps, 'drawing' | 'position' | 'onPositionChange'>;
};

/** A part of the board: the bar's row, the bar's end, the menu, the attach menu, hidden. */
type Part = FormatBarHome;

/**
 * Settings > Toolbar: the bar itself, every item
 * named and in its left-to-right order, the hidden row right under it, then
 * the + menu with a column for each group. On a narrow pane the groups
 * stack.
 *
 * Every item is a button. A click opens its menu (move up, move down, and
 * the three homes), which is the whole of the tab for the keyboard and for a
 * finger. Under a pointer an item also drags: onto another item (it lands
 * before it) or onto the bar or a column (it lands at the end).
 *
 * Moves that would break the bar are refused with a line that says why. Every
 * write goes through `onUpdate`, which applies the move to the freshest
 * arrangement in the settings cache, never to the one this render drew.
 * Spec: docs/internal/specs/format-bar.md (section 5)
 */
export function FormatBarBoard({ layout, onUpdate, position = 'top', onPositionChange, previewing = false, onEnter, onLeave, heading, bar }: FormatBarBoardProps) {
  const { t } = useTranslation('editor');
  const model = bar?.model ?? FORMAT_BAR;
  const look = bar?.look ?? FORMAT_BAR_LOOK;
  // Only the format bar has the + menu and the attach menu.
  const menus = !bar;
  const { item: formatBarItem, refusalFor, placeItem, stepItem, canStep } = model;
  const touch = useIsTouchDevice();
  const canDrag = !touch;
  const [refusal, setRefusal] = useState<{ reason: Exclude<FormatBarRefusal, null>; key: string } | null>(null);
  // The bar marches its edge for a moment when the tab opens (pn-bar-ants).
  const [barIntro, setBarIntro] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setBarIntro(false), 1200);
    return () => window.clearTimeout(id);
  }, []);
  const lifeRef = useRef({ onEnter, onLeave });
  lifeRef.current = { onEnter, onLeave };
  useEffect(() => {
    lifeRef.current.onEnter?.();
    return () => lifeRef.current.onLeave?.();
  }, []);
  const [overPart, setOverPart] = useState<Part | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  // A move remounts the item in its new column, so the focus is put back on
  // it by key after the render that moved it.
  const [refocus, setRefocus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPos = usePopoverPosition(menuKey !== null, anchorRef, menuRef);

  const label = (key: string) => t(look[key]!.label);
  const itemButton = (key: string) =>
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-key="${key}"][data-item]`) ?? null;

  // The focus goes back to the control that opened the menu (an item or an
  // icon of the live bar) while it is still in the page, else to the item.
  useEffect(() => {
    if (!refocus) return;
    const opener = anchorRef.current;
    if (opener?.isConnected) opener.focus();
    else itemButton(refocus)?.focus();
    setRefocus(null);
  }, [refocus, layout]);

  function closeMenu(focusItem = true) {
    const key = menuKey;
    setMenuKey(null);
    if (focusItem && key) setRefocus(key);
  }
  useEscapeToClose(() => closeMenu(), menuKey !== null);

  // The menu is hidden until it has a position, and a hidden button takes no
  // focus, so the focus moves in once the position is known.
  const menuPlaced = menuPos !== null;
  useEffect(() => {
    if (menuKey !== null && menuPlaced) {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
  }, [menuKey, menuPlaced]);

  useEffect(() => {
    if (menuKey === null) return;
    function outside(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setMenuKey(null);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menuKey]);

  /** Apply a move, or say why it is refused. */
  function moveTo(key: string, to: FormatBarHome, beforeKey: string | null = null) {
    const reason = refusalFor(layout, key, to);
    if (reason) {
      setRefusal({ reason, key });
      return;
    }
    setRefusal(null);
    onUpdate((current) => placeItem(current, key, to, beforeKey));
  }

  function openMenu(key: string, anchor: HTMLElement) {
    if (menuKey === key) {
      setMenuKey(null);
      return;
    }
    anchorRef.current = anchor;
    setRefusal(null);
    if (menuKey === null) {
      setMenuKey(key);
      return;
    }
    // The position is measured when the menu opens, so a menu that moves to
    // another item closes for one render and opens there (the effect below).
    pendingMenu.current = key;
    setMenuKey(null);
  }
  const pendingMenu = useRef<string | null>(null);
  useEffect(() => {
    if (menuKey !== null || !pendingMenu.current) return;
    const key = pendingMenu.current;
    pendingMenu.current = null;
    setMenuKey(key);
  }, [menuKey]);

  // Up and Down move between the menu's choices, Home and End to the ends.
  // Tab closes the menu and gives the focus back to the item that opened it:
  // the menu sits at the end of the page, so a Tab out of it would land
  // behind the Settings window.
  function menuKeys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
      return;
    }
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'ArrowDown' ? (at + 1) % items.length
      : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    items[to]!.focus();
  }

  // Drag, under a pointer: the shared reorder engine (ui/reorder.tsx), the
  // same feel as the folders, the sidebar rows and the tabs. A finger uses
  // the item menu, which holds every move. While a drag is on, `target` says
  // where the item would land and a line is drawn there: the half of the
  // item nearest the pointer decides before or after it, and the empty part
  // of a list means its end. A spot where the item already is draws nothing,
  // and a refused home takes no drop (the cursor says so) and shows its
  // reason. The drop applies the target, never a guess.
  type DropTarget = { part: Part; before: string | null; refused?: Exclude<FormatBarRefusal, null> };
  const groupOf = (k: string) => formatBarItem(k)!.group;
  const listOf = (part: Part) =>
    layout[part];
  /** The key after `key` in its list (in the menu, inside its group), or null at the end. */
  function nextIn(part: Part, key: string): string | null {
    const list = listOf(part);
    const next = list[list.indexOf(key) + 1] ?? null;
    return part === 'menu' && next && groupOf(next) !== groupOf(key) ? null : next;
  }

  /** Where the dragged item would land for `before` in `part`, null for no move. */
  function aim(key: string, part: Part, before: string | null): DropTarget | null {
    const item = formatBarItem(key)!;
    const refused = refusalFor(layout, key, part);
    if (refused) return { part, before: null, refused };
    let at = before;
    // In the menu an item lands in its own group, at the end when the spot is in another.
    if (part === 'menu' && at && groupOf(at) !== item.group) at = null;
    if (homeOf(layout, key) === part && (at === key || at === nextIn(part, key))) return null;
    if (homeOf(layout, key) === part && at === null && nextIn(part, key) === null) return null;
    return { part, before: at };
  }

  /** The zone under a point, then the item in it nearest the point. */
  function resolve(key: string, x: number, y: number): DropTarget | null {
    const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-reorder-zone]');
    if (!zone || !rootRef.current?.contains(zone)) return null;
    const part = zone.dataset.reorderZone as Part;
    const sideways = part !== 'menu' && part !== 'attachMenu';
    let best: { el: HTMLElement; gap: number } | null = null;
    for (const el of zone.querySelectorAll<HTMLElement>('[data-reorder-id]')) {
      if (el.closest('[data-reorder-zone]') !== zone) continue;
      const box = el.getBoundingClientRect();
      // A bar row wraps and the menu has columns, so the nearest item is
      // measured both ways.
      const gap = Math.max(box.left - x, 0, x - box.right) + Math.max(box.top - y, 0, y - box.bottom);
      if (!best || gap < best.gap) best = { el, gap };
    }
    if (!best) return aim(key, part, null);
    const over = best.el.dataset.reorderId!;
    const box = best.el.getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    const after = sideways
      ? (rtl ? x < box.left + box.width / 2 : x > box.left + box.width / 2)
      : y > box.top + box.height / 2;
    return aim(key, part, after ? nextIn(part, over) : over);
  }

  const { drag, pressProps, endedDrag } = usePointerReorder<DropTarget>({
    enabled: canDrag,
    resolve,
    targetKey: (tg) => `${tg.part}:${tg.before}:${tg.refused ?? ''}`,
    onDrop: (key, at) => {
      if (at.refused) {
        setRefusal({ reason: at.refused, key });
        return;
      }
      moveTo(key, at.part, at.before);
    },
  });
  const dragKey = drag?.id ?? null;
  const target = drag?.target && !drag.target.refused ? drag.target : null;
  // A drag closes the item menu and clears an old refusal; a refused home
  // under the drag says why while it is there.
  useEffect(() => {
    if (dragKey) setMenuKey(null);
  }, [dragKey]);
  const dragRefusal = drag?.target?.refused ? { reason: drag.target.refused, key: drag.id } : null;

  /** The last key of the list a line at the end of `part` follows. */
  function lastIn(part: Part): string | null {
    if (part === 'menu' && dragKey) {
      const own = layout.menu.filter((k) => groupOf(k) === groupOf(dragKey));
      return own[own.length - 1] ?? null;
    }
    return layout[part][layout[part].length - 1] ?? null;
  }
  /** The landing line on an item: before it, or after the last one. */
  function lineOn(key: string, part: Part): ReactNode {
    if (!target || target.part !== part) return null;
    const sideways = part !== 'menu' && part !== 'attachMenu';
    if (target.before === key) return <DropLine edge={sideways ? 'start' : 'top'} />;
    if (target.before === null && lastIn(part) === key) return <DropLine edge={sideways ? 'end' : 'bottom'} />;
    return null;
  }

  function item(key: string, part: Part): ReactNode {
    const def = formatBarItem(key)!;
    const { Icon } = look[key]!;
    const home = homeOf(layout, key);
    const open = menuKey === key;
    const name = label(key);
    const common = {
      type: 'button' as const,
      'data-key': key,
      'data-item': '',
      'aria-haspopup': 'menu' as const,
      'aria-expanded': open,
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
        if (!endedDrag()) openMenu(key, e.currentTarget);
      },
      ...pressProps(key),
    };
    // On the bar and in the hidden row an item looks like its toolbar
    // button: the icon alone, the name in a hover label (and at the top of
    // its menu on touch). Only the two menus list names, as the toolbar's do.
    if (part !== 'menu' && part !== 'attachMenu') {
      const thinLine = key.startsWith('separator') && part !== 'hidden';
      // A hidden separator keeps a frame, so the row shows a grabbable item
      // and not a loose line.
      const framedLine = key.startsWith('separator') && part === 'hidden';
      return (
        <li key={key} data-reorder-id={key} className="relative shrink-0">
          {lineOn(key, part)}
          <HoverLabel label={name} position="below">
            <button
              {...common}
              aria-label={name}
              // On the bar a separator is the toolbar's thin line in a narrow
              // slot; in the hidden row it is a full button, so it can be seen and grabbed.
              className={`flex items-center justify-center ${thinLine ? 'w-2 [@media(hover:none)]:w-5' : 'w-8 [@media(hover:none)]:w-10'} h-8 [@media(hover:none)]:h-10 rounded-md transition ${
                open ? 'bg-accent/15 text-accent-strong' : 'text-pn-soft [@media(hover:hover)]:hover:bg-pn/10'
              } ${framedLine ? 'border border-divider' : ''} ${canDrag ? 'cursor-grab' : ''} ${dragKey === key ? DRAG_SOURCE : ''}`}
            >
              {thinLine
                ? <span aria-hidden="true" className="h-4 w-px bg-pn-muted/35" />
                : <Icon aria-hidden="true" />}
            </button>
          </HoverLabel>
        </li>
      );
    }
    return (
      <li key={key} data-reorder-id={key} className="relative">
        {lineOn(key, part)}
        <button
          {...common}
          className={`w-full flex items-center gap-2 min-h-[44px] [@media(hover:hover)]:min-h-[34px] rounded-md ps-2 pe-1.5 text-start text-body bg-surface-2 border transition ${
            open ? 'border-accent' : 'border-transparent [@media(hover:hover)]:hover:border-divider'
          } ${canDrag ? 'cursor-grab' : ''} ${dragKey === key ? DRAG_SOURCE : ''} ${home === 'hidden' ? 'text-pn-muted' : 'text-pn-soft'}`}
        >
          {canDrag && <DotsSixVertical className="shrink-0 text-pn-muted" aria-hidden="true" />}
          <Icon className="shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-0 leading-tight break-words hyphens-auto">{name}</span>
          {/* The pin says why the item cannot go into the menu. */}
          {part === 'menu' && !def.menuAllowed && <PushPin className="shrink-0 text-pn-muted" aria-label={t('formatBar.pinned')} />}
          {touch && <DotsThree className="shrink-0 text-pn-muted" aria-hidden="true" />}
        </button>
      </li>
    );
  }

  const empty = (text: string) => <p className="px-1 py-2 text-small text-pn-muted">{text}</p>;
  /** A column list; the drop line is drawn on its items. */
  const list = (keys: string[], part: Part) => (
    <ul className="space-y-1">
      {keys.map((k) => item(k, part))}
    </ul>
  );
  const subhead = (text: string) => (
    <div className="px-1 pt-3 pb-1 text-small text-pn-soft">{text}</div>
  );

  // In the menu the end of a list is the end of a group: the line goes at the
  // end of the dragged item's own group.
  const dragGroup = target?.part === 'menu' && dragKey ? groupOf(dragKey) : null;
  const menuColumn = layout.menu.length
    ? model.groups.map((g) => {
        const inGroup = layout.menu.filter((k) => groupOf(k) === g);
        // The menu keeps its groups. A group with nothing in it shows no
        // header, except while an item of that group is dragged over the
        // menu: then it shows where the item will land.
        if (!inGroup.length) {
          return g === dragGroup
            ? <div key={g}>{subhead(t(`insertGroup.${g}`))}<DropSlot /></div>
            : null;
        }
        return <div key={g} className="min-w-0">{subhead(t(`insertGroup.${g}`))}{list(inGroup, 'menu')}</div>;
      })
    : <>{empty(t('formatBar.menuEmpty'))}{target?.part === 'menu' && <DropSlot />}</>;
  // The attach menu, drawn under the Blocks group: the paperclip's own list,
  // a drop target of its own inside the + menu box.
  const attachSection = (
    <div
      key="attachMenu"
      data-reorder-zone="attachMenu"
      className={`min-w-0 mt-2 rounded-md transition-colors ${target?.part === 'attachMenu' ? 'bg-accent/10' : ''}`}
    >
      <div className="flex items-center gap-1.5 px-1 pt-3 pb-1 text-small text-pn-soft">
        <Paperclip aria-hidden="true" />{t('formatBar.inAttachMenu')}
      </div>
      {layout.attachMenu.length
        ? list(layout.attachMenu, 'attachMenu')
        : <>{empty(t('formatBar.attachMenuEmpty'))}{target?.part === 'attachMenu' && <DropSlot />}</>}
    </div>
  );
  const blocksAt = Array.isArray(menuColumn) ? model.groups.indexOf('blocks') : -1;
  const menuWithAttach = Array.isArray(menuColumn)
    ? menuColumn.map((col, n) => (n === blocksAt
        ? <div key="blocks" className="min-w-0">{col}{attachSection}</div>
        : col))
    : <>{menuColumn}{attachSection}</>;
  // The hidden row says what a hidden button still does, or how to hide one.
  // A separator is not a button, so it does not count as a hidden one.
  const hiddenNote = layout.hidden.some((k) => !k.startsWith('separator')) ? t(bar?.hiddenNote ?? 'formatBar.hiddenNote')
    : canDrag ? t('formatBar.hiddenDrop')
    : t('formatBar.hiddenEmpty');
  const overBar = target?.part === 'bar' || target?.part === 'end';
  const shownRefusal = dragRefusal ?? refusal;

  const menuItem = menuKey ? formatBarItem(menuKey) : undefined;
  const menuHome = menuKey ? homeOf(layout, menuKey) : null;
  const ordered = menuHome === 'bar' || menuHome === 'end' || menuHome === 'menu' || menuHome === 'attachMenu';
  // The bar runs sideways, so its order moves are left and right (across the
  // '+' between its two zones), mirrored in a right-to-left language; the
  // menu runs down.
  const sideways = menuHome === 'bar' || menuHome === 'end';
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const earlierLabel = sideways ? t(rtl ? 'formatBar.moveRight' : 'formatBar.moveLeft') : t('formatBar.moveUp');
  const laterLabel = sideways ? t(rtl ? 'formatBar.moveLeft' : 'formatBar.moveRight') : t('formatBar.moveDown');
  const EarlierIcon = sideways ? (rtl ? ArrowRight : ArrowLeft) : ArrowUp;
  const LaterIcon = sideways ? (rtl ? ArrowLeft : ArrowRight) : ArrowDown;
  const menuAction = (act: () => void) => () => {
    act();
    closeMenu();
  };
  const menuBtn = 'w-full flex items-center gap-2.5 text-start px-3 min-h-[44px] [@media(hover:hover)]:min-h-0 [@media(hover:hover)]:py-1.5 text-body rounded-md text-pn-soft [@media(hover:hover)]:hover:bg-pn/5 disabled:opacity-40 disabled:cursor-default';

  return (
    <div ref={rootRef} className="space-y-3">
      {/* Top or bottom, on every device (per device). */}
      {onPositionChange && (
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-divider">
          <div className="min-w-0">
            <RowTitle icon={Rows}>{t('formatBar.positionTitle')}</RowTitle>
            <p className={SETTINGS_HELP}>{t('formatBar.positionNote')}</p>
          </div>
          <div
            role="radiogroup"
            aria-label={t('formatBar.positionTitle')}
            className={`shrink-0 ${SETTINGS_TRACK}`}
            // A radio group is one Tab stop, and an arrow key picks the other
            // choice, as every radio group does.
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
              e.preventDefault();
              const next = position === 'top' ? 'bottom' : 'top';
              onPositionChange(next);
              e.currentTarget.querySelector<HTMLButtonElement>(`[data-position="${next}"]`)?.focus();
            }}
          >
            {(['top', 'bottom'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                data-position={p}
                aria-checked={position === p}
                tabIndex={position === p ? 0 : -1}
                onClick={() => onPositionChange(p)}
                className={settingsSegClass(position === p)}
              >
                {t(p === 'top' ? 'formatBar.positionTop' : 'formatBar.positionBottom')}
              </button>
            ))}
          </div>
        </div>
      )}

      {heading}

      <div className="min-w-0 space-y-3">
        {/* The bar itself, in its left-to-right order: every item named, the
            + mark where the menu sits, and the fixed end with the picture,
            file and recording buttons. It wraps onto more lines when the
            pane is narrow. */}
        <section
          aria-label={t('formatBar.onBar')}
          className="rounded-lg p-2 bg-surface-1"
        >
          {/* Each hint sits where it applies: how to move a button next to
              the heading, and the fixed end of the bar named above it. */}
          <div className="flex items-baseline gap-2 px-1 pb-1.5">
            <h3 className={`shrink-0 ${SETTINGS_EYEBROW}`}>{t('formatBar.onBar')}</h3>
            <p className="min-w-0 truncate text-small text-pn-muted">{touch ? t('formatBar.hintTap') : t('formatBar.hintDrag')}</p>
            {layout.end.length > 0 && <p className="ms-auto shrink-0 text-small text-pn-muted">{t('formatBar.alwaysVisible')}</p>}
          </div>
          {/* Drawn like the toolbar: one row of icon buttons in bar order, the
              + mark where the menu sits, a hairline, then the end of the bar,
              which the person fills and which never gives way behind the •••. On
              a touch screen a long row scrolls sideways, as the toolbar does.
              Under a pointer it stays unclipped, because the names show in
              hover labels below the icons, and only an unusually long bar
              wraps. */}
          {/* The bar reads as a live drop target at rest (an accent edge and
              tint, marching on hover and when the tab opens), turns dashed
              while any button is dragged, and fills when the drag is over it,
              as the Hidden box below does. */}
          <div className={`rounded-lg ${overBar || dragKey ? '' : 'pn-bar-ants'}`} data-intro={barIntro ? '' : undefined}>
          <ul data-reorder-zone="bar" className={`pn-format-row flex items-center rounded-lg border px-1.5 py-1 transition-colors [@media(hover:none)]:overflow-x-auto [@media(hover:none)]:[scrollbar-width:none] [@media(hover:hover)]:flex-wrap ${
            overBar ? 'border-accent bg-accent/10 ring-2 ring-accent/25'
              : dragKey ? 'border-dashed border-accent/60 bg-accent/5'
              : 'border-accent/40 bg-accent/5'
          }`}>
            {layout.bar.map((k) => item(k, 'bar'))}
            <li aria-hidden="true" className="flex-1" />
            {layout.menu.length > 0 && (
              <li aria-hidden="true" className="flex items-center justify-center w-8 h-8 text-pn-muted">
                <Plus />
              </li>
            )}
            <li aria-hidden="true" className="mx-0.5 h-4 w-px bg-pn-muted/35" />
            {/* The end zone: its own drop target, so an empty end can still be
                filled; while a drag is on, it shows as a slot. */}
            <li
              data-reorder-zone="end"
              className={`flex items-center min-w-8 min-h-8 rounded-md ${dragKey && !layout.end.length ? 'border border-dashed border-divider' : ''}`}
            >
              <ul className="flex items-center">
                {layout.end.map((k) => item(k, 'end'))}
              </ul>
            </li>
          </ul>
          </div>
          {/* Hidden, right under the bar and as wide, drawn like it: a
              heading with its note, then one row of icons that wraps. The
              whole part is the drop target. */}
          <section
            aria-label={t('formatBar.hidden')}
            data-reorder-zone="hidden"
            className="mt-3"
          >
            <div className="flex items-baseline gap-2 px-1 pb-1.5">
              <h3 className={`shrink-0 ${SETTINGS_EYEBROW}`}>{t('formatBar.hidden')}</h3>
              <p className="min-w-0 truncate text-small text-pn-muted">{hiddenNote}</p>
            </div>
            <ul className={`flex flex-wrap items-center min-h-[2.625rem] [@media(hover:none)]:min-h-[3.125rem] rounded-lg border border-dashed px-1.5 py-1 transition-colors ${
              target?.part === 'hidden' ? 'border-accent bg-accent/10' : 'border-divider'
            }`}>
              {layout.hidden.map((k) => item(k, 'hidden'))}
            </ul>
          </section>
        </section>

        {/* A refused move is named above the menu box, in view of the drag
            that caused it rather than under the fold. A free account's
            preview says it is not saved in the same line, so the pitch takes
            no room of its own; a refusal replaces it while it shows. */}
        <div className="min-w-0">
          <p aria-live="polite" className={`mb-1.5 px-1 text-small empty:mb-0 ${shownRefusal ? 'text-danger' : 'text-pro'}`}>
            {shownRefusal ? (shownRefusal.reason === 'menuNotAllowed'
              ? t('formatBar.refuse.menuNotAllowed', { item: label(shownRefusal.key) })
              : t(`formatBar.refuse.${shownRefusal.reason}`))
              : previewing && t('formatBar.previewOnly')}
          </p>
          {menus && <section
            aria-label={t('formatBar.inMenu')}
            data-reorder-zone="menu"
            className={`min-w-0 rounded-lg p-2 transition-colors ${target?.part === 'menu' ? 'bg-accent/10' : 'bg-surface-1'}`}
          >
            <h3 className={`px-1 ${SETTINGS_EYEBROW}`}>{t('formatBar.inMenu')}</h3>
            <div className="grid gap-x-3 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))] items-start">
              {menuWithAttach}
            </div>
          </section>}
        </div>
      </div>

      {menuKey && menuItem && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('formatBar.optionsFor', { item: label(menuKey) })}
          onKeyDown={menuKeys}
          // Focus that moves to another element closes the menu, so it never
          // stays open behind the focus. A blur to nothing keeps it open: WebKit
          // gives no focus to a tapped button, so a tap on a choice blurs the
          // menu with no next element, and closing then would eat the click.
          // A tap outside is handled by the pointerdown listener.
          onBlur={(e) => {
            const next = e.relatedTarget as Node | null;
            if (next && !menuRef.current?.contains(next) && !anchorRef.current?.contains(next)) closeMenu(false);
          }}
          className="fixed z-[60] w-60 rounded-lg border border-divider bg-surface-1 p-1 shadow-lg"
          style={{ top: menuPos?.top ?? 0, left: menuPos?.left ?? 0, visibility: menuPos ? 'visible' : 'hidden' }}
        >
          <div className="flex items-center gap-2 px-3 pt-1.5 pb-1 text-small font-semibold text-pn-muted" aria-hidden="true">
            {(() => { const { Icon } = look[menuKey]!; return <Icon />; })()}
            <span className="truncate">{label(menuKey)}</span>
          </div>
          {ordered && (
            <>
              <button type="button" role="menuitem" className={menuBtn} disabled={!canStep(layout, menuKey, -1)}
                onClick={menuAction(() => onUpdate((c) => stepItem(c, menuKey, -1)))}>
                <EarlierIcon aria-hidden="true" />{earlierLabel}
              </button>
              <button type="button" role="menuitem" className={menuBtn} disabled={!canStep(layout, menuKey, 1)}
                onClick={menuAction(() => onUpdate((c) => stepItem(c, menuKey, 1)))}>
                <LaterIcon aria-hidden="true" />{laterLabel}
              </button>
              <div className="my-1 h-px bg-divider" aria-hidden="true" />
            </>
          )}
          {(['bar', 'menu', 'attachMenu', 'hidden'] as const).filter((home) => (home !== 'attachMenu' || menuItem.attachAllowed) && (menus || home === 'bar' || home === 'hidden')).map((home) => {
            const blocked = home === 'menu' && !menuItem.menuAllowed;
            const current = menuHome === home || (home === 'bar' && menuHome === 'end');
            return (
              <button
                key={home}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                className={menuBtn}
                disabled={blocked}
                onClick={menuAction(() => { if (!current) moveTo(menuKey, home); })}
              >
                <span className="w-4 shrink-0">{current && <Check aria-hidden="true" />}</span>
                <span className="flex-1">{t(`formatBar.home.${home}`)}</span>
                {blocked && <span className="text-small text-pn-muted">{t(menuKey === 'audio' ? 'formatBar.showsRecording' : 'formatBar.opensPanel')}</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Where an item lands in a list that has none yet: a line on its own. */
function DropSlot() {
  return <div aria-hidden="true" className="relative h-2 mx-1"><DropLine edge="top" /></div>;
}
