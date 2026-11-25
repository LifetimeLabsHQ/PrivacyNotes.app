import type { Icon } from './icons';
import {
  Scan,
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  TextH,
  ListChecks,
  ListBullets,
  ListNumbers,
  Link,
  BracketsSquare,
  TextAUnderline,
  TextT,
  TextAlignLeft,
  Highlighter,
  Megaphone,
  GridFour,
  Minus,
  Images,
  Calendar,
  Clock,
  Quotes,
  CodeBlock,
  Copy,
  Kanban,
  Columns,
  Code,
  MathOperations,
  Sigma,
  TextSuperscript,
  TextSubscript,
  EyeSlash,
  Asterisk,
  Image,
  Paperclip,
  FileArrowUp,
  LineVertical,
  Microphone,
  Gear,
  ArticleMedium,
  ClipboardText,
  FileMd,
  TextIndent,
  TextOutdent,
  Shapes,
  MapPin,
  ScribbleLoop,
  ArrowsInLineVertical,
  ArrowUUpLeft,
  ArrowUUpRight,
  SquareSplitHorizontal,
} from './icons';

/**
 * How each format bar item looks wherever it is listed: the icon and the
 * label key (editor namespace). The toolbar's own buttons draw richer
 * controls for some of these (the split colour buttons, the heading level);
 * the Settings board and a button promoted from the menu use these.
 * Spec: docs/internal/specs/format-bar.md
 */
export const FORMAT_BAR_LOOK: Record<string, { Icon: Icon; label: string }> = {
  // The tag row's own words, so the two read the same.
  undo: { Icon: ArrowUUpLeft, label: 'notes:editor.undo' },
  redo: { Icon: ArrowUUpRight, label: 'notes:editor.redo' },
  bold: { Icon: TextB, label: 'toolbar.bold' },
  italic: { Icon: TextItalic, label: 'toolbar.italic' },
  underline: { Icon: TextUnderline, label: 'toolbar.underline' },
  heading: { Icon: TextH, label: 'toolbar.heading' },
  tasks: { Icon: ListChecks, label: 'toolbar.taskList' },
  link: { Icon: Link, label: 'formatBar.items.link' },
  notelink: { Icon: BracketsSquare, label: 'formatBar.items.notelink' },
  color: { Icon: TextAUnderline, label: 'toolbar.textColor' },
  align: { Icon: TextAlignLeft, label: 'toolbar.align' },
  font: { Icon: TextT, label: 'toolbar.font' },
  highlight: { Icon: Highlighter, label: 'toolbar.highlight' },
  callout: { Icon: Megaphone, label: 'toolbar.callout' },
  // Collapse all or Expand all (foldAll.ts); the toolbar flips the label and
  // the icon, as the folder list's own control does (TagsRail.tsx).
  foldAll: { Icon: ArrowsInLineVertical, label: 'shell:folders.collapseAll' },
  strike: { Icon: TextStrikethrough, label: 'toolbar.strikethrough' },
  table: { Icon: GridFour, label: 'toolbar.table' },
  hr: { Icon: Minus, label: 'toolbar.divider' },
  bullets: { Icon: ListBullets, label: 'toolbar.bulletList' },
  numbered: { Icon: ListNumbers, label: 'toolbar.numberedList' },
  indent: { Icon: TextIndent, label: 'toolbar.indent' },
  outdent: { Icon: TextOutdent, label: 'toolbar.outdent' },
  fromFiles: { Icon: Images, label: 'toolbar.pictureFromFiles' },
  date: { Icon: Calendar, label: 'toolbar.date' },
  dateTime: { Icon: Clock, label: 'toolbar.dateTime' },
  // The note menu's own label, so the two read the same.
  icon: { Icon: Shapes, label: 'shell:noteOptionsMenu.icon' },
  // A map of a place in the body (PlaceMapNode.tsx); the window is the note's place window.
  location: { Icon: MapPin, label: 'notes:location.title' },
  // A pen drawing saved as a picture (doodle/DoodlePad.tsx).
  doodle: { Icon: ScribbleLoop, label: 'doodle.title' },
  quote: { Icon: Quotes, label: 'toolbar.quote' },
  codeblock: { Icon: CodeBlock, label: 'toolbar.codeBlock' },
  copybox: { Icon: Copy, label: 'toolbar.copyBox' },
  kanban: { Icon: Kanban, label: 'callout.types.kanban' },
  columns: { Icon: Columns, label: 'kanban.columns' },
  inlinecode: { Icon: Code, label: 'toolbar.inlineCode' },
  math: { Icon: MathOperations, label: 'toolbar.math' },
  blockmath: { Icon: Sigma, label: 'toolbar.blockMath' },
  superscript: { Icon: TextSuperscript, label: 'toolbar.superscript' },
  subscript: { Icon: TextSubscript, label: 'toolbar.subscript' },
  spoiler: { Icon: EyeSlash, label: 'toolbar.spoiler' },
  footnote: { Icon: Asterisk, label: 'toolbar.footnote' },
  image: { Icon: Image, label: 'toolbar.image' },
  attach: { Icon: FileArrowUp, label: 'toolbar.attachFile' },
  // Scan a page (scan/ScanEditor.tsx): a photo becomes a flat picture or PDF.
  // The menu names the text too, so the OCR door is found (owner, 2026-11-18); the window keeps "Scan a page".
  scan: { Icon: Scan, label: 'media:scanOcr' },
  attachMenu: { Icon: Paperclip, label: 'formatBar.items.attachMenu' },
  // Every divider, of any number (isSeparatorKey in formatBar.ts), wears this look.
  separator: { Icon: LineVertical, label: 'formatBar.items.separator' },
  audio: { Icon: Microphone, label: 'formatBar.items.audio' },
  customize: { Icon: Gear, label: 'toolbar.customize' },
  // The Markdown view with its preview beside it (sourcePreviewButtons.tsx).
  splitView: { Icon: SquareSplitHorizontal, label: 'notes:editor.splitView' },
  markdownView: { Icon: ArticleMedium, label: 'formatBar.items.markdownView' },
  copyAsPlain: { Icon: ClipboardText, label: 'bodyMenu.copyAsPlain' },
  copyAsMarkdown: { Icon: FileMd, label: 'bodyMenu.copyAsMarkdown' },
};

/**
 * The Markdown an item writes, shown beside its entry in the '+' menu of
 * both toolbars, the formatted one (EditorToolbar.tsx) and the Markdown
 * view's (MarkdownSourceBar.tsx), so the two teach the same syntax.
 * Spec: docs/internal/specs/format-bar.md
 */
export const FORMAT_BAR_HINT = {
  bold: '**x**', italic: '*x*', strike: '~~x~~', tasks: '[]', notelink: '[[',
  hr: '---', bullets: '-', numbered: '1.', quote: '>', codeblock: '```', copybox: '```copy',
  inlinecode: '`x`', math: '$x$', blockmath: '$$x$$', spoiler: '||x||', footnote: '[^1]',
  highlight: '==x==', callout: '> [!note]',
} as const satisfies Record<string, string>;

/** The hint for any key, or null where the item has none. */
export function formatBarHint(key: string): string | null {
  return (FORMAT_BAR_HINT as Record<string, string | undefined>)[key] ?? null;
}
