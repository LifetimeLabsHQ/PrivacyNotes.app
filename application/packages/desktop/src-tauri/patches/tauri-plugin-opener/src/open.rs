// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Types and functions related to shell.

use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    path::Path,
};

/// Environment variables mutated by AppImage runtimes (`AppRun`, `AppRun.wrapped`,
/// `linuxdeploy-plugin-gtk.sh`, `linuxdeploy-plugin-gstreamer.sh`, `pn-tls-fallback.sh`)
/// or our own AppImage startup hooks (`emoji_font.rs`, `lib.rs`).
///
/// When `pn-host-env.sh` ran at the top of `AppRun`, `PN_HOST_ENV_SAVED=1` is set
/// and each variable below has its pre-AppImage host value saved under
/// `PN_HOST_SET_<NAME>=1` + `PN_HOST_<NAME>=<value>` (absent if unset on the host).
const HOST_RESTORED_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "PATH",
    "XDG_DATA_DIRS",
    "GSETTINGS_SCHEMA_DIR",
    "GI_TYPELIB_PATH",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "GTK_IM_MODULE_FILE",
    "GTK_THEME",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_PATH_1_0",
    "GST_PLUGIN_SCANNER_1_0",
    "GST_PTP_HELPER_1_0",
    "GST_REGISTRY_REUSE_PLUGIN_SCANNER",
    "QT_PLUGIN_PATH",
    "PERLLIB",
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONDONTWRITEBYTECODE",
    "FONTCONFIG_FILE",
    "WEBKIT_DISABLE_DMABUF_RENDERER",
];

/// Colon-separated path list variables that may contain AppImage mount entries
/// when running without `pn-host-env.sh` (e.g., extracted dev harness).
const APPIMAGE_LIST_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "PATH",
    "XDG_DATA_DIRS",
    "QT_PLUGIN_PATH",
    "PERLLIB",
    "PYTHONPATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_PATH_1_0",
    "GI_TYPELIB_PATH",
];

/// Single-value variables that AppImage hooks overwrite with bundle paths.
const APPIMAGE_SINGLE_VARS: &[&str] = &[
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "GTK_IM_MODULE_FILE",
    "GTK_THEME",
    "GSETTINGS_SCHEMA_DIR",
    "GST_PLUGIN_SCANNER_1_0",
    "GST_PTP_HELPER_1_0",
    "GST_REGISTRY_REUSE_PLUGIN_SCANNER",
    "PYTHONHOME",
    "PYTHONDONTWRITEBYTECODE",
];

/// AppImage runtime metadata variables that must never leak to host launchers.
const APPIMAGE_META_VARS: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "APPIMAGE_EXTRACT_AND_RUN",
    "PN_HOST_ENV_SAVED",
    "PN_SET_WEBKIT_DISABLE_DMABUF",
];

fn is_appimage_path_entry(entry: &str, appdir: Option<&str>) -> bool {
    if entry.is_empty() {
        return false;
    }
    if let Some(dir) = appdir {
        let trimmed = dir.trim_end_matches('/');
        if !trimmed.is_empty()
            && (entry == trimmed || entry.starts_with(&format!("{trimmed}/")))
        {
            return true;
        }
    }
    entry.contains("/.mount_") || entry.ends_with("/usr/lib/tls-fallback")
}

fn strip_appimage_entries(value: &str, appdir: Option<&str>) -> Option<String> {
    let kept: Vec<&str> = value
        .split(':')
        .filter(|segment| !segment.is_empty() && !is_appimage_path_entry(segment, appdir))
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(":"))
    }
}

fn is_our_emoji_fontconfig(value: &str) -> bool {
    value.ends_with("/emoji/fonts.conf") && value.contains("app.privacynotes")
}

/// Returns a clean environment for spawning host Linux utilities (`xdg-open`,
/// `gio`, browsers) from inside an AppImage without leaking bundled Ubuntu 22.04
/// libraries, GTK/GIO/GStreamer module paths, or fontconfig overrides.
///
/// Outside an AppImage (no `APPDIR`, no `PN_HOST_ENV_SAVED`, no AppImage mount
/// paths in `LD_LIBRARY_PATH`), every host variable stays intact and only our
/// own process-local markers/overrides are stripped.
pub fn clean_host_env<I, K, V>(vars: I) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<OsString>,
    V: Into<OsString>,
{
    let map: HashMap<OsString, OsString> = vars
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();

    let host_saved = map
        .get(OsStr::new("PN_HOST_ENV_SAVED"))
        .and_then(|v| v.to_str())
        == Some("1");
    let appdir = map
        .get(OsStr::new("APPDIR"))
        .and_then(|v| v.to_str())
        .map(str::to_owned);
    let we_set_dmabuf = map
        .get(OsStr::new("PN_SET_WEBKIT_DISABLE_DMABUF"))
        .and_then(|v| v.to_str())
        == Some("1");

    let in_appimage = host_saved
        || appdir.is_some()
        || map
            .get(OsStr::new("LD_LIBRARY_PATH"))
            .and_then(|v| v.to_str())
            .is_some_and(|ld| ld.split(':').any(|s| is_appimage_path_entry(s, None)));

    let restored_set: HashSet<&str> = HOST_RESTORED_VARS.iter().copied().collect();
    let list_set: HashSet<&str> = APPIMAGE_LIST_VARS.iter().copied().collect();
    let single_set: HashSet<&str> = APPIMAGE_SINGLE_VARS.iter().copied().collect();
    let meta_set: HashSet<&str> = APPIMAGE_META_VARS.iter().copied().collect();

    let mut out: Vec<(OsString, OsString)> = Vec::with_capacity(map.len());

    for (key, val) in &map {
        let Some(name) = key.to_str() else {
            out.push((key.clone(), val.clone()));
            continue;
        };

        if meta_set.contains(name)
            || name.starts_with("PN_HOST_")
            || name.starts_with("PN_HOST_SET_")
        {
            continue;
        }

        if host_saved && restored_set.contains(name) {
            // Re-added below from the saved host snapshot if it was originally set.
            continue;
        }

        if name == "WEBKIT_DISABLE_DMABUF_RENDERER" && we_set_dmabuf {
            continue;
        }

        if name == "FONTCONFIG_FILE"
            && val.to_str().is_some_and(is_our_emoji_fontconfig)
        {
            continue;
        }

        if in_appimage && !host_saved {
            if single_set.contains(name) {
                continue;
            }
            if list_set.contains(name) {
                if let Some(raw) = val.to_str() {
                    if let Some(cleaned) = strip_appimage_entries(raw, appdir.as_deref()) {
                        out.push((key.clone(), OsString::from(cleaned)));
                    }
                    continue;
                }
            }
        }

        out.push((key.clone(), val.clone()));
    }

    if host_saved {
        for &name in HOST_RESTORED_VARS {
            let set_key = OsString::from(format!("PN_HOST_SET_{name}"));
            if map.get(&set_key).and_then(|v| v.to_str()) == Some("1") {
                let val_key = OsString::from(format!("PN_HOST_{name}"));
                let orig = map.get(&val_key).cloned().unwrap_or_default();
                out.push((OsString::from(name), orig));
            }
        }
    }

    out
}

#[cfg(target_os = "linux")]
fn spawn_clean_command(cmd: &mut std::process::Command) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt as _;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let env = clean_host_env(std::env::vars_os());
    cmd.env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Start the launcher in its own session so closing PrivacyNotes does not
    // send SIGHUP to the browser process it spawned.
    unsafe {
        cmd.pre_exec(|| {
            let _ = libc::setsid();
            Ok(())
        });
    }

    let mut child = cmd.spawn()?;
    // Wait briefly so immediate failures (missing handler, exit 3/4/127) are
    // caught and fall through to the next opener or the D-Bus portal instead
    // of silently returning Ok.
    let deadline = Instant::now() + Duration::from_millis(250);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                return Err(std::io::Error::other(format!(
                    "launcher exited with {status}"
                )));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(err) => return Err(err),
        }
    }
}

#[cfg(target_os = "linux")]
fn open_uri_with_portal(uri: &str) -> crate::Result<()> {
    use zbus::zvariant::{OwnedObjectPath, Value};

    #[zbus::proxy(
        interface = "org.freedesktop.portal.OpenURI",
        default_service = "org.freedesktop.portal.Desktop",
        default_path = "/org/freedesktop/portal/desktop"
    )]
    trait OpenUriPortal {
        #[zbus(name = "OpenURI")]
        fn open_uri(
            &self,
            parent_window: &str,
            uri: &str,
            options: HashMap<&str, Value<'_>>,
        ) -> zbus::Result<OwnedObjectPath>;
    }

    let connection = zbus::blocking::Connection::session()?;
    let proxy = OpenUriPortalProxyBlocking::new(&connection)?;
    let _handle = proxy.open_uri("", uri, HashMap::new())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_linux<P: AsRef<OsStr>, S: AsRef<str>>(path: P, with: Option<S>) -> crate::Result<()> {
    let target = path.as_ref();
    if let Some(program) = with {
        let mut cmd = ::open::with_command(target, program.as_ref());
        return spawn_clean_command(&mut cmd).map_err(Into::into);
    }

    let mut last_err: Option<std::io::Error> = None;
    for mut cmd in ::open::commands(target) {
        match spawn_clean_command(&mut cmd) {
            Ok(()) => return Ok(()),
            Err(err) => last_err = Some(err),
        }
    }

    if let Some(uri) = target.to_str().filter(|s| url::Url::parse(s).is_ok()) {
        if open_uri_with_portal(uri).is_ok() {
            return Ok(());
        }
    }

    Err(last_err
        .unwrap_or_else(|| std::io::Error::other("no Linux URL launcher succeeded"))
        .into())
}

pub(crate) fn open<P: AsRef<OsStr>, S: AsRef<str>>(path: P, with: Option<S>) -> crate::Result<()> {
    #[cfg(target_os = "linux")]
    {
        open_linux(path, with)
    }
    #[cfg(not(target_os = "linux"))]
    {
        match with {
            Some(program) => ::open::with_detached(path, program.as_ref()),
            None => ::open::that_detached(path),
        }
        .map_err(Into::into)
    }
}

/// Opens URL with the program specified in `with`, or system default if `None`.
///
/// ## Platform-specific:
///
/// - **Android / iOS**: Always opens using default program.
///
/// # Examples
///
/// ```rust,no_run
/// tauri::Builder::default()
///   .setup(|app| {
///     // open the given URL on the system default browser
///     tauri_plugin_opener::open_url("https://github.com/tauri-apps/tauri", None::<&str>)?;
///     Ok(())
///   });
/// ```
pub fn open_url<P: AsRef<str>, S: AsRef<str>>(url: P, with: Option<S>) -> crate::Result<()> {
    let url = url.as_ref();
    open(url, with)
}

/// Opens path with the program specified in `with`, or system default if `None`.
///
/// ## Platform-specific:
///
/// - **Android / iOS**: Always opens using default program.
///
/// # Examples
///
/// ```rust,no_run
/// tauri::Builder::default()
///   .setup(|app| {
///     // open the given URL on the system default explorer
///     tauri_plugin_opener::open_path("/path/to/file", None::<&str>)?;
///     Ok(())
///   });
/// ```
pub fn open_path<P: AsRef<Path>, S: AsRef<str>>(path: P, with: Option<S>) -> crate::Result<()> {
    let path = path.as_ref();
    if with.is_none() {
        // Returns an IO error if not exists, and besides `exists()` is a shorthand for `metadata()`
        _ = path.metadata()?;
    }
    open(path, with)
}
