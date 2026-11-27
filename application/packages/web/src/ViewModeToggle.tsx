import { useTranslation } from 'react-i18next';
import { HoverLabel } from './HoverLabel';
import { exemptOpts } from './i18nExempt';
import { List, Sparkle, SquaresFour } from './icons';
import { SETTINGS_TRACK, settingsSegClass } from './settingsUI';
import type { ViewMode } from './viewMode';

/**
 * The layout switch: Auto (icon), List, and Grid in one shared segmented track.
 * Drawn in the list preferences menu of every pane; the choice is this
 * device's own (viewMode.ts).
 */
export function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (next: ViewMode) => void }) {
  const { t } = useTranslation('shell');
  const autoLabel = t('tagsRail.viewAuto', exemptOpts('shell:tagsRail.viewAuto'));
  return (
    <div role="group" aria-label={t('listPrefs.layout', { defaultValue: 'Layout' })} className={SETTINGS_TRACK}>
      <HoverLabel label={autoLabel} position="end" className="flex">
        <button
          type="button"
          onClick={() => onChange('auto')}
          aria-pressed={mode === 'auto'}
          aria-label={autoLabel}
          className={`${settingsSegClass(mode === 'auto', true)} !flex-none inline-flex items-center justify-center !px-2.5`}
        >
          <Sparkle aria-hidden="true" />
        </button>
      </HoverLabel>
      {(['list', 'grid'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={`${settingsSegClass(mode === m, true)} min-w-0 inline-flex items-center justify-center gap-1`}
        >
          {m === 'list' ? <List className="shrink-0" aria-hidden="true" /> : <SquaresFour className="shrink-0" aria-hidden="true" />}
          <span className="truncate">{m === 'list' ? t('settings:appearance.viewList') : t('settings:appearance.viewGrid')}</span>
        </button>
      ))}
    </div>
  );
}
