import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type MutableRefObject,
  type ReactElement,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  TextB as BoldIcon,
  TextItalic as ItalicIcon,
  TextUnderline as UnderlineIcon,
  TextStrikethrough as StrikethroughIcon,
  TextAUnderline as TextColorIcon,
  TextH,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextHFour,
  TextHFive,
  TextHSix,
  TextT as FontIcon,
  CaretDown as ChevronDownIcon,
  ListChecks as ListChecksIcon,
  Link as LinkIcon,
  BracketsSquare as BracketsIcon,
  Highlighter as HighlighterIcon,
  TextAlignLeft as TextAlignLeftIcon,
  TextAlignCenter as TextAlignCenterIcon,
  TextAlignRight as TextAlignRightIcon,
  TextAlignJustify as TextAlignJustifyIcon,
  Megaphone as MegaphoneIcon,
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
} from './icons';
import { useEditorState, type Editor as TipTapEditor } from '@tiptap/react';
import { triggerAttachmentUpload } from './EncryptedAttachment';
import { insertFootnote } from './footnotes';
import { foldSummary, setAllFolded } from './foldAll';
import type { Icon } from './icons';
import { copySelectionAs } from './clipboardSpacing';
import { openPicturePicker } from './mediaRefs';
import { HoverLabel } from './HoverLabel';
import { AudioRecorder, type AudioRecordingState } from './AudioRecorder';
import { isLinuxNative } from './devices';
import { TEXT_COLORS, HIGHLIGHT_COLORS, DEFAULT_HIGHLIGHT } from './editorColors';
import { isSoftKeyboardDevice, suppressSoftKeyboard } from './softKeyboard';
import { readColorPref } from './editorPrefs';
import { toggleCodeBlockSmart, ALIGNMENT_VALUES, COPY_BOX_LANGUAGE } from './editorExtensions';
import { bindingKeyText, keyText } from './shortcutMatch';
import { insertDateText } from './editorCommands';
import { insertKanbanBoard } from './KanbanBoard';
import { LocationPanel } from './notesView/NoteLocationChip';
import { Popover, Snackbar } from './ui';
import { PlaceMapNode } from './PlaceMapNode';
import type { NoteLocation } from './noteLocation';
import { FormatBarContext } from './formatBarContext';
import { barForWidth, formatBarItem, isSeparatorKey } from './formatBar';
import { FORMAT_BAR_HINT, FORMAT_BAR_LOOK } from './formatBarItems';
import { ToolbarFrame } from './ToolbarFrame';
import { sourcePreviewButtons, sourcePreviewMenuItems, type SourcePreviewControls } from './sourcePreviewButtons';
import { pluginsShown } from './onDeviceAi';
import { detectPlatform } from './devices';
import { pluginFlagOn } from './plugins/pluginState';
import { editorNote, openPluginSheet } from './plugins/pluginDoors';
import { insertTextAfter, insertTextAt } from './plugins/insertText';
import { isTouchOnly } from './touchOnly';
import { indentListItem, indentText } from './editorIndent';

const AttachIcon = FORMAT_BAR_LOOK.attachMenu!.Icon;
import { useIsMobile, useIsTouchDevice } from './useIsMobile';
import { useToolbarFit } from './useToolbarFit';
import {
  ColorBar,
  TB_BTN_ACTIVE,
  TB_BTN_BASE,
  TB_BTN_REST,
  TB_CARET,
  TB_ICON,
  TB_SPLIT_CARET,
  TB_SPLIT_MAIN,
  ToolbarBtn,
  endComposition,
  normalizeCssColor,
  runOnCaretWord,
  useToolbarPopover,
} from './editorToolbarParts';
import { AlignPanel, CalloutPanel, FontPanel, HeadingPanel, HighlightPanel, TextColorPanel } from './editorToolbarPopovers';
import { insertInlineIcon } from './editorIcon';

const LookPicker = lazy(() => import('./looks/LookPicker').then((m) => ({ default: m.LookPicker })));
const ScanEditor = lazy(() => import('./scan/ScanEditor').then((m) => ({ default: m.ScanEditor })));

// ------------------------------------------------------------------
// Toolbar
// ------------------------------------------------------------------

type ToolbarProps = {
  editor: TipTapEditor | null;
  /** The note's own place: Insert > Location opens prefilled with it. */
  place?: NoteLocation;
  /** Pass -1 on mobile to remove toolbar buttons from iOS form-assistant chain. */
  mobileTabIndex?: number;
  /** Opens the URL link popover (chain icon / Cmd+K). */
  onOpenLinkPopover: () => void;
  /**
   * Anchor for that popover. The link button is the only toolbar control a
   * popover outside this file has to line up with, so the ref comes in rather
   * than the panel guessing at a position.
   */
  linkBtnRef?: RefObject<HTMLButtonElement | null>;
  onAudioStateChange?: (state: AudioRecordingState, duration: number) => void;
  /**
   * Hides the image / attachment / audio group.
   *
   * Those three write an ENCRYPTED blob and insert a `pn:img/` or `pn:file/`
   * reference, which is correct for a note and meaningless inside somebody's
   * Markdown folder - the file would be unreadable in Obsidian, in git, and in
   * the folder itself. The Markdown pillar writes real files next to the note
   * instead, so it turns this group off rather than letting it corrupt a vault.
   * Spec: docs/internal/specs/markdown-folder.md (section 8, media)
   */
  hideEncryptedMedia?: boolean;
  /**
   * Where the picture and file buttons hand their files when the encrypted
   * group is hidden. The Markdown pillar writes them as real files next to
   * the note; without this prop the two buttons stay hidden too. The
   * recorder and "from Files" stay hidden either way: both only exist as
   * encrypted blobs.
   */
  onInsertFiles?: (files: File[]) => void;
  /** Ref that gets set to the stop function when recording starts. */
  audioStopRef?: MutableRefObject<(() => void) | null>;
  /** Switches the note to its Markdown view; absent where the note has none. */
  onShowMarkdown?: () => void;
  /** The Split view item (Settings > Toolbar): it opens the Markdown view
   *  with its preview. Absent in the phone layout and where the note has no
   *  Markdown view. */
  sourcePreview?: SourcePreviewControls;
};

// The heading button's glyph for the level the caret is in, 0 for body text.
const HEADING_ICONS = [TextH, TextHOne, TextHTwo, TextHThree, TextHFour, TextHFive, TextHSix] as const;

export function Toolbar({ editor, place, mobileTabIndex, onOpenLinkPopover, linkBtnRef, onAudioStateChange, audioStopRef, hideEncryptedMedia = false, onInsertFiles, onShowMarkdown, sourcePreview }: ToolbarProps) {
  const { t } = useTranslation('editor');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  // Scan a page: the photo, then the corner editor (scan/ScanEditor.tsx).
  // The result goes in where the cursor was when the scan began.
  // Spec: docs/internal/plans/plugins.md (section 6.3)
  const scanInputRef = useRef<HTMLInputElement>(null);
  // The iOS app scans with Apple's document camera (VisionKit), whose page
  // comes back flat as JPEG bytes; elsewhere a photo goes to our corner
  // editor. A device with no camera (the Simulator) falls back to the photo.
  // The camera cannot be held to one page and a scan keeps one (D11), so the
  // count of pages it took says when the rest were left out (beta #242 item 4).
  const startScan = () => {
    if (detectPlatform() !== 'ios') {
      scanInputRef.current?.click();
      return;
    }
    void import('./plugins/appleEngines')
      .then((m) => m.appleScanPages())
      .then((answer) => {
        if (answer) setScan({ file: new File([answer.jpeg.slice()], 'scan.jpg', { type: 'image/jpeg' }), pos: scanPos.current, flat: true, pages: answer.pages });
      })
      .catch(() => scanInputRef.current?.click());
  };
  const [scan, setScan] = useState<{ file: File; pos: number; flat?: boolean; pages?: number } | null>(null);
  // "Only the first page was added", for a few seconds after the page goes in.
  const [firstPageOnly, setFirstPageOnly] = useState(false);
  useEffect(() => {
    if (!firstPageOnly) return;
    const timer = setTimeout(() => setFirstPageOnly(false), 6000);
    return () => clearTimeout(timer);
  }, [firstPageOnly]);
  const scanPos = useRef(0);
  // The person's arrangement of the bar and the + menu, and the gear's door
  // to Settings > Toolbar. Spec: docs/internal/specs/format-bar.md
  const { layout: arranged, onCustomize, position } = useContext(FormatBarContext);
  // A touch screen gets one strip that scrolls sideways; a pointer gets the
  // measured row with the ••• overflow. The swipe decides it, not the width.
  const strip = useIsTouchDevice();
  // A narrow window keeps the gear at the end of the row (barForWidth).
  const wide = !useIsMobile();
  const layout = barForWidth(arranged, wide);
  // The person can put the bar at the bottom of the note (section 7 of the
  // plan): the last item of the editor's column, sticky to the bottom of the
  // scroll view, and on a phone above the keyboard. Its labels then open
  // above it, and the ••• row opens above the main row.
  // bottom-[-0.5rem] reaches past the note view's 0.5rem bottom padding, so no
  // text scrolls into a gap under the bar.
  const atBottom = position === 'bottom';
  const tipSide = atBottom ? 'above' : 'below';
  const [recording, setRecording] = useState(false);

  /**
   * Subscribe the toolbar to the editor state it displays.
   *
   * TipTap 3's `useEditor` defaults `shouldRerenderOnTransaction` to FALSE, so
   * nothing re-renders this component when the caret moves. Every `isActive()`
   * below was therefore computed on the last unrelated React render and then
   * went stale - buttons only caught up when some other state (a popover
   * opening, the overflow row measuring) happened to re-render the tree. It
   * looked worst on alignment, because that is a block property that changes
   * simply by arrowing into a different paragraph, but bold, headings, lists
   * and the rest were all equally stale.
   *
   * Deliberately NOT `shouldRerenderOnTransaction: true` on `useEditor`: that
   * re-renders the whole Editor - EditorContent, node views and all - on every
   * keystroke. Subscribing just this component, with a selector, keeps the
   * re-render scoped to the toolbar AND skips it entirely while the states are
   * unchanged (useEditorState compares with deepEqual by default), so ordinary
   * typing inside one paragraph costs nothing.
   */
  useEditorState({
    editor,
    selector: ({ editor: e }) => !e ? null : ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      codeBlock: e.isActive('codeBlock'),
      highlight: e.isActive('highlight'),
      link: e.isActive('link'),
      superscript: e.isActive('superscript'),
      subscript: e.isActive('subscript'),
      spoiler: e.isActive('spoiler'),
      blockquote: e.isActive('blockquote'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      taskList: e.isActive('taskList'),
      table: e.isActive('table'),
      callout: e.isActive('callout'),
      heading: e.isActive('heading') ? (e.getAttributes('heading').level ?? 0) : 0,
      // The three attribute-driven controls. textAlign is why this exists.
      textAlign: ALIGNMENT_VALUES.find((v) => e.isActive({ textAlign: v })) ?? null,
      fontFamily: e.getAttributes('textStyle').fontFamily ?? null,
      fontSize: e.getAttributes('textStyle').fontSize ?? null,
      color: e.getAttributes('textStyle').color ?? null,
      highlightColor: e.getAttributes('highlight').color ?? null,
      // Collapse all / Expand all: its label, and whether it does anything.
      foldable: foldSummary(e.state).foldable,
      foldOpen: foldSummary(e.state).open,
    }),
  });

  const handleImagePick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length || !editor) return;
    // Never the encrypted upload where that store is off limits.
    if (hideEncryptedMedia) {
      onInsertFiles?.(Array.from(files));
      e.target.value = '';
      return;
    }
    // On mobile, file.type is often empty even for valid images picked
    // from the gallery. Since the input already has accept="image/*",
    // trust that the OS only offered image files - don't filter on MIME.
    const pos = editor.state.selection.from;
    const view = editor.view;
    for (const file of Array.from(files)) {
      import('./EncryptedImage').then(({ triggerImageUpload }) => {
        void triggerImageUpload(file, view, pos);
      });
    }
    // Reset so the same file can be picked again.
    e.target.value = '';
  }, [editor, hideEncryptedMedia, onInsertFiles]);

  const handleAttachmentPick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length || !editor) return;
    if (hideEncryptedMedia) {
      onInsertFiles?.(Array.from(files));
      e.target.value = '';
      return;
    }
    const view = editor.view;
    // Everything from the attachment picker goes through the attachment
    // pipeline - even images. The dedicated image button exists for
    // inline image rendering. The paperclip always creates file chips.
    for (const file of Array.from(files)) {
      void triggerAttachmentUpload(file, view);
    }
    e.target.value = '';
  }, [editor, hideEncryptedMedia, onInsertFiles]);

  if (!editor) return null;

  const isActive = (name: string, attrs?: Record<string, unknown>) =>
    editor.isActive(name, attrs);

  /**
   * How a popover trigger in the row acts. Under a mouse it acts on
   * pointerdown, which keeps the outside-pointerdown close of the open
   * popover from fighting the toggle. In a touch strip a swipe can start on
   * any button, so the trigger acts on the click the browser fires after a
   * tap and never after a scroll; pointerdown still keeps the focus in the
   * note. A press on the open trigger lands inside its wrapper, so the
   * outside check lets it through and the click closes it.
   *
   * Android raises a closed keyboard for a tap that leaves a focused note
   * focused, and the page then shrinks under the popover the tap opened, so
   * the strip arms the keyboard guard as the tap starts (GitHub #490).
   *
   * Every press first ends a keyboard composition, so a command that
   * redraws the block never makes the keyboard type its word twice.
   */
  const press = (act: () => void) => strip
    ? {
        onPointerDown: (e: ReactPointerEvent) => {
          e.preventDefault();
          endComposition(editor);
          suppressSoftKeyboard(editor.view.dom);
        },
        onClick: act,
      }
    : { onPointerDown: (e: ReactPointerEvent) => { e.preventDefault(); endComposition(editor); act(); } };

  const { open: headingOpen, setOpen: setHeadingOpen, wrapRef: headingRef, btnRef: headingBtnRef, popoverRef: headingDropdownRef, pos: headingDropdownPos } =
    useToolbarPopover('button');

  // Text color swatch popover. Same portal + outside-click pattern as the
  // heading dropdown so it escapes the toolbar's overflow clipping.
  //
  // The wrapper is the popover's anchor rather than a button, because the
  // trigger is a two-part control: the popover lines up with the whole
  // thing, not with the caret half that opens it.
  const { open: colorOpen, setOpen: setColorOpen, wrapRef: colorWrapRef, popoverRef: colorPopoverRef, pos: colorPos } =
    useToolbarPopover('wrap');

  const currentColor = (editor.getAttributes('textStyle').color as string | undefined) || undefined;

  // The swatch picked here last, so the button's main half can apply it
  // again in one press. Held in React state beside localStorage so the
  // bar of the glyph repaints the moment a swatch is picked.
  const [textMemory, setTextMemory] = useState<string | null>(() => readColorPref('text'));
  const rememberedTextColor =
    TEXT_COLORS.find((c) => c.name.toLowerCase() === textMemory)?.value ?? null;

  // Highlight swatch popover. Twin of the text color one above, down to the
  // two-ref outside-click check, and it reuses the same `color.names.*`
  // strings - HIGHLIGHT_COLORS carries the same names.
  const { open: highlightOpen, setOpen: setHighlightOpen, wrapRef: highlightWrapRef, popoverRef: highlightPopoverRef, pos: highlightPos } =
    useToolbarPopover('wrap');

  // The color attribute is absent on a plain highlight, which is the
  // palette's first entry rather than "nothing selected" - so the two
  // states the swatches distinguish are (highlighted, which color) and
  // (not highlighted at all).
  const highlightOn = isActive('highlight');
  const currentHighlight = (editor.getAttributes('highlight').color as string | undefined) || undefined;

  // Twin of the text memory above, with one difference: this palette HAS a
  // default, so an untrained button still applies something on its first
  // press rather than falling through to the popover.
  const [highlightMemory, setHighlightMemory] = useState<string | null>(() => readColorPref('highlight'));
  const rememberedHighlight =
    HIGHLIGHT_COLORS.find((c) => c.name.toLowerCase() === highlightMemory) ?? DEFAULT_HIGHLIGHT;

  /**
   * Apply the remembered colour, or strip it when the run already carries
   * exactly that. The second half is what makes removal a single press;
   * a run in some OTHER colour is recoloured rather than cleared, because
   * that is what pressing a colour button asks for.
   */
  const applyRememberedTextColor = () => {
    // The text palette has no default entry the way the highlight one does:
    // unstyled body text is not a swatch. So an untrained button has nothing
    // to apply and opens the palette, which is all it ever did.
    if (!rememberedTextColor) {
      setColorOpen(true);
      return;
    }
    const same = normalizeCssColor(currentColor) === normalizeCssColor(rememberedTextColor);
    runOnCaretWord(editor, (chain) => (same ? chain.unsetColor() : chain.setColor(rememberedTextColor)));
  };

  const applyRememberedHighlight = () => {
    const same =
      highlightOn &&
      normalizeCssColor(currentHighlight) === normalizeCssColor(rememberedHighlight.value ?? undefined);
    // setHighlight MERGES onto an active mark, so the default entry has to
    // clear the old colour rather than omit one - the same trap the popover
    // swatches work around.
    runOnCaretWord(editor, (chain) => {
      if (same) return chain.unsetHighlight();
      return rememberedHighlight.value
        ? chain.setHighlight({ color: rememberedHighlight.value })
        : chain.unsetHighlight().setHighlight();
    });
  };

  // Font family + size share ONE popover and one toolbar button. Two reasons:
  // the format row is measured and clipped, so every button added pushes a
  // writing toggle into the ••• row; and the natural icon for a font-family
  // control is a letterform, which is already spoken for by the text-color
  // button (TextAa). One "Font" entry on TextT avoids both problems.
  const { open: fontOpen, setOpen: setFontOpen, wrapRef: fontWrapRef, btnRef: fontBtnRef, popoverRef: fontPopoverRef, pos: fontPos } =
    useToolbarPopover('button');

  // Undefined means the run carries no font attribute, the same
  // no-value-is-not-a-default distinction the alignment control makes.
  const currentFontFamily = (editor.getAttributes('textStyle').fontFamily as string | undefined) || undefined;
  const currentFontSize = (editor.getAttributes('textStyle').fontSize as string | undefined) || undefined;

  // Text alignment. A popover rather than four toolbar buttons: the format row
  // is already measured-and-clipped, and four more always-on buttons would push
  // the writing toggles people actually use into the ••• row. Same shape as the
  // color picker above it.
  const { open: alignOpen, setOpen: setAlignOpen, wrapRef: alignWrapRef, btnRef: alignBtnRef, popoverRef: alignPopoverRef, pos: alignPos } =
    useToolbarPopover('button');

  // The attach menu behind the paperclip: the picture, file and recording
  // items a person put there. Spec: docs/internal/issues/0534.md
  const { open: attachOpen, setOpen: setAttachOpen, wrapRef: attachWrapRef, btnRef: attachBtnRef, popoverRef: attachPopoverRef, pos: attachPos } =
    useToolbarPopover('button');
  // Starts a recording from the attach menu, where no recorder button shows.
  const audioStartRef = useRef<(() => void) | null>(null);

  // Callout type picker. Same portal + outside-click pattern as the color
  // swatch so it escapes the toolbar's overflow clipping.
  //
  // The trigger belongs in this row, inside calloutWrapRef and beside the panel
  // it opens. A popover whose trigger sits in a menu that closes on the same
  // pointerdown cannot survive its own opening press: the menu unmounts the
  // pressed row, the event reaches this listener carrying a target that is no
  // longer in the document, no wrapper contains it, and the check reads an
  // outside click. The link popover has the same requirement.
  const { open: calloutOpen, setOpen: setCalloutOpen, wrapRef: calloutWrapRef, btnRef: calloutBtnRef, popoverRef: calloutPopoverRef, pos: calloutPos } =
    useToolbarPopover('button');

  // Insert > Icons & logos: the look picker, whose pick goes into the text.
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);

  // Escape closes whichever popover is open. Six of the seven register
  // through useToolbarPopover; the '+' menu (ToolbarInsertMenu.tsx),
  // anchored to the whole right cluster, registers its own the same way.
  //
  // They each had an outside-pointerdown check and nothing else, so the one
  // key every other overlay in the app answers to did nothing here. The hook
  // is the documented route (ui-patterns.md): it keeps a LIFO stack and only
  // the topmost entry acts, and `enabled` gated on the open flag means a
  // CLOSED popover registers no listener at all - which is what keeps this
  // from touching any other Escape behaviour in the app.
  //
  // It also settles the one collision worth checking. useEditorPanels swallows
  // Escape while find-in-note is open, from a capture-phase listener on
  // `document`; this hook's is capture-phase on `window`, and capture runs
  // window before document, so an open popover wins and closes, and the find
  // bar stays up. With every popover closed the hook is not listening, so that
  // swallow and the global Esc cascade behave exactly as they did before.
  //
  // Registering also hands these popovers to the Android back button,
  // which walks the same stack via closeTopOverlay().

  // Row 1 shows as many buttons as fit; the rest wait behind the ••• in a
  // full-width row 2. On a touch screen it is one strip that scrolls.
  // Shared with the drawing canvas's toolbar (useToolbarFit.ts).
  const fitState = useToolbarFit(strip, `${layout.bar.join(',')}${sourcePreview ? '+preview' : ''}`);
  const rightClusterRef = fitState.clusterRef;

  // All six levels, menu and detection alike. The schema always allowed
  // every level (imports and ###### markdown produce H6) and detection
  // always read all six so the button never showed a bare "H"; the menu
  // stopped at 5 until the H1-H6 ladder in index.css gave H6 a size of its
  // own, above body copy, that made it worth offering.
  const activeHeading = isActive('heading', { level: 1 }) ? 1
    : isActive('heading', { level: 2 }) ? 2
    : isActive('heading', { level: 3 }) ? 3
    : isActive('heading', { level: 4 }) ? 4
    : isActive('heading', { level: 5 }) ? 5
    : isActive('heading', { level: 6 }) ? 6
    : 0;
  const HeadingIcon = HEADING_ICONS[activeHeading];

  // Format buttons in priority order. They fill the bar; whatever doesn't
  // fit wraps below and is clipped (max-h) until ••• expands it.
  const bold = (
    <ToolbarBtn key="bold" onClick={() => editor.chain().focus().toggleBold().run()} active={isActive('bold')} label={t('toolbar.bold')} keys={keyText('bold')} tabIndex={mobileTabIndex}>
      <BoldIcon size={TB_ICON} />
    </ToolbarBtn>
  );
  const italic = (
    <ToolbarBtn key="italic" onClick={() => editor.chain().focus().toggleItalic().run()} active={isActive('italic')} label={t('toolbar.italic')} keys={keyText('italic')} tabIndex={mobileTabIndex}>
      <ItalicIcon size={TB_ICON} />
    </ToolbarBtn>
  );
  // Underline sits in the B/I/U triad rather than beside strikethrough: it is
  // where every other editor puts it, and priority order is also clipping
  // order, so parking it at the end would drop it into the ••• row first.
  const underline = (
    <ToolbarBtn key="underline" onClick={() => editor.chain().focus().toggleUnderline().run()} active={isActive('underline')} label={t('toolbar.underline')} keys={keyText('underline')} tabIndex={mobileTabIndex}>
      <UnderlineIcon size={TB_ICON} />
    </ToolbarBtn>
  );
  const heading = (
    <div key="heading" ref={headingRef} className="relative shrink-0">
      <HoverLabel label={t('toolbar.heading')} position={tipSide}>
        <button
          ref={headingBtnRef}
          type="button"
          tabIndex={mobileTabIndex}
          {...press(() => setHeadingOpen((prev) => !prev))}
          aria-label={t('toolbar.heading')}
          className={`${TB_BTN_BASE} ${activeHeading ? TB_BTN_ACTIVE : TB_BTN_REST}`}
        >
          {/* A plain button box with no caret: its one press opens the level
              list, as alignment, font and callout do. The glyph names the
              level the caret is in, so the box never changes width.
              Spec: docs/internal/design/ui-patterns.md (section 23 - editor toolbar fit) */}
          <HeadingIcon size={TB_ICON} />
        </button>
      </HoverLabel>
      {headingOpen && (
        <HeadingPanel
          popoverRef={headingDropdownRef}
          pos={headingDropdownPos}
          onClose={() => setHeadingOpen(false)}
          editor={editor}
          activeHeading={activeHeading}
        />
      )}
    </div>
  );
  const tasks = (
    <ToolbarBtn key="tasks" onClick={() => editor.chain().focus().toggleTaskList().run()} active={isActive('taskList')} label={t('toolbar.taskList')} keys={keyText('taskList')} tabIndex={mobileTabIndex}>
      <ListChecksIcon size={TB_ICON} />
    </ToolbarBtn>
  );
  const link = (
    <ToolbarBtn key="link" onClick={onOpenLinkPopover} active={isActive('link')} label={t('toolbar.addLink')} keys={keyText('insertLink')} tabIndex={mobileTabIndex} btnRef={linkBtnRef}>
      <LinkIcon size={TB_ICON} />
    </ToolbarBtn>
  );
  // The two kinds of link are one pair and sit together: the chain reaches a
  // site, the brackets reach another note. This one only types "[[" and leaves
  // the rest to the suggestion plugin, so it could live in the '+' menu as
  // well - it sits in the row because its twin has to, and a pair split across
  // two homes reads as two unrelated controls.
  const noteLink = (
    <ToolbarBtn key="notelink" onClick={() => { editor.chain().focus().insertContent('[[').run(); }} label={t('toolbar.noteLink')} tabIndex={mobileTabIndex}>
      <BracketsIcon size={TB_ICON} />
    </ToolbarBtn>
  );
  // Split control: the wide half applies the remembered colour, the caret
  // opens the palette. Both halves paint the same rest state so the pair
  // reads as one button, and the bar of the A shows either the colour of
  // the run the caret sits in or the one a press would apply.
  const colorApplyLabel = rememberedTextColor
    ? t('toolbar.textColorApply', { color: t(`color.names.${textMemory}`) })
    : t('toolbar.textColor');
  const color = (
    <div key="color" ref={colorWrapRef} className="relative shrink-0 flex items-stretch">
      <HoverLabel label={colorApplyLabel} position={tipSide}>
        <button
          type="button"
          tabIndex={mobileTabIndex}
          onMouseDown={(e) => e.preventDefault()}
          {...press(applyRememberedTextColor)}
          aria-label={colorApplyLabel}
          className={`${TB_SPLIT_MAIN} ${TB_BTN_REST}`}
        >
          <TextColorIcon size={TB_ICON} />
          <ColorBar place="underline" color={currentColor ?? rememberedTextColor} />
        </button>
      </HoverLabel>
      <HoverLabel label={t('toolbar.pickColor')} position={tipSide}>
        <button
          type="button"
          tabIndex={mobileTabIndex}
          onMouseDown={(e) => e.preventDefault()}
          {...press(() => setColorOpen((prev) => !prev))}
          aria-label={t('toolbar.pickColor')}
          aria-expanded={colorOpen}
          className={`${TB_SPLIT_CARET} ${TB_BTN_REST}`}
        >
          <ChevronDownIcon size={TB_CARET} />
        </button>
      </HoverLabel>
      {colorOpen && (
        <TextColorPanel
          popoverRef={colorPopoverRef}
          pos={colorPos}
          onClose={() => setColorOpen(false)}
          editor={editor}
          currentColor={currentColor}
          setTextMemory={setTextMemory}
        />
      )}
    </div>
  );
  const callout = (
    <div key="callout" ref={calloutWrapRef} className="relative shrink-0">
      <HoverLabel label={t('toolbar.callout')} position={tipSide}>
        <button
          ref={calloutBtnRef}
          type="button"
          tabIndex={mobileTabIndex}
          onMouseDown={(e) => e.preventDefault()}
          {...press(() => setCalloutOpen((prev) => !prev))}
          aria-label={t('toolbar.callout')}
          className={`${TB_BTN_BASE} ${isActive('callout') ? TB_BTN_ACTIVE : TB_BTN_REST} shrink-0`}
        >
          <MegaphoneIcon size={TB_ICON} />
        </button>
      </HoverLabel>
      {calloutOpen && (
        <CalloutPanel
          popoverRef={calloutPopoverRef}
          pos={calloutPos}
          onClose={() => setCalloutOpen(false)}
          editor={editor}
          isActive={isActive}
        />
      )}
    </div>
  );
  const font = (
    <div key="font" ref={fontWrapRef} className="relative shrink-0">
      <HoverLabel label={t('toolbar.font')} position={tipSide}>
        <button
          ref={fontBtnRef}
          type="button"
          tabIndex={mobileTabIndex}
          onMouseDown={(e) => e.preventDefault()}
          {...press(() => setFontOpen((prev) => !prev))}
          aria-label={t('toolbar.font')}
          className={`${TB_BTN_BASE} ${currentFontFamily || currentFontSize ? TB_BTN_ACTIVE : TB_BTN_REST} shrink-0`}
        >
          <FontIcon size={TB_ICON} />
        </button>
      </HoverLabel>
      {fontOpen && (
        <FontPanel
          popoverRef={fontPopoverRef}
          pos={fontPos}
          onClose={() => setFontOpen(false)}
          editor={editor}
          currentFontFamily={currentFontFamily}
          currentFontSize={currentFontSize}
        />
      )}
    </div>
  );

  const ALIGN_ICONS = {
    left: TextAlignLeftIcon,
    center: TextAlignCenterIcon,
    right: TextAlignRightIcon,
    justify: TextAlignJustifyIcon,
  } as const;
  const ALIGNMENTS = ALIGNMENT_VALUES.map((value) => ({ value, Icon: ALIGN_ICONS[value] }));
  // NULL means the block carries no textAlign attribute at all, which is a
  // different state from an explicit 'left' and must not be collapsed into it:
  // TextAlign's defaultAlignment is null, so an untouched paragraph matches no
  // alignment. Defaulting this to 'left' lit up the Align-left entry on every
  // unaligned paragraph, and worse, made the unset-on-repick branch below fire
  // on it - so clicking Align left called unsetTextAlign() and explicit left
  // could never be set.
  const currentAlign =
    ALIGNMENTS.find((a) => editor.isActive({ textAlign: a.value }))?.value ?? null;
  // The trigger mirrors the active alignment so the row shows state without
  // opening the popover; unaligned borrows the left glyph but stays in the
  // rest style, which is what "inheriting" looks like.
  const CurrentAlignIcon =
    ALIGNMENTS.find((a) => a.value === currentAlign)?.Icon ?? TextAlignLeftIcon;

  const align = (
    <div key="align" ref={alignWrapRef} className="relative shrink-0">
      <HoverLabel label={t('toolbar.align')} position={tipSide}>
        <button
          ref={alignBtnRef}
          type="button"
          tabIndex={mobileTabIndex}
          onMouseDown={(e) => e.preventDefault()}
          {...press(() => setAlignOpen((prev) => !prev))}
          aria-label={t('toolbar.align')}
          className={`${TB_BTN_BASE} ${currentAlign === null ? TB_BTN_REST : TB_BTN_ACTIVE} shrink-0`}
        >
          <CurrentAlignIcon size={TB_ICON} />
        </button>
      </HoverLabel>
      {alignOpen && (
        <AlignPanel
          popoverRef={alignPopoverRef}
          pos={alignPos}
          onClose={() => setAlignOpen(false)}
          editor={editor}
          alignments={ALIGNMENTS}
          currentAlign={currentAlign}
        />
      )}
    </div>
  );
  // Twin of the text-colour control above. The active tint paints BOTH
  // halves, because a half-tinted pair would read as two buttons.
  const highlightApplyLabel = t('toolbar.highlightApply', {
    color: t(`color.names.${rememberedHighlight.name.toLowerCase()}`),
  });
  const highlight = (
    <div key="highlight" ref={highlightWrapRef} className="relative shrink-0 flex items-stretch">
      <HoverLabel label={highlightApplyLabel} position={tipSide}>
        <button
          type="button"
          tabIndex={mobileTabIndex}
          onMouseDown={(e) => e.preventDefault()}
          {...press(applyRememberedHighlight)}
          aria-label={highlightApplyLabel}
          className={`${TB_SPLIT_MAIN} ${highlightOn ? TB_BTN_ACTIVE : TB_BTN_REST}`}
        >
          <HighlighterIcon size={TB_ICON} />
          {/* The strip shows the run's own wash while the caret sits inside
              one, and the colour a press would apply everywhere else. */}
          {highlightOn && currentHighlight
            ? <ColorBar place="below" color={currentHighlight} />
            : <ColorBar
                place="below"
                color={rememberedHighlight.value}
                className={rememberedHighlight.value ? '' : 'pn-hl-default'}
              />}
        </button>
      </HoverLabel>
      <HoverLabel label={t('toolbar.pickHighlight')} position={tipSide}>
        <button
          type="button"
          tabIndex={mobileTabIndex}
          onMouseDown={(e) => e.preventDefault()}
          {...press(() => setHighlightOpen((prev) => !prev))}
          aria-label={t('toolbar.pickHighlight')}
          aria-expanded={highlightOpen}
          className={`${TB_SPLIT_CARET} ${highlightOn ? TB_BTN_ACTIVE : TB_BTN_REST}`}
        >
          <ChevronDownIcon size={TB_CARET} />
        </button>
      </HoverLabel>
      {highlightOpen && (
        <HighlightPanel
          popoverRef={highlightPopoverRef}
          pos={highlightPos}
          onClose={() => setHighlightOpen(false)}
          editor={editor}
          highlightOn={highlightOn}
          currentHighlight={currentHighlight}
          setHighlightMemory={setHighlightMemory}
        />
      )}
    </div>
  );
  const strike = (
    <ToolbarBtn key="strike" onClick={() => editor.chain().focus().toggleStrike().run()} active={isActive('strike')} label={t('toolbar.strikethrough')} keys={keyText('strikethrough')} tabIndex={mobileTabIndex}>
      <StrikethroughIcon size={TB_ICON} />
    </ToolbarBtn>
  );

  // Collapse all / Expand all (#779): it closes every callout and code block
  // while one is open, and opens them all once every one is closed. With
  // nothing to fold it stays dimmed on the bar and leaves the + menu.
  const folds = foldSummary(editor.state);
  const foldAllCloses = folds.open > 0 || folds.foldable === 0;
  const foldAllLabel = t(foldAllCloses ? 'shell:folders.collapseAll' : 'shell:folders.expandAll');
  const FoldAllIcon = foldAllCloses ? ArrowsInLineVertical : ArrowsOutLineVertical;
  const runFoldAll = () => {
    const tr = setAllFolded(editor.state, foldAllCloses);
    if (tr) editor.view.dispatch(tr);
  };
  const foldAll = (
    <ToolbarBtn key="foldAll" onClick={runFoldAll} disabled={folds.foldable === 0} label={foldAllLabel} tabIndex={mobileTabIndex}>
      <FoldAllIcon size={TB_ICON} />
    </ToolbarBtn>
  );

  // What a press does for every item that can sit in the + menu, and for the
  // plain marks a person can move there. The look (icon, label) comes from
  // formatBarItems.tsx; the group from formatBar.ts. `hint` is the Markdown or
  // the key that does the same, which the menu shows beside the label.
  // `label` and `Icon` replace the look's own for an item whose words follow
  // the note (Collapse all / Expand all).
  type MenuAction = { hint: string | null; active: boolean; run: () => void; label?: string; Icon?: Icon };
  const actions: Record<string, MenuAction> = {
    // As the tag row's pair does (handleHistory in NotesView.tsx): a touch
    // screen keeps its keyboard down, where a focus would raise it.
    undo: { hint: keyText('undo'), active: false, run: () => { const c = editor.chain(); if (!isSoftKeyboardDevice()) c.focus(); c.undo().run(); } },
    redo: { hint: keyText('redo'), active: false, run: () => { const c = editor.chain(); if (!isSoftKeyboardDevice()) c.focus(); c.redo().run(); } },
    bold: { hint: FORMAT_BAR_HINT.bold, active: isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
    italic: { hint: FORMAT_BAR_HINT.italic, active: isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
    underline: { hint: keyText('underline'), active: isActive('underline'), run: () => editor.chain().focus().toggleUnderline().run() },
    tasks: { hint: FORMAT_BAR_HINT.tasks, active: isActive('taskList'), run: () => editor.chain().focus().toggleTaskList().run() },
    notelink: { hint: FORMAT_BAR_HINT.notelink, active: false, run: () => { editor.chain().focus().insertContent('[[').run(); } },
    customize: { hint: null, active: false, run: () => onCustomize?.() },
    markdownView: { hint: keyText('markdownView'), active: false, run: () => onShowMarkdown?.() },
    strike: { hint: FORMAT_BAR_HINT.strike, active: isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
    // A header row is what a pipe table needs to exist at all: the markdown
    // serializer falls back to raw HTML for a table whose first row is plain
    // cells, so a headerless one is stored as a wall of markup and travels to
    // other apps as markup too. The bar under the table turns it off for
    // anyone who wants a grid instead.
    table: { hint: null, active: isActive('table'), run: () => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() },
    hr: { hint: FORMAT_BAR_HINT.hr, active: false, run: () => editor.chain().focus().setHorizontalRule().run() },
    // The hint column teaches the list prefixes, and the prefix is faster
    // than any button.
    bullets: { hint: FORMAT_BAR_HINT.bullets, active: isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    numbered: { hint: FORMAT_BAR_HINT.numbered, active: isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() },
    // Tab and Shift+Tab for a phone, which has neither key (#614): the list
    // item moves a level, and elsewhere the line takes or loses spaces.
    indent: { hint: bindingKeyText({ key: 'Tab' }), active: false, run: () => { if (!indentListItem(editor, 1)) indentText(editor, 1); } },
    outdent: { hint: bindingKeyText({ shift: true, key: 'Tab' }), active: false, run: () => { if (!indentListItem(editor, -1)) indentText(editor, -1); } },
    date: { hint: keyText('insertDate'), active: false, run: () => insertDateText(editor, 'date') },
    dateTime: { hint: keyText('insertDateTime'), active: false, run: () => insertDateText(editor, 'dateTime') },
    quote: { hint: FORMAT_BAR_HINT.quote, active: isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() },
    codeblock: {
      hint: FORMAT_BAR_HINT.codeblock,
      active: isActive('codeBlock') && !isActive('codeBlock', { language: COPY_BOX_LANGUAGE }),
      run: () => toggleCodeBlockSmart(editor),
    },
    copybox: {
      hint: FORMAT_BAR_HINT.copybox,
      active: isActive('codeBlock', { language: COPY_BOX_LANGUAGE }),
      run: () => toggleCodeBlockSmart(editor, COPY_BOX_LANGUAGE),
    },
    kanban: { hint: null, active: false, run: () => insertKanbanBoard(editor, t) },
    inlinecode: { hint: FORMAT_BAR_HINT.inlinecode, active: isActive('code'), run: () => editor.chain().focus().toggleCode().run() },
    // The selected text becomes the formula. The insert commands do not
    // replace a selection, so it is deleted first.
    math: {
      hint: FORMAT_BAR_HINT.math,
      active: false,
      run: () => {
        const { from, to, empty } = editor.state.selection;
        const latex = empty ? 'x^2' : editor.state.doc.textBetween(from, to, ' ');
        editor.chain().focus().deleteSelection().insertInlineMath({ latex }).run();
      },
    },
    // Block math is its own node in @tiptap/extension-mathematics, so it has
    // its own entry.
    blockmath: {
      hint: FORMAT_BAR_HINT.blockmath,
      active: false,
      run: () => {
        const { from, to, empty } = editor.state.selection;
        const latex = empty ? 'x^2' : editor.state.doc.textBetween(from, to, ' ');
        editor.chain().focus().deleteSelection().insertBlockMath({ latex }).run();
      },
    },
    superscript: { hint: null, active: isActive('superscript'), run: () => editor.chain().focus().toggleSuperscript().run() },
    subscript: { hint: null, active: isActive('subscript'), run: () => editor.chain().focus().toggleSubscript().run() },
    spoiler: { hint: FORMAT_BAR_HINT.spoiler, active: isActive('spoiler'), run: () => editor.chain().focus().toggleSpoiler().run() },
    footnote: { hint: FORMAT_BAR_HINT.footnote, active: false, run: () => insertFootnote(editor) },
    icon: { hint: null, active: false, run: () => setIconPickerOpen(true) },
    // The note's place window, prefilled; Insert map puts a map block at the caret.
    location: { hint: null, active: false, run: () => setLocationOpen(true) },
    doodle: { hint: null, active: false, run: () => { void import('./doodle/insertDoodle').then((m) => m.insertDoodle(editor)); } },
    // The touch home of the selection menu's "Copy as ..." entries (#546).
    copyAsPlain: { hint: null, active: false, run: () => copySelectionAs(editor, 'plain') },
    copyAsMarkdown: { hint: null, active: false, run: () => copySelectionAs(editor, 'markdown') },
  };
  if (folds.foldable > 0) {
    actions.foldAll = { hint: null, active: false, run: runFoldAll, label: foldAllLabel, Icon: FoldAllIcon };
  }
  // A picture already in Files, shown without a copy (#330). A modal, so the
  // menu closing under the press cannot close it. Absent where the media
  // buttons are: a Markdown folder cannot hold a reference to our encrypted
  // store.
  // The picture and file pickers run as a command, so they can sit in the
  // menu as well as on the bar.
  if (!hideEncryptedMedia || onInsertFiles) {
    actions.image = { hint: null, active: false, run: () => fileInputRef.current?.click() };
    actions.attach = { hint: null, active: false, run: () => attachmentInputRef.current?.click() };
  }
  if (!hideEncryptedMedia && pluginsShown()) {
    actions.scan = {
      hint: null,
      active: false,
      run: () => {
        scanPos.current = editor.state.selection.from;
        startScan();
      },
    };
  }
  if (!hideEncryptedMedia) {
    actions.fromFiles = {
      hint: null,
      active: false,
      run: () => {
        const view = editor.view;
        openPicturePicker({
          onPick: (ref) => {
            void import('./EncryptedImage').then(({ insertPictureRef }) => insertPictureRef(view, ref));
          },
        });
      },
    };
  }

  const lookLabel = (key: string) => t(FORMAT_BAR_LOOK[key]!.label);

  // The recording and "from Files" buttons only make an encrypted blob, which
  // a Markdown folder note cannot hold; the picture and file buttons stay when
  // the folder takes their files (`onInsertFiles`). The Linux app has no
  // recorder (its WebKitGTK has no MediaRecorder; docs/contrib/gotchas.md). An item
  // this editor does not offer is left out wherever it was placed.
  const MEDIA = new Set(onInsertFiles ? ['audio', 'fromFiles', 'scan'] : ['image', 'attach', 'audio', 'fromFiles', 'scan']);
  // "Customize toolbar" is the door to Settings > Toolbar, where this bar is
  // arranged: an item like the others, so a person can hide it there. Only
  // where there is room for it; on a phone that tab is reached through
  // Settings. No Pro mark on it: the tab says what Pro adds.
  const offered = (key: string) =>
    !(hideEncryptedMedia && MEDIA.has(key)) && !(key === 'audio' && isLinuxNative()) &&
    !(key === 'customize' && !onCustomize) &&
    !(key === 'markdownView' && !onShowMarkdown) &&
    !(key === 'splitView' && !sourcePreview);

  // What the attach menu offers here. Its items count only while the
  // paperclip is on the bar; with one item left, the paperclip gives way to
  // that item's own button.
  const onBarOrEnd = (key: string) => layout.bar.includes(key) || layout.end.includes(key);
  const attachKeys = onBarOrEnd('attachMenu')
    ? layout.attachMenu.filter((k) => offered(k) && (k === 'audio' || actions[k]))
    : [];
  const soloAttach = attachKeys.length === 1 ? attachKeys[0]! : null;
  // The recorder shows its idle button only where the person placed it on
  // the bar. In the attach menu it stays mounted with no button, so a
  // recording started from the menu keeps its stop button on the bar.
  const recorderShown = onBarOrEnd('audio') || soloAttach === 'audio';
  if (attachKeys.includes('audio')) {
    actions.audio = { hint: null, active: false, run: () => audioStartRef.current?.() };
  }

  // A menu item the person moved onto the bar: a plain button whose tip
  // carries the shortcut the menu row showed.
  const promoted = (key: string) => {
    const action = actions[key];
    if (!action) return null;
    const { Icon } = FORMAT_BAR_LOOK[key]!;
    return (
      <ToolbarBtn key={key} onClick={action.run} active={action.active} label={lookLabel(key)} keys={action.hint ?? undefined} tabIndex={mobileTabIndex}>
        <Icon size={TB_ICON} />
      </ToolbarBtn>
    );
  };

  // The bar's own controls. Their stock order, and why each item starts where
  // it does, is in formatBar.ts.
  const recorder = (
    <AudioRecorder
      key="audio"
      editorView={editor.view}
      tabIndex={mobileTabIndex}
      onStateChange={(state, duration) => {
        setRecording(state !== 'idle');
        onAudioStateChange?.(state, duration);
      }}
      stopRef={audioStopRef}
      startRef={audioStartRef}
      idleHidden={!recorderShown}
      tipSide={tipSide}
    />
  );
  const attachMenu = attachKeys.length === 0 ? null
    : soloAttach === 'audio' ? recorder
    : soloAttach ? promoted(soloAttach)
    : (
      <div key="attachMenu" ref={attachWrapRef} className="relative shrink-0">
        <HoverLabel label={lookLabel('attachMenu')} position={tipSide}>
          <button
            ref={attachBtnRef}
            type="button"
            tabIndex={mobileTabIndex}
            onMouseDown={(e) => e.preventDefault()}
            {...press(() => setAttachOpen((prev) => !prev))}
            aria-label={lookLabel('attachMenu')}
            aria-haspopup="menu"
            aria-expanded={attachOpen}
            className={`${TB_BTN_BASE} ${attachOpen ? TB_BTN_ACTIVE : TB_BTN_REST} shrink-0`}
          >
            <AttachIcon size={TB_ICON} />
          </button>
        </HoverLabel>
        {attachOpen && createPortal(
          <div
            ref={attachPopoverRef}
            role="menu"
            aria-label={lookLabel('attachMenu')}
            className="fixed z-50 bg-surface-1 border border-divider rounded-lg shadow-lg py-1 w-48"
            style={{ top: attachPos?.top ?? 0, left: attachPos?.left ?? 0, visibility: attachPos ? 'visible' : 'hidden' }}
          >
            {attachKeys.map((key) => {
              const { Icon } = FORMAT_BAR_LOOK[key]!;
              return (
                <button
                  key={key}
                  type="button"
                  role="menuitem"
                  {...press(() => {
                    setAttachOpen(false);
                    actions[key]!.run();
                  })}
                  className="w-full flex items-center gap-2.5 text-start px-3 py-1.5 text-body text-pn-soft [@media(hover:hover)]:hover:bg-pn/5 active:bg-pn/5 transition"
                >
                  <Icon size={TB_ICON} />
                  <span className="flex-1">{lookLabel(key)}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
      </div>
    );
  // A thin line the person places between buttons to group them.
  const separatorLine = (key: string) => (
    <span key={key} aria-hidden="true" className="shrink-0 -mx-0.5 h-4 w-px bg-pn-muted/35" />
  );
  const rowControls: Record<string, ReactElement> = {
    bold, italic, underline, heading, tasks, link, notelink: noteLink,
    color, align, font, highlight, callout, foldAll, strike, audio: recorder,
  };
  // Split view, wherever the person placed it (sourcePreviewButtons.tsx).
  const controls = (keys: string[]) => keys
    .filter(offered)
    .flatMap((key) => {
      if (key === 'splitView') return sourcePreview ? sourcePreviewButtons(t, sourcePreview, mobileTabIndex) : [];
      if (isSeparatorKey(key)) return [separatorLine(key)];
      const el = key === 'attachMenu' ? attachMenu : rowControls[key] ?? promoted(key);
      return el ? [el] : [];
    });
  const formatButtons = controls(layout.bar);
  // The end of the bar, after the '+': it never gives way behind the •••.
  // A hidden or moved-away recorder stays here while it records, so a change
  // to the bar never cuts a recording off. One in the attach menu stays here
  // at rest too, with no button, so the menu can start it.
  const endKeys = !onBarOrEnd('audio') && soloAttach !== 'audio' && (recording || attachKeys.includes('audio'))
    ? [...layout.end, 'audio']
    : layout.end;
  const endButtons = controls(endKeys);
  // A recorder that sits in row 2 keeps row 2 open while it records: closing
  // the ••• would unmount it, and its button with it.
  const audioAt = formatButtons.indexOf(recorder);
  const holdOpen = recording && audioAt >= 0 && fitState.measured && audioAt >= fitState.visibleCount;
  const menuItems = layout.menu.filter(offered).flatMap((key) => {
    if (key === 'splitView') return sourcePreview ? sourcePreviewMenuItems(t, sourcePreview) : [];
    const action = actions[key];
    return action ? [{ key, group: formatBarItem(key)!.group, Icon: FORMAT_BAR_LOOK[key]!.Icon, label: lookLabel(key), ...action }] : [];
  });

  return (
    <ToolbarFrame
      fit={fitState}
      row={formatButtons}
      holdOpen={holdOpen}
      menu={menuItems}
      press={press}
      end={endButtons}
      atBottom={atBottom}
      strip={strip}
      onHideKeyboard={() => editor.commands.blur()}
      tabIndex={mobileTabIndex}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleImagePick}
      />
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleAttachmentPick}
      />
      {/* A phone opens its rear camera; the gallery stays one tap away. */}
      <input
        ref={scanInputRef}
        type="file"
        accept="image/*"
        {...(isTouchOnly() ? { capture: 'environment' as const } : {})}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) setScan({ file, pos: scanPos.current });
        }}
      />
      {/* On the body, as the snackbar below: inside the bar, its backdrop blur
          held the window to the bar's own box, cut off under the header. */}
      {scan && editor && createPortal(
        <Suspense fallback={null}>
          <ScanEditor
            file={scan.file}
            flat={scan.flat}
            withTextOffer={pluginFlagOn('ocr')}
            onRetake={startScan}
            onClose={() => setScan(null)}
            onDone={(result) => {
              const view = editor.view;
              setScan(null);
              if ((scan.pages ?? 1) > 1) setFirstPageOnly(true);
              // Text only: the sheet reads the page, and its "Add text to
              // note" puts the words where the cursor was when the scan began.
              if (result.kind === 'text') {
                const at = scan.pos;
                openPluginSheet({
                  kind: 'ocr',
                  source: 'picture',
                  primary: 'add',
                  noteId: editorNote(editor),
                  load: async () => result.page,
                  insert: (text) => insertTextAt(editor, at, text),
                });
                return;
              }
              // The placed picture's or PDF's address, once it is in the note.
              let placed: string | null = null;
              void (result.kind === 'picture'
                ? import('./EncryptedImage').then(({ triggerImageUpload }) => triggerImageUpload(result.file, view, scan.pos))
                : triggerAttachmentUpload(result.file, view)
              ).then((src) => {
                placed = src;
              });
              // "Also add the text": the Text in pictures sheet on the warped
              // page, whose "Add text to note" puts it below the scan. The
              // scan is found when the button is pressed: the cursor position
              // from before the scan is not where it went, and edits move it
              // (beta #240 item 5). Not there (yet, or any more): it throws,
              // and the sheet points to Copy.
              const page = result.page;
              if (page) {
                openPluginSheet({
                  kind: 'ocr',
                  source: 'picture',
                  primary: 'add',
                  noteId: editorNote(editor),
                  load: async () => page,
                  insert: (text) => {
                    let at: number | null = null;
                    if (placed) {
                      editor.state.doc.descendants((node, pos) => {
                        if (at === null && node.attrs.src === placed) at = pos;
                        return at === null;
                      });
                    }
                    if (at === null) throw new Error('gone');
                    insertTextAfter(editor, at, text);
                  },
                });
              }
            }}
          />
        </Suspense>,
        document.body,
      )}
      {/* On the body: the bar's backdrop blur would hold a fixed child to the bar. */}
      {firstPageOnly && createPortal(<Snackbar>{t('media:scanFirstPageOnly')}</Snackbar>, document.body)}
      {editor && (
        <Popover
          open={locationOpen}
          anchorRef={rightClusterRef}
          onClose={() => setLocationOpen(false)}
          title={t('notes:location.title')}
          align="end"
          className="w-80"
        >
          <LocationPanel
            key={locationOpen ? 'open' : 'closed'}
            place={place}
            readOnly={false}
            startEditing
            saveText={t('notes:location.insertMap')}
            onDone={() => setLocationOpen(false)}
            onSave={async (loc) => editor.chain().focus().insertContent({
              type: PlaceMapNode.name,
              attrs: { lat: loc.lat, lng: loc.lng, label: loc.label ?? null },
            }).run()}
          />
        </Popover>
      )}
      {iconPickerOpen && (
        <Suspense fallback={null}>
          <LookPicker
            target={{ kind: 'insert', lookKey: '', name: t('shell:noteOptionsMenu.icon') }}
            styles={{}}
            noteColors="off"
            onNoteColors={() => {}}
            onPick={(patch) => {
              if (patch.icon) insertInlineIcon(editor, patch.icon);
              setIconPickerOpen(false);
            }}
            onCancel={() => {}}
            onClose={() => setIconPickerOpen(false)}
          />
        </Suspense>
      )}
    </ToolbarFrame>
  );
}
