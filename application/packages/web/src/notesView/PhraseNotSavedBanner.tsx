/**
 * While this tab holds the recovery phrase in memory only, a banner says that
 * closing the tab signs out: either the browser could not wrap the phrase, so
 * nothing was stored (and the app lock would keep it on this device), or the
 * person did not trust this device, which keeps its sign-in in memory.
 * Spec: docs/internal/plans/phrase-lock-hardening.md (section 1.2 C)
 * Spec: docs/internal/plans/untrusted-device-memory.md (section 2.3)
 */
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner } from '../ui/feedback';
import { onPhraseMemoryOnlyChange, phraseHeldInMemoryOnly } from '../phraseAtRest';
import { isTrustedDevice } from '../trustStorage';
import { isDemoMode } from '../demo';

export function PhraseNotSavedBanner() {
  const { t } = useTranslation('security');
  const shown = useSyncExternalStore(onPhraseMemoryOnlyChange, phraseHeldInMemoryOnly, () => false);
  if (shown) return <Banner tone="warning">{t('appLock.phraseInMemoryOnly')}</Banner>;
  // A tab keeps its trust answer for its life, so reading it at render holds.
  if (!isDemoMode() && !isTrustedDevice()) return <Banner tone="info">{t('appLock.untrustedSignIn')}</Banner>;
  return null;
}
