/**
 * On a custodial account, a banner asks this device to allow or deny a new
 * sign-in that asks for the recovery phrase, oldest first. Allow and Deny are
 * signed with the account's key, so only a device that holds the phrase can
 * answer. A request whose wait runs says when it ends. Asked when the vault
 * opens, when the app comes back to the front, and every minute while it is
 * in front, so a person on a new device is not kept waiting; never in the
 * demo.
 * Spec: docs/internal/plans/custodial-release-hardening.md (section 13.2)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';
import { isDemoMode } from '../demo';
import { formatInstant } from '../intlFormat';
import { decideReleaseRequest, pendingReleaseRequests, requestCode, type ReleaseRequest } from '../releaseNotice';
import { Banner, Button, FeedbackButton } from '../ui';

// Spec: docs/internal/plans/custodial-release-hardening.md (13.2: every minute)
const LOOK_EVERY_MS = 60_000;

export function ReleaseApprovalBanner() {
  const { t } = useTranslation('security');
  const { auth, supabase } = useAuth();
  const live = auth.status === 'authenticated' && auth.isCustodial === true ? auth : null;
  const pubkey = live?.pubkey ?? null;
  const [request, setRequest] = useState<ReleaseRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const last = useRef(0);

  const look = useCallback(async (force = false) => {
    if (!pubkey || isDemoMode() || document.hidden) return;
    if (!force && Date.now() - last.current < LOOK_EVERY_MS) return;
    const requests = await pendingReleaseRequests(supabase);
    if (requests === null) return;
    last.current = Date.now();
    setRequest(requests[0] ?? null);
  }, [supabase, pubkey]);

  useEffect(() => {
    if (!pubkey || isDemoMode()) return;
    last.current = 0;
    void look();
    const onVisibility = () => { void look(); };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => { void look(true); }, LOOK_EVERY_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pubkey, look]);

  if (!live || !request) return null;
  const answer = async (allow: boolean) => {
    setBusy(true);
    try {
      // Taken or not (already decided, a key changed elsewhere), the list
      // is read again, so a stale request does not stay.
      await decideReleaseRequest(supabase, request.id, allow, live.pubkey, live.signingPrivateKey);
      await look(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner
      tone="warning"
      action={<>
        <FeedbackButton action="cancel" disabled={busy} onClick={() => void answer(false)}>{t('releaseApproval.deny')}</FeedbackButton>
        <Button action="confirm" disabled={busy} onClick={() => void answer(true)}>{t('releaseApproval.allow')}</Button>
      </>}
    >
      {request.until
        ? t('releaseApproval.waiting', { when: formatInstant(request.until, 'dateTime'), code: requestCode(request.id) })
        : t('releaseApproval.ask', { when: formatInstant(request.at, 'dateTime'), code: requestCode(request.id) })}
    </Banner>
  );
}
