//! macOS: the @_cdecl functions in macos/Sources/AppleMLMac/Exports.swift.

use super::{Answer, Progress};
use serde_json::Value;
use std::ffi::c_void;
use swift_rs::{autoreleasepool, swift, SRData, SRString};
use tauri::{ipc::Channel, AppHandle, Runtime};

// Never a plain `extern "C"` block with `&SRString`: that passes a pointer to
// the Rust handle, not the Swift object, and the first objc_msgSend crashes.
// swift! passes the object pointer. The progress callback goes as a raw
// pointer; Swift reads it as a @convention(c) function.
//
// Each call runs in its own autorelease pool: the calls run on tokio's
// blocking threads, which have none, so the Swift copies of a picture or a
// recording and the answer's text would wait for the thread to exit
// (beta #242 entry 8). swift-rs retains the answer, so it outlives the pool.
swift!(fn apple_ml_ocr(image: &SRData, languages: &SRString) -> SRString);
swift!(fn apple_ml_speech_status(locale: &SRString) -> SRString);
swift!(fn apple_ml_speech_install(locale: &SRString, context: *const c_void, progress: *const c_void) -> SRString);
swift!(fn apple_ml_transcribe(pcm: &SRData, locale: &SRString, call: u64) -> SRString);
swift!(fn apple_ml_cancel(call: u64) -> bool);

/// {"ok": v} becomes Ok(v), {"err": code} becomes Err(code).
fn open(raw: SRString) -> Answer {
    let mut v: Value = serde_json::from_str(raw.as_str()).map_err(|_| "io".to_string())?;
    if let Some(ok) = v.get_mut("ok") {
        return Ok(ok.take());
    }
    Err(v.get("err").and_then(Value::as_str).unwrap_or("io").to_string())
}

pub fn ocr<R: Runtime>(_: &AppHandle<R>, image: Vec<u8>, languages: Vec<String>) -> Answer {
    let langs = languages.join(",");
    autoreleasepool!(open(unsafe { apple_ml_ocr(&SRData::from(&image[..]), &SRString::from(langs.as_str())) }))
}

pub fn scan<R: Runtime>(_: &AppHandle<R>, _: Option<f64>) -> Result<(u64, Vec<u8>), String> {
    // VisionKit's document camera exists on iOS only: the Mac app uses our scanner.
    Err("unsupported".into())
}

pub fn speech_status<R: Runtime>(_: &AppHandle<R>, locale: String) -> Answer {
    autoreleasepool!(open(unsafe { apple_ml_speech_status(&SRString::from(locale.as_str())) }))
}

extern "C" fn on_progress(context: *const c_void, fraction: f64) {
    // Safety: context is the &Channel in speech_install, alive until its call returns.
    let channel = unsafe { &*(context as *const Channel<Progress>) };
    let _ = channel.send(Progress { fraction });
}

pub fn speech_install<R: Runtime>(_: &AppHandle<R>, locale: String, channel: Channel<Progress>) -> Answer {
    let ctx = &channel as *const Channel<Progress> as *const c_void;
    let cb = on_progress as extern "C" fn(*const c_void, f64) as *const c_void;
    autoreleasepool!(open(unsafe { apple_ml_speech_install(&SRString::from(locale.as_str()), ctx, cb) }))
}

pub fn transcribe<R: Runtime>(_: &AppHandle<R>, pcm: Vec<u8>, locale: String, call: u64) -> Answer {
    autoreleasepool!(open(unsafe { apple_ml_transcribe(&SRData::from(&pcm[..]), &SRString::from(locale.as_str()), call) }))
}

pub fn cancel<R: Runtime>(_: &AppHandle<R>, call: u64) -> Answer {
    autoreleasepool!(unsafe { apple_ml_cancel(call) });
    Ok(Value::Null)
}
