import { useTranslation } from 'react-i18next';
import { ArrowCircleDown, ArrowsClockwise, CloudCheck, CloudSlash, CloudWarning, CloudX, Database, PauseCircle, WifiHigh } from './icons';
import { useOnlineStatus } from './useOnlineStatus';
import { usePendingUploads } from './usePendingUploads';
import { useSyncing } from './syncingStore';
import { HoverLabel } from './HoverLabel';
import { isDemoMode } from './demo';
import { useBelowVersionFloor } from './versionFloor';
import { useSyncPaused } from './syncPause';
import { useFilesWifiOnly } from './wifiOnly';
import { usePushFailures, usePushHalt } from './pushFailures';
import { pullStanding, useSyncLog } from './syncLog';

interface SyncStatusProps {
  /** Icon size in px: the footer's 20, the phone bar's 22. The icon is the whole status, so it is larger than a glyph beside a word. */
  size?: number;
  /**
   * Opens ID & Sync, which is where the detail lives: what is still
   * waiting to upload, and the check of this device against the server.
   * Wired on every state, not just "Synced" - a stalled upload or an
   * offline spell is exactly when you want that panel, and a control
   * that only responds in one of three states reads as broken.
   * Omitted where there is nowhere to navigate to (lock screen, demo).
   */
  onOpen?: () => void;
  /**
   * Where the tooltip opens. Start-aligned suits the desktop footer, where
   * the status sits at the start of its zone; the phone footer centres it,
   * so its tooltip centres too instead of hanging past the screen's edge.
   */
  tipPosition?: 'above-start' | 'above';
  /**
   * Classes for the hover box. The phone bar makes it as tall as its 44px
   * buttons, so the tip opens above the bar like theirs instead of on its
   * top edge.
   */
  tipHostClassName?: string;
  /**
   * The first read of this device's vault has finished. Until then the
   * list is empty while the store opens, and a "Synced" check over it
   * reads as lost notes (beta issue 3), so nothing shows.
   */
  ready?: boolean;
}

/**
 * Sync status indicator with offline awareness.
 * Offline (amber) > Syncing (accent spinner) > Not synced (amber, the
 * last pass could not push a note, or its push stopped before it reached
 * every note; the footer slot fits one short word, so the fuller "not
 * backed up" lives in the tooltip and in ID & Sync) > Not synced (amber,
 * no clean pull in the log yet, or the newest pull failed) > Uploading (accent
 * spinner, blobs still queued) > Synced (green check).
 *
 * The green check is a promise that nothing is still on its way up, so
 * it must not show while blobs wait in the upload queue - "Synced" next
 * to ID & Sync's "58 files waiting to upload" is a contradiction, and a
 * user who trusts the check closes the app before the files ever leave.
 *
 * Icon only (owner, 2026-11-21): one glyph per state, and the words live in
 * the tip (the state's short word) and the `aria-label` (the full
 * sentence), so they translate in every language. The footer once showed a word beside the icon and kept it in
 * English for width. Cloud with a check, in the accent: synced. Turning
 * arrows, faint and gray so a running pass does not pull the eye: syncing
 * or uploading. Cloud struck: offline. Cloud with a
 * warning: not synced. Pause: paused by the person. Wi-Fi: files wait for
 * Wi-Fi. Database: storage full. Arrow down: an update is required. Cloud
 * with an X: the demo saves nothing. The counts live in ID & Sync, one click
 * away. Spec: docs/internal/design/ui-patterns.md section 205
 */
export function SyncStatus({ size = 20, onOpen, tipPosition = 'above-start', tipHostClassName, ready = true }: SyncStatusProps) {
  const { t } = useTranslation('settings');
  const online = useOnlineStatus();
  const pendingUploads = usePendingUploads();
  // Subscribed here, at the leaf, so a sync-pass status flip renders only
  // this pill instead of the whole NotesView tree (backlog #141).
  const syncing = useSyncing();
  const belowFloor = useBelowVersionFloor();
  const paused = useSyncPaused();
  const wifi = useFilesWifiOnly();
  const failures = usePushFailures();
  const halt = usePushHalt();
  const standing = pullStanding(useSyncLog());

  if (!ready) return null;

  // Demo mode never saves anything - don't show a green "Synced" check
  // that implies durability. Say so plainly instead.
  if (isDemoMode()) {
    return (
      <HoverLabel label={t('syncStatus.notSaved')} position={tipPosition} className={tipHostClassName}>
        <span
          className="inline-flex items-center gap-1.5"
          aria-live="polite"
          aria-label={t('syncStatus.demoAria')}
        >
          <CloudX size={size} className="text-warning" />
        </span>
      </HoverLabel>
    );
  }

  // "Synced" is a claim this component cannot actually substantiate: it
  // only knows whether a pass is running, not whether this device holds
  // what the server holds. Clicking it opens ID & Sync and runs the
  // verification, so the claim is at least one click from being tested.
  // Below the release floor sync is PAUSED (versionFloor.ts gates every
  // server write), so this outranks every other state: a green check or a
  // spinner would claim work that is deliberately not happening. The pill is
  // the permanent carrier of that truth, same job it does for demo's "Not
  // saved" - the required update toast can cover content, this cannot.
  const state = belowFloor
    ? {
        body: <ArrowCircleDown size={size} className="text-warning" />,
        tip: t('common:updateToast.required'),
        aria: t('syncStatus.updateRequiredAria'),
      }
    : paused
    ? {
        // The user's own pause (syncPause.ts). Outranks everything below:
        // offline, spinners and the green check all describe work that is
        // deliberately not happening. Never auto-clears, so the pill is
        // the permanent carrier of the paused state.
        body: <PauseCircle size={size} className="text-warning" />,
        tip: t('syncStatus.paused'),
        aria: t('syncStatus.paused'),
      }
    : !online
    ? {
        body: <CloudSlash size={size} className="text-warning" />,
        tip: t('syncStatus.offline'),
        aria: t('syncStatus.offline'),
      }
    : syncing
      ? {
          body: <ArrowsClockwise size={size} className="text-pn-muted opacity-60 motion-safe:animate-spin [animation-duration:2s]" />,
          tip: t('syncStatus.syncing'),
          aria: t('syncStatus.syncingAria'),
        }
      : failures.size > 0 || halt
        ? {
            // The last pass could not push these notes (pushFailures.ts),
            // or its push stopped with notes still waiting. Outranks every
            // upload state below: a green check or an "Uploading" spinner
            // would claim the notes are on their way while the server has
            // refused them or was never reached. The stop speaks for the
            // pass; the count and the reason per note live in ID & Sync,
            // one click away.
            body: <CloudWarning size={size} className="text-warning" />,
            tip: t('syncStatus.notSynced'),
            aria: halt
              ? t('syncStatus.haltedAria', { count: halt.unreached })
              : t('syncStatus.notBackedUpAria', { count: failures.size }),
          }
      : standing !== 'ok'
        ? {
            // No pass on this device has finished a clean pull, or the
            // newest one could not read the server. The check would claim
            // this device holds what the server holds while a fresh
            // browser can still be thousands of notes short of it, which
            // reads as lost notes.
            body: <CloudWarning size={size} className="text-warning" />,
            tip: t('syncStatus.notSynced'),
            aria: standing === 'never' ? t('syncStatus.firstSyncPending') : t('syncStatus.pullFailed'),
          }
      : pendingUploads.count > 0 && wifi.held
        ? {
            // "Files on wifi only" is holding the queue on cellular. Not an
            // error: say what is waited for, not that something is wrong.
            body: <WifiHigh size={size} className="text-warning" />,
            tip: t('syncStatus.wifiHold'),
            aria: t('syncStatus.wifiHold'),
          }
      : pendingUploads.count > 0 && pendingUploads.blocked >= pendingUploads.count
        ? {
            // Every pending blob is quota-blocked: nothing is actually
            // uploading, so a spinner + "Uploading..." would be a lie
            // (backlog #143). Amber warning instead.
            body: <Database size={size} className="text-warning" />,
            tip: t('syncStatus.storageFull'),
            aria: t('syncStatus.pendingBlobsBlocked', { count: pendingUploads.blocked }),
          }
      : pendingUploads.count > 0
        ? {
            body: <ArrowsClockwise size={size} className="text-pn-muted opacity-60 motion-safe:animate-spin [animation-duration:2s]" />,
            tip: t('syncStatus.uploading'),
            aria: t('syncStatus.pendingBlobs', { count: pendingUploads.count }),
          }
        : {
            body: <CloudCheck size={size} className="text-accent" />,
            tip: t('syncStatus.synced'),
            aria: onOpen ? t('syncStatus.syncedVerifyAria') : t('syncStatus.synced'),
          };

  // The tip is the state's short word; the full sentence stays in the
  // aria-label and in ID & Sync, one click away (owner, 2026-11-21).
  const tip = state.tip;

  return (
    <HoverLabel label={tip} position={tipPosition} className={tipHostClassName}>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center justify-center rounded-md p-1 hover:bg-pn/5 transition"
          aria-live="polite"
          aria-label={state.aria}
        >
          {state.body}
        </button>
      ) : (
        <span
          className="inline-flex items-center justify-center p-1"
          aria-live="polite"
          aria-label={state.aria}
        >
          {state.body}
        </span>
      )}
    </HoverLabel>
  );
}
