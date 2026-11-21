import type { MouseEvent } from 'react';
import type { NoteType } from '@notes/shared';
import { VIEW_NOTE_TYPES, type View } from './views';

/**
 * Section lock: a whole sidebar section behind the gate that PIN-protected
 * notes use. The rule is a type check against the list of protected views,
 * never a list of ids, so locking Notes on a large account costs nothing.
 * Spec: docs/internal/specs/section-lock.md
 */

/** The views a person can protect: every view that owns a type, and Trash.
 *  All, Home, Pinned and Archive only gather items from other sections;
 *  Markdown reads the disk and has no PIN-protect (decision S4). */
const PROTECTABLE_VIEWS: readonly View[] = [
  ...(Object.keys(VIEW_NOTE_TYPES) as View[]),
  'trash',
];

export function isProtectableView(view: View): boolean {
  return PROTECTABLE_VIEWS.includes(view);
}

const VIEW_OF_TYPE = new Map<NoteType, View>(
  (Object.entries(VIEW_NOTE_TYPES) as [View, NoteType[]][]).flatMap(([view, types]) =>
    types.map((type) => [type, view] as [NoteType, View]),
  ),
);

/** The section an item belongs to, by its type. */
export function sectionOf(n: { type?: NoteType | null }): View | undefined {
  return VIEW_OF_TYPE.get(n.type ?? 'note');
}

/**
 * Whether an item sits in one of `views`: its own section, or the Trash
 * while it is trashed. Flag level for `protectedViews`; the shut set for
 * the absence filter.
 */
export function inSection(
  n: { type?: NoteType | null; trashed?: number },
  views: ReadonlySet<View> | readonly View[],
): boolean {
  const has = (v: View) => ('has' in views ? views.has(v) : views.includes(v));
  const own = sectionOf(n);
  if (own && has(own)) return true;
  return n.trashed === 1 && has('trash');
}

/** The views whose "New" makes their own type; every other view makes a
 *  plain note (`handleNew` in NotesView.tsx creates this type). */
const NEW_OWN_TYPE: Partial<Record<View, NoteType>> = {
  tasks: 'task',
  journal: 'journal',
  calendar: 'event',
  drawings: 'drawing',
};

/** The type a "New" from `view` creates: a vault item of `vaultType` (a
 *  login by default), the view's own type, or a plain note. */
export function newItemType(view: View, vaultType?: 'login' | 'card' | 'ssh-key'): NoteType {
  if (view === 'vault') return vaultType ?? 'login';
  return NEW_OWN_TYPE[view] ?? 'note';
}

/**
 * Whether the open item keeps the PIN window alive: the open view is an
 * open protected section, or the open item belongs to one, wherever it is
 * open (All, Home, Pinned, a tab). An item of a shut section is never the
 * open one, so a protected section of `selected` is an open one.
 * Spec: docs/internal/specs/section-lock.md (section 7)
 */
export function keepsSectionOpen(
  view: View,
  selected: { type?: NoteType | null; trashed?: number } | null,
  protectedViews: readonly View[],
  shutViews: ReadonlySet<View>,
): boolean {
  if (protectedViews.includes(view) && !shutViews.has(view)) return true;
  return !!selected && inSection(selected, protectedViews.filter((v) => !shutViews.has(v)));
}

/**
 * The shut section a note-link leads into, when every item it names sits
 * in one: the link opens that section's gate, not the "create this note?"
 * prompt, which would make a second item of that title.
 * Spec: docs/internal/specs/section-lock.md (section 5)
 */
export function shutSectionOfLink(
  matches: readonly { type?: NoteType | null; trashed?: number }[],
  shutViews: ReadonlySet<View>,
): View | undefined {
  const hit = matches.find((n) => inSection(n, shutViews));
  if (!hit) return undefined;
  const own = sectionOf(hit);
  return own && shutViews.has(own) ? own : 'trash';
}

/**
 * How one id from the command list or Ctrl+Backspace (`handleTrash` in
 * NotesView.tsx) is trashed. `note` is the view list's item: none means it
 * sits in a shut section, and it is not trashed (beta #137). A read-only item
 * goes to the trash window, which explains; a protected one behind the gate
 * asks for the PIN first.
 * Spec: docs/internal/specs/section-lock.md (section 6)
 */
export type TrashRoute = 'none' | 'explain' | 'pin' | 'trash';
export function trashRoute<N extends { locked?: number; pinProtected?: number }>(
  note: N | undefined,
  isNoteLocked: (n: N) => boolean,
): TrashRoute {
  if (!note) return 'none';
  if (note.locked === 1) return 'explain';
  if (note.pinProtected === 1 && isNoteLocked(note)) return 'pin';
  return 'trash';
}

/** The stored list, with members this build cannot protect left out. The
 *  stored list keeps them, as `hiddenViews` does, so an older client never
 *  drops a newer client's value. */
export function protectedSections(stored: readonly View[] | undefined): View[] {
  return (stored ?? []).filter(isProtectableView);
}

/** A row's lock state: not protected, protected and open, or shut. */
export type SectionState = 'none' | 'open' | 'shut';

/** What a sidebar list needs to draw and drive the section lock. */
export interface SectionLockControls {
  stateOf: (view: View) => SectionState;
  lockNow: (view: View) => void;
  /** The row menu: right-click, long press, the Menu key. */
  openMenu: (e: MouseEvent, view: View) => void;
}
