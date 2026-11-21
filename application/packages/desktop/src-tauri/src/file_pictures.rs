//! The pictures of a Markdown file the person opened on its own.
//!
//! A file opened without its folder (a double-click, a launch argument, the
//! file picker) holds only itself in the fs scope, so the pane could not look
//! up a picture beside it, and the asset scope (asset_scope.rs) copied
//! nothing but the file. `grant_file_picture` grants the asset scope one
//! picture the file names, after it checked here, natively, what the page
//! asks for: a relative name with a picture extension, at or under the file's
//! own folder, no dot-name and no link at any part of the way, a regular file,
//! outside the deny list. It never widens the fs scope, so nothing beside the
//! file can be listed, read as text or written, and the grant ends with the
//! run (the pane asks again at each open).
//! Spec: docs/internal/plans/desktop-asset-scope.md (section 2)

use crate::opened_file::{is_openable, DenyPath};
use std::path::{Component, Path, PathBuf};
use tauri::ipc::CommandScope;
use tauri::Manager;

/// The picture extensions, as `IMAGE_EXT` in web/src/markdownFolder/useAssets.ts.
const PICTURE_EXT: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];

/// The picture `name` that `file` names, when it sits at or under the file's
/// own folder and passes every check above; None otherwise.
pub fn picture_beside(file: &Path, name: &str) -> Option<PathBuf> {
    let ext = Path::new(name).extension()?.to_str()?;
    if !PICTURE_EXT.iter().any(|known| known.eq_ignore_ascii_case(ext)) {
        return None;
    }
    let mut at = file.parent()?.to_path_buf();
    let mut depth = 0;
    for part in Path::new(name).components() {
        match part {
            Component::CurDir => continue,
            // A dot-name is out of reach as in the fs scope
            // (`requireLiteralLeadingDot`) and the folder scan.
            Component::Normal(part) if part.as_encoded_bytes().first() != Some(&b'.') => at.push(part),
            // `..`, a root, a drive or a share.
            _ => return None,
        }
        // `symlink_metadata` does not follow the last link, so each part is
        // asked on its own, as `crossesLink` in fileAccess.ts asks.
        if std::fs::symlink_metadata(&at).ok()?.file_type().is_symlink() {
            return None;
        }
        depth += 1;
    }
    (depth > 0 && std::fs::symlink_metadata(&at).ok()?.is_file()).then_some(at)
}

/// Grant the asset scope the picture `picture` that the opened file `path`
/// names, and hand back its path for `convertFileSrc`; None when any check
/// refuses.
#[tauri::command(async)]
pub fn grant_file_picture(
    app: tauri::AppHandle,
    deny: CommandScope<DenyPath>,
    path: String,
    picture: String,
) -> Option<String> {
    let file = PathBuf::from(&path);
    if !file.is_absolute() || !is_openable(&path) {
        return None;
    }
    let denied = crate::opened_file::deny_scope(&app, &deny)?;
    let opened = crate::opened_file::in_fs_scope(&app, &file);
    if !opened || denied.is_forbidden(&file) {
        return None;
    }
    let found = picture_beside(&file, &picture)?;
    if denied.is_forbidden(&found) {
        return None;
    }
    app.asset_protocol_scope().allow_file(&found).ok()?;
    found.into_os_string().into_string().ok()
}

#[cfg(test)]
mod tests {
    use super::picture_beside;
    use std::fs;
    use std::path::PathBuf;

    /// A folder with `note.md`, `beside.png`, `attachments/a.png`, a text
    /// file, a dot-folder with a picture, and a picture outside it.
    fn folder(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("pn-file-pictures-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("notes");
        for sub in ["attachments", ".hidden", "deep/er"] {
            fs::create_dir_all(dir.join(sub)).expect("folder");
        }
        for file in ["note.md", "beside.png", "attachments/a.png", "Photo.JPG", "notes.txt", ".hidden/x.png", "deep/er/y.webp"] {
            fs::write(dir.join(file), b"x").expect("file");
        }
        fs::write(base.join("outside.png"), b"x").expect("file");
        (base, dir)
    }

    #[test]
    fn grants_a_picture_beside_the_file_and_below_it() {
        let (base, dir) = folder("beside");
        let note = dir.join("note.md");
        assert_eq!(picture_beside(&note, "beside.png"), Some(dir.join("beside.png")));
        assert_eq!(picture_beside(&note, "./beside.png"), Some(dir.join("beside.png")));
        assert_eq!(picture_beside(&note, "attachments/a.png"), Some(dir.join("attachments").join("a.png")));
        assert_eq!(picture_beside(&note, "deep/er/y.webp"), Some(dir.join("deep").join("er").join("y.webp")));
        assert_eq!(picture_beside(&note, "Photo.JPG"), Some(dir.join("Photo.JPG")));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn refuses_everything_that_is_not_a_picture_inside_the_folder() {
        let (base, dir) = folder("refuse");
        let note = dir.join("note.md");
        let outside = base.join("outside.png");
        for name in [
            "",
            ".",
            "../outside.png",
            "attachments/../../outside.png",
            outside.to_str().expect("utf-8"),
            "notes.txt",
            "note.md",
            "missing.png",
            "attachments",
            ".hidden/x.png",
            "attachments/",
        ] {
            assert_eq!(picture_beside(&note, name), None, "{name:?}");
        }
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_link_at_any_part_of_the_way() {
        let (base, dir) = folder("link");
        let note = dir.join("note.md");
        std::os::unix::fs::symlink(base.join("outside.png"), dir.join("link.png")).expect("link");
        std::os::unix::fs::symlink(&base, dir.join("up")).expect("link");
        std::os::unix::fs::symlink("beside.png", dir.join("near.png")).expect("link");
        assert_eq!(picture_beside(&note, "link.png"), None);
        assert_eq!(picture_beside(&note, "up/outside.png"), None);
        assert_eq!(picture_beside(&note, "near.png"), None);
        let _ = fs::remove_dir_all(base);
    }
}
