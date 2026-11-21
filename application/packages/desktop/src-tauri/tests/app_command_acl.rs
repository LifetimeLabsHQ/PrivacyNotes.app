//! The app's own commands answer only the windows a capability names
//! (beta issue 167). build.rs declares them in an app manifest; without it
//! Tauri asked the access list for plugin commands only, and the Ninja and
//! About windows could call `install_cli`, `set_autostart` and the rest.
//!
//! This runs the real access list (the capabilities compiled into the
//! context) on the mock runtime, with stand-in commands of the same names,
//! so it decides exactly what the app decides for a call from each window.
//! Which commands each window's web code calls is
//! tests/desktopCapabilities.test.ts (vitest).
#![cfg(not(any(target_os = "android", target_os = "ios")))]

use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn ninja_dismiss() {}
#[tauri::command]
fn install_cli() {}
#[tauri::command]
fn set_autostart() {}
/// Answers how many deny entries the capability hands the command, which
/// proves the grant's deny list reaches it (opened_file.rs reads it).
#[tauri::command]
fn read_opened_file(deny: tauri::ipc::CommandScope<serde_json::Value>) -> usize {
    deny.denies().len()
}
/// The same, for the picture grant of a file opened on its own (file_pictures.rs).
#[tauri::command]
fn grant_file_picture(deny: tauri::ipc::CommandScope<serde_json::Value>) -> usize {
    deny.denies().len()
}

fn call(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &str) -> bool {
    answer(window, cmd).is_ok()
}

fn answer(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

#[test]
fn each_window_reaches_only_its_own_commands() {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![ninja_dismiss, install_cli, set_autostart, read_opened_file, grant_file_picture])
        .build(tauri::generate_context!())
        .unwrap();
    let window = |label: &str| WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into())).build().unwrap();
    let main = window("main");
    let ninja = window("ninja");
    let about = window("about");

    assert!(call(&main, "install_cli"));
    assert!(call(&main, "set_autostart"));
    assert!(call(&main, "ninja_dismiss"));
    let denies: usize = answer(&main, "read_opened_file").unwrap().deserialize().unwrap();
    assert!(denies > 0, "the deny list reaches read_opened_file");
    let denies: usize = answer(&main, "grant_file_picture").unwrap().deserialize().unwrap();
    assert!(denies > 0, "the deny list reaches grant_file_picture");

    assert!(call(&ninja, "ninja_dismiss"));
    assert!(!call(&ninja, "install_cli"));
    assert!(!call(&ninja, "set_autostart"));
    assert!(!call(&ninja, "read_opened_file"));
    assert!(!call(&ninja, "grant_file_picture"));

    // The About window is macOS only, but its label holds no app command on
    // any target.
    assert!(!call(&about, "ninja_dismiss"));
    assert!(!call(&about, "install_cli"));
    assert!(!call(&about, "read_opened_file"));
    assert!(!call(&about, "grant_file_picture"));
}
