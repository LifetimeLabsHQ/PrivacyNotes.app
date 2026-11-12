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
//! view that never says shows the window after 5 s (`lib.rs`, `setup`).
//! Spec: docs/internal/plans/ninja-anywhere-694.md (section 7)

use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime};

pub const ARG: &str = "--autostart";

/// The sign-in entry for this copy of the app.
fn entry<R: Runtime>(app: &AppHandle<R>) -> Result<AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // An AppImage runs from a mount that changes at every start: the entry names the file.
    #[cfg(target_os = "linux")]
    let path = app.env().appimage.map(std::path::PathBuf::from).unwrap_or(exe);
    #[cfg(not(target_os = "linux"))]
    let path = exe;
    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_app_name(&app.package_info().name)
        .set_app_path(&path.to_string_lossy())
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

/// Write or remove the sign-in entry, and answer what the system now has.
#[tauri::command]
pub fn set_autostart<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<bool, String> {
    let launch = entry(&app)?;
    if enabled { launch.enable() } else { launch.disable() }.map_err(|e| e.to_string())?;
    Ok(launch.is_enabled().unwrap_or(enabled))
}

/// Set once the web view has said how a start at sign-in shows.
static DONE: AtomicBool = AtomicBool::new(false);

/// The web view said how this start shows, or there was nothing to say.
pub fn decided() -> bool {
    DONE.load(Ordering::SeqCst)
}

/// How a start at sign-in shows, from the Start minimized switch. Any other
/// start, and a second call, change nothing.
#[tauri::command]
pub fn finish_login_start<R: Runtime>(app: AppHandle<R>, minimized: bool) {
    if !started_at_login() || DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    if !minimized {
        crate::show_main_window(&app);
    } else if !crate::tray::is_on() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.minimize();
            let _ = window.show();
        }
    }
}
