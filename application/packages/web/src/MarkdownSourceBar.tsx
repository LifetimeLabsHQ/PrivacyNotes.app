import { useTranslation } from 'react-i18next';
import { TextAa } from './icons';
import { FORMAT_BAR_LOOK } from './formatBarItems';
import { TB_ICON, TipSideContext, ToolbarBtn } from './editorToolbarParts';
import { useIsTouchDevice } from './useIsMobile';
import type { SourceAction } from './markdownSourceFormat';

/**
 * The fixed set the Markdown view offers: the items that have a plain
 * Markdown form. Settings > Toolbar does not arrange it; colour, alignment,
 * font, underline and the callout have no Markdown and are not here.
 * Spec: docs/internal/issues/0493.md (Spec)
 */
const SOURCE_BAR: readonly SourceAction[] = [
  'bold', 'italic', 'strike', 'heading', 'tasks', 'link', 'notelink',
  'bullets', 'numbered', 'quote', 'inlinecode', 'codeblock', 'table', 'hr',
];

/**
 * The bar over the Notes box of a login, card and SSH key: the same buttons
 * minus what is too big for a few lines of notes (heading, table, divider)
 * and the note-link, which a plain box cannot offer a title list for and the
 * item view cannot open. Spec: docs/internal/issues/0634.md
 */
export const NOTES_FIELD_BAR: readonly SourceAction[] = [
  'bold', 'italic', 'strike', 'inlinecode', 'tasks',
  'bullets', 'numbered', 'quote', 'codeblock', 'link',
];

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
  onShowFormatted: () => void;
  atBottom: boolean;
  mobileTabIndex?: number;
};

/**
 * The Markdown view's toolbar, over SourceButtons. The
 * way back to formatted text closes the bar, at the place the formatted
 * bar's "Show markdown" holds by default.
 */
export function MarkdownSourceBar({ onAction, onShowFormatted, atBottom, mobileTabIndex }: Props) {
  const { t } = useTranslation('notes');
  const strip = useIsTouchDevice();
  return (
    <TipSideContext.Provider value={atBottom ? 'above' : 'below'}>
      <div className={`pn-editor-toolbar border-divider ${
        atBottom ? 'pn-toolbar-bottom' : '-mx-4 sm:-mx-6 bg-surface-2/90 backdrop-blur [overscroll-behavior:contain] border-b'
      }`}>
        <div className="flex items-center gap-1.5 px-4 sm:px-6 py-1">
          <div className={`flex-1 min-w-0 flex items-center gap-0.5 ${strip ? 'pn-format-strip' : 'flex-wrap'}`}>
            <SourceButtons items={SOURCE_BAR} onAction={onAction} tabIndex={mobileTabIndex} />
          </div>
          <span aria-hidden="true" className="shrink-0 mx-0.5 h-4 w-px bg-pn-muted/35" />
          <ToolbarBtn onClick={onShowFormatted} label={t('notes:editor.showFormatted')} tabIndex={mobileTabIndex}>
            <TextAa size={TB_ICON} />
          </ToolbarBtn>
        </div>
      </div>
    </TipSideContext.Provider>
  );
}
