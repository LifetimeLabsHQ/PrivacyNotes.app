import { useTranslation } from 'react-i18next';
import { Banner, FeedbackButton } from '../ui';

export function SnapshotForbiddenBanner({
  onRestorePro,
  onDismiss,
}: {
  onRestorePro: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('notes');
  return (
    <Banner
      tone="warning"
      action={
        <FeedbackButton action="restore" onClick={onRestorePro}>
          {t('banner.restorePro')}
        </FeedbackButton>
      }
      onDismiss={onDismiss}
      dismissLabel={t('common:updateToast.dismiss')}
    >
      {t('banner.snapshotPaused')}
    </Banner>
  );
}
