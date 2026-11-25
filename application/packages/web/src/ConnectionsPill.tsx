import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Graph } from './icons';
import type { LocalNote } from './db';
import type { FolderDef } from './folders';
import type { ItemStyles } from './itemStyles';
import { EditorSlotPill } from './EditorSlotPill';
import { registerEditorCommand } from './editorCommands';
import { keyText } from './shortcutMatch';
import { deriveDisplayTitle } from './notesViewUtils';
import { linkResolver, linksInBody, suggestedLinksInBody, type FileUse, type LinkIndex } from './connectionsIndex';
import type { ConnectionLists, LinkActions, MeaningDoor, RelatedWhy } from './ConnectionsPanel';
import type { RelatedLinks, RelatedReason } from './relatedNotes';
import { relatedModule, suggestionPairKey } from './relatedLoader';
import { listOf } from './scheduleText';
import { meaningHits } from './onDeviceAi';
import { hiddenPairs } from './dismissedSuggestions';
import { buildMentionIndex, mentionsIn } from './mentions';
import { hasStructuredBody, noteLinkName } from './notesViewUtils';

/** At most this many items named in the note lead the suggestions. */
const MAX_MENTIONS = 5;

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
  fileUse,
  relatedIndexVersion,
  linkSuggestions,
  dismissedSuggestions,
  liveBody,
  onHideSuggestions,
  linkActions,
  onDismissSuggestion,
  onRestoreSuggestion,
  meaningDoor,
  itemStyles,
  folders,
  isPro,
  onOpenFullGraph,
  pinnedCenterId,
  onPinnedCenterChange,
  isNoteLocked,
  onOpen,
  open,
  onOpenChange,
  tabIndex,
  idle = false,
}: {
  note: LocalNote;
  notes: readonly LocalNote[];
  index: LinkIndex;
  /**
   * For a file item, the notes that use it (#852): those that hold its file
   * and those that link to it. The panel lists them as "Used in".
   */
  fileUse?: FileUse;
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
  itemStyles: ItemStyles;
  folders: readonly FolderDef[];
  isPro: boolean;
  onOpenFullGraph: (focusNoteId: string) => void;
  pinnedCenterId?: string | null;
  onPinnedCenterChange?: (id: string | null) => void;
  isNoteLocked: (n: LocalNote) => boolean;
  onOpen: (n: LocalNote) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabIndex?: number;
  /** The other side of two items side by side: the key stays with the
   *  focused side. Spec: docs/internal/specs/side-by-side-notes.md (section 6) */
  idle?: boolean;
}) {
  const { t } = useTranslation('notes');
  const [localPinnedId, setLocalPinnedId] = useState<string | null>(null);
  const pinnedId = onPinnedCenterChange ? (pinnedCenterId ?? null) : localPinnedId;
  const setPinnedId = onPinnedCenterChange ?? setLocalPinnedId;
  useEffect(() => {
    if (!open && pinnedId !== null) setPinnedId(null);
  }, [open, pinnedId, setPinnedId]);

  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const gatedKey = notes.filter(isNoteLocked).map((n) => n.id).join(' ');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isNoteLocked changes identity every render; gatedKey carries what it reads.
  const resolver = useMemo(() => linkResolver(notes, (n) => noteLinkName(n, isNoteLocked(n))), [notes, gatedKey]);
  // The items a note can suggest by name (mentions.ts): every item that is
  // not markdown (a contact, a bookmark, a vault item, a drawing), never one
  // behind a PIN. Only the name is read.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isNoteLocked changes identity every render; gatedKey carries what it reads.
  const mentionIndex = useMemo(() => buildMentionIndex(
    notes
      .filter((n) => hasStructuredBody(n.type) && n.pinProtected !== 1 && !isNoteLocked(n))
      .map((n) => ({ id: n.id, name: noteLinkName(n) })),
  ), [notes, gatedKey]);
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
      !!n && n.trashed === 0 && n.pinProtected !== 1 && !isNoteLocked(n);
    const isListable = (id: string) => { const n = byId.get(id); return mayList(n) && !hasStructuredBody(n.type) && !dismissed.has(suggestionPairKey(note.id, id)); };
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
    // Items the note names come first: a name is the strongest reason. Then
    // the ranking of notes (words, links, tags, meaning).
    const mentioned = !ranking || !suggests
      ? []
      : mentionsIn(ranking.plainNoteText(liveNote), mentionIndex, new Set([note.id, ...out.ids]))
        .filter((m) => !dismissed.has(suggestionPairKey(note.id, m.id)))
        .slice(0, MAX_MENTIONS)
        .map((m) => {
          const sentence = t('connections.relatedMention', { name: m.name });
          return { note: byId.get(m.id)!, why: { kind: 'mention' as const, text: sentence, sentence } };
        });
    const related = !ranking || !suggests
      ? []
      : [...mentioned, ...ranking.relatedNotes(liveNote, links, isListable, (skip, limit) => meaningHits(liveNote, skip, limit)).map((hit) => ({ note: byId.get(hit.id)!, why: whyOf(hit.reason) }))];
    return {
      from: pick(fileUse ? fileUse.ids : index.incoming.get(note.id)),
      usedIn: !!fileUse,
      to: pick(out.ids),
      suggestedTo: suggestedLinksInBody(liveBody, note.id, resolver),
      missing: out.missing,
      hidden: fileUse ? fileUse.hidden : index.protectedIncoming.get(note.id) ?? 0,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isNoteLocked changes identity every render; gatedKey carries what it reads.
  }, [index, fileUse, byId, resolver, mentionIndex, note, liveBody, relatedIndexVersion, linkSuggestions, dismissedSuggestions, gatedKey, t]);

  const pinnedNote = useMemo(() => {
    if (!open || !pinnedId) return null;
    const found = byId.get(pinnedId);
    if (!found || found.trashed !== 0 || found.pinProtected === 1 || isNoteLocked(found)) return null;
    return found;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isNoteLocked changes identity every render; gatedKey carries what it reads.
  }, [open, pinnedId, byId, gatedKey]);
  const activeCenterNote = pinnedNote ?? note;
  const effectiveIndex = useMemo((): LinkIndex => {
    if (!open) return index;
    const outgoing = new Map(index.outgoing);
    outgoing.set(note.id, linksInBody(liveBody, note.id, resolver));
    return {
      incoming: index.incoming,
      protectedIncoming: index.protectedIncoming,
      outgoing,
    };
  }, [open, index, note.id, liveBody, resolver]);
  const centerRelated = useMemo((): { note: LocalNote; why: RelatedWhy }[] => {
    if (!open) return [];
    if (activeCenterNote.id === note.id) return lists.related;
    const ranking = relatedModule();
    if (!ranking || !linkSuggestions || hasStructuredBody(activeCenterNote.type) || isNoteLocked(activeCenterNote)) return [];
    const dismissed = hiddenPairs(dismissedSuggestions);
    const isListable = (id: string) => {
      const n = byId.get(id);
      return !!n && n.trashed === 0 && n.pinProtected !== 1 && !isNoteLocked(n) && !hasStructuredBody(n.type) && !dismissed.has(suggestionPairKey(activeCenterNote.id, id));
    };
    const links: RelatedLinks = {
      incoming: effectiveIndex.incoming,
      outgoing: { get: (id) => effectiveIndex.outgoing.get(id) },
    };
    return ranking
      .relatedNotes(activeCenterNote, links, isListable, (skip, limit) => meaningHits(activeCenterNote, skip, limit))
      .map((hit) => ({
        note: byId.get(hit.id)!,
        why: { kind: 'meaning' as const, text: '', sentence: '' },
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isNoteLocked changes identity every render; gatedKey carries what it reads.
  }, [open, activeCenterNote, note.id, lists.related, linkSuggestions, dismissedSuggestions, byId, effectiveIndex, relatedIndexVersion, gatedKey]);

  const shown = lists.from.length + lists.to.length + lists.missing.length + lists.related.length + lists.notRelated.length;
  const visible = shown + lists.hidden > 0 || (open && pinnedNote !== null);

  // The key (Mod+Shift+X) runs this toggle, and only while the pill is on screen.
  useEffect(() => {
    if (!visible || idle) return;
    return registerEditorCommand('connections', () => onOpenChange(!open));
  }, [visible, idle, open, onOpenChange]);

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
      <ConnectionsPanel
        lists={lists}
        centerNote={activeCenterNote}
        notes={notes}
        linkIndex={effectiveIndex}
        itemStyles={itemStyles}
        folders={folders}
        centerRelated={centerRelated}
        pinned={pinnedNote !== null}
        pinnedTitle={pinnedNote ? deriveDisplayTitle(pinnedNote, isNoteLocked(pinnedNote)) : null}
        onTogglePin={() => setPinnedId(pinnedNote ? null : activeCenterNote.id)}
        isPro={isPro}
        onOpenFullGraph={onOpenFullGraph}
        onHideSuggestions={onHideSuggestions}
        linkActions={linkActions}
        onDismissSuggestion={onDismissSuggestion}
        onRestoreSuggestion={onRestoreSuggestion}
        meaningDoor={meaningDoor}
        isNoteLocked={isNoteLocked}
        onOpen={onOpen}
        onClose={() => { setPinnedId(null); onOpenChange(false); }}
      />
    </Suspense>
  );
}
