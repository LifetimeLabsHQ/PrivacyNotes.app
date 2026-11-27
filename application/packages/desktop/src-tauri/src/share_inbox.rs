//! The inbox of items other apps shared into this one, through the system
//! share sheet.
//!
//! On iOS the share sheet runs our share extension, a separate process that
//! cannot reach the running app. It writes each item into a folder of the app
//! group both processes belong to. On Android the activity receives the share
//! itself (MainActivity.kt) and writes the same layout into the app's own data
//! folder. Either way the app takes the items from there once the user has
//! signed in and cleared the app lock: the frontend drains the inbox from
//! inside the authenticated shell, never before.
//!
//! Layout: `<inbox>/<uuid>/item.json`, plus `<inbox>/<uuid>/payload` for a file.
//! The extension writes an item under a temporary name and renames it into
//! place, so a folder named by a bare UUID is always complete.
//!
//! Everything read here is untrusted: any app on the phone can share into us,
//! and the extension copies what it is given. Kinds are a closed set, the
//! lengths are capped, a link must be http or https, an id must be a UUID
//! before it is joined onto a path, and a file is read only when it is a
//! regular file, never through a link, and never past its cap. An invalid item
//! is deleted; one that cannot be read right now stays for the next drain.
//! Spec: docs/internal/specs/share-into-app.md
#![cfg_attr(not(mobile), allow(dead_code))]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

/// The app group the iOS app and its share extension both belong to. The
/// extension's Swift source and both entitlements files carry the same string.
#[cfg(target_os = "ios")]
const APP_GROUP: &str = "group.app.privacynotes";

const ITEM_FILE: &str = "item.json";
/// Beside the inbox, never in it: `list_in` would delete it as an invalid item.
/// ShareViewController.swift reads the same names.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
const LIMIT_FILE: &str = "ShareLimit";
/// Non-sensitive organizer metadata (non-PIN task list titles, folder names,
/// tags) mirrored for the iOS share extension while App Lock is off, plus the
/// extension's last-picked task list ID. Kept in a sibling directory marked
/// complete-protection and excluded from device backups, never inside
/// `ShareInbox`. Cleared on sign-out, account switch, wipe, and when App Lock
/// is turned on.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
const META_DIR: &str = "ShareMeta";
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
const CATALOG_FILE: &str = "ShareCatalog.json";
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
const LAST_PICK_FILE: &str = "ShareLastPick";
const PAYLOAD_FILE: &str = "payload";
/// The largest per-file limit the app grants (the storage add-on); the app's
/// own check names the lower limits to the user. The extension holds the same cap.
const MAX_PAYLOAD_BYTES: u64 = 100 * 1000 * 1000;
const MAX_ITEM_JSON_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 500_000;
const MAX_URL_CHARS: usize = 8_192;
const MAX_SHORT_CHARS: usize = 1_000;
const MAX_FOLDER_ID_CHARS: usize = 100;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 100;
const MAX_CATALOG_TASK_LISTS: usize = 100;
const MAX_CATALOG_FOLDERS: usize = 150;
const MAX_CATALOG_TAGS: usize = 100;
const MAX_CATALOG_LABEL_CHARS: usize = 120;
/// A `.tmp-` folder older than this was abandoned by an extension that was
/// stopped mid-copy, and is deleted.
const STALE_TMP: Duration = Duration::from_secs(60 * 60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawItem {
    v: u32,
    kind: String,
    created: Option<u64>,
    url: Option<String>,
    title: Option<String>,
    text: Option<String>,
    name: Option<String>,
    mime: Option<String>,
    target: Option<String>,
    group: Option<String>,
    task_list_id: Option<String>,
    folder_id: Option<String>,
    tags: Option<Vec<String>>,
}

/// One item, as the frontend receives it. A `file` carries no bytes here: the
/// frontend reads them with `share_inbox_read` when it stores the file.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedItem {
    pub id: String,
    pub kind: &'static str,
    pub created: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_list_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Deserialize, Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareCatalogTaskList {
    pub id: String,
    pub title: String,
}

#[derive(Deserialize, Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareCatalogFolder {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareCatalogInput {
    #[serde(default)]
    pub folders_unlocked: bool,
    #[serde(default)]
    pub task_lists: Vec<ShareCatalogTaskList>,
    #[serde(default)]
    pub folders: Vec<ShareCatalogFolder>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ShareCatalogFile {
    v: u32,
    folders_unlocked: bool,
    task_lists: Vec<ShareCatalogTaskList>,
    folders: Vec<ShareCatalogFolder>,
    tags: Vec<String>,
}

/// A UUID in its canonical text form, either case. The only shape of name
/// that is ever joined onto the inbox path.
fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn valid_folder_id(s: Option<String>) -> Option<String> {
    let s = s?.trim().to_string();
    if s.is_empty() || s.len() > MAX_FOLDER_ID_CHARS {
        return None;
    }
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        .then_some(s)
}

fn sanitize_tags(tags: Option<Vec<String>>, max_count: usize, max_len: usize) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for raw in tags? {
        if out.len() >= max_count {
            break;
        }
        let cleaned: String = raw.trim().chars().take(max_len).collect();
        let cleaned = cleaned.trim().to_string();
        if !cleaned.is_empty() && !out.contains(&cleaned) {
            out.push(cleaned);
        }
    }
    (!out.is_empty()).then_some(out)
}

fn sanitize_catalog(input: ShareCatalogInput) -> ShareCatalogFile {
    let mut task_lists = Vec::new();
    for item in input.task_lists {
        if task_lists.len() >= MAX_CATALOG_TASK_LISTS {
            break;
        }
        let id = item.id.trim().to_string();
        let Some(title) = capped(Some(item.title), MAX_CATALOG_LABEL_CHARS) else {
            continue;
        };
        if is_uuid(&id) && !task_lists.iter().any(|t: &ShareCatalogTaskList| t.id == id) {
            task_lists.push(ShareCatalogTaskList { id, title });
        }
    }
    let mut folders = Vec::new();
    if input.folders_unlocked {
        for item in input.folders {
            if folders.len() >= MAX_CATALOG_FOLDERS {
                break;
            }
            let Some(id) = valid_folder_id(Some(item.id)) else {
                continue;
            };
            let Some(name) = capped(Some(item.name), MAX_CATALOG_LABEL_CHARS) else {
                continue;
            };
            if !folders.iter().any(|f: &ShareCatalogFolder| f.id == id) {
                folders.push(ShareCatalogFolder { id, name });
            }
        }
    }
    let tags = sanitize_tags(Some(input.tags), MAX_CATALOG_TAGS, MAX_TAG_CHARS).unwrap_or_default();
    ShareCatalogFile {
        v: 1,
        folders_unlocked: input.folders_unlocked,
        task_lists,
        folders,
        tags,
    }
}

fn capped(s: Option<String>, max: usize) -> Option<String> {
    let s = s?.trim().to_string();
    if s.is_empty() {
        return None;
    }
    Some(s.chars().take(max).collect())
}

fn web_url(s: Option<String>) -> Option<String> {
    let s = s?.trim().to_string();
    if s.chars().count() > MAX_URL_CHARS {
        return None;
    }
    let url = tauri::Url::parse(&s).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// A file name with no directory part, so it can only ever name the file.
fn file_name(s: Option<String>) -> Option<String> {
    let s = capped(s, MAX_SHORT_CHARS)?;
    let last = s.rsplit(['/', '\\']).next().unwrap_or("").trim();
    (!last.is_empty() && last != "." && last != "..").then(|| last.to_string())
}

enum Capped {
    Bytes(Vec<u8>),
    /// Not a regular file, a link, or over the cap: never usable.
    Invalid,
    /// Missing or unreadable now, for example while file protection holds it.
    Unreadable,
}

/// Reads a regular file, never through a link, and never more than `cap`
/// bytes, so a file that grows after the size check is still refused.
fn read_capped(path: &Path, cap: u64) -> Capped {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Capped::Unreadable };
    if !meta.is_file() || meta.len() > cap {
        return Capped::Invalid;
    }
    let Ok(file) = std::fs::File::open(path) else { return Capped::Unreadable };
    // The path was checked, then opened: refuse it when what was opened is not
    // the file that was checked, which is how a link swapped in between shows.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let Ok(opened) = file.metadata() else { return Capped::Unreadable };
        if opened.dev() != meta.dev() || opened.ino() != meta.ino() {
            return Capped::Invalid;
        }
    }
    let mut bytes = Vec::new();
    if file.take(cap + 1).read_to_end(&mut bytes).is_err() {
        return Capped::Unreadable;
    }
    if bytes.len() as u64 > cap {
        return Capped::Invalid;
    }
    Capped::Bytes(bytes)
}

enum ItemRead {
    Item(Box<SharedItem>),
    Invalid,
    Unreadable,
}

/// Read and validate one item folder.
fn read_item(dir: &Path, id: &str) -> ItemRead {
    match read_capped(&dir.join(ITEM_FILE), MAX_ITEM_JSON_BYTES) {
        Capped::Bytes(bytes) => parse_item(dir, id, &bytes).map_or(ItemRead::Invalid, |item| ItemRead::Item(Box::new(item))),
        Capped::Invalid => ItemRead::Invalid,
        Capped::Unreadable => ItemRead::Unreadable,
    }
}

fn parse_target_for_url(raw: Option<&str>) -> Option<&'static str> {
    match raw? {
        "bookmark" => Some("bookmark"),
        "clip" => Some("clip"),
        "note" => Some("note"),
        "task" => Some("task"),
        "journal" => Some("journal"),
        _ => None,
    }
}

fn parse_target_for_text(raw: Option<&str>) -> Option<&'static str> {
    match raw? {
        "note" => Some("note"),
        "task" => Some("task"),
        "journal" => Some("journal"),
        "bookmark" => Some("bookmark"),
        _ => None,
    }
}

fn parse_target_for_file(raw: Option<&str>) -> Option<&'static str> {
    match raw? {
        "note" => Some("note"),
        "journal" => Some("journal"),
        "files" => Some("files"),
        _ => None,
    }
}

fn parse_item(dir: &Path, id: &str, bytes: &[u8]) -> Option<SharedItem> {
    let raw: RawItem = serde_json::from_slice(bytes).ok()?;
    if raw.v != 1 {
        return None;
    }
    let tags = sanitize_tags(raw.tags, MAX_TAGS, MAX_TAG_CHARS);
    let base = SharedItem {
        id: id.to_string(),
        kind: "text",
        created: raw.created.unwrap_or(0),
        url: None,
        title: None,
        text: None,
        name: None,
        mime: None,
        size: None,
        target: None,
        group: None,
        task_list_id: None,
        folder_id: None,
        tags: None,
    };
    match raw.kind.as_str() {
        "url" => match web_url(raw.url.clone()) {
            Some(url) => {
                let target = parse_target_for_url(raw.target.as_deref());
                let task_list_id = (target == Some("task"))
                    .then(|| raw.task_list_id.as_deref().filter(|t| is_uuid(t)).map(str::to_string))
                    .flatten();
                let folder_id = (!matches!(target, Some("task" | "journal")))
                    .then(|| valid_folder_id(raw.folder_id))
                    .flatten();
                Some(SharedItem {
                    kind: "url",
                    url: Some(url),
                    title: capped(raw.title, MAX_SHORT_CHARS),
                    text: capped(raw.text, MAX_TEXT_CHARS),
                    target,
                    task_list_id,
                    folder_id,
                    tags: (target != Some("task")).then_some(tags).flatten(),
                    ..base
                })
            }
            // A web address the share sheet already reported as saved, too
            // long or refused by the parser (Android writes any
            // `^https?://\S+$` text as a link): kept as text, not deleted
            // (beta issue 176). Any other scheme is still refused.
            None if raw.url.as_deref().is_some_and(|u| {
                let u = u.trim_start().as_bytes();
                u.get(..7).is_some_and(|h| h.eq_ignore_ascii_case(b"http://"))
                    || u.get(..8).is_some_and(|h| h.eq_ignore_ascii_case(b"https://"))
            }) =>
            {
                let target = parse_target_for_text(raw.target.as_deref());
                let task_list_id = (target == Some("task"))
                    .then(|| raw.task_list_id.as_deref().filter(|t| is_uuid(t)).map(str::to_string))
                    .flatten();
                let folder_id = (!matches!(target, Some("task" | "journal")))
                    .then(|| valid_folder_id(raw.folder_id))
                    .flatten();
                Some(SharedItem {
                    kind: "text",
                    title: capped(raw.title, MAX_SHORT_CHARS),
                    text: Some(capped(raw.url, MAX_TEXT_CHARS)?),
                    target,
                    task_list_id,
                    folder_id,
                    tags: (target != Some("task")).then_some(tags).flatten(),
                    ..base
                })
            }
            None => None,
        },
        "text" => {
            let target = parse_target_for_text(raw.target.as_deref());
            let task_list_id = (target == Some("task"))
                .then(|| raw.task_list_id.as_deref().filter(|t| is_uuid(t)).map(str::to_string))
                .flatten();
            let folder_id = (!matches!(target, Some("task" | "journal")))
                .then(|| valid_folder_id(raw.folder_id))
                .flatten();
            Some(SharedItem {
                kind: "text",
                title: capped(raw.title, MAX_SHORT_CHARS),
                text: Some(capped(raw.text, MAX_TEXT_CHARS)?),
                target,
                task_list_id,
                folder_id,
                tags: (target != Some("task")).then_some(tags).flatten(),
                ..base
            })
        }
        "file" => {
            let meta = std::fs::symlink_metadata(dir.join(PAYLOAD_FILE)).ok()?;
            if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_PAYLOAD_BYTES {
                return None;
            }
            let target = parse_target_for_file(raw.target.as_deref());
            let grouped = matches!(target, Some("note" | "journal"));
            let group = grouped
                .then(|| raw.group.as_deref().filter(|g| is_uuid(g)).map(str::to_string))
                .flatten();
            let folder_id = (target != Some("journal"))
                .then(|| valid_folder_id(raw.folder_id))
                .flatten();
            Some(SharedItem {
                kind: "file",
                name: Some(file_name(raw.name).unwrap_or_else(|| "file".to_string())),
                mime: capped(raw.mime, MAX_SHORT_CHARS),
                size: Some(meta.len()),
                target,
                group,
                title: grouped.then(|| capped(raw.title, MAX_SHORT_CHARS)).flatten(),
                text: grouped.then(|| capped(raw.text, MAX_TEXT_CHARS)).flatten(),
                folder_id,
                tags,
                ..base
            })
        }
        _ => None,
    }
}

/// Every complete item in `inbox`, oldest first. An invalid item is deleted on
/// the way, and so are the `.tmp-` folders a copier abandoned; while any of
/// them is younger than `STALE_TMP` a share is still being written and all of
/// them are left alone.
pub fn list_in(inbox: &Path) -> Vec<SharedItem> {
    let Ok(entries) = std::fs::read_dir(inbox) else { return Vec::new() };
    let mut items = Vec::new();
    let mut temps = Vec::new();
    for entry in entries.flatten() {
        let Some(id) = entry.file_name().to_str().map(str::to_string) else { continue };
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if !is_uuid(&id) {
            if id.starts_with(".tmp-") && kind.is_dir() {
                temps.push(path);
            }
            continue;
        }
        let read = if kind.is_dir() { read_item(&path, &id) } else { ItemRead::Invalid };
        match read {
            ItemRead::Item(item) => items.push(*item),
            ItemRead::Unreadable => {}
            ItemRead::Invalid => {
                let _ = if kind.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
            }
        }
    }
    // A share of several files stages each one in a temp folder of its own
    // and renames them together at the end, so while any temp folder is
    // fresh a share is still copying and every finished one belongs to it.
    // Only when all of them are stale were they abandoned.
    if temps.iter().all(|p| is_stale(p)) {
        for path in temps {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
    items.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    items
}

/// A temp folder is abandoned when neither it nor any entry directly inside
/// it changed for `STALE_TMP`. The Android copier streams the payload into
/// the folder without touching the folder itself, so the folder's own time
/// alone would delete a slow copy under it. An entry whose time cannot be
/// read counts as fresh.
fn is_stale(path: &Path) -> bool {
    let old = |p: &Path| {
        std::fs::symlink_metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > STALE_TMP)
    };
    if !old(path) {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(path) else { return false };
    entries.flatten().all(|e| old(&e.path()))
}

pub fn read_in(inbox: &Path, id: &str) -> Result<Vec<u8>, String> {
    if !is_uuid(id) {
        return Err("bad_id".into());
    }
    let dir = inbox.join(id);
    if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return Err("missing".into());
    }
    match read_capped(&dir.join(PAYLOAD_FILE), MAX_PAYLOAD_BYTES) {
        Capped::Bytes(bytes) => Ok(bytes),
        Capped::Invalid => Err("bad_payload".into()),
        Capped::Unreadable => Err("unreadable".into()),
    }
}

pub fn remove_in(inbox: &Path, id: &str) -> Result<(), String> {
    if !is_uuid(id) {
        return Err("bad_id".into());
    }
    match std::fs::remove_dir_all(inbox.join(id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("not_removed".into()),
    }
}

/// Removes every waiting and staged entry inside `inbox` while keeping `inbox`
/// itself (so its iOS file-protection and backup-exclusion marks stay), and
/// removes `ShareLimit` beside it when `group` is given.
pub fn clear_in(inbox: &Path, group: Option<&Path>) -> Result<(), String> {
    let mut failed = false;
    match std::fs::read_dir(inbox) {
        Ok(entries) => {
            for entry in entries {
                let Ok(entry) = entry else {
                    failed = true;
                    continue;
                };
                let path = entry.path();
                let res = match entry.file_type() {
                    Ok(kind) if kind.is_dir() => std::fs::remove_dir_all(&path),
                    Ok(_) => std::fs::remove_file(&path),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(_) => {
                        failed = true;
                        continue;
                    }
                };
                if res.is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound) {
                    failed = true;
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => failed = true,
    }
    if let Some(dir) = group {
        for name in [LIMIT_FILE, ".share-limit.tmp"] {
            if std::fs::remove_file(dir.join(name))
                .is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound)
            {
                failed = true;
            }
        }
        let meta_dir = dir.join(META_DIR);
        for name in [
            CATALOG_FILE,
            ".share-catalog.tmp",
            LAST_PICK_FILE,
            ".share-last-pick.tmp",
        ] {
            if std::fs::remove_file(meta_dir.join(name))
                .is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound)
            {
                failed = true;
            }
        }
    }
    if failed { Err("not_cleared".into()) } else { Ok(()) }
}

/// Applies iOS complete data protection (NSFileProtectionComplete = class A)
/// directly to a file or directory descriptor so metadata is encrypted by the
/// OS hardware key while the phone is locked.
#[cfg(target_os = "ios")]
fn protect_complete_ios(path: &Path) {
    use std::os::unix::io::AsRawFd;
    const F_SETPROTECTIONCLASS: std::ffi::c_int = 64;
    const PROTECTION_CLASS_A: std::ffi::c_int = 1;
    extern "C" {
        fn fcntl(fd: std::ffi::c_int, cmd: std::ffi::c_int, ...) -> std::ffi::c_int;
    }
    if let Ok(file) = std::fs::File::open(path) {
        unsafe {
            let _ = fcntl(file.as_raw_fd(), F_SETPROTECTIONCLASS, PROTECTION_CLASS_A);
        }
    }
}

/// Writes or clears the iOS share extension's organizer catalog under
/// `<group>/ShareMeta/ShareCatalog.json`. Passing `None` deletes both the
/// catalog and the extension's last-picked task list ID.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn write_catalog_in(group: &Path, catalog: Option<ShareCatalogInput>) -> Result<(), String> {
    let meta_dir = group.join(META_DIR);
    let Some(input) = catalog else {
        for name in [
            CATALOG_FILE,
            ".share-catalog.tmp",
            LAST_PICK_FILE,
            ".share-last-pick.tmp",
        ] {
            if std::fs::remove_file(meta_dir.join(name))
                .is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound)
            {
                return Err("not_cleared".into());
            }
        }
        return Ok(());
    };
    std::fs::create_dir_all(&meta_dir).map_err(|_| "not_written".to_string())?;
    #[cfg(target_os = "ios")]
    protect_complete_ios(&meta_dir);
    let sanitized = sanitize_catalog(input);
    let bytes = serde_json::to_vec(&sanitized).map_err(|_| "not_written".to_string())?;
    let tmp = meta_dir.join(".share-catalog.tmp");
    std::fs::write(&tmp, bytes).map_err(|_| "not_written".to_string())?;
    #[cfg(target_os = "ios")]
    protect_complete_ios(&tmp);
    std::fs::rename(&tmp, meta_dir.join(CATALOG_FILE)).map_err(|_| "not_written".to_string())?;
    Ok(())
}

#[cfg(target_os = "ios")]
fn group_dir() -> Option<PathBuf> {
    use objc2_foundation::{NSFileManager, NSString};
    let url = NSFileManager::defaultManager()
        .containerURLForSecurityApplicationGroupIdentifier(&NSString::from_str(APP_GROUP))?;
    Some(PathBuf::from(url.path()?.to_string()))
}

/// The inbox folder on this platform, or `None` where nothing writes one.
#[cfg(target_os = "ios")]
fn inbox_dir(_app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(group_dir()?.join("ShareInbox"))
}

/// The activity's data folder, which is where MainActivity.kt writes.
#[cfg(target_os = "android")]
fn inbox_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    Some(app.path().app_data_dir().ok()?.join("ShareInbox"))
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn inbox_dir(_app: &tauri::AppHandle) -> Option<PathBuf> {
    None
}

#[tauri::command]
pub fn share_inbox_list(app: tauri::AppHandle) -> Vec<SharedItem> {
    inbox_dir(&app).map(|d| list_in(&d)).unwrap_or_default()
}

#[tauri::command]
pub fn share_inbox_read(app: tauri::AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let dir = inbox_dir(&app).ok_or("no_inbox")?;
    read_in(&dir, &id).map(tauri::ipc::Response::new)
}

/// The signed-in account's per-file limit, written where the iOS share
/// extension reads it, so a file the app would refuse is refused in the share
/// sheet with the reason instead of after a "Saved". A number, never content:
/// it tells the extension nothing about the notes. Clamped to the largest
/// limit the app grants. Android needs none: its share opens the app, whose
/// upload window names the limit at once.
fn limit_text(bytes: u64) -> String {
    bytes.clamp(1, MAX_PAYLOAD_BYTES).to_string()
}

#[tauri::command]
pub fn share_limit_set(bytes: u64) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let dir = group_dir().ok_or("no_group")?;
        let tmp = dir.join(".share-limit.tmp");
        std::fs::write(&tmp, limit_text(bytes)).map_err(|_| "not_written".to_string())?;
        std::fs::rename(&tmp, dir.join(LIMIT_FILE)).map_err(|_| "not_written".to_string())?;
    }
    #[cfg(not(target_os = "ios"))]
    let _ = bytes;
    Ok(())
}

/// Writes or clears the signed-in account's non-PIN organizer metadata (task
/// list titles, Pro folder names, and tags) under `ShareMeta/ShareCatalog.json`
/// for the iOS share extension. Passing `None` clears the catalog (called when
/// App Lock is enabled or on sign-out). Android needs none because its share
/// sheet runs inside the unlocked app.
#[tauri::command]
pub fn share_catalog_set(catalog: Option<ShareCatalogInput>) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let dir = group_dir().ok_or("no_group")?;
        return write_catalog_in(&dir, catalog);
    }
    #[cfg(not(target_os = "ios"))]
    let _ = catalog;
    Ok(())
}

#[tauri::command]
pub fn share_inbox_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    remove_in(&inbox_dir(&app).ok_or("no_inbox")?, &id)
}

#[tauri::command]
pub fn share_inbox_clear(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        let group = group_dir().ok_or("no_group")?;
        return clear_in(&group.join("ShareInbox"), Some(&group));
    }
    #[cfg(target_os = "android")]
    {
        return clear_in(&inbox_dir(&app).ok_or("no_inbox")?, None);
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0A1B2C3D-0000-4000-8000-000000000001";
    const B: &str = "0a1b2c3d-0000-4000-8000-000000000002";

    /// One folder per test: the tests run in parallel.
    fn inbox() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pn-share-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(inbox: &Path, id: &str, json: &str, payload: Option<&[u8]>) {
        let d = inbox.join(id);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(ITEM_FILE), json).unwrap();
        if let Some(p) = payload {
            std::fs::write(d.join(PAYLOAD_FILE), p).unwrap();
        }
    }

    #[test]
    fn reads_each_kind_oldest_first() {
        let dir = inbox();
        put(&dir, A, r#"{"v":1,"kind":"url","created":2,"url":"https://example.com/a","title":" A page "}"#, None);
        put(&dir, B, r#"{"v":1,"kind":"file","created":1,"name":"../../x/photo.jpg","mime":"image/jpeg"}"#, Some(b"jpg"));
        let items = list_in(&dir);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].kind, "file");
        assert_eq!(items[0].name.as_deref(), Some("photo.jpg"));
        assert_eq!(items[0].size, Some(3));
        assert_eq!(items[1].url.as_deref(), Some("https://example.com/a"));
        assert_eq!(items[1].title.as_deref(), Some("A page"));
        assert_eq!(read_in(&dir, B).unwrap(), b"jpg");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deletes_what_it_cannot_use() {
        let dir = inbox();
        put(&dir, A, r#"{"v":1,"kind":"url","url":"javascript:alert(1)"}"#, None);
        put(&dir, B, r#"{"v":1,"kind":"file","name":"empty.bin"}"#, None);
        let c = "0a1b2c3d-0000-4000-8000-000000000003";
        put(&dir, c, r#"{"v":2,"kind":"text","text":"from the future"}"#, None);
        assert!(list_in(&dir).is_empty());
        assert!(!dir.join(A).exists() && !dir.join(B).exists() && !dir.join(c).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Beta issue 176: a web link the Rust side cannot take as a link is
    /// kept as a text note, not deleted after the sheet said Saved.
    #[test]
    fn keeps_a_web_link_it_cannot_parse_as_text() {
        let dir = inbox();
        let long = format!("https://example.org/{}", "a".repeat(MAX_URL_CHARS));
        put(&dir, A, &format!(r#"{{"v":1,"kind":"url","url":"{long}"}}"#), None);
        put(&dir, B, r#"{"v":1,"kind":"url","url":"http://[broken"}"#, None);
        let items = list_in(&dir);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.kind == "text" && i.url.is_none()));
        assert!(items.iter().any(|i| i.text.as_deref() == Some(long.as_str())));
        assert!(items.iter().any(|i| i.text.as_deref() == Some("http://[broken")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn leaves_an_item_still_being_written() {
        let dir = inbox();
        let tmp = format!(".tmp-{A}");
        put(&dir, &tmp, r#"{"v":1,"kind":"text","text":"half"}"#, None);
        assert!(list_in(&dir).is_empty());
        assert!(dir.join(&tmp).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_id_is_never_a_path() {
        let dir = inbox();
        assert_eq!(read_in(&dir, "../item.json"), Err("bad_id".into()));
        assert!(!is_uuid("0A1B2C3D-0000-4000-8000-00000000000/"));
        std::fs::create_dir_all(dir.join("keep")).unwrap();
        assert_eq!(remove_in(&dir, "keep"), Err("bad_id".into()));
        assert!(dir.join("keep").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn never_reads_through_a_link() {
        let dir = inbox();
        let outside = dir.join("outside.json");
        std::fs::write(&outside, r#"{"v":1,"kind":"text","text":"secret"}"#).unwrap();
        std::fs::create_dir_all(dir.join(A)).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(A).join(ITEM_FILE)).unwrap();
        assert!(list_in(&dir).is_empty());
        assert!(!dir.join(A).exists());
        std::fs::create_dir_all(dir.join(B)).unwrap();
        std::fs::write(dir.join(B).join(ITEM_FILE), r#"{"v":1,"kind":"file"}"#).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(B).join(PAYLOAD_FILE)).unwrap();
        assert_eq!(read_in(&dir, B), Err("bad_payload".into()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_a_fresh_temp_folder_and_drops_an_old_one() {
        let dir = inbox();
        let fresh = dir.join(format!(".tmp-{A}"));
        std::fs::create_dir_all(&fresh).unwrap();
        list_in(&dir);
        assert!(fresh.exists());
        std::fs::remove_dir_all(&fresh).unwrap();
        let old = dir.join(format!(".tmp-{B}"));
        std::fs::create_dir_all(&old).unwrap();
        let past = SystemTime::now() - STALE_TMP - Duration::from_secs(60);
        std::fs::File::open(&old).unwrap().set_modified(past).unwrap();
        list_in(&dir);
        assert!(!old.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_an_old_temp_folder_whose_payload_is_still_being_written() {
        // The Android copier streams the payload into the folder and never
        // touches the folder itself, so a copy that runs past the limit has an
        // old folder and a fresh file.
        let dir = inbox();
        let slow = dir.join(format!(".tmp-{A}"));
        std::fs::create_dir_all(&slow).unwrap();
        std::fs::write(slow.join(PAYLOAD_FILE), b"partial").unwrap();
        let past = SystemTime::now() - STALE_TMP - Duration::from_secs(60);
        std::fs::File::open(&slow).unwrap().set_modified(past).unwrap();
        list_in(&dir);
        assert!(slow.join(PAYLOAD_FILE).exists());
        std::fs::File::open(slow.join(PAYLOAD_FILE)).unwrap().set_modified(past).unwrap();
        std::fs::File::open(&slow).unwrap().set_modified(past).unwrap();
        list_in(&dir);
        assert!(!slow.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_the_finished_folders_of_a_share_that_is_still_copying() {
        // A share of several files stages each file in its own temp folder
        // and renames them all at the end, so a finished folder waits while a
        // later file copies, however long that takes.
        let dir = inbox();
        let past = SystemTime::now() - STALE_TMP - Duration::from_secs(60);
        let done = dir.join(format!(".tmp-{A}"));
        std::fs::create_dir_all(&done).unwrap();
        std::fs::write(done.join(PAYLOAD_FILE), b"first").unwrap();
        std::fs::File::open(done.join(PAYLOAD_FILE)).unwrap().set_modified(past).unwrap();
        std::fs::File::open(&done).unwrap().set_modified(past).unwrap();
        let copying = dir.join(format!(".tmp-{B}"));
        std::fs::create_dir_all(&copying).unwrap();
        std::fs::write(copying.join(PAYLOAD_FILE), b"second").unwrap();
        list_in(&dir);
        assert!(done.join(PAYLOAD_FILE).exists());
        std::fs::File::open(copying.join(PAYLOAD_FILE)).unwrap().set_modified(past).unwrap();
        std::fs::File::open(&copying).unwrap().set_modified(past).unwrap();
        list_in(&dir);
        assert!(!done.exists() && !copying.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_limit_is_a_plain_number_within_the_largest_grant() {
        assert_eq!(limit_text(5_000_000), "5000000");
        assert_eq!(limit_text(0), "1");
        assert_eq!(limit_text(u64::MAX), MAX_PAYLOAD_BYTES.to_string());
    }

    #[test]
    fn blank_text_is_not_an_item() {
        let dir = inbox();
        put(&dir, A, r#"{"v":1,"kind":"text","text":"   "}"#, None);
        assert!(list_in(&dir).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_photo_note_fields_and_drops_untrusted_values() {
        let dir = inbox();
        let group = "0a1b2c3d-0000-4000-8000-000000000099";
        put(
            &dir,
            A,
            &format!(
                r#"{{"v":1,"kind":"file","created":1,"name":"pic.jpg","mime":"image/jpeg","target":"note","group":"{group}","title":" Receipt ","text":" Lunch "}}"#
            ),
            Some(b"jpg"),
        );
        put(
            &dir,
            B,
            r#"{"v":1,"kind":"file","created":2,"name":"doc.pdf","mime":"application/pdf","target":"other","group":"../escape","title":"Ignored","text":"Ignored"}"#,
            Some(b"pdf"),
        );
        let items = list_in(&dir);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].target, Some("note"));
        assert_eq!(items[0].group.as_deref(), Some(group));
        assert_eq!(items[0].title.as_deref(), Some("Receipt"));
        assert_eq!(items[0].text.as_deref(), Some("Lunch"));
        assert_eq!(items[1].target, None);
        assert_eq!(items[1].group, None);
        assert_eq!(items[1].title, None);
        assert_eq!(items[1].text, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn clears_waiting_items_staged_folders_and_limit_while_keeping_inbox_dir() {
        let group = inbox();
        let dir = group.join("ShareInbox");
        std::fs::create_dir_all(&dir).unwrap();
        put(&dir, A, r#"{"v":1,"kind":"text","text":"secret"}"#, None);
        put(&dir, &format!(".tmp-{B}"), r#"{"v":1,"kind":"file"}"#, Some(b"bytes"));
        std::fs::write(group.join(LIMIT_FILE), "5000000").unwrap();
        std::fs::write(group.join(".share-limit.tmp"), "50000000").unwrap();
        let meta = group.join(META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(meta.join(CATALOG_FILE), "{}").unwrap();
        std::fs::write(meta.join(".share-catalog.tmp"), "{}").unwrap();
        std::fs::write(meta.join(LAST_PICK_FILE), A).unwrap();
        std::fs::write(meta.join(".share-last-pick.tmp"), B).unwrap();

        clear_in(&dir, Some(&group)).unwrap();

        assert!(dir.is_dir());
        assert!(list_in(&dir).is_empty());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        assert!(!group.join(LIMIT_FILE).exists());
        assert!(!group.join(".share-limit.tmp").exists());
        assert!(!meta.join(CATALOG_FILE).exists());
        assert!(!meta.join(".share-catalog.tmp").exists());
        assert!(!meta.join(LAST_PICK_FILE).exists());
        assert!(!meta.join(".share-last-pick.tmp").exists());
        // Clearing when ShareInbox has not been created yet succeeds without creating it.
        let missing = group.join("MissingInbox");
        clear_in(&missing, Some(&group)).unwrap();
        assert!(!missing.exists());
        std::fs::remove_dir_all(&group).unwrap();
    }

    #[test]
    fn reads_unified_targets_task_list_folder_and_tags_and_drops_invalid_values() {
        let dir = inbox();
        let list_id = "0a1b2c3d-0000-4000-8000-000000000077";
        let c = "0a1b2c3d-0000-4000-8000-000000000003";
        put(
            &dir,
            A,
            &format!(
                r#"{{"v":1,"kind":"url","created":1,"url":"https://example.com/flight","title":"Flight","target":"task","taskListId":"{list_id}","folderId":"work_1","tags":["travel"]}}"#
            ),
            None,
        );
        put(
            &dir,
            B,
            r#"{"v":1,"kind":"url","created":2,"url":"https://example.com/read","title":"Guide","text":"Check section 2","target":"clip","taskListId":"not-a-uuid","folderId":"fld_123","tags":["  reading ","reading","","web"]}"#,
            None,
        );
        put(
            &dir,
            c,
            r#"{"v":1,"kind":"text","created":3,"title":"Snippet","text":"Hello world","target":"journal","folderId":"../bad","tags":["daily"]}"#,
            None,
        );
        let items = list_in(&dir);
        assert_eq!(items.len(), 3);
        // Task target keeps taskListId, drops folderId and tags.
        assert_eq!(items[0].target, Some("task"));
        assert_eq!(items[0].task_list_id.as_deref(), Some(list_id));
        assert_eq!(items[0].folder_id, None);
        assert_eq!(items[0].tags, None);
        // Clip target keeps folderId, deduped tags, title & note text; drops taskListId.
        assert_eq!(items[1].target, Some("clip"));
        assert_eq!(items[1].task_list_id, None);
        assert_eq!(items[1].folder_id.as_deref(), Some("fld_123"));
        assert_eq!(items[1].text.as_deref(), Some("Check section 2"));
        assert_eq!(items[1].tags.as_deref(), Some(&["reading".to_string(), "web".to_string()][..]));
        // Journal target drops folderId, keeps tags.
        assert_eq!(items[2].target, Some("journal"));
        assert_eq!(items[2].folder_id, None);
        assert_eq!(items[2].tags.as_deref(), Some(&["daily".to_string()][..]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writes_sanitized_share_catalog_and_clears_it_when_none() {
        let group = inbox();
        let valid_task_id = "0a1b2c3d-0000-4000-8000-000000000088";
        write_catalog_in(
            &group,
            Some(ShareCatalogInput {
                folders_unlocked: true,
                task_lists: vec![
                    ShareCatalogTaskList { id: valid_task_id.into(), title: " Work ".into() },
                    ShareCatalogTaskList { id: "not-a-uuid".into(), title: "Bad".into() },
                    ShareCatalogTaskList { id: valid_task_id.into(), title: "Duplicate".into() },
                ],
                folders: vec![
                    ShareCatalogFolder { id: "fld_1".into(), name: " Projects ".into() },
                    ShareCatalogFolder { id: "../escape".into(), name: "Bad".into() },
                ],
                tags: vec![" urgent ".into(), "urgent".into(), " ".into(), "home".into()],
            }),
        )
        .unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(group.join(META_DIR).join(CATALOG_FILE)).unwrap())
                .unwrap();
        assert_eq!(saved["v"], 1);
        assert_eq!(saved["foldersUnlocked"], true);
        assert_eq!(saved["taskLists"].as_array().unwrap().len(), 1);
        assert_eq!(saved["taskLists"][0]["id"], valid_task_id);
        assert_eq!(saved["taskLists"][0]["title"], "Work");
        assert_eq!(saved["folders"].as_array().unwrap().len(), 1);
        assert_eq!(saved["folders"][0]["id"], "fld_1");
        assert_eq!(saved["tags"], serde_json::json!(["urgent", "home"]));

        // When folders are locked (free plan), folders list is omitted.
        write_catalog_in(
            &group,
            Some(ShareCatalogInput {
                folders_unlocked: false,
                task_lists: vec![],
                folders: vec![ShareCatalogFolder { id: "fld_1".into(), name: "Projects".into() }],
                tags: vec![],
            }),
        )
        .unwrap();
        let free: serde_json::Value =
            serde_json::from_slice(&std::fs::read(group.join(META_DIR).join(CATALOG_FILE)).unwrap())
                .unwrap();
        assert_eq!(free["foldersUnlocked"], false);
        assert_eq!(free["folders"].as_array().unwrap().len(), 0);

        // Clearing removes ShareCatalog.json and ShareLastPick.
        std::fs::write(group.join(META_DIR).join(LAST_PICK_FILE), valid_task_id).unwrap();
        write_catalog_in(&group, None).unwrap();
        assert!(!group.join(META_DIR).join(CATALOG_FILE).exists());
        assert!(!group.join(META_DIR).join(LAST_PICK_FILE).exists());
        std::fs::remove_dir_all(&group).unwrap();
    }
}
