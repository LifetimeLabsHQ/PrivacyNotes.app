/**
 * The node views of a Kanban board and its columns. Both are callouts
 * (Callout.tsx draws them through here), so the stored form, copy, paste,
 * export and the importers need nothing of their own. Every edit is a
 * function of kanban.ts, run as one transaction.
 *
 * The board menu holds Color, Icons & logos, Columns (3, 4, Add column) and Remove board;
 * the column menu holds Color, Icons & logos, Move left, Move right and Delete column; a tap on a
 * card's grip opens Move to. Add column is Pro.
 * Spec: docs/internal/issues/0270.md (Spec)
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { NodeViewContent, NodeViewWrapper, type NodeViewProps, type Editor as TipTapEditor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu';
import { ColorSwatchRow, IconButton } from './ui';
import { BackRow } from './ui/BackRow';
import { ActionItem, Group, OptionsMenu } from './OptionsMenu';
import type { LookColor } from './itemStyles';
import { ArrowLeft, ArrowRight, Check, Columns, DotsThree, Kanban, Palette, Plus, Shapes, Trash, XSquare } from './icons';
import { PathGlyph } from './looks/LookGlyph';
import { useLookPaths } from './looks/lookIconsLoader';
import { isColumnColor } from './calloutKeywords';
import { BlockGrip } from './BlockGrip';
import { writeKanbanPref } from './editorPrefs';
import { DEFAULT_COLORS, slotName, startLayout } from './kanbanLayout';
import {
  CARD_MENU_EVENT,
  type CardMenuDetail,
  MAX_COLUMNS,
  MIN_COLUMNS,
  addColumn,
  columnsOf,
  deleteColumn,
  isBoard,
  isPlaceholderTask,
  leadIconOf,
  makeBoard,
  moveCard,
  moveColumn,
  removeBoard,
  setBoardIcon,
  setColumnColor,
  setColumnCount,
  setColumnIcon,
} from './kanban';

const LookPicker = lazy(() => import('./looks/LookPicker').then((m) => ({ default: m.LookPicker })));

export interface KanbanOptions {
  /** True for Pro and the demo: Add column runs. */
  kanbanUnlocked: () => boolean;
  /** Opens the upgrade window for a free account. */
  onUpgrade: () => void;
}


/** Inserts a new board where the caret is: the count and colors of the last
 *  board on this device, the default names in the reader's language. */
export function insertKanbanBoard(editor: TipTapEditor, t: TFunction) {
  const { names, colors, icons } = startLayout(t);
  const count = names.length as 3 | 4;
  editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      const board = makeBoard(state.schema, names, colors, icons);
      if (dispatch) {
        const from = tr.selection.from;
        tr.replaceSelectionWith(board);
        // The caret goes into the first card of the first column.
        const start = tr.mapping.map(from, -1);
        let target = -1;
        tr.doc.nodesBetween(start, Math.min(tr.doc.content.size, start + board.nodeSize + 4), (node, pos) => {
          if (target === -1 && node.type.name === 'taskItem') {
            target = pos + 2;
            return false;
          }
          return target === -1;
        });
        if (target >= 0) tr.setSelection(TextSelection.create(tr.doc, target));
        tr.scrollIntoView();
      }
      return true;
    })
    .run();
  writeKanbanPref({ count, colors });
}

/** Remembers a board of 3 or 4 columns for the next insert. */
function rememberBoard(board: PMNode | null | undefined) {
  if (!board || !isBoard(board)) return;
  const cols = columnsOf(board);
  if (cols.length !== 3 && cols.length !== 4) return;
  const defaults = DEFAULT_COLORS[cols.length];
  writeKanbanPref({
    count: cols.length,
    colors: cols.map((c, i) => (isColumnColor(c.attrs.meta) ? (c.attrs.meta as string) : defaults[i]!)),
  });
}

function columnName(column: PMNode, t: TFunction): string {
  const title = column.firstChild?.type.name === 'calloutTitle' ? column.firstChild.textContent.trim() : '';
  return title || t('editor:callout.types.column');
}

/** Runs one board edit as one transaction. */
function useBoardEdit(editor: TipTapEditor, getPos: () => number | undefined) {
  return (edit: (tr: Transaction, pos: number) => boolean) => {
    const pos = getPos();
    // A menu opened before the note turned read-only must not edit it.
    if (typeof pos !== 'number' || !editor.isEditable) return;
    const tr = editor.state.tr;
    if (!edit(tr, pos)) return;
    editor.view.dispatch(tr);
    rememberBoard(editor.state.doc.nodeAt(pos));
  };
}

export function KanbanBoardView({ node, editor, getPos, extension }: NodeViewProps) {
  const { t } = useTranslation('editor');
  const options = extension.options as KanbanOptions;
  const edit = useBoardEdit(editor, getPos);
  const ctx = useContextMenu();
  const dotsRef = useRef<HTMLSpanElement | null>(null);
  const [menu, setMenu] = useState<null | 'main' | 'color'>(null);
  const closeMenu = () => setMenu(null);
  const columns = columnsOf(node);
  const count = columns.length;
  // A title that holds only its icon still shows the "Kanban board" hint.
  const titleEmpty = node.firstChild?.type.name === 'calloutTitle' && node.firstChild.textContent.trim() === '';
  const editable = editor.isEditable;
  const [pickerOpen, setPickerOpen] = useState(false);
  // An icon that leads the title stands in for the Kanban glyph.
  const ownIcon = leadIconOf(node);
  const iconPaths = useLookPaths(ownIcon);

  // A tap on a card's grip asks this board for the Move to menu.
  useEffect(() => {
    const onCardMenu = (e: Event) => {
      const board = dotsRef.current?.closest('.pn-callout-kanban');
      if (!board || (e.target as HTMLElement | null)?.closest('.pn-callout-kanban') !== board) return;
      const { pos, column, x, y } = (e as CustomEvent<CardMenuDetail>).detail;
      const items: ContextMenuItem[] = [
        { type: 'header', label: t('kanban.moveTo') },
        ...columnsOf(editor.state.doc.nodeAt(getPos() ?? -1) ?? node).map((col, i) => ({
          label: columnName(col, t),
          checked: i === column,
          onSelect: () => {
            if (i === column || !editor.isEditable) return;
            const tr = editor.state.tr;
            if (moveCard(tr, pos, i)) editor.view.dispatch(tr);
          },
        })),
      ];
      ctx.open({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }, items);
    };
    document.addEventListener(CARD_MENU_EVENT, onCardMenu);
    return () => document.removeEventListener(CARD_MENU_EVENT, onCardMenu);
  });

  const unlocked = options.kanbanUnlocked();
  // Each column's color, as the dots at the end of the Color row.
  const colorDots = (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {columns.map((col, i) => (
        <span
          key={i}
          className="w-3 h-3 rounded-full border border-divider"
          style={{ background: `var(--pn-label-${isColumnColor(col.attrs.meta) ? (col.attrs.meta as string) : 'gray'}-ink)` }}
        />
      ))}
    </span>
  );
  const boardMenu = menu && (
    <OptionsMenu
      anchorRef={dotsRef}
      label={t('formatBar.optionsFor', { item: t('callout.types.kanban') })}
      view={menu}
      onClose={closeMenu}
      onEscape={() => (menu === 'main' ? closeMenu() : setMenu('main'))}
      // The Color view holds a row of ten swatches; the main view only short rows.
      className={menu === 'color' ? 'w-80' : 'w-60'}
    >
      {menu === 'color' ? (
        <>
          <BackRow title={t('shell:noteOptionsMenu.color')} onBack={() => setMenu('main')} />
          <div className="px-4 py-3 flex flex-col gap-3">
            {columns.map((col, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <span className="text-compact text-pn-muted truncate" dir="auto">{columnName(col, t)}</span>
                <ColorSwatchRow
                  selected={isColumnColor(col.attrs.meta) ? (col.attrs.meta as LookColor) : 'none'}
                  noneLabel={t('color.remove')}
                  colorLabel={(c) => t(`color.names.${c}`)}
                  onPick={(c) => edit((tr, pos) => setColumnColor(tr, pos, i, c))}
                />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <Group>
            <ActionItem
              label={t('shell:noteOptionsMenu.color')}
              icon={<Palette aria-hidden="true" />}
              value={colorDots}
              chevron
              onClick={() => setMenu('color')}
            />
            <ActionItem
              label={t('shell:noteOptionsMenu.icon')}
              icon={<Shapes aria-hidden="true" />}
              value={iconPaths ? <PathGlyph paths={iconPaths} size={16} className="text-pn-soft" /> : undefined}
              onClick={() => {
                closeMenu();
                setPickerOpen(true);
              }}
            />
          </Group>
          <Group>
            {([3, 4] as const).map((n) => (
              <ActionItem
                key={n}
                label={t('kanban.columnCount', { count: n })}
                icon={<Columns aria-hidden="true" />}
                value={count === n ? <Check aria-hidden="true" className="text-accent" /> : undefined}
                onClick={() => {
                  edit((tr, pos) => setColumnCount(tr, pos, n, (c, slot) => slotName(t, c, slot)));
                  closeMenu();
                }}
              />
            ))}
            <ActionItem
              label={t('kanban.addColumn')}
              icon={<Plus aria-hidden="true" />}
              pro={!unlocked}
              disabled={count >= MAX_COLUMNS}
              onClick={() => {
                closeMenu();
                if (!options.kanbanUnlocked()) options.onUpgrade();
                else edit((tr, pos) => addColumn(tr, pos, '', null));
              }}
            />
          </Group>
          <Group>
            <ActionItem
              label={t('kanban.removeBoard')}
              icon={<XSquare aria-hidden="true" />}
              tone="danger"
              onClick={() => {
                closeMenu();
                edit((tr, pos) => removeBoard(tr, pos));
              }}
            />
          </Group>
        </>
      )}
    </OptionsMenu>
  );

  return (
    <NodeViewWrapper
      as="div"
      className={`pn-callout pn-callout-kanban${count > 0 ? ' pn-kanban-has-columns' : ''}${ownIcon ? ' pn-kanban-own-icon' : ''}`}
      data-callout=""
      data-type="kanban"
      role="group"
      aria-label={titleEmpty ? t('callout.types.kanban') : `${t('callout.types.kanban')}: ${node.firstChild?.textContent ?? ''}`}
      style={{ ['--kanban-cols' as string]: Math.max(1, count) } as React.CSSProperties}
    >
      {!ownIcon && (
        <span className="pn-kanban-icon" contentEditable={false} aria-hidden="true">
          <Kanban weight="bold" />
        </span>
      )}
      {titleEmpty && (
        <span className="pn-callout-placeholder pn-kanban-placeholder" contentEditable={false} aria-hidden="true">
          {t('callout.types.kanban')}
        </span>
      )}
      {editable && (
        <span className="pn-kanban-tools" contentEditable={false} ref={dotsRef}>
          <BlockGrip editor={editor} getPos={getPos} className="pn-kanban-grip" />
          <IconButton
            label={t('formatBar.optionsFor', { item: t('callout.types.kanban') })}
            position="start"
            aria-haspopup="dialog"
            aria-expanded={!!menu}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMenu((m) => (m ? null : 'main'))}
          >
            <DotsThree weight="bold" />
          </IconButton>
        </span>
      )}
      <NodeViewContent className="pn-callout-content" />
      {boardMenu}
      {pickerOpen && (
        <Suspense fallback={null}>
          <LookPicker
            target={{ kind: 'insert', lookKey: '', name: t('callout.types.kanban') }}
            styles={{}}
            noteColors="off"
            onNoteColors={() => {}}
            onPick={(patch) => {
              if (patch.icon) edit((tr, pos) => setBoardIcon(tr, pos, patch.icon!));
              setPickerOpen(false);
            }}
            onCancel={() => {}}
            onClose={() => setPickerOpen(false)}
          />
        </Suspense>
      )}
      <ContextMenu state={ctx.state} onClose={ctx.close} />
    </NodeViewWrapper>
  );
}

/** The number of cards in a column: the tasks of its top-level task lists. */
function cardCount(column: PMNode): number {
  let n = 0;
  column.forEach((child) => {
    if (child.type.name === 'taskList') {
      child.forEach((item) => {
        if (!isPlaceholderTask(item)) n++;
      });
    }
  });
  return n;
}

export function KanbanColumnView({ node, editor, getPos }: NodeViewProps) {
  const { t } = useTranslation('editor');
  const [menu, setMenu] = useState<null | 'main' | 'color'>(null);
  const closeMenu = () => setMenu(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const dotsRef = useRef<HTMLSpanElement | null>(null);
  // The theme's label tokens, the colors the swatches show: gray without a color.
  const own = isColumnColor(node.attrs.meta as string | null) ? (node.attrs.meta as LookColor) : null;
  const key = own ?? 'gray';
  // The icon that leads the title, the one the Icons & logos row sets.
  const iconPaths = useLookPaths(leadIconOf(node));
  const titleEmpty = node.firstChild?.type.name === 'calloutTitle' && node.firstChild.content.size === 0;
  const editable = editor.isEditable;

  // The board around this column and this column's place in it.
  const place = () => {
    const pos = getPos();
    if (typeof pos !== 'number') return null;
    const $pos = editor.state.doc.resolve(pos);
    const board = $pos.parent;
    if (!isBoard(board)) return null;
    let index = -1;
    board.forEach((child, _o, i) => {
      if (i <= $pos.index() && child.type.name === 'callout' && child.attrs.type === 'column') index++;
    });
    return { boardPos: $pos.before(), board, index };
  };
  const inBoard = !!place();

  const run = (edit: (tr: Transaction, boardPos: number, index: number) => boolean) => {
    const p = place();
    if (!p || !editor.isEditable) return;
    const tr = editor.state.tr;
    if (!edit(tr, p.boardPos, p.index)) return;
    editor.view.dispatch(tr);
    rememberBoard(editor.state.doc.nodeAt(p.boardPos));
  };

  const p = menu ? place() : null;
  const total = p ? columnsOf(p.board).length : 0;
  const pick = (edit: (tr: Transaction, boardPos: number, index: number) => boolean) => {
    closeMenu();
    run(edit);
  };
  const columnMenu = p && (
    <OptionsMenu
      anchorRef={dotsRef}
      label={t('formatBar.optionsFor', { item: columnName(node, t) })}
      view={menu ?? 'main'}
      onClose={closeMenu}
      onEscape={() => (menu === 'main' ? closeMenu() : setMenu('main'))}
      // The Color view holds a row of ten swatches, as in the board menu.
      className={menu === 'color' ? 'w-80' : 'w-max min-w-48'}
    >
      {menu === 'color' ? (
        <>
          <BackRow title={t('shell:noteOptionsMenu.color')} onBack={() => setMenu('main')} />
          <div className="px-4 py-3">
            <ColorSwatchRow
              selected={isColumnColor(node.attrs.meta as string | null) ? (node.attrs.meta as LookColor) : 'none'}
              noneLabel={t('color.remove')}
              colorLabel={(c) => t(`color.names.${c}`)}
              onPick={(c) => run((tr, b, i) => setColumnColor(tr, b, i, c))}
            />
          </div>
        </>
      ) : (
        <>
          <Group>
            <ActionItem
              label={t('shell:noteOptionsMenu.color')}
              icon={<Palette aria-hidden="true" />}
              value={
                <span className="inline-flex items-center gap-2 min-w-0">
                  <span
                    aria-hidden="true"
                    className="shrink-0 w-4 h-4 rounded-full border border-divider"
                    style={own ? { background: `var(--pn-label-${own}-ink)` } : undefined}
                  />
                  <span className="truncate">{own ? t(`color.names.${own}`) : t('shell:noteOptionsMenu.colorNone')}</span>
                </span>
              }
              chevron
              onClick={() => setMenu('color')}
            />
            <ActionItem
              label={t('shell:noteOptionsMenu.icon')}
              icon={<Shapes aria-hidden="true" />}
              value={iconPaths ? <PathGlyph paths={iconPaths} size={16} className="text-pn-soft" /> : undefined}
              onClick={() => {
                closeMenu();
                setPickerOpen(true);
              }}
            />
          </Group>
          <Group>
            <ActionItem
              label={t('formatBar.moveLeft')}
              icon={<ArrowLeft aria-hidden="true" />}
              disabled={p.index === 0}
              onClick={() => pick((tr, b, i) => moveColumn(tr, b, i, -1))}
            />
            <ActionItem
              label={t('formatBar.moveRight')}
              icon={<ArrowRight aria-hidden="true" />}
              disabled={p.index >= total - 1}
              onClick={() => pick((tr, b, i) => moveColumn(tr, b, i, 1))}
            />
          </Group>
          <Group>
            <ActionItem
              label={t('table.deleteColumn')}
              icon={<Trash aria-hidden="true" />}
              tone="danger"
              disabled={total <= MIN_COLUMNS}
              onClick={() => pick((tr, b, i) => deleteColumn(tr, b, i))}
            />
          </Group>
        </>
      )}
    </OptionsMenu>
  );

  return (
    <NodeViewWrapper
      as="div"
      className="pn-callout pn-callout-column"
      data-callout=""
      data-type="column"
      role="group"
      aria-label={`${columnName(node, t)}, ${t('kanban.cardCount', { count: cardCount(node) })}`}
      style={{ ['--cs' as string]: `var(--pn-label-${key}-ink)`, ['--ct' as string]: `var(--pn-label-${key}-tint)` } as React.CSSProperties}
    >
      {titleEmpty && (
        <span className="pn-callout-placeholder pn-column-placeholder" contentEditable={false} aria-hidden="true">
          {t('callout.types.column')}
        </span>
      )}
      <span className="pn-column-tools" contentEditable={false} ref={dotsRef}>
        <span className="pn-column-count" aria-hidden="true">{cardCount(node)}</span>
        {editable && inBoard && (
          <IconButton
            label={t('formatBar.optionsFor', { item: columnName(node, t) })}
            position="start"
            aria-haspopup="dialog"
            aria-expanded={!!menu}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMenu((m) => (m ? null : 'main'))}
          >
            <DotsThree weight="bold" />
          </IconButton>
        )}
      </span>
      <NodeViewContent className="pn-callout-content" />
      {columnMenu}
      {pickerOpen && (
        <Suspense fallback={null}>
          <LookPicker
            target={{ kind: 'insert', lookKey: '', name: columnName(node, t) }}
            styles={{}}
            noteColors="off"
            onNoteColors={() => {}}
            onPick={(patch) => {
              if (patch.icon) run((tr, b, i) => setColumnIcon(tr, b, i, patch.icon!));
              setPickerOpen(false);
            }}
            onCancel={() => {}}
            onClose={() => setPickerOpen(false)}
          />
        </Suspense>
      )}
    </NodeViewWrapper>
  );
}
