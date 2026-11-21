//! The files of Settings > Plugins in the desktop apps: one folder per store
//! under the app's data folder, `<app local data>/plugins/files/` and
//! `<app local data>/plugins/smart-connections/`, so a person (or a cleanup
//! tool) sees them as the app's own files, apart from the web view's data.
//! The browser build keeps them in Cache Storage (`pluginStore.ts`).
//!
//! The web view never passes a path: it names a store from a fixed list and
//! a file name of letters, digits, `.`, `_` and `-`. Every file is checked
//! against its pinned SHA-256 on the web side before it is written and again
//! each time it is read, so this side only stores bytes. A write goes to a
//! `.partial` file first and is renamed, so a crash never leaves half a file
//! under a real name.
//!
//! Every command answers a short code on failure, never a path or an OS
//! message: `not-main`, `bad-store`, `bad-name`, `gone`, `full`, `io`.
//! Commands are reachable from every window, so each one refuses a caller
//! that is not the main window.
//!
//! Spec: docs/internal/plans/plugins.md (section 3)

use crate::backup_dest::{blocking, is_full, main_only};
use std::fs;
use std::io;
use std::path::PathBuf;
use tauri::Manager;

/// The request headers of `plugin_file_write`, whose body is the raw bytes.
const STORE_HEADER: &str = "x-plugin-store";
const NAME_HEADER: &str = "x-plugin-name";
const PARTIAL: &str = ".partial";
const NAME_MAX: usize = 128;

/// The folder of a store, below `plugins/`. The ids are the web build's Cache
/// Storage names, so one id means the same files in every build.
fn folder_of(store: &str) -> Option<&'static str> {
    match store {
        "pn-plugins" => Some("files"),
        "pn-on-device-ai" => Some("smart-connections"),
        _ => None,
    }
}

/// A file name the web side may use: no path, no hidden file, no `.partial`.
fn good_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= NAME_MAX
        && !name.starts_with('.')
        && !name.ends_with(PARTIAL)
        && !name.contains("..")
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn code(error: &io::Error) -> String {
    match error.kind() {
        _ if is_full(error) => "full",
        io::ErrorKind::NotFound => "gone",
        _ => "io",
    }
    .to_owned()
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|_| "io".to_owned())?.join("plugins"))
}

fn store_dir(app: &tauri::AppHandle, store: &str) -> Result<PathBuf, String> {
    Ok(root(app)?.join(folder_of(store).ok_or("bad-store")?))
}

fn file_path(app: &tauri::AppHandle, store: &str, name: &str) -> Result<PathBuf, String> {
    if !good_name(name) {
        return Err("bad-name".to_owned());
    }
    Ok(store_dir(app, store)?.join(name))
}

/// The file names in a folder; a `.partial` left by a crash is deleted.
fn names_in(dir: &PathBuf) -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(code(&error)),
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if name.ends_with(PARTIAL) {
            let _ = fs::remove_file(entry.path());
        } else if good_name(&name) && entry.file_type().is_ok_and(|t| t.is_file()) {
            names.push(name);
        }
    }
    Ok(names)
}

fn write_in(dir: &PathBuf, name: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| code(&e))?;
    let partial = dir.join(format!("{name}{PARTIAL}"));
    if let Err(error) = fs::write(&partial, bytes).and_then(|()| fs::rename(&partial, dir.join(name))) {
        let _ = fs::remove_file(&partial);
        return Err(code(&error));
    }
    Ok(())
}

/// The names of the files in a store. Empty when it has none.
#[tauri::command]
pub async fn plugin_files_list(app: tauri::AppHandle, window: tauri::WebviewWindow, store: String) -> Result<Vec<String>, String> {
    main_only(&window)?;
    let dir = store_dir(&app, &store)?;
    blocking(move || names_in(&dir)).await
}

/// One file's bytes, as an `ArrayBuffer` on the web side. `gone` when it is not there.
#[tauri::command]
pub async fn plugin_file_read(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    store: String,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    main_only(&window)?;
    let path = file_path(&app, &store, &name)?;
    blocking(move || fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| code(&e))).await
}

/// Stores one file: the raw body, named by the two headers.
#[tauri::command]
pub async fn plugin_file_write(app: tauri::AppHandle, window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    main_only(&window)?;
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let store = header(STORE_HEADER).ok_or("bad-store")?;
    let name = header(NAME_HEADER).ok_or("bad-name")?;
    let dir = store_dir(&app, &store)?;
    if !good_name(&name) {
        return Err("bad-name".to_owned());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("io".to_owned()) };
    let bytes = bytes.clone();
    blocking(move || write_in(&dir, &name, &bytes)).await
}

/// Deletes one file. Nothing happens when it is not there.
#[tauri::command]
pub async fn plugin_file_delete(app: tauri::AppHandle, window: tauri::WebviewWindow, store: String, name: String) -> Result<(), String> {
    main_only(&window)?;
    let path = file_path(&app, &store, &name)?;
    blocking(move || match fs::remove_file(&path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(code(&error)),
        _ => Ok(()),
    })
    .await
}

/// Deletes a store's folder and every file in it.
#[tauri::command]
pub async fn plugin_files_clear(app: tauri::AppHandle, window: tauri::WebviewWindow, store: String) -> Result<(), String> {
    main_only(&window)?;
    let dir = store_dir(&app, &store)?;
    blocking(move || match fs::remove_dir_all(&dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(code(&error)),
        _ => Ok(()),
    })
    .await
}

/// Shows the `plugins` folder in the file manager. Nothing is opened or run.
#[tauri::command]
pub async fn plugin_files_reveal(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    main_only(&window)?;
    let dir = root(&app)?;
    blocking(move || {
        fs::create_dir_all(&dir).map_err(|e| code(&e))?;
        app.opener().reveal_item_in_dir(dir).map_err(|_| "io".to_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{folder_of, good_name, names_in, write_in};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn plugin_files_name_check() {
        for name in ["ort-wasm-simd-threaded-4b884c203b0f.wasm", "model-en-de-db0fa25f3767.bin.zst", "bekko256-vocab-3646307292d4.txt"] {
            assert!(good_name(name), "{name}");
        }
        let long = "a".repeat(129);
        for name in ["", ".hidden", "a/b", "a\\b", "..", "a..b", "x.partial", "a b", "a:b", long.as_str(), "\u{e9}.bin"] {
            assert!(!good_name(name), "{name}");
        }
    }

    #[test]
    fn plugin_files_store_list_is_fixed() {
        assert_eq!(folder_of("pn-plugins"), Some("files"));
        assert_eq!(folder_of("pn-on-device-ai"), Some("smart-connections"));
        assert_eq!(folder_of("../x"), None);
        assert_eq!(folder_of(""), None);
    }

    #[test]
    fn plugin_files_write_list_and_partial_cleanup() {
        let dir = std::env::temp_dir().join(format!("pn-plugin-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(names_in(&dir).expect("missing folder lists").is_empty());
        write_in(&dir, "a.bin", b"abc").expect("writes");
        fs::write(dir.join("b.bin.partial"), b"half").expect("leftover");
        assert_eq!(names_in(&dir).expect("lists"), vec!["a.bin".to_owned()]);
        assert!(!PathBuf::from(&dir).join("b.bin.partial").exists());
        assert_eq!(fs::read(dir.join("a.bin")).expect("reads"), b"abc");
        let _ = fs::remove_dir_all(&dir);
    }
}
