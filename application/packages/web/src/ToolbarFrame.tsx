import type { ReactElement, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretLineDown as HideKeyboardIcon, DotsThree as MoreIcon } from './icons';
import { TB_ICON, TipSideContext, ToolbarBtn } from './editorToolbarParts';
import { ToolbarInsertMenu, type InsertMenuItem, type ToolbarPress } from './ToolbarInsertMenu';
import { useKeyboardOpen } from './useKeyboardOpen';
import type { useToolbarFit } from './useToolbarFit';

type Props = {
  /** The row's measure (useToolbarFit), owned by the caller, which may line
   *  a popover of its own up with the right cluster. */
  fit: ReturnType<typeof useToolbarFit>;
  /** The row, in the person's order. */
  row: ReactElement[];
  /** Keeps row 2 open, for a control there that must stay mounted (a
   *  recorder that is recording). */
  holdOpen?: boolean;
  /** The '+' menu, in the person's order. */
  menu: readonly InsertMenuItem[];
  press: ToolbarPress;
  /** The end of the bar, after the '+'; it never gives way behind the •••. */
  end: ReactElement[];
  atBottom: boolean;
  /** A touch screen: one strip that scrolls sideways. */
  strip: boolean;
  onHideKeyboard: () => void;
  tabIndex?: number;
  rootRef?: Ref<HTMLDivElement>;
  /** What belongs to the bar but is not in it: file inputs, portals. */
  children?: ReactNode;
};

/**
 * The format bar as it is drawn, for every view that edits a note's body:
 * the formatted editor (EditorToolbar.tsx) and the Markdown view
 * (MarkdownSourceBar.tsx) hand it their buttons, built from the one
 * arrangement in Settings > Toolbar (FormatBarContext), and it draws the
 * row with its ••• overflow, the '+' menu, the end of the bar and row 2 the
 * same way for both. Sticky under the tag row at the top, or the pane's own
 * row at the bottom.
 * Spec: docs/internal/specs/format-bar.md
 */
export function ToolbarFrame({ fit, row, holdOpen = false, menu, press, end, atBottom, strip, onHideKeyboard, tabIndex, rootRef, children }: Props) {
  const { t } = useTranslation('editor');
  // The iOS app removes the system Done bar above the keyboard (GitHub #533),
  // so the strip carries the only control that closes it. It sits outside
  // the arrangeable items: a person who could hide it could lose the way out.
  const keyboardUp = useKeyboardOpen();
  const tipSide = atBottom ? 'above' : 'below';
  const rowTwoOpen = fit.expanded || holdOpen;
  return (
    <TipSideContext.Provider value={tipSide}>
    <div ref={rootRef} className={`pn-editor-toolbar border-divider ${
      atBottom ? 'pn-toolbar-bottom flex flex-col-reverse' : 'sticky z-10 -mx-4 sm:-mx-6 bg-surface-2/90 backdrop-blur [overscroll-behavior:contain] top-[var(--pn-tagrow-h,0px)] border-b'
    }`}>
      <div className="flex items-start gap-1.5 px-4 sm:px-6 py-1">
        {/* Row 1 under a pointer: as many buttons as fit (measured), clipped
            to a single line; the overflow lives in the full-width row 2 below.
            overflow-x-clip (not -hidden) hides transient button spill during
            resize measurement while letting the hover labels, which render
            below the buttons, escape vertically. A label that would hang past
            the clip moves back inside it as it shows (HoverLabel's fitTip).
            On a touch screen it is one strip that scrolls (pn-format-strip in
            index.css); touch shows no hover labels, so nothing needs to
            escape it. */}
        <div ref={fit.rowRef} className={`pn-format-row flex-1 min-w-0 flex items-center gap-0.5 ${strip ? 'pn-format-strip' : 'overflow-x-clip'}`}>
          {row.slice(0, fit.measured ? fit.visibleCount : row.length)}
        </div>

        {/* Right cluster: ••• overflow toggle (only when something overflows),
            the '+' menu and the end of the bar, always on row 1. */}
        <div ref={fit.clusterRef} className="shrink-0 flex items-center gap-1.5">
          {/* The ••• sits next to the row it extends, before the '+'. */}
          {fit.hasOverflow && (
            <ToolbarBtn
              onClick={() => { if (!holdOpen) fit.setExpanded((v) => !v); }}
              active={rowTwoOpen}
              label={rowTwoOpen ? t('toolbar.fewerFormatting') : t('toolbar.moreFormatting')}
              tabIndex={tabIndex}
            >
              <MoreIcon size={TB_ICON} />
            </ToolbarBtn>
          )}
          {/* '+' insert menu: block inserts (table, divider, code block, the
              bullet and numbered lists) plus the rare notation marks (inline
              code, sup/sub, math). Labeled entries with syntax hints - the
              menu teaches while the format row keeps the marks a live
              selection is waiting for. */}
          <ToolbarInsertMenu items={menu} anchorRef={fit.clusterRef} press={press} tabIndex={tabIndex} tipSide={tipSide} />
          {end.length > 0 && (
          <>
          {/* Hairline, not a tinted box. An accent fill here would be the only
              filled container in the editor's three control rows, reading as a
              different kind of control rather than the last group in a row.
              Spec: docs/internal/design/ui-patterns.md (section 80) */}
          <span aria-hidden="true" className="shrink-0 mx-0.5 h-4 w-px bg-pn-muted/35" />
          <div className="flex items-center gap-0.5">
            {end}
          </div>
          </>
          )}
          {strip && keyboardUp && (
            <>
              <span aria-hidden="true" className="shrink-0 mx-0.5 h-4 w-px bg-pn-muted/35" />
              <ToolbarBtn onClick={onHideKeyboard} label={t('toolbar.hideKeyboard')} tabIndex={tabIndex}>
                <HideKeyboardIcon size={TB_ICON} />
              </ToolbarBtn>
            </>
          )}
        </div>
      </div>

      {/* Row 2: the overflow buttons, full width, revealed by •••. Only once
          the fit has measured this arrangement: before that row 1 draws every
          button, and drawing some of them here as well would mount a control
          twice and leave its popover anchor empty. */}
      {fit.measured && rowTwoOpen && fit.hasOverflow && (
        <div className={`flex flex-wrap items-center gap-0.5 px-4 sm:px-6 py-1 border-divider ${atBottom ? 'border-b' : 'border-t'}`}>
          {row.slice(fit.visibleCount)}
        </div>
      )}
      {children}
    </div>
    </TipSideContext.Provider>
  );
}
