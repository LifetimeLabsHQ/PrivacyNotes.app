import { Check, ShieldSlash, Timer } from '../icons';
import { Button, Callout, CompareTiles, Modal, ModalFooter, type CompareTile } from '../ui';
import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  buildPinWrap,
  hasBiometricCredential,
  hasPinWrappedPhrase,
  isBiometricKeyBound,
  onWrappedBlobChange,
  removeStoredPhrase,
  sealedLocalPinWrap,
  storeBuiltPinWrap,
} from '../biometric';
import { HelpChip } from '../HelpChip';
import {
  holdPinSurface,
  cachedPinCredential,
  clearPinFailures,
  credentialStamp,
  getPinLockoutState,
  hashPin,
  hasPin,
  markPinUnlocked,
  pinChangeNeedsWrap,
  pinCredentialStamp,
  pinIsPasscode,
  recordPinFailure,
  stagePinHash,
  verifyPin,
  type PinCredential,
} from '../pin';
import { clearPin, dropLocalPinWrapIfNotKept, keepsLocalPinWrap, restoreUnsavedClear } from '../pinRecovery';
import { inNativeShell, noDeviceKeyHere, storedPhraseUnwrapped } from '../phraseAtRest';
import { isTrustedDevice } from '../trustStorage';
import { signInStamp, signedOutSince } from '../liveSignIn';
import { ForgotPinLink, PinRecoveryForm } from '../PinRecoveryForm';
import { PinInput, type PinInputHandle } from '../PinInput';
import { PasscodeInput, SecretInput } from '../PasscodeInput';
import {
  isValidPasscode,
  normalizeSecret,
  PASSCODE_MAX_CHARS,
  PASSCODE_MIN_CHARS,
  passcodeRules,
  secretReady,
  type SecretKind,
} from '../secretKind';
import { SectionEyebrow, SETTINGS_HELP } from '../settingsUI';
import { loadLocalSettings, saveCredential, takePinChangeLost, type UserSettings } from '../userSettings';

/**
 * PIN tab - set, change, or remove the account's secret inline, a 4-digit PIN
 * or a longer passcode, switch between the two, and pick how long an unlock
 * lasts. That window covers the phrase view and PIN-protected notes; it is
 * set in the Lock tab beside the app lock's own (#662), and this tab points
 * there. A switch is a change: the
 * current secret first, then the new hash and wrap in one write.
 * Spec: docs/internal/plans/app-lock-passcode.md
 */
export function PinTab({
  phrase,
  onOpenLockTab,
  userSettings,
  onSettingsChange,
  reason,
  onPinCreated,
}: {
  phrase: string;
  /** Open the Lock tab, which holds the window this tab's PIN times. */
  onOpenLockTab: () => void;
  userSettings: UserSettings;
  /** `base` is the copy this surface was rendered with; the parent applies
   *  only the credential keys that differ between it and `next`. */
  onSettingsChange: (next: UserSettings, base: UserSettings) => void;
  /** Why the user landed here, when it was not their own idea. Protecting
   *  a note opens this tab, and without a word of explanation the demand
   *  for a PIN reads as an arbitrary one. */
  reason?: 'protect';
  /** A PIN now exists. The parent uses it to return a user who was sent here
   *  from another tab to create one. */
  onPinCreated?: () => void;
}) {
  const { t } = useTranslation('security');
  // Read `hasPin()` once on mount and flip locally on set/remove so the
  // UI transitions without remounting.
  const [pinExists, setPinExists] = useState(() => hasPin());
  // Read once per opening of the tab, which clears it.
  const [changeLost] = useState(() => takePinChangeLost());
  // The kind the account holds, read from its hash salt, and the kind the
  // new-secret step sets.
  const [existingKind, setExistingKind] = useState<SecretKind>(() => (pinIsPasscode() ? 'passcode' : 'pin'));
  // A first secret defaults to a passcode where the OS keeps no device key
  // (the web, a shell without one): C2 seals the PIN wrap under that key, and
  // where it cannot, a copy of the storage gives a 4-digit PIN up to an
  // offline search in minutes.
  // Spec: docs/internal/plans/pin-wrap-hardening.md (section 5, C1 (b))
  const [defaultKind, setDefaultKind] = useState<SecretKind>(() => (inNativeShell() ? 'pin' : 'passcode'));
  const [newKind, setNewKind] = useState<SecretKind>(() =>
    pinIsPasscode() || (!hasPin() && !inNativeShell()) ? 'passcode' : 'pin');
  // The kind a first secret starts on, on every way back to that step.
  const firstKind = (): SecretKind => (pinIsPasscode() ? 'passcode' : hasPin() ? 'pin' : defaultKindRef.current);
  const defaultKindRef = useRef(defaultKind);
  defaultKindRef.current = defaultKind;
  const [oldPinVerified, setOldPinVerified] = useState(false);
  // The phrase route out of a forgotten PIN, and the line that says it
  // worked. Spec: docs/internal/specs/pin-recovery.md
  const [recovering, setRecovering] = useState(false);
  // The kind that was cleared, for the line that says it worked.
  const [recovered, setRecovered] = useState<SecretKind | null>(null);
  const [oldPin, setOldPin] = useState('');
  const [oldPinError, setOldPinError] = useState<string | null>(null);
  const [oldPinBusy, setOldPinBusy] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kindFromTiles = useRef(false);
  // Anything typed in the new-secret fields: a late default never moves it.
  const typedRef = useRef('');
  typedRef.current = pin + confirm;
  // A shell learns whether it has a device key from storage, so its default
  // arrives after the first render, and only while nothing was picked or typed.
  useEffect(() => {
    if (!inNativeShell()) return;
    let live = true;
    void noDeviceKeyHere().then((none) => {
      if (!live || !none) return;
      setDefaultKind('passcode');
      defaultKindRef.current = 'passcode';
      if (!hasPin() && !kindFromTiles.current && !typedRef.current) setNewKind('passcode');
    });
    return () => { live = false; };
  }, []);
  const [savedFlash, setSavedFlash] = useState(false);
  const [lockout, setLockout] = useState(() => getPinLockoutState());
  const oldPinRef = useRef<PinInputHandle>(null);
  const newPinRef = useRef<PinInputHandle>(null);
  const confirmRef = useRef<PinInputHandle>(null);

  useEffect(() => {
    if (!lockout.locked) return;
    const id = setInterval(() => {
      const state = getPinLockoutState();
      setLockout(state);
      if (!state.locked) setOldPinError(null);
    }, 1000);
    return () => clearInterval(id);
  }, [lockout.locked]);

  // A secret changed on another device reaches this tab as new settings, after
  // the sync pass refreshed the hash cache. The tab re-reads what the account
  // holds and asks for the current secret again, so it never draws a field for
  // a secret the account no longer has. Its own writes land here too, and find
  // the state they already set.
  const credential = `${userSettings.pinHash ?? ''}:${userSettings.pinSalt ?? ''}`;
  const seenCredential = useRef(credential);
  // The cached hash the current-secret step proved, which a change must
  // still find in place when it saves.
  const proved = useRef<PinCredential | null>(null);
  function followAccount() {
    const kind: SecretKind = pinIsPasscode() ? 'passcode' : 'pin';
    setPinExists(hasPin());
    setExistingKind(kind);
    setNewKind(firstKind());
    kindFromTiles.current = false;
    setOldPinVerified(false);
    proved.current = null;
    setOldPin('');
    setOldPinError(null);
    setPin('');
    setConfirm('');
  }
  useEffect(() => {
    if (seenCredential.current === credential) return;
    seenCredential.current = credential;
    followAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential]);

  // The biometric line below reads storage while it renders; a change another
  // tab makes (an enrollment, a set-up-again, a removal) renders it again.
  const [, setBlobVersion] = useState(0);
  useEffect(() => onWrappedBlobChange(() => setBlobVersion((v) => v + 1)), []);
  // A PIN screen holding a proof of the secret: a held PIN rehash waits
  // until it closes (pin-wrap-hardening.md section 3).
  useEffect(() => holdPinSurface(), []);

  const needsOldPin = pinExists && !oldPinVerified;
  // While biometric unlock on this device is a presence gate, its wrap key
  // sits beside the wrap it opens, so it is the weaker door and a longer
  // secret here does not raise the cost of a stolen copy of the storage.
  // Spec: docs/internal/plans/biometric-key-binding.md (part C)
  const biometricWeaker = hasBiometricCredential() && !isBiometricKeyBound();
  // The wrap failed on this browser and the phrase sits as plain text; the
  // app lock is what takes it out of storage.
  // Spec: docs/public/THREAT_MODEL.md (The phrase itself is wrapped)
  const phraseUnwrapped = storedPhraseUnwrapped();

  async function verifyOldPin(candidate: string) {
    if (!secretReady(existingKind, candidate) || oldPinBusy) return;
    // The counter is shared by every PIN surface, so it is read at submit and
    // not only from the state this tab mounted with.
    const current = getPinLockoutState();
    if (current.locked) {
      setLockout(current);
      setOldPinError(t('security:lockScreen.tooManyAttempts', { seconds: current.secondsLeft }));
      return;
    }
    setOldPinBusy(true);
    setOldPinError(null);
    const startedAt = signInStamp();
    const credentialAtStart = seenCredential.current;
    const checked = cachedPinCredential();
    const stamp = credentialStamp(checked);
    const { valid: ok } = await verifyPin(candidate);
    // The secret changed during the check, on another device or in another
    // tab of this browser (which reaches the cache and not these props): this
    // answer is about a secret the account no longer holds, so it opens nothing.
    if (seenCredential.current !== credentialAtStart || pinCredentialStamp() !== stamp) {
      setOldPinBusy(false);
      return;
    }
    if (ok) {
      clearPinFailures();
      // If app lock is enabled but no local PIN wrap exists, create it
      // and sync the blob so all devices get it.
      // The flag is synced and the wrap is not: a device the user marked
      // untrusted can be told the lock is on by another device, and must
      // still not write a durable copy of the phrase here.
      if (userSettings.appLockEnabled && isTrustedDevice() && !hasPinWrappedPhrase()) {
        // Built in memory and stored only while the secret is still the
        // account's, with no await in between, so a wrap under a secret
        // replaced meanwhile never overwrites the newer one.
        const blob = await buildPinWrap(phrase, candidate);
        // This device's copy, sealed under the device key in the apps before
        // the last check, so the wrap never lands plain (pinWrapSeal.ts).
        const local = await sealedLocalPinWrap(blob);
        if (pinCredentialStamp() !== stamp || seenCredential.current !== credentialAtStart) {
          setOldPinBusy(false);
          return;
        }
        storeBuiltPinWrap(blob, startedAt, local);
        removeStoredPhrase();
        onSettingsChange({ ...userSettings, ...blob }, userSettings);
      }
      proved.current = checked;
      setOldPinVerified(true);
      setOldPin('');
      setTimeout(() => newPinRef.current?.focus(), 50);
    } else {
      const state = recordPinFailure();
      setLockout(state);
      setOldPinError(state.locked
        ? t('security:lockScreen.tooManyAttempts', { seconds: state.secondsLeft })
        : existingKind === 'passcode' ? t('pinTab.incorrectPasscode') : t('pinTab.incorrectPin'));
      setOldPin('');
      oldPinRef.current?.clear();
    }
    setOldPinBusy(false);
  }

  function reset() {
    setPin('');
    setConfirm('');
    setError(null);
  }

  async function submit(pinVal: string, confirmVal: string) {
    setError(null);
    // A passcode that breaks a rule gets no line here: the live checks under
    // the field already say which one.
    const problem = newKind === 'passcode'
      ? !isValidPasscode(pinVal) ? ''
        : normalizeSecret(pinVal) !== normalizeSecret(confirmVal) ? t('pinTab.passcodesDoNotMatch') : null
      : pinVal.length !== 4 ? t('pinTab.pinFourDigits')
        : pinVal !== confirmVal ? t('pinTab.pinsDoNotMatch') : null;
    if (problem !== null) {
      if (problem) setError(problem);
      return;
    }
    // The secret this replaces: the one the current-secret step proved, or
    // none when the account has none yet.
    const replacing: PinCredential | null = pinExists ? proved.current : { pinSalt: null, pinHash: null };
    if (!replacing) {
      followAccount();
      return;
    }
    setBusy(true);
    const startedAt = signInStamp();
    try {
      // Built in memory, nothing written yet. The wrap follows the hash
      // (pinChangeNeedsWrap), on every device, so the account's wrap follows
      // the new PIN. Pinned by tests/pinChange.test.ts.
      const hashed = await hashPin(pinVal);
      const updated: UserSettings = { ...userSettings, ...hashed };
      // Asked of the cache as well, after the hash derived: it knows of a lock
      // armed in another tab before this tab's copy does, and when no wrap is
      // built nothing awaits between this answer and the commit below.
      const wrap = pinChangeNeedsWrap(updated) || pinChangeNeedsWrap(loadLocalSettings())
        ? await buildPinWrap(phrase, pinVal)
        : null;
      if (wrap) Object.assign(updated, wrap);
      // This device's copy, sealed under the device key in the apps before
      // the checks below, so the store after them stays synchronous.
      const localWrap = wrap && isTrustedDevice() ? await sealedLocalPinWrap(wrap) : null;
      // A sign-out during the PIN hash or the wrap cleared the settings this
      // would write back, the new PIN and its wrap.
      if (signedOutSince(startedAt)) return;
      // Another tab of this browser, or a sync pass, replaced the secret after
      // the step that proved it: this tab saves nothing and asks for the
      // secret the account holds now.
      if (pinCredentialStamp() !== credentialStamp(replacing)) {
        followAccount();
        return;
      }
      // Whether the lock is on now, which the strip below follows.
      const now = loadLocalSettings();
      // This device's copies go in first, each read back and each with a
      // put-back: the hash every gate here checks, and on a trusted device the
      // new wrap (an untrusted one keeps no copy). A refused one says so and
      // leaves everything as it was. A device whose lock is off and whose
      // phrase is at rest keeps no lock copy (`keepsLocalPinWrap`): the new
      // wrap goes to the account only, and the next settings pass takes the
      // old copy off once the phrase reads back.
      const putBackHash = stagePinHash(hashed);
      if (!putBackHash) {
        setError(t('pinTab.changeNotSaved'));
        return;
      }
      let putBackWrap: (() => void) | null = null;
      if (wrap && isTrustedDevice() && keepsLocalPinWrap(now.appLockEnabled === true)) {
        try {
          putBackWrap = storeBuiltPinWrap(wrap, startedAt, localWrap);
        } catch {
          putBackHash();
          setError(t('pinTab.changeNotSaved'));
          return;
        }
      }
      // The settings save is the commit, read back whole: until it lands the
      // old secret stays in force everywhere, its hash, its wrap and the
      // phrase at rest. Pinned by tests/pinTabWrites.test.ts.
      if (!saveCredential(updated, userSettings, onSettingsChange, replacing)) {
        putBackWrap?.();
        putBackHash();
        setError(t('pinTab.changeNotSaved'));
        return;
      }
      // Last, once the new wrap is this device's door: with the lock on, the
      // phrase at rest goes so the lock is the only door. Where no lock copy
      // is kept, a copy under the old secret goes too, or Lock app would ask
      // for a secret the account no longer holds.
      if (putBackWrap && now.appLockEnabled) removeStoredPhrase();
      if (!putBackWrap) void dropLocalPinWrapIfNotKept(phrase);
      // This tab's own write: the settings that come back with it are not a
      // change made elsewhere, and must not reset the steps below.
      seenCredential.current = `${updated.pinHash ?? ''}:${updated.pinSalt ?? ''}`;
      // Mark unlocked so the user isn't immediately re-prompted for
      // the PIN they just created.
      markPinUnlocked();
      setPinExists(true);
      setExistingKind(newKind);
      setOldPinVerified(false);
      reset();
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
      onPinCreated?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  /** `checked` is the cached hash the remove dialog proved the secret against. */
  async function doRemovePin(checked: PinCredential) {
    const stamp = credentialStamp(checked);
    // The same clear the phrase route performs, so the two cannot drift.
    // App lock is left alone: it is a synced setting and an enrolled
    // fingerprint is not, so removing a PIN here used to switch off a lock
    // another device could still open. clearPin carries the reasoning, and
    // answers null, having removed nothing, when the wrap is this device's
    // last door and the phrase did not read back at rest, or when another tab
    // replaced the secret meanwhile, which takes nothing off and says nothing.
    const cleared = await clearPin(userSettings, phrase, () => pinCredentialStamp() === stamp);
    if (!cleared) {
      if (pinCredentialStamp() === stamp) setError(t('appLock.phraseNotSaved'));
      return;
    }
    // A save the store refused, or settings that hold a secret saved since,
    // leave the account's PIN in force, so this device gets its hash and its
    // wrap back.
    if (!saveCredential(cleared.settings, userSettings, onSettingsChange, checked)) {
      await restoreUnsavedClear(phrase, cleared);
      setError(t('pinTab.changeNotSaved'));
      return;
    }
    seenCredential.current = ':';
    setPinExists(false);
    setExistingKind('pin');
    setNewKind(defaultKindRef.current);
    kindFromTiles.current = false;
    setOldPinVerified(false);
    reset();
  }

  if (recovering) {
    return (
      <div className="space-y-3">
        <PinRecoveryForm
          kind={existingKind}
          phrase={phrase}
          userSettings={userSettings}
          onSettingsChange={onSettingsChange}
          onCleared={() => {
            seenCredential.current = ':';
            setRecovering(false);
            setRecovered(existingKind);
            setPinExists(false);
            setExistingKind('pin');
            setNewKind(defaultKindRef.current);
            kindFromTiles.current = false;
            setOldPinVerified(false);
            reset();
          }}
          onCancel={() => setRecovering(false)}
        />
        <HelpChip surface="pin" className="pt-2 border-t border-divider" />
      </div>
    );
  }

  return (
    <div className="@container space-y-3">
      {changeLost && <Callout tone="danger">{t('pinTab.changeLost')}</Callout>}
      {phraseUnwrapped && <Callout tone="danger">{t('pinTab.phraseUnwrapped')}</Callout>}
      {needsOldPin && biometricWeaker && (
        <Callout>{t('pinTab.biometricWeaker')}</Callout>
      )}
      {needsOldPin ? (
        <>
          <p className={`${SETTINGS_HELP} leading-relaxed`}>
            {existingKind === 'passcode' ? t('pinTab.enterCurrentPasscode') : t('pinTab.enterCurrent')}
          </p>
          <div className="space-y-1.5">
            <SectionEyebrow className="text-center">
              {existingKind === 'passcode' ? t('pinTab.currentPasscode') : t('pinTab.currentPin')}
            </SectionEyebrow>
            <SecretInput
              kind={existingKind}
              ref={oldPinRef}
              value={oldPin}
              onChange={(v) => {
                setOldPin(v);
                setOldPinError(null);
              }}
              onComplete={(v) => void verifyOldPin(v)}
              autoFocus
              compact
              disabled={oldPinBusy || lockout.locked}
            />
          </div>
          {oldPinError && (
            <p className="text-body text-danger text-center">
              {oldPinError}
            </p>
          )}
          <Button
            action="confirm"
            variant="primary"
            onClick={() => void verifyOldPin(oldPin)}
            disabled={!secretReady(existingKind, oldPin) || oldPinBusy}
            className="w-full"
          >
            {oldPinBusy ? t('security:lockScreen.checking') : t('pinTab.verify')}
          </Button>
          <ForgotPinLink kind={existingKind} onClick={() => setRecovering(true)} />
        </>
      ) : (
        <>
          <div className="space-y-2">
            {reason === 'protect' && (
              <Callout>{t('pinTab.protectReason')}</Callout>
            )}
            {recovered && (
              <p className="text-body text-accent">
                {recovered === 'passcode' ? t('pinRecovery.clearedPasscode') : t('pinRecovery.cleared')}
              </p>
            )}
            <p className={`${SETTINGS_HELP} leading-relaxed`}>
              {!pinExists
                ? t('pinTab.chooseIntro')
                : newKind === 'passcode'
                  ? t('pinTab.replaceWithPasscode')
                  : existingKind === 'passcode'
                    ? t('pinTab.replacePasscodeWithPin')
                    : t('pinTab.replaceExisting')}
            </p>
          </div>

          <SecretKindTiles
            value={newKind}
            defaultKind={defaultKind}
            appLock={userSettings.appLockEnabled}
            disabled={busy}
            onChange={(kind) => {
              // Arrow keys move through the tiles, so a choice made there
              // keeps the focus in the group instead of jumping to a field.
              kindFromTiles.current = true;
              setNewKind(kind);
              reset();
            }}
          />
          {biometricWeaker && (
            <Callout>{t('pinTab.biometricWeaker')}</Callout>
          )}

          {newKind === 'passcode' ? (
            <>
              <NewPasscodeFields
                value={pin}
                confirm={confirm}
                busy={busy}
                onChange={(v) => { setPin(v); setError(null); }}
                onConfirmChange={(v) => { setConfirm(v); setError(null); }}
                onSubmit={() => void submit(pin, confirm)}
                autoFocus={pinExists && !kindFromTiles.current}
              />
            </>
          ) : (
            <div className={NEW_SECRET_FIELDS}>
              <div className="space-y-1.5">
                <SectionEyebrow className="text-center">
                  {t('pinTab.newPin')}
                </SectionEyebrow>
                <PinInput
                  ref={newPinRef}
                  value={pin}
                  onChange={(v) => {
                    setPin(v);
                    setError(null);
                  }}
                  onComplete={() => confirmRef.current?.focus()}
                  compact
                  disabled={busy}
                />
              </div>

              <div className="space-y-1.5">
                <SectionEyebrow className="text-center">
                  {t('pinTab.confirmPin')}
                </SectionEyebrow>
                <PinInput
                  ref={confirmRef}
                  value={confirm}
                  onChange={(v) => {
                    setConfirm(v);
                    setError(null);
                  }}
                  onComplete={(v) => void submit(pin, v)}
                  compact
                  disabled={busy}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-body text-danger text-center">
              {error}
            </p>
          )}
          {savedFlash && (
            <p className="text-body text-accent text-center">
              {existingKind === 'passcode' ? t('pinTab.passcodeSaved') : t('pinTab.pinSaved')}
            </p>
          )}

          <div data-setting="security.setPin" className="flex gap-2">
            <Button
              action="save"
              variant="primary"
              onClick={() => void submit(pin, confirm)}
              disabled={busy || (newKind === 'passcode'
                ? !isValidPasscode(pin) || normalizeSecret(pin) !== normalizeSecret(confirm)
                : pin.length !== 4 || confirm.length !== 4)}
              className="flex-1"
            >
              {busy
                ? t('common:state.saving')
                : newKind === 'passcode'
                  ? t('pinTab.setPasscode')
                  : pinExists ? t('pinTab.updatePin') : t('pinTab.setPin')}
            </Button>
            {pinExists && (
              <Button
                data-setting="security.removePin"
                icon={<ShieldSlash aria-hidden="true" className="shrink-0" />}
                onClick={() => setShowRemoveConfirm(true)}
                disabled={busy}
              >
                {existingKind === 'passcode' ? t('removePinDialog.removePasscode') : t('pinTab.removePin')}
              </Button>
            )}
          </div>
        </>
      )}

      {/* The window itself lives in the Lock tab, beside the app lock's, so
          the two read as different things (#662). This line keeps the old
          place from being a dead end. */}
      <p className={`${SETTINGS_HELP} pt-3 border-t border-divider leading-relaxed flex items-start gap-1.5`}>
        <Timer className="text-accent shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          <Trans
            t={t}
            i18nKey="pinTab.timerMoved"
            components={{
              tab: (
                <button
                  type="button"
                  onClick={onOpenLockTab}
                  className="text-accent underline underline-offset-2 hover:no-underline"
                />
              ),
            }}
          />
        </span>
      </p>

      <HelpChip surface="pin" className="pt-3 border-t border-divider" />

      {showRemoveConfirm && (
        <RemovePinDialog
          kind={existingKind}
          credential={seenCredential}
          onConfirm={(checked) => {
            void doRemovePin(checked);
            setShowRemoveConfirm(false);
          }}
          onClose={() => setShowRemoveConfirm(false)}
        />
      )}
    </div>
  );
}

/**
 * Removal-of-PIN gate: requires fresh re-entry of the current PIN
 * regardless of whether a prior `oldPinVerified` flag is still set
 * earlier in the session. Without this gate, a casual passerby who
 * watched one PIN entry could remove protection in two clicks. See
 * gap #26.
 */
function RemovePinDialog({
  kind,
  credential,
  onConfirm,
  onClose,
}: {
  kind: SecretKind;
  /** The account credential the tab last saw, so a check that outlives a
   *  change made elsewhere removes nothing. */
  credential: { readonly current: string };
  /** Receives the cached hash the secret was checked against. */
  onConfirm: (checked: PinCredential) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('security');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockout, setLockout] = useState(() => getPinLockoutState());
  const inputRef = useRef<PinInputHandle>(null);
  const hasBio = hasBiometricCredential();

  useEffect(() => {
    if (!lockout.locked) return;
    const id = setInterval(() => {
      const state = getPinLockoutState();
      setLockout(state);
      if (!state.locked) setError(null);
    }, 1000);
    return () => clearInterval(id);
  }, [lockout.locked]);

  async function submit(candidate: string) {
    if (!secretReady(kind, candidate) || busy) return;
    const current = getPinLockoutState();
    if (current.locked) {
      setLockout(current);
      setError(t('security:lockScreen.tooManyAttempts', { seconds: current.secondsLeft }));
      return;
    }
    setBusy(true);
    setError(null);
    const credentialAtStart = credential.current;
    const checked = cachedPinCredential();
    const { valid } = await verifyPin(candidate);
    // A secret replaced during the check, on another device or in another tab
    // of this browser, is not the one this answer is about.
    if (credential.current !== credentialAtStart || pinCredentialStamp() !== credentialStamp(checked)) {
      onClose();
      return;
    }
    if (valid) {
      clearPinFailures();
      onConfirm(checked);
    } else {
      const state = recordPinFailure();
      setLockout(state);
      setError(state.locked
        ? t('security:lockScreen.tooManyAttempts', { seconds: state.secondsLeft })
        : kind === 'passcode' ? t('security:lockScreen.incorrectPasscodeRetry') : t('security:lockScreen.incorrectPinRetry'));
      setPin('');
      setBusy(false);
      inputRef.current?.clear();
    }
  }

  return (
    <Modal
      onClose={onClose}
      title={kind === 'passcode' ? t('security:removePinDialog.removePasscode') : t('security:pinTab.removePin')}
      icon={<ShieldSlash />}
      layer="z-[60]"
      className="max-w-sm p-5 space-y-4"
    >
      <p className="text-body text-pn-soft leading-relaxed">
        {kind === 'passcode'
          ? (hasBio ? t('removePinDialog.introWithBioPasscode') : t('removePinDialog.introNoBioPasscode'))
          : (hasBio ? t('removePinDialog.introWithBio') : t('removePinDialog.introNoBio'))}
      </p>
      <SecretInput
        kind={kind}
        ref={inputRef}
        value={pin}
        onChange={(v) => {
          setPin(v);
          setError(null);
        }}
        onComplete={(v) => void submit(v)}
        autoFocus
        disabled={busy || lockout.locked}
      />
      {error && (
        <p className="text-body text-danger text-center">
          {error}
        </p>
      )}
      <ModalFooter>
        <Button action="cancel" onClick={onClose} />
        <Button
          action="remove"
          variant="danger"
          onClick={() => void submit(pin)}
          disabled={!secretReady(kind, pin) || busy || lockout.locked}
        >
          {busy
            ? t('security:lockScreen.verifying')
            : kind === 'passcode' ? t('removePinDialog.removePasscode') : t('security:pinTab.removePin')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * The new passcode, its confirmation and the live rule checks. The set button
 * below stays disabled until both rules pass and the two fields match; the
 * field never submits itself at a length.
 */
/** The new and the confirm field side by side once the tab is wide enough for
 *  both rows of PIN boxes, stacked below that. */
const NEW_SECRET_FIELDS = 'grid grid-cols-1 @md:grid-cols-2 items-start gap-x-6 gap-y-3';

function NewPasscodeFields({
  value,
  confirm,
  busy,
  onChange,
  onConfirmChange,
  onSubmit,
  autoFocus,
}: {
  value: string;
  confirm: string;
  busy: boolean;
  onChange: (v: string) => void;
  onConfirmChange: (v: string) => void;
  onSubmit: () => void;
  autoFocus: boolean;
}) {
  const { t } = useTranslation('security');
  const confirmRef = useRef<PinInputHandle>(null);
  const rules = passcodeRules(value);
  const mismatch = confirm.length > 0 && normalizeSecret(confirm) !== normalizeSecret(value);
  const checks = [
    { ok: rules.longEnough, label: t('pinTab.ruleLength', { min: PASSCODE_MIN_CHARS }) },
    { ok: rules.notOnlyDigits, label: t('pinTab.ruleNotDigits') },
  ];
  return (
    <div className={NEW_SECRET_FIELDS}>
      <div className="space-y-1.5">
        <SectionEyebrow className="text-center">{t('pinTab.newPasscode')}</SectionEyebrow>
        <PasscodeInput
          value={value}
          onChange={onChange}
          onSubmit={() => confirmRef.current?.focus()}
          ariaLabel={t('pinTab.newPasscode')}
          autoFocus={autoFocus}
          compact
          disabled={busy}
        />
        <ul className="space-y-0.5 pt-1">
          {checks.map((c) => (
            <li key={c.label} className={`flex items-center gap-1.5 text-small ${c.ok ? 'text-success' : 'text-pn-soft'}`}>
              <Check weight="bold" className={c.ok ? '' : 'opacity-30'} aria-hidden="true" />
              {c.label}
            </li>
          ))}
          {!rules.notTooLong && (
            <li className="text-small text-danger">{t('pinTab.ruleMax', { max: PASSCODE_MAX_CHARS })}</li>
          )}
        </ul>
      </div>
      <div className="space-y-1.5">
        <SectionEyebrow className="text-center">{t('pinTab.confirmPasscode')}</SectionEyebrow>
        <PasscodeInput
          ref={confirmRef}
          value={confirm}
          onChange={onConfirmChange}
          onSubmit={onSubmit}
          ariaLabel={t('pinTab.confirmPasscode')}
          compact
          disabled={busy}
        />
        {mismatch && <p className="text-small text-pn-soft">{t('pinTab.passcodesDoNotMatch')}</p>}
      </div>
    </div>
  );
}

/**
 * The choice between the two kinds of secret, as two tiles that compare them
 * row by row. The one real difference is what a person who gets past the
 * device's screen lock can do with the stored hash: try all 10,000 PINs, or
 * face a passcode's length and alphabet. That difference exists only while
 * the app lock is on: with it off, the app opens without asking for either
 * secret, so the row then reads the same in both tiles. CompareTiles draws
 * the native radios and keeps each row level across both tiles.
 * Spec: docs/public/THREAT_MODEL.md (PIN protection)
 */
function SecretKindTiles({
  value,
  defaultKind,
  appLock,
  onChange,
  disabled,
}: {
  value: SecretKind;
  defaultKind: SecretKind;
  appLock: boolean;
  onChange: (kind: SecretKind) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation('security');
  const stolenNoLock = { label: t('pinTab.rowStolen'), mark: 'meh', text: t('pinTab.stolenNoLock') } as const;
  const tiles: CompareTile<SecretKind>[] = [
    {
      value: 'pin',
      title: t('pinTab.kindPin'),
      ...(defaultKind === 'pin' ? { badge: { label: t('pinTab.badgeDefault'), tone: 'info' as const } } : {}),
      rows: [
        { label: t('pinTab.rowTyping'), mark: 'yes', text: t('pinTab.typingPin') },
        { label: t('pinTab.rowNearby'), mark: 'yes', text: t('pinTab.nearby') },
        appLock ? { label: t('pinTab.rowStolen'), mark: 'no', text: t('pinTab.stolenPin') } : stolenNoLock,
        { label: t('pinTab.rowForgot'), mark: 'yes', text: t('pinTab.forgot') },
      ],
    },
    {
      value: 'passcode',
      title: t('pinTab.kindPasscode'),
      badge: { label: t('pinTab.badgeStronger'), tone: 'success' },
      rows: [
        { label: t('pinTab.rowTyping'), mark: 'meh', text: t('pinTab.typingPasscode', { min: PASSCODE_MIN_CHARS }) },
        { label: t('pinTab.rowNearby'), mark: 'yes', text: t('pinTab.nearby') },
        appLock ? { label: t('pinTab.rowStolen'), mark: 'yes', text: t('pinTab.stolenPasscode') } : stolenNoLock,
        { label: t('pinTab.rowForgot'), mark: 'yes', text: t('pinTab.forgot') },
      ],
    },
  ];
  return <CompareTiles label={t('pinTab.kindGroup')} value={value} tiles={tiles} onChange={onChange} disabled={disabled} />;
}
