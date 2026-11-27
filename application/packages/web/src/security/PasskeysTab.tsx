import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';
import { ConfirmModal } from '../ConfirmModal';
import { isDemoMode } from '../demo';
import { DEVICE_LABEL_MAX } from '../deviceLabels';
import { buildDeviceName } from '../devices';
import { NO_TEXT_ASSIST } from '../formFields';
import { DeviceMobile, Eye, EyeSlash, Key, Lock, Password, Plus, ShieldCheck } from '../icons';
import { HelpChip } from '../HelpChip';
import { formatInstant } from '../intlFormat';
import { pinIsPasscode } from '../pin';
import {
  beginAddSignInPasskey,
  cancelPendingSignInPasskey,
  finishPasswordSignInPasskey,
  listSignInPasskeys,
  MAX_PASSKEY_SLOTS,
  PASSKEY_PASSWORD_MAX_LENGTH,
  PASSKEY_PASSWORD_MIN_LENGTH,
  passkeyPasswordValid,
  passkeySignInAvailable,
  removeSignInPasskey,
  SIGNIN_PASSKEY_NAME,
  type PendingPasswordPasskey,
  type SignInPasskeySlot,
} from '../passkeySignIn';
import { useSecretOnScreen } from '../privacyScreen';
import { SectionEyebrow, SETTINGS_HELP } from '../settingsUI';
import { Badge, Button, Callout, EmptyState, FeedbackButton, FieldLabel, IconButton, IconTile, Spinner, TextField } from '../ui';
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
 * a new device. Empty state shows a pitch card matching TwoFactorTab; populated
 * list shows each passkey's name, wrap badge (1-click vs passkey password),
 * added/last-used dates, and Remove behind a confirm. Add runs behind the PIN
 * gate that guards viewing the phrase. When the passkey app does not support
 * WebAuthn PRF, pending state lives ABOVE PhrasePinGate so a PIN timeout never
 * unmounts the password form or signals away the newly created passkey.
 * The demo lists nothing and asks nothing.
 * Spec: docs/contrib/passkeys.md (4.4, 4.5)
 */
export function PasskeysTab({ pubkey, hasPin, pinCredential, pinTimeoutMinutes, recovery }: Props) {
  const { t } = useTranslation('security');
  const { phraseChangeActor } = useAuth();
  const ids = useId();
  // The latest accessor, read at each call: the context hands a new function
  // on each render, and the list loads once per mount.
  const actorRef = useRef(phraseChangeActor);
  actorRef.current = phraseChangeActor;
  const available = passkeySignInAvailable();
  const [slots, setSlots] = useState<SignInPasskeySlot[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState(() => buildDeviceName());
  const [pending, setPending] = useState<PendingPasswordPasskey | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SignInPasskeySlot | null>(null);

  const alive = useRef(true);
  const workingRef = useRef(false);
  // Refs own unmount cleanup (StrictMode-safe and immune to effect dependency
  // churn): only an unsaved credential whose `add` has never left the browser
  // is signalled on unmount.
  const pendingRef = useRef<PendingPasswordPasskey | null>(null);
  const addDispatchedRef = useRef(false);

  useSecretOnScreen(showPassword && (password.length > 0 || confirmPassword.length > 0));

  useEffect(() => {
    if (!pending || busy) return;
    const timer = window.setTimeout(() => {
      if (!alive.current || workingRef.current) return;
      cancelPending();
    }, 2 * 60_000);
    return () => window.clearTimeout(timer);
  }, [pending, busy, password, confirmPassword]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // While a Save is in flight, defer cleanup to savePasswordSlot so unmount
      // never zeroes pending.userHandle underneath scrypt or signals a slot
      // whose add request may still settle on the server.
      if (workingRef.current) return;
      if (pendingRef.current && !addDispatchedRef.current) {
        cancelPendingSignInPasskey(pendingRef.current);
      } else {
        pendingRef.current?.userHandle.fill(0);
      }
      pendingRef.current = null;
    };
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

  function clearPasswordFields() {
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  }

  async function startAdd() {
    if (workingRef.current) return;
    workingRef.current = true;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const actor = await actorRef.current();
      if (!actor) { setError(t('passkeysTab.failed')); return; }
      const result = await beginAddSignInPasskey(actor, label.trim() || buildDeviceName());
      if (!alive.current) {
        if (result.ok && result.status === 'needs_password') cancelPendingSignInPasskey(result.pending);
        return;
      }
      if (result.ok && result.status === 'added') {
        setAdding(false);
        setLabel(buildDeviceName());
        await load();
        return;
      }
      if (result.ok && result.status === 'needs_password') {
        // The pending form renders above PhrasePinGate so a PIN timeout never
        // unmounts it mid-typing, without reopening an expired PIN window.
        addDispatchedRef.current = false;
        pendingRef.current = result.pending;
        setPending(result.pending);
        setAdding(false);
        clearPasswordFields();
        return;
      }
      if (!result.ok && result.reason === 'cancelled') return;
      if (!result.ok) {
        setError(result.reason === 'too_many'
          ? t('passkeysTab.tooMany', { count: MAX_PASSKEY_SLOTS })
          : t('passkeysTab.failed'));
      }
    } finally {
      workingRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function savePasswordSlot() {
    const current = pendingRef.current;
    if (!current || workingRef.current) return;
    if (!passkeyPasswordValid(password)) {
      setError(t('passkeysTab.passwordMinHint', { count: PASSKEY_PASSWORD_MIN_LENGTH }));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('passkeysTab.passwordMismatch'));
      return;
    }
    workingRef.current = true;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // Fetch the vault actor only at Save so neither phrase nor bearer sits
      // in React state while the user types.
      const actor = await actorRef.current();
      if (!alive.current) {
        if (!addDispatchedRef.current) cancelPendingSignInPasskey(current);
        else current.userHandle.fill(0);
        pendingRef.current = null;
        addDispatchedRef.current = false;
        return;
      }
      if (!actor) { setError(t('passkeysTab.failed')); return; }
      const result = await finishPasswordSignInPasskey(actor, current, password, {
        onDispatch: () => { addDispatchedRef.current = true; },
        onResetDispatch: () => { addDispatchedRef.current = false; },
        isCancelled: () => !alive.current,
      });
      if (!alive.current) {
        if (result.ok) {
          current.userHandle.fill(0);
        } else if (!addDispatchedRef.current) {
          cancelPendingSignInPasskey(current);
        } else {
          current.userHandle.fill(0);
        }
        pendingRef.current = null;
        addDispatchedRef.current = false;
        return;
      }
      if (result.ok) {
        pendingRef.current = null;
        addDispatchedRef.current = false;
        setPending(null);
        setLabel(buildDeviceName());
        clearPasswordFields();
        await load();
        return;
      }
      if (result.reason === 'cancelled') return;
      if (!result.retryable) {
        if (!addDispatchedRef.current) cancelPendingSignInPasskey(current);
        else current.userHandle.fill(0);
        pendingRef.current = null;
        addDispatchedRef.current = false;
        setPending(null);
        clearPasswordFields();
      }
      setError(result.reason === 'too_many'
        ? t('passkeysTab.tooMany', { count: MAX_PASSKEY_SLOTS })
        : result.reason === 'invalid_password'
          ? t('passkeysTab.passwordMinHint', { count: PASSKEY_PASSWORD_MIN_LENGTH })
          : t('passkeysTab.failed'));
    } finally {
      workingRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function cancelPending() {
    const current = pendingRef.current;
    const dispatched = addDispatchedRef.current;
    pendingRef.current = null;
    if (current && !dispatched) {
      cancelPendingSignInPasskey(current);
    } else {
      current?.userHandle.fill(0);
    }
    addDispatchedRef.current = false;
    setPending(null);
    clearPasswordFields();
    setError(null);
    // After an ambiguous/lost add response, refresh the slot list instead of
    // telling the user to delete a passkey that the server may have stored.
    if (dispatched) {
      setNotice(null);
      void load();
    } else {
      setNotice(t('passkeysTab.passwordCancelled'));
    }
  }

  async function remove(slot: SignInPasskeySlot) {
    setRemoving(null);
    setError(null);
    setNotice(null);
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
  const passwordValid = passkeyPasswordValid(password);
  const passwordMatches = password.length > 0 && password === confirmPassword;
  const showEmptyPitch = available && slots !== null && slots.length === 0 && !loadFailed && !adding && !pending;

  return (
    <div className="space-y-4">
      <SectionEyebrow icon={Password}>{t('notes:vaultFilter.passkeys')}</SectionEyebrow>
      {!showEmptyPitch && <p className={`${SETTINGS_HELP} leading-relaxed`}>{t('passkeysTab.intro')}</p>}

      {loadFailed ? (
        <Callout tone="danger" action={<FeedbackButton action="retry" onClick={() => void load()}>{t('twoFactor.retry')}</FeedbackButton>}>
          {t('passkeysTab.loadFailed')}
        </Callout>
      ) : slots === null ? (
        <div className="flex justify-center py-2"><Spinner size={20} label={t('notes:vaultFilter.passkeys')} /></div>
      ) : showEmptyPitch ? (
        <div className="space-y-4 rounded-lg border border-divider p-4">
          <div className="flex items-center gap-3">
            <IconTile tone="info"><Password aria-hidden="true" /></IconTile>
            <div className="min-w-0 flex-1">
              <p className="text-body font-semibold text-pn">{t('auth:passkeySignIn.button')}</p>
              <p className={SETTINGS_HELP}>{t('passkeysTab.emptySubtitle')}</p>
            </div>
            <Badge tone="neutral">{t('shell:alerts.none')}</Badge>
          </div>
          <ul className="space-y-2">
            {([[DeviceMobile, 'benefitWhere'], [Key, 'benefitModes'], [ShieldCheck, 'benefitBackup']] as const).map(([Icon, key]) => (
              <li key={key} className="flex items-start gap-2.5 text-body text-pn-soft">
                <Icon className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                <span>{t(`passkeysTab.${key}`)}</span>
              </li>
            ))}
          </ul>
          <Button
            variant="primary"
            icon={<Plus aria-hidden="true" />}
            className="w-full"
            disabled={busy}
            onClick={() => { setError(null); setNotice(null); setAdding(true); }}
          >
            {t('passkeysTab.add')}
          </Button>
        </div>
      ) : slots.length === 0 ? (
        <div className="rounded-md border border-divider"><EmptyState compact>{t('passkeysTab.empty')}</EmptyState></div>
      ) : (
        <ul className="divide-y divide-divider rounded-md border border-divider">
          {slots.map((slot) => {
            const added = t('twoFactor.addedOn', { date: formatInstant(slot.createdAt, 'date') });
            return (
              <li key={slot.credentialId} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-body text-pn">
                    <Password className="shrink-0 text-accent" aria-hidden="true" />
                    <span className="min-w-0 truncate">{slot.label ?? added}</span>
                    <Badge tone={slot.wrapKind === 'prf' ? 'success' : 'neutral'}>
                      {t(slot.wrapKind === 'prf' ? 'passkeysTab.badgeOneClick' : 'passkeysTab.badgePassword')}
                    </Badge>
                  </div>
                  <p className="text-small text-pn-muted">
                    {slot.label ? `${added} · ` : ''}
                    {slot.lastUsedAt ? t('passkeysTab.lastUsed', { date: formatInstant(slot.lastUsedAt, 'date') }) : t('passkeysTab.neverUsed')}
                  </p>
                  {!slot.current && <p className="text-small text-warning">{t('passkeysTab.retired')}</p>}
                </div>
                <Button action="remove" disabled={busy || pending !== null} onClick={() => setRemoving(slot)} />
              </li>
            );
          })}
        </ul>
      )}

      {pending ? (
        <form
          className="space-y-3 rounded-lg border border-divider p-4"
          onSubmit={(e) => { e.preventDefault(); void savePasswordSlot(); }}
        >
          <div className="flex items-start gap-3">
            <IconTile tone="info" size="sm"><Lock aria-hidden="true" /></IconTile>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-body font-semibold text-pn">{t('passkeysTab.passwordStepTitle')}</p>
              <p className={`${SETTINGS_HELP} leading-relaxed`}>{t('passkeysTab.passwordStepBody')}</p>
            </div>
          </div>
          {/* Visually hidden (never display:none or type=hidden) username matching the
              passkey's user.name so password managers attach this password to the same item. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            readOnly
            tabIndex={-1}
            aria-hidden="true"
            value={SIGNIN_PASSKEY_NAME}
            className="sr-only"
          />
          <div>
            <FieldLabel htmlFor={`${ids}-pw`} icon={<Key aria-hidden="true" />}>
              {t('auth:passkeySignIn.passwordPlaceholder')}
            </FieldLabel>
            <div className="flex items-center gap-1.5">
              <TextField
                id={`${ids}-pw`}
                type={showPassword ? 'text' : 'password'}
                value={password}
                maxLength={PASSKEY_PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
                {...NO_TEXT_ASSIST}
                disabled={busy}
                autoFocus
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                className="flex-1"
              />
              <IconButton
                label={showPassword ? t('passkeysTab.hidePassword') : t('passkeysTab.showPassword')}
                onClick={() => setShowPassword((s) => !s)}
                disabled={busy}
              >
                {showPassword ? <EyeSlash aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </IconButton>
            </div>
            <p className={`mt-1 ${SETTINGS_HELP}`}>
              {t('passkeysTab.passwordMinHint', { count: PASSKEY_PASSWORD_MIN_LENGTH })}
            </p>
          </div>
          <TextField
            id={`${ids}-pw-confirm`}
            label={t('passkeysTab.passwordConfirmLabel')}
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            maxLength={PASSKEY_PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
            {...NO_TEXT_ASSIST}
            disabled={busy}
            error={confirmPassword.length > 0 && password !== confirmPassword ? t('passkeysTab.passwordMismatch') : undefined}
            onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
          />
          <Callout tone="info">{t('passkeysTab.passwordStepHint')}</Callout>
          <div className="grid grid-cols-2 gap-2">
            <Button action="cancel" className="w-full" disabled={busy} onClick={cancelPending} />
            <Button
              action="confirm"
              variant="primary"
              type="submit"
              className="w-full"
              disabled={busy || !passwordValid || !passwordMatches}
            >
              {busy ? t('passkeysTab.passwordSaving') : t('passkeysTab.passwordSave')}
            </Button>
          </div>
        </form>
      ) : !available ? (
        <p className={SETTINGS_HELP}>{t('passkeysTab.appsOnly')}</p>
      ) : full ? (
        <p className={SETTINGS_HELP}>{t('passkeysTab.tooMany', { count: slots?.length ?? MAX_PASSKEY_SLOTS })}</p>
      ) : adding ? (
        <PhrasePinGate pubkey={pubkey} hasPin={hasPin} pinCredential={pinCredential} pinTimeoutMinutes={pinTimeoutMinutes}
          prompt={pinPrompt} recovery={recovery} onCancel={() => setAdding(false)}>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); if (!busy) void startAdd(); }}
          >
            <TextField
              label={t('shell:vaultItem.fieldName')}
              value={label}
              maxLength={DEVICE_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
            <div className="grid grid-cols-2 gap-2">
              <Button action="cancel" className="w-full" disabled={busy} onClick={() => { setAdding(false); setError(null); }} />
              <Button action="add" type="submit" className="w-full" disabled={busy}>{busy ? t('passkeysTab.adding') : t('passkeysTab.add')}</Button>
            </div>
          </form>
        </PhrasePinGate>
      ) : !showEmptyPitch ? (
        <Button action="add" className="w-full" disabled={slots === null && !loadFailed} onClick={() => { setError(null); setNotice(null); setAdding(true); }}>
          {t('passkeysTab.add')}
        </Button>
      ) : null}

      {notice && <Callout tone="info">{notice}</Callout>}
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
