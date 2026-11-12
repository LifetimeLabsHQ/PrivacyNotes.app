/**
 * Change PIN (or passcode), a sheet over the open vault: the current one,
 * then the new one twice, of either kind. The server counts a wrong current
 * one with the unlock's 10 tries. A fingerprint or face set-up ends with the
 * change, so the done step offers it again with the new proof. The fields and
 * Save fill the width; the PIN boxes fill it too, as on every PIN screen.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, step 2)
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Fingerprint, FloppyDisk } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Callout } from '@web/ui/feedback';
import { SectionEyebrow, SettingsSegmented, SETTINGS_HELP } from '@web/settingsUI';
import { SecretInput } from '@web/PasscodeInput';
import type { PinInputHandle } from '@web/PinInput';
import { PASSCODE_MIN_CHARS } from '@web/secretKind';
import type { Connection, SecretKind } from '../../src/connection';
import { biometricPossible, biometricReady, startEnrollment } from '../../src/biometric';
import { changeSecret } from '../../src/changeSecret';
import { SaveButton } from './SaveButton';
import { SheetHeader } from './Sheet';

const full = (kind: SecretKind, value: string) => (kind === 'pin' ? /^\d{4}$/.test(value) : value.length >= PASSCODE_MIN_CHARS);

export function ChangeSecretView({ connection, onBack, onChanged }: {
  connection: Connection;
  onBack: () => void;
  onChanged: (c: Connection) => void;
}) {
  const { t } = useTranslation('extension');
  const was = connection.secretKind ?? 'pin';
  const [current, setCurrent] = useState('');
  const [kind, setKind] = useState<SecretKind>(was);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ tone: 'warning' | 'danger'; text: string } | null>(null);
  const [done, setDone] = useState<Connection | null>(null);
  // Fingerprint or face was set up before the change, and can be again.
  const [hadFingerprint, setHadFingerprint] = useState(false);
  const proof = useRef<Uint8Array | null>(null);
  // Each field hands the cursor on when it is full: a PIN at its fourth
  // digit, a passcode at Enter.
  const newRef = useRef<PinInputHandle>(null);
  const repeatRef = useRef<PinInputHandle>(null);
  const [enrolled, setEnrolled] = useState<'no' | 'busy' | 'yes' | 'failed'>('no');
  useEffect(() => {
    void Promise.all([biometricReady(), biometricPossible()]).then(([ready, possible]) => setHadFingerprint(ready && possible));
  }, []);

  const ready = full(was, current) && full(kind, first);
  const save = async (repeat: string = second) => {
    if (!ready || busy) return;
    if (first !== repeat) {
      setError({ tone: 'warning', text: t('protect.mismatch') });
      setSecond('');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await changeSecret(current, { value: first, kind });
    setBusy(false);
    if (result.kind === 'ok') {
      proof.current = hadFingerprint ? result.proof : null;
      setDone(result.connection);
      return;
    }
    setCurrent('');
    if (result.kind === 'wrong') return setError({ tone: 'warning', text: t('logins.wrong', { count: result.left }) });
    // The vault locked meanwhile: the main window shows the PIN again.
    if (result.kind === 'locked') return onBack();
    if (result.kind === 'disconnected') return setError({ tone: 'danger', text: t('account.revokedBody') });
    setError({ tone: 'danger', text: t('connect.offline') });
  };

  // A click of its own: the system sheet wants a fresh user gesture.
  const enroll = async () => {
    if (!proof.current) return;
    setEnrolled('busy');
    const ok = await startEnrollment(proof.current);
    if (import.meta.env.FIREFOX) return window.close();
    proof.current = null;
    setEnrolled(ok ? 'yes' : 'failed');
  };

  const title = was === 'pin' ? t('changeSecret.titlePin') : t('changeSecret.titlePasscode');
  const pinWords = (k: SecretKind, pin: string, passcode: string) => t(k === 'pin' ? pin : passcode);

  if (done) {
    return (
      <>
        <SheetHeader title={title} onBack={() => onChanged(done)} />
        <div className="p-3 space-y-3">
          <Callout look="card" tone="success">{pinWords(kind, 'security:pinTab.pinSaved', 'security:pinTab.passcodeSaved')}</Callout>
          {enrolled === 'yes' ? (
            <Callout look="card" tone="success">{t('biometric.enrolledHere')}</Callout>
          ) : enrolled === 'failed' ? (
            <Callout look="card" tone="warning">{t('biometric.failed')}</Callout>
          ) : proof.current ? (
            <>
              <p className={SETTINGS_HELP}>{t('changeSecret.biometricAgain')}</p>
              <Button icon={<Fingerprint aria-hidden="true" />} onClick={() => void enroll()} disabled={enrolled === 'busy'} className="w-full">
                {t('logins.useBiometric')}
              </Button>
            </>
          ) : null}
          <Button action="done" onClick={() => onChanged(done)} className="w-full" />
        </div>
      </>
    );
  }

  return (
    <>
      <SheetHeader title={title} onBack={onBack} />
      <div className="p-3 space-y-3">
        <div className="space-y-1.5">
          <SectionEyebrow className="text-center">{pinWords(was, 'security:pinTab.currentPin', 'security:pinTab.currentPasscode')}</SectionEyebrow>
          <SecretInput kind={was} value={current} onChange={setCurrent} onComplete={() => newRef.current?.focus()} ariaLabel={pinWords(was, 'security:pinTab.currentPin', 'security:pinTab.currentPasscode')} autoFocus disabled={busy} fill />
        </div>
        <SettingsSegmented<SecretKind>
          label={t('security:pinTab.kindGroup')}
          className="w-full [&>button]:flex-1"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setFirst('');
            setSecond('');
            requestAnimationFrame(() => newRef.current?.focus());
          }}
          options={[
            { value: 'pin', label: t('security:pinTab.kindPin') },
            { value: 'passcode', label: t('security:pinTab.kindPasscode') },
          ]}
        />
        <div className="space-y-1.5">
          <SectionEyebrow className="text-center">{pinWords(kind, 'security:pinTab.newPin', 'security:pinTab.newPasscode')}</SectionEyebrow>
          <SecretInput ref={newRef} kind={kind} value={first} onChange={setFirst} onComplete={() => repeatRef.current?.focus()} ariaLabel={pinWords(kind, 'security:pinTab.newPin', 'security:pinTab.newPasscode')} disabled={busy} fill />
        </div>
        {full(kind, first) && (
          <div className="space-y-1.5">
            <SectionEyebrow className="text-center">{t('protect.repeat')}</SectionEyebrow>
            <SecretInput ref={repeatRef} kind={kind} value={second} onChange={setSecond} onComplete={(v) => void save(v)} ariaLabel={t('protect.repeat')} autoFocus={kind === 'pin'} disabled={busy} fill />
          </div>
        )}
        {error && <Callout look="card" tone={error.tone}>{error.text}</Callout>}
        <SaveButton
          variant="primary"
          state={busy ? 'busy' : 'idle'}
          disabled={!ready || second.length === 0}
          icon={<FloppyDisk aria-hidden="true" />}
          label={t('common:actions.save')}
          busyLabel={t('common:state.saving')}
          doneLabel={t('shell:checkIn.saved')}
          onClick={() => void save()}
          className="w-full"
        />
      </div>
    </>
  );
}
