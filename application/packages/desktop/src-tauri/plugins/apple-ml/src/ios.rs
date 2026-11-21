//! iOS: the Swift class in ios/Sources/AppleMLPlugin.swift.

use super::{Answer, Progress};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{
    ipc::Channel,
    plugin::{mobile::PluginInvokeError, PluginHandle},
    AppHandle, Manager, Runtime,
};

pub struct Handle<R: Runtime>(pub PluginHandle<R>);

fn run<R: Runtime>(app: &AppHandle<R>, cmd: &str, args: impl Serialize) -> Answer {
    let handle = app.state::<Handle<R>>();
    handle.0.run_mobile_plugin::<Value>(cmd, args).map_err(|e| match e {
        PluginInvokeError::InvokeRejected(r) => r.code.unwrap_or_else(|| "io".into()),
        _ => "io".into(),
    })
}

#[derive(Serialize)]
struct OcrArgs {
    image: String,
    languages: Vec<String>,
}

pub fn ocr<R: Runtime>(app: &AppHandle<R>, image: Vec<u8>, languages: Vec<String>) -> Answer {
    run(app, "ocr", OcrArgs { image: base64::engine::general_purpose::STANDARD.encode(image), languages })
}

#[derive(Serialize)]
struct ScanArgs {
    quality: Option<f64>,
}

/// The page count and the first page.
pub fn scan<R: Runtime>(app: &AppHandle<R>, quality: Option<f64>) -> Result<(u64, Vec<u8>), String> {
    let answer = run(app, "scan", ScanArgs { quality })?;
    let page = answer.get("page").and_then(Value::as_str).ok_or_else(|| "io".to_string())?;
    let pages = answer.get("pages").and_then(Value::as_u64).unwrap_or(1);
    let jpeg = base64::engine::general_purpose::STANDARD.decode(page).map_err(|_| "io".to_string())?;
    Ok((pages, jpeg))
}

#[derive(Serialize)]
struct LocaleArgs {
    locale: String,
}

pub fn speech_status<R: Runtime>(app: &AppHandle<R>, locale: String) -> Answer {
    run(app, "speechStatus", LocaleArgs { locale })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallArgs {
    locale: String,
    on_progress: Channel<Progress>,
}

pub fn speech_install<R: Runtime>(app: &AppHandle<R>, locale: String, on_progress: Channel<Progress>) -> Answer {
    run(app, "speechInstall", InstallArgs { locale, on_progress })
}

#[derive(Serialize)]
struct TranscribeArgs {
    pcm: String,
    locale: String,
    call: u64,
}

pub fn transcribe<R: Runtime>(app: &AppHandle<R>, pcm: Vec<u8>, locale: String, call: u64) -> Answer {
    run(app, "transcribe", TranscribeArgs { pcm: base64::engine::general_purpose::STANDARD.encode(pcm), locale, call })
}

#[derive(Serialize)]
struct CancelArgs {
    call: u64,
}

pub fn cancel<R: Runtime>(app: &AppHandle<R>, call: u64) -> Answer {
    run(app, "cancel", CancelArgs { call })
}
