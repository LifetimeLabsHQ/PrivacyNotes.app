/// Native biometric gate: Touch ID / Face ID on macOS + iOS, Windows Hello on
/// Windows, BiometricPrompt on Android. `native_biometric` is set by build.rs
/// for exactly those targets; Linux falls through to the WebAuthn path.
/// Spec: docs/contrib/biometric-unlock.md, backlog #101 (LAContext must run on the main thread; Windows Hello must not)
#[cfg(native_biometric)]
mod biometric;

/// The device key on Linux: the Secret Service (GNOME Keyring, KDE Wallet).
/// The other platforms keep theirs in `biometric`.
/// Spec: docs/internal/plans/device-bound-phrase-key.md (section 3)
#[cfg(target_os = "linux")]
mod device_key_linux;

/// The AppImage's own color emoji font, so no emoji reaches the COLRv1 code
/// that crashes its WebKitGTK on a newer FreeType (GitHub #863).
#[cfg(target_os = "linux")]
mod emoji_font;

/// Who the OS opens Markdown files with, and pointing it at us on the two
/// platforms that permit it. Desktop only: neither mobile OS has user-settable
/// file associations. Spec: docs/internal/specs/markdown-folder.md (section 11)
#[cfg(desktop)]
mod file_assoc;

/// Native print for the two platforms whose webview refuses to print itself:
/// macOS and iOS both render in WKWebView, which never implements JavaScript's
/// `window.print()`. Windows (WebView2) and Linux (WebKitGTK) do implement it
/// and keep using the frontend's own print path.
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod print;

/// The cover iOS photographs in place of the notes when the app leaves the
/// screen. Android does the same job with a window property of its own, set
/// from MainActivity.kt, so nothing here is compiled for it.
/// Spec: docs/internal/specs/app-switcher-privacy-screen.md
mod privacy_screen;

/// No previous, next and Done bar above the iOS keyboard: the note editor's
/// format bar sits there (GitHub #533).
#[cfg(target_os = "ios")]
mod keyboard_accessory;
/// Tap the iOS status bar to take the note or list to the top (GitHub #617).
#[cfg(target_os = "ios")]
mod status_bar_tap;
/// The iOS page stays put when the keyboard opens; only columns scroll (GitHub #767).
#[cfg(target_os = "ios")]
mod scroll_pin;

/// The Windows title bar painted in the app's theme colors.
/// Spec: docs/contrib/color-themes.md (section 1, the Windows title bar)
#[cfg(desktop)]
mod title_bar;
#[cfg(desktop)]
mod tray;
/// Alternative desktop app icons (Settings > System, GitHub #977).
#[cfg(desktop)]
mod app_icon;
/// Ninja from any app: the global key and the small window it opens.
/// Spec: docs/internal/plans/ninja-anywhere-694.md
#[cfg(desktop)]
mod ninja;
/// Open at login: the sign-in entry and its `--autostart` start.
/// Spec: docs/internal/plans/ninja-anywhere-694.md (section 7)
#[cfg(desktop)]
mod autostart;

/// Every window stays on the app's own pages (beta issue 85).
mod navigation;
/// A policy on every script the app serves, so its workers run under one.
mod script_csp;

/// Links, text and files other apps shared into this one, waiting for the
/// unlocked app to take them. Compiled everywhere so its tests run on the
/// host; only the mobile builds expose its commands.
/// Spec: docs/internal/specs/share-into-app.md
mod pasteboard;
use pasteboard::pasteboard_pictures;
mod share_inbox;
#[cfg(mobile)]
use share_inbox::{
    share_catalog_set, share_inbox_clear, share_inbox_list, share_inbox_read, share_inbox_remove,
    share_limit_set,
};
/// AVIF pictures decoded for the Linux webview, which cannot (GitHub #687).
/// Spec: docs/contrib/gotchas.md (AppImage AVIF)
#[cfg(desktop)]
mod avif;
#[cfg(desktop)]
use avif::decode_avif;
/// The web clipper's download, on every native platform.
/// Spec: docs/internal/specs/web-clipper-stage1.md (section 3.1)
mod clip_fetch;
use clip_fetch::clip_fetch;
/// Where automatic backups go: the folder the person picked, held on this
/// side, and the staged, checked write into it.
/// Spec: docs/internal/plans/auto-backup.md (section 7)
mod backup_dest;
/// Install for `privacynotes`, the command line tool (Settings > CLI).
/// Spec: docs/internal/plans/agent-cli.md (section 3.7)
#[cfg(desktop)]
mod cli_install;
#[cfg(desktop)]
use cli_install::{cli_status, install_cli};
/// The capped read of a file opened from outside the app (beta issue 168).
#[cfg(desktop)]
mod opened_file;
/// The pictures of a Markdown file opened without its folder.
#[cfg(desktop)]
mod file_pictures;
/// A forgotten Markdown folder leaves the persisted fs scope (beta #214 item 2).
#[cfg(desktop)]
mod folder_scope;
/// The asset protocol reads only what the fs runtime scope holds.
#[cfg(desktop)]
mod asset_scope;
/// The files of Settings > Plugins in the app's data folder (plugin_files.rs).
#[cfg(desktop)]
mod plugin_files;

/// A second launch that asks for the Ninja box. Never one that carries the
/// app's own scheme: on Windows the single-instance forwarder joins argv with
/// a pipe and splits it again, so the link `privacynotes:x|--ninja` arrives
/// as two arguments, the second of them `--ninja` (beta issue 166).
#[cfg(desktop)]
fn wants_ninja_box(args: &[String]) -> bool {
    ninja::wants_box(args) && !opened_file::carries_app_link(args)
}

/// Which app the OS currently opens Markdown files with. Read-only, and cheap
/// enough to re-ask on every window focus - the association can change while we
/// are running, because another installer can take it.
#[tauri::command(async)]
#[cfg(desktop)]
fn markdown_assoc_status(app: tauri::AppHandle) -> file_assoc::AssocStatus {
    file_assoc::status(&app)
}

/// Make us the default Markdown app. Only ever reached from an explicit click:
/// nothing claims the association at install time or at launch.
#[tauri::command(async)]
#[cfg(desktop)]
fn markdown_assoc_claim(app: tauri::AppHandle) -> Result<(), String> {
    file_assoc::claim(&app)
}

/// Who opens `.txt` files, or nothing on Linux, where the row is not offered.
#[tauri::command(async)]
#[cfg(desktop)]
fn text_assoc_status(app: tauri::AppHandle) -> Option<file_assoc::AssocStatus> {
    file_assoc::text_status(&app)
}

/// Make us the default `.txt` app. macOS only, and only from an explicit click.
#[tauri::command(async)]
#[cfg(desktop)]
fn text_assoc_claim(app: tauri::AppHandle) -> Result<(), String> {
    file_assoc::text_claim(&app)
}

/// Open the OS screen where the user sets this themselves. Windows only, where
/// the OS reserves the choice for the user and answers `settable: false` above.
#[tauri::command(async)]
#[cfg(desktop)]
fn markdown_assoc_open_os_settings() -> Result<(), String> {
    file_assoc::open_os_settings()
}

/// Whether the process holding the single-instance rendezvous is this app.
///
/// The desktop app answers "am I already running?" by seeing whether anything
/// replies at a meeting point, and on macOS that meeting point is a Unix
/// socket. The patched plugin (`patches/tauri-plugin-single-instance`, beta
/// #174) keeps it in this user's own app data folder,
/// `~/Library/Application Support/<identifier>/si.sock`, not in `/tmp`, which
/// every account on the machine can write to. This check stays as a second
/// line: the plugin's rule is that whatever replies there IS
/// the running app: it hands that listener this launch's arguments and its
/// working directory, then exits. So anything that gets there first stops the
/// app from ever starting and reads the path of the file somebody tried to
/// open with it.
///
/// Two questions, because one test cannot answer both. A socket owned by
/// another account is not ours and never can be, since nobody else can create
/// one owned by us. A socket owned by THIS user still proves nothing, because
/// a program running as the person owns whatever it creates, so the listener
/// is asked which executable it is and the answer has to be this one.
///
/// The order matters. Nothing there at all means the plugin creates the
/// socket and owns it. A socket nothing listens on is a leftover from a
/// crash, which the plugin removes before taking the rendezvous over. Past
/// that point something is listening, and anything short of proof is refused:
/// the plugin stays unregistered and the app starts. Losing second-launch
/// forwarding for one run is a far smaller cost than a run that never
/// happens.
///
/// The connection this makes carries nothing. Arguments and the working
/// directory travel on the plugin's own connect, which happens after this has
/// decided, so a listener that fails the test learns only that somebody
/// looked.
#[cfg(all(desktop, target_os = "macos"))]
fn rendezvous_is_ours(config: &tauri::Config) -> bool {
    let Some(home) = std::env::var_os("HOME") else { return false };
    let socket = std::path::Path::new(&home)
        .join("Library/Application Support")
        .join(&config.identifier)
        .join("si.sock");
    rendezvous_holder_matches(
        &socket.to_string_lossy(),
        std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .ok(),
    )
}

/// The decision itself, with both of its inputs handed in so a test can put
/// a real socket at a real path and ask about a real process.
#[cfg(all(desktop, target_os = "macos"))]
fn rendezvous_holder_matches(path: &str, expected: Option<std::path::PathBuf>) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::UnixStream;

    match std::fs::symlink_metadata(path) {
        Err(_) => return true,
        Ok(meta) => {
            if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
                return false;
            }
        }
    }

    let Ok(stream) = UnixStream::connect(path) else {
        return true;
    };

    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let asked = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            std::ptr::addr_of_mut!(pid).cast(),
            &mut len,
        )
    };
    if asked != 0 || pid <= 0 {
        return false;
    }

    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let written =
        unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if written <= 0 {
        return false;
    }
    buf.truncate(written as usize);

    // Both sides are resolved before they are compared, so one of them
    // arriving through a symbolic link cannot read as a different program.
    let peer = String::from_utf8(buf)
        .ok()
        .and_then(|p| std::fs::canonicalize(p).ok());
    peer.is_some() && peer == expected
}

/// The rendezvous decision, every branch of it, against real sockets in a
/// real directory and a real listening process.
///
/// The positive case is the one worth having: the listener is this test
/// binary, so the peer the kernel names IS the executable asked about, which
/// is the same proof the app makes of a running copy of itself.
#[cfg(all(test, desktop, target_os = "macos"))]
mod rendezvous_tests {
    use super::rendezvous_holder_matches;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;

    fn me() -> Option<PathBuf> {
        std::env::current_exe().and_then(std::fs::canonicalize).ok()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("pn-rendezvous-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn nothing_there_is_ours_to_take() {
        let path = scratch("absent.sock");
        assert!(rendezvous_holder_matches(path.to_str().unwrap(), me()));
    }

    #[test]
    fn a_plain_file_is_not_a_rendezvous() {
        let path = scratch("plain");
        std::fs::write(&path, b"").unwrap();
        assert!(!rendezvous_holder_matches(path.to_str().unwrap(), me()));
    }

    #[test]
    fn a_symbolic_link_is_not_a_rendezvous() {
        let target = scratch("link-target.sock");
        let link = scratch("link");
        let _listener = UnixListener::bind(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        // The link points at a socket this process is listening on, so only
        // reading the link itself rather than its target refuses it.
        assert!(!rendezvous_holder_matches(link.to_str().unwrap(), me()));
    }

    #[test]
    fn a_socket_nobody_listens_on_is_a_leftover() {
        let path = scratch("stale.sock");
        drop(UnixListener::bind(&path).unwrap());
        // The file outlives the listener, and the plugin removes it before it
        // takes the rendezvous over.
        assert!(rendezvous_holder_matches(path.to_str().unwrap(), me()));
    }

    #[test]
    fn a_listener_that_is_this_executable_is_ours() {
        let path = scratch("live.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        assert!(rendezvous_holder_matches(path.to_str().unwrap(), me()));
    }

    #[test]
    fn a_listener_that_is_another_executable_is_not() {
        let path = scratch("impostor.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        assert!(!rendezvous_holder_matches(
            path.to_str().unwrap(),
            Some(PathBuf::from("/bin/sh")),
        ));
    }

    #[test]
    fn an_unknowable_executable_is_not_ours() {
        let path = scratch("unknown.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        // Nothing to compare against is not the same as a match, and the
        // wrong answer here hands a stranger this launch's arguments.
        assert!(!rendezvous_holder_matches(path.to_str().unwrap(), None));
    }
}

/// Linux keeps the rendezvous on the session bus and Windows in a named
/// mutex, and neither is reachable from another account, so there is nothing
/// here to check.
#[cfg(all(desktop, not(target_os = "macos")))]
fn rendezvous_is_ours(_config: &tauri::Config) -> bool {
    true
}

/// The launch environment names that make WebKitGTK open an inspector
/// server. A build without `devtools` drops both at start.
#[cfg(all(target_os = "linux", not(feature = "devtools")))]
const LINUX_INSPECTOR_ENV: [&str; 2] = ["WEBKIT_INSPECTOR_SERVER", "WEBKIT_INSPECTOR_HTTP_SERVER"];

/// True when NVIDIA's own kernel driver is loaded (the closed one or the
/// open one: both are the `nvidia` module, and both pair with NVIDIA's EGL).
/// nouveau is not it: that is Mesa, like AMD and Intel.
#[cfg(target_os = "linux")]
fn nvidia_driver_loaded() -> bool {
    std::path::Path::new("/sys/module/nvidia").exists()
        || std::path::Path::new("/proc/driver/nvidia/version").exists()
}

/// The arguments to restart with when a launch argument after argv[0] is
/// not valid Unicode, or None when there is nothing to drop.
///
/// argv[0] is never examined. Every argument a restart passes on is a
/// `String`, so the restarted process always gets None here and a restart
/// can never lead to another.
#[cfg(all(desktop, unix))]
fn restart_without_non_unicode_args(
    args: impl Iterator<Item = std::ffi::OsString>,
) -> Option<Vec<String>> {
    let mut kept = Vec::new();
    let mut dropped = false;
    for arg in args.skip(1) {
        match arg.into_string() {
            Ok(arg) => kept.push(arg),
            Err(_) => dropped = true,
        }
    }
    dropped.then_some(kept)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // reqwest is built with `rustls-no-provider` (the clipper pins its own
    // provider in clip_fetch.rs), and that feature reaches every reqwest
    // client in the build, Tauri's own included: the dev-server proxy of a
    // phone dev build, and the updater. A client built with no process-wide
    // provider panics, so the app installs ring as that provider before any
    // client exists. An Err only means one was installed already.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // On Linux and macOS, no launch argument after argv[0] reaches the
    // builder unless it is valid Unicode. The deep-link plugin (every Linux
    // launch) and the single-instance plugin (a second launch, on Linux and
    // macOS) read `std::env::args()` inside `Builder::build`, and it panics
    // on an argument that will not convert, which a Linux file name is free
    // to be. Such an argument is dropped and the process restarts without
    // it: that file does not open, and the app does. `exec` returns only
    // when the restart failed, and the launch then goes on as it would have.
    // A failed `current_exe()` skips the restart, and the launch goes on the
    // same way.
    // Windows is left out: an argument there fails to convert only when it
    // carries an unpaired UTF-16 surrogate.
    #[cfg(all(desktop, unix))]
    if let Some(kept) = restart_without_non_unicode_args(std::env::args_os()) {
        if let Ok(exe) = std::env::current_exe() {
            use std::os::unix::process::CommandExt;
            let err = std::process::Command::new(exe).args(kept).exec();
            eprintln!("could not restart without the non-Unicode arguments: {err}");
        }
    }

    // WebKitGTK's DMA-BUF renderer can paint nothing with NVIDIA's own
    // driver: the window opens but stays blank. There the app turns it off.
    // Everywhere else it stays on: the fallback copies every frame through
    // the CPU, and on AMD and Intel the app lagged badly with it (#806).
    // Must run before any GTK code. A value the user set always wins.
    // Spec: docs/contrib/gotchas.md (Linux blank window / WebKitGTK DMA-BUF)
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && nvidia_driver_loaded() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("PN_SET_WEBKIT_DISABLE_DMABUF", "1");
    }

    // A build without `devtools` has no inspector, but WebKitGTK still opens
    // one when the launch environment names an inspector server. Drop both
    // names before any thread or GTK call, so only a devtools build can
    // have an inspector.
    // Spec: docs/contrib/gotchas.md (Linux inspector environment variables)
    #[cfg(all(target_os = "linux", not(feature = "devtools")))]
    for name in LINUX_INSPECTOR_ENV {
        std::env::remove_var(name);
    }

    // Built here rather than at the end of the chain: the rendezvous check
    // below reads the identifier out of it.
    let context = tauri::generate_context!();

    // Every color emoji in the AppImage comes from its own bitmap font, or a
    // COLRv1 emoji kills the web process on a host with FreeType 2.13 or
    // newer (#863). Before any thread or GTK call: fontconfig reads the
    // variable once.
    // Spec: docs/contrib/gotchas.md (Color emoji crash the Linux AppImage)
    #[cfg(target_os = "linux")]
    emoji_font::use_bundled_emoji_font(&context.config().identifier);

    let builder = tauri::Builder::default();

    // single-instance MUST be the first plugin registered. With the
    // deep-link feature it forwards a privacynotes:// link (a note shortcut,
    // `privacynotes://note/<id>`) or a file path caught by a second launch to
    // the running instance, instead of letting that copy start fresh. The
    // desktop sign-in no longer returns through the scheme: it ends on a page
    // that shows a code the person pastes (web/auth-desktop-page.ts).
    // Desktop only.
    #[cfg(desktop)]
    let builder = if !rendezvous_is_ours(context.config()) {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        // `--ninja` is the Ninja key on Wayland, bound in the system settings.
        if wants_ninja_box(&args) {
            ninja::summon(app);
            return;
        }
        // A second launch carrying a file path is a double-click while we are
        // already running. The args were discarded here until file
        // associations existed; now they are the whole point of the callback.
        opened_file::queue_args(args.into_iter().map(Into::into), Some(cwd.into()));
        // Also out of the tray, where the window is hidden (tray.rs).
        tray::reveal(app);
        opened_file::notify(app);
        }))
    };

    let builder = builder
        // Disable the plugin's injected window click interceptor: App.tsx and
        // editorLinks.ts are the single owner of link clicks across every
        // platform, preventing double-opens (#701) and app-origin leaks (#169).
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        // Save As dialog + file write. The webview has no download handler, so
        // exports/backups/QR saves go through these instead of <a download>.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Calendar reminders on every platform: scheduled with the OS on a
        // phone, shown from the app's own timer on a desktop.
        // Spec: docs/internal/specs/calendar-pillar-spec.md (section 8)
        .plugin(tauri_plugin_notification::init());

    // Self-updater is desktop-only; iOS/Android update via their stores.
    // process plugin powers the updater's "Restart" button (relaunch()).
    // window-state persists the main window's size/position across launches;
    // the About window stays out so it always opens centered at its fixed size.
    // persisted-scope restores the fs scope the folder picker, Save As and
    // `take_pending_opens` widened in an earlier run. The capability grants
    // carry no static allow, so without it a picked folder is
    // refused after every restart. It must come after the fs plugin.
    // Spec: docs/internal/plans/desktop-fs-casefold.md (section 2, option A)
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            // VISIBLE stays out: the main window starts hidden and
            // `tray::show` shows it, and a restored "visible" would show
            // it before the page paints.
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["about", "ninja"])
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(ninja::plugin());

    // Native in-app purchase (StoreKit on iOS, Play Billing on Android). One
    // plugin covers both; the desktop DMG never compiles it. The macOS App
    // Store build adds it for macOS under the `mas` feature (MAS track).
    // Spec: docs/internal/billing-integration.md (also drives Android storage-tier upgrades via subscriptionReplacementMode)
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_iap::init());

    // One position reading for a note's place. Loading it asks nothing: the
    // permission question comes from the first "Use my current location" tap.
    // Spec: docs/internal/specs/note-location.md (section 3)
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_geolocation::init());

    // The backup folder on a phone (plugins/backup-folder). No capability
    // entry: only src/backup_dest.rs reaches it, from Rust.
    // Spec: docs/internal/plans/auto-backup.md (section 7)
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_backup_folder::init());

    // Apple Vision (Text in pictures) and VisionKit (Scan a page) for
    // Settings > Plugins; the page calls it (capabilities/apple-ml.json).
    // Spec: docs/internal/plans/plugins.md (section 6.7)
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_apple_ml::init());

    // In-app OAuth (ASWebAuthenticationSession sheet). iOS only - see the
    // Cargo.toml entry for why Android stays on the system browser.
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_auth_session::init());

    // The Android half of the biometric gate (src/biometric.rs). The other three
    // platforms call their OS from Rust and need no plugin; Android's API is
    // Kotlin, so the prompt arrives as one. It is registered without a
    // capability entry on purpose: the webview must not be able to invoke it,
    // and does not need to, because our own two commands call it from Rust.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_biometric::init());
    // The bound key's Keystore half (plugins/biometric-key), registered the
    // same way: no capability entry, reached only from src/biometric.rs.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_biometric_key::init());

    // App-defined commands. build.rs declares each one in an app manifest, so
    // a window calls only the ones a capability grants it: the main window
    // every one (capabilities/app-commands.json), the Ninja box ninja_dismiss
    // (ninja.json), the About window none (beta issue 167). A command added
    // here goes into APP_COMMANDS in build.rs and app-commands.json too, or
    // the web view's call is refused. The biometric pair is registered on every platform and
    // answers "unavailable" where no OS gate exists (Linux), so the frontend can
    // always ask and fall back to WebAuthn on a false. The updater command is
    // desktop-only, which is the only reason there are two lists.
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        can_self_update,
        is_scoop_install,
        updater_target_info,
        prepare_update_restart,
        biometric_available,
        biometric_authenticate,
        biometric_key_create,
        biometric_key_open,
        biometric_key_delete,
        device_key_create,
        device_key_open,
        biometric_tpm_missing,
        print_html,
        opened_file::take_pending_opens,
        opened_file::read_opened_file,
        file_pictures::grant_file_picture,
        folder_scope::forget_folder_scope,
        markdown_assoc_status,
        markdown_assoc_claim,
        markdown_assoc_open_os_settings,
        text_assoc_status,
        text_assoc_claim,
        set_privacy_screen,
        set_capture_block,
        set_title_bar_colors,
        pasteboard_pictures,
        clip_fetch,
        decode_avif,
        cli_status,
        install_cli,
        tray::set_tray_mode,
        app_icon::set_app_icon,
        ninja::set_ninja_shortcut,
        ninja::ninja_dismiss,
        autostart::autostart_enabled,
        autostart::set_autostart,
        autostart::finish_login_start,
        backup_dest::backup_dest_pick,
        backup_dest::backup_dest_status,
        backup_dest::backup_dest_begin,
        backup_dest::backup_dest_chunk,
        backup_dest::backup_dest_finish,
        backup_dest::backup_dest_abort,
        backup_dest::backup_dest_exists,
        backup_dest::backup_dest_delete,
        backup_dest::backup_dest_reveal,
        backup_dest::backup_dest_clear,
        backup_dest::backup_dest_metered,
        plugin_files::plugin_files_list,
        plugin_files::plugin_file_read,
        plugin_files::plugin_file_write,
        plugin_files::plugin_file_delete,
        plugin_files::plugin_files_clear,
        plugin_files::plugin_files_reveal
    ]);
    // Close and minimize go to the tray while that switch is on (tray.rs).
    // The Ninja box closes when it loses the focus (ninja.rs).
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        tray::on_window_event(window, event);
        ninja::on_window_event(window, event);
    });
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        biometric_available,
        biometric_authenticate,
        biometric_key_create,
        biometric_key_open,
        biometric_key_delete,
        device_key_create,
        device_key_open,
        print_html,
        set_privacy_screen,
        set_capture_block,
        share_inbox_list,
        share_inbox_read,
        share_inbox_remove,
        share_inbox_clear,
        share_limit_set,
        share_catalog_set,
        pasteboard_pictures,
        clip_fetch,
        backup_dest::backup_dest_pick,
        backup_dest::backup_dest_status,
        backup_dest::backup_dest_begin,
        backup_dest::backup_dest_chunk,
        backup_dest::backup_dest_finish,
        backup_dest::backup_dest_abort,
        backup_dest::backup_dest_exists,
        backup_dest::backup_dest_delete,
        backup_dest::backup_dest_reveal,
        backup_dest::backup_dest_clear,
        backup_dest::backup_dest_metered
    ]);

    // A load can replace the web view's content view, so the iOS keyboard bar
    // is taken off again after each one. The status bar tap rides along: it
    // needs the web view, and adding it again does nothing; so does the page
    // scroll pin (scroll_pin.rs). On desktop the
    // first finished load shows the main window (`tray::show`).
    // One handler for both: a second `on_page_load` replaces the first.
    #[cfg(any(target_os = "ios", desktop))]
    let builder = builder.on_page_load(|webview, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            #[cfg(target_os = "ios")]
            {
                keyboard_accessory::hide_in(webview);
                status_bar_tap::listen_in(webview);
                scroll_pin::pin_in(webview);
            }
            // A start at sign-in waits for the web view (tray.rs, `decide`).
            #[cfg(desktop)]
            if webview.label() == "main" {
                use tauri::Manager;
                tray::show(webview.app_handle(), tray::Ask::PageLoaded);
            }
        }
    });

    // WebKitGTK denies a camera request that no handler answers, and wry
    // connects `permission-request` only when one is set, so without this the
    // QR sign-in scanner is dead on Linux. Allow the camera for the app's own
    // pages only; every other kind, and any page that is not ours, keeps
    // WebKit's default (deny). The microphone stays denied: its one user, the
    // recorder, cannot run in this WebKitGTK, which has no MediaRecorder. The
    // other platforms grant capture in wry or ask the OS, so they stay as they
    // were.
    // Spec: docs/contrib/gotchas.md (Camera or microphone dead with no prompt)
    #[cfg(target_os = "linux")]
    let builder = builder.on_permission_request(|webview, kind| {
        use tauri::webview::{PermissionKind, PermissionResponse};
        match kind {
            PermissionKind::Camera if serves_app_origin(&webview) => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        }
    });

    builder
        .setup(|app| {
            // The main window is built here and not from tauri.conf.json, whose
            // entry says `create: false`, so a desktop build can start it hidden.
            // A webview paints white until the page loads, and that showed as a
            // white window at every start (#665). By the time the page has
            // loaded, initTheme has set the theme on <html>, so the window
            // appears in the app's own background. Mobile keeps a visible
            // window: its launch screen covers the load already.
            {
                let config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|w| w.label == "main")
                    .cloned()
                    .ok_or("tauri.conf.json has no main window")?;
                let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                    .on_navigation(navigation::guard(app.handle()))
                    .on_web_resource_request(script_csp::hook(app.handle()));
                #[cfg(desktop)]
                let builder = builder.visible(false);
                builder.build()?;
                // A page that never finishes loading must still leave a window
                // to look at.
                #[cfg(desktop)]
                {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        tray::show(&handle, tray::Ask::Timer);
                    });
                }
            }
            // The webview keeps its storage, the wrapped phrase and the key
            // beside it included, in the app's own folders. Linux creates a
            // folder readable by every account on the computer (0755 under
            // the usual umask), so they are owner-only, and set again at every
            // start so a folder an earlier build made is closed too. macOS and
            // Windows keep a user's app data to that user already; there this
            // changes nothing.
            #[cfg(all(unix, desktop))]
            {
                use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
                use tauri::Manager;
                let paths = app.path();
                for dir in [paths.app_local_data_dir(), paths.app_data_dir(), paths.app_cache_dir(), paths.app_config_dir()]
                    .into_iter()
                    .flatten()
                {
                    let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir);
                    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
                }
            }
            // An installed `privacynotes` runs the copy in the app's data folder; bring
            // it to this version off the main thread (cli_install.rs).
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || cli_install::refresh_at_launch(&handle));
            }
            // A Markdown folder forgotten in this run stays out of the saved
            // fs scope after every later grant (folder_scope.rs).
            #[cfg(desktop)]
            folder_scope::watch(app.handle());
            // The asset protocol has no static allow: it reads what the fs
            // scope holds, restored by persisted-scope above, and every later
            // grant (asset_scope.rs).
            #[cfg(desktop)]
            asset_scope::watch(app.handle());
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    disable_browser_accelerator_keys(&window);
                }
                autostart::refresh(app.handle());
            }
            // An entry an earlier build wrote names the AppImage unquoted.
            #[cfg(target_os = "linux")]
            {
                autostart::refresh(app.handle());
            }
            // Bring the main window to the foreground on launch. After an
            // updater relaunch() the new process can otherwise come up behind
            // other windows, making it look like the restart did nothing.
            #[cfg(desktop)]
            {
                use tauri::Manager;
                // Cold start from a double-click on Windows and Linux: the path
                // is in our own argv. macOS does not use argv for this - it
                // sends an Apple Event, handled by RunEvent::Opened below.
                //
                // `args_os` and not `args`: `std::env::args()` panics on any
                // argument that is not valid Unicode, and a Linux file name is a
                // byte string with no encoding guarantee at all. This read is
                // not what keeps such a launch alive: the plugins call
                // `std::env::args()` inside `Builder::build`, before `setup`,
                // so on Linux and macOS `run()` drops those arguments and
                // restarts before the builder exists. A path that will not
                // convert is dropped rather than lossily mangled: the frontend
                // takes a path as a `String`, so a replacement-character path
                // could not be read anyway and would only fail later, in a
                // place that does not name the cause.
                //
                // A relative path is read from the folder the start was typed
                // in, as a second launch's is (beta #200, item 1). Skip replayed
                // launch arguments after an explicit updater restart (NSIS /ARGS
                // and relaunch() forward the original process argv).
                if consume_update_restart_marker(app.handle()) {
                    RELAUNCH_SUPPRESSED_ARGS.store(true, std::sync::atomic::Ordering::SeqCst);
                } else {
                    opened_file::queue_args(std::env::args_os(), std::env::current_dir().ok());
                }
                // A start at sign-in must not raise the window (autostart.rs).
                if let Some(window) = app.get_webview_window("main").filter(|_| !autostart::started_at_login()) {
                    let _ = window.set_focus();
                }
            }

            // Linux is the only desktop platform where nothing registers the
            // privacynotes:// scheme at install time: macOS gets it from the
            // bundle's Info.plist via LaunchServices and Windows from the NSIS
            // installer, but an AppImage is a loose file no desktop
            // environment ever indexes, so the system has no handler for the
            // scheme and every deep link is dropped with no error anywhere -
            // native Google sign-in hands the browser a link that goes
            // nowhere. Register it against this
            // binary on every launch: that covers the AppImage, repairs the
            // handler after it is moved or renamed, and keeps a .deb install
            // pointed at itself. Off-thread because it shells out to
            // update-desktop-database and xdg-mime, and a failure (neither
            // tool installed) must never block startup.
            // Spec: docs/contrib/gotchas.md (Linux registers privacynotes:// at runtime)
            #[cfg(target_os = "linux")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(e) = handle.deep_link().register_all() {
                        eprintln!("failed to register the privacynotes:// scheme: {e}");
                    }
                });
            }

            // Swap the predefined About item in the app menu for our own,
            // which opens a styled About window (rendered by the web bundle)
            // instead of the unstylable system About panel. macOS only:
            // Windows/Linux builds have no app menu and keep their behavior.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                use tauri::Manager;

                let menu = Menu::default(app.handle())?;
                if let Some(MenuItemKind::Submenu(app_submenu)) = menu.items()?.into_iter().next()
                {
                    // Item 0 of the default app submenu is the predefined About.
                    app_submenu.remove_at(0)?;
                    let about = MenuItem::with_id(
                        app.handle(),
                        "about",
                        "About PrivacyNotes",
                        true,
                        None::<&str>,
                    )?;
                    app_submenu.insert(&about, 0)?;
                }
                // Cmd+W in the main window closes the open item's tab, and the
                // page handles it, so the menu's Close Window moves to
                // Shift+Cmd+W. A predefined item keeps its own key, so both
                // copies (File and Window) are swapped for one of ours. The
                // About window closes on Cmd+W by itself (AboutWindow.tsx).
                // Spec: docs/internal/specs/keyboard-shortcuts.md (decision D4)
                for item in menu.items()? {
                    let MenuItemKind::Submenu(submenu) = item else { continue };
                    let items = submenu.items()?;
                    for (i, entry) in items.iter().enumerate() {
                        let MenuItemKind::Predefined(p) = entry else { continue };
                        if p.text()? != "Close Window" {
                            continue;
                        }
                        submenu.remove_at(i)?;
                        let close = MenuItem::with_id(
                            app.handle(),
                            "close-window",
                            "Close Window",
                            true,
                            Some("Shift+CmdOrCtrl+W"),
                        )?;
                        submenu.insert(&close, i)?;
                    }
                }
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| match event.id().as_ref() {
                    "about" => open_about_window(app),
                    "close-window" => {
                        if let Some(window) = app
                            .webview_windows()
                            .into_values()
                            .find(|w| w.is_focused().unwrap_or(false))
                        {
                            let _ = window.close();
                        }
                    }
                    _ => {}
                });
            }

            // Start watching for the app leaving the screen. Registered here
            // rather than on the frontend's first push, because the observers
            // have to be in place before the first backgrounding and the push
            // arrives only once the web bundle has booted. They read a flag
            // that is false until it does, so an early transition covers
            // nothing, which is the right answer at that point.
            // Spec: docs/internal/specs/app-switcher-privacy-screen.md
            privacy_screen::observe();

            let _ = &app;
            Ok(())
        })
        .build(context)
        .expect("error while building PrivacyNotes")
        .run(|_app, _event| {
            // macOS delivers a file open as an Apple Event, never in argv, so
            // this is the ONLY place a double-click arrives there. Reaching it
            // is why the builder ends in build()+run() rather than run() alone.
            // Spec: docs/internal/specs/markdown-folder.md (section 11)
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                opened_file::queue_urls(urls);
                opened_file::notify(_app);
            }
        });
}

/// Whether this executable was unpacked by Scoop rather than installed by our NSIS
/// installer. Scoop keeps each app under `<root>\apps\<name>\<version>\` and treats that
/// path as its record of what is installed, so a build written into it out of band makes
/// the folder name a lie: `scoop list` keeps reporting the old version and the next
/// `scoop update` puts it back. The root is relocatable, so honour SCOOP and SCOOP_GLOBAL
/// before falling back to the default layout.
/// Spec: docs/internal/windows-release.md (Scoop is off the homepage; a Scoop install is offered winget)
#[cfg(all(desktop, target_os = "windows"))]
fn unpacked_by_scoop() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        // Nothing to match against. Answering "not Scoop" keeps the ordinary NSIS
        // install self-updating, which is the far more common case.
        return false;
    };
    let exe = exe.to_string_lossy().to_lowercase();
    for var in ["SCOOP", "SCOOP_GLOBAL"] {
        let Some(root) = std::env::var_os(var) else { continue };
        let root = root.to_string_lossy().to_lowercase();
        let root = root.trim_end_matches('\\');
        if !root.is_empty() && exe.starts_with(&format!("{root}\\apps\\")) {
            return true;
        }
    }
    exe.contains("\\scoop\\apps\\")
}

/// Whether this install can self-update via the Tauri updater.
///
/// Two formats cannot, for the same underlying reason: the updater runs an installer
/// that writes somewhere other than where this copy lives. A Linux .deb sits in
/// root-owned /usr, so the AppImage payload fails to apply every launch; the APPIMAGE
/// env var the AppImage runtime sets is what tells the two apart. A Scoop install sits
/// in Scoop's own directory while our NSIS installer targets %LOCALAPPDATA%\PrivacyNotes,
/// so self-updating would leave a second copy the user's shortcut never points at.
/// The frontend nudges instead of installing whenever this is false.
/// Spec: docs/internal/linux-release.md (deb ships beside the AppImage; only the AppImage self-updates)
/// WebView2 keeps a browser's own keys unless told otherwise: F5 and Ctrl+R
/// reload the whole app, Ctrl+P prints the page, Alt+Left goes back, Ctrl+F
/// opens the browser's find. The app owns its keys, so they are turned off.
/// Editing keys (copy, paste, cut, select all, undo) are not browser keys in
/// WebView2's sense and keep working.
/// Spec: docs/internal/specs/keyboard-shortcuts.md (decision D8)
#[cfg(target_os = "windows")]
fn disable_browser_accelerator_keys(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows::core::Interface;
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
}

/// Whether this PC offers Windows no TPM, so Windows Hello keeps the key of
/// biometric unlock in software. No prompt. False on every other desktop.
/// Spec: docs/internal/plans/hello-tpm-status.md (section 3)
#[cfg(desktop)]
#[tauri::command]
async fn biometric_tpm_missing() -> bool {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(biometric::tpm_missing).await.unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[cfg(desktop)]
#[tauri::command]
fn can_self_update() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").is_some()
    }
    #[cfg(target_os = "windows")]
    {
        !unpacked_by_scoop()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        true
    }
}

/// Whether the nudge shown in place of a self-update should name Scoop. Both blocked
/// formats answer false to can_self_update, and their advice is opposite: a .deb user
/// fetches a newer package from the website, while a Scoop user must NOT, because the
/// download there is the NSIS installer that creates the second copy. Scoop is off the
/// homepage, so that user is handed the command that moves the install to winget.
#[cfg(desktop)]
#[tauri::command]
fn is_scoop_install() -> bool {
    #[cfg(target_os = "windows")]
    {
        unpacked_by_scoop()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[cfg(desktop)]
static RELAUNCH_SUPPRESSED_ARGS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Compiled target slug and whether background updates should only download and
/// defer `install()` until the user clicks Restart (always on Windows, and on
/// macOS when the `.app` bundle or its parent directory is not writable by the
/// current user so background checks never pop an unsolicited `osascript`
/// administrator password prompt).
#[cfg(desktop)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterTargetInfo {
    target: &'static str,
    install_on_restart: bool,
    relaunch_suppressed_args: bool,
}

#[cfg(all(desktop, target_os = "macos"))]
fn path_is_writable(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(all(desktop, target_os = "macos"))]
fn macos_bundle_writable() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return true;
    };
    let Some(bundle) = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
    else {
        return true;
    };
    let Some(parent) = bundle.parent() else {
        return false;
    };
    path_is_writable(bundle) && path_is_writable(parent)
}

#[cfg(desktop)]
#[tauri::command]
fn updater_target_info() -> UpdaterTargetInfo {
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", _) => "windows-x86_64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("macos", _) => "darwin-aarch64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", _) => "linux-x86_64",
        _ => "linux-x86_64",
    };
    let install_on_restart = {
        #[cfg(target_os = "windows")]
        {
            true
        }
        #[cfg(target_os = "macos")]
        {
            !macos_bundle_writable()
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            false
        }
    };
    UpdaterTargetInfo {
        target,
        install_on_restart,
        relaunch_suppressed_args: RELAUNCH_SUPPRESSED_ARGS
            .load(std::sync::atomic::Ordering::SeqCst),
    }
}

#[cfg(desktop)]
const UPDATE_RESTART_MARKER: &str = "update-relaunch";
#[cfg(desktop)]
const UPDATE_RESTART_MARKER_TTL_SECS: u64 = 30 * 60;

#[cfg(desktop)]
#[derive(serde::Serialize, serde::Deserialize)]
struct UpdateRestartMarker {
    ts: u64,
    args: Vec<String>,
}

#[cfg(desktop)]
fn current_cli_args() -> Vec<String> {
    std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}

#[cfg(desktop)]
fn update_restart_marker_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(UPDATE_RESTART_MARKER))
}

/// Suppress replayed CLI arguments only when a fresh marker exists AND the
/// incoming argv matches the previous launch's argv. A user double-clicking a
/// new `.md` file after a failed installer still opens that file normally.
#[cfg(desktop)]
fn consume_update_restart_marker<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(path) = update_restart_marker_path(app) else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let _ = std::fs::remove_file(&path);
    let Ok(marker) = serde_json::from_str::<UpdateRestartMarker>(&raw) else {
        return false;
    };
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return false;
    };
    let now = now.as_secs();
    let fresh = marker.ts <= now.saturating_add(60)
        && now.saturating_sub(marker.ts) <= UPDATE_RESTART_MARKER_TTL_SECS;
    fresh && !marker.args.is_empty() && marker.args == current_cli_args()
}

/// Persist desktop window geometry before an updater exit (Windows `install()`
/// calls `std::process::exit(0)` and skips `RunEvent::Exit`) and arm/clear a
/// short-lived marker carrying the current argv so replayed CLI file/deep-link
/// arguments are ignored on restart.
#[cfg(desktop)]
#[tauri::command]
fn prepare_update_restart<R: tauri::Runtime>(app: tauri::AppHandle<R>, active: bool) {
    if active {
        use tauri_plugin_window_state::{AppHandleExt, StateFlags};
        let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
    }
    let Some(path) = update_restart_marker_path(&app) else {
        return;
    };
    if !active {
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        let marker = UpdateRestartMarker {
            ts: now.as_secs(),
            args: current_cli_args(),
        };
        if let Ok(json) = serde_json::to_string(&marker) {
            let _ = std::fs::write(&path, json);
        }
    }
}

/// Whether this device can gate on the OS biometric (Touch ID, Face ID, Hello,
/// or an Android fingerprint or face).
///
/// The webview's own check is useless in a native build: embedded webviews expose
/// no WebAuthn platform authenticator, so `isUserVerifyingPlatformAuthenticator-
/// Available()` resolves false even on a Mac with Touch ID, which is why
/// Security > Biometric Lock claimed "not available on this device". False where
/// the OS has no gate to offer (Linux); the frontend then falls back to the
/// WebAuthn check. Async so the OS round trip never stalls the main thread
/// (a sync command would run there); it touches no UI.
/// Spec: docs/contrib/biometric-unlock.md, backlog #101 (must check the same biometric class the prompt will request)
#[tauri::command(async)]
fn biometric_available(app: tauri::AppHandle) -> bool {
    #[cfg(native_biometric)]
    {
        biometric::available(&app)
    }
    #[cfg(not(native_biometric))]
    {
        let _ = app;
        false
    }
}

/// Presents the OS biometric prompt and resolves true only if it succeeded.
///
/// `Ok(false)` is every flavour of "no" (cancelled, wrong finger, fell back,
/// system interrupt) - the caller just keeps the app locked and offers PIN or
/// phrase. `Err` means no prompt could be shown at all. The wait always happens
/// on a blocking task; each platform backend then does its own thread hop, since
/// LAContext wants the main thread and Hello must not have it.
///
/// Both strings are rendered by the OS, so the frontend sends them translated:
/// the reason for the prompt, and the label for the cancel button that Android
/// draws itself.
#[tauri::command]
async fn biometric_authenticate(
    app: tauri::AppHandle,
    reason: String,
    cancel_label: String,
) -> Result<bool, String> {
    #[cfg(native_biometric)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            biometric::authenticate(&app, reason, cancel_label)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(native_biometric))]
    {
        let _ = (app, reason, cancel_label);
        Err("Native biometric authentication is not available on this platform.".to_owned())
    }
}

/// The bound biometric key: what `biometric_key_create`
/// hands the web side. `handle` is all it stores; `secret` (hex) is what it
/// derives the wrap key from, and it is never stored.
#[derive(serde::Serialize)]
struct BiometricKey {
    handle: String,
    secret: String,
}

/// Makes a fresh key in the device's secure hardware (Secure Enclave, Android
/// Keystore, Windows Hello), seals a secret to it, and opens it once behind
/// the biometric prompt. Errors are the plain codes `unsupported` (said before
/// any prompt: this device cannot bind now, and the web side enrolls nothing,
/// #842), `cancelled` and `failed`. A caller gets nothing it could not get by
/// passing the prompt itself, and every call makes a new key under a new name,
/// so no call can replace or open an existing enrollment.
/// Spec: docs/internal/plans/biometric-key-binding.md (section 8.2)
#[tauri::command]
async fn biometric_key_create(
    app: tauri::AppHandle,
    reason: String,
    cancel_label: String,
) -> Result<BiometricKey, String> {
    #[cfg(native_biometric)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            biometric::key_create(&app, reason, cancel_label)
                .map(|(handle, secret)| BiometricKey { handle, secret })
                .map_err(|failure| failure.code().to_owned())
        })
        .await
        .map_err(|_| "failed".to_owned())?
    }
    #[cfg(not(native_biometric))]
    {
        let _ = (app, reason, cancel_label);
        Err("unsupported".to_owned())
    }
}

/// Opens the secret of a key `biometric_key_create` made, behind the biometric
/// prompt. Errors: `cancelled`, `gone` (the OS destroyed the key: the device
/// passcode removed, the key invalidated; it never comes back), `unenrolled`
/// (no biometric enrolled now; the key may open again once one is) and
/// `failed`. Without a passed biometric check the hardware releases nothing,
/// whatever handle a caller sends.
#[tauri::command]
async fn biometric_key_open(
    app: tauri::AppHandle,
    handle: String,
    reason: String,
    cancel_label: String,
) -> Result<String, String> {
    #[cfg(native_biometric)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            biometric::key_open(&app, handle, reason, cancel_label)
                .map_err(|failure| failure.code().to_owned())
        })
        .await
        .map_err(|_| "failed".to_owned())?
    }
    #[cfg(not(native_biometric))]
    {
        let _ = (app, handle, reason, cancel_label);
        Err("unsupported".to_owned())
    }
}

/// The device key: a key the OS keeps outside the app's own storage (Secure
/// Enclave, Android Keystore, DPAPI), opened with no prompt. The web side
/// wraps the stored phrase under a key it derives from `secret` while the app
/// lock is off, and stores only `handle`, so a copy of the app's storage holds
/// only ciphertext. On Linux the store is the Secret Service
/// (`device_key_linux.rs`). Errors: `unsupported` (no such store here; the web
/// side keeps its own key) and `failed`. Every call seals a fresh
/// secret, so no call replaces or opens an existing one.
/// Spec: docs/internal/plans/device-bound-phrase-key.md (section 3)
#[tauri::command]
async fn device_key_create(app: tauri::AppHandle) -> Result<BiometricKey, String> {
    #[cfg(native_biometric)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            biometric::device_create(&app)
                .map(|(handle, secret)| BiometricKey { handle, secret })
                .map_err(|failure| failure.code().to_owned())
        })
        .await
        .map_err(|_| "failed".to_owned())?
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(|| {
            device_key_linux::create()
                .map(|(handle, secret)| BiometricKey { handle, secret })
                .map_err(str::to_owned)
        })
        .await
        .map_err(|_| "failed".to_owned())?
    }
    #[cfg(not(any(native_biometric, target_os = "linux")))]
    {
        let _ = app;
        Err("unsupported".to_owned())
    }
}

/// Opens the secret of a handle `device_key_create` made. No prompt, except
/// the system's unlock dialog for a locked Linux keyring when `interactive`
/// (the boot); that dialog dismissed or left unanswered is `cancelled`.
#[tauri::command]
async fn device_key_open(app: tauri::AppHandle, handle: String, interactive: Option<bool>) -> Result<String, String> {
    // Only the Linux keyring has a dialog to allow or forbid.
    #[cfg(native_biometric)]
    let _ = &interactive;
    #[cfg(native_biometric)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            biometric::device_open(&app, handle).map_err(|failure| failure.code().to_owned())
        })
        .await
        .map_err(|_| "failed".to_owned())?
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        let interactive = interactive.unwrap_or(false);
        tauri::async_runtime::spawn_blocking(move || {
            device_key_linux::open(&handle, interactive).map_err(str::to_owned)
        })
        .await
        .map_err(|_| "failed".to_owned())?
    }
    #[cfg(not(any(native_biometric, target_os = "linux")))]
    {
        let _ = (app, handle, interactive);
        Err("unsupported".to_owned())
    }
}

/// Deletes the hardware key of a handle the web side no longer stores. On
/// Apple the key lives only in the handle, so there is nothing to delete; on
/// Android and Windows only a key this app made under its own prefix can be
/// named. Never fails: an orphan key opens nothing.
#[tauri::command]
async fn biometric_key_delete(app: tauri::AppHandle, handle: String) {
    #[cfg(native_biometric)]
    {
        let _ = tauri::async_runtime::spawn_blocking(move || biometric::key_delete(&app, handle)).await;
    }
    #[cfg(not(native_biometric))]
    {
        let _ = (app, handle);
    }
}

/// Prints one note from the standalone HTML document the frontend already
/// renders for the .html export - same markup, same print CSS, same inlined
/// images, so a printout matches the browser's on every platform.
///
/// Only macOS and iOS need this: their WKWebView silently ignores
/// `window.print()`, so the frontend's hidden-iframe path opened nothing there
/// (Windows and Linux implement it and keep that path). Everywhere else this
/// answers with an error, which the frontend reads as "print it yourself".
/// Async so a multi-megabyte document deserializes off the main thread; the
/// print UI itself is put up on the main thread by `print.rs`.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct PrintPageNumbers {
    pub placement: String,
    pub format: String,
}

#[tauri::command]
async fn print_html(
    app: tauri::AppHandle,
    html: String,
    job_name: String,
    page_numbers: Option<PrintPageNumbers>,
) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        print::print(&app, html, job_name, page_numbers)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (app, html, job_name, page_numbers);
        Err("Native printing is only needed on macOS and iOS.".to_owned())
    }
}

/// Arm or disarm the cover the operating system photographs in place of the
/// notes. The frontend is the only side that knows whether the app lock is on,
/// and it pushes from the one place local settings are written.
///
/// The cover is black on every theme, so nothing but the switch crosses the
/// bridge. Spec: docs/internal/specs/app-switcher-privacy-screen.md
#[tauri::command]
fn set_privacy_screen(enabled: bool) {
    privacy_screen::set(enabled);
}

/// Keep the window out of screenshots, screen recordings and screen sharing,
/// or let it back in. A device setting: the frontend stores the switch itself
/// and pushes it at boot and on every change. Android does the same job from
/// MainActivity.kt, so the command does nothing there.
/// Spec: docs/internal/specs/app-switcher-privacy-screen.md (section 14)
#[tauri::command]
fn set_capture_block(app: tauri::AppHandle, enabled: bool) {
    privacy_screen::set_capture_block(&app, enabled);
}

/// Paint the Windows title bar in the app shell's color and text color, and
/// make it dark or light; `dark: None` follows the system. Takes the window it
/// was called from and three-byte colors, so a caller can only recolor this
/// app's own title bar. A no-op off Windows.
#[cfg(desktop)]
#[tauri::command]
fn set_title_bar_colors(
    window: tauri::WebviewWindow,
    caption: [u8; 3],
    text: [u8; 3],
    dark: Option<bool>,
) {
    title_bar::paint(&window, caption, text, dark);
}

/// Whether the web view shows the app's own pages: `tauri://localhost` in a
/// release build, and the configured dev server in a debug build. Every window
/// opens on the app and `navigation::guard` keeps it there; a capture grant
/// still asks where the web view is now.
#[cfg(target_os = "linux")]
fn serves_app_origin<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> bool {
    let Ok(url) = webview.url() else { return false };
    navigation::is_app_url(&url, navigation::dev_url(webview).as_ref())
}

/// Opens (or focuses) the custom About window. The web bundle renders it:
/// main.tsx branches to AboutWindow.tsx when the URL carries ?about-window=1.
/// Fixed-size and closable only, mimicking the standard macOS About panel;
/// the overlay title bar puts the traffic lights over our themed background.
/// The window cannot resize itself, so the height is sized by hand to the
/// content: add or remove a link button in AboutWindow.tsx and this number
/// moves with it (~41px per button, including the gap). The content starts
/// 32px from the top (clear of the traffic lights) and ends 24px from the bottom.
#[cfg(target_os = "macos")]
fn open_about_window(app: &tauri::AppHandle) {
    use tauri::{Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

    if let Some(existing) = app.get_webview_window("about") {
        let _ = existing.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(
        app,
        "about",
        WebviewUrl::App("index.html?about-window=1".into()),
    )
    .on_navigation(crate::navigation::guard(app))
    .on_web_resource_request(crate::script_csp::hook(app))
    .title("About PrivacyNotes")
    .inner_size(280.0, 441.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .hidden_title(true)
    .title_bar_style(TitleBarStyle::Overlay)
    .accept_first_mouse(true)
    .center()
    .content_protected(privacy_screen::capture_on())
    .build();
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    /// What `readDir` reports for a symlink, which is the fact the folder
    /// scan's refusal rests on.
    ///
    /// The plugin derives `isFile`, `isDirectory` and `isSymlink` from one
    /// `DirEntry::file_type()` call and returns false for all three when it
    /// cannot stat the entry (tauri-plugin-fs-2.6.0/src/commands.rs:486-499).
    /// `file_type()` does not traverse a link, so a link reports itself
    /// rather than its target - which is why the frontend asks for a proven
    /// file rather than for "not a symlink". Asserted against a real link on
    /// a real filesystem, because it is an operating-system behaviour and
    /// the whole guard depends on it.
    #[test]
    fn a_symlink_reports_itself_and_not_its_target() {
        let dir = std::env::temp_dir().join("pn-symlink-filetype-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target.md");
        std::fs::write(&target, "real bytes").unwrap();
        let link = dir.join("link.md");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).unwrap();

        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let file_type = entry.file_type().unwrap();
            match entry.file_name().to_str().unwrap() {
                "target.md" => {
                    assert!(file_type.is_file());
                    assert!(!file_type.is_symlink());
                    seen += 1;
                }
                "link.md" => {
                    // The two the scan reads: a link is not a file, so asking
                    // for a proven file refuses it.
                    assert!(file_type.is_symlink());
                    assert!(!file_type.is_file());
                    assert!(!file_type.is_dir());
                    seen += 1;
                }
                other => panic!("unexpected entry {other}"),
            }
        }
        assert_eq!(seen, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The restart decision `run()` acts on before the builder exists, one
    /// case per outcome.
    #[cfg(unix)]
    #[test]
    fn a_restart_drops_only_non_unicode_arguments_after_argv_zero() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        // argv[0] is never examined, so a restart cannot lead to another.
        assert_eq!(
            restart_without_non_unicode_args(
                [OsString::from_vec(b"/opt/caf\xe9/privacynotes".to_vec())].into_iter(),
            ),
            None,
        );
        // The argument that will not convert is dropped, argv[0] is not
        // passed on, and the rest keep their order.
        assert_eq!(
            restart_without_non_unicode_args(
                [
                    OsString::from("/usr/bin/privacynotes"),
                    OsString::from_vec(b"/home/anna/caf\xe9.md".to_vec()),
                    OsString::from("/home/wang/文档/note.md"),
                    OsString::from("/home/anna/second.md"),
                ]
                .into_iter(),
            ),
            Some(vec![
                "/home/wang/文档/note.md".to_string(),
                "/home/anna/second.md".to_string(),
            ]),
        );
        // Nothing to drop, no restart.
        assert_eq!(
            restart_without_non_unicode_args(
                [
                    OsString::from("/usr/bin/privacynotes"),
                    OsString::from("/home/wang/文档/note.md"),
                ]
                .into_iter(),
            ),
            None,
        );
    }

    /// Beta issue 166: a link that the Windows forwarder split into two
    /// arguments must not open the Ninja box. The Wayland key still does.
    #[test]
    fn a_split_link_never_opens_the_ninja_box() {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(wants_ninja_box(&argv(&["privacynotes", "--ninja"])));
        assert!(!wants_ninja_box(&argv(&["privacynotes", "privacynotes:x", "--ninja"])));
        assert!(!wants_ninja_box(&argv(&["privacynotes", "PRIVACYNOTES://x", "--ninja"])));
        assert!(!wants_ninja_box(&argv(&["privacynotes", "notes.md"])));
    }
}
