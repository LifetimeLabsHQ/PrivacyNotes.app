import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { liveQuery } from 'dexie';
import { countUnopenedCopiesHere } from '../unopenedNotes';
import { Archive, Key, SignOut } from '../icons';
import { Button, Callout, Checkbox, Modal, ModalFooter } from '../ui';

/**
 * Phrase-reminder confirmation shown when the user clicks Sign Out
 * unless they previously checked "Don't remind me again". Two paths:
 *   - "No, show phrase" opens the Phrase tab of Security (the explicit
 *     ask is honoured even if "Don't remind" is checked).
 *   - "Yes, sign out" tears down the session.
 *
 * unsyncedCount > 0 adds an amber warning: this device holds notes the
 * server has not confirmed. unsyncedKept picks the copy - forced
 * sign-outs (dead session) preserve those rows through the wipe, a
 * voluntary sign-out destroys them if the final flush fails.
 * unsyncedFiles > 0 adds the pictures and files the server does not hold.
 * No sign-out uploads one first; a voluntary sign-out deletes them and a
 * forced one keeps them, so only the voluntary copy names them. Either
 * count forces this modal open even for users who opted out of the phrase
 * reminder (maySkipSignOutConfirm): they consented to skipping a
 * reminder, not to data loss. Same principle as #121.
 *
 * It also counts, live, the notes whose server row this device cannot open
 * (unopenedNotes.ts, beta #203): no sign-out sends them, so a voluntary one
 * deletes the copy here, which may be the only good one, and a forced one
 * keeps it.
 */
function useUnopenedCopiesHere(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const sub = liveQuery(countUnopenedCopiesHere).subscribe({ next: setCount, error: () => setCount(0) });
    return () => sub.unsubscribe();
  }, []);
  return count;
}

export function SignOutConfirmModal({
  dontRemind,
  onDontRemindChange,
  onShowPhrase,
  onConfirmSignOut,
  onStay,
  unsyncedCount,
  unsyncedFiles,
  unsyncedKept,
  neverBackedUp,
  localOnly = false,
  onExportBackup,
}: {
  dontRemind: boolean;
  onDontRemindChange: (next: boolean) => void;
  onShowPhrase: () => void;
  onConfirmSignOut: () => void;
  /** Closes the confirm and keeps the session. The default action while
   *  unsynced notes or files are at stake: they rest sealed on this
   *  device, so staying costs nothing and signing out destroys them. */
  onStay: () => void;
  /** Local rows with an unsynced change (dirty 1 or 2) when the modal opened. */
  unsyncedCount: number;
  /** Pictures and files waiting to upload or refused for good at the
   *  moment the modal opened (countOnlyOnThisDevice). */
  unsyncedFiles: number;
  /** True when the sign-out preserves unsynced rows (forced context). */
  unsyncedKept: boolean;
  /** The subset that exists on this device only (neverBackedUp.ts). */
  neverBackedUp: ReadonlyArray<{ id: string; title: string }>;
  /** Local-only vault: nothing has ever synced, so signing out permanently
   *  deletes all notes and files on this device. */
  localOnly?: boolean;
  /** Opens Settings > Backup > Manual from the local-only sign-out confirm. */
  onExportBackup?: () => void;
}) {
  const { t } = useTranslation('notesChrome');
  // With unsynced rows or files at stake (or local-only mode), every dismissal
  // keeps the session; the phrase escape hatch stays as an explicit button.
  const unopened = useUnopenedCopiesHere();
  const filesAtRisk = unsyncedFiles > 0 && !unsyncedKept;
  const lostNotes = unsyncedCount + (unsyncedKept ? 0 : unopened);
  const risky = (lostNotes > 0 && !unsyncedKept) || filesAtRisk;
  const loseLabel = !filesAtRisk
    ? t('signOutConfirm.signOutLose', { count: lostNotes })
    : lostNotes > 0
      ? t('signOutConfirm.signOutLoseBoth', {
          count: lostNotes,
          files: t('signOutConfirm.fileCount', { count: unsyncedFiles }),
        })
      : t('signOutConfirm.signOutLoseFiles', { count: unsyncedFiles });
  const dismiss = localOnly || risky ? onStay : onShowPhrase;
  const shown = neverBackedUp.slice(0, 5);
  const more = neverBackedUp.length - shown.length;

  if (localOnly) {
    const noteText = t('settings:danger.unsyncedNotes', { count: unsyncedCount });
    const fileText = t('settings:danger.unsyncedFiles', { count: unsyncedFiles });
    const items =
      unsyncedCount > 0 && unsyncedFiles > 0
        ? t('settings:danger.unsyncedBoth', { notes: noteText, files: fileText })
        : unsyncedCount > 0
          ? noteText
          : fileText;
    const hasItems = unsyncedCount > 0 || unsyncedFiles > 0;
    return (
      <Modal
        onClose={dismiss}
        title={t('signOutConfirm.localOnlyTitle')}
        className="max-w-sm p-6 space-y-4"
      >
        <p className="text-body text-pn-muted leading-relaxed">
          {t('signOutConfirm.localOnlyBody')}
        </p>
        {hasItems && (
          <Callout tone="warning">
            {t('signOutConfirm.localOnlyCounts', { items })}
          </Callout>
        )}
        <ModalFooter>
          {onExportBackup && (
            <Button icon={<Archive aria-hidden="true" />} onClick={onExportBackup}>
              {t('signOutConfirm.localOnlyExportBackup')}
            </Button>
          )}
          <Button action="confirm" onClick={onStay}>
            {t('signOutConfirm.stay')}
          </Button>
          <Button
            action="delete"
            variant="danger"
            onClick={onConfirmSignOut}
            className={onExportBackup ? 'col-span-2' : undefined}
          >
            {t('signOutConfirm.localOnlyDeleteConfirm')}
          </Button>
        </ModalFooter>
      </Modal>
    );
  }
  return (
    <Modal
      onClose={dismiss}
      title={t('signOutConfirm.title')}
      className="max-w-sm p-6 space-y-4"
    >
      <p className="text-body text-pn-muted leading-relaxed">
        <Trans
          i18nKey="notesChrome:signOutConfirm.body"
          components={{ only: <strong />, action: <strong /> }}
        />
      </p>
      {(unsyncedCount > 0 || filesAtRisk || unopened > 0) && (
        <Callout tone="warning">
          <div className="space-y-2">
            {unsyncedCount > 0 && (
              <p>
                {t(unsyncedKept ? 'signOutConfirm.unsyncedKept' : 'signOutConfirm.unsyncedWarn', {
                  count: unsyncedCount,
                })}
              </p>
            )}
            {filesAtRisk && <p>{t('signOutConfirm.unsyncedFilesWarn', { count: unsyncedFiles })}</p>}
            {unopened > 0 && <p>{t(unsyncedKept ? 'signOutConfirm.unopenedKept' : 'signOutConfirm.unopenedWarn', { count: unopened })}</p>}
            {risky && shown.length > 0 && (
              <div>
                <p className="font-medium">{t('signOutConfirm.neverBackedUp', { count: neverBackedUp.length })}</p>
                <ul className="mt-1 list-disc ps-4 space-y-0.5">
                  {shown.map((n) => (
                    <li key={n.id} className="truncate" dir="auto">{n.title}</li>
                  ))}
                  {more > 0 && <li className="list-none -ms-4 opacity-80">{t('signOutConfirm.moreNotes', { count: more })}</li>}
                </ul>
              </div>
            )}
            {risky && <p className="opacity-90">{t('signOutConfirm.appLockHint')}</p>}
          </div>
        </Callout>
      )}
      <Checkbox
        checked={dontRemind}
        onChange={(e) => onDontRemindChange(e.target.checked)}
        label={t('signOutConfirm.dontRemind')}
      />
      {risky ? (
        // Data at stake: the primary action keeps it, and the sign-out
        // names its cost. Two clicks to lose data is the point.
        <ModalFooter>
          <Button icon={<Key aria-hidden="true" />} onClick={onShowPhrase}>
            {t('signOutConfirm.showPhrase')}
          </Button>
          <Button action="confirm" onClick={onStay}>
            {t('signOutConfirm.stay')}
          </Button>
          <Button action="delete" variant="danger" onClick={onConfirmSignOut} className="col-span-2">
            {loseLabel}
          </Button>
        </ModalFooter>
      ) : (
        <ModalFooter>
          <Button icon={<Key aria-hidden="true" />} onClick={onShowPhrase}>
            {t('signOutConfirm.showPhrase')}
          </Button>
          <Button variant="primary" icon={<SignOut aria-hidden="true" />} onClick={onConfirmSignOut}>
            {t('signOutConfirm.confirm')}
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
}
