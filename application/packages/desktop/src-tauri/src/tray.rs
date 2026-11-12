//! Keep running in the tray (GitHub #667). With the Settings switch on, the
//! close button and minimize put the main window away instead of quitting or
//! sitting on the taskbar, and an icon in the notification area brings it
//! back: a left click (Windows; Linux delivers no tray clicks) or Open in its
//! menu. Settings in the menu brings it back with Settings open (`pn-tray-settings`).
//! Quit in the menu ends the app.
//!
//! The web view keeps running while the window is away, so desktop reminders
//! still ring. `pn-tray` tells it when the window goes and comes back: the
//! idle re-lock in `appReLock.ts` does not count time spent in the tray, so an
//! app in the tray stays unlocked (the owner's choice, 2026-11-03).
//! Spec: docs/internal/specs/calendar-pillar-spec.md (section 8); docs/contrib/biometric-unlock.md (section 3.3)

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};

const TRAY_ID: &str = "main";
const OPEN_ID: &str = "tray-open";
const SETTINGS_ID: &str = "tray-settings";
const QUIT_ID: &str = "tray-quit";

/// The Settings switch, as the web view last pushed it.
static ON: AtomicBool = AtomicBool::new(false);

/// The switch is on: a start at sign-in stays in the tray (autostart.rs).
pub fn is_on() -> bool {
    ON.load(Ordering::SeqCst)
}

/// Turn tray mode on or off. The menu labels come from the web view, which
/// holds the translations. Pushed at start and on every change of the switch.
#[tauri::command]
pub fn set_tray_mode<R: Runtime>(app: AppHandle<R>, enabled: bool, open: String, settings: String, quit: String) -> Result<(), String> {
    ON.store(enabled, Ordering::SeqCst);
    let _ = app.remove_tray_by_id(TRAY_ID);
    if !enabled {
        // Switched off while the window was away: bring it back, or nothing would.
        reveal(&app);
        return Ok(());
    }
    let open = MenuItem::with_id(&app, OPEN_ID, open, true, None::<&str>).map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(&app, SETTINGS_ID, settings, true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, QUIT_ID, quit, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&open, &settings, &quit]).map_err(|e| e.to_string())?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("PrivacyNotes")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_click);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(&app).map_err(|e| e.to_string())?;
    Ok(())
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id.as_ref() {
        OPEN_ID => reveal(app),
        SETTINGS_ID => {
            reveal(app);
            let _ = app.emit("pn-tray-settings", ());
        }
        QUIT_ID => app.exit(0),
        _ => {}
    }
}

fn on_click<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        reveal(tray.app_handle());
    }
}

/// The main window's close and minimize, while tray mode is on.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != "main" || !ON.load(Ordering::SeqCst) {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            put_away(window);
        }
        // Tao has no minimize event: a resize that leaves the window
        // minimized is one. On Windows that resize is to 0 x 0, and
        // `is_minimized` inside this handler still answers false.
        WindowEvent::Resized(size) if (size.width == 0 && size.height == 0) || window.is_minimized().unwrap_or(false) => {
            put_away(window)
        }
        _ => {}
    }
}

fn put_away<R: Runtime>(window: &Window<R>) {
    let _ = window.hide();
    let _ = window.emit("pn-tray", true);
}

/// Bring the main window back from the tray, or to the front. Also the second
/// launch of the app (single-instance), which must not leave it hidden.
pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("pn-tray", false);
    }
}
