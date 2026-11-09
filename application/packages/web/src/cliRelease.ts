/**
 * Whether Settings > CLI shows. `privacynotes` reaches people through the desktop
 * app's Install button (src-tauri/src/cli_install.rs), so the pane shows in
 * the desktop apps only. Before that button shipped (C9), the pane showed in
 * development builds only, so no release offered a command nobody could
 * install; turned on by the owner on 2026-11-09 with the Install button.
 * Spec: docs/internal/plans/agent-cli.md (C2, C9)
 */
import { DESKTOP_APP } from './shortcutMatch';

const CLI_RELEASED = true;

export function commandLineShown(): boolean {
  return CLI_RELEASED ? DESKTOP_APP : import.meta.env.DEV;
}

/** The homepage section (LandingCli.tsx): on the web for everyone once
 *  released, and in development builds before. */
export function cliMarketingShown(): boolean {
  return CLI_RELEASED || import.meta.env.DEV;
}
