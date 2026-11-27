import { PILLAR_GLYPHS, type Icon } from './icons';

/** The types that wear a corner mark. The vault stays bare (section 78). */
export type ItemMark = 'link' | 'note' | 'task' | 'journal' | 'event' | 'drawing' | 'file' | 'contact';

/** The sidebar glyph each type wears, so a row names its type with the very
 *  icon its list has in the sidebar. Spec: docs/internal/design/ui-patterns.md
 *  section 78 */
const MARK_GLYPHS: Record<ItemMark, Icon> = {
  link: PILLAR_GLYPHS.bookmarks,
  note: PILLAR_GLYPHS.notes,
  task: PILLAR_GLYPHS.tasks,
  journal: PILLAR_GLYPHS.journals,
  event: PILLAR_GLYPHS.calendar,
  drawing: PILLAR_GLYPHS.drawings,
  file: PILLAR_GLYPHS.files,
  contact: PILLAR_GLYPHS.contacts,
};

export function isItemMark(kind: string): kind is ItemMark {
  return Object.prototype.hasOwnProperty.call(MARK_GLYPHS, kind);
}

/** The type mark: the type's glyph as a faint watermark behind the item's end.
 *  It takes no room, so the title, the date and the buttons keep their places.
 *  See `.pn-watermark` in index.css. */
export function TypeMark({ mark }: { mark: ItemMark }) {
  const Glyph = MARK_GLYPHS[mark];
  return (
    <span data-slot="mark" data-mark={mark} className="pn-watermark" aria-hidden="true">
      <Glyph size="100%" />
    </span>
  );
}
