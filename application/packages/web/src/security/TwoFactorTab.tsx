import { QRCodeCanvas } from 'qrcode.react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatInstant } from '../intlFormat';
import { useAuth } from '../auth';
import { isDemoMode } from '../demo';
import { AppWindow, Check, Copy, DeviceMobile, Download, Key, ShieldCheck, ShieldPlus, ShieldSlash } from '../icons';
import { Badge, Button, Callout, Checkbox, IconTile, StatusLine, TextField } from '../ui';
import { MfaRecoveryHelp } from '../MfaPrompt';
import { ensureLevel2, fetchMfaStatus, MfaCancelledError, notifyMfaChanged, verifyMfaCodeForSession, type MfaStatus } from '../mfaStep';
import { mfaSessionIdentity } from '../sessionWriteGuard';
import { saveBlob } from '../saveFile';
import { PinInput } from '../PinInput';
import { HelpChip } from '../HelpChip';
import { SectionEyebrow, SETTINGS_HELP } from '../settingsUI';
import { AccountSignInSetup } from '../AccountSignInSetup';
import { useAccountLogins } from '../accountLogins';

type Factor = { id: string; status: string; factor_type: string; friendly_name?: string; created_at?: string };
type Setup = { id: string; secret: string; uri: string; identity: string };

const TOTP_ISSUER = 'PrivacyNotes.app';
const STEPS = ['scan', 'key', 'confirm'] as const;

/** The same otpauth URI under the PrivacyNotes name and a readable account. */
export function labelTotpUri(uri: URL, account: string): string {
  const params = new URLSearchParams(uri.search);
  params.set('issuer', TOTP_ISSUER);
  return `otpauth://totp/${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(account)}?${params.toString()}`;
}

function normalizeKey(value: string): string { return value.toUpperCase().replace(/[\s-]/g, ''); }


/** Secrets stay in this mounted setup screen. Only explicit copy/save exports them. */
export function TwoFactorTab() {
  const { t } = useTranslation('security');
  const { supabase, auth } = useAuth();
  const accountLogins = useAccountLogins();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [factors, setFactors] = useState<Factor[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<typeof STEPS[number]>('scan');
  const [exported, setExported] = useState<'copied' | 'saved' | null>(null);
  const [backupSaved, setBackupSaved] = useState(false);
  const [backupAnswer, setBackupAnswer] = useState('');
  const [code, setCode] = useState('');
  const alive = useRef(true);
  const identity = useRef<string | null>(null);
  const operation = useRef(0);
  const running = useRef(false);
  const readGeneration = useRef(0);
  const ids = useId();

  const clearSetup = useCallback(() => {
    setSetup(null);
    setStep('scan');
    setExported(null);
    setBackupSaved(false);
    setBackupAnswer('');
    setCode('');
  }, []);

  const currentIdentity = useCallback(async () => {
    if (isDemoMode()) throw new MfaCancelledError();
    const { data, error: sessionError } = await supabase.auth.getSession();
    const current = mfaSessionIdentity(data.session);
    if (sessionError || !current) throw new MfaCancelledError();
    return current;
  }, [supabase]);

  const assertIdentity = useCallback(async (expected: string, epoch: number) => {
    if (!alive.current || operation.current !== epoch || await currentIdentity() !== expected) throw new MfaCancelledError();
  }, [currentIdentity]);

  const readState = useCallback(async (expected?: string) => {
    const generation = ++readGeneration.current;
    const at = await currentIdentity();
    if (expected && at !== expected) throw new MfaCancelledError();
    const next = await fetchMfaStatus(supabase);
    const listed = next.available ? await supabase.auth.mfa.listFactors() : null;
    if (listed?.error) throw listed.error;
    if (await currentIdentity() !== at || !alive.current) throw new MfaCancelledError();
    identity.current = at;
    const all: Factor[] = listed?.data?.all ?? [];
    if (generation === readGeneration.current) {
      setStatus(next);
      setFactors(all);
    }
    return { status: next, factors: all, identity: at };
  }, [currentIdentity, supabase]);

  useEffect(() => {
    if (isDemoMode()) return;
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      if (running.current) return;
      void readState().catch((failure) => {
        if (alive.current && !(failure instanceof MfaCancelledError)) setError('twoFactor.unavailable');
      });
    };
    reload();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const next = mfaSessionIdentity(session);
      if (identity.current && next !== identity.current) {
        operation.current++;
        identity.current = next;
        clearSetup();
        setStatus(null);
        setFactors([]);
        running.current = false;
        setBusy(false);
      }
      // Auth callbacks run under the SDK lock. Read outside that callback.
      clearTimeout(timer);
      timer = setTimeout(reload, 0);
    });
    window.addEventListener('privacynotes:mfa-changed', reload);
    return () => {
      alive.current = false;
      operation.current++;
      clearTimeout(timer);
      data.subscription.unsubscribe();
      window.removeEventListener('privacynotes:mfa-changed', reload);
    };
  }, [clearSetup, readState, supabase]);

  async function run(action: (at: string, epoch: number) => Promise<void>) {
    if (running.current || isDemoMode()) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const epoch = ++operation.current;
    try {
      const at = await currentIdentity();
      if (identity.current && at !== identity.current) throw new MfaCancelledError();
      await action(at, epoch);
    } catch (failure) {
      if (alive.current && operation.current === epoch && !(failure instanceof MfaCancelledError)) setError('twoFactor.actionFailed');
    } finally {
      if (alive.current && operation.current === epoch) { running.current = false; setBusy(false); }
    }
  }

  // The RPC conditionally deletes only an unverified factor owned by this
  // user. listFactors -> native unenroll would race verification in another tab.
  async function cancelPending(id: string, at: string, epoch: number) {
    await assertIdentity(at, epoch);
    const result = await supabase.rpc('mfa_cancel_setup', { p_factor_id: id });
    if (result.error) throw result.error;
    await assertIdentity(at, epoch);
  }

  function startSetup() {
    if (!status?.can_enroll) return;
    void run(async (at, epoch) => {
      const fresh = await readState(at);
      if (fresh.status.enrolled || !fresh.status.can_enroll || !fresh.status.setup_enabled) return;
      const preflight = await supabase.rpc('mfa_enroll_preflight');
      if (preflight.error) throw preflight.error;
      await assertIdentity(at, epoch);
      for (const pending of fresh.factors.filter((factor) => factor.factor_type === 'totp' && factor.status === 'unverified')) {
        await cancelPending(pending.id, at, epoch);
      }
      const enrolled = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator', issuer: 'PrivacyNotes' });
      await assertIdentity(at, epoch);
      if (enrolled.error || !enrolled.data) {
        await readState(at);
        throw enrolled.error ?? new Error('mfa_enroll_failed');
      }
      const secret = normalizeKey(enrolled.data.totp.secret);
      if (!/^[A-Z2-7]{16,128}$/.test(secret)) throw new Error('invalid_totp_secret');
      const uri = new URL(enrolled.data.totp.uri);
      if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || normalizeKey(uri.searchParams.get('secret') ?? '') !== secret) throw new Error('invalid_totp_uri');
      // qrcode.react draws the URI locally. Server-returned SVG is never injected.
      // The server labels the entry with the phrase account's internal email,
      // which authenticator apps show as a service called "phrase"; the label
      // is rebuilt here and every parameter the code depends on is kept.
      const account = t('twoFactor.authenticatorAccount', { id: auth.status === 'authenticated' ? auth.pubkey.slice(0, 8) : '' });
      setSetup({ id: enrolled.data.id, secret, uri: labelTotpUri(uri, account), identity: at });
      setBackupSaved(false);
      setBackupAnswer('');
      setCode('');
    });
  }

  function activate() {
    if (!setup || !backupSaved || normalizeKey(backupAnswer) !== setup.secret || !/^\d{6}$/.test(code)) return;
    const pending = setup;
    void run(async (at, epoch) => {
      if (pending.identity !== at) throw new MfaCancelledError();
      await assertIdentity(at, epoch);
      // The server binds activation to this saved-copy-confirmed factor.
      await accountLogins.enrollMfa(pending.id);
      await assertIdentity(at, epoch);
      let failed = false;
      try {
        const verified = await verifyMfaCodeForSession(supabase, { factorId: pending.id, code });
        failed = Boolean(verified.error);
      } catch { failed = true; }
      await assertIdentity(at, epoch);
      // A lost verification response can still have activated MFA. Read the
      // actual factor before retrying or offering to delete a pending setup.
      const fresh = await readState(at);
      if (fresh.factors.some((factor) => factor.id === pending.id && factor.status === 'verified')) {
        clearSetup();
        setNotice('twoFactor.enabledNotice');
        notifyMfaChanged();
      } else {
        setCode('');
        setError(failed ? 'mfaPrompt.verificationFailed' : 'twoFactor.actionFailed');
      }
    });
  }

  function cancelSetup() {
    if (!setup) return;
    const pending = setup;
    // Forget the secret immediately, even if offline cleanup cannot finish.
    clearSetup();
    void run(async (at, epoch) => {
      if (pending.identity !== at) throw new MfaCancelledError();
      await cancelPending(pending.id, at, epoch);
      await readState(at);
    });
  }

  function removeFactor(factorId: string) {
    void run(async (at, epoch) => {
      await accountLogins.unenrollMfa(factorId);
      await assertIdentity(at, epoch);
      const fresh = await readState(at);
      if (!fresh.factors.some((factor) => factor.id === factorId && factor.status === 'verified')) return;
      await assertIdentity(at, epoch);
      let failed = false;
      try { const result = await supabase.auth.mfa.unenroll({ factorId }); failed = Boolean(result.error); }
      catch { failed = true; }
      await assertIdentity(at, epoch);
      const after = await readState(at);
      if (!after.factors.some((factor) => factor.id === factorId)) {
        // Turning 2FA off needs no notice: the off card with its badge says it.
        if (after.status.enrolled) setNotice('twoFactor.factorRemoved');
        notifyMfaChanged();
      } else setError(failed ? 'twoFactor.actionFailed' : 'twoFactor.stillEnabled');
    });
  }

  async function copyKey() {
    if (!setup || busy) return;
    try { await navigator.clipboard.writeText(setup.secret); if (alive.current) setExported('copied'); }
    catch { if (alive.current) setError('twoFactor.copyFailed'); }
  }

  async function downloadKey() {
    if (!setup || busy) return;
    // The same sentences the screens show, so the file never says something the app does not.
    const contents = [t('twoFactor.backupFileTitle'), '', setup.secret, '', t('twoFactor.backupWarning'), '', t('mfaPrompt.restore'), '', t('twoFactor.warning')].join('\n');
    const saved = await saveBlob(new Blob([contents], { type: 'text/plain;charset=utf-8' }), 'privacynotes-2fa-backup-key.txt');
    if (!alive.current) return;
    if (saved.ok) setExported('saved');
    else if (saved.reason !== 'cancelled') setError('twoFactor.saveFailed');
  }

  if (isDemoMode()) return null;
  const verified = factors.filter((factor) => factor.status === 'verified');
  const removable = verified.find((factor) => factor.factor_type === 'totp');
  return (
    <div className="space-y-4">
      <SectionEyebrow icon={ShieldCheck}>{t('twoFactor.title')}</SectionEyebrow>
      {error && <Callout tone="danger">{t(error)}</Callout>}
      {notice && <StatusLine tone="success">{t(notice)}</StatusLine>}
      {!status ? (
        <Button action="retry" onClick={() => void run(async () => { await readState(); })} disabled={busy}>{t(error ? 'twoFactor.retry' : 'twoFactor.loading')}</Button>
      ) : status.available && status.wrong_login ? (
        <AccountSignInSetup onReady={() => { void run(async () => { await readState(); }); }} />
      ) : !status.available || (!status.setup_enabled && !status.enrolled) ? (
        <p className={SETTINGS_HELP}>{t('twoFactor.notAvailable')}</p>
      ) : setup ? (
        <div className="space-y-4">
          <ol className="flex items-center gap-2" aria-label={t('twoFactor.stepOf', { step: STEPS.indexOf(step) + 1 })}>
            {STEPS.map((name, index) => {
              const at = STEPS.indexOf(step);
              return <li key={name} className={`flex items-center gap-2 ${index < STEPS.length - 1 ? 'flex-1' : ''}`} aria-current={index === at ? 'step' : undefined}>
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-small font-medium ${index < at ? 'bg-accent/15 text-accent-strong' : index === at ? 'bg-accent-fill text-white' : 'border border-divider text-pn-muted'}`}>
                  {index < at ? <Check size={12} aria-hidden="true" /> : index + 1}
                </span>
                <span className={`text-small ${index === at ? 'text-pn font-medium' : 'text-pn-soft'}`}>{t(`twoFactor.step.${name}`)}</span>
                {index < STEPS.length - 1 && <span className={`h-px flex-1 ${index < at ? 'bg-accent/40' : 'bg-divider'}`} aria-hidden="true" />}
              </li>;
            })}
          </ol>
          {step === 'scan' ? (
            <>
              <p className={SETTINGS_HELP}>{t('twoFactor.scan')}</p>
              <div className="w-fit mx-auto rounded-md bg-white p-3" role="img" aria-label={t('twoFactor.qrLabel')}>
                <QRCodeCanvas value={setup.uri} size={176} level="M" />
              </div>
              <a href={setup.uri} className="block text-center text-body text-accent hover:underline">{t('twoFactor.openAuthenticator')}</a>
              <div className="flex gap-2">
                <Button action="cancel" onClick={cancelSetup} disabled={busy} className="flex-1">{t('twoFactor.cancelSetup')}</Button>
                <Button action="next" variant="primary" onClick={() => setStep('key')} disabled={busy} className="flex-1" />
              </div>
            </>
          ) : step === 'key' ? (
            <>
              <TextField
                id={`${ids}-secret`}
                label={t('twoFactor.backupKey')}
                readOnly
                value={setup.secret.match(/.{1,4}/g)?.join(' ') ?? setup.secret}
                dir="ltr"
                className="font-mono text-center"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={exported === 'copied' ? 'primary' : 'secondary'}
                  icon={exported === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  onClick={() => void copyKey()}
                  disabled={busy}
                >
                  {t(exported === 'copied' ? 'twoFactor.copied' : 'twoFactor.copy')}
                </Button>
                <Button
                  variant={exported === 'saved' ? 'primary' : 'secondary'}
                  icon={exported === 'saved' ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}
                  onClick={() => void downloadKey()}
                  disabled={busy}
                >
                  {t(exported === 'saved' ? 'twoFactor.saved' : 'twoFactor.download')}
                </Button>
              </div>
              <Callout>{t('twoFactor.backupWarning')}</Callout>
              <Checkbox
                checked={backupSaved}
                onChange={(event) => setBackupSaved(event.target.checked)}
                disabled={busy}
                label={t('twoFactor.savedAcknowledgment')}
              />
              <div className="flex gap-2">
                <Button action="back" onClick={() => setStep('scan')} disabled={busy} className="flex-1" />
                <Button action="next" variant="primary" onClick={() => setStep('confirm')} disabled={busy || !backupSaved} className="flex-1" />
              </div>
            </>
          ) : (
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); activate(); }}>
              <p className={SETTINGS_HELP}>{t('twoFactor.confirmBackup')}</p>
              <TextField
                id={`${ids}-backup`}
                label={t('security:twoFactor.backupKey')}
                autoFocus
                type="password"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                autoCapitalize="characters"
                value={backupAnswer}
                onChange={(event) => setBackupAnswer(event.target.value)}
                disabled={busy}
                dir="ltr"
                className="font-mono"
              />
              <p className="text-body font-medium">{t('twoFactor.codeLabel')}</p>
              <PinInput value={code} onChange={setCode} length={6} reveal compact ariaLabel={t('twoFactor.codeLabel')} disabled={busy} />
              <Callout tone="success">{t('twoFactor.warning')}</Callout>
              {/* The first factor disconnects every extension and command line (migration 0152, beta #213 item 1). */}
              <p className={SETTINGS_HELP}>{t('twoFactor.disconnectsConnections')}</p>
              <div className="flex gap-2">
                <Button action="back" onClick={() => { setBackupAnswer(''); setCode(''); setStep('key'); }} disabled={busy} className="flex-1" />
                <Button action="confirm" variant="primary" type="submit" className="flex-1" disabled={busy || !backupSaved || normalizeKey(backupAnswer) !== setup.secret || code.length !== 6}>{t(busy ? 'mfaPrompt.verifying' : 'security:twoFactor.start')}</Button>
              </div>
            </form>
          )}
        </div>
      ) : status.enrolled || removable ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 p-4">
            <IconTile tone="success"><ShieldCheck weight="fill" aria-hidden="true" /></IconTile>
            <div className="min-w-0">
              <p className="text-body font-semibold text-success">{t('twoFactor.enabled')}</p>
              <p className="text-small text-pn-soft">{t('twoFactor.enabledHelp')}</p>
            </div>
          </div>
          {!status.satisfied && <Button variant="primary" icon={<ShieldCheck aria-hidden="true" />} className="w-full" disabled={busy} onClick={() => void run(async () => { await ensureLevel2(supabase, { allowLocalUse: true }); await readState(); })}>{t('mfaPrompt.verify')}</Button>}
          <div className="divide-y divide-divider rounded-md border border-divider">
            {verified.map((factor) => <div key={factor.id} className="flex items-center justify-between gap-3 p-3">
              <span className="flex items-center gap-2 text-body text-pn"><DeviceMobile className="text-accent" aria-hidden="true" />{t('twoFactor.authenticatorRow')}</span>
              {factor.created_at && <span className="text-small text-pn-muted">{t('twoFactor.addedOn', { date: formatInstant(factor.created_at, 'date') })}</span>}
            </div>)}
            <div className="p-3"><MfaRecoveryHelp /></div>
          </div>
          {verified.length > 1 && <p className={SETTINGS_HELP}>{t('twoFactor.multipleFactors', { count: verified.length })}</p>}
          {removable && <Button icon={<ShieldSlash aria-hidden="true" className="shrink-0" />} disabled={busy} onClick={() => removeFactor(removable.id)}>{t(busy ? 'security:connectedAccounts.working' : verified.length > 1 ? 'twoFactor.removeFactor' : 'twoFactor.disable')}</Button>}
          <HelpChip surface="twoFactor" className="pt-3 border-t border-divider" />
        </div>
      ) : !status.can_enroll && status.reason === 'mfa_managed_account_required' ? (
        <AccountSignInSetup onReady={() => { void readState().catch(() => { if (alive.current) setError('twoFactor.unavailable'); }); }} />
      ) : !status.can_enroll ? (
        <Callout>{t('twoFactor.cannotEnroll')}</Callout>
      ) : (
        <div className="space-y-4 rounded-lg border border-divider p-4">
          <div className="flex items-center gap-3">
            <IconTile tone="success"><ShieldPlus aria-hidden="true" /></IconTile>
            <div className="min-w-0 flex-1">
              <p className="text-body font-semibold text-pn">{t('twoFactor.offTitle')}</p>
              <p className={SETTINGS_HELP}>{t('twoFactor.offTime')}</p>
            </div>
            <Badge tone="warning">{t('twoFactor.offBadge')}</Badge>
          </div>
          <ul className="space-y-2">
            {([[DeviceMobile, 'benefitCode'], [Key, 'benefitPhrase'], [AppWindow, 'benefitApps']] as const).map(([Icon, key]) =>
              <li key={key} className="flex items-start gap-2.5 text-body text-pn-soft"><Icon className="mt-0.5 shrink-0 text-success" aria-hidden="true" />{t(`twoFactor.${key}`)}</li>)}
          </ul>
          <Button variant="primary" icon={<ShieldPlus aria-hidden="true" />} className="w-full" disabled={busy} onClick={startSetup}>{t(busy ? 'security:connectedAccounts.working' : 'twoFactor.start')}</Button>
        </div>
      )}
    </div>
  );
}
