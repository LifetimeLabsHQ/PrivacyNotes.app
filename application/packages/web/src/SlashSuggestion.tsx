/**
 * The `/` slash menu in the note editor.
 *
 * Sibling of `NoteLinkSuggestion.tsx`, `CalloutSuggestion.tsx`, and
 * `FormulaSuggestion.tsx`, backed by a stateful ProseMirror plugin so only a
 * typed `/` at the start of a block or after whitespace opens the menu:
 * pastes, Undo/Redo, code spans/fences, URLs, fractions, and cursor movements
 * onto an existing `/` stay silent.
 *
 * Live editor insert and block actions come from `SLASH_FORMAT_BAR_KEYS`
 * through the mounted toolbar's `slashActionsRef`, so adding an item to the
 * `+` or attach menu adds it here automatically.
 *
 * Spec: docs/internal/specs/slash-menu.md
 */

import { Extension, type Editor } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { Fragment, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import {
  BellSimple,
  CalendarDot,
  MathOperations,
  TextHFive,
  TextHFour,
  TextHOne,
  TextHSix,
  TextHThree,
  TextHTwo,
  TextT,
  type Icon,
} from './icons';
import { CALLOUT_PICKER_TYPES, type CalloutType } from './calloutTypes';
import { smartToggleHeading } from './editorToolbarParts';
import { hasTaskReminderInItem } from './editorTaskReminder';
import { formatBarItem } from './formatBar';
import { formatInstant, toLocalIso } from './intlFormat';
import { noteRecentId, readRecentIds } from './recentIds';
import { keyText } from './shortcutMatch';
import { textMatcher } from './textMatch';
import { placeAtCaret } from './usePopoverPosition';
import { Divider, Kbd, NinjaIcon, ProBadge, SETTINGS_EYEBROW, SuggestionItem, SuggestionPopup } from './ui';

const SLASH_RECENT_KEY = 'privacynotes.editor.slashRecent';
const SLASH_RECENT_MAX = 3;
/** Maximum non-matching query characters kept open for the Ask Ninja row; the next character auto-closes. */
const ZERO_MATCH_MAX_LEN = 6;

export const SLASH_PLUGIN_KEY = new PluginKey<SlashSession | null>('slashSuggestion');

export type SlashAction = {
  key: string;
  label: string;
  icon: Icon;
  hint: string | null;
  run: () => void;
};

type SlashGroup = 'recent' | 'smartDate' | 'basic' | 'blocks' | 'insert' | 'notation' | 'ninja';

export type SlashMenuEntry = {
  id: string;
  group: SlashGroup;
  label: string;
  hint?: string;
  shortcut?: string | null;
  icon: Icon | typeof NinjaIcon;
  pro?: boolean;
  inline: boolean;
  keywords: string;
  /** Whether picking this entry records it in the Recent group. */
  recordRecent: boolean;
  run: () => void;
};

type SlashSession = {
  /** Document position of the typed `/`. */
  from: number;
};

/** Format-bar keys that insert inline at the caret instead of starting or converting a block. */
const INLINE_FORMAT_KEYS: ReadonlySet<string> = new Set([
  'notelink', 'link', 'date', 'dateTime', 'icon', 'inlinecode', 'math', 'superscript', 'subscript', 'spoiler', 'footnote',
]);

/** Format-bar keys promoted to the Basic blocks group at the top of the slash menu. */
const BASIC_FORMAT_KEYS: ReadonlySet<string> = new Set([
  'tasks', 'bullets', 'numbered', 'table', 'hr',
]);

/** Resolve a format-bar item's group in `/` directly from `formatBar.ts` so new items never drift groups. */
function slashGroupOfFormatKey(key: string): 'basic' | 'blocks' | 'insert' | 'notation' {
  if (BASIC_FORMAT_KEYS.has(key)) return 'basic';
  if (key === 'callout') return 'blocks';
  const group = formatBarItem(key)?.group;
  if (group === 'blocks') return 'blocks';
  if (group === 'notation') return 'notation';
  return 'insert';
}

/** Extra search words so people find entries under common Markdown or Notion names too. */
const EXTRA_KEYWORDS: Record<string, string> = {
  tasks: 'todo checklist checkbox []',
  bullets: 'unordered ul list -',
  numbered: 'ordered ol list 1.',
  table: 'grid spreadsheet',
  hr: 'divider rule line separator ---',
  callout: 'admonition alert box > [!',
  quote: 'blockquote citation >',
  codeblock: 'fence snippet pre ```',
  copybox: 'clipboard snippet ```copy',
  kanban: 'board cards columns',
  columns: 'layout side by side grid',
  notelink: 'note link mention [[',
  link: 'url href web address',
  date: 'today calendar',
  dateTime: 'now timestamp clock',
  icon: 'emoji logo glyph symbol',
  location: 'map place pin address',
  doodle: 'draw sketch pen scribble',
  image: 'photo picture upload',
  fromFiles: 'gallery files vault picture',
  attach: 'file pdf document paperclip upload',
  scan: 'ocr camera page document',
  audio: 'voice record microphone memo',
  inlinecode: 'code span monospace',
  math: 'latex equation katex inline',
  blockmath: 'latex equation sigma display',
  spoiler: 'hidden blur secret ||',
  footnote: 'reference citation [^1]',
  superscript: 'sup exponent',
  subscript: 'sub index',
};

/** Keys allowed inside a table cell (inline items + cell formula; block structures stay out). */
const TABLE_CELL_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'notelink', 'link', 'date', 'dateTime', 'icon', 'inlinecode', 'math', 'superscript', 'subscript', 'spoiler',
]);

function isInsideTableCell(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return true;
  }
  return false;
}

function enclosingTaskItemPos(state: EditorState, pos: number): number | null {
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'taskItem') return $pos.before(d);
  }
  return null;
}

/**
 * Whether typing `/` at `slashPos` in `state` is allowed to start a slash session:
 * editable textblock, not inside a code block or inline code mark, at the start
 * of the block or right after whitespace, and not inside an unclosed `[[` link.
 */
export function allowSlashStart(state: EditorState, slashPos: number): boolean {
  if (slashPos < 0 || slashPos >= state.doc.content.size) return false;
  const $pos = state.doc.resolve(slashPos);
  if (!$pos.parent.isTextblock) return false;
  for (let d = $pos.depth; d >= 0; d--) {
    if ($pos.node(d).type.name === 'codeBlock') return false;
  }
  const codeMark = state.schema.marks.code;
  const marks = state.storedMarks ?? $pos.marks();
  if (codeMark?.isInSet(marks)) return false;

  if (slashPos > $pos.start()) {
    const prevChar = state.doc.textBetween(slashPos - 1, slashPos, '\n', '\0');
    if (!/^\s$/.test(prevChar)) return false;
    const before = state.doc.textBetween($pos.start(), slashPos, '\n', '\0');
    const lastWikiOpen = before.lastIndexOf('[[');
    if (lastWikiOpen >= 0 && before.indexOf(']]', lastWikiOpen + 2) < 0) return false;
  }
  return true;
}

function isSingleTypedSlash(tr: Transaction, oldState: EditorState, newState: EditorState): boolean {
  if (!tr.docChanged) return false;
  if (tr.getMeta('paste') || tr.getMeta('drop')) return false;
  const uiEvent = tr.getMeta('uiEvent');
  if (uiEvent === 'paste' || uiEvent === 'drop') return false;
  if (tr.getMeta('history$') || tr.getMeta('addToHistory') === false) return false;
  if (!oldState.selection.empty || !newState.selection.empty) return false;
  if (tr.steps.length !== 1) return false;
  const slashPos = oldState.selection.from;
  if (newState.selection.from !== slashPos + 1) return false;
  return newState.doc.textBetween(slashPos, slashPos + 1, '\n', '\0') === '/';
}

type SmartDateDeps = {
  parseQuickAdd: typeof import('./quickAdd').parseQuickAdd;
  quickAddContext: typeof import('./quickAddContext').quickAddContext;
  dayOfQuery: typeof import('./switcherQuery').dayOfQuery;
};

let smartDateDeps: SmartDateDeps | null = null;
let smartDateLoading: Promise<SmartDateDeps> | null = null;

/** Load natural-date parsing lazily off the boot path when `/` first opens. */
export function ensureSlashSmartDateLoaded(onReady?: () => void): Promise<void> {
  if (smartDateDeps) {
    onReady?.();
    return Promise.resolve();
  }
  if (!smartDateLoading) {
    smartDateLoading = Promise.all([
      import('./quickAdd'),
      import('./quickAddContext'),
      import('./switcherQuery'),
    ]).then(([qa, qac, sq]) => {
      smartDateDeps = {
        parseQuickAdd: qa.parseQuickAdd,
        quickAddContext: qac.quickAddContext,
        dayOfQuery: sq.dayOfQuery,
      };
      return smartDateDeps;
    });
  }
  return smartDateLoading.then(() => {
    onReady?.();
  });
}

/** Resolve a natural-language date query (`friday`, `tomorrow`, `dec 25`) to formatted date text, or null. */
export function resolveSlashSmartDate(query: string, now = new Date()): { iso: string; formatted: string } | null {
  if (!smartDateDeps) return null;
  const q = query.trim();
  if (q.length < 2 || /^\d+$/.test(q)) return null;
  const today = toLocalIso(now);
  const day = smartDateDeps.dayOfQuery(
    smartDateDeps.parseQuickAdd(q, { ...smartDateDeps.quickAddContext(), today, folders: [] }),
    today,
  );
  if (!day) return null;
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return null;
  const localNoon = new Date(y, m - 1, d, 12, 0, 0);
  return { iso: day, formatted: formatInstant(localNoon, 'date') };
}

export interface SlashSuggestionOptions {
  getActions: () => readonly SlashAction[];
  openReminder: (anchor: HTMLElement, taskPos: number) => void;
  isPro: () => boolean;
  proUnlocked: () => boolean;
  onUpgrade: () => void;
  askNinja: () => ((seed?: string) => void) | null;
}

/** Build the candidate entries for the current caret position and query. */
export function buildSlashEntries(
  editor: Editor,
  state: EditorState,
  slashPos: number,
  query: string,
  opts: SlashSuggestionOptions,
): SlashMenuEntry[] {
  const inCell = isInsideTableCell(state, slashPos);
  const taskPos = enclosingTaskItemPos(state, slashPos);
  const actionsByKey = new Map(opts.getActions().map((a) => [a.key, a]));
  const q = query.trim();

  const base: SlashMenuEntry[] = [];

  if (!inCell) {
    const headingLevels = q
      ? ([1, 2, 3, 4, 5, 6] as const)
      : ([1, 2, 3] as const);
    const headingIcons = [TextHOne, TextHTwo, TextHThree, TextHFour, TextHFive, TextHSix] as const;
    if (q) {
      base.push({
        id: 'paragraph',
        group: 'basic',
        label: i18n.t('editor:heading.normalText'),
        icon: TextT,
        inline: false,
        keywords: 'text paragraph plain body normal',
        recordRecent: false,
        run: () => { editor.chain().focus().setParagraph().run(); },
      });
    }
    for (const level of headingLevels) {
      base.push({
        id: `h${level}`,
        group: 'basic',
        label: i18n.t('editor:heading.level', { level }),
        shortcut: '#'.repeat(level),
        icon: headingIcons[level - 1]!,
        inline: false,
        keywords: `heading h${level} title ${'#'.repeat(level)}`,
        recordRecent: true,
        run: () => smartToggleHeading(editor, level),
      });
    }
  }

  const pushFormatKey = (key: string, group: SlashGroup) => {
    if (inCell && !TABLE_CELL_ALLOWED_KEYS.has(key)) return;
    const action = actionsByKey.get(key);
    if (!action) return;
    base.push({
      id: key,
      group,
      label: action.label,
      shortcut: action.hint,
      icon: action.icon,
      inline: INLINE_FORMAT_KEYS.has(key),
      keywords: EXTRA_KEYWORDS[key] ?? '',
      recordRecent: true,
      run: action.run,
    });
  };

  const actionsInGroup = (target: 'basic' | 'blocks' | 'insert' | 'notation') => {
    for (const action of opts.getActions()) {
      if (slashGroupOfFormatKey(action.key) === target) {
        pushFormatKey(action.key, target);
      }
    }
  };

  actionsInGroup('basic');
  actionsInGroup('blocks');

  // Contextual insert entries come first in the Insert group so they are right under the thumb.
  if (taskPos !== null && !inCell) {
    const taskNode = state.doc.nodeAt(taskPos);
    const hasReminder = taskNode ? hasTaskReminderInItem(taskNode) : false;
    base.push({
      id: 'remind',
      group: 'insert',
      label: i18n.t(hasReminder ? 'shell:taskReminder.edit' : 'shell:taskReminder.set'),
      icon: BellSimple,
      inline: true,
      keywords: 'remind reminder alarm due alert notification task',
      recordRecent: false,
      run: () => {
        const currentPos = enclosingTaskItemPos(editor.state, editor.state.selection.from);
        if (currentPos === null) return;
        const dom = editor.view.nodeDOM(currentPos);
        const anchor = dom instanceof HTMLElement ? dom : (editor.view.dom as HTMLElement);
        opts.openReminder(anchor, currentPos);
      },
    });
  }

  if (inCell) {
    const unlocked = opts.proUnlocked();
    base.push({
      id: 'formula',
      group: 'insert',
      label: i18n.t('editor:table.insertFormula'),
      shortcut: '=',
      icon: MathOperations,
      pro: !opts.isPro(),
      inline: true,
      keywords: 'formula sum average math cell =',
      recordRecent: false,
      run: () => {
        if (!unlocked) {
          opts.onUpgrade();
          return;
        }
        const { state: s, view } = editor;
        const $from = s.selection.$from;
        const tr = s.tr.insertText('=', $from.pos, $from.pos);
        tr.setSelection(TextSelection.create(tr.doc, $from.pos + 1));
        view.dispatch(tr.scrollIntoView());
        view.focus();
      },
    });
  }

  actionsInGroup('insert');
  actionsInGroup('notation');

  // Empty query: prepend up to 3 Recent picks that exist in this context, in recent order.
  if (!q) {
    const byId = new Map(base.map((e) => [e.id, e]));
    const recents: SlashMenuEntry[] = [];
    for (const id of readRecentIds(SLASH_RECENT_KEY, SLASH_RECENT_MAX)) {
      const found = byId.get(id);
      if (found) recents.push({ ...found, id: `recent:${found.id}`, group: 'recent' });
    }
    return [...recents, ...base];
  }

  // Non-empty query: rank base entries + direct callout types + smart natural date.
  const match = textMatcher(q);
  const rankedBase = base
    .map((entry, idx) => {
      const labelRank = match(entry.label)?.rank ?? 0;
      const kwRank = Math.max(
        labelRank,
        ...entry.keywords.split(/\s+/).filter(Boolean).map((w) => (match(w)?.rank ?? 0) * 0.9),
      );
      return { entry, idx, rank: kwRank };
    })
    .filter((r) => r.rank > 0);

  // Direct callout types (e.g. `/warn`, `/tip`, `/bug`) from 2 chars so `/c` stays clean.
  const directCallouts: Array<{ entry: SlashMenuEntry; idx: number; rank: number }> = [];
  if (!inCell && q.length >= 2 && actionsByKey.has('callout')) {
    CALLOUT_PICKER_TYPES.forEach((c, i) => {
      const typeName = i18n.t(`editor:callout.types.${c.type}`);
      const rank = Math.max(match(typeName)?.rank ?? 0, match(c.type)?.rank ?? 0);
      if (rank > 0) {
        const type: CalloutType = c.type;
        directCallouts.push({
          idx: 1000 + i,
          rank: rank * 0.95,
          entry: {
            id: `callout:${type}`,
            group: 'blocks',
            label: typeName,
            hint: i18n.t('editor:toolbar.callout'),
            shortcut: `[!${type}]`,
            icon: c.icon,
            inline: false,
            keywords: type,
            recordRecent: false,
            run: () => { editor.chain().focus().insertCallout(type).run(); },
          },
        });
      }
    });
    directCallouts.sort((a, b) => b.rank - a.rank);
    directCallouts.splice(4);
  }

  const combined = [...rankedBase, ...directCallouts]
    .sort((a, b) => b.rank - a.rank || a.idx - b.idx)
    .map((r) => r.entry);

  const smart = resolveSlashSmartDate(q);
  if (smart) {
    combined.unshift({
      id: `smartDate:${smart.iso}`,
      group: 'smartDate',
      label: smart.formatted,
      hint: q,
      icon: CalendarDot,
      inline: true,
      keywords: q,
      recordRecent: false,
      run: () => {
        editor.chain().focus().insertContent({ type: 'text', text: smart.formatted }).run();
      },
    });
  }

  if (combined.length === 0) {
    const openNinja = opts.askNinja();
    if (openNinja && q.length <= ZERO_MATCH_MAX_LEN) {
      return [{
        id: 'ask-ninja',
        group: 'ninja',
        label: i18n.t('editor:slash.askNinja', { query: q }),
        icon: NinjaIcon,
        inline: true,
        keywords: '',
        recordRecent: false,
        run: () => openNinja(q),
      }];
    }
  }

  return combined;
}

/**
 * Execute a picked slash entry:
 * - Ask Ninja leaves or removes `/query` cleanly and opens Ninja prefilled.
 * - Whole-line `/query` deletes `/query` and runs in place on that empty block.
 * - Mid-line inline entries delete `/query` (keeping any space before `/`) and run at the caret.
 * - Mid-line block entries delete `/query` (and a single space before `/`), open a clean
 *   paragraph right below (splitting if text follows), move the caret there, and run.
 */
export function executeSlashEntry(
  editor: Editor,
  range: { from: number; to: number },
  entry: SlashMenuEntry,
): void {
  const { state, view } = editor;
  const $from = state.doc.resolve(range.from);
  const blockStart = $from.start();
  const blockEnd = $from.end();
  const wholeBlock = range.from === blockStart && range.to === blockEnd;

  if (entry.recordRecent) {
    const rawId = entry.id.startsWith('recent:') ? entry.id.slice('recent:'.length) : entry.id;
    noteRecentId(SLASH_RECENT_KEY, rawId, SLASH_RECENT_MAX);
  }

  if (entry.group === 'ninja') {
    const cutFrom = range.from > blockStart && state.doc.textBetween(range.from - 1, range.from) === ' '
      ? range.from - 1
      : range.from;
    const tr = state.tr.delete(cutFrom, range.to).setMeta(SLASH_PLUGIN_KEY, { dismiss: true });
    view.dispatch(tr);
    entry.run();
    return;
  }

  if (wholeBlock || entry.inline) {
    const tr = state.tr.delete(range.from, range.to).setMeta(SLASH_PLUGIN_KEY, { dismiss: true });
    tr.setSelection(TextSelection.create(tr.doc, range.from));
    view.dispatch(tr);
    entry.run();
    return;
  }

  // Mid-line block entry: preserve text on the current line and insert the new block below.
  const cutFrom = range.from > blockStart && state.doc.textBetween(range.from - 1, range.from) === ' '
    ? range.from - 1
    : range.from;
  const cutTo = range.to < blockEnd && state.doc.textBetween(range.to, range.to + 1) === ' '
    ? range.to + 1
    : range.to;
  const hasTrailingText = cutTo < blockEnd;
  const paragraph = state.schema.nodes.paragraph;
  const tr = state.tr.delete(cutFrom, cutTo).setMeta(SLASH_PLUGIN_KEY, { dismiss: true });

  if (paragraph) {
    if (hasTrailingText && cutFrom > blockStart) {
      tr.split(cutFrom);
      const betweenPos = cutFrom + 1;
      const $between = tr.doc.resolve(betweenPos);
      if ($between.parent.canReplaceWith($between.index(), $between.index(), paragraph)) {
        tr.insert(betweenPos, paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, betweenPos + 1));
      }
    } else if (hasTrailingText && cutFrom === blockStart) {
      const beforePos = $from.before();
      const $before = tr.doc.resolve(beforePos);
      if ($before.parent.canReplaceWith($before.index(), $before.index(), paragraph)) {
        tr.insert(beforePos, paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, beforePos + 1));
      }
    } else {
      const afterPos = tr.mapping.map($from.after());
      const $after = tr.doc.resolve(afterPos);
      if ($after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) {
        tr.insert(afterPos, paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, afterPos + 1));
      }
    }
  }

  view.dispatch(tr.scrollIntoView());
  entry.run();
}

/* ------------------------------------------------------------------ */
/* Popup React component (SuggestionPopup + SuggestionItem from ui/)  */
/* ------------------------------------------------------------------ */

interface SlashMenuRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface SlashMenuProps {
  items: SlashMenuEntry[];
  query: string;
  onSelect: (entry: SlashMenuEntry) => void;
  onDismiss: () => void;
}

const GROUP_LABEL_KEY: Record<Exclude<SlashGroup, 'ninja'>, string> = {
  recent: 'common:quickSwitcher.recent',
  smartDate: 'editor:slash.smartDate',
  basic: 'editor:slash.basic',
  blocks: 'editor:insertGroup.blocks',
  insert: 'editor:insertGroup.insert',
  notation: 'editor:insertGroup.notation',
};

const SlashMenuList = forwardRef<SlashMenuRef, SlashMenuProps>(
  ({ items, query, onSelect, onDismiss }, ref) => {
    const { t } = useTranslation('editor');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => setSelectedIndex(0), [items]);

    useEffect(() => {
      listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event: KeyboardEvent) => {
        if (items.length === 0) return false;
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedIndex((i) => (i <= 0 ? items.length - 1 : i - 1));
          return true;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedIndex((i) => (i >= items.length - 1 ? 0 : i + 1));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const picked = items[selectedIndex];
          if (!picked) return false;
          event.preventDefault();
          onSelect(picked);
          return true;
        }
        return false;
      },
    }));

    const showHeaders = !query.trim() || items.some((i) => i.group === 'smartDate');
    const switcherKeys = keyText('quickSwitcher');

    return (
      <SuggestionPopup
        role="listbox"
        aria-label={t('slash.label')}
        className="z-50 flex flex-col w-72 max-w-[calc(100vw-16px)] !max-h-80 !overflow-hidden !py-0"
      >
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-body text-pn-muted">{t('slash.noMatches')}</div>
          ) : (
            items.map((item, idx) => {
              const prev = idx > 0 ? items[idx - 1]! : null;
              const groupChanged = prev !== null && prev.group !== item.group;
              const headerKey = item.group !== 'ninja' ? GROUP_LABEL_KEY[item.group] : null;
              const IconComp = item.icon;
              return (
                <Fragment key={item.id}>
                  {groupChanged && (showHeaders || item.group === 'ninja') && <Divider />}
                  {showHeaders && headerKey && (!prev || prev.group !== item.group) && (
                    <div className={`px-3 pt-1.5 pb-0.5 ${SETTINGS_EYEBROW} !font-normal !text-pn-muted`}>
                      {i18n.t(headerKey)}
                    </div>
                  )}
                  <SuggestionItem
                    active={idx === selectedIndex}
                    onSelect={() => onSelect(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    icon={<IconComp aria-hidden="true" />}
                    label={item.label}
                    hint={item.hint}
                    shortcut={
                      item.pro ? (
                        <ProBadge />
                      ) : item.group === 'ninja' ? (
                        switcherKeys ? <Kbd>{switcherKeys}</Kbd> : undefined
                      ) : item.shortcut ? (
                        <span className="font-mono">{item.shortcut}</span>
                      ) : undefined
                    }
                  />
                </Fragment>
              );
            })
          )}
        </div>
        <div className="shrink-0 bg-surface-2 pb-0.5">
          <div className="-mt-1">
            <Divider />
          </div>
          <SuggestionItem
            active={false}
            onSelect={onDismiss}
            label={<span className="text-small text-pn-muted">{i18n.t('shell:tagsRail.closeMenu')}</span>}
            shortcut={<Kbd>Esc</Kbd>}
          />
        </div>
      </SuggestionPopup>
    );
  },
);
SlashMenuList.displayName = 'SlashMenuList';

function caretRectAt(view: EditorView, pos: number): DOMRect | null {
  try {
    const coords = view.coordsAtPos(pos);
    return new DOMRect(coords.left, coords.top, 0, Math.max(16, coords.bottom - coords.top));
  } catch {
    return null;
  }
}

export const SlashSuggestion = Extension.create<SlashSuggestionOptions>({
  name: 'slashSuggestion',

  addOptions() {
    return {
      getActions: () => [],
      openReminder: () => {},
      isPro: () => false,
      proUnlocked: () => false,
      onUpgrade: () => {},
      askNinja: () => null,
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const opts = this.options;
    const rendererRef: { current: ReactRenderer<SlashMenuRef> | null } = { current: null };

    return [
      new Plugin<SlashSession | null>({
        key: SLASH_PLUGIN_KEY,

        state: {
          init: () => null,
          apply(tr, prev, oldState, newState): SlashSession | null {
            if (!editor.isEditable) return null;
            const meta = tr.getMeta(SLASH_PLUGIN_KEY) as { dismiss?: boolean } | undefined;
            if (meta?.dismiss) return null;

            if (prev === null) {
              if (!isSingleTypedSlash(tr, oldState, newState)) return null;
              const slashPos = oldState.selection.from;
              return allowSlashStart(newState, slashPos) ? { from: slashPos } : null;
            }

            if (!newState.selection.empty) return null;
            const from = tr.mapping.map(prev.from, -1);
            const to = newState.selection.from;
            if (from < 0 || to < from + 1 || to > newState.doc.content.size) return null;
            if (newState.doc.textBetween(from, from + 1, '\n', '\0') !== '/') return null;

            const $from = newState.doc.resolve(from);
            const $to = newState.doc.resolve(to);
            if (!$from.sameParent($to) || !$from.parent.isTextblock) return null;

            const query = newState.doc.textBetween(from + 1, to, '\n', '\0');
            if (query.includes('\n') || query.includes('\0')) return null;
            if (/^\s/.test(query)) return null;
            if (query.includes('/')) return null;
            if (/\s{2}/.test(query)) return null;

            if (query.length > 0) {
              const entries = buildSlashEntries(editor, newState, from, query, opts);
              const realMatch = entries.some((e) => e.group !== 'ninja');
              if (!realMatch) {
                if (/\s$/.test(query)) return null;
                if (query.length > ZERO_MATCH_MAX_LEN) return null;
              }
            }

            return { from };
          },
        },

        props: {
          handleKeyDown(view, event) {
            const session = SLASH_PLUGIN_KEY.getState(view.state);
            if (!session) return false;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch(view.state.tr.setMeta(SLASH_PLUGIN_KEY, { dismiss: true }));
              return true;
            }
            return rendererRef.current?.ref?.onKeyDown(event) ?? false;
          },

          decorations(state) {
            const session = SLASH_PLUGIN_KEY.getState(state);
            if (!session) return undefined;
            const to = state.selection.from;
            if (to < session.from + 1 || to > state.doc.content.size) return undefined;
            const decos: Decoration[] = [
              Decoration.inline(session.from, to, { class: 'pn-slash-active' }),
            ];
            if (to === session.from + 1) {
              const hintText = i18n.t('editor:slash.filterHint');
              decos.push(
                Decoration.widget(
                  to,
                  () => {
                    const span = document.createElement('span');
                    span.className = 'pn-slash-hint';
                    span.setAttribute('aria-hidden', 'true');
                    span.textContent = hintText;
                    return span;
                  },
                  { side: 1, key: `slash-hint:${hintText}` },
                ),
              );
            }
            return DecorationSet.create(state.doc, decos);
          },
        },

        view(editorView) {
          let popup: HTMLDivElement | null = null;
          let component: ReactRenderer<SlashMenuRef> | null = null;
          let destroyed = false;

          const dismiss = () => {
            if (!SLASH_PLUGIN_KEY.getState(editorView.state)) return;
            editorView.dispatch(editorView.state.tr.setMeta(SLASH_PLUGIN_KEY, { dismiss: true }));
          };

          const onPointerDownOutside = (e: PointerEvent) => {
            if (!popup) return;
            const target = e.target as Node | null;
            if (target && popup.contains(target)) return;
            dismiss();
          };

          const onBlur = (e: FocusEvent) => {
            const next = e.relatedTarget as Node | null;
            if (popup && next && popup.contains(next)) return;
            cleanupPopup();
          };

          const reposition = () => {
            if (!popup) return;
            const session = SLASH_PLUGIN_KEY.getState(editorView.state);
            if (!session) return;
            const rect = caretRectAt(editorView, session.from);
            if (rect) placeAtCaret(popup, rect);
          };

          function mountPopup(props: SlashMenuProps, slashPos: number) {
            component = new ReactRenderer(SlashMenuList, { props, editor });
            rendererRef.current = component;
            popup = document.createElement('div');
            popup.style.position = 'absolute';
            popup.style.zIndex = '9999';
            popup.addEventListener('mousedown', (e) => e.preventDefault());
            popup.appendChild(component.element);
            document.body.appendChild(popup);
            const rect = caretRectAt(editorView, slashPos);
            if (rect) placeAtCaret(popup, rect);
            document.addEventListener('pointerdown', onPointerDownOutside, true);
            window.addEventListener('scroll', reposition, true);
            window.addEventListener('resize', reposition);
            editorView.dom.addEventListener('focusout', onBlur);
          }

          function cleanupPopup() {
            document.removeEventListener('pointerdown', onPointerDownOutside, true);
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
            editorView.dom.removeEventListener('focusout', onBlur);
            rendererRef.current = null;
            component?.destroy();
            component = null;
            if (popup) {
              popup.remove();
              popup = null;
            }
          }

          const syncView = () => {
            const session = SLASH_PLUGIN_KEY.getState(editorView.state);
            if (!session || !editor.isEditable) {
              cleanupPopup();
              return;
            }
            if (!smartDateDeps) {
              void ensureSlashSmartDateLoaded(() => {
                if (!destroyed && SLASH_PLUGIN_KEY.getState(editorView.state)) syncView();
              });
            }
            const from = session.from;
            const to = editorView.state.selection.from;
            const query = editorView.state.doc.textBetween(from + 1, to, '\n', '\0');
            const items = buildSlashEntries(editor, editorView.state, from, query, opts);
            const props: SlashMenuProps = {
              items,
              query,
              onSelect: (entry) => executeSlashEntry(editor, { from, to: editorView.state.selection.from }, entry),
              onDismiss: dismiss,
            };
            if (!component) {
              mountPopup(props, from);
            } else {
              component.updateProps(props);
              reposition();
            }
          };

          syncView();
          return {
            update: syncView,
            destroy: () => {
              destroyed = true;
              cleanupPopup();
            },
          };
        },
      }),
    ];
  },
});
