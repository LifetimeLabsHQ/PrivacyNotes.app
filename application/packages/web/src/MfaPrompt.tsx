import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, Shield } from './icons';
import { PinInput, type PinInputHandle } from './PinInput';
import { MfaCancelledError, submitMfaCode, dismissMfaPrompt, type MfaPromptRequest } from './mfaStep';
import { useAccountLogins } from './accountLogins';
import { accountErrorKey } from './AccountSignInSetup';
import { Button, Modal } from './ui';

/** A backup restores the authenticator. It never goes to an app endpoint. */
export function MfaRecoveryHelp() {
  const { t } = useTranslation('security');
  return (
    <details className="text-body text-pn-soft leading-relaxed">
      <summary className="cursor-pointer text-accent py-1">{t('mfaPrompt.lostAuthenticator')}</summary>
      <div className="pt-2 space-y-2">
        <p>{t('mfaPrompt.restore')}</p>
        <p>{t('mfaPrompt.noBackup')}</p>
      </div>
    </details>
  );
}

/** The repair swaps the session, which closes the wrong-login prompt and
 * opens the code prompt of the canonical login. It runs here, outside the
 * prompt, so that swap cannot unmount it halfway. */
function WrongLoginRepair({ onEnd }: { onEnd: (error: string | null) => void }) {
  const account = useAccountLogins();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    account.activate().then(() => onEnd(null),
      (error: unknown) => onEnd(error instanceof MfaCancelledError ? null : accountErrorKey(error)));
  }, [account, onEnd]);
  return null;
}

export function MfaPromptLayer({ request }: { request: MfaPromptRequest | null }) {
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const endRepair = useCallback((error: string | null) => { setRepairing(false); setRepairError(error); }, []);
  return <>
    {repairing && <WrongLoginRepair onEnd={endRepair} />}
    {request && <MfaPrompt request={request} onSubmit={submitMfaCode} onDismiss={dismissMfaPrompt}
      repairing={repairing} repairError={repairError}
      onRepair={() => { setRepairError(null); setRepairing(true); }} />}
  </>;
}

/** Dismissal only cancels the server operation. It never wipes local notes. */
export function MfaPrompt({ request, onSubmit, onDismiss, onRepair, repairing = false, repairError = null }: {
  request: MfaPromptRequest;
  onSubmit: (code: string) => Promise<void>;
  onDismiss: () => void;
  onRepair?: () => void;
  repairing?: boolean;
  repairError?: string | null;
}) {
  const { t } = useTranslation('security');
  const [code, setCode] = useState('');
  const errorId = useId();
  const input = useRef<PinInputHandle>(null);
  useEffect(() => {
    setCode('');
    input.current?.focus();
  }, [request.id]);
  useEffect(() => { if (request.error) { setCode(''); input.current?.clear(); } }, [request.error]);
  const submit = (value: string) => { if (!request.busy && /^\d{6}$/.test(value)) void onSubmit(value); };

  return (
    <Modal
      onClose={onDismiss}
      closeOnBackdrop={false}
      layer="z-[100]"
      icon={<Shield />}
      title={t(request.wrongLogin ? 'mfaPrompt.wrongLoginTitle' : 'mfaPrompt.title')}
      className="max-w-sm p-6 space-y-4 max-h-[90dvh] overflow-y-auto"
    >
      {request.wrongLogin ? (
        <div className="space-y-3">
          <p className="text-body text-pn-soft leading-relaxed">{t('mfaPrompt.wrongLogin')}</p>
          {repairError && <p role="alert" className="text-body text-danger">{t(repairError)}</p>}
          <Button
            variant="primary"
            icon={<ArrowClockwise aria-hidden="true" />}
            onClick={onRepair}
            disabled={repairing}
            className="w-full justify-center"
          >
            {t(repairing ? 'connectedAccounts.working' : 'mfaPrompt.signInAgain')}
          </Button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); submit(code); }}>
          <p className="text-body text-pn-soft">{t('mfaPrompt.enterCode')}</p>
          <div aria-describedby={request.error ? errorId : undefined}>
            <PinInput ref={input} value={code} onChange={setCode} onComplete={submit} length={6} reveal compact
              ariaLabel={t('mfaPrompt.codeLabel')} disabled={request.busy} />
          </div>
          {request.error && <p id={errorId} role="alert" className="text-body text-center text-danger">{t(request.error)}</p>}
          <Button
            type="submit"
            action="confirm"
            disabled={request.busy || code.length !== 6}
            className="w-full justify-center"
          >
            {t(request.busy ? 'mfaPrompt.verifying' : 'mfaPrompt.verify')}
          </Button>
        </form>
      )}
      {!request.wrongLogin && <MfaRecoveryHelp />}
      {request.allowLocalUse && <>
        {!request.wrongLogin && <p className="text-body text-pn-soft">{t('mfaPrompt.localNotes')}</p>}
        <Button action="cancel" onClick={onDismiss} className="w-full justify-center">
          {t('mfaPrompt.useLocalNotes')}
        </Button>
      </>}
    </Modal>
  );
}
