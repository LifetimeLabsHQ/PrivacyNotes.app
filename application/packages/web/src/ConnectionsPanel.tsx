import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, At, ArrowsIn, ArrowsOut, Asterisk, CaretDown, CaretRight, CursorText, EyeSlash, FileDashed, Graph, Hash, Intersect, LinkSimple, LockSimple, Sparkle, TextAa, X } from './icons';
import { IconButton, Snackbar } from './ui';
import type { LocalNote } from './db';
import type { LinkIndex } from './connectionsIndex';
import type { FolderDef } from './folders';
import type { ItemStyles } from './itemStyles';
import { EditorSlotPanel, SLOT_BADGE, SLOT_PANEL_ROW } from './EditorSlotPill';
import { OverflowTip } from './OverflowTip';
import { keyText } from './shortcutMatch';
import { typeGlyph } from './NoteRow';
import { deriveDisplayTitle } from './notesViewUtils';
import { PathGlyph, useItemLook } from './looks/LookGlyph';
import { ProBadge } from './OptionsMenu';
import { isDemoMode } from './demo';
import { useTheme } from './theme';
import { buildLocalGraph, isSyntheticGraphId } from './graph/graphModel';
import { closeMeaningDoor, laterMeaningDoor, meaningDoorClosed, onDeviceAiShown, reopenMeaningDoor, useMeaningState } from './onDeviceAi';

const LocalGraphCardLazy = lazy(() => import('./graph/LocalGraphCard').then((m) => ({ default: m.LocalGraphCard })));

/** What the panel lists for the open item (ConnectionsPill works it out). */
export type ConnectionLists = {
  from: LocalNote[];
  /** The open item is a file: `from` lists the notes that use it, titled "Used in" (#852). */
  usedIn: boolean;
  to: LocalNote[];
  /** Ids in `to` whose link was added from Suggested connections. */
  suggestedTo: ReadonlySet<string>;
  missing: string[];
  hidden: number;
  /** Notes about the same thing that no link joins, each with why (relatedNotes.ts). */
  related: { note: LocalNote; why: RelatedWhy }[];
  /** This note's pairs marked "Not related", for Restore (dismissedSuggestions.ts). */
  notRelated: LocalNote[];
};

/**
 * Why a note is a link suggestion: an icon for the kind of reason, the short
 * text beside it (a title, the shared words, a tag) and the whole sentence
 * ("Both link to X") for the tooltip and screen readers.
 */
export type RelatedWhy = { kind: 'words' | 'link' | 'tag' | 'meaning' | 'mention'; text: string; sentence: string };

const WHY_ICON = { words: TextAa, link: LinkSimple, tag: Hash, meaning: Sparkle, mention: At } as const;

/**
 * One item in the panel, drawn the way the list draws it: its own icon when
 * it has one, else its type's, and its color at the strength the reader
 * chose (a tinted row, or a colored icon). The tint is a background image,
 * so the hover color still shows under it.
 */
/** How a link suggestion becomes a link (NoteEditorPane). */
export type LinkActions = {
  /** Whether the reader placed a cursor in this note since it opened. */
  cursorPlaced: boolean;
  onAtCursor: (n: LocalNote) => void;
  onAsFootnote: (n: LocalNote) => void;
};

/** The line at the foot of Link suggestions that offers the meaning model. */
export type MeaningDoor = { pro: boolean; onOpen: () => void };

/**
 * "Smart connections: find notes with the same meaning, with offline AI": the
 * one door to Smart connections outside Settings. It opens the Settings row.
 * "Not now" hides it in every note until the app starts again; "Don't show
 * again" hides it on this device for good, with an Undo bar that says where
 * the feature stays. It shows only while the model is off, and never in the
 * demo, which cannot download the model. The shape is ui-patterns.md section 184.
 * Spec: docs/internal/specs/related-notes.md (section 5, "Where it lives")
 */
function MeaningDoorLine({ door }: { door: MeaningDoor }) {
  const { t } = useTranslation('notes');
  const status = useMeaningState().status;
  const [closed, setClosed] = useState(meaningDoorClosed);
  const [undo, setUndo] = useState(false);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(false), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);
  const bar = undo && (
    <Snackbar actionLabel={t('editor.undo')} onAction={() => { reopenMeaningDoor(); setClosed(false); setUndo(false); }}>
      {t('connections.meaningDoorHidden')}
    </Snackbar>
  );
  if (closed || !onDeviceAiShown() || isDemoMode() || (status !== 'off' && status !== 'error')) return bar || null;
  const choice = 'rounded-md py-0.5 text-pn-muted hover:text-pn';
  return (
    <div className="mt-1 border-t border-dashed border-divider px-2 pt-1.5 pb-0.5 text-small">
      <div className="flex items-start gap-2">
        <button type="button" onClick={door.onOpen} className="flex min-w-0 items-start gap-2 rounded-md py-0.5 text-start text-accent hover:underline">
          <Sparkle aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{t('connections.meaningDoor')}</span>
        </button>
        {door.pro && <span className="mt-0.5 shrink-0"><ProBadge /></span>}
      </div>
      {/* Under the offer text, lined up with it rather than with the icon. */}
      <div className="flex flex-wrap gap-x-4 ps-6">
        <button type="button" onClick={() => { laterMeaningDoor(); setClosed(true); }} className={choice}>
          {t('security:biometricTab.bindOfferLater')}
        </button>
        <button type="button" onClick={() => { closeMeaningDoor(); setClosed(true); setUndo(true); }} className={choice}>
          {t('connections.meaningDoorNo')}
        </button>
      </div>
    </div>
  );
}

/** How long Undo stays after "Not related", as the other Undo bars. */
const UNDO_MS = 6000;

/**
 * "Hidden (n)" at the foot of Suggested connections: the notes of this note
 * marked "Not related", folded until opened, each with Restore. Restore
 * suggests the pair again on every device (dismissedSuggestions.ts).
 * The shape is ui-patterns.md section 186.
 * Spec: docs/internal/specs/related-notes.md (section 9, "Not related")
 */
function NotRelatedLine({ notes, title, onRestore }: { notes: LocalNote[]; title: (n: LocalNote) => string; onRestore: (n: LocalNote) => void }) {
  const { t } = useTranslation('notes');
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;
  const Caret = open ? CaretDown : CaretRight;
  return (
    <div className="mt-1 border-t border-dashed border-divider px-2 pt-1.5 pb-0.5 text-small">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded-md py-0.5 text-pn-muted hover:text-pn">
        <Caret aria-hidden="true" className="shrink-0" />
        {t('connections.notRelatedCount', { n: notes.length })}
      </button>
      {open && (
        <ul className="mt-0.5">
          {notes.map((n) => (
            <li key={n.id} className="flex items-center gap-2 py-0.5 ps-5">
              <OverflowTip text={title(n)} className="min-w-0 flex-1 flex">
                <span className="truncate text-pn-muted" dir="auto">{title(n)}</span>
              </OverflowTip>
              <IconButton label={t('connections.restoreSuggestion')} position="start" onClick={() => onRestore(n)}>
                <ArrowCounterClockwise />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The actions of a link suggestion row. Absent on the other groups. */
type SuggestionActions = { link?: LinkActions; onDismiss: () => void };

function ConnectionRow({ note, title, why, suggested, actions, onOpen }: { note: LocalNote; title: string; why?: RelatedWhy; suggested?: boolean; actions?: SuggestionActions; onOpen: () => void }) {
  const { t } = useTranslation('notes');
  const { iconPaths: paths, row, icon } = useItemLook(note.id, note.tags, note.folderId);
  const { Icon, color } = typeGlyph(note.type);
  const WhyIcon = why ? WHY_ICON[why.kind] : null;
  const iconClass = `shrink-0 ${icon ? '' : actions ? 'text-success' : color}`;
  const button = (
    <button
      type="button"
      onClick={onOpen}
      style={row}
      className={`${SLOT_PANEL_ROW} px-2 text-pn-soft${actions ? ' min-w-0' : ''}`}
    >
      {paths
        ? <PathGlyph paths={paths} size={16} className={iconClass} style={icon} />
        : <Icon aria-hidden="true" className={iconClass} style={icon} />}
      {why ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <OverflowTip text={title} className="flex min-w-0">
            <span className="truncate" dir="auto">{title}</span>
          </OverflowTip>
          <span className="flex min-w-0 items-center gap-1 text-small text-pn-muted">
            {WhyIcon && <WhyIcon aria-hidden="true" className="shrink-0" />}
            <OverflowTip text={why.sentence} className="flex min-w-0">
              <span className="truncate" dir="auto">{why.text}</span>
            </OverflowTip>
            <span className="sr-only">{why.sentence}</span>
          </span>
        </span>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate" dir="auto">{title}</span>
          {suggested && <Sparkle weight="fill" aria-hidden="true" className="ms-auto shrink-0 text-success" />}
        </>
      )}
    </button>
  );
  return (
    <li className={actions ? 'group/row flex items-center gap-0.5' : undefined}>
      {why ? button : <OverflowTip text={title} className="block">{button}</OverflowTip>}
      {actions && (
        // On a device with a mouse the two tools show on hover or focus and
        // take no room otherwise, so a title is cut only while they show. A
        // touch screen has no hover, so there they always show.
        <span className="flex shrink-0 items-center [@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover/row:flex [@media(hover:hover)]:group-focus-within/row:flex">
          {actions.link && (
            <>
              <IconButton
                label={t(actions.link.cursorPlaced ? 'connections.linkAtCursor' : 'connections.linkNeedsCursor')}
                position="start"
                disabled={!actions.link.cursorPlaced}
                className="disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => actions.link?.onAtCursor(note)}
              >
                <CursorText />
              </IconButton>
              <IconButton label={t('connections.linkAsFootnote')} position="start" onClick={() => actions.link?.onAsFootnote(note)}>
                <Asterisk />
              </IconButton>
            </>
          )}
          <IconButton label={t('connections.notRelated')} position="start" onClick={actions.onDismiss}>
            <X />
          </IconButton>
        </span>
      )}
    </li>
  );
}

/**
 * The open Connections panel. A file of its own, loaded the first time a
 * reader opens it: the closed pill is on every note, the panel is not.
 * Spec: docs/internal/issues/0351.md (Spec)
 */
export function ConnectionsPanel({
  lists,
  openNoteId,
  centerNote,
  notes,
  linkIndex,
  itemStyles,
  centerRelated,
  pinned,
  pinnedTitle,
  onTogglePin,
  isPro,
  onOpenFullGraph,
  onHideSuggestions,
  linkActions,
  onDismissSuggestion,
  onRestoreSuggestion,
  meaningDoor,
  isNoteLocked,
  onOpen,
  onClose,
}: {
  lists: ConnectionLists;
  openNoteId?: string;
  centerNote: LocalNote;
  notes: readonly LocalNote[];
  linkIndex: LinkIndex;
  itemStyles: ItemStyles;
  folders?: readonly FolderDef[];
  centerRelated: readonly { note: LocalNote; why: RelatedWhy }[];
  pinned: boolean;
  pinnedTitle: string | null;
  onTogglePin: () => void;
  isPro: boolean;
  onOpenFullGraph: (focusNoteId: string) => void;
  /** Turns the Link suggestions setting off (Settings > Editor turns it back on). */
  onHideSuggestions: () => void;
  /** How a suggestion becomes a link; absent when the open note is read-only. */
  linkActions?: LinkActions;
  /** "Not related": stops suggesting this pair, until Undo or Restore. */
  onDismissSuggestion: (n: LocalNote) => void;
  /** Undo and Restore: suggests the pair again. */
  onRestoreSuggestion: (n: LocalNote) => void;
  meaningDoor: MeaningDoor;
  isNoteLocked: (n: LocalNote) => boolean;
  onOpen: (n: LocalNote) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('notes');
  const { theme } = useTheme();
  const [depth, setDepth] = useState<1 | 2>(1);
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const isVaultCredential = centerNote.type === 'login' || centerNote.type === 'card' || centerNote.type === 'ssh-key';
  const canShowGraph = !isVaultCredential && centerNote.pinProtected !== 1 && !isNoteLocked(centerNote);
  const lockedKey = notes.filter(isNoteLocked).map((n) => n.id).join(' ');
  const localGraph = useMemo(
    () => (canShowGraph
      ? buildLocalGraph(centerNote.id, depth, notes, linkIndex, isNoteLocked, itemStyles, centerRelated)
      : { nodes: [], edges: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isNoteLocked changes identity every render; lockedKey carries what it reads.
    [canShowGraph, centerNote.id, depth, notes, linkIndex, lockedKey, itemStyles, centerRelated],
  );
  const showLocalGraph = canShowGraph && localGraph.nodes.length > 0;
  const centerTitle = deriveDisplayTitle(centerNote, isNoteLocked(centerNote));
  const row = (n: LocalNote, suggested = false) => (
    <ConnectionRow key={n.id} note={n} title={deriveDisplayTitle(n, isNoteLocked(n))} suggested={suggested} onOpen={() => onOpen(n)} />
  );

  // An empty group is left out. Each group carries its direction three ways
  // at once, so no one has to read a label to tell them apart: a side bar, an
  // arrow icon and a color. In (the notes that link here) is the warm color,
  // out (what this note links to) the accent; both follow the theme.
  const group = (
    label: string,
    GroupIcon: typeof ArrowsIn,
    tone: { bar: string; text: string; section?: string; title?: string },
    count: number,
    body: ReactNode,
    action?: ReactNode,
  ) => count === 0 && !body ? null : (
    <section className={`mx-0.5 border-s-[3px] ${tone.bar}${tone.section ? ` ${tone.section}` : ''}`}>
      <div className={`flex items-center gap-2 px-2 pt-1 pb-0.5 text-body font-semibold ${tone.title ?? 'text-pn'}`}>
        <GroupIcon weight="bold" aria-hidden="true" className={`shrink-0 ${tone.text}`} />
        {label}
        <span className={`font-normal ${SLOT_BADGE}`}>{count}</span>
        {action && <span className="ms-auto">{action}</span>}
      </div>
      {body}
    </section>
  );
  const inTone = { bar: 'border-warning', text: 'text-warning' };
  const outTone = { bar: 'border-accent', text: 'text-accent' };
  // Related is a suggestion, not a link: a dashed bar and soft tint in the success color.
  const relatedTone = {
    bar: 'border-success border-dashed',
    text: 'text-success',
    section: 'rounded-e-lg bg-success/5 pb-0.5',
    title: 'text-success',
  };
  const hasIn = lists.from.length + lists.hidden > 0;
  const hasOut = lists.to.length + lists.missing.length > 0;
  const hasRelated = lists.related.length + lists.notRelated.length > 0;
  // The last "Not related", offered back for a few seconds.
  const [undo, setUndo] = useState<LocalNote | null>(null);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);
  const separator = <div role="separator" className="-mx-1 my-1.5 border-t border-divider" />;

  return (
    <EditorSlotPanel
      label={t('connections.title')}
      icon={<Graph />}
      title={t('connections.title')}
      closeLabel={t('connections.hide')}
      closeKeys={keyText('connections')}
      onClose={onClose}
    >
      {showLocalGraph && (
        <>
          <Suspense fallback={null}>
            <LocalGraphCardLazy
              centerId={centerNote.id}
              centerTitle={centerTitle}
              activeNoteId={openNoteId}
              nodes={localGraph.nodes}
              edges={localGraph.edges}
              depth={depth}
              onDepthChange={setDepth}
              pinned={pinned}
              pinnedTitle={pinnedTitle}
              onTogglePin={onTogglePin}
              onOpenFullGraph={() => onOpenFullGraph(centerNote.id)}
              onSelectNeighbor={(id) => {
                if (isSyntheticGraphId(id)) return;
                const target = byId.get(id);
                if (target) onOpen(target);
              }}
              dark={theme !== 'light'}
              labels={{
                hop1: t('graph.hop1'),
                hop2: t('graph.hop2'),
                depthLabel: t('graph.depthLabel'),
                pin: t('graph.pinLocalGraph'),
                unpin: t('graph.unpinLocalGraph'),
                pinnedTo: (title) => t('graph.pinnedCenter', { title }),
                fullGraph: t('graph.fullGraph'),
                empty: t('graph.localEmpty'),
                ariaLabel: t('graph.localAria', { title: centerTitle }),
              }}
            />
          </Suspense>
          {(hasIn || hasOut || hasRelated) && separator}
        </>
      )}
      {group(lists.usedIn ? t('connections.usedIn') : t('connections.linkedFrom'), ArrowsIn, inTone, lists.from.length, hasIn && (
        <>
          <ul>{lists.from.map((n) => row(n))}</ul>
          {lists.hidden > 0 && (
            <p className="flex items-center gap-2 px-2 py-1 text-small text-pn-muted">
              <LockSimple aria-hidden="true" className="shrink-0" />
              {t('connections.protectedHidden', { count: lists.hidden })}
            </p>
          )}
        </>
      ))}
      {hasIn && hasOut && separator}
      {group(t('connections.linksTo'), ArrowsOut, outTone, lists.to.length + lists.missing.length, hasOut && (
        <ul>
          {lists.to.map((n) => row(n, lists.suggestedTo.has(n.id)))}
          {lists.missing.map((name) => (
            <li key={name} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-body text-pn-muted">
              <FileDashed aria-hidden="true" className="shrink-0" />
              <OverflowTip text={name} className="min-w-0 flex-1 flex">
                <span className="truncate" dir="auto">{name}</span>
              </OverflowTip>
              <span className="ms-auto shrink-0 text-small">{t('connections.missing')}</span>
            </li>
          ))}
        </ul>
      ))}
      {(hasIn || hasOut) && hasRelated && separator}
      {group(t('connections.related'), Intersect, relatedTone, lists.related.length, hasRelated && (
        <>
          <ul>
            {lists.related.map(({ note, why }) => (
              <ConnectionRow
                key={note.id}
                note={note}
                title={deriveDisplayTitle(note, isNoteLocked(note))}
                why={why}
                actions={{ link: linkActions, onDismiss: () => { onDismissSuggestion(note); setUndo(note); } }}
                onOpen={() => onOpen(note)}
              />
            ))}
          </ul>
          <NotRelatedLine notes={lists.notRelated} title={(n) => deriveDisplayTitle(n, isNoteLocked(n))} onRestore={onRestoreSuggestion} />
          <MeaningDoorLine door={meaningDoor} />
        </>
      ), (
        <IconButton label={t('connections.hideSuggestions')} position="start" onClick={onHideSuggestions}>
          <EyeSlash />
        </IconButton>
      ))}
      {undo && (
        <Snackbar actionLabel={t('editor.undo')} onAction={() => { onRestoreSuggestion(undo); setUndo(null); }}>
          {t('connections.notRelatedDone')}
        </Snackbar>
      )}
    </EditorSlotPanel>
  );
}
