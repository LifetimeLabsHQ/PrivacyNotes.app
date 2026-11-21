/**
 * On a custodial account, a banner says when the recovery phrase went to
 * another sign-in, one release at a time, oldest first, so a stranger's
 * sign-in does not go unseen behind a later one of the owner's. Asked when
 * the vault opens, when the app comes back to the front, and every 15 minutes
 * while it is in front; never in the demo. A dismiss in one tab clears the
 * others. Devices opens Settings > Account > Overview at the device list,
 * where the person removes a device they do not know.
 * Spec: docs/internal/plans/custodial-release-hardening.md (section 13.1)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';
import { isDemoMode } from '../demo';
import { formatInstant } from '../intlFormat';
import { Devices } from '../icons';
import { markReleaseSeen, nextRelease, releaseSeen, releaseSeenKey } from '../releaseNotice';
import { Banner, FeedbackButton } from '../ui/feedback';

// Spec: docs/internal/plans/custodial-release-hardening.md (13.1: every 15 minutes)
const LOOK_EVERY_MS = 15 * 60_000;

export function ReleaseNoticeBanner({ onOpenDevices }: { onOpenDevices: () => void }) {
  const { t } = useTranslation(['security', 'common', 'billing']);
  const { auth, supabase } = useAuth();
  const pubkey = auth.status === 'authenticated' && auth.isCustodial === true ? auth.pubkey : null;
  const [shown, setShown] = useState<string | null>(null);
  const last = useRef(0);

  const look = useCallback(async (force = false) => {
    if (!pubkey || isDemoMode() || document.hidden) return;
    if (!force && Date.now() - last.current < LOOK_EVERY_MS) return;
    const at = await nextRelease(supabase, pubkey);
    // No answer: the next return to the front asks again.
    if (at === undefined) return;
    last.current = Date.now();
    setShown(at);
  }, [supabase, pubkey]);

  useEffect(() => {
    if (!pubkey || isDemoMode()) return;
    last.current = 0;
    void look();
    const onVisibility = () => { void look(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === releaseSeenKey(pubkey)) setShown((at) => (at && releaseSeen(pubkey, at) ? null : at));
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onStorage);
    const timer = setInterval(() => { void look(true); }, LOOK_EVERY_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
    };
  }, [pubkey, look]);

  if (!pubkey || !shown) return null;
  return (
    <Banner
      tone="warning"
      dismissLabel={t('common:updateToast.dismiss')}
      onDismiss={() => { markReleaseSeen(pubkey, shown); setShown(null); void look(true); }}
      action={<FeedbackButton icon={<Devices size={15} aria-hidden />} onClick={onOpenDevices}>{t('billing:upgrade.pass.devices')}</FeedbackButton>}
    >
      {t('security:releaseNotice.sent', { when: formatInstant(shown, 'dateTime') })}
    </Banner>
  );
}
