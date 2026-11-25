import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clearPin, phraseMatches, restoreUnsavedClear } from './pinRecovery';
import type { SecretKind } from './secretKind';
import { Button, PhraseInput } from './ui';
import { saveCredential, type UserSettings } from './userSettings';

/**
 * The recovery phrase, offered wherever a forgotten PIN would otherwise be
 * a dead end. Shared by the PIN tab and the protected-note gate, which
 * both run inside an unlocked app and can therefore check the phrase
 * against the one already in memory.
 *
 * Layout-neutral on purpose: no icon and no heading, so the note gate can
 * put its own centred header above and the settings pane can keep its
 * left-aligned column.
 *
 * The lock screen does NOT use this. There the phrase is the sign-in, so
 * recovery rides the phrase screen it already has.
 *
 * Spec: docs/internal/specs/pin-recovery.md
 */
export function PinRecoveryForm({
  kind = 'pin',
  phrase,
  userSettings,
  onSettingsChange,
  onCleared,
  onCancel,
}: {
  /** The secret this clears, for the words on screen. */
  kind?: SecretKind;
  /** The account's phrase, held by the signed-in app. */
  phrase: string;
  userSettings: UserSettings;
  /** `base` is the copy this surface was rendered with; the parent applies
   *  only the credential keys that differ between it and `next`. */
  onSettingsChange: (next: UserSettings, base: UserSettings) => void;
  /** The PIN is gone. Callers move on to setting a new one. */
  onCleared: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('security');
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!input.trim()) return;
    if (!phraseMatches(input, phrase)) {
      // One message for every failure. Naming the word that was wrong
      // would turn this box into a checker for a phrase somebody found.
      setError(t('pinRecovery.wrongPhrase'));
      return;
    }
    const cleared = await clearPin(userSettings, phrase);
    if (!cleared) {
      setError(t('appLock.phraseNotSaved'));
      return;
    }
    // A save the store refused leaves the account's PIN in force, so this
    // device gets its hash and its wrap back.
    if (!saveCredential(cleared.settings, userSettings, onSettingsChange)) {
      await restoreUnsavedClear(phrase, cleared);
      setError(t('pinTab.changeNotSaved'));
      return;
    }
    onCleared();
  }

  return (
    <div className="space-y-3 text-start">
      <p className="text-small text-pn-soft leading-relaxed">
        {kind === 'passcode' ? t('pinRecovery.introPasscode') : t('pinRecovery.intro')}
      </p>
      <PhraseInput
        value={input}
        onChange={(next) => {
          setInput(next);
          setError(null);
        }}
        placeholder={t('auth:importPhrase.placeholder')}
        autoFocus
      />
      <p className="text-small text-pn-soft leading-relaxed">
        {kind === 'passcode' ? t('pinRecovery.consequencePasscode') : t('pinRecovery.consequence')}
      </p>
      {error && (
        <p className="text-body text-danger">{error}</p>
      )}
      <div className="flex gap-2">
        <Button action="cancel" onClick={onCancel} className="flex-1 justify-center" />
        <Button
          action="confirm"
          variant="primary"
          onClick={() => void submit()}
          disabled={!input.trim()}
          className="flex-1 justify-center"
        >
          {kind === 'passcode' ? t('pinRecovery.clearPasscode') : t('pinRecovery.clearPin')}
        </Button>
      </div>
    </div>
  );
}

/** The link into the form. Same wording everywhere a PIN is demanded. */
export function ForgotPinLink({ onClick, kind = 'pin' }: { onClick: () => void; kind?: SecretKind }) {
  const { t } = useTranslation('security');
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-body text-accent hover:underline py-1 transition"
    >
      {kind === 'passcode' ? t('pinRecovery.forgotPasscode') : t('pinRecovery.forgotPin')}
    </button>
  );
}
