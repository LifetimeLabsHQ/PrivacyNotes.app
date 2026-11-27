import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UpdateToast } from './UpdateToast';
import { startVersionPolling } from './versionCheck';
import { detectPlatform } from './devices';
import { exitWritesRun, flushEditorsForExit, tabEditWaits } from './flushStash';
import { usesOfficialServer } from './hosts';
import { openExternal } from './openExternal';
import { siteHref } from './siteLinks';

const IS_DESKTOP = detectPlatform() !== 'web';
const RELOAD_FLUSH_SETTLE_MS = 300;
const RELOAD_FLUSH_MAX_MS = 2_000;
const RELOAD_FLUSH_POLL_MS = 50;

/**
 * Bottom-right toast that appears when the server is running a newer
 * version than the currently loaded client. Slides up on first detection
 * and on every re-detection after dismiss. The Update button flushes any open
 * editors (including Markdown folder files that have no flush stash) and
 * reloads the page; the dismiss × hides the toast until the next poll
 * re-detects the mismatch, so a long-running session can't permanently
 * silence updates.
 *
 * Skipped in Tauri builds - desktop apps bundle their own version and
 * shouldn't compare against the web deployment.
 */
export function VersionUpdateToast() {
  const { t } = useTranslation('common');
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (IS_DESKTOP) return;
    return startVersionPolling((v) => {
      setServerVersion(v);
      setHidden(false);
    });
  }, []);

  if (!serverVersion || hidden) return null;

  const handleRefresh = async () => {
    if (reloading) return;
    setReloading(true);
    flushEditorsForExit();
    const start = Date.now();
    const settled = start + RELOAD_FLUSH_SETTLE_MS;
    const deadline = start + RELOAD_FLUSH_MAX_MS;
    // Wait at least 300 ms so unstashed async writes (note titles, source-mode
    // encrypted bodies, or saves whose debounce just fired) finish IndexedDB
    // commits before reloading, mirroring lockReload.ts.
    while ((Date.now() < settled || tabEditWaits() || exitWritesRun()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RELOAD_FLUSH_POLL_MS));
    }
    window.location.reload();
  };

  return (
    <UpdateToast
      version={serverVersion}
      actionLabel={t('updateToast.refresh')}
      busy={reloading}
      onAction={() => void handleRefresh()}
      onChangelog={usesOfficialServer() ? () => openExternal(siteHref('/changelog')) : undefined}
      onDismiss={reloading ? undefined : () => setHidden(true)}
    />
  );
}
