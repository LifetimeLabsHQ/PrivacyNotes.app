import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { loadLocalSettings, saveLocalSettings } from './userSettings';
import { Modal } from './ui';
import { PasswordGenerator } from './PasswordGeneratorPanel';

/** The generator in a centred dialog with a backdrop; Escape and the backdrop close it. */
export function PasswordGeneratorModal({ isPro, onOpenUpgrade, onGenerate, onClose }: {
  isPro: boolean | null;
  onOpenUpgrade: () => void;
  onGenerate?: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('auth');
  return createPortal(
    <Modal
      onClose={onClose}
      title={t('auth:loginForm.generatePassword')}
      header="bar"
      className="max-w-sm max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden"
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-1">
        <PasswordGenerator
          isPro={isPro}
          onOpenUpgrade={onOpenUpgrade}
          onGenerate={onGenerate}
          initial={loadLocalSettings().pwGen}
          onSave={(pwGen) => saveLocalSettings({ ...loadLocalSettings(), pwGen })}
        />
      </div>
    </Modal>,
    document.body,
  );
}
