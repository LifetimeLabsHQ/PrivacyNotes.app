import { useTranslation } from 'react-i18next';
import { Banner } from '../ui';

export function ProActivationPendingBanner({
  onDismiss,
}: {
  onDismiss: () => void;
}) {
  const { t } = useTranslation('notes');
  return (
    <Banner tone="warning" onDismiss={onDismiss} dismissLabel={t('common:updateToast.dismiss')}>
      {t('banner.proActivationPending')}
    </Banner>
  );
}
