import { useEffect, useState, useSyncExternalStore } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useAuth } from '../auth';
import { countLocalNotes, getDmsWipe, subscribeDmsWipe } from '../dms';
import { Download, Hourglass } from '../icons';
import { formatInstant } from '../intlFormat';
import { describeOnlyHere, useOnlyOnThisDevice } from '../neverBackedUp';
import { Button, Modal, ModalFooter, TextField } from '../ui';

/**
 * The answer a device owes after the dead man's switch wiped its account on
 * the server (dms.ts holds every server write until then). Two separate
 * buttons: a backup never deletes anything, because a cancelled save
 * resolves like a finished one. The delete is the Danger zone's door: it
 * names what exists only on this device and asks for the typed word, then
 * runs the same local wipe, and the reload signs in to the empty account.
 *
 * No close X and no Escape: it must be answered. Hidden while an export runs
 * so its progress window is on top; on the base layer, so a PIN prompt the
 * backup opens for a locked note stacks above it.
 * Spec: docs/internal/specs/dead-mans-switch.md (section 6, the dialog)
 */
export function DmsReturnModal({ onBackup, hidden }: { onBackup: () => void; hidden: boolean }) {
  const { t } = useTranslation('notesChrome');
  const { auth, supabase } = useAuth();
  const wipe = useSyncExternalStore(subscribeDmsWipe, getDmsWipe, () => null);
  const [count, setCount] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const atStake = useOnlyOnThisDevice(confirming && !busy);

  useEffect(() => {
    if (!wipe) return;
    let cancelled = false;
    void countLocalNotes().then((n) => { if (!cancelled) setCount(n); });
    return () => { cancelled = true; };
  }, [wipe]);

  // A hold found for another account is never answered from this one.
  if (!wipe || hidden || auth.status !== 'authenticated' || wipe.pubkey !== auth.pubkey) return null;
  const authed = auth;

  async function deleteHere() {
    if (getDmsWipe()?.pubkey !== authed.pubkey || typed.toUpperCase() !== 'DELETE') return;
    setBusy(true);
    try {
      // At click time: the Danger zone is not on the boot path.
      const { wipeThisDevice } = await import('../DangerZone');
      await wipeThisDevice(authed, supabase);
    } finally {
      window.location.replace('/');
    }
  }

  const onlyHere = describeOnlyHere(t, atStake);

  return (
    <Modal title={t('dms.returnTitle')} icon={<Hourglass />} className="max-w-md p-6 space-y-4">
      <p className="text-body text-pn-muted leading-relaxed">
        {t('dms.returnBody', {
          count: count ?? 0,
          date: wipe.wipedAt ? formatInstant(wipe.wipedAt, 'date') : '',
        })}
      </p>
      {confirming ? (
        <>
          {onlyHere && <p className="text-body text-danger leading-relaxed">{onlyHere}</p>}
          <TextField
            label={<Trans i18nKey="settings:danger.confirmPrompt" components={{ kbd: <span className="font-mono font-semibold text-danger" /> }} />}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            placeholder="DELETE"
            autoComplete="off"
            spellCheck={false}
          />
          <ModalFooter>
            <Button action="cancel" disabled={busy} onClick={() => { setConfirming(false); setTyped(''); }} />
            <Button action="delete" disabled={busy || typed.toUpperCase() !== 'DELETE'} onClick={() => void deleteHere()}>
              {t('settings:danger.deletePermanently')}
            </Button>
          </ModalFooter>
        </>
      ) : (
        <ModalFooter>
          <Button icon={<Download aria-hidden="true" />} onClick={onBackup}>
            {t('dms.returnBackup')}
          </Button>
          <Button action="delete" onClick={() => setConfirming(true)}>
            {t('dms.returnDelete')}
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
}
