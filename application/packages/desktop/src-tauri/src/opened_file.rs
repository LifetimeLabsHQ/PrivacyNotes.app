//! A file the person opened from outside the app (a double-click, a launch
//! argument or the file picker): the launch inbox that holds it until the
//! page asks, and the read of it (`tauriFileRef` in
//! web/src/markdownFolder/fileAccess.ts).
//!
//! The inbox: a file or a link arrives three ways, a cold start's arguments,
//! a second launch (single-instance) and on macOS the Opened event. Each
//! goes through `queue_args` or `queue_urls`, which keep the paths the
//! bundle registers and never a `privacynotes://` link (the deep-link
//! plugin's); `notify` tells the page, and `take_pending_opens` hands the
//! paths over and grants the one the page opens (`take`). lib.rs keeps one
//! call for each way in.
//!
//! The read: the fs plugin can only stat a path and then read it, which is
//! two looks at a name. A Linux `/proc` file reports as a regular file of
//! size 0 and then reads without end, and the file at the name can change
//! between the stat and the read (beta issue 168). Here the check and the
//! read are on one opened handle, and the read stops one byte past the
//! limit, so no file can make it run long or large.
//!
//! The path is held to the same scope the plugin's read holds it to: the
//! runtime scope the picker, the folder pick and `take_pending_opens`
//! widened, and the deny list the capability puts on this command
//! (app-commands.json, the same list as every fs grant).

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::ipc::CommandScope;
use tauri::utils::config::FsScope;
use tauri_plugin_fs::FsExt;

/// One deny entry of the capability, a path or `{ "path": ... }`, as the fs
/// plugin's own entries are written.
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
pub enum DenyPath {
    Value(PathBuf),
    Object { path: PathBuf },
}

impl DenyPath {
    fn path(&self) -> PathBuf {
        match self {
            Self::Value(path) | Self::Object { path } => path.clone(),
        }
    }
}

/// Why a read was refused. `notText` and `tooLarge` are the page's own
/// reasons (`FileOpenError`); `forbidden path` is the plugin's wording, which
/// `isScopeRefusal` reads; an OS error keeps its `(os error N)` text, which
/// `openFailedText` reads.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    NotFile,
    TooLarge,
    Io(String),
}

impl Refusal {
    fn code(self) -> String {
        match self {
            Self::NotFile => "notText".to_owned(),
            Self::TooLarge => "tooLarge".to_owned(),
            Self::Io(message) => message,
        }
    }
}

/// `O_NONBLOCK` from the C headers, named here so no crate is added for one
/// flag: Linux and Android (x86 and Arm) and the Apple systems.
#[cfg(any(target_os = "linux", target_os = "android"))]
const O_NONBLOCK: i32 = 0o4000;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const O_NONBLOCK: i32 = 0x0004;

/// Opens for reading without waiting. A named pipe opened for reading waits
/// for a writer, and every later open from outside waits behind it (beta
/// #200, item 4); with `O_NONBLOCK` the open returns at once and the handle
/// check refuses the pipe. The flag changes nothing for a regular file.
fn open_no_wait(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(O_NONBLOCK);
    }
    options.open(path)
}

/// The bytes of a regular file of at most `max` bytes. The type is read from
/// the opened handle, and at most `max + 1` bytes are read, so a file that
/// grows or lies about its size is refused instead of read to the end.
pub fn read_capped(path: &Path, max: u64) -> Result<Vec<u8>, Refusal> {
    let file = open_no_wait(path).map_err(|e| Refusal::Io(e.to_string()))?;
    let meta = file.metadata().map_err(|e| Refusal::Io(e.to_string()))?;
    if !meta.is_file() {
        return Err(Refusal::NotFile);
    }
    if meta.len() > max {
        return Err(Refusal::TooLarge);
    }
    let mut bytes = Vec::new();
    file.take(max.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| Refusal::Io(e.to_string()))?;
    if bytes.len() as u64 > max {
        return Err(Refusal::TooLarge);
    }
    Ok(bytes)
}

/// Read one opened file, raw bytes out. `max` is the page's limit
/// (`TEXT_READ_MAX_BYTES`).
#[tauri::command(async)]
pub fn read_opened_file(
    app: tauri::AppHandle,
    deny: CommandScope<DenyPath>,
    path: String,
    max: u64,
) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("forbidden path".to_owned());
    }
    let denied = deny_scope(&app, &deny).ok_or_else(|| "forbidden path".to_owned())?;
    if !in_fs_scope(&app, &path) || denied.is_forbidden(&path) {
        return Err("forbidden path".to_owned());
    }
    read_capped(&path, max).map(tauri::ipc::Response::new).map_err(Refusal::code)
}

/// The deny list a command's grant carries (app-commands.json), as a scope.
pub fn deny_scope(app: &tauri::AppHandle, deny: &CommandScope<DenyPath>) -> Option<tauri::scope::fs::Scope> {
    tauri::scope::fs::Scope::new(
        app,
        &FsScope::Scope {
            allow: Vec::new(),
            deny: deny.denies().iter().map(|d| d.path()).collect(),
            // A wildcard of the deny list also takes a dot-name, so the list
            // refuses at least what the plugin's would.
            require_literal_leading_dot: Some(false),
        },
    )
    .ok()
}

/// True when the runtime fs scope holds `path`: a file or folder the person opened.
pub fn in_fs_scope(app: &tauri::AppHandle, path: &Path) -> bool {
    app.try_fs_scope().is_some_and(|scope| scope.is_allowed(path))
}

/// Files the OS asked us to open before the webview was ready to hear about it.
///
/// A cold start from a double-click delivers the path within milliseconds, long
/// before the frontend has booted, let alone cleared the auth gate and the app
/// lock. Emitting straight away would drop it on the floor and the user would
/// be left staring at a login screen wondering why their file did not open, so
/// the path waits here until the frontend says it is listening.
/// Spec: docs/internal/specs/markdown-folder.md (section 11)
static INBOX: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Extensions the bundle registers. Kept in step with `fileAssociations` in
/// tauri.conf.json, and checked here because argv carries anything the shell
/// felt like passing - flags, a deep link, a file we never claimed.
const OPENABLE_EXT: [&str; 5] = ["md", "markdown", "mdown", "mkd", "txt"];

/// The URL scheme the bundle registers, kept in step with `plugins.deep-link`
/// in tauri.conf.json and asserted against it by
/// `the_scheme_the_queue_refuses_is_the_one_the_bundle_registers` below.
const APP_SCHEME: &str = "privacynotes:";

/// True when the argument is one of our own deep links.
///
/// Case-insensitively, because a scheme is case-insensitive and the shell
/// hands over whatever the sender typed. Compared as bytes, because every
/// launch argument reaches this, argv[0] included, and a range over a `str`
/// panics when it ends inside a character: a per-user Windows install puts
/// the profile folder name in argv[0], and for José or 田中 byte 13 is
/// mid-character.
fn announces_app_scheme(arg: &str) -> bool {
    arg.as_bytes()
        .get(..APP_SCHEME.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(APP_SCHEME.as_bytes()))
}

pub fn is_openable(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| OPENABLE_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// True when the argument announces a URL scheme, `file:` included.
///
/// Shape, not a parser, and deliberately. A bare Windows path such as
/// `C:\notes\a.md` parses as a URL with scheme "c", so asking a parser what
/// the scheme is would mangle every Windows double-click; a drive letter is
/// one character and a scheme is at least two. And the colon has to come
/// before any separator, because `/tmp/my:file.md` is a legal name on Unix.
///
/// The `://` form is not enough on its own: a scheme can carry an opaque
/// value after a single colon, which is how `privacynotes:x|...` slipped
/// past an earlier version of this test.
fn has_url_scheme(arg: &str) -> bool {
    let Some((scheme, _)) = arg.split_once(':') else { return false };
    if scheme.len() < 2 || scheme.contains('/') || scheme.contains('\\') {
        return false;
    }
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// Turn one argv entry into a filesystem path we claimed, or None.
///
/// The extension check is the obvious job. Two others are not.
///
/// A URL is not a file, whatever its last segment looks like: the app's own
/// scheme arrives on this same argv, and `privacynotes://x/y.md` ends in a
/// registered extension. The deep-link plugin owns those, and handing one to
/// the filesystem is how a link somebody else wrote became a path the app
/// opened.
///
/// The one exception is `file://`, which a Linux file manager launching a
/// `%F` desktop entry may hand over instead of a bare path, and which needs a
/// parser rather than a `strip_prefix` because `file:///home/a/my%20note.md`
/// has to come back with a real space. It is scoped away from Windows, which
/// never sends one: there the single-instance forwarder joins argv with a
/// pipe and splits the payload on the same character, so one crafted deep
/// link arrives as several arguments and the second of them was unwrapped
/// into a path - a local file, or a UNC name pointing at a host of the
/// sender's choosing.
fn openable_path(arg: &str) -> Option<String> {
    #[cfg(not(target_os = "windows"))]
    if arg.starts_with("file://") {
        let path = tauri::Url::parse(arg)
            .ok()?
            .to_file_path()
            .ok()?
            .to_string_lossy()
            .into_owned();
        return is_openable(&path).then_some(path);
    }
    if has_url_scheme(arg) {
        return None;
    }
    is_openable(arg).then_some(arg.to_owned())
}

/// Queue every openable path in an argv-style list. Windows and Linux deliver
/// file opens this way, both on a cold start and through single-instance.
fn queue_batch<I: IntoIterator<Item = String>>(args: I) {
    let args: Vec<String> = args.into_iter().collect();
    // A batch carrying one of our own deep links is a link delivery, not a
    // file open, and the two must never be mixed. On Windows the
    // single-instance forwarder joins argv with a pipe and the receiver
    // splits the payload on the same character, so ONE crafted link arrives
    // as several arguments and every argument after the first looks exactly
    // like a file the shell handed over - a local path, or a network name
    // whose owner learns who opened it.
    //
    // Nothing legitimate is lost, because the deep-link plugin refuses that
    // same batch: it takes the argument after the binary only when there is
    // no second one (tauri-plugin-deep-link-2.6.1/src/lib.rs:211-218), so a
    // split payload is already dead as a link before our callback runs. This
    // closes the delivery rather than the shape, which is why a double-click
    // on a note that lives on a file server is still an ordinary open.
    if args.iter().any(|a| announces_app_scheme(a)) {
        return;
    }
    let mut queue = INBOX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    for arg in args.into_iter().skip(1) {
        if let Some(path) = openable_path(&arg) {
            queue.push(path);
        }
    }
}

/// A second launch's arguments with each relative path joined onto the
/// folder that launch ran in. The running app's own folder is another one,
/// so `notes.md` typed in `~/work` would open a file of that name from where
/// the app was first started. argv[0], flags and anything with a scheme pass
/// as they are.
fn from_cwd(args: Vec<String>, cwd: &str) -> Vec<String> {
    if cwd.is_empty() {
        return args;
    }
    args.into_iter()
        .enumerate()
        .map(|(i, arg)| {
            if i == 0 || arg.starts_with('-') || has_url_scheme(&arg) || !std::path::Path::new(&arg).is_relative() {
                arg
            } else {
                std::path::Path::new(cwd).join(&arg).to_string_lossy().into_owned()
            }
        })
        .collect()
}

/// A launch's own arguments, each relative path joined onto the folder it
/// started in (`from_cwd`): a cold start's process folder, or the folder a
/// second launch ran in. An argument or a folder that is not Unicode is
/// dropped; with no readable folder the arguments pass as they are.
fn launch_args<I: IntoIterator<Item = std::ffi::OsString>>(args: I, cwd: Option<std::path::PathBuf>) -> Vec<String> {
    let args = args.into_iter().filter_map(|a| a.into_string().ok()).collect();
    let cwd = cwd.and_then(|d| d.into_os_string().into_string().ok()).unwrap_or_default();
    from_cwd(args, &cwd)
}

/// One launch's arguments, the way Windows and Linux hand over a file: a
/// cold start (`std::env::args_os()` and the process folder) or a second
/// launch (single-instance, with the folder it ran in). Each openable path
/// is queued; a batch that carries the app's own link queues nothing.
pub fn queue_args<I: IntoIterator<Item = std::ffi::OsString>>(args: I, cwd: Option<PathBuf>) {
    queue_batch(launch_args(args, cwd));
}

/// The macOS `RunEvent::Opened` URLs: macOS sends a double-click as an Apple
/// Event, never in argv. Each URL counts on its own: a file URL with a
/// registered extension is queued, and anything else has no file path to
/// give (`privacynotes://` is the deep-link plugin's).
#[cfg(any(target_os = "macos", test))]
pub fn queue_urls(urls: &[tauri::Url]) {
    let mut queue = INBOX.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    for url in urls {
        if let Ok(path) = url.to_file_path() {
            if let Some(p) = path.to_str() {
                if is_openable(p) {
                    queue.push(p.to_string());
                }
            }
        }
    }
}

/// A second launch's batch that carries one of the app's own links (the Ninja
/// box check in lib.rs refuses it too).
pub fn carries_app_link(args: &[String]) -> bool {
    args.iter().any(|a| announces_app_scheme(a))
}

/// Tell the page there is something to take. It calls `take_pending_opens`
/// when it is ready, not when this fires.
pub fn notify<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter;
    let _ = app.emit("markdown-open-pending", ());
}

/// Drain the queue, every path in the order it came. `grant` gets the last
/// path and its staging path beside it, and nothing else.
///
/// The fs scope has no static allow, and the only other runtime widening is
/// the one the dialog plugin gives a picker; a double-click never goes
/// through a picker, so without the grant every double-clicked file is
/// ACL-denied the instant the frontend reads it. The staging path
/// (`stagingPath` in markdownFolder/fileAccess.ts) lets a save be staged and
/// renamed over the file rather than written in place. The last one only,
/// which is the one the frontend opens (`usePendingFileOpens.ts`): a
/// multi-select hands over several, and the widening is process-wide and
/// permanent, so granting the rest keeps whatever they name reachable for the
/// life of the run and buys nothing. A path that cannot be granted is still
/// returned: the read then fails with the frontend's own error state rather
/// than being dropped here.
/// Spec: docs/internal/specs/markdown-folder.md (section 11)
pub fn take(mut grant: impl FnMut(&str)) -> Vec<String> {
    let paths = std::mem::take(&mut *INBOX.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
    if let Some(path) = paths.last() {
        grant(path);
        grant(&format!("{path}.pn-tmp"));
    }
    paths
}

/// Drain the queue. Called by the frontend once it is ready to act on a path,
/// which is why this is a command rather than an event: the frontend asks when
/// it is ready, instead of us guessing when that is. The scope is widened
/// here, the first point with an `AppHandle`.
#[tauri::command]
pub fn take_pending_opens(app: tauri::AppHandle) -> Vec<String> {
    let scope = app.try_fs_scope();
    take(|path| {
        if let Some(scope) = &scope {
            let _ = scope.allow_file(path);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{read_capped, Refusal};
    use std::fs;

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pn-opened-file-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp folder");
        dir
    }

    #[test]
    fn opened_file_reads_up_to_the_cap_and_refuses_past_it() {
        let dir = temp("cap");
        let file = dir.join("notes.md");
        fs::write(&file, b"12345").expect("writes");
        assert_eq!(read_capped(&file, 5), Ok(b"12345".to_vec()));
        assert_eq!(read_capped(&file, 4), Err(Refusal::TooLarge));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opened_file_refuses_a_folder() {
        let dir = temp("folder");
        assert_eq!(read_capped(&dir, 1024), Err(Refusal::NotFile));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A device reports size 0 and has no end: refused before any read.
    #[cfg(unix)]
    #[test]
    fn opened_file_refuses_a_device() {
        assert_eq!(read_capped(std::path::Path::new("/dev/zero"), 1024), Err(Refusal::NotFile));
    }

    /// A link to a device is opened through, and the handle is what is
    /// checked.
    #[cfg(unix)]
    #[test]
    fn opened_file_refuses_a_link_to_a_device() {
        let dir = temp("link");
        let link = dir.join("README.md");
        std::os::unix::fs::symlink("/dev/zero", &link).expect("link");
        assert_eq!(read_capped(&link, 1024), Err(Refusal::NotFile));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A named pipe with no writer is refused at once, not waited on.
    #[cfg(unix)]
    #[test]
    fn opened_file_refuses_a_pipe_without_waiting() {
        let dir = temp("pipe");
        let pipe = dir.join("README.md");
        let made = std::process::Command::new("mkfifo").arg(&pipe).status().expect("mkfifo runs");
        assert!(made.success());
        let (tx, rx) = std::sync::mpsc::channel();
        let path = pipe.clone();
        std::thread::spawn(move || {
            let _ = tx.send(read_capped(&path, 1024));
        });
        let got = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("the open does not wait for a writer");
        assert_eq!(got, Err(Refusal::NotFile));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A Linux `/proc` file is regular with size 0 and more bytes than it
    /// says: the read stops one byte past the cap.
    #[cfg(target_os = "linux")]
    #[test]
    fn opened_file_stops_a_proc_file_at_the_cap() {
        assert_eq!(read_capped(std::path::Path::new("/proc/self/maps"), 8), Err(Refusal::TooLarge));
    }
}

/// The argv side of the file association, which is the only part of it that
/// can be reached without an `AppHandle`.
///
/// Two refusals live here. A path is claimed
/// on its extension alone, and a `file://` value is unwrapped through a URL
/// parser, so a token that is neither still has to be refused. And the
/// unwrapping is scoped to the platform that needs it: a Linux file manager
/// launching a `%F` desktop entry may hand over a URL, while on Windows the
/// same code turned an attacker-supplied deep link into a filesystem path,
/// because the single-instance forwarder splits one argument into several.
#[cfg(test)]
mod inbox_tests {
    use super::*;

    /// `INBOX` is one queue for the whole process and the harness
    /// runs tests on parallel threads, so every test that fills it holds
    /// this for its whole run. Its poisoning is ignored: a test that fails
    /// while holding it has already reported that failure.
    static QUEUE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn claims_the_registered_extensions_and_nothing_else() {
        assert_eq!(openable_path("/tmp/a.md").as_deref(), Some("/tmp/a.md"));
        assert_eq!(openable_path("/tmp/a.MD").as_deref(), Some("/tmp/a.MD"));
        assert_eq!(openable_path("/tmp/a.txt").as_deref(), Some("/tmp/a.txt"));
        assert!(openable_path("/tmp/a.pdf").is_none());
        assert!(openable_path("--flag").is_none());
        assert!(openable_path("/tmp/noextension").is_none());
    }

    #[test]
    fn a_deep_link_is_not_a_file() {
        // The scheme is the app's own, and the last segment ends in one of the
        // registered extensions, which is all `is_openable` looks at.
        assert!(openable_path("privacynotes://x/y.md").is_none());
        // The opaque form, which is what the Windows forwarder splits.
        assert!(openable_path("privacynotes:x|file:///tmp/a.md").is_none());
        assert!(openable_path("https://example.com/a.md").is_none());
    }

    #[test]
    fn a_path_that_merely_contains_a_colon_is_still_a_path() {
        // One character before the colon is a Windows drive, not a scheme.
        assert_eq!(openable_path("C:\\notes\\a.md").as_deref(), Some("C:\\notes\\a.md"));
        // And a colon after a separator belongs to the file name.
        assert_eq!(openable_path("/tmp/my:file.md").as_deref(), Some("/tmp/my:file.md"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unwraps_a_file_url_where_a_file_manager_sends_one() {
        assert_eq!(openable_path("file:///tmp/a.md").as_deref(), Some("/tmp/a.md"));
        // Percent-encoding is why this goes through a parser at all.
        assert_eq!(
            openable_path("file:///tmp/my%20note.md").as_deref(),
            Some("/tmp/my note.md"),
        );
    }

    /// The Windows refusal, pinned where every platform can run it.
    ///
    /// On Windows the `file://` unwrapping is compiled out, so such an
    /// argument falls to the general rule below, and this is that rule. A
    /// build for another platform cannot exercise the branch itself, so the
    /// predicate it depends on is asserted instead.
    #[test]
    fn a_file_url_is_a_url_by_the_general_rule() {
        assert!(has_url_scheme("file:///C:/Users/victim/notes/private.md"));
        assert!(has_url_scheme("file://attacker.example/share/x.md"));
        assert!(!has_url_scheme("C:\\notes\\a.md"));
        assert!(!has_url_scheme("/tmp/my:file.md"));
        assert!(!has_url_scheme("--flag"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn refuses_a_file_url_on_windows() {
        // Windows never delivers one, and the single-instance forwarder joins
        // argv with a pipe and splits the payload on the same character, so
        // one crafted deep link arrives as several arguments. Unwrapping here
        // turned the second of them into a path the app then opened, local or
        // a UNC name pointing at a host the sender chose.
        assert!(openable_path("file:///C:/Users/victim/notes/private.md").is_none());
        assert!(openable_path("file://attacker.example/share/x.md").is_none());
    }

    /// The third producer of the queue, and why it needs no scheme check.
    ///
    /// macOS delivers a double-click as an Apple Event rather than in argv,
    /// so `queue_urls` (`RunEvent::Opened`) pushes straight onto the queue
    /// without going through `openable_path`. It calls `to_file_path()` first, which is a
    /// stronger rule than the one above rather than a missing one: a URL that
    /// is not a file URL has no file path to give. Asserted because the claim
    /// is about a library, not about our code.
    #[test]
    fn a_non_file_url_has_no_file_path() {
        let deep = tauri::Url::parse("privacynotes://x/y.md").unwrap();
        assert!(deep.to_file_path().is_err());
        let web = tauri::Url::parse("https://example.com/a.md").unwrap();
        assert!(web.to_file_path().is_err());
        let file = tauri::Url::parse("file:///tmp/a.md").unwrap();
        assert!(file.to_file_path().is_ok());
    }

    #[test]
    fn a_batch_carrying_the_app_scheme_queues_nothing() {
        let _queue = QUEUE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // What the Windows forwarder produces from one crafted link: the
        // scheme token, then the payload, which announces nothing and ends in
        // a registered extension. A UNC name is the sharp one - opening it is
        // an outbound connection to a host the sender chose.
        INBOX.lock().unwrap().clear();
        queue_batch([
            "app.exe".to_string(),
            "privacynotes:x".to_string(),
            "\\\\attacker.example\\share\\x.md".to_string(),
        ]);
        assert!(INBOX.lock().unwrap().is_empty());

        // And the same batch shape with a local path, which is the same
        // injection with a quieter payload.
        queue_batch([
            "app.exe".to_string(),
            "privacynotes://auth-callback".to_string(),
            "C:\\Users\\victim\\notes\\private.md".to_string(),
        ]);
        assert!(INBOX.lock().unwrap().is_empty());
        INBOX.lock().unwrap().clear();
    }

    #[test]
    fn a_network_path_still_opens_when_nobody_smuggled_it() {
        let _queue = QUEUE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // The refusal is about the delivery, not the shape: a double-click on
        // a note that lives on a real file server is an ordinary open.
        INBOX.lock().unwrap().clear();
        queue_batch([
            "app.exe".to_string(),
            "\\\\fileserver\\team\\notes.md".to_string(),
        ]);
        assert_eq!(
            INBOX.lock().unwrap().clone(),
            vec!["\\\\fileserver\\team\\notes.md"],
        );
        INBOX.lock().unwrap().clear();
    }

    #[test]
    fn queue_skips_argv_zero_and_keeps_the_order_given() {
        let _queue = QUEUE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        INBOX.lock().unwrap().clear();
        queue_batch([
            "/Applications/PrivacyNotes.app/Contents/MacOS/a.md".to_string(),
            "/tmp/first.md".to_string(),
            "--flag".to_string(),
            "/tmp/second.txt".to_string(),
        ]);
        let queued = INBOX.lock().unwrap().clone();
        assert_eq!(queued, vec!["/tmp/first.md", "/tmp/second.txt"]);
        INBOX.lock().unwrap().clear();
    }

    /// Launch arguments whose byte 13, the scheme's length, falls inside a
    /// character: argv[0] of a per-user Windows install under each of these
    /// profile names, and a Linux note path. The first assertion pins that,
    /// so the fixtures keep testing the boundary if the scheme changes.
    #[test]
    fn a_non_ascii_launch_argument_is_not_a_link() {
        for arg in [
            "C:\\Users\\José\\AppData\\Local\\PrivacyNotes\\privacynotes.exe",
            "C:\\Users\\René\\AppData\\Local\\PrivacyNotes\\privacynotes.exe",
            "C:\\Users\\María\\AppData\\Local\\PrivacyNotes\\privacynotes.exe",
            "C:\\Users\\田中\\AppData\\Local\\PrivacyNotes\\privacynotes.exe",
            "C:\\Users\\김철수\\AppData\\Local\\PrivacyNotes\\privacynotes.exe",
            "C:\\Users\\さくら\\AppData\\Local\\PrivacyNotes\\privacynotes.exe",
            "/home/wang/文档/note.md",
        ] {
            assert!(!arg.is_char_boundary(APP_SCHEME.len()), "{arg}");
            assert!(!announces_app_scheme(arg), "{arg}");
        }
        // Still a scheme test: ASCII case is ignored, and an argument
        // shorter than the scheme is never a link.
        assert!(announces_app_scheme("PrivacyNotes://auth-callback"));
        assert!(!announces_app_scheme("privacynote"));
    }

    /// The same launches end to end: a Windows cold start from a profile
    /// folder named José, and a Linux double-click on a note in a folder
    /// named in Cyrillic. Each has to queue its file, not abort the app.
    #[test]
    fn a_non_ascii_launch_still_queues_its_file() {
        let _queue = QUEUE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        INBOX.lock().unwrap().clear();
        queue_batch([
            "C:\\Users\\José\\AppData\\Local\\PrivacyNotes\\privacynotes.exe".to_string(),
            "C:\\Users\\José\\Documents\\note.md".to_string(),
        ]);
        queue_batch([
            "/usr/bin/privacynotes".to_string(),
            "/home/max/Документы/x.md".to_string(),
        ]);
        let queued = INBOX.lock().unwrap().clone();
        INBOX.lock().unwrap().clear();
        assert_eq!(
            queued,
            vec!["C:\\Users\\José\\Documents\\note.md", "/home/max/Документы/x.md"],
        );
    }

    /// Beta issue 168 (2): a relative path from a second launch is read from
    /// that launch's folder; argv[0], flags, links and absolute paths stay.
    #[test]
    fn a_second_launch_resolves_a_relative_path_from_its_own_folder() {
        let cwd = if cfg!(windows) { "C:\\work" } else { "/home/a/work" };
        let abs = if cfg!(windows) { "C:\\x\\b.md" } else { "/x/b.md" };
        let out = from_cwd(
            ["privacynotes", "notes.md", "--ninja", "privacynotes://note/1", abs]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            cwd,
        );
        let joined = std::path::Path::new(cwd).join("notes.md").to_string_lossy().into_owned();
        assert_eq!(out, vec!["privacynotes".to_string(), joined, "--ninja".into(), "privacynotes://note/1".into(), abs.into()]);
        assert_eq!(from_cwd(vec!["p".into(), "a.md".into()], ""), vec!["p".to_string(), "a.md".into()]);
    }

    // The three ways a file or a link reaches the launch queue. Only these
    // three adapters name the code under test; the table below them is the
    // characterization and did not change when the queue moved. The second
    // launch and the cold start are the same now: both go through
    // `queue_args`, as lib.rs calls it for each.
    fn second_launch(args: &[&str], cwd: &str) -> Vec<String> {
        INBOX.lock().unwrap().clear();
        queue_args(args.iter().map(std::ffi::OsString::from), Some(std::path::PathBuf::from(cwd)));
        take(|_| {})
    }
    fn cold_start(args: &[&str], cwd: &str) -> Vec<String> {
        INBOX.lock().unwrap().clear();
        queue_args(args.iter().map(std::ffi::OsString::from), Some(std::path::PathBuf::from(cwd)));
        take(|_| {})
    }
    fn macos_opened(urls: &[&str]) -> Vec<String> {
        INBOX.lock().unwrap().clear();
        let urls: Vec<tauri::Url> = urls.iter().map(|u| tauri::Url::parse(u).unwrap()).collect();
        queue_urls(&urls);
        take(|_| {})
    }

    /// Each way in, with a file and with a `privacynotes://` link (GHSA-mxc4,
    /// deep links): a file is queued, a link never is (the deep-link plugin
    /// owns it), and a batch that carries a link queues none of its files.
    #[test]
    fn each_way_in_queues_a_file_and_never_a_link() {
        let _queue = QUEUE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (cwd, abs, rel) = if cfg!(windows) {
            ("C:\\work", "C:\\x\\a.md", "C:\\work\\b.md")
        } else {
            ("/home/a/work", "/x/a.md", "/home/a/work/b.md")
        };
        for way in [second_launch, cold_start] {
            assert_eq!(way(&["privacynotes", abs], cwd), [abs]);
            assert_eq!(way(&["privacynotes", "b.md"], cwd), [rel]);
            assert_eq!(way(&["privacynotes", abs, "--flag", "c.pdf"], cwd), [abs]);
            assert!(way(&["privacynotes", "privacynotes://note/1"], cwd).is_empty());
            assert!(way(&["privacynotes", "privacynotes://x/y.md"], cwd).is_empty());
            assert!(way(&["privacynotes", "PrivacyNotes:x", abs], cwd).is_empty());
            assert!(way(&["privacynotes", abs, "privacynotes://auth-callback"], cwd).is_empty());
        }
        assert_eq!(macos_opened(&["file:///tmp/a.md"]), ["/tmp/a.md"]);
        assert_eq!(macos_opened(&["file:///tmp/my%20note.MD", "file:///tmp/b.pdf"]), ["/tmp/my note.MD"]);
        assert!(macos_opened(&["privacynotes://note/1"]).is_empty());
        assert!(macos_opened(&["privacynotes://x/y.md"]).is_empty());
        // Each URL of the event on its own: a link beside a file drops only itself.
        assert_eq!(macos_opened(&["privacynotes://x/y.md", "file:///tmp/a.md"]), ["/tmp/a.md"]);
        assert!(macos_opened(&["https://example.com/a.md"]).is_empty());
    }

    /// Beta issue 200 (1): a cold start from a terminal reads a relative path
    /// from that folder too, so the page never gets a path the opener refuses.
    #[test]
    fn a_cold_start_resolves_a_relative_path_from_its_folder() {
        let cwd = if cfg!(windows) { "C:\\work" } else { "/home/a/work" };
        let args = ["privacynotes", "notes.md", "--ninja"].map(std::ffi::OsString::from);
        let out = launch_args(args.clone(), Some(std::path::PathBuf::from(cwd)));
        let joined = std::path::Path::new(cwd).join("notes.md").to_string_lossy().into_owned();
        assert_eq!(out, vec!["privacynotes".to_string(), joined, "--ninja".into()]);
        assert!(std::path::Path::new(&out[1]).is_absolute());
        assert_eq!(launch_args(args, None), vec!["privacynotes".to_string(), "notes.md".into(), "--ninja".into()]);
    }

    /// `take_pending_opens`: the queue drains in order, and only the last
    /// path, the one the page opens, and its staging path are granted.
    #[test]
    fn take_grants_only_the_last_path_and_its_staging_path() {
        let _queue = QUEUE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (a, b) = if cfg!(windows) { ("C:\\x\\a.md", "C:\\x\\b.txt") } else { ("/x/a.md", "/x/b.txt") };
        INBOX.lock().unwrap().clear();
        queue_args(["privacynotes", a, b].map(std::ffi::OsString::from), None);
        let mut granted = Vec::new();
        assert_eq!(take(|p| granted.push(p.to_owned())), [a, b]);
        assert_eq!(granted, [b.to_owned(), format!("{b}.pn-tmp")]);
        // Empty now: nothing more to take, nothing granted.
        assert!(take(|p| panic!("granted {p}")).is_empty());
    }

    fn conf() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    /// The scheme the queue refuses is the one the bundle registers. The
    /// refusal of a batch that carries a link is only as good as this name.
    #[test]
    fn the_scheme_the_queue_refuses_is_the_one_the_bundle_registers() {
        let schemes = &conf()["plugins"]["deep-link"]["desktop"]["schemes"];
        let ours = APP_SCHEME.strip_suffix(':').unwrap();
        assert!(schemes.as_array().unwrap().iter().any(|s| s == ours), "{schemes}");
    }

    /// The extensions the queue claims are the ones the bundle registers
    /// (`bundle.fileAssociations`): one the bundle registers and the queue
    /// does not claim is a double-click that opens the app and does nothing.
    /// The page's own list is held to the bundle by
    /// `tests/desktopCapabilities.test.ts`.
    #[test]
    fn the_extensions_the_queue_claims_are_the_ones_the_bundle_registers() {
        let mut bundle: Vec<String> = conf()["bundle"]["fileAssociations"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|a| a["ext"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_owned()))
            .collect();
        let mut ours: Vec<String> = OPENABLE_EXT.iter().map(|e| e.to_string()).collect();
        bundle.sort();
        ours.sort();
        assert_eq!(bundle, ours);
    }
}
