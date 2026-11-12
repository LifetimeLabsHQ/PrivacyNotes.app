//! The phone half of automatic backups.
//!
//! The Kotlin side (`android/`) holds a Storage Access Framework tree URI,
//! the Swift side (`ios/`) a security-scoped bookmark. Both pick the folder,
//! place one staged file in it and read it back, and find or delete a file
//! they placed. This crate carries those calls and maps a rejection onto its
//! code. The app compiles it for Android and iOS only, and only
//! `src/backup_dest.rs` calls it.
//! Spec: docs/internal/plans/auto-backup.md (section 7)

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.privacynotes.backupfolder";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_backup_folder);

/// The codes the native side may reject with; anything else is `io`.
const CODES: [&str; 6] = ["no-destination", "bad-name", "gone", "denied", "full", "io"];

/// Access to the folder calls.
pub struct BackupFolder<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct NoArgs {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaceArgs<'a> {
    staging_path: &'a str,
    name: &'a str,
}

#[derive(Serialize)]
struct RefArgs<'a> {
    #[serde(rename = "ref")]
    reference: &'a str,
}

#[derive(Deserialize)]
struct Picked {
    picked: bool,
    #[serde(default)]
    label: String,
}

#[derive(Deserialize)]
struct StatusAnswer {
    stored: bool,
    #[serde(default)]
    label: String,
    #[serde(default)]
    reachable: bool,
}

#[derive(Deserialize)]
struct Flag {
    value: bool,
}

/// The stored folder and whether it can be used now.
pub struct Status {
    pub label: String,
    pub reachable: bool,
}

/// A file that is in the folder: its reference, the name the provider gave
/// it, and the size and SHA-256 (hex) of the bytes read back from it.
#[derive(Deserialize)]
pub struct Stored {
    #[serde(rename = "ref")]
    pub reference: String,
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

fn code_of(err: tauri::plugin::mobile::PluginInvokeError) -> String {
    match err {
        tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) => response
            .code
            .filter(|code| CODES.contains(&code.as_str()))
            .unwrap_or_else(|| "io".to_owned()),
        _ => "io".to_owned(),
    }
}

impl<R: Runtime> BackupFolder<R> {
    /// Opens the folder picker and stores the choice. The label of the
    /// folder, or None when the person cancelled. Blocks until they answer.
    pub fn pick(&self) -> Result<Option<String>, String> {
        let picked = self.0.run_mobile_plugin::<Picked>("pick", NoArgs {}).map_err(code_of)?;
        Ok(picked.picked.then_some(picked.label))
    }

    /// None when no folder is stored.
    pub fn status(&self) -> Result<Option<Status>, String> {
        let status = self.0.run_mobile_plugin::<StatusAnswer>("status", NoArgs {}).map_err(code_of)?;
        Ok(status.stored.then_some(Status { label: status.label, reachable: status.reachable }))
    }

    /// Copies the staging file into the folder under `name` and reads the
    /// stored file back. The caller compares the size and hash.
    pub fn place(&self, staging_path: &str, name: &str) -> Result<Stored, String> {
        self.0.run_mobile_plugin("place", PlaceArgs { staging_path, name }).map_err(code_of)
    }

    pub fn exists(&self, reference: &str) -> Result<bool, String> {
        self.0.run_mobile_plugin::<Flag>("exists", RefArgs { reference }).map(|flag| flag.value).map_err(code_of)
    }

    /// False when the file is not there.
    pub fn delete(&self, reference: &str) -> Result<bool, String> {
        self.0.run_mobile_plugin::<Flag>("delete", RefArgs { reference }).map(|flag| flag.value).map_err(code_of)
    }

    /// Forgets the folder and gives its permission back. No file is deleted.
    pub fn clear(&self) -> Result<(), String> {
        self.0.run_mobile_plugin::<()>("clear", NoArgs {}).map_err(code_of)
    }

    /// Whether the connection in use is metered.
    pub fn metered(&self) -> Result<bool, String> {
        self.0.run_mobile_plugin::<Flag>("metered", NoArgs {}).map(|flag| flag.value).map_err(code_of)
    }
}

/// Access from the app handle.
pub trait BackupFolderExt<R: Runtime> {
    fn backup_folder(&self) -> &BackupFolder<R>;
}

impl<R: Runtime, T: Manager<R>> BackupFolderExt<R> for T {
    fn backup_folder(&self) -> &BackupFolder<R> {
        self.state::<BackupFolder<R>>().inner()
    }
}

/// Registers the Kotlin or the Swift plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("backup-folder")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "BackupFolderPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_backup_folder)?;
            app.manage(BackupFolder(handle));
            Ok(())
        })
        .build()
}
