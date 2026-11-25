import { Trans, useTranslation } from 'react-i18next';
import { Brand } from './Brand';
import { Heart } from './icons';
import { Button, Modal, ModalFooter, SETTINGS_BTN_PRIMARY } from './ui';

type Props = {
  reason: string;
  onClose: () => void;
};

export function DonationModal({ reason, onClose }: Props) {
  const { t } = useTranslation('billing');
  return (
    <Modal onClose={onClose} title={reason} subtitle={t('donation.eyebrow')} className="max-w-md p-6 space-y-4">

        <p className="text-body text-pn-muted leading-relaxed">
          <Trans
            i18nKey="billing:donation.intro"
            components={{ brand: <Brand /> }}
          />
        </p>

        <p className="text-body text-pn-muted leading-relaxed">
          {t('donation.proBenefits')}
        </p>

        <ModalFooter>
          <Button action="cancel" onClick={onClose}>
            {t('donation.maybeLater')}
          </Button>
          <a
            href="https://github.com/LifetimeLabsHQ/PrivacyNotes.app"
            target="_blank"
            rel="noreferrer"
            onClick={onClose}
            className={SETTINGS_BTN_PRIMARY}
          >
            <Heart aria-hidden="true" className="shrink-0" />
            {t('donation.support')}
          </a>
        </ModalFooter>
    </Modal>
  );
}
