import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useTheme } from './theme';
import { registerEditorCommand } from './editorCommands';
import { formatInstant } from './intlFormat';
import { APP_KEYS, matchesKey } from './shortcutMatch';
import { isImeComposing } from './imeComposing';
import { proUnlocked } from './demo';
import { SourceSearchBar } from './SourceSearchBar';
import { replaceAllText, type TextMatch } from './markdownSourceSearch';
import { MarkdownSourceBar } from './MarkdownSourceBar';
import type { SourcePreviewControls } from './sourcePreviewButtons';
import { applySourceAction, type SourceAction } from './markdownSourceFormat';
import { sourceFoldSummary } from './markdownSourceFolds';
import { suppressSoftKeyboard } from './softKeyboard';
import { EditorSlotPill } from './EditorSlotPill';
import { useCopyToClipboard } from './clipboard';
import { Check, Copy } from './icons';
import { useLineNumbersPref } from './editorPrefs';
import { useIsPhoneLayout } from './useIsMobile';
import { lineGutter } from './lineNumbers';

type Props = {
  /** Initial markdown content. Only read on mount - use a `key` prop to force reload. */
  value: string;
  /** Called with the latest markdown on every keystroke. */
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  /** Spell check is off for this note. It only takes the device switch away.
   *  Spec: docs/internal/specs/note-spell-check.md */
  noSpellcheck?: boolean;
  /** Turns on find (free) and replace (Pro) for this view, with the keys and
   *  the command entries the rich editor has. */
  search?: { isPro: boolean; onOpenUpgrade?: (trigger: 'replace') => void };
  /** The Markdown toolbar. `slot` is the pane's row under the note when the
   *  bar sits at the bottom; nothing is drawn there until it exists. */
  toolbar?: {
    onShowFormatted: () => void;
    atBottom: boolean;
    slot: HTMLElement | null;
    mobileTabIndex?: number;
    /** The bar's preview and swap buttons; absent on a phone. */
    preview?: SourcePreviewControls;
  };
  /** The formatted preview beside the text, given the text as typed and,
   *  unless read only, `edit`, which replaces the text with an edit made in
   *  the preview. The bar spans both columns.
   *  Spec: docs/internal/specs/heading-folds-and-source-preview.md (Part 2) */
  preview?: (text: string, caretLine: number | null, edit: ((markdown: string) => void) | undefined) => ReactNode;
  /** Focuses the text, so Tab from the tag field lands in the body here too. */
  ref?: Ref<MarkdownSourceHandle>;
  /** The other side of two items side by side: it takes no keys and
   *  registers no commands, so they reach the focused side only.
   *  Spec: docs/internal/specs/side-by-side-notes.md (section 6) */
  idle?: boolean;
};

export type MarkdownSourceHandle = { focus: () => boolean };

/**
 * Plain markdown source editor: a textarea bound to the note body.
 *
 * The body is already stored as markdown (Editor.tsx parses markdown in
 * and serializes markdown out via tiptap-markdown), so this shares the
 * exact same value/onChange contract and the same save + sync path. No
 * serialization, no schema change.
 *
 * Deliberately boring - no note-link autocomplete, no image paste. It is the
 * reliable fallback when the rich editor misbehaves, and the source view for
 * people who prefer raw markdown. With `toolbar` it has a fixed bar whose
 * buttons write the Markdown characters into the text. With `search` it has
 * the find and replace bars, which see the raw text: a code block's
 * language, a link's address, the markup itself (GitHub #455).
 *
 * Uncontrolled (defaultValue + key), mirroring Editor, so typing never
 * round-trips through parent state.
 *
 * Spec: docs/internal/specs/editor-mode-toggle.md (no custom Tab-key handling in v1, deliberately)
 */
export function MarkdownSourceEditor({ value, onChange, readOnly = false, noSpellcheck = false, search, toolbar, preview, ref: handleRef, idle = false }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(handleRef, () => ({
    focus: () => {
      ref.current?.focus();
      return !!ref.current;
    },
  }), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const spellcheck = useTheme().spellcheck && !noSpellcheck;
  const [text, setText] = useState(value);
  const { t } = useTranslation('editor');
  const { copy: copyText, copied } = useCopyToClipboard();
  // Line numbers (lineNumbers.ts), not in the phone layout. `caret` is the
  // first and last line of the selection, whose numbers take the accent.
  const lineNumbersOn = useLineNumbersPref();
  const phoneLayout = useIsPhoneLayout();
  const numbered = lineNumbersOn && !phoneLayout;
  const [caret, setCaret] = useState<{ from: number; to: number; known: boolean }>({ from: -1, to: -1, known: false });
  useEffect(() => {
    if (!numbered && !preview) return;
    const read = () => {
      const el = ref.current;
      if (!el || document.activeElement !== el) return;
      const lineAt = (at: number) => {
        let n = 0;
        for (let i = el.value.indexOf('\n'); i !== -1 && i < at; i = el.value.indexOf('\n', i + 1)) n++;
        return n;
      };
      const from = lineAt(el.selectionStart);
      const to = el.selectionEnd === el.selectionStart ? from : lineAt(el.selectionEnd);
      setCaret((c) => (c.from === from && c.to === to && c.known ? c : { from, to, known: true }));
    };
    document.addEventListener('selectionchange', read);
    const el = ref.current;
    el?.addEventListener('input', read);
    return () => {
      document.removeEventListener('selectionchange', read);
      el?.removeEventListener('input', read);
    };
  }, [numbered, preview]);

  function change(markdown: string) {
    onChange(markdown);
    setText(markdown);
  }

  /** An edit made in the split view's preview, as Markdown. The field is
   *  uncontrolled, so its value is set here too; it does not hold the caret,
   *  and the preview keeps its own undo for the edit. */
  function fromPreview(markdown: string) {
    const el = ref.current;
    if (!el || el.value === markdown) return;
    el.value = markdown;
    change(markdown);
  }

  /** Writes `insert` over [from, to) through the same change as typing, so the
   *  field's own undo takes it back in one step, and gives focus back to
   *  whatever held it. */
  function writeRange(from: number, to: number, insert: string) {
    const el = ref.current;
    if (!el) return;
    const back = document.activeElement as HTMLElement | null;
    el.focus();
    el.setSelectionRange(from, to);
    if (!document.execCommand?.('insertText', false, insert)) {
      el.setRangeText(insert, from, to, 'end');
      change(el.value);
    }
    if (back && back !== el) back.focus();
  }

  /** The date, or the date and time, at the caret, through the same change as
   *  typing. insertText keeps the field's own undo, which the tag row's undo
   *  drives; setRangeText is the way where the browser has no insertText. */
  function insertDate(style: 'date' | 'dateTime') {
    const el = ref.current;
    if (!el) return;
    const text = formatInstant(new Date(), style);
    el.focus();
    if (document.execCommand?.('insertText', false, text)) return;
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    change(el.value);
  }

  /** A toolbar press: one replacement through the same change as typing, so
   *  one undo takes it back, then the selection the action leaves. */
  function format(action: SourceAction) {
    const el = ref.current;
    if (!el || readOnly) return;
    const untyped = applySourceAction(el, action);
    if (untyped !== null) change(untyped);
  }

  // The find bar pins under the toolbar, as the rich editor's does.
  const sourceBarRef = useRef<HTMLDivElement>(null);
  const showBar = !!toolbar && !readOnly;
  const barAtTop = showBar && !toolbar.atBottom;
  useEffect(() => {
    const root = rootRef.current;
    const el = sourceBarRef.current;
    if (!root) return;
    if (!barAtTop || !el) {
      root.style.setProperty('--pn-editor-toolbar-h', '0px');
      return;
    }
    const apply = () => root.style.setProperty('--pn-editor-toolbar-h', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [barAtTop]);

  const [bar, setBar] = useState<'none' | 'find' | 'replace'>('none');
  const barRef = useRef(bar);
  barRef.current = bar;
  const [barFocusTick, setBarFocusTick] = useState(0);
  const [barSeed, setBarSeed] = useState('');
  const [hits, setHits] = useState<{ matches: TextMatch[]; active: number }>({ matches: [], active: -1 });
  const onHits = useCallback((matches: TextMatch[], active: number) => setHits({ matches, active }), []);

  const openBar = (next: 'find' | 'replace') => {
    const el = ref.current;
    const sel = el ? el.value.slice(el.selectionStart, el.selectionEnd).trim() : '';
    if (barRef.current === 'none') setBarSeed(sel && sel.length <= 80 && !sel.includes('\n') ? sel : '');
    setBar(next);
    setBarFocusTick((n) => n + 1);
  };

  /** Back to the text with the active match selected, the way the rich bar
   *  leaves the caret on it. */
  const closeBar = () => {
    const el = ref.current;
    const m = hits.matches[hits.active];
    setBar('none');
    if (!el) return;
    el.focus();
    if (m) el.setSelectionRange(m.from, m.to);
  };

  // Replace is the Pro half of search, gated here for the key and the "..."
  // row alike, as useEditorPanels gates the rich editor's.
  // Spec: docs/internal/pro-features.md (Find and replace)
  const toggleReplace = () => {
    if (!search || readOnly) return;
    if (barRef.current === 'replace') return closeBar();
    if (!proUnlocked(search.isPro)) return search.onOpenUpgrade?.('replace');
    openBar('replace');
  };
  const toggleFind = () => {
    if (barRef.current === 'find') closeBar();
    else openBar('find');
  };
  const togglesRef = useRef({ toggleFind, toggleReplace });
  togglesRef.current = { toggleFind, toggleReplace };

  const hasSearch = !!search && !idle;
  useEffect(() => {
    if (!hasSearch) return;
    const off = [
      registerEditorCommand('find', () => togglesRef.current.toggleFind()),
      ...(readOnly ? [] : [registerEditorCommand('findReplace', () => togglesRef.current.toggleReplace())]),
    ];
    return () => off.forEach((f) => f());
  }, [hasSearch, readOnly]);

  // The same keys as the rich editor's (useEditorPanels.ts): capture phase on
  // the document, standing down in a field that is not this view's, and
  // keeping Escape from the global cascade while a bar is open.
  useEffect(() => {
    if (!hasSearch) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return;
      const ae = document.activeElement as HTMLElement | null;
      const ours = !!ae && !!rootRef.current?.contains(ae);
      const inForeignField = !!ae && /^(input|textarea)$/i.test(ae.tagName) && !ours;
      if (e.key === 'Escape') {
        if (barRef.current !== 'none' && !inForeignField) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const isReplace = matchesKey(e, APP_KEYS.findReplace);
      if (!isReplace && !matchesKey(e, APP_KEYS.find)) return;
      if (inForeignField) return;
      e.preventDefault();
      if (isReplace) togglesRef.current.toggleReplace();
      else togglesRef.current.toggleFind();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [hasSearch]);

  useEffect(() => {
    if (readOnly) setBar((b) => (b === 'replace' ? 'none' : b));
  }, [readOnly]);

  // Scroll the active match into view as the bar steps or the query changes,
  // not while the reader types in the note under an open bar.
  useEffect(() => {
    if (hits.active < 0 || document.activeElement === ref.current) return;
    rootRef.current?.querySelector('[data-pn-hit-current]')?.scrollIntoView({ block: 'center' });
  }, [hits]);

  // The rich editor is not mounted in this view, so the field registers the
  // date inserts and takes their keys itself.
  const insertRef = useRef(insertDate);
  insertRef.current = insertDate;
  useEffect(() => {
    if (readOnly || idle) return;
    const off = [
      registerEditorCommand('insertDate', () => insertRef.current('date')),
      registerEditorCommand('insertDateTime', () => insertRef.current('dateTime')),
    ];
    return () => off.forEach((f) => f());
  }, [readOnly, idle]);

  const textarea = (
    <textarea
      ref={ref}
      // The tag row's undo/redo drive the native undo stack of whichever
      // textarea holds focus, and reach for this one by name when nothing
      // does. See handleHistory in NotesView.tsx.
      data-pn-source
      defaultValue={value}
      readOnly={readOnly}
      // Only the off state is written (design-decisions, "Spell check is
      // the engine's, not ours").
      spellCheck={spellcheck ? undefined : false}
      onChange={(e) => change(e.target.value)}
      // The copy below gives the height, so the field never needs to scroll.
      // A caret moved into view in the frame before the copy catches up can
      // still scroll a field with overflow hidden; that would slide the text
      // off its marks.
      onScroll={(e) => {
        e.currentTarget.scrollTop = 0;
      }}
      onKeyDown={(e) => {
        if (readOnly) return;
        const key = e.nativeEvent;
        const style = matchesKey(key, APP_KEYS.insertDate) ? 'date' : matchesKey(key, APP_KEYS.insertDateTime) ? 'dateTime' : null;
        if (!style) return;
        e.preventDefault();
        insertDate(style);
      }}
      // Tracks the Text size setting like the rich editor does, from the
      // same --pn-text-scale knob. Its own 14px base is kept (monospace
      // runs visually larger than the prose face at the same size).
      style={{ fontSize: 'calc(14px * var(--pn-text-scale))' }}
      className="pn-source-field relative w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-mono leading-relaxed text-pn outline-none [grid-area:1/1]"
    />
  );

  /** The field's own undo history, as the tag row's pair drives it
   *  (handleHistory in NotesView.tsx): a touch keyboard stays down. */
  const history = (action: 'undo' | 'redo') => {
    const el = ref.current;
    if (!el) return;
    suppressSoftKeyboard(el);
    el.focus();
    document.execCommand(action);
  };
  // Counted per change of the text, for the Collapse all / Expand all label.
  const folds = useMemo(() => (showBar ? sourceFoldSummary(text) : { foldable: 0, open: 0 }), [showBar, text]);

  const sourceBar = showBar ? (
    <MarkdownSourceBar
      onAction={format}
      onInsertDate={insertDate}
      onHistory={history}
      folds={folds}
      onHideKeyboard={() => ref.current?.blur()}
      onShowFormatted={toolbar.onShowFormatted}
      rootRef={barAtTop ? sourceBarRef : undefined}
      atBottom={toolbar.atBottom}
      mobileTabIndex={toolbar.mobileTabIndex}
      preview={toolbar.preview}
    />
  ) : null;

  // A copy of the text sits under the transparent textarea in the same grid
  // cell, with the same font, size, width and wrapping. It gives the cell its
  // height, so the field grows to its text and the note scrolls in the editor
  // pane, at every width, text size and font, with nothing to measure. Nothing
  // collapses the field, so the pane never loses its scroll position while
  // typing (GitHub #469). The find matches are painted as marks in this copy,
  // so each one sits exactly under its characters: a textarea has no
  // highlight of its own. The zero-width space gives a final newline the
  // empty line the textarea shows for it.
  // With line numbers, the copy draws each line as its own row, so each
  // row's number (a CSS counter, index.css `.pn-source-lines`) sits level
  // with the row's first wrap. A row wraps exactly as the same text in one
  // block does: a newline in pre-wrap is a forced break.
  const segments: Array<{ s: string; hit?: boolean; current?: boolean }> = [];
  if (search && bar !== 'none' && hits.matches.length > 0) {
    let at = 0;
    hits.matches.forEach((m, i) => {
      segments.push({ s: text.slice(at, m.from) });
      segments.push({ s: text.slice(m.from, m.to), hit: true, current: i === hits.active });
      at = m.to;
    });
    segments.push({ s: text.slice(at) });
  } else {
    segments.push({ s: text });
  }
  const drawSegment = (seg: { s: string; hit?: boolean; current?: boolean }, key: string) => (seg.hit ? (
    <mark
      key={key}
      className={seg.current ? 'pn-search-hit pn-search-hit-current' : 'pn-search-hit'}
      {...(seg.current ? { 'data-pn-hit-current': '' } : {})}
    >
      {seg.s}
    </mark>
  ) : seg.s);
  let copy: ReactNode;
  if (numbered) {
    const rows: ReactNode[][] = [[]];
    segments.forEach((seg, n) => {
      seg.s.split('\n').forEach((part, p) => {
        if (p > 0) rows.push([]);
        if (part) rows[rows.length - 1]!.push(drawSegment({ ...seg, s: part }, `${n}.${p}`));
      });
    });
    copy = rows.map((row, i) => (
      <div key={i} {...(i >= caret.from && i <= caret.to ? { 'data-active': '' } : {})}>
        {row}
        {'\u200b'}
      </div>
    ));
  } else {
    copy = segments.map((seg, n) => drawSegment(seg, String(n)));
  }
  const marks = (
    <div
      aria-hidden="true"
      inert
      style={{ fontSize: 'calc(14px * var(--pn-text-scale))' }}
      className={`pn-source-marks pointer-events-none whitespace-pre-wrap break-words font-mono leading-relaxed text-transparent [grid-area:1/1]${numbered ? ' pn-source-lines' : ''}`}
    >
      {copy}
      {numbered ? null : '\u200b'}
    </div>
  );

  // The text keeps a gap under whatever sits above it, the toolbar or, with
  // the bar hidden or at the bottom, the sticky tag row.
  // min-h-[60vh] on the text's grid matches `.ProseMirror` in index.css so
  // toggling modes does not jump the page height.
  // The gap clears the copy pill (SLOT_PILL_HEIGHT plus 8px), so the first
  // line starts under it: a textarea cannot wrap beside a float the way the
  // rich editor's text does. It stays when the pill hides, so typing into an
  // empty note or opening find moves nothing.
  // The find bar takes the rich editor's slot: a zero-height sticky row
  // pinned under the toolbar, floating over the text.
  // With the preview, the text and its pills keep the left column and the
  // preview takes the right one; the bar above spans both.
  const field = (
    <>
      {/* The whole note as Markdown, for a chat or an email (#744). It has
          the rich editor's top-right slot to itself and gives it to the find
          bar while that is open. */}
      {bar === 'none' && text.trim() !== '' && (
        <div
          className="sticky z-[5] flex h-0 items-start justify-end overflow-visible pointer-events-none"
          style={{ top: 'calc(var(--pn-tagrow-h, 0px) + var(--pn-editor-toolbar-h, 0px))' }}
        >
          <EditorSlotPill
            label={copied ? t('auth:createPhrase.copied') : t('bodyMenu.copyAsMarkdown')}
            onClick={() => copyText(ref.current?.value ?? text, 'note')}
            tabIndex={toolbar?.mobileTabIndex}
          >
            {copied ? <Check /> : <Copy />}
          </EditorSlotPill>
        </div>
      )}
      {search && bar !== 'none' && (
        <div
          className="sticky z-[5] flex h-0 items-start justify-end overflow-visible pointer-events-none"
          style={{ top: 'calc(var(--pn-tagrow-h, 0px) + var(--pn-editor-toolbar-h, 0px))' }}
        >
          <SourceSearchBar
            mode={bar}
            text={text}
            focusTick={barFocusTick}
            initialQuery={barSeed}
            onHits={onHits}
            onReplaceOne={(m, replacement) => writeRange(m.from, m.to, replacement)}
            onReplaceAll={(matches, replacement) => {
              const first = matches[0]!.from;
              const last = matches[matches.length - 1]!.to;
              const next = replaceAllText(text, matches, replacement);
              writeRange(first, last, next.slice(first, next.length - (text.length - last)));
            }}
            onSwap={readOnly ? undefined : () => (bar === 'find' ? toggleReplace() : openBar('find'))}
            swapPro={!search?.isPro}
            onClose={closeBar}
          />
        </div>
      )}
      <div
        className="relative mt-11 grid min-h-[60vh]"
        style={numbered ? { paddingInlineStart: lineGutter(text.split('\n').length, 12) } : undefined}
      >
        {marks}
        {textarea}
      </div>
    </>
  );
  return (
    <div ref={rootRef} className={preview ? 'flex flex-1 flex-col' : undefined}>
      {/* The bar pins itself under the tag row (ToolbarFrame). */}
      {barAtTop && sourceBar}
      {showBar && toolbar.atBottom && toolbar.slot && createPortal(sourceBar, toolbar.slot)}
      {preview ? (
        <div className="grid flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-6">
          <div className="min-w-0">{field}</div>
          {preview(text, numbered && caret.known ? caret.from : null, readOnly ? undefined : fromPreview)}
        </div>
      ) : field}
    </div>
  );
}
