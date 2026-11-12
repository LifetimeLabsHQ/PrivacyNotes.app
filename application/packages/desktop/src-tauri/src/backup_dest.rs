//! Where automatic backups go.
//!
//! This side holds the destination, and the web view never passes a path: it
//! asks for the folder picker, then sends the sealed bytes of one backup in
//! pieces and a size and SHA-256 to check them against. The pieces land in
//! one staging file in the app cache directory (ciphertext only). `finish`
//! compares the staged bytes, places the file in the destination, reads the
//! placed file back and compares again, so a backup is only reported as
//! placed when the bytes in the folder are the bytes the web view sealed.
//!
//! Desktop writes with `std::fs` into the folder whose path sits in
//! `backup-dest.json` in the app config directory; no fs-plugin grant is
//! involved, so no general write or delete reaches any other folder. Phones
//! forward the folder work to `plugins/backup-folder` (a tree URI on Android,
//! a security-scoped bookmark on iOS); the size and hash comparison stays
//! here on every platform.
//!
//! Every command answers a short code on failure, never a path or an OS
//! message: `not-main`, `no-destination`, `bad-name`, `bad-id`, `mismatch`,
//! `gone`, `denied`, `full`, `io`, `unsupported`. Commands are reachable from
//! every window, so each one refuses a caller that is not the main window.
//!
//! Spec: docs/internal/plans/auto-backup.md (sections 5 and 7)

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// One fixed name, so a crash leaves at most one leftover and the next
/// backup replaces it.
const STAGING_NAME: &str = "backup-staging.partial";
/// The request header of `backup_dest_chunk` that carries the session id.
const ID_HEADER: &str = "x-backup-id";
const NAME_PREFIX: &str = "privacynotes-backup-";
/// The shape of `YYYY-MM-DD-HHmm-`: a digit where the pattern has `0`.
const STAMP: &[u8] = b"0000-00-00-0000-";
const DEVICE_MAX: usize = 40;

/// What the picker answers. `path` is for display and exists on desktop only.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestInfo {
    label: String,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestStatus {
    label: String,
    path: Option<String>,
    reachable: bool,
}

/// A backup that is in the destination. `ref` is what `backup_dest_exists`
/// and `backup_dest_delete` take: the file name on desktop and iOS, the
/// document URI on Android, where a provider may rename a new document.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    #[serde(rename = "ref")]
    reference: String,
    name: String,
    bytes: u64,
}

/// What a platform reports after it placed a file and read it back.
struct Stored {
    reference: String,
    name: String,
    bytes: u64,
    sha256: String,
}

/// The device part of a backup file name, or None when the name is not
/// `privacynotes-backup-YYYY-MM-DD-HHmm-<device>.(pnbackupz|pnbackup)` with a
/// device of 1 to 40 characters from `a-z`, `0-9` and `-`. Such a name holds
/// no path separator and no dot but the one before the extension, so it
/// names a file directly inside the folder it is joined to.
fn device_of(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(NAME_PREFIX)?;
    let stem = rest.strip_suffix(".pnbackupz").or_else(|| rest.strip_suffix(".pnbackup"))?;
    let (stamp, device) = stem.split_at_checked(STAMP.len())?;
    let stamped = stamp
        .bytes()
        .zip(STAMP)
        .all(|(have, want)| if *want == b'0' { have.is_ascii_digit() } else { have == *want });
    let plain = device.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    (stamped && plain && (1..=DEVICE_MAX).contains(&device.len())).then_some(device)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn is_full(error: &io::Error) -> bool {
    // 28 is ENOSPC on every Unix this app runs on.
    matches!(error.kind(), io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded)
        || (cfg!(unix) && error.raw_os_error() == Some(28))
}

/// The code of a failure in the app's own cache directory.
fn staging_code(error: &io::Error) -> String {
    if is_full(error) { "full" } else { "io" }.to_owned()
}

/// The code of a failure in the destination folder.
#[cfg(any(desktop, test))]
fn dest_code(error: &io::Error) -> String {
    match error.kind() {
        _ if is_full(error) => "full",
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => "gone",
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => "denied",
        _ => "io",
    }
    .to_owned()
}

/// The size and SHA-256 (lower-case hex) of a file, read from start to end.
#[cfg(any(desktop, test))]
fn hash_file(path: &std::path::Path) -> io::Result<(u64, String)> {
    use std::io::Read;
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut bytes = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok((bytes, hex(&hasher.finalize())));
        }
        let piece = buffer.get(..read).unwrap_or_default();
        hasher.update(piece);
        bytes += piece.len() as u64;
    }
}

/// One backup on its way in: the staging file, and the hash of what it holds.
struct Session {
    id: u32,
    name: String,
    path: PathBuf,
    file: File,
    hasher: Sha256,
    bytes: u64,
}

impl Session {
    fn start(path: PathBuf, id: u32, name: String) -> io::Result<Self> {
        if let Some(folder) = path.parent() {
            fs::create_dir_all(folder)?;
        }
        // A leftover of a crashed run, or anything else that sits at the name.
        let _ = fs::remove_file(&path);
        let file = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        Ok(Self { id, name, path, file, hasher: Sha256::new(), bytes: 0 })
    }

    fn append(&mut self, piece: &[u8]) -> io::Result<()> {
        self.file.write_all(piece)?;
        self.hasher.update(piece);
        self.bytes += piece.len() as u64;
        Ok(())
    }

    /// Closes the staging file and answers its name, path, size and hash.
    fn seal(self) -> io::Result<(String, PathBuf, u64, String)> {
        let synced = self.file.sync_all();
        drop(self.file);
        if let Err(error) = synced {
            let _ = fs::remove_file(&self.path);
            return Err(error);
        }
        Ok((self.name, self.path, self.bytes, hex(&self.hasher.finalize())))
    }

    fn discard(self) {
        drop(self.file);
        let _ = fs::remove_file(&self.path);
    }
}

/// One session at a time, for the one window that may call.
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn session() -> std::sync::MutexGuard<'static, Option<Session>> {
    SESSION.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Takes the session out when it is the one the caller names.
fn take_session(id: u32) -> Result<Session, String> {
    let mut slot = session();
    match slot.take() {
        Some(current) if current.id == id => Ok(current),
        other => {
            *slot = other;
            Err("bad-id".to_owned())
        }
    }
}

fn same_bytes(bytes: u64, sha256: &str, want_bytes: u64, want_sha256: &str) -> bool {
    bytes == want_bytes && sha256.eq_ignore_ascii_case(want_sha256)
}

/// The desktop destination: a folder, written with `std::fs`. Every function
/// takes the folder, so the tests run them on a temporary one.
#[cfg(any(desktop, test))]
mod folder {
    use super::{dest_code, device_of, hash_file, Stored, NAME_PREFIX};
    use std::fs::{self, File};
    use std::io;
    use std::path::Path;

    /// "gone" unless the folder is there now. An unplugged drive must not
    /// read as "the file is not there": the caller would forget the file.
    pub fn reachable(dest: &Path) -> bool {
        fs::metadata(dest).is_ok_and(|meta| meta.is_dir())
    }

    fn require(dest: &Path) -> Result<(), String> {
        if reachable(dest) { Ok(()) } else { Err("gone".to_owned()) }
    }

    /// Copies the staging file to the fixed partial name inside the folder,
    /// syncs it, renames it to its final name, and reads it back.
    pub fn place(dest: &Path, staging: &Path, name: &str) -> Result<Stored, String> {
        let device = device_of(name).ok_or("bad-name")?;
        require(dest)?;
        let mut from = File::open(staging).map_err(|_| "io".to_owned())?;
        let partial = dest.join(format!("{NAME_PREFIX}{device}.partial"));
        let target = dest.join(name);
        // A leftover of a crashed run. Removing it first also means a link
        // someone put at that name is replaced, never written through.
        let _ = fs::remove_file(&partial);
        let written = (|| {
            let mut to = fs::OpenOptions::new().write(true).create_new(true).open(&partial)?;
            io::copy(&mut from, &mut to)?;
            to.sync_all()?;
            drop(to);
            fs::rename(&partial, &target)
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(&partial);
            return Err(dest_code(&error));
        }
        match hash_file(&target) {
            Ok((bytes, sha256)) => Ok(Stored { reference: name.to_owned(), name: name.to_owned(), bytes, sha256 }),
            Err(error) => {
                let _ = fs::remove_file(&target);
                Err(dest_code(&error))
            }
        }
    }

    /// Whether `name` is a regular file directly inside the folder. A link
    /// is never followed, so it is not one.
    fn regular_file(dest: &Path, name: &str) -> Result<Option<bool>, String> {
        device_of(name).ok_or("bad-name")?;
        require(dest)?;
        match fs::symlink_metadata(dest.join(name)) {
            Ok(meta) => Ok(Some(meta.file_type().is_file())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(dest_code(&error)),
        }
    }

    pub fn exists(dest: &Path, name: &str) -> Result<bool, String> {
        Ok(regular_file(dest, name)? == Some(true))
    }

    /// False when the file is not there. Anything at the name that is not a
    /// regular file (a link, a folder) is refused.
    pub fn delete(dest: &Path, name: &str) -> Result<bool, String> {
        match regular_file(dest, name)? {
            None => Ok(false),
            Some(false) => Err("denied".to_owned()),
            Some(true) => match fs::remove_file(dest.join(name)) {
                Ok(()) => Ok(true),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(dest_code(&error)),
            },
        }
    }
}

/// Desktop: the picked folder's path in `backup-dest.json`.
#[cfg(desktop)]
mod platform {
    use super::{folder, DestInfo, DestStatus, Stored};
    use serde::{Deserialize, Serialize};
    use std::fs;
    use std::path::{Path, PathBuf};
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_opener::OpenerExt;

    const CONFIG_NAME: &str = "backup-dest.json";

    #[derive(Serialize, Deserialize)]
    struct Saved {
        path: PathBuf,
    }

    fn config(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        app.path().app_config_dir().map(|dir| dir.join(CONFIG_NAME)).map_err(|_| "io".to_owned())
    }

    fn saved(app: &tauri::AppHandle) -> Option<PathBuf> {
        let text = fs::read(config(app).ok()?).ok()?;
        serde_json::from_slice::<Saved>(&text).ok().map(|saved| saved.path)
    }

    fn dest(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        saved(app).ok_or_else(|| "no-destination".to_owned())
    }

    fn label(path: &Path) -> String {
        // A drive root has no last component.
        path.file_name().unwrap_or(path.as_os_str()).to_string_lossy().into_owned()
    }

    pub fn pick(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<Option<DestInfo>, String> {
        let Some(picked) = app.dialog().file().set_parent(window).blocking_pick_folder() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|_| "io".to_owned())?;
        let file = config(app)?;
        let text = serde_json::to_vec(&Saved { path: path.clone() }).map_err(|_| "io".to_owned())?;
        file.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| fs::write(&file, text)).map_err(|_| "io".to_owned())?;
        Ok(Some(DestInfo { label: label(&path), path: Some(path.to_string_lossy().into_owned()) }))
    }

    pub fn status(app: &tauri::AppHandle) -> Result<Option<DestStatus>, String> {
        Ok(saved(app).map(|path| DestStatus {
            label: label(&path),
            reachable: folder::reachable(&path),
            path: Some(path.to_string_lossy().into_owned()),
        }))
    }

    pub fn place(app: &tauri::AppHandle, staging: &Path, name: &str) -> Result<Stored, String> {
        folder::place(&dest(app)?, staging, name)
    }

    pub fn exists(app: &tauri::AppHandle, reference: &str) -> Result<bool, String> {
        folder::exists(&dest(app)?, reference)
    }

    pub fn delete(app: &tauri::AppHandle, reference: &str) -> Result<bool, String> {
        folder::delete(&dest(app)?, reference)
    }

    /// Selects the folder in the file manager. Nothing is opened or run.
    pub fn reveal(app: &tauri::AppHandle) -> Result<(), String> {
        let path = dest(app)?;
        if !folder::reachable(&path) {
            return Err("gone".to_owned());
        }
        app.opener().reveal_item_in_dir(path).map_err(|_| "io".to_owned())
    }

    pub fn clear(app: &tauri::AppHandle) -> Result<(), String> {
        match fs::remove_file(config(app)?) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err("io".to_owned()),
            _ => Ok(()),
        }
    }

    pub fn metered(_app: &tauri::AppHandle) -> Result<bool, String> {
        Ok(false)
    }
}

/// Phones: the folder lives in `plugins/backup-folder`, which is reached from
/// here only and holds no web view permission.
#[cfg(mobile)]
mod platform {
    use super::{DestInfo, DestStatus, Stored};
    use std::path::Path;
    use tauri_plugin_backup_folder::BackupFolderExt;

    pub fn pick(app: &tauri::AppHandle, _window: &tauri::WebviewWindow) -> Result<Option<DestInfo>, String> {
        Ok(app.backup_folder().pick()?.map(|label| DestInfo { label, path: None }))
    }

    pub fn status(app: &tauri::AppHandle) -> Result<Option<DestStatus>, String> {
        Ok(app.backup_folder().status()?.map(|status| DestStatus {
            label: status.label,
            path: None,
            reachable: status.reachable,
        }))
    }

    pub fn place(app: &tauri::AppHandle, staging: &Path, name: &str) -> Result<Stored, String> {
        let staging = staging.to_str().ok_or("io")?;
        let stored = app.backup_folder().place(staging, name)?;
        Ok(Stored { reference: stored.reference, name: stored.name, bytes: stored.bytes, sha256: stored.sha256 })
    }

    pub fn exists(app: &tauri::AppHandle, reference: &str) -> Result<bool, String> {
        app.backup_folder().exists(reference)
    }

    pub fn delete(app: &tauri::AppHandle, reference: &str) -> Result<bool, String> {
        app.backup_folder().delete(reference)
    }

    pub fn reveal(_app: &tauri::AppHandle) -> Result<(), String> {
        Err("unsupported".to_owned())
    }

    pub fn clear(app: &tauri::AppHandle) -> Result<(), String> {
        app.backup_folder().clear()
    }

    pub fn metered(app: &tauri::AppHandle) -> Result<bool, String> {
        app.backup_folder().metered()
    }
}

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("not-main".to_owned()) }
}

/// File work and the picker stay off the main thread and off the async
/// workers: a copy to a slow drive takes as long as the drive does.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| "io".to_owned())?
}

/// Opens the folder picker and remembers the choice. None when the person
/// cancels; the stored destination is then unchanged.
#[tauri::command]
pub async fn backup_dest_pick(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<DestInfo>, String> {
    main_only(&window)?;
    blocking(move || platform::pick(&app, &window)).await
}

/// The stored destination and whether it can be reached now. None when
/// nothing is stored.
#[tauri::command]
pub async fn backup_dest_status(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<DestStatus>, String> {
    main_only(&window)?;
    blocking(move || platform::status(&app)).await
}

/// Starts one backup and answers its session id. An older unfinished
/// session is dropped with its staging file.
#[tauri::command]
pub async fn backup_dest_begin(app: tauri::AppHandle, window: tauri::WebviewWindow, name: String) -> Result<u32, String> {
    main_only(&window)?;
    if device_of(&name).is_none() {
        return Err("bad-name".to_owned());
    }
    let path = app.path().app_cache_dir().map_err(|_| "io".to_owned())?.join(STAGING_NAME);
    blocking(move || {
        let mut slot = session();
        if let Some(old) = slot.take() {
            old.discard();
        }
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        *slot = Some(Session::start(path, id, name).map_err(|error| staging_code(&error))?);
        Ok(id)
    })
    .await
}

/// The bytes of a piece that came as JSON: `{ "b64": "<base64>" }`.
/// Android's web view cannot send a raw body, and the JSON array of numbers
/// Tauri would make of the bytes is too slow for a backup of tens of MB.
fn json_piece(value: &serde_json::Value) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let text = value.get("b64")?.as_str()?;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// The next bytes of a backup: the raw body, with the session id in the
/// `x-backup-id` header. Android sends base64 text instead (`json_piece`).
#[tauri::command]
pub async fn backup_dest_chunk(window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    main_only(&window)?;
    let id = request
        .headers()
        .get(ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or("bad-id")?;
    let piece = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(value) => json_piece(value).ok_or("io")?,
    };
    blocking(move || {
        let mut slot = session();
        let current = slot.as_mut().filter(|current| current.id == id).ok_or("bad-id")?;
        if let Err(error) = current.append(&piece) {
            // A staging file with a hole in it cannot be finished.
            if let Some(broken) = slot.take() {
                broken.discard();
            }
            return Err(staging_code(&error));
        }
        Ok(())
    })
    .await
}

/// Checks the staged bytes against `size` and `sha256`, places the file,
/// reads the placed file back and checks again. The staging file is gone
/// when this returns, whatever it answers.
#[tauri::command]
pub async fn backup_dest_finish(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: u32,
    size: u64,
    sha256: String,
) -> Result<Placed, String> {
    main_only(&window)?;
    blocking(move || {
        let (name, staging, bytes, staged) = take_session(id)?.seal().map_err(|error| staging_code(&error))?;
        if !same_bytes(bytes, &staged, size, &sha256) {
            let _ = fs::remove_file(&staging);
            return Err("mismatch".to_owned());
        }
        let stored = platform::place(&app, &staging, &name);
        let _ = fs::remove_file(&staging);
        let stored = stored?;
        if !same_bytes(stored.bytes, &stored.sha256, size, &sha256) {
            let _ = platform::delete(&app, &stored.reference);
            return Err("mismatch".to_owned());
        }
        Ok(Placed { reference: stored.reference, name: stored.name, bytes: stored.bytes })
    })
    .await
}

/// Drops a session and its staging file.
#[tauri::command]
pub async fn backup_dest_abort(window: tauri::WebviewWindow, id: u32) -> Result<(), String> {
    main_only(&window)?;
    blocking(move || {
        take_session(id)?.discard();
        Ok(())
    })
    .await
}

/// Whether a placed backup is still in the destination.
#[tauri::command]
pub async fn backup_dest_exists(app: tauri::AppHandle, window: tauri::WebviewWindow, r#ref: String) -> Result<bool, String> {
    main_only(&window)?;
    blocking(move || platform::exists(&app, &r#ref)).await
}

/// Deletes one placed backup. False when it is not there.
#[tauri::command]
pub async fn backup_dest_delete(app: tauri::AppHandle, window: tauri::WebviewWindow, r#ref: String) -> Result<bool, String> {
    main_only(&window)?;
    blocking(move || platform::delete(&app, &r#ref)).await
}

/// Shows the folder in the file manager. Desktop only.
#[tauri::command]
pub async fn backup_dest_reveal(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    blocking(move || platform::reveal(&app)).await
}

/// Forgets the destination. No backup file is deleted.
#[tauri::command]
pub async fn backup_dest_clear(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    blocking(move || platform::clear(&app)).await
}

/// Whether the connection in use is metered. Always false on desktop.
#[tauri::command]
pub async fn backup_dest_metered(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<bool, String> {
    main_only(&window)?;
    blocking(move || platform::metered(&app)).await
}

#[cfg(test)]
mod tests {
    use super::{device_of, folder, hex, json_piece, same_bytes, Session};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::PathBuf;

    const NAME: &str = "privacynotes-backup-2026-11-11-0930-work-laptop.pnbackupz";

    /// A fresh folder under the system temporary directory, removed on drop.
    struct Temp(PathBuf);

    impl Temp {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("pn-backup-dest-{}-{tag}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("temp folder");
            Self(path)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Stages `pieces` the way begin and chunk do, and answers the staging
    /// path, the size and the hash.
    fn stage(temp: &Temp, pieces: &[&[u8]]) -> (PathBuf, u64, String) {
        let mut session = Session::start(temp.0.join("cache").join("staging.partial"), 1, NAME.to_owned()).expect("starts");
        for piece in pieces {
            session.append(piece).expect("appends");
        }
        let (name, path, bytes, sha256) = session.seal().expect("seals");
        assert_eq!(name, NAME);
        (path, bytes, sha256)
    }

    #[test]
    fn backup_dest_name_check_accepts_the_two_formats() {
        assert_eq!(device_of(NAME), Some("work-laptop"));
        assert_eq!(device_of("privacynotes-backup-2026-01-02-0000-a.pnbackup"), Some("a"));
        let longest = format!("privacynotes-backup-2026-01-02-2359-{}.pnbackupz", "a".repeat(40));
        assert!(device_of(&longest).is_some());
    }

    #[test]
    fn backup_dest_name_check_refuses_everything_else() {
        let too_long = format!("privacynotes-backup-2026-01-02-2359-{}.pnbackupz", "a".repeat(41));
        for name in [
            "",
            "privacynotes-backup-2026-11-11-0930-.pnbackupz",
            "privacynotes-backup-2026-11-11-0930-mac.zip",
            "privacynotes-backup-2026-11-11-0930-mac.pnbackupz.exe",
            "privacynotes-backup-2026-11-11-0930-mac",
            "privacynotes-backup-2026-11-11-0930-Mac.pnbackupz",
            "privacynotes-backup-2026-11-11-0930-mac.PNBACKUPZ",
            "privacynotes-Backup-2026-11-11-0930-mac.pnbackupz",
            "privacynotes-backup-2026-11-11-0930-a/b.pnbackupz",
            "privacynotes-backup-2026-11-11-0930-a\\b.pnbackupz",
            "privacynotes-backup-2026-11-11-0930-...pnbackupz",
            "privacynotes-backup-2026-11-11-0930-a.b.pnbackupz",
            "../privacynotes-backup-2026-11-11-0930-mac.pnbackupz",
            "/tmp/privacynotes-backup-2026-11-11-0930-mac.pnbackupz",
            "privacynotes-backup-2026-11-11-093-mac.pnbackupz",
            "privacynotes-backup-2026-11-11-09300-mac.pnbackupz",
            "privacynotes-backup-2026/11/11-0930-mac.pnbackupz",
            "privacynotes-backup-20261111-0930-mac.pnbackupz",
            "privacynotes-backup-2026-11-11-0930-m\u{e4}c.pnbackupz",
            "privacynotes-backup-2026-11-11-0930-mac .pnbackupz",
            "privacynotes-backup-2026-11-11-0930-mac.pnbackupz\0",
            "privacynotes-backup-mac.partial",
            too_long.as_str(),
        ] {
            assert_eq!(device_of(name), None, "{name:?}");
        }
    }

    #[test]
    fn backup_dest_reads_a_base64_piece() {
        assert_eq!(json_piece(&serde_json::json!({ "b64": "c2VhbGVkIGJ5dGVz" })), Some(b"sealed bytes".to_vec()));
        assert_eq!(json_piece(&serde_json::json!({ "b64": "" })), Some(Vec::new()));
        assert_eq!(json_piece(&serde_json::json!({ "b64": "not base64!" })), None);
        assert_eq!(json_piece(&serde_json::json!([115, 101])), None);
        assert_eq!(json_piece(&serde_json::json!({ "b64": 7 })), None);
    }

    #[test]
    fn backup_dest_places_and_reads_back() {
        let temp = Temp::new("place");
        let dest = temp.0.join("dest");
        fs::create_dir(&dest).expect("dest");
        let (staging, bytes, sha256) = stage(&temp, &[b"sealed ", b"bytes"]);
        assert_eq!(bytes, 12);
        assert_eq!(sha256, hex(&Sha256::digest(b"sealed bytes")));

        // A leftover partial of a crashed run is replaced.
        fs::write(dest.join("privacynotes-backup-work-laptop.partial"), b"old").expect("leftover");
        let stored = folder::place(&dest, &staging, NAME).expect("places");
        assert_eq!((stored.reference.as_str(), stored.name.as_str()), (NAME, NAME));
        assert!(same_bytes(stored.bytes, &stored.sha256, bytes, &sha256));
        assert!(same_bytes(stored.bytes, &stored.sha256, bytes, &sha256.to_uppercase()));
        assert!(!same_bytes(stored.bytes, &stored.sha256, bytes + 1, &sha256));
        assert_eq!(fs::read(dest.join(NAME)).expect("reads"), b"sealed bytes");
        assert!(!dest.join("privacynotes-backup-work-laptop.partial").exists());

        assert_eq!(folder::exists(&dest, NAME), Ok(true));
        assert_eq!(folder::delete(&dest, NAME), Ok(true));
        assert_eq!(folder::exists(&dest, NAME), Ok(false));
        assert_eq!(folder::delete(&dest, NAME), Ok(false));
    }

    #[test]
    fn backup_dest_refuses_a_name_outside_the_pattern() {
        let temp = Temp::new("names");
        let dest = temp.0.join("dest");
        fs::create_dir(&dest).expect("dest");
        fs::write(temp.0.join("notes.md"), b"mine").expect("other file");
        let (staging, ..) = stage(&temp, &[b"x"]);
        for name in ["../notes.md", "notes.md", "privacynotes-backup-work-laptop.partial"] {
            assert_eq!(folder::place(&dest, &staging, name).err().as_deref(), Some("bad-name"));
            assert_eq!(folder::exists(&dest, name), Err("bad-name".to_owned()));
            assert_eq!(folder::delete(&dest, name), Err("bad-name".to_owned()));
        }
        assert_eq!(fs::read(temp.0.join("notes.md")).expect("still there"), b"mine");
    }

    #[cfg(unix)]
    #[test]
    fn backup_dest_never_follows_a_link() {
        let temp = Temp::new("link");
        let dest = temp.0.join("dest");
        fs::create_dir(&dest).expect("dest");
        let outside = temp.0.join("outside.txt");
        fs::write(&outside, b"mine").expect("outside file");

        // A link at a backup's name is not a backup, and is not deleted.
        std::os::unix::fs::symlink(&outside, dest.join(NAME)).expect("link");
        assert_eq!(folder::exists(&dest, NAME), Ok(false));
        assert_eq!(folder::delete(&dest, NAME), Err("denied".to_owned()));
        assert!(fs::symlink_metadata(dest.join(NAME)).is_ok());
        assert_eq!(fs::read(&outside).expect("untouched"), b"mine");
        fs::remove_file(dest.join(NAME)).expect("link removed");

        // A link at the partial name is replaced, never written through.
        std::os::unix::fs::symlink(&outside, dest.join("privacynotes-backup-work-laptop.partial")).expect("link");
        let (staging, ..) = stage(&temp, &[b"sealed"]);
        folder::place(&dest, &staging, NAME).expect("places");
        assert_eq!(fs::read(&outside).expect("untouched"), b"mine");
        assert!(fs::symlink_metadata(dest.join(NAME)).expect("placed").file_type().is_file());

        // A folder at a backup's name is refused too.
        let other = "privacynotes-backup-2026-11-12-0930-work-laptop.pnbackup";
        fs::create_dir(dest.join(other)).expect("folder");
        assert_eq!(folder::exists(&dest, other), Ok(false));
        assert_eq!(folder::delete(&dest, other), Err("denied".to_owned()));
    }

    #[test]
    fn backup_dest_says_gone_when_the_folder_is_removed() {
        let temp = Temp::new("gone");
        let dest = temp.0.join("dest");
        fs::create_dir(&dest).expect("dest");
        let (staging, ..) = stage(&temp, &[b"sealed"]);
        folder::place(&dest, &staging, NAME).expect("places");
        fs::remove_dir_all(&dest).expect("removed");

        assert!(!folder::reachable(&dest));
        assert_eq!(folder::place(&dest, &staging, NAME).err().as_deref(), Some("gone"));
        // Not "false": a drive that is unplugged still holds its backups.
        assert_eq!(folder::exists(&dest, NAME), Err("gone".to_owned()));
        assert_eq!(folder::delete(&dest, NAME), Err("gone".to_owned()));

        // A file where the folder was is no folder either.
        fs::write(&dest, b"").expect("file");
        assert_eq!(folder::place(&dest, &staging, NAME).err().as_deref(), Some("gone"));
    }

    #[test]
    fn backup_dest_a_new_session_replaces_the_staging_file() {
        let temp = Temp::new("stage");
        let (path, ..) = stage(&temp, &[b"first backup"]);
        let (again, bytes, sha256) = stage(&temp, &[b"second"]);
        assert_eq!(path, again);
        assert_eq!(bytes, 6);
        assert_eq!(sha256, hex(&Sha256::digest(b"second")));
        assert_eq!(fs::read(&again).expect("reads"), b"second");

        let session = Session::start(again.clone(), 2, NAME.to_owned()).expect("starts");
        session.discard();
        assert!(!again.exists());
    }
}
