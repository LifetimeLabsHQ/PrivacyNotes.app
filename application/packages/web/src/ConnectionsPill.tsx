import { Suspense, lazy, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Graph } from './icons';
import type { LocalNote } from './db';
import { EditorSlotPill } from './EditorSlotPill';
import { registerEditorCommand } from './editorCommands';
import { keyText } from './shortcutMatch';
import { deriveDisplayTitle } from './notesViewUtils';
import { linkResolver, linksInBody, type LinkIndex } from './connectionsIndex';
import type { ConnectionLists, LinkActions, MeaningDoor, RelatedWhy } from './ConnectionsPanel';
import type { RelatedLinks, RelatedReason } from './relatedNotes';
import { relatedModule, suggestionPairKey } from './relatedLoader';
import { listOf } from './scheduleText';
import { meaningHits } from './onDeviceAi';
import { hiddenPairs } from './dismissedSuggestions';
import { hasStructuredBody, noteLinkName } from './notesViewUtils';

const ConnectionsPanel = lazy(() => import('./ConnectionsPanel').then((m) => ({ default: m.ConnectionsPanel })));

/**
 * The Connections pill in the editor's corner slot: the notes that link to
 * the open item, the items it links to, and the notes related to it
 * (relatedNotes.ts). Like every pill in that slot it
 * takes itself away when it has nothing to say, so a note with no links
 * shows nothing. Open, it becomes the panel in the same place, as the outline
 * does; the editor keeps one panel open at a time.
 * Spec: docs/internal/issues/0351.md (Spec)
 */
export function ConnectionsPill({
  note,
  notes,
  index,
  relatedIndexVersion,
  linkSuggestions,
  dismissedSuggestions,
  liveBody,
  onHideSuggestions,
  linkActions,
  onDismissSuggestion,
  onRestoreSuggestion,
  meaningDoor,
  isNoteLocked,
  onOpen,
  open,
  onOpenChange,
  tabIndex,
}: {
  note: LocalNote;
  notes: readonly LocalNote[];
  index: LinkIndex;
  /** Bumps after each write to the related-notes index. */
  relatedIndexVersion: number;
  /** The Link suggestions setting: off, no related notes and the old pill. */
  linkSuggestions: boolean;
  /** "Not related" pairs with their versions (dismissedSuggestions.ts); a hidden pair is not suggested. */
  dismissedSuggestions: readonly string[];
  /**
   * The open note's text as the editor holds it now. A save of the open note
   * does not refresh the notes state (useNoteEditing keeps typing fast), so
   * the index lags; the open note's own links are read from this instead.
   */
  liveBody: string;
  onHideSuggestions: () => void;
  /** How a suggestion becomes a link; absent when the open note is read-only. */
  linkActions?: LinkActions;
  onDismissSuggestion: (n: LocalNote) => void;
  /** Undo or Restore: suggests the pair again. */
  onRestoreSuggestion: (n: LocalNote) => void;
  /** The panel's line that offers the meaning model (Offline AI). */
  meaningDoor: MeaningDoor;
  isNoteLocked: (n: LocalNote) => boolean;
  onOpen: (n: LocalNote) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabIndex?: number;
}) {
  const { t } = useTranslation('notes');

  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isNoteLocked changes identity every render; the names it gates follow `notes`.
  const resolver = useMemo(() => linkResolver(notes, (n) => noteLinkName(n, isNoteLocked(n))), [notes]);
  const lists = useMemo((): ConnectionLists => {
    const pick = (ids: readonly string[] | undefined) =>
      (ids ?? [])
        .map((id) => byId.get(id))
        .filter((n): n is LocalNote => !!n)
        .sort((a, b) => deriveDisplayTitle(a, isNoteLocked(a)).localeCompare(deriveDisplayTitle(b, isNoteLocked(b))));
    const liveNote = { ...note, body: liveBody };
    const out = linksInBody(liveBody, note.id, resolver);
    const links: RelatedLinks = {
      incoming: index.incoming,
      outgoing: { get: (id) => (id === note.id ? out : index.outgoing.get(id)) },
    };
    // A related note must be one the panel may show: live, markdown, not
    // behind a PIN. The index holds only such notes, but a link signal can
    // reach any item.
    const dismissed = hiddenPairs(dismissedSuggestions);
    const mayList = (n: LocalNote | undefined): n is LocalNote =>
      !!n && n.trashed === 0 && !hasStructuredBody(n.type) && n.pinProtected !== 1 && !isNoteLocked(n);
    const isListable = (id: string) => mayList(byId.get(id)) && !dismissed.has(suggestionPairKey(note.id, id));
    const titleOf = (id: string) => {
      const n = byId.get(id);
      return n ? deriveDisplayTitle(n, isNoteLocked(n)) : '';
    };
    const whyOf = (reason: RelatedReason): RelatedWhy => {
      switch (reason.kind) {
        case 'words': {
          const words = listOf(reason.words);
          return { kind: 'words', text: words, sentence: t('connections.relatedWords', { words }) };
        }
        case 'linksTo': {
          const title = titleOf(reason.via);
          return { kind: 'link', text: title, sentence: t('connections.relatedLinksTo', { title }) };
        }
        case 'linkedFrom': {
          const title = titleOf(reason.via);
          return { kind: 'link', text: title, sentence: t('connections.relatedLinkedFrom', { title }) };
        }
        case 'tag': return { kind: 'tag', text: reason.tag, sentence: t('connections.relatedTag', { tag: reason.tag }) };
        case 'meaning': {
          const sentence = t('connections.relatedMeaning');
          return { kind: 'meaning', text: sentence, sentence };
        }
      }
    };
    // The ranking module loads with the first index build; until then, none.
    const ranking = relatedModule();
    const suggests = linkSuggestions && !hasStructuredBody(note.type) && !isNoteLocked(note);
    const related = !ranking || !suggests
      ? []
      : ranking.relatedNotes(liveNote, links, isListable, (skip, limit) => meaningHits(liveNote, skip, limit)).map((hit) => ({ note: byId.get(hit.id)!, why: whyOf(hit.reason) }));
    return {
      from: pick(index.incoming.get(note.id)),
      to: pick(out.ids),
      missing: out.missing,
      hidden: index.protectedIncoming.get(note.id) ?? 0,
      related,
      // The pairs of this note marked "Not related", so Restore can bring one back.
      notRelated: suggests
        ? [...dismissed].flatMap((key) => {
          const [a, b] = key.split('|');
          const other = a === note.id ? b : b === note.id ? a : undefined;
          const n = other ? byId.get(other) : undefined;
          return mayList(n) ? [n] : [];
        })
        : [],
    };
    // isNoteLocked changes identity every render; the titles it gates follow `notes`.
    // The open note's own text is read through `note`, so a save re-scores it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, byId, resolver, note, liveBody, relatedIndexVersion, linkSuggestions, dismissedSuggestions, t]);

  const shown = lists.from.length + lists.to.length + lists.missing.length + lists.related.length + lists.notRelated.length;
  const visible = shown + lists.hidden > 0;

  // The key (Mod+Shift+X) runs this toggle, and only while the pill is on screen.
  useEffect(() => {
    if (!visible) return;
    return registerEditorCommand('connections', () => onOpenChange(!open));
  }, [visible, open, onOpenChange]);

  if (!visible) return null;

  if (!open) {
    return (
      <EditorSlotPill label={t('connections.title')} keys={keyText('connections')} onClick={() => onOpenChange(true)} tabIndex={tabIndex}>
        <Graph />
      </EditorSlotPill>
    );
  }

  return (
    <Suspense fallback={null}>
      <ConnectionsPanel lists={lists} onHideSuggestions={onHideSuggestions} linkActions={linkActions} onDismissSuggestion={onDismissSuggestion} onRestoreSuggestion={onRestoreSuggestion} meaningDoor={meaningDoor} isNoteLocked={isNoteLocked} onOpen={onOpen} onClose={() => onOpenChange(false)} />
    </Suspense>
  );
}
