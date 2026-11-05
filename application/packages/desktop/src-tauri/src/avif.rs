//! AVIF pictures for the Linux app.
//!
//! WebKitGTK is built without an AVIF decoder on Ubuntu, Linux Mint and
//! Debian, and the AppImage bundles the Ubuntu build, so an AVIF picture that
//! draws on every other platform is a broken image on Linux (GitHub #687).
//! The page hands the bytes here and draws the PNG that comes back. dav1d is
//! built from source and linked statically (`.cargo/config.toml`), so neither
//! the AppImage nor the .deb needs a library on the user's system. Other
//! platforms draw AVIF themselves and never call this.
//!
//! Spec: docs/contrib/gotchas.md (AppImage AVIF)

/// Guards against a hostile file, not product limits: a stored picture is far
/// smaller, and a side of 16,384 px already decodes to 1 GB of pixels.
const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_SIDE_PX: u32 = 16_384;

/// The PNG of an AVIF picture. Takes the bytes as a raw body and answers raw
/// bytes, so neither side copies them through JSON.
#[tauri::command]
pub async fn decode_avif(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the picture as raw bytes".into());
    };
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("picture too large".into());
    }
    let bytes = bytes.clone();
    // A decode takes long enough to stall the window if it ran on the main thread.
    tauri::async_runtime::spawn_blocking(move || to_png(&bytes))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

#[cfg(target_os = "linux")]
fn to_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::{ImageFormat, ImageReader, Limits};
    use std::io::Cursor;

    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Avif);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE_PX);
    limits.max_image_height = Some(MAX_SIDE_PX);
    reader.limits(limits);
    let picture = reader.decode().map_err(|e| e.to_string())?;
    let mut png = Vec::new();
    // Fast: the PNG lives in memory for the session, never on disk.
    let encoder = PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Adaptive);
    picture.write_with_encoder(encoder).map_err(|e| e.to_string())?;
    Ok(png)
}

#[cfg(not(target_os = "linux"))]
fn to_png(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("AVIF is decoded by the webview on this platform".into())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::to_png;

    /// A 64x64 AVIF (SVT-AV1, one frame of ffmpeg's testsrc).
    const SAMPLE: &[u8] = include_bytes!("../tests/fixtures/sample.avif");

    #[test]
    fn avif_decodes_to_png() {
        let png = to_png(SAMPLE).expect("decodes");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let picture = image::load_from_memory_with_format(&png, image::ImageFormat::Png).expect("png reads back");
        assert_eq!((picture.width(), picture.height()), (64, 64));
    }

    #[test]
    fn other_bytes_are_refused() {
        assert!(to_png(b"not a picture at all").is_err());
    }
}
