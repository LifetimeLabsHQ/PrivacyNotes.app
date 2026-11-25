import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCircleDown, ArrowsClockwise, Database, Laptop, PauseCircle, WifiHigh } from './icons';
import { useOnlineStatus } from './useOnlineStatus';
import { usePendingUploads } from './usePendingUploads';
import { useSyncing } from './syncingStore';
import { HoverLabel } from './HoverLabel';
import { isDemoMode } from './demo';
import { useLocalOnly, useLocalTruthOnly } from './localOnly';
import { useBelowVersionFloor } from './versionFloor';
import { useSyncPaused } from './syncPause';
import { useFilesWifiOnly } from './wifiOnly';
import { usePushFailures, usePushHalt } from './pushFailures';
import { pullStanding, useSyncLog } from './syncLog';

/** Phosphor bold `ArrowsClockwise` path (256x256 viewBox), shared across the
 *  sync ring states so every footer status icon shares one round silhouette
 *  with the Settings gear and the storage ring. */
const ARROWS_CLOCKWISE_BOLD_D =
  'M228,48V96a12,12,0,0,1-12,12H168a12,12,0,0,1,0-24h19l-7.8-7.8a75.55,75.55,0,0,0-53.32-22.26h-.43A75.49,75.49,0,0,0,72.39,75.57,12,12,0,1,1,55.61,58.41a99.38,99.38,0,0,1,69.87-28.47H126A99.42,99.42,0,0,1,196.2,59.23L204,67V48a12,12,0,0,1,24,0ZM183.61,180.43a75.49,75.49,0,0,1-53.09,21.63h-.43A75.55,75.55,0,0,1,76.77,179.8L69,172H88a12,12,0,0,0,0-24H40a12,12,0,0,0-12,12v48a12,12,0,0,0,24,0V189l7.8,7.8A99.42,99.42,0,0,0,130,226.06h.56a99.38,99.38,0,0,0,69.87-28.47,12,12,0,0,0-16.78-17.16Z';

export type SyncArrowsMark = 'x' | 'slash' | 'warning';

/**
 * Circular `ArrowsClockwise` glyph carrying its state (`warning` bottom-right
 * cutout badge for not synced, `x` bottom-right danger cutout badge for demo
 * not saved, or a masked diagonal `slash` for offline), matching Phosphor's
 * bold weight. Synced uses plain `ArrowsClockwise` in `text-success`.
 */
export function SyncArrowsIcon({
  mark,
  size = 20,
  className = '',
}: {
  mark: SyncArrowsMark;
  size?: number;
  className?: string;
}) {
  const maskId = useId();
  const badgeMaskId = useId();
  if (mark === 'slash') {
    return (
      <svg
        viewBox="0 0 256 256"
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        data-pn-icon=""
        className={className}
      >
        <defs>
          <mask id={maskId}>
            <rect width="256" height="256" fill="white" />
            <line x1="48" y1="40" x2="208" y2="216" stroke="black" strokeWidth="48" strokeLinecap="round" />
          </mask>
        </defs>
        <path d={ARROWS_CLOCKWISE_BOLD_D} mask={`url(#${maskId})`} />
        <line
          x1="48"
          y1="40"
          x2="208"
          y2="216"
          fill="none"
          stroke="currentColor"
          strokeWidth="22"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  const badgeFill = mark === 'x' ? 'rgb(var(--pn-danger))' : 'rgb(var(--pn-warning))';
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      data-pn-icon=""
      className={className}
    >
      <defs>
        <mask id={maskId}>
          <rect width="256" height="256" fill="white" />
          <circle cx="198" cy="196" r="66" fill="black" />
        </mask>
        <mask id={badgeMaskId}>
          <rect width="256" height="256" fill="white" />
          {mark === 'warning' ? (
            <>
              <line x1="198" y1="171" x2="198" y2="198" stroke="black" strokeWidth="17" strokeLinecap="round" />
              <circle cx="198" cy="221" r="10" fill="black" />
            </>
          ) : (
            <path
              d="M179 177 L217 215 M217 177 L179 215"
              fill="none"
              stroke="black"
              strokeWidth="17"
              strokeLinecap="round"
            />
          )}
        </mask>
      </defs>
      <path d={ARROWS_CLOCKWISE_BOLD_D} mask={`url(#${maskId})`} />
      <circle cx="198" cy="196" r="50" fill={badgeFill} mask={`url(#${badgeMaskId})`} />
    </svg>
  );
}

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
 * spinner, blobs still queued) > Synced (accent check).
 *
 * The check is a promise that nothing is still on its way up, so
 * it must not show while blobs wait in the upload queue - "Synced" next
 * to ID & Sync's "58 files waiting to upload" is a contradiction, and a
 * user who trusts the check closes the app before the files ever leave.
 *
 * Icon only (owner, 2026-11-21; round `ArrowsClockwise` states, 2026-11-25):
 * one round glyph per state so the gear, the storage ring and the sync icon
 * balance in the footer, while the words live in the tip (the state's short
 * word) and the `aria-label` (the full sentence), which translate in every
 * language. Clean circular arrows (`ArrowsClockwise`) in `text-success`: synced.
 * Turning arrows, faint and gray so a running pass does not pull the eye: syncing
 * or uploading. Circular arrows struck: offline. Circular arrows with a bottom-right
 * cutout `!` badge: not synced. Pause circle: paused by the person. Wi-Fi: files
 * wait for Wi-Fi. Database: storage full. Arrow circle down: an update is
 * required. Circular arrows with a bottom-right cutout danger `x` badge: the demo
 * saves nothing. The counts live in ID & Sync, one click away.
 * Spec: docs/internal/design/ui-patterns.md section 205
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
  const localOnly = useLocalOnly();
  const localTruth = useLocalTruthOnly();
  const wifi = useFilesWifiOnly();
  const failures = usePushFailures();
  const halt = usePushHalt();
  const standing = pullStanding(useSyncLog());

  if (!ready) return null;

  // Demo mode never saves anything - don't show a "Synced" check
  // that implies durability. Say so plainly instead.
  if (isDemoMode()) {
    return (
      <HoverLabel label={t('syncStatus.notSaved')} position={tipPosition} className={tipHostClassName}>
        <span
          className="inline-flex items-center justify-center p-1"
          aria-live="polite"
          aria-label={t('syncStatus.demoAria')}
        >
          <SyncArrowsIcon mark="x" size={size} className="text-warning" />
        </span>
      </HoverLabel>
    );
  }

  // "Synced" is a claim this component cannot actually substantiate: it
  // only knows whether a pass is running, not whether this device holds
  // what the server holds. Clicking it opens ID & Sync and runs the
  // verification, so the claim is at least one click from being tested.
  // Below the release floor sync is PAUSED (versionFloor.ts gates every
  // server write), so this outranks every other state: a check or a
  // spinner would claim work that is deliberately not happening. The pill is
  // the permanent carrier of that truth, same job it does for demo's "Not
  // saved" - the required update toast can cover content, this cannot.
  // Local-only mode (and registered-but-never-synced vaults with sync still
  // off) shows a calm neutral device icon instead of an amber warning.
  const state = localOnly || (localTruth && paused)
    ? {
        body: <Laptop size={size} className="text-pn-muted" />,
        tip: t('syncStatus.localOnly'),
        aria: t('syncStatus.localOnlyAria'),
      }
    : belowFloor
    ? {
        body: <ArrowCircleDown size={size} className="text-warning" />,
        tip: t('common:updateToast.required'),
        aria: t('syncStatus.updateRequiredAria'),
      }
    : paused
    ? {
        // The user's own pause (syncPause.ts). Outranks everything below:
        // offline, spinners and the check all describe work that is
        // deliberately not happening. Never auto-clears, so the pill is
        // the permanent carrier of the paused state.
        body: <PauseCircle size={size} className="text-warning" />,
        tip: t('syncStatus.paused'),
        aria: t('syncStatus.paused'),
      }
    : !online
    ? {
        body: <SyncArrowsIcon mark="slash" size={size} className="text-warning" />,
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
            // upload state below: a check or an "Uploading" spinner
            // would claim the notes are on their way while the server has
            // refused them or was never reached. The stop speaks for the
            // pass; the count and the reason per note live in ID & Sync,
            // one click away.
            body: <SyncArrowsIcon mark="warning" size={size} className="text-warning" />,
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
            body: <SyncArrowsIcon mark="warning" size={size} className="text-warning" />,
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
            body: <ArrowsClockwise size={size} className="text-success" />,
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
