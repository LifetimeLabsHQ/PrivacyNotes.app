/**
 * Whether Settings > CLI shows. `privacynotes` reaches people through the desktop
 * app's Install button (src-tauri/src/cli_install.rs), so the pane shows in
 * the desktop apps only.
 * Spec: docs/internal/plans/agent-cli.md (C2, C9)
 */
import { DESKTOP_APP } from './shortcutMatch';

export function commandLineShown(): boolean {
  return DESKTOP_APP;
}
