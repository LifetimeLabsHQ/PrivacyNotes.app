import { useContext, type ReactElement, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  TextAa,
  type Icon,
} from './icons';
import { FORMAT_BAR_LOOK, formatBarHint } from './formatBarItems';
import { barForWidth, formatBarItem, type ResolvedFormatBar } from './formatBar';
import { FormatBarContext } from './formatBarContext';
import { TB_ICON, ToolbarBtn } from './editorToolbarParts';
import { type InsertMenuItem } from './ToolbarInsertMenu';
import { ToolbarFrame } from './ToolbarFrame';
import { sourcePreviewButtons, sourcePreviewMenuItems, type SourcePreviewControls } from './sourcePreviewButtons';
import { useIsMobile, useIsTouchDevice } from './useIsMobile';
import { useToolbarFit } from './useToolbarFit';
import { keyText } from './shortcutMatch';
import { isLinuxNative } from './devices';
import { SOURCE_ACTIONS, type SourceAction } from './markdownSourceFormat';
import type { SourceFoldSummary } from './markdownSourceFolds';

/**
 * The buttons over the Notes box of a login, card and SSH key: the Markdown
 * view's actions minus what is too big for a few lines of notes (heading,
 * table, divider) and the note-link, which a plain box cannot offer a title
 * list for and the item view cannot open. Spec: docs/internal/issues/0634.md
 */
const NOTES_FIELD_ACTIONS: ReadonlySet<string> = new Set<SourceAction>([
  'bold', 'italic', 'strike', 'inlinecode', 'tasks',
  'bullets', 'numbered', 'quote', 'codeblock', 'link',
]);

/**
 * The Notes box's buttons in the person's arrangement (Settings > Toolbar):
 * the bar's order, then the '+' menu's, then the end's, without the items
 * they hid. The box has no menu of its own, so all of them sit in its row.
 */
export function notesFieldItems(layout: ResolvedFormatBar): SourceAction[] {
  return [...layout.bar, ...layout.menu, ...layout.end].filter((k): k is SourceAction => NOTES_FIELD_ACTIONS.has(k));
}

/**
 * The buttons of a source bar, in the order given, each with the look the
 * formatted bar gives the same action. Their presses write Markdown into the
 * text, so none shows an "on" state: a plain field has no parser to read one
 * from.
 */
export function SourceButtons({ items, onAction, tabIndex }: {
  items: readonly SourceAction[];
  onAction: (action: SourceAction) => void;
  tabIndex?: number;
}) {
  const { t } = useTranslation('editor');
  return (
    <>
      {items.map((key) => {
        const { Icon, label } = FORMAT_BAR_LOOK[key]!;
        return (
          <ToolbarBtn key={key} onClick={() => onAction(key)} label={t(label)} tabIndex={tabIndex}>
            <Icon size={TB_ICON} />
          </ToolbarBtn>
        );
      })}
    </>
  );
}

type Props = {
  onAction: (action: SourceAction) => void;
  /** The date or the date and time at the caret, as the keys insert them. */
  onInsertDate: (style: 'date' | 'dateTime') => void;
  /** The field's own undo history. */
  onHistory: (action: 'undo' | 'redo') => void;
  /** The text's folds, for Collapse all / Expand all (markdownSourceFolds.ts). */
  folds: SourceFoldSummary;
  onShowFormatted: () => void;
  /** Lets go of the field, so a touch keyboard closes. */
  onHideKeyboard: () => void;
  atBottom: boolean;
  mobileTabIndex?: number;
  /** The bar's root, which the view measures to pin its find bar under it. */
  rootRef?: Ref<HTMLDivElement>;
  /** Split view, the formatted preview beside the text; absent in the phone
   *  layout. Dimmed while the pane is too narrow for two columns. */
  preview?: SourcePreviewControls;
};

/** What an arranged item does in the Markdown view. */
type BarItem = {
  label: string;
  Icon: Icon;
  hint: string | null;
  keys?: string;
  run: () => void;
  disabled?: boolean;
  /** The button's tip, where it says more than the label. */
  tip?: string;
  /** Runs in the formatted view only: shown dimmed, in the + menu too. */
  formattedOnly?: boolean;
};

const noop = () => {
  /* dimmed: the formatted view runs it */
};

const isSeparator = (key: string) => key.startsWith('separator');

/**
 * The format bar in the Markdown view: the same bar as the formatted view's
 * (ToolbarFrame), from the same arrangement (Settings > Toolbar,
 * FormatBarContext), every button in its place. The ones that write Markdown
 * run here (SOURCE_ACTIONS, plus undo and redo, the dates, Collapse all and
 * the gear); the rest (underline, color, alignment, font, the paperclip, the
 * pickers) are shown dimmed, with a tip that says they work in the formatted
 * view (owner, 2026-11-20). "Show markdown" stands as "Show formatted" in its
 * place. Split view is an item like the others (sourcePreviewButtons.tsx),
 * with Swap sides beside it while it shows.
 * Spec: docs/internal/specs/editor-mode-toggle.md (Source bar edits)
 */
export function MarkdownSourceBar({ onAction, onInsertDate, onHistory, folds, onShowFormatted, onHideKeyboard, atBottom, mobileTabIndex, rootRef, preview }: Props) {
  const { t } = useTranslation('editor');
  const { layout: arranged, onCustomize } = useContext(FormatBarContext);
  const strip = useIsTouchDevice();
  // A narrow window keeps the gear at the end of the row, as on the
  // formatted bar (barForWidth).
  const layout = barForWidth(arranged, !useIsMobile());
  const foldCloses = folds.open > 0 || folds.foldable === 0;

  const item = (key: string): BarItem | null => {
    const look = FORMAT_BAR_LOOK[key];
    if (!look) return null;
    const base = { label: t(look.label), Icon: look.Icon, hint: formatBarHint(key) };
    switch (key) {
      case 'foldAll':
        return {
          label: t(foldCloses ? 'shell:folders.collapseAll' : 'shell:folders.expandAll'),
          Icon: foldCloses ? ArrowsInLineVertical : ArrowsOutLineVertical,
          hint: null,
          run: () => onAction('foldAll'),
          disabled: folds.foldable === 0,
        };
      case 'undo':
      case 'redo':
        return { ...base, hint: keyText(key), keys: keyText(key), run: () => onHistory(key) };
      case 'date':
      case 'dateTime': {
        const keys = keyText(key === 'date' ? 'insertDate' : 'insertDateTime');
        return { ...base, hint: keys, keys, run: () => onInsertDate(key) };
      }
      case 'customize':
        return onCustomize ? { ...base, run: onCustomize } : null;
      case 'markdownView':
        return { label: t('notes:editor.showFormatted'), Icon: TextAa, hint: keyText('markdownView'), keys: keyText('markdownView'), run: onShowFormatted };
      // Drawn by sourcePreviewButtons below; absent in the phone layout.
      case 'splitView':
        return preview ? { ...base, run: preview.onToggle } : null;
      default: {
        if (SOURCE_ACTIONS.has(key)) return { ...base, run: () => onAction(key as SourceAction) };
        // What the formatted bar does not offer on this device stays out
        // here too: the recorder on Linux, and a paperclip with nothing in it.
        if (key === 'audio' && isLinuxNative()) return null;
        if (key === 'attachMenu' && !layout.attachMenu.some((k) => k !== 'audio' || !isLinuxNative())) return null;
        return {
          ...base,
          tip: t('notes:editor.formattedOnly', { name: base.label }),
          hint: t('notes:editor.formattedOnlyHint'),
          run: noop,
          disabled: true,
          formattedOnly: true,
        };
      }
    }
  };

  /** A zone's buttons; a line the person placed, but never two in a row or
   *  one at an edge, where the items around it are not offered here. */
  const controls = (keys: readonly string[]): ReactElement[] => {
    const offered = keys.filter((k) => isSeparator(k) || item(k));
    const kept = offered.filter((k, i) => !isSeparator(k) || (i > 0 && i < offered.length - 1 && !isSeparator(offered[i - 1]!)));
    return kept.flatMap((key) => {
      if (isSeparator(key)) return [<span key={key} aria-hidden="true" className="shrink-0 -mx-0.5 h-4 w-px bg-pn-muted/35" />];
      // Split view, with Swap sides beside it while it shows.
      if (key === 'splitView' && preview) return sourcePreviewButtons(t, preview, mobileTabIndex);
      const it = item(key)!;
      const button = (
        <ToolbarBtn key={key} onClick={it.run} disabled={it.disabled} label={it.tip ?? it.label} keys={it.keys} tabIndex={mobileTabIndex}>
          <it.Icon size={TB_ICON} />
        </ToolbarBtn>
      );
      return [button];
    });
  };

  const row = controls(layout.bar);
  const fit = useToolbarFit(strip, row.map((el) => el.key).join(','));
  const menu: InsertMenuItem[] = layout.menu.flatMap((key) => {
    if (key === 'splitView') return preview ? sourcePreviewMenuItems(t, preview) : [];
    const it = item(key);
    // Collapse all drops its row when there is nothing to fold, as on the
    // formatted bar; an item of the formatted view stays, dimmed.
    return it && (!it.disabled || it.formattedOnly)
      ? [{ key, group: formatBarItem(key)!.group, Icon: it.Icon, label: it.label, hint: it.hint, active: false, run: it.run, disabled: it.disabled }]
      : [];
  });
  // On a touch strip a press keeps the field's focus, so the keyboard stays.
  const press = (act: () => void) => (strip
    ? { onPointerDown: (e: ReactPointerEvent) => e.preventDefault(), onClick: act }
    : { onClick: act });

  return (
    <ToolbarFrame
      fit={fit}
      row={row}
      menu={menu}
      press={press}
      end={controls(layout.end)}
      atBottom={atBottom}
      strip={strip}
      onHideKeyboard={onHideKeyboard}
      tabIndex={mobileTabIndex}
      rootRef={rootRef}
    />
  );
}
