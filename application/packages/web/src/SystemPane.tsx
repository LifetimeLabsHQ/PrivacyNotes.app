import { useTranslation } from 'react-i18next';
import { APP_ZOOM_LEVELS, DEFAULT_APP_ZOOM, useAppZoom } from './appZoom';
import { ArrowsInSimple, Files, MagnifyingGlassPlus, SignIn, Tray } from './icons';
import { intlLocale } from './languages';
import { DefaultAppSettingsRow } from './markdownFolder/MarkdownDefaultApp';
import { markdownDefaultAppSupported } from './markdownFolder/defaultApp';
import { NinjaKeyRow } from './NinjaKeyRow';
import { setOpenAtLogin, setStartMinimized, useOpenAtLogin, useStartMinimized } from './openAtLogin';
import { ROW_TITLE, ResetDefaultsButton, RowTitle, SETTINGS_HELP, SETTINGS_TRACK, SectionEyebrow, settingsSegClass } from './settingsUI';
import { DEFAULT_NINJA_KEY, setNinjaKey } from './ninjaShortcut';
import { Switch } from './Switch';
import { setTrayMode, useTrayMode } from './trayMode';

/**
 * Settings > System, in the desktop apps only: how PrivacyNotes runs on this
 * computer. Open at login, Keep running in the tray, the Ninja hotkey, the
 * size of the whole window and which app opens a double-clicked file. Every row is a device setting and
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

/**
 * App size: the whole window, which the Editor's text size is not. A browser
 * has this on the same keys already. The level itself is the label, formatted
 * per locale, at one fixed width per option so the row never wraps.
 * Spec: docs/internal/design-decisions.md (app zoom)
 */
function AppSizeRow() {
  const { t } = useTranslation('settings');
  const { appZoom, setAppZoom } = useAppZoom();
  return (
    <div data-setting="appearance.appZoom" className="flex flex-col gap-2 py-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between lg:gap-x-5 lg:gap-y-2">
      <div className="min-w-0">
        <RowTitle icon={MagnifyingGlassPlus}>{t('appearance.appZoomTitle')}</RowTitle>
        <p className={`${SETTINGS_HELP} mt-0.5`}>{t('appearance.appZoomDesc')}</p>
      </div>
      <div className={SETTINGS_TRACK}>
        {APP_ZOOM_LEVELS.map((level) => (
          <button key={level} type="button" onClick={() => setAppZoom(level)} aria-pressed={appZoom === level} className={`${settingsSegClass(appZoom === level)} lg:w-12 lg:px-0`}>
            {level.toLocaleString(intlLocale(), { style: 'percent' })}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SystemPane() {
  const { t } = useTranslation('settings');
  const trayMode = useTrayMode();
  const { setAppZoom } = useAppZoom();
  // The rows the app owns. Open with stays: the system holds that choice.
  const reset = () => {
    setOpenAtLogin(false);
    setStartMinimized(false);
    setTrayMode(false);
    setNinjaKey(DEFAULT_NINJA_KEY);
    setAppZoom(DEFAULT_APP_ZOOM);
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
        <AppSizeRow />
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
