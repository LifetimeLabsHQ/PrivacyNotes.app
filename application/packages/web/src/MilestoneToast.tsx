import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { NewMilestone } from './milestones';
import { CloseButton, SETTINGS_EYEBROW } from './ui';

type Props = {
  milestone: NewMilestone;
  onDismiss: () => void;
};

export function MilestoneToast({ milestone, onDismiss }: Props) {
  const { t } = useTranslation('stats');
  // The parent passes a fresh callback on every render; reading it through a
  // ref keeps the timer at fifteen seconds from when this milestone appeared.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), 15000);
    return () => window.clearTimeout(timer);
  }, [milestone]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{ bottom: 'calc(var(--pn-safe-bottom, 0px) + 1rem)' }}
      className="fixed end-4 sm:end-6 z-40 max-w-xs rounded-lg border border-divider border-s-[3px] border-s-accent bg-surface-2 ps-4 pe-2 py-2.5 text-pn shadow-xl flex items-start gap-3 pn-toast-in"
    >
      <div className="min-w-0 flex-1">
        <div className={`${SETTINGS_EYEBROW} mb-1`}>
          {t('milestoneToast.unlocked')}
        </div>
        <div className="text-body font-medium">{milestone.label}</div>
      </div>
      <CloseButton
        onClick={onDismiss}
        label={t('common:updateToast.dismiss')}
        className="-me-1 -mt-1"
      />
    </div>
  );
}
