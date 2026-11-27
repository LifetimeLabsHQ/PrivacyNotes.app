import { useTranslation } from 'react-i18next';
import { AppIconPicker } from './AppIconPicker';
import { DEFAULT_APP_ICON, setAppIcon } from './appIcon';
import { ArrowsInSimple, Desktop, Files, SignIn, Tray } from './icons';
import { DefaultAppSettingsRow } from './markdownFolder/MarkdownDefaultApp';
import { markdownDefaultAppSupported } from './markdownFolder/defaultApp';
import { NinjaKeyRow } from './NinjaKeyRow';
import { setOpenAtLogin, setStartMinimized, useOpenAtLogin, useStartMinimized } from './openAtLogin';
import { ROW_TITLE, ResetDefaultsButton, SETTINGS_GROUP, SectionEyebrow } from './settingsUI';
import { DEFAULT_NINJA_KEY, setNinjaKey } from './ninjaShortcut';
import { Switch } from './Switch';
import { setTrayMode, useTrayMode } from './trayMode';

/**
 * Settings > System, in the desktop apps only: how PrivacyNotes runs on this
 * computer. Grouped into Startup & background, Open with PrivacyNotes, and
 * App icon. Every row is a device setting and never syncs; the system keeps
 * the sign-in entry and the file owner, so those two rows read the system and
 * store nothing.
 * Spec: docs/internal/plans/ninja-anywhere-694.md (section 7)
 */

/** Open at login, and the sub-row under it while it is on, Start minimized. */
function OpenAtLoginRow() {
  const { t } = useTranslation('settings');
  const on = useOpenAtLogin();
  const minimized = useStartMinimized();
  return (
    <>
      <div className="px-3.5 py-3">
        <Switch
          setting="system.openAtLogin"
          icon={<SignIn className="text-accent" />}
          labelClassName={ROW_TITLE}
          label={t('system.openAtLoginTitle')}
          description={t('system.openAtLoginDesc')}
          checked={on}
          onChange={setOpenAtLogin}
          className="gap-x-5"
        />
      </div>
      {on && (
        <div className="ps-7 pe-3.5 py-3 bg-track/40">
          <Switch
            setting="system.startMinimized"
            icon={<ArrowsInSimple className="text-accent" />}
            labelClassName={ROW_TITLE}
            label={t('system.startMinimizedTitle')}
            description={t('system.startMinimizedDesc')}
            checked={minimized}
            onChange={setStartMinimized}
            className="gap-x-5"
          />
        </div>
      )}
    </>
  );
}

export function SystemPane() {
  const { t } = useTranslation('settings');
  const trayMode = useTrayMode();
  // The rows the app owns. Open with stays: the system holds that choice.
  const reset = () => {
    setOpenAtLogin(false);
    setStartMinimized(false);
    setTrayMode(false);
    setNinjaKey(DEFAULT_NINJA_KEY);
    void setAppIcon(DEFAULT_APP_ICON);
  };
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="px-6 py-4 space-y-5 text-pn">
        <section className="space-y-2">
          <SectionEyebrow icon={Desktop}>{t('system.startupHeading')}</SectionEyebrow>
          <div className={`${SETTINGS_GROUP} bg-surface-2 overflow-hidden`}>
            <NinjaKeyRow />
            <OpenAtLoginRow />
            {/* Close and minimize to the tray. Spec: docs/internal/specs/calendar-pillar-spec.md (section 8) */}
            <div className="px-3.5 py-3">
              <Switch
                setting="appearance.tray"
                icon={<Tray className="text-accent" />}
                labelClassName={ROW_TITLE}
                label={t('appearance.trayTitle')}
                description={t('appearance.trayDesc')}
                checked={trayMode}
                onChange={setTrayMode}
                className="gap-x-5"
              />
            </div>
          </div>
        </section>

        {/* Which app the system opens a double-clicked file with.
            Spec: docs/internal/specs/default-app-settings.md */}
        {markdownDefaultAppSupported() && (
          <section data-setting="appearance.defaultApps" className="space-y-2">
            <SectionEyebrow icon={Files}>{t('appearance.defaultAppsTitle')}</SectionEyebrow>
            <div className={`${SETTINGS_GROUP} bg-surface-2 px-3.5`}>
              <DefaultAppSettingsRow kind="text" />
              <DefaultAppSettingsRow kind="markdown" />
            </div>
          </section>
        )}

        <AppIconPicker />

        <ResetDefaultsButton onReset={reset} className="pt-1" />
      </div>
    </div>
  );
}
