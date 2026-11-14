import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField } from '../ui';

/**
 * The check of three words of a phrase the person saved: three distinct
 * random positions, in order, drawn once per phrase so closing and opening
 * the screen cannot reroll them. Each answer compares without case or
 * outer spaces. The custody release (CustodyPanel) and the phrase change
 * (PhraseChangeWizard) both use it.
 * Spec: docs/internal/plans/phrase-change.md (section 2.3, step 3)
 */
export function usePhraseCheck(phrase: string) {
  const words = useMemo(() => phrase.trim().split(/\s+/), [phrase]);
  const positions = useMemo(() => {
    const pool = words.map((_, i) => i + 1);
    const picked: number[] = [];
    while (picked.length < 3 && pool.length > 0) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]!);
    }
    return picked.sort((a, b) => a - b);
  }, [words]);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const correct = positions.every((pos, i) => (answers[i] ?? '').trim().toLowerCase() === words[pos - 1]!.toLowerCase());
  // Stable, because a caller may hold them in an effect's dependencies.
  const setAnswer = useCallback((index: number, value: string) => setAnswers((prev) => prev.map((a, i) => (i === index ? value : a))), []);
  const reset = useCallback(() => setAnswers(['', '', '']), []);
  return { positions, answers, correct, setAnswer, reset };
}

export type PhraseCheck = ReturnType<typeof usePhraseCheck>;

/** The three fields of a check, labeled with their word numbers. */
export function PhraseWordCheck({ check, disabled = false, onEdit }: {
  check: PhraseCheck;
  disabled?: boolean;
  /** Called on every edit, for a caller that clears an error. */
  onEdit?: () => void;
}) {
  const { t } = useTranslation('security');
  return (
    <div className="grid grid-cols-3 gap-2">
      {check.positions.map((pos, i) => (
        <TextField
          key={pos}
          size="sm"
          label={t('custody.wordLabel', { position: pos })}
          value={check.answers[i] ?? ''}
          onChange={(e) => { check.setAnswer(i, e.target.value); onEdit?.(); }}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono"
        />
      ))}
    </div>
  );
}
