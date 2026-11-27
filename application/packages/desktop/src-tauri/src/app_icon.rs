//! Alternative desktop app icons (Settings > System, GitHub #977).
//!
//! Signed desktop binaries cannot be patched in place (modifying a macOS `.app`
//! breaks notarization; modifying a Windows `.exe` breaks Authenticode), so
//! each platform updates both the running icon and its OS-level icon metadata:
//!
//!   - **macOS**: `NSApplication.applicationIconImage` updates the live Dock
//!     and Cmd+Tab immediately; `NSWorkspace.setIcon:forFile:options:` applies
//!     Finder custom-icon metadata on the `.app` bundle (outside the sealed
//!     `Contents/` tree, keeping the code signature intact). Re-applied on
//!     launch after self-updates.
//!   - **Windows**: `window.set_icon` (`WM_SETICON`) and `tray::update_icon`
//!     update running surfaces immediately; bundled `.ico` files are written
//!     into `<app local data>/icons/` and Start Menu / Desktop / pinned
//!     Taskbar `.lnk` shortcuts pointing at our executable have their
//!     `IconLocation` updated via `IShellLinkW` + `SHChangeNotify`.
//!   - **Linux**: `window.set_icon` (X11) and `tray::update_icon` update
//!     running surfaces; the chosen PNG is written to
//!     `~/.local/share/icons/hicolor/256x256/apps/` and a per-user `.desktop`
//!     override in `~/.local/share/applications/` points `Icon=` at it (for
//!     both `.deb` and AppImage installs) so Wayland docks and app menus match.
//!
//! Only a fixed allowlist of bundled preset IDs is accepted; no caller-supplied
//! path or image bytes cross IPC. Only the `main` window may invoke the command.

use std::sync::atomic::{AtomicU8, Ordering};
use tauri::image::Image;
use tauri::{AppHandle, Runtime, WebviewWindow};

/// Preset IDs shared with `packages/web/src/appIcon.ts` and
/// `packages/desktop/scripts/make-alt-icons.py`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum IconId {
    Default = 0,
    Dark = 1,
    Tinted = 2,
    Liquid = 3,
    NoteBoy = 4,
    PlainPage = 5,
    Calculator = 6,
    Journal = 7,
    Archive = 8,
    MinimalFold = 9,
}

impl IconId {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "default" => Some(Self::Default),
            "dark" => Some(Self::Dark),
            "tinted" => Some(Self::Tinted),
            "liquid" => Some(Self::Liquid),
            "note-boy" => Some(Self::NoteBoy),
            "plain-page" => Some(Self::PlainPage),
            "calculator" => Some(Self::Calculator),
            "journal" => Some(Self::Journal),
            "archive" => Some(Self::Archive),
            "minimal-fold" => Some(Self::MinimalFold),
            _ => None,
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", test))]
    pub fn slug(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Dark => "dark",
            Self::Tinted => "tinted",
            Self::Liquid => "liquid",
            Self::NoteBoy => "note-boy",
            Self::PlainPage => "plain-page",
            Self::Calculator => "calculator",
            Self::Journal => "journal",
            Self::Archive => "archive",
            Self::MinimalFold => "minimal-fold",
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Dark,
            2 => Self::Tinted,
            3 => Self::Liquid,
            4 => Self::NoteBoy,
            5 => Self::PlainPage,
            6 => Self::Calculator,
            7 => Self::Journal,
            8 => Self::Archive,
            9 => Self::MinimalFold,
            _ => Self::Default,
        }
    }

    /// 256x256 rounded tile PNG bytes for tray icons, Windows/Linux windows,
    /// and Linux `.desktop` icons. None for `Default` (restores bundle icon).
    fn tile_png(self) -> Option<&'static [u8]> {
        match self {
            Self::Default => None,
            Self::Dark => Some(include_bytes!("../icons/alt/tile/dark.png")),
            Self::Tinted => Some(include_bytes!("../icons/alt/tile/tinted.png")),
            Self::Liquid => Some(include_bytes!("../icons/alt/tile/liquid.png")),
            Self::NoteBoy => Some(include_bytes!("../icons/alt/tile/note-boy.png")),
            Self::PlainPage => Some(include_bytes!("../icons/alt/tile/plain-page.png")),
            Self::Calculator => Some(include_bytes!("../icons/alt/tile/calculator.png")),
            Self::Journal => Some(include_bytes!("../icons/alt/tile/journal.png")),
            Self::Archive => Some(include_bytes!("../icons/alt/tile/archive.png")),
            Self::MinimalFold => Some(include_bytes!("../icons/alt/tile/minimal-fold.png")),
        }
    }

    /// 512x512 macOS squircle PNG bytes (Apple 824px grid + soft shadow).
    #[cfg(target_os = "macos")]
    fn mac_png(self) -> Option<&'static [u8]> {
        match self {
            Self::Default => None,
            Self::Dark => Some(include_bytes!("../icons/alt/mac/dark.png")),
            Self::Tinted => Some(include_bytes!("../icons/alt/mac/tinted.png")),
            Self::Liquid => Some(include_bytes!("../icons/alt/mac/liquid.png")),
            Self::NoteBoy => Some(include_bytes!("../icons/alt/mac/note-boy.png")),
            Self::PlainPage => Some(include_bytes!("../icons/alt/mac/plain-page.png")),
            Self::Calculator => Some(include_bytes!("../icons/alt/mac/calculator.png")),
            Self::Journal => Some(include_bytes!("../icons/alt/mac/journal.png")),
            Self::Archive => Some(include_bytes!("../icons/alt/mac/archive.png")),
            Self::MinimalFold => Some(include_bytes!("../icons/alt/mac/minimal-fold.png")),
        }
    }

    /// Multi-resolution Windows ICO bytes for Start Menu / Desktop shortcuts.
    #[cfg(target_os = "windows")]
    fn win_ico(self) -> Option<&'static [u8]> {
        match self {
            Self::Default => None,
            Self::Dark => Some(include_bytes!("../icons/alt/win/dark.ico")),
            Self::Tinted => Some(include_bytes!("../icons/alt/win/tinted.ico")),
            Self::Liquid => Some(include_bytes!("../icons/alt/win/liquid.ico")),
            Self::NoteBoy => Some(include_bytes!("../icons/alt/win/note-boy.ico")),
            Self::PlainPage => Some(include_bytes!("../icons/alt/win/plain-page.ico")),
            Self::Calculator => Some(include_bytes!("../icons/alt/win/calculator.ico")),
            Self::Journal => Some(include_bytes!("../icons/alt/win/journal.ico")),
            Self::Archive => Some(include_bytes!("../icons/alt/win/archive.ico")),
            Self::MinimalFold => Some(include_bytes!("../icons/alt/win/minimal-fold.ico")),
        }
    }
}

static CURRENT: AtomicU8 = AtomicU8::new(IconId::Default as u8);

/// Outcome of applying an icon preset, used by Settings > System to show an
/// honest platform note when the closed/pinned icon could not update in place.
#[derive(serde::Serialize)]
pub struct AppIconResult {
    pub platform: &'static str,
    pub persisted: bool,
    pub note: Option<&'static str>,
}

/// Decoded icon for `tray.rs` and Windows/Linux window icons.
pub fn current_tray_icon<R: Runtime>(app: &AppHandle<R>) -> Option<Image<'static>> {
    icon_image(app, IconId::from_u8(CURRENT.load(Ordering::SeqCst)))
}

fn icon_image<R: Runtime>(app: &AppHandle<R>, id: IconId) -> Option<Image<'static>> {
    match id.tile_png() {
        Some(bytes) => Image::from_bytes(bytes).ok().map(Image::to_owned),
        None => app.default_window_icon().cloned().map(Image::to_owned),
    }
}

/// Apply one bundled app icon preset to the running app, tray, and OS launcher
/// metadata. Restricted to the `main` window.
#[tauri::command(async)]
pub fn set_app_icon(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<AppIconResult, String> {
    if window.label() != "main" {
        return Err("Only the main window may change the app icon.".to_owned());
    }
    let preset = IconId::parse(&id).ok_or_else(|| "Unknown app icon preset.".to_owned())?;
    CURRENT.store(preset as u8, Ordering::SeqCst);

    #[cfg(target_os = "macos")]
    let res = macos::apply(&app, preset)?;

    #[cfg(target_os = "windows")]
    let res = windows_icon::apply(&app, preset)?;

    #[cfg(target_os = "linux")]
    let res = linux::apply(&app, preset)?;

    crate::tray::update_icon(&app);
    Ok(res)
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::mpsc;

    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    use super::{AppIconResult, IconId};

    fn ns_image_from_png(bytes: &[u8]) -> Option<Retained<AnyObject>> {
        let data_cls = AnyClass::get(c"NSData")?;
        let img_cls = AnyClass::get(c"NSImage")?;
        // SAFETY: `bytes` is valid for `bytes.len()` bytes; `dataWithBytes:length:`
        // copies the buffer into a new NSData object, and `initWithData:` decodes
        // a valid PNG into an owned NSImage.
        unsafe {
            let data: Option<Retained<AnyObject>> = msg_send![
                data_cls,
                dataWithBytes: bytes.as_ptr().cast::<c_void>(),
                length: bytes.len()
            ];
            let data = data?;
            let alloc: *mut AnyObject = msg_send![img_cls, alloc];
            if alloc.is_null() {
                return None;
            }
            let raw: *mut AnyObject = msg_send![alloc, initWithData: &*data];
            Retained::from_raw(raw)
        }
    }

    pub fn apply(app: &AppHandle, preset: IconId) -> Result<AppIconResult, String> {
        let png = preset.mac_png();
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let outcome = apply_on_main(png);
            let _ = tx.send(outcome);
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|_| "Could not update the macOS app icon.".to_owned())?
    }

    fn apply_on_main(png: Option<&'static [u8]>) -> Result<AppIconResult, String> {
        let app_cls = AnyClass::get(c"NSApplication").ok_or("NSApplication unavailable")?;
        let ns_app: Retained<AnyObject> = unsafe { msg_send![app_cls, sharedApplication] };

        let image = match png {
            Some(bytes) => Some(ns_image_from_png(bytes).ok_or("Could not decode icon image.")?),
            None => None,
        };
        let img_ptr: *const AnyObject = image
            .as_deref()
            .map_or(ptr::null(), std::ptr::from_ref);

        // Live Dock and Cmd+Tab icon. Passing nil restores the bundle default.
        unsafe {
            let _: () = msg_send![&*ns_app, setApplicationIconImage: img_ptr];
        }

        // Persistent Finder / Dock / Spotlight custom icon on our own `.app` bundle.
        // Skipped when running unbundled (`tauri dev` bare binary) so we never
        // stamp a custom icon onto `target/debug/`.
        let bundle_path = AnyClass::get(c"NSBundle").and_then(|cls| unsafe {
            let main: Option<Retained<AnyObject>> = msg_send![cls, mainBundle];
            let path: Option<Retained<NSString>> = msg_send![&*main?, bundlePath];
            path
        });

        let Some(bundle_path) = bundle_path else {
            return Ok(AppIconResult {
                platform: "macos",
                persisted: false,
                note: Some("unbundled"),
            });
        };
        if !bundle_path.to_string().ends_with(".app") {
            return Ok(AppIconResult {
                platform: "macos",
                persisted: false,
                note: Some("unbundled"),
            });
        }

        let persisted = AnyClass::get(c"NSWorkspace").is_some_and(|cls| unsafe {
            let ws: Retained<AnyObject> = msg_send![cls, sharedWorkspace];
            let ok: Bool = msg_send![&*ws, setIcon: img_ptr, forFile: &*bundle_path, options: 0usize];
            ok.as_bool()
        });

        Ok(AppIconResult {
            platform: "macos",
            persisted,
            note: if persisted { None } else { Some("bundle_readonly") },
        })
    }
}

#[cfg(target_os = "windows")]
mod windows_icon {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use tauri::{AppHandle, Manager};
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READWRITE,
    };
    use windows::Win32::UI::Shell::{
        IShellLinkW, SHChangeNotify, ShellLink, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };

    use super::{icon_image, same_exe_name, AppIconResult, IconId};

    fn wide_nul(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn collect_lnk_files(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
                {
                    out.push(path);
                }
            } else if depth > 0 && path.is_dir() {
                collect_lnk_files(&path, depth - 1, out);
            }
        }
    }

    fn shortcut_candidates() -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let base = PathBuf::from(appdata);
            collect_lnk_files(&base.join(r"Microsoft\Windows\Start Menu\Programs"), 2, &mut out);
            collect_lnk_files(
                &base.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"),
                0,
                &mut out,
            );
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            collect_lnk_files(&PathBuf::from(profile).join("Desktop"), 0, &mut out);
        }
        out
    }

    fn update_shortcut(lnk: &Path, exe_name: &str, icon_path: &Path) -> bool {
        // SAFETY: COM is initialized on this thread by the caller; all wide
        // string buffers stay alive for the duration of each Win32 call.
        unsafe {
            let Ok(link): Result<IShellLinkW, _> =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            else {
                return false;
            };
            let Ok(persist) = link.cast::<IPersistFile>() else {
                return false;
            };
            let lnk_w = wide_nul(lnk.as_os_str());
            if persist.Load(PCWSTR(lnk_w.as_ptr()), STGM_READWRITE).is_err() {
                return false;
            }
            let mut target_buf = vec![0u16; 1024];
            if link
                .GetPath(&mut target_buf, std::ptr::null_mut(), 0)
                .is_err()
            {
                return false;
            }
            let end = target_buf
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(target_buf.len());
            let target = String::from_utf16_lossy(&target_buf[..end]);
            if !same_exe_name(&target, exe_name) {
                return false;
            }
            let icon_w = wide_nul(icon_path.as_os_str());
            if link.SetIconLocation(PCWSTR(icon_w.as_ptr()), 0).is_err() {
                return false;
            }
            persist.Save(PCWSTR::null(), true).is_ok()
        }
    }

    pub fn apply(app: &AppHandle, preset: IconId) -> Result<AppIconResult, String> {
        // Update every open window (title bar, Alt-Tab, active taskbar button).
        if let Some(img) = icon_image(app, preset) {
            for win in app.webview_windows().values() {
                let _ = win.set_icon(img.clone());
            }
        }

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_name = exe
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("privacynotes.exe")
            .to_owned();

        let icon_path = match preset.win_ico() {
            Some(ico_bytes) => {
                let dir = app
                    .path()
                    .app_local_data_dir()
                    .map_err(|e| e.to_string())?
                    .join("icons");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let file = dir.join(format!("{}.ico", preset.slug()));
                std::fs::write(&file, ico_bytes).map_err(|e| e.to_string())?;
                file
            }
            None => exe.clone(),
        };

        // Update matching Start Menu, Desktop, and pinned Taskbar `.lnk` files.
        let mut updated = 0usize;
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let should_uninit = hr.is_ok();
            for lnk in shortcut_candidates() {
                if update_shortcut(&lnk, &exe_name, &icon_path) {
                    updated += 1;
                }
            }
            if updated > 0 {
                SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
            }
            if should_uninit {
                CoUninitialize();
            }
        }

        Ok(AppIconResult {
            platform: "windows",
            persisted: updated > 0,
            note: Some(if updated > 0 {
                "windows_pinned"
            } else {
                "no_shortcuts"
            }),
        })
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use tauri::{AppHandle, Manager};

    use super::{
        desktop_entry_with_icon, has_icon_marker, icon_image, AppIconResult, IconId,
        DESKTOP_ICON_MARKER,
    };

    const SYSTEM_DESKTOP: &str = "/usr/share/applications/PrivacyNotes.desktop";
    const DESKTOP_ID: &str = "PrivacyNotes.desktop";
    const MARKDOWN_DESKTOP_ID: &str = "privacynotes-markdown.desktop";

    fn user_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .data_dir()
            .map_err(|_| "No user data directory available.".to_owned())
    }

    fn write_icon_png(data_dir: &Path, preset: IconId, bytes: &[u8]) -> Result<PathBuf, String> {
        let dir = data_dir.join("icons/hicolor/256x256/apps");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("privacynotes-alt-{}.png", preset.slug()));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path)
    }

    fn current_exec_line(app: &AppHandle) -> Result<String, String> {
        let exec = match app.env().appimage {
            Some(path) => PathBuf::from(path),
            None => std::env::current_exe().map_err(|e| e.to_string())?,
        };
        let escaped = crate::file_assoc::escape_exec_arg(&exec.to_string_lossy())
            .ok_or_else(|| "App path cannot be written into a desktop entry.".to_owned())?;
        Ok(format!("\"{escaped}\" %F"))
    }

    pub fn apply(app: &AppHandle, preset: IconId) -> Result<AppIconResult, String> {
        if let Some(img) = icon_image(app, preset) {
            for win in app.webview_windows().values() {
                let _ = win.set_icon(img.clone());
            }
        }

        let data_dir = user_data_dir(app)?;
        let apps_dir = data_dir.join("applications");
        std::fs::create_dir_all(&apps_dir).map_err(|e| e.to_string())?;
        let user_desktop = apps_dir.join(DESKTOP_ID);
        let md_desktop = apps_dir.join(MARKDOWN_DESKTOP_ID);
        let system_exists = Path::new(SYSTEM_DESKTOP).exists();

        match preset.tile_png() {
            Some(png_bytes) => {
                let icon_path = write_icon_png(&data_dir, preset, png_bytes)?;
                let icon_value = icon_path.to_string_lossy().into_owned();
                if icon_value.contains(['\n', '\r']) {
                    return Err("Icon path cannot be written into a desktop entry.".to_owned());
                }

                // Prefer copying the packaged .deb desktop entry so Categories,
                // MimeType, and StartupWMClass stay identical and override it cleanly.
                let base = if system_exists {
                    std::fs::read_to_string(SYSTEM_DESKTOP).ok()
                } else {
                    std::fs::read_to_string(&user_desktop).ok()
                };

                let next = match base {
                    Some(existing) => desktop_entry_with_icon(&existing, &icon_value),
                    None => {
                        let exec = current_exec_line(app)?;
                        format!(
                            "{DESKTOP_ICON_MARKER}\n\
                             [Desktop Entry]\n\
                             Type=Application\n\
                             Name=PrivacyNotes\n\
                             Exec={exec}\n\
                             StartupWMClass=privacynotes\n\
                             Icon={icon_value}\n\
                             Terminal=false\n\
                             Categories=Office;TextEditor;\n"
                        )
                    }
                };
                std::fs::write(&user_desktop, next).map_err(|e| e.to_string())?;

                if let Ok(md_text) = std::fs::read_to_string(&md_desktop) {
                    let _ = std::fs::write(&md_desktop, desktop_entry_with_icon(&md_text, &icon_value));
                }
            }
            None => {
                if let Ok(existing) = std::fs::read_to_string(&user_desktop) {
                    if system_exists && has_icon_marker(&existing) {
                        let _ = std::fs::remove_file(&user_desktop);
                    } else {
                        let _ = std::fs::write(
                            &user_desktop,
                            desktop_entry_with_icon(&existing, "privacynotes"),
                        );
                    }
                }
                if let Ok(md_text) = std::fs::read_to_string(&md_desktop) {
                    let _ = std::fs::write(&md_desktop, desktop_entry_with_icon(&md_text, "privacynotes"));
                }
            }
        }

        let _ = Command::new("update-desktop-database").arg(&apps_dir).status();
        let _ = Command::new("gtk-update-icon-cache")
            .args(["-f", "-t"])
            .arg(data_dir.join("icons/hicolor"))
            .status();

        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        Ok(AppIconResult {
            platform: "linux",
            persisted: true,
            note: if wayland { Some("wayland_relaunch") } else { None },
        })
    }
}

/// Marker line placed at the top of a `.desktop` override we created so
/// restoring `Default` knows it is safe to remove our override over `/usr/share`.
#[cfg(any(target_os = "linux", test))]
const DESKTOP_ICON_MARKER: &str = "# Managed by PrivacyNotes app icon";

#[cfg(any(target_os = "linux", test))]
fn has_icon_marker(text: &str) -> bool {
    text.lines().any(|l| l.trim() == DESKTOP_ICON_MARKER)
}

/// Replace `Icon=` inside `[Desktop Entry]` (or append it if missing) and mark
/// the file as managed by PrivacyNotes app icon.
#[cfg(any(target_os = "linux", test))]
fn desktop_entry_with_icon(source: &str, icon_value: &str) -> String {
    let mut out = Vec::new();
    let mut seen_marker = false;
    let mut in_entry = false;
    let mut replaced = false;

    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed == DESKTOP_ICON_MARKER {
            seen_marker = true;
            out.push(line.to_owned());
            continue;
        }
        if trimmed.starts_with('[') {
            if in_entry && !replaced {
                out.push(format!("Icon={icon_value}"));
                replaced = true;
            }
            in_entry = trimmed == "[Desktop Entry]";
            out.push(line.to_owned());
            continue;
        }
        if in_entry && trimmed.starts_with("Icon=") {
            out.push(format!("Icon={icon_value}"));
            replaced = true;
            continue;
        }
        out.push(line.to_owned());
    }
    if in_entry && !replaced {
        out.push(format!("Icon={icon_value}"));
    }
    if !seen_marker {
        out.insert(0, DESKTOP_ICON_MARKER.to_owned());
    }
    let mut body = out.join("\n");
    body.push('\n');
    body
}

/// Case-insensitive filename match so Windows shortcut updates only ever touch
/// `.lnk` files targeting our own executable.
#[cfg(any(target_os = "windows", test))]
fn same_exe_name(target_path: &str, expected_exe_name: &str) -> bool {
    let target_name = target_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("");
    !target_name.is_empty() && target_name.eq_ignore_ascii_case(expected_exe_name)
}

#[cfg(test)]
mod tests {
    use super::{
        desktop_entry_with_icon, has_icon_marker, same_exe_name, IconId, DESKTOP_ICON_MARKER,
    };
    use tauri::image::Image;

    const ALL_SLUGS: [&str; 10] = [
        "default",
        "dark",
        "tinted",
        "liquid",
        "note-boy",
        "plain-page",
        "calculator",
        "journal",
        "archive",
        "minimal-fold",
    ];

    #[test]
    fn parses_exact_allowlist_and_refuses_unknown_or_paths() {
        for slug in ALL_SLUGS {
            let id = IconId::parse(slug).expect(slug);
            assert_eq!(id.slug(), slug);
        }
        for bad in ["", "DEFAULT", "../icon", "/etc/passwd", "plain-page.png", "custom"] {
            assert!(IconId::parse(bad).is_none(), "{bad} should be rejected");
        }
    }

    #[test]
    fn every_non_default_tile_png_decodes_cleanly() {
        for slug in ALL_SLUGS {
            let id = IconId::parse(slug).unwrap();
            match id {
                IconId::Default => assert!(id.tile_png().is_none()),
                other => {
                    let bytes = other.tile_png().expect(slug);
                    let img = Image::from_bytes(bytes).expect(slug);
                    assert_eq!(img.width(), 256, "{slug}");
                    assert_eq!(img.height(), 256, "{slug}");
                }
            }
        }
    }

    #[test]
    fn rewrites_linux_desktop_icon_without_touching_other_sections() {
        let src = "[Desktop Entry]\nType=Application\nName=PrivacyNotes\nExec=privacynotes %F\nIcon=privacynotes\nStartupWMClass=privacynotes\n\n[Desktop Action New]\nIcon=other\n";
        let updated = desktop_entry_with_icon(src, "/home/u/.local/share/icons/calc.png");
        assert!(has_icon_marker(&updated));
        assert!(updated.contains("Icon=/home/u/.local/share/icons/calc.png\n"));
        // Action section icon must stay untouched.
        assert!(updated.contains("[Desktop Action New]\nIcon=other\n"));
        assert_eq!(updated.matches(DESKTOP_ICON_MARKER).count(), 1);
    }

    #[test]
    fn inserts_icon_line_when_desktop_entry_had_none() {
        let src = "[Desktop Entry]\nType=Application\nName=PrivacyNotes\n";
        let updated = desktop_entry_with_icon(src, "/tmp/a.png");
        assert!(updated.contains("Icon=/tmp/a.png\n"));
    }

    #[test]
    fn windows_shortcut_matcher_only_matches_our_exe() {
        assert!(same_exe_name(
            r"C:\Users\alice\AppData\Local\PrivacyNotes\privacynotes.exe",
            "privacynotes.exe",
        ));
        assert!(same_exe_name(
            r"C:\Users\alice\pn\PrivacyNotes.EXE",
            "privacynotes.exe",
        ));
        assert!(!same_exe_name(r"C:\Windows\System32\calc.exe", "privacynotes.exe"));
        assert!(!same_exe_name("", "privacynotes.exe"));
    }
}
