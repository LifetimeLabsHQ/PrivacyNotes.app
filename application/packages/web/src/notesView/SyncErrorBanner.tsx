import { useTranslation } from 'react-i18next';
import { Banner } from '../ui';

/**
 * Sync-error banner shown when one or more notes failed to push for a
 * non-quota, non-auth reason during the most recent sync. The notes
 * stay `dirty=1` and retry on the next sync pass - this banner exists
 * so a novel server-side reject doesn't stay invisible. Size rejections
 * never reach it: no retry can turn one into a success, so
 * pushFailures.ts carries them as the persistent "Not backed up" state
 * in the pill, ID & Sync and the editor instead. See gap #4.
 *
 * Visibility is owned by the parent (NotesView) so dismissal can flip
 * the same state that drives the read.
 */
export function SyncErrorBanner({
  count,
  lastMessage,
  onDismiss,
}: {
  count: number;
  lastMessage: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('notesChrome');
  return (
    <Banner tone="warning" onDismiss={onDismiss} dismissLabel={t('common:updateToast.dismiss')}>
      <span>{t('syncError.failed', { count })}</span>
      {lastMessage && (
        <span className="ms-1 text-pn-soft">{t('syncError.lastError', { message: lastMessage })}</span>
      )}
    </Banner>
  );
}
