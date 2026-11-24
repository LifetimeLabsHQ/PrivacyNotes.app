import { useTranslation } from 'react-i18next';
import { ArrowsClockwise } from './icons';
import { Callout, FeedbackButton } from './ui';

export type LocalOnlyFeature =
  | 'multiDevice'
  | 'connectedAccounts'
  | 'keyCustody'
  | 'cloudStorage'
  | 'dms'
  | 'twoFactorPasskeys'
  | 'phraseChange'
  | 'browserExtension'
  | 'commandLine'
  | 'noteHistory'
  | 'burnShare';

const FEATURE_KEYS: Record<LocalOnlyFeature, string> = {
  multiDevice: 'settings:localOnlyNotice.features.multiDevice',
  connectedAccounts: 'security:connectedAccounts.title',
  keyCustody: 'settings:localOnlyNotice.features.keyCustody',
  cloudStorage: 'settings:localOnlyNotice.features.cloudStorage',
  dms: 'settings:dms.tab',
  twoFactorPasskeys: 'settings:localOnlyNotice.features.twoFactorPasskeys',
  phraseChange: 'settings:localOnlyNotice.features.phraseChange',
  browserExtension: 'shell:apps.title',
  commandLine: 'shell:cli.title',
  noteHistory: 'billing:upgrade.features.history',
  burnShare: 'settings:localOnlyNotice.features.burnShare',
};

/**
 * Shared notice for server-backed surfaces while a vault is in local-only
 * mode (GitHub #862). Kept off the boot path (imported only by lazy settings
 * panes and modals). Uses the design system's Callout + FeedbackButton.
 * Spec: docs/internal/specs/local-only-862.md (section 8)
 */
export function LocalOnlyNotice({
  feature,
  onOpenSync,
  className,
}: {
  feature: LocalOnlyFeature;
  onOpenSync?: () => void;
  className?: string;
}) {
  const { t } = useTranslation(['settings', 'billing', 'security', 'shell']);
  return (
    <Callout
      tone="info"
      title={t('settings:syncPanel.rhythmPaused')}
      className={className}
      action={
        onOpenSync ? (
          <FeedbackButton icon={<ArrowsClockwise aria-hidden="true" />} onClick={onOpenSync}>
            {t('settings:localOnlyNotice.cta')}
          </FeedbackButton>
        ) : undefined
      }
    >
      {t('settings:localOnlyNotice.body', {
        feature: t(FEATURE_KEYS[feature]),
      })}
    </Callout>
  );
}
