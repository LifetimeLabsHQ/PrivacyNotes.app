//! The main window's filesystem grants refuse a new file in every
//! denied folder, whatever spelling of the folder a script uses.
//!
//! The deny entries are globs that fold ASCII case only, and tauri-plugin-fs
//! canonicalizes a path only when the whole path exists, so a new file is
//! matched as the caller spells it. APFS (case-insensitive, the macOS default)
//! folds full Unicode case: it opens `LaunchAgentſ` (U+017F) as
//! `LaunchAgents`, `WebKit` with U+212A as `WebKit`, and `ﬆartup` (U+FB06) as
//! `Startup`. A deny list cannot list those, so the grants carry no static
//! allow at all and reach only what the user picked (the runtime scope).
//!
//! The decision below is the one tauri-plugin-fs 2.6.0 makes in `resolve_path`
//! (src/commands.rs:1564-1600): the `fs:scope` and command entries merged into
//! one `Scope`, `is_forbidden` against it and against the runtime scope, then
//! `is_allowed` on either. `is_forbidden` is private to the plugin, so it is
//! copied here, and the Cargo.lock check makes a plugin update re-read it.
//! Spec: docs/internal/plans/desktop-fs-casefold.md (section 4)
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::scope::fs::Scope;
use tauri::utils::config::FsScope;

const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");
const CAPABILITIES: [&str; 2] = ["capabilities/default.json", "capabilities/desktop.json"];
const NEW_FILE: &str = "sec155-new.txt";

/// tauri-plugin-fs-2.6.0/src/commands.rs:1616-1650, logic unchanged.
fn is_forbidden(scope: &Scope, path: &Path, require_literal_leading_dot: bool) -> bool {
    let path = if path.is_symlink() {
        match std::fs::read_link(path) {
            Ok(p) => p,
            Err(_) => return false,
        }
    } else {
        path.to_path_buf()
    };
    let path = if !path.exists() {
        Ok(path)
    } else {
        std::fs::canonicalize(path)
    };
    if let Ok(path) = path {
        let path: PathBuf = path.components().collect();
        scope.forbidden_patterns().iter().any(|p| {
            p.matches_path_with(
                &path,
                glob::MatchOptions {
                    require_literal_separator: true,
                    require_literal_leading_dot,
                    ..Default::default()
                },
            )
        })
    } else {
        false
    }
}

#[derive(Debug, PartialEq)]
enum Decision {
    Allowed,
    Denied,
    NotAllowed,
}

struct Grant {
    id: String,
    scope: Scope,
}

struct Setup {
    home: PathBuf,
    rlld: bool,
    grants: Vec<Grant>,
    /// What the plugin keeps as `fs_scope.scope`: empty at start, widened by
    /// the folder picker, Save As and `take_pending_opens`.
    runtime: Scope,
    deny_folders: Vec<String>,
}

fn read_json(rel: &str) -> serde_json::Value {
    let text = std::fs::read_to_string(Path::new(MANIFEST_DIR).join(rel)).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn entries(p: &serde_json::Value, key: &str) -> Vec<PathBuf> {
    p[key]
        .as_array()
        .map(|a| a.iter().map(|e| PathBuf::from(e["path"].as_str().unwrap())).collect())
        .unwrap_or_default()
}

/// A home of our own on the volume the repository is on, set once for the
/// whole test binary: Scope::new resolves `$HOME` from the environment.
fn fake_home() -> &'static PathBuf {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let home = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("sec155-home");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        // Edition 2021: set_var is safe; no other thread reads the
        // environment before this lock is initialized.
        std::env::set_var("HOME", &home);
        home
    })
}

fn setup() -> Setup {
    let lock = std::fs::read_to_string(Path::new(MANIFEST_DIR).join("Cargo.lock")).unwrap();
    assert!(
        lock.contains("name = \"tauri-plugin-fs\"\nversion = \"2.6.0\"\n"),
        "tauri-plugin-fs is no longer 2.6.0: re-read resolve_path and is_forbidden in its \
         src/commands.rs and update the copy and the decision in this test"
    );
    let home = fake_home().clone();
    let app = tauri::test::mock_app();
    let rlld = read_json("tauri.conf.json")["plugins"]["fs"]["requireLiteralLeadingDot"]
        .as_bool()
        .unwrap_or(true);

    let mut global_allow = vec![];
    let mut global_deny = vec![];
    let mut commands = vec![];
    for file in CAPABILITIES {
        let cap = read_json(file);
        for p in cap["permissions"].as_array().unwrap() {
            if let Some(id) = p.as_str() {
                // A bare fs: permission brings a scope this test cannot see.
                assert!(!id.starts_with("fs:"), "{file}: bare `{id}`; give it an explicit scope and teach this test");
                continue;
            }
            let id = p["identifier"].as_str().unwrap();
            if !id.starts_with("fs:") {
                continue;
            }
            if id.starts_with("fs:scope") {
                global_allow.extend(entries(p, "allow"));
                global_deny.extend(entries(p, "deny"));
            } else {
                commands.push((format!("{file} {id}"), entries(p, "allow"), entries(p, "deny")));
            }
        }
    }
    assert!(!commands.is_empty(), "no fs: grants found");

    let mut deny_folders: Vec<String> = vec![];
    let grants = commands
        .into_iter()
        .map(|(id, allow, deny)| {
            for d in &deny {
                let d = d.to_str().unwrap();
                let rel = d.trim_start_matches("$HOME/").trim_end_matches("/**").to_string();
                if !deny_folders.contains(&rel) {
                    deny_folders.push(rel);
                }
            }
            let fs = FsScope::Scope {
                allow: global_allow.iter().cloned().chain(allow).collect(),
                deny: global_deny.iter().cloned().chain(deny).collect(),
                require_literal_leading_dot: Some(rlld),
            };
            Grant { id, scope: Scope::new(&app, &fs).unwrap() }
        })
        .collect();
    let runtime = Scope::new(&app, &FsScope::default()).unwrap();
    Setup { home, rlld, grants, runtime, deny_folders }
}

fn decide(s: &Setup, g: &Grant, path: &Path) -> Decision {
    if is_forbidden(&s.runtime, path, s.rlld) || is_forbidden(&g.scope, path, s.rlld) {
        Decision::Denied
    } else if s.runtime.is_allowed(path) || g.scope.is_allowed(path) {
        Decision::Allowed
    } else {
        Decision::NotAllowed
    }
}

/// The spellings APFS opens as `rel`: as written, upper case, every `s` as a
/// long s, every `k` as the Kelvin sign, and every `st` as the ligature. Only
/// the ones that differ from `rel`.
fn spellings(rel: &str) -> Vec<(&'static str, String)> {
    let swap = |from: &[char], to: char| -> String {
        rel.chars().map(|c| if from.contains(&c) { to } else { c }).collect()
    };
    let mut st = String::new();
    let chars: Vec<char> = rel.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if i + 1 < chars.len() && chars[i].eq_ignore_ascii_case(&'s') && chars[i + 1].eq_ignore_ascii_case(&'t') {
            st.push('\u{fb06}');
            i += 2;
        } else {
            st.push(chars[i]);
            i += 1;
        }
    }
    let mut out = vec![("ascii", rel.to_string()), ("upper case", rel.to_uppercase())];
    for (name, s) in [
        ("long s U+017F", swap(&['s', 'S'], '\u{17f}')),
        ("Kelvin U+212A", swap(&['k', 'K'], '\u{212a}')),
        ("ligature st U+FB06", st),
    ] {
        if s != rel {
            out.push((name, s));
        }
    }
    out
}

/// True when this volume opens `LaunchAgentſ` as `LaunchAgents`.
fn folds_unicode_case(home: &Path) -> bool {
    let real = home.join("Library/LaunchAgents");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::canonicalize(home.join("Library/LaunchAgent\u{17f}"))
        .map(|c| c == std::fs::canonicalize(&real).unwrap())
        .unwrap_or(false)
}

#[test]
fn every_denied_folder_refuses_a_new_file_in_every_folded_spelling() {
    let s = setup();
    if !folds_unicode_case(&s.home) {
        eprintln!(
            "SKIPPED: {} is on a volume that does not fold Unicode case (case-sensitive), \
             so no folded spelling reaches a denied folder here. Run it on a Mac's APFS volume.",
            s.home.display()
        );
        return;
    }
    let mut targets = s.deny_folders.clone();
    // Under `AppData/**`, and the one denied place whose name has an `st`.
    targets.push("AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup".into());
    // The CLI copy that `refresh_at_launch` runs, under the app's data.
    targets.push("Library/Application Support/app.privacynotes/cli".into());
    for t in &targets {
        std::fs::create_dir_all(s.home.join(t)).unwrap();
    }

    let mut failures = vec![];
    let mut checked = 0;
    for t in &targets {
        for (spelling, spelled) in spellings(t) {
            for path in [s.home.join(&spelled), s.home.join(&spelled).join(NEW_FILE)] {
                for g in &s.grants {
                    checked += 1;
                    if decide(&s, g, &path) == Decision::Allowed {
                        // The new file does not exist, so where its folder is.
                        let opens = std::fs::canonicalize(&path)
                            .or_else(|_| std::fs::canonicalize(path.parent().unwrap()))
                            .map(|c| c.strip_prefix(std::fs::canonicalize(&s.home).unwrap()).unwrap().display().to_string())
                            .unwrap_or_else(|_| "(no folder)".into());
                        failures.push(format!(
                            "ALLOWED {}: ~/{} ({spelling}; the OS opens ~/{opens})",
                            g.id,
                            path.strip_prefix(&s.home).unwrap().display(),
                        ));
                    }
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {checked} decisions let the window reach a denied folder:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn only_what_the_user_picked_is_reachable() {
    let s = setup();
    let notes = s.home.join("Documents/Notes");
    std::fs::create_dir_all(notes.join("sub")).unwrap();
    let note = notes.join("a.md");
    let each = |path: &Path| -> Vec<(String, Decision)> {
        s.grants.iter().map(|g| (g.id.clone(), decide(&s, g, path))).collect()
    };
    let all_are = |path: &Path, want: Decision| {
        for (id, d) in each(path) {
            assert_eq!(d, want, "{id}: {}", path.display());
        }
    };

    // Nothing in the home before a pick.
    all_are(&note, Decision::NotAllowed);
    all_are(&s.home.join("Documents/other.md"), Decision::NotAllowed);

    // The folder picker: tauri-plugin-dialog `open({ directory: true,
    // recursive: true })` calls allow_directory(picked, true).
    s.runtime.allow_directory(&notes, true).unwrap();
    all_are(&note, Decision::Allowed);
    all_are(&notes.join("sub/b.md"), Decision::Allowed);
    // The staged save beside a file (fileAccess.ts stagingPath).
    all_are(&notes.join("a.md.pn-tmp"), Decision::Allowed);
    // A dot path inside the folder stays out (requireLiteralLeadingDot).
    all_are(&notes.join(".obsidian/app.json"), Decision::NotAllowed);
    // Beside the folder stays out.
    all_are(&s.home.join("Documents/other.md"), Decision::NotAllowed);
    all_are(&s.home.join("Library/LaunchAgent\u{17f}").join(NEW_FILE), Decision::NotAllowed);

    // Save As: allow_file(chosen path), that path and nothing beside it.
    let saved = s.home.join("Downloads/backup.zip");
    s.runtime.allow_file(&saved).unwrap();
    all_are(&saved, Decision::Allowed);
    all_are(&s.home.join("Downloads/other.zip"), Decision::NotAllowed);

    // A double-clicked file (take_pending_opens in src/lib.rs): the file and
    // its staging path, nothing else in its folder.
    let opened = s.home.join("Desktop/todo.md");
    s.runtime.allow_file(&opened).unwrap();
    s.runtime.allow_file(PathBuf::from(format!("{}.pn-tmp", opened.display()))).unwrap();
    all_are(&opened, Decision::Allowed);
    all_are(&s.home.join("Desktop/todo.md.pn-tmp"), Decision::Allowed);
    all_are(&s.home.join("Desktop/other.md"), Decision::NotAllowed);
}
