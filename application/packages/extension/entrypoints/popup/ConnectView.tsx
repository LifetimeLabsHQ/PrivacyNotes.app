/**
 * Connect: paste the one-time code from the app; with logins on, choose this
 * browser's own PIN or passcode, with the line that 10 wrong tries
 * disconnect it, and fingerprint or face on top of it, set up in the same
 * step. Then the popup opens, and its footer says Connected.
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.2 and E4)
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ClipboardText, Fingerprint } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Callout } from '@web/ui/feedback';
import { FIELD_CLASS } from '@web/formFields';
import { ROW_TITLE, SectionEyebrow, SettingsSegmented, SETTINGS_HELP } from '@web/settingsUI';
import { SecretInput } from '@web/PasscodeInput';
import type { PinInputHandle } from '@web/PinInput';
import { Switch } from '@web/Switch';
import { PASSCODE_MIN_CHARS } from '@web/secretKind';
import { readCode, redeem, type Connection, type SecretKind } from '../../src/connection';
import { biometricPossible, startEnrollment } from '../../src/biometric';
import { unlock } from '../../src/logins';
import { SaveButton } from './SaveButton';

type Step = 'paste' | 'protect';

const REASONS = { bad: 'connect.badCode', used: 'connect.usedCode', offline: 'connect.offline', full: 'connect.usedCode', notPro: 'shell:apps.secondBrowserPro', failed: 'connect.offline' } as const;

export function ConnectView({ onConnected }: { onConnected: (c: Connection, note?: string) => void }) {
  const { t } = useTranslation('extension');
  const [step, setStep] = useState<Step>('paste');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<SecretKind>('pin');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canFingerprint, setCanFingerprint] = useState(false);
  const [fingerprint, setFingerprint] = useState(false);
  // A full PIN hands the cursor to the repeat field; a passcode at Enter.
  const repeatRef = useRef<PinInputHandle>(null);
  useEffect(() => {
    void biometricPossible().then(setCanFingerprint);
  }, []);

  const finish = async (secret?: { value: string; kind: SecretKind }) => {
    setBusy(true);
    setError(null);
    const result = await redeem(code, secret);
    if (!result.ok) {
      setBusy(false);
      setError(t(REASONS[result.reason]));
      if (result.reason !== 'offline') setStep('paste');
      return;
    }
    // The PIN was typed twice a moment ago: open the vault with its proof,
    // so it starts unlocked for the chosen lock time. If this fails, the
    // Vault tab asks for the PIN as usual.
    if (result.proof) await unlock({ proof: result.proof }).catch(() => undefined);
    // Fingerprint or face is set up in the same step: the system sheet
    // comes while the Connect click (or the last digit) is still fresh,
    // a second after it. No second screen (owner, 2026-11-11). Firefox
    // sets it up on its own page, which opens in a tab.
    let note: string | undefined;
    if (fingerprint && result.proof) {
      const ok = await startEnrollment(result.proof);
      if (import.meta.env.FIREFOX) return window.close();
      note = ok ? t('biometric.enrolledHere') : t('biometric.failed');
    }
    setBusy(false);
    onConnected(result.connection, note);
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

  if (step === 'protect') {
    return (
      <div className="flex flex-col gap-3 px-3 py-4">
        <h1 className="text-title font-semibold text-pn m-0">{t('protect.title')}</h1>
        <p className={SETTINGS_HELP}>{t('protect.body')}</p>
        <SettingsSegmented<SecretKind>
          label={t('protect.title')}
          className="w-full [&>button]:flex-1"
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
        <SecretInput kind={kind} value={first} onChange={setFirst} onComplete={() => repeatRef.current?.focus()} autoFocus fill />
        {ready && (
          <div className="space-y-1.5">
            <SectionEyebrow className="text-center">{t('protect.repeat')}</SectionEyebrow>
            <SecretInput ref={repeatRef} kind={kind} value={second} onChange={setSecond} onComplete={(v) => protect(v)} autoFocus={kind === 'pin'} fill />
          </div>
        )}
        {/* Biometric unlock, a settings row of its own below a rule. */}
        {canFingerprint && (
          <div className="border-t border-divider pt-3">
            <Switch icon={<Fingerprint className="text-accent" />} labelClassName={ROW_TITLE} label={t('protect.biometric')} description={t('protect.biometricHelp')} checked={fingerprint} onChange={setFingerprint} />
          </div>
        )}
        {error && <Callout look="card" tone="danger">{error}</Callout>}
        <SaveButton variant="primary" state={busy ? 'busy' : 'idle'} disabled={!ready || second.length === 0} icon={<ArrowRight aria-hidden="true" />} label={t('connect.connect')} busyLabel={t('connect.connect')} doneLabel={t('connect.connected')} onClick={() => protect()} className="w-full" />
      </div>
    );
  }

  // Room between the parts: the title, the steps, the field and Connect
  // each stand apart (owner, 2026-11-11).
  return (
    <div className="flex flex-col gap-5 px-3 py-4">
      <h1 className="text-title font-semibold text-pn m-0">{t('connect.title')}</h1>
      {/* Three numbered steps; the help is the header's question mark (owner, 2026-11-11). */}
      <ol className="m-0 p-0 list-none space-y-3">
        {(['connect.step1', 'connect.step2', 'connect.step3'] as const).map((key, i) => (
          <li key={key} className="flex items-center gap-2.5">
            <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-meta font-semibold text-accent-strong">{i + 1}</span>
            <span className="text-small text-pn">{t(key)}</span>
          </li>
        ))}
      </ol>
      <div>
        <div className="flex items-stretch gap-2">
          <textarea
            id="pn-code"
            aria-label={t('connect.codeLabel')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={3}
            dir="ltr"
            spellCheck={false}
            autoFocus
            className={`${FIELD_CLASS} min-w-0 flex-1 font-mono resize-none`}
            placeholder="pnx1-..."
          />
          <Button
            icon={<ClipboardText aria-hidden="true" />}
            onClick={() => void navigator.clipboard.readText().then((text) => setCode(text.trim()), () => undefined)}
            className="shrink-0 flex-col !h-auto"
          >
            {t('connect.paste')}
          </Button>
        </div>
      </div>
      {error && <Callout look="card" tone="danger">{error}</Callout>}
      <SaveButton variant="primary" state={busy ? 'busy' : 'idle'} disabled={!code.trim()} icon={<ArrowRight aria-hidden="true" />} label={t('connect.connect')} busyLabel={t('connect.connect')} doneLabel={t('connect.connected')} onClick={next} className="w-full" />
    </div>
  );
}
