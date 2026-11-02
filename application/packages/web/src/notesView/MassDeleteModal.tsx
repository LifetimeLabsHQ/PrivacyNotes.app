import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';
import { getTombstoneHold, subscribeTombstoneHold } from '../massDelete';
import { Shield } from '../icons';
import { deleteHeldNotes, keepHeldNotes } from '../sync';
import { Button, Modal, ModalFooter } from '../ui';

/**
 * The question the mass delete guard holds a pull for (massDelete.ts): many
 * notes this device still shows were deleted from the server at once. Keep
 * puts them back on every device under new ids; Delete lets the tombstones
 * through. No close X and no Escape: the notes wait until it is answered.
 * `onAnswered` runs a sync, so a kept note reaches the server at once.
 * Spec: docs/contrib/sync-protocol.md (section 3, the mass delete guard)
 */
export function MassDeleteModal({ onAnswered, hidden }: { onAnswered: () => void; hidden: boolean }) {
  const { t } = useTranslation('notesChrome');
  const { auth } = useAuth();
  const hold = useSyncExternalStore(subscribeTombstoneHold, getTombstoneHold, () => null);
  const [busy, setBusy] = useState(false);

  // A hold found for another account is never answered from this one.
  if (!hold || hidden || auth.status !== 'authenticated' || hold.pubkey !== auth.pubkey) return null;
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

  return (
    <Modal title={t('massDelete.title')} icon={<Shield />} className="max-w-md p-6 space-y-4">
      <p className="text-body text-pn-muted leading-relaxed">{t('massDelete.body', { count: hold.ids.length })}</p>
      <ModalFooter>
        <Button action="delete" disabled={busy} onClick={() => void answer(false)}>
          {t('massDelete.delete')}
        </Button>
        <Button action="restore" disabled={busy} onClick={() => void answer(true)}>
          {t('massDelete.keep')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
