import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotePencil, TextAa } from './icons';
import { FieldLabel } from './formFields';
import { NOTES_FIELD_BAR, SourceButtons } from './MarkdownSourceBar';
import { TB_ICON, TipSideContext, ToolbarBtn } from './editorToolbarParts';
import { FORMAT_BAR_LOOK } from './formatBarItems';
import { NotesText } from './detailPane';
import { applySourceAction, type SourceAction } from './markdownSourceFormat';
import { useToolbarFit } from './useToolbarFit';
import { useIsTouchDevice } from './useIsMobile';

const NOTES_BAR_SIG = NOTES_FIELD_BAR.join();

/**
 * The Notes box of a login, card and SSH key: a plain text field with the
 * Markdown view's buttons over it. The text stays Markdown as typed, so the
 * vault export, the extension and the burn share carry it unchanged, and the
 * item view shows it formatted (DetailNotes). A press goes through the same
 * edit and the same typed change as the Markdown view's bar, so one undo in
 * the box takes it back.
 *
 * "Show formatted" at the end of the bar shows the notes the way the item
 * view will (NotesText), and "Show markdown" goes back. A preview, not an
 * editor: the format buttons step aside meanwhile. The text area stays
 * mounted, only hidden, so its undo history survives the round trip.
 *
 * The imports are static on purpose: the bar's modules already sit on the
 * boot path through the Markdown view, and a lazy chunk measured 2.9 kB
 * larger there, because it splits chunks the boot path shares.
 * Spec: docs/internal/issues/0634.md
 */
export function NotesField({ label, value, onChange, placeholder, disabled }: {
  label: string;
  value: string;
  onChange: (notes: string) => void;
  placeholder: string;
  disabled: boolean;
}) {
  const { t } = useTranslation(['notes', 'editor']);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [formatted, setFormatted] = useState(false);
  // The text area's height when the preview opened, so the box does not jump.
  const [height, setHeight] = useState(0);
  const backToText = useRef(false);
  useEffect(() => {
    if (formatted || !backToText.current) return;
    backToText.current = false;
    ref.current?.focus();
  }, [formatted]);
  // On a touch screen the bar is the editor's sideways strip; under a pointer
  // it wraps, because the strip clips on both axes and a tip above a button
  // would be cut off. The key changes when the strip comes or goes, so the
  // strip's fade attaches to the row that is there.
  const strip = useIsTouchDevice();
  const { rowRef } = useToolbarFit(true, strip && !disabled && !formatted ? NOTES_BAR_SIG : '');
  const MarkdownIcon = FORMAT_BAR_LOOK.markdownView!.Icon;

  function toggleFormatted() {
    if (!formatted) setHeight(ref.current?.offsetHeight ?? 0);
    else backToText.current = true;
    setFormatted(!formatted);
  }

  function format(action: SourceAction) {
    const el = ref.current;
    if (!el || disabled) return;
    const untyped = applySourceAction(el, action);
    if (untyped !== null) onChange(untyped);
  }

  return (
    <div>
      <FieldLabel icon={<NotePencil />}>{label}</FieldLabel>
      {/* The field comes first in the DOM and the bar is drawn above it, so
          Tab reaches the text before the buttons, then the bar. */}
      <div className="flex flex-col-reverse rounded-md border border-divider bg-surface-1 focus-within:ring-1 focus-within:ring-accent">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={label}
          rows={8}
          hidden={formatted && !disabled}
          dir="auto"
          // The box around it is the field (FIELD_CLASS's border, fill and
          // focus ring); the text area draws none of its own, or a second
          // ring shows inside the first.
          className="block w-full resize-y bg-transparent px-3 py-2 text-body text-pn focus:outline-none disabled:opacity-60"
        />
        {formatted && !disabled && (
          <div style={{ minHeight: height }}>
            {value.trim()
              ? <NotesText text={value} markdown pad="px-3 py-2" />
              : <div className="px-3 py-2 text-body text-pn-muted">{placeholder}</div>}
          </div>
        )}
        {!disabled && (
          <TipSideContext.Provider value="above">
            {/* On touch: one row that scrolls sideways when the box is too
                narrow for every button, with a fade on the edge that has more
                (useToolbarFit). The Markdown view's bar makes the same split. */}
            <div className="flex items-center gap-1.5 border-b border-divider px-1 py-0.5">
              <div ref={strip ? rowRef : undefined} className={`flex-1 min-w-0 flex items-center gap-0.5 ${strip ? 'pn-format-strip' : 'flex-wrap'}`}>
                {!formatted && <SourceButtons items={NOTES_FIELD_BAR} onAction={format} />}
              </div>
              {!formatted && <span aria-hidden="true" className="shrink-0 mx-0.5 h-4 w-px bg-pn-muted/35" />}
              <ToolbarBtn
                onClick={toggleFormatted}
                label={formatted ? t(`editor:${FORMAT_BAR_LOOK.markdownView!.label}`) : t('notes:editor.showFormatted')}
              >
                {formatted ? <MarkdownIcon size={TB_ICON} /> : <TextAa size={TB_ICON} />}
              </ToolbarBtn>
            </div>
          </TipSideContext.Provider>
        )}
      </div>
    </div>
  );
}
