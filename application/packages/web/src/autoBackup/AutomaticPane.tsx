/**
 * Automatic backups, what the person sees: the Automatic tab of Settings >
 * Import & Export, the callout that points at it from the Export tab, and
 * the message that shows outside Settings when a backup failed, is overdue
 * or needs a click. All three read the device's store and the runner's live
 * state, so they take no vault props.
 * Spec: docs/internal/plans/auto-backup.md (sections 10 and 11);
 * mockups/auto-backup-11nov2026.html
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Step } from '../CommandLinePane';
import { askForRemindersOnce } from '../notesView/useReminders';
import { detectPlatform } from '../devices';
import { STEP_LABELS } from '../ExportProgressModal';
import { formatBytes } from '../formatBytes';
import { Archive, CalendarBlank, Check, ClockCounterClockwise, Folder, MinusCircle, Warning, X } from '../icons';
import { formatInstant, formatRelative } from '../intlFormat';
import { protectedFolder, saveFailureText } from '../saveFile';
import {
  Badge, Button, Callout, FeedbackButton, ProgressBar, SectionEyebrow, Select, SETTINGS_HELP, StatusLine, Switch, UpdateToast,
} from '../ui';
import {
  clearDestination, destinationKind, destinationStatus, isPhone, pickDestination, requestFolderPermission,
  revealDestination, type DestinationStatus,
} from './destination';
import { backupName, isOverdue, KEEP_CHOICES, PERIOD_CHOICES, type BackupKeep, type BackupPeriod, type BackupType } from './plan';
import {
  checkBackup, confirmShrunk, destinationChanged, dismissBackupMessage, runBackup, snoozeBackup, stopBackup,
  turnOffBackups, turnOnWithFirstBackup, useBackupLive,
} from './runner';
import { patchConfig, useAutoBackupState, type FailureCause, type RunLogEntry } from './store';

const when = (at: number) => formatRelative(new Date(at).toISOString());

/** The folder, read once and after every change the pane makes to it. */
function useDestination(): [DestinationStatus | null, () => Promise<void>] {
  const [status, setStatus] = useState<DestinationStatus | null>(null);
  const refresh = async () => setStatus(await destinationStatus());
  useEffect(() => {
    void refresh();
  }, []);
  return [status, refresh];
}

function RhythmRow() {
  const { t } = useTranslation('importExport');
  const { config } = useAutoBackupState();
  const pruning = destinationKind() !== 'download';
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        aria-label={t('auto.periodLabel')}
        value={config.period}
        onChange={(e) => patchConfig({ period: e.target.value as BackupPeriod })}
        className="min-w-0 flex-1 basis-44"
      >
        {PERIOD_CHOICES.map((p) => <option key={p} value={p}>{p === 'day' ? t('shell:repeat.daily', { count: 1 }) : t(`auto.period.${p}`)}</option>)}
      </Select>
      {pruning && (
        <Select
          aria-label={t('auto.keepLabel')}
          value={String(config.keep)}
          onChange={(e) => patchConfig({ keep: Number(e.target.value) as BackupKeep })}
          className="min-w-0 flex-1 basis-44"
        >
          {KEEP_CHOICES.map((k) => (
            <option key={k} value={k}>{k === 0 ? t('auto.keepAll') : t('auto.keepLast', { count: k })}</option>
          ))}
        </Select>
      )}
    </div>
  );
}

function FolderRow({ status, onPicked }: { status: DestinationStatus | null; onPicked: () => Promise<void> }) {
  const { t } = useTranslation('importExport');
  const [refused, setRefused] = useState<string | null>(null);
  const hadFolder = status !== null;
  const choose = async () => {
    setRefused(null);
    const picked = await pickDestination();
    if (!picked) return;
    // A folder the app must never write into is refused with its reason,
    // as Save As does (saveFile.ts).
    if (picked.path && detectPlatform() === 'desktop') {
      const { homeDir } = await import('@tauri-apps/api/path');
      // protectedFolder judges a file's path, and a backup is a file directly
      // inside the picked folder: `~/.ssh` itself must match, not only `~/.ssh/x`.
      const folder = protectedFolder(`${picked.path.replace(/[\\/]+$/, '')}/${backupName(new Date(), 'desktop', 'full')}`, await homeDir());
      if (folder) {
        // The pick already replaced the earlier folder on the Rust side, so
        // the earlier folder's list goes with it.
        await clearDestination();
        if (hadFolder) destinationChanged();
        setRefused(saveFailureText({ blockedFolder: folder }, ''));
        await onPicked();
        return;
      }
    }
    if (hadFolder) destinationChanged();
    await onPicked();
  };
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {status && <span className="min-w-0 flex-1 truncate rounded-md border border-divider bg-surface-0 px-2.5 py-1.5 font-mono text-small text-pn" title={status.path ?? status.label}>{status.path ?? status.label}</span>}
        <Button icon={<Folder aria-hidden="true" />} onClick={() => void choose()}>
          {status ? t('auto.changeFolder') : t('auto.chooseFolder')}
        </Button>
        {status && detectPlatform() === 'desktop' && (
          <Button action="open" onClick={() => void revealDestination()}>{t('exportProgress.showInFolder')}</Button>
        )}
      </div>
      {refused && <StatusLine tone="danger">{refused}</StatusLine>}
    </div>
  );
}

function folderHint(t: (key: string) => string): string {
  const platform = detectPlatform();
  if (platform === 'android') return t('auto.stepFolderHintAndroid');
  if (platform === 'ios') return t('auto.stepFolderHintIos');
  return t('auto.stepFolderHint');
}

function runsHint(t: (key: string) => string): string {
  if (isPhone()) return t('auto.runsHintPhone');
  // No folder to write to: nothing runs alone, the app can only say one is due.
  if (destinationKind() === 'download') return t('auto.runsHintDownload');
  return detectPlatform() === 'desktop' ? t('auto.runsHintDesktop') : t('auto.runsHintWeb');
}

function TypeSelect() {
  const { t } = useTranslation('importExport');
  const { config } = useAutoBackupState();
  return (
    <div className="space-y-1.5">
      <Select aria-label={t('auto.typeLabel')} value={config.type} onChange={(e) => patchConfig({ type: e.target.value as BackupType })} className="w-full">
        <option value="full">{t('export.encryptedZipBackupTitle')}</option>
        <option value="text">{t('export.encryptedBackupTitle')}</option>
      </Select>
      <p className={SETTINGS_HELP}>{config.type === 'full' ? t('auto.typeFullHint') : t('export.encryptedBackupDesc')}</p>
    </div>
  );
}

function Progress() {
  const { t } = useTranslation('importExport');
  const { step } = useBackupLive();
  return (
    <div className="space-y-1.5 rounded-md border border-divider px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <StatusLine busy>
            {t('auto.running')}
            {step && ` ${t(STEP_LABELS[step.step])}${step.total !== undefined ? ` ${t('media:viewer.position', { index: step.done, count: step.total })}` : ''}`}
          </StatusLine>
        </div>
        <Button action="cancel" onClick={stopBackup}>{t('editor:audio.stop')}</Button>
      </div>
      <ProgressBar label={t('auto.running')} value={step?.total ? (step.done ?? 0) / step.total : undefined} />
    </div>
  );
}

function LogRow({ entry }: { entry: RunLogEntry }) {
  const { t } = useTranslation('importExport');
  const at = formatInstant(new Date(entry.at), 'row');
  let glyph: ReactNode = <Check className="shrink-0 text-success" aria-hidden="true" />;
  let detail: string | null = entry.checked ? t('auto.logChecked') : null;
  if (entry.result === 'unchanged') {
    glyph = <MinusCircle className="shrink-0 text-pn-muted" aria-hidden="true" />;
    detail = t('auto.logUnchanged');
  } else if (entry.result === 'stopped') {
    glyph = <MinusCircle className="shrink-0 text-pn-muted" aria-hidden="true" />;
    detail = t('auto.logStopped');
  } else if (entry.result === 'failed') {
    glyph = <X className="shrink-0 text-danger" aria-hidden="true" />;
    detail = t(`auto.cause.${entry.cause ?? 'unknown'}`);
  } else if (entry.missing) {
    glyph = <Warning className="shrink-0 text-warning" aria-hidden="true" />;
    detail = t('auto.logMissing', { count: entry.missing });
  }
  return (
    <li className="flex items-center gap-2 border-t border-divider py-1.5 text-small text-pn first:border-t-0">
      {glyph}
      <span className="min-w-0 flex-1">{at}{detail ? ` · ${detail}` : ''}</span>
      {entry.bytes !== undefined && <span className="shrink-0 tabular-nums text-pn-muted">{formatBytes(entry.bytes)}</span>}
    </li>
  );
}

/** The status under the title: the last good run, or what is wrong. */
function StatusBadge({ status }: { status: DestinationStatus | null }) {
  const { t } = useTranslation('importExport');
  const { config, log } = useAutoBackupState();
  const last = log[0];
  if (status?.needsPermission) return <Badge tone="warning">{t('auto.statusWaiting')}</Badge>;
  if (last?.result === 'failed') return <Badge tone="danger">{t('auto.statusFailed')}</Badge>;
  if (config.lastGood === undefined) return <Badge>{t('auto.statusNever')}</Badge>;
  if (isOverdue(config.lastGood, config.period, Date.now())) return <Badge tone="warning">{t('auto.statusOverdue', { when: when(config.lastGood) })}</Badge>;
  if (last?.result === 'unchanged') return <Badge tone="success">{t('auto.statusUnchanged', { when: when(config.lastGood) })}</Badge>;
  const placed = log.find((e) => e.result === 'ok');
  return <Badge tone="success">{t('auto.statusLast', { when: when(placed?.at ?? config.lastGood), size: formatBytes(placed?.bytes ?? 0) })}</Badge>;
}

/** The Automatic tab. */
export function AutomaticPane() {
  const { t } = useTranslation('importExport');
  const { config, files, log } = useAutoBackupState();
  const live = useBackupLive();
  const [status, refresh] = useDestination();
  const kind = destinationKind();
  const download = kind === 'download';
  const hasFolder = download || status !== null;
  const lastFailed = live.message?.kind === 'failed' ? live.message.cause : null;

  const header = (
    <div className="space-y-1.5">
        <Switch
          label={t('auto.title')}
          description={download ? t('auto.introDownload') : t('auto.intro')}
          checked={config.on}
          // Turning it on is the first backup's job (the stepper below).
          disabled={!config.on}
          onChange={(next) => { if (!next) turnOffBackups(); }}
          setting="import.automatic"
        />
        {config.on && !live.running && <StatusBadge status={status} />}
    </div>
  );

  if (!config.on) {
    return (
      <div className="space-y-3">
        {header}
        <ol className="rounded-xl border border-divider p-4">
          {!download && (
            <Step n={1} done={status !== null} title={t('shell:dashboard.chooseFolder')} hint={folderHint(t)}>
              <FolderRow status={status} onPicked={refresh} />
            </Step>
          )}
          <Step n={download ? 1 : 2} done={false} title={t('auto.stepRhythm')}>
            <RhythmRow />
          </Step>
          <Step n={download ? 2 : 3} last done={false} title={t('auto.stepFirst')} hint={`${config.type === 'full' ? t('export.encryptedZipBackupTitle') : t('export.encryptedBackupTitle')}. ${t('auto.stepFirstHint')}`}>
            {live.running ? <Progress /> : (
              <Button
                variant="primary"
                icon={<ClockCounterClockwise aria-hidden="true" />}
                disabled={!hasFolder}
                onClick={() => {
                  // The overdue notification needs the permission, and this tap
                  // is the moment its reason is plain (phones only; asks once).
                  if (config.notify) askForRemindersOnce();
                  void turnOnWithFirstBackup().then(refresh);
                }}
              >
                {download ? t('auto.turnOnDownload') : t('auto.turnOn')}
              </Button>
            )}
            {lastFailed && !live.running && <StatusLine tone="danger">{t(`auto.cause.${lastFailed}`)}</StatusLine>}
          </Step>
        </ol>
        <p className={SETTINGS_HELP}>{runsHint(t)}</p>
      </div>
    );
  }

  const lastSize = files.reduce((newest, f) => (f.at > newest.at ? f : newest), { at: 0, bytes: 0 }).bytes;
  return (
    <div className="space-y-3">
      {header}
      {config.shrunk && (
        <Callout
          tone="warning"
          title={t('auto.shrunkTitle')}
          action={<FeedbackButton icon={<Check aria-hidden="true" />} onClick={confirmShrunk}>{t('auto.shrunkConfirm')}</FeedbackButton>}
        >
          {t('auto.shrunkBody', { items: config.shrunk.items, previous: config.shrunk.previous })}
        </Callout>
      )}
      {live.running && <Progress />}

      <section className="space-y-1.5">
        <SectionEyebrow icon={Archive} className="pt-1">{t('auto.whatHeading')}</SectionEyebrow>
        <TypeSelect />
      </section>

      {!download && (
        <section className="space-y-1.5">
          <SectionEyebrow icon={Folder} className="pt-1">{t('auto.folderHeading')}</SectionEyebrow>
          <FolderRow status={status} onPicked={refresh} />
          {status?.needsPermission && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={<Check aria-hidden="true" />} onClick={() => void requestFolderPermission().then((ok) => (ok ? runBackup(true) : false)).then(refresh)}>
                {t('auto.allow')}
              </Button>
              <p className={`${SETTINGS_HELP} min-w-0 flex-1`}>{t('auto.permissionHint')}</p>
            </div>
          )}
          {status && files.length === 0 && log.some((e) => e.result === 'ok') && <p className={SETTINGS_HELP}>{t('auto.folderChanged')}</p>}
        </section>
      )}

      <section className="space-y-1.5">
        <SectionEyebrow icon={CalendarBlank} className="pt-1">{t('auto.rhythmHeading')}</SectionEyebrow>
        <RhythmRow />
        <p className={SETTINGS_HELP}>
          {runsHint(t)}
          {!download && config.keep !== 0 && lastSize > 0 && ` ${t('auto.sizeHint', { size: formatBytes(lastSize * config.keep), count: config.keep })}`}
        </p>
        {isPhone() && (
          <>
            <Switch label={t('auto.wifiOnly')} description={t('auto.wifiOnlyHint')} checked={config.wifiOnly} onChange={(wifiOnly) => patchConfig({ wifiOnly })} />
            <Switch label={t('auto.notify')} description={t('auto.notifyHint')} checked={config.notify} onChange={(notify) => { patchConfig({ notify }); if (notify) askForRemindersOnce(); }} />
          </>
        )}
      </section>

      <section className="space-y-1.5">
        <SectionEyebrow icon={ClockCounterClockwise} className="pt-1">{t('auto.historyHeading')}</SectionEyebrow>
        {log.length > 0 && <ul>{log.slice(0, 6).map((e) => <LogRow key={`${e.at}-${e.result}`} entry={e} />)}</ul>}
        {!live.running && (
          <Button variant="primary" icon={<ClockCounterClockwise aria-hidden="true" />} onClick={() => void runBackup(true).then(refresh)}>
            {download ? t('auto.downloadNow') : t('auto.backUpNow')}
          </Button>
        )}
        {!download && (
          <p className={SETTINGS_HELP}>
            {log.some((e) => e.checked) && `${t('auto.checkedHint')} `}
            {config.keep !== 0 && t('auto.pruneHint')}
          </p>
        )}
      </section>
    </div>
  );
}

/** On the Export tab, above Full backup: off, with the way in; on, one line. */
export function AutomaticCallout({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation('importExport');
  const { config } = useAutoBackupState();
  if (config.on) {
    return (
      <Callout action={<FeedbackButton action="open" onClick={onOpen}>{t('shell:contacts.open')}</FeedbackButton>}>
        {config.lastGood !== undefined ? t('auto.calloutOn', { when: when(config.lastGood) }) : t('auto.calloutOnNever')}
      </Callout>
    );
  }
  return (
    <Callout title={t('auto.calloutOffTitle')} action={<FeedbackButton icon={<ClockCounterClockwise aria-hidden="true" />} onClick={onOpen}>{t('auto.setUp')}</FeedbackButton>}>
      {t('auto.calloutOffBody')}
    </Callout>
  );
}

const causeText = (t: (key: string) => string, cause: FailureCause) => t(`auto.cause.${cause}`);

/** The one message outside Settings. A good backup shows nothing. */
export function AutoBackupToast({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation('importExport');
  const { message, running } = useBackupLive();
  if (!message || running) return null;
  const icon = <ClockCounterClockwise aria-hidden="true" />;
  const settings = { label: t('shell:contextMenu.settings'), onAction: () => { dismissBackupMessage(); onOpenSettings(); } };
  const again = () => { dismissBackupMessage(); void runBackup(true); };
  if (message.kind === 'failed') {
    return <UpdateToast title={t('auto.toastFailed')} icon={icon} meta={causeText(t, message.cause)} actionLabel={t('auth:signIn.tryAgain')} onAction={again} secondary={settings} onDismiss={dismissBackupMessage} />;
  }
  if (message.kind === 'overdue') {
    return <UpdateToast title={t('auto.toastOverdue', { count: message.days })} icon={icon} actionLabel={t('auto.backUpNow')} onAction={again} secondary={settings} onDismiss={dismissBackupMessage} />;
  }
  if (message.kind === 'due') {
    return <UpdateToast title={t('auto.toastDue')} icon={icon} actionLabel={t('auto.downloadNow')} onAction={again} secondary={{ label: t('auto.notToday'), onAction: snoozeBackup }} onDismiss={snoozeBackup} />;
  }
  if (message.kind === 'permission') {
    return (
      <UpdateToast
        title={t('auto.toastDue')}
        icon={icon}
        meta={t('auto.toastPermission', { folder: message.folder })}
        actionLabel={t('auto.allow')}
        onAction={() => { dismissBackupMessage(); void requestFolderPermission().then((ok) => { void (ok ? runBackup(true) : checkBackup()); }); }}
        onDismiss={dismissBackupMessage}
      />
    );
  }
  return (
    <UpdateToast
      title={t('auto.shrunkTitle')}
      icon={icon}
      meta={t('auto.shrunkBody', { items: message.items, previous: message.previous })}
      actionLabel={t('shell:contextMenu.settings')}
      onAction={() => { dismissBackupMessage(); onOpenSettings(); }}
      onDismiss={dismissBackupMessage}
    />
  );
}

/** Under a manual full backup that just finished, while automatic backups are off. */
export function AutomaticAfterExport({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation('importExport');
  const { config } = useAutoBackupState();
  if (config.on) return null;
  return (
    <Callout className="mt-3" action={<FeedbackButton icon={<ClockCounterClockwise aria-hidden="true" />} onClick={onOpen}>{t('auto.afterExportAction')}</FeedbackButton>}>
      {t('auto.afterExport')}
    </Callout>
  );
}
