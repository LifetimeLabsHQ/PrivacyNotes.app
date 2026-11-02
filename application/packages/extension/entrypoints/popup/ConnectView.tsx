/**
 * Connect: paste the one-time code from the app; with logins on, choose this
 * browser's own PIN or passcode, with the line that 10 wrong tries
 * disconnect it. Then a short confirmation that the code is spent.
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.2 and E4)
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Fingerprint } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Callout, StatusLine } from '@web/ui/feedback';
import { FIELD_CLASS, FieldLabel } from '@web/formFields';
import { SettingsSegmented, SETTINGS_HELP } from '@web/settingsUI';
import { SecretInput } from '@web/PasscodeInput';
import { Switch } from '@web/Switch';
import { PASSCODE_MIN_CHARS } from '@web/secretKind';
import { HELP_URL } from '../../src/config';
import { readCode, redeem, type Connection, type SecretKind } from '../../src/connection';
import { biometricPossible, startEnrollment } from '../../src/biometric';

type Step = 'paste' | 'protect' | 'done';

const REASONS = { bad: 'connect.badCode', used: 'connect.usedCode', offline: 'connect.offline', full: 'connect.usedCode', failed: 'connect.offline' } as const;

export function ConnectView({ onConnected }: { onConnected: (c: Connection) => void }) {
  const { t } = useTranslation('extension');
  const [step, setStep] = useState<Step>('paste');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<SecretKind>('pin');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<Connection | null>(null);
  const [canFingerprint, setCanFingerprint] = useState(false);
  const [fingerprint, setFingerprint] = useState(false);
  // The unlock proof, in memory only, for the passkey button of the done step.
  const proof = useRef<Uint8Array | null>(null);
  const [enrolled, setEnrolled] = useState<'no' | 'busy' | 'yes' | 'failed'>('no');
  useEffect(() => {
    void biometricPossible().then(setCanFingerprint);
  }, []);

  const finish = async (secret?: { value: string; kind: SecretKind }) => {
    setBusy(true);
    setError(null);
    const result = await redeem(code, secret);
    setBusy(false);
    if (!result.ok) {
      setError(t(REASONS[result.reason]));
      if (result.reason !== 'offline') setStep('paste');
      return;
    }
    proof.current = fingerprint && result.proof ? result.proof : null;
    setConnected(result.connection);
    setStep('done');
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

  const next = () => {
    const read = readCode(code);
    if (read.kind === 'bad') return setError(t('connect.badCode'));
    setError(null);
    if (read.kind === 'needsSecret') setStep('protect');
    else void finish();
  };

  const ready = kind === 'pin' ? /^\d{4}$/.test(first) : first.length >= PASSCODE_MIN_CHARS;
  // The repeat field hands over its value as the last digit lands, before
  // the state holds it.
  const protect = (repeat: string = second) => {
    if (!ready) return;
    if (first !== repeat) {
      setError(t('protect.mismatch'));
      setSecond('');
      return;
    }
    void finish({ value: first, kind });
  };

  if (step === 'done' && connected) {
    return (
      <div className="p-4 space-y-3">
        <Callout tone="success" title={t('connect.connected')}>
          {connected.logins && connected.clips ? t('connect.connectedBoth') : connected.logins ? t('notes:vaultFilter.logins') : t('connect.connectedClips')}
        </Callout>
        <p className={SETTINGS_HELP}>{t('connect.codeSpent')}</p>
        {enrolled === 'yes' ? (
          <Callout tone="success">{t('biometric.enrolledHere')}</Callout>
        ) : enrolled === 'failed' ? (
          <Callout tone="warning">{t('biometric.failed')}</Callout>
        ) : proof.current ? (
          <Button icon={<Fingerprint aria-hidden="true" />} onClick={() => void enroll()} disabled={enrolled === 'busy'} className="w-full">
            {t('logins.useBiometric')}
          </Button>
        ) : null}
        <Button action="done" onClick={() => onConnected(connected)} />
      </div>
    );
  }

  if (step === 'protect') {
    return (
      <div className="p-4 space-y-3">
        <h1 className="text-title font-semibold text-pn m-0">{t('protect.title')}</h1>
        <p className={SETTINGS_HELP}>{t('protect.body')}</p>
        <SettingsSegmented<SecretKind>
          label={t('protect.title')}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setFirst('');
            setSecond('');
          }}
          options={[
            { value: 'pin', label: t('security:pinTab.kindPin') },
            { value: 'passcode', label: t('security:pinTab.kindPasscode') },
          ]}
        />
        <SecretInput kind={kind} value={first} onChange={setFirst} autoFocus compact />
        {ready && (
          <div className="space-y-1">
            <FieldLabel>{t('protect.repeat')}</FieldLabel>
            <SecretInput kind={kind} value={second} onChange={setSecond} onComplete={(v) => protect(v)} compact />
          </div>
        )}
        <p className={SETTINGS_HELP}>{t('protect.tries')}</p>
        {canFingerprint && (
          <Switch label={t('protect.biometric')} description={t('protect.biometricHelp')} checked={fingerprint} onChange={setFingerprint} />
        )}
        {error && <Callout tone="danger">{error}</Callout>}
        {busy ? <StatusLine busy>{t('connect.connect')}</StatusLine> : (
          <Button action="next" onClick={() => protect()} disabled={!ready || second.length === 0}>{t('connect.connect')}</Button>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <img src="/icon/32.png" alt="" className="w-6 h-6 rounded" />
        <h1 className="text-title font-semibold text-pn m-0">{t('connect.title')}</h1>
      </div>
      <p className={SETTINGS_HELP}>{t('connect.body')}</p>
      <div>
        <FieldLabel htmlFor="pn-code">{t('connect.codeLabel')}</FieldLabel>
        <textarea
          id="pn-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={4}
          dir="ltr"
          spellCheck={false}
          autoFocus
          className={`${FIELD_CLASS} font-mono resize-none`}
          placeholder="pnx1-..."
        />
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
      {busy ? <StatusLine busy>{t('connect.connect')}</StatusLine> : (
        <Button action="next" onClick={next} disabled={!code.trim()}>{t('connect.connect')}</Button>
      )}
      <a href={HELP_URL} target="_blank" rel="noopener noreferrer" className="block text-small text-accent-strong hover:underline">
        {t('connect.help')}
      </a>
    </div>
  );
}
