import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';
import { dismissRefusedDelete, getRefusedDelete, getTombstoneHold, subscribeTombstoneHold } from '../massDelete';
import { Devices, Shield } from '../icons';
import { deleteHeldNotes, keepHeldNotes } from '../sync';
import { Button, Modal, ModalFooter } from '../ui';

/**
 * The two windows of the mass delete guard (massDelete.ts).
 *
 * The question: many notes this device still shows were deleted from the
 * server at once, with no seal (an app before migration 0130, or a session
 * without the key). Keep puts them back on every device under new ids; Delete
 * lets the tombstones through. No close X and no Escape: the notes wait until
 * it is answered. `onAnswered` runs a sync, so a kept note reaches the server
 * at once.
 *
 * The notice: a delete with a bad seal was refused and the notes are already
 * back (settleTombstones in sync.ts). Nothing to decide, so it only tells,
 * once, and offers the device list. The question goes first when both wait.
 * Spec: docs/contrib/sync-protocol.md (section 3, sealed deletes)
 */
export function MassDeleteModal({ onAnswered, onShowDevices, hidden }: { onAnswered: () => void; onShowDevices: () => void; hidden: boolean }) {
  const { t } = useTranslation(['notesChrome', 'shell']);
  const { auth } = useAuth();
  const hold = useSyncExternalStore(subscribeTombstoneHold, getTombstoneHold, () => null);
  const refused = useSyncExternalStore(subscribeTombstoneHold, getRefusedDelete, () => null);
  const [busy, setBusy] = useState(false);

  if (hidden || auth.status !== 'authenticated') return null;
  const pubkey = auth.pubkey;

  async function answer(keep: boolean) {
    setBusy(true);
    try {
      await (keep ? keepHeldNotes(pubkey) : deleteHeldNotes(pubkey));
      onAnswered();
    } finally {
      setBusy(false);
    }
  }

  // A hold or a notice found for another account is never shown in this one.
  if (hold && hold.pubkey === pubkey) {
    return (
      <Modal title={t('massDelete.title')} icon={<Shield />} className="max-w-md p-6 space-y-4">
        <p className="text-body text-pn-muted leading-relaxed">{t('massDelete.body', { count: hold.ids.length })}</p>
        <ModalFooter>
          <Button action="delete" disabled={busy} onClick={() => void answer(false)} />
          <Button action="restore" disabled={busy} onClick={() => void answer(true)}>
            {t('shell:contextMenu.restore')}
          </Button>
        </ModalFooter>
      </Modal>
    );
  }

  if (refused && refused.pubkey === pubkey) {
    return (
      <Modal title={t('massDelete.refusedTitle')} icon={<Shield />} onClose={dismissRefusedDelete} className="max-w-md p-6 space-y-4">
        <p className="text-body text-pn-muted leading-relaxed">{t('massDelete.refusedBody', { count: refused.count })}</p>
        <ModalFooter>
          <Button
            variant="primary"
            icon={<Devices aria-hidden="true" />}
            onClick={() => {
              dismissRefusedDelete();
              onShowDevices();
            }}
          >
            {t('massDelete.showDevices')}
          </Button>
        </ModalFooter>
      </Modal>
    );
  }

  return null;
}
