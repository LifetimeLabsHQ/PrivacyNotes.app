import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { UpdateToast } from './UpdateToast';
import { detectPlatform } from './devices';
import { exitWritesRun, flushEditorsForExit, isFlushingEditorsForExit, tabEditWaits } from './flushStash';
import { APEX_ORIGIN, RELEASES_ORIGIN, usesOfficialServer } from './hosts';
import { createListeners } from './listeners';
import { holdLockReload } from './lockReload';
import { clearRelaunchShowWindow, markRelaunchShowWindow } from './openAtLogin';
import { openExternalAsync } from './openExternal';
import { marketingHomeHref } from './siteLinks';
import { compareSemver } from './versionCheck';
import { VERSION } from './version';
import { isUpdateSnoozed, snoozeUpdate } from './updateSnooze';
import { setUpdateAvailable } from './updateAvailable';
import { isBelowVersionFloor, knownVersionFloor, reportVersionFloor } from './versionFloor';
import { fetchPolicy } from './policySignature';

const IS_DESKTOP = detectPlatform() === 'desktop';

// Re-check every 4 hours while the app stays open (periodic timer + focus /
// visibility resume). Only a COMPLETED check stamps this floor - a failed
// check or download retries on short backoff and as soon as the device comes
// back online, never locking out updates for hours after a boot/wake race.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h

// tauri-plugin-updater requests have no timeout unless one is passed, so a
// laptop sleeping or switching VPN mid-request could leave a check hung
// forever. Bounds both requests cleanly so retry backoff can recover.
// reqwest's timeout covers the entire download from connect to last byte; 60m
// lets a 112 MB Linux AppImage finish even on a slow ~250 kbps link.
const CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

// Backoff schedule after a failed check or download (30s, 2m, 10m, 30m, 1h).
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
// Wait briefly after `online` so Windows Wi-Fi, DNS and VPN finish settling.
const ONLINE_SETTLE_MS = 3_000;
// After this many failed background checks/downloads (e.g. corporate PAC/WPAD
// proxy that Rust reqwest cannot traverse, or a firewall blocking `.exe`
// downloads), probe via WebView2 or surface a dismissible Download toast so
// the user still learns about the release.
const DOWNLOAD_FALLBACK_AFTER = 2;
// Stop background download retries for a given version after this many
// consecutive failures so a slow/metered connection or read-only install
// location cannot burn gigabytes per day; manual Retry resets this cap.
const MAX_BACKGROUND_DOWNLOAD_RETRIES = 3;

// Public changelog, opened in the system browser (a /changelog tab cannot
// open inside the Tauri webview). Canonical no-www domain. Spec:
// docs/contrib/gotchas.md (canonical domain).
const CHANGELOG_URL = `${APEX_ORIGIN}/changelog`;

// The release floor for the .deb, the one desktop format that cannot self-update.
// Published per platform, from the tracked packages/desktop/update-policy.json:
// a global floor would let a Linux release force Android clients toward an APK
// that does not satisfy it yet. Spec: docs/internal/android-update-check.md (floors are published per platform, never globally).
const LINUX_POLICY_URL = `${RELEASES_ORIGIN}/linux/update-policy.json`;

// The command that moves a Scoop install to winget. The bucket still gets each
// release, but Scoop is off the homepage and winget is the channel we support:
// winget runs our installer, which lands the app where the self-updater
// installs, and the Scoop copy is then removed. Notes and settings live outside
// the Scoop folder, so they stay. `;`, not `&&`: Windows PowerShell 5.1 has no `&&`.
// Spec: docs/internal/windows-release.md (Scoop is off the homepage; a Scoop install is offered winget)
export const SCOOP_SWITCH_CMD = 'winget install LifetimeLabs.PrivacyNotes; scoop uninstall privacynotes';

// Survives an App Lock page reload (`window.location.reload()`) on writable
// macOS/Linux once `downloadAndInstall()` has already replaced the bundle on
// disk, so locking after staging avoids redundant re-downloads or re-installs.
const STAGED_VERSION_KEY = 'privacynotes.stagedUpdate';

// What a check found. `restart` is a staged install awaiting a relaunch.
// The other two cannot self-update and want opposite advice: a Linux .deb is
// replaced from the downloads page, while a Scoop install must NOT be, because the
// download there is the installer that leaves a second copy behind. It gets the
// command that moves it to winget instead.
// `required` is set only in download mode, when this build is below the floor.
export type UpdateReady = { version: string; mode: 'restart' | 'download' | 'scoop'; required?: boolean };

export type DesktopUpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'upToDate' }
  | { phase: 'downloading'; version: string; progress?: number }
  | { phase: 'ready'; update: UpdateReady }
  | { phase: 'restarting'; version: string }
  | { phase: 'error'; version?: string; stage: 'check' | 'download' | 'install' };

const IDLE_STATE: DesktopUpdateState = { phase: 'idle' };

type DownloadedHandle = {
  install(): Promise<void>;
  close?: () => Promise<void>;
};

const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const IS_WINDOWS = /Windows/i.test(UA);
const IS_MAC = /Macintosh|Mac OS X/i.test(UA);
const IS_ARM64 = /aarch64|arm64/i.test(UA);

// Compiled target slug (os-arch) and whether install must wait until Restart
// (always true on Windows, and true on macOS when the .app bundle is not
// writable by the current user so background checks never pop an osascript
// administrator password prompt). Populated lazily from Rust's
// `updater_target_info`, falling back to UA heuristics.
let updaterTarget: string | null = null;
let holdForRestart = IS_WINDOWS;

function readPersistedStagedVersion(): string | null {
  if (holdForRestart) return null;
  try {
    const v = sessionStorage.getItem(STAGED_VERSION_KEY);
    if (!v) return null;
    if (compareSemver(v, VERSION) <= 0) {
      sessionStorage.removeItem(STAGED_VERSION_KEY);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

function writePersistedStagedVersion(version: string | null): void {
  if (holdForRestart) return;
  try {
    if (version) sessionStorage.setItem(STAGED_VERSION_KEY, version);
    else sessionStorage.removeItem(STAGED_VERSION_KEY);
  } catch {
    /* Storage refused: best effort. */
  }
}

/** A Windows (or non-writable macOS) update downloaded and waiting for Restart.
 *  On Windows the install launches the installer and quits the app at once, so
 *  installing in the background closed the window mid-sentence and lost the
 *  typing still in its save delay (external report, 2026-10-24, bug report
 *  11.4). On non-writable macOS installs, running install() in the background
 *  would trigger an unsolicited osascript administrator password prompt. */
let downloadedForRestart: DownloadedHandle | null = null;
/** The version already downloaded (Windows / deferred macOS) or installed to
 *  disk (writable macOS / Linux) and awaiting Restart. Tracking the version
 *  instead of a boolean lets us re-offer a dismissed staged update without
 *  re-downloading it AND still pick up an even newer release that ships later
 *  in the same session. */
let stagedVersion: string | null = readPersistedStagedVersion();

/** How long the editors get to write what they hold before the app quits:
 *  the note editor's save delay and the Markdown folder's (900 ms), with room.
 *  If a slow disk write is still running after 1500 ms, wait up to 5000 ms. */
const SAVE_BEFORE_QUIT_MS = 1500;
const SAVE_WAIT_MAX_MS = 5000;
const SAVE_WAIT_POLL_MS = 50;
/** Cap waiting for an in-flight local macOS/Linux bundle swap on Restart. */
const INSTALL_SWAP_WAIT_MAX_MS = 15_000;
/** Safety watchdog if `install()` or `relaunch()` resolves without exiting. */
const RESTART_WATCHDOG_MS = 15_000;

// Shared module store so both the background DesktopUpdater toast and Settings
// > About ("Check for updates") stay in sync with zero duplicate requests.
let updateState: DesktopUpdateState = stagedVersion
  ? { phase: 'ready', update: { version: stagedVersion, mode: 'restart' } }
  : IDLE_STATE;
let toastUpdate: UpdateReady | null = stagedVersion
  ? { version: stagedVersion, mode: 'restart' }
  : null;
let latestAvailableVersion: string | null = stagedVersion;
if (stagedVersion) setUpdateAvailable(stagedVersion);

function recordAvailableVersion(version: string): void {
  latestAvailableVersion = version;
  setUpdateAvailable(version);
}

function clearAvailableVersion(): void {
  latestAvailableVersion = null;
  setUpdateAvailable(null);
}

let inFlight: Promise<void> | null = null;
let activeInstallSwap: Promise<void> | null = null;
let installSwapActive = false;
let checkEpoch = 0;
let currentCheckManual = false;
let restarting = false;
let lastSuccessAt = 0;
let lastFailureAt = 0;
let failureCount = 0;
let downloadFailureVersion: string | null = null;
let downloadFailureCount = 0;
let downloadStoppedVersion: string | null = null;
let installFailedVersion: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setTimeout> | null = null;
let restartWatchdog: ReturnType<typeof setTimeout> | null = null;
let mounted = false;

const store = createListeners();

function setUpdateState(next: DesktopUpdateState): void {
  updateState = next;
  store.notify();
}

function setToastUpdate(next: UpdateReady | null): void {
  toastUpdate = next;
  store.notify();
}

export function useDesktopUpdateState(): DesktopUpdateState {
  return useSyncExternalStore(store.subscribe, () => updateState, () => IDLE_STATE);
}

function currentBackoffMs(): number {
  const idx = Math.min(Math.max(failureCount - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[idx]!;
}

function clearTimers(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (periodicTimer) {
    clearTimeout(periodicTimer);
    periodicTimer = null;
  }
  if (restartWatchdog) {
    clearTimeout(restartWatchdog);
    restartWatchdog = null;
  }
}

function schedulePeriodic(): void {
  if (!mounted || restarting) return;
  if (periodicTimer) clearTimeout(periodicTimer);
  periodicTimer = setTimeout(() => {
    periodicTimer = null;
    void runCheck(false);
  }, CHECK_INTERVAL_MS);
}

function scheduleRetry(delayMs?: number): void {
  if (!mounted || restarting) return;
  if (delayMs === undefined && typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (retryTimer) clearTimeout(retryTimer);
  const ms = delayMs ?? currentBackoffMs();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void runCheck(false);
  }, ms);
}

/**
 * Release any downloaded Windows installer held in Tauri's Rust ResourceTable
 * before an App Lock page reload wipes JS globals, preventing a ~14 MB leak
 * per lock cycle.
 */
export async function releaseDownloadedUpdate(): Promise<void> {
  checkEpoch += 1;
  const handle = downloadedForRestart;
  downloadedForRestart = null;
  if (updateState.phase === 'checking' || updateState.phase === 'downloading') {
    lastSuccessAt = 0;
    setUpdateState(IDLE_STATE);
  }
  if (holdForRestart) {
    if (handle || stagedVersion) {
      // Allow a prompt re-check if the reload was canceled (e.g. App Lock
      // unlocked before reload) instead of hiding the update for 4 hours.
      lastSuccessAt = 0;
    }
    stagedVersion = null;
    if (updateState.phase === 'ready' && updateState.update.mode === 'restart') {
      setUpdateState(IDLE_STATE);
    }
    if (toastUpdate?.mode === 'restart') {
      setToastUpdate(null);
    }
  }
  if (handle?.close) {
    await handle.close().catch(() => {});
  }
}

async function fetchManifestVersion(url: string): Promise<{ status: number; version: string | null }> {
  try {
    const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(CHECK_TIMEOUT_MS)
      : undefined;
    const res = await fetch(url, { cache: 'no-store', signal });
    if (!res.ok) return { status: res.status, version: null };
    const data = (await res.json()) as { version?: unknown };
    return {
      status: res.status,
      version: typeof data?.version === 'string' ? data.version.replace(/^v/, '') : null,
    };
  } catch {
    return { status: 0, version: null };
  }
}

/**
 * Read-only manifest probe through the WebView's own network stack when Rust's
 * updater `check()` fails. On corporate Windows laptops with PAC/WPAD scripts,
 * per-protocol proxy strings, or NTLM/Kerberos proxy auth, `reqwest`'s
 * `system-proxy` cannot traverse the proxy while WebView2 (Edge) can. Never
 * installs anything - only discovers the latest version so we can surface the
 * Downloads badge and one-click Download fallback.
 */
async function probeManifestViaWebview(): Promise<string | null> {
  const target = updaterTarget ?? (
    IS_WINDOWS
      ? 'windows-x86_64'
      : IS_MAC
        ? 'darwin-aarch64'
        : IS_ARM64
          ? 'linux-aarch64'
          : 'linux-x86_64'
  );
  const ts = Date.now();
  if (target.startsWith('windows-')) {
    const u2 = await fetchManifestVersion(`${RELEASES_ORIGIN}/u2/${target}/latest.json?t=${ts}`);
    if (u2.version) return u2.version;
    if (u2.status !== 404) return null;
  }
  const legacy = await fetchManifestVersion(`${RELEASES_ORIGIN}/u/${target}/latest.json?t=${ts}`);
  return legacy.version;
}

/**
 * Desktop self-updater (macOS/Windows/Linux only).
 *
 * On launch, on a 4h cadence, on focus/visibility resume, on reconnect, and on
 * manual request from Settings > About, it checks the updater endpoint; if a
 * newer build exists it downloads + installs it in the background (or downloads
 * only on Windows, installing on Restart), then surfaces the shared "Update
 * available" toast with a Restart action. A failed check or download never
 * burns the 4h cooldown: it retries with exponential backoff and on `online`.
 * If Rust cannot reach the endpoint (e.g. corporate PAC/WPAD proxy) or the
 * download fails repeatedly, a read-only WebView manifest check and Download
 * fallback toast ensure the user still learns about new releases.
 * A Linux `.deb` can't self-update (it lives in root-owned `/usr`), so its
 * toast nudges to the downloads page - non-dismissible only when below the
 * release floor. iOS/Android update through their app stores, so this is gated
 * on detectPlatform() === 'desktop'. Spec: docs/internal/macos-ios-setup.md (iOS updates through App Store review, not this updater).
 */
async function fetchLinuxMinVersion(): Promise<{ minVersion: string; issued: number } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fetched = await Promise.race([
      fetchPolicy(LINUX_POLICY_URL, 'linux').catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CHECK_TIMEOUT_MS);
      }),
    ]);
    // A policy the release did not sign for this channel is no answer either.
    if (!fetched?.signed) return undefined;
    const { minVersion } = fetched.policy;
    return typeof minVersion === 'string' ? { minVersion, issued: fetched.issued } : undefined;
  } catch {
    // Offline or policy missing: no answer. The caller keeps the floor it
    // already holds, so a network blip never lifts a pause.
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function syncLinuxVersionFloor(fallbackDownload: UpdateReady | null = null): Promise<boolean> {
  const fetched = await fetchLinuxMinVersion();
  if (fetched === undefined) return false;
  reportVersionFloor(fetched.minVersion, fetched.issued);
  const required = isBelowVersionFloor();
  if (updateState.phase === 'ready' && updateState.update.mode === 'download') {
    const nextUpdate: UpdateReady = { ...updateState.update, required };
    if (updateState.update.required !== required) {
      setUpdateState({ phase: 'ready', update: nextUpdate });
    }
    if (required && toastUpdate === null) {
      setToastUpdate(nextUpdate);
    }
  } else if (required && toastUpdate === null && fallbackDownload) {
    setToastUpdate({ ...fallbackDownload, required: true });
  }
  if (toastUpdate?.mode === 'download' && toastUpdate.required !== required) {
    setToastUpdate(!required && isUpdateSnoozed(toastUpdate.version) ? null : { ...toastUpdate, required });
  }
  return true;
}

function finishManualChannelUpdate(
  version: string,
  scoop: boolean,
  floorSynced: boolean,
  failureCounted: boolean,
): void {
  if (scoop) {
    lastSuccessAt = Date.now();
    failureCount = 0;
    schedulePeriodic();
    // No release floor is consulted: the floor is published for Linux only,
    // so this toast is always dismissible.
    const ready: UpdateReady = { version, mode: 'scoop' };
    setUpdateState({ phase: 'ready', update: ready });
    if (currentCheckManual || !isUpdateSnoozed(version)) setToastUpdate(ready);
    else if (toastUpdate) setToastUpdate(null);
    return;
  }

  // The floor held after the report: an older signed policy is refused there.
  const minVersion = knownVersionFloor();
  const required = !!minVersion && compareSemver(VERSION, minVersion) < 0;
  const ready: UpdateReady = { version, mode: 'download', required };
  setUpdateState({ phase: 'ready', update: ready });
  // Dismissed within the last 48h: stay quiet in the toast (About still
  // shows it), and clear any previously forced toast when a lowered floor
  // returns a snoozed version to optional.
  if (currentCheckManual || required || !isUpdateSnoozed(version)) setToastUpdate(ready);
  else if (toastUpdate) setToastUpdate(null);

  if (!floorSynced) {
    lastFailureAt = Date.now();
    if (!failureCounted) {
      failureCount += 1;
    }
    scheduleRetry();
    return;
  }
  lastSuccessAt = Date.now();
  failureCount = 0;
  schedulePeriodic();
}

type DownloadProgressEvent = {
  event: string;
  data?: { contentLength?: number; chunkLength?: number };
};

function isSignatureOrVerifyError(err: unknown): boolean {
  return /signature|minisign|verify|signed|pubkey|version/i.test(String(err));
}

function dropDeferredStagedUpdate(): void {
  const handle = downloadedForRestart;
  downloadedForRestart = null;
  stagedVersion = null;
  handle?.close?.().catch(() => {});
}

async function performCheck(): Promise<void> {
  const epoch = checkEpoch;
  const isStale = () => restarting || !mounted || epoch !== checkEpoch;
  let stage: 'check' | 'download' = 'check';
  let foundVersion: string | undefined;
  let canSelfUpdate = true;
  let scoop = false;
  let floorSynced = true;
  let downloadFinished = false;
  const priorDownload =
    updateState.phase === 'ready' && updateState.update.mode === 'download' ? updateState.update : null;
  // Do NOT call holdLockReload() for background update checks or downloads:
  // holding App Lock reloads across a slow background download would keep the
  // phrase and keys in memory behind the lock screen (THREAT_MODEL.md).
  // `checkEpoch` + `releaseDownloadedUpdate()` keep handle lifecycle safe.
  try {
    if (currentCheckManual || (updateState.phase !== 'ready' && updateState.phase !== 'restarting')) {
      setUpdateState({ phase: 'checking' });
    }

    const { invoke } = await import('@tauri-apps/api/core');
    if (isStale()) return;

    if (updaterTarget === null) {
      const info = await invoke<{ target?: unknown; installOnRestart?: unknown }>('updater_target_info').catch(() => null);
      if (isStale()) return;
      if (info && typeof info.target === 'string' && info.target) {
        updaterTarget = info.target;
        holdForRestart = IS_WINDOWS || info.installOnRestart === true;
      }
    }

    canSelfUpdate = await invoke<boolean>('can_self_update').catch(() => true);
    if (isStale()) return;
    if (!canSelfUpdate) {
      // Both blocked formats arrive here, so ask which one before choosing the
      // nudge. Defaulting to the .deb path on an error keeps the existing
      // behavior for the platform that has had this toast all along.
      scoop = await invoke<boolean>('is_scoop_install').catch(() => false);
      if (isStale()) return;
      // Sync the signed Linux floor over WebView fetch ahead of Rust check() so
      // a corporate proxy, an unreachable manifest, or an up-to-date install
      // with no stored floor still records the latest signed policy and issued
      // timestamp immediately.
      if (!scoop) {
        floorSynced = await syncLinuxVersionFloor(priorDownload);
        if (isStale()) return;
      }
    }

    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({
      timeout: CHECK_TIMEOUT_MS,
      headers: { 'Cache-Control': 'no-cache', 'X-App-Version': VERSION },
    });
    if (isStale()) {
      update?.close?.().catch(() => {});
      return;
    }
    if (!update) {
      downloadFailureCount = 0;
      downloadFailureVersion = null;
      downloadStoppedVersion = null;
      installFailedVersion = null;
      // On Windows / deferred-install macOS nothing has touched disk yet, so a
      // server-side rollback to <= VERSION drops any held installer handle.
      if (holdForRestart && (stagedVersion || downloadedForRestart)) {
        dropDeferredStagedUpdate();
      }
      if (stagedVersion) {
        setUpdateState({ phase: 'ready', update: { version: stagedVersion, mode: 'restart' } });
      } else {
        clearAvailableVersion();
        if (toastUpdate) setToastUpdate(null);
        setUpdateState(currentCheckManual ? { phase: 'upToDate' } : IDLE_STATE);
      }
      if (!canSelfUpdate && !scoop && !floorSynced) {
        lastFailureAt = Date.now();
        failureCount += 1;
        scheduleRetry();
        return;
      }
      lastSuccessAt = Date.now();
      failureCount = 0;
      schedulePeriodic();
      return;
    }

    foundVersion = update.version;

    // Badge the rail's Downloads button first, so the dot survives a dismissed
    // toast and an un-restarted staged install alike.
    recordAvailableVersion(update.version);

    // A Linux .deb can't self-update (it lives in root-owned /usr). Don't
    // install; the toast points the user at the downloads page to fetch the
    // newer .deb by hand. Spec: docs/internal/linux-release.md (.deb lives in root-owned /usr, excluded from the updater manifest).
    if (!canSelfUpdate) {
      update.close?.().catch(() => {});
      finishManualChannelUpdate(update.version, scoop, floorSynced, false);
      return;
    }

    // Background check for the exact version whose installer previously failed:
    // keep offering the Download fallback and restore the AboutModal error card
    // instead of leaving it stuck in `checking` or clobbering back to Restart.
    // Exact equality (`=== 0`) ensures a server-side rollback to an intermediate
    // version is still adopted cleanly.
    if (!currentCheckManual && installFailedVersion && compareSemver(update.version, installFailedVersion) === 0) {
      update.close?.().catch(() => {});
      lastSuccessAt = Date.now();
      failureCount = 0;
      setUpdateState({ phase: 'error', version: update.version, stage: 'install' });
      if (!isUpdateSnoozed(update.version)) {
        setToastUpdate({ version: update.version, mode: 'download' });
      }
      schedulePeriodic();
      return;
    }

    // Background check for the exact version whose downloads hit the retry cap:
    // keep the Download fallback without burning more bandwidth; manual Retry
    // clears `downloadStoppedVersion` to try again.
    if (!currentCheckManual && downloadStoppedVersion && compareSemver(update.version, downloadStoppedVersion) === 0) {
      update.close?.().catch(() => {});
      lastSuccessAt = Date.now();
      failureCount = 0;
      setUpdateState({ phase: 'error', version: update.version, stage: 'download' });
      if (!isUpdateSnoozed(update.version)) {
        setToastUpdate({ version: update.version, mode: 'download' });
      }
      schedulePeriodic();
      return;
    }

    // Already staged for this exact version: never re-run download /
    // downloadAndInstall, just re-offer Restart cleanly. Exact equality (`=== 0`)
    // ensures both newer releases AND server-side rollbacks to an intermediate
    // release replace the staged build.
    if (stagedVersion && compareSemver(update.version, stagedVersion) === 0) {
      update.close?.().catch(() => {});
      lastSuccessAt = Date.now();
      failureCount = 0;
      const ready: UpdateReady = { version: stagedVersion, mode: 'restart' };
      setUpdateState({ phase: 'ready', update: ready });
      setToastUpdate(ready);
      schedulePeriodic();
      return;
    }

    stage = 'download';
    let totalBytes: number | undefined;
    let receivedBytes = 0;
    let lastReportedPct = -1;
    setUpdateState({ phase: 'downloading', version: update.version });
    const onEvent = (ev: DownloadProgressEvent) => {
      if (ev.event === 'Finished') {
        downloadFinished = true;
        if (!holdForRestart) installSwapActive = true;
      }
      if (isStale()) return;
      if (ev.event === 'Started') {
        totalBytes = ev.data?.contentLength ?? undefined;
        receivedBytes = 0;
        lastReportedPct = totalBytes ? 0 : -1;
        setUpdateState({ phase: 'downloading', version: update.version, progress: totalBytes ? 0 : undefined });
      } else if (ev.event === 'Progress') {
        receivedBytes += ev.data?.chunkLength ?? 0;
        if (totalBytes && totalBytes > 0) {
          const pct = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
          if (pct !== lastReportedPct) {
            lastReportedPct = pct;
            setUpdateState({ phase: 'downloading', version: update.version, progress: pct / 100 });
          }
        }
      } else if (ev.event === 'Finished') {
        if (lastReportedPct !== 100) {
          lastReportedPct = 100;
          setUpdateState({ phase: 'downloading', version: update.version, progress: 1 });
        }
      }
    };

    // Writable macOS / Linux AppImage: download + install in the background;
    // the toast's Restart button relaunches into the freshly installed build.
    // Windows (and non-writable macOS installs): download only, and install
    // from the Restart button after flushing editors.
    try {
      if (holdForRestart) {
        await update.download(onEvent, { timeout: DOWNLOAD_TIMEOUT_MS });
        if (isStale()) {
          update.close?.().catch(() => {});
          return;
        }
        const prev = downloadedForRestart;
        downloadedForRestart = update;
        prev?.close?.().catch(() => {});
      } else {
        const swap = update.downloadAndInstall(onEvent, { timeout: DOWNLOAD_TIMEOUT_MS });
        activeInstallSwap = swap;
        try {
          await swap;
        } finally {
          if (activeInstallSwap === swap) {
            activeInstallSwap = null;
            installSwapActive = false;
          }
        }
        update.close?.().catch(() => {});
        if (isStale()) {
          stagedVersion = update.version;
          writePersistedStagedVersion(update.version);
          return;
        }
      }
    } catch (downloadErr) {
      update.close?.().catch(() => {});
      throw downloadErr;
    }

    stagedVersion = update.version;
    writePersistedStagedVersion(update.version);
    installFailedVersion = null;
    downloadStoppedVersion = null;
    lastSuccessAt = Date.now();
    failureCount = 0;
    downloadFailureCount = 0;
    downloadFailureVersion = null;
    const ready: UpdateReady = { version: update.version, mode: 'restart' };
    setUpdateState({ phase: 'ready', update: ready });
    setToastUpdate(ready);
    schedulePeriodic();
  } catch (e) {
    if (isStale()) return;
    // Offline, endpoint down, timeout, PAC/WPAD proxy, blocked download, or
    // signature mismatch. Never burn the 4h cooldown: schedule short backoff
    // retry and surface the error in Settings > About.
    console.warn('[updater] update check failed', e);
    lastFailureAt = Date.now();
    failureCount += 1;

    // On macOS/Linux, `downloadAndInstall()` failing after `Finished` with a
    // non-verification error means the local install step failed (e.g.
    // read-only AppImage location or canceled admin prompt). Signature/verify
    // errors also fire after `Finished` in updater.rs and stay retryable
    // download errors so a transient stale edge tarball can recover.
    if (stage === 'download' && foundVersion && !holdForRestart && downloadFinished && !isSignatureOrVerifyError(e)) {
      installFailedVersion = foundVersion;
      lastSuccessAt = Date.now();
      failureCount = 0;
      setUpdateState({ phase: 'error', version: foundVersion, stage: 'install' });
      if (!stagedVersion && (currentCheckManual || !isUpdateSnoozed(foundVersion))) {
        setToastUpdate({ version: foundVersion, mode: 'download' });
      }
      schedulePeriodic();
      return;
    }

    if (stage === 'check' && (currentCheckManual || failureCount >= DOWNLOAD_FALLBACK_AFTER)) {
      if (!canSelfUpdate && !scoop && !floorSynced) {
        floorSynced = await syncLinuxVersionFloor(priorDownload);
        if (isStale()) return;
      }
      // Rust reqwest could not reach the endpoint; probe via WebView2/WebKit
      // (which supports Windows PAC/WPAD and corporate proxy auth).
      const webviewVersion = await probeManifestViaWebview();
      if (isStale()) return;
      if (webviewVersion) {
        if (compareSemver(webviewVersion, VERSION) <= 0) {
          if (holdForRestart && (stagedVersion || downloadedForRestart)) {
            dropDeferredStagedUpdate();
          }
          if (stagedVersion) {
            setUpdateState({ phase: 'ready', update: { version: stagedVersion, mode: 'restart' } });
          } else {
            clearAvailableVersion();
            if (toastUpdate) setToastUpdate(null);
            setUpdateState(currentCheckManual ? { phase: 'upToDate' } : IDLE_STATE);
          }
          if (!canSelfUpdate && !scoop && !floorSynced) {
            lastFailureAt = Date.now();
            scheduleRetry();
            return;
          }
          lastSuccessAt = Date.now();
          failureCount = 0;
          schedulePeriodic();
          return;
        }
        recordAvailableVersion(webviewVersion);
        if (!canSelfUpdate) {
          finishManualChannelUpdate(webviewVersion, scoop, floorSynced, true);
          return;
        }
        foundVersion = webviewVersion;
        if (!stagedVersion) {
          const fallback: UpdateReady = { version: webviewVersion, mode: 'download' };
          if (currentCheckManual || !isUpdateSnoozed(webviewVersion)) {
            setToastUpdate(fallback);
          }
          // Keep `ready` (download mode) so Settings > About shows the version
          // and a direct Download action instead of misreporting a proxy check
          // failure as a failed download or flashing `Checking...` on retries.
          setUpdateState({ phase: 'ready', update: fallback });
          lastFailureAt = Date.now();
          scheduleRetry();
          return;
        }
      }
    } else if (stage === 'download' && foundVersion) {
      if (downloadFailureVersion === foundVersion) {
        downloadFailureCount += 1;
      } else {
        downloadFailureVersion = foundVersion;
        downloadFailureCount = 1;
      }
      if (!stagedVersion && downloadFailureCount >= DOWNLOAD_FALLBACK_AFTER && !isUpdateSnoozed(foundVersion)) {
        setToastUpdate({ version: foundVersion, mode: 'download' });
      }
      if (!currentCheckManual && downloadFailureCount >= MAX_BACKGROUND_DOWNLOAD_RETRIES) {
        downloadStoppedVersion = foundVersion;
        lastSuccessAt = Date.now();
        failureCount = 0;
        setUpdateState({ phase: 'error', version: foundVersion, stage: 'download' });
        schedulePeriodic();
        return;
      }
    }

    if (stagedVersion && !currentCheckManual) {
      setUpdateState({ phase: 'ready', update: { version: stagedVersion, mode: 'restart' } });
    } else if (!currentCheckManual && updateState.phase === 'ready') {
      // Keep the ready manual-channel or proxy-fallback card across background retries.
    } else {
      setUpdateState({ phase: 'error', version: foundVersion, stage });
    }
    lastFailureAt = Date.now();
    scheduleRetry();
  }
}

function runCheck(manual: boolean): Promise<void> {
  if (restarting) return Promise.resolve();
  if (manual) {
    installFailedVersion = null;
    downloadStoppedVersion = null;
    downloadFailureCount = 0;
    downloadFailureVersion = null;
  }
  if (inFlight) {
    if (manual) currentCheckManual = true;
    return inFlight;
  }
  clearTimers();
  currentCheckManual = manual;
  const p = performCheck().finally(() => {
    if (inFlight === p) {
      inFlight = null;
      currentCheckManual = false;
    }
  });
  inFlight = p;
  return p;
}

/** Trigger a desktop update check on demand (Settings > About). */
export function checkForDesktopUpdate(): Promise<void> {
  if (!IS_DESKTOP || !usesOfficialServer()) return Promise.resolve();
  return runCheck(true);
}

function recoverRestartFailure(version: string, err: unknown): void {
  if (restartWatchdog) {
    clearTimeout(restartWatchdog);
    restartWatchdog = null;
  }
  restarting = false;
  clearRelaunchShowWindow();
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('prepare_update_restart', { active: false }))
    .catch(() => {});
  console.warn('[updater] relaunch failed', err);
  // Drop any failed handle and clear stagedVersion (including sessionStorage)
  // so Retry fetches a fresh copy and background checks do not revert Download
  // back to Restart.
  if (downloadedForRestart) {
    const broken = downloadedForRestart;
    downloadedForRestart = null;
    broken.close?.().catch(() => {});
  }
  stagedVersion = null;
  writePersistedStagedVersion(null);
  if (version) installFailedVersion = version;
  setUpdateState({ phase: 'error', version: version || undefined, stage: 'install' });
  if (version) {
    setToastUpdate({ version, mode: 'download' });
  }
  schedulePeriodic();
}

function armRestartWatchdog(version: string): void {
  if (restartWatchdog) clearTimeout(restartWatchdog);
  restartWatchdog = setTimeout(() => {
    restartWatchdog = null;
    if (restarting) {
      recoverRestartFailure(version, new Error('Updater restart did not exit process'));
    }
  }, RESTART_WATCHDOG_MS);
}

export async function applyDesktopUpdate(): Promise<void> {
  if (restarting) return;
  restarting = true;
  checkEpoch += 1;
  clearTimers();
  const version =
    stagedVersion ??
    (updateState.phase === 'ready' ? updateState.update.version : toastUpdate?.version ?? latestAvailableVersion ?? '');
  setUpdateState({ phase: 'restarting', version });
  markRelaunchShowWindow();
  const releaseHold = holdLockReload();
  try {
    // A quit by the updater fires no beforeunload of its own.
    flushEditorsForExit();
    const waitStart = Date.now();
    await new Promise((resolve) => setTimeout(resolve, SAVE_BEFORE_QUIT_MS));
    while ((tabEditWaits() || exitWritesRun()) && Date.now() - waitStart < SAVE_WAIT_MAX_MS) {
      await new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_POLL_MS));
    }
    // Only wait if a macOS/Linux download has already reached `Finished` and
    // entered the local disk bundle swap (never block up to 60m on an active
    // network download). Cap the wait at 15s so Restart can never hang.
    if (installSwapActive && activeInstallSwap) {
      let swapTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        activeInstallSwap.catch(() => {}),
        new Promise<void>((resolve) => {
          swapTimer = setTimeout(resolve, INSTALL_SWAP_WAIT_MAX_MS);
        }),
      ]);
      if (swapTimer !== undefined) clearTimeout(swapTimer);
    }
    await import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('prepare_update_restart', { active: true }))
      .catch(() => {});
    if (downloadedForRestart) {
      const handle = downloadedForRestart;
      await handle.install();
      if (IS_WINDOWS) {
        // Windows: the installer runs and the app exits; arm watchdog in case
        // the process unexpectedly stays alive.
        armRestartWatchdog(version);
        return;
      }
      // Deferred-install macOS: `install()` swapped the bundle in place; drop
      // the handle and fall through to `relaunch()`.
      downloadedForRestart = null;
      handle.close?.().catch(() => {});
    } else if (holdForRestart) {
      throw new Error('Update installer handle missing');
    }
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    armRestartWatchdog(version);
  } catch (e) {
    recoverRestartFailure(version, e);
  } finally {
    releaseHold();
  }
}

export async function openDesktopChangelog(): Promise<void> {
  try {
    await openExternalAsync(CHANGELOG_URL, { browser: true });
  } catch (e) {
    console.warn('[updater] open changelog failed', e);
  }
}

async function copyScoopSwitchCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(SCOOP_SWITCH_CMD);
  } catch (e) {
    // Denied or unavailable. The toast still named the new version, and the
    // desktop-updates FAQ entry spells the command out, so this is a lost
    // convenience rather than a dead end.
    console.warn('[updater] clipboard write failed', e);
  }
}

export async function openDesktopDownloads(): Promise<void> {
  try {
    // Locale-aware, matching the in-app Downloads button: on desktop
    // marketingHomeHref() is the absolute /<lang> homepage, and #downloads
    // reveals both Linux formats. Spec: docs/internal/linux-release.md (homepage carries both AppImage and .deb buttons).
    await openExternalAsync(`${marketingHomeHref()}#downloads`, { browser: true });
  } catch (e) {
    console.warn('[updater] open downloads failed', e);
  }
}

export function DesktopUpdater() {
  const { t } = useTranslation('common');
  const ready = useSyncExternalStore(store.subscribe, () => toastUpdate, () => null);
  const state = useDesktopUpdateState();
  const [devOverride, setDevOverride] = useState<UpdateReady | null>(null);

  useEffect(() => {
    // Dev-only console hook, same shape as AndroidUpdateToast's: the toast is
    // gated on the desktop build and can never render in a browser. Folded out
    // of every shipped build by import.meta.env.DEV.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__pnDesktopUpdateToast = (opts?: {
        required?: boolean;
        mode?: 'restart' | 'download' | 'scoop';
      }) => {
        recordAvailableVersion('999.0.0');
        setDevOverride({
          version: '999.0.0',
          mode: opts?.mode ?? 'download',
          required: !!opts?.required,
        });
      };
    }

    if (!IS_DESKTOP) return;
    mounted = true;

    const maybeResumeCheck = () => {
      if (inFlight || restarting) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const now = Date.now();
      if (failureCount > 0) {
        if (now - lastFailureAt < currentBackoffMs()) return;
        void runCheck(false);
        return;
      }
      if (now - lastSuccessAt < CHECK_INTERVAL_MS) return;
      void runCheck(false);
    };

    const onFocus = () => maybeResumeCheck();
    const onVisibility = () => {
      if (!document.hidden) maybeResumeCheck();
    };
    const onOnline = () => {
      if (inFlight || restarting) return;
      if (failureCount > 0 || Date.now() - lastSuccessAt >= CHECK_INTERVAL_MS) {
        scheduleRetry(ONLINE_SETTLE_MS);
      }
    };
    const onPageHide = () => {
      if (restarting || isFlushingEditorsForExit()) return;
      void releaseDownloadedUpdate();
    };

    // Always check on launch; periodic timer + focus/visibility/online cover
    // never-quit, tray, sleep/wake, and boot-before-Wi-Fi sessions.
    void runCheck(false);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mounted = false;
      clearTimers();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  const active = devOverride ?? ready;
  if (!active) return null;

  // Only a staged install offers Restart. A .deb (or a self-updater whose
  // background check/download repeatedly failed) is sent to the downloads page,
  // and a Scoop install is handed the command that moves it to winget, since the
  // download it would otherwise be pointed at is what creates the second copy.
  // Only a below-the-floor .deb loses its dismiss and changelog; every other
  // update behaves like an ordinary one.
  const isStaged = active.mode === 'restart';
  const isScoop = active.mode === 'scoop';
  const required = active.mode === 'download' && !!active.required;
  const isRestarting = isStaged && state.phase === 'restarting';
  return (
    <UpdateToast
      version={active.version}
      actionLabel={t(
        isStaged ? 'updateToast.restart' : isScoop ? 'updateToast.copyCommand' : 'updateToast.download',
      )}
      required={required}
      busy={isRestarting}
      onAction={() => {
        if (isStaged) return void applyDesktopUpdate();
        if (isScoop) return void copyScoopSwitchCommand();
        void openDesktopDownloads();
      }}
      onChangelog={required ? undefined : () => void openDesktopChangelog()}
      onDismiss={
        required || isRestarting
          ? undefined
          : () => {
              // Only the nudge paths write the 48h snooze: a staged install
              // costs nothing to re-offer on the next 4h check (or on demand
              // in Settings > About) without re-downloading.
              if (!isStaged) snoozeUpdate(active.version);
              setDevOverride(null);
              setToastUpdate(null);
            }
      }
    />
  );
}
