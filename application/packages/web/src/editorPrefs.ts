import { useSyncExternalStore } from 'react';
import { isDemoMode } from './demo';
import { createListeners } from './listeners';
import { hasLiveSignIn, signOutMarkLeft } from './liveSignIn';
import { readFlag } from './localStore';
import { isTrustedDevice } from './trustStorage';

const TOOLBAR_PREF_KEY = 'privacynotes.editor.toolbarVisible';

export function readToolbarPref(): boolean {
  try {
    const v = localStorage.getItem(TOOLBAR_PREF_KEY);
    if (v === null) return true; // default: visible
    return v === '1';
  } catch {
    return true;
  }
}

export function writeToolbarPref(visible: boolean) {
  try {
    localStorage.setItem(TOOLBAR_PREF_KEY, visible ? '1' : '0');
  } catch {
    /* ignore */
  }
}

// Where the format bar sits on a touch screen: at the top of the note, or at
// the bottom, above the keyboard. Per device, since a phone and a tablet can
// want different things. Spec: docs/internal/specs/format-bar.md (section 7)
const BAR_POSITION_KEY = 'privacynotes.editor.barPosition';
export type BarPosition = 'top' | 'bottom';

export function readBarPositionPref(): BarPosition {
  try {
    return localStorage.getItem(BAR_POSITION_KEY) === 'bottom' ? 'bottom' : 'top';
  } catch {
    return 'top';
  }
}

export function writeBarPositionPref(position: BarPosition) {
  try {
    localStorage.setItem(BAR_POSITION_KEY, position);
  } catch {
    /* ignore */
  }
}

// Spec: docs/internal/design/ui-patterns.md (outline panel) - remember the outline open/closed
// choice across notes and sessions, like the toolbar visibility pref.
const OUTLINE_PREF_KEY = 'privacynotes.editor.outlineOpen';

export function readOutlinePref(): boolean {
  try {
    return localStorage.getItem(OUTLINE_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeOutlinePref(open: boolean) {
  try {
    localStorage.setItem(OUTLINE_PREF_KEY, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * Line numbers (GitHub #727 follow-up): the Markdown view numbers each line
 * of the text, and the formatted view and the split view's preview show the
 * number of the line each block starts on. Device-local and off by default,
 * like the outline; it names no note, so a sign-out keeps it. A store, so
 * every view that draws numbers turns them on together.
 * Spec: docs/internal/specs/editor-mode-toggle.md (Line numbers)
 */
const LINE_NUMBERS_KEY = 'privacynotes.editor.lineNumbers';
let lineNumbersOn = readFlag(LINE_NUMBERS_KEY);
const lineNumberListeners = createListeners();

export function setLineNumbersPref(on: boolean) {
  if (on === lineNumbersOn) return;
  lineNumbersOn = on;
  try {
    localStorage.setItem(LINE_NUMBERS_KEY, on ? '1' : '0');
  } catch {
    /* the in-memory flag still holds for this session */
  }
  lineNumberListeners.notify();
}

export function useLineNumbersPref(): boolean {
  return useSyncExternalStore(lineNumberListeners.subscribe, () => lineNumbersOn);
}

/**
 * The formatted preview beside the Markdown view (SourcePreviewPane.tsx), on
 * a pane wide enough for two columns. Device-local like the outline: how
 * this screen lays the view out. Never a value of the synced `editorMode`,
 * which an older client would read as its default and sync back. It names
 * no note, so a sign-out keeps it.
 * Spec: docs/internal/specs/heading-folds-and-source-preview.md (Part 2, decision 1)
 */
const SOURCE_PREVIEW_KEY = 'privacynotes.editor.sourcePreview';

export function readSourcePreviewPref(): boolean {
  try {
    return localStorage.getItem(SOURCE_PREVIEW_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSourcePreviewPref(on: boolean) {
  try {
    localStorage.setItem(SOURCE_PREVIEW_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

// Which side the preview takes: the start (the default, the left in a
// left-to-right language: the note as it reads, then its Markdown; owner,
// 2026-11-20) or the end. Device-local like the pref above.
const SOURCE_PREVIEW_FIRST_KEY = 'privacynotes.editor.sourcePreviewFirst';

export function readSourcePreviewFirst(): boolean {
  try {
    return localStorage.getItem(SOURCE_PREVIEW_FIRST_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeSourcePreviewFirst(first: boolean) {
  try {
    localStorage.setItem(SOURCE_PREVIEW_FIRST_KEY, first ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * The swatch last picked from each of the editor's two colour popovers, so
 * the toolbar button can apply it again in one press. GitHub #248.
 *
 * Stored as the swatch NAME, never its value. The highlight palette's
 * default entry carries no colour at all - it serializes as `==text==` -
 * so a stored value cannot express it, and a name still resolves if the
 * palette values are ever re-tuned.
 *
 * Device-local, like the two prefs above. The settings blob takes the
 * remote copy for every scalar field, so a value that changes on each pick
 * would let two devices in one sitting overwrite each other's colour for
 * no gain: a fresh device trains itself on the first swatch its owner
 * picks. Spec: docs/internal/design-decisions.md (remembered editor colours)
 */
export type ColorPrefKind = 'text' | 'highlight';

const COLOR_PREF_KEYS: Record<ColorPrefKind, string> = {
  text: 'privacynotes.editor.lastTextColor',
  highlight: 'privacynotes.editor.lastHighlightColor',
};

export function readColorPref(kind: ColorPrefKind): string | null {
  try {
    return localStorage.getItem(COLOR_PREF_KEYS[kind]);
  } catch {
    return null;
  }
}

export function writeColorPref(kind: ColorPrefKind, name: string) {
  try {
    localStorage.setItem(COLOR_PREF_KEYS[kind], name);
  } catch {
    /* ignore */
  }
}

/**
 * The Kanban board a new insert starts from: the number of columns (3 or 4)
 * and each column's color, taken from the last board inserted or changed on
 * this device. The column names are not remembered: a new board always
 * starts from the default names in the reader's language. Device-local, for
 * the reason the colour picks above are.
 * Spec: docs/internal/issues/0270.md (Spec, remember)
 */
export interface KanbanPref {
  count: 3 | 4;
  colors: string[];
}

const KANBAN_PREF_KEY = 'privacynotes.editor.kanban';

export function readKanbanPref(): KanbanPref | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KANBAN_PREF_KEY) ?? 'null') as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const { count, colors } = raw as { count?: unknown; colors?: unknown };
    if (count !== 3 && count !== 4) return null;
    if (!Array.isArray(colors) || !colors.every((c) => typeof c === 'string')) return null;
    return { count, colors: colors.slice(0, count) };
  } catch {
    return null;
  }
}

export function writeKanbanPref(pref: KanbanPref) {
  try {
    localStorage.setItem(KANBAN_PREF_KEY, JSON.stringify(pref));
  } catch {
    /* ignore */
  }
}

// The Connections panel shares the outline's corner and remembers its
// open/closed choice the same way. Spec: docs/internal/issues/0351.md (Spec)
const CONNECTIONS_PREF_KEY = 'privacynotes.editor.connectionsOpen';

export function readConnectionsPref(): boolean {
  try {
    return localStorage.getItem(CONNECTIONS_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeConnectionsPref(open: boolean) {
  try {
    localStorage.setItem(CONNECTIONS_PREF_KEY, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * The sections folded in each note (heading and list folds, editorFolds.ts),
 * as fold keys. Device-local and never synced: a fold is how this screen
 * shows the note, not a change to it. Bounded by itself to the notes folded
 * most recently, so nothing grows without end. It names note ids, so a
 * sign-out removes it (clearAccountScopedUiState in authStorage.ts), and only
 * a live sign-in on a trusted device outside the demo reads or writes it on
 * disk.
 * Spec: docs/internal/specs/heading-folds-and-source-preview.md (Where the fold state lives)
 */
const FOLDS_KEY = 'privacynotes.editor.folds';
const FOLDS_MAX_NOTES = 500;
const HASHED_FOLD_KEY = /^[0-9a-f]{8}$/;

type FoldRecord = { k: string[]; t: number };

export function canPersistNoteFolds(): boolean {
  return !isDemoMode() && hasLiveSignIn() && signOutMarkLeft() === null && isTrustedDevice();
}

function writeFoldMap(map: Record<string, FoldRecord>) {
  if (!canPersistNoteFolds()) return;
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(FOLDS_KEY);
    } else {
      localStorage.setItem(FOLDS_KEY, JSON.stringify(map));
      if (!canPersistNoteFolds()) localStorage.removeItem(FOLDS_KEY);
    }
  } catch {
    /* ignore */
  }
}

function readFoldMap(): Record<string, FoldRecord> {
  if (!canPersistNoteFolds()) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? 'null') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const map = raw as Record<string, FoldRecord>;
    // Scrub any legacy plaintext fold keys (heading/task words) left from
    // before fold keys were hashed, so no note words stay on disk.
    let scrubbed = false;
    for (const id of Object.keys(map)) {
      const rec = map[id];
      const rawKeys = rec && Array.isArray(rec.k) ? rec.k : [];
      const hashed = rawKeys.filter((k): k is string => typeof k === 'string' && HASHED_FOLD_KEY.test(k));
      if (hashed.length !== rawKeys.length) {
        scrubbed = true;
        if (hashed.length === 0) delete map[id];
        else map[id] = { k: hashed, t: rec?.t ?? 0 };
      }
    }
    if (scrubbed) writeFoldMap(map);
    return map;
  } catch {
    return {};
  }
}

export function readNoteFolds(noteId: string): string[] {
  if (!canPersistNoteFolds()) return [];
  const map = readFoldMap();
  const rec = Object.hasOwn(map, noteId) ? map[noteId] : undefined;
  return rec && Array.isArray(rec.k) ? rec.k.filter((k): k is string => typeof k === 'string' && HASHED_FOLD_KEY.test(k)) : [];
}

/** An empty list forgets the note. */
export function writeNoteFolds(noteId: string, keys: readonly string[]) {
  if (!canPersistNoteFolds()) return;
  const map = readFoldMap();
  const hashed = keys.filter((k) => HASHED_FOLD_KEY.test(k));
  if (hashed.length === 0) {
    if (!Object.hasOwn(map, noteId)) return;
    delete map[noteId];
  } else {
    map[noteId] = { k: hashed, t: Date.now() };
    const ids = Object.keys(map);
    if (ids.length > FOLDS_MAX_NOTES) {
      ids.sort((a, b) => (map[b]!.t || 0) - (map[a]!.t || 0));
      for (const id of ids.slice(FOLDS_MAX_NOTES)) delete map[id];
    }
  }
  writeFoldMap(map);
}
