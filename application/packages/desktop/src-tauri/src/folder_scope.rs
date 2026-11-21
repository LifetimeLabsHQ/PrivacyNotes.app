//! Taking a forgotten Markdown folder out of the persisted fs scope
//! (beta.privacynotes.app #214 item 2, the desktop half).
//!
//! The folder picker grants the picked folder to the fs scope
//! (`allow_directory(folder, true)`: the folder, `<folder>/**`, and the same
//! two for its canonical path), and tauri-plugin-persisted-scope saves the
//! whole scope to `<app data>/.persisted-scope` and grants it again at every
//! start. The web side forgets the folder at a wipe, an account switch and the
//! pillar's close (`forgetFolder`, markdownFolder/folderMemory.ts), but the
//! grant stayed in that file, so the folder of the account that left was
//! reachable again after every restart.
//!
//! The fs scope has no call that takes a pattern back, so the grant leaves the
//! saved file, and the in-memory grant ends with the run. The plugin saves the
//! whole in-memory scope again on every later grant, so after each grant this
//! rewrites the file once more, after the plugin's own save. A grant of the
//! folder itself (the person picks it again) keeps it.
//!
//! The file is bincode 1 with its default options, which the plugin writes:
//! `struct { allowed_paths: Vec<String>, forbidden_patterns: Vec<String> }`,
//! each length a little-endian u64. It is read and written here by hand, so
//! the app carries no second copy of that crate's version.
//! Spec: docs/internal/specs/markdown-folder.md (section 5)

use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::Mutex;
use tauri::scope::fs::{Event, Pattern};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FsExt;

/// tauri-plugin-persisted-scope's `SCOPE_STATE_FILENAME`, in the app data folder.
const STATE_FILE: &str = ".persisted-scope";

/// The folders forgotten in this run, each with the patterns of its grant.
static FORGOTTEN: Mutex<Vec<(PathBuf, Vec<String>)>> = Mutex::new(Vec::new());

/// The patterns `allow_directory(folder, true)` adds, as the saved file spells
/// them: the folder and everything under it, as given and canonical, and the
/// Windows path without its `\\?\` prefix. `*` too, from a pick that was not
/// recursive.
pub fn grant_patterns(folder: &Path) -> Vec<String> {
    let path: PathBuf = folder.components().collect();
    let given = path.to_string_lossy().into_owned();
    let mut bases = vec![given.clone()];
    if let Some(short) = given.strip_prefix(r"\\?\") {
        bases.push(short.to_owned());
    }
    if let Ok(real) = path.canonicalize() {
        bases.push(real.to_string_lossy().into_owned());
    }
    let mut out = Vec::new();
    for base in bases {
        let escaped = Pattern::escape(&base);
        let sep = if base.ends_with(MAIN_SEPARATOR) { String::new() } else { MAIN_SEPARATOR.to_string() };
        for pattern in [escaped.clone(), format!("{escaped}{sep}**"), format!("{escaped}{sep}*")] {
            if !out.contains(&pattern) {
                out.push(pattern);
            }
        }
    }
    out
}

fn read_strings(bytes: &mut &[u8]) -> Option<Vec<String>> {
    let count = read_u64(bytes)?;
    let mut out = Vec::new();
    for _ in 0..count {
        let len = usize::try_from(read_u64(bytes)?).ok()?;
        if bytes.len() < len {
            return None;
        }
        let (text, rest) = bytes.split_at(len);
        out.push(String::from_utf8(text.to_vec()).ok()?);
        *bytes = rest;
    }
    Some(out)
}

fn read_u64(bytes: &mut &[u8]) -> Option<u64> {
    if bytes.len() < 8 {
        return None;
    }
    let (head, rest) = bytes.split_at(8);
    *bytes = rest;
    Some(u64::from_le_bytes(head.try_into().ok()?))
}

fn write_strings(out: &mut Vec<u8>, strings: &[String]) {
    out.extend_from_slice(&(strings.len() as u64).to_le_bytes());
    for s in strings {
        out.extend_from_slice(&(s.len() as u64).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }
}

/// The saved scope without the allowed patterns in `drop`; the forbidden ones
/// stay. None for a file this cannot read, which is then left as it is.
pub fn without(saved: &[u8], drop: &[String]) -> Option<Vec<u8>> {
    let mut rest = saved;
    let allowed = read_strings(&mut rest)?;
    let forbidden = read_strings(&mut rest)?;
    let kept: Vec<String> = allowed.into_iter().filter(|p| !drop.contains(p)).collect();
    let mut out = Vec::new();
    write_strings(&mut out, &kept);
    write_strings(&mut out, &forbidden);
    Some(out)
}

/// Rewrite the saved scope without `drop`, through a file beside it renamed
/// over it. Nothing to do without a saved file.
fn rewrite(file: &Path, drop: &[String]) {
    let Ok(saved) = std::fs::read(file) else { return };
    let Some(next) = without(&saved, drop) else { return };
    if next == saved {
        return;
    }
    let staged = file.with_extension("pn-tmp");
    if std::fs::write(&staged, next).is_ok() && std::fs::rename(&staged, file).is_err() {
        let _ = std::fs::remove_file(&staged);
    }
}

fn state_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(STATE_FILE))
}

fn forgotten_patterns() -> Vec<String> {
    FORGOTTEN.lock().unwrap().iter().flat_map(|(_, p)| p.iter().cloned()).collect()
}

/// A grant of a forgotten folder itself (picked again) keeps it from now on.
pub fn regranted(path: &Path) {
    let path: PathBuf = path.components().collect();
    FORGOTTEN.lock().unwrap().retain(|(folder, _)| *folder != path);
}

/// Forget the Markdown folder's grant: out of the saved scope now, and again
/// after every later grant of this run. The folder stays reachable in memory
/// until the app quits.
#[tauri::command]
pub fn forget_folder_scope(app: AppHandle, path: String) {
    let folder: PathBuf = Path::new(&path).components().collect();
    if folder.as_os_str().is_empty() {
        return;
    }
    {
        let mut list = FORGOTTEN.lock().unwrap();
        list.retain(|(f, _)| *f != folder);
        let patterns = grant_patterns(&folder);
        list.push((folder, patterns));
    }
    if let Some(file) = state_file(&app) {
        rewrite(&file, &forgotten_patterns());
    }
}

/// After every grant: a grant of a forgotten folder keeps it; any other is
/// followed by the plugin's save of the whole scope, which is then rewritten
/// without the forgotten folders. The save runs in the same event, so the
/// rewrite waits a moment on its own thread. Register after the fs plugin.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let Some(scope) = app.try_fs_scope() else { return };
    let app = app.clone();
    scope.listen(move |event| {
        let Event::PathAllowed(path) = event else { return };
        regranted(path);
        let drop = forgotten_patterns();
        if drop.is_empty() {
            return;
        }
        let Some(file) = state_file(&app) else { return };
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            rewrite(&file, &drop);
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(allowed: &[&str], forbidden: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        write_strings(&mut out, &allowed.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        write_strings(&mut out, &forbidden.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        out
    }

    fn read(bytes: &[u8]) -> (Vec<String>, Vec<String>) {
        let mut rest = bytes;
        (read_strings(&mut rest).unwrap(), read_strings(&mut rest).unwrap())
    }

    /// The patterns the fs scope itself adds for a pick, read back the way
    /// the persisted-scope plugin saves them (`Pattern::to_string`).
    fn scope_grant(folder: &Path) -> Vec<String> {
        let app = tauri::test::mock_app();
        let scope = tauri::scope::fs::Scope::new(&app, &Default::default()).unwrap();
        scope.allow_directory(folder, true).unwrap();
        scope.allowed_patterns().into_iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn names_every_pattern_the_picker_grants() {
        let dir = std::env::temp_dir().join("pn folder [scope] test");
        std::fs::create_dir_all(&dir).unwrap();
        let ours = grant_patterns(&dir);
        for pattern in scope_grant(&dir) {
            assert!(ours.contains(&pattern), "{pattern} is not taken back");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drops_the_folder_and_keeps_everything_else() {
        let folder = Path::new("/Users/someone/Notes");
        let drop = grant_patterns(folder);
        let file = saved(
            &["/Users/someone/Notes", "/Users/someone/Notes/**", "/Users/someone/Other/**", "/Users/someone/Notes/opened.md"],
            &["/Users/someone/.persisted-scope"],
        );
        let (allowed, forbidden) = read(&without(&file, &drop).unwrap());
        assert_eq!(allowed, ["/Users/someone/Other/**", "/Users/someone/Notes/opened.md"]);
        assert_eq!(forbidden, ["/Users/someone/.persisted-scope"]);
    }

    #[test]
    fn leaves_a_file_it_cannot_read() {
        assert_eq!(without(&[1, 2, 3], &grant_patterns(Path::new("/x"))), None);
        let mut cut = saved(&["/x"], &[]);
        cut.truncate(cut.len() - 1);
        assert_eq!(without(&cut, &grant_patterns(Path::new("/x"))), None);
    }

    #[test]
    fn rewrites_the_saved_file_and_a_new_pick_keeps_the_folder() {
        let dir = std::env::temp_dir().join(format!("pn-folder-scope-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(STATE_FILE);
        let folder = dir.join("Notes");
        std::fs::create_dir_all(&folder).unwrap();
        let mut allowed = scope_grant(&folder);
        allowed.push("/elsewhere/**".to_owned());
        let allowed: Vec<&str> = allowed.iter().map(String::as_str).collect();
        std::fs::write(&file, saved(&allowed, &[])).unwrap();

        rewrite(&file, &grant_patterns(&folder));
        let (left, _) = read(&std::fs::read(&file).unwrap());
        assert_eq!(left, ["/elsewhere/**"]);
        assert!(!file.with_extension("pn-tmp").exists(), "no staged file is left");

        FORGOTTEN.lock().unwrap().push((folder.components().collect(), grant_patterns(&folder)));
        regranted(&folder);
        assert!(FORGOTTEN.lock().unwrap().iter().all(|(f, _)| *f != folder));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
