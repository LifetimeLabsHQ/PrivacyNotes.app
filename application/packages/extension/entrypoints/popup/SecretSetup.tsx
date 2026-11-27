/**
 * Compact PIN vs Passcode picker and live passcode requirements, mirroring
 * Settings > Security > PIN in miniature for the 480 px extension popup
 * (ChangeSecretView and ConnectView).
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, step 2)
 */
import { useTranslation } from 'react-i18next';
import { Check } from '@web/icons';
import { Badge } from '@web/ui/feedback';
import { PASSCODE_MAX_CHARS, PASSCODE_MIN_CHARS, passcodeRules, type SecretKind } from '@web/secretKind';

export function SecretKindCards({ value, onChange, disabled = false }: {
  value: SecretKind;
  onChange: (kind: SecretKind) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('extension');
  const cards: { kind: SecretKind; title: string; hint: string; badge?: string }[] = [
    { kind: 'pin', title: t('security:pinTab.kindPin'), hint: t('protect.pinHint') },
    { kind: 'passcode', title: t('security:pinTab.kindPasscode'), hint: t('protect.passcodeHint'), badge: t('security:pinTab.badgeStronger') },
  ];
  return (
    <div role="radiogroup" aria-label={t('security:pinTab.kindGroup')} className="grid grid-cols-2 gap-2">
      {cards.map((c) => {
        const selected = value === c.kind;
        return (
          <button
            key={c.kind}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(c.kind)}
            className={`flex flex-col justify-start text-start rounded-lg border px-2.5 py-2 transition disabled:opacity-40 ${
              selected
                ? 'border-accent bg-accent/8'
                : 'border-divider bg-surface-1 hover:border-pn-muted/40'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                  selected ? 'border-accent' : 'border-pn-muted'
                }`}
              >
                {selected && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
              <span className="text-small font-semibold text-pn truncate">{c.title}</span>
              {c.badge && <Badge tone="success" className="ms-auto shrink-0">{c.badge}</Badge>}
            </div>
            <p className="mt-1 text-meta text-pn-muted leading-snug">{c.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

/** Live checks under a new passcode field: matches Settings > Security > PIN. */
export function PasscodeRequirements({ value }: { value: string }) {
  const { t } = useTranslation('security');
  const rules = passcodeRules(value);
  const typed = value.length > 0;
  const rows: { ok: boolean; label: string; show?: boolean }[] = [
    { ok: rules.longEnough, label: t('pinTab.ruleLength', { min: PASSCODE_MIN_CHARS }) },
    { ok: typed && rules.notOnlyDigits, label: t('pinTab.ruleNotDigits') },
    { ok: rules.notTooLong, label: t('pinTab.ruleMax', { max: PASSCODE_MAX_CHARS }), show: !rules.notTooLong },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 pt-0.5 text-meta">
      {rows.filter((r) => r.show !== false).map((r) => (
        <span key={r.label} className={`inline-flex items-center gap-1 ${r.ok ? 'text-success' : 'text-pn-muted'}`}>
          <Check aria-hidden="true" className="shrink-0" />
          <span>{r.label}</span>
        </span>
      ))}
    </div>
  );
}
