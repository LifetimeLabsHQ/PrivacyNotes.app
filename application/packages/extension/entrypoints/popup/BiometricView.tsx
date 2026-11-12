/**
 * Settings > Fingerprint or face, turned on: the PIN or passcode once, then
 * the system sheet. The PIN makes the proof that the passkey keeps, and the
 * server checks it first, so a wrong PIN counts as a wrong try (as at the
 * lock screen) and sets nothing up. Turning it off needs no PIN: App forgets
 * the wrapped proof. The PIN or passcode always works too.
 * Spec: docs/internal/plans/browser-extension-build.md (decision E17)
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Callout, StatusLine } from '@web/ui/feedback';
import { SecretInput } from '@web/PasscodeInput';
import { SETTINGS_HELP } from '@web/settingsUI';
import { base64ToBytes } from '@notes/shared';
import type { Connection } from '../../src/connection';
import { deriveProof } from '../../src/proof';
import { unlock } from '../../src/logins';
import { startEnrollment } from '../../src/biometric';

export function BiometricView({ connection, onDone }: { connection: Connection; onDone: (on: boolean) => void }) {
  const { t } = useTranslation('extension');
  const kind = connection.secretKind ?? 'pin';
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (secret: string = value) => {
    if (busy || !secret || !connection.salt) return;
    setBusy(true);
    setError(null);
    const proof = await deriveProof(secret, base64ToBytes(connection.salt));
    const checked = await unlock({ proof });
    if (checked.kind !== 'ok') {
      setBusy(false);
      setValue('');
      setError(checked.kind === 'wrong' ? t('logins.wrong', { count: checked.left }) : t('logins.unreachable'));
      return;
    }
    const ok = await startEnrollment(proof);
    if (import.meta.env.FIREFOX) return window.close();
    setBusy(false);
    if (!ok) return setError(t('biometric.failed'));
    onDone(true);
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-4">
      <p className={`m-0 ${SETTINGS_HELP}`}>{kind === 'pin' ? t('settings.biometricPin') : t('settings.biometricPasscode')}</p>
      <SecretInput kind={kind} value={value} onChange={setValue} onComplete={(v) => void run(v)} autoFocus fill />
      {error && <Callout look="card" tone="danger">{error}</Callout>}
      {busy ? <StatusLine busy>{t('vault.unlocking')}</StatusLine> : <p className={`m-0 ${SETTINGS_HELP}`}>{t('protect.biometricHelp')}</p>}
    </div>
  );
}
