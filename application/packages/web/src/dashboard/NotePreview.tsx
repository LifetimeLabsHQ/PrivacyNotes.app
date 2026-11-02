/**
 * The note widget's body: one markdown note in a read-only editor, its
 * note-links live. Loaded on demand, so only a person who put a note on Home
 * pays for an editor there.
 *
 * A link opens its note beside Home, the call a row click makes; a heading
 * link, or a link that names this note, opens this note. It never moves the
 * app to another view. A link to a missing or doubled title does nothing
 * here: the open note is where those questions are asked.
 * Spec: docs/internal/specs/dashboard.md (section 5, the note widget)
 */
import { useRef } from 'react';
import type { LocalNote } from '../db';
import { Editor } from '../Editor';
import { setWikiLinkNavigator } from '../NoteLink';
import { noteLinkKey, parseNoteLinkTarget, resolveNoteLinkMatches } from '../noteLinks';
import { noteLinkName } from '../notesViewUtils';

const noop = () => {};

export default function NotePreview({ note, everywhere, isNoteLocked, onOpen }: {
  note: LocalNote;
  everywhere: LocalNote[];
  isNoteLocked: (n: LocalNote) => boolean;
  onOpen: (id: string) => void;
}) {
  // The navigator is written once, when the editor is ready, and reads the
  // latest render's values through this ref at click time.
  const latest = useRef({ note, everywhere, isNoteLocked, onOpen });
  latest.current = { note, everywhere, isNoteLocked, onOpen };
  return (
    <Editor
      value={note.body}
      onChange={noop}
      readOnly
      preview
      onReady={(editor) =>
        setWikiLinkNavigator(editor, (target) => {
          const { note: self, everywhere: all, isNoteLocked: gated, onOpen: open } = latest.current;
          const keys = new Set(all.map((n) => noteLinkKey(noteLinkName(n, gated(n)))));
          const { note: name } = parseNoteLinkTarget(target, (k) => keys.has(noteLinkKey(k)));
          if (name === '') return open(self.id);
          const matches = resolveNoteLinkMatches(all, name, noteLinkName);
          if (matches.length === 1) open(matches[0]!.id);
        })
      }
    />
  );
}
