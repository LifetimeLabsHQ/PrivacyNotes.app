/**
 * The header of a view that opens over the main window (the generator, Add
 * login): the back arrow, then the title. Escape goes back too, from App.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from '@web/icons';
import { IconButton } from '@web/ui/Button';

export function SheetHeader({ title, onBack, end }: { title: ReactNode; onBack: () => void; end?: ReactNode }) {
  const { t } = useTranslation('common');
  return (
    <header className="sticky top-0 z-[60] flex items-center gap-1 px-2 py-2 border-b border-divider bg-surface-2">
      <IconButton label={t('actions.back')} position="below-start" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
      </IconButton>
      <span className="text-body font-semibold text-pn truncate">{title}</span>
      {end && <span className="ms-auto">{end}</span>}
    </header>
  );
}
