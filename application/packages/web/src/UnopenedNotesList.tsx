import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { liveQuery } from 'dexie';
import { CloudArrowUp } from './icons';
import { Callout, DeleteButton, FeedbackButton } from './ui';
import { formatRelative } from './intlFormat';
import { deriveDisplayTitle } from './notesViewUtils';
import { deleteUnopenedNote, listUnopenedNotes, resendUnopenedNote, type UnopenedNote } from './unopenedNotes';

/** The rows drawn; the rest are counted in one line. */
const SHOWN = 50;
const EMPTY = { total: 0, rows: [] as UnopenedNote[] };

/**
 * "Notes this device can't open", in the sync readout (SyncPanel.tsx, so the
 * Sync tab and Settings > ID & Sync): the server rows this device met and
 * could not open (beta #203, owner card C1, option A). Shown only while the
 * list is not empty. Each row names what this device knows of the note, its
 * title when a copy is here, and offers "Send my copy again" when there is
 * one, and Delete (a sealed tombstone). A PIN-protected copy keeps its stored
 * title only and offers no Delete: deleting it goes through its gate in the
 * notes, after a resend.
 * Spec: docs/internal/design/ui-patterns.md section 193
 */
export function UnopenedNotesList({ onSyncNow }: { onSyncNow?: () => void | Promise<void> }) {
  const { t } = useTranslation('settings');
  const [list, setList] = useState(EMPTY);
  useEffect(() => {
    const sub = liveQuery(() => listUnopenedNotes(SHOWN)).subscribe({ next: setList, error: () => setList(EMPTY) });
    return () => sub.unsubscribe();
  }, []);
  if (list.total === 0) return null;

  const answer = (done: Promise<boolean>) => {
    void done.then((ok) => {
      if (ok) void onSyncNow?.();
    });
  };
  const more = list.total - list.rows.length;
  return (
    <Callout tone="warning" title={t('syncPanel.unopenedTitle')}>
      <p className="text-pn-soft">{t('syncPanel.unopenedHelp')}</p>
      <ul className="mt-2 space-y-1.5">
        {list.rows.map((row) => {
          const gated = row.local?.pinProtected === 1;
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 flex-[1_1_10rem]">
                <span className="block truncate text-body" dir="auto">
                  {row.local ? deriveDisplayTitle(row.local, gated) : t('syncPanel.unopenedNoCopy')}
                </span>
                <span className="block text-meta text-pn-muted">{t('syncPanel.unopenedSeen', { ago: formatRelative(row.seenAt) })}</span>
              </span>
              {row.local && (
                <FeedbackButton icon={<CloudArrowUp aria-hidden="true" />} onClick={() => answer(resendUnopenedNote(row.id))}>
                  {t('syncPanel.unopenedResend')}
                </FeedbackButton>
              )}
              {!gated && <DeleteButton label={t('common:actions.delete')} onConfirm={() => answer(deleteUnopenedNote(row.id))} />}
            </li>
          );
        })}
        {more > 0 && <li className="text-pn-muted">{t('notesChrome:signOutConfirm.moreNotes', { count: more })}</li>}
      </ul>
    </Callout>
  );
}
