import { useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { BookOpenText, Sparkle } from './icons';
import { formatBytes } from './formatBytes';
import { activeLocale } from './i18n';
import { helpPath } from './localeRoutes';
import { siteHref } from './siteLinks';
import { proUnlocked } from './demo';
import { MEANING_BYTES, useMeaningState } from './onDeviceAi';
import { cancelMeaningDownload, checkKeptModel, removeMeaning, turnMeaningOff, turnMeaningOn } from './onDeviceAiModel';
import { ROW_TITLE, SETTINGS_HELP } from './settingsUI';
import { Switch } from './Switch';
import { Button, ProMark, ProgressBar, StatusLine, useProGate } from './ui';

/**
 * Settings > Editor > Behavior > Smart connections: the one home of the
 * meaning model (onDeviceAi.ts), right under Suggested connections with no rule
 * between them, because it only adds to those suggestions. Per device, since the file is stored on each
 * device. Without the model: Download and turn on (nothing downloads before).
 * With it: a switch (off keeps the file, so on again downloads nothing) and
 * Remove, which deletes the file. Download and the switch also turn
 * Suggested connections on when it is off. Behind the release switch
 * (`onDeviceAiShown`).
 * Spec: docs/internal/plans/related-notes.md (part 2, "Where it lives")
 */
/** The model's public page, linked from the row so anyone can read what it is. Spec: docs/internal/plans/related-notes.md (section 4a) */
const MODEL_PAGE = 'https://huggingface.co/hotchpotch/bekko-static-embedding-v1';

/** A link inside a help line. */
const LINK = 'text-accent hover:underline';

/** The help answer that explains the model (FAQ entry `no-ai`). */
const guideHref = () => siteHref(`${helpPath(activeLocale())}/no-ai`);

/**
 * A help line whose model name links to the model's page, outside the app.
 * The size never breaks across lines.
 */
function ModelLine({ i18nKey, size }: { i18nKey: 'onDeviceAi.desc' | 'onDeviceAi.on'; size: string }) {
  return (
    <Trans
      ns="settings"
      i18nKey={i18nKey}
      values={{ size: size.replace(' ', '\u00a0') }}
      components={{
        model: <a href={MODEL_PAGE} target="_blank" rel="noopener noreferrer" className={`${LINK} whitespace-nowrap`} />,
      }}
    />
  );
}

/**
 * "How it works" with the guide mark, drawn as HelpChip draws it (the book in a
 * 20px box, the text's own line height), so it reads as a help link.
 */
function GuideLink() {
  const { t } = useTranslation('settings');
  return (
    <a href={guideHref()} target="_blank" rel="noopener noreferrer" className={`inline-flex items-start gap-2 text-help ${LINK}`}>
      <span className="flex h-5 shrink-0 items-center">
        <BookOpenText aria-hidden="true" />
      </span>
      <span>{t('onDeviceAi.howItWorks')}</span>
    </a>
  );
}

/**
 * The Editor rows' layout (AppearanceSheet.tsx, `rowLayout`): stacked below lg,
 * with the button full width under the text, one line from lg up.
 */
const SETTINGS_ROW_LAYOUT = 'flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between lg:gap-x-5 lg:gap-y-2';

export function SmartConnectionsRow({ isPro, onUpgrade, parentOn, onParentOn }: {
  isPro: boolean | undefined;
  onUpgrade: () => void;
  /** Whether Suggested connections is on; this row only adds to it. */
  parentOn: boolean;
  /** Turns Suggested connections on: Download and the switch do it too, so there is no dead state. */
  onParentOn: () => void;
}) {
  const { t } = useTranslation('settings');
  const state = useMeaningState();
  const unlocked = proUnlocked(isPro);
  const gate = useProGate(unlocked, onUpgrade);
  const size = formatBytes(MEANING_BYTES);
  const { status } = state;

  // Whether this device still holds the model from an earlier download.
  useEffect(() => {
    if (status === 'off') void checkKeptModel();
    // Once, when the row opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = (
    <>
      {t('onDeviceAi.title')}
      {/* The badge keys off the plan, not the unlock, so the demo keeps it. */}
      {!isPro && <ProMark />}
    </>
  );
  const icon = <Sparkle className="text-accent" />;
  // With Suggested connections off, the model adds nothing: the row reads as off.
  const shown = status !== 'kept' && parentOn;
  const turnOn = gate(() => {
    if (!parentOn) onParentOn();
    if (status !== 'on' && status !== 'loading') void turnMeaningOn();
  });

  if (status === 'on' || status === 'kept' || status === 'loading') {
    return (
      <div data-setting="appearance.smartConnections" className="pb-3 flex flex-col gap-2 text-pretty">
        <Switch
          icon={icon}
          labelClassName={ROW_TITLE}
          label={title}
          description={shown ? <ModelLine i18nKey="onDeviceAi.on" size={size} /> : t('onDeviceAi.kept')}
          checked={shown}
          disabled={status === 'loading'}
          onChange={(on) => (on ? turnOn() : turnMeaningOff())}
          className="gap-x-5"
        />
        {status === 'loading' ? (
          <StatusLine busy>{t('onDeviceAi.loading')}</StatusLine>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {/* Neutral, not red: the model is public data that downloads again in seconds. */}
            <Button action="remove" variant="secondary" onClick={() => void removeMeaning()}>{t('onDeviceAi.remove', { size })}</Button>
            <GuideLink />
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-setting="appearance.smartConnections" className={`${SETTINGS_ROW_LAYOUT} pb-3 text-pretty`}>
      <div className="min-w-0 flex-1 flex flex-col">
        <span className={ROW_TITLE}>
          <span aria-hidden="true" className="flex shrink-0">{icon}</span>
          {title}
        </span>
        {status === 'downloading' ? (
          <div className="mt-1.5 flex flex-col gap-1">
            <ProgressBar value={state.loaded / state.total} label={t('onDeviceAi.downloadingLabel')} />
            <StatusLine>{t('stats:milestones.ofTarget', { current: formatBytes(state.loaded), target: formatBytes(state.total) })}</StatusLine>
          </div>
        ) : (
          <span className={`${SETTINGS_HELP} mt-0.5`}>
            <ModelLine i18nKey="onDeviceAi.desc" size={size} />
          </span>
        )}
        {status !== 'downloading' && (
          <div className="mt-1">
            <GuideLink />
          </div>
        )}
        {(status === 'unavailable' || status === 'error') && (
          <div className="mt-1">
            <StatusLine tone="danger">{t(status === 'error' ? 'onDeviceAi.failed' : 'onDeviceAi.unavailable')}</StatusLine>
          </div>
        )}
      </div>
      {status === 'downloading' ? (
        <Button action="cancel" onClick={() => void cancelMeaningDownload()} />
      ) : (
        // A free account gets the Pro door every other Pro button uses:
        // secondary, so the rocket keeps its Pro color.
        <Button
          action="download"
          variant={unlocked ? 'primary' : 'secondary'}
          pro={!unlocked}
          onClick={turnOn}
        >
          {t('onDeviceAi.downloadSize', { size: size.replace(' ', '\u00a0') })}
        </Button>
      )}
    </div>
  );
}
