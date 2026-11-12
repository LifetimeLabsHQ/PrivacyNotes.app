import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Archive, LockSimpleOpen, PencilSimpleSlash } from './icons';
import { HoverLabel } from './HoverLabel';

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
    <div className={`flex items-center gap-1.5 text-compact text-pn-muted ${className}`}>
      {icon}
      <span className="truncate">{label}</span>
      <span aria-hidden="true">·</span>
      <HoverLabel label={tip} position="below-start">{button}</HoverLabel>
    </div>
  );
}

/** A read-only item, with Turn off. The caller runs the same Pro check as the
 *  menu's switch. One copy for the editor, the forms and the drawing. */
export function ReadOnlyHint({ onTurnOff, className }: { onTurnOff: () => void; className?: string }) {
  const { t } = useTranslation(['notes', 'shell']);
  return (
    <StateHint
      icon={<PencilSimpleSlash className="shrink-0" aria-hidden="true" />}
      label={t('notes:noteRow.readOnly')}
      action={t('shell:cli.turnOff')}
      onAction={onTurnOff}
      tip={t('notes:editor.turnOffHint')}
      className={className}
    />
  );
}

/** An archived item, so a note reached by a note-link, a search or in Zen
 *  says it is archived (#712), with Unarchive. */
export function ArchivedHint({ onUnarchive, className }: { onUnarchive: () => void; className?: string }) {
  const { t } = useTranslation(['notes', 'shell']);
  return (
    <StateHint
      icon={<Archive className="shrink-0" aria-hidden="true" />}
      label={t('notes:noteRow.archived')}
      action={t('shell:contextMenu.unarchive')}
      onAction={onUnarchive}
      tip={t('notes:editor.unarchiveHint')}
      className={className}
    />
  );
}

/**
 * An open PIN-protected item, with the way to shut it before the timer does
 * (#723). A locked one shows the gate instead. One PIN window opens every
 * protected item, so Lock shuts all of them, and its tip says so.
 */
export function UnlockedHint({ onLock, className }: { onLock: () => void; className?: string }) {
  const { t } = useTranslation('notes');
  return (
    <StateHint
      icon={<LockSimpleOpen className="shrink-0" aria-hidden="true" />}
      label={t('editor.unlocked')}
      action={t('editor.lock')}
      onAction={onLock}
      tip={t('editor.lockNowHint')}
      className={className}
    />
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
