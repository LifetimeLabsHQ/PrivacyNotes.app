//! Linux AppImage host environment sanitization for `tauri-plugin-opener`.
//!
//! Inside an AppImage, `AppRun`, `apprun-hooks/*`, `AppRun.wrapped`,
//! `emoji_font.rs`, and `lib.rs` export bundled Ubuntu 22.04 library paths and
//! module directories (`LD_LIBRARY_PATH`, `GIO_MODULE_DIR`,
//! `GDK_PIXBUF_MODULE_FILE`, `GTK_PATH`, `FONTCONFIG_FILE`, etc.). When the
//! opener plugin spawns `xdg-open`, `gio`, or a host browser inheriting that
//! environment on a newer host (Ubuntu 24.04, Mint 22, Kubuntu 26.04), the
//! host binary loads mismatched bundled libraries and dies with a symbol
//! lookup error (`g_string_free_and_steal`, #806).
//!
//! `clean_host_env` restores the pre-AppImage host snapshot when
//! `pn-host-env.sh` ran, and strips AppImage mount paths and overrides even
//! without the snapshot (such as in the extracted VM harness).

use std::collections::HashMap;
use std::ffi::OsString;

fn to_map(pairs: Vec<(OsString, OsString)>) -> HashMap<String, String> {
    pairs
        .into_iter()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .collect()
}

#[test]
fn restores_saved_host_snapshot_and_strips_appimage_markers() {
    let polluted = vec![
        ("DISPLAY", ":0"),
        ("WAYLAND_DISPLAY", "wayland-0"),
        ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
        ("HOME", "/home/user"),
        ("XDG_RUNTIME_DIR", "/run/user/1000"),
        ("APPDIR", "/tmp/.mount_PrivaXYZ"),
        ("APPIMAGE", "/home/user/PrivacyNotes_x86_64.AppImage"),
        ("ARGV0", "./PrivacyNotes_x86_64.AppImage"),
        ("OWD", "/home/user"),
        ("PN_HOST_ENV_SAVED", "1"),
        ("PN_HOST_SET_PATH", "1"),
        ("PN_HOST_PATH", "/usr/local/bin:/usr/bin:/bin"),
        ("PN_HOST_SET_XDG_DATA_DIRS", "1"),
        ("PN_HOST_XDG_DATA_DIRS", "/usr/share/plasma:/usr/local/share:/usr/share"),
        ("PN_HOST_SET_LD_LIBRARY_PATH", "1"),
        ("PN_HOST_LD_LIBRARY_PATH", "/opt/user/lib"),
        ("LD_LIBRARY_PATH", "/tmp/.mount_PrivaXYZ/usr/lib/tls-fallback:/tmp/.mount_PrivaXYZ/usr/lib:/opt/user/lib"),
        ("PATH", "/tmp/.mount_PrivaXYZ/usr/bin:/usr/local/bin:/usr/bin:/bin"),
        ("XDG_DATA_DIRS", "/tmp/.mount_PrivaXYZ/usr/share:/usr/share:/usr/share/plasma:/usr/local/share:/usr/share"),
        ("GIO_MODULE_DIR", "/tmp/.mount_PrivaXYZ//usr/lib/gio/modules"),
        ("GDK_PIXBUF_MODULE_FILE", "/tmp/.mount_PrivaXYZ//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
        ("GTK_PATH", "/tmp/.mount_PrivaXYZ//usr/lib/gtk-3.0"),
        ("GTK_THEME", "Adwaita:dark"),
        ("GSETTINGS_SCHEMA_DIR", "/tmp/.mount_PrivaXYZ//usr/share/glib-2.0/schemas"),
        ("GST_PLUGIN_SYSTEM_PATH_1_0", "/tmp/.mount_PrivaXYZ/usr/lib/gstreamer-1.0"),
        ("PYTHONHOME", "/tmp/.mount_PrivaXYZ/usr/"),
        ("FONTCONFIG_FILE", "/home/user/.cache/app.privacynotes.appimage/emoji/fonts.conf"),
        ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
        ("PN_SET_WEBKIT_DISABLE_DMABUF", "1"),
    ];

    let cleaned = to_map(tauri_plugin_opener::clean_host_env(polluted));

    assert_eq!(cleaned.get("DISPLAY").map(String::as_str), Some(":0"));
    assert_eq!(cleaned.get("WAYLAND_DISPLAY").map(String::as_str), Some("wayland-0"));
    assert_eq!(
        cleaned.get("DBUS_SESSION_BUS_ADDRESS").map(String::as_str),
        Some("unix:path=/run/user/1000/bus")
    );
    assert_eq!(cleaned.get("HOME").map(String::as_str), Some("/home/user"));
    assert_eq!(cleaned.get("XDG_RUNTIME_DIR").map(String::as_str), Some("/run/user/1000"));
    assert_eq!(cleaned.get("PATH").map(String::as_str), Some("/usr/local/bin:/usr/bin:/bin"));
    assert_eq!(
        cleaned.get("XDG_DATA_DIRS").map(String::as_str),
        Some("/usr/share/plasma:/usr/local/share:/usr/share")
    );
    assert_eq!(cleaned.get("LD_LIBRARY_PATH").map(String::as_str), Some("/opt/user/lib"));

    for removed in [
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "OWD",
        "GIO_MODULE_DIR",
        "GDK_PIXBUF_MODULE_FILE",
        "GTK_PATH",
        "GTK_THEME",
        "GSETTINGS_SCHEMA_DIR",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "PYTHONHOME",
        "FONTCONFIG_FILE",
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "PN_HOST_ENV_SAVED",
        "PN_HOST_PATH",
        "PN_HOST_SET_PATH",
        "PN_SET_WEBKIT_DISABLE_DMABUF",
    ] {
        assert!(
            !cleaned.contains_key(removed),
            "{removed} must not leak into host launcher environment"
        );
    }
}

#[test]
fn strips_appdir_entries_without_saved_snapshot() {
    let polluted = vec![
        ("DISPLAY", ":99"),
        ("APPDIR", "/home/user/pn/appimage/squashfs-root"),
        (
            "LD_LIBRARY_PATH",
            "/home/user/pn/appimage/squashfs-root/usr/lib/tls-fallback:/home/user/pn/appimage/squashfs-root/usr/lib:/opt/custom/lib",
        ),
        (
            "PATH",
            "/home/user/pn/appimage/squashfs-root/usr/bin:/usr/bin:/bin",
        ),
        ("GIO_MODULE_DIR", "/home/user/pn/appimage/squashfs-root//usr/lib/gio/modules"),
        ("GDK_PIXBUF_MODULE_FILE", "/home/user/pn/appimage/squashfs-root/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
        ("GST_PLUGIN_SYSTEM_PATH_1_0", "/home/user/pn/appimage/squashfs-root/usr/lib/gstreamer-1.0"),
        ("FONTCONFIG_FILE", "/home/user/.cache/app.privacynotes.appimage/emoji/fonts.conf"),
    ];

    let cleaned = to_map(tauri_plugin_opener::clean_host_env(polluted));

    assert_eq!(cleaned.get("DISPLAY").map(String::as_str), Some(":99"));
    assert_eq!(cleaned.get("LD_LIBRARY_PATH").map(String::as_str), Some("/opt/custom/lib"));
    assert_eq!(cleaned.get("PATH").map(String::as_str), Some("/usr/bin:/bin"));
    for removed in [
        "APPDIR",
        "GIO_MODULE_DIR",
        "GDK_PIXBUF_MODULE_FILE",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "FONTCONFIG_FILE",
    ] {
        assert!(!cleaned.contains_key(removed), "{removed} should be stripped");
    }
}

#[test]
fn drops_ld_library_path_when_all_entries_belong_to_appimage() {
    let polluted = vec![
        ("APPDIR", "/tmp/.mount_PN1234"),
        (
            "LD_LIBRARY_PATH",
            "/tmp/.mount_PN1234/usr/lib/tls-fallback:/tmp/.mount_PN1234/usr/lib",
        ),
    ];

    let cleaned = to_map(tauri_plugin_opener::clean_host_env(polluted));
    assert!(!cleaned.contains_key("LD_LIBRARY_PATH"));
    assert!(!cleaned.contains_key("APPDIR"));
}

#[test]
fn preserves_non_appimage_deb_environment_and_user_fontconfig() {
    let deb_env = vec![
        ("DISPLAY", ":0"),
        ("LD_LIBRARY_PATH", "/opt/custom/lib"),
        ("FONTCONFIG_FILE", "/etc/fonts/custom.conf"),
        ("GTK_THEME", "Breeze"),
        ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
    ];

    let cleaned = to_map(tauri_plugin_opener::clean_host_env(deb_env));
    assert_eq!(cleaned.get("LD_LIBRARY_PATH").map(String::as_str), Some("/opt/custom/lib"));
    assert_eq!(cleaned.get("FONTCONFIG_FILE").map(String::as_str), Some("/etc/fonts/custom.conf"));
    assert_eq!(cleaned.get("GTK_THEME").map(String::as_str), Some("Breeze"));
    // User-set WEBKIT_DISABLE_DMABUF_RENDERER (no PN_SET_WEBKIT_DISABLE_DMABUF marker) stays intact.
    assert_eq!(
        cleaned.get("WEBKIT_DISABLE_DMABUF_RENDERER").map(String::as_str),
        Some("1")
    );
}
