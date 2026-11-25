import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Archive, LockSimpleOpen, PencilSimpleSlash } from './icons';
import { HoverLabel } from './HoverLabel';
import type { LocalNote } from './db';
import type { View } from './views';

/**
 * One state over an item, in the editor's notice row: its icon and name in the
 * muted tone, then the one action that undoes it. Read-only, Archived and
 * Unlocked all draw through this, so the three look and act alike (#723).
 * Every action carries a short tip, opened start-aligned below it, so the
 * three tips land the same way. The caller sets the spacing.
 */
function StateHint({ icon, label, action, onAction, tip, className = '' }: {
  icon: ReactNode;
  label: string;
  action: string;
  onAction: () => void;
  tip: string;
  className?: string;
}) {
  const button = (
    <button type="button" onClick={onAction} className="shrink-0 text-accent hover:underline">
      {action}
    </button>
  );
  return (
    <div className={`flex items-center gap-1.5 select-none text-compact text-pn-muted ${className}`}>
      {icon}
      <span className="truncate">{label}</span>
      <span aria-hidden="true">·</span>
      <HoverLabel label={tip} position="below-start">{button}</HoverLabel>
    </div>
  );
}

/** A state over an open item that the editor names, with the action that
 *  undoes it. */
export type NoteState = 'readOnly' | 'archived' | 'unlocked';

/**
 * The states the editor names over an item, in the order the row draws them:
 * Read-only (#706), Archived (#712), Unlocked (#723). None in the Trash.
 * Unlocked reads the `pinProtected` flag for display only: an item the PIN
 * gate guards shows the gate instead of a body, and the gate's own check
 * (`isNoteLocked`, `ProtectedNoteGate`) is not here. `deviceReadOnly` is this
 * device's "Open notes read-only" (#824): the same hint, over a note that is
 * not read-only itself.
 */
export function noteStates(note: Pick<LocalNote, 'locked' | 'archived' | 'pinProtected'>, view: View, deviceReadOnly = false): NoteState[] {
  if (view === 'trash') return [];
  const states: NoteState[] = [];
  if (note.locked === 1 || deviceReadOnly) states.push('readOnly');
  if (note.archived === 1) states.push('archived');
  if (note.pinProtected === 1) states.push('unlocked');
  return states;
}

/**
 * Where the row sits: `block` over a form item or a drawing, one hint under
 * another; `source` over the markdown source view, with Read-only pinned
 * under the tag row (#830); `editor` in the rich editor's notice row, beside
 * its corner pills.
 */
export type NoteStatePlace = 'block' | 'source' | 'editor';

/**
 * The hints of `noteStates`, drawn alike in every body branch of the editor
 * pane. Turn off runs the menu switch's own Pro check, Unarchive is the
 * menu's action, and Lock shuts this open protected item before the timer
 * does. Each action has a short tip. Draws nothing when no state applies.
 * `deviceReadOnly` says Read-only comes from this device's setting (#824), so
 * Turn off edits the note for now and its tip says so.
 */
export function NoteStateRow({ states, place, deviceReadOnly = false, onTurnOff, onUnarchive, onLock }: {
  states: readonly NoteState[];
  place: NoteStatePlace;
  deviceReadOnly?: boolean;
  onTurnOff: () => void;
  onUnarchive: () => void;
  onLock: () => void;
}) {
  const { t } = useTranslation(['notes', 'shell']);
  if (!states.length) return null;
  const hint = (state: NoteState, className: string) => {
    const props = { readOnly: {
      icon: <PencilSimpleSlash className="shrink-0" aria-hidden="true" />,
      label: t('notes:noteRow.readOnly'), action: t('shell:cli.turnOff'), onAction: onTurnOff, tip: t(deviceReadOnly ? 'notes:editor.turnOffForNowHint' : 'notes:editor.turnOffHint'),
    }, archived: {
      icon: <Archive className="shrink-0" aria-hidden="true" />,
      label: t('notes:noteRow.archived'), action: t('shell:contextMenu.unarchive'), onAction: onUnarchive, tip: t('notes:editor.unarchiveHint'),
    }, unlocked: {
      icon: <LockSimpleOpen className="shrink-0" aria-hidden="true" />,
      label: t('notes:editor.unlocked'), action: t('notes:editor.lock'), onAction: onLock, tip: t('notes:editor.lockNowHint'),
    } }[state];
    return <StateHint key={state} {...props} className={className} />;
  };
  if (place === 'editor') {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">
        {states.map((s) => hint(s, 'min-w-0'))}
      </div>
    );
  }
  if (place === 'block') return <>{states.map((s) => hint(s, 'px-6 pt-3'))}</>;
  return (
    <>
      {states.map((s) => s === 'readOnly' ? (
        <div key={s} className="pn-notice-row sticky top-[var(--pn-tagrow-h,0px)] z-[4] mb-2 bg-surface-1/95 backdrop-blur">
          {hint(s, 'mx-4 sm:mx-6 py-2')}
        </div>
      ) : hint(s, 'mx-4 sm:mx-6 mt-1 mb-3'))}
    </>
  );
}

/**
 * Says how many of the items a confirm modal asks about are read-only and
 * will therefore stay where they are. Renders nothing when none of them
 * are, so a caller can hand it a raw count without a guard of its own.
 */
export function ReadOnlySkipNotice({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-divider bg-surface-1 text-compact leading-snug p-3">
      <PencilSimpleSlash className="shrink-0 mt-0.5" />
      <span>
        <Trans
          i18nKey="notes:bulkTrash.readOnlySkipped"
          count={count}
          values={{ count }}
          components={{ highlight: <span className="font-medium text-pn" /> }}
        />
      </span>
    </div>
  );
}
