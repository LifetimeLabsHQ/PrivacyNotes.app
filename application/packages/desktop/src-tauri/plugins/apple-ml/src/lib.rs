//! Apple's on-device engines behind one Tauri plugin, for Settings > Plugins.
//!
//! iOS: the Swift class in ios/ (a Tauri mobile plugin), reached through
//! `run_mobile_plugin`. macOS: the @_cdecl bridge in macos/, linked with
//! swift-rs. Both call the same Swift core in core/. The app depends on this
//! crate on macOS and iOS only, so no other platform's app has these
//! commands. Every input and output stays in memory: no temporary file.
//!
//! Commands (`plugin:apple-ml|<name>`):
//! - `ocr`: raw body = image bytes (JPEG, PNG, WebP, GIF, HEIC or AVIF by
//!   their first bytes), header `x-languages` ("" lets Vision detect).
//! - `scan`: `{ quality? }`, iOS only; answers one byte with the number of
//!   pages the camera took (at most 255), then the first page's JPEG bytes.
//! - `speech_status`: `{ locale }`; `{ locale, status }` (`os-too-old` below iOS and macOS 26).
//! - `speech_install`: `{ locale, onProgress: Channel }`; the status once installed.
//! - `transcribe`: raw body = 16 kHz mono 16-bit PCM, header `x-locale`.
//! - `cancel`: ends the running `transcribe`, which then fails `canceled`.
//!
//! One `ocr` and one `transcribe` run at a time; a second answers `busy`.
//!
//! Spec: docs/internal/plans/plugins.md (section 6.7), docs/internal/specs/plugins-apple.md

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{
    ipc::{Channel, InvokeBody, Request, Response},
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
mod ios;
// The binding makes a private fn, so it lives where setup() calls it.
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_apple_ml);
#[cfg(target_os = "macos")]
mod macos;

const MAX_IMAGE: usize = 40 * 1024 * 1024;
/// One hour of 16 kHz mono 16-bit PCM.
/// Spec: docs/internal/plans/plugins.md (section 6.6)
const MAX_PCM: usize = 3600 * 16_000 * 2;

/// The OS model download, 0 to 1.
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Progress {
    pub fraction: f64,
}

/// What a command fails with: one short code, never an OS message.
type Answer = Result<Value, String>;

fn body(request: &Request<'_>, max: usize) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(b) if !b.is_empty() && b.len() <= max => Ok(b.clone()),
        InvokeBody::Raw(_) => Err("bad-size".into()),
        _ => Err("bad-body".into()),
    }
}

fn header(request: &Request<'_>, name: &str) -> String {
    request.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// A comma-separated list of ids of ASCII letters, digits and `-`, 1 to 16
/// each and 200 bytes in all; an empty list is allowed (the engine detects).
/// A check of characters and lengths, not of BCP 47: no path, quote,
/// separator or control character reaches the engines, and the OS answers
/// `unsupported-locale` for an id it does not know.
fn clean_locales(raw: &str) -> Result<Vec<String>, String> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let list: Vec<String> = raw.split(',').map(String::from).collect();
    let ok = raw.len() <= 200
        && list.iter().all(|l| !l.is_empty() && l.len() <= 16 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    if ok {
        Ok(list)
    } else {
        Err("bad-locale".into())
    }
}

/// Exactly one locale.
fn clean_locale(raw: &str) -> Result<String, String> {
    let mut list = clean_locales(raw)?;
    if list.len() == 1 {
        Ok(list.remove(0))
    } else {
        Err("bad-locale".into())
    }
}

/// The picture formats the app stores, by their first bytes: JPEG, PNG, WebP,
/// GIF, and HEIC or AVIF by their `ftyp` brand. ImageIO decodes far more
/// (TIFF, PSD, camera raw and others) in the app's own process, so nothing
/// else reaches it (beta #242 entry 6).
fn known_image(b: &[u8]) -> bool {
    const HEIF_BRANDS: [&[u8]; 10] = [b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1", b"avif", b"avis"];
    b.starts_with(&[0xFF, 0xD8, 0xFF])
        || b.starts_with(b"\x89PNG\r\n\x1a\n")
        || b.starts_with(b"GIF87a")
        || b.starts_with(b"GIF89a")
        || (b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP")
        || (b.len() >= 12 && &b[4..8] == b"ftyp" && HEIF_BRANDS.contains(&&b[8..12]))
}

/// The one running `ocr`: a second call answers `busy` (beta #242 entry 5).
static OCR_RUNNING: AtomicBool = AtomicBool::new(false);
/// The number of the running `transcribe`, so `cancel` can name it to Swift.
static TRANSCRIBING: Mutex<Option<u64>> = Mutex::new(None);
static NEXT_CALL: AtomicU64 = AtomicU64::new(1);

/// Holds the `ocr` slot until dropped, at the end of the native call.
struct OcrSlot;

impl OcrSlot {
    fn take() -> Result<Self, String> {
        OCR_RUNNING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).map(|_| OcrSlot).map_err(|_| "busy".to_string())
    }
}

impl Drop for OcrSlot {
    fn drop(&mut self) {
        OCR_RUNNING.store(false, Ordering::Release);
    }
}

/// Holds the `transcribe` slot and the call's number until dropped.
struct TranscribeSlot(u64);

fn transcribing() -> std::sync::MutexGuard<'static, Option<u64>> {
    TRANSCRIBING.lock().unwrap_or_else(|e| e.into_inner())
}

impl TranscribeSlot {
    fn take() -> Result<Self, String> {
        let mut running = transcribing();
        if running.is_some() {
            return Err("busy".into());
        }
        let call = NEXT_CALL.fetch_add(1, Ordering::Relaxed);
        *running = Some(call);
        Ok(TranscribeSlot(call))
    }
}

impl Drop for TranscribeSlot {
    fn drop(&mut self) {
        let mut running = transcribing();
        if *running == Some(self.0) {
            *running = None;
        }
    }
}

async fn blocking<T: Send + 'static, F: FnOnce() -> Result<T, String> + Send + 'static>(f: F) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.unwrap_or_else(|_| Err("io".into()))
}

#[tauri::command]
async fn ocr<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Answer {
    let image = body(&request, MAX_IMAGE)?;
    if !known_image(&image) {
        return Err("bad-image".into());
    }
    let languages = clean_locales(&header(&request, "x-languages"))?;
    let slot = OcrSlot::take()?;
    blocking(move || {
        let _slot = slot;
        native::ocr(&app, image, languages)
    })
    .await
}

/// The scanned page as raw bytes, never as a file or a JSON array of numbers:
/// one byte with the page count, then the first page. The camera takes many
/// pages and the app keeps one (plugins.md D11), so the page says so.
#[tauri::command]
async fn scan<R: Runtime>(app: AppHandle<R>, quality: Option<f64>) -> Result<Response, String> {
    let quality = quality.map(|q| q.clamp(0.3, 1.0));
    let (pages, jpeg) = blocking(move || native::scan(&app, quality)).await?;
    Ok(Response::new(framed_scan(pages, &jpeg)))
}

fn framed_scan(pages: u64, jpeg: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(jpeg.len() + 1);
    out.push(pages.clamp(1, 255) as u8);
    out.extend_from_slice(jpeg);
    out
}

#[tauri::command]
async fn speech_status<R: Runtime>(app: AppHandle<R>, locale: String) -> Answer {
    let locale = clean_locale(&locale)?;
    blocking(move || native::speech_status(&app, locale)).await
}

#[tauri::command]
async fn speech_install<R: Runtime>(app: AppHandle<R>, locale: String, on_progress: Channel<Progress>) -> Answer {
    let locale = clean_locale(&locale)?;
    blocking(move || native::speech_install(&app, locale, on_progress)).await
}

/// The audio arrives as PCM decoded by the page: the bytes stay in memory
/// (plugins.md D16), never in a temporary file.
#[tauri::command]
async fn transcribe<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Answer {
    let pcm = body(&request, MAX_PCM)?;
    if pcm.len() % 2 != 0 {
        return Err("bad-audio".into());
    }
    let locale = clean_locale(&header(&request, "x-locale"))?;
    let slot = TranscribeSlot::take()?;
    blocking(move || {
        let call = slot.0;
        let _slot = slot;
        native::transcribe(&app, pcm, locale, call)
    })
    .await
}

/// A stopped job ends the running transcription, which then fails
/// `canceled`, rather than letting it run to its end (beta #242 entry 2).
/// With none running there is nothing to do.
#[tauri::command]
async fn cancel<R: Runtime>(app: AppHandle<R>) -> Answer {
    let Some(call) = *transcribing() else { return Ok(Value::Null) };
    blocking(move || native::cancel(&app, call)).await
}

#[cfg(target_os = "ios")]
use ios as native;
#[cfg(target_os = "macos")]
use macos as native;

// Never built into the app (see the top of this file); it keeps the crate
// building and its tests running on any host.
#[cfg(not(any(target_os = "ios", target_os = "macos")))]
mod native {
    use super::*;
    pub fn ocr<R: Runtime>(_: &AppHandle<R>, _: Vec<u8>, _: Vec<String>) -> Answer {
        Err("unsupported".into())
    }
    pub fn scan<R: Runtime>(_: &AppHandle<R>, _: Option<f64>) -> Result<(u64, Vec<u8>), String> {
        Err("unsupported".into())
    }
    pub fn speech_status<R: Runtime>(_: &AppHandle<R>, _: String) -> Answer {
        Err("unsupported".into())
    }
    pub fn speech_install<R: Runtime>(_: &AppHandle<R>, _: String, _: Channel<Progress>) -> Answer {
        Err("unsupported".into())
    }
    pub fn transcribe<R: Runtime>(_: &AppHandle<R>, _: Vec<u8>, _: String, _: u64) -> Answer {
        Err("unsupported".into())
    }
    pub fn cancel<R: Runtime>(_: &AppHandle<R>, _: u64) -> Answer {
        Err("unsupported".into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apple-ml")
        .invoke_handler(tauri::generate_handler![ocr, scan, speech_status, speech_install, transcribe, cancel])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let handle = _api.register_ios_plugin(init_plugin_apple_ml)?;
                _app.manage(ios::Handle(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_formats_by_first_bytes() {
        let ftyp = |brand: &[u8]| [&[0, 0, 0, 24][..], &b"ftyp"[..], brand, &[0; 4][..]].concat();
        for ok in [
            vec![0xFF, 0xD8, 0xFF, 0xE0],
            b"\x89PNG\r\n\x1a\n....".to_vec(),
            b"GIF89a..".to_vec(),
            b"GIF87a..".to_vec(),
            b"RIFF\x10\0\0\0WEBPVP8 ".to_vec(),
            ftyp(b"heic"),
            ftyp(b"mif1"),
            ftyp(b"avif"),
        ] {
            assert!(known_image(&ok), "{ok:?}");
        }
        for bad in [
            b"II*\0........".to_vec(),   // TIFF, also DNG
            b"MM\0*........".to_vec(),   // TIFF
            b"8BPS........".to_vec(),     // PSD
            b"\0\0\0\x0CjP  \r\n\x87\n".to_vec(), // JPEG 2000
            b"\x76\x2f\x31\x01....".to_vec(), // OpenEXR
            ftyp(b"crx "),               // Canon raw
            ftyp(b"qt  "),
            b"RIFF\x10\0\0\0WAVE".to_vec(),
            vec![0xFF, 0xD8],
            Vec::new(),
        ] {
            assert!(!known_image(&bad), "{bad:?}");
        }
    }

    #[test]
    fn one_ocr_at_a_time() {
        let first = OcrSlot::take().unwrap();
        assert_eq!(OcrSlot::take().err().as_deref(), Some("busy"));
        drop(first);
        assert!(OcrSlot::take().is_ok());
    }

    #[test]
    fn one_transcribe_at_a_time_each_with_its_number() {
        let first = TranscribeSlot::take().unwrap();
        assert_eq!(*transcribing(), Some(first.0));
        assert_eq!(TranscribeSlot::take().err().as_deref(), Some("busy"));
        let n = first.0;
        drop(first);
        assert_eq!(*transcribing(), None);
        let second = TranscribeSlot::take().unwrap();
        assert!(second.0 > n);
    }

    #[test]
    fn scan_answer_leads_with_the_page_count() {
        assert_eq!(framed_scan(3, &[0xFF, 0xD8]), vec![3, 0xFF, 0xD8]);
        assert_eq!(framed_scan(400, &[1])[0], 255);
        assert_eq!(framed_scan(0, &[1])[0], 1);
    }
}
