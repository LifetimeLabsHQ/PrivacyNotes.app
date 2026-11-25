import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';
import { ConfirmModal } from '../ConfirmModal';
import { isDemoMode } from '../demo';
import { DEVICE_LABEL_MAX } from '../deviceLabels';
import { buildDeviceName } from '../devices';
import { Password } from '../icons';
import { HelpChip } from '../HelpChip';
import { formatInstant } from '../intlFormat';
import { pinIsPasscode } from '../pin';
import {
  addSignInPasskey,
  listSignInPasskeys,
  MAX_PASSKEY_SLOTS,
  passkeySignInAvailable,
  removeSignInPasskey,
  type SignInPasskeySlot,
} from '../passkeySignIn';
import { SectionEyebrow, SETTINGS_HELP } from '../settingsUI';
import { Button, Callout, EmptyState, FeedbackButton, Spinner, TextField } from '../ui';
import { PhrasePinGate, type PinGateRecovery } from './PhrasePinGate';

type Props = {
  pubkey: string;
  hasPin: boolean;
  pinCredential?: string;
  pinTimeoutMinutes: number;
  recovery?: PinGateRecovery;
};

/**
 * Settings > Security > Passkeys: the passkeys that sign this account in on
 * a new device. The intro, the list (name, added, last used, Remove behind a
 * confirm; a slot from before a phrase change is marked retired), then Add,
 * where this origin offers passkey sign-in, behind the PIN gate that guards
 * viewing the phrase: a passkey added here can open the phrase. The tab
 * exists only while the release switch is on (SecurityModal.tsx), and has no
 * help chip until then (P11). The demo lists nothing and asks nothing.
 * Spec: docs/contrib/passkeys.md (4.4, 4.5)
 */
export function PasskeysTab({ pubkey, hasPin, pinCredential, pinTimeoutMinutes, recovery }: Props) {
  const { t } = useTranslation('security');
  const { phraseChangeActor } = useAuth();
  // The latest accessor, read at each call: the context hands a new function
  // on each render, and the list loads once per mount.
  const actorRef = useRef(phraseChangeActor);
  actorRef.current = phraseChangeActor;
  const available = passkeySignInAvailable();
  const [slots, setSlots] = useState<SignInPasskeySlot[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState(() => buildDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SignInPasskeySlot | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    if (isDemoMode()) { setSlots([]); return; }
    const actor = await actorRef.current();
    const listed = actor ? await listSignInPasskeys(actor) : { ok: false as const };
    if (!alive.current) return;
    if (listed.ok) setSlots(listed.slots);
    else setLoadFailed(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function add() {
    setError(null);
    setBusy(true);
    try {
      const actor = await actorRef.current();
      if (!actor) { setError(t('passkeysTab.failed')); return; }
      const result = await addSignInPasskey(actor, label.trim() || buildDeviceName());
      if (!alive.current) return;
      if (result.ok) {
        setAdding(false);
        setLabel(buildDeviceName());
        await load();
        return;
      }
      if (result.reason === 'cancelled') return;
      setError(result.reason === 'no_prf' ? t('passkeysTab.noPrf')
        : result.reason === 'too_many' ? t('passkeysTab.tooMany', { count: MAX_PASSKEY_SLOTS })
        : t('passkeysTab.failed'));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function remove(slot: SignInPasskeySlot) {
    setRemoving(null);
    setError(null);
    setBusy(true);
    try {
      const actor = await actorRef.current();
      const result = actor ? await removeSignInPasskey(actor, slot.credentialId) : { ok: false as const };
      if (!alive.current) return;
      // A slot the server no longer has is gone either way.
      if (!result.ok && !('reason' in result && (result.reason === 'not_found' || result.reason === 'cancelled'))) setError(t('passkeysTab.removeFailed'));
      await load();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const full = (slots?.length ?? 0) >= MAX_PASSKEY_SLOTS;
  // The gate names the kind of secret the account holds; the passcode text is
  // picked here, so the gate needs no entry of its own for this prompt.
  const pinPrompt = pinIsPasscode() ? 'passkeysTab.pinPromptPasscode' : 'passkeysTab.pinPrompt';

  return (
    <div className="space-y-4">
      <SectionEyebrow icon={Password}>{t('notes:vaultFilter.passkeys')}</SectionEyebrow>
      <p className={`${SETTINGS_HELP} leading-relaxed`}>{t('passkeysTab.intro')}</p>

      {loadFailed ? (
        <Callout tone="danger" action={<FeedbackButton action="retry" onClick={() => void load()}>{t('twoFactor.retry')}</FeedbackButton>}>
          {t('passkeysTab.loadFailed')}
        </Callout>
      ) : slots === null ? (
        <div className="flex justify-center py-2"><Spinner size={20} label={t('notes:vaultFilter.passkeys')} /></div>
      ) : slots.length === 0 ? (
        <div className="rounded-md border border-divider"><EmptyState compact>{t('passkeysTab.empty')}</EmptyState></div>
      ) : (
        <ul className="divide-y divide-divider rounded-md border border-divider">
          {slots.map((slot) => {
            const added = t('twoFactor.addedOn', { date: formatInstant(slot.createdAt, 'date') });
            return (
              <li key={slot.credentialId} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="flex items-center gap-2 text-body text-pn">
                    <Password className="shrink-0 text-accent" aria-hidden="true" />
                    <span className="min-w-0 truncate">{slot.label ?? added}</span>
                  </p>
                  <p className="text-small text-pn-muted">
                    {slot.label ? `${added} · ` : ''}
                    {slot.lastUsedAt ? t('passkeysTab.lastUsed', { date: formatInstant(slot.lastUsedAt, 'date') }) : t('passkeysTab.neverUsed')}
                  </p>
                  {!slot.current && <p className="text-small text-warning">{t('passkeysTab.retired')}</p>}
                </div>
                <Button action="remove" disabled={busy} onClick={() => setRemoving(slot)} />
              </li>
            );
          })}
        </ul>
      )}

      {!available ? (
        <p className={SETTINGS_HELP}>{t('passkeysTab.appsOnly')}</p>
      ) : full ? (
        <p className={SETTINGS_HELP}>{t('passkeysTab.tooMany', { count: slots?.length ?? MAX_PASSKEY_SLOTS })}</p>
      ) : adding ? (
        <PhrasePinGate pubkey={pubkey} hasPin={hasPin} pinCredential={pinCredential} pinTimeoutMinutes={pinTimeoutMinutes}
          prompt={pinPrompt} recovery={recovery} onCancel={() => setAdding(false)}>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); if (!busy) void add(); }}
          >
            <TextField
              label={t('shell:vaultItem.fieldName')}
              value={label}
              maxLength={DEVICE_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
            <div className="flex flex-wrap gap-2">
              <Button action="cancel" disabled={busy} onClick={() => { setAdding(false); setError(null); }} />
              <Button action="add" type="submit" disabled={busy}>{busy ? t('passkeysTab.adding') : t('passkeysTab.add')}</Button>
            </div>
          </form>
        </PhrasePinGate>
      ) : (
        <Button action="add" disabled={slots === null && !loadFailed} onClick={() => { setError(null); setAdding(true); }}>{t('passkeysTab.add')}</Button>
      )}

      {error && <Callout tone="danger">{error}</Callout>}

      <HelpChip surface="passkeys" />

      {removing && (
        <ConfirmModal
          title={t('passkeysTab.removeTitle')}
          confirmLabel={t('common:actions.remove')}
          variant="danger"
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        >
          {t('passkeysTab.removeBody')}
        </ConfirmModal>
      )}
    </div>
  );
}
