import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { PhraseView } from './PhraseView';
import { PhraseOdds } from './PhraseOdds';
import { PhrasePinGate, type PinGateRecovery } from './PhrasePinGate';
import { HelpChip } from '../HelpChip';
import { RedditLogo, Vault, Warning } from '../icons';
import { isDemoMode } from '../demo';
import { ReencryptProgressLine } from '../reencryptProgress';

// The length tiles and the phrase change load only when the tab opens:
// MoveScreen shows this tab too, and it is on the boot path.
const PhraseLength = lazy(() => import('./PhraseLength').then((m) => ({ default: m.PhraseLength })));

// The thread's own title, shown untranslated: the thread is written in English.
const PHRASE_MEGATHREAD = {
  href: 'https://www.reddit.com/r/PrivacyNotes/comments/1wsy3ky/megathread_your_12word_phrase_explained_privacy/',
  title: 'Megathread: Your 12-word phrase explained, privacy, security and recovery',
};

/** Phrase reveal and backup stay separate from account custody changes. */
export function PhraseTab({
  phrase, pubkey, pinTimeoutMinutes, hasPin, pinCredential, onCancel, onOpenCustody, onOpenTwoFactor, recovery,
}: {
  phrase: string;
  pubkey: string;
  pinTimeoutMinutes: number;
  hasPin: boolean;
  pinCredential?: string;
  onCancel: () => void;
  onOpenCustody?: () => void;
  /** The 2FA tab, for the phrase change's last screen. */
  onOpenTwoFactor?: () => void;
  recovery?: PinGateRecovery;
}) {
  const { t } = useTranslation('security');
  return <PhrasePinGate pubkey={pubkey} pinTimeoutMinutes={pinTimeoutMinutes} hasPin={hasPin}
    pinCredential={pinCredential} onCancel={onCancel} recovery={recovery}>
    <div className="space-y-4">
      {isDemoMode() && <div className="rounded-md border border-amber-400/40 bg-amber-50 dark:border-amber-600/30 dark:bg-amber-950/20 px-3 py-2.5 text-compact leading-relaxed text-warning flex items-start gap-2.5">
        <Warning aria-hidden="true" className="shrink-0 mt-0.5" />
        <span>{t('phraseView.demoPhrase')}</span>
      </div>}
      <PhraseView phrase={phrase} onCancel={onCancel} hideDismiss gated hasPin={hasPin} />
      <Suspense fallback={null}><PhraseLength words={phrase.trim().split(/\s+/).length} onOpenTwoFactor={onOpenTwoFactor} /></Suspense>
      {onOpenCustody && <button type="button" className="inline-flex items-center gap-2 text-body text-accent hover:underline" onClick={onOpenCustody}>
        <Vault className="shrink-0" aria-hidden="true" />
        {t('connectedAccounts.openCustody')}
      </button>}
      <PhraseOdds words={phrase.trim().split(/\s+/).length} />
      <ReencryptProgressLine />
      <div className="flex flex-col items-start gap-1.5">
        <a href={PHRASE_MEGATHREAD.href} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-start gap-2 max-w-full text-help text-accent hover:underline">
          <span className="flex h-5 shrink-0 items-center">
            <RedditLogo weight="fill" aria-hidden="true" />
          </span>
          <span>{PHRASE_MEGATHREAD.title}</span>
        </a>
        <HelpChip surface="phrase" />
      </div>
    </div>
  </PhrasePinGate>;
}
