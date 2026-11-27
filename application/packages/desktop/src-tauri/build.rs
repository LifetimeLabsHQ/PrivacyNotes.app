fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // The native biometric gate (src/biometric.rs) exists only where the OS
    // exposes one: LocalAuthentication on macOS + iOS, Windows Hello on Windows,
    // androidx.biometric on Android. One cfg keeps lib.rs from repeating that
    // target list at every use site, mirroring how tauri-build hands us
    // `desktop` / `mobile`. Linux is the only target left without a gate.
    println!("cargo:rustc-check-cfg=cfg(native_biometric)");
    if matches!(target_os.as_str(), "macos" | "ios" | "windows" | "android") {
        println!("cargo:rustc-cfg=native_biometric");
    }

    // biometric.rs looks up LAContext through the ObjC runtime, and nothing else
    // in the tree links LocalAuthentication.framework - without this the class is
    // simply absent and biometrics report as unavailable. Framework links are
    // per-target, so gate on the target OS rather than the host.
    if matches!(target_os.as_str(), "macos" | "ios") {
        println!("cargo:rustc-link-lib=framework=LocalAuthentication");
    }

    // file_assoc.rs calls LaunchServices (LSCopyDefaultRoleHandlerForContentType /
    // LSSetDefaultRoleHandlerForContentType) to read and set which app opens
    // Markdown. LaunchServices is a CoreServices subframework, and nothing else
    // in the tree links it. macOS only: iOS has no user-settable file
    // associations at all.
    if target_os == "macos" {
        println!("cargo:rustc-link-lib=framework=CoreServices");
        // plugins/apple-ml links Swift on macOS, and a plugin's build script
        // cannot add an rpath to the app: without it the app dies at launch
        // (`Library not loaded: @rpath/libswift_Concurrency.dylib`).
        // Spec: docs/internal/specs/plugins-apple.md (section 3, item 1)
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    // The iOS sign-in sheet completes on an https return address only when
    // the app claims that host as an associated web-credentials domain. The
    // deep-link plugin's build script writes the associated-domains array
    // with `applinks:` for every app-link host in tauri.conf.json and knows
    // no other service, and cargo re-runs each script on its own schedule, so
    // the array is written here in full, from the same config, on every iOS
    // build: a package's build script runs after every dependency's, and the
    // Tauri CLI sets the two variables the helper reads only during `ios dev`
    // and `ios build`, which is also when the plugin writes. The host is the
    // one in OAUTH_APP_LINK_REDIRECT (packages/web/src/authStorage.ts), and
    // tests/desktopCapabilities.test.ts holds the two together.
    // Spec: docs/internal/plans/oauth-redirect-binding-handoff.md (section 8.2)
    if target_os == "ios" {
        claim_associated_domains();
    }

    // The app's own commands get an access list like the plugin commands
    // (beta issue 167). Without an app manifest Tauri asks the ACL only for
    // plugin commands, so the Ninja and About windows could call every
    // command in lib.rs. With it, each command needs an `allow-<command>`
    // grant for the calling window: capabilities/app-commands.json gives the
    // main window every one, ninja.json gives the Ninja box `ninja_dismiss`,
    // and the About window gets none. One list for every target, the union of
    // the two `generate_handler!` lists in lib.rs; a grant for a command a
    // target does not register reaches nothing there.
    // tests/desktopCapabilities.test.ts holds this list to lib.rs and every
    // command the web code invokes to a grant for the window that runs it.
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("{error:#}");
    }
}

const APP_COMMANDS: &[&str] = &[
    "can_self_update",
    "is_scoop_install",
    "updater_target_info",
    "prepare_update_restart",
    "biometric_available",
    "biometric_authenticate",
    "biometric_key_create",
    "biometric_key_open",
    "biometric_key_delete",
    "device_key_create",
    "device_key_open",
    "biometric_tpm_missing",
    "print_html",
    "take_pending_opens",
    "read_opened_file",
    "grant_file_picture",
    "forget_folder_scope",
    "markdown_assoc_status",
    "markdown_assoc_claim",
    "markdown_assoc_open_os_settings",
    "text_assoc_status",
    "text_assoc_claim",
    "set_privacy_screen",
    "set_capture_block",
    "set_title_bar_colors",
    "pasteboard_pictures",
    "clip_fetch",
    "decode_avif",
    "cli_status",
    "install_cli",
    "set_tray_mode",
    "set_app_icon",
    "set_ninja_shortcut",
    "ninja_dismiss",
    "autostart_enabled",
    "set_autostart",
    "finish_login_start",
    "share_inbox_list",
    "share_inbox_read",
    "share_inbox_remove",
    "share_inbox_clear",
    "share_limit_set",
    "share_catalog_set",
    "backup_dest_pick",
    "backup_dest_status",
    "backup_dest_begin",
    "backup_dest_chunk",
    "backup_dest_finish",
    "backup_dest_abort",
    "backup_dest_exists",
    "backup_dest_delete",
    "backup_dest_reveal",
    "backup_dest_clear",
    "backup_dest_metered",
    "plugin_files_list",
    "plugin_file_read",
    "plugin_file_write",
    "plugin_file_delete",
    "plugin_files_clear",
    "plugin_files_reveal",
];

/// The helper exists on a Mac host only, which is also the only host that
/// builds iOS; the other hosts compile an empty function.
#[cfg(target_os = "macos")]
fn claim_associated_domains() {
    // Cargo re-runs this script only when an input it knows about changes.
    // The entitlements file is one, because xcodegen blanks it and the
    // deep-link plugin's script rewrites it; the two variables are another,
    // because they exist only under the Tauri CLI; the config is the third.
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-env-changed=TAURI_IOS_PROJECT_PATH");
    println!("cargo:rerun-if-env-changed=TAURI_IOS_APP_NAME");
    if let (Ok(project), Ok(app)) = (
        std::env::var("TAURI_IOS_PROJECT_PATH"),
        std::env::var("TAURI_IOS_APP_NAME"),
    ) {
        println!("cargo:rerun-if-changed={project}/{app}_iOS/{app}_iOS.entitlements");
    }

    let conf: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("tauri.conf.json").expect("tauri.conf.json is unreadable"),
    )
    .expect("tauri.conf.json is not JSON");
    let hosts: Vec<String> = conf["plugins"]["deep-link"]["mobile"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["appLink"].as_bool() == Some(true))
        .filter_map(|entry| entry["host"].as_str().map(str::to_string))
        .collect();
    let mut domains = Vec::new();
    for host in &hosts {
        domains.push(plist::Value::String(format!("applinks:{host}")));
    }
    for host in &hosts {
        domains.push(plist::Value::String(format!("webcredentials:{host}")));
    }

    tauri_plugin::mobile::update_entitlements(|entitlements| {
        entitlements.insert(
            "com.apple.developer.associated-domains".into(),
            plist::Value::Array(domains),
        );
        // The share extension writes into this group's folder and the app
        // reads it (src/share_inbox.rs). Written here for the same reason as
        // the domains: xcodegen blanks the file.
        // Spec: docs/internal/specs/share-into-app.md
        entitlements.insert(
            "com.apple.security.application-groups".into(),
            plist::Value::Array(vec![plist::Value::String("group.app.privacynotes".into())]),
        );
    })
    .expect("failed to write the iOS entitlements");
}

#[cfg(not(target_os = "macos"))]
fn claim_associated_domains() {}
