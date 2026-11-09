/**
 * Install for `privacynotes` from Settings > CLI, through the desktop app's two Tauri
 * commands (`cli_status`, `install_cli` in src-tauri/src/cli_install.rs).
 * Outside the desktop app there is nothing to install from: the hook answers
 * null and the pane shows the help only.
 * Spec: docs/internal/plans/agent-cli.md (section 3.7)
 */
import { useCallback, useEffect, useState } from 'react';
import { DESKTOP_APP } from './shortcutMatch';

export interface CliStatus {
  installed: boolean;
  /** Where the launcher is: `~/.local/bin/pn`, or `pn.cmd` on Windows. */
  command: string;
  onPath: boolean;
  /** The shell line that puts the launcher's folder on PATH. */
  pathLine: string | null;
}

/** `not_ours`: a launcher the app did not write is in the way. */
export type CliInstallError = 'not_ours' | 'failed';

async function call(cmd: 'cli_status' | 'install_cli'): Promise<CliStatus> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<CliStatus>(cmd);
}

export function useCliInstall() {
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CliInstallError | null>(null);

  useEffect(() => {
    if (!DESKTOP_APP) return;
    let live = true;
    call('cli_status').then((s) => { if (live) setStatus(s); }, () => {});
    return () => { live = false; };
  }, []);

  const install = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await call('install_cli'));
    } catch (e) {
      setError(e === 'not_ours' ? 'not_ours' : 'failed');
    } finally {
      setBusy(false);
    }
  }, []);

  return { available: DESKTOP_APP, status, busy, error, install };
}
