import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth';
import type { DeviceRow } from './devices';
import { shortDeviceId } from './deviceSlots';
import { formatRelative } from './intlFormat';
import { isPaddleConfigured, isBetaPricing } from './paddle';
import { startProCheckout } from './billing';
import { PRO_PRICE, EARLY_PRICE } from './pricing';
import { PhraseView } from './security/PhraseView';
import { Devices, SignOut } from './icons';
import { DeviceIcon } from './DeviceIcon';
import { Badge, Button, Callout, IconUpgrade, Modal, ModalFooter, SectionEyebrow } from './ui';

/**
 * Blocking modal shown immediately after sign-in when the free-tier
 * active-device cap is hit. No app chrome is rendered behind it - the
 * user must revoke one of the active devices (which immediately frees
 * the slot) or upgrade before they can see any notes.
 *
 * Recently revoked devices are listed for transparency only - they
 * stay in the table for a 72h cooldown window for ghost-row hygiene
 * but no longer occupy a slot. Spec: migration 0043.
 */
export function DeviceLimitModal() {
  const { t } = useTranslation('security');
  const { auth, resolveDeviceLimit, signOut, refreshProStatus } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [showPhrase, setShowPhrase] = useState(false);
  const configured = isPaddleConfigured();

  // No Escape binding on purpose. Escape used to run the same signOut
  // as the button, and signOut erases the stored phrase, the wrapped
  // blobs and the local database - a user who never wrote the phrase
  // down loses the vault on one keypress. That is the exact
  // Escape-to-wipe pattern backlog #121 removed from
  // SessionExpiredModal; the explicit button below (next to the phrase
  // backup link) is the only way out.

  // A paid checkout whose webhook outlives refreshProStatus's ~15 s poll
  // dispatches pro-activation-pending - and the only other listener
  // (NotesView) is unmounted in this state, so the modal must catch it
  // itself or the paying user sits behind the cap with zero feedback.
  const [activationPending, setActivationPending] = useState(false);
  useEffect(() => {
    const onPending = () => setActivationPending(true);
    window.addEventListener('privacynotes:pro-activation-pending', onPending);
    return () =>
      window.removeEventListener('privacynotes:pro-activation-pending', onPending);
  }, []);
  // While pending, keep re-checking: payment is confirmed (the event only
  // fires off checkout.completed), so poll until the webhook lands.
  // refreshProStatus then completes the interrupted registration and this
  // modal unmounts. Silent single attempts - the banner below already
  // carries the message.
  useEffect(() => {
    if (!activationPending) return;
    const interval = window.setInterval(
      () => void refreshProStatus({ silent: true, attempts: 1 }),
      5000,
    );
    return () => window.clearInterval(interval);
  }, [activationPending, refreshProStatus]);

  if (auth.status !== 'device_limit_reached') return null;

  // OAuth users hit by the device cap on a fresh install can't revoke
  // anything (the existing devices may be unreachable) - and signing
  // out only loops them back to OAuth. Their recovery phrase is the
  // escape hatch: writing it down gives them a permanent way back if
  // OAuth ever fails. See gap #22.
  const isOAuth = auth.method === 'oauth';

  const activeDevices = auth.devices.filter((d) => !d.revoked_at);
  const cooldownDevices = auth.devices.filter((d) => d.revoked_at);

  const handleRevoke = async (targetDeviceId: string) => {
    setBusy(targetDeviceId);
    setError(null);
    const result = await resolveDeviceLimit(targetDeviceId);
    if (!result.ok) {
      setError(result.error);
      setBusy(null);
      return;
    }
    // Success - auth state flips to 'authenticated', this modal unmounts.
  };

  return (
    <Modal title={t('deviceLimit.title')} className="max-w-lg p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <p className="text-body text-pn-muted leading-relaxed">
          {t('deviceLimit.body', { limit: auth.limit, count: activeDevices.length })}
        </p>

        {/* Active devices */}
        {activeDevices.length > 0 && (
          <div className="space-y-2">
            <SectionEyebrow icon={Devices}>
              {t('deviceLimit.activeDevices')}
            </SectionEyebrow>
            {activeDevices.map((d) => (
              <DeviceRowView
                key={d.device_id}
                device={d}
                isCurrent={false}
                busy={busy === d.device_id}
                disabled={busy !== null}
                onRevoke={() => handleRevoke(d.device_id)}
              />
            ))}
          </div>
        )}

        {/* Recently removed devices - informational, do not occupy a slot. */}
        {cooldownDevices.length > 0 && (
          <div className="space-y-2">
            <SectionEyebrow>
              {t('settings:devices.recentlyRemoved')}
            </SectionEyebrow>
            {cooldownDevices.map((d) => (
              <div
                key={d.device_id}
                className="flex items-center justify-between gap-3 rounded-md border border-divider px-3 py-2 opacity-60"
              >
                <div className="min-w-0">
                  <div className="text-body font-medium truncate text-pn-muted">
                    {d.device_name}
                  </div>
                  <div className="text-meta text-pn-muted">
                    {t('settings:devices.removedAt', { time: formatRelative(d.revoked_at!) })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <Callout tone="danger">{error}</Callout>}

        {/* Same copy as NotesView's pending banner (notes namespace) so no
            new locale strings are needed; the poll above retries for us. */}
        {activationPending && (
          <Callout tone="warning">{t('notes:banner.proActivationPending')}</Callout>
        )}

        {/* No Paddle (a self-hosted or dev build): no upgrade box; Remove and
            Sign out still lead out. There is no user support to send people to. */}
        {configured && (
          <div className="rounded-md border border-accent/40 bg-accent/5 dark:bg-accent/10 p-4 space-y-2">
            <div className="text-body font-medium">{t('deviceLimit.upgradeHeading')}</div>
            <p className="text-small text-pn-muted leading-relaxed">
              {t('deviceLimit.upgradeBody')}
            </p>
            <Button
              variant="upgrade"
              icon={<IconUpgrade size={16} />}
              className="w-full"
              disabled={checkoutLoading || activationPending}
              onClick={async () => {
                setCheckoutLoading(true);
                try {
                  await startProCheckout(
                    auth.pubkey,
                    () => {
                      void refreshProStatus();
                    },
                    () => {
                      // Desktop return: re-check Pro silently, no payment banner.
                      void refreshProStatus({ silent: true });
                    },
                    // Native IAP failure: reuse the modal's error box so the
                    // tap never fails silently (Play internal test).
                    (reason) => setError(t(`billing:purchaseError.${reason}`)),
                  );
                } catch (err) {
                  console.error('Paddle checkout error:', err);
                } finally {
                  setCheckoutLoading(false);
                }
              }}
            >
              {checkoutLoading ? t('billing:upgrade.ctaOpening') : t('deviceLimit.upgradeCta', { price: isBetaPricing() ? EARLY_PRICE : PRO_PRICE })}
            </Button>
          </div>
        )}

        {isOAuth && (
          // OAuth users may have signed up without ever seeing their
          // recovery phrase. If they hit the device cap and their other
          // devices are unreachable, the phrase is their only way to
          // recover. Reveal on demand. See gap #22.
          <Callout tone="warning" title={t('deviceLimit.saveRecoveryHeading')}>
            <p>{t('deviceLimit.saveRecoveryBody')}</p>
            {showPhrase ? (
              <div className="pt-2">
                <PhraseView
                  phrase={auth.phrase}
                  onCancel={() => setShowPhrase(false)}
                  showCallout={false}
                  cancelLabel={t('deviceLimit.hide')}
                />
              </div>
            ) : (
              <div className="pt-2">
                <Button action="view" onClick={() => setShowPhrase(true)} className="w-full">
                  {t('deviceLimit.viewRecoveryPhrase')}
                </Button>
              </div>
            )}
          </Callout>
        )}

        <ModalFooter>
          <Button
            icon={<SignOut aria-hidden="true" />}
            onClick={() => void signOut({ keepUnsyncedNotes: true })}
            className="w-full sm:w-auto"
            disabled={busy !== null}
          >
            {t('settings:account.signOut')}
          </Button>
        </ModalFooter>
    </Modal>
  );
}

function DeviceRowView({
  device,
  isCurrent,
  busy,
  disabled,
  onRevoke,
}: {
  device: DeviceRow;
  isCurrent: boolean;
  busy: boolean;
  disabled: boolean;
  onRevoke: () => void;
}) {
  const { t } = useTranslation('security');
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-divider px-3 py-2">
      <div className="flex items-center gap-2.5 min-w-0">
        <DeviceIcon row={device} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-body font-medium truncate">
            <span className="truncate">{device.device_name}</span>
            <span className="font-mono text-meta font-normal text-pn-muted shrink-0">{shortDeviceId(device.device_id)}</span>
            {isCurrent && (
              <Badge tone="info">{t('settings:devices.thisDevice')}</Badge>
            )}
          </div>
          <div className="text-meta text-pn-muted">
            {t('deviceLimit.lastActive', { platform: device.platform, when: formatRelative(device.last_seen_at) })}
          </div>
        </div>
      </div>
      <Button
        action="remove"
        variant="danger"
        onClick={onRevoke}
        disabled={disabled}
        className="shrink-0"
      >
        {busy ? t('deviceLimit.removing') : t('common:actions.remove')}
      </Button>
    </div>
  );
}
