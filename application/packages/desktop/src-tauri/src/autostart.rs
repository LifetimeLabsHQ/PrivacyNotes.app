//! Open at login (Settings > System). auto-launch writes the entry each
//! system reads at sign-in: a LaunchAgent on macOS, the Run key on Windows, an
//! autostart .desktop file on Linux (the AppImage's own path). It is called
//! directly rather than through tauri-plugin-autostart, which leaves the
//! LaunchAgent's AssociatedBundleIdentifiers empty: macOS then lists the entry
//! in Login Items as a bare "privacynotes" executable, not as PrivacyNotes
//! with its icon.
//! The entry starts the app with `--autostart`. Such a start shows no window
//! until the web view says how (`finish_login_start`): with Start minimized
//! on, it stays in the tray when Keep running in the tray is on, and opens
//! minimized when it is off; otherwise the window shows as on any start. A web
//! view that never says shows the window after 5 s (the timer in `lib.rs`,
//! `setup`). The rule for all of it is `decide` in `tray.rs`.
//! Spec: docs/internal/plans/ninja-anywhere-694.md (section 7)

use auto_launch::{AutoLaunch, AutoLaunchBuilder};
#[cfg(target_os = "linux")]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

pub const ARG: &str = "--autostart";

/// The sign-in entry for this copy of the app.
fn entry<R: Runtime>(app: &AppHandle<R>) -> Result<AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // An AppImage runs from a mount that changes at every start: the entry names the file.
    #[cfg(target_os = "linux")]
    let path = app.env().appimage.map(std::path::PathBuf::from).unwrap_or(exe);
    #[cfg(not(target_os = "linux"))]
    let path = exe;
    // The Run key value is one command line, path and arguments joined by a
    // space, and auto-launch does not quote the path. For an unquoted path
    // with a space, Windows first tries each part before a space as a
    // program, so a C:\Program.exe, or C:\Users\John.exe for the folder
    // C:\Users\John Smith, would start at sign-in in place of the app.
    #[cfg(windows)]
    let path = format!("\"{}\"", path.to_string_lossy());
    // Linux: auto-launch writes `Exec={path} {args}` as it comes, and a
    // desktop entry splits `Exec` on spaces, so an AppImage kept in
    // `~/App Images/` named `/home/<user>/App` as the program (beta issue
    // 174). Quoted and escaped the way the Markdown association's entry is.
    #[cfg(target_os = "linux")]
    let path = format!(
        "\"{}\"",
        crate::file_assoc::escape_exec_arg(&path.to_string_lossy()).ok_or("this path cannot be written into a desktop entry")?
    );
    #[cfg(not(any(windows, target_os = "linux")))]
    let path = path.to_string_lossy();
    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_app_name(&app.package_info().name)
        .set_app_path(&path)
        .set_args(&[ARG]);
    // The person's own sign-in only. The library's default writes the
    // machine-wide Run key when the app has admin rights, which would start
    // PrivacyNotes for every account on the computer.
    #[cfg(windows)]
    builder.set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser);
    #[cfg(target_os = "macos")]
    builder
        .set_macos_launch_mode(auto_launch::MacOSLaunchMode::LaunchAgent)
        .set_bundle_identifiers(&[app.config().identifier.as_str()]);
    builder.build().map_err(|e| e.to_string())
}

/// This process was started by the sign-in entry.
pub fn started_at_login() -> bool {
    std::env::args().any(|a| a == ARG)
}

/// Whether the sign-in entry is there. The system is the record: the person
/// can remove it in the system settings, and the switch must say so.
#[tauri::command]
pub fn autostart_enabled<R: Runtime>(app: AppHandle<R>) -> bool {
    entry(&app).and_then(|e| e.is_enabled().map_err(|e| e.to_string())).unwrap_or(false)
}

/// Write the sign-in entry again at start when it is on, so an entry from an
/// earlier build (an unquoted path, a copy that moved) names this copy as it
/// is now. An entry the person turned off in Task Manager reads as off and
/// stays off.
#[cfg(windows)]
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(launch) = entry(app) {
        if launch.is_enabled().unwrap_or(false) {
            let _ = launch.enable();
        }
    }
}

/// The same at start on Linux, so an entry an earlier build wrote with the
/// AppImage path unquoted gets the quoted one (beta issue 200, item 5). An
/// entry the desktop's own settings switched off (`Hidden=true`, GNOME's
/// `X-GNOME-Autostart-enabled=false`) is left as it is.
#[cfg(target_os = "linux")]
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Ok(launch) = entry(app) else { return };
    if !launch.is_enabled().unwrap_or(false) {
        return;
    }
    // Where auto-launch keeps it (`get_xdg_desktop_file` in auto-launch 0.6).
    let file = std::env::var_os("HOME")
        .map(|home| std::path::Path::new(&home).join(".config/autostart").join(format!("{}.desktop", app.package_info().name)));
    let text = file.and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
    if !switched_off_in_entry(&text) {
        let _ = launch.enable();
    }
}

/// Whether a desktop entry carries a desktop's own "do not start" mark.
#[cfg(any(target_os = "linux", test))]
fn switched_off_in_entry(text: &str) -> bool {
    text.lines().map(str::trim).any(|l| l == "Hidden=true" || l == "X-GNOME-Autostart-enabled=false")
}

/// Write or remove the sign-in entry, and answer what the system now has.
#[tauri::command]
pub fn set_autostart<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<bool, String> {
    let launch = entry(&app)?;
    if enabled { launch.enable() } else { launch.disable() }.map_err(|e| e.to_string())?;
    Ok(launch.is_enabled().unwrap_or(enabled))
}

/// How a start at sign-in shows, from the Start minimized switch. Any other
/// start, and a second call, change nothing (tray.rs, `decide`). The tray
/// switch comes with the call: `set_tray_mode` is a separate request, and
/// Tauri does not keep two requests in order, so reading it from `tray.rs`
/// here could see it still off and leave the window minimized in the taskbar
/// instead of in the tray.
#[tauri::command]
pub fn finish_login_start<R: Runtime>(app: AppHandle<R>, minimized: bool, tray: bool) {
    crate::tray::show(&app, crate::tray::Ask::LoginChoice { minimized, tray });
}

#[cfg(test)]
mod tests {
    use super::switched_off_in_entry;

    /// Beta issue 200 (5): the rewrite at start keeps an entry the desktop
    /// switched off, and rewrites any other.
    #[test]
    fn a_switched_off_entry_is_left_alone() {
        let ours = "[Desktop Entry]\nType=Application\nExec=/home/a/App Images/PrivacyNotes.AppImage --autostart\n";
        assert!(!switched_off_in_entry(ours));
        assert!(switched_off_in_entry(&format!("{ours}Hidden=true\n")));
        assert!(switched_off_in_entry(&format!("{ours}X-GNOME-Autostart-enabled=false\n")));
        assert!(!switched_off_in_entry(&format!("{ours}X-GNOME-Autostart-enabled=true\n")));
    }
}
