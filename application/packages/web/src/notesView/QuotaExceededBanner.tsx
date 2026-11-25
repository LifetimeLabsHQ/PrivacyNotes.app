import { useTranslation } from 'react-i18next';
import { HardDrives } from '../icons';
import { Banner, FeedbackButton } from '../ui';

/**
 * Storage-quota warning banner pinned below the header. Three states:
 *  - Sync frozen (90+ days over):     red, non-dismissable
 *  - Grace period (1..89 days):       amber, with a remaining-days hint
 *  - Just-now exceeded:               amber, generic message
 *
 * Copy and CTA adapt to whether the storage add-on is purchasable
 * (`storageConfigured`). When Paddle isn't wired (self-host, dev, env
 * vars missing), the banner stops suggesting "re-subscribe" - there's
 * nothing to subscribe to - and points users at trimming notes
 * instead. See gap #25.
 *
 * Visibility is owned by the parent (NotesView) so dismissal can flip
 * the same state that drives the read.
 */
export function QuotaExceededBanner({
  quotaExceededSince,
  storageConfigured,
  onManageStorage,
  onDismiss,
}: {
  quotaExceededSince: string | null;
  storageConfigured: boolean;
  onManageStorage: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('notesChrome');
  const graceDaysRemaining = quotaExceededSince
    ? Math.max(0, 90 - Math.floor((Date.now() - new Date(quotaExceededSince).getTime()) / 86400000))
    : null;
  const syncFrozen = graceDaysRemaining !== null && graceDaysRemaining <= 0;
  const isGracePeriod = graceDaysRemaining !== null && graceDaysRemaining > 0;

  const message = (() => {
    if (syncFrozen) {
      return storageConfigured
        ? t('quota.frozen.configured')
        : t('quota.frozen.unconfigured');
    }
    if (isGracePeriod) {
      return storageConfigured
        ? t('quota.grace.configured', { count: graceDaysRemaining })
        : t('quota.grace.unconfigured', { count: graceDaysRemaining });
    }
    return storageConfigured
      ? t('quota.full.configured')
      : t('quota.full.unconfigured');
  })();

  const ctaLabel = storageConfigured ? t('quota.manageStorage') : t('quota.viewUsage');

  return (
    <Banner
      tone={syncFrozen ? 'danger' : 'warning'}
      action={
        <FeedbackButton icon={<HardDrives aria-hidden="true" />} onClick={onManageStorage}>
          {ctaLabel}
        </FeedbackButton>
      }
      onDismiss={syncFrozen ? undefined : onDismiss}
      dismissLabel={t('common:updateToast.dismiss')}
    >
      {/* The server counts a deleted file until its object is removed, a day
          later (imageGC.ts, BLOB_GC_GRACE_MS; beta #204 item 3). */}
      {message} {t('quota.deletedSpace')}
    </Banner>
  );
}
