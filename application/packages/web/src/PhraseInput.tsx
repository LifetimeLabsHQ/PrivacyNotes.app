import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { BIP39_WORDS } from '@notes/shared';
import { Check, Eye, EyeSlash, Warning } from './icons';
import { useSecretOnScreen } from './privacyScreen';
import { Badge, Callout } from './ui/feedback';

const BIP39_SET: ReadonlySet<string> = new Set(BIP39_WORDS);

/** True when `word` is either a valid BIP-39 word or (while still being typed
 *  at the end of the field with no trailing space) a prefix of one. */
function isPlausiblePhraseWord(word: string, isActiveLastWord: boolean): boolean {
  const lower = word.toLowerCase();
  if (BIP39_SET.has(lower)) return true;
  if (!isActiveLastWord) return false;
  return BIP39_WORDS.some((candidate) => candidate.startsWith(lower));
}

/**
 * How long a revealed phrase stays visible before masking itself again.
 * Matches Settings > Security > Phrase (`PhraseView.tsx`).
 */
export const PHRASE_INPUT_AUTO_HIDE_SECONDS = 60;

/**
 * How long an entered phrase may sit untouched before the field clears itself
 * (GitHub #888), so an unattended tab cannot be submitted later.
 */
export const PHRASE_INPUT_IDLE_CLEAR_SECONDS = 120;

/**
 * Keep the textarea's own letters transparent while masked so neither Firefox
 * (which lacks `-webkit-text-security`) nor Android's key-preview flash can
 * paint a typed letter, while leaving the caret visible in the bullet grid.
 * Inline for the same reason as `PinInput.tsx` and `PasscodeInput.tsx`.
 */
const MASKED_TEXT: CSSProperties = {
  color: 'transparent',
  caretColor: 'rgb(var(--pn-accent))',
};

/** Replace every non-whitespace character with a bullet, preserving spaces and
 *  line breaks so word structure and monospace line wraps match 1:1. */
export function maskPhrase(value: string): string {
  return value.replace(/\S/g, '•');
}

/** Count whitespace-separated words entered in the phrase field. */
export function countPhraseWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * @catalog PhraseInput
 * use: every multi-word recovery-phrase entry (LockScreen, PinRecoveryForm, PhraseReplacedScreen, Onboarding with `tone="washi"`): starts masked with a 1:1 bullet mirror, shows numbered word chips with live BIP-39 spelling feedback, reveals with a 60-second draining bar, blocks screenshots while revealed, and clears idle input after 2 minutes.
 * never: a plain unmasked `<textarea>` or `<TextField>` for a full recovery phrase; checking against the account's secret phrase per word (dictionary check uses the public BIP-39 list only).
 */
export function PhraseInput({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  disabled = false,
  tone = 'app',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** `app` uses semantic theme tokens; `washi` matches Onboarding's paper palette. */
  tone?: 'app' | 'washi';
}) {
  const { t } = useTranslation('auth');
  const [shown, setShown] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(PHRASE_INPUT_AUTO_HIDE_SECONDS);
  const [timedOut, setTimedOut] = useState(false);
  const mask = !shown;
  const hasValue = value.length > 0;
  const words = countPhraseWords(value);
  const washi = tone === 'washi';

  const parsedWords = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const parts = trimmed.split(/\s+/);
    const trailingSpace = /\s$/.test(value);
    return parts.map((word, index) => {
      const activeLast = index === parts.length - 1 && !trailingSpace;
      const valid = isPlausiblePhraseWord(word, activeLast);
      const exact = BIP39_SET.has(word.toLowerCase());
      return { index: index + 1, word, valid, exact };
    });
  }, [value]);

  const hasInvalidWord = parsedWords.some((item) => !item.valid);
  const allExactValid =
    (words === 12 || words === 24) && parsedWords.every((item) => item.exact);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastActivityRef = useRef(Date.now());

  // Any edit or QR fill resets the idle clock and dismisses an earlier timeout notice.
  useEffect(() => {
    if (!hasValue) return;
    lastActivityRef.current = Date.now();
    setTimedOut(false);
  }, [value, hasValue]);

  // Block native screenshots/recordings and cover the app switcher while the
  // entered phrase is revealed on screen.
  useSecretOnScreen(shown && words > 0);

  // Wall-clock 60s auto-hide (mirrors PhraseView.tsx) plus immediate re-mask
  // when the tab hides, so returning to a forgotten tab never flashes words.
  useEffect(() => {
    if (!shown) return;
    const deadline = Date.now() + PHRASE_INPUT_AUTO_HIDE_SECONDS * 1000;
    setSecondsLeft(PHRASE_INPUT_AUTO_HIDE_SECONDS);

    function syncCountdown(): boolean {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      if (left > 0) {
        setSecondsLeft(left);
        return false;
      }
      setShown(false);
      return true;
    }

    const id = setInterval(() => {
      if (syncCountdown()) clearInterval(id);
    }, 1000);

    function handleVisibility() {
      if (document.visibilityState === 'hidden') {
        clearInterval(id);
        setShown(false);
        return;
      }
      if (syncCountdown()) clearInterval(id);
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [shown]);

  // Wall-clock 2-minute idle clear (GitHub #888): checks on an interval and on
  // tab return / focus so background-tab throttling cannot keep an abandoned
  // phrase sitting ready to submit.
  useEffect(() => {
    if (!hasValue) return;

    function checkIdle(): boolean {
      if (Date.now() - lastActivityRef.current < PHRASE_INPUT_IDLE_CLEAR_SECONDS * 1000) {
        return false;
      }
      setShown(false);
      setTimedOut(true);
      onChangeRef.current('');
      return true;
    }

    const id = setInterval(() => {
      if (checkIdle()) clearInterval(id);
    }, 1000);

    function onReturn() {
      if (checkIdle()) clearInterval(id);
    }

    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [hasValue]);

  function handleToggleShown() {
    if (hasValue) lastActivityRef.current = Date.now();
    setShown((s) => !s);
  }

  const wellClass = washi
    ? 'bg-[var(--wl-bg)] border-[var(--wl-line)]'
    : 'bg-track border-divider';
  const inkClass = washi ? 'text-[var(--wl-ink)]' : 'text-pn';
  const mutedClass = washi ? 'text-[var(--wl-muted)]' : 'text-pn-muted';
  const placeholderClass = washi ? 'placeholder:text-[var(--wl-muted)]' : 'placeholder:text-pn-muted';
  const toggleClass = shown
    ? washi
      ? 'border-warning/50 bg-[var(--wl-bg)] text-[var(--wl-ink)] hover:bg-[var(--wl-tint)]'
      : 'border-warning/50 bg-surface-1 text-pn hover:bg-surface-2'
    : washi
      ? 'border-warning/35 bg-warning/10 text-[var(--wl-amber-text)] hover:bg-warning/15'
      : 'border-warning/35 bg-warning/10 text-warning hover:bg-warning/15';
  const barTrackClass = washi ? 'bg-[var(--wl-line)]' : 'bg-divider';
  const chipOkClass = washi
    ? 'border-[var(--wl-line)] bg-[var(--wl-bg)] text-[var(--wl-ink)]'
    : 'border-divider bg-surface-1 text-pn';

  return (
    <div className="space-y-2 text-start">
      <div
        dir="ltr" // rtl-ok: BIP-39 phrase words, always LTR
        className={`max-h-36 overflow-y-auto rounded-md border focus-within:border-accent transition-colors ${wellClass}`}
      >
        <div className="grid">
          <div
            aria-hidden="true"
            className={`pn-phrase-mirror col-start-1 row-start-1 pointer-events-none select-none whitespace-pre-wrap break-words p-3 text-body font-mono ${
              mask && hasValue ? inkClass : 'invisible'
            }`}
          >
            {hasValue ? `${mask ? maskPhrase(value) : value}\u200b` : ''}
          </div>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onCopy={(e) => {
              if (mask) e.preventDefault();
            }}
            onCut={(e) => {
              if (mask) e.preventDefault();
            }}
            placeholder={placeholder}
            rows={3}
            dir="ltr" // rtl-ok: BIP-39 phrase words, always LTR
            // A phone keyboard must neither rewrite a phrase word nor learn it.
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            disabled={disabled}
            autoFocus={autoFocus}
            style={mask ? MASKED_TEXT : undefined}
            className={`col-start-1 row-start-1 w-full resize-none overflow-hidden bg-transparent p-3 text-body font-mono focus:outline-none ${placeholderClass} ${
              mask ? 'selection:text-transparent selection:bg-accent/25' : inkClass
            }`}
          />
        </div>
      </div>

      {parsedWords.length > 0 && (
        <ol
          dir="ltr" // rtl-ok: BIP-39 phrase word positions 1..24 always run LTR
          aria-hidden="true"
          data-phrase-chips=""
          className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 select-none"
        >
          {parsedWords.map((item) => (
            <li
              key={item.index}
              data-word-valid={item.valid ? 'true' : 'false'}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-meta font-mono min-w-0 ${
                item.valid
                  ? chipOkClass
                  : 'border-danger/50 bg-danger/10 text-danger'
              }`}
            >
              <span className={`shrink-0 tabular-nums ${item.valid ? mutedClass : 'text-danger/80'}`}>
                {item.index}.
              </span>
              <span className="truncate">
                {mask ? maskPhrase(item.word) : item.word}
              </span>
            </li>
          ))}
        </ol>
      )}

      <button
        type="button"
        onClick={handleToggleShown}
        disabled={disabled}
        aria-pressed={shown}
        className={`w-full overflow-hidden rounded-md border text-body font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${toggleClass}`}
      >
        <span className="flex items-center justify-center gap-1.5 px-3 py-2">
          {shown
            ? <EyeSlash aria-hidden="true" className="text-warning" />
            : <Eye aria-hidden="true" />}
          {shown
            ? t('importPhrase.hidePhraseIn', { seconds: secondsLeft })
            : t('importPhrase.showPhrase')}
        </span>
        {shown && (
          <span className={`block h-1 ${barTrackClass}`}>
            <span
              className="block h-full bg-warning transition-[width] duration-1000 ease-linear"
              style={{ width: `${(secondsLeft / PHRASE_INPUT_AUTO_HIDE_SECONDS) * 100}%` }}
            />
          </span>
        )}
      </button>

      <div className={`flex flex-wrap items-center justify-between gap-2 text-small ${mutedClass}`}>
        {words > 0 ? (
          <Badge
            tone={hasInvalidWord ? 'danger' : allExactValid ? 'success' : 'neutral'}
            icon={
              hasInvalidWord
                ? <Warning aria-hidden="true" />
                : allExactValid
                  ? <Check aria-hidden="true" />
                  : undefined
            }
          >
            {t('importPhrase.wordsEntered', { count: words })}
          </Badge>
        ) : (
          <span>{t('importPhrase.maskedHint')}</span>
        )}
        <span>{t('importPhrase.clearsIdle')}</span>
      </div>

      {timedOut && (
        <Callout tone="warning">
          {t('importPhrase.clearedIdle')}
        </Callout>
      )}
    </div>
  );
}
