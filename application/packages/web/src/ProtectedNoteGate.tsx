import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Fingerprint, Lock, LockKeyOpen, ShieldSlash, Trash } from './icons';
import { PinInput, type PinInputHandle } from './PinInput';
import { SecretInput } from './PasscodeInput';
import { hashPin, hasPin, pinCredentialStamp, pinIsPasscode, verifyPin, recordPinFailure, clearPinFailures, getPinLockoutState, stagePinHash } from './pin';
import { secretReady, type SecretKind } from './secretKind';
import { hasBiometricCredential, unlockWithBiometricDetailed } from './biometric';
import { ForgotPinLink, PinRecoveryForm } from './PinRecoveryForm';
import { signInStamp, signedOutSince } from './liveSignIn';
import { saveCredential, type UserSettings } from './userSettings';
import { Button, Callout, Divider, GateCard, Modal, ModalFooter, SectionEyebrow } from './ui';

/**
 * Inline gate for protected notes. Renders in the editor pane when
 * the selected note is gated. Unlock bubbles up via `onUnlock` so the
 * parent can refresh the shared session timer and all other protected
 * notes become accessible.
 *
 * Handles three modes automatically:
 *
 *   1. **Biometric** - device has biometric enrolled; prompt fingerprint/face.
 *      The PIN screen is one tap away, and so is the way back.
 *   2. **Verify** - a PIN is set; user enters it to unlock.
 *   3. **Bootstrap** - no PIN or biometric. Inline "Set a PIN" prompt.
 *
 * The verify screens draw the field of the secret the account holds, a PIN or
 * a passcode, from the cached hash (`pinIsPasscode`). The bootstrap stays four
 * digits: a passcode is set only in the PIN tab.
 * Spec: docs/internal/plans/app-lock-passcode.md (section 4.4)
 *
 * A fourth screen sits behind all of them: the recovery phrase, for a PIN
 * nobody remembers. Without it a forgotten PIN shuts these notes forever,
 * because the hash is synced and every screen that changes it asks for the
 * old one. Spec: docs/internal/specs/pin-recovery.md
 */
/**
 * A whole protected section behind the gate: the same checks, worded for a
 * section instead of one item. Spec: docs/internal/specs/section-lock.md (section 7)
 */
type GateProps = {
  /** The account's phrase, so a forgotten PIN has a way out. */
  phrase: string;
  onUnlock: () => void;
  /** Drop the note's protection. Runs only behind the same check as an
   *  unlock, so it is no weaker a gate than the one it removes. */
  onRemoveProtection: () => void;
  /** Rendered below md only: on desktop the pane auto-reselects, so
   *  Cancel was a no-op there (the quick-add Cancel had the same fate);
   *  on a phone the gate IS the screen and needs the way back. */
  onCancel?: () => void;
  /** 'remove' opens the gate straight into removal, for the menu action that
   *  has no other screen to ask on. */
  initialIntent?: Intent;
  /** Told when the user backs out of a removal, so a gate opened only to
   *  remove can close. A gate that is also holding a locked note stays: it
   *  simply falls back to unlocking. */
  onExitRemove?: () => void;
  userSettings: UserSettings;
  /** `base` is the copy this surface was rendered with; the parent applies
   *  only the credential keys that differ between it and `next`. */
  onSettingsChange: (next: UserSettings, base: UserSettings) => void;
};

const SectionWordsContext = createContext(false);

export function ProtectedNoteGate({ section = false, ...props }: GateProps & {
  /** Word the screens for a protected section rather than one item. */
  section?: boolean;
}) {
  return (
    <SectionWordsContext.Provider value={section}>
      <GateBody {...props} />
    </SectionWordsContext.Provider>
  );
}

function GateBody({
  phrase,
  onUnlock,
  onRemoveProtection,
  onCancel,
  initialIntent = 'unlock',
  onExitRemove,
  userSettings,
  onSettingsChange,
}: GateProps) {
  const { t } = useTranslation('security');
  const pinIsSet = hasPin();
  const kind: SecretKind = pinIsPasscode() ? 'passcode' : 'pin';
  const bioEnrolled = hasBiometricCredential();
  const [recovering, setRecovering] = useState(false);
  // Which of the two screens is showing. The PIN screen never sets this
  // back, because its biometric button prompts where it stands.
  const [usePin, setUsePin] = useState(false);
  // Why the gate is open. It belongs to the gate rather than to a button on
  // one screen, so a refused fingerprint leaves the user where they meant to
  // be instead of dropping them back into plain unlocking.
  const [intent, setIntent] = useState<Intent>(initialIntent);
  // A gate already on screen for a locked note keeps its own mounted state, so
  // a fresh request from a menu would otherwise land on nothing. Following the
  // prop here is what lets the menus reach a gate that is already open. It runs
  // only when the caller's answer changes, so the gate's own buttons still win.
  useEffect(() => {
    setIntent(initialIntent);
  }, [initialIntent]);
  const removing = intent === 'remove';
  const done = removing ? onRemoveProtection : onUnlock;
  // Backing out of a removal always falls back to unlocking. Whether the gate
  // survives that is the parent's call: it keeps the gate for a locked note
  // and drops it for one that was only ever open to be unprotected.
  const onCancelRemove = () => {
    setIntent('unlock');
    onExitRemove?.();
  };

  // Clearing the PIN drops this gate into BootstrapMode, whose own "set a
  // PIN" step ends in the unlock the user came for.
  if (recovering) {
    return (
      <GateCard
        maxWidth="max-w-sm"
        className="mt-16"
        icon={<Lock aria-hidden="true" />}
        title={kind === 'passcode' ? t('pinRecovery.titlePasscode') : t('pinRecovery.title')}
      >
        <div className="text-start">
          <PinRecoveryForm
            kind={kind}
            phrase={phrase}
            userSettings={userSettings}
            onSettingsChange={onSettingsChange}
            onCleared={() => setRecovering(false)}
            onCancel={() => setRecovering(false)}
          />
        </div>
      </GateCard>
    );
  }

  if (bioEnrolled && !usePin) {
    return (
      <BiometricMode
        done={done}
        removing={removing}
        onStartRemove={() => setIntent('remove')}
        onRemoveProtection={onRemoveProtection}
        onCancelRemove={onCancelRemove}
        onCancel={onCancel}
        showPinFallback={pinIsSet}
        pinKind={kind}
        onUsePin={() => setUsePin(true)}
      />
    );
  }
  return pinIsSet ? (
    <VerifyMode
      kind={kind}
      done={done}
      removing={removing}
      onStartRemove={() => setIntent('remove')}
      onCancelRemove={onCancelRemove}
      onCancel={onCancel}
      showBiometric={bioEnrolled}
      onForgotPin={() => setRecovering(true)}
    />
  ) : (
    <BootstrapMode onUnlock={done} onCancel={onCancel} userSettings={userSettings} onSettingsChange={onSettingsChange} />
  );
}

/** Unlocking the note, or taking its protection off. Both pass the same check. */
type Intent = 'unlock' | 'remove';

/**
 * Runs the OS or WebAuthn prompt and reports a refusal through `setErr`.
 * Shared by the biometric screen and by the "Use biometric instead" button
 * on both PIN screens, which prompt in place rather than switching screens.
 */
function useBiometricUnlock(setErr: (msg: string | null) => void) {
  const { t } = useTranslation('security');
  const [busy, setBusy] = useState(false);

  async function run(onSuccess: () => void) {
    setBusy(true);
    setErr(null);
    // Reason line the OS prompt renders; reuses the lock-screen label. The
    // second string labels the cancel button Android draws itself.
    const { phrase, failure } = await unlockWithBiometricDetailed(
      t('lockScreen.unlockWithBiometrics'),
      t('common:actions.cancel'),
    );
    if (phrase) {
      onSuccess();
    } else {
      // A hardware key the OS destroyed gets the lock screen's line: biometric
      // unlock must be set up again, and the PIN below still opens the item.
      setErr(
        failure === 'gone' ? t('lockScreen.biometricGone')
          : failure === 'unopened' ? t('lockScreen.biometricUnopened')
          : t('security:lockScreen.biometricFailed'),
      );
      setBusy(false);
    }
  }

  return { busy, run };
}

/* ────────────────────────────────────────────────────────────────
 * Biometric - device has fingerprint/face enrolled
 * ──────────────────────────────────────────────────────────────── */

function BiometricMode({
  done,
  removing = false,
  onStartRemove,
  onRemoveProtection,
  onCancelRemove,
  onCancel,
  showPinFallback,
  pinKind = 'pin',
  onUsePin,
  compact = false,
}: {
  /** What a passed check performs: unlock the note, or take the lock off. */
  done: () => void;
  removing?: boolean;
  /** Absent where removing protection is not on offer, such as the modal
   *  that gates a delete. */
  onStartRemove?: () => void;
  onRemoveProtection?: () => void;
  onCancelRemove?: () => void;
  onCancel?: () => void;
  showPinFallback: boolean;
  /** Names the fallback button after the secret the account holds. */
  pinKind?: SecretKind;
  onUsePin: () => void;
  /** Inside the modal the box supplies its own padding. */
  compact?: boolean;
}) {
  const { t } = useTranslation('security');
  const section = useContext(SectionWordsContext);
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useBiometricUnlock(setErr);
  const offersRemove = Boolean(onStartRemove && onRemoveProtection);

  const subtitle = removing
    ? t('protectedGate.disableBiometricSubtitle')
    : section ? t('protectedGate.sectionBiometricSubtitle') : t('protectedGate.biometricSubtitle');

  const controls = (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          {onCancel && !removing && (
            <Button action="cancel" onClick={onCancel} className="md:hidden flex-1" />
          )}
          <Button
            variant={removing ? 'danger' : 'primary'}
            icon={removing ? <ShieldSlash aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}
            onClick={() => void run(done)}
            disabled={busy}
            className="flex-1"
          >
            {busy
              ? t('security:lockScreen.verifying')
              : removing
                ? t('protectedGate.disableProtection')
                : t('security:lockScreen.unlock')}
          </Button>
        </div>
        {showPinFallback && (
          <Button variant="secondary" icon={<Lock aria-hidden="true" />} onClick={onUsePin} className="w-full">
            {pinKind === 'passcode' ? t('protectedGate.usePasscodeInstead') : t('protectedGate.usePinInstead')}
          </Button>
        )}
        {offersRemove && (
          <>
            {/* The two above are ways INTO the note. What follows changes the
                note itself, so it sits under a rule rather than reading as a
                third way in. */}
            <Divider />
            {removing ? (
              <Button action="cancel" onClick={() => { setErr(null); onCancelRemove?.(); }} className="w-full" />
            ) : (
              <Button
                variant="danger"
                icon={<ShieldSlash aria-hidden="true" />}
                onClick={() => { onStartRemove?.(); void run(onRemoveProtection!); }}
                disabled={busy}
                className="w-full"
              >
                {t('protectedGate.disableProtection')}
              </Button>
            )}
          </>
        )}
      </div>
      {err && <p className="text-body text-danger">{err}</p>}
    </>
  );

  if (compact) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-body text-pn-muted leading-relaxed">{subtitle}</p>
        {controls}
      </div>
    );
  }

  return (
    <GateCard
      maxWidth="max-w-sm"
      className="mt-16"
      tone={removing ? 'danger' : 'info'}
      icon={removing ? <ShieldSlash aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}
      title={removing ? t('protectedGate.disableProtection') : section ? t('protectedGate.sectionTitle') : t('protectedGate.protectedItem')}
      subtitle={subtitle}
    >
      {controls}
    </GateCard>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Verify - device already has a PIN
 * ──────────────────────────────────────────────────────────────── */

function VerifyMode({
  kind,
  done,
  removing = false,
  onStartRemove,
  onCancelRemove,
  onCancel,
  showBiometric = false,
  onForgotPin,
}: {
  kind: SecretKind;
  /** What a correct PIN performs: unlock the note, or take the lock off. */
  done: () => void;
  removing?: boolean;
  /** Absent where removing protection is not on offer. */
  onStartRemove?: () => void;
  onCancelRemove?: () => void;
  onCancel?: () => void;
  /** True only when this device has biometric enrolled, so the button is
   *  absent where there is no finger to ask for. */
  showBiometric?: boolean;
  /** Opens the phrase route. Absent while removing protection, where the
   *  user is not locked out of anything. */
  onForgotPin?: () => void;
}) {
  const { t } = useTranslation('security');
  const section = useContext(SectionWordsContext);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockout, setLockout] = useState(() => getPinLockoutState());
  const inputRef = useRef<PinInputHandle>(null);
  const bio = useBiometricUnlock(setErr);

  // Switching between unlock and remove keeps the same input mounted, so its
  // autoFocus does not fire again and the caret is left wherever the button
  // click put it.
  useEffect(() => {
    inputRef.current?.focus();
  }, [removing]);

  // Countdown timer during lockout.
  useEffect(() => {
    if (!lockout.locked) return;
    const id = setInterval(() => {
      const state = getPinLockoutState();
      setLockout(state);
      if (!state.locked) setErr(null);
    }, 1000);
    return () => clearInterval(id);
  }, [lockout.locked]);

  async function submit(candidate: string) {
    if (!secretReady(kind, candidate) || busy) return;
    // The counter is shared by every PIN surface, so it is read at submit and
    // not only from the state this screen mounted with.
    const current = getPinLockoutState();
    if (current.locked) {
      setLockout(current);
      setErr(t('security:lockScreen.tooManyAttempts', { seconds: current.secondsLeft }));
      return;
    }
    setBusy(true);
    setErr(null);
    const stamp = pinCredentialStamp();
    const { valid: ok } = await verifyPin(candidate);
    // The secret changed on another device during the check: the answer is
    // about a secret the account no longer holds, so it opens nothing.
    if (pinCredentialStamp() !== stamp) {
      setValue('');
      setBusy(false);
      inputRef.current?.clear();
      return;
    }
    if (ok) {
      clearPinFailures();
      done();
    } else {
      const state = recordPinFailure();
      setLockout(state);
      setErr(state.locked
        ? t('security:lockScreen.tooManyAttempts', { seconds: state.secondsLeft })
        : kind === 'passcode' ? t('security:lockScreen.incorrectPasscodeRetry') : t('security:lockScreen.incorrectPinRetry'));
      setValue('');
      setBusy(false);
      inputRef.current?.clear();
    }
  }

  const disabled = busy || lockout.locked;

  return (
    <GateCard
      maxWidth="max-w-sm"
      className="mt-16"
      tone={removing ? 'danger' : 'info'}
      icon={removing ? <ShieldSlash aria-hidden="true" /> : <Lock aria-hidden="true" />}
      title={removing
        ? kind === 'passcode' ? t('protectedGate.disableTitlePasscode') : t('protectedGate.disableTitle')
        : section ? t('protectedGate.sectionTitle') : t('protectedGate.protectedItem')}
      subtitle={removing
        ? section ? t('protectedGate.sectionDisableSubtitle') : t('protectedGate.disableSubtitle')
        : section
          ? kind === 'passcode' ? t('protectedGate.sectionVerifySubtitlePasscode') : t('protectedGate.sectionVerifySubtitle')
          : kind === 'passcode' ? t('protectedGate.verifySubtitlePasscode') : t('protectedGate.verifySubtitle')}
    >
      <SecretInput
        kind={kind}
        ref={inputRef}
        value={value}
        onChange={(v) => {
          setValue(v);
          setErr(null);
        }}
        onComplete={(v) => void submit(v)}
        autoFocus
        disabled={disabled}
      />
      {err && (
        <p className="text-body text-danger">{err}</p>
      )}
      {lockout.locked && (
        <p className="text-small text-pn-muted">
          {t('protectedGate.lockedFor', { seconds: lockout.secondsLeft })}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          {onCancel && !removing && (
            <Button action="cancel" onClick={onCancel} className="md:hidden flex-1" />
          )}
          <Button
            variant={removing ? 'danger' : 'primary'}
            icon={removing ? <ShieldSlash aria-hidden="true" /> : <LockKeyOpen aria-hidden="true" />}
            onClick={() => void submit(value)}
            disabled={!secretReady(kind, value) || disabled}
            className="flex-1"
          >
            {busy
              ? t('security:lockScreen.checking')
              : removing
                ? t('protectedGate.disableProtection')
                : t('security:lockScreen.unlock')}
          </Button>
        </div>
        {showBiometric && (
          <Button
            variant="secondary"
            icon={<Fingerprint aria-hidden="true" />}
            onClick={() => void bio.run(done)}
            disabled={bio.busy}
            className="w-full"
          >
            {bio.busy ? t('security:lockScreen.verifying') : t('protectedGate.useBiometricInstead')}
          </Button>
        )}
        {onForgotPin && !removing && <ForgotPinLink kind={kind} onClick={onForgotPin} />}
        {onStartRemove && (
          <>
            <Divider />
            {removing ? (
              <Button action="cancel" onClick={() => { setErr(null); onCancelRemove?.(); }} className="w-full" />
            ) : (
              <Button
                variant="danger"
                icon={<ShieldSlash aria-hidden="true" />}
                onClick={() => { setErr(null); onStartRemove(); }}
                className="w-full"
              >
                {t('protectedGate.disableProtection')}
              </Button>
            )}
          </>
        )}
      </div>
    </GateCard>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Bootstrap - no PIN set yet
 * ──────────────────────────────────────────────────────────────── */

function BootstrapMode({
  onUnlock,
  onCancel,
  userSettings,
  onSettingsChange,
  compact = false,
}: {
  onUnlock: () => void;
  onCancel?: () => void;
  userSettings: UserSettings;
  /** `base` is the copy this surface was rendered with; the parent applies
   *  only the credential keys that differ between it and `next`. */
  onSettingsChange: (next: UserSettings, base: UserSettings) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation('security');
  const section = useContext(SectionWordsContext);
  const [pin, setNewPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<PinInputHandle>(null);

  async function submit(pinVal: string, confirmVal: string) {
    setErr(null);
    if (pinVal.length !== 4) {
      setErr(t('security:pinTab.pinFourDigits'));
      return;
    }
    if (pinVal !== confirmVal) {
      setErr(t('security:pinTab.pinsDoNotMatch'));
      return;
    }
    setBusy(true);
    const startedAt = signInStamp();
    try {
      const hashed = await hashPin(pinVal);
      // A sign-out during the hash cleared the settings this would write back.
      if (signedOutSince(startedAt)) {
        setBusy(false);
        return;
      }
      // The hash goes into this device's cache first, read back, then the
      // settings save commits, read back too; a refusal of either says so and
      // leaves no PIN anywhere. A PIN set elsewhere meanwhile is not replaced
      // by this first one.
      const putBackHash = stagePinHash(hashed);
      if (!putBackHash || !saveCredential({ ...userSettings, ...hashed }, userSettings, onSettingsChange, { pinSalt: null, pinHash: null })) {
        putBackHash?.();
        setErr(t('pinTab.changeNotSaved'));
        setBusy(false);
        return;
      }
      // Storing the PIN is enough - the session is now considered
      // unlocked and the parent advances.
      onUnlock();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const subtitle = section ? t('protectedGate.sectionBootstrapSubtitle') : t('protectedGate.bootstrapSubtitle');
  const fields = (
    <div className="space-y-4 text-start">
      <Callout tone="warning">
        {t('protectedGate.bootstrapWarning')}
      </Callout>
      <div className="space-y-2">
        <SectionEyebrow className="justify-center">
          {t('security:pinTab.newPin')}
        </SectionEyebrow>
        <PinInput
          value={pin}
          onChange={(v) => {
            setNewPin(v);
            setErr(null);
          }}
          onComplete={() => confirmRef.current?.focus()}
          autoFocus
          disabled={busy}
        />
      </div>
      <div className="space-y-2">
        <SectionEyebrow className="justify-center">
          {t('security:pinTab.confirmPin')}
        </SectionEyebrow>
        <PinInput
          ref={confirmRef}
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            setErr(null);
          }}
          onComplete={(v) => void submit(pin, v)}
          disabled={busy}
        />
      </div>
      {err && (
        <p className="text-body text-danger text-center">
          {err}
        </p>
      )}
      <div className="flex gap-2">
        {onCancel && !compact && (
          <Button action="cancel" onClick={onCancel} className="md:hidden flex-1" />
        )}
        <Button
          variant="primary"
          icon={<Lock aria-hidden="true" />}
          onClick={() => void submit(pin, confirm)}
          disabled={busy || pin.length !== 4 || confirm.length !== 4}
          className="flex-1"
        >
          {busy ? t('common:state.saving') : t('protectedGate.setPinUnlock')}
        </Button>
      </div>
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-4">
        <p className="text-body text-pn-muted leading-relaxed">{subtitle}</p>
        {fields}
      </div>
    );
  }

  return (
    <GateCard
      maxWidth="max-w-sm"
      className="mt-12"
      icon={<Lock aria-hidden="true" />}
      title={t('protectedGate.bootstrapTitle')}
      subtitle={subtitle}
    >
      {fields}
    </GateCard>
  );
}

/* ────────────────────────────────────────────────────────────────
 * PinGateModal - modal overlay for PIN verification before an action on
 * a protected note: a destructive one (delete, shred), or one that reads
 * the note out (an export, its history), which is worded as an unlock.
 * ──────────────────────────────────────────────────────────────── */

export type PinGatePurpose = 'delete' | 'unlock';

export function PinGateModal({
  onUnlock,
  onCancel,
  purpose,
  userSettings,
  onSettingsChange,
}: {
  onUnlock: () => void;
  onCancel: () => void;
  purpose: PinGatePurpose;
  /** For the PIN this modal asks to be set when none is. */
  userSettings: UserSettings;
  onSettingsChange: (next: UserSettings, base: UserSettings) => void;
}) {
  const { t } = useTranslation('security');
  const pinIsSet = hasPin();
  const kind: SecretKind = pinIsPasscode() ? 'passcode' : 'pin';
  const bioEnrolled = hasBiometricCredential();
  const [usePin, setUsePin] = useState(false);

  const modalTitle = bioEnrolled && !usePin
    ? t('protectedGate.protectedItem')
    : pinIsSet
      ? purpose === 'delete'
        ? kind === 'passcode' ? t('protectedGate.passcodeRequired') : t('protectedGate.pinRequired')
        : t('protectedGate.protectedItem')
      : t('protectedGate.bootstrapTitle');

  return (
    <Modal
      onClose={onCancel}
      layer="z-[60]"
      icon={<Lock aria-hidden="true" />}
      title={modalTitle}
      className="max-w-sm p-6 space-y-4"
    >
      {bioEnrolled && !usePin ? (
        <BiometricMode
          done={onUnlock}
          showPinFallback={pinIsSet}
          pinKind={kind}
          onUsePin={() => setUsePin(true)}
          compact
        />
      ) : pinIsSet ? (
        <ModalVerifyMode kind={kind} onUnlock={onUnlock} showBiometric={bioEnrolled} purpose={purpose} />
      ) : (
        /* No PIN and no fingerprint: set a PIN first, as the read gate on
           the same note asks, and the action runs once it is stored. */
        <BootstrapMode onUnlock={onUnlock} userSettings={userSettings} onSettingsChange={onSettingsChange} compact />
      )}
      <ModalFooter>
        <Button action="cancel" onClick={onCancel} />
      </ModalFooter>
    </Modal>
  );
}

/**
 * Compact verify mode for the modal - same logic as VerifyMode but
 * with a shorter subtitle and no top margin. A delete asks in red with the
 * delete wording; anything else asks with the unlock wording the note pane
 * uses, so an export never reads as a deletion.
 */
function ModalVerifyMode({
  kind,
  onUnlock,
  showBiometric = false,
  purpose,
}: {
  kind: SecretKind;
  onUnlock: () => void;
  showBiometric?: boolean;
  purpose: PinGatePurpose;
}) {
  const { t } = useTranslation('security');
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockout, setLockout] = useState(() => getPinLockoutState());
  const inputRef = useRef<PinInputHandle>(null);
  const bio = useBiometricUnlock(setErr);

  useEffect(() => {
    if (!lockout.locked) return;
    const id = setInterval(() => {
      const state = getPinLockoutState();
      setLockout(state);
      if (!state.locked) setErr(null);
    }, 1000);
    return () => clearInterval(id);
  }, [lockout.locked]);

  async function submit(candidate: string) {
    if (!secretReady(kind, candidate) || busy) return;
    // The counter is shared by every PIN surface, so it is read at submit and
    // not only from the state this screen mounted with.
    const current = getPinLockoutState();
    if (current.locked) {
      setLockout(current);
      setErr(t('security:lockScreen.tooManyAttempts', { seconds: current.secondsLeft }));
      return;
    }
    setBusy(true);
    setErr(null);
    const stamp = pinCredentialStamp();
    const { valid: ok } = await verifyPin(candidate);
    // The secret changed on another device during the check: the answer is
    // about a secret the account no longer holds, so it opens nothing.
    if (pinCredentialStamp() !== stamp) {
      setValue('');
      setBusy(false);
      inputRef.current?.clear();
      return;
    }
    if (ok) {
      clearPinFailures();
      onUnlock();
    } else {
      const state = recordPinFailure();
      setLockout(state);
      setErr(state.locked
        ? t('security:lockScreen.tooManyAttempts', { seconds: state.secondsLeft })
        : kind === 'passcode' ? t('security:lockScreen.incorrectPasscodeRetry') : t('security:lockScreen.incorrectPinRetry'));
      setValue('');
      setBusy(false);
      inputRef.current?.clear();
    }
  }

  const disabled = busy || lockout.locked;
  const subtitle = purpose === 'delete'
    ? kind === 'passcode' ? t('protectedGate.deleteSubtitlePasscode') : t('protectedGate.deleteSubtitle')
    : kind === 'passcode' ? t('protectedGate.verifySubtitlePasscode') : t('protectedGate.verifySubtitle');

  return (
    <div className="space-y-4 text-center">
      <p className="text-body text-pn-muted leading-relaxed">{subtitle}</p>
      <SecretInput
        kind={kind}
        ref={inputRef}
        value={value}
        onChange={(v) => {
          setValue(v);
          setErr(null);
        }}
        onComplete={(v) => void submit(v)}
        autoFocus
        disabled={disabled}
      />
      {err && (
        <p className="text-body text-danger">{err}</p>
      )}
      {lockout.locked && (
        <p className="text-small text-pn-muted">
          {t('protectedGate.lockedFor', { seconds: lockout.secondsLeft })}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Button
          variant={purpose === 'delete' ? 'danger' : 'primary'}
          icon={purpose === 'delete' ? <Trash aria-hidden="true" /> : <LockKeyOpen aria-hidden="true" />}
          onClick={() => void submit(value)}
          disabled={!secretReady(kind, value) || disabled}
          className="w-full"
        >
          {busy
            ? t('security:lockScreen.checking')
            : purpose === 'delete' ? t('protectedGate.confirmDelete') : t('security:lockScreen.unlock')}
        </Button>
        {showBiometric && (
          <Button
            variant="secondary"
            icon={<Fingerprint aria-hidden="true" />}
            onClick={() => void bio.run(onUnlock)}
            disabled={bio.busy}
            className="w-full"
          >
            {bio.busy ? t('security:lockScreen.verifying') : t('protectedGate.useBiometricInstead')}
          </Button>
        )}
      </div>
    </div>
  );
}
