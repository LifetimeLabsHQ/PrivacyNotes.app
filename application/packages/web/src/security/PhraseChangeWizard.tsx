import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, ShieldCheck, Terminal } from '../icons';
import { useAuth } from '../auth';
import { useAccountLogins } from '../accountLogins';
import { isDemoMode } from '../demo';
import { pinIsPasscode } from '../pin';
import { SecretInput } from '../PasscodeInput';
import { secretReady } from '../secretKind';
import { SectionEyebrow, SETTINGS_HELP } from '../settingsUI';
import { Button, Callout, Checkbox, Modal, ModalFooter, Spinner, StatusLine } from '../ui';
import type { ChangeState, PreparedChange } from '../phraseChange';
import { PhraseView } from './PhraseView';
import { PhraseWordCheck, usePhraseCheck } from './PhraseWordCheck';

type Module = Awaited<ReturnType<ReturnType<typeof useAuth>['loadPhraseChange']>>;
type Step = 'loading' | 'blocked' | 'intro' | 'pin' | 'phrase' | 'check' | 'running' | 'failed' | 'unknown' | 'signIn' | 'done';

// What the demo shows in step 1: no server answers there.
const DEMO_STATE: ChangeState = {
  custodial: false,
  logins: [{ id: 'demo-login', provider: 'google', email: 'you@example.com' }],
  factors: [],
  connections: [
    { id: 'demo-browser', label: 'Chrome', client: 'browser' },
    { id: 'demo-cli', label: 'privacynotes', client: 'cli' },
  ],
  settings: { nonce: null, keyEpoch: 1, plain: null, localRev: 0 },
};

const PROVIDER = { google: 'Google', apple: 'Apple', github: 'GitHub' } as const;

/** The refusal codes the wizard names; any other reads as "did not change". */
function failureKey(code: string): string {
  if (code === 'phrase_change_too_many') return 'phraseChange.failedTooMany';
  if (code === 'phrase_change_settings_moved' || code === 'phrase_change_conflict') return 'phraseChange.failedMoved';
  if (code.startsWith('mfa_') || code === 'phrase_change_keep_factor') return 'phraseChange.failedTwoFactor';
  if (code === 'key_ring_incomplete') return 'phraseChange.failedKeyRing';
  if (code === 'biometric_required') return 'phraseChange.failedBiometric';
  if (code === 'settings_unsynced') return 'phraseChange.failedUnsynced';
  if (code === 'phrase_change_unavailable_now' || code === 'account_unavailable' || code === 'settings_unavailable') return 'phraseChange.failedOffline';
  return 'phraseChange.failed';
}

/**
 * The phrase change, in one window over Settings: what happens and what the
 * person keeps, the PIN or passcode typed fresh (only when the account holds
 * a PIN wrap), the new phrase shown once, the check of three of its words,
 * then the change itself and its result. The length is fixed when the window
 * opens: the length cards and the "Change phrase" row of the Phrase tab
 * preset it. The demo walks the same steps with sample data, and its last
 * button stays disabled.
 * Spec: docs/internal/plans/phrase-change.md (section 2.3)
 */
export function PhraseChangeWizard({ words, reason, onClose, onOpenTwoFactor }: {
  words: 12 | 24;
  /** `leak`: the "Change phrase" row, which adds the 2FA line. */
  reason: 'length' | 'leak';
  onClose: () => void;
  onOpenTwoFactor?: () => void;
}) {
  const { t } = useTranslation('security');
  const auth = useAuth();
  const accountLogins = useAccountLogins();
  const demo = isDemoMode();
  const kind = pinIsPasscode() ? 'passcode' : 'pin';

  const [step, setStep] = useState<Step>('loading');
  const [blocked, setBlocked] = useState<string | null>(null);
  const [state, setState] = useState<ChangeState | null>(null);
  const [keepLogins, setKeepLogins] = useState<Set<string>>(new Set());
  const [keepFactors, setKeepFactors] = useState<Set<string>>(new Set());
  const [newPhrase, setNewPhrase] = useState('');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stage, setStage] = useState<'prepare' | 'send'>('prepare');
  const mod = useRef<Module | null>(null);
  // The change this window prepared, and whether it may have gone out: a
  // change that went out (or landed) is never discarded here, because its
  // doors are or may become this device's.
  const prepared = useRef<PreparedChange | null>(null);
  const sent = useRef(false);
  const attempted = useRef(false);
  const alive = useRef(true);
  const check = usePhraseCheck(newPhrase);

  const needsPin = !demo && state !== null && mod.current !== null && mod.current.changeNeedsPin(state);
  const steps: Step[] = needsPin ? ['intro', 'pin', 'phrase', 'check'] : ['intro', 'phrase', 'check'];
  const stepNumber = steps.indexOf(step) + 1;

  async function load() {
    setStep('loading');
    setBlocked(null);
    try {
      const m = mod.current ?? await auth.loadPhraseChange();
      mod.current = m;
      if (!newPhrase) setNewPhrase(m.newChangePhrase(words));
      if (demo) {
        accept(DEMO_STATE);
        return;
      }
      if (!navigator.onLine) throw new Error('offline');
      const read = async () => {
        const actor = await auth.phraseChangeActor();
        if (!actor) throw new m.PhraseChangeError('account_auth_required');
        return m.readChangeState(actor);
      };
      let next: ChangeState;
      try {
        next = await read();
      } catch (err) {
        // An account that is not managed yet runs the activation first (4.5).
        if (!(err instanceof m.PhraseChangeError) || err.code !== 'account_management_required') throw err;
        await accountLogins.activate();
        next = await read();
      }
      if (alive.current) accept(next);
    } catch (err) {
      if (!alive.current) return;
      const code = err instanceof Error ? err.message : '';
      setBlocked(code === 'offline' ? t('phraseChange.offline')
        : code === 'settings_unsynced' ? t('phraseChange.failedUnsynced')
        : t('phraseChange.readFailed'));
      setStep('blocked');
    }
  }

  function accept(next: ChangeState) {
    setState(next);
    setKeepLogins(new Set(next.logins.map((l) => l.id)));
    setKeepFactors(new Set(next.factors.map((f) => f.id)));
    setStep('intro');
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      discardUnsent();
      // A change left waiting (an idle re-lock unmounts the wizard too) must
      // not keep this tab held and its sync stopped (phrase-change-reviews.md 14.5, finding 12).
      auth.leavePhraseChange();
    };
    // Once per window: the new phrase and the account state belong to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A change prepared and never sent leaves no hardware key behind. */
  function discardUnsent() {
    if (prepared.current && mod.current && !sent.current) mod.current.discardPreparedChange(prepared.current);
    prepared.current = null;
  }

  async function run() {
    const m = mod.current;
    if (demo || !m || !state) return;
    discardUnsent();
    setFailure(null);
    setStage('prepare');
    setStep('running');
    try {
      const actor = await auth.phraseChangeActor();
      if (!actor) throw new m.PhraseChangeError('account_auth_required');
      // A retry reads the account again: the settings row it builds on may
      // have moved, and a refused change discarded what it had prepared.
      const fresh = attempted.current ? await m.readChangeState(actor) : state;
      attempted.current = true;
      const keep = {
        logins: fresh.logins.map((l) => l.id).filter((id) => keepLogins.has(id)),
        factors: fresh.factors.map((f) => f.id).filter((id) => keepFactors.has(id)),
      };
      const made = await m.prepareChange(actor, fresh, {
        phrase: newPhrase,
        pin: needsPin ? pin : undefined,
        biometric: { reason: t('phraseChange.titleChange'), cancelLabel: t('common:actions.cancel') },
      });
      prepared.current = made;
      if (!alive.current) return;
      setStage('send');
      const outcome = await auth.changePhrase(made, keep, fresh);
      // Landed, or not known: the doors stay for the commit that follows.
      if (outcome.ok || outcome.reason !== 'refused') sent.current = true;
      if (!alive.current) return;
      settle(outcome);
    } catch (err) {
      if (alive.current) fail(err instanceof m.PhraseChangeError ? err.code : err instanceof Error ? err.message : '');
    }
  }

  function settle(outcome: Awaited<ReturnType<typeof auth.changePhrase>>) {
    if (outcome.ok) setStep('done');
    else if (outcome.reason === 'unknown') setStep('unknown');
    else if (outcome.reason === 'sign_in') setStep('signIn');
    else fail(outcome.code);
  }

  function fail(code: string) {
    // A refusal sends nothing more under this preparation: the retry
    // prepares again (sendChange also zeroed its new private key).
    discardUnsent();
    if (code === 'pin_wrong' || code === 'pin_required') {
      setPin('');
      setPinError(kind === 'passcode' ? t('pinTab.incorrectPasscode') : t('pinTab.incorrectPin'));
      setStep('pin');
      return;
    }
    setFailure(t(failureKey(code)));
    setStep('failed');
  }

  async function resume() {
    const m = mod.current;
    if (!m || !prepared.current) return;
    setStage('send');
    setStep('running');
    const outcome = await auth.continuePhraseChange(prepared.current);
    if (!alive.current) return;
    // A refusal now means the change did not land after all.
    if (!outcome.ok && outcome.reason === 'refused') sent.current = false;
    settle(outcome);
  }

  // A running change, and a change whose result is not known, must be
  // answered here: the window has no X then.
  const closable = !['running', 'unknown', 'signIn'].includes(step);
  const custodial = state?.custodial === true;

  function toggle(set: Set<string>, id: string, on: boolean, update: (next: Set<string>) => void) {
    const next = new Set(set);
    if (on) next.add(id); else next.delete(id);
    update(next);
  }

  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (step === 'loading') {
    body = <StatusLine busy>{t('phraseChange.loading')}</StatusLine>;
  } else if (step === 'blocked') {
    body = <Callout tone="danger" action={<Button action="retry" onClick={() => void load()}>{t('twoFactor.retry')}</Button>}>{blocked}</Callout>;
  } else if (step === 'intro' && state) {
    const lastLogin = custodial && keepLogins.size <= 1;
    const lastFactor = state.factors.length > 0 && keepFactors.size <= 1;
    body = (
      <div className="space-y-4">
        <p className="text-body text-pn leading-relaxed">{t('phraseChange.intro', { count: words })}</p>
        {state.logins.length > 0 && (
          <div className="space-y-1.5">
            <SectionEyebrow>{t('phraseChange.loginsHeading')}</SectionEyebrow>
            {state.logins.map((login) => {
              const on = keepLogins.has(login.id);
              return (
                <Checkbox
                  key={login.id}
                  label={login.email ? `${PROVIDER[login.provider]}, ${login.email}` : PROVIDER[login.provider]}
                  checked={on}
                  disabled={on && lastLogin}
                  onChange={(e) => toggle(keepLogins, login.id, e.target.checked, setKeepLogins)}
                />
              );
            })}
            <p className={SETTINGS_HELP}>{custodial ? `${t('phraseChange.keepHelp')} ${t('phraseChange.keepLastLogin')}` : t('phraseChange.keepHelp')}</p>
          </div>
        )}
        {state.factors.length > 0 && (
          <div className="space-y-1.5">
            <SectionEyebrow>{t('twoFactor.title')}</SectionEyebrow>
            {state.factors.map((factor) => {
              const on = keepFactors.has(factor.id);
              return (
                <Checkbox
                  key={factor.id}
                  label={factor.name ?? t('twoFactor.authenticatorRow')}
                  checked={on}
                  disabled={on && lastFactor}
                  onChange={(e) => toggle(keepFactors, factor.id, e.target.checked, setKeepFactors)}
                />
              );
            })}
            <p className={SETTINGS_HELP}>{`${t('phraseChange.keepHelp')} ${t('phraseChange.keepLastFactor')}`}</p>
          </div>
        )}
        {state.connections.length > 0 && (
          <div className="space-y-1.5">
            <SectionEyebrow>{t('phraseChange.connectionsHeading')}</SectionEyebrow>
            <ul className="space-y-1">
              {state.connections.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-body text-pn">
                  {c.client === 'cli' ? <Terminal aria-hidden="true" className="shrink-0 text-accent" /> : <Globe aria-hidden="true" className="shrink-0 text-accent" />}
                  <span className="min-w-0 truncate">{c.client === 'cli' ? t('phraseChange.cliConnection') : c.label}</span>
                </li>
              ))}
            </ul>
            <p className={SETTINGS_HELP}>{t('phraseChange.connectionsHelp')}</p>
          </div>
        )}
        {reason === 'leak' && state.factors.length === 0 && <Callout tone="info">{t('phraseChange.leakTwoFactor')}</Callout>}
      </div>
    );
    footer = <><Button action="cancel" onClick={onClose} /><Button action="next" onClick={() => setStep(needsPin ? 'pin' : 'phrase')} /></>;
  } else if (step === 'pin') {
    const ready = secretReady(kind, pin);
    body = (
      <div className="space-y-3">
        <p className="text-body text-pn leading-relaxed">{kind === 'passcode' ? t('phraseChange.passcodeBody') : t('phraseChange.pinBody')}</p>
        <SecretInput
          kind={kind}
          value={pin}
          onChange={(v) => { setPin(v); setPinError(null); }}
          onComplete={() => { if (secretReady(kind, pin)) setStep('phrase'); }}
          ariaLabel={kind === 'passcode' ? t('pinTab.kindPasscode') : t('pinTab.kindPin')}
          autoFocus
        />
        {pinError && <p role="alert" className="text-small text-danger text-center">{pinError}</p>}
      </div>
    );
    footer = <><Button action="back" onClick={() => setStep('intro')} /><Button action="next" disabled={!ready} onClick={() => setStep('phrase')} /></>;
  } else if (step === 'phrase') {
    body = (
      <div className="space-y-3">
        <p className="text-body text-pn leading-relaxed">{t('phraseChange.phraseBody')}</p>
        <PhraseView phrase={newPhrase} onCancel={onClose} hideDismiss />
      </div>
    );
    footer = <><Button action="back" onClick={() => setStep(needsPin ? 'pin' : 'intro')} /><Button action="done" iconEnd onClick={() => { check.reset(); setStep('check'); }} /></>;
  } else if (step === 'check') {
    body = (
      <div className="space-y-3">
        <p className="text-body text-pn leading-relaxed">{t('phraseChange.checkBody')}</p>
        <PhraseWordCheck check={check} />
        {demo && <Callout tone="info">{t('phraseChange.demoBlocked')}</Callout>}
      </div>
    );
    footer = <><Button action="back" onClick={() => setStep('phrase')} /><Button action="confirm" disabled={!check.correct || demo} onClick={() => void run()}>{t('phraseChange.changeRow')}</Button></>;
  } else if (step === 'running') {
    body = <PhraseChangeEnd end={{ kind: 'running', stage }} />;
  } else if (step === 'failed') {
    body = <PhraseChangeEnd end={{ kind: 'failed', message: failure ?? t('phraseChange.failed') }} />;
    footer = <><Button action="cancel" onClick={onClose} /><Button action="retry" variant="primary" onClick={() => void run()}>{t('twoFactor.retry')}</Button></>;
  } else if (step === 'unknown' || step === 'signIn') {
    body = <PhraseChangeEnd end={{ kind: step }} />;
    footer = <Button action="retry" variant="primary" onClick={() => void resume()}>{step === 'unknown' ? t('phraseChange.checkAgain') : t('twoFactor.retry')}</Button>;
  } else if (step === 'done') {
    const end = { kind: 'done' as const, connections: (state?.connections.length ?? 0) > 0, twoFactorOff: (state?.factors.length ?? 0) === 0 };
    body = <PhraseChangeEnd end={end} onOpenTwoFactor={onOpenTwoFactor ? () => { onClose(); onOpenTwoFactor(); } : undefined} />;
    footer = <Button action="done" onClick={onClose} />;
  }

  return (
    <Modal
      title={t('phraseChange.titleChange')}
      subtitle={stepNumber > 0 ? t('phraseChange.step', { step: stepNumber, total: steps.length }) : undefined}
      onClose={closable ? onClose : undefined}
      escape={closable}
      closeOnBackdrop={false}
      layer="z-[60]"
      className="max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto"
    >
      {step === 'loading' && !state ? <div className="flex justify-center py-4"><Spinner size={24} label={t('phraseChange.loading')} /></div> : body}
      {footer && <ModalFooter>{footer}</ModalFooter>}
    </Modal>
  );
}

/** How the change is going, or how it ended: the wizard's last screens. */
export type ChangeEnd =
  | { kind: 'running'; stage: 'prepare' | 'send' }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown' }
  | { kind: 'signIn' }
  | { kind: 'done'; connections: boolean; twoFactorOff: boolean };

/**
 * The body of the wizard's last screens. Its own part so that the UI
 * catalog shows each of them: the demo stops before the change, so it
 * never reaches them.
 */
export function PhraseChangeEnd({ end, onOpenTwoFactor }: { end: ChangeEnd; onOpenTwoFactor?: () => void }) {
  const { t } = useTranslation('security');
  if (end.kind === 'running') {
    return (
      <div className="space-y-2">
        <StatusLine busy>{end.stage === 'prepare' ? t('phraseChange.runPrepare') : t('phraseChange.runSend')}</StatusLine>
        <p className={SETTINGS_HELP}>{t('phraseChange.runHint')}</p>
      </div>
    );
  }
  if (end.kind === 'failed') return <Callout tone="danger">{end.message}</Callout>;
  if (end.kind === 'unknown' || end.kind === 'signIn') {
    return (
      <Callout tone="warning" title={end.kind === 'unknown' ? t('phraseChange.unknownTitle') : t('phraseChange.signInTitle')}>
        {end.kind === 'unknown' ? t('phraseChange.unknownBody') : t('phraseChange.signInBody')}
      </Callout>
    );
  }
  return (
    <div className="space-y-3">
      <Callout tone="success" title={t('phraseChange.doneTitle')}>
        <ul className="list-disc ps-5 space-y-1">
          <li>{t('phraseChange.doneBackground')}</li>
          {end.connections && <li>{t('phraseChange.doneConnect')}</li>}
          <li>{t('phraseChange.doneDevices')}</li>
        </ul>
      </Callout>
      {end.twoFactorOff && onOpenTwoFactor && (
        <Callout tone="info" action={<Button icon={<ShieldCheck />} onClick={onOpenTwoFactor}>{t('twoFactor.start')}</Button>}>
          {t('phraseChange.doneTwoFactor')}
        </Callout>
      )}
    </div>
  );
}
