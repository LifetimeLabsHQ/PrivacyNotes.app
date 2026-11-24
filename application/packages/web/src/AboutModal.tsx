import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { VERSION } from './version';
import { ArrowClockwise, ArrowSquareOut, Bug, ChatCircle, Check, Code, Database, GithubLogo, Globe, Info, Link, MapTrifold, Scales, Sparkle, Star, Tag } from './icons';
import { bugReportUrl } from './bugReportUrl';
import { useCopyToClipboard } from './clipboard';
import { detectPlatform } from './devices';
import {
  applyDesktopUpdate,
  checkForDesktopUpdate,
  openDesktopChangelog,
  openDesktopDownloads,
  SCOOP_SWITCH_CMD,
  useDesktopUpdateState,
} from './DesktopUpdater';
import { FOLLOW_LINKS, GITHUB_NEW_ISSUE } from './followLinks';
import { HelpChip } from './HelpChip';
import { usesOfficialServer } from './hosts';
import { LinksList } from './LinksList';
import { RateOutro, useRateLinks } from './rateLinks';
import { siteHref } from './siteLinks';
import { EYEBROW_ICON_ROW, EyebrowGlyph, SETTINGS_EYEBROW, SETTINGS_HELP, SettingsTabStrip, settingsTabClass } from './settingsUI';
import { Button, Callout, FeedbackButton, Modal, ProgressBar, StatusLine } from './ui';
import { Brand } from './Brand';
import { SwissFlag } from './SwissFlag';
import { formatDay } from './intlFormat';
import { LATEST_RELEASE, latestChangelogHref } from './latestRelease';
import { usePaneTab } from './settingsPaneTab';

const SHOW_DESKTOP_UPDATER = detectPlatform() === 'desktop' && usesOfficialServer();

type Tab = 'about' | 'rating';

type Props = {
  onClose: () => void;
  initialTab?: Tab;
  /** Render inline as a settings pane (no overlay, no own header/footer/escape). */
  embedded?: boolean;
};

const ALL_TABS: { id: Tab; setting: string; labelKey: string; icon: ReactNode }[] = [
  { id: 'about', setting: 'about.about', labelKey: 'about.tabs.about', icon: <Info aria-hidden="true" /> },
  { id: 'rating', setting: 'about.rating', labelKey: 'about.tabs.rating', icon: <Star weight="fill" aria-hidden="true" /> },
];

/* ------------------------------------------------------------------ */
/*  Icons                                                             */
/* ------------------------------------------------------------------ */

function LinkIcon() {
  return <Link />;
}

function ExternalLinkIcon() {
  return <ArrowSquareOut />;
}

/* ------------------------------------------------------------------ */
/*  Tab content                                                       */
/* ------------------------------------------------------------------ */

function DesktopUpdateControl() {
  const { t } = useTranslation('landing');
  const state = useDesktopUpdateState();
  const { copy, copied } = useCopyToClipboard();

  if (state.phase === 'ready') {
    const { update } = state;
    const isStaged = update.mode === 'restart';
    const isScoop = update.mode === 'scoop';
    const required = update.mode === 'download' && !!update.required;
    const scoopCopied = copied === 'scoop';
    return (
      <Callout
        tone={required ? 'warning' : 'info'}
        title={t(required ? 'common:updateToast.required' : 'common:updateToast.available')}
        action={
          isStaged ? (
            <FeedbackButton icon={<ArrowClockwise aria-hidden="true" />} onClick={() => void applyDesktopUpdate()}>
              {t('common:updateToast.restart')}
            </FeedbackButton>
          ) : isScoop ? (
            scoopCopied ? (
              <FeedbackButton icon={<Check className="text-success" aria-hidden="true" />} onClick={() => copy(SCOOP_SWITCH_CMD, 'scoop')}>
                {t('auth:copied')}
              </FeedbackButton>
            ) : (
              <FeedbackButton action="copy" onClick={() => copy(SCOOP_SWITCH_CMD, 'scoop')}>
                {t('common:updateToast.copyCommand')}
              </FeedbackButton>
            )
          ) : (
            <FeedbackButton action="download" onClick={() => void openDesktopDownloads()}>
              {t('common:updateToast.download')}
            </FeedbackButton>
          )
        }
      >
        <span className="font-mono">v{update.version}</span>
        {!required && (
          <>
            {' · '}
            <button
              type="button"
              onClick={() => void openDesktopChangelog()}
              className="text-accent hover:underline"
            >
              {t('common:updateToast.changelog')}
            </button>
          </>
        )}
      </Callout>
    );
  }

  if (state.phase === 'error') {
    const msg =
      state.stage === 'download' && state.version
        ? t('about.updateDownloadFailed', { version: state.version })
        : state.stage === 'install' && state.version
          ? t('about.updateInstallFailed', { version: state.version })
          : t('about.updateCheckFailed');
    return (
      <Callout
        tone="danger"
        action={
          <>
            <FeedbackButton action="retry" onClick={() => void checkForDesktopUpdate()}>
              {t('auth:signIn.tryAgain')}
            </FeedbackButton>
            <FeedbackButton action="download" onClick={() => void openDesktopDownloads()}>
              {t('common:updateToast.download')}
            </FeedbackButton>
          </>
        }
      >
        {msg}
      </Callout>
    );
  }

  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'restarting';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          icon={<ArrowClockwise aria-hidden="true" />}
          disabled={busy}
          onClick={() => void checkForDesktopUpdate()}
        >
          {t('about.checkForUpdates')}
        </Button>
        {state.phase === 'checking' && <StatusLine busy>{t('about.updateChecking')}</StatusLine>}
        {state.phase === 'upToDate' && <StatusLine tone="success">{t('about.updateUpToDate')}</StatusLine>}
        {state.phase === 'downloading' && (
          <StatusLine busy>{t('about.updateDownloading', { version: state.version })}</StatusLine>
        )}
        {state.phase === 'restarting' && <StatusLine busy>{t('about.updateRestarting')}</StatusLine>}
      </div>
      {state.phase === 'downloading' && (
        <ProgressBar
          value={state.progress}
          label={t('about.updateDownloading', { version: state.version })}
        />
      )}
    </div>
  );
}

function AboutTab() {
  const { t } = useTranslation('landing');
  return (
    <div className="space-y-6">
      <section>
        <p className="text-pn-soft leading-relaxed">
          <Trans
            i18nKey="landing:about.intro"
            components={{
              brand: <Brand />,
              nowrap: <span className="whitespace-nowrap" />,
            }}
          />
        </p>
      </section>

      {/* The newest release only. The /changelog page carries the full
          history with its screenshots, so the app links there instead of
          keeping a shorter copy of it. */}
      <a
        href={latestChangelogHref()}
        target="_blank"
        rel="noopener noreferrer"
        data-setting="about.changelog"
        className="group block rounded-lg border border-divider p-4 hover:border-accent/40 transition"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW}`}><EyebrowGlyph icon={Sparkle} />{t('about.whatsNew')}</span>
          <span className="font-mono text-meta text-pn-muted">
            v{LATEST_RELEASE.version} - {formatDay(LATEST_RELEASE.date, 'date')}
          </span>
        </div>
        <p className="mt-2 text-body font-medium text-pn">{LATEST_RELEASE.title}</p>
        <span className="mt-2 inline-flex items-center gap-1.5 text-small text-accent group-hover:underline">
          {t('about.seeWhatsNew')}
          <ExternalLinkIcon />
        </span>
      </a>

      <section className="space-y-4">
        <div className="grid grid-cols-2 gap-6">
          <div>
            <h3 data-setting="about.version" className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}>
              <EyebrowGlyph icon={Tag} />
              {t('about.versionHeading')}
            </h3>
            <p className="font-mono text-pn-soft">v{VERSION}</p>
          </div>
          <div>
            {/* Reuses the retired tab's label rather than carrying a second key
                for the same word, exactly as the desktop About window does.
                /roadmap is an English-only page, so the href takes no slug. */}
            <h3 data-setting="about.roadmap" className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}>
              <EyebrowGlyph icon={MapTrifold} />
              {t('header.roadmap')}
            </h3>
            <a
              href={siteHref('/roadmap')}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline transition inline-flex items-center gap-1.5"
            >
              privacynotes.app
              <ExternalLinkIcon />
            </a>
          </div>
        </div>
        {SHOW_DESKTOP_UPDATER && <DesktopUpdateControl />}
      </section>

      <section className="border-t border-divider pt-5">
        <h3 data-setting="about.openSource" className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}>
            <EyebrowGlyph icon={Code} />
          {t('trust.openSourceHeading')}
        </h3>
        <a
          href="https://github.com/LifetimeLabsHQ/PrivacyNotes.app"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-small text-accent hover:underline"
        >
          <LinkIcon />
          {t('trust.openSourceLink')}
        </a>
        <p className="text-help text-pn-soft mt-1 leading-relaxed">
          {t('trust.openSourceBody')}
        </p>
      </section>

      {/* Same split as the feedback window: bugs and requests go to GitHub,
          and the channels below are for following along only. */}
      <section className="border-t border-divider pt-5">
        <h3 data-setting="about.feedback" className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}>
            <EyebrowGlyph icon={ChatCircle} />
          {t('about.feedbackHeading')}
        </h3>
        <p className="text-help text-pn-soft mb-3">{t('feedback.intro')}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <a href={bugReportUrl()} target="_blank" rel="noopener noreferrer"
            className="text-small text-accent hover:underline inline-flex items-center gap-1">
            <Bug weight="fill" className="shrink-0" />
            {t('feedback.labelReportBug')}
          </a>
          <a href={GITHUB_NEW_ISSUE} target="_blank" rel="noopener noreferrer"
            className="text-small text-accent hover:underline inline-flex items-center gap-1">
            <GithubLogo weight="fill" className="shrink-0" />
            GitHub
          </a>
        </div>
        <h4 className={`${SETTINGS_EYEBROW} mt-4 mb-2`}>{t('feedback.followHeading')}</h4>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {FOLLOW_LINKS.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel={l.rel}
              className="text-small text-accent hover:underline inline-flex items-center gap-1">
              <l.Icon size={12} weight="fill" className="shrink-0" />
              {l.label}
            </a>
          ))}
        </div>
      </section>

      <section className="border-t border-divider pt-5">
        <h3 data-setting="about.dataStorage" className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}>
            <EyebrowGlyph icon={Database} />
          {t('trust.dataStorageHeading')}
        </h3>
        <p className="text-help text-pn-soft leading-relaxed">
          <Trans i18nKey="landing:trust.dataStorageBody" components={{ flag: <SwissFlag /> }} />
        </p>
        <HelpChip surface="about" className="mt-2" />
      </section>

      <section className="border-t border-divider pt-5">
        <h3 data-setting="about.favicons" className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}>
            <EyebrowGlyph icon={Globe} />
          {t('trust.faviconsHeading')}
        </h3>
        {/* One paragraph, not two: the split read as two separate claims when
            it is one story - where the icons come from, and what that costs. */}
        <p className="text-help text-pn-soft leading-relaxed">
          {t('trust.faviconsBody1')} {t('trust.faviconsBody2')}
        </p>
      </section>

      <section className="border-t border-divider pt-5">
        <h3 data-setting="about.legal" className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-3`}>
            <EyebrowGlyph icon={Scales} />
          {t('about.legalHeading')}
        </h3>
        <div className="flex gap-3">
          <a
            href="https://lifetimelabs.dev/privacy/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-small text-accent hover:underline"
          >
            {t('about.privacyPolicy')}
          </a>
          <a
            href="https://lifetimelabs.dev/terms/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-small text-accent hover:underline"
          >
            {t('about.termsOfService')}
          </a>
          <a
            href="https://lifetimelabs.dev/terms/#refunds"
            target="_blank"
            rel="noopener noreferrer"
            className="text-small text-accent hover:underline"
          >
            {t('about.refundPolicy')}
          </a>
        </div>
        <p className={`${SETTINGS_HELP} mt-3 leading-relaxed`}>
          <a href="https://lifetimelabs.dev" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Lifetime Labs LLC</a>
          {' - '}
          <span className="italic">{t('about.tagline')}</span>
        </p>
      </section>
    </div>
  );
}

/** The review platforms, sharing one list with the Rate modal. */
function RatingTab() {
  const { t } = useTranslation('landing');
  const links = useRateLinks();
  return (
    <div>
      <p className={`${SETTINGS_HELP} mb-3`}>{t('rate.intro')}</p>
      <LinksList links={links} grid />
      <p className="mt-3 pt-3 border-t border-divider text-small leading-relaxed text-pn-muted">
        <RateOutro />
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Modal shell                                                       */
/* ------------------------------------------------------------------ */

export function AboutModal({ onClose, initialTab, embedded = false }: Props) {
  const { t } = useTranslation('landing');
  const safeInitial = initialTab ?? 'about';
  const [tab, setTab] = usePaneTab<Tab>('about', safeInitial);

  return (
    <Modal
      // Same opt-out as SettingsShell (which hosts the embedded copy):
      // this screen is text people copy from. Spec: issue #208.
      data-no-app-menu
      embedded={embedded}
      embeddedClassName="flex-1 min-h-0 overflow-hidden flex flex-col text-pn"
      onClose={onClose}
      title={t('notes:settings.aboutLabel')}
      header="bar"
      className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
    >
        <SettingsTabStrip className="shrink-0 px-4 sm:px-6">
          {ALL_TABS.map((tabItem) => (
            <button
              key={tabItem.id}
              data-setting={tabItem.setting}
              onClick={() => setTab(tabItem.id)}
              aria-pressed={tab === tabItem.id}
              className={settingsTabClass(tab === tabItem.id)}
            >
              {tabItem.icon}
              <span>{t(tabItem.labelKey)}</span>
            </button>
          ))}
        </SettingsTabStrip>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6 text-body">
          {tab === 'about' && <AboutTab />}
          {tab === 'rating' && <RatingTab />}
        </div>

    </Modal>
  );
}
