import type { NoteType } from '@notes/shared';
import type { AutoLocationType } from './autoLocation';

/** What a note type gets, answered once for every file that asks. */
export interface NoteTypeTraits {
  /** What the body holds: markdown the editor writes, or a JSON document a
   *  form owns (a bookmark's `{url}`, a contact, a login, a card, an SSH key,
   *  a drawing's scene). */
  body: 'markdown' | 'form';
  /** The day the item carries: a journal entry's own date ("Entry date"), a
   *  day the item may be given ("Schedule"), or none. The calendar, the "..."
   *  menu and the header's calendar button read it.
   *  Spec: docs/internal/specs/calendar-pillar-spec.md */
  dated: 'entry' | 'schedule' | null;
  /** Whether the pane draws the tag row above the body: folder chip, tags
   *  and the place chip, with "Add location" in the "..." menu. */
  tagRow: boolean;
  /** The auto-place switch that fills in this type's place by itself, if any.
   *  Spec: docs/internal/plans/note-location.md (section 3c) */
  autoPlace: AutoLocationType | null;
  /** Whether Translate notes reads the body.
   *  Spec: docs/internal/plans/plugins.md (section 6.5) */
  translate: boolean;
  /** The catalog key of the title field's placeholder. A bookmark shows its
   *  domain first, a contact the name being typed. */
  titleKey: string;
}

/**
 * The traits of each note type. Keyed by the whole `NoteType` union and typed
 * with every field required, so a type added to the union does not build
 * until each trait has a value here. Each row states every trait, with no
 * shared default to spread: a new row copied from a default would take every
 * trait without a decision, so a new type decides each one.
 */
const TYPE_TRAITS: Record<NoteType, NoteTypeTraits> = {
  note: { body: 'markdown', dated: 'schedule', tagRow: true, autoPlace: 'note', translate: true, titleKey: 'notes:editor.titlePlaceholder' },
  task: { body: 'markdown', dated: 'schedule', tagRow: true, autoPlace: null, translate: true, titleKey: 'notes:editor.titlePlaceholder' },
  journal: { body: 'markdown', dated: 'entry', tagRow: true, autoPlace: 'journal', translate: true, titleKey: 'notes:editor.titlePlaceholder' },
  // An event has no tag row: its card above the body holds the schedule.
  event: { body: 'markdown', dated: 'schedule', tagRow: false, autoPlace: null, translate: false, titleKey: 'notes:editor.titlePlaceholder' },
  file: { body: 'markdown', dated: null, tagRow: true, autoPlace: null, translate: false, titleKey: 'notes:editor.titlePlaceholder' },
  link: { body: 'form', dated: null, tagRow: false, autoPlace: null, translate: false, titleKey: 'notes:editor.titlePlaceholderLink' },
  contact: { body: 'form', dated: null, tagRow: false, autoPlace: null, translate: false, titleKey: 'shell:contacts.menuName' },
  login: { body: 'form', dated: null, tagRow: false, autoPlace: null, translate: false, titleKey: 'notes:editor.titlePlaceholderLogin' },
  card: { body: 'form', dated: null, tagRow: false, autoPlace: null, translate: false, titleKey: 'notes:editor.titlePlaceholderCard' },
  'ssh-key': { body: 'form', dated: null, tagRow: false, autoPlace: null, translate: false, titleKey: 'common:sshKeyForm.labelPlaceholder' },
  drawing: { body: 'form', dated: null, tagRow: false, autoPlace: null, translate: false, titleKey: 'notes:editor.titlePlaceholder' },
};

/** What a type this build does not know gets: nothing, and a form body. */
const UNKNOWN_TYPE: NoteTypeTraits = {
  body: 'form', dated: null, tagRow: false, autoPlace: null, translate: false, titleKey: 'notes:editor.titlePlaceholder',
};

/**
 * The traits of a note type. A row with no type is a plain note. A type this
 * build does not know gets nothing: its body counts as a form, so the editor
 * never writes it (see `isKnownNoteType`).
 */
export function traitsOf(type: string | undefined): NoteTypeTraits {
  const key = type ?? 'note';
  return Object.hasOwn(TYPE_TRAITS, key) ? TYPE_TRAITS[key as NoteType] : UNKNOWN_TYPE;
}

/** The markdown pillars: the note types whose body the editor writes. */
export const MARKDOWN_NOTE_TYPES: readonly NoteType[] = (Object.keys(TYPE_TRAITS) as NoteType[])
  .filter((type) => TYPE_TRAITS[type].body === 'markdown');

/**
 * Whether this build knows the note type. A newer build can add a pillar, and
 * its items reach this one through sync with their type intact; the editor
 * pane opens such an item as a notice, because this build cannot read its
 * body. A row with no type is a plain note.
 */
export function isKnownNoteType(type: string | undefined): boolean {
  return Object.hasOwn(TYPE_TRAITS, type ?? 'note');
}

/**
 * The types an item can be converted to from the "..." menu. A file is a
 * source and never a target: its body holds one attachment that the editor
 * draws as a file card, and a note with none or several has no such card.
 * Spec: docs/internal/specs/convert-type.md
 */
export const CONVERT_TARGETS = ['note', 'task', 'journal', 'event'] as const;
export type ConvertTarget = (typeof CONVERT_TARGETS)[number];

/** Whether the "..." menu offers Convert to: the editor writes the body. */
export function isConvertSource(type: string | undefined): boolean {
  return traitsOf(type).body === 'markdown';
}

/**
 * The patch that converts an item. Only `type` changes, and no field is
 * removed but one, so converting back restores the item. An item that
 * becomes a journal entry or an event with no day takes `today` (a local ISO
 * day): the journal fallback, the UTC day of createdAt, would file its
 * tracker values under the day the item was made, and an event lives on the
 * calendar. An event that becomes anything else loses its repeat, because a
 * series is an event; the Convert to view says so.
 * Spec: docs/internal/specs/convert-type.md, docs/internal/specs/calendar-pillar-spec.md (decision 10)
 */
export function convertPatch(
  trackers: Record<string, unknown> | undefined,
  target: ConvertTarget,
  today: string,
): { type: ConvertTarget; trackers?: Record<string, unknown> } {
  const existing = trackers ?? {};
  let next = existing;
  if ((target === 'journal' || target === 'event') && typeof existing.journalDate !== 'string') {
    next = { ...next, journalDate: today };
  }
  if (target !== 'event' && 'repeat' in next) {
    const { repeat: _repeat, ...rest } = next;
    next = rest;
  }
  return next === existing ? { type: target } : { type: target, trackers: next };
}
