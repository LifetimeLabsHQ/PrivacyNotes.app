import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Icon } from './icons';
import { Plus as PlusIcon } from './icons';
import { HoverLabel } from './HoverLabel';
import { SETTINGS_EYEBROW } from './ui';
import { TB_BTN_ACTIVE, TB_BTN_BASE, TB_BTN_REST, TB_ICON } from './editorToolbarParts';
import { usePopoverPosition } from './usePopoverPosition';
import { useEscapeToClose } from './useEscapeToClose';
import type { FormatBarGroup } from './formatBar';

/** One entry of the '+' menu. */
export type InsertMenuItem = {
  key: string;
  group: FormatBarGroup;
  Icon: Icon;
  label: string;
  /** The syntax or the key that does the same, shown beside the label. */
  hint: string | null;
  active: boolean;
  run: () => void;
  /** Shown dimmed, runs nothing: an item this view cannot run (the
   *  Markdown view's items that work in the formatted view only). */
  disabled?: boolean;
};

/** How a press on a toolbar control is wired: a click under a pointer, and
 *  on a touch strip whatever the host needs to keep its keyboard down. */
export type ToolbarPress = (act: () => void) => object;

/**
 * The '+' menu of an arranged toolbar: the items the person placed in the
 * menu on Settings > Toolbar, under a header per group, in their order. One
 * menu for the formatted toolbar (EditorToolbar.tsx) and the Markdown view's
 * (MarkdownSourceBar.tsx), so the two draw the same arrangement the same way.
 * An empty menu has no button: everything is on the bar or hidden.
 * Spec: docs/internal/specs/format-bar.md
 */
export function ToolbarInsertMenu({ items, anchorRef, press, tabIndex, tipSide }: {
  items: readonly InsertMenuItem[];
  /** What the menu lines up with: the toolbar's right cluster, end-aligned. */
  anchorRef: RefObject<HTMLElement | null>;
  press: ToolbarPress;
  tabIndex?: number;
  tipSide: 'above' | 'below';
}) {
  const { t } = useTranslation('editor');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Same portal + outside-click pattern as the toolbar's pickers.
  useEffect(() => {
    if (!open) return;
    function handler(e: PointerEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  // Escape closes it through the shared overlay stack, which also hands it to
  // the Android back button. A closed menu registers no listener.
  // Spec: docs/internal/design/ui-patterns.md (Escape on popovers)
  useEscapeToClose(() => setOpen(false), open);

  // Anchored to the whole right cluster, not to its own '+' button, and
  // end-aligned: the menu is wider than the cluster, so this lines its right
  // edge up with the buttons above it.
  const pos = usePopoverPosition(open, anchorRef, menuRef, { align: 'end', shrink: true });

  if (items.length === 0) return null;
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <HoverLabel label={t('toolbar.insert')} position={tipSide}>
        <button
          type="button"
          tabIndex={tabIndex}
          onMouseDown={(e) => e.preventDefault()}
          // On touch the menu opens on the click after the tap. Opened on
          // pointerdown, a menu placed over the button took the release of the
          // same tap and ran the entry under the finger.
          {...press(() => setOpen((prev) => !prev))}
          aria-label={t('toolbar.insert')}
          className={`${TB_BTN_BASE} ${open ? TB_BTN_ACTIVE : TB_BTN_REST} shrink-0`}
        >
          <PlusIcon size={TB_ICON} />
        </button>
      </HoverLabel>
      {open && createPortal(
        <div
          ref={menuRef}
          // An arranged menu can hold every movable item, so it scrolls
          // rather than run off the screen.
          className="fixed z-50 bg-surface-1 border border-divider rounded-lg shadow-lg py-1 w-56 overflow-y-auto overscroll-contain"
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            maxHeight: pos?.maxHeight ?? `calc(100dvh - ${pos?.top ?? 0}px - 8px)`,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          {items.map((item, i) => (
            <Fragment key={item.key}>
              {/* A header opens each run of entries sharing a group. The
                  arrangement is grouped (resolveFormatBar), so comparing with
                  the previous entry is enough, and a group with no entry left
                  shows no header. */}
              {(i === 0 || items[i - 1]!.group !== item.group) && (
                <div className={`px-3 pt-2 pb-0.5 ${SETTINGS_EYEBROW} !font-normal !text-pn-muted`}>
                  {t(`insertGroup.${item.group}`)}
                </div>
              )}
              <button
                type="button"
                aria-disabled={item.disabled || undefined}
                // On touch a press that becomes a scroll of the menu must not
                // run an entry.
                {...press(() => {
                  if (item.disabled) return;
                  item.run();
                  setOpen(false);
                })}
                className={`w-full flex items-center gap-2.5 text-start px-3 py-1.5 text-body transition ${
                  item.disabled ? 'text-pn-soft opacity-40 cursor-not-allowed'
                    : `[@media(hover:hover)]:hover:bg-pn/5 active:bg-pn/5 ${item.active ? 'text-accent' : 'text-pn-soft'}`
                }`}
              >
                <item.Icon size={TB_ICON} />
                <span className="flex-1">{item.label}</span>
                {item.hint && (
                  <span className="text-meta font-mono text-pn-muted">{item.hint}</span>
                )}
              </button>
            </Fragment>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
