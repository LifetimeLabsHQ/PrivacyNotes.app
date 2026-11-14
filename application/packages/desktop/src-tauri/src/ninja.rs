//! Ninja from any app (GitHub #694). A global key opens a small window,
//! `ninja`, above the app in front. The window shows the real Ninja of the
//! main window: the main window runs it hidden and sends its markup over, and
//! the small window sends back the typing, the keys and the clicks
//! (`ninjaHost.ts`, `NinjaWindow.tsx`). Nothing here reads a note.
//!
//! The key comes from the web view (`set_ninja_shortcut`), which keeps it as a
//! device setting. The plugin's own JavaScript API is not granted, so a script
//! cannot take keys from other apps. Esc, a click outside and the key again
//! give the focus back to the app that was in front; a row that runs brings
//! the main window forward instead (`ninja_dismiss`).
//! Spec: docs/internal/plans/ninja-anywhere-694.md

use std::str::FromStr;
use std::sync::Mutex;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const LABEL: &str = "ninja";
/// The box's size in logical pixels. Spec: docs/internal/plans/ninja-anywhere-694.md (section 3)
const WIDTH: f64 = 640.0;
const HEIGHT: f64 = 420.0;

/// The key registered now, so a change can take it away again.
static CURRENT: Mutex<Option<Shortcut>> = Mutex::new(None);

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                pressed(app);
            }
        })
        .build()
}

/// Take the key the web view sends, or none. `Ok(Some(command))` on a Linux
/// Wayland session, where no app can take a key: the command is what the
/// person binds in the system keyboard settings instead. `Err("invalid")` for
/// a key with no Ctrl, Alt or Cmd, `Err("taken")` when the system refuses it.
#[tauri::command]
pub fn set_ninja_shortcut<R: Runtime>(app: AppHandle<R>, accelerator: Option<String>) -> Result<Option<String>, String> {
    let mut current = CURRENT.lock().map_err(|e| e.to_string())?;
    if let Some(old) = current.take() {
        let _ = app.global_shortcut().unregister(old);
    }
    let Some(accelerator) = accelerator else { return Ok(None) };
    let shortcut = Shortcut::from_str(&accelerator).map_err(|_| "invalid".to_owned())?;
    // Shift alone would take a character from every text field.
    if !shortcut.mods.intersects(Modifiers::ALT | Modifiers::CONTROL | Modifiers::SUPER) {
        return Err("invalid".to_owned());
    }
    app.global_shortcut().register(shortcut).map_err(|_| "taken".to_owned())?;
    *current = Some(shortcut);
    Ok(wayland_command())
}

/// Close the box. `reveal` brings the main window forward (a row ran);
/// otherwise the app that was in front gets the focus back.
#[tauri::command]
pub fn ninja_dismiss<R: Runtime>(app: AppHandle<R>, reveal: bool) {
    dismiss(&app, reveal);
}

fn pressed<R: Runtime>(app: &AppHandle<R>) {
    // In the main window the key is Cmd+K: Ninja opens or closes there.
    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) && main.is_focused().unwrap_or(false) {
            let _ = app.emit_to("main", "pn-ninja-toggle", ());
            return;
        }
    }
    if open_box(app).is_some() {
        dismiss(app, false);
    } else {
        summon(app);
    }
}

/// The box when it is on screen.
fn open_box<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(LABEL).filter(|w| w.is_visible().unwrap_or(false))
}

/// Show the box. Also `--ninja` on a second launch, the key on Wayland.
pub fn summon<R: Runtime>(app: &AppHandle<R>) {
    front::remember();
    if let Some(window) = app.get_webview_window(LABEL) {
        open(app, &window);
        return;
    }
    // The first show makes the window, on a thread of its own: on Windows a
    // web view made inside the event loop's handler (the hotkey's) fails with
    // 0x8007139F (wry #583).
    let app = app.clone();
    std::thread::spawn(move || match build(&app) {
        Ok(window) => open(&app, &window),
        Err(e) => eprintln!("could not open the Ninja window: {e}"),
    });
}

fn open<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    place(app, window);
    show(window);
    let _ = app.emit_to("main", "pn-ninja-open", ());
    let _ = app.emit_to(LABEL, "pn-ninja-shown", ());
}

/// On macOS the box is a panel that takes the keys without making PrivacyNotes
/// the active app, as Spotlight does: activating the app would bring its main
/// window forward behind the box. Elsewhere only the box comes forward anyway.
#[cfg(target_os = "macos")]
fn show<R: Runtime>(window: &WebviewWindow<R>) {
    panel::show(window);
}

#[cfg(target_os = "windows")]
fn show<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// GNOME gives a new window the focus, but refuses it to a hidden window
/// shown again unless the request carries a current time (focus-stealing
/// prevention). So the box asks the X server for its time and presents
/// itself with it. Without an X11 window the time is 0, as before.
#[cfg(target_os = "linux")]
fn show<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.show();
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        use gtk::prelude::*;
        let Ok(gtk_window) = w.gtk_window() else { return };
        let time = gtk_window
            .window()
            .and_then(|g| g.downcast::<gdkx11::X11Window>().ok())
            .map(|x| gdkx11::functions::x11_get_server_time(&x))
            .unwrap_or(0);
        gtk_window.present_with_time(time);
    });
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?ninja-window=1".into()))
        .on_navigation(crate::navigation::guard(app));
    // Windows: every web view of the app shares one WebView2 environment, so
    // the box starts with the main window's browser options, or WebView2
    // refuses it (0x8007139F). A debug build adds the DevTools port there.
    #[cfg(windows)]
    let builder = match app.config().app.windows.iter().find(|w| w.label == "main").and_then(|w| w.additional_browser_args.clone()) {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    let window = builder
        .title("Ninja")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .build()?;
    #[cfg(target_os = "macos")]
    panel::convert(&window);
    Ok(window)
}

/// Centered on the screen of the pointer, a fifth of the way down.
fn place<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let cursor = app.cursor_position().ok();
    let monitors = app.available_monitors().unwrap_or_default();
    let monitor = cursor
        .and_then(|c| {
            monitors.into_iter().find(|m| {
                let (p, s) = (m.position(), m.size());
                c.x >= p.x as f64 && c.x < p.x as f64 + s.width as f64 && c.y >= p.y as f64 && c.y < p.y as f64 + s.height as f64
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let (p, s) = (monitor.position(), monitor.size());
    let x = p.x + (s.width as i32 - (WIDTH * scale) as i32) / 2;
    let y = p.y + s.height as i32 / 5;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn dismiss<R: Runtime>(app: &AppHandle<R>, reveal: bool) {
    let Some(window) = open_box(app) else { return };
    let _ = window.hide();
    let _ = app.emit_to(LABEL, "pn-ninja-hidden", ());
    let _ = app.emit_to("main", "pn-ninja-close", ());
    if reveal {
        crate::tray::reveal(app);
    } else {
        front::restore();
    }
}

/// The box closes when it loses the focus: a click outside, another app.
/// The main window going away takes the box with it, or a hidden box would
/// keep the app running with no window and no tray icon.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    match (window.label(), event) {
        (LABEL, WindowEvent::Focused(false)) => {
            if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
                let _ = window.app_handle().emit_to(LABEL, "pn-ninja-hidden", ());
                let _ = window.app_handle().emit_to("main", "pn-ninja-close", ());
            }
        }
        ("main", WindowEvent::Destroyed) => {
            if let Some(ninja) = window.app_handle().get_webview_window(LABEL) {
                let _ = ninja.destroy();
            }
        }
        _ => {}
    }
}

/// A second launch with `--ninja` opens the box (the Wayland key, N8).
pub fn wants_box(args: &[String]) -> bool {
    args.iter().any(|a| a == "--ninja")
}

/// The command a Wayland session binds, or None elsewhere.
fn wayland_command() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let wayland = std::env::var("XDG_SESSION_TYPE").map(|t| t == "wayland").unwrap_or(false)
            || std::env::var_os("WAYLAND_DISPLAY").is_some();
        if !wayland {
            return None;
        }
        // An AppImage runs from a mount that changes at every start: bind the file itself.
        let exe = std::env::var("APPIMAGE").ok().or_else(|| std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned()))?;
        let exe = if exe.contains(' ') { format!("\"{exe}\"") } else { exe };
        Some(format!("{exe} --ninja"))
    }
    #[cfg(not(target_os = "linux"))]
    None
}

/// The box as a non-activating panel (macOS). Only an NSPanel honors the
/// non-activating style, so the window's class changes once to a subclass of
/// NSPanel that may become key, the way launchers built on Tauri do it. The
/// object keeps its memory and its delegate; the change is refused when the
/// panel class would need more memory than the window has.
#[cfg(target_os = "macos")]
mod panel {
    use objc2::ffi::{class_getInstanceSize, object_getClass, object_setClass};
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::{Runtime, WebviewWindow};

    /// NSWindowStyleMaskNonactivatingPanel.
    const NON_ACTIVATING: usize = 1 << 7;
    /// canJoinAllSpaces | fullScreenAuxiliary: on the current desktop, also over a full-screen app.
    const COLLECTION: usize = (1 << 0) | (1 << 8);

    static CONVERTED: AtomicBool = AtomicBool::new(false);

    extern "C" fn yes(_: &AnyObject, _: Sel) -> Bool {
        Bool::YES
    }
    extern "C" fn no(_: &AnyObject, _: Sel) -> Bool {
        Bool::NO
    }

    fn class() -> Option<&'static AnyClass> {
        static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
        *CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"PNNinjaPanel", AnyClass::get(c"NSPanel")?)?;
            unsafe {
                builder.add_method(sel!(canBecomeKeyWindow), yes as extern "C" fn(_, _) -> _);
                builder.add_method(sel!(canBecomeMainWindow), no as extern "C" fn(_, _) -> _);
            }
            Some(builder.register())
        })
    }

    pub fn convert<R: Runtime>(window: &WebviewWindow<R>) {
        let Ok(ns) = window.ns_window() else { return };
        let ns = ns as usize;
        let _ = window.run_on_main_thread(move || unsafe {
            let obj = ns as *mut AnyObject;
            let Some(panel) = class() else {
                eprintln!("ninja panel: no NSPanel subclass");
                return;
            };
            let (need, have) = (class_getInstanceSize(panel), class_getInstanceSize(object_getClass(obj)));
            eprintln!("ninja panel: panel size {need}, window size {have}");
            if need > have {
                return;
            }
            object_setClass(obj, panel);
            let mask: usize = msg_send![obj, styleMask];
            let _: () = msg_send![obj, setStyleMask: mask | NON_ACTIVATING];
            // The style set after the window exists leaves the window
            // server's activation flag as it was; this sets it too.
            let prevents = sel!(_setPreventsActivation:);
            let responds: bool = msg_send![obj, respondsToSelector: prevents];
            if responds {
                let _: () = msg_send![obj, _setPreventsActivation: true];
            }
            eprintln!("ninja panel: prevents activation {responds}");
            let _: () = msg_send![obj, setHidesOnDeactivate: false];
            // Not part of the app's Hide (Cmd+H): a window of a hidden app
            // that comes forward unhides the app, and its main window with it.
            let _: () = msg_send![obj, setCanHide: false];
            let _: () = msg_send![obj, setBecomesKeyOnlyIfNeeded: false];
            let _: () = msg_send![obj, setCollectionBehavior: COLLECTION];
            CONVERTED.store(true, Ordering::SeqCst);
        });
    }

    /// Show the panel and give it the keys, with the app left inactive. A
    /// window that did not become a panel shows as before and activates the
    /// app. Queued after `convert` on the main thread, so the first show
    /// already finds the panel.
    pub fn show<R: Runtime>(window: &WebviewWindow<R>) {
        let Ok(ns) = window.ns_window() else { return };
        let ns = ns as usize;
        let _ = window.run_on_main_thread(move || unsafe {
            let obj = ns as *mut AnyObject;
            let _: () = msg_send![obj, makeKeyAndOrderFront: std::ptr::null::<AnyObject>()];
            if !CONVERTED.load(Ordering::SeqCst) {
                if let Some(app) = AnyClass::get(c"NSApplication") {
                    let app: *mut AnyObject = msg_send![app, sharedApplication];
                    let _: () = msg_send![app, activateIgnoringOtherApps: true];
                }
            }
        });
    }
}

/// The app in front before the box showed, to give the focus back to.
#[cfg(target_os = "macos")]
mod front {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::sync::Mutex;

    static PID: Mutex<Option<i32>> = Mutex::new(None);

    fn workspace() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSWorkspace")?;
        unsafe { msg_send![class, sharedWorkspace] }
    }

    pub fn remember() {
        let pid = workspace().and_then(|ws| {
            let app: Option<Retained<AnyObject>> = unsafe { msg_send![&*ws, frontmostApplication] };
            app.map(|a| unsafe { msg_send![&*a, processIdentifier] })
        });
        *PID.lock().unwrap() = pid.filter(|p: &i32| *p as u32 != std::process::id());
    }

    pub fn restore() {
        let Some(pid) = PID.lock().unwrap().take() else { return };
        let Some(class) = AnyClass::get(c"NSRunningApplication") else { return };
        let app: Option<Retained<AnyObject>> = unsafe { msg_send![class, runningApplicationWithProcessIdentifier: pid] };
        if let Some(app) = app {
            let _: bool = unsafe { msg_send![&*app, activateWithOptions: 0usize] };
        }
    }
}

#[cfg(target_os = "windows")]
mod front {
    use std::sync::Mutex;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

    /// The window handle as a number: a raw pointer is not Send.
    static WINDOW: Mutex<Option<usize>> = Mutex::new(None);

    pub fn remember() {
        let hwnd = unsafe { GetForegroundWindow() };
        *WINDOW.lock().unwrap() = (!hwnd.0.is_null()).then_some(hwnd.0 as usize);
    }

    pub fn restore() {
        if let Some(hwnd) = WINDOW.lock().unwrap().take() {
            let _ = unsafe { SetForegroundWindow(HWND(hwnd as *mut _)) };
        }
    }
}

/// Linux: the window manager gives the focus to the window under the box.
#[cfg(target_os = "linux")]
mod front {
    pub fn remember() {}
    pub fn restore() {}
}
