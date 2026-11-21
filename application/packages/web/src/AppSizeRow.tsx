import { useTranslation } from 'react-i18next';
import { APP_ZOOM_LEVELS, useAppZoom } from './appZoom';
import { MagnifyingGlassPlus } from './icons';
import { intlLocale } from './languages';
import { DeviceOnlyTip, RowTitle, SETTINGS_HELP, SETTINGS_TRACK, settingsSegClass } from './settingsUI';

/**
 * App size: the whole app, which the Editor's text size is not. Settings >
 * Design draws it in the desktop and phone apps (#834), each with that
 * build's ladder. The level itself is the label, formatted per
 * locale, at one fixed width per option in a wide pane.
 * Spec: docs/internal/design-decisions.md (app zoom)
 */
export function AppSizeRow() {
  const { t } = useTranslation('settings');
  const { appZoom, setAppZoom } = useAppZoom();
  return (
    <div data-setting="appearance.appZoom" className="flex flex-col gap-2 py-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between lg:gap-x-5 lg:gap-y-2">
      <div className="min-w-0">
        <RowTitle icon={MagnifyingGlassPlus} hint={<DeviceOnlyTip />}>{t('appearance.appZoomTitle')}</RowTitle>
        <p className={`${SETTINGS_HELP} mt-0.5`}>{t('appearance.appZoomDesc')}</p>
      </div>
      {/* Three columns below lg: at the top step a phone lays the app out in
          about 268 points, where every label in one row cuts off the last ones. */}
      <div className={`${SETTINGS_TRACK} max-lg:grid max-lg:grid-cols-3`}>
        {APP_ZOOM_LEVELS.map((level) => (
          <button key={level} type="button" onClick={() => setAppZoom(level)} aria-pressed={appZoom === level} className={`${settingsSegClass(appZoom === level)} lg:w-12 lg:px-0`}>
            {level.toLocaleString(intlLocale(), { style: 'percent' })}
          </button>
        ))}
      </div>
    </div>
  );
}
