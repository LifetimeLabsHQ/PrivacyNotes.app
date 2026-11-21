import { useTranslation } from 'react-i18next';
import { ArrowsInSimple, Files, SignIn, Tray } from './icons';
import { DefaultAppSettingsRow } from './markdownFolder/MarkdownDefaultApp';
import { markdownDefaultAppSupported } from './markdownFolder/defaultApp';
import { NinjaKeyRow } from './NinjaKeyRow';
import { setOpenAtLogin, setStartMinimized, useOpenAtLogin, useStartMinimized } from './openAtLogin';
import { ROW_TITLE, ResetDefaultsButton, SectionEyebrow } from './settingsUI';
import { DEFAULT_NINJA_KEY, setNinjaKey } from './ninjaShortcut';
import { Switch } from './Switch';
import { setTrayMode, useTrayMode } from './trayMode';

/**
 * Settings > System, in the desktop apps only: how PrivacyNotes runs on this
 * computer. Open at login, Keep running in the tray, the Ninja hotkey and which
 * app opens a double-clicked file. Every row is a device setting and
 * never syncs; the system keeps the sign-in entry and the file owner, so
 * those two rows read the system and store nothing.
 * Spec: docs/internal/plans/ninja-anywhere-694.md (section 7)
 */

/** Open at login, and the row under it while it is on, Start minimized. */
function OpenAtLoginRow() {
  const { t } = useTranslation('settings');
  const on = useOpenAtLogin();
  const minimized = useStartMinimized();
  return (
    <>
      <Switch
        setting="system.openAtLogin"
        icon={<SignIn className="text-accent" />}
        labelClassName={ROW_TITLE}
        label={t('system.openAtLoginTitle')}
        description={t('system.openAtLoginDesc')}
        checked={on}
        onChange={setOpenAtLogin}
        className="gap-x-5 py-3"
      />
      {on && (
        <Switch
          setting="system.startMinimized"
          icon={<ArrowsInSimple className="text-accent" />}
          labelClassName={ROW_TITLE}
          label={t('system.startMinimizedTitle')}
          description={t('system.startMinimizedDesc')}
          checked={minimized}
          onChange={setStartMinimized}
          className="gap-x-5 py-3"
        />
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
  };
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="px-6 divide-y divide-divider text-pn">
        <OpenAtLoginRow />
        {/* Close and minimize to the tray. Spec: docs/internal/specs/calendar-pillar-spec.md (section 8) */}
        <Switch
          setting="appearance.tray"
          icon={<Tray className="text-accent" />}
          labelClassName={ROW_TITLE}
          label={t('appearance.trayTitle')}
          description={t('appearance.trayDesc')}
          checked={trayMode}
          onChange={setTrayMode}
          className="gap-x-5 py-3"
        />
        <NinjaKeyRow />
        {/* Which app the system opens a double-clicked file with.
            Spec: docs/internal/plans/default-app-settings.md */}
        {markdownDefaultAppSupported() && (
          <div data-setting="appearance.defaultApps" className="py-4">
            <SectionEyebrow icon={Files}>{t('appearance.defaultAppsTitle')}</SectionEyebrow>
            <DefaultAppSettingsRow kind="text" />
            <DefaultAppSettingsRow kind="markdown" />
          </div>
        )}
      </div>
      <div className="px-6 pb-4">
        <ResetDefaultsButton onReset={reset} />
      </div>
    </div>
  );
}
