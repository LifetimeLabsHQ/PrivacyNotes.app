/**
 * After an unlock removed a browser presence gate (its key sat next to the
 * phrase it wrapped, and a PIN or passcode wrap is the lock), a banner says
 * that fingerprint or face unlock is off, until it is dismissed.
 * Spec: docs/internal/plans/phrase-lock-hardening.md (section 2.2 B)
 */
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner } from '../ui/feedback';
import { dismissPresenceGateNotice, onPresenceGateNoticeChange, presenceGateRemovedNotice } from '../biometric';

export function PresenceGateRemovedBanner() {
  const { t } = useTranslation('security');
  const shown = useSyncExternalStore(onPresenceGateNoticeChange, presenceGateRemovedNotice, () => false);
  if (!shown) return null;
  return (
    <Banner tone="info" onDismiss={dismissPresenceGateNotice} dismissLabel={t('common:updateToast.dismiss')}>
      {t('appLock.presenceGateRemoved')}
    </Banner>
  );
}
