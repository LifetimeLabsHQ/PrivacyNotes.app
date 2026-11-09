//! Install for `pn`, the command line tool (Settings > CLI, Install).
//!
//! The app's resources carry `pn.mjs` (packages/cli, `bundle.resources` in
//! tauri.conf.json). The resource path is not stable: an AppImage mounts at a
//! new `/tmp/.mount_*` each launch, a DMG run or App Translocation gives a
//! temporary path, and Scoop uses a folder per version. So Install copies the
//! file to `<app local data>/cli/pn.mjs`, and each launch refreshes that copy
//! when the bundled file differs, which keeps `pn` at the app's version.
//!
//! Then a small launcher goes where a terminal finds it: `~/.local/bin/pn` on
//! macOS and Linux, `<app local data>\cli\bin\pn.cmd` on Windows, whose folder
//! is added to the user PATH (never the system PATH). A launcher file that the
//! app did not write is never replaced: its second line carries `MARKER`.
//!
//! Both commands take no arguments, so the only outcome a caller can force is
//! the install itself (tools/entry-points.mjs).
//! Spec: docs/internal/plans/agent-cli.md (section 3.7)

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// The bundled file, as `bundle.resources` names it.
const RESOURCE: &str = "pn.mjs";
/// The second line of every launcher this app writes.
const MARKER: &str = "privacynotes-pn: written by the PrivacyNotes app";
const NODE_HELP: &str = "pn needs Node.js 20 or newer: https://nodejs.org/en/download";

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// The launcher is in place and points at the stable copy.
    installed: bool,
    /// Where the launcher is (or would be).
    command: String,
    /// A new terminal finds `pn` without a change to PATH.
    on_path: bool,
    /// The one shell line that adds the launcher's folder to PATH, when
    /// `on_path` is false. A command, never translated.
    path_line: Option<String>,
}

/// A refusal the pane can name. Anything else is `failed`.
const NOT_OURS: &str = "not_ours";
const FAILED: &str = "failed";

struct Places {
    resource: PathBuf,
    stable: PathBuf,
    launcher: PathBuf,
}

fn places(app: &AppHandle) -> Option<Places> {
    let resource = app.path().resource_dir().ok()?.join(RESOURCE);
    let cli = app.path().app_local_data_dir().ok()?.join("cli");
    #[cfg(windows)]
    let launcher = cli.join("bin").join("pn.cmd");
    #[cfg(not(windows))]
    let launcher = app.path().home_dir().ok()?.join(".local").join("bin").join("pn");
    Some(Places { resource, stable: cli.join(RESOURCE), launcher })
}

/// Whether `pn` is installed, and what the pane should say about PATH.
#[tauri::command]
pub async fn cli_status(app: AppHandle) -> Result<CliStatus, String> {
    let p = places(&app).ok_or(FAILED)?;
    Ok(status_of(&p))
}

/// Copy `pn.mjs` to its stable place and write the launcher.
#[tauri::command]
pub async fn install_cli(app: AppHandle) -> Result<CliStatus, String> {
    let p = places(&app).ok_or(FAILED)?;
    install_into(&p)?;
    #[cfg(windows)]
    if let Some(bin) = p.launcher.parent() {
        windows_path::add(bin).map_err(|_| FAILED)?;
    }
    Ok(status_of(&p))
}

/// At launch: when `pn` is installed, bring the stable copy to the bundled
/// version. Silent: a failure leaves the old copy, which still runs.
pub fn refresh_at_launch(app: &AppHandle) {
    let Some(p) = places(app) else { return };
    if p.stable.exists() {
        let _ = refresh_copy(&p.resource, &p.stable);
    }
}

fn install_into(p: &Places) -> Result<(), String> {
    // Refuse before anything is written, so a refusal changes nothing.
    if !may_write(&p.launcher) {
        return Err(NOT_OURS.into());
    }
    refresh_copy(&p.resource, &p.stable).map_err(|_| FAILED)?;
    write_launcher(&p.launcher, &launcher_text(&p.stable)).map_err(|_| FAILED)?;
    Ok(())
}

/// A missing launcher, or one with our marker, may be written.
fn may_write(launcher: &Path) -> bool {
    match fs::read(launcher) {
        Ok(bytes) => is_ours(&bytes),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

fn is_ours(bytes: &[u8]) -> bool {
    String::from_utf8_lossy(bytes).lines().take(2).any(|l| l.contains(MARKER))
}

/// Copy `from` to `to` when the bytes differ, through a temporary file and a
/// rename, so a terminal that starts `pn` meanwhile never reads half a file.
fn refresh_copy(from: &Path, to: &Path) -> std::io::Result<()> {
    let new = fs::read(from)?;
    if fs::read(to).is_ok_and(|old| old == new) {
        return Ok(());
    }
    write_atomic(to, &new)
}

fn write_atomic(to: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = to.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, to)
}

fn write_launcher(launcher: &Path, text: &str) -> std::io::Result<()> {
    write_atomic(launcher, text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(launcher, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// The `sh` launcher. The path is single-quoted, with a quote inside it
/// written as `'\''`, so no character in it reaches the shell.
#[cfg(not(windows))]
fn launcher_text(stable: &Path) -> String {
    let path = stable.to_string_lossy().replace('\'', r"'\''");
    format!(
        "#!/bin/sh\n# {MARKER}; Settings > CLI replaces it.\ncommand -v node >/dev/null 2>&1 || {{ echo '{NODE_HELP}' >&2; exit 127; }}\nexec node '{path}' \"$@\"\n"
    )
}

/// The `cmd` launcher. A Windows path holds no `"`; a `%` is doubled so cmd
/// does not read it as a variable.
#[cfg(windows)]
fn launcher_text(stable: &Path) -> String {
    let path = stable.to_string_lossy().replace('%', "%%");
    format!(
        "@echo off\r\nrem {MARKER}; Settings > CLI replaces it.\r\nwhere node >nul 2>nul || (echo {NODE_HELP} 1>&2 & exit /b 127)\r\nnode \"{path}\" %*\r\nexit /b %errorlevel%\r\n"
    )
}

fn status_of(p: &Places) -> CliStatus {
    let installed = p.stable.exists()
        && fs::read(&p.launcher).is_ok_and(|b| is_ours(&b) && String::from_utf8_lossy(&b).contains(&*launcher_path_text(&p.stable)));
    let dir = p.launcher.parent().map(Path::to_path_buf).unwrap_or_default();
    let on_path = dir_on_path(&dir);
    CliStatus {
        installed,
        command: p.launcher.to_string_lossy().into_owned(),
        on_path,
        path_line: if on_path { None } else { path_line() },
    }
}

/// How the launcher writes the stable path, to see that it points there.
fn launcher_path_text(stable: &Path) -> String {
    let s = stable.to_string_lossy();
    if cfg!(windows) { s.replace('%', "%%") } else { s.replace('\'', r"'\''") }
}

/// Windows: the folder is on the user PATH once Install added it (a new
/// terminal reads it). macOS and Linux: an app started from the Dock or a
/// menu does not see the shell's PATH, so ask the login shell.
#[cfg(windows)]
fn dir_on_path(dir: &Path) -> bool {
    windows_path::contains(dir)
}

#[cfg(not(windows))]
fn dir_on_path(dir: &Path) -> bool {
    shell_path().is_some_and(|path| path_has(&path, dir))
}

#[cfg(not(windows))]
fn path_has(path: &str, dir: &Path) -> bool {
    let want = dir.to_string_lossy();
    let want = want.trim_end_matches('/');
    path.split(':').any(|p| p.trim_end_matches('/') == want)
}

/// The PATH of an interactive login shell, read with a 3 second limit. The
/// value comes after a marker, so text a startup file prints is skipped.
#[cfg(not(windows))]
fn shell_path() -> Option<String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/'))?;
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", "printf '\\n__PN_PATH__%s\\n' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.lines().rev().find_map(|l| l.strip_prefix("__PN_PATH__").map(str::to_owned))
}

/// The line for the person's shell that puts `~/.local/bin` on PATH.
#[cfg(not(windows))]
fn path_line() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_default();
    Some(line_for_shell(&shell).to_owned())
}

#[cfg(windows)]
fn path_line() -> Option<String> {
    None
}

#[cfg(not(windows))]
fn line_for_shell(shell: &str) -> &'static str {
    match shell.rsplit('/').next().unwrap_or("") {
        "fish" => "fish_add_path ~/.local/bin",
        "bash" => "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.bashrc",
        // zsh is the macOS default; any other shell reads a profile line.
        "zsh" => "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.zshrc",
        _ => "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.profile",
    }
}

/// The user PATH in HKCU\Environment: read, add one folder, tell running
/// programs that the environment changed.
#[cfg(windows)]
mod windows_path {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows::core::w;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, LPARAM, WPARAM};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE,
        REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};

    fn same(a: &str, b: &str) -> bool {
        a.trim().trim_end_matches('\\').eq_ignore_ascii_case(b.trim().trim_end_matches('\\'))
    }

    fn read(key: HKEY) -> windows::core::Result<Option<(String, REG_VALUE_TYPE)>> {
        let mut kind = REG_VALUE_TYPE::default();
        let mut len = 0u32;
        let r = unsafe { RegQueryValueExW(key, w!("Path"), None, Some(&mut kind), None, Some(&mut len)) };
        if r == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        r.ok()?;
        let mut buf = vec![0u8; len as usize];
        unsafe { RegQueryValueExW(key, w!("Path"), None, Some(&mut kind), Some(buf.as_mut_ptr()), Some(&mut len)) }.ok()?;
        let wide: Vec<u16> = buf.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
        let text = String::from_utf16_lossy(&wide).trim_end_matches('\0').to_owned();
        Ok(Some((text, kind)))
    }

    fn open(access: windows::Win32::System::Registry::REG_SAM_FLAGS) -> windows::core::Result<HKEY> {
        let mut key = HKEY::default();
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, w!("Environment"), None, access, &mut key) }.ok()?;
        Ok(key)
    }

    pub fn contains(dir: &Path) -> bool {
        let Ok(key) = open(KEY_READ) else { return false };
        let found = read(key).ok().flatten().is_some_and(|(v, _)| v.split(';').any(|p| same(p, &dir.to_string_lossy())));
        unsafe {
            let _ = RegCloseKey(key);
        }
        found
    }

    pub fn add(dir: &Path) -> windows::core::Result<()> {
        let key = open(KEY_READ | KEY_WRITE)?;
        let result = (|| {
            let want = dir.to_string_lossy().into_owned();
            let (old, kind) = read(key)?.unwrap_or((String::new(), REG_EXPAND_SZ));
            if old.split(';').any(|p| same(p, &want)) {
                return Ok(());
            }
            let kind = if kind == REG_SZ { REG_SZ } else { REG_EXPAND_SZ };
            let joined = if old.trim().is_empty() { want } else { format!("{};{}", old.trim_end_matches(';'), want) };
            let wide: Vec<u16> = std::ffi::OsStr::new(&joined).encode_wide().chain(std::iter::once(0)).collect();
            let bytes: Vec<u8> = wide.iter().flat_map(|u| u.to_le_bytes()).collect();
            unsafe { RegSetValueExW(key, w!("Path"), None, kind, Some(&bytes)) }.ok()?;
            unsafe {
                let _ = SendMessageTimeoutW(
                    HWND_BROADCAST,
                    WM_SETTINGCHANGE,
                    WPARAM(0),
                    LPARAM(w!("Environment").as_ptr() as isize),
                    SMTO_ABORTIFHUNG,
                    5000,
                    None,
                );
            }
            Ok(())
        })();
        unsafe {
            let _ = RegCloseKey(key);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pn-install-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn places_in(d: &Path) -> Places {
        let resource = d.join("res").join(RESOURCE);
        fs::create_dir_all(resource.parent().unwrap()).unwrap();
        fs::write(&resource, "#!/usr/bin/env node\nconsole.log('v1')\n").unwrap();
        Places { resource, stable: d.join("data").join("cli").join(RESOURCE), launcher: d.join("home").join(".local").join("bin").join("pn") }
    }

    #[test]
    fn installs_the_copy_and_the_launcher() {
        let d = temp("fresh");
        let p = places_in(&d);
        install_into(&p).unwrap();
        assert_eq!(fs::read(&p.stable).unwrap(), fs::read(&p.resource).unwrap());
        let text = fs::read_to_string(&p.launcher).unwrap();
        assert!(is_ours(text.as_bytes()));
        assert!(text.contains(&launcher_path_text(&p.stable)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&p.launcher).unwrap().permissions().mode() & 0o777, 0o755);
        }
        assert!(status_of(&p).installed);
    }

    #[test]
    fn refuses_a_launcher_it_did_not_write_and_changes_nothing() {
        let d = temp("foreign");
        let p = places_in(&d);
        fs::create_dir_all(p.launcher.parent().unwrap()).unwrap();
        fs::write(&p.launcher, "#!/bin/sh\necho someone else's pn\n").unwrap();
        assert_eq!(install_into(&p), Err(NOT_OURS.to_string()));
        assert_eq!(fs::read_to_string(&p.launcher).unwrap(), "#!/bin/sh\necho someone else's pn\n");
        assert!(!p.stable.exists());
        assert!(!status_of(&p).installed);
    }

    #[test]
    fn a_second_install_replaces_its_own_launcher() {
        let d = temp("again");
        let p = places_in(&d);
        install_into(&p).unwrap();
        install_into(&p).unwrap();
        assert!(status_of(&p).installed);
    }

    #[test]
    fn the_launch_refresh_brings_the_copy_to_the_bundled_version() {
        let d = temp("refresh");
        let p = places_in(&d);
        install_into(&p).unwrap();
        fs::write(&p.resource, "console.log('v2')\n").unwrap();
        refresh_copy(&p.resource, &p.stable).unwrap();
        assert_eq!(fs::read_to_string(&p.stable).unwrap(), "console.log('v2')\n");
        assert!(!p.stable.with_extension("tmp").exists());
    }

    #[cfg(not(windows))]
    #[test]
    fn a_quote_in_the_path_cannot_reach_the_shell() {
        let text = launcher_text(Path::new("/Users/o'neil/x/pn.mjs"));
        assert!(text.contains(r"exec node '/Users/o'\''neil/x/pn.mjs' "));
        let status = std::process::Command::new("/bin/sh").arg("-n").arg("-c").arg(&text).status().unwrap();
        assert!(status.success());
    }

    /// The launcher end to end: it runs node on the stable copy with every
    /// argument intact. Skipped where node is not installed.
    #[cfg(not(windows))]
    #[test]
    fn the_launcher_runs_the_copy_with_its_arguments() {
        let has_node = std::process::Command::new("/bin/sh").args(["-c", "command -v node"]).output().is_ok_and(|o| o.status.success());
        if !has_node {
            return;
        }
        let d = temp("run");
        let p = places_in(&d);
        fs::write(&p.resource, "console.log(JSON.stringify(process.argv.slice(2)))\n").unwrap();
        install_into(&p).unwrap();
        let out = std::process::Command::new(&p.launcher).args(["save", "a b", "--tag", "x'y"]).output().unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), r#"["save","a b","--tag","x'y"]"#);
    }

    #[cfg(not(windows))]
    #[test]
    fn path_lines_per_shell_and_path_matching() {
        assert_eq!(line_for_shell("/opt/homebrew/bin/fish"), "fish_add_path ~/.local/bin");
        assert!(line_for_shell("/bin/zsh").ends_with("~/.zshrc"));
        assert!(line_for_shell("/bin/bash").ends_with("~/.bashrc"));
        assert!(line_for_shell("/bin/dash").ends_with("~/.profile"));
        assert!(path_has("/usr/bin:/home/a/.local/bin/:/bin", Path::new("/home/a/.local/bin")));
        assert!(!path_has("/usr/bin:/home/a/.local/bin2", Path::new("/home/a/.local/bin")));
    }
}
