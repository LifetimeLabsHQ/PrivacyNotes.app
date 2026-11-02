import { useTranslation } from 'react-i18next';
import { SignOut, WarningCircle } from '../icons';
import { Button, Modal, ModalFooter } from '../ui';

/**
 * Shown instead of signing out when the upload a chosen sign-out waits for
 * could not finish: the device is offline, server writes are paused, or the
 * push left changes behind (signOutUpload.ts). Every dismissal keeps the
 * session, because the changes rest on this device and staying costs
 * nothing; "Sign out anyway" runs the sign-out, which wipes them.
 */
export function SignOutUnsentModal({ onStay, onSignOutAnyway }: { onStay: () => void; onSignOutAnyway: () => void }) {
  const { t } = useTranslation('notesChrome');
  return (
    <Modal onClose={onStay} title={t('signOutUpload.title')} icon={<WarningCircle />} className="max-w-sm p-6 space-y-4">
      <p className="text-body text-pn-muted leading-relaxed">{t('signOutUpload.body')}</p>
      <ModalFooter>
        <Button action="cancel" autoFocus onClick={onStay}>
          {t('signOutConfirm.stay')}
        </Button>
        <Button variant="danger" icon={<SignOut aria-hidden="true" className="shrink-0" />} onClick={onSignOutAnyway}>
          {t('signOutUpload.signOutAnyway')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
