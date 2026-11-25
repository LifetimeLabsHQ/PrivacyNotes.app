import { useTranslation } from 'react-i18next';
import { Banner, FeedbackButton } from '../ui';

export function StoragePastDueBanner({
  onDismiss,
}: {
  onDismiss: () => void;
}) {
  const { t } = useTranslation('notes');
  return (
    <Banner
      tone="warning"
      action={
        <FeedbackButton
          action="open"
          href="https://customer.paddle.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('banner.updateCard')}
        </FeedbackButton>
      }
      onDismiss={onDismiss}
      dismissLabel={t('common:updateToast.dismiss')}
    >
      {t('banner.storagePastDue')}
    </Banner>
  );
}
