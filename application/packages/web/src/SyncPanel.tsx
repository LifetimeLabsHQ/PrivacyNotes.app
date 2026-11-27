import { useEffect, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArrowsClockwise,
  CaretDown,
  Check,
  CircleNotch,
  CloudArrowUp,
  CloudCheck,
  CloudSlash,
  Copy,
  Lock,
  Pause,
  SealCheck,
  Warning,
  WifiSlash,
  Laptop,
  IdentificationCard,
  Pulse,
} from './icons';
import { type SupabaseClient } from '@notes/shared';
import { isDemoMode } from './demo';
import { clearNeverSynced, useLocalOnly, useLocalTruthOnly, useUnsyncedLocalVault } from './localOnly';
import { formatInstant, formatRelative } from './intlFormat';
import { verifySync, resetSyncCursor, type SyncReport } from './syncVerify';
import { recordCleanVerify } from './verifyStamp';
import { buildDeviceName } from './devices';
import { countUnsyncedNotes } from './notesRepo';
import { useOnlineStatus } from './useOnlineStatus';
import { usePendingUploads } from './usePendingUploads';
import { useSyncing } from './syncingStore';
import { useBelowVersionFloor } from './versionFloor';
import { setSyncPaused, useSyncPaused } from './syncPause';
import { setFilesWifiOnly, useFilesWifiOnly, wifiOnlyAvailable } from './wifiOnly';
import { useSyncLog, lastOkSyncAt, pullStanding, type SyncPassEntry } from './syncLog';
import { usePushFailures, usePushHalt, type PushFailure } from './pushFailures';
import { db } from './db';
import { readAuthLog } from './authDiag';
import { readSyncFaults } from './syncFaults';
import { readPanelCache } from './accountPanelCache';
import { buildSupportReport } from './supportReport';
import { deriveDisplayTitle } from './notesViewUtils';
import { useVerifyStamp } from './verifyStamp';
import { EYEBROW_ICON_ROW, EyebrowGlyph, SETTINGS_EYEBROW, SETTINGS_BTN_PRIMARY } from './settingsUI';
import { Button, Callout, FeedbackButton, Spinner } from './ui';
import { Switch } from './Switch';
import { VERSION } from './version';
import { SwissFlag } from './SwissFlag';
import { UnopenedNotesList } from './UnopenedNotesList';

/**
 * The redesigned sync readout: one status word with its age, the recent
 * pass bars, the pause and wifi switches, the device and data-path
 * cards, and the activity list. Replaces the old five-row table
 * (SyncStatusRows). Shared by the Sync tab and ID & Sync; `pubkey` adds
 * the compact Account ID row.
 *
 * State precedence mirrors SyncStatus.tsx exactly - the pill sends
 * people here, so this panel must never answer a different question
 * than the thing they clicked.
 */
export function SyncPanel({
  pubkey,
  onSyncNow,
  supabase,
  autoVerify = false,
  onOpenNote,
  onOpenAutoBackup,
  localStorageBytes,
  storageReport,
  onTurnOnLocalSync,
}: {
  pubkey?: string;
  onSyncNow?: () => void | Promise<void>;
  /** Enables the Verify button - the read-only local-vs-server compare. */
  supabase?: SupabaseClient;
  /** Run the verify on mount - set when the footer pill's click IS the
   *  question (was SyncVerifyBlock's autoRun). */
  autoVerify?: boolean;
  /** Opens a note from the not-backed-up list. Absent where there is no
   *  editor to open it in. */
  onOpenNote?: (id: string) => void;
  /** Opens Settings > Backup > Automatic from the local-only backup reminder. */
  onOpenAutoBackup?: () => void;
  /** Local vault byte total (kept independent so offline reports still include it). */
  localStorageBytes?: number;
  /** Server and local storage totals for the Support report. */
  storageReport?: { serverNotesBytes: number; serverFilesBytes: number; localBytes?: number };
  /** Registers (if needed) and enables sync for a local-only or never-synced vault. */
  onTurnOnLocalSync?: () => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const { t } = useTranslation('settings');
  const localOnly = useLocalOnly();
  const localTruth = useLocalTruthOnly();
  const online = useOnlineStatus();
  const syncing = useSyncing();
  const pending = usePendingUploads();
  const belowFloor = useBelowVersionFloor();
  const paused = useSyncPaused();
  const wifi = useFilesWifiOnly();
  const log = useSyncLog();
  const stamp = useVerifyStamp();
  const failures = usePushFailures();
  const halt = usePushHalt();
  const [turningOnSync, setTurningOnSync] = useState(false);
  const [turnOnError, setTurnOnError] = useState<{ message: string; offline: boolean } | null>(null);
  const [localCounts, setLocalCounts] = useState<{ notes: number; files: number } | null>(null);
  const showLocalOnlyView = useUnsyncedLocalVault();

  useEffect(() => {
    if (!showLocalOnlyView) {
      setLocalCounts(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      db.notes.where('deleted').equals(0).count(),
      db.imageCache.toCollection().primaryKeys(),
      db.attachmentCache.toCollection().primaryKeys(),
      db.blobGC.toCollection().primaryKeys(),
    ]).then(([notes, imgIds, attIds, gcIds]) => {
      if (cancelled) return;
      const gcSet = new Set(gcIds);
      const files =
        imgIds.filter((id) => !gcSet.has(id)).length +
        attIds.filter((id) => !gcSet.has(id)).length;
      setLocalCounts({ notes, files });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [showLocalOnlyView]);

  async function handleTurnOnSync() {
    if (turningOnSync) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setTurnOnError({ message: t('sync.localOnlyOfflineError'), offline: true });
      return;
    }
    if (!onTurnOnLocalSync) return;
    setTurningOnSync(true);
    setTurnOnError(null);
    const result = await onTurnOnLocalSync();
    setTurningOnSync(false);
    if (!result.ok) {
      setTurnOnError({ message: result.error, offline: false });
      return;
    }
    void onSyncNow?.();
  }

  // Titles for the not-backed-up list, read on demand: the failing notes
  // are the few the last pass refused, never the whole vault.
  const [failedNotes, setFailedNotes] = useState<Array<{ id: string; title: string; failure: PushFailure; chars: number }>>([]);
  useEffect(() => {
    if (failures.size === 0) {
      setFailedNotes([]);
      return;
    }
    let cancelled = false;
    const ids = [...failures.keys()];
    void db.notes.bulkGet(ids).then((rows) => {
      if (cancelled) return;
      setFailedNotes(
        ids.map((id, i) => {
          const row = rows[i];
          return { id, title: row ? deriveDisplayTitle(row) : id.slice(0, 8), failure: failures.get(id)!, chars: row ? row.body.length : 0 };
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [failures]);

  // Re-render every 30 s so "2 min ago" ages without interaction.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  // Dirty note count for the waiting line. Recomputed when a pass ends
  // or the pause flips - the two moments the number can move.
  const [unsynced, setUnsynced] = useState(0);
  useEffect(() => {
    if (!syncing && !showLocalOnlyView) void countUnsyncedNotes().then(setUnsynced);
  }, [syncing, paused, showLocalOnlyView]);

  // ── Verify (moved in from the deleted SyncVerifyBlock) ──────────
  // Exists because the pill and hero only know whether a pass RAN, not
  // whether this device holds what the server holds. See syncVerify.ts.
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [repaired, setRepaired] = useState(false);

  async function runVerify() {
    if (!supabase) return;
    setVerifyBusy(true);
    setRepaired(false);
    try {
      const r = await verifySync(supabase);
      setReport(r);
      // Stamp only a CLEAN result - the hero's "Verified ... items
      // match" line is a claim of full agreement (verifyStamp.ts).
      if (r.verdict === 'in_sync' && pending.count === 0) {
        recordCleanVerify(r.serverLive);
      }
    } finally {
      setVerifyBusy(false);
    }
  }

  function repair() {
    resetSyncCursor();
    setRepaired(true);
    setReport(null);
  }

  useEffect(() => {
    if (showLocalOnlyView) return;
    if (autoVerify && supabase && navigator.onLine) void runVerify();
    // Mount-only: re-running on every online flip would fire the check
    // again each time the network blips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The demo never contacts a server, so every readout below that
  // describes a server - the state word, the timestamps, the pass bars,
  // the two actions, the activity list - would be a claim about work
  // that does not happen. It outranks every other state, same as the
  // pill (SyncStatus.tsx), and carries the same words the pill does.
  const demo = isDemoMode();

  // Local-only mode (and registered-but-never-synced vaults with sync still
  // off, e.g. after upgrading to Pro without sync, GitHub #862): calm neutral
  // status card, live local counts, backup callout, explicit "Turn on sync"
  // button, device card, and Account ID row. No amber warnings, no sync
  // switches, no server pass bars or activity table.
  if (showLocalOnlyView && !demo) {
    const fileLabel = localCounts && localCounts.files > 0
      ? ` · ${t('notesChrome:signOutConfirm.fileCount', { count: localCounts.files })}`
      : '';
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-divider border-s-[3px] border-s-pn-muted bg-surface-1 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex text-pn-muted"><Laptop /></span>
            <span className="text-title font-semibold text-pn">{t('syncStatus.localOnly')}</span>
          </div>
          <p className="mt-1.5 text-help text-pn-soft">{t('syncPanel.localOnlyBody')}</p>
          {localCounts && (
            <p className="mt-1.5 text-small text-pn-muted tabular-nums">
              {t('syncPanel.localOnlyNotes', { count: localCounts.notes })}{fileLabel}
            </p>
          )}
        </div>

        <Callout
          tone="info"
          action={
            onOpenAutoBackup ? (
              <FeedbackButton icon={<Archive aria-hidden="true" />} onClick={onOpenAutoBackup}>
                {t('syncPanel.localOnlySetUpBackups')}
              </FeedbackButton>
            ) : undefined
          }
        >
          {t('syncPanel.localOnlyBackupHint')}
        </Callout>

        <div className="space-y-2">
          <Button
            variant="primary"
            disabled={turningOnSync}
            icon={turningOnSync ? <Spinner size={15} /> : <ArrowsClockwise aria-hidden="true" />}
            onClick={() => void handleTurnOnSync()}
            className="w-full"
          >
            {turningOnSync ? t('syncPanel.localOnlyTurningOn') : t('syncPanel.localOnlyTurnOnSync')}
          </Button>
          {turnOnError && (
            <Callout tone={turnOnError.offline ? 'info' : 'danger'}>{turnOnError.message}</Callout>
          )}
        </div>

        <div data-setting="me.thisDevice" className="flex flex-col rounded-lg border border-divider px-3.5 py-3">
          <span className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}>
            <EyebrowGlyph icon={Laptop} />{t('settings:devices.thisDevice')}
          </span>
          <div className="text-body font-medium">
            {buildDeviceName()} - v{VERSION}
          </div>
        </div>

        {pubkey && (
          <AccountIdRow
            pubkey={pubkey}
            mode={localOnly ? 'local-only' : 'never-synced'}
            unsynced={localCounts?.notes ?? 0}
            pendingCount={0}
            log={[]}
            failed={[]}
            localStorageBytes={localStorageBytes}
            storageReport={storageReport}
            hint={localOnly ? t('syncPanel.localOnlyAccountIdHint') : undefined}
          />
        )}
      </div>
    );
  }

  // Same rule as the pill: no green check before a clean pull is logged.
  const standing = pullStanding(log);

  const state: 'demo' | 'floor' | 'paused' | 'offline' | 'syncing' | 'notBackedUp' | 'notSynced' | 'wifiHold' | 'storageFull' | 'uploading' | 'synced' =
    demo ? 'demo'
    : belowFloor ? 'floor'
    : paused ? 'paused'
    : !online ? 'offline'
    : syncing ? 'syncing'
    : failures.size > 0 || halt ? 'notBackedUp'
    : standing !== 'ok' ? 'notSynced'
    : pending.count > 0 && wifi.held ? 'wifiHold'
    : pending.count > 0 && pending.blocked >= pending.count ? 'storageFull'
    : pending.count > 0 ? 'uploading'
    : 'synced';

  const amber = 'text-warning';
  const green = 'text-success';
  const heads: Record<typeof state, { icon: React.ReactNode; word: string; cls: string }> = {
    demo: { icon: <CloudSlash />, word: t('syncStatus.notSaved'), cls: amber },
    floor: { icon: <Warning />, word: t('common:updateToast.required'), cls: amber },
    paused: { icon: <Pause weight="bold" />, word: t('syncStatus.paused'), cls: amber },
    offline: { icon: <WifiSlash />, word: t('syncStatus.offline'), cls: amber },
    syncing: { icon: <Spinner />, word: t('syncStatus.syncing'), cls: 'text-accent' },
    notBackedUp: { icon: <Warning />, word: t('syncStatus.notBackedUp'), cls: amber },
    notSynced: { icon: <Warning />, word: t('syncStatus.notSynced'), cls: amber },
    wifiHold: { icon: <CloudArrowUp />, word: t('syncStatus.wifiHold'), cls: amber },
    storageFull: { icon: <Warning />, word: t('syncStatus.storageFull'), cls: amber },
    uploading: { icon: <Spinner />, word: t('syncStatus.uploading'), cls: 'text-accent' },
    synced: { icon: <Check weight="bold" />, word: t('syncStatus.synced'), cls: green },
  };
  const head = heads[state];

  const lastOk = lastOkSyncAt();
  const waiting = unsynced + pending.count;

  // One state-specific subline, nothing more (translation diet).
  const subline =
    state === 'demo' ? t('syncStatus.demoTooltip')
    : state === 'floor' ? t('syncStatus.updateRequiredTooltip')
    : state === 'paused' ? t('syncPanel.pausedBody')
    : state === 'offline' ? t('syncStatus.offlineTooltip')
    : state === 'notBackedUp'
      ? halt
        ? t('syncStatus.haltedAria', { count: halt.unreached })
        : t('syncStatus.notBackedUpAria', { count: failures.size })
    : state === 'notSynced'
      ? standing === 'never' ? t('syncStatus.firstSyncPending') : t('syncStatus.pullFailed')
    : state === 'wifiHold' ? t('syncStatus.wifiHoldTooltip')
    : state === 'storageFull' ? t('syncStatus.pendingBlobsBlocked', { count: pending.blocked })
    : state === 'uploading' ? t('syncStatus.pendingBlobs', { count: pending.count })
    : null;

  const showWaiting = (state === 'paused' || state === 'floor' || state === 'offline') && waiting > 0;

  return (
    <div className="space-y-3">
      {/* ── Status hero ── */}
      <div
        className={`rounded-lg border border-divider border-s-[3px] px-3.5 py-3 ${
          state === 'synced'
            ? 'border-s-emerald-500 bg-[linear-gradient(100deg,rgba(16,185,129,0.07),transparent_65%)]'
            : state === 'syncing' || state === 'uploading'
              ? 'border-s-accent bg-[linear-gradient(100deg,rgb(var(--pn-accent)/0.07),transparent_65%)]'
              : 'border-s-amber-500 bg-[linear-gradient(100deg,rgba(245,158,11,0.07),transparent_65%)]'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`inline-flex ${head.cls}`}>{head.icon}</span>
          <span className={`text-title font-semibold ${head.cls}`}>{head.word}</span>
          {!demo && (
            <span className="ms-auto text-small text-pn-muted whitespace-nowrap">
              {lastOk !== null
                ? t('syncPanel.lastSync', { ago: formatRelative(new Date(lastOk).toISOString()) })
                : t('syncPanel.neverSynced')}
            </span>
          )}
        </div>

        {/* One line, one slot: while a pass runs it narrates, otherwise it
            carries the last clean verify. Same element and size either way,
            and an empty slot holds the line's height in the synced state,
            so the hero never changes height when a background pass or
            either button starts one. */}
        {state === 'syncing' ? (
          <p className="mt-1.5 text-help text-pn-soft">
            {t('syncPanel.passRunning')}
          </p>
        ) : verifyBusy ? (
          // The compare narrates in the same slot the sync does - a
          // click on either action always answers in this line.
          <p className="mt-1.5 text-help text-pn-soft">
            {t('syncPanel.compareRunning')}
          </p>
        ) : stamp && !demo ? (
          // Soft text, green seal only: the state word above owns the
          // color, this line is a fact with a small anchor, not a second
          // green claim.
          <p className="mt-1.5 text-help text-pn-soft flex items-center gap-1.5">
            {t('syncPanel.verified', {
              ago: formatRelative(new Date(stamp.at).toISOString()),
              count: stamp.items,
            })}
            <SealCheck weight="fill" className="text-success" />
          </p>
        ) : state === 'synced' && !demo ? (
          <p className="mt-1.5 h-5" aria-hidden="true" />
        ) : null}
        {subline && <p className="mt-1.5 text-help text-pn-soft">{subline}</p>}
        {showWaiting && (
          <p className="mt-1.5 text-help text-pn-soft">
            {t('syncPanel.waitingNotes', { count: unsynced })}
            {pending.count > 0 && <>{' · '}{t('syncPanel.waitingFiles', { count: pending.count })}</>}
          </p>
        )}

        {!demo && <PassBars log={log} />}
      </div>

      {/* ── Not backed up: the notes the last pass could not push, with the
          reason each one was refused. Persistent by design - it clears only
          when a pass pushes them. */}
      {failedNotes.length > 0 && !demo && (
        <Callout tone="warning" title={t('settings:syncStatus.notBackedUpAria', { count: failedNotes.length })}>
          <ul className="mt-1.5 space-y-1.5">
            {failedNotes.map(({ id, title, failure }) => (
              <li key={id} className="flex items-center gap-2 text-body">
                <span className="min-w-0 flex-1 truncate text-pn" dir="auto">{title}</span>
                <span className="shrink-0 text-small text-warning">
                  {failure.reason === 'too_large'
                    ? t('syncPanel.reasonTooLarge')
                    : t('syncPanel.reasonFailed', { message: failure.message })}
                </span>
                {onOpenNote && (
                  <FeedbackButton action="open" onClick={() => onOpenNote(id)} className="shrink-0">
                    {t('shell:contacts.open')}
                  </FeedbackButton>
                )}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {/* ── Notes this device can't open: the server rows the pull met and
          could not open, each with a resend and a delete (beta #203). Only
          while the list holds a row. ── */}
      <UnopenedNotesList onSyncNow={onSyncNow} />

      {/* ── Controls: the two actions side by side, settings rows under ── */}
      <div className="grid gap-3 sm:grid-cols-2">
        {onSyncNow && !demo && (
          <Button
            icon={syncing ? <Spinner size={15} /> : <ArrowsClockwise className="text-accent" aria-hidden="true" />}
            onClick={() => void onSyncNow()}
            disabled={!online || syncing || belowFloor || paused || verifyBusy}
            className="!rounded-lg !py-2.5"
          >
            {t('syncPanel.syncNow')}
          </Button>
        )}
        {supabase && !demo && (
          <Button
            icon={<CloudCheck className="text-accent" aria-hidden="true" />}
            onClick={() => void runVerify()}
            disabled={verifyBusy || !online || syncing}
            className={`relative !rounded-lg !py-2.5 ${verifyBusy ? '!opacity-100' : ''}`}
          >
            {/* While the compare runs, a short accent dash travels the
                border. The SVG sits on the border's centre line, so the
                rect's radius is the button's 8px less half the 1px border. */}
            {verifyBusy && (
              <svg className="pointer-events-none absolute inset-[-0.5px] h-[calc(100%+1px)] w-[calc(100%+1px)] overflow-visible" aria-hidden="true">
                <rect className="pn-border-trace" width="100%" height="100%" rx="7.5" pathLength="100" />
              </svg>
            )}
            {verifyBusy ? t('sync.verifyRunning') : t('sync.verifyAction')}
          </Button>
        )}
      </div>

      {/* ── Verify outcome - only the answers the hero line cannot carry:
          divergence, busy, failed, files still queued, the repair. ── */}
      {repaired && (
        <p className="text-body text-pn-soft leading-relaxed">{t('sync.verifyRepairQueued')}</p>
      )}
      {report && (
        <div className="text-body leading-relaxed">
          {report.verdict === 'in_sync' && (
            pending.count > 0 && pending.blocked >= pending.count ? (
              <p className="inline-flex items-center gap-1.5 text-warning">
                <Warning />
                {t('sync.verifyInSyncBlockedBlobs', { count: pending.blocked })}
              </p>
            ) : pending.count > 0 ? (
              <p className="inline-flex items-center gap-1.5">
                <Spinner size={14} />
                {t('sync.verifyInSyncPendingBlobs', { count: pending.count })}
              </p>
            ) : (
              // Clean: the hero line just refreshed - saying it twice is
              // the redundancy this panel exists to remove.
              null
            )
          )}
          {/* Not a verdict: another device was mid-write, so any gap we
              measured is probably just data in flight. */}
          {report.verdict === 'busy' && <p className="text-pn-soft">{t('sync.verifyBusy')}</p>}
          {report.verdict === 'failed' && (
            <p className="inline-flex items-center gap-1.5 text-warning">
              <WifiSlash />
              {t('sync.verifyFailed')}
            </p>
          )}
          {report.verdict === 'diverged' && (
            <div className="space-y-2">
              <p className="text-warning">{t('sync.verifyDiverged')}</p>
              <ul className="text-pn-soft space-y-0.5">
                {report.missingLocally.length > 0 && (
                  <li>{t('sync.verifyMissing', { count: report.missingLocally.length })}</li>
                )}
                {report.staleLocally.length > 0 && (
                  <li>{t('sync.verifyStale', { count: report.staleLocally.length })}</li>
                )}
                {report.pendingTombstones.length > 0 && (
                  <li>{t('sync.verifyPendingDelete', { count: report.pendingTombstones.length })}</li>
                )}
                {report.neverPushed.length > 0 && (
                  <li>{t('sync.verifyNeverPushed', { count: report.neverPushed.length })}</li>
                )}
              </ul>
              {report.missingLocally.length + report.staleLocally.length + report.pendingTombstones.length > 0 && (
                <button
                  type="button"
                  onClick={repair}
                  className={SETTINGS_BTN_PRIMARY}
                >
                  {t('sync.verifyRepairAction')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Device + data path ── */}
      <div className="grid gap-3 sm:grid-cols-5">
        <div data-setting="me.thisDevice" className="flex flex-col rounded-lg border border-divider px-3.5 py-3 sm:col-span-2">
          <span className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}><EyebrowGlyph icon={Laptop} />{t('settings:devices.thisDevice')}</span>
          <div className="flex items-center gap-2 text-body font-medium">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              {state !== 'floor' && state !== 'offline' && state !== 'demo' && (
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-40 ${state === 'paused' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
              )}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${state === 'paused' || state === 'demo' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
            </span>
            {buildDeviceName()} - v{VERSION}
          </div>
          <p className={`mt-1 mb-2.5 text-small ${state === 'paused' || state === 'floor' || state === 'demo' ? amber : 'text-pn-muted'}`}>
            {state === 'demo' ? t('syncPanel.rhythmDemo')
              : state === 'paused' ? t('syncPanel.rhythmPaused')
              : state === 'floor' ? t('syncPanel.rhythmFloor')
              : state === 'offline' ? t('syncPanel.rhythmOffline')
              : t('syncPanel.rhythm')}
          </p>
          {/* Both switches govern a server conversation the demo never
              has, so they would be controls over nothing. */}
          {!demo && (
            <SwitchRow
              setting="me.pauseSync"
              className="mt-auto border-t border-divider pt-2.5"
              label={t('syncPanel.pauseSync')}
              checked={paused}
              onChange={(v) => {
                // Turning sync on for the first time ends the local-truth
                // state so future deletes use tombstones and sync normally.
                if (!v) void clearNeverSynced();
                setSyncPaused(v);
              }}
            />
          )}
          {!demo && wifiOnlyAvailable() && (
            <SwitchRow
              setting="me.filesWifiOnly"
              className="border-t border-divider pt-2.5 mt-2.5"
              label={t('syncPanel.filesWifiOnly')}
              checked={wifi.enabled}
              onChange={(v) => setFilesWifiOnly(v)}
            />
          )}
        </div>

        <div data-setting="me.where" className="flex flex-col rounded-lg border border-divider px-3.5 py-3 sm:col-span-3">
          <span className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}><EyebrowGlyph icon={CloudArrowUp} />{t('syncPanel.whereTitle')}</span>
          <div className="flex items-center gap-1.5 flex-wrap text-small text-pn-soft">
            <span className="rounded-md border border-divider bg-track px-2 py-1 whitespace-nowrap">{t('settings:devices.thisDevice')}</span>
            <Lock className="text-pn-muted shrink-0" aria-hidden="true" />
            <span className="rounded-md border border-divider bg-track px-2 py-1 whitespace-nowrap">{t('syncPanel.nodeEncrypted')}</span>
            <CloudArrowUp className="text-pn-muted shrink-0" aria-hidden="true" />
            <span className="rounded-md border border-emerald-600/40 bg-track px-2 py-1 whitespace-nowrap">{t('syncPanel.nodeRegion')} <SwissFlag /></span>
          </div>
          {/* No local-at-rest line here: the seal's residuals need
              caveats a settings card has no room for. This card only
              makes the claim the product advertises; THREAT_MODEL.md
              carries the honest detail. */}
          <p className="mt-2 mb-2.5 text-help text-pn-soft">{t('syncPanel.sealed')}</p>
          <p className="mt-auto border-t border-divider pt-2.5 text-help text-pn-soft">
            {t('syncPanel.offlineFact')}
          </p>
        </div>
      </div>

      {/* ── Account ID (ID & Sync only) ── */}
      {pubkey && (
        <AccountIdRow
          pubkey={pubkey}
          mode={localTruth ? 'never-synced' : undefined}
          unsynced={unsynced}
          pendingCount={pending.count}
          log={log}
          failed={failedNotes}
          localStorageBytes={localStorageBytes}
          storageReport={storageReport}
        />
      )}

      {/* ── Recent activity ── */}
      {!demo && <ActivityList log={log} />}
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  onChange,
  className = '',
  setting,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
  setting: string;
}) {
  return (
    <Switch
      setting={setting}
      label={label}
      checked={checked}
      onChange={onChange}
      className={`gap-3 ${className}`}
      labelClassName="text-compact font-medium"
    />
  );
}

/**
 * The last passes as small bars, oldest first. Green ran clean, amber
 * left notes behind (refused one by one, or a push that stopped), red
 * failed; height tracks how much the pass moved. Purely glanceable -
 * the exact numbers live in the activity list below.
 */
function PassBars({ log }: { log: SyncPassEntry[] }) {
  if (log.length < 2) return null;
  const bars = log.slice(-12);
  return (
    <div className="mt-2.5 flex items-end gap-[3px] h-5" aria-hidden="true">
      {bars.map((e, i) => {
        const h = 30 + Math.min(70, (e.up + e.down + (e.failed ?? 0) + (e.halted?.unreached ?? 0)) * 7);
        // Older passes fade: the newest bar is fully opaque, the oldest
        // sits at 45%, so a red failure from hours ago reads as history
        // instead of a live alarm.
        const age = bars.length > 1 ? i / (bars.length - 1) : 1;
        return (
          <span
            key={`${e.at}-${i}`}
            className={`flex-1 rounded-[2px] ${!e.ok ? 'bg-red-500/60' : e.failed || e.halted ? 'bg-amber-500/60' : 'bg-emerald-500/50'}`}
            style={{ height: `${e.ok ? h : 60}%`, opacity: 0.45 + 0.55 * age }}
          />
        );
      })}
    </div>
  );
}

function AccountIdRow({
  pubkey,
  mode,
  unsynced,
  pendingCount,
  log,
  failed,
  localStorageBytes,
  storageReport,
  hint,
}: {
  pubkey: string;
  mode?: 'local-only' | 'never-synced';
  unsynced: number;
  pendingCount: number;
  /** The recent passes, newest last (syncLog.ts). */
  log: SyncPassEntry[];
  /** The notes the last pass could not push. */
  failed: ReadonlyArray<{ id: string; failure: PushFailure; chars: number }>;
  /** Local vault byte total (kept independent for offline support reports). */
  localStorageBytes?: number;
  /** Server and local storage totals for the Support report. */
  storageReport?: { serverNotesBytes: number; serverFilesBytes: number; localBytes?: number };
  /** Optional status hint under the ID row (used in local-only mode). */
  hint?: string;
}) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState<'id' | 'report' | null>(null);

  async function copy(kind: 'id' | 'report') {
    let text: string;
    if (kind === 'id') {
      text = pubkey;
    } else {
      const pendingGc = await db.blobGC.count().catch(() => 0);
      const cached = storageReport ? null : readPanelCache(pubkey)?.quota ?? null;
      const localBytes = storageReport?.localBytes ?? localStorageBytes;
      const storage = storageReport
        ? { ...storageReport, localBytes, pendingGc }
        : cached
          ? { serverNotesBytes: cached.totalBytes, serverFilesBytes: cached.imageBytes, localBytes, pendingGc }
          : undefined;
      text = buildSupportReport({
        pubkey,
        device: buildDeviceName(),
        version: VERSION,
        mode,
        storage,
        unsynced,
        pendingUploads: pendingCount,
        lastOkAt: lastOkSyncAt(),
        failed: failed.map((f) => ({ id: f.id, reason: f.failure.reason, chars: f.chars })),
        passes: log,
        faults: readSyncFaults(),
        breadcrumbs: readAuthLog(20),
      });
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* clipboard not available */
    }
  }

  return (
    // pn-account-id: container-query pair in index.css, same pattern as
    // pn-storage (ui-patterns section 48). The PANE's width decides the
    // form: narrow panes give the ID the whole line with the two buttons
    // in a 2-column row beneath (a one-line squeeze truncated the ID to
    // four characters on phones); wide panes keep everything on one line.
    <div data-setting="me.accountId" className="pn-account-id rounded-lg border border-divider px-3.5 py-3">
      <span className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}><EyebrowGlyph icon={IdentificationCard} />{t('accountId.heading')}</span>
      <div className="pn-account-id-row">
        <code className="min-w-0 rounded bg-track px-2.5 py-1.5 text-small font-mono truncate">{pubkey}</code>
        {/* Labels never change - only the icon flips to a check - so the
            buttons cannot resize under the click. */}
        <CopyButton
          label={t('accountId.copyId')}
          copied={copied === 'id'}
          onClick={() => void copy('id')}
        />
        <CopyButton
          label={t('accountId.report')}
          copied={copied === 'report'}
          onClick={() => void copy('report')}
        />
      </div>
      {hint && <p className="mt-2 text-small text-pn-muted">{hint}</p>}
    </div>
  );
}

function CopyButton({
  label,
  copied,
  onClick,
}: {
  label: string;
  copied: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      icon={copied ? <Check weight="bold" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      onClick={onClick}
      className={`!px-2.5 !py-1.5 !text-small whitespace-nowrap ${
        copied ? '!border-accent !bg-accent/10 !text-accent-strong' : ''
      }`}
    >
      {label}
    </Button>
  );
}

function ActivityList({ log }: { log: SyncPassEntry[] }) {
  const { t } = useTranslation('settings');
  // Open on desktop, folded on phones - the one section long enough to
  // earn a fold (the mobile panel scrolls otherwise).
  const [open, setOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches,
  );
  if (log.length === 0) return null;
  const rows = [...log].reverse().slice(0, 6);
  return (
    <div data-setting="me.activity" className="rounded-lg border border-divider overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 hover:bg-surface-1 transition"
      >
        <span className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW}`}><EyebrowGlyph icon={Pulse} />{t('syncPanel.activity')}</span>
        <CaretDown className={`ms-auto text-pn-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <table className="w-full text-small text-pn-soft">
          <tbody>
            {rows.map((e, i) => (
              <tr key={`${e.at}-${i}`} className="border-t border-divider">
                <td className="px-3.5 py-1.5 tabular-nums text-pn-muted">
                  {formatInstant(new Date(e.at), 'time')}
                </td>
                <td className={`px-2 py-1.5 ${!e.ok ? 'text-danger' : e.failed || e.halted ? 'text-warning' : ''}`}>
                  {!e.ok
                    ? t('syncPanel.passFailed')
                    : e.up === 0 && e.down === 0 && !e.failed && !e.halted
                      ? (e.n ?? 1) > 1
                        ? t('syncPanel.passNothingRepeat', { count: e.n })
                        : t('syncPanel.passNothing')
                      : [
                          e.up > 0 ? t('syncPanel.passUp', { count: e.up }) : null,
                          e.down > 0 ? t('syncPanel.passDown', { count: e.down }) : null,
                          e.failed ? t('syncPanel.passPushFailed', { count: e.failed }) : null,
                          e.halted ? t('syncPanel.passHalted', { count: e.halted.unreached }) : null,
                        ].filter(Boolean).join(', ')}
                </td>
                <td className="px-3.5 py-1.5 text-end tabular-nums text-pn-muted">
                  {(e.ms / 1000).toFixed(1)}s
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
