/**
 * The page that makes or uses the fingerprint or face passkey. The system
 * sheet needs a page that keeps focus, so the popup sends the person here.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, step 3)
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initReactI18next, useTranslation } from 'react-i18next';
import { Fingerprint } from '@web/icons';
import { IconDefaults } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Callout } from '@web/ui/feedback';
import { startI18n } from '../../src/i18n';
import { enroll, unlockWithBiometricHere } from '../../src/biometric';
import '../popup/style.css';

const dark = window.matchMedia('(prefers-color-scheme: dark)');
document.documentElement.classList.toggle('dark', dark.matches);

function Page() {
  const { t } = useTranslation('extension');
  const mode = location.hash === '#enroll' ? 'enroll' : 'unlock';
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'failed'>('idle');
  const run = async () => {
    setState('busy');
    const ok = mode === 'enroll' ? await enroll() : (await unlockWithBiometricHere()).kind === 'ok';
    setState(ok ? 'ok' : 'failed');
  };
  return (
    <main className="max-w-sm mx-auto p-6 space-y-4">
      <h1 className="text-title font-semibold text-pn m-0">{t('protect.biometric')}</h1>
      {state === 'ok' ? (
        <Callout look="card" tone="success">{mode === 'enroll' ? t('biometric.enrolled') : t('biometric.unlocked')}</Callout>
      ) : state === 'failed' ? (
        <Callout look="card" tone="warning">{t('biometric.failed')}</Callout>
      ) : (
        <Button variant="primary" icon={<Fingerprint aria-hidden="true" />} onClick={() => void run()} disabled={state === 'busy'} className="w-full">
          {t('logins.useBiometric')}
        </Button>
      )}
    </main>
  );
}

void startI18n([initReactI18next]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <IconDefaults>
      <Page />
    </IconDefaults>,
  );
});
