import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChartPieSlice, Database, Image as ImageIcon } from '../icons';
import { SettingsTabStrip, settingsTabClass } from '../settingsUI';
import { usePaneTab } from '../settingsPaneTab';

type Section = 'storage' | 'usage' | 'images';

function resolveSection(initialTab?: string): Section {
  if (initialTab === 'images') return 'images';
  if (initialTab === 'usage') return 'usage';
  return 'storage';
}

/**
 * Settings > Storage: plan and add-ons on Storage, the unified local vault
 * breakdown on Usage (same screen for Free, Pro, local-only and own-storage),
 * and image compression settings on Images.
 * Spec: docs/internal/specs/image-quality-handoff.md (section 9)
 */
export function StoragePane({
  initialTab,
  storage,
  usage,
  images,
}: {
  initialTab?: string;
  storage: (actions: { openUsage: () => void; openImages: () => void }) => ReactNode;
  usage: ReactNode;
  images: ReactNode;
}) {
  const { t } = useTranslation(['notes', 'settings']);
  const [section, setSection] = usePaneTab<Section>('storage', resolveSection(initialTab));
  useEffect(() => {
    setSection(resolveSection(initialTab));
  }, [initialTab, setSection]);
  // The Images and Usage tabs carry search ids so Settings search lands on them.
  const tabs = [
    { id: 'storage', setting: undefined, label: t('notes:settings.storageLabel'), Icon: Database },
    { id: 'usage', setting: 'storage.usage', label: t('settings:storage.usage.tab'), Icon: ChartPieSlice },
    { id: 'images', setting: 'storage.images', label: t('notes:settings.imagesLabel'), Icon: ImageIcon },
  ] as const;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SettingsTabStrip className="shrink-0 px-4 sm:px-6">
        {tabs.map(({ id, setting, label, Icon }) => (
          <button
            key={id}
            type="button"
            data-setting={setting}
            aria-pressed={section === id}
            onClick={() => setSection(id)}
            className={settingsTabClass(section === id)}
          >
            <Icon className="shrink-0 text-accent" aria-hidden="true" />
            <span className="min-w-0">{label}</span>
          </button>
        ))}
      </SettingsTabStrip>
      {section === 'storage'
        ? storage({ openUsage: () => setSection('usage'), openImages: () => setSection('images') })
        : section === 'usage'
          ? usage
          : images}
    </div>
  );
}
