import { useContext, useState } from 'react';
import { readSourcePreviewFirst, readSourcePreviewPref, useLineNumbersPref, writeSourcePreviewFirst, writeSourcePreviewPref } from './editorPrefs';
import { FormatBarContext } from './formatBarContext';
import { canSplitScreen, fitsSourcePreview, type SourcePreviewControls } from './sourcePreviewButtons';
import { useSteppedWidth } from './useElementSize';
import { useIsPhoneLayout } from './useIsMobile';

/**
 * Split view (the formatted preview beside the Markdown text, GitHub #727)
 * and line numbers, for any pane that shows `MarkdownSourceEditor` and
 * `Editor`: the note editor and the Markdown folder's file pane. One home, so
 * the two panes cannot drift apart.
 *
 * Whether split view is on is this device's choice; the pane's width decides
 * whether it shows, so a narrowed window closes the split and a widened one
 * brings it back. Hiding the Split view item on Settings > Toolbar turns it
 * off, so it never stays on with no button to close it. The phone layout has
 * room for neither.
 * Spec: docs/internal/plans/heading-folds-and-source-preview.md (Part 2)
 */
export function useSplitView({ pane, markdownShown, showMarkdown }: {
  /** The pane's scroller, measured for the 600 px fit. */
  pane: HTMLElement | null;
  /** The Markdown view is on screen and may take a preview. */
  markdownShown: boolean;
  /** Switches the pane to the Markdown view, for the formatted view's button. */
  showMarkdown: () => void;
}) {
  const { layout } = useContext(FormatBarContext);
  const phoneLayout = useIsPhoneLayout();
  const [on, setOn] = useState(readSourcePreviewPref);
  const [first, setFirst] = useState(readSourcePreviewFirst);
  const [paneWidth] = useSteppedWidth(pane, (w) => (fitsSourcePreview(w) ? 'wide' : 'narrow'));
  const fits = fitsSourcePreview(paneWidth);
  const setPref = (next: boolean) => {
    setOn(next);
    writeSourcePreviewPref(next);
  };
  // The button on every screen that can split; dimmed while the pane is too narrow.
  const screen = canSplitScreen() && !phoneLayout;
  const lineNumbersOn = useLineNumbersPref();
  return {
    split: markdownShown && on && fits && !layout.hidden.includes('splitView') && !phoneLayout,
    /** Which side the preview takes, remembered on this device as well. */
    first,
    lineNumbers: lineNumbersOn && !phoneLayout,
    /** The Markdown bar's Split view and Swap sides buttons. */
    sourceControls: screen ? {
      on, fits,
      onToggle: () => setPref(!on),
      onSwap: () => { setFirst(!first); writeSourcePreviewFirst(!first); },
    } satisfies SourcePreviewControls : undefined,
    /** The formatted bar's Split view button: opens the Markdown view with the preview on. */
    formattedControls: screen ? {
      on: false, fits,
      onToggle: () => { if (!on) setPref(true); showMarkdown(); },
    } satisfies SourcePreviewControls : undefined,
  };
}
