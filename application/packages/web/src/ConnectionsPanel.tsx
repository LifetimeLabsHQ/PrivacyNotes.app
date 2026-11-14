import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, ArrowsIn, ArrowsOut, Asterisk, CaretDown, CaretRight, CursorText, EyeSlash, FileDashed, Graph, Hash, Intersect, LinkSimple, LockSimple, Sparkle, TextAa, X } from './icons';
import { IconButton, Snackbar } from './ui';
import type { LocalNote } from './db';
import { EditorSlotPanel, SLOT_BADGE, SLOT_PANEL_ROW } from './EditorSlotPill';
import { keyText } from './shortcutMatch';
import { typeGlyph } from './NoteRow';
import { deriveDisplayTitle } from './notesViewUtils';
import { PathGlyph, useItemLook } from './looks/LookGlyph';
import { ProBadge } from './OptionsMenu';
import { isDemoMode } from './demo';
import { closeMeaningDoor, laterMeaningDoor, meaningDoorClosed, onDeviceAiShown, reopenMeaningDoor, useMeaningState } from './onDeviceAi';

/** What the panel lists for the open item (ConnectionsPill works it out). */
export type ConnectionLists = {
  from: LocalNote[];
  to: LocalNote[];
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
export type RelatedWhy = { kind: 'words' | 'link' | 'tag' | 'meaning'; text: string; sentence: string };

const WHY_ICON = { words: TextAa, link: LinkSimple, tag: Hash, meaning: Sparkle } as const;

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
 * Spec: docs/internal/plans/related-notes.md (section 5, "Where it lives")
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
 * Spec: docs/internal/plans/related-notes.md (section 9, "Not related")
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
              <span className="min-w-0 flex-1 truncate text-pn-muted" dir="auto" title={title(n)}>{title(n)}</span>
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

function ConnectionRow({ note, title, why, actions, onOpen }: { note: LocalNote; title: string; why?: RelatedWhy; actions?: SuggestionActions; onOpen: () => void }) {
  const { t } = useTranslation('notes');
  const { iconPaths: paths, row, icon } = useItemLook(note.id, note.tags, note.folderId);
  const { Icon, color } = typeGlyph(note.type);
  const WhyIcon = why ? WHY_ICON[why.kind] : null;
  const iconClass = `shrink-0 ${icon ? '' : color}`;
  return (
    <li className={actions ? 'group/row flex items-center gap-0.5' : undefined}>
      <button
        type="button"
        onClick={onOpen}
        title={why ? `${title}\n${why.sentence}` : title}
        style={row}
        className={`${SLOT_PANEL_ROW} px-2 text-pn-soft${actions ? ' min-w-0' : ''}`}
      >
        {paths
          ? <PathGlyph paths={paths} size={16} className={iconClass} style={icon} />
          : <Icon aria-hidden="true" className={iconClass} style={icon} />}
        {why ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate" dir="auto">{title}</span>
            <span className="flex min-w-0 items-center gap-1 text-small text-pn-muted">
              {WhyIcon && <WhyIcon aria-hidden="true" className="shrink-0" />}
              <span className="truncate" dir="auto">{why.text}</span>
              <span className="sr-only">{why.sentence}</span>
            </span>
          </span>
        ) : <span className="truncate" dir="auto">{title}</span>}
      </button>
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
  const row = (n: LocalNote) => (
    <ConnectionRow key={n.id} note={n} title={deriveDisplayTitle(n, isNoteLocked(n))} onOpen={() => onOpen(n)} />
  );

  // An empty group is left out. Each group carries its direction three ways
  // at once, so no one has to read a label to tell them apart: a side bar, an
  // arrow icon and a color. In (the notes that link here) is the warm color,
  // out (what this note links to) the accent; both follow the theme.
  const group = (
    label: string,
    GroupIcon: typeof ArrowsIn,
    tone: { bar: string; text: string },
    count: number,
    body: ReactNode,
    action?: ReactNode,
  ) => count === 0 && !body ? null : (
    <section className={`mx-0.5 border-s-[3px] ${tone.bar}`}>
      <div className="flex items-center gap-2 px-2 pt-1 pb-0.5 text-body font-semibold text-pn">
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
  // Related is a suggestion, not a link: a dashed bar in the success color.
  const relatedTone = { bar: 'border-success border-dashed', text: 'text-success' };
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
      {group(t('connections.linkedFrom'), ArrowsIn, inTone, lists.from.length, hasIn && (
        <>
          <ul>{lists.from.map(row)}</ul>
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
          {lists.to.map(row)}
          {lists.missing.map((name) => (
            <li key={name} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-body text-pn-muted">
              <FileDashed aria-hidden="true" className="shrink-0" />
              <span className="truncate" dir="auto" title={name}>{name}</span>
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
