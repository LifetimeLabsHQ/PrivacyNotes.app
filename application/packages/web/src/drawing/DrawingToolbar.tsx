/**
 * The drawing canvas's toolbar, in the app's toolbar parts (`ToolbarBtn`,
 * the editor bar's frame and hairlines), at the top or the bottom as the
 * person set the editor's bar (`FormatBarContext`). It takes the place of
 * Excalidraw's own tool island, zoom box, undo box and main menu, which
 * drawing.css hides.
 *
 * Every tool, history and zoom button sends Excalidraw the key of the same
 * action, so a button and its key do the one thing Excalidraw does (the
 * image tool's file picker included). Its tooltip names that key from the
 * drawing hotkey list, the same list the hotkey window shows. Style and
 * reset have no key: they call the canvas (DrawingCanvas's `commandsRef`),
 * reset after the app's own confirm.
 *
 * The person arranges it in Settings > Toolbar > Drawing: the order, the
 * end zone and the hidden buttons come from `FormatBarContext.drawing`
 * (`drawingBar.tsx`), and a separator item draws the editor bar's rule.
 * Spec: docs/internal/specs/drawing.md (section 0)
 */
import { useContext, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { DotsThree, LockSimple, Palette } from '../icons';
import { TB_ICON, TipSideContext, ToolbarBtn } from '../editorToolbarParts';
import { FormatBarContext } from '../formatBarContext';
import { DRAWING_HOTKEY_GROUPS, rowText } from '../hotkeysData';
import { DESKTOP_APP, KEY_OS } from '../shortcutMatch';
import { useIsMobile, useIsTouchDevice } from '../useIsMobile';
import { useToolbarFit } from '../useToolbarFit';
import { isTouchOnly } from '../touchOnly';
import { DRAWING_BAR, DRAWING_BAR_LOOK, type DrawingPress } from './drawingBar';

/** What the canvas reports (DrawingCanvas's `CanvasToolState`, written out
 *  here: this file is in the NotesView chunk and may not import the lazy one). */
export type DrawingToolState = { tool: string; locked: boolean; zoom: number; phone: boolean; styled: boolean; styleOpen: boolean };

/** The keys of a row of the drawing hotkey list, for a tooltip; `alt` picks
 *  one of the row's alternatives ("A / B"). */
function keysOf(i18nKey: string | undefined, alt?: 0 | 1): string {
  const row = i18nKey && DRAWING_HOTKEY_GROUPS.flatMap((g) => g.rows).find((r) => r.i18nKey === i18nKey);
  if (!row) return '';
  const text = rowText(row, KEY_OS, DESKTOP_APP);
  return alt === undefined ? text : text.split(' / ')[alt] ?? '';
}

/** The buttons a locked or trashed drawing keeps: it can only be looked at. */
const READ_ONLY_KEYS = new Set(['zoomOut', 'zoomReset', 'zoomIn', 'hotkeys']);

export function DrawingToolbar({ canvasRef, state, readOnly, onShowKeys, onStyle, onSteps, onReset, slot }: {
  /** The element around the canvas; the presses go to Excalidraw inside it. */
  canvasRef: RefObject<HTMLElement | null>;
  /** In the pane: the row under the scrolling column that holds the bar at
   *  the bottom, as the note editor's (NoteEditorPane's `barSlot`). Without
   *  it (the full-screen window) the bar sits under the canvas itself. */
  slot?: HTMLElement | null;
  state: DrawingToolState;
  readOnly: boolean;
  onShowKeys: () => void;
  /** Opens or closes Excalidraw's shape panel (the phone layout only). */
  onStyle: () => void;
  /** Turns on the Steps tool, which has no Excalidraw key (DrawingCanvas). */
  onSteps: () => void;
  /** Asks the app's confirm, then clears the canvas (DrawingItem). */
  onReset: () => void;
}) {
  const { t } = useTranslation('notes');
  const { position } = useContext(FormatBarContext);
  const atBottom = position === 'bottom';
  const touch = useIsTouchDevice();
  const press = ({ key, code, mod, shift }: DrawingPress) => {
    const target = canvasRef.current?.querySelector('.excalidraw');
    if (!target) return;
    const mac = KEY_OS === 'mac';
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key, code, bubbles: true, cancelable: true, shiftKey: !!shift,
      metaKey: !!mod && mac, ctrlKey: !!mod && !mac,
    }));
  };
  const { drawing, onCustomizeDrawing } = useContext(FormatBarContext);
  const wide = !useIsMobile();
  const layout = drawing ?? DRAWING_BAR.stock();
  /** One item of the arrangement as its button, or null where this canvas
   *  does not offer it. */
  const button = (key: string): ReactNode => {
    const look = DRAWING_BAR_LOOK[key];
    if (!look || key.startsWith('separator')) return null;
    if (readOnly && !READ_ONLY_KEYS.has(key)) return null;
    // No keys without a keyboard: the app's own list leaves a touch-only
    // screen too (AboutModal).
    if (key === 'hotkeys' && isTouchOnly()) return null;
    // The gear, as the format bar's: a wide screen only; a phone reaches the
    // tab through Settings.
    if (key === 'customize' && !(wide && onCustomizeDrawing)) return null;
    const { Icon } = look;
    const label = key === 'zoomReset' ? `${t(look.label)} (${Math.round(state.zoom * 100)}%)` : t(look.label);
    const act = key === 'reset' ? onReset
      : key === 'hotkeys' ? onShowKeys
      : key === 'customize' ? () => onCustomizeDrawing?.()
      : key === 'steps' ? onSteps
      : () => press(look.press as DrawingPress);
    return (
      <ToolbarBtn
        label={label}
        keys={key === 'hotkeys' ? '?' : keysOf(look.hotkey, look.alt)}
        active={key === 'keepTool' ? state.locked : look.tool !== undefined && state.tool === look.tool}
        onClick={act}
      >
        {key === 'keepTool' && state.locked ? <LockSimple size={TB_ICON} /> : <Icon size={TB_ICON} />}
      </ToolbarBtn>
    );
  };
  /** A list of items as the row's children, each separator the editor
   *  bar's line. A line with no button before or after it is left out. */
  const run = (keys: readonly string[]): { key: string; node: ReactNode }[] => {
    const out: { key: string; node: ReactNode }[] = [];
    let line: string | null = null;
    for (const key of keys) {
      if (key.startsWith('separator')) {
        if (out.length) line = key;
        continue;
      }
      const b = button(key);
      if (!b) continue;
      if (line) out.push({ key: line, node: <span key={line} aria-hidden="true" className="shrink-0 -mx-0.5 h-4 w-px bg-pn-muted/35" /> });
      line = null;
      out.push({ key, node: <span key={key} className="shrink-0 flex">{b}</span> });
    }
    return out;
  };
  const row = run(layout.bar);
  // Row 1 holds as many as fit, the rest wait behind the ••• in row 2: the
  // editor bar's fit (useToolbarFit.ts), and under a finger its strip.
  const fit = useToolbarFit(touch, row.map((i) => i.key).join(','));
  const shown = fit.measured ? fit.visibleCount : row.length;
  const rowTwo = fit.measured && fit.expanded && fit.hasOverflow;
  // In the pane the bar takes the editor bar's places: on top in the
  // centred content column, at the bottom in the pane's own row, which
  // draws the hairline and the background.
  const inSlot = atBottom && !!slot;
  const bar = (
    <TipSideContext.Provider value={atBottom ? 'above' : 'below'}>
      <div
        role="toolbar"
        aria-label={t('drawing.tools.label')}
        className={`shrink-0 flex ${atBottom ? 'flex-col-reverse' : 'flex-col'} ${
          inSlot ? '' : `border-divider bg-surface-2/90 ${atBottom ? 'order-last border-t' : 'border-b'}`}`}
      >
        <div className="flex items-start gap-1.5 px-4 sm:px-6 py-1">
          {/* As the editor's bar: row 1 clipped across (not down, so the
              tips below still show), or one strip that scrolls under a
              finger (pn-format-strip in index.css). */}
          <div ref={fit.rowRef} className={`pn-format-row flex-1 min-w-0 flex items-center gap-0.5 ${touch ? 'pn-format-strip' : 'overflow-x-clip'}`}>
            {row.slice(0, shown).map((i) => i.node)}
          </div>
          {/* The end cluster, as the editor bar's: the •••, then the
              buttons that always stay visible. */}
          <div ref={fit.clusterRef} className="shrink-0 flex items-center gap-1.5">
            {fit.hasOverflow && (
              <ToolbarBtn
                onClick={() => fit.setExpanded((v) => !v)}
                active={fit.expanded}
                label={fit.expanded ? t('drawing.tools.fewer') : t('drawing.tools.more')}
              >
                <DotsThree size={TB_ICON} />
              </ToolbarBtn>
            )}
            <div className="flex items-center gap-0.5">
              {/* Excalidraw's phone layout shows the shape panel (colours,
                  widths, layers) only on demand, from a button of its own
                  tool row, which the app's toolbar replaces. Like that button,
                  it shows while a style applies. */}
              {!readOnly && state.phone && state.styled && (
                <ToolbarBtn label={t('drawing.tools.style')} active={state.styleOpen} onClick={onStyle}>
                  <Palette size={TB_ICON} />
                </ToolbarBtn>
              )}
              {run(layout.end).map((i) => i.node)}
            </div>
          </div>
        </div>
        {/* Row 2, full width, for what row 1 had no room for. */}
        {rowTwo && (
          <div className={`flex flex-wrap items-center gap-0.5 px-4 sm:px-6 py-1 border-divider ${atBottom ? 'border-b' : 'border-t'}`}>
            {row.slice(fit.visibleCount).map((i) => i.node)}
          </div>
        )}
      </div>
    </TipSideContext.Provider>
  );
  if (inSlot) return createPortal(bar, slot);
  return slot === undefined || atBottom ? bar : <div className="pn-content-col shrink-0">{bar}</div>;
}
