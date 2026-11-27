/**
 * LinkSheet - mobile bottom sheet / desktop dropdown for adding, editing,
 * and removing URL links in the TipTap editor.
 *
 * Replaces the old floating LinkPopover that broke on mobile (keyboard
 * pushed it off-screen, coordsAtPos unreliable after layout shift).
 *
 * Mobile: slides up from the bottom as a sheet, sits above the keyboard.
 * Desktop: a portal-rendered panel anchored under the toolbar's link button,
 * placed by usePopoverPosition like every other toolbar dropdown.
 *
 * Pre-fills "Link text" from the current selection. URL field validates
 * on submit. Supports edit + remove for existing links. The hover text
 * (GitHub #702) sits behind a fold that opens by itself on a link that
 * has one, so the panel stays two fields for everyone who never uses it.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { isImeComposing } from './imeComposing';
import { useTranslation } from 'react-i18next';
import { useEscapeToClose } from './useEscapeToClose';
import { useKeyboardRect } from './useKeyboardOpen';
import { NO_TEXT_ASSIST } from './formFields';
import { Button, CloseButton, Popover, TextField } from './ui';
import { CaretDown, CaretRight } from './icons';
import { getMarkRange } from '@tiptap/core';
import { looksLikeUrl, normalizeUrl } from './editorLinks';
import { isPictureSelection } from './EncryptedImage';
import type { Editor } from '@tiptap/react';

type Props = {
  editor: Editor;
  isMobile: boolean;
  /**
   * What the desktop panel lines up under. Unread on mobile, where the sheet
   * is pinned to the viewport bottom instead.
   */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
};

export function LinkSheet({ editor, isMobile, anchorRef, onClose }: Props) {
  const { t } = useTranslation('editor');
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);
  const keyboard = useKeyboardRect(isMobile);

  // Existing link attributes (either on a selected image #970 or inside a link mark).
  const isImage = isPictureSelection(editor.state.selection);
  const existingHref: string = isImage
    ? ((editor.getAttributes('image').linkHref as string | undefined) ?? '')
    : ((editor.getAttributes('link').href as string | undefined) ?? '');
  const existingTitle: string = isImage
    ? ((editor.getAttributes('image').linkTitle as string | undefined) ?? '')
    : ((editor.getAttributes('link').title as string | undefined) ?? '');

  // Selected text for pre-filling the link text field.
  const { from, to } = editor.state.selection;
  const selectionText = from !== to
    ? editor.state.doc.textBetween(from, to, ' ')
    : '';

  // The words of the link the caret is in, which are what Update rewrites:
  // it replaces the mark's whole range, so a reader who selected half a link
  // still edits the whole of it and sees the whole of it in the field.
  const linkMark = editor.schema.marks.link;
  const linkRange = existingHref && linkMark
    ? getMarkRange(editor.state.selection.$from, linkMark)
    : undefined;
  const existingText = linkRange
    ? editor.state.doc.textBetween(linkRange.from, linkRange.to, ' ')
    : '';

  const [url, setUrl] = useState(existingHref);
  const [text, setText] = useState(existingHref ? existingText : selectionText);
  const [title, setTitle] = useState(existingHref ? existingTitle : '');
  const [titleOpen, setTitleOpen] = useState(!!title);
  const [urlError, setUrlError] = useState('');

  // Focus the URL input on mount.
  useEffect(() => {
    requestAnimationFrame(() => {
      urlRef.current?.focus();
      if (existingHref) urlRef.current?.select();
    });
  }, [existingHref]);

  useEscapeToClose(onClose, isMobile);

  function validate(): boolean {
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError(t('link.errorEnterUrl'));
      return false;
    }
    if (!looksLikeUrl(trimmed)) {
      setUrlError(t('link.errorInvalidUrl'));
      return false;
    }
    setUrlError('');
    return true;
  }

  function apply() {
    if (!validate()) return;
    const href = normalizeUrl(url);
    const linkText = text.trim();
    // An emptied field removes the hover text: null, so nothing is written.
    const attrs = { href, title: title.trim() || null };

    // Read fresh selection state from the editor - the component-body
    // `from`/`to` can go stale if ProseMirror processes transactions
    // while the sheet is open (e.g. after a previous link insertion).
    // Fix: GitHub #77
    if (isPictureSelection(editor.state.selection)) {
      editor
        .chain()
        .focus()
        .updateAttributes('image', { linkHref: href, linkTitle: attrs.title })
        .run();
      onClose();
      return;
    }

    const { from: curFrom, to: curTo } = editor.state.selection;
    const curHasSelection = curFrom !== curTo;
    const inLink = editor.isActive('link');

    if (!curHasSelection && !inLink && linkText) {
      // No selection, not on a link, but user typed link text - insert both.
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: linkText,
          marks: [{ type: 'link', attrs }],
        })
        .run();
    } else if (!curHasSelection && !inLink) {
      // No selection, no link text - insert the URL as both text and link.
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: href,
          marks: [{ type: 'link', attrs }],
        })
        .run();
    } else if (inLink && linkText && linkText !== existingText) {
      // Renaming a link. The mark's whole range goes, because the words in
      // the field are that range. Formatting inside the old words goes with
      // it: a link is one run of text again, which is what renaming one
      // means. Everything else keeps the run and only re-points it.
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .insertContent({
          type: 'text',
          text: linkText,
          marks: [{ type: 'link', attrs }],
        })
        .run();
    } else {
      // Has selection or cursor is inside an existing link - wrap / update.
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .setLink(attrs)
        .run();
    }
    onClose();
  }

  function remove() {
    if (isPictureSelection(editor.state.selection)) {
      editor.chain().focus().updateAttributes('image', { linkHref: null, linkTitle: null }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    onClose();
  }

  const hasSelection = from !== to;
  const isEditing = !!existingHref;

  const dialogTitle = isEditing ? t('editor:link.menuEdit') : t('editor:toolbar.addLink');

  // Shared form content - used in both mobile and desktop layouts.
  const form = (
    <>
      <TextField
        ref={urlRef}
        type="url"
        inputMode="url"
        autoComplete="off"
        {...NO_TEXT_ASSIST}
        label={t('link.urlLabel')}
        placeholder={t('link.urlPlaceholder')}
        error={urlError || undefined}
        value={url}
        onChange={(e) => { setUrl(e.target.value); if (urlError) setUrlError(''); }}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return;
          if (e.key === 'Enter') { e.preventDefault(); apply(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
      />

      {!isImage && (
        <div className="mt-3">
          <TextField
            type="text"
            autoComplete="off"
            label={t('link.textLabel')}
            placeholder={hasSelection ? '' : t('link.textPlaceholder')}
            hint={hasSelection && !isEditing ? t('link.selectedTextHint') : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') { e.preventDefault(); apply(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            }}
            disabled={hasSelection && !isEditing}
          />
        </div>
      )}

      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setTitleOpen((o) => !o)}
        aria-expanded={titleOpen}
        className="mt-3 flex items-center gap-1 text-meta font-medium text-pn-muted hover:text-pn"
      >
        {titleOpen ? <CaretDown aria-hidden="true" /> : <CaretRight aria-hidden="true" className="rtl:-scale-x-100" />}
        {t('link.titleLabel')}
      </button>
      {titleOpen && (
        <div className="mt-1">
          <TextField
            autoComplete="off"
            autoFocus={!existingTitle}
            aria-label={t('link.titleLabel')}
            hint={t('link.titleHint')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') { e.preventDefault(); apply(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        {isEditing && (
          <Button
            action="remove"
            variant="danger"
            onMouseDown={(e) => e.preventDefault()}
            onClick={remove}
          />
        )}
        <div className="flex-1" />
        <Button
          action="cancel"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
        />
        <Button
          action="apply"
          onMouseDown={(e) => e.preventDefault()}
          onClick={apply}
          disabled={!url.trim()}
        >
          {isEditing ? t('link.update') : t('link.apply')}
        </Button>
      </div>
    </>
  );

  if (isMobile) {
    // Bottom sheet. With no keyboard it sits on the viewport bottom. iOS draws
    // the keyboard over the page instead of shrinking it, so while one is up
    // the sheet's bottom edge goes to the top of the keyboard (GitHub #695).
    return (
      <>
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/30 dark:bg-black/50 z-50"
          onClick={onClose}
        />
        {/* Sheet */}
        <div
          ref={sheetRef}
          className={`fixed bottom-0 inset-x-0 z-50 bg-surface-2 border-t border-divider rounded-t-xl px-4 pt-3 ${
            keyboard ? 'pb-4 overflow-y-auto' : 'pb-[max(1rem,var(--pn-safe-bottom))]'
          }`}
          style={keyboard ? {
            top: keyboard.top + keyboard.height,
            bottom: 'auto',
            transform: 'translateY(-100%)',
            maxHeight: keyboard.height,
          } : undefined}
          role="dialog"
          aria-label={dialogTitle}
        >
          {/* Handle */}
          <div className="w-8 h-1 bg-pn-muted/35 rounded-full mx-auto mb-4" />
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-title font-semibold text-pn">{dialogTitle}</h3>
            <CloseButton onClick={onClose} className="-me-2" />
          </div>
          {form}
        </div>
      </>
    );
  }

  // Desktop - panel anchored under the link button via canonical Popover.
  return (
    <Popover
      open
      anchorRef={anchorRef}
      onClose={onClose}
      title={dialogTitle}
      className="w-80 p-4"
    >
      {form}
    </Popover>
  );
}
