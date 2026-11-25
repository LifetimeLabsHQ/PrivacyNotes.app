/**
 * Floating toolbar glued below the active Columns block (#647).
 *
 * Mirrors TableControls.tsx: always mounted while editable, hidden via display:none
 * when the caret is outside a columns block (or inside a table nested in one, so
 * TableControls owns that slot). Preset switches, reordering, equal reset, unwrap,
 * and column delete all run as single undoable transactions in columns.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor as TipTapEditor } from '@tiptap/react';
import { ArrowLeft, ArrowRight, Trash, XSquare } from './icons';
import { HoverLabel } from './HoverLabel';
import { COLOR_MENU_WIDTH, ColorSwatchRow, Popover, ProGlyph, SETTINGS_TRACK, Switch, settingsSegClass } from './ui';
import { BlockGrip } from './BlockGrip';
import {
  COLUMN_PRESETS,
  MIN_LAYOUT_COLUMNS,
  activeColumnsAt,
  applyColumnPreset,
  columnBorderOf,
  columnsAreEqual,
  deleteColumn,
  dispatchColumnEdit,
  matchingPresetId,
  moveColumn,
  setColumnBorder,
  setColumnWidths,
  unwrapColumns,
  type ColumnPresetId,
} from './columns';
import {
  COLUMN_BORDER_LINES,
  COLUMN_BORDER_STYLES,
  COLUMN_BORDER_WEIGHTS,
  columnBorderSupportsTint,
  formatColumnBorder,
  parseColumnBorder,
  type ColumnBorderConfig,
  type ColumnBorderLine,
  type ColumnBorderStyle,
} from './columnBorders';

interface BarSnapshot {
  pos: number;
  colIndex: number;
  count: number;
  preset: ColumnPresetId | null;
  equal: boolean;
  border: string | null;
}

const PRESET_GRID: Record<ColumnPresetId, { template: string; bars: number; labelKey: string; count?: number }> = {
  '2': { template: '1fr 1fr', bars: 2, labelKey: 'kanban.columnCount', count: 2 },
  '1:2': { template: '1fr 2fr', bars: 2, labelKey: 'columns.narrowWide' },
  '2:1': { template: '2fr 1fr', bars: 2, labelKey: 'columns.wideNarrow' },
  '3': { template: '1fr 1fr 1fr', bars: 3, labelKey: 'kanban.columnCount', count: 3 },
  '4': { template: '1fr 1fr 1fr 1fr', bars: 4, labelKey: 'kanban.columnCount', count: 4 },
  '5': { template: '1fr 1fr 1fr 1fr 1fr', bars: 5, labelKey: 'kanban.columnCount', count: 5 },
};

function sameSnapshot(a: BarSnapshot | null, b: BarSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.pos === b.pos &&
    a.colIndex === b.colIndex &&
    a.count === b.count &&
    a.preset === b.preset &&
    a.equal === b.equal &&
    a.border === b.border
  );
}

function BorderStyleGlyph({ style }: { style: ColumnBorderStyle }) {
  if (style === 'none') {
    return (
      <svg aria-hidden="true" width="22" height="14" viewBox="0 0 24 16" fill="none">
        <rect x="2" y="3" width="8" height="2" rx="1" fill="currentColor" opacity="0.55" />
        <rect x="2" y="7" width="7" height="2" rx="1" fill="currentColor" opacity="0.35" />
        <rect x="14" y="3" width="8" height="2" rx="1" fill="currentColor" opacity="0.55" />
        <rect x="14" y="7" width="6" height="2" rx="1" fill="currentColor" opacity="0.35" />
      </svg>
    );
  }
  if (style === 'divider') {
    return (
      <svg aria-hidden="true" width="22" height="14" viewBox="0 0 24 16" fill="none">
        <rect x="2" y="3" width="7" height="2" rx="1" fill="currentColor" opacity="0.45" />
        <rect x="2" y="7" width="6" height="2" rx="1" fill="currentColor" opacity="0.3" />
        <line x1="12" y1="2" x2="12" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <rect x="15" y="3" width="7" height="2" rx="1" fill="currentColor" opacity="0.45" />
        <rect x="15" y="7" width="6" height="2" rx="1" fill="currentColor" opacity="0.3" />
      </svg>
    );
  }
  if (style === 'boxes') {
    return (
      <svg aria-hidden="true" width="22" height="14" viewBox="0 0 24 16" fill="none">
        <rect x="1.5" y="2" width="9" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <rect x="13.5" y="2" width="9" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" width="22" height="14" viewBox="0 0 24 16" fill="none">
      <rect x="1.5" y="2" width="21" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="2" x2="12" y2="14" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

const BORDER_LINE_LABEL: Record<ColumnBorderLine, string> = {
  solid: 'columns.borderSolid',
  dashed: 'columns.borderDashed',
  dotted: 'columns.borderDotted',
};

export function ColumnsControls({
  editor,
  isPro,
  columnsUnlocked,
  onUpgrade,
}: {
  editor: TipTapEditor;
  /** Raw account Pro status: Pro badges key off !isPro so demo labels what it unlocks. */
  isPro: boolean;
  /** True for Pro and demo: 3- and 4-column presets run. */
  columnsUnlocked: boolean;
  onUpgrade?: () => void;
}) {
  const { t } = useTranslation('editor');
  const toolbarRef = useRef<HTMLDivElement>(null);
  const equalRef = useRef<HTMLSpanElement>(null);
  const borderBtnRef = useRef<HTMLButtonElement>(null);
  const posRef = useRef<number | undefined>(undefined);
  const getPos = useCallback(() => posRef.current, []);
  const [snap, setSnap] = useState<BarSnapshot | null>(null);
  const [borderOpen, setBorderOpen] = useState(false);
  const closeBorderRef = useRef(setBorderOpen);
  closeBorderRef.current = setBorderOpen;

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    let frame = 0;

    const hide = () => {
      toolbar.style.display = 'none';
      posRef.current = undefined;
      closeBorderRef.current(false);
      setSnap((prev) => (prev === null ? prev : null));
    };

    const place = () => {
      frame = 0;
      if (editor.isDestroyed || !(editor.view as { docView?: unknown }).docView) return hide();
      const active = activeColumnsAt(editor.state);
      if (!active || active.inTable) return hide();

      let blockDOM: Node | null | undefined;
      try {
        blockDOM = editor.view.nodeDOM(active.pos);
      } catch {
        return hide();
      }
      if (!(blockDOM instanceof HTMLElement)) return hide();
      const wrapper = toolbar.parentElement;
      if (!wrapper) return hide();

      const wrapperRect = wrapper.getBoundingClientRect();
      const blockRect = blockDOM.getBoundingClientRect();
      posRef.current = active.pos;

      const next: BarSnapshot = {
        pos: active.pos,
        colIndex: active.colIndex,
        count: active.node.childCount,
        preset: matchingPresetId(active.node),
        equal: columnsAreEqual(active.node),
        border: formatColumnBorder(columnBorderOf(active.node)),
      };
      // Toggle equal-widths button synchronously before measuring toolbar width
      // so narrow panes never misclamp for one frame (mirrors TableControls.tsx).
      if (equalRef.current) equalRef.current.style.display = next.equal ? 'none' : 'contents';
      setSnap((prev) => (sameSnapshot(prev, next) ? prev : next));

      toolbar.style.display = '';
      const barWidth = toolbar.offsetWidth;
      const rtl = getComputedStyle(blockDOM).direction === 'rtl';
      const rawLeft = rtl ? blockRect.right - wrapperRect.left - barWidth : blockRect.left - wrapperRect.left;
      const maxLeft = Math.max(0, wrapperRect.width - barWidth - 8);
      toolbar.style.top = `${blockRect.bottom - wrapperRect.top + 8}px`;
      toolbar.style.left = `${Math.max(0, Math.min(rawLeft, maxLeft))}px`;
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };

    place();
    editor.on('transaction', schedule);
    const observer = new ResizeObserver(schedule);
    const observe = () => {
      if (editor.isDestroyed || !(editor.view as { docView?: unknown }).docView) return;
      observer.observe(editor.view.dom);
      schedule();
    };
    observe();
    editor.on('mount', observe);
    return () => {
      editor.off('transaction', schedule);
      editor.off('mount', observe);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor]);

  const runEdit = (fn: (tr: typeof editor.state.tr, pos: number) => boolean, refocus = true) => {
    if (!editor.isEditable || editor.isDestroyed) return;
    const ok = dispatchColumnEdit(editor.view, (tr) => {
      const current = activeColumnsAt(editor.state);
      const pos = current?.pos ?? posRef.current;
      return typeof pos === 'number' ? fn(tr, pos) : false;
    });
    if (ok && refocus) editor.commands.focus();
  };

  const count = snap?.count ?? 2;
  const colIndex = snap?.colIndex ?? 0;
  const border = parseColumnBorder(snap?.border);
  const canMoveLeft = colIndex > 0;
  const canMoveRight = colIndex < count - 1;
  const canDelete = count > MIN_LAYOUT_COLUMNS;
  const isBorderOff = border.style === 'none';

  const updateBorder = (patch: Partial<ColumnBorderConfig>) => {
    const style = patch.style ?? (border.style === 'none' ? 'divider' : border.style);
    const next: ColumnBorderConfig = { ...border, ...patch, style };
    // Keep keyboard focus inside the popover while the user adjusts multiple options.
    runEdit((tr, pos) => setColumnBorder(tr, pos, next), false);
  };

  const styleLabel = (style: ColumnBorderStyle): string => {
    if (style === 'none') return t('shell:alerts.none');
    if (style === 'divider') return t('toolbar.divider');
    if (style === 'boxes') return t('columns.borderBoxes');
    return t('notes:drawing.frame');
  };

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={t('columns.barLabel')}
      className="pn-table-toolbar pn-columns-toolbar"
      contentEditable={false}
      suppressContentEditableWarning
      style={{ position: 'absolute', zIndex: 3, display: 'none' }}
    >
      {/* Drag grip to move the whole columns block among its siblings */}
      <BlockGrip editor={editor} getPos={getPos} className="pn-table-toolbar-btn pn-columns-grip" tipPosition="below" />
      <div className="pn-table-toolbar-divider" />

      {/* Layout presets: 2, 1:2, 2:1 free; 3 and 4 Pro */}
      {COLUMN_PRESETS.map((preset) => {
        const meta = PRESET_GRID[preset.id];
        const label = meta.count ? t(meta.labelKey, { count: meta.count }) : t(meta.labelKey);
        const active = snap?.preset === preset.id;
        return (
          <HoverLabel key={preset.id} label={label} position="below">
            <button
              type="button"
              aria-label={label}
              aria-pressed={active}
              className={`pn-table-toolbar-btn pn-columns-preset-btn${active ? ' pn-columns-preset-active' : ''}`}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={() => {
                if (preset.pro && !columnsUnlocked) {
                  onUpgrade?.();
                  return;
                }
                runEdit((tr, pos) => applyColumnPreset(tr, pos, preset.weights));
              }}
            >
              <ProGlyph pro={preset.pro && !isPro}>
                <span className="pn-columns-glyph" style={{ gridTemplateColumns: meta.template }} aria-hidden="true">
                  {Array.from({ length: meta.bars }, (_, i) => <i key={i} />)}
                </span>
              </ProGlyph>
              <span className="pn-columns-preset-label">{preset.id}</span>
            </button>
          </HoverLabel>
        );
      })}

      {/* Reset custom dragged widths back to equal shares (toggled via ref for sync width measurement) */}
      <span ref={equalRef} style={{ display: 'none' }}>
        <HoverLabel label={t('table.equalColumnWidths')} position="below">
          <button
            type="button"
            aria-label={t('table.equalColumnWidths')}
            className="pn-table-toolbar-btn"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={() => runEdit((tr, pos) => setColumnWidths(tr, pos, null))}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="1" />
              <line x1="9" y1="4" x2="9" y2="20" />
              <line x1="15" y1="4" x2="15" y2="20" />
            </svg>
          </button>
        </HoverLabel>
      </span>

      <div className="pn-table-toolbar-divider" />

      {/* Column borders popover (style, line, thickness, standard color row, tint) */}
      <HoverLabel label={t('columns.borders')} position="below">
        <button
          ref={borderBtnRef}
          type="button"
          aria-label={t('columns.borders')}
          aria-expanded={borderOpen}
          aria-haspopup="dialog"
          className={`pn-table-toolbar-btn pn-columns-border-btn${borderOpen || !isBorderOff ? ' pn-columns-preset-active' : ''}`}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => setBorderOpen((prev) => !prev)}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" strokeDasharray="3 3" />
            <line x1="12" y1="4" x2="12" y2="20" />
          </svg>
          {!isBorderOff && border.color && (
            <span
              aria-hidden="true"
              className="pn-columns-border-dot"
              style={{ background: `var(--pn-label-${border.color}-ink)` }}
            />
          )}
        </button>
      </HoverLabel>

      <Popover
        open={borderOpen}
        anchorRef={borderBtnRef}
        onClose={() => setBorderOpen(false)}
        title={t('columns.borders')}
        className={`${COLOR_MENU_WIDTH} max-w-[calc(100vw-16px)]`}
      >
        <div className="flex flex-col gap-3 px-2 pb-1">
          <div className="flex flex-col gap-1.5">
            <span className="text-meta font-medium text-pn-muted">{t('notes:drawing.tools.style')}</span>
            <div role="group" aria-label={t('notes:drawing.tools.style')} className={SETTINGS_TRACK}>
              {COLUMN_BORDER_STYLES.map((style) => {
                const active = border.style === style;
                return (
                  <button
                    key={style}
                    type="button"
                    aria-pressed={active}
                    className={`${settingsSegClass(active, true)} !px-1.5`}
                    onClick={() => updateBorder({ style })}
                  >
                    <span className="flex flex-col items-center gap-1">
                      <BorderStyleGlyph style={style} />
                      <span>{styleLabel(style)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={`flex flex-col gap-3 transition-opacity ${isBorderOff ? 'opacity-50 hover:opacity-100 focus-within:opacity-100' : ''}`}>
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-pn-muted">{t('notes:drawing.tools.line')}</span>
              <div role="group" aria-label={t('notes:drawing.tools.line')} className={SETTINGS_TRACK}>
                {COLUMN_BORDER_LINES.map((line) => {
                  const active = !isBorderOff && border.line === line;
                  return (
                    <button
                      key={line}
                      type="button"
                      aria-pressed={active}
                      className={`${settingsSegClass(active, true)} !px-2`}
                      onClick={() => updateBorder({ line })}
                    >
                      <span className="flex items-center justify-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className="w-5 border-t-2 border-current"
                          style={{ borderTopStyle: line }}
                        />
                        <span>{t(BORDER_LINE_LABEL[line])}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-pn-muted">{t('columns.borderThickness')}</span>
              <div role="group" aria-label={t('columns.borderThickness')} className={SETTINGS_TRACK}>
                {COLUMN_BORDER_WEIGHTS.map((weight) => {
                  const active = !isBorderOff && border.weight === weight;
                  return (
                    <button
                      key={weight}
                      type="button"
                      aria-pressed={active}
                      className={settingsSegClass(active, true)}
                      onClick={() => updateBorder({ weight })}
                    >
                      <span className="flex items-center justify-center gap-2">
                        <span
                          aria-hidden="true"
                          className="w-5 border-current"
                          style={{ borderTopWidth: weight, borderTopStyle: 'solid' }}
                        />
                        <span>{t(weight === 1 ? 'columns.borderThin' : 'columns.borderMedium')}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-pn-muted">{t('shell:noteOptionsMenu.color')}</span>
              <div className="[&>div]:flex-wrap">
                <ColorSwatchRow
                  selected={isBorderOff ? null : (border.color ?? 'none')}
                  noneLabel={t('columns.borderColorDefault')}
                  colorLabel={(c) => t(`color.names.${c}`)}
                  onPick={(color) => updateBorder({ color })}
                />
              </div>
            </div>

            {columnBorderSupportsTint(border.style) && (
              <Switch
                label={t('columns.borderTint')}
                labelClassName="text-small font-medium text-pn"
                checked={border.tint}
                onChange={(tint) => updateBorder({ tint })}
                className="pt-0.5"
              />
            )}
          </div>
        </div>
      </Popover>

      <div className="pn-table-toolbar-divider" />

      {/* Reorder active column */}
      <HoverLabel label={t('formatBar.moveLeft')} position="below">
        <button
          type="button"
          aria-label={t('formatBar.moveLeft')}
          disabled={!canMoveLeft}
          className="pn-table-toolbar-btn"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => {
            if (canMoveLeft) runEdit((tr, pos) => moveColumn(tr, pos, colIndex, -1));
          }}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
      </HoverLabel>
      <HoverLabel label={t('formatBar.moveRight')} position="below">
        <button
          type="button"
          aria-label={t('formatBar.moveRight')}
          disabled={!canMoveRight}
          className="pn-table-toolbar-btn"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => {
            if (canMoveRight) runEdit((tr, pos) => moveColumn(tr, pos, colIndex, 1));
          }}
        >
          <ArrowRight aria-hidden="true" />
        </button>
      </HoverLabel>

      <div className="pn-table-toolbar-divider" />

      {/* Unwrap back to normal sequential blocks (keeps all text) */}
      <HoverLabel label={t('columns.removeColumns')} position="below">
        <button
          type="button"
          aria-label={t('columns.removeColumns')}
          className="pn-table-toolbar-btn"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => runEdit((tr, pos) => unwrapColumns(tr, pos))}
        >
          <XSquare aria-hidden="true" />
        </button>
      </HoverLabel>

      {/* Delete active column (merges text into neighbor; disabled at 2 columns) */}
      <HoverLabel label={t('table.deleteColumn')} position="below">
        <button
          type="button"
          aria-label={t('table.deleteColumn')}
          disabled={!canDelete}
          className="pn-table-toolbar-btn pn-table-toolbar-danger"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => {
            if (canDelete) runEdit((tr, pos) => deleteColumn(tr, pos, colIndex));
          }}
        >
          <Trash aria-hidden="true" />
        </button>
      </HoverLabel>
    </div>
  );
}
