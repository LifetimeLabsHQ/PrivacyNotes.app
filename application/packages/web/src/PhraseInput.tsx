import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Eye, EyeSlash } from './icons';
import { useSecretOnScreen } from './privacyScreen';
import { Badge, Callout } from './ui';

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
 * Multi-line recovery-phrase input that starts masked, borrows the
 * Show / Hide + 60-second draining bar control from `PhraseView.tsx`,
 * and clears idle input after 2 minutes (GitHub #888).
 *
 * Uses a CSS grid mirror (`col-start-1 row-start-1`) inside one scroll box so
 * the bullet overlay and the textarea share identical width, wrapping and
 * scrollbars across every browser, including Firefox.
 */
export function PhraseInput({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation('auth');
  const [shown, setShown] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(PHRASE_INPUT_AUTO_HIDE_SECONDS);
  const [timedOut, setTimedOut] = useState(false);
  const mask = !shown;
  const hasValue = value.length > 0;
  const words = countPhraseWords(value);

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

  return (
    <div className="space-y-2">
      <div
        dir="ltr" // rtl-ok: BIP-39 phrase words, always LTR
        className="max-h-36 overflow-y-auto rounded-md bg-[var(--wl-bg)] border border-[var(--wl-line)] focus-within:border-accent transition-colors"
      >
        <div className="grid">
          <div
            aria-hidden="true"
            className={`pn-phrase-mirror col-start-1 row-start-1 pointer-events-none select-none whitespace-pre-wrap break-words p-3 text-body font-mono ${
              mask && hasValue ? 'text-[var(--wl-ink)]' : 'invisible'
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
            className={`col-start-1 row-start-1 w-full resize-none overflow-hidden bg-transparent p-3 text-body font-mono focus:outline-none placeholder:text-[var(--wl-muted)] ${
              mask ? 'selection:text-transparent selection:bg-accent/25' : 'text-[var(--wl-ink)]'
            }`}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={handleToggleShown}
        disabled={disabled}
        aria-pressed={shown}
        className={`w-full overflow-hidden rounded-md border text-body font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${
          shown
            ? 'border-warning/50 bg-[var(--wl-bg)] text-[var(--wl-ink)] hover:bg-[var(--wl-tint)]'
            : 'border-warning/35 bg-warning/10 text-[var(--wl-amber-text)] hover:bg-warning/15'
        }`}
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
          <span className="block h-1 bg-[var(--wl-line)]">
            <span
              className="block h-full bg-warning transition-[width] duration-1000 ease-linear"
              style={{ width: `${(secondsLeft / PHRASE_INPUT_AUTO_HIDE_SECONDS) * 100}%` }}
            />
          </span>
        )}
      </button>

      <div className="flex items-center justify-between gap-2 text-small text-[var(--wl-muted)]">
        {words > 0 ? (
          <Badge
            tone={words === 12 || words === 24 ? 'success' : 'neutral'}
            icon={words === 12 || words === 24 ? <Check aria-hidden="true" /> : undefined}
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
