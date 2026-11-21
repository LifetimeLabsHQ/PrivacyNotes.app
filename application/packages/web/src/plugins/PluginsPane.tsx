import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { BookOpenText, Cpu, DownloadSimple, HardDrives, MagicWand, Scan, Sparkle, Translate, Waveform } from '../icons';
import { formatBytes } from '../formatBytes';
import { activeLocale } from '../i18n';
import { helpPath } from '../localeRoutes';
import { siteHref } from '../siteLinks';
import { proUnlocked } from '../demo';
import { detectPlatform } from '../devices';
import { MEANING_BYTES, useMeaningIndexReady, useMeaningState } from '../onDeviceAi';
import type { LocalNote } from '../db';
import type { FolderDef } from '../folders';
import { DuplicatesSheet } from './DuplicatesSheet';
import { cancelMeaningDownload, checkKeptModel, removeMeaning, turnMeaningOff, turnMeaningOn } from '../onDeviceAiModel';
import { ConfirmModal } from '../ConfirmModal';
import { ROW_TITLE, SectionEyebrow, SETTINGS_HELP, SettingsCardIcon } from '../settingsUI';
import { Switch } from '../Switch';
import { Button, DeleteButton, ProMark, Select, StatusLine, useProGate } from '../ui';
import { PluginStateLine as StateLine } from './PluginStateLine';
import { pluginBusy, stopJobsForPlugin } from './jobs';
import { cleanupShown } from './pluginDoors';
import { pluginFlagOn, setPluginFlag, setSuggestionsOn, usePluginState, usePluginStates, useSuggestionsOn, type PluginId, type PluginKey, type PluginState } from './pluginState';
import { revealPluginFolder } from './pluginStore';
import { cancelPluginDownload, checkKeptPlugin, downloadPlugin, engineStorage, pluginStorage, removeAllPlugins, removePlugin, setPluginOn } from './pluginManager';
import { checkAppleSpeech, modelLanguageName, pluginEntry, RUNTIME_FILES, TRANSLATE_MODEL, translateFiles, voiceOffered } from './registry';
import type { UpgradeTrigger } from '../UpgradeModal';

/**
 * Settings > Plugins: the intro, the storage strip, then the plugins on this
 * device and the ones to add, each as a card (ui-patterns, "Plugin card").
 * Every plugin is Pro; a free account sees the Pro mark and the upgrade
 * button on each card, and kept files stay (D23).
 * Spec: docs/internal/plans/plugins.md (section 5)
 */

/** The public pages of the engines a card names. Brand names, the same in every language. */
const ENGINE = {
  bekko: { name: 'bekko-static', href: 'https://huggingface.co/hotchpotch/bekko-static-embedding-v1' },
  paddle: { name: 'PaddleOCR', href: 'https://github.com/PaddlePaddle/PaddleOCR' },
  vision: { name: 'Apple Vision', href: 'https://developer.apple.com/documentation/vision' },
  firefox: { name: 'Firefox Translations', href: 'https://github.com/mozilla/translations' },
  whisper: { name: 'Whisper small', href: 'https://github.com/openai/whisper' },
  speech: { name: 'SpeechAnalyzer', href: 'https://developer.apple.com/documentation/speech/speechanalyzer' },
  dpdfnet: { name: 'DPDFNet', href: 'https://github.com/ceva-ip/DPDFNet' },
} as const;

const LINK = 'text-accent hover:underline';

function EngineLink({ engine }: { engine: keyof typeof ENGINE }) {
  const e = ENGINE[engine];
  return (
    <a href={e.href} target="_blank" rel="noopener noreferrer" className={`${LINK} whitespace-nowrap`}>
      {e.name}
    </a>
  );
}

/** "How it works": the FAQ answer `no-ai`, drawn as HelpChip draws a guide link. */
function GuideLink() {
  const { t } = useTranslation('settings');
  return (
    <a href={siteHref(`${helpPath(activeLocale())}/no-ai`)} target="_blank" rel="noopener noreferrer" className={`inline-flex items-start gap-2 ${LINK}`}>
      <span className="flex h-5 shrink-0 items-center">
        <BookOpenText aria-hidden="true" />
      </span>
      <span>{t('onDeviceAi.howItWorks')}</span>
    </a>
  );
}

/** A size that never breaks across lines. */
const sizeText = (bytes: number) => formatBytes(bytes).replace(' ', ' ');

/** Not on this device: the card belongs to "Add to this device". */
const offDevice = (s: PluginState['status']) => s === 'off' || s === 'unavailable' || s === 'error';

type CardProps = {
  setting: string;
  icon: ReactNode;
  title: string;
  desc: ReactNode;
  /** The line under the description once the plugin is on this device: size and engine. */
  meta: ReactNode;
  bytes: number;
  state: PluginState;
  isPro: boolean | undefined;
  /** Apple's engine: nothing to download, the switch turns it on at once. */
  builtIn?: boolean;
  /** False for the one free plugin (Voice to text, D25): no Pro mark, no Pro door. */
  pro?: boolean;
  /** Whether the switch shows on (Smart connections also needs Suggested connections). */
  shownOn?: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onToggle: (on: boolean) => void;
  onRemove: () => void;
  onUpgrade: () => void;
  children?: ReactNode;
};

/**
 * One plugin. Not on the device: the description and Download (the Pro door
 * on a free account), or the progress with Cancel. On it: a switch (off keeps
 * the files) and Remove. A free account with the files kept sees the Pro door,
 * not the switch (D23).
 */
function PluginCard({ setting, icon, title, desc, meta, bytes, state, isPro, builtIn = false, pro = true, shownOn, onDownload, onCancel, onToggle, onRemove, onUpgrade, children }: CardProps) {
  const { t } = useTranslation('settings');
  const unlocked = !pro || proUnlocked(isPro);
  const gate = useProGate(unlocked, onUpgrade);
  const status = !unlocked && (state.status === 'kept' || state.status === 'on') ? 'needsPro' : state.status;
  const heading = (
    <>
      {title}
      {/* The badge keys off the plan, not the unlock, so the demo keeps it. */}
      {pro && !isPro && <ProMark />}
    </>
  );
  const glyph = <SettingsCardIcon glyph={icon} />;

  if (unlocked && (builtIn || status === 'on' || status === 'kept' || status === 'loading')) {
    const on = shownOn ?? status === 'on';
    return (
      <div data-setting={setting} className="rounded-lg border border-divider p-3 flex flex-col gap-2 text-pretty">
        <div className="flex items-start gap-3">
          {glyph}
          <div className="min-w-0 flex-1">
            <Switch
              labelClassName={ROW_TITLE}
              label={heading}
              description={
                <>
                  <span className="block">{status === 'kept' && !builtIn ? t('plugins.kept') : desc}</span>
                  <span className="mt-1 block">{meta}</span>
                </>
              }
              checked={on}
              disabled={status === 'loading'}
              onChange={(next) => (next ? gate(builtIn ? () => onToggle(true) : onDownload)() : onToggle(false))}
              className="gap-x-5"
            />
            <StateLine state={state} name={title} />
          </div>
        </div>
        {children}
        {!builtIn && status !== 'loading' && (
          <div className="ps-11">
            {/* Neutral, not red: the files are public data that download again. */}
            <Button action="remove" variant="secondary" onClick={onRemove}>{t('onDeviceAi.remove', { size: formatBytes(bytes) })}</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-setting={setting} className="rounded-lg border border-divider p-3 flex flex-col gap-2 text-pretty">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-x-5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {glyph}
          <div className="min-w-0 flex-1 flex flex-col">
            <span className={ROW_TITLE}>{heading}</span>
            <span className={`${SETTINGS_HELP} mt-0.5`}>{desc}</span>
            {builtIn && <span className={`${SETTINGS_HELP} mt-1`}>{meta}</span>}
            <StateLine state={state} name={title} />
          </div>
        </div>
        {status === 'downloading' ? (
          <Button action="cancel" onClick={onCancel} />
        ) : (
          // A free account gets the Pro door every other Pro button uses:
          // secondary, so the rocket keeps its Pro color.
          <Button action="download" variant={unlocked ? 'primary' : 'secondary'} pro={!unlocked} onClick={gate(onDownload)}>
            {t('onDeviceAi.downloadSize', { size: sizeText(bytes) })}
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

/** Asks first when the plugin still runs a job: turning it off or removing it stops the job. */
function useJobConfirm() {
  const [pending, setPending] = useState<{ title: string; run: () => void } | null>(null);
  const ask = (pluginId: PluginId, title: string, run: () => void) => (pluginBusy(pluginId) ? setPending({ title, run }) : run());
  return { ask, pending, close: () => setPending(null) };
}

type SimpleId = 'ocr' | 'voice' | 'cleanup';

/** The cards with one download and a switch: their search marker, words, glyph, engines and Pro door. */
const SIMPLE = {
  ocr: { setting: 'plugins.ocr', title: 'plugins.ocr.title', desc: 'plugins.ocr.desc', Icon: Scan, engine: 'paddle', apple: 'vision', trigger: 'ocr' },
  voice: { setting: 'plugins.voice', title: 'plugins.voice.title', desc: 'plugins.voice.desc', Icon: Waveform, engine: 'whisper', apple: 'speech', trigger: 'smartConnections' },
  cleanup: { setting: 'plugins.cleanup', title: 'plugins.cleanup.title', desc: 'plugins.cleanup.desc', Icon: MagicWand, engine: 'dpdfnet', apple: 'dpdfnet', trigger: 'cleanup' },
} as const satisfies Record<SimpleId, { engine: keyof typeof ENGINE; apple: keyof typeof ENGINE; trigger: UpgradeTrigger } & Record<string, unknown>>;

const MODELS = [...new Set(Object.values(TRANSLATE_MODEL))] as string[];
const LANG_KEYS: readonly PluginKey[] = MODELS.map((m) => `translate.${m}` as PluginKey);

export function PluginsPane({ isPro, onUpgrade, linkSuggestions, onLinkSuggestionsChange, notes, folders, dismissed, onNotDuplicates, onOpenNotes }: {
  isPro: boolean | undefined;
  onUpgrade: (trigger: UpgradeTrigger) => void;
  /** Suggested connections: Smart connections only adds to it, so turning it on turns that on too. */
  linkSuggestions: boolean;
  onLinkSuggestionsChange: (on: boolean) => void;
  /** Find duplicates: the notes, their folders, and the "Not related" pairs. */
  notes: readonly LocalNote[];
  folders: readonly FolderDef[];
  dismissed: readonly string[];
  onNotDuplicates: (a: string, b: string) => void;
  /** Closes Settings and opens the notes (Open both). */
  onOpenNotes: (ids: string[]) => void;
}) {
  const { t } = useTranslation('settings');
  const ui = activeLocale();
  const meaning = useMeaningState();
  const ocr = usePluginState('ocr');
  const voice = usePluginState('voice');
  const cleanup = usePluginState('cleanup');
  const unlocked = proUnlocked(isPro);
  // Voice's engine follows the OS's answer (below 26: the web engine on a
  // Mac, none on an iPhone): draw again once it is in.
  const [, setSpeechKnown] = useState(false);
  useEffect(() => {
    let live = true;
    void checkAppleSpeech().then(() => live && setSpeechKnown(true));
    return () => {
      live = false;
    };
  }, []);
  const ocrApple = pluginEntry('ocr').engine() === 'apple';
  const voiceApple = pluginEntry('voice').engine() === 'apple';
  const jobConfirm = useJobConfirm();
  const indexReady = useMeaningIndexReady();
  const suggestionsOn = useSuggestionsOn();
  const [duplicates, setDuplicates] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  const langList = usePluginStates(LANG_KEYS);
  const langStates = MODELS.map((m, i) => [m, langList[i]!] as const);
  const statusKey = [meaning.status, ocr.status, voice.status, cleanup.status, ...langStates.map(([, s]) => s.status)].join(' ');

  // What this device holds, once when the pane opens.
  useEffect(() => {
    if (meaning.status === 'off') void checkKeptModel();
    for (const key of ['ocr', 'voice', 'cleanup', ...MODELS.map((m) => `translate.${m}`)] as PluginKey[]) void checkKeptPlugin(key, unlocked);
    // Once per open, and again when the plan changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);

  const [storage, setStorage] = useState<{ key: PluginKey; bytes: number }[]>([]);
  const [engineBytes, setEngineBytes] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.all([pluginStorage(), engineStorage()]).then(([per, engines]) => {
      if (!live) return;
      setStorage(per);
      setEngineBytes(engines);
    });
    return () => {
      live = false;
    };
  }, [statusKey]);

  const meaningHere = meaning.status === 'on' || meaning.status === 'kept' || meaning.status === 'loading' || meaning.status === 'needsPro';
  const lines = useMemo(() => {
    const out: { label: string; bytes: number }[] = [];
    if (meaningHere) out.push({ label: t('onDeviceAi.title'), bytes: MEANING_BYTES });
    for (const { key, bytes } of storage) {
      const label = key.startsWith('translate.')
        ? t('notes:translate.newTitle', { title: t('plugins.translate.title'), language: modelLanguageName(key.slice('translate.'.length), ui) })
        : t(SIMPLE[key as SimpleId].title);
      out.push({ label, bytes });
    }
    if (engineBytes) out.push({ label: t('plugins.engine'), bytes: engineBytes });
    return out;
  }, [meaningHere, storage, engineBytes, t, ui]);
  const total = lines.reduce((s, l) => s + l.bytes, 0);
  const anyBusy = (['ocr', 'translate', 'voice', 'cleanup'] as PluginId[]).some(pluginBusy);

  const upgrade = (trigger: UpgradeTrigger) => () => onUpgrade(trigger);

  const smart = (
    <PluginCard
      key="smart"
      setting="plugins.smartConnections"
      icon={<Sparkle className="text-accent" />}
      title={t('onDeviceAi.title')}
      desc={<Trans ns="settings" i18nKey="onDeviceAi.desc" components={{ model: <a href={ENGINE.bekko.href} target="_blank" rel="noopener noreferrer" className={LINK} /> }} />}
      meta={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          {formatBytes(MEANING_BYTES)} · <GuideLink />
        </span>
      }
      bytes={MEANING_BYTES}
      state={meaning}
      isPro={isPro}
      // With Suggested connections off, the model adds nothing: the card reads as off.
      shownOn={meaning.status === 'on' && linkSuggestions}
      onDownload={() => {
        if (!linkSuggestions) onLinkSuggestionsChange(true);
        if (meaning.status !== 'on' && meaning.status !== 'loading') void turnMeaningOn();
      }}
      onCancel={() => void cancelMeaningDownload()}
      onToggle={(on) => (on ? void turnMeaningOn() : turnMeaningOff())}
      onRemove={() => void removeMeaning()}
      onUpgrade={upgrade('smartConnections')}
    >
      {meaning.status === 'on' && unlocked && (
        <div className="ps-11 flex flex-col divide-y divide-divider">
          <Switch
            setting="plugins.suggestions"
            labelClassName={ROW_TITLE}
            label={t('plugins.smart.suggestions')}
            description={t('plugins.smart.suggestionsDesc')}
            checked={suggestionsOn}
            onChange={setSuggestionsOn}
            className="gap-x-5 py-2"
          />
          <div data-setting="plugins.duplicates" className="flex flex-col gap-2 py-2 lg:flex-row lg:items-center lg:justify-between lg:gap-x-5">
            <div className="min-w-0">
              <p className={ROW_TITLE}>{t('plugins.smart.duplicates')}</p>
              <p className={`${SETTINGS_HELP} mt-0.5`}>{t('plugins.smart.duplicatesDesc')}</p>
            </div>
            {indexReady ? (
              <Button action="search" variant="secondary" onClick={() => setDuplicates(true)}>{t('plugins.smart.findDuplicates')}</Button>
            ) : (
              <StatusLine busy>{t('plugins.smart.reading')}</StatusLine>
            )}
          </div>
        </div>
      )}
    </PluginCard>
  );

  const simpleCard = (id: SimpleId) => {
    const card = SIMPLE[id];
    const entry = pluginEntry(id);
    const state = id === 'ocr' ? ocr : id === 'voice' ? voice : cleanup;
    const apple = id === 'ocr' ? ocrApple : id === 'voice' ? voiceApple : false;
    const name = t(card.title);
    const builtIn = (
      <>
        {t('plugins.builtIn')} · <EngineLink engine={card.apple} />
      </>
    );
    const bytes = entry.files.reduce((s, f) => s + f.bytes, 0);
    return (
      <PluginCard
        key={id}
        setting={card.setting}
        icon={<card.Icon className="text-accent" />}
        title={name}
        desc={t(card.desc)}
        meta={apple ? builtIn : <>{formatBytes(bytes)} · <EngineLink engine={card.engine} /></>}
        bytes={bytes}
        state={apple ? { status: pluginFlagOn(id) ? 'on' : 'kept' } : state}
        isPro={isPro}
        builtIn={apple}
        pro={entry.pro}
        onDownload={() => void downloadPlugin(id)}
        onCancel={() => void cancelPluginDownload(id)}
        onToggle={(on) =>
          jobConfirm.ask(id, name, () => {
            if (!apple) return setPluginOn(id, on);
            setPluginFlag(id, on);
            // Off stops the running job: its signal cancels Apple's engine.
            if (!on) stopJobsForPlugin(id);
            void checkKeptPlugin(id, unlocked);
          })
        }
        onRemove={() => jobConfirm.ask(id, name, () => void removePlugin(id))}
        onUpgrade={upgrade(card.trigger)}
      />
    );
  };

  const langHere = langStates.filter(([, s]) => !offDevice(s.status));
  const translateHere = langHere.length > 0;
  const translate = (
    <TranslateCard
      key="translate"
      isPro={isPro}
      langs={langStates}
      onUpgrade={upgrade('translate')}
      onRemove={(m) => jobConfirm.ask('translate', t('plugins.translate.title'), () => void removePlugin(`translate.${m}`))}
    />
  );

  const ocrHere = ocrApple ? pluginFlagOn('ocr') : !offDevice(ocr.status);
  const voiceHere = voiceApple ? pluginFlagOn('voice') : !offDevice(voice.status);
  // Voice to text first: the one free plugin. Remove noise only where the
  // worker can encode audio (not WebKitGTK).
  const cards: [boolean, ReactNode][] = [
    ...(voiceOffered() ? [[voiceHere, simpleCard('voice')] as [boolean, ReactNode]] : []),
    [meaningHere, smart],
    [ocrHere, simpleCard('ocr')],
    [translateHere, translate],
    ...(cleanupShown() ? [[!offDevice(cleanup.status), simpleCard('cleanup')] as [boolean, ReactNode]] : []),
  ];
  const here = cards.filter(([h]) => h).map(([, c]) => c);
  const add = cards.filter(([h]) => !h).map(([, c]) => c);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 pt-4 flex flex-col gap-6">
      <p className={SETTINGS_HELP}>{t('plugins.intro')}</p>

      {total > 0 && (
        <section className="flex flex-col gap-2 rounded-lg border border-divider p-3 lg:flex-row lg:items-center lg:justify-between lg:gap-x-5">
          <div className="min-w-0">
            <p className={`${ROW_TITLE}`}>
              <HardDrives className="text-accent" aria-hidden="true" />
              {t('plugins.storage', { size: formatBytes(total) })}
            </p>
            <p className={`${SETTINGS_HELP} mt-0.5`}>{lines.map((l) => `${l.label} ${formatBytes(l.bytes)}`).join(' · ')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {detectPlatform() === 'desktop' && (
              <Button action="open" variant="secondary" onClick={() => void revealPluginFolder()}>{t('importExport:exportProgress.showInFolder')}</Button>
            )}
            <Button action="remove" variant="secondary" onClick={() => setConfirmAll(true)}>{t('devices.removeAll')}</Button>
          </div>
        </section>
      )}

      {here.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionEyebrow icon={Cpu}>{t('plugins.onDevice')}</SectionEyebrow>
          {here}
        </section>
      )}
      {add.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionEyebrow icon={DownloadSimple}>{t('plugins.add')}</SectionEyebrow>
          {add}
        </section>
      )}

      <p className={SETTINGS_HELP}>
        {(() => {
          // The engine's size in bold: split the sentence at the size, so no
          // catalog needs a tag around its placeholder.
          const size = sizeText(RUNTIME_FILES.reduce((n, f) => n + f.bytes, 0));
          const [before, ...after] = t('plugins.footer', { size }).split(size);
          return after.length ? <>{before}<strong className="text-pn">{size}</strong>{after.join(size)}</> : before;
        })()}
      </p>

      {duplicates && (
        <DuplicatesSheet
          notes={notes}
          folders={folders}
          dismissed={dismissed}
          onNotDuplicates={onNotDuplicates}
          onOpenBoth={(a, b) => onOpenNotes([a, b])}
          onClose={() => setDuplicates(false)}
        />
      )}
      {confirmAll && (
        <ConfirmModal
          title={t('devices.removeAll')}
          confirmLabel={t('devices.removeAll')}
          onConfirm={() => {
            void removeMeaning();
            void removeAllPlugins();
          }}
          onClose={() => setConfirmAll(false)}
        >
          <p>{t('plugins.removeAllConfirm')}</p>
          {anyBusy && <p className="mt-2">{t('plugins.stopJobConfirm')}</p>}
        </ConfirmModal>
      )}
      {jobConfirm.pending && (
        <ConfirmModal
          title={jobConfirm.pending.title}
          confirmLabel={t('common:actions.confirm')}
          variant="warning"
          onConfirm={jobConfirm.pending.run}
          onClose={jobConfirm.close}
        >
          <p>{t('plugins.stopJobConfirm')}</p>
        </ConfirmModal>
      )}
    </div>
  );
}

/**
 * Translate notes: one download per language, both ways (D18). Each
 * downloaded language with its size and a remove button, then "Add a
 * language". English is the bridge between two other languages.
 */
function TranslateCard({ isPro, langs, onUpgrade, onRemove }: {
  isPro: boolean | undefined;
  langs: (readonly [string, PluginState])[];
  onUpgrade: () => void;
  onRemove: (model: string) => void;
}) {
  const { t } = useTranslation('settings');
  const ui = activeLocale();
  const unlocked = proUnlocked(isPro);
  const gate = useProGate(unlocked, onUpgrade);
  const here = langs.filter(([, s]) => !offDevice(s.status));
  const free = langs.filter(([, s]) => offDevice(s.status)).map(([m]) => m);
  const failed = langs.filter(([, s]) => s.status === 'error' || s.status === 'unavailable');
  const name = (m: string) => modelLanguageName(m, ui);
  const bytesOf = (m: string) => translateFiles(m).reduce((s, f) => s + f.bytes, 0);
  const title = t('plugins.translate.title');

  return (
    <div data-setting="plugins.translate" className="rounded-lg border border-divider p-3 flex flex-col gap-2 text-pretty">
      <div className="flex items-start gap-3">
        <SettingsCardIcon glyph={<Translate className="text-accent" />} />
        <div className="min-w-0 flex-1 flex flex-col">
          <span className={ROW_TITLE}>
            {title}
            {!isPro && <ProMark />}
          </span>
          <span className={`${SETTINGS_HELP} mt-0.5`}>{t('plugins.translate.desc')}</span>
          <span className={`${SETTINGS_HELP} mt-1`}>
            <EngineLink engine="firefox" /> · {t('plugins.translate.bridge')}
          </span>
        </div>
      </div>
      {here.length > 0 && (
        <ul className="ps-11 flex flex-col gap-1.5">
          {here.map(([m, s]) => (
            <li key={m} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-body">
                  {name(m)} · {formatBytes(bytesOf(m))}
                </span>
                {s.status === 'downloading' ? (
                  <Button action="cancel" onClick={() => void cancelPluginDownload(`translate.${m}`)} />
                ) : (
                  <DeleteButton kind="remove" label={t('onDeviceAi.remove', { size: formatBytes(bytesOf(m)) })} onConfirm={() => onRemove(m)} />
                )}
              </div>
              {s.status === 'downloading' && <StateLine state={s} name={name(m)} />}
            </li>
          ))}
        </ul>
      )}
      {failed.map(([m, s]) => (
        <div key={m} className="ps-11">
          <StateLine state={s} name={name(m)} />
        </div>
      ))}
      {free.length > 0 && (
        <div className="ps-11">
          <Select
            aria-label={t('plugins.translate.addLanguage')}
            value=""
            onChange={(e) => {
              const m = e.target.value;
              if (m) gate(() => void downloadPlugin(`translate.${m}`))();
            }}
          >
            <option value="">{t('plugins.translate.addLanguage')}</option>
            {free
              .map((m) => [m, name(m)] as const)
              .sort((a, b) => a[1].localeCompare(b[1], ui))
              .map(([m, label]) => (
                <option key={m} value={m}>
                  {label} · {formatBytes(bytesOf(m))}
                </option>
              ))}
          </Select>
        </div>
      )}
    </div>
  );
}
