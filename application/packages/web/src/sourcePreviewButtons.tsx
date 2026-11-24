import type { ReactElement } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ArrowsLeftRight, Hash, SquareSplitHorizontal } from './icons';
import { HoverLabel } from './HoverLabel';
import { setLineNumbersPref, useLineNumbersPref } from './editorPrefs';
import { useIsPhoneLayout } from './useIsMobile';
import { TB_ICON, ToolbarBtn } from './editorToolbarParts';
import type { InsertMenuItem } from './ToolbarInsertMenu';

/** The narrowest editor pane that holds two columns: the text and its
 *  preview (Split view), or two items side by side. One number for both, so
 *  the two read as one rule (owner, 2026-11-21), and low enough for a laptop
 *  window with the list open (a 625 px pane at 1440 px). Measured on the pane,
 *  not the window: the notes list takes part of the window. Here, not in
 *  SourcePreviewPane.tsx, so the pane loads on demand.
 *  Spec: docs/internal/plans/heading-folds-and-source-preview.md (Part 2),
 *  docs/internal/specs/side-by-side-notes.md (section 4) */
const SOURCE_PREVIEW_MIN_WIDTH = 600;

/** Whether this screen can ever show the preview beside the text. A phone
 *  never does, held sideways too: its shorter side is under 600 px. */
export function canSplitScreen(): boolean {
  return typeof screen === 'undefined' || Math.min(screen.width, screen.height) >= 600;
}

/** Whether a pane this wide takes the preview now. */
export function fitsSourcePreview(paneWidth: number): boolean {
  return paneWidth >= SOURCE_PREVIEW_MIN_WIDTH && canSplitScreen();
}

/** What a format bar needs to draw its Split view item. */
export type SourcePreviewControls = {
  /** Split view is on (the Markdown view with its preview showing). */
  on: boolean;
  /** The pane is wide enough for two columns now. */
  fits: boolean;
  /** Show or hide it; from the formatted view, open the Markdown view with it. */
  onToggle: () => void;
  /** Turn the two columns round; only while split view shows. */
  onSwap?: () => void;
};

function splitLabel(t: TFunction, c: SourcePreviewControls): string {
  return !c.fits ? t('notes:editor.splitViewNeedsWidth')
    : c.on ? t('notes:editor.hideSplitView') : t('notes:editor.showSplitView');
}

/**
 * The Split view item (`splitView` in formatBar.ts) as both format bars draw
 * it on the bar, wherever the person placed it on Settings > Toolbar, with
 * "Swap sides" always right before it while split view shows: Swap is not an
 * item of its own (owner, 2026-11-20). A pane too narrow for two columns dims
 * the button with a tip that says why; the phone layout never draws it.
 * Spec: docs/internal/specs/editor-mode-toggle.md (Markdown view with a preview)
 */
export function sourcePreviewButtons(t: TFunction, c: SourcePreviewControls, tabIndex?: number): ReactElement[] {
  const buttons: ReactElement[] = [];
  if (c.on && c.fits && c.onSwap) {
    buttons.push(
      <ToolbarBtn key="splitViewSwap" onClick={c.onSwap} label={t('notes:editor.swapSides')} tabIndex={tabIndex}>
        <ArrowsLeftRight size={TB_ICON} />
      </ToolbarBtn>,
    );
  }
  buttons.push(
    <ToolbarBtn key="splitView" onClick={c.onToggle} active={c.on && c.fits} disabled={!c.fits} label={splitLabel(t, c)} tabIndex={tabIndex}>
      <SquareSplitHorizontal size={TB_ICON} />
    </ToolbarBtn>,
  );
  return buttons;
}

/** The same item in the '+' menu, with "Swap sides" right after it while
 *  split view shows. */
export function sourcePreviewMenuItems(t: TFunction, c: SourcePreviewControls): InsertMenuItem[] {
  const items: InsertMenuItem[] = [{
    key: 'splitView',
    group: 'insert',
    Icon: SquareSplitHorizontal,
    label: splitLabel(t, c),
    hint: null,
    active: c.on && c.fits,
    disabled: !c.fits,
    run: c.onToggle,
  }];
  if (c.on && c.fits && c.onSwap) {
    items.push({ key: 'splitViewSwap', group: 'insert', Icon: ArrowsLeftRight, label: t('notes:editor.swapSides'), hint: null, active: false, run: c.onSwap });
  }
  return items;
}

/**
 * The line numbers switch (lineNumbers.ts) at the end of an editor's footer,
 * beside the view switch it serves: both views number, so one switch for
 * both. Grey when off like the pin, accent when on, and light in both states,
 * so it weighs what the footer's other glyphs weigh. Its tip opens toward the
 * start: the end of the row has no room. Not in the phone layout, which has
 * no room for the numbers. The note editor and the Markdown folder share it.
 */
export function LineNumbersToggle() {
  const { t } = useTranslation('notes');
  const on = useLineNumbersPref();
  if (useIsPhoneLayout()) return null;
  const label = on ? t('editor.lineNumbersHide') : t('editor.lineNumbersShow');
  return (
    <HoverLabel label={label} position="start">
      <button
        type="button"
        onClick={() => setLineNumbersPref(!on)}
        aria-pressed={on}
        aria-label={label}
        className={`shrink-0 h-4 flex items-center hover:text-accent transition ${on ? 'text-accent' : 'text-pn-muted'}`}
      >
        <Hash weight="light" size={16} />
      </button>
    </HoverLabel>
  );
}
