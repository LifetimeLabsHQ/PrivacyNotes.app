import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useEscapeToClose } from './useEscapeToClose';
import { loadLocalSettings, saveLocalSettings } from './userSettings';
import { CloseButton } from './ui';
import { PasswordGenerator } from './PasswordGeneratorPanel';

/** The generator in a centred dialog with a backdrop; Escape and the backdrop close it. */
export function PasswordGeneratorModal({ isPro, onOpenUpgrade, onGenerate, onClose }: {
  isPro: boolean | null;
  onOpenUpgrade: () => void;
  onGenerate?: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('auth');
  useEscapeToClose(onClose);
  return createPortal(
    <div className="fixed inset-0 bg-black/30 dark:bg-black/50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-surface-2 border border-divider rounded-lg max-w-sm w-full shadow-lg max-h-full overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-0">
          <h2 className="text-title font-semibold text-pn">{t('auth:loginForm.generatePassword')}</h2>
          <CloseButton onClick={onClose} />
        </div>
        <PasswordGenerator
          isPro={isPro}
          onOpenUpgrade={onOpenUpgrade}
          onGenerate={onGenerate}
          initial={loadLocalSettings().pwGen}
          onSave={(pwGen) => saveLocalSettings({ ...loadLocalSettings(), pwGen })}
        />
      </div>
    </div>,
    document.body,
  );
}
