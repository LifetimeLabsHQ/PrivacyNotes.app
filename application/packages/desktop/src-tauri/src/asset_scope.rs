//! The asset protocol reads only what the person opened.
//!
//! The asset protocol serves a file from disk by the path in its address, and
//! `tauri.conf.json` gives it no static allow. Its scope holds exactly what
//! the fs runtime scope holds, which has no static allow either and
//! grows only by the person's own acts: the folder picker, the file picker and
//! Save As (the dialog plugin), and a double-clicked file (`take_pending_opens`,
//! opened_file.rs). Every allowed pattern of the fs scope is copied here at
//! start, after tauri-plugin-persisted-scope restored the fs scope from
//! `.persisted-scope`, and again after every later fs grant. So the grant
//! comes back at each start from that one saved file, and a folder that
//! `forget_folder_scope` (folder_scope.rs) takes out of it is gone from both
//! scopes at the next start.
//! Spec: docs/internal/plans/desktop-asset-scope.md (section 2)

use std::collections::HashSet;
use std::path::PathBuf;
use tauri::scope::fs::Scope;

/// What one allowed pattern of a scope grants.
#[derive(Debug, PartialEq)]
enum Grant {
    File(PathBuf),
    Folder(PathBuf, bool),
}

/// The grant behind a pattern the scope made: `glob::Pattern::escape` of the
/// path, plus `**` (a folder and everything under it) or `*` (its top level)
/// after a separator. An escaped `*` reads `[*]`, so a bare `*` at the end is
/// always that suffix. The folder keeps its trailing separator, which the
/// scope drops again (`components()`), and which keeps a root (`/`, `C:\`) a
/// root.
fn grant_of(pattern: &str) -> Grant {
    if let Some(base) = pattern.strip_suffix("**") {
        Grant::Folder(PathBuf::from(unescape(base)), true)
    } else if let Some(base) = pattern.strip_suffix('*') {
        Grant::Folder(PathBuf::from(unescape(base)), false)
    } else {
        Grant::File(PathBuf::from(unescape(pattern)))
    }
}

/// The inverse of `glob::Pattern::escape`, which writes each of `?`, `*`, `[`
/// and `]` as `[c]` and leaves every other character alone, so read left to
/// right a `[` always opens such a triple.
fn unescape(escaped: &str) -> String {
    let chars: Vec<char> = escaped.chars().collect();
    let mut out = String::with_capacity(escaped.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' && i + 2 < chars.len() && chars[i + 2] == ']' && matches!(chars[i + 1], '?' | '*' | '[' | ']') {
            out.push(chars[i + 1]);
            i += 3;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Copy every allowed pattern of `from` that `to` does not hold yet. The
/// scope adds the canonical path of each grant itself, so a folder reached
/// through a link (macOS `/var` to `/private/var`) still matches.
pub fn copy(from: &Scope, to: &Scope) {
    let have = held(to);
    for pattern in held(from) {
        if have.contains(&pattern) {
            continue;
        }
        let _ = match grant_of(&pattern) {
            Grant::Folder(path, recursive) => to.allow_directory(path, recursive),
            Grant::File(path) => to.allow_file(path),
        };
    }
}

/// Copy after every later grant of `from`, and now. The listener comes
/// first, so a grant that lands between the two is copied too (a copy that
/// runs twice adds nothing).
fn follow(from: &Scope, to: &Scope) {
    let (from_, to_) = (from.clone(), to.clone());
    from.listen(move |event| {
        if let tauri::scope::fs::Event::PathAllowed(_) = event {
            copy(&from_, &to_);
        }
    });
    copy(from, to);
}

/// The asset scope follows the fs runtime scope. Register in `setup`, after
/// the fs and persisted-scope plugins restored it.
pub fn watch<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    let Some(fs) = app.try_fs_scope() else { return };
    follow(&fs, &app.asset_protocol_scope());
}

fn held(scope: &Scope) -> HashSet<String> {
    scope.allowed_patterns().iter().map(|p| p.as_str().to_owned()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tauri::utils::config::FsScope;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_app()
    }

    /// The asset scope as `tauri.conf.json` declares it.
    fn configured(app: &tauri::App<tauri::test::MockRuntime>) -> Scope {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let scope: FsScope =
            serde_json::from_value(conf["app"]["security"]["assetProtocol"]["scope"].clone()).expect("asset scope");
        Scope::new(app, &scope).expect("scope")
    }

    fn empty(app: &tauri::App<tauri::test::MockRuntime>) -> Scope {
        Scope::new(app, &FsScope::default()).expect("scope")
    }

    /// The system temp folder, which on macOS sits behind a link (`/var`).
    /// On Windows it is under `AppData`, which the deny list refuses, so the
    /// folder next to the test binary.
    fn temp(tag: &str) -> PathBuf {
        #[cfg(windows)]
        let base = std::env::current_exe().unwrap().parent().unwrap().join("pn-asset-scope-tmp");
        #[cfg(not(windows))]
        let base = std::env::temp_dir();
        let dir = base.join(format!("pn-asset-scope-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp folder");
        dir
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"png").unwrap();
    }

    #[test]
    fn asset_scope_allows_no_picture_before_a_grant() {
        let app = app();
        let asset = configured(&app);
        let home = tauri::Manager::path(&app).home_dir().expect("home");
        for path in [home.join("Pictures/x.png"), home.join("Documents/Notes/x.png"), PathBuf::from("/etc/x.png")] {
            assert!(!asset.is_allowed(&path), "{} is reachable with no grant", path.display());
        }
    }

    #[test]
    fn asset_scope_follows_a_picked_folder_and_nothing_beside_it() {
        let dir = temp("folder");
        let folder = dir.join("Notes");
        touch(&folder.join("attachments/deep/pic.png"));
        touch(&folder.join("pic.png"));
        touch(&dir.join("beside.png"));
        touch(&dir.join("Notes2/pic.png"));

        let app = app();
        let (fs, asset) = (empty(&app), configured(&app));
        follow(&fs, &asset);
        fs.allow_directory(&folder, true).unwrap();

        assert!(asset.is_allowed(folder.join("pic.png")));
        assert!(asset.is_allowed(folder.join("attachments/deep/pic.png")));
        assert!(asset.is_allowed(folder.join("not-there-yet.png")));
        assert!(!asset.is_allowed(dir.join("beside.png")));
        assert!(!asset.is_allowed(dir.join("Notes2/pic.png")));
        assert!(!asset.is_allowed(folder.join("../beside.png")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// At start persisted-scope has already restored the fs scope, before
    /// `watch` runs: the copy takes those grants too.
    #[test]
    fn asset_scope_takes_the_folder_restored_at_start() {
        let dir = temp("restart");
        let folder = dir.join("Vault");
        touch(&folder.join("img/a.png"));
        let app = app();
        let (fs, asset) = (empty(&app), configured(&app));
        fs.allow_directory(&folder, true).unwrap();
        follow(&fs, &asset);
        assert!(asset.is_allowed(folder.join("img/a.png")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_scope_keeps_a_folder_name_with_glob_characters() {
        let dir = temp("glob");
        let app = app();
        // Windows refuses `*` and `?` in a name.
        #[cfg(windows)]
        let names = ["My [Notes]", "x]y[z", "plain name", "Notizen äöü"];
        #[cfg(not(windows))]
        let names = ["My [Notes]", "a*b", "what?", "x]y[z", "plain name", "Notizen äöü"];
        for name in names {
            let folder = dir.join(name);
            touch(&folder.join("p.png"));
            let (fs, asset) = (empty(&app), configured(&app));
            follow(&fs, &asset);
            fs.allow_directory(&folder, true).unwrap();
            assert!(asset.is_allowed(folder.join("p.png")), "{name}");
            assert!(!asset.is_allowed(dir.join("other/p.png")), "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_scope_reaches_only_a_double_clicked_file() {
        let dir = temp("file");
        let file = dir.join("Downloads/readme.md");
        touch(&file);
        touch(&dir.join("Downloads/pic.png"));
        let app = app();
        let (fs, asset) = (empty(&app), configured(&app));
        follow(&fs, &asset);
        // What `take_pending_opens` grants: the file and its staging name.
        fs.allow_file(&file).unwrap();
        fs.allow_file(format!("{}.pn-tmp", file.display())).unwrap();
        assert!(asset.is_allowed(&file));
        assert!(!asset.is_allowed(dir.join("Downloads/pic.png")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn asset_scope_refuses_a_link_out_of_the_folder() {
        let dir = temp("link");
        let folder = dir.join("Notes");
        let outside = dir.join("outside/secret.png");
        touch(&outside);
        std::fs::create_dir_all(&folder).unwrap();
        std::os::unix::fs::symlink(&outside, folder.join("pic.png")).unwrap();
        std::os::unix::fs::symlink(dir.join("outside"), folder.join("assets")).unwrap();
        let app = app();
        let (fs, asset) = (empty(&app), configured(&app));
        follow(&fs, &asset);
        fs.allow_directory(&folder, true).unwrap();
        assert!(!asset.is_allowed(folder.join("pic.png")));
        assert!(!asset.is_allowed(folder.join("assets/secret.png")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A home folder picked as the Markdown folder: the deny list still
    /// keeps the credential and profile folders out.
    #[test]
    fn asset_scope_keeps_the_deny_list_inside_a_granted_folder() {
        let app = app();
        let home = tauri::Manager::path(&app).home_dir().expect("home");
        let (fs, asset) = (empty(&app), configured(&app));
        follow(&fs, &asset);
        fs.allow_directory(&home, true).unwrap();
        assert!(asset.is_allowed(home.join("pn-asset-scope-not-there.png")));
        for denied in ["Library/WebKit/x.png", "AppData/Roaming/x.png", ".ssh/x.png"] {
            assert!(!asset.is_allowed(home.join(denied)), "{denied}");
        }
    }

    #[test]
    fn reads_the_grant_behind_each_pattern_form() {
        let folder = |p: &str, r| Grant::Folder(PathBuf::from(p), r);
        assert_eq!(grant_of("/Users/a/Notes/**"), folder("/Users/a/Notes/", true));
        assert_eq!(grant_of("/Users/a/Notes/*"), folder("/Users/a/Notes/", false));
        assert_eq!(grant_of("/Users/a/Notes"), Grant::File(PathBuf::from("/Users/a/Notes")));
        assert_eq!(grant_of("/**"), folder("/", true));
        assert_eq!(grant_of("/Users/a/My [[]Notes[]]/**"), folder("/Users/a/My [Notes]/", true));
        assert_eq!(grant_of("/Users/a/a[*]b"), Grant::File(PathBuf::from("/Users/a/a*b")));
        assert_eq!(grant_of("/Users/a/a[*][*]"), Grant::File(PathBuf::from("/Users/a/a**")));
        assert_eq!(grant_of(r"C:\Users\a\Notes\**"), folder(r"C:\Users\a\Notes\", true));
        assert_eq!(grant_of(r"C:\**"), folder(r"C:\", true));
        assert_eq!(grant_of(r"\\[?]\C:\Users\a\Notes\**"), folder(r"\\?\C:\Users\a\Notes\", true));
        assert_eq!(grant_of(r"\\server\share\Notes\**"), folder(r"\\server\share\Notes\", true));
    }
}
