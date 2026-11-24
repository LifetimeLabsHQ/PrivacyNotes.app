import { useTranslation } from 'react-i18next';
import { formatBytes } from './formatBytes';
import { HelpChip } from './HelpChip';
import { CONTACT_PHOTO_PX, EXAMPLE_PHOTO_BYTES, SPACE_SAVER_LEVELS, SPACE_SAVER_PRESETS } from './imageProcessing';
import { intlLocale } from './languages';
import { ROW_TITLE, ResetDefaultsButton, RowTitle, SETTINGS_HELP, SETTINGS_ROW, SETTINGS_TRACK, settingsSegClass } from './settingsUI';
import { ArrowsIn, Gauge, MapPinLine, UserCircle } from './icons';
import { Switch } from './Switch';
import { Badge, ProgressBar } from './ui';
import type { ImageSwitch, SpaceSaverLevel } from './userSettings';
import { defaultSettings } from './userSettingsShape';

type Field = 'imageSpaceSaver' | 'imageStripMetadata' | 'imageContactCeiling';

type Props = {
  spaceSaver: ImageSwitch;
  spaceSaverLevel: SpaceSaverLevel;
  stripMetadata: ImageSwitch;
  contactCeiling: ImageSwitch;
  storageLimitBytes: number;
  onChange: (field: Field, value: ImageSwitch) => void;
  onSpaceSaverLevelChange: (level: SpaceSaverLevel) => void;
};

/** Format a byte count without trailing `.0` zeros so preview labels stay tight. */
function cleanBytes(bytes: number): string {
  return formatBytes(bytes)
    .replace(/\.0+(?=\s)/, '')
    .replace(/(\.\d)0(?=\s)/, '$1');
}

/** Round an estimated photo count to clean steps (~19, ~190, ~1,900). */
function roundPhotoEstimate(n: number): number {
  if (n >= 1000) return Math.round(n / 100) * 100;
  if (n >= 100) return Math.round(n / 10) * 10;
  return Math.max(1, Math.round(n));
}

/**
 * Images settings pane: the two switches every image door obeys, the
 * compression preset that unfolds while Space saver is on, plus the ceiling
 * a contact photo keeps on top of them.
 *
 * All settings are synced, so a choice made on one device holds on every
 * device. The rows say what the code does, numbers included: the ceilings
 * and the JPEG quality are read from imageProcessing.ts so the copy cannot
 * drift from the constant it describes. The switches apply to new images
 * only, which the footer states, because a user who turns the space saver on
 * to free space frees nothing.
 *
 * Spec: docs/internal/specs/image-quality-handoff.md (section 9)
 */
export function ImagesSheet({
  spaceSaver,
  spaceSaverLevel,
  stripMetadata,
  contactCeiling,
  storageLimitBytes,
  onChange,
  onSpaceSaverLevelChange,
}: Props) {
  const { t } = useTranslation('settings');
  const spaceSaverOn = spaceSaver === 'on';
  const preset = SPACE_SAVER_PRESETS[spaceSaverLevel];
  const qualityPct = Math.round(preset.quality * 100);

  const savedBytes = spaceSaverOn ? preset.exampleBytes : EXAMPLE_PHOTO_BYTES;
  const barRatio = Math.min(1, Math.max(0.04, savedBytes / EXAMPLE_PHOTO_BYTES));
  const photoCount = roundPhotoEstimate(storageLimitBytes / savedBytes);
  const formattedCount = new Intl.NumberFormat(intlLocale()).format(photoCount);
  const quotaLabel = cleanBytes(storageLimitBytes);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto text-pn">
      <div className="px-6 pt-2 pb-4">
        {/* Boolean rows: the whole row is the label, the switch sits beside
            it at every width. Space saver and its Compression sub-row share
            one wrapper so the divided list draws no rule between them
            (ui-patterns.md section 185).
            Spec: docs/internal/design/ui-patterns.md section 36 */}
        <div className="divide-y divide-divider">
          <div>
            <Switch
              setting="images.spaceSaver"
              icon={<ArrowsIn className="text-accent" />}
              labelClassName={ROW_TITLE}
              label={t('images.spaceSaverTitle')}
              description={t('images.spaceSaverDesc')}
              checked={spaceSaverOn}
              onChange={(on) => onChange('imageSpaceSaver', on ? 'on' : 'off')}
              className="gap-x-5 py-3"
            />
            {spaceSaverOn && (
              <div data-setting="images.compression" className={`${SETTINGS_ROW} lg:flex-nowrap lg:items-start pt-0`}>
                <div className="min-w-0 lg:flex-1">
                  <RowTitle icon={Gauge}>{t('images.compressionTitle')}</RowTitle>
                  <p className={`${SETTINGS_HELP} mt-0.5`}>
                    {t('images.levelSpec', { px: preset.fitBox, quality: qualityPct })}
                    <br />
                    {t(`images.levelDesc.${spaceSaverLevel}`)}
                  </p>
                </div>
                <div role="group" aria-label={t('images.compressionTitle')} className={`${SETTINGS_TRACK} shrink-0`}>
                  {SPACE_SAVER_LEVELS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      onClick={() => onSpaceSaverLevelChange(level)}
                      aria-pressed={spaceSaverLevel === level}
                      className={settingsSegClass(spaceSaverLevel === level)}
                    >
                      {t(`images.level.${level}`)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div
              aria-live="polite"
              className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-divider px-3 py-2.5 text-small text-pn-soft"
            >
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <Badge>{t('images.previewSample', { size: cleanBytes(EXAMPLE_PHOTO_BYTES) })}</Badge>
                <span>
                  {t('images.previewSavedAs')}{' '}
                  <span className="font-mono font-semibold text-pn tabular-nums">
                    {spaceSaverOn
                      ? t('images.previewCompressed', {
                        size: cleanBytes(preset.exampleBytes),
                        px: preset.fitBox,
                        quality: qualityPct,
                      })
                      : t('images.previewOriginal', { size: cleanBytes(EXAMPLE_PHOTO_BYTES) })}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2.5 shrink-0">
                <div className="w-24">
                  <ProgressBar value={barRatio} label={t('images.previewBarLabel')} />
                </div>
                <span className="tabular-nums whitespace-nowrap">
                  {t('images.previewFits', { count: formattedCount, storage: quotaLabel })}
                </span>
              </div>
            </div>
          </div>

          <Switch
            setting="images.contactPhotos"
            icon={<UserCircle className="text-accent" />}
            labelClassName={ROW_TITLE}
            label={t('images.contactTitle')}
            description={t('images.contactDesc', { px: CONTACT_PHOTO_PX })}
            checked={contactCeiling === 'on'}
            onChange={(on) => onChange('imageContactCeiling', on ? 'on' : 'off')}
            className="gap-x-5 py-3"
          />

          <Switch
            setting="images.removeLocation"
            icon={<MapPinLine className="text-accent" />}
            labelClassName={ROW_TITLE}
            label={t('images.removeLocationTitle')}
            description={t('images.removeLocationDesc')}
            checked={stripMetadata === 'on'}
            onChange={(on) => onChange('imageStripMetadata', on ? 'on' : 'off')}
            className="gap-x-5 py-3"
          />
        </div>
        <p className={`${SETTINGS_HELP} mt-3`}>{t('images.applyNote')}</p>
        <ResetDefaultsButton
          onReset={() => {
            const d = defaultSettings();
            onChange('imageSpaceSaver', d.imageSpaceSaver);
            onSpaceSaverLevelChange(d.imageSpaceSaverLevel);
            onChange('imageStripMetadata', d.imageStripMetadata);
            onChange('imageContactCeiling', d.imageContactCeiling);
          }}
        />
        <HelpChip surface="images" className="mt-4" />
      </div>
    </div>
  );
}
